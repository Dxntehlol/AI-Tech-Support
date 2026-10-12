/* Readings history + follow-ups: routes (withServer pattern from app.test.ts), the diagnose/save_finding/
 * get_unit_history tools, and the unit context block. */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PROJECT_ROOT, loadConfig } from "../config.ts";
import { loadKnowledge } from "../knowledge/loader.ts";
import { openDatabase, type Db } from "../db/index.ts";
import { createRepos, type Repos } from "../db/repos.ts";
import { createFakeClient } from "../agent/fakeClient.ts";
import { executeTool, type ToolContext } from "../agent/tools.ts";
import { staticSystemPrompt, unitContextBlock } from "../agent/systemPrompt.ts";
import type { AppConfig, KnowledgeBase, UnitRow } from "../types.ts";
import { createApp, type AppDeps } from "../app.ts";
import { addDays, followUpCounts } from "./followups.ts";

const NOW = new Date("2026-09-26T12:00:00Z");
const TODAY = "2026-09-26";

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
  const repos = createRepos(db, { now: () => NOW.toISOString() });
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

async function expectError(res: Response, status: number, code: string): Promise<void> {
  assert.equal(res.status, status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, code);
}

/** A healthy R-410A TXV system (DESIGN.md "normal system" vector). */
const NORMAL = {
  refrigerant: "R-410A",
  metering_device: "txv",
  mode: "ac_cooling",
  outdoor_db_f: 85,
  indoor_db_f: 75,
  indoor_wb_f: 63,
  supply_db_f: 57,
  suction_psig: 118,
  suction_line_temp_f: 52,
  liquid_psig: 340,
  liquid_line_temp_f: 95,
  compressor_amps: 20,
  compressor_rla: 25,
  runtime_minutes: 20,
};
/** Same unit two months later, charge leaking out: high SH, low SC, low suction/head, weak delta-T. */
const LOW_CHARGE = { ...NORMAL, outdoor_db_f: 88, supply_db_f: 63, suction_psig: 100, suction_line_temp_f: 60, liquid_psig: 300, liquid_line_temp_f: 94, compressor_amps: 16 };

function makeUnit(repos: Repos, over: Record<string, unknown> = {}): UnitRow {
  return repos.units.create({ model: "48TCDA04A2A5-0A0A0", serial: "3216E54321", unit_tag: "RTU-7", site: "Main St store", refrigerant: "R-410A", metering_device: "txv", ...over });
}

// ---------------------------------------------------------------------------
// Readings routes
// ---------------------------------------------------------------------------

describe("readings history routes", () => {
  test("POST /api/calc/diagnose without unit_id stores nothing and keeps its shape", async () => {
    await withServer(async (c) => {
      const res = await c.json("POST", "/api/calc/diagnose", NORMAL);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.ok(body.derived && body.validity && Array.isArray(body.findings) && typeof body.summary === "string");
      assert.equal("readingId" in body, false);
    });
  });

  test("POST /api/calc/diagnose with unit_id stores a readings row and returns readingId; GET lists it newest first", async () => {
    await withServer(async (c) => {
      const unit = makeUnit(c.repos);
      const conv = c.repos.conversations.create({ unit_id: unit.id });
      const res = await c.json("POST", "/api/calc/diagnose", { ...NORMAL, unit_id: unit.id, conversation_id: conv.id, note: "after coil cleaning" });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { readingId: string; derived: { superheatF: number; subcoolingF: number }; validity: { ok: boolean } };
      assert.match(body.readingId, /^[0-9a-f]{16}$/);
      assert.ok(body.derived.superheatF > 5 && body.derived.subcoolingF > 5);

      const list = await c.get(`/api/units/${unit.id}/readings`);
      assert.equal(list.status, 200);
      const { readings, trend } = (await list.json()) as { readings: Record<string, unknown>[]; trend: unknown };
      assert.equal(readings.length, 1);
      assert.equal(trend, null);
      const r = readings[0]!;
      assert.equal(r.id, body.readingId);
      assert.equal(r.unit_id, unit.id);
      assert.equal(r.conversation_id, conv.id);
      assert.equal(r.mode, "ac_cooling");
      assert.equal(r.refrigerant, "R-410A");
      assert.equal(r.metering_device, "txv");
      assert.equal(r.source, "sheet");
      assert.equal(r.note, "after coil cleaning");
      assert.equal((r.measurements as { suctionPsig: number }).suctionPsig, 118);
      assert.equal((r.measurements as { outdoorDbF: number }).outdoorDbF, 85);
      assert.equal((r.derived as { superheatF: number }).superheatF, body.derived.superheatF);
      assert.equal((r.validity as { ok: boolean }).ok, body.validity.ok);
      for (const f of r.findings as Record<string, unknown>[]) assert.deepEqual(Object.keys(f).sort(), ["ruleId", "severity"]);
      assert.equal(r.created_at, NOW.toISOString());

      const unitRes = await c.get(`/api/units/${unit.id}`);
      const u = (await unitRes.json()) as { lastReading: { id: string } | null; trend: unknown };
      assert.equal(u.lastReading?.id, body.readingId);
      assert.equal(u.trend, null);
    });
  });

  test("a second visit in the same mode and ambient yields a trend on GET /api/units/:id and the readings list", async () => {
    await withServer(async (c) => {
      const unit = makeUnit(c.repos);
      // first visit two months earlier
      c.repos.readings.create({
        unit_id: unit.id,
        mode: "ac_cooling",
        refrigerant: "R-410A",
        metering_device: "txv",
        measurements_json: { outdoorDbF: 85, suctionPsig: 118, liquidPsig: 340 },
        derived_json: { superheatF: 12, subcoolingF: 12, condSatF: 105, evapSatF: 40, deltaTF: 18, ampsPercentRla: 80 },
        validity_json: { ok: true, issues: [] },
        findings_json: [],
        source: "sheet",
        created_at: "2026-08-02T10:00:00.000Z",
      });
      const res = await c.json("POST", "/api/calc/diagnose", { ...LOW_CHARGE, unit_id: unit.id });
      assert.equal(res.status, 200);
      const u = (await (await c.get(`/api/units/${unit.id}`)).json()) as { trend: { since: string; lines: string[]; deltas: { metric: string; direction: string }[] } | null };
      assert.ok(u.trend, "trend present");
      assert.equal(u.trend.since, "2026-08-02");
      const by = Object.fromEntries(u.trend.deltas.map((d) => [d.metric, d.direction]));
      assert.equal(by.subcoolingF, "down");
      assert.equal(by.superheatF, "up");
      assert.equal(by.suctionPsig, "down");
      assert.ok(u.trend.lines.some((l) => /^Subcooling fell from 12 to [\d.]+ °F since 2026-08-02 \(same mode\) - charge loss or restriction trend$/.test(l)), u.trend.lines.join("\n"));
      const list = (await (await c.get(`/api/units/${unit.id}/readings?limit=1`)).json()) as { readings: unknown[]; trend: { since: string } | null };
      assert.equal(list.readings.length, 1, "limit applies to the list");
      assert.equal(list.trend?.since, "2026-08-02", "trend still computed over the window");
    });
  });

  test("no trend across modes or when ambient differs by more than 15 °F", async () => {
    await withServer(async (c) => {
      const unit = makeUnit(c.repos);
      c.repos.readings.create({
        unit_id: unit.id,
        mode: "ac_cooling",
        refrigerant: "R-410A",
        metering_device: "txv",
        measurements_json: { outdoorDbF: 65, suctionPsig: 118 },
        derived_json: { superheatF: 12, subcoolingF: 12 },
        validity_json: { ok: true, issues: [] },
        findings_json: [],
        created_at: "2026-08-02T10:00:00.000Z",
      });
      await c.json("POST", "/api/calc/diagnose", { ...LOW_CHARGE, unit_id: unit.id }); // outdoor 88: 23 °F warmer
      let u = (await (await c.get(`/api/units/${unit.id}`)).json()) as { trend: unknown };
      assert.equal(u.trend, null);
      await c.json("POST", "/api/calc/diagnose", { ...LOW_CHARGE, mode: "heat_pump_heating", unit_id: unit.id });
      u = (await (await c.get(`/api/units/${unit.id}`)).json()) as { trend: unknown };
      assert.equal(u.trend, null);
    });
  });

  test("validation: unknown unit → 404, bad ids → 400, limit bounds, DELETE scoped to the unit", async () => {
    await withServer(async (c) => {
      await expectError(await c.json("POST", "/api/calc/diagnose", { ...NORMAL, unit_id: "0123456789abcdef" }), 404, "not_found");
      await expectError(await c.json("POST", "/api/calc/diagnose", { ...NORMAL, unit_id: "nope" }), 400, "validation");
      await expectError(await c.get("/api/units/nope/readings"), 400, "validation");
      await expectError(await c.get("/api/units/0123456789abcdef/readings"), 404, "not_found");
      const unit = makeUnit(c.repos);
      const other = makeUnit(c.repos, { unit_tag: "RTU-8", serial: "3216E99999" });
      await expectError(await c.get(`/api/units/${unit.id}/readings?limit=0`), 400, "validation");
      await expectError(await c.get(`/api/units/${unit.id}/readings?limit=201`), 400, "validation");
      const { readingId } = (await (await c.json("POST", "/api/calc/diagnose", { ...NORMAL, unit_id: unit.id })).json()) as { readingId: string };
      await expectError(await c.json("DELETE", `/api/units/${other.id}/readings/${readingId}`), 404, "not_found");
      await expectError(await c.json("DELETE", `/api/units/${unit.id}/readings/zzz`), 400, "validation");
      const del = await c.json("DELETE", `/api/units/${unit.id}/readings/${readingId}`);
      assert.equal(del.status, 200);
      assert.deepEqual(await del.json(), { deleted: true, id: readingId });
      await expectError(await c.json("DELETE", `/api/units/${unit.id}/readings/${readingId}`), 404, "not_found");
      const list = (await (await c.get(`/api/units/${unit.id}/readings`)).json()) as { readings: unknown[] };
      assert.equal(list.readings.length, 0);
      // 20 by default
      for (let i = 0; i < 25; i++) await c.json("POST", "/api/calc/diagnose", { ...NORMAL, unit_id: unit.id });
      const dflt = (await (await c.get(`/api/units/${unit.id}/readings`)).json()) as { readings: unknown[] };
      assert.equal(dflt.readings.length, 20);
    });
  });
});

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

describe("follow-ups", () => {
  test("findings accept follow_up_due / follow_up_done on POST and PATCH, validate the date", async () => {
    await withServer(async (c) => {
      const unit = makeUnit(c.repos);
      const res = await c.json("POST", "/api/findings", { unit_id: unit.id, symptom: "Low SC", status: "monitor", follow_up: "Recheck subcooling", follow_up_due: "2026-10-10" });
      assert.equal(res.status, 201);
      const { finding } = (await res.json()) as { finding: Record<string, unknown> };
      assert.equal(finding.follow_up_due, "2026-10-10");
      assert.equal(finding.follow_up_done, 0);
      await expectError(await c.json("POST", "/api/findings", { symptom: "x", follow_up: "y", follow_up_due: "10/10/2026" }), 400, "validation");
      await expectError(await c.json("POST", "/api/findings", { symptom: "x", follow_up: "y", follow_up_due: "2026-02-30" }), 400, "validation");
      await expectError(await c.json("PATCH", `/api/findings/${finding.id}`, { follow_up_done: "maybe" }), 400, "validation");
      const patched = await c.json("PATCH", `/api/findings/${finding.id}`, { follow_up_done: true, follow_up_due: null });
      assert.equal(patched.status, 200);
      const pf = ((await patched.json()) as { finding: Record<string, unknown> }).finding;
      assert.equal(pf.follow_up_done, 1);
      assert.equal(pf.follow_up_due, null);
      const got = ((await (await c.get(`/api/findings/${finding.id}`)).json()) as { finding: Record<string, unknown> }).finding;
      assert.equal(got.follow_up_done, 1);
    });
  });

  test("GET /api/followups joins unit + conversation, sorts due first (nulls last), filters by status and counts overdue / due this week", async () => {
    await withServer(async (c) => {
      const unit = makeUnit(c.repos);
      const conv = c.repos.conversations.create({ unit_id: unit.id, title: "RTU-7 low charge" });
      const mk = (over: Record<string, unknown>) => c.repos.findings.create({ unit_id: unit.id, conversation_id: conv.id, symptom: "s", ...over });
      const overdue = mk({ follow_up: "Leak search ckt 2", follow_up_due: "2026-09-01" });
      const soon = mk({ follow_up: "Recheck SC", follow_up_due: "2026-09-30" });
      const later = mk({ follow_up: "Replace contactor", follow_up_due: "2026-12-01" });
      const undated = mk({ follow_up: "Call customer" });
      mk({ follow_up: "Done item", follow_up_due: "2026-08-01", follow_up_done: 1 });
      mk({ follow_up: "   " }); // blank follow-up: not a follow-up
      mk({ cause: "no follow up" });

      const open = (await (await c.get("/api/followups")).json()) as { followups: Record<string, unknown>[]; counts: Record<string, number>; today: string };
      assert.equal(open.today, TODAY);
      assert.deepEqual(open.followups.map((f) => f.id), [overdue.id, soon.id, later.id, undated.id]);
      assert.deepEqual(open.counts, { open: 4, overdue: 1, dueThisWeek: 1 });
      const row = open.followups[0]!;
      assert.equal(row.unit_site, "Main St store");
      assert.equal(row.unit_tag, "RTU-7");
      assert.equal(row.unit_model, "48TCDA04A2A5-0A0A0");
      assert.equal(row.conversation_title, "RTU-7 low charge");
      assert.equal(row.follow_up, "Leak search ckt 2");

      const done = (await (await c.get("/api/followups?status=done")).json()) as { followups: Record<string, unknown>[]; counts: Record<string, number> };
      assert.equal(done.followups.length, 1);
      assert.equal(done.followups[0]!.follow_up, "Done item");
      assert.deepEqual(done.counts, { open: 4, overdue: 1, dueThisWeek: 1 }, "counts always describe the open set");

      const all = (await (await c.get("/api/followups?status=all&limit=2")).json()) as { followups: unknown[] };
      assert.equal(all.followups.length, 2);
      await expectError(await c.get("/api/followups?status=later"), 400, "validation");
      await expectError(await c.get("/api/followups?limit=0"), 400, "validation");

      // marking done moves it out of the open list and the counts
      await c.json("PATCH", `/api/findings/${overdue.id}`, { follow_up_done: 1 });
      const after = (await (await c.get("/api/followups")).json()) as { followups: Record<string, unknown>[]; counts: Record<string, number> };
      assert.deepEqual(after.followups.map((f) => f.id), [soon.id, later.id, undated.id]);
      assert.deepEqual(after.counts, { open: 3, overdue: 0, dueThisWeek: 1 });
    });
  });

  test("followUpCounts is pure: today inclusive, 7-day window, done rows ignored", () => {
    const f = (follow_up_due: string | null, follow_up_done: 0 | 1 = 0) =>
      ({ follow_up: "x", follow_up_due, follow_up_done }) as unknown as Parameters<typeof followUpCounts>[0][number];
    assert.deepEqual(followUpCounts([f("2026-09-25"), f("2026-09-26"), f("2026-10-03"), f("2026-10-04"), f(null), f("2026-01-01", 1)], TODAY), { open: 5, overdue: 1, dueThisWeek: 2 });
    assert.equal(addDays("2026-12-30", 7), "2027-01-06");
  });
});

// ---------------------------------------------------------------------------
// Assistant: tools and unit context
// ---------------------------------------------------------------------------

describe("assistant readings + follow-ups", () => {
  function fresh(unitId: string | null): { repos: Repos; ctx: ToolContext } {
    const repos = createRepos(openDatabase(":memory:"));
    const conv = repos.conversations.create(unitId ? { unit_id: unitId } : {});
    return { repos, ctx: { kb, repos, conversationId: conv.id, unitId, now: NOW } };
  }

  test("diagnose_refrigeration stores a chat-sourced reading only when a unit is attached, and reports the trend", async () => {
    const repos = createRepos(openDatabase(":memory:"));
    const unit = makeUnit(repos);
    const noUnit = repos.conversations.create({});
    const r0 = await executeTool("diagnose_refrigeration", NORMAL, { kb, repos, conversationId: noUnit.id, unitId: null, now: NOW });
    assert.equal(r0.isError, undefined);
    assert.equal((JSON.parse(r0.content) as { readingId?: string }).readingId, undefined);
    assert.equal(repos.readings.list({ unitId: unit.id }).length, 0);

    const conv = repos.conversations.create({ unit_id: unit.id });
    const ctx: ToolContext = { kb, repos, conversationId: conv.id, unitId: unit.id, now: NOW };
    const r1 = await executeTool("diagnose_refrigeration", NORMAL, ctx);
    const j1 = JSON.parse(r1.content) as { readingId: string; trendSinceLastVisit?: string[] };
    assert.match(j1.readingId, /^[0-9a-f]{16}$/);
    assert.equal(j1.trendSinceLastVisit, undefined);
    const rows = repos.readings.list({ unitId: unit.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.source, "chat");
    assert.equal(rows[0]!.conversation_id, conv.id);
    assert.equal(rows[0]!.mode, "ac_cooling");

    const r2 = await executeTool("diagnose_refrigeration", LOW_CHARGE, ctx);
    const j2 = JSON.parse(r2.content) as { readingId: string; trendSinceLastVisit?: string[] };
    assert.ok(Array.isArray(j2.trendSinceLastVisit) && j2.trendSinceLastVisit.length > 0, r2.content.slice(0, 300));
    assert.ok(j2.trendSinceLastVisit.some((l) => /^Subcooling fell/.test(l)));
    assert.equal(repos.readings.list({ unitId: unit.id }).length, 2);
  });

  test("save_finding accepts follow_up_due (YYYY-MM-DD) and rejects other forms", async () => {
    const repos = createRepos(openDatabase(":memory:"));
    const unit = makeUnit(repos);
    const { ctx } = { ctx: { kb, repos, conversationId: repos.conversations.create({ unit_id: unit.id }).id, unitId: unit.id, now: NOW } };
    const ok = await executeTool("save_finding", { symptom: "Low SC", follow_up: "Recheck SC", follow_up_due: "2026-10-15", status: "monitor" }, ctx);
    assert.equal(ok.isError, undefined, ok.content);
    const j = JSON.parse(ok.content) as { finding: { id: string; follow_up_due: string; follow_up_done: boolean } };
    assert.equal(j.finding.follow_up_due, "2026-10-15");
    assert.equal(j.finding.follow_up_done, false);
    assert.equal(repos.findings.get(j.finding.id)?.follow_up_due, "2026-10-15");
    const bad = await executeTool("save_finding", { symptom: "x", follow_up: "y", follow_up_due: "next week" }, ctx);
    assert.equal(bad.isError, true);
    assert.match(bad.content, /YYYY-MM-DD/);
    // a due date without a follow-up text is dropped rather than stored
    const noText = await executeTool("save_finding", { symptom: "x", follow_up_due: "2026-10-15" }, ctx);
    const jn = JSON.parse(noText.content) as { finding: { id: string } };
    assert.equal(repos.findings.get(jn.finding.id)?.follow_up_due, null);
  });

  test("get_unit_history lists open follow-ups first, the last 3 readings compactly, and the trend", async () => {
    const repos = createRepos(openDatabase(":memory:"));
    const unit = makeUnit(repos);
    const conv = repos.conversations.create({ unit_id: unit.id });
    const ctx: ToolContext = { kb, repos, conversationId: conv.id, unitId: unit.id, now: NOW };
    repos.findings.create({ unit_id: unit.id, symptom: "Leak", follow_up: "Leak search ckt 2", follow_up_due: "2026-09-01", status: "open" });
    repos.findings.create({ unit_id: unit.id, symptom: "Done", follow_up: "Old", follow_up_done: 1 });
    repos.readings.create({
      unit_id: unit.id,
      mode: "ac_cooling",
      refrigerant: "R-410A",
      metering_device: "txv",
      measurements_json: { outdoorDbF: 85, suctionPsig: 118, liquidPsig: 340 },
      derived_json: { superheatF: 12, subcoolingF: 12, condSatF: 105, evapSatF: 40, deltaTF: 18, ampsPercentRla: 80 },
      validity_json: { ok: true, issues: [] },
      findings_json: [],
      created_at: "2026-08-02T10:00:00.000Z",
    });
    for (let i = 0; i < 3; i++) await executeTool("diagnose_refrigeration", LOW_CHARGE, ctx);
    const r = await executeTool("get_unit_history", {}, ctx);
    assert.equal(r.isError, undefined, r.content);
    const j = JSON.parse(r.content) as Record<string, unknown>;
    const keys = Object.keys(j);
    assert.ok(keys.indexOf("openFollowUps") < keys.indexOf("findings"), "open follow-ups come before findings");
    assert.deepEqual(j.openFollowUps, [{ findingId: repos.findings.listFollowUps()[0]!.id, due: "2026-09-01", text: "Leak search ckt 2", symptom: "Leak", status: "open" }]);
    const readings = j.readings as Record<string, unknown>[];
    assert.equal(readings.length, 3, "last 3 only");
    assert.equal(j.readingCount, 4);
    assert.equal(readings[0]!.source, "chat");
    assert.equal(typeof readings[0]!.superheatF, "number");
    assert.equal(typeof readings[0]!.subcoolingF, "number");
    assert.equal(readings[0]!.outdoorDbF, 88);
    assert.ok(!("measurements" in readings[0]!), "compact rows only");
    const trend = j.trendSinceLastVisit as { since: string; lines: string[] } | undefined;
    // newest vs previous chat reading (identical) → nothing notable; the engine falls through to no trend
    assert.equal(trend, undefined);
    assert.match(r.summary, /1 open follow-up/);
    assert.match(r.summary, /4 readings/);
  });

  test("unit context block: open follow-ups before findings (overdue flagged), saved readings + trend lines; static prompt mentions the trend", () => {
    const repos = createRepos(openDatabase(":memory:"));
    const unit = makeUnit(repos);
    repos.findings.create({ unit_id: unit.id, symptom: "Leak", follow_up: "Leak search ckt 2", follow_up_due: "2026-09-01", status: "open" });
    repos.findings.create({ unit_id: unit.id, symptom: "Cap", follow_up: "Replace run cap", follow_up_due: "2026-12-01", status: "monitor" });
    repos.findings.create({ unit_id: unit.id, symptom: "Old", follow_up: "Done thing", follow_up_done: 1 });
    const mk = (created_at: string, derived: Record<string, number>, outdoorDbF = 85) =>
      repos.readings.create({
        unit_id: unit.id,
        mode: "ac_cooling",
        refrigerant: "R-410A",
        metering_device: "txv",
        measurements_json: { outdoorDbF, suctionPsig: 118, liquidPsig: 340 },
        derived_json: derived,
        validity_json: { ok: true, issues: [] },
        findings_json: [],
        created_at,
      });
    mk("2026-06-01T10:00:00.000Z", { superheatF: 11, subcoolingF: 13, deltaTF: 18 });
    mk("2026-07-01T10:00:00.000Z", { superheatF: 12, subcoolingF: 12, deltaTF: 18 });
    mk("2026-08-02T10:00:00.000Z", { superheatF: 12, subcoolingF: 12, deltaTF: 18 });
    mk("2026-09-20T10:00:00.000Z", { superheatF: 12, subcoolingF: 4, deltaTF: 17 });
    const text = unitContextBlock(unit, repos.findings.list({ unitId: unit.id }), [], "x", NOW, [], repos.readings.list({ unitId: unit.id }));
    const idx = (s: string) => {
      const i = text.indexOf(s);
      assert.ok(i >= 0, `missing: ${s}\n${text}`);
      return i;
    };
    assert.ok(idx("Open follow-ups:") < idx("OPEN / MONITOR FINDINGS"));
    assert.ok(idx("Leak search ckt 2 (OVERDUE since 2026-09-01") < idx("Replace run cap (due 2026-12-01"));
    assert.ok(!text.includes("Done thing (") , "done follow-ups are not listed as open");
    assert.ok(text.includes("SAVED READINGS (4, last 3 shown; newest first)"));
    assert.ok(text.includes("- 2026-09-20 AC cooling (sheet): OD 85°F, suction 118 psig, liquid 340 psig, SH 12°F, SC 4°F, ΔT 17°F"));
    assert.ok(!text.includes("- 2026-06-01"), "only the last 3 readings");
    assert.ok(text.includes("TREND SINCE LAST VISIT (2026-08-02):"));
    assert.ok(text.includes("- Subcooling fell from 12 to 4 °F since 2026-08-02 (same mode) - charge loss or restriction trend"));
    assert.ok(idx("SAVED READINGS") > idx("UNCONFIRMED ASSISTANT HYPOTHESES"), "readings come after findings");
    assert.match(staticSystemPrompt({ webSearchEnabled: false }), /trend since last visit/);
  });

  test("unit context block without readings is unchanged and never throws on junk rows", () => {
    const repos = createRepos(openDatabase(":memory:"));
    const unit = makeUnit(repos);
    const plain = unitContextBlock(unit, [], [], "x", NOW);
    assert.ok(!plain.includes("SAVED READINGS"));
    assert.ok(!plain.includes("Open follow-ups"));
    const junk = unitContextBlock(unit, [], [], "x", NOW, [], [{ id: "a", created_at: "2026-01-01T00:00:00Z", mode: "ac_cooling", measurements_json: "{bad", derived_json: "nope" } as never, null as never]);
    assert.ok(junk.includes("SAVED READINGS (1"));
    assert.ok(junk.includes("no numbers"));
  });
});
