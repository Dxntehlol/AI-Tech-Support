import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import { loadKnowledge } from "../knowledge/loader.ts";
import { openDatabase } from "../db/index.ts";
import { createRepos, type Repos } from "../db/repos.ts";
import type { KnowledgeBase } from "../types.ts";
import { compactJson, describeToolCall, executeTool, toolDefinitions, toolNames, TOOL_RESULT_MAX_CHARS, type ToolContext } from "./tools.ts";

const NOW = new Date("2026-09-26T12:00:00Z");
const CARRIER_MODEL = "48TCDA04A2A5-0A0A0";
const CARRIER_SERIAL = "3216E54321";

let kb: KnowledgeBase;
before(() => {
  kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });
});

function fresh(): { repos: Repos; ctx: ToolContext } {
  const repos = createRepos(openDatabase(":memory:"));
  const conv = repos.conversations.create({});
  return { repos, ctx: { kb, repos, conversationId: conv.id, unitId: null, now: NOW } };
}

function parse(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

describe("toolDefinitions", () => {
  test("covers every tool in DESIGN.md with strict schemas listing every property as required", () => {
    const defs = toolDefinitions();
    const names = defs.map((d) => d.name);
    for (const expected of [
      "decode_unit",
      "find_unit",
      "refrigerant_pt",
      "calc_superheat_subcooling",
      "diagnose_refrigeration",
      "electrical_reference",
      "calc_electrical",
      "lookup_fault_code",
      "search_history",
      "get_unit_history",
      "save_finding",
      "update_unit",
      "set_conversation",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    assert.deepEqual(names, toolNames());
    for (const d of defs) {
      assert.equal(d.strict, true, `${d.name} strict`);
      assert.ok(d.description && d.description.length > 40, `${d.name} description`);
      const schema = d.input_schema as { type: string; properties: Record<string, { type: string | string[] }>; required: string[]; additionalProperties: boolean };
      assert.equal(schema.type, "object");
      assert.equal(schema.additionalProperties, false, `${d.name} additionalProperties`);
      const props = Object.keys(schema.properties);
      assert.deepEqual([...schema.required].sort(), [...props].sort(), `${d.name} required must list every property`);
      for (const [key, p] of Object.entries(schema.properties)) {
        assert.ok(p.type, `${d.name}.${key} has a type`);
        assert.ok((p as { description?: string }).description, `${d.name}.${key} has a description`);
      }
    }
  });

  test("optional inputs are nullable, required ones are not", () => {
    const decode = toolDefinitions().find((d) => d.name === "decode_unit")!;
    const props = (decode.input_schema as { properties: Record<string, { type: string | string[]; enum?: unknown[] }> }).properties;
    assert.equal(props.model!.type, "string");
    assert.deepEqual(props.serial!.type, ["string", "null"]);
    assert.deepEqual(props.save!.type, ["boolean", "null"]);
    const dx = toolDefinitions().find((d) => d.name === "diagnose_refrigeration")!;
    const dxProps = (dx.input_schema as { properties: Record<string, { type: string | string[]; enum?: unknown[] }> }).properties;
    assert.equal(dxProps.metering_device!.type, "string");
    assert.deepEqual(dxProps.metering_device!.enum, ["txv", "fixed", "eev", "unknown"]);
    assert.ok(dxProps.suction_psig, "snake_case measurement present");
    assert.ok(dxProps.compressor_amps_l2, "compressorAmpsL2 → compressor_amps_l2");
    assert.ok(dxProps.economizer_position!.enum!.includes(null), "nullable enum includes null");
  });

  test("definitions are fresh objects each call (loop may add cache_control)", () => {
    const a = toolDefinitions();
    const b = toolDefinitions();
    assert.notEqual(a[a.length - 1], b[b.length - 1]);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("executeTool validation", () => {
  test("unknown tool → isError listing available tools", async () => {
    const { ctx } = fresh();
    const r = await executeTool("nope", {}, ctx);
    assert.equal(r.isError, true);
    assert.match(parse(r.content).error as string, /Unknown tool "nope"/);
    assert.match(r.content, /decode_unit/);
  });

  test("missing required, wrong types, bad enum and out-of-range are all listed", async () => {
    const { ctx } = fresh();
    const r = await executeTool("diagnose_refrigeration", { metering_device: "piston", mode: "ac_cooling", suction_psig: "abc", outdoor_db_f: 900 }, ctx);
    assert.equal(r.isError, true);
    const msg = parse(r.content).error as string;
    assert.match(msg, /refrigerant is required/);
    assert.match(msg, /metering_device must be one of txv, fixed, eev, unknown/);
    assert.match(msg, /suction_psig must be a number/);
    assert.match(msg, /outdoor_db_f must be <= 500/);
    assert.match(r.summary, /invalid input \(4 problems\)/);
  });

  test("non-object input → isError", async () => {
    const { ctx } = fresh();
    const r = await executeTool("refrigerant_pt", "R-410A", ctx);
    assert.equal(r.isError, true);
    assert.match(r.content, /must be a JSON object/);
  });

  test("nulls are treated as omitted; numeric strings and enum case are coerced", async () => {
    const { ctx } = fresh();
    const r = await executeTool("refrigerant_pt", { refrigerant: "r410a", psig: "118", temp_f: null, elevation_ft: null }, ctx);
    assert.equal(r.isError, undefined);
    const out = parse(r.content);
    assert.equal(out.refrigerant, "R-410A");
    assert.equal(out.psig, 118);
  });
});

// ---------------------------------------------------------------------------
// Knowledge tools
// ---------------------------------------------------------------------------

describe("decode_unit", () => {
  test("decodes a Carrier nameplate and does not save without save=true", async () => {
    const { ctx, repos } = fresh();
    const r = await executeTool("decode_unit", { model: CARRIER_MODEL, serial: CARRIER_SERIAL }, ctx);
    assert.equal(r.isError, undefined);
    assert.ok(r.content.length <= TOOL_RESULT_MAX_CHARS);
    const out = parse(r.content);
    assert.ok(typeof out.summary === "string" && (out.summary as string).length > 20);
    const model = (out.model as { attributes: Record<string, string>; manufacturerId: string }[])[0]!;
    assert.equal(model.manufacturerId, "carrier");
    assert.equal(model.attributes.tonnage, "3");
    const serial = (out.serial as { year?: number; week?: number }[])[0]!;
    assert.equal(serial.year, 2016);
    assert.equal(serial.week, 32);
    assert.equal(r.attachUnitId, undefined);
    assert.equal(repos.units.list().length, 0);
    assert.match(r.summary, /Decoded 48TCDA04A2A5-0A0A0: Carrier/);
  });

  test("save=true creates the unit with decoded attributes and returns attachUnitId", async () => {
    const { ctx, repos } = fresh();
    const r = await executeTool("decode_unit", { model: CARRIER_MODEL, serial: CARRIER_SERIAL, save: true, site: "Pharmacy", unit_tag: "RTU-7", nickname: null }, ctx);
    assert.equal(r.isError, undefined);
    assert.ok(r.attachUnitId, "attachUnitId returned");
    const unit = repos.units.get(r.attachUnitId!)!;
    assert.equal(unit.model, CARRIER_MODEL);
    assert.equal(unit.serial, CARRIER_SERIAL);
    assert.equal(unit.manufacturer, "Carrier");
    assert.equal(unit.refrigerant, "R-410A");
    assert.equal(unit.tonnage, 3);
    assert.equal(unit.phase, "3");
    assert.equal(unit.site, "Pharmacy");
    assert.equal(unit.unit_tag, "RTU-7");
    assert.ok(unit.decoded_json && JSON.parse(unit.decoded_json).model.length > 0);
    assert.equal((parse(r.content).unit as { action: string }).action, "created");
  });

  test("a matching existing unit is updated (upsert) even without save", async () => {
    const { ctx, repos } = fresh();
    const created = repos.units.create({ model: CARRIER_MODEL, serial: CARRIER_SERIAL, site: "Old site" });
    const r = await executeTool("decode_unit", { model: CARRIER_MODEL.toLowerCase(), serial: CARRIER_SERIAL }, ctx);
    assert.equal(r.attachUnitId, created.id);
    const unit = repos.units.get(created.id)!;
    assert.equal(unit.site, "Old site", "unrelated fields kept");
    assert.equal(unit.manufacturer, "Carrier");
    assert.ok(unit.decoded_json);
    assert.equal((parse(r.content).unit as { action: string }).action, "updated");
    assert.equal(repos.units.list().length, 1);
  });

  test("unknown model still returns a result with warnings", async () => {
    const { ctx } = fresh();
    const r = await executeTool("decode_unit", { model: "QQQ-999" }, ctx);
    assert.equal(r.isError, undefined);
    const out = parse(r.content);
    assert.ok(Array.isArray(out.warnings));
    assert.match(r.summary, /No manufacturer match/);
  });
});

describe("find_unit", () => {
  test("finds by tag + site tokens, reports last finding date and attaches a single match", async () => {
    const { ctx, repos } = fresh();
    const u = repos.units.create({ model: CARRIER_MODEL, unit_tag: "RTU-7", site: "Pharmacy" });
    repos.units.create({ model: "XYZ", unit_tag: "AHU-2", site: "School" });
    repos.findings.create({ unit_id: u.id, symptom: "no cooling", service_date: "2025-03-04" });
    const r = await executeTool("find_unit", { query: "RTU-7 pharmacy" }, ctx);
    assert.equal(r.isError, undefined);
    const out = parse(r.content);
    const matches = out.matches as { id: string; lastFindingDate?: string }[];
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.id, u.id);
    assert.equal(matches[0]!.lastFindingDate, "2025-03-04");
    assert.equal(r.attachUnitId, u.id);
    assert.match(r.summary, /attached/);
  });

  test("several matches attach only with attach=true; none → hint", async () => {
    const { ctx, repos } = fresh();
    repos.units.create({ model: "AAA", unit_tag: "RTU-1", site: "Mall" });
    repos.units.create({ model: "BBB", unit_tag: "RTU-2", site: "Mall" });
    const r1 = await executeTool("find_unit", { query: "Mall" }, ctx);
    assert.equal((parse(r1.content).matches as unknown[]).length, 2);
    assert.equal(r1.attachUnitId, undefined);
    assert.match(parse(r1.content).hint as string, /Several units/);
    const r2 = await executeTool("find_unit", { query: "Mall", attach: true }, ctx);
    assert.ok(r2.attachUnitId);
    const r3 = await executeTool("find_unit", { query: "zzzz-nothing" }, ctx);
    assert.equal((parse(r3.content).matches as unknown[]).length, 0);
    assert.match(r3.summary, /No unit found/);
  });
});

describe("refrigerant_pt", () => {
  test("psig → saturation temps with safety class and glide", async () => {
    const { ctx } = fresh();
    const r = await executeTool("refrigerant_pt", { refrigerant: "R-410A", psig: 118 }, ctx);
    assert.equal(r.isError, undefined);
    const out = parse(r.content);
    assert.ok(Math.abs((out.dewTempF as number) - 40) < 1.5);
    assert.equal(out.safetyClass, "A1");
    assert.match(r.summary, /PT: R-410A 118 psig → /);
  });

  test("temp → pressures for an A2L blend carries handling notes; missing both inputs is an error", async () => {
    const { ctx } = fresh();
    const r = await executeTool("refrigerant_pt", { refrigerant: "R-454B", temp_f: 40 }, ctx);
    const out = parse(r.content);
    assert.equal(out.safetyClass, "A2L");
    assert.ok(typeof out.bubblePsig === "number" && typeof out.dewPsig === "number");
    assert.ok((out.notes as string[]).some((n) => /A2L/i.test(n)));
    const bad = await executeTool("refrigerant_pt", { refrigerant: "R-410A" }, ctx);
    assert.equal(bad.isError, true);
    assert.match(bad.content, /psig or temp_f/);
    const unknown = await executeTool("refrigerant_pt", { refrigerant: "R-9999", psig: 100 }, ctx);
    assert.equal(unknown.isError, true);
    assert.match(unknown.content, /Unknown refrigerant/);
  });
});

describe("calc_superheat_subcooling", () => {
  test("computes SH and SC", async () => {
    const { ctx } = fresh();
    const r = await executeTool("calc_superheat_subcooling", { refrigerant: "R-410A", suction_psig: 118, suction_line_temp_f: 50, liquid_psig: 380, liquid_line_temp_f: 101.5 }, ctx);
    assert.equal(r.isError, undefined);
    const out = parse(r.content);
    assert.ok(Math.abs((out.superheatF as number) - 10) < 1);
    assert.ok(Math.abs((out.subcoolingF as number) - 10) < 2);
    assert.match(r.summary, /SH .* \/ SC /);
  });

  test("needs at least one pressure/temperature pair", async () => {
    const { ctx } = fresh();
    const r = await executeTool("calc_superheat_subcooling", { refrigerant: "R-410A", suction_psig: 118 }, ctx);
    assert.equal(r.isError, true);
    assert.match(r.content, /suction_line_temp_f/);
  });
});

describe("diagnose_refrigeration", () => {
  test("maps snake_case to DxMeasurements and returns derived/validity/findings/missing/summary", async () => {
    const { ctx } = fresh();
    const r = await executeTool(
      "diagnose_refrigeration",
      {
        refrigerant: "R-410A",
        metering_device: "txv",
        mode: "ac_cooling",
        outdoor_db_f: 91.4,
        indoor_db_f: 75,
        indoor_wb_f: 63,
        suction_psig: 118,
        suction_line_temp_f: 50,
        liquid_psig: 380,
        liquid_line_temp_f: 101.5,
        supply_db_f: 57,
        compressor_amps: 16,
        compressor_rla: 20,
        runtime_minutes: 20,
        economizer_position: "closed",
        sight_glass: null,
      },
      ctx,
    );
    assert.equal(r.isError, undefined);
    const out = parse(r.content);
    const derived = out.derived as Record<string, number>;
    assert.ok(Math.abs(derived.superheatF! - 10) < 1);
    assert.ok(Math.abs(derived.deltaTF! - 18) < 0.01);
    assert.equal(derived.ampsPercentRla, 80);
    assert.equal((out.validity as { ok: boolean }).ok, true);
    assert.ok(Array.isArray(out.findings) && (out.findings as unknown[]).length <= 6);
    assert.ok(Array.isArray(out.missing));
    assert.ok(typeof out.summary === "string");
    assert.ok(r.content.length <= TOOL_RESULT_MAX_CHARS);
  });

  test("low ambient without head-pressure control flags validity", async () => {
    const { ctx } = fresh();
    const r = await executeTool("diagnose_refrigeration", { refrigerant: "R-410A", metering_device: "txv", mode: "ac_cooling", outdoor_db_f: 50, suction_psig: 100, suction_line_temp_f: 60, liquid_psig: 250, liquid_line_temp_f: 70 }, ctx);
    const out = parse(r.content);
    assert.equal((out.validity as { ok: boolean }).ok, false);
    assert.match(r.summary, /not valid for charge/);
  });
});

describe("electrical_reference / calc_electrical", () => {
  test("component lookup returns tests with expected values", async () => {
    const { ctx } = fresh();
    const r = await executeTool("electrical_reference", { query: "run capacitor", kind: "component" }, ctx);
    assert.equal(r.isError, undefined);
    const out = parse(r.content);
    const comps = out.components as { id: string; tests: unknown[] }[];
    assert.ok(comps.length >= 1);
    assert.equal(comps[0]!.id, "run_capacitor");
    assert.deepEqual(out.procedures, []);
    assert.ok(r.content.length <= TOOL_RESULT_MAX_CHARS);
  });

  test("procedure lookup by symptom", async () => {
    const { ctx } = fresh();
    const r = await executeTool("electrical_reference", { query: "unit completely dead", kind: "procedure" }, ctx);
    const procs = parse(r.content).procedures as { id: string }[];
    assert.ok(procs.some((p) => p.id === "unit_dead"));
  });

  test("voltage imbalance calculator", async () => {
    const { ctx } = fresh();
    const r = await executeTool("calc_electrical", { kind: "voltage_imbalance", vab: 480, vbc: 470, vca: 475 }, ctx);
    assert.equal(r.isError, undefined);
    const out = parse(r.content);
    assert.ok(Math.abs((out.values as Record<string, number>).imbalancePercent! - 1.05) < 0.02);
    assert.match(r.summary, /voltage imbalance/);
  });

  test("every calculator kind runs with its inputs", async () => {
    const { ctx } = fresh();
    const cases: Record<string, unknown>[] = [
      { kind: "current_imbalance", ia: 10, ib: 11, ic: 10.5 },
      { kind: "capacitor_under_load", amps: 2.5, volts: 240, rated_uf: 40 },
      { kind: "amps_vs_rla", amps: 16, rla: 20 },
      { kind: "temp_rise_cfm", input_btuh: 100000, efficiency_percent: 80, rise_f: 40 },
      { kind: "ohms_law", volts: 24, ohms: 12 },
      { kind: "electric_heat_kw", volts: 480, amps: 20, phase: 3, nameplate_kw: 16 },
      { kind: "psychrometrics", db_f: 75, wb_f: 63 },
      { kind: "winding_check", phase: 1, r1: 2.1, r2: 0.9, r3: 3.0 },
      { kind: "megohm", megohms: 250, test_volts: 500 },
    ];
    for (const input of cases) {
      const r = await executeTool("calc_electrical", input, ctx);
      assert.equal(r.isError, undefined, `${input.kind}: ${r.content}`);
      assert.equal(parse(r.content).kind, input.kind);
    }
  });

  test("missing calculator inputs → helpful error", async () => {
    const { ctx } = fresh();
    const r = await executeTool("calc_electrical", { kind: "voltage_imbalance", vab: 480 }, ctx);
    assert.equal(r.isError, true);
    assert.match(r.content, /missing: vbc, vca/);
    const ohms = await executeTool("calc_electrical", { kind: "ohms_law", volts: 24 }, ctx);
    assert.equal(ohms.isError, true);
    const phase = await executeTool("calc_electrical", { kind: "winding_check", phase: 2, r1: 1, r2: 1, r3: 1 }, ctx);
    assert.equal(phase.isError, true);
    assert.match(phase.content, /phase must be 1 or 3/);
  });
});

describe("lookup_fault_code", () => {
  test("hit includes platform coverage and source per entry", async () => {
    const { ctx } = fresh();
    const r = await executeTool("lookup_fault_code", { code: "A140", manufacturer: "Carrier" }, ctx);
    assert.equal(r.isError, undefined);
    const out = parse(r.content);
    const entries = out.entries as { code: string; meaning: string; source: string; platform: { coverage: string }; coverageNote: string }[];
    assert.ok(entries.length >= 1);
    assert.ok(entries[0]!.meaning.length > 5);
    assert.ok(typeof entries[0]!.source === "string" && entries[0]!.source.length > 0);
    assert.ok(["complete", "partial"].includes(entries[0]!.platform.coverage));
    assert.match(entries[0]!.coverageNote, /complete|PARTIAL/);
    assert.match(out.message as string, /coverage/);
    assert.match(r.summary, /A140/);
  });

  test("no hit says no verified entry", async () => {
    const { ctx } = fresh();
    const r = await executeTool("lookup_fault_code", { code: "ZZ-9999-QQ" }, ctx);
    assert.equal(r.isError, undefined);
    assert.equal(parse(r.content).hitCount, 0);
    assert.match(parse(r.content).message as string, /No verified entry/);
    assert.match(r.summary, /No verified entry/);
  });
});

// ---------------------------------------------------------------------------
// Job memory tools
// ---------------------------------------------------------------------------

describe("save_finding / search_history / get_unit_history", () => {
  test("round-trip: save then search finds it; hypothesis unless confirmed === true", async () => {
    const { ctx, repos } = fresh();
    const unit = repos.units.create({ model: CARRIER_MODEL, unit_tag: "RTU-7", site: "Pharmacy" });
    ctx.unitId = unit.id;
    const saved = await executeTool(
      "save_finding",
      { symptom: "Low suction and high superheat on circuit 1", cause: "Undercharge from a leaking Schrader", resolution: "Replaced core, leak checked, added 2.5 lb", measurements: { suction_psig: 95, sh_f: 25 }, parts: ["Schrader core"], tags: ["undercharge", "Leak"], circuit: "1", refrigerant: "R-410A", refrigerant_added_lbs: 2.5, confirmed: false },
      ctx,
    );
    assert.equal(saved.isError, undefined, saved.content);
    const row = repos.findings.list({ unitId: unit.id })[0]!;
    assert.equal(row.origin, "assistant");
    assert.equal(row.confirmed, 0, "confirmed only when input.confirmed === true");
    const yes = await executeTool("save_finding", { symptom: "x", confirmed: "yes" }, ctx);
    assert.equal(yes.isError, true, "non-boolean confirmed is rejected");
    assert.equal(row.status, "open");
    assert.equal(row.tags, "undercharge,leak");
    assert.equal(row.measurements_json, JSON.stringify({ suction_psig: 95, sh_f: 25 }));
    assert.equal(row.service_date, "2026-09-26");
    assert.equal(row.conversation_id, ctx.conversationId);
    assert.match(saved.summary, /unconfirmed/);

    const confirmed = await executeTool("save_finding", { symptom: "Contactor pitted", cause: "Age", resolution: "Replaced contactor", confirmed: true }, ctx);
    assert.equal(confirmed.isError, undefined);
    const rows = repos.findings.list({ unitId: unit.id });
    const c = rows.find((f) => f.symptom === "Contactor pitted")!;
    assert.equal(c.confirmed, 1);
    assert.equal(c.status, "resolved");

    const search = await executeTool("search_history", { query: "Schrader leak", unit_only: true }, ctx);
    assert.equal(search.isError, undefined);
    const hits = parse(search.content).hits as { kind: string; id: string; snippet: string }[];
    assert.ok(hits.some((h) => h.kind === "finding" && h.id === row.id));
    assert.ok(hits.every((h) => h.snippet.length <= 300));

    const history = await executeTool("get_unit_history", {}, ctx);
    assert.equal(history.isError, undefined);
    const out = parse(history.content);
    assert.equal(out.findingCount, 2);
    const findings = out.findings as { hypothesis?: boolean; confirmed: boolean }[];
    assert.ok(findings.some((f) => f.hypothesis === true));
    assert.ok(findings.some((f) => f.confirmed === true));
    assert.equal((out.unit as { id: string }).id, unit.id);
  });

  test("unit_only without unit, bad since date, and get_unit_history without unit are errors", async () => {
    const { ctx } = fresh();
    const a = await executeTool("search_history", { query: "x", unit_only: true }, ctx);
    assert.equal(a.isError, true);
    const b = await executeTool("search_history", { query: "x", since: "yesterday" }, ctx);
    assert.equal(b.isError, true);
    assert.match(b.content, /since must be an ISO date/);
    const c = await executeTool("get_unit_history", {}, ctx);
    assert.equal(c.isError, true);
    assert.match(c.content, /No unit attached/);
    const d = await executeTool("get_unit_history", { unit_id: "0123456789abcdef" }, ctx);
    assert.equal(d.isError, true);
    assert.match(d.content, /not found/);
  });

  test("search with no hits is ok with a hint", async () => {
    const { ctx } = fresh();
    const r = await executeTool("search_history", { query: "nothing-here" }, ctx);
    assert.equal(r.isError, undefined);
    assert.equal(parse(r.content).hitCount, 0);
  });
});

describe("update_unit", () => {
  test("errors when no unit is attached", async () => {
    const { ctx } = fresh();
    const r = await executeTool("update_unit", { circuits: 2 }, ctx);
    assert.equal(r.isError, true);
    assert.match(r.content, /No unit is attached/);
  });

  test("updates fields; charge/nameplate objects are stringified", async () => {
    const { ctx, repos } = fresh();
    const unit = repos.units.create({ model: CARRIER_MODEL });
    ctx.unitId = unit.id;
    const r = await executeTool(
      "update_unit",
      { unit_tag: "RTU-7", circuits: 2, charge: { "1": "12 lb 4 oz", "2": "11 lb 8 oz" }, nameplate: '{"mca":38,"mop":50}', metering_device: "TXV", elevation_ft: 5280, phase: "3", nickname: null },
      ctx,
    );
    assert.equal(r.isError, undefined, r.content);
    const u = repos.units.get(unit.id)!;
    assert.equal(u.unit_tag, "RTU-7");
    assert.equal(u.circuits, 2);
    assert.equal(u.charge_json, JSON.stringify({ "1": "12 lb 4 oz", "2": "11 lb 8 oz" }));
    assert.equal(u.nameplate_json, '{"mca":38,"mop":50}');
    assert.equal(u.metering_device, "txv");
    assert.equal(u.elevation_ft, 5280);
    assert.equal(u.phase, "3");
    const updatedKeys = parse(r.content).updated as string[];
    assert.deepEqual([...updatedKeys].sort(), ["charge_json", "circuits", "elevation_ft", "metering_device", "nameplate_json", "phase", "unit_tag"]);
    assert.match(r.summary, /updated: /);
    const nothing = await executeTool("update_unit", { nickname: null }, ctx);
    assert.equal(nothing.isError, true);
  });
});

describe("set_conversation", () => {
  test("returns setTitle / setSummary side effects", async () => {
    const { ctx } = fresh();
    const r = await executeTool("set_conversation", { title: "RTU-7 low charge ckt 1", summary: "Undercharge from a leaking Schrader; core replaced, 2.5 lb added." }, ctx);
    assert.equal(r.isError, undefined);
    assert.equal(r.setTitle, "RTU-7 low charge ckt 1");
    assert.match(r.setSummary!, /Undercharge/);
    assert.match(r.summary, /title/);
    const onlySummary = await executeTool("set_conversation", { title: null, summary: "x" }, ctx);
    assert.equal(onlySummary.setTitle, undefined);
    assert.equal(onlySummary.setSummary, "x");
    const none = await executeTool("set_conversation", {}, ctx);
    assert.equal(none.isError, true);
  });
});

// ---------------------------------------------------------------------------
// Labels and result sizing
// ---------------------------------------------------------------------------

describe("describeToolCall", () => {
  test("labels for every tool", () => {
    assert.equal(describeToolCall("decode_unit", { model: "48TCDA04", serial: "3216E54321" }), "Decode 48TCDA04 / S/N 3216E54321");
    assert.equal(describeToolCall("find_unit", { query: "RTU-7" }), 'Find unit "RTU-7"');
    assert.equal(describeToolCall("refrigerant_pt", { refrigerant: "R-410A", psig: 118 }), "PT: R-410A 118 psig");
    assert.equal(describeToolCall("refrigerant_pt", { refrigerant: "R-22", temp_f: 40 }), "PT: R-22 40 °F");
    assert.equal(describeToolCall("calc_superheat_subcooling", { refrigerant: "R-410A" }), "SH/SC R-410A");
    assert.equal(describeToolCall("diagnose_refrigeration", { refrigerant: "R-410A", mode: "ac_cooling", circuit: "2" }), "Diagnose R-410A · ac cooling · ckt 2");
    assert.equal(describeToolCall("electrical_reference", { query: "contactor" }), "Electrical: contactor");
    assert.equal(describeToolCall("calc_electrical", { kind: "voltage_imbalance" }), "Calc voltage imbalance");
    assert.equal(describeToolCall("lookup_fault_code", { code: "A140", manufacturer: "Carrier" }), "Fault code A140 (Carrier)");
    assert.equal(describeToolCall("search_history", { query: "leak" }), 'Search history "leak"');
    assert.equal(describeToolCall("get_unit_history", {}), "Unit history");
    assert.equal(describeToolCall("save_finding", { symptom: "no cooling" }), "Save finding (unconfirmed): no cooling");
    assert.equal(describeToolCall("save_finding", { symptom: "no cooling", confirmed: true }), "Save finding: no cooling");
    assert.equal(describeToolCall("update_unit", { circuits: 2, site: "x" }), "Update unit (circuits, site)");
    assert.equal(describeToolCall("set_conversation", { title: "t", summary: "s" }), "Set conversation title + summary");
    assert.equal(describeToolCall("web_search", { query: "48TC IOM" }), "Web search: 48TC IOM");
    assert.equal(describeToolCall("mystery", null), "mystery");
  });
});

describe("compactJson", () => {
  test("fits under the limit by shortening arrays and says so; output stays valid JSON", () => {
    const big = { summary: "s", items: Array.from({ length: 500 }, (_, i) => ({ i, text: "x".repeat(80) })) };
    const text = compactJson(big);
    assert.ok(text.length <= TOOL_RESULT_MAX_CHARS);
    const parsed = JSON.parse(text) as { items: unknown[]; truncated: string; summary: string };
    assert.ok(parsed.items.length < 500);
    assert.match(parsed.truncated, /truncated/);
    assert.equal(parsed.summary, "s");
  });

  test("giant strings without arrays still fit", () => {
    const text = compactJson({ summary: "s", blob: "y".repeat(50_000) });
    assert.ok(text.length <= TOOL_RESULT_MAX_CHARS);
    assert.equal((JSON.parse(text) as { summary: string }).summary, "s");
  });

  test("undefined values are dropped and small values are untouched", () => {
    assert.equal(compactJson({ a: 1, b: undefined, c: [1, undefined] }), '{"a":1,"c":[1,null]}');
  });
});
