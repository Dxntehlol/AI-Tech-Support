import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { SCHEMA_SQL } from "./schema.ts";

export interface Db {
  raw: DatabaseSync;
  close(): void;
}

/**
 * Open (or create) the SQLite database, apply the idempotent schema (which sets WAL + foreign keys
 * through its own PRAGMAs), and set a busy timeout so concurrent writers wait instead of failing.
 * Use ":memory:" for tests.
 */
export function openDatabase(path: string): Db {
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA busy_timeout = 5000;");
  raw.exec(SCHEMA_SQL);
  applyColumnMigrations(raw);
  let closed = false;
  return {
    raw,
    close(): void {
      if (closed) return;
      closed = true;
      raw.close();
    },
  };
}

/**
 * Columns added to tables that may pre-exist (CREATE TABLE IF NOT EXISTS cannot add them). Each entry is
 * applied only when PRAGMA table_info lacks the column, so startup on an old or new database is idempotent.
 */
export const FINDINGS_COLUMN_MIGRATIONS: readonly { table: string; column: string; ddl: string }[] = [
  { table: "findings", column: "follow_up_due", ddl: "ALTER TABLE findings ADD COLUMN follow_up_due TEXT" },
  { table: "findings", column: "follow_up_done", ddl: "ALTER TABLE findings ADD COLUMN follow_up_done INTEGER NOT NULL DEFAULT 0" },
];

/** Column names of a table (empty when the table does not exist). */
export function tableColumns(raw: DatabaseSync, table: string): Set<string> {
  const rows = raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => String(r.name)));
}

function applyColumnMigrations(raw: DatabaseSync): void {
  const seen = new Map<string, Set<string>>();
  for (const m of FINDINGS_COLUMN_MIGRATIONS) {
    let cols = seen.get(m.table);
    if (!cols) {
      cols = tableColumns(raw, m.table);
      seen.set(m.table, cols);
    }
    if (cols.has(m.column)) continue;
    raw.exec(m.ddl);
    cols.add(m.column);
  }
  // Index over the follow-up columns; must come after the ALTERs so an old database has the columns.
  raw.exec("CREATE INDEX IF NOT EXISTS idx_findings_follow_up ON findings(follow_up_done, follow_up_due)");
}

/** 16 lowercase hex chars from 8 random bytes. */
export function newId(): string {
  return randomBytes(8).toString("hex");
}

/** Public ids are 16 lowercase hex chars. Routes reject anything else with 400. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

export function nowIso(): string {
  return new Date().toISOString();
}
