import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { READINGS_TABLE_SQL, SCHEMA_SQL } from "./schema.ts";

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
  migrateReadingsModeCheck(raw);
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
export interface ColumnMigration {
  table: string;
  column: string;
  ddl: string;
}

export const FINDINGS_COLUMN_MIGRATIONS: readonly ColumnMigration[] = [
  { table: "findings", column: "follow_up_due", ddl: "ALTER TABLE findings ADD COLUMN follow_up_due TEXT" },
  { table: "findings", column: "follow_up_done", ddl: "ALTER TABLE findings ADD COLUMN follow_up_done INTEGER NOT NULL DEFAULT 0" },
];

/** Refrigerant log / EPA compliance columns on units (DESIGN.md "Refrigerant log + compliance"). */
export const UNITS_COLUMN_MIGRATIONS: readonly ColumnMigration[] = [
  { table: "units", column: "full_charge_lbs", ddl: "ALTER TABLE units ADD COLUMN full_charge_lbs REAL" },
  { table: "units", column: "appliance_type", ddl: "ALTER TABLE units ADD COLUMN appliance_type TEXT" },
  { table: "units", column: "circuits_count", ddl: "ALTER TABLE units ADD COLUMN circuits_count INTEGER" },
];

/** Job clock + customer signature columns on conversations (DESIGN.md "Job clock + signature"). */
export const CONVERSATIONS_COLUMN_MIGRATIONS: readonly ColumnMigration[] = [
  { table: "conversations", column: "job_started_at", ddl: "ALTER TABLE conversations ADD COLUMN job_started_at TEXT" },
  { table: "conversations", column: "job_ended_at", ddl: "ALTER TABLE conversations ADD COLUMN job_ended_at TEXT" },
  { table: "conversations", column: "signature_png", ddl: "ALTER TABLE conversations ADD COLUMN signature_png TEXT" },
  { table: "conversations", column: "signed_by", ddl: "ALTER TABLE conversations ADD COLUMN signed_by TEXT" },
  { table: "conversations", column: "signed_at", ddl: "ALTER TABLE conversations ADD COLUMN signed_at TEXT" },
  { table: "conversations", column: "signature_note", ddl: "ALTER TABLE conversations ADD COLUMN signature_note TEXT" },
];

/** Every guarded ALTER TABLE, in order. */
export const COLUMN_MIGRATIONS: readonly ColumnMigration[] = [...FINDINGS_COLUMN_MIGRATIONS, ...UNITS_COLUMN_MIGRATIONS, ...CONVERSATIONS_COLUMN_MIGRATIONS];

/** Column names of a table (empty when the table does not exist). */
export function tableColumns(raw: DatabaseSync, table: string): Set<string> {
  const rows = raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => String(r.name)));
}

function applyColumnMigrations(raw: DatabaseSync): void {
  const seen = new Map<string, Set<string>>();
  for (const m of COLUMN_MIGRATIONS) {
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

/** The CREATE TABLE text SQLite stores for a table (undefined when the table does not exist). */
export function tableSql(raw: DatabaseSync, table: string): string | undefined {
  const row = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined;
  return typeof row?.sql === "string" ? row.sql : undefined;
}

/**
 * The readings table's mode CHECK gained 'chiller'. SQLite cannot alter a CHECK constraint, so a table created
 * before that is rebuilt (new table, copy rows, drop, rename, re-index) with foreign keys off for the swap — the
 * procedure sqlite.org documents for schema changes. Idempotent: a table whose DDL already lists 'chiller' is
 * left alone.
 */
export function migrateReadingsModeCheck(raw: DatabaseSync): boolean {
  const sql = tableSql(raw, "readings");
  if (!sql || /'chiller'/.test(sql)) return false;
  const cols = "id, unit_id, conversation_id, created_at, mode, refrigerant, metering_device, measurements_json, derived_json, validity_json, findings_json, note, source";
  raw.exec("PRAGMA foreign_keys = OFF;");
  try {
    raw.exec("BEGIN IMMEDIATE;");
    try {
      raw.exec("DROP TABLE IF EXISTS readings_new;");
      raw.exec(READINGS_TABLE_SQL("readings_new"));
      raw.exec(`INSERT INTO readings_new (${cols}) SELECT ${cols} FROM readings;`);
      raw.exec("DROP TABLE readings;");
      raw.exec("ALTER TABLE readings_new RENAME TO readings;");
      raw.exec("CREATE INDEX IF NOT EXISTS idx_readings_unit_created ON readings(unit_id, created_at DESC);");
      raw.exec("COMMIT;");
    } catch (err) {
      try {
        raw.exec("ROLLBACK;");
      } catch {
        /* not in a transaction */
      }
      throw err;
    }
  } finally {
    raw.exec("PRAGMA foreign_keys = ON;");
  }
  return true;
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
