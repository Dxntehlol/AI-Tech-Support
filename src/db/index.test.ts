import { test } from "node:test";
import assert from "node:assert/strict";
import { isId, newId, nowIso, openDatabase } from "./index.ts";

test("openDatabase(':memory:') applies the schema and pragmas", () => {
  const db = openDatabase(":memory:");
  try {
    const names = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const t of ["units", "conversations", "messages", "findings", "messages_fts", "findings_fts"]) {
      assert.ok(names.includes(t), `table ${t} missing`);
    }
    const triggers = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(triggers.sort(), ["findings_ad", "findings_ai", "findings_au", "messages_ad", "messages_ai", "messages_au"]);

    const fk = db.raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    assert.equal(fk.foreign_keys, 1);
    const busy = db.raw.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    assert.equal(busy.timeout, 5000);
  } finally {
    db.close();
  }
});

test("openDatabase is idempotent on an existing file and close() is safe to call twice", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "hvac-db-"));
  const path = join(dir, "t.sqlite");
  try {
    const a = openDatabase(path);
    a.raw.prepare("INSERT INTO units (id, model, created_at, updated_at) VALUES (?, ?, ?, ?)").run("0123456789abcdef", "X", "t", "t");
    const mode = a.raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(mode.journal_mode, "wal");
    a.close();
    a.close();

    const b = openDatabase(path); // schema re-applied without error, data intact
    const n = b.raw.prepare("SELECT COUNT(*) AS n FROM units").get() as { n: number };
    assert.equal(n.n, 1);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("newId() returns 16 lowercase hex chars, unique, accepted by isId()", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const id = newId();
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.ok(isId(id));
    ids.add(id);
  }
  assert.equal(ids.size, 500);
});

test("isId() rejects anything but 16 lowercase hex chars", () => {
  assert.equal(isId("0123456789abcdef"), true);
  assert.equal(isId("0123456789ABCDEF"), false);
  assert.equal(isId("0123456789abcde"), false);
  assert.equal(isId("0123456789abcdef0"), false);
  assert.equal(isId(""), false);
  assert.equal(isId(null), false);
  assert.equal(isId(123), false);
  assert.equal(isId("../etc/passwd!!"), false);
});

test("nowIso() is ISO-8601 UTC", () => {
  const s = nowIso();
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Number.isFinite(Date.parse(s)));
});
