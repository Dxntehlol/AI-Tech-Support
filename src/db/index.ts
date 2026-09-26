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
