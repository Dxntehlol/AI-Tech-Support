/* PM checklists: repos, routes (withServer pattern), the get_pm_checklist tool, the unit context block and reports. */
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
import { executeTool, type ToolContext } from "../agent/tools.ts";
import { unitContextBlock } from "../agent/systemPrompt.ts";
import type { AppConfig, KnowledgeBase, UnitRow } from "../types.ts";
import { createApp, type AppDeps } from "../app.ts";
import { parseResults } from "./pm.ts";
import { findTemplate } from "../knowledge/pm.ts";

const NOW = new Date("2026-10-12T15:00:00Z");

let kb: KnowledgeBase;
before(() => {
  kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });
});

interface Ctx {
  db: Db;
  repos: Repos;
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

const CARRIER = "48TCDA04A2A5-0A0A0";
function makeRtu(repos: Repos, over: Record<string, unknown> = {}): UnitRow {
  return repos.units.create({
    model: CARRIER,
    unit_tag: "RTU-7",
    site: "Main St store",
    refrigerant: "R-410A",
    voltage: "208-230/3/60",
    heat_type: "gas",
    nameplate_json: JSON.stringify({ rla_1: 14.2, mca: 38 }),
    decoded_json: JSON.stringify({ model: [{ productType: "packaged_rtu", family: "48TC WeatherMaker", attributes: { heat_type: "gas" } }] }),
    ...over,
  });
}

describe("pmVisits repo", () => {
  test("create / list / latest / update / remove with validation", () => {
    const repos = createRepos(openDatabase(":memory:"), { now: () => NOW.toISOString() });
    const unit = makeRtu(repos);
    const v = repos.pmVisits.create({ unit_id: unit.id, template_id: "rtu_gas", results_json: { filters: { value: "20x25" } }, summary_json: { total: 1 } });
    assert.equal(v.status, "in_progress");
    assert.equal(v.results_json, '{"filters":{"value":"20x25"}}');
    assert.equal(v.updated_at, NOW.toISOString());
    assert.throws(() => repos.pmVisits.create({ unit_id: unit.id, template_id: "" }), /template_id required/);
    assert.throws(() => repos.pmVisits.create({ unit_id: unit.id, template_id: "x", status: "done" }), /status must be/);
    assert.throws(() => repos.pmVisits.create({ unit_id: "0123456789abcdef", template_id: "x" }), (e: unknown) => e instanceof RepoError && e.code === "not_found");
    const v2 = repos.pmVisits.create({ unit_id: unit.id, template_id: "rtu_gas", created_at: "2026-11-01T00:00:00.000Z" });
    assert.equal(repos.pmVisits.latest(unit.id)!.id, v2.id);
    assert.deepEqual(repos.pmVisits.list({ unitId: unit.id }).map((r) => r.id), [v2.id, v.id]);
    const up = repos.pmVisits.update(v.id, { status: "complete", tech_name: "Sam", note: "ok" })!;
    assert.equal(up.status, "complete");
    assert.equal(up.tech_name, "Sam");
    assert.equal(repos.pmVisits.update(v.id, {})!.id, v.id);
    assert.equal(repos.pmVisits.update("0123456789abcdef", { status: "complete" }), undefined);
    assert.equal(repos.pmVisits.listAll().length, 2);
    assert.equal(repos.pmVisits.remove(v2.id), true);
    repos.units.remove(unit.id);
    assert.equal(repos.pmVisits.listAll().length, 0, "cascade");
  });
});

describe("pm routes", () => {
  test("GET /api/pm/templates lists ids with item counts; GET /api/pm/templates/:id returns the template", async () => {
    await withServer(async (c) => {
      const list = (await (await c.get("/api/pm/templates")).json()) as { templates: { id: string; itemCount: number; sections: unknown[] }[]; sources: string[] };
      assert.equal(list.templates.length, 11);
      const rtu = list.templates.find((t) => t.id === "rtu_gas")!;
      assert.ok(rtu.itemCount >= 10);
      assert.ok(rtu.sections.length >= 4);
      assert.ok(list.sources.length > 0);
      const one = (await (await c.get("/api/pm/templates/boiler")).json()) as { template: { id: string; sections: { items: unknown[] }[] } };
      assert.equal(one.template.id, "boiler");
      await expectError(await c.get("/api/pm/templates/garage"), 404, "not_found");
    });
  });

  test("POST / PATCH / GET / DELETE /api/units/:id/pm evaluate against the template and the unit nameplate", async () => {
    await withServer(async (c) => {
      const unit = makeRtu(c.repos);
      const conv = c.repos.conversations.create({ unit_id: unit.id });
      const res = await c.json("POST", `/api/units/${unit.id}/pm`, {
        template_id: "rtu_gas",
        tech_name: "Sam",
        conversation_id: conv.id,
        results: { filters: { value: "2x 20x25x2" }, supply_volts: { value: 236 }, comp_amps: { asFound: 16.5, asLeft: 13.9 }, condensate: { checked: false }, run_capacitor: { value: 42, rated: 45 } },
      });
      assert.equal(res.status, 201);
      const { visit } = (await res.json()) as { visit: Record<string, unknown> & { summary: { total: number; pass: number; fail: number; na: number; flagged: string[]; fails: string[]; items: { id: string; status: string; reference?: string }[] }; results: Record<string, unknown> } };
      assert.equal(visit.template_id, "rtu_gas");
      assert.equal(visit.template_name, "Packaged rooftop — gas heat / electric cooling");
      assert.equal(visit.status, "in_progress");
      assert.equal(visit.tech_name, "Sam");
      assert.equal(visit.conversation_id, conv.id);
      assert.equal(visit.date, "2026-10-12");
      assert.equal(visit.summary.total, 32);
      assert.equal(visit.summary.pass, 3, "filters, volts, amps as-left");
      assert.deepEqual(visit.summary.fails, ["condensate", "run_capacitor"]);
      assert.deepEqual(visit.summary.flagged, ["run_capacitor"]);
      const amps = visit.summary.items.find((i) => i.id === "comp_amps")!;
      assert.equal(amps.status, "pass");
      assert.equal(amps.reference, "RLA/FLA 14.2 A (fail above 110 %)");
      const volts = visit.summary.items.find((i) => i.id === "supply_volts")!;
      assert.equal(volts.reference, "nameplate 208–230 V ±10 %");

      // PATCH merges results and re-evaluates; status change
      const vid = visit.id as string;
      const patched = await c.json("PATCH", `/api/units/${unit.id}/pm/${vid}`, { results: { condensate: { checked: true }, run_capacitor: { value: 44.5 } }, status: "complete", note: "left clean" });
      assert.equal(patched.status, 200);
      const pv = ((await patched.json()) as { visit: typeof visit }).visit;
      assert.equal(pv.status, "complete");
      assert.equal(pv.note, "left clean");
      assert.deepEqual(pv.summary.fails, []);
      assert.deepEqual(pv.summary.flagged, []);
      assert.equal((pv.results.run_capacitor as { rated: number }).rated, 45, "merge keeps the rated µF");
      assert.equal((pv.results.filters as { value: string }).value, "2x 20x25x2", "untouched items survive");
      const removed = await c.json("PATCH", `/api/units/${unit.id}/pm/${vid}`, { results: { filters: null } });
      assert.equal("filters" in ((await removed.json()) as { visit: { results: Record<string, unknown> } }).visit.results, false, "null removes an item");

      const list = (await (await c.get(`/api/units/${unit.id}/pm`)).json()) as { visits: { id: string }[] };
      assert.equal(list.visits.length, 1);
      const unitPage = (await (await c.get(`/api/units/${unit.id}`)).json()) as { lastPm: { id: string; status: string } | null };
      assert.equal(unitPage.lastPm?.id, vid);
      assert.equal(unitPage.lastPm?.status, "complete");

      // validation
      await expectError(await c.json("POST", `/api/units/${unit.id}/pm`, { template_id: "garage" }), 400, "validation");
      await expectError(await c.json("POST", `/api/units/${unit.id}/pm`, { template_id: "rtu_gas", results: { bogus_item: { checked: true } } }), 400, "validation");
      await expectError(await c.json("POST", `/api/units/${unit.id}/pm`, { template_id: "rtu_gas", results: { filters: { weird: 1 } } }), 400, "validation");
      await expectError(await c.json("POST", `/api/units/${unit.id}/pm`, { template_id: "rtu_gas", results: { comp_amps: { asFound: "lots" } } }), 400, "validation");
      await expectError(await c.json("POST", `/api/units/${unit.id}/pm`, { template_id: "rtu_gas", status: "done" }), 400, "validation");
      await expectError(await c.json("POST", `/api/units/${unit.id}/pm`, { template_id: "rtu_gas", conversation_id: "0123456789abcdef" }), 404, "not_found");
      await expectError(await c.json("POST", "/api/units/0123456789abcdef/pm", { template_id: "rtu_gas" }), 404, "not_found");
      await expectError(await c.json("PATCH", `/api/units/${unit.id}/pm/${vid}`, {}), 400, "validation");
      await expectError(await c.json("PATCH", `/api/units/${unit.id}/pm/${vid}`, { status: "" }), 400, "validation");
      const other = c.repos.units.create({ model: "X", unit_tag: "RTU-9" });
      await expectError(await c.json("PATCH", `/api/units/${other.id}/pm/${vid}`, { status: "complete" }), 404, "not_found");
      await expectError(await c.json("DELETE", `/api/units/${other.id}/pm/${vid}`), 404, "not_found");
      const del = await c.json("DELETE", `/api/units/${unit.id}/pm/${vid}`);
      assert.deepEqual(await del.json(), { deleted: true, id: vid });
      const after = (await (await c.get(`/api/units/${unit.id}`)).json()) as { lastPm: unknown };
      assert.equal(after.lastPm, null);
    });
  });

  test("parseResults accepts the documented keys only", () => {
    const t = findTemplate(kb.pm, "rtu_gas")!;
    assert.deepEqual(parseResults(undefined, t), {});
    assert.deepEqual(parseResults({ filters: { value: "x", note: null }, belt_condition: null }, t), { filters: { value: "x", note: null }, belt_condition: null });
    assert.throws(() => parseResults([], t), /must be an object/);
    assert.throws(() => parseResults({ filters: { checked: "yes" } }, t), /true, false or null/);
    assert.throws(() => parseResults({ filters: { value: {} } }, t), /number or string/);
  });
});

describe("assistant PM checklist", () => {
  test("get_pm_checklist suggests rtu_gas from the decoded unit and reports the last visit's fails and flagged items", async () => {
    const repos = createRepos(openDatabase(":memory:"), { now: () => NOW.toISOString() });
    const unit = makeRtu(repos);
    const conv = repos.conversations.create({ unit_id: unit.id });
    const ctx: ToolContext = { kb, repos, conversationId: conv.id, unitId: unit.id, now: NOW };
    const r = await executeTool("get_pm_checklist", {}, ctx);
    assert.equal(r.isError, undefined, r.content);
    const j = JSON.parse(r.content) as { template: { id: string; sections: { items: { id: string }[] }[] }; suggestedFrom: string; lastPm?: unknown; availableTemplates: string[] };
    assert.equal(j.template.id, "rtu_gas");
    assert.match(j.suggestedFrom, /gas heat/);
    assert.equal(j.lastPm, undefined);
    assert.equal(j.availableTemplates.length, 11);
    assert.match(r.summary, /PM checklist Packaged rooftop — gas heat/);
    // explicit type wins; unknown → error; no unit and no type → error
    const boiler = JSON.parse((await executeTool("get_pm_checklist", { equipment_type: "boiler" }, ctx)).content) as { template: { id: string } };
    assert.equal(boiler.template.id, "boiler");
    const bad = await executeTool("get_pm_checklist", { equipment_type: "garage" }, ctx);
    assert.equal(bad.isError, true);
    const none = await executeTool("get_pm_checklist", {}, { ...ctx, unitId: null });
    assert.equal(none.isError, true);
    // with a stored visit
    const { evaluateForUnit } = await import("../pmStore.ts");
    const template = findTemplate(kb.pm, "rtu_gas")!;
    const results = { condensate: { checked: false }, comp_amps: { value: 16.5 }, filters: { value: "20x25" } };
    repos.pmVisits.create({ unit_id: unit.id, template_id: "rtu_gas", status: "complete", tech_name: "Sam", results_json: results, summary_json: evaluateForUnit(template, results, unit) });
    const r2 = JSON.parse((await executeTool("get_pm_checklist", {}, ctx)).content) as { lastPm: { date: string; fail: number; fails: string[]; flagged: string[] } };
    assert.equal(r2.lastPm.date, "2026-10-12");
    assert.equal(r2.lastPm.fail, 2);
    assert.ok(r2.lastPm.fails.some((f) => /Condensate drain/.test(f)));
    assert.ok(r2.lastPm.flagged.some((f) => /Compressor running amps.*16.5 vs RLA\/FLA 14.2 A/.test(f)));
    // unit context block
    const text = unitContextBlock(unit, [], [], conv.id, NOW, [], [], [], repos.pmVisits.list({ unitId: unit.id }));
    assert.ok(text.includes("LAST PM VISIT 2026-10-12 — Packaged rooftop — gas heat / electric cooling (complete, Sam; 1 visit on record)"), text);
    assert.ok(/- 1 pass \/ 2 fail \/ 29 n\/a of 32 items/.test(text));
    assert.ok(/Fails: Condensate drain[^;]*\[SAFETY\]/.test(text));
    assert.ok(/Nameplate deviations: Compressor running amps[^;]*16.5 vs RLA\/FLA 14.2 A \(fail above 110 %\) \(\+16.2 %\)/.test(text), text);
    assert.ok(!unitContextBlock(unit, [], [], conv.id, NOW).includes("LAST PM VISIT"));
  });
});
