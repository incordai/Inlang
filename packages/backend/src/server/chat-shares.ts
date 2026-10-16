/**
 * @az server chat-shares
 * Purpose: az backend shares — the operator deletes one shared chat answer by its id or its link, from the server folder; an audit line, never the answer.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §20.7)
 * Exports: shareIdOf
 * Edit guide: one delete by exact id, through the share store's own operator delete; print the id and the outcome only — never a share's events or question.
 * Tests: packages/backend/test/chat-share.test.ts, packages/cli/test/backend.test.ts
 */

/**
 * `node src/chat-shares.ts --delete <id | link>` (run by `az backend shares
 * <server-dir> --delete <id>`).
 *
 * A visitor's shared answer (chat-block-spec §20.7) is gone at its expiry,
 * or when its sharer uses the delete link; this is the operator's way, for a
 * share reported to them, on any chat site — one with data tables also has
 * the same delete on /admin. It reads the server's own `.env` and database as
 * main.ts does, deletes that one share and prints one audit line on stdout:
 * the id, the outcome and the time — never what the share held.
 *
 * Copied into a generated server with a chat; imports only its siblings and node built-ins.
 */

import { pathToFileURL } from 'node:url';
import { failure, openChat } from './chat-report.ts';
import { createShareStore, isShareId } from './chat-share.ts';

/**
 * The share id in what the operator pasted: the id itself, or a share link
 * (`https://<site>/chat/shared#<id>`, or its delete link `#<id>&<token>`) —
 * the delete token, if any, is not kept. Null when it holds no share id.
 */
export function shareIdOf(arg: string): string | null {
  const hash = arg.indexOf('#');
  const id = (hash >= 0 ? arg.slice(hash + 1) : arg).split('&')[0].trim();
  return isShareId(id) ? id : null;
}

async function main(argv: readonly string[]): Promise<number> {
  const id = argv.length === 2 && argv[0] === '--delete' ? shareIdOf(argv[1]) : null;
  if (id === null) {
    process.stderr.write('backend: try: node src/chat-shares.ts --delete <share id or link>\n');
    return 2;
  }
  const opened = await openChat('delete the share', 'there are no shares to delete');
  if (typeof opened === 'number') return opened;
  const { db, chat } = opened;
  try {
    const gone = await createShareStore({ db, days: chat.shares.days, max: chat.shares.max }).removeAny(id);
    const at = new Date().toISOString();
    if (!gone) {
      process.stderr.write(`backend: no shared answer ${id} — it is already gone (deleted or expired), or the id is not one of this server's\n`);
      return 1;
    }
    // The audit line: what went and when, never what it held.
    process.stdout.write(`backend: shared answer ${id} deleted by the operator at ${at}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`backend: cannot delete the share (${failure(e)}) — has the server started with chat once? It makes az_chat_shares then\n`);
    return 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
