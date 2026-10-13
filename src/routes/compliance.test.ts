/* Refrigerant log + compliance: repos, routes (withServer pattern), CSV export, the log_refrigerant tool and the
 * unit context block. */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PROJECT_ROOT, loadConfig } from "../config.ts";
import { loadKnowledge } from "../knowledge/loader.ts";
import { openDatabase, type Db } from "../db/index.ts";
import { createRepos, RepoError, type Repos } from "../db/repos.ts";
import { createFakeClient } from "../agent/fakeClient.ts";
import { executeTool, toolDefinitions, type ToolContext } from "../agent/tools.ts";
import { unitContextBlock } from "../agent/systemPrompt.ts";
import type { AppConfig, KnowledgeBase, UnitRow } from "../types.ts";
import { createApp, type AppDeps } from "../app.ts";
import { csvLine, refrigerantLogCsv } from "../complianceStore.ts";

const NOW = new Date("2026-10-12T15:00:00Z");
const TODAY = "2026-10-12";

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

function makeRack(repos: Repos, over: Record<string, unknown> = {}): UnitRow {
  return repos.units.create({ model: "RACK-A", unit_tag: "Rack A", site: "Grocery 12", refrigerant: "R-404A", full_charge_lbs: 400, appliance_type: "commercial_refrigeration", circuits_count: 1, ...over });
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

describe("refrigerantEvents repo", () => {
  test("units accept full_charge_lbs / appliance_type / circuits_count with validation", () => {
    const repos = createRepos(openDatabase(":memory:"));
    const u = makeRack(repos, { appliance_type: "Commercial_Refrigeration" });
    assert.equal(u.full_charge_lbs, 400);
    assert.equal(u.appliance_type, "commercial_refrigeration");
    assert.equal(u.circuits_count, 1);
    assert.throws(() => repos.units.update(u.id, { appliance_type: "garage" } as never), RepoError);
    assert.throws(() => repos.units.update(u.id, { circuits_count: 0 }), RepoError);
    assert.equal(repos.units.update(u.id, { appliance_type: null, full_charge_lbs: null })!.appliance_type, null);
  });

  test("create computes the EPA leak rate on an add from the previous add, flags the exceedance and opens one follow-up finding", () => {
    const repos = createRepos(openDatabase(":memory:"), { now: () => NOW.toISOString() });
    const unit = makeRack(repos);
    const first = repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "add", amount_lbs: 10, date: "2026-01-01", tech_name: "Sam", tech_cert: "608-123" });
    assert.equal(first.created_at, "2026-01-01T12:00:00.000Z");
    assert.equal(first.refrigerant, "R-404A", "defaults to the unit refrigerant");
    assert.equal(first.leak_rate_pct, null, "no previous add and no install year");
    assert.equal(first.threshold_pct, 20);
    assert.equal(first.exceeded, null);
    assert.equal(first.finding_id, null);
    // EPA worked example: 25 lb into a 400 lb rack 60 days later = 38.02 %
    const second = repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "add", amount_lbs: 25, date: "2026-03-02", cylinder_id: "CYL-77" });
    assert.equal(second.leak_rate_pct, 38.02);
    assert.equal(second.threshold_pct, 20);
    assert.equal(second.exceeded, 1);
    assert.match(second.finding_id ?? "", /^[0-9a-f]{16}$/);
    const finding = repos.findings.get(second.finding_id!)!;
    assert.equal(finding.status, "open");
    assert.equal(finding.follow_up, "EPA leak rate 38.02 % exceeds 20 % - repair within 30 days and verify");
    assert.equal(finding.follow_up_due, "2026-04-01");
    assert.equal(finding.refrigerant_added_lbs, 25);
    assert.equal(finding.unit_id, unit.id);
    assert.equal(repos.findings.listFollowUps({ unitId: unit.id }).length, 1);
    // a small add later: within threshold, no new finding
    const third = repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "add", amount_lbs: 2, date: "2026-09-01" });
    assert.equal(third.leak_rate_pct, 1); // 2/400 × 365/183 × 100 = 1.0
    assert.equal(third.exceeded, 0);
    assert.equal(third.finding_id, null);
    assert.equal(repos.findings.list({ unitId: unit.id }).length, 1);
    assert.deepEqual(repos.refrigerantEvents.list({ unitId: unit.id }).map((e) => e.amount_lbs), [2, 25, 10], "newest first");
    assert.equal(repos.refrigerantEvents.latestAdd(unit.id)!.id, third.id);
    assert.equal(repos.refrigerantEvents.remove(third.id), true);
    assert.equal(repos.refrigerantEvents.get(third.id), undefined);
  });

  test("per-circuit adds use the circuit's share of the charge and the previous add on that circuit; install year is the first-add basis", () => {
    const repos = createRepos(openDatabase(":memory:"), { now: () => NOW.toISOString() });
    const rtu = repos.units.create({ model: "48TC", unit_tag: "RTU-7", refrigerant: "R-410A", full_charge_lbs: 40, appliance_type: "comfort_cooling", circuits_count: 2, install_year: 2020 });
    const c1 = repos.refrigerantEvents.create({ unit_id: rtu.id, event_type: "add", amount_lbs: 1, circuit: 1, date: "2026-01-01" });
    // install-year basis, > 365 days → capped at 365: 1 / 20 × 365 / 365 × 100 = 5 %
    assert.equal(c1.leak_rate_pct, 5, `install-year basis: ${c1.leak_rate_pct}`);
    const c2 = repos.refrigerantEvents.create({ unit_id: rtu.id, event_type: "add", amount_lbs: 1, circuit: 2, date: "2026-03-01" });
    assert.equal(c2.leak_rate_pct, 5, "circuit 2 has no previous add: install-year basis, not circuit 1's add");
    // circuit 1 again, 181 days after its own add: 1/20 × 365/181 × 100 = 10.08 % > 10
    const c1b = repos.refrigerantEvents.create({ unit_id: rtu.id, event_type: "add", amount_lbs: 1, circuit: 1, date: "2026-07-01" });
    assert.equal(c1b.leak_rate_pct, 10.08);
    assert.equal(c1b.exceeded, 1);
    assert.equal(repos.refrigerantEvents.latestAdd(rtu.id, 2)!.id, c2.id);
    assert.equal(repos.refrigerantEvents.latestAdd(rtu.id)!.id, c1b.id);
  });

  test("a circuit-tagged add is annualized from an earlier unit-level add (circuit NULL), not treated as a first add", () => {
    const repos = createRepos(openDatabase(":memory:"), { now: () => NOW.toISOString() });
    const rtu = repos.units.create({ model: "48TC", unit_tag: "RTU-8", refrigerant: "R-410A", full_charge_lbs: 40, appliance_type: "comfort_cooling", circuits_count: 2 });
    const unitLevel = repos.refrigerantEvents.create({ unit_id: rtu.id, event_type: "add", amount_lbs: 2, date: "2026-01-01" });
    assert.equal(unitLevel.leak_rate_pct, null, "first add, no install year");
    // circuit 1, 60 days after the unit-level add: 2 / 20 × 365 / 60 × 100 = 60.83 %
    const c1 = repos.refrigerantEvents.create({ unit_id: rtu.id, event_type: "add", amount_lbs: 2, circuit: 1, date: "2026-03-02" });
    assert.equal(c1.leak_rate_pct, 60.83);
    assert.equal(c1.exceeded, 1);
    // a newer add on the circuit itself wins over the older unit-level add
    const c1b = repos.refrigerantEvents.create({ unit_id: rtu.id, event_type: "add", amount_lbs: 1, circuit: 1, date: "2026-09-01" });
    assert.equal(c1b.leak_rate_pct, 9.97, "1 / 20 × 365 / 183 × 100 from the circuit add of 03-02");
    // latestAdd(unitId, circuit) keeps its strict per-circuit meaning
    assert.equal(repos.refrigerantEvents.latestAdd(rtu.id, 2), undefined);
  });

  test("removing an exceeded add deletes its auto-created EPA follow-up finding in the same transaction", () => {
    const repos = createRepos(openDatabase(":memory:"), { now: () => NOW.toISOString() });
    const unit = makeRack(repos);
    repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "add", amount_lbs: 10, date: "2026-01-01" });
    const ex = repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "add", amount_lbs: 25, date: "2026-03-02" });
    assert.ok(ex.finding_id);
    assert.equal(repos.findings.listFollowUps({ unitId: unit.id }).length, 1);
    assert.equal(repos.refrigerantEvents.remove(ex.id), true);
    assert.equal(repos.findings.get(ex.finding_id!), undefined);
    assert.equal(repos.findings.listFollowUps({ unitId: unit.id }).length, 0);
    assert.equal(repos.refrigerantEvents.remove(ex.id), false, "already gone");
  });

  test("auto follow-up follows the open exceedance: a top-off keeps it open, a passed follow-up verification closes it", () => {
    const repos = createRepos(openDatabase(":memory:"), { now: () => NOW.toISOString() });
    const unit = makeRack(repos);
    repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "add", amount_lbs: 10, date: "2026-01-01" });
    const ex = repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "add", amount_lbs: 25, date: "2026-03-02" });
    const topOff = repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "add", amount_lbs: 2, date: "2026-03-20" });
    assert.equal(topOff.exceeded, 0, "2 / 400 × 365 / 18 × 100 = 10.14 % < 20 %");
    assert.equal(repos.findings.get(ex.finding_id!)!.follow_up_done, 0, "top-off does not close it");
    repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "repair", date: "2026-03-20" });
    repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "verification_initial", date: "2026-03-20", passed: true });
    repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "verification_followup", date: "2026-03-25", passed: false });
    assert.equal(repos.findings.get(ex.finding_id!)!.follow_up_done, 0, "a failed follow-up does not close it");
    repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "verification_followup", date: "2026-03-28", passed: true });
    const f = repos.findings.get(ex.finding_id!)!;
    assert.equal(f.follow_up_done, 1);
    assert.equal(f.status, "resolved");
    assert.match(f.resolution ?? "", /Follow-up verification test passed 2026-03-28/);
    assert.equal(repos.findings.listFollowUps({ unitId: unit.id }).length, 0);
  });

  test("validation: event type, amount for add/recover, circuit range, unit/conversation existence, dates", () => {
    const repos = createRepos(openDatabase(":memory:"));
    const unit = makeRack(repos);
    assert.throws(() => repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "vent" }), /event_type must be one of/);
    assert.throws(() => repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "add" }), /amount_lbs must be a positive number for add/);
    assert.throws(() => repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "recover", amount_lbs: 0 }), /amount_lbs/);
    assert.throws(() => repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "leak_check", circuit: 99 }), /circuit must be between 1 and 64/);
    assert.throws(() => repos.refrigerantEvents.create({ unit_id: "0123456789abcdef", event_type: "leak_check" }), (e: unknown) => e instanceof RepoError && e.code === "not_found");
    assert.throws(() => repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "leak_check", conversation_id: "0123456789abcdef" }), (e: unknown) => e instanceof RepoError && e.code === "not_found");
    assert.throws(() => repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "leak_check", date: "2026-02-30" }), /YYYY-MM-DD/);
    assert.throws(() => repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "leak_check", created_at: "yesterday" }), /ISO timestamp/);
    const lc = repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "leak_check", leak_found: true, note: "fitting at the drier" });
    assert.equal(lc.leak_found, 1);
    assert.equal(lc.amount_lbs, null);
    const vi = repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "verification_initial", passed: "false" as never });
    assert.equal(vi.passed, 0);
  });

  test("listAll joins the unit identity; cascade on unit hard delete; conversation delete sets NULL", () => {
    const repos = createRepos(openDatabase(":memory:"));
    const unit = makeRack(repos, { serial: "SN-1", nickname: "Big rack" });
    const conv = repos.conversations.create({ unit_id: unit.id });
    repos.refrigerantEvents.create({ unit_id: unit.id, conversation_id: conv.id, event_type: "add", amount_lbs: 5, date: "2026-05-05" });
    const all = repos.refrigerantEvents.listAll();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.unit_site, "Grocery 12");
    assert.equal(all[0]!.unit_tag, "Rack A");
    assert.equal(all[0]!.unit_model, "RACK-A");
    assert.equal(all[0]!.unit_serial, "SN-1");
    assert.equal(all[0]!.unit_nickname, "Big rack");
    repos.conversations.remove(conv.id);
    assert.equal(repos.refrigerantEvents.listAll()[0]!.conversation_id, null);
    repos.units.remove(unit.id);
    assert.equal(repos.refrigerantEvents.listAll().length, 0);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe("refrigerant log routes", () => {
  test("PATCH /api/units/:id accepts the compliance columns and GET /api/units/:id returns compliance", async () => {
    await withServer(async (c) => {
      const unit = c.repos.units.create({ model: "48TC", unit_tag: "RTU-1" });
      const res = await c.json("PATCH", `/api/units/${unit.id}`, { full_charge_lbs: 22.5, appliance_type: "comfort_cooling", circuits_count: 2 });
      assert.equal(res.status, 200);
      const { unit: u } = (await res.json()) as { unit: UnitRow };
      assert.equal(u.full_charge_lbs, 22.5);
      assert.equal(u.appliance_type, "comfort_cooling");
      assert.equal(u.circuits_count, 2);
      await expectError(await c.json("PATCH", `/api/units/${unit.id}`, { appliance_type: "nope" }), 400, "validation");
      await expectError(await c.json("PATCH", `/api/units/${unit.id}`, { circuits_count: 1.5 }), 400, "validation");
      const got = (await (await c.get(`/api/units/${unit.id}`)).json()) as { compliance: Record<string, unknown> };
      assert.equal(got.compliance.applies, true);
      assert.equal(got.compliance.thresholdPct, 10);
      assert.equal(got.compliance.fullChargeLbs, 22.5);
      assert.equal(got.compliance.circuitChargeLbs, 11.25);
      assert.equal(got.compliance.exceeded, false);
      assert.deepEqual(got.compliance.obligations, []);
      // decode-and-store path (POST /api/units) accepts them too
      const created = await c.json("POST", "/api/units", { model: "48TCDA04A2A5-0A0A0", unit_tag: "RTU-2", full_charge_lbs: 18, appliance_type: "other" });
      assert.equal(created.status, 201);
      const cu = ((await created.json()) as { unit: UnitRow }).unit;
      assert.equal(cu.full_charge_lbs, 18);
      assert.equal(cu.appliance_type, "other");
    });
  });

  test("POST/GET/DELETE /api/units/:id/refrigerant with compliance and the auto follow-up", async () => {
    await withServer(async (c) => {
      const unit = makeRack(c.repos);
      const conv = c.repos.conversations.create({ unit_id: unit.id });
      const r1 = await c.json("POST", `/api/units/${unit.id}/refrigerant`, { event_type: "add", amount_lbs: 10, date: "2026-01-01", tech_name: "Sam", tech_cert: "608-123", cylinder_id: "C1" });
      assert.equal(r1.status, 201);
      const b1 = (await r1.json()) as { event: Record<string, unknown>; finding: unknown; compliance: Record<string, unknown> };
      assert.equal(b1.event.leak_rate_pct, null);
      assert.equal(b1.event.exceeded, null);
      assert.equal(b1.event.date, "2026-01-01");
      assert.equal(b1.finding, null);
      const r2 = await c.json("POST", `/api/units/${unit.id}/refrigerant`, { event_type: "add", amount_lbs: 25, date: "2026-03-02", conversation_id: conv.id });
      assert.equal(r2.status, 201);
      const b2 = (await r2.json()) as { event: Record<string, unknown>; finding: Record<string, unknown> | null; compliance: Record<string, unknown> };
      assert.equal(b2.event.leak_rate_pct, 38.02);
      assert.equal(b2.event.exceeded, true);
      assert.equal(b2.event.conversation_id, conv.id);
      assert.equal(b2.finding?.follow_up_due, "2026-04-01");
      assert.equal(b2.compliance.exceeded, true);
      assert.equal(b2.compliance.lastLeakRatePct, 38.02);
      const kinds = (b2.compliance.obligations as { kind: string; overdue: boolean }[]).map((o) => o.kind);
      assert.deepEqual(kinds, ["repair", "verification_initial", "retrofit_plan", "inspection"], "today is 2026-10-12: repair overdue → retrofit plan");
      assert.equal((b2.compliance.obligations as { overdue: boolean }[])[0]!.overdue, true);

      const list = (await (await c.get(`/api/units/${unit.id}/refrigerant`)).json()) as { events: Record<string, unknown>[]; compliance: Record<string, unknown> };
      assert.equal(list.events.length, 2);
      assert.equal(list.events[0]!.amount_lbs, 25, "newest first");
      assert.equal(list.compliance.exceeded, true);
      const unitPage = (await (await c.get(`/api/units/${unit.id}`)).json()) as { compliance: { exceeded: boolean; lastAdd: { leakRatePct: number } }; findings: unknown[] };
      assert.equal(unitPage.compliance.exceeded, true);
      assert.equal(unitPage.compliance.lastAdd.leakRatePct, 38.02);
      assert.equal(unitPage.findings.length, 1);

      // repair + verification chain clears the repair obligations
      await c.json("POST", `/api/units/${unit.id}/refrigerant`, { event_type: "repair", date: "2026-03-20", note: "replaced drier flare" });
      await c.json("POST", `/api/units/${unit.id}/refrigerant`, { event_type: "verification_initial", date: "2026-03-20", passed: true });
      const after = (await (await c.json("POST", `/api/units/${unit.id}/refrigerant`, { event_type: "verification_followup", date: "2026-03-28", passed: true })).json()) as { compliance: { obligations: { kind: string }[] } };
      assert.deepEqual(after.compliance.obligations.map((o) => o.kind), ["inspection"]);

      // validation + delete scoping
      await expectError(await c.json("POST", `/api/units/${unit.id}/refrigerant`, { event_type: "add" }), 400, "validation");
      await expectError(await c.json("POST", `/api/units/${unit.id}/refrigerant`, { event_type: "steal", amount_lbs: 1 }), 400, "validation");
      await expectError(await c.json("POST", `/api/units/${unit.id}/refrigerant`, { event_type: "leak_check", circuit: 1.5 }), 400, "validation");
      await expectError(await c.json("POST", `/api/units/${unit.id}/refrigerant`, { event_type: "leak_check", date: "3/2/2026" }), 400, "validation");
      await expectError(await c.json("POST", `/api/units/${unit.id}/refrigerant`, { event_type: "leak_check", conversation_id: "0123456789abcdef" }), 404, "not_found");
      await expectError(await c.json("POST", "/api/units/0123456789abcdef/refrigerant", { event_type: "leak_check" }), 404, "not_found");
      await expectError(await c.get("/api/units/nope/refrigerant"), 400, "validation");
      const other = c.repos.units.create({ model: "X", unit_tag: "RTU-9" });
      const eid = list.events[0]!.id as string;
      await expectError(await c.json("DELETE", `/api/units/${other.id}/refrigerant/${eid}`), 404, "not_found");
      const del = await c.json("DELETE", `/api/units/${unit.id}/refrigerant/${eid}`);
      assert.deepEqual(await del.json(), { deleted: true, id: eid });
      await expectError(await c.json("DELETE", `/api/units/${unit.id}/refrigerant/${eid}`), 404, "not_found");
    });
  });

  test("open exceedance: GET /api/units/:id compliance, the owner documentation and the unit context keep a topped-off exceedance open and drop a verified one", async () => {
    await withServer(async (c) => {
      const unit = makeRack(c.repos);
      const conv = c.repos.conversations.create({ unit_id: unit.id });
      const post = async (b: Record<string, unknown>): Promise<void> => {
        const r = await c.json("POST", `/api/units/${unit.id}/refrigerant`, { conversation_id: conv.id, ...b });
        assert.equal(r.status, 201);
      };
      await post({ event_type: "add", amount_lbs: 10, date: "2026-01-01" });
      await post({ event_type: "add", amount_lbs: 25, date: "2026-03-02" });
      await post({ event_type: "add", amount_lbs: 2, date: "2026-03-20" });
      type Page = { compliance: { exceeded: boolean; lastLeakRatePct: number; openExceedance: { date: string } | null; lastAdd: { exceeded: boolean }; obligations: { kind: string }[] } };
      const page = (await (await c.get(`/api/units/${unit.id}`)).json()) as Page;
      assert.equal(page.compliance.exceeded, true, "(a) the 2 lb top-off below the threshold does not clear the 03-02 exceedance");
      assert.equal(page.compliance.lastAdd.exceeded, false);
      assert.equal(page.compliance.lastLeakRatePct, 38.02);
      assert.equal(page.compliance.openExceedance?.date, "2026-03-02");
      assert.ok(page.compliance.obligations.some((o) => o.kind === "repair"));
      const md = await (await c.get(`/api/conversations/${conv.id}/report`)).text();
      assert.match(md, /\*\*Open exceedance:\*\* 38.02 %\/yr — EXCEEDS the threshold \(add of 2026-03-02/);
      const ctxText = unitContextBlock(c.repos.units.get(unit.id)!, [], [], "c0", NOW, [], [], c.repos.refrigerantEvents.list({ unitId: unit.id }), []);
      assert.ok(ctxText.includes("EXCEEDANCE OPEN: do not recommend topping off"), ctxText);
      assert.ok(ctxText.includes("Open since the 2026-03-02 add (38.02 %/yr vs 20 %)"));
      // (b) repair + passed initial 03-20, passed follow-up 03-28 → closed
      await post({ event_type: "repair", date: "2026-03-20" });
      await post({ event_type: "verification_initial", date: "2026-03-20", passed: true });
      await post({ event_type: "verification_followup", date: "2026-03-28", passed: true });
      const after = (await (await c.get(`/api/units/${unit.id}`)).json()) as Page;
      assert.equal(after.compliance.exceeded, false);
      assert.equal(after.compliance.openExceedance, null);
      assert.deepEqual(after.compliance.obligations.map((o) => o.kind), ["inspection"]);
      const md2 = await (await c.get(`/api/conversations/${conv.id}/report`)).text();
      assert.match(md2, /\*\*Last leak rate:\*\* 10.14 %\/yr\n/);
      const ctx2 = unitContextBlock(c.repos.units.get(unit.id)!, [], [], "c0", NOW, [], [], c.repos.refrigerantEvents.list({ unitId: unit.id }), []);
      assert.ok(!ctx2.includes("EXCEEDANCE OPEN"));
    });
  });

  test("applicability by refrigerant from the knowledge base: R-22 under 50 lb and R-744 are not covered; leak_rate calc agrees", async () => {
    await withServer(async (c) => {
      const r22 = c.repos.units.create({ model: "X", unit_tag: "RTU-22", refrigerant: "R-22", full_charge_lbs: 40, appliance_type: "comfort_cooling" });
      const co2 = makeRack(c.repos, { unit_tag: "CO2 rack", refrigerant: "R744" });
      const hfc = c.repos.units.create({ model: "X", unit_tag: "RTU-410", refrigerant: "Puron", full_charge_lbs: 20, appliance_type: "comfort_cooling" });
      type C = { compliance: { applies: boolean; regime: string; applicabilityLbs: number | null; notes: string[] } };
      const g22 = ((await (await c.get(`/api/units/${r22.id}`)).json()) as C).compliance;
      assert.deepEqual([g22.applies, g22.regime, g22.applicabilityLbs], [false, "ods", 50]);
      const gco2 = ((await (await c.get(`/api/units/${co2.id}`)).json()) as C).compliance;
      assert.deepEqual([gco2.applies, gco2.regime, gco2.applicabilityLbs], [false, "not_covered", null]);
      assert.ok(gco2.notes.some((n) => /R-744 \(GWP 1\)/.test(n)), gco2.notes.join(" | "));
      const ghfc = ((await (await c.get(`/api/units/${hfc.id}`)).json()) as C).compliance;
      assert.deepEqual([ghfc.applies, ghfc.regime, ghfc.applicabilityLbs], [true, "hfc", 15]);
      const calc = (await (await c.json("POST", "/api/calc/electrical", { kind: "leak_rate", added_lbs: 5, full_charge_lbs: 40, days_since_last_add: 90, refrigerant: "R-22" })).json()) as { values: Record<string, number>; interpretation: string[] };
      assert.equal(calc.values.applies, 0);
      assert.match(calc.interpretation[2]!, /R-22 is an ODS: full charge 40 lb is below the 50 lb applicability/);
      const calcCo2 = (await (await c.json("POST", "/api/calc/electrical", { kind: "leak_rate", added_lbs: 5, full_charge_lbs: 400, days_since_last_add: 90, refrigerant: "CO2" })).json()) as { values: Record<string, number>; interpretation: string[] };
      assert.equal(calcCo2.values.applies, 0);
      assert.match(calcCo2.interpretation[2]!, /does not apply/);
    });
  });

  test("CSV export neutralises spreadsheet formulas and marks the row cap", () => {
    assert.equal(csvLine(["=HYPERLINK(\"http://x\")", "+1", "-2 psi", "@SUM(A1)", "\tTab", "\rCR", -5, "ok"]), `"'=HYPERLINK(""http://x"")","'+1","'-2 psi","'@SUM(A1)","'\tTab","'\rCR",-5,ok`);
    const repos = createRepos(openDatabase(":memory:"), { now: () => NOW.toISOString() });
    const unit = makeRack(repos, { site: "=cmd|' /C calc'!A0" });
    for (const d of ["2026-01-01", "2026-02-01", "2026-03-01"]) repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "leak_check", date: d });
    const full = refrigerantLogCsv(repos).split("\r\n");
    assert.equal(full.length, 5, "header + 3 rows + trailing CRLF; no cap marker");
    assert.ok(full[1]!.startsWith(`2026-01-01,"'=cmd|' /C calc'!A0",`), full[1]);
    const capped = refrigerantLogCsv(repos, 2).split("\r\n");
    assert.equal(capped.length, 5, "header + 2 rows + marker + trailing CRLF");
    assert.match(capped[3]!, /^TRUNCATED: export stopped at the 2-event cap; events after 2026-02-01 are not included$/);
  });

  test("GET /api/refrigerant/export.csv: attachment, RFC 4180 quoting, unit identity joined; GET /api/export carries the events", async () => {
    await withServer(async (c) => {
      const unit = makeRack(c.repos, { site: 'Grocery "12", Main St', serial: "SN,1" });
      c.repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "add", amount_lbs: 10, date: "2026-01-01", note: "line one\nline two" });
      c.repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "leak_check", date: "2026-02-01", leak_found: false, tech_name: "Sam" });
      const res = await c.get("/api/refrigerant/export.csv");
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^text\/csv/);
      assert.equal(res.headers.get("content-disposition"), 'attachment; filename="hvac-refrigerant-log-2026-10-12.csv"');
      const text = await res.text();
      const lines = text.split("\r\n");
      assert.equal(lines[0], "date,site,unit_tag,nickname,model,serial,event_type,refrigerant,amount_lbs,circuit,cylinder_id,tech_name,tech_cert,leak_found,passed,leak_rate_pct,threshold_pct,exceeded,note,unit_id,event_id");
      assert.ok(lines[1]!.startsWith('2026-01-01,"Grocery ""12"", Main St",Rack A,,RACK-A,"SN,1",add,R-404A,10,,,,,,,,20,,"line one\nline two",'), lines[1]);
      assert.ok(lines[2]!.startsWith("2026-02-01,"), "oldest first");
      assert.match(lines[2]!, /,leak_check,R-404A,,,,Sam,,no,,,,,,/);
      assert.equal(lines[3], "", "ends with CRLF");
      assert.equal(csvLine(["a", 1, null, 'q"x', "c,d"]), 'a,1,,"q""x","c,d"');
      assert.equal(refrigerantLogCsv(c.repos).split("\r\n").length, 4);
      const ex = (await (await c.get("/api/export")).json()) as { refrigerantEvents: unknown[]; pmVisits: unknown[]; truncated: string[] };
      assert.equal(ex.refrigerantEvents.length, 2);
      assert.deepEqual(ex.pmVisits, []);
      assert.deepEqual(ex.truncated, []);
    });
  });
});

// ---------------------------------------------------------------------------
// Assistant: tool + unit context
// ---------------------------------------------------------------------------

describe("assistant refrigerant log", () => {
  test("log_refrigerant requires an attached unit, logs the add, reports the exceedance and the 30-day clock", async () => {
    const repos = createRepos(openDatabase(":memory:"), { now: () => NOW.toISOString() });
    const unit = makeRack(repos);
    const noUnit = await executeTool("log_refrigerant", { event_type: "add", amount_lbs: 5 }, { kb, repos, conversationId: repos.conversations.create({}).id, unitId: null, now: NOW });
    assert.equal(noUnit.isError, true);
    const conv = repos.conversations.create({ unit_id: unit.id });
    const ctx: ToolContext = { kb, repos, conversationId: conv.id, unitId: unit.id, now: NOW };
    const first = await executeTool("log_refrigerant", { event_type: "add", amount_lbs: 10, date: "2026-01-01", tech_cert: "608-1" }, ctx);
    assert.equal(first.isError, undefined, first.content);
    const j1 = JSON.parse(first.content) as { event: { leak_rate_pct: number | null }; notes: string[] };
    assert.equal(j1.event.leak_rate_pct, null);
    assert.match(j1.notes[0]!, /no previous add/);
    const second = await executeTool("log_refrigerant", { event_type: "add", amount_lbs: 25, date: "2026-03-02" }, ctx);
    const j2 = JSON.parse(second.content) as { event: { leak_rate_pct: number; exceeded: boolean; conversation_id: string }; finding: { follow_up_due: string }; compliance: { obligations: { kind: string }[] }; notes: string[] };
    assert.equal(j2.event.leak_rate_pct, 38.02);
    assert.equal(j2.event.exceeded, true);
    assert.equal(j2.event.conversation_id, conv.id);
    assert.equal(j2.finding.follow_up_due, "2026-04-01");
    assert.match(j2.notes[0]!, /EXCEEDANCE: 38.02 % per year exceeds the 20 % threshold.*repair within 30 days of 2026-03-02/);
    assert.ok(j2.compliance.obligations.some((o) => o.kind === "repair"));
    assert.match(second.summary, /38.02 %\/yr EXCEEDS 20 %/);
    const bad = await executeTool("log_refrigerant", { event_type: "add", amount_lbs: 1, date: "March 2" }, ctx);
    assert.equal(bad.isError, true);
    const missing = await executeTool("log_refrigerant", { event_type: "recover" }, ctx);
    assert.equal(missing.isError, true);
    const check = await executeTool("log_refrigerant", { event_type: "leak_check", leak_found: true, note: "schrader" }, ctx);
    assert.equal(check.isError, undefined);
    assert.match(check.summary, /Logged leak check/);
    const def = toolDefinitions().find((d) => d.name === "log_refrigerant")!;
    const props = (def.input_schema as { properties: Record<string, { type?: unknown; enum?: unknown[] }> }).properties;
    assert.deepEqual(props.event_type!.enum, ["add", "recover", "leak_check", "verification_initial", "verification_followup", "repair", "retrofit_plan"]);
  });

  test("unit context block carries a REFRIGERANT / COMPLIANCE section with the exceedance and obligations", () => {
    const repos = createRepos(openDatabase(":memory:"), { now: () => NOW.toISOString() });
    const unit = makeRack(repos);
    repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "add", amount_lbs: 10, date: "2026-01-01" });
    repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "add", amount_lbs: 25, date: "2026-03-02" });
    repos.refrigerantEvents.create({ unit_id: unit.id, event_type: "leak_check", date: "2026-03-10", leak_found: true, note: "drier flare" });
    const events = repos.refrigerantEvents.list({ unitId: unit.id });
    const text = unitContextBlock(repos.units.get(unit.id)!, repos.findings.list({ unitId: unit.id }), [], "c0", NOW, [], [], events, []);
    assert.ok(text.includes("REFRIGERANT / COMPLIANCE"), text);
    assert.ok(text.includes("Full charge 400 lb | commercial refrigeration → threshold 20 % | rule applies"));
    assert.ok(text.includes("Last add 2026-03-02: 25 lb R-404A → leak rate 38.02 %/yr — EXCEEDS 20 %"));
    assert.ok(text.includes("EXCEEDANCE OPEN: do not recommend topping off"));
    assert.ok(/OVERDUE Repair within 30 days of 2026-03-02/.test(text));
    assert.ok(text.includes("- 2026-03-10 leak check, leak found, drier flare"));
    assert.ok(text.indexOf("REFRIGERANT / COMPLIANCE") < text.indexOf("OTHER CONVERSATIONS"));
    // no charge and no events: section absent; charge but no events: present with the hint
    const bare = repos.units.create({ model: "X", unit_tag: "RTU-0" });
    assert.ok(!unitContextBlock(bare, [], [], "c0", NOW).includes("REFRIGERANT / COMPLIANCE"));
    const charged = repos.units.create({ model: "X", unit_tag: "RTU-1", full_charge_lbs: 30 });
    const t2 = unitContextBlock(charged, [], [], "c0", NOW, [], [], [], []);
    assert.ok(t2.includes("No refrigerant adds on record"));
    assert.ok(t2.includes("appliance type not set (comfort cooling assumed) → threshold 10 %"));
  });
});
