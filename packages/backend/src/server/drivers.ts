/**
 * The only modules the server loads beyond Node's built-ins — by name, from
 * this closed list, and only when the setup chose them (backend-spec §9).
 * A test ties the list to the pinned dependencies a generated server gets.
 *
 * Copied into a generated server; imports nothing.
 */

export const DRIVERS = ['node:sqlite', 'pg', 'mysql2/promise', 'nodemailer'] as const;
export type Driver = (typeof DRIVERS)[number];

export const loadDriver = (name: Driver): Promise<Record<string, unknown>> =>
  import(name) as Promise<Record<string, unknown>>;
