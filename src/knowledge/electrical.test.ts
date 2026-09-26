import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadKnowledge } from "./loader.ts";
import { PROJECT_ROOT } from "../config.ts";
import {
  calcElectrical,
  findComponent,
  findProcedure,
  findReference,
  lookupElectrical,
  nemaDerateFactor,
  psychrometrics,
  saturationPressurePsia,
  tokenize,
} from "./electrical.ts";
import type { ElectricalCalcRequest, ElectricalComponent, ElectricalProcedure } from "../types.ts";

const kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });

function near(actual: number | undefined, expected: number, tol: number, label: string): void {
  assert.ok(actual !== undefined && Number.isFinite(actual), `${label}: got ${actual}`);
  assert.ok(Math.abs((actual as number) - expected) <= tol, `${label}: ${actual} not within ±${tol} of ${expected}`);
}

// ---------------------------------------------------------------------------
// Calculators
// ---------------------------------------------------------------------------

test("voltage_imbalance: 460/455/470 → NEMA imbalance and derate", () => {
  const r = calcElectrical({ kind: "voltage_imbalance", vab: 460, vbc: 455, vca: 470 });
  assert.equal(r.kind, "voltage_imbalance");
  assert.equal(r.warnings.length, 0);
  near(r.values.average, 461.7, 0.1, "average");
  near(r.values.maxDeviation, 8.33, 0.05, "max deviation");
  // 100 × 8.33 / 461.67 = 1.8 % (NEMA MG-1 definition)
  near(r.values.imbalancePercent, 1.8, 0.05, "imbalance %");
  assert.ok((r.values.derateFactor as number) >= 0.95 && (r.values.derateFactor as number) <= 1.0, "derate ~1.0");
  assert.equal(r.values.worstLeg, 3);
  assert.ok(r.interpretation.some((s) => /NEMA MG-1/.test(s)));
});

test("voltage_imbalance: NEMA derate curve points and >5 % warning", () => {
  assert.equal(nemaDerateFactor(0.5), 1);
  assert.equal(nemaDerateFactor(1), 1);
  assert.equal(nemaDerateFactor(2), 0.95);
  assert.equal(nemaDerateFactor(3), 0.88);
  assert.equal(nemaDerateFactor(4), 0.82);
  assert.equal(nemaDerateFactor(5), 0.75);
  assert.equal(nemaDerateFactor(7), 0.75);
  const balanced = calcElectrical({ kind: "voltage_imbalance", vab: 480, vbc: 480, vca: 480 });
  assert.equal(balanced.values.imbalancePercent, 0);
  assert.equal(balanced.values.derateFactor, 1);
  const bad = calcElectrical({ kind: "voltage_imbalance", vab: 480, vbc: 440, vca: 480 });
  assert.ok((bad.values.imbalancePercent as number) > 5);
  assert.equal(bad.values.derateFactor, 0.75);
  assert.ok(bad.interpretation.some((s) => /do not operate/i.test(s)));
});

test("voltage_imbalance: invalid input returns warnings, no throw", () => {
  const r = calcElectrical({ kind: "voltage_imbalance", vab: 460, vbc: Number.NaN, vca: -5 });
  assert.equal(Object.keys(r.values).length, 0);
  assert.ok(r.warnings.length >= 2);
  assert.ok(r.warnings.some((w) => /vbc/.test(w)) && r.warnings.some((w) => /vca/.test(w)));
  const missing = calcElectrical({ kind: "voltage_imbalance" } as unknown as ElectricalCalcRequest);
  assert.ok(missing.warnings.length === 3);
});

test("current_imbalance: 10 % guideline and single-phasing", () => {
  const ok = calcElectrical({ kind: "current_imbalance", ia: 20, ib: 21, ic: 20.5 });
  near(ok.values.imbalancePercent, 2.44, 0.05, "imbalance");
  assert.ok(ok.interpretation.some((s) => /Within the 10 %/.test(s)));
  const high = calcElectrical({ kind: "current_imbalance", ia: 20, ib: 26, ic: 20 });
  assert.ok((high.values.imbalancePercent as number) > 10);
  assert.ok(high.interpretation.some((s) => /Above 10 %/.test(s)));
  const single = calcElectrical({ kind: "current_imbalance", ia: 30, ib: 0, ic: 30 });
  assert.ok(single.interpretation.some((s) => /single-phasing/i.test(s)));
  const bad = calcElectrical({ kind: "current_imbalance", ia: 30, ib: -1, ic: 30 });
  assert.ok(bad.warnings.length === 1 && Object.keys(bad.values).length === 0);
});

test("capacitor_under_load: 2652 × 4.0 / 240 = 44.2 µF, pass/fail vs 45 µF ±6 %", () => {
  const pass = calcElectrical({ kind: "capacitor_under_load", amps: 4.0, volts: 240, ratedUf: 45 });
  near(pass.values.microfarads, 44.2, 0.05, "µF");
  near(pass.values.percentOfRated, 98.2, 0.1, "% of rated");
  assert.equal(pass.values.pass, 1);
  assert.ok(pass.interpretation.some((s) => /PASS/.test(s)));
  assert.ok(pass.interpretation.some((s) => /COMMON/i.test(s)), "invalid-on-common note");

  const fail = calcElectrical({ kind: "capacitor_under_load", amps: 3.6, volts: 240, ratedUf: 45 });
  near(fail.values.microfarads, 39.8, 0.05, "µF");
  assert.equal(fail.values.pass, 0);
  assert.ok(fail.interpretation.some((s) => /FAIL/.test(s)));

  const noRating = calcElectrical({ kind: "capacitor_under_load", amps: 4.0, volts: 240 });
  near(noRating.values.microfarads, 44.2, 0.05, "µF");
  assert.equal(noRating.values.pass, undefined);

  const bad = calcElectrical({ kind: "capacitor_under_load", amps: 0, volts: 240, ratedUf: 45 });
  assert.equal(bad.values.microfarads, undefined);
  assert.ok(bad.warnings.some((w) => /amps/.test(w)));
});

test("amps_vs_rla: percent bands and MCC estimate", () => {
  const normal = calcElectrical({ kind: "amps_vs_rla", amps: 18, rla: 20 });
  assert.equal(normal.values.percentOfRla, 90);
  near(normal.values.mccEstimate, 31.2, 0.05, "MCC");
  assert.ok(normal.interpretation.some((s) => /Normal running band/.test(s)));
  const low = calcElectrical({ kind: "amps_vs_rla", amps: 8, rla: 20 });
  assert.ok(low.interpretation.some((s) => /< 50 %/.test(s)));
  const high = calcElectrical({ kind: "amps_vs_rla", amps: 25, rla: 20 });
  assert.ok(high.interpretation.some((s) => /> 115 %/.test(s)));
  const zero = calcElectrical({ kind: "amps_vs_rla", amps: 0, rla: 20 });
  assert.ok(zero.interpretation.some((s) => /not running/.test(s)));
  const bad = calcElectrical({ kind: "amps_vs_rla", amps: 10, rla: 0 });
  assert.ok(bad.warnings.some((w) => /rla/.test(w)));
});

test("temp_rise_cfm: CFM = output / (1.08 × ΔT); electric heat at 100 %", () => {
  const gas = calcElectrical({ kind: "temp_rise_cfm", inputBtuh: 150000, efficiencyPercent: 80, riseF: 50 });
  assert.equal(gas.values.outputBtuh, 120000);
  assert.equal(gas.values.cfm, Math.round(120000 / (1.08 * 50)));
  const electric = calcElectrical({ kind: "temp_rise_cfm", inputBtuh: 15 * 3412, efficiencyPercent: 100, riseF: 30 });
  assert.equal(electric.values.outputBtuh, 51180);
  assert.equal(electric.values.cfm, Math.round(51180 / (1.08 * 30)));
  const bad = calcElectrical({ kind: "temp_rise_cfm", inputBtuh: 150000, efficiencyPercent: 80, riseF: 0 });
  assert.ok(bad.warnings.some((w) => /riseF/.test(w)));
  assert.equal(bad.values.cfm, undefined);
});

test("ohms_law: any two values compute the rest", () => {
  const vi = calcElectrical({ kind: "ohms_law", volts: 240, amps: 10 });
  assert.deepEqual(vi.values, { volts: 240, amps: 10, ohms: 24, watts: 2400 });
  const vr = calcElectrical({ kind: "ohms_law", volts: 240, ohms: 24 });
  assert.equal(vr.values.amps, 10);
  assert.equal(vr.values.watts, 2400);
  const pr = calcElectrical({ kind: "ohms_law", watts: 2400, ohms: 24 });
  assert.equal(pr.values.amps, 10);
  assert.equal(pr.values.volts, 240);
  const ip = calcElectrical({ kind: "ohms_law", amps: 10, watts: 2400 });
  assert.equal(ip.values.volts, 240);
  const one = calcElectrical({ kind: "ohms_law", volts: 240 });
  assert.ok(one.warnings.some((w) => /any two/.test(w)));
  const bad = calcElectrical({ kind: "ohms_law", volts: 240, amps: Number.POSITIVE_INFINITY });
  assert.ok(bad.warnings.length >= 1);
});

test("electric_heat_kw: 3-phase 480 V 20 A → 16.6 kW; nameplate ±10 %", () => {
  const r = calcElectrical({ kind: "electric_heat_kw", volts: 480, amps: 20, phase: 3, nameplateKw: 16 });
  near(r.values.kw, 16.63, 0.05, "kW");
  near(r.values.btuh, 16.63 * 3412, 100, "BTUh");
  assert.equal(r.values.pass, 1);
  const single = calcElectrical({ kind: "electric_heat_kw", volts: 240, amps: 20.8, phase: 1 });
  near(single.values.kw, 4.99, 0.01, "kW 1-ph");
  const low = calcElectrical({ kind: "electric_heat_kw", volts: 480, amps: 12, phase: 3, nameplateKw: 16 });
  assert.equal(low.values.pass, 0);
  assert.ok(low.interpretation.some((s) => /low/i.test(s)));
  const bad = calcElectrical({ kind: "electric_heat_kw", volts: -480, amps: 20, phase: 3 });
  assert.ok(bad.warnings.some((w) => /volts/.test(w)));
});

test("psychrometrics: 75 °F DB / 63 °F WB at sea level", () => {
  const r = calcElectrical({ kind: "psychrometrics", dbF: 75, wbF: 63 });
  assert.equal(r.warnings.length, 0);
  near(r.values.rhPercent, 51, 3, "RH");
  near(r.values.dewPointF, 55.5, 1.5, "dew point");
  near(r.values.enthalpyBtuPerLb, 28.5, 0.7, "enthalpy");
  near(r.values.grainsPerLb, 67, 4, "grains");
  near(r.values.pressurePsia, 14.696, 0.001, "Patm");
  // internal consistency: enthalpy = 0.240·T + W·(1061 + 0.444·T)
  const s = psychrometrics(75, 63, 0);
  near(s.enthalpyBtuPerLb, 0.24 * 75 + s.humidityRatio * (1061 + 0.444 * 75), 1e-9, "enthalpy identity");
  // saturation pressure anchors: 212 °F ≈ 14.696 psia, 32 °F ≈ 0.0887 psia
  near(saturationPressurePsia(212), 14.696, 0.02, "pws 212");
  near(saturationPressurePsia(32), 0.0887, 0.001, "pws 32");
});

test("psychrometrics: elevation raises humidity ratio; WB > DB clamped with a warning", () => {
  const sea = calcElectrical({ kind: "psychrometrics", dbF: 75, wbF: 63, elevationFt: 0 });
  const denver = calcElectrical({ kind: "psychrometrics", dbF: 75, wbF: 63, elevationFt: 5280 });
  assert.ok((denver.values.pressurePsia as number) < 12.5);
  assert.ok((denver.values.grainsPerLb as number) > (sea.values.grainsPerLb as number));
  assert.ok((denver.values.enthalpyBtuPerLb as number) > (sea.values.enthalpyBtuPerLb as number));
  const saturated = calcElectrical({ kind: "psychrometrics", dbF: 75, wbF: 75 });
  near(saturated.values.rhPercent, 100, 0.5, "saturated RH");
  near(saturated.values.dewPointF, 75, 0.2, "saturated dew point");
  const clamped = calcElectrical({ kind: "psychrometrics", dbF: 70, wbF: 80 });
  assert.ok(clamped.warnings.some((w) => /cannot exceed/.test(w)));
  near(clamped.values.rhPercent, 100, 0.5, "clamped RH");
  const bad = calcElectrical({ kind: "psychrometrics", dbF: Number.NaN, wbF: 63 });
  assert.ok(bad.warnings.some((w) => /dbF/.test(w)));
});

test("winding_check single-phase: pass, open overload, mismatch, short", () => {
  const pass = calcElectrical({ kind: "winding_check", phase: 1, r1: 3.1, r2: 0.9, r3: 4.0 });
  assert.equal(pass.values.pass, 1);
  assert.equal(pass.values.csPlusCr, 4);
  assert.ok(pass.interpretation.some((s) => /PASS/.test(s)));

  const overload = calcElectrical({ kind: "winding_check", phase: 1, r1: 1e9, r2: 1e9, r3: 4.0 });
  assert.equal(overload.values.pass, 0);
  assert.equal(overload.values.openCount, 2);
  assert.ok(overload.interpretation.some((s) => /internal overload/.test(s) && /cool/i.test(s)));

  const mismatch = calcElectrical({ kind: "winding_check", phase: 1, r1: 3.1, r2: 0.9, r3: 6.0 });
  assert.equal(mismatch.values.pass, 0);
  assert.ok((mismatch.values.sumErrorPercent as number) > 10);

  const shorted = calcElectrical({ kind: "winding_check", phase: 1, r1: 3.1, r2: 0, r3: 4.0 });
  assert.equal(shorted.values.pass, 0);
  assert.equal(shorted.values.shortCount, 1);
  assert.ok(shorted.interpretation.some((s) => /shorted/i.test(s)));

  const swapped = calcElectrical({ kind: "winding_check", phase: 1, r1: 0.9, r2: 3.1, r3: 4.0 });
  assert.equal(swapped.values.pass, 0);
  assert.ok(swapped.interpretation.some((s) => /ordering/i.test(s)));
});

test("winding_check three-phase: ±5 % balance, open leg, short", () => {
  const pass = calcElectrical({ kind: "winding_check", phase: 3, r1: 1.0, r2: 1.02, r3: 0.98 });
  assert.equal(pass.values.pass, 1);
  near(pass.values.deviationPercent, 2, 0.01, "deviation");
  const fail = calcElectrical({ kind: "winding_check", phase: 3, r1: 1.0, r2: 1.2, r3: 1.0 });
  assert.equal(fail.values.pass, 0);
  assert.ok((fail.values.deviationPercent as number) > 5);
  const open = calcElectrical({ kind: "winding_check", phase: 3, r1: 1.0, r2: 1.0, r3: Number.POSITIVE_INFINITY });
  assert.ok(open.warnings.length === 1, "infinite ohms rejected as non-finite input");
  const openBig = calcElectrical({ kind: "winding_check", phase: 3, r1: 1.0, r2: 1.0, r3: 5e6 });
  assert.equal(openBig.values.openCount, 1);
  assert.equal(openBig.values.pass, 0);
  const shorted = calcElectrical({ kind: "winding_check", phase: 3, r1: 1.0, r2: 0.01, r3: 1.0 });
  assert.equal(shorted.values.shortCount, 1);
  assert.equal(shorted.values.pass, 0);
  assert.ok(pass.interpretation.some((s) => /Never megger under vacuum/.test(s)));
});

test("megohm bands: >100 good, 20–100 investigate, <20 suspect, <1 condemn", () => {
  const good = calcElectrical({ kind: "megohm", megohms: 500, testVolts: 500 });
  assert.equal(good.values.band, 0);
  assert.equal(good.values.condemn, 0);
  assert.ok(good.interpretation.some((s) => /good/.test(s)));
  const investigate = calcElectrical({ kind: "megohm", megohms: 50 });
  assert.equal(investigate.values.band, 1);
  assert.ok(investigate.interpretation.some((s) => /investigate/.test(s)));
  const suspect = calcElectrical({ kind: "megohm", megohms: 5 });
  assert.equal(suspect.values.band, 2);
  assert.ok(suspect.interpretation.some((s) => /suspect/.test(s)));
  const condemn = calcElectrical({ kind: "megohm", megohms: 0.4 });
  assert.equal(condemn.values.band, 3);
  assert.equal(condemn.values.condemn, 1);
  assert.ok(condemn.interpretation.some((s) => /condemn/.test(s)));
  assert.ok(good.interpretation.some((s) => /Never megger a compressor under vacuum/.test(s) && /VFD/.test(s)));
  const highV = calcElectrical({ kind: "megohm", megohms: 200, testVolts: 1000 });
  assert.ok(highV.warnings.some((w) => /500 VDC/.test(w)));
  const bad = calcElectrical({ kind: "megohm", megohms: -1 });
  assert.ok(bad.warnings.length === 1 && bad.values.band === undefined);
});

test("calcElectrical never throws on garbage", () => {
  const unknown = calcElectrical({ kind: "nope" } as unknown as ElectricalCalcRequest);
  assert.ok(unknown.warnings.some((w) => /Unknown calculator kind/.test(w)));
  const nothing = calcElectrical(null as unknown as ElectricalCalcRequest);
  assert.ok(nothing.warnings.length === 1);
  const kinds: ElectricalCalcRequest["kind"][] = [
    "voltage_imbalance", "current_imbalance", "capacitor_under_load", "amps_vs_rla", "temp_rise_cfm",
    "ohms_law", "electric_heat_kw", "psychrometrics", "winding_check", "megohm",
  ];
  for (const kind of kinds) {
    const r = calcElectrical({ kind } as unknown as ElectricalCalcRequest);
    assert.equal(r.kind, kind);
    assert.ok(Array.isArray(r.warnings) && Array.isArray(r.interpretation));
  }
});

// ---------------------------------------------------------------------------
// Knowledge packs
// ---------------------------------------------------------------------------

test("components.json loads with ≥ 22 components, each with tests + safety; required components present", () => {
  assert.equal(kb.electrical.version, "1");
  const comps = kb.electrical.components;
  assert.ok(comps.length >= 22, `components ${comps.length}`);
  const ids = new Set<string>();
  for (const c of comps) {
    assert.ok(c.id && c.name && c.function, `component ${c.id} missing id/name/function`);
    assert.ok(!ids.has(c.id), `duplicate component id ${c.id}`);
    ids.add(c.id);
    assert.ok(c.tests.length >= 1, `${c.id} has no tests`);
    for (const t of c.tests) {
      assert.ok(t.name && t.steps.length >= 1 && t.expected, `${c.id} test ${t.name} incomplete`);
      assert.equal(typeof t.energized, "boolean");
    }
    assert.ok(c.safety.length >= 1, `${c.id} has no safety line`);
    assert.ok(c.failureModes.length >= 1, `${c.id} has no failure modes`);
  }
  for (const required of [
    "run_capacitor", "start_capacitor", "contactor", "control_relay", "control_transformer", "single_phase_compressor",
    "three_phase_compressor", "scroll_internal_protection", "condenser_fan_motor", "belt_drive_blower", "ecm_blower_motor",
    "vfd", "crankcase_heater", "phase_monitor", "high_pressure_switch", "low_pressure_switch", "freeze_stat",
    "limit_rollout_switch", "defrost_board", "economizer_controller", "thermostat_24v_circuit", "fuses_breakers_disconnect",
    "low_ambient_head_pressure_control", "solenoid_valves", "anti_short_cycle_timer", "current_sensor", "refrigerant_detection_system",
  ]) {
    assert.ok(ids.has(required), `missing component ${required}`);
  }
  const rds = comps.find((c) => c.id === "refrigerant_detection_system")!;
  assert.ok(rds.function.includes("blower") && /lock/i.test(rds.function), "RDS mitigation described");
  assert.ok(rds.safety.some((s) => /never bypass/i.test(s)));
  const vfd = comps.find((c) => c.id === "vfd")!;
  assert.ok(vfd.tests.some((t) => /DC-bus/i.test(t.name) && t.steps.some((s) => /< 50 VDC/.test(s))));
  assert.ok(vfd.safety.some((s) => /never megger/i.test(s)));
  const ecm = comps.find((c) => c.id === "ecm_blower_motor")!;
  assert.ok(ecm.tests.some((t) => /high-voltage first/i.test(t.name)));
  const cap = comps.find((c) => c.id === "run_capacitor")!;
  assert.ok(cap.tests.some((t) => t.steps.some((s) => /2652/.test(s))));
});

test("reference topics carry the pinned tolerances and their sources", () => {
  const refs = kb.electrical.reference;
  assert.ok(refs.length >= 10, `reference ${refs.length}`);
  for (const r of refs) {
    assert.ok(r.topic && r.content.length >= 3, `reference ${r.topic} thin`);
    assert.ok(r.content.some((line) => /^Source:/.test(line)), `reference ${r.topic} lacks a source line`);
  }
  const vi = refs.find((r) => /voltage imbalance/i.test(r.topic))!;
  assert.ok(vi.content.some((l) => /NEMA MG-1/.test(l) && /0\.95 at 2 %/.test(l) && /0\.75 at 5 %/.test(l)));
  const meg = refs.find((r) => /megohm/i.test(r.topic))!;
  assert.ok(meg.content.some((l) => /Copeland/.test(l)));
  assert.ok(meg.content.some((l) => /Never megger in a vacuum/.test(l) && /VFD/.test(l)));
  const safety = refs.find((r) => /safety/i.test(r.topic))!;
  assert.ok(safety.content.some((l) => /NFPA 70E/.test(l)));
  assert.ok(safety.content.some((l) => /live-dead-live/i.test(l)));
  const chain = refs.find((r) => /24 V control path/i.test(r.topic))!;
  assert.ok(chain.content.some((l) => /HPS/.test(l) && /phase monitor/.test(l) && /contactor coil/.test(l)));
  const plate = refs.find((r) => /nameplate/i.test(r.topic))!;
  assert.ok(plate.content.some((l) => /MCC \/ 1\.56/.test(l)));
});

test("procedures.json loads with ≥ 16 procedures, each ≥ 4 steps + safety + causes; required ids present", () => {
  const procs = kb.electrical.procedures;
  assert.ok(procs.length >= 16, `procedures ${procs.length}`);
  const ids = new Set<string>();
  for (const p of procs) {
    assert.ok(p.id && p.symptom, `procedure ${p.id} missing id/symptom`);
    assert.ok(!ids.has(p.id), `duplicate procedure id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.steps.length >= 4, `${p.id} has ${p.steps.length} steps`);
    for (const s of p.steps) assert.ok(s.step.length > 10, `${p.id} has an empty step`);
    assert.ok(p.safety.length >= 1, `${p.id} has no safety line`);
    assert.ok(p.commonCauses.length >= 3, `${p.id} has too few common causes`);
  }
  for (const required of [
    "unit_dead", "no_cooling_fans_run_compressor_off", "compressor_hums_wont_start_1ph", "compressor_wont_start_3ph",
    "breaker_fuse_trips", "short_cycling", "condenser_fan_dead", "blower_wont_run", "blower_runs_constantly",
    "intermittent_24v_loss_control_fuse_blowing", "hps_trips", "lps_trips_lockout", "no_heat_gas_rtu",
    "economizer_not_modulating", "vfd_fault_motor_wont_ramp", "phase_loss_single_phasing", "ecm_blower_dead",
    "no_call_verify_demand", "24v_safety_chain_trace", "a2l_mitigation_active", "bas_or_thermostat_override",
  ]) {
    assert.ok(ids.has(required), `missing procedure ${required}`);
  }
  const gas = procs.find((p) => p.id === "no_heat_gas_rtu")!;
  assert.ok(gas.safety.some((s) => /NEVER bypass/i.test(s) && /rollout/i.test(s)));
  assert.ok(gas.steps.some((s) => /µA/.test(s.step) && /board-specific/i.test(s.step)));
  assert.ok(gas.safety.some((s) => /CO/.test(s)));
  const chain = procs.find((p) => p.id === "24v_safety_chain_trace")!;
  assert.ok(chain.safety.some((s) => /momentary/i.test(s) && /attended/i.test(s) && /NEVER left/i.test(s)));
  const a2l = procs.find((p) => p.id === "a2l_mitigation_active")!;
  assert.ok(a2l.safety.some((s) => /NEVER bypass/i.test(s)));
  assert.ok(a2l.steps[0]!.step.includes("Read the fault code"));
  const noCall = procs.find((p) => p.id === "no_call_verify_demand")!;
  assert.ok(noCall.steps.some((s) => /Y1, Y2, W1, W2, G/.test(s.step)));
  const vfd = procs.find((p) => p.id === "vfd_fault_motor_wont_ramp")!;
  assert.ok(vfd.safety.some((s) => /< 50 VDC/.test(s)));
});

test("raw JSON files have the documented top-level shape", () => {
  const comp = JSON.parse(readFileSync(join(PROJECT_ROOT, "knowledge", "electrical", "components.json"), "utf8"));
  assert.equal(comp.version, "1");
  assert.ok(Array.isArray(comp.components) && Array.isArray(comp.reference));
  const proc = JSON.parse(readFileSync(join(PROJECT_ROOT, "knowledge", "electrical", "procedures.json"), "utf8"));
  assert.equal(proc.version, "1");
  assert.ok(Array.isArray(proc.procedures));
});

// ---------------------------------------------------------------------------
// Fuzzy lookups
// ---------------------------------------------------------------------------

function firstId(items: (ElectricalComponent | ElectricalProcedure)[]): string | undefined {
  return items[0]?.id;
}

test("findComponent: synonyms, aliases and ranking", () => {
  assert.equal(firstId(findComponent(kb, "cap")), "run_capacitor");
  assert.equal(firstId(findComponent(kb, "run capacitor")), "run_capacitor");
  assert.equal(firstId(findComponent(kb, "contactor coil")), "contactor");
  assert.equal(firstId(findComponent(kb, "A2L")), "refrigerant_detection_system");
  assert.equal(firstId(findComponent(kb, "RDS")), "refrigerant_detection_system");
  assert.equal(firstId(findComponent(kb, "xfmr")), "control_transformer");
  assert.equal(firstId(findComponent(kb, "Transformer")), "control_transformer");
  assert.equal(firstId(findComponent(kb, "comp")), "single_phase_compressor");
  assert.equal(firstId(findComponent(kb, "VFD")), "vfd");
  assert.equal(firstId(findComponent(kb, "drive")), "vfd");
  assert.equal(firstId(findComponent(kb, "ECM")), "ecm_blower_motor");
  assert.equal(firstId(findComponent(kb, "X13")), "ecm_blower_motor");
  assert.equal(firstId(findComponent(kb, "motormaster")), "low_ambient_head_pressure_control");
  assert.equal(firstId(findComponent(kb, "flame sense")), "ignition_control_flame_sensor");
  assert.equal(firstId(findComponent(kb, "HPS")), "high_pressure_switch");
  assert.equal(firstId(findComponent(kb, "OFM")), "condenser_fan_motor");
  assert.equal(firstId(findComponent(kb, "start cap")), "start_capacitor");
  const caps = findComponent(kb, "capacitor");
  assert.ok(caps.length <= 5 && caps.length >= 2);
  assert.ok(caps.slice(0, 2).map((c) => c.id).includes("start_capacitor"));
});

test("findProcedure: symptom phrases", () => {
  assert.equal(firstId(findProcedure(kb, "unit is dead")), "unit_dead");
  assert.equal(firstId(findProcedure(kb, "hums won't start")), "compressor_hums_wont_start_1ph");
  assert.equal(firstId(findProcedure(kb, "compressor humming")), "compressor_hums_wont_start_1ph");
  assert.equal(firstId(findProcedure(kb, "no call")), "no_call_verify_demand");
  assert.equal(firstId(findProcedure(kb, "A2L")), "a2l_mitigation_active");
  assert.equal(firstId(findProcedure(kb, "no cooling")), "no_cooling_fans_run_compressor_off");
  assert.equal(firstId(findProcedure(kb, "breaker trips")), "breaker_fuse_trips");
  assert.equal(firstId(findProcedure(kb, "blower runs constantly")), "blower_runs_constantly");
  assert.equal(firstId(findProcedure(kb, "BAS override")), "bas_or_thermostat_override");
  assert.equal(firstId(findProcedure(kb, "phase loss")), "phase_loss_single_phasing");
  assert.equal(firstId(findProcedure(kb, "no heat")), "no_heat_gas_rtu");
  assert.equal(firstId(findProcedure(kb, "HPS trips")), "hps_trips");
  assert.equal(firstId(findProcedure(kb, "economizer stuck open")), "economizer_not_modulating");
  assert.equal(firstId(findProcedure(kb, "VFD fault")), "vfd_fault_motor_wont_ramp");
  assert.equal(firstId(findProcedure(kb, "3 phase compressor won't start")), "compressor_wont_start_3ph");
  assert.equal(firstId(findProcedure(kb, "running backwards")), "reversed_rotation_after_power_work");
  assert.equal(firstId(findProcedure(kb, "control fuse keeps blowing")), "intermittent_24v_loss_control_fuse_blowing");
  assert.ok(findProcedure(kb, "trips").length <= 5);
});

test("findReference: topics", () => {
  assert.match(findReference(kb, "voltage imbalance")[0]!.topic, /Voltage imbalance/);
  assert.match(findReference(kb, "nameplate")[0]!.topic, /nameplate/i);
  assert.match(findReference(kb, "rotation")[0]!.topic, /Rotation/);
  assert.match(findReference(kb, "LOTO")[0]!.topic, /safety/i);
  assert.match(findReference(kb, "megger")[0]!.topic, /Megohm/);
  assert.match(findReference(kb, "wire colors")[0]!.topic, /Wire-color/);
  assert.match(findReference(kb, "ladder diagram")[0]!.topic, /ladder/i);
  assert.match(findReference(kb, "24v chain")[0]!.topic, /24 V control path/);
  assert.ok(findReference(kb, "voltage").length <= 5);
});

test("lookups are case-insensitive, cap at 5 and return [] for empty/nonsense/bad input", () => {
  assert.deepEqual(findComponent(kb, "RUN CAPACITOR").map((c) => c.id), findComponent(kb, "run capacitor").map((c) => c.id));
  assert.ok(findComponent(kb, "switch").length <= 5);
  assert.deepEqual(findComponent(kb, ""), []);
  assert.deepEqual(findProcedure(kb, "   "), []);
  assert.deepEqual(findReference(kb, "zzzz qqqq"), []);
  assert.deepEqual(findComponent(kb, undefined as unknown as string), []);
  assert.deepEqual(findProcedure({ electrical: undefined } as unknown as typeof kb, "dead"), []);
  const all = lookupElectrical(kb, "A2L");
  assert.equal(all.components[0]!.id, "refrigerant_detection_system");
  assert.equal(all.procedures[0]!.id, "a2l_mitigation_active");
  assert.ok(all.reference.some((r) => /safety/i.test(r.topic)));
  const only = lookupElectrical(kb, "cap", "component");
  assert.equal(only.procedures.length, 0);
  assert.equal(only.reference.length, 0);
  assert.equal(only.components[0]!.id, "run_capacitor");
});

test("tokenize applies synonyms, stemming and stopwords", () => {
  assert.deepEqual(tokenize("hums won't start"), ["hum", "wont", "start"]);
  assert.deepEqual(tokenize("The cap is dead"), ["capacitor", "dead"]);
  assert.deepEqual(tokenize("xfmr"), ["transformer"]);
  assert.deepEqual(tokenize("Trips breakers"), ["trip", "breaker"]);
  assert.deepEqual(tokenize("A2L"), ["a2l", "rds", "refrigerant", "detection"]);
});

test("lookups never throw on entries missing arrays or with wrong types (non-strict loads)", () => {
  const withComps = (components: unknown) => ({ ...kb, electrical: { ...kb.electrical, components: components as ElectricalComponent[] } });
  const bad = withComps([{ id: "x", name: "x thing", function: "f" }, null, { id: 5, name: ["n"], aliases: "a", tests: "t", failureModes: 1 }, { id: "y", name: "y thing", function: "g", tests: [null, { name: 3 }], failureModes: ["ok"], safety: [] }]);
  assert.equal(findComponent(bad, "x thing")[0]?.id, "x");
  assert.equal(findComponent(bad, "y thing")[0]?.id, "y");
  assert.ok(findComponent(bad, "thing").every((c) => c.id === "x" || c.id === "y")); // null / malformed entries are dropped
  assert.deepEqual(findComponent(bad, "zzz"), []);
  const badProcs = { ...kb, electrical: { ...kb.electrical, procedures: [{ id: "y", symptom: "unit dead" }, null, { id: "z", symptom: "no cooling", steps: [null, { step: 1 }], commonCauses: "x", aliases: 4 }] as unknown as ElectricalProcedure[] } };
  assert.equal(findProcedure(badProcs, "unit dead")[0]?.id, "y");
  assert.equal(findProcedure(badProcs, "no cooling")[0]?.id, "z");
  const badRefs = { ...kb, electrical: { ...kb.electrical, reference: [{ topic: "z" }, null, { topic: 1, content: ["x"] }, { topic: "q", content: "not an array" }] as unknown as typeof kb.electrical.reference } };
  assert.equal(findReference(badRefs, "z")[0]?.topic, "z");
  assert.equal(findReference(badRefs, "q")[0]?.topic, "q");
  const all = lookupElectrical({ ...bad, electrical: { ...bad.electrical, procedures: badProcs.electrical.procedures, reference: badRefs.electrical.reference } }, "x thing");
  assert.equal(all.components[0]?.id, "x");
});
