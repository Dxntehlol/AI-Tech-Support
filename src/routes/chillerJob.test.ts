/* Chiller readings mode (route + tool + storage + migration) and job clock / signature (routes + reports). */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PROJECT_ROOT, loadConfig } from "../config.ts";
import { loadKnowledge } from "../knowledge/loader.ts";
import { COLUMN_MIGRATIONS, migrateReadingsModeCheck, openDatabase, tableColumns, tableSql, type Db } from "../db/index.ts";
import { SCHEMA_SQL } from "../db/schema.ts";
import { createRepos, type Repos } from "../db/repos.ts";
import { createFakeClient } from "../agent/fakeClient.ts";
import { executeTool, toolDefinitions, type ToolContext } from "../agent/tools.ts";
import type { AppConfig, KnowledgeBase, UnitRow } from "../types.ts";
import { createApp, type AppDeps } from "../app.ts";
import { MAX_SIGNATURE_BYTES, parseSignaturePng } from "./util.ts";
import { minutesOnSite } from "./conversations.ts";
import { formatMinutes } from "../reports.ts";

const NOW = new Date("2026-10-12T15:00:00Z");
/** A 1×1 transparent PNG. */
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG_1PX}`;

let kb: KnowledgeBase;
before(() => {
  kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });
});

interface Ctx {
  db: Db;
  repos: Repos;
  now: { value: Date };
  get(path: string): Promise<Response>;
  json(method: string, path: string, body?: unknown): Promise<Response>;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const db = openDatabase(":memory:");
  const now = { value: NOW };
  const repos = createRepos(db, { now: () => now.value.toISOString() });
  const config: AppConfig = { ...loadConfig({}) };
  const deps: AppDeps = { client: createFakeClient(), config, kb, repos, log: () => {}, now: () => now.value, demo: true, version: "9.9.9" };
  const app = createApp(deps);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ctx: Ctx = {
    db,
    repos,
    now,
    get: (path) => fetch(base + path),
    json: (method, path, body) => fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
  };
  try {
    await fn(ctx);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

async function expectError(res: Response, status: number, code: string): Promise<void> {
  assert.equal(res.status, status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, code);
}

const CHILLER = { refrigerant: "R-134a", chw_supply_f: 44, chw_return_f: 54, chw_flow_gpm: 720, evap_pressure_psig: 35, cond_pressure_psig: 185, outdoor_db_f: 95, compressor_amps: 300, rla: 400, percent_load: 78 };

function makeChiller(repos: Repos, over: Record<string, unknown> = {}): UnitRow {
  return repos.units.create({ model: "CGAM060", unit_tag: "CH-1", site: "Hospital", refrigerant: "R-134a", ...over });
}

// ---------------------------------------------------------------------------
// Chiller
// ---------------------------------------------------------------------------

describe("chiller readings mode", () => {
  test("POST /api/calc/chiller evaluates and, with unit_id, stores a readings row with mode chiller", async () => {
    await withServer(async (c) => {
      const res = await c.json("POST", "/api/calc/chiller", CHILLER);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { condenserType: string; derived: Record<string, number>; findings: { ruleId: string }[]; summary: string; readingId?: string };
      assert.equal(body.condenserType, "air_cooled");
      assert.equal(body.derived.chwDeltaTF, 10);
      assert.equal(body.derived.tons, 300);
      assert.ok((body.derived.condApproachF ?? 0) > 25);
      assert.ok(body.findings.some((f) => f.ruleId === "chiller_cond_approach_high_air"));
      assert.equal("readingId" in body, false);

      const unit = makeChiller(c.repos);
      const conv = c.repos.conversations.create({ unit_id: unit.id });
      const stored = await c.json("POST", "/api/calc/chiller", { ...CHILLER, refrigerant: undefined, unit_id: unit.id, conversation_id: conv.id, note: "after coil wash" });
      assert.equal(stored.status, 200);
      const sb = (await stored.json()) as { readingId: string; derived: Record<string, number> };
      assert.match(sb.readingId, /^[0-9a-f]{16}$/);
      assert.ok(sb.derived.evapApproachF !== undefined, "refrigerant defaulted from the unit so pressures converted");
      const list = (await (await c.get(`/api/units/${unit.id}/readings`)).json()) as { readings: Record<string, unknown>[] };
      assert.equal(list.readings.length, 1);
      const r = list.readings[0]!;
      assert.equal(r.mode, "chiller");
      assert.equal(r.refrigerant, "R-134a");
      assert.equal(r.metering_device, "unknown");
      assert.equal(r.source, "sheet");
      assert.equal(r.note, "after coil wash");
      assert.equal((r.measurements as { chwSupplyF: number }).chwSupplyF, 44);
      assert.equal((r.measurements as { condenserType: string }).condenserType, "air_cooled");
      assert.equal((r.derived as { tons: number }).tons, 300);
      const unitPage = (await (await c.get(`/api/units/${unit.id}`)).json()) as { lastReading: { mode: string } | null; trend: unknown };
      assert.equal(unitPage.lastReading?.mode, "chiller");
      assert.equal(unitPage.trend, null, "no DX trend over chiller rows");
      // a DX diagnosis on the same unit still works alongside
      const dx = await c.json("POST", "/api/calc/diagnose", { refrigerant: "R-134a", metering_device: "txv", mode: "ac_cooling", suction_psig: 35, suction_line_temp_f: 50, unit_id: unit.id });
      assert.equal(dx.status, 200);

      await expectError(await c.json("POST", "/api/calc/chiller", {}), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/chiller", { chw_supply_f: 44, refrigerant: "R-999" }), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/chiller", { chw_supply_f: 44, condenser_type: "evaporative" }), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/chiller", { chw_supply_f: 44, unit_id: "0123456789abcdef" }), 404, "not_found");
      await expectError(await c.json("POST", "/api/calc/chiller", { chw_supply_f: "warm" }), 400, "validation");
    });
  });

  test("diagnose_chiller tool: stores on an attached unit, errors without readings, strict schema", async () => {
    const repos = createRepos(openDatabase(":memory:"), { now: () => NOW.toISOString() });
    const unit = makeChiller(repos);
    const conv = repos.conversations.create({ unit_id: unit.id });
    const ctx: ToolContext = { kb, repos, conversationId: conv.id, unitId: unit.id, now: NOW };
    const r = await executeTool("diagnose_chiller", { chw_supply_f: 44, chw_return_f: 54, evap_pressure_psig: 35, cond_pressure_psig: 185, cond_water_out_f: 95 }, ctx);
    assert.equal(r.isError, undefined, r.content);
    const j = JSON.parse(r.content) as { condenserType: string; derived: Record<string, number>; readingId: string; findings: { ruleId: string }[] };
    assert.equal(j.condenserType, "water_cooled");
    assert.ok((j.derived.condApproachF ?? 0) > 5);
    assert.ok(j.findings.some((f) => f.ruleId === "chiller_cond_approach_high_water"));
    assert.match(j.readingId, /^[0-9a-f]{16}$/);
    assert.equal(repos.readings.list({ unitId: unit.id })[0]!.source, "chat");
    assert.match(r.summary, /cond approach/);
    const none = await executeTool("diagnose_chiller", {}, ctx);
    assert.equal(none.isError, true);
    const bad = await executeTool("diagnose_chiller", { chw_supply_f: 44, refrigerant: "R-999" }, ctx);
    assert.equal(bad.isError, true);
    const noUnit = await executeTool("diagnose_chiller", { chw_supply_f: 44, chw_return_f: 50 }, { ...ctx, unitId: null });
    assert.equal(noUnit.isError, undefined);
    assert.equal((JSON.parse(noUnit.content) as { readingId?: string }).readingId, undefined);
    const def = toolDefinitions().find((d) => d.name === "diagnose_chiller")!;
    const props = (def.input_schema as { properties: Record<string, { anyOf?: unknown[] }>; required: string[] }).properties;
    assert.ok(props.chw_supply_f && props.cond_pressure_psig && props.oil_temp_f);
    assert.deepEqual(props.condenser_type!.anyOf, [{ type: "string", enum: ["water_cooled", "air_cooled"] }, { type: "null" }]);
  });

  test("an old readings table (mode CHECK without chiller) is rebuilt in place with its rows kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "hvac-chiller-mig-"));
    const path = join(dir, "old.sqlite");
    try {
      const legacy = SCHEMA_SQL.replace("'refrigeration','chiller'", "'refrigeration'");
      assert.ok(!legacy.includes("'chiller'"));
      const old = new DatabaseSync(path);
      old.exec(legacy);
      old.exec("INSERT INTO units (id, model, created_at, updated_at) VALUES ('0123456789abcdef', 'X', 't', 't');");
      old.exec("INSERT INTO readings (id, unit_id, created_at, mode, refrigerant, metering_device, measurements_json, derived_json, validity_json, findings_json) VALUES ('0123456789abcde0', '0123456789abcdef', '2026-01-01T00:00:00Z', 'ac_cooling', 'R-410A', 'txv', '{}', '{}', '{}', '[]');");
      assert.throws(() => old.exec("INSERT INTO readings (id, unit_id, created_at, mode, refrigerant, metering_device, measurements_json, derived_json, validity_json, findings_json) VALUES ('0123456789abcde1', '0123456789abcdef', 't', 'chiller', 'R-134a', 'unknown', '{}', '{}', '{}', '[]');"), /CHECK/);
      old.close();
      const db = openDatabase(path);
      try {
        assert.match(tableSql(db.raw, "readings") ?? "", /'chiller'/);
        assert.equal(migrateReadingsModeCheck(db.raw), false, "idempotent");
        const repos = createRepos(db);
        assert.equal(repos.readings.get("0123456789abcde0")?.mode, "ac_cooling");
        const row = repos.readings.create({ unit_id: "0123456789abcdef", mode: "chiller", refrigerant: "R-134a", metering_device: "unknown", measurements_json: {}, derived_json: {}, validity_json: {}, findings_json: [] });
        assert.equal(row.mode, "chiller");
        const idx = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='readings'").all() as { name: string }[]).map((r) => r.name);
        assert.ok(idx.includes("idx_readings_unit_created"));
        for (const m of COLUMN_MIGRATIONS) assert.ok(tableColumns(db.raw, m.table).has(m.column), `${m.table}.${m.column}`);
        const fk = db.raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
        assert.equal(fk.foreign_keys, 1, "foreign keys back on");
      } finally {
        db.close();
      }
      openDatabase(path).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("units / conversations columns are added to a database created before them", () => {
    const dir = mkdtempSync(join(tmpdir(), "hvac-cols-mig-"));
    const path = join(dir, "old.sqlite");
    try {
      const legacy = SCHEMA_SQL.replace(",\n  full_charge_lbs REAL,\n  appliance_type TEXT,\n  circuits_count INTEGER\n", "\n").replace(",\n  job_started_at TEXT,\n  job_ended_at TEXT,\n  signature_png TEXT,\n  signed_by TEXT,\n  signed_at TEXT,\n  signature_note TEXT\n", "\n");
      assert.ok(!legacy.includes("full_charge_lbs") && !legacy.includes("signature_png"), "legacy schema stripped");
      const old = new DatabaseSync(path);
      old.exec(legacy);
      old.exec("INSERT INTO units (id, model, created_at, updated_at) VALUES ('0123456789abcdef', 'X', 't', 't');");
      old.exec("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('0123456789abcde1', 'c', 't', 't');");
      old.close();
      const db = openDatabase(path);
      try {
        const repos = createRepos(db);
        assert.equal(repos.units.get("0123456789abcdef")?.full_charge_lbs, null);
        assert.equal(repos.units.update("0123456789abcdef", { full_charge_lbs: 30, appliance_type: "comfort_cooling" })?.full_charge_lbs, 30);
        const c = repos.conversations.get("0123456789abcde1")!;
        assert.equal(c.job_started_at, null);
        assert.equal(repos.conversations.setJob(c.id, { job_started_at: "2026-01-01T00:00:00Z" })?.job_started_at, "2026-01-01T00:00:00Z");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Job clock + signature
// ---------------------------------------------------------------------------

describe("job clock and signature", () => {
  test("POST /api/conversations/:id/job start → stop → clear; payload exposes the clock fields and minutes", async () => {
    await withServer(async (c) => {
      const conv = c.repos.conversations.create({ title: "Job" });
      await expectError(await c.json("POST", `/api/conversations/${conv.id}/job`, { action: "stop" }), 400, "validation");
      await expectError(await c.json("POST", `/api/conversations/${conv.id}/job`, { action: "pause" }), 400, "validation");
      await expectError(await c.json("POST", `/api/conversations/${conv.id}/job`, {}), 400, "validation");
      await expectError(await c.json("POST", "/api/conversations/0123456789abcdef/job", { action: "start" }), 404, "not_found");
      const started = (await (await c.json("POST", `/api/conversations/${conv.id}/job`, { action: "start" })).json()) as { conversation: Record<string, unknown> };
      assert.equal(started.conversation.job_started_at, NOW.toISOString());
      assert.equal(started.conversation.job_ended_at, null);
      assert.equal(started.conversation.minutes_on_site, null);
      c.now.value = new Date(NOW.getTime() + 95 * 60_000);
      const stopped = (await (await c.json("POST", `/api/conversations/${conv.id}/job`, { action: "stop" })).json()) as { conversation: Record<string, unknown> };
      assert.equal(stopped.conversation.minutes_on_site, 95);
      const got = (await (await c.get(`/api/conversations/${conv.id}`)).json()) as { conversation: Record<string, unknown>; signature?: unknown };
      assert.equal(got.conversation.job_ended_at, c.now.value.toISOString());
      assert.equal(got.conversation.minutes_on_site, 95);
      assert.equal(got.conversation.signed, false);
      assert.equal("signature_png" in got.conversation, false);
      assert.equal("signature" in got, false);
      const listed = (await (await c.get("/api/conversations")).json()) as { conversations: Record<string, unknown>[] };
      assert.equal(listed.conversations[0]!.minutes_on_site, 95);
      // restart resets the end
      const again = (await (await c.json("POST", `/api/conversations/${conv.id}/job`, { action: "start" })).json()) as { conversation: Record<string, unknown> };
      assert.equal(again.conversation.job_ended_at, null);
      const cleared = (await (await c.json("POST", `/api/conversations/${conv.id}/job`, { action: "clear" })).json()) as { conversation: Record<string, unknown> };
      assert.equal(cleared.conversation.job_started_at, null);
      assert.equal(minutesOnSite("2026-01-01T10:00:00Z", "2026-01-01T09:00:00Z"), null);
      assert.equal(minutesOnSite("2026-01-01T10:00:00Z", "2026-01-01T12:30:30Z"), 151);
      assert.equal(formatMinutes(151), "2 h 31 min");
      assert.equal(formatMinutes(45), "45 min");
    });
  });

  test("POST/DELETE /api/conversations/:id/signature validates the PNG data URL; GET ?include=signature returns it", async () => {
    await withServer(async (c) => {
      const conv = c.repos.conversations.create({ title: "Job" });
      await expectError(await c.json("POST", `/api/conversations/${conv.id}/signature`, {}), 400, "validation");
      await expectError(await c.json("POST", `/api/conversations/${conv.id}/signature`, { png: "data:image/jpeg;base64,/9j/4AAQ" }), 400, "validation");
      await expectError(await c.json("POST", `/api/conversations/${conv.id}/signature`, { png: `data:image/png;base64,${Buffer.from("GIF89a not a png at all").toString("base64")}` }), 400, "validation");
      await expectError(await c.json("POST", `/api/conversations/${conv.id}/signature`, { png: "data:image/png;base64,###" }), 400, "validation");
      const big = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_SIGNATURE_BYTES)]).toString("base64")}`;
      await expectError(await c.json("POST", `/api/conversations/${conv.id}/signature`, { png: big }), 400, "validation");
      await expectError(await c.json("POST", "/api/conversations/0123456789abcdef/signature", { png: PNG_URL }), 404, "not_found");
      const res = await c.json("POST", `/api/conversations/${conv.id}/signature`, { png: PNG_URL, signed_by: "J. Customer", note: "declined coil cleaning" });
      assert.equal(res.status, 201);
      const { conversation } = (await res.json()) as { conversation: Record<string, unknown> };
      assert.equal(conversation.signed_by, "J. Customer");
      assert.equal(conversation.signed_at, NOW.toISOString());
      assert.equal(conversation.signature_note, "declined coil cleaning");
      assert.equal(conversation.signed, true);
      assert.equal("signature_png" in conversation, false, "the png never rides on the row");
      const plain = (await (await c.get(`/api/conversations/${conv.id}`)).json()) as Record<string, unknown>;
      assert.equal("signature" in plain, false);
      assert.equal(JSON.stringify(plain).includes(PNG_1PX), false);
      const withSig = (await (await c.get(`/api/conversations/${conv.id}?include=signature`)).json()) as { signature: { png: string; signed_by: string; note: string } };
      assert.equal(withSig.signature.png, PNG_URL);
      assert.equal(withSig.signature.signed_by, "J. Customer");
      assert.equal(parseSignaturePng(` ${PNG_URL} `), PNG_URL);
      const del = await c.json("DELETE", `/api/conversations/${conv.id}/signature`);
      assert.equal(del.status, 200);
      const after = (await (await c.get(`/api/conversations/${conv.id}?include=signature`)).json()) as { conversation: Record<string, unknown>; signature: unknown };
      assert.equal(after.signature, null);
      assert.equal(after.conversation.signed, false);
      assert.equal(after.conversation.signed_by, null);
    });
  });

  test("reports: time on site, signature image (html) / note (md), owner documentation and PM blocks", async () => {
    await withServer(async (c) => {
      const unit = c.repos.units.create({ model: "RACK-A", unit_tag: "Rack A", site: "Grocery 12", refrigerant: "R-404A", full_charge_lbs: 400, appliance_type: "commercial_refrigeration" });
      const conv = c.repos.conversations.create({ title: "Rack A leak", unit_id: unit.id });
      c.repos.conversations.setJob(conv.id, { job_started_at: "2026-10-12T13:00:00.000Z", job_ended_at: "2026-10-12T15:05:00.000Z" });
      c.repos.conversations.setSignature(conv.id, { png: PNG_URL, signed_by: "J. Customer <mgr>", note: "declined recommendation", signed_at: NOW.toISOString() });
      c.repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "add", amount_lbs: 10, date: "2026-01-01" });
      c.repos.refrigerantEvents.create({ unit_id: unit.id, conversation_id: conv.id, event_type: "add", amount_lbs: 25, date: "2026-03-02", cylinder_id: "CYL-7", tech_name: "Sam", tech_cert: "608-1", note: "<b>flare</b>" });
      const { evaluateForUnit } = await import("../pmStore.ts");
      const { findTemplate } = await import("../knowledge/pm.ts");
      const template = findTemplate(kb.pm, "walk_in_cooler")!;
      const results = { box_temp: { asFound: 46, asLeft: 37 }, door_gaskets: { checked: false, note: "torn" } };
      c.repos.pmVisits.create({ unit_id: unit.id, conversation_id: conv.id, template_id: "walk_in_cooler", status: "complete", results_json: results, summary_json: evaluateForUnit(template, results, unit) });

      const json = (await (await c.get(`/api/conversations/${conv.id}/report?format=json`)).json()) as {
        job: { minutesOnSite: number };
        signature: { signedBy: string; png: string };
        ownerDocumentation: { events: { amountLbs: number; leakRatePct: number | null }[]; obligations: { kind: string }[]; formula: string; exceeded: boolean };
        pm: { templateName: string; fail: number; fails: string[] };
      };
      assert.equal(json.job.minutesOnSite, 125);
      assert.equal(json.signature.signedBy, "J. Customer <mgr>");
      assert.equal(json.signature.png, PNG_URL);
      assert.equal(json.ownerDocumentation.events.length, 1, "conversation report lists the events logged in this conversation");
      assert.equal(json.ownerDocumentation.events[0]!.leakRatePct, 38.02);
      assert.equal(json.ownerDocumentation.exceeded, true);
      assert.ok(json.ownerDocumentation.obligations.some((o) => o.kind === "repair"));
      assert.match(json.ownerDocumentation.formula, /365/);
      assert.equal(json.pm.templateName, "Walk-in cooler (medium temperature)");
      assert.equal(json.pm.fail, 1);
      assert.match(json.pm.fails[0]!, /Door gaskets.*torn/);

      const md = await (await c.get(`/api/conversations/${conv.id}/report`)).text();
      assert.match(md, /\*\*Time on site:\*\* 2 h 05 min \(2026-10-12 13:00 UTC → 2026-10-12 15:05 UTC\)/);
      assert.match(md, /## Owner documentation/);
      assert.match(md, /- 2026-03-02 · \*\*add\*\* · 25 lb R-404A · leak rate 38.02 %\/yr vs 20 % threshold — EXCEEDED · cylinder CYL-7 · tech Sam cert 608-1 · <b>flare<\/b>/);
      assert.match(md, /\*\*OVERDUE\*\* Repair within 30 days of 2026-03-02/);
      assert.match(md, /## Preventive maintenance[\s\S]*Walk-in cooler[\s\S]*1 pass \/ 1 fail/);
      assert.match(md, /## Customer signature\n\nSigned by J. Customer <mgr> on 2026-10-12 15:00 UTC — declined recommendation \(signature image in the printable report\)/);
      assert.equal(md.includes(PNG_1PX), false);

      const html = await (await c.get(`/api/conversations/${conv.id}/report?format=html`)).text();
      assert.match(html, /<b>Time on site<\/b>2 h 05 min/);
      assert.match(html, new RegExp(`<img src="${PNG_URL.replace(/[+/]/g, (ch) => `\\${ch}`)}" alt="Customer signature">`));
      assert.match(html, /J\. Customer &lt;mgr&gt;/);
      assert.match(html, /Owner documentation \(refrigerant \/ EPA leak-repair record\)/);
      assert.match(html, /&lt;b&gt;flare&lt;\/b&gt;/, "notes are escaped");
      assert.match(html, /<span class="ex">EXCEEDED<\/span>/);
      assert.match(html, /Preventive maintenance/);
      assert.match(html, /Formula: leak rate %/);

      // unit report: every event, compliance and the last PM
      const unitJson = (await (await c.get(`/api/units/${unit.id}/report?format=json`)).json()) as { ownerDocumentation: { events: unknown[] }; pm: { templateId: string } };
      assert.equal(unitJson.ownerDocumentation.events.length, 2);
      assert.equal(unitJson.pm.templateId, "walk_in_cooler");
      const unitMd = await (await c.get(`/api/units/${unit.id}/report`)).text();
      assert.match(unitMd, /## Owner documentation[\s\S]*2026-01-01 · \*\*add\*\* · 10 lb R-404A/);
      // a conversation with nothing: blocks say so, no signature
      const empty = c.repos.conversations.create({ title: "Nothing" });
      const emptyMd = await (await c.get(`/api/conversations/${empty.id}/report`)).text();
      assert.match(emptyMd, /_No refrigerant events or full charge recorded._/);
      assert.match(emptyMd, /_No PM visit recorded._/);
      assert.match(emptyMd, /## Customer signature\n\n_Not signed._/);
      assert.doesNotMatch(emptyMd, /Time on site/);
    });
  });
});
