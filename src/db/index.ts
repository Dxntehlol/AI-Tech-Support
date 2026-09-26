import type { DatabaseSync } from "node:sqlite";

export interface Db {
  raw: DatabaseSync;
  close(): void;
}

/** Open (or create) the SQLite database, apply schema.sql, enable WAL + foreign keys. Use ":memory:" for tests. */
export function openDatabase(path: string): Db {
  throw new Error("not implemented");
}

export function newId(): string {
  throw new Error("not implemented");
}

export function nowIso(): string {
  return new Date().toISOString();
}
