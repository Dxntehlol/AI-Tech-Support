/* Wave-2 calculator kinds through the calc_electrical tool + describeToolCall labels for the new tools. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import { loadKnowledge } from "../knowledge/loader.ts";
import { openDatabase } from "../db/index.ts";
import { createRepos } from "../db/repos.ts";
import { CALC_KINDS } from "../knowledge/electrical.ts";
import { describeToolCall, executeTool, toolDefinitions, type ToolContext } from "./tools.ts";

const kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });

function ctx(): ToolContext {
  const repos = createRepos(openDatabase(":memory:"));
  return { kb, repos, conversationId: repos.conversations.create({}).id, unitId: null, now: new Date("2026-10-12T12:00:00Z") };
}

describe("calc_electrical wave-2 kinds", () => {
  test("the tool enum lists every CALC_KINDS entry and every kind runs with its required inputs", async () => {
    const def = toolDefinitions().find((d) => d.name === "calc_electrical")!;
    const props = (def.input_schema as { properties: Record<string, { enum?: string[] }> }).properties;
    assert.deepEqual(props.kind!.enum, [...CALC_KINDS]);
    for (const key of ["added_lbs", "dial_cuft", "co_ppm", "btuh", "supply_in_wc", "rpm1", "motor_rpm", "one_way_ft", "hp", "rated_v", "frame"]) assert.ok(props[key], key);
    const c = ctx();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ kind: "leak_rate", added_lbs: 25, full_charge_lbs: 400, days_since_last_add: 60, appliance_type: "commercial_refrigeration" }, /38.02 %/],
      [{ kind: "gas_meter_clock", dial_cuft: 1, seconds_per_rev: 36, nameplate_input_btuh: 100000 }, /100 ft³\/h/],
      [{ kind: "combustion_co", co_ppm: 50, o2_pct: 9, ambient_co_ppm: 3 }, /88 ppm/],
      [{ kind: "sensible_cfm", btuh: 54000, delta_t_f: 50, tons: 2.5 }, /1,000 CFM/],
      [{ kind: "static_pressure", supply_in_wc: 0.35, return_in_wc: -0.3, blower_type: "ecm" }, /0.65 in. wc/],
      [{ kind: "fan_laws", rpm1: 1000, rpm2: 1100, cfm1: 5000 }, /ratio/],
      [{ kind: "belt_drive", motor_rpm: 1750, motor_sheave_in: 4, fan_sheave_in: 8, center_distance_in: 20 }, /875 RPM/],
      [{ kind: "voltage_drop", volts: 240, amps: 20, one_way_ft: 100, awg: "10" }, /4.97 V/],
      [{ kind: "motor_fla", hp: 15, volts: 460, phase: 3 }, /21 A/],
      [{ kind: "capacitor_replacement", rated_uf: 45, rated_v: 370, replacement_uf: 45, replacement_v: 440 }, /within/],
      [{ kind: "motor_replacement", hp: 1, rpm: 1075, rotation_from_shaft_end: "ccw" }, /checklist/i],
    ];
    for (const [input, re] of cases) {
      const r = await executeTool("calc_electrical", input, c);
      assert.equal(r.isError, undefined, `${String(input.kind)}: ${r.content}`);
      const j = JSON.parse(r.content) as { kind: string; interpretation: string[]; request: { kind: string } };
      assert.equal(j.kind, input.kind);
      assert.equal(j.request.kind, input.kind);
      assert.match(j.interpretation.join("\n"), re, String(input.kind));
    }
  });

  test("missing required inputs and bad enums fail cleanly", async () => {
    const c = ctx();
    const missing = await executeTool("calc_electrical", { kind: "leak_rate", added_lbs: 5 }, c);
    assert.equal(missing.isError, true);
    assert.match(missing.content, /full_charge_lbs/);
    const vd = await executeTool("calc_electrical", { kind: "voltage_drop", volts: 240, amps: 20, one_way_ft: 100 }, c);
    assert.equal(vd.isError, true);
    assert.match(vd.content, /awg/);
    const phase = await executeTool("calc_electrical", { kind: "motor_fla", hp: 5, volts: 230, phase: 2 }, c);
    assert.equal(phase.isError, true);
    const badEnum = await executeTool("calc_electrical", { kind: "static_pressure", supply_in_wc: 0.3, return_in_wc: 0.3, blower_type: "belt" }, c);
    assert.equal(badEnum.isError, true);
  });

  test("describeToolCall labels the new tools", () => {
    assert.equal(describeToolCall("log_refrigerant", { event_type: "add", amount_lbs: 2.5, refrigerant: "R-410A" }), "Log refrigerant add 2.5 lb R-410A");
    assert.equal(describeToolCall("log_refrigerant", { event_type: "leak_check" }), "Log refrigerant leak check");
    assert.equal(describeToolCall("diagnose_chiller", { circuit: "1" }), "Chiller readings ckt 1");
    assert.equal(describeToolCall("get_pm_checklist", { equipment_type: "rtu_gas" }), "PM checklist rtu gas");
    assert.equal(describeToolCall("get_pm_checklist", {}), "PM checklist");
    assert.equal(describeToolCall("calc_electrical", { kind: "voltage_drop" }), "Calc voltage drop");
  });
});
