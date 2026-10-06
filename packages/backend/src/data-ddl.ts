/**
 * @az module data-ddl
 * Purpose: the schema lock's steps as per-engine SQL units: one statement each, probed, guarded, named deterministically.
 * Spec: docs/data-spec.md §4.3–§4.4, §6.3
 * Exports: dataSteps, physical, DESTRUCTIVE_OPS
 * Edit guide: identifiers only from the validated lock, always quoted; values only as parameters; one statement per unit.
 * Tests: packages/backend/test/data-ddl.test.ts
 */

/**
 * Build time: the lock (data-spec §6.1) becomes the SQL the generated server
 * applies on start (§6.3). Each unit is ONE statement, so a failure resumes
 * at that statement; each carries a probe (claim.ts) so a statement that
 * landed before a crash is not run twice, or a guard that must find no rows
 * before a destructive change goes ahead.
 *
 * Constraint and index names are numbered by the step that creates them
 * (`azx_<version>_<n>`), never derived from table names: a renamed table
 * keeps its constraints, and a new table may then take the old name without
 * a clash (constraint and index names are schema-wide on PostgreSQL, foreign
 * key names on MySQL).
 *
 * Deliberately NOT in the database (data-spec §6.3 deviation, recorded in
 * the spec): NOT NULL on author fields and the choice CHECK. Both would have
 * to change when a field becomes optional or a choice gains a value, and
 * SQLite cannot alter a constraint without rebuilding the table. The server
 * validates every value before it writes (data-api.ts). Length checks stay:
 * the type caps never change.
 */

import type { Database } from './server/env.ts';
import type { DataStep, DataUnit, Param } from './server/data-migrate.ts';
import type { Fill, LockField, LockOp, LockStep } from '../../core/src/data-lock.ts';

export const DESTRUCTIVE_OPS: ReadonlySet<LockOp['op']> = new Set(['dropTable', 'dropField', 'renameTable', 'renameField']);

/** The SQL table behind `data <name>`: prefixed, so no author name meets an az_ or SQL-reserved table. */
export const physical = (table: string) => `azd_${table}`;

const MYSQL_TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';
const LIMIT: Partial<Record<LockField['type'], number>> = { text: 200, longtext: 10_000, email: 254, url: 2048, choice: 63 };

const q = (d: Database, name: string) => (d === 'mysql' ? `\`${name}\`` : `"${name}"`);

/** A column's type on one engine (data-spec §4.3). */
function columnType(d: Database, f: LockField): string {
  const col = q(d, f.name);
  switch (f.type) {
    case 'text': case 'longtext': case 'email': case 'url': case 'choice': {
      const max = LIMIT[f.type]!;
      if (d === 'sqlite') return `TEXT CHECK (length(${col}) <= ${max})`;
      if (f.type === 'longtext') return 'TEXT';
      // MySQL counts every VARCHAR's full width against a 65,535-byte row:
      // a url at 2048 × 4 bytes would allow only seven per table. Never
      // indexed, so TEXT costs nothing (data-spec §4.3 deviation).
      if (f.type === 'url' && d === 'mysql') return 'TEXT';
      return `VARCHAR(${max})`;
    }
    case 'number': case 'money': case 'datetime':
      return d === 'sqlite' ? 'INTEGER' : 'BIGINT';
    case 'flag':
      return d === 'sqlite' ? `INTEGER CHECK (${col} IN (0, 1))` : d === 'postgres' ? 'SMALLINT' : 'TINYINT';
    case 'date':
      return d === 'sqlite' ? `TEXT CHECK (length(${col}) = 10)` : 'CHAR(10)';
    case 'ref':
      return d === 'sqlite' ? 'TEXT' : 'VARCHAR(36)';
    case 'image':
      throw new Error('data-ddl: image fields ship in D3');
  }
}

const fillValue = (v: Fill): Param => (typeof v === 'boolean' ? (v ? 1 : 0) : v);

/** One table's live names while the lock replays. */
interface TableState {
  fields: Map<string, LockField>;
  /** `owner`, `created`, `updated`, `plain:<field>`, `unique:<field>` → index name. */
  indexes: Map<string, string>;
  /** field → foreign key name (owner included). */
  fks: Map<string, string>;
  pk: string;
}

type Emit = { readonly [D in Database]: DataUnit[] };
const DIALECTS: readonly Database[] = ['sqlite', 'postgres', 'mysql'];

/** The lock's steps as SQL units per engine, replayed from an empty schema. */
export function dataSteps(steps: readonly LockStep[]): DataStep[] {
  const tables = new Map<string, TableState>();
  return steps.map((step) => {
    let n = 0;
    const name = (kind: 'x' | 'f' | 'p') => `az${kind}_${step.version}_${++n}`;
    const out: Emit = { sqlite: [], postgres: [], mysql: [] };
    const summary: string[] = [];
    let destructive = false;
    const all = (unit: (d: Database) => DataUnit | null) => {
      for (const d of DIALECTS) {
        const u = unit(d);
        if (u) out[d].push(u);
      }
    };
    const need = (t: string) => {
      const s = tables.get(t);
      if (!s) throw new Error(`data-ddl: step ${step.version} names missing table '${t}'`);
      return s;
    };

    const createIndex = (table: string, s: TableState, key: string, cols: readonly string[], unique: boolean) => {
      const ix = name('x');
      s.indexes.set(key, ix);
      const t = physical(table);
      all((d) => ({
        sql: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(d, ix)} ON ${q(d, t)} (${cols.map((c) => q(d, c)).join(', ')})`,
        probe: { kind: 'index', table: t, name: ix, done: 'present' },
      }));
    };
    const dropIndex = (table: string, s: TableState, key: string) => {
      const ix = s.indexes.get(key);
      if (ix === undefined) return;
      s.indexes.delete(key);
      const t = physical(table);
      all((d) => ({
        sql: d === 'mysql' ? `ALTER TABLE ${q(d, t)} DROP INDEX ${q(d, ix)}` : `DROP INDEX ${q(d, ix)}`,
        probe: { kind: 'index', table: t, name: ix, done: 'absent' },
      }));
    };
    /** A field's own indexes, from its definition: unique, or (index or ref) as a sort key with id. */
    const fieldIndexes = (table: string, s: TableState, f: LockField) => {
      if (f.unique) createIndex(table, s, `unique:${f.name}`, [f.name], true);
      else if (f.index || f.type === 'ref') createIndex(table, s, `plain:${f.name}`, [f.name, 'id'], false);
    };
    const fkClause = (d: Database, fk: string, col: string, target: string, cascade: boolean) =>
      `CONSTRAINT ${q(d, fk)} FOREIGN KEY (${q(d, col)}) REFERENCES ${q(d, target)} (${q(d, 'id')}) ON DELETE ${cascade ? 'CASCADE' : 'RESTRICT'}`;

    for (const op of step.ops) {
      if (DESTRUCTIVE_OPS.has(op.op)) destructive = true;
      switch (op.op) {
        case 'createTable': {
          const s: TableState = { fields: new Map(op.fields.map((f) => [f.name, f])), indexes: new Map(), fks: new Map(), pk: name('p') };
          s.fks.set('owner', name('f'));
          for (const f of op.fields) if (f.type === 'ref') s.fks.set(f.name, name('f'));
          tables.set(op.table, s);
          const t = physical(op.table);
          all((d) => {
            const idType = d === 'sqlite' ? 'TEXT' : 'VARCHAR(36)';
            const big = d === 'sqlite' ? 'INTEGER' : 'BIGINT';
            const cols = [
              `${q(d, 'id')} ${idType} NOT NULL`,
              `${q(d, 'owner')} ${idType}`,
              `${q(d, 'created')} ${big} NOT NULL`,
              `${q(d, 'updated')} ${big} NOT NULL`,
              ...op.fields.map((f) => `${q(d, f.name)} ${columnType(d, f)}`),
              `CONSTRAINT ${q(d, s.pk)} PRIMARY KEY (${q(d, 'id')})`,
              fkClause(d, s.fks.get('owner')!, 'owner', 'az_users', true),
              ...op.fields.filter((f) => f.type === 'ref').map((f) => fkClause(d, s.fks.get(f.name)!, f.name, physical(f.ref!), false)),
            ];
            return {
              sql: `CREATE TABLE ${q(d, t)} (${cols.join(', ')})${d === 'mysql' ? ` ${MYSQL_TABLE}` : ''}`,
              probe: { kind: 'table', table: t, done: 'present' },
            };
          });
          createIndex(op.table, s, 'owner', ['owner'], false);
          createIndex(op.table, s, 'created', ['created', 'id'], false);
          createIndex(op.table, s, 'updated', ['updated', 'id'], false);
          for (const f of op.fields) fieldIndexes(op.table, s, f);
          summary.push(`create table ${op.table}`);
          break;
        }
        case 'addField': {
          const s = need(op.table);
          const f = op.field;
          s.fields.set(f.name, f);
          const t = physical(op.table);
          const fk = f.type === 'ref' ? name('f') : undefined;
          if (fk) s.fks.set(f.name, fk);
          all((d) => {
            // MySQL adds the foreign key as its own statement (below); the
            // others take it in the column, one statement either way.
            const ref = fk && d !== 'mysql'
              ? d === 'sqlite'
                ? ` REFERENCES ${q(d, physical(f.ref!))} (${q(d, 'id')}) ON DELETE RESTRICT`
                : ` CONSTRAINT ${q(d, fk)} REFERENCES ${q(d, physical(f.ref!))} (${q(d, 'id')}) ON DELETE RESTRICT`
              : '';
            return {
              sql: `ALTER TABLE ${q(d, t)} ADD COLUMN ${q(d, f.name)} ${columnType(d, f)}${ref}`,
              probe: { kind: 'column', table: t, name: f.name, done: 'present' },
            };
          });
          if (fk) {
            out.mysql.push({
              sql: `ALTER TABLE ${q('mysql', t)} ADD ${fkClause('mysql', fk, f.name, physical(f.ref!), false)}`,
              probe: { kind: 'fk', table: t, name: fk, done: 'present' },
            });
          }
          if (op.fill !== undefined) {
            const v = fillValue(op.fill);
            all((d) => ({ sql: `UPDATE ${q(d, t)} SET ${q(d, f.name)} = ? WHERE ${q(d, f.name)} IS NULL`, params: [v] }));
          }
          fieldIndexes(op.table, s, f);
          summary.push(`add ${op.table}.${f.name}`);
          break;
        }
        case 'dropField': {
          const s = need(op.table);
          const t = physical(op.table);
          const fk = s.fks.get(op.field);
          if (fk) {
            s.fks.delete(op.field);
            out.mysql.push({ sql: `ALTER TABLE ${q('mysql', t)} DROP FOREIGN KEY ${q('mysql', fk)}`, probe: { kind: 'fk', table: t, name: fk, done: 'absent' } });
          }
          // SQLite refuses to drop an indexed column; the others drop the index with it.
          dropIndex(op.table, s, `unique:${op.field}`);
          dropIndex(op.table, s, `plain:${op.field}`);
          all((d) => ({ sql: `ALTER TABLE ${q(d, t)} DROP COLUMN ${q(d, op.field)}`, probe: { kind: 'column', table: t, name: op.field, done: 'absent' } }));
          s.fields.delete(op.field);
          summary.push(`drop ${op.table}.${op.field}`);
          break;
        }
        case 'renameField': {
          const s = need(op.table);
          const t = physical(op.table);
          all((d) => ({
            sql: `ALTER TABLE ${q(d, t)} RENAME COLUMN ${q(d, op.field)} TO ${q(d, op.to)}`,
            probe: { kind: 'column', table: t, name: op.to, done: 'present' },
          }));
          const f = s.fields.get(op.field)!;
          s.fields.delete(op.field);
          s.fields.set(op.to, { ...f, name: op.to });
          for (const k of ['unique', 'plain']) {
            const ix = s.indexes.get(`${k}:${op.field}`);
            if (ix !== undefined) { s.indexes.delete(`${k}:${op.field}`); s.indexes.set(`${k}:${op.to}`, ix); }
          }
          const fk = s.fks.get(op.field);
          if (fk !== undefined) { s.fks.delete(op.field); s.fks.set(op.to, fk); }
          summary.push(`rename ${op.table}.${op.field} to ${op.to}`);
          break;
        }
        case 'renameTable': {
          const s = need(op.table);
          const [from, to] = [physical(op.table), physical(op.to)];
          all((d) => ({
            sql: d === 'mysql' ? `RENAME TABLE ${q(d, from)} TO ${q(d, to)}` : `ALTER TABLE ${q(d, from)} RENAME TO ${q(d, to)}`,
            probe: { kind: 'table', table: to, done: 'present' },
          }));
          tables.delete(op.table);
          tables.set(op.to, s);
          for (const other of tables.values()) {
            for (const [k, f] of other.fields) if (f.ref === op.table) other.fields.set(k, { ...f, ref: op.to });
          }
          summary.push(`rename table ${op.table} to ${op.to}`);
          break;
        }
        case 'dropTable': {
          need(op.table);
          const t = physical(op.table);
          all((d) => ({ sql: `DROP TABLE ${q(d, t)}`, probe: { kind: 'table', table: t, done: 'absent' } }));
          tables.delete(op.table);
          summary.push(`drop table ${op.table}`);
          break;
        }
        case 'setField': {
          const s = need(op.table);
          const was = s.fields.get(op.field.name)!;
          const now = op.field;
          const t = physical(op.table);
          const col = now.name;
          const removed = (was.choices ?? []).filter((c) => !(now.choices ?? []).includes(c));
          if (removed.length > 0) {
            destructive = true;
            all((d) => ({
              guard: {
                sql: `SELECT COUNT(*) AS n FROM ${q(d, t)} WHERE ${q(d, col)} IN (${removed.map(() => '?').join(', ')})`,
                params: removed,
                message: `${op.table}.${col} still holds a removed choice (${removed.join(', ')})`,
              },
            }));
            summary.push(`remove ${removed.join(', ')} from ${op.table}.${col}`);
          }
          if (op.fill !== undefined) {
            const v = fillValue(op.fill);
            all((d) => ({ sql: `UPDATE ${q(d, t)} SET ${q(d, col)} = ? WHERE ${q(d, col)} IS NULL`, params: [v] }));
          }
          if (!was.unique && now.unique) {
            destructive = true;
            all((d) => ({
              guard: {
                sql: `SELECT COUNT(*) AS n FROM (SELECT ${q(d, col)} FROM ${q(d, t)} WHERE ${q(d, col)} IS NOT NULL GROUP BY ${q(d, col)} HAVING COUNT(*) > 1) ${q(d, 'dupes')}`,
                params: [],
                message: `${op.table}.${col} has values held by more than one row`,
              },
            }));
            summary.push(`make ${op.table}.${col} unique`);
          }
          const wantPlain = !now.unique && (now.index || now.type === 'ref');
          if (was.unique && !now.unique) dropIndex(op.table, s, `unique:${col}`);
          if (s.indexes.has(`plain:${col}`) && !wantPlain) dropIndex(op.table, s, `plain:${col}`);
          if (!was.unique && now.unique) createIndex(op.table, s, `unique:${col}`, [col], true);
          if (wantPlain && !s.indexes.has(`plain:${col}`)) createIndex(op.table, s, `plain:${col}`, [col, 'id'], false);
          s.fields.set(col, now);
          if (summary.length === 0 || !summary[summary.length - 1].includes(`${op.table}.${col}`)) summary.push(`change ${op.table}.${col}`);
          break;
        }
      }
    }
    return { version: step.version, destructive, summary, units: out };
  });
}
