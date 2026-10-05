import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PROJECT_ROOT, loadConfig, readPackageVersion } from "../config.ts";
import { loadKnowledge } from "../knowledge/loader.ts";
import { openDatabase, type Db } from "../db/index.ts";
import { createRepos, type Repos } from "../db/repos.ts";
import { createFakeClient } from "../agent/fakeClient.ts";
import { runTurn } from "../agent/chat.ts";
import { executeTool } from "../agent/tools.ts";
import { unitContextBlock } from "../agent/systemPrompt.ts";
import type { AppConfig, CorrectionRow, KnowledgeBase, UnitRow } from "../types.ts";
import { createApp, type AppDeps } from "../app.ts";
import { IMPORT_MAX_ROWS } from "./fleetImport.ts";

const NOW = new Date("2026-09-26T12:00:00Z");
const CARRIER_MODEL = "48TCDA04A2A5-0A0A0";
const CARRIER_SERIAL = "1523G12345";

let kb: KnowledgeBase;
before(() => {
  kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });
});

interface Ctx {
  db: Db;
  repos: Repos;
  deps: AppDeps;
  get(path: string): Promise<Response>;
  json(method: string, path: string, body?: unknown): Promise<Response>;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const db = openDatabase(":memory:");
  const repos = createRepos(db);
  const config: AppConfig = { ...loadConfig({}) };
  const deps: AppDeps = { client: createFakeClient(), config, kb, repos, log: () => {}, now: () => NOW, demo: true };
  const app = createApp(deps);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ctx: Ctx = {
    db,
    repos,
    deps,
    get: (path) => fetch(base + path),
    json: (method, path, body) =>
      fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
  };
  try {
    await fn(ctx);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

async function expectError(res: Response, status: number, code: string): Promise<string> {
  assert.equal(res.status, status);
  const b = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(b.error.code, code);
  assert.equal(typeof b.error.message, "string");
  return b.error.message;
}

interface ImportRes {
  dryRun: boolean;
  source: string;
  delimiter?: string;
  header?: boolean;
  ignoredColumns: string[];
  warnings: string[];
  summary: { total: number; new: number; duplicate: number; error: number; created: number };
  createdIds: string[];
  rows: {
    index: number;
    line?: number;
    input: Record<string, string>;
    status: string;
    error?: string;
    existingUnitId?: string;
    duplicateOf?: number;
    unitId?: string;
    decoded: { manufacturer: string | null; family: string | null; tonnage: number | null; refrigerant: string | null; voltage: string | null; manufactureDate: string | null; ageYears: number | null; confidence: string; warnings: string[] } | null;
  }[];
}

function unitCount(repos: Repos): number {
  return repos.units.list({ includeArchived: true, limit: 1000 }).length;
}

// ---------------------------------------------------------------------------
// Feature C — bulk fleet import
// ---------------------------------------------------------------------------

describe("POST /api/units/import", () => {
  const CSV = [
    "Model #,S/N,Brand,Building,RTU,Tons",
    `${CARRIER_MODEL},${CARRIER_SERIAL},Carrier,"Pharmacy, North",RTU-7,3`,
    `${CARRIER_MODEL.toLowerCase()},${CARRIER_SERIAL.toLowerCase()},,"Pharmacy, North",RTU-7b,`,
    "ZZZ999,QQ1,,Mall,RTU-9,",
    ",,,Mall,,",
    "48TCDA05A2A5-0A0A0,EXIST-1,,Mall,RTU-10,",
  ].join("\r\n");

  test("dry run classifies new / in-batch duplicate / existing duplicate / error and writes nothing", async () => {
    await withServer(async (c) => {
      // Stored lowercase directly, so the duplicate check is truly case-insensitive.
      c.db.raw
        .prepare("INSERT INTO units (id, model, serial, unit_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("00000000000000aa", "48tcda05a2a5-0a0a0", "exist-1", "RTU-10", NOW.toISOString(), NOW.toISOString());
      const before = unitCount(c.repos);
      const res = await c.json("POST", "/api/units/import", { text: CSV, dryRun: true });
      assert.equal(res.status, 200);
      const b = (await res.json()) as ImportRes;
      assert.equal(b.dryRun, true);
      assert.equal(b.source, "text");
      assert.equal(b.delimiter, ",");
      assert.equal(b.header, true);
      assert.deepEqual(b.ignoredColumns, ["Tons"]);
      assert.deepEqual(b.summary, { total: 5, new: 2, duplicate: 2, error: 1, created: 0 });
      assert.deepEqual(b.createdIds, []);
      assert.deepEqual(b.rows.map((r) => r.status), ["new", "duplicate", "new", "error", "duplicate"]);
      assert.deepEqual(b.rows.map((r) => r.index), [0, 1, 2, 3, 4]);
      assert.deepEqual(b.rows.map((r) => r.line), [2, 3, 4, 5, 6]);

      const carrier = b.rows[0]!;
      assert.deepEqual(carrier.input, { model: CARRIER_MODEL, serial: CARRIER_SERIAL, manufacturer: "Carrier", site: "Pharmacy, North", unit_tag: "RTU-7" });
      assert.ok(carrier.decoded);
      assert.equal(carrier.decoded.manufacturer, "Carrier");
      assert.match(carrier.decoded.family ?? "", /48\/50TC/);
      assert.equal(carrier.decoded.tonnage, 3);
      assert.equal(carrier.decoded.refrigerant, "R-410A");
      assert.equal(carrier.decoded.voltage, "208/230-3-60");
      assert.equal(carrier.decoded.manufactureDate, "2023-W15");
      assert.equal(carrier.decoded.ageYears, 3.5);
      assert.equal(carrier.decoded.confidence, "medium", "lowest of model (medium) and serial (high)");
      assert.ok(Array.isArray(carrier.decoded.warnings));

      assert.equal(b.rows[1]!.duplicateOf, 0);
      // Numbered by source line (the header is line 1), matching the row numbers the preview shows.
      assert.equal(b.rows[1]!.error, "Same unit as row 2 of this import.");
      assert.equal(b.rows[2]!.decoded?.confidence, "none");
      assert.match(b.rows[2]!.decoded?.warnings.join(" ") ?? "", /No manufacturer matched/);
      assert.equal(b.rows[3]!.decoded, null);
      assert.match(b.rows[3]!.error ?? "", /model, unit_tag or nickname/);
      assert.equal(b.rows[4]!.existingUnitId, "00000000000000aa");
      assert.match(b.rows[4]!.error ?? "", /Already saved as RTU-10/);

      assert.equal(unitCount(c.repos), before, "dry run writes nothing");
    });
  });

  test("dryRun:false creates the new rows exactly like POST /api/units, in one go, and reports ids", async () => {
    await withServer(async (c) => {
      const res = await c.json("POST", "/api/units/import", { text: CSV, dryRun: false });
      assert.equal(res.status, 200);
      const b = (await res.json()) as ImportRes;
      assert.equal(b.dryRun, false);
      assert.deepEqual(b.summary, { total: 5, new: 3, duplicate: 1, error: 1, created: 3 });
      assert.equal(b.createdIds.length, 3);
      assert.deepEqual(
        b.rows.filter((r) => r.status === "new").map((r) => r.unitId),
        b.createdIds,
      );
      assert.equal(unitCount(c.repos), 3);

      const imported = c.repos.units.get(b.createdIds[0]!)!;
      // The same body through POST /api/units on a fresh server must yield the same columns.
      await withServer(async (c2) => {
        const single = await c2.json("POST", "/api/units", { model: CARRIER_MODEL, serial: CARRIER_SERIAL, manufacturer: "Carrier", site: "Pharmacy, North", unit_tag: "RTU-7" });
        assert.equal(single.status, 201);
        const u = ((await single.json()) as { unit: UnitRow }).unit;
        const strip = (row: UnitRow) => ({ ...row, id: "", created_at: "", updated_at: "" });
        assert.deepEqual(strip(imported), strip(u));
      });

      // Re-running the same import is all duplicates (idempotent) and creates nothing.
      const again = (await (await c.json("POST", "/api/units/import", { text: CSV, dryRun: false })).json()) as ImportRes;
      assert.deepEqual(again.summary, { total: 5, new: 0, duplicate: 4, error: 1, created: 0 });
      assert.equal(again.rows[0]!.existingUnitId, b.createdIds[0]);
      assert.equal(unitCount(c.repos), 3);
    });
  });

  test("rows[] with alias keys; serial-less rows dedupe on site + tag; dryRun defaults to true", async () => {
    await withServer(async (c) => {
      c.repos.units.create({ unit_tag: "AHU-1", site: "Clinic" });
      const res = await c.json("POST", "/api/units/import", {
        rows: [
          { "Model Number": CARRIER_MODEL, "Serial #": CARRIER_SERIAL, Location: "Clinic", Tag: "RTU-1", Nickname: "North", Customer: "Acme", Notes: "by the hatch", Weird: 1 },
          { tag: "ahu-1", site: "clinic" },
          { tag: "AHU-2", site: "Clinic" },
          { tag: "AHU-2", site: "Clinic" },
          { model: "X".repeat(201) },
        ],
      });
      assert.equal(res.status, 200);
      const b = (await res.json()) as ImportRes;
      assert.equal(b.dryRun, true);
      assert.equal(b.source, "rows");
      assert.deepEqual(b.ignoredColumns, ["Weird"]);
      assert.deepEqual(b.rows.map((r) => r.status), ["new", "duplicate", "new", "duplicate", "error"]);
      assert.deepEqual(b.rows[0]!.input, { model: CARRIER_MODEL, serial: CARRIER_SERIAL, site: "Clinic", unit_tag: "RTU-1", nickname: "North", customer: "Acme", location_note: "by the hatch" });
      assert.ok(b.rows[1]!.existingUnitId);
      assert.equal(b.rows[3]!.duplicateOf, 2);
      assert.equal(b.rows[3]!.error, "Same unit as row 3 of this import.", "rows[] have no line: index + 1");
      assert.match(b.rows[4]!.error ?? "", /at most 200/);
      assert.equal(unitCount(c.repos), 1);
    });
  });

  test("headerless whitespace lines import too", async () => {
    await withServer(async (c) => {
      const b = (await (await c.json("POST", "/api/units/import", { text: `${CARRIER_MODEL} ${CARRIER_SERIAL} Pharmacy RTU-7\n`, dryRun: false })).json()) as ImportRes;
      assert.equal(b.delimiter, "whitespace");
      assert.equal(b.header, false);
      assert.equal(b.summary.created, 1);
      const u = c.repos.units.get(b.createdIds[0]!)!;
      assert.equal(u.site, "Pharmacy");
      assert.equal(u.unit_tag, "RTU-7");
      assert.equal(u.tonnage, 3);
    });
  });

  test("validation: nothing to import, both inputs, bad types, row limit, size limit", async () => {
    await withServer(async (c) => {
      await expectError(await c.json("POST", "/api/units/import", { dryRun: true }), 400, "validation");
      await expectError(await c.json("POST", "/api/units/import", { text: "\n\n", dryRun: true }), 400, "validation");
      await expectError(await c.json("POST", "/api/units/import", { text: "a b", rows: [], dryRun: true }), 400, "validation");
      await expectError(await c.json("POST", "/api/units/import", { rows: "nope", dryRun: true }), 400, "validation");
      await expectError(await c.json("POST", "/api/units/import", { rows: [1], dryRun: true }), 400, "validation");
      await expectError(await c.json("POST", "/api/units/import", { text: 42, dryRun: true }), 400, "validation");
      await expectError(await c.json("POST", "/api/units/import", { text: "M1 S1", dryRun: "maybe" }), 400, "validation");
      const many = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `M${i} S${i}`).join("\n");
      const msg = await expectError(await c.json("POST", "/api/units/import", { text: many, dryRun: false }), 400, "validation");
      assert.match(msg, /Too many rows \(more than 200\)/);
      const manyRows = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => ({ model: `M${i}`, serial: `S${i}` }));
      assert.match(await expectError(await c.json("POST", "/api/units/import", { rows: manyRows, dryRun: true }), 400, "validation"), /201.*200/);
      assert.equal(unitCount(c.repos), 0);
      const exactly = Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => `M${i} S${i}`).join("\n");
      const ok = (await (await c.json("POST", "/api/units/import", { text: exactly, dryRun: true })).json()) as ImportRes;
      assert.equal(ok.summary.total, IMPORT_MAX_ROWS);
      await expectError(await c.json("POST", "/api/units/import", { text: "x".repeat(1024 * 1024 + 10), dryRun: true }), 413, "too_large");
    });
  });
});

// ---------------------------------------------------------------------------
// Feature D — decode corrections
// ---------------------------------------------------------------------------

async function createCarrier(c: Ctx): Promise<UnitRow> {
  const res = await c.json("POST", "/api/units", { model: CARRIER_MODEL, serial: CARRIER_SERIAL, manufacturer: "Carrier", unit_tag: "RTU-7", site: "Pharmacy" });
  return ((await res.json()) as { unit: UnitRow }).unit;
}

describe("corrections", () => {
  test("POST snapshots identity + decoder match, derives app_value, apply updates the unit with PATCH validation", async () => {
    await withServer(async (c) => {
      const unit = await createCarrier(c);
      assert.equal(unit.tonnage, 3);

      const res = await c.json("POST", `/api/units/${unit.id}/corrections`, { field: "tonnage", actual_value: "4", note: "Plate says 4 ton", apply: true });
      assert.equal(res.status, 201);
      const b = (await res.json()) as { correction: CorrectionRow; unit: UnitRow };
      assert.equal(b.correction.field, "tonnage");
      assert.equal(b.correction.app_value, "3");
      assert.equal(b.correction.actual_value, "4");
      assert.equal(b.correction.note, "Plate says 4 ton");
      assert.equal(b.correction.model, CARRIER_MODEL);
      assert.equal(b.correction.serial, CARRIER_SERIAL);
      assert.equal(b.correction.manufacturer, "Carrier");
      assert.equal(b.correction.pack_id, "carrier");
      assert.equal(b.correction.format_id, "carrier-48-50tc");
      assert.equal(b.correction.applied, 1);
      assert.equal(b.correction.status, "open");
      assert.equal(b.correction.unit_id, unit.id);
      assert.equal(b.unit.tonnage, 4);
      assert.equal(c.repos.units.get(unit.id)!.tonnage, 4);

      // manufacture_date points at the serial format; non-applicable field ignores apply.
      const date = (await (await c.json("POST", `/api/units/${unit.id}/corrections`, { field: "manufacture_date", actual_value: "2013-04", apply: true })).json()) as { correction: CorrectionRow };
      assert.equal(date.correction.format_id, "carrier-wwyy-letter-5");
      assert.equal(date.correction.app_value, "2023-W15");
      assert.equal(date.correction.applied, 0);

      // explicit app_value wins; no apply → unit unchanged
      const ref = (await (await c.json("POST", `/api/units/${unit.id}/corrections`, { field: "refrigerant", app_value: "R-410A", actual_value: "R-454B" })).json()) as { correction: CorrectionRow; unit: UnitRow };
      assert.equal(ref.correction.app_value, "R-410A");
      assert.equal(ref.correction.applied, 0);
      assert.equal(ref.unit.refrigerant, "R-410A");

      // apply with an invalid value → 400 and nothing stored
      const beforeCount = c.repos.corrections.list().length;
      await expectError(await c.json("POST", `/api/units/${unit.id}/corrections`, { field: "tonnage", actual_value: "lots", apply: true }), 400, "validation");
      assert.equal(c.repos.corrections.list().length, beforeCount);

      // validation + 404
      await expectError(await c.json("POST", `/api/units/${unit.id}/corrections`, { field: "colour", actual_value: "x" }), 400, "validation");
      await expectError(await c.json("POST", `/api/units/${unit.id}/corrections`, { actual_value: "x" }), 400, "validation");
      await expectError(await c.json("POST", `/api/units/${unit.id}/corrections`, { field: "other" }), 400, "validation");
      await expectError(await c.json("POST", `/api/units/${unit.id}/corrections`, { field: "other", actual_value: "x", apply: "sure" }), 400, "validation");
      await expectError(await c.json("POST", "/api/units/0123456789abcdef/corrections", { field: "other", actual_value: "x" }), 404, "not_found");
      await expectError(await c.json("POST", "/api/units/nope/corrections", { field: "other", actual_value: "x" }), 400, "validation");

      // GET /api/units/:id carries corrections, newest first
      const got = (await (await c.get(`/api/units/${unit.id}`)).json()) as { corrections: CorrectionRow[] };
      assert.equal(got.corrections.length, 3);
      assert.deepEqual(new Set(got.corrections.map((x) => x.field)), new Set(["tonnage", "manufacture_date", "refrigerant"]));
    });
  });

  test("unit without a decode: no pack/format; apply manufacturer updates the column", async () => {
    await withServer(async (c) => {
      const unit = c.repos.units.create({ unit_tag: "AHU-1", site: "Clinic" });
      const b = (await (await c.json("POST", `/api/units/${unit.id}/corrections`, { field: "manufacturer", actual_value: "Trane", apply: true })).json()) as { correction: CorrectionRow; unit: UnitRow };
      assert.equal(b.correction.pack_id, null);
      assert.equal(b.correction.format_id, null);
      assert.equal(b.correction.app_value, null);
      assert.equal(b.correction.model, null);
      assert.equal(b.unit.manufacturer, "Trane");
    });
  });

  test("list by status, export file (attachment, version, app version) marks exported, delete", async () => {
    await withServer(async (c) => {
      const unit = await createCarrier(c);
      await c.json("POST", `/api/units/${unit.id}/corrections`, { field: "voltage", actual_value: "460-3-60" });
      await c.json("POST", `/api/units/${unit.id}/corrections`, { field: "fault_code", actual_value: "Code 3 means LPS open on this board", note: "per IOM p. 42" });

      const all = (await (await c.get("/api/corrections")).json()) as { corrections: CorrectionRow[] };
      assert.equal(all.corrections.length, 2);
      const open = (await (await c.get("/api/corrections?status=open")).json()) as { corrections: CorrectionRow[] };
      assert.equal(open.corrections.length, 2);
      await expectError(await c.get("/api/corrections?status=closed"), 400, "validation");

      // A GET (cross-site <img>, prefetcher) neither exports nor marks anything.
      const evil = (await c.get("/api/corrections")).url.replace("/api/corrections", "/api/corrections/export");
      const crossGet = await fetch(evil, { headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });
      assert.equal(crossGet.status, 404);
      await crossGet.body?.cancel();
      assert.equal(((await (await c.get("/api/corrections?status=open")).json()) as { corrections: unknown[] }).corrections.length, 2);
      // A cross-site POST is rejected by the Origin guard and marks nothing.
      await expectError(await fetch(evil, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" }), 403, "forbidden");
      await expectError(await fetch(evil, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }), 400, "validation");
      assert.equal(((await (await c.get("/api/corrections?status=open")).json()) as { corrections: unknown[] }).corrections.length, 2);

      const res = await c.json("POST", "/api/corrections/export", {});
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="hvac-corrections-2026-09-26\.json"$/);
      const ex = (await res.json()) as { kind: string; version: number; appVersion: string; exportedAt: string; count: number; newlyExported: number; corrections: CorrectionRow[] };
      assert.equal(ex.kind, "hvac-corrections");
      assert.equal(ex.version, 1);
      assert.equal(ex.appVersion, readPackageVersion());
      assert.equal(ex.exportedAt, NOW.toISOString());
      assert.equal(ex.count, 2);
      assert.equal(ex.newlyExported, 2);
      assert.equal(ex.corrections.length, 2);
      assert.ok(ex.corrections.every((x) => x.status === "exported"));
      assert.ok(ex.corrections.some((x) => x.model === CARRIER_MODEL && x.pack_id === "carrier"));

      assert.equal(((await (await c.get("/api/corrections?status=open")).json()) as { corrections: unknown[] }).corrections.length, 0);
      assert.equal(((await (await c.get("/api/corrections?status=exported")).json()) as { corrections: unknown[] }).corrections.length, 2);
      // A second export still contains everything but marks nothing new.
      const ex2 = (await (await c.json("POST", "/api/corrections/export", {})).json()) as { count: number; newlyExported: number };
      assert.equal(ex2.count, 2);
      assert.equal(ex2.newlyExported, 0);

      // The backup export carries corrections too, without changing their status.
      const backup = (await (await c.get("/api/export")).json()) as { corrections: CorrectionRow[] };
      assert.equal(backup.corrections.length, 2);

      const id = all.corrections[0]!.id;
      const del = await c.json("DELETE", `/api/corrections/${id}`);
      assert.equal(del.status, 200);
      assert.deepEqual(await del.json(), { deleted: true, id });
      await expectError(await c.json("DELETE", `/api/corrections/${id}`), 404, "not_found");
      await expectError(await c.json("DELETE", "/api/corrections/bad"), 400, "validation");
      assert.equal(c.repos.corrections.list().length, 1);
    });
  });
});

describe("corrections repo + schema", () => {
  test("table is created on an existing database that predates it; hard-deleting a unit keeps the correction", () => {
    const dir = mkdtempSync(join(tmpdir(), "hvac-corrections-"));
    try {
      const path = join(dir, "old.sqlite");
      const first = openDatabase(path);
      first.raw.exec("DROP TABLE corrections");
      first.close();
      const db = openDatabase(path);
      const repos = createRepos(db);
      const unit = repos.units.create({ model: "M1", serial: "S1" });
      const corr = repos.corrections.create({ unit_id: unit.id, field: "other", actual_value: "x", applied: true });
      assert.equal(corr.applied, 1);
      assert.throws(() => repos.corrections.create({ unit_id: unit.id, field: "bogus" as "other", actual_value: "x" }), /field must be one of/);
      assert.throws(() => repos.corrections.create({ unit_id: unit.id, field: "other", actual_value: "  " }), /actual_value required/);
      assert.throws(() => repos.corrections.create({ unit_id: "0123456789abcdef", field: "other", actual_value: "x" }), /unit not found/);
      repos.units.remove(unit.id);
      assert.equal(repos.corrections.get(corr.id)!.unit_id, null);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("transaction rolls back every write when the callback throws", () => {
    const db = openDatabase(":memory:");
    const repos = createRepos(db);
    assert.throws(() =>
      repos.transaction(() => {
        repos.units.create({ model: "M1" });
        repos.units.create({ model: "M2" });
        throw new Error("boom");
      }),
    );
    assert.equal(repos.units.list().length, 0);
    assert.equal(repos.transaction(() => 7), 7);
    db.close();
  });

  test("findDuplicate: model+serial case-insensitive, ignores archived; serial-less matches site+tag", () => {
    const db = openDatabase(":memory:");
    const repos = createRepos(db);
    const a = repos.units.create({ model: "M1", serial: "S1" });
    const b = repos.units.create({ model: "M2", unit_tag: "RTU-1", site: "Mall" });
    const archived = repos.units.create({ model: "M3", serial: "S3" });
    repos.units.archive(archived.id);
    assert.equal(repos.units.findDuplicate({ model: "m1", serial: "s1" })?.id, a.id);
    assert.equal(repos.units.findDuplicate({ model: "m1", serial: "s2" }), undefined);
    assert.equal(repos.units.findDuplicate({ model: "M3", serial: "S3" }), undefined);
    assert.equal(repos.units.findDuplicate({ serial: "S1" }), undefined);
    assert.equal(repos.units.findDuplicate({ model: "M2", unit_tag: "rtu-1", site: "mall" })?.id, b.id);
    assert.equal(repos.units.findDuplicate({ unit_tag: "RTU-1", site: "Mall" })?.id, b.id);
    assert.equal(repos.units.findDuplicate({ model: "OTHER", unit_tag: "RTU-1", site: "Mall" }), undefined);
    assert.equal(repos.units.findDuplicate({ model: "M2", unit_tag: "RTU-1", site: "Clinic" }), undefined);
    assert.equal(repos.units.findDuplicate({ model: "M2" }), undefined);
    db.close();
  });
});

describe("assistant sees technician corrections", () => {
  function seed(): { repos: Repos; unit: UnitRow; conversationId: string } {
    const repos = createRepos(openDatabase(":memory:"));
    const unit = repos.units.create({ model: CARRIER_MODEL, serial: CARRIER_SERIAL, unit_tag: "RTU-7", tonnage: 3 });
    repos.corrections.create({ unit_id: unit.id, field: "tonnage", app_value: "3", actual_value: "4", note: "nameplate", applied: true });
    const conv = repos.conversations.create({ unit_id: unit.id });
    return { repos, unit, conversationId: conv.id };
  }

  test("get_unit_history includes the corrections, labelled", async () => {
    const { repos, conversationId, unit } = seed();
    const out = await executeTool("get_unit_history", {}, { kb, repos, conversationId, unitId: unit.id, now: NOW });
    assert.equal(out.isError ?? false, false);
    const parsed = JSON.parse(out.content) as { technicianCorrections: { note: string; items: Record<string, unknown>[] } };
    assert.match(parsed.technicianCorrections.note, /Technician corrections - trust these over the decoder/);
    const { date, ...rest } = parsed.technicianCorrections.items[0]! as { date: string };
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(rest, { field: "tonnage", appValue: "3", actualValue: "4", note: "nameplate", appliedToUnit: true });
    assert.match(out.summary, /1 correction/);
  });

  test("unit context block lists corrections; absent section when there are none", () => {
    const { repos, unit } = seed();
    const corrections = repos.corrections.list({ unitId: unit.id });
    const text = unitContextBlock(unit, [], [], "current", NOW, corrections);
    assert.match(text, /TECHNICIAN CORRECTIONS - trust these over the decoder \(1\)/);
    assert.match(text, /tonnage: app said "3", actual "4" \(unit record updated\) — nameplate/);
    assert.doesNotMatch(unitContextBlock(unit, [], [], "current", NOW), /TECHNICIAN CORRECTIONS/);
  });

  test("the chat turn's unit system block carries the corrections", async () => {
    const { repos, conversationId } = seed();
    const client = createFakeClient();
    const config: AppConfig = { ...loadConfig({}) };
    await runTurn({ client, config, kb, repos, log: () => {}, now: () => NOW }, conversationId, { text: "What size is this unit?" }, () => {});
    const system = client.calls[0]!.system as { text: string }[];
    assert.equal(system.length, 2);
    assert.match(system[1]!.text, /TECHNICIAN CORRECTIONS - trust these over the decoder/);
    assert.match(system[1]!.text, /actual "4"/);
  });
});
