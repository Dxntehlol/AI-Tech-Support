import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadKnowledge } from "./loader.ts";
import { PROJECT_ROOT } from "../config.ts";
import { deriveMetrics, diagnose, modeDefaults, targetDeltaTFromTable, targetSuperheatFixedOrifice, wetBulbFromRh } from "./diagnostics.ts";
import type { DxMeasurements, DxResult } from "../types.ts";

const kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });

const ids = (r: DxResult) => r.findings.map((f) => f.ruleId);
const severities = (r: DxResult, level: "warning" | "critical") => r.findings.filter((f) => f.severity === level);

const base: DxMeasurements = { refrigerant: "R-410A", meteringDevice: "txv", mode: "ac_cooling", outdoorDbF: 95, indoorDbF: 75, indoorWbF: 63 };

test("rule set loads with the required defaults and at least 35 rules", () => {
  const rs = kb.diagnostics.rules;
  assert.ok(rs.rules.length >= 35, `rules: ${rs.rules.length}`);
  assert.equal(rs.defaults.targetSubcoolingTxvF, 10);
  assert.deepEqual(rs.defaults.condenserSplitNormalF, { min: 15, max: 30 });
  assert.deepEqual(rs.defaults.evapTdNormalF, { min: 30, max: 40 });
  assert.deepEqual(rs.defaults.deltaTNormalF, { min: 16, max: 22 });
  assert.equal(rs.defaults.dischargeTempWarnF, 225);
  assert.equal(rs.defaults.dischargeTempCriticalF, 250);
  assert.equal(rs.defaults.compressionRatioAdvisory, 3.5);
  assert.equal(rs.defaults.compressionRatioWarn, 4.5);
  assert.equal(rs.defaults.lowAmbientMinOutdoorDbF, 65);
  assert.equal(rs.defaults.byMode?.refrigeration?.compressionRatioAdvisory, 8);
  assert.equal(rs.defaults.byMode?.refrigeration?.compressionRatioWarn, 12);
  assert.deepEqual(rs.defaults.byMode?.refrigeration?.evapTdNormalF, { min: 8, max: 12 });
  assert.deepEqual(rs.defaults.byMode?.refrigeration?.condenserSplitNormalF, { min: 20, max: 30 });
  assert.ok(rs.defaults.byMode?.heat_pump_heating);
  const merged = modeDefaults(rs, "refrigeration");
  assert.equal(merged.compressionRatioAdvisory, 8);
  assert.equal(merged.targetSubcoolingTxvF, 10); // inherited
  const required = [
    "undercharge_txv", "undercharge_fixed", "overcharge_txv", "overcharge_fixed", "liquid_line_restriction", "low_evap_airflow_fixed",
    "low_evap_airflow_txv", "high_load_or_airflow", "low_condenser_airflow_dirty_coil", "non_condensables", "non_condensables_standing",
    "txv_overfeeding", "txv_starving", "inefficient_compressor", "wrong_refrigerant", "min_superheat_floodback", "low_discharge_superheat",
    "high_discharge_superheat", "discharge_temp_warn", "discharge_temp_critical", "compression_ratio_advisory", "compression_ratio_warn",
    "compression_ratio_advisory_refrigeration", "compression_ratio_warn_refrigeration", "amps_over_rla", "amps_low", "current_imbalance",
    "sight_glass_bubbles_restriction", "sight_glass_bubbles_undercharge", "sight_glass_flashing", "drier_restriction", "low_ambient_head_control",
    "low_ambient_head_control_failed", "flooding_valve_suppress", "hot_gas_bypass", "readings_part_load", "readings_not_stable", "economizer_open",
    "hp_ports_swapped", "hp_charge_by_chart", "reversing_valve_leak", "defrost_active", "metering_fixed_guidance", "metering_txv_guidance",
    "metering_eev_guidance", "refrigeration_targets", "vrf_chiller_scope", "missing_suction_line_temp", "missing_liquid_line_temp",
  ];
  const have = new Set(rs.rules.map((r) => r.id));
  for (const id of required) assert.ok(have.has(id), `missing rule ${id}`);
  // every rule is well-formed: when[] numeric ops carry value(s), nextChecks present, explanation cites a source
  for (const r of rs.rules) {
    assert.ok(r.when.length > 0, r.id);
    for (const c of r.when) {
      if (c.op === "between") assert.ok(typeof c.value === "number" && typeof c.value2 === "number", `${r.id} between`);
      else if (c.op !== "present" && c.op !== "absent") assert.equal(typeof c.value, "number", `${r.id} ${c.metric} ${c.op}`);
    }
    assert.ok(r.nextChecks.length > 0, `${r.id} nextChecks`);
    assert.ok(/Follows /.test(r.explanation), `${r.id} explanation should end with the chart/bulletin it follows`);
  }
});

test("charging targets pack has the standard chart shape", () => {
  const c = kb.diagnostics.charging;
  assert.deepEqual(c.fixedOrificeSuperheat.indoorWbF, [50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76]);
  assert.deepEqual(c.fixedOrificeSuperheat.outdoorDbF, [55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115]);
  assert.equal(c.fixedOrificeSuperheat.targetF.length, 14);
  for (const row of c.fixedOrificeSuperheat.targetF) {
    assert.equal(row.length, 13);
    for (const v of row) if (v !== null) assert.ok(v >= 5 && v <= 45, `value ${v}`); // published chart tops out at 45 F (WB 76 / DB 55)
  }
  assert.equal(c.fixedOrificeSuperheat.targetF[0]![12], null); // 50 WB / 115 DB: not recommended
  assert.ok(c.targetDeltaT);
  assert.ok(c.heatPumpHeating!.notes.length >= 3);
  assert.ok(c.notes.some((n) => /precedence/i.test(n)));
});

test("fixed-orifice chart: grid points, midpoints, clamping and nulls", () => {
  const chart = kb.diagnostics.charging.fixedOrificeSuperheat;
  const cell = (wb: number, db: number) => chart.targetF[chart.indoorWbF.indexOf(wb)]![chart.outdoorDbF.indexOf(db)];
  // published values (Carrier 38CKC Table 4 / Goodman / Trane fixed-orifice chart), not self-referencing cells
  assert.equal(targetSuperheatFixedOrifice(kb, 64, 85), 14);
  assert.equal(targetSuperheatFixedOrifice(kb, 70, 95), 18); // published WB 70 row (formula gives 17.5)
  assert.equal(targetSuperheatFixedOrifice(kb, 76, 55), 45);
  assert.equal(targetSuperheatFixedOrifice(kb, 62, 95), 6);
  assert.ok(Math.abs(targetSuperheatFixedOrifice(kb, 63, 95)! - 7.5) < 0.11);
  // midpoint between four cells = average of the four
  const mid = (cell(64, 85)! + cell(64, 90)! + cell(66, 85)! + cell(66, 90)!) / 4;
  assert.ok(Math.abs(targetSuperheatFixedOrifice(kb, 65, 87.5)! - mid) < 0.11);
  // midpoint along one axis
  const half = (cell(64, 85)! + cell(64, 90)!) / 2;
  assert.ok(Math.abs(targetSuperheatFixedOrifice(kb, 64, 87.5)! - half) < 0.11);
  assert.equal(targetSuperheatFixedOrifice(kb, 50, 115), undefined); // null cell
  assert.equal(targetSuperheatFixedOrifice(kb, 64, 54), undefined); // below 55 outdoor
  assert.equal(targetSuperheatFixedOrifice(kb, 77, 85), cell(76, 85)); // within one step: clamp
  assert.equal(targetSuperheatFixedOrifice(kb, 80, 85), undefined); // beyond one step
  assert.equal(targetSuperheatFixedOrifice(kb, 76, 118), cell(76, 115)); // within one column step: clamp
  assert.equal(targetSuperheatFixedOrifice(kb, 76, 125), undefined);
  assert.equal(targetSuperheatFixedOrifice(kb, 64, 118), undefined); // clamps onto a null cell
  assert.equal(targetSuperheatFixedOrifice(kb, Number.NaN, 85), undefined);
});

test("fixed-orifice chart: a null neighbour falls back to the nearest cell instead of blanking the whole box", () => {
  // WB 58 / DB 90 is null; WB 60 / DB 90 = 5, WB 58 / DB 85 = 5, WB 60 / DB 85 = 8
  assert.equal(targetSuperheatFixedOrifice(kb, 59, 88), 5); // nearest cell (60, 90)
  assert.equal(targetSuperheatFixedOrifice(kb, 58.5, 86), 5); // nearest cell (58, 85)
  assert.equal(targetSuperheatFixedOrifice(kb, 59.5, 88), 5); // nearest cell (60, 90)
  assert.equal(targetSuperheatFixedOrifice(kb, 58, 89), undefined); // nearest cell (58, 90) is itself null
  assert.equal(targetSuperheatFixedOrifice(kb, 63, 92), 9.3); // fully populated box still interpolates
});

test("delta-T table follows the Carrier / Proctor CheckMe reference points with a +/-3 F band", () => {
  const a = targetDeltaTFromTable(kb, 75, 63)!; // point ~18.4
  const b = targetDeltaTFromTable(kb, 75, 58)!; // point ~21.4
  const c = targetDeltaTFromTable(kb, 75, 68)!; // point ~14.5
  const mid = (r: { min: number; max: number }) => (r.min + r.max) / 2;
  assert.ok(a.min <= 18 && a.max >= 19, `75/63 ${JSON.stringify(a)}`);
  assert.ok(b.min <= 21 && b.max >= 22, `75/58 ${JSON.stringify(b)}`);
  assert.ok(c.min <= 14 && c.max >= 15, `75/68 ${JSON.stringify(c)}`);
  assert.ok(Math.abs(mid(a) - 18.4) <= 0.6 && Math.abs(mid(b) - 21.4) <= 0.6 && Math.abs(mid(c) - 14.5) <= 0.6);
  assert.equal(a.max - a.min, 6, "field tolerance is +/-3 F (Carrier / CheckMe)");
  assert.ok(b.min > a.min && a.min > c.min, "humid air → smaller delta-T");
  assert.equal(targetDeltaTFromTable(kb, 75, 76), undefined); // WB above DB: null
});

test("wet bulb from RH approximation is sane", () => {
  const wb = wetBulbFromRh(75, 50)!;
  assert.ok(wb > 61 && wb < 64, `75F/50% → ${wb}`);
  assert.ok(wetBulbFromRh(75, 99)! > 74);
});

test("R-410A TXV undercharge ranks first", () => {
  const r = diagnose(kb, { ...base, suctionPsig: 118, suctionLineTempF: 55, liquidPsig: 340, liquidLineTempF: 100 });
  assert.equal(r.findings[0]!.ruleId, "undercharge_txv");
  assert.equal(r.findings[0]!.severity, "warning");
  assert.ok(r.derived.superheatF! > 14 && r.derived.subcoolingF! < 6);
  assert.equal(r.validity.ok, true);
  assert.ok(/undercharge/i.test(r.summary));
  assert.ok(r.findings[0]!.safety!.some((s) => /leak check/i.test(s)));
});

test("overcharge (high SC, normal SH)", () => {
  const r = diagnose(kb, { ...base, suctionPsig: 130, suctionLineTempF: 52, liquidPsig: 420, liquidLineTempF: 98 });
  assert.equal(r.findings[0]!.ruleId, "overcharge_txv");
  assert.ok(!ids(r).includes("undercharge_txv"));
});

test("restriction (high SH + high SC + low suction)", () => {
  const r = diagnose(kb, { ...base, outdoorDbF: 90, suctionPsig: 100, suctionLineTempF: 60, liquidPsig: 360, liquidLineTempF: 85 });
  assert.equal(r.findings[0]!.ruleId, "liquid_line_restriction");
  assert.ok(!ids(r).includes("undercharge_txv"));
  assert.ok(!ids(r).includes("overcharge_txv"));
});

test("drier temperature drop > 3 F flags the drier", () => {
  const r = diagnose(kb, { ...base, drierInletTempF: 100, drierOutletTempF: 94 });
  assert.equal(r.derived.drierTempDropF, 6);
  assert.ok(ids(r).includes("drier_restriction"));
});

test("fixed orifice: low airflow vs undercharge are distinguished by the chart", () => {
  const fixed: DxMeasurements = { ...base, meteringDevice: "fixed", outdoorDbF: 85, indoorWbF: 64 };
  const lowAir = diagnose(kb, { ...fixed, suctionPsig: 105, suctionLineTempF: 40.6, liquidPsig: 340, liquidLineTempF: 92 });
  assert.equal(lowAir.derived.targetSuperheatF, targetSuperheatFixedOrifice(kb, 64, 85));
  assert.equal(lowAir.findings[0]!.ruleId, "low_evap_airflow_fixed");
  assert.ok(!ids(lowAir).includes("undercharge_fixed"));
  const under = diagnose(kb, { ...fixed, suctionPsig: 105, suctionLineTempF: 59.6, liquidPsig: 340, liquidLineTempF: 99 });
  assert.equal(under.findings[0]!.ruleId, "undercharge_fixed");
  assert.ok(!ids(under).includes("low_evap_airflow_fixed"));
  // TXV rules never fire on a fixed-orifice system and vice versa
  assert.ok(!ids(under).includes("undercharge_txv"));
});

test("fixed orifice with WB from return RH gets a chart target", () => {
  const r = deriveMetrics(kb, { ...base, meteringDevice: "fixed", indoorWbF: undefined, returnRhPercent: 50, outdoorDbF: 85 });
  assert.ok(r.targetSuperheatF !== undefined);
});

test("dirty condenser: split ~40 F", () => {
  const r = diagnose(kb, { ...base, suctionPsig: 120, suctionLineTempF: 52.7, liquidPsig: 520, liquidLineTempF: 124 });
  assert.ok(r.derived.condenserSplitF! > 38 && r.derived.condenserSplitF! < 43, `split ${r.derived.condenserSplitF}`);
  assert.equal(r.findings[0]!.ruleId, "low_condenser_airflow_dirty_coil");
  assert.ok(ids(r).includes("compression_ratio_advisory"));
});

test("inefficient compressor: CR < 2 and amps 45 % RLA", () => {
  const r = diagnose(kb, { ...base, outdoorDbF: 80, suctionPsig: 160, suctionLineTempF: 70, liquidPsig: 280, liquidLineTempF: 80, compressorAmps: 18, compressorRla: 40 });
  assert.ok(r.derived.compressionRatio! < 2);
  assert.equal(r.derived.ampsPercentRla, 45);
  assert.equal(r.findings[0]!.ruleId, "inefficient_compressor");
  assert.ok(ids(r).includes("amps_low"));
});

test("normal system produces no warning-level finding", () => {
  const r = diagnose(kb, {
    ...base, outdoorDbF: 91.4, suctionPsig: 118, suctionLineTempF: 50, liquidPsig: 380, liquidLineTempF: 101.5, supplyDbF: 57,
    compressorAmps: 16, compressorRla: 20, runtimeMinutes: 20,
  });
  assert.ok(Math.abs(r.derived.superheatF! - 10) < 1);
  assert.ok(Math.abs(r.derived.subcoolingF! - 10) < 2);
  assert.ok(Math.abs(r.derived.condenserSplitF! - 20) < 2.5);
  assert.equal(r.derived.deltaTF, 18);
  assert.ok(Math.abs(r.derived.compressionRatio! - 2.9) < 0.15);
  assert.equal(r.derived.ampsPercentRla, 80);
  assert.equal(severities(r, "warning").length, 0);
  assert.equal(severities(r, "critical").length, 0);
  assert.equal(r.validity.ok, true);
  const n = r.summary.split(/(?<=\.)\s+/).length;
  assert.ok(n >= 2 && n <= 4, `summary sentences ${n}: ${r.summary}`);
});

test("critical: superheat under 5 F (floodback) outranks everything", () => {
  const r = diagnose(kb, { ...base, suctionPsig: 130, suctionLineTempF: 46, liquidPsig: 380, liquidLineTempF: 102 });
  assert.equal(r.findings[0]!.ruleId, "min_superheat_floodback");
  assert.equal(r.findings[0]!.severity, "critical");
});

test("discharge temperature warn / critical thresholds", () => {
  const warn = diagnose(kb, { ...base, dischargeLineTempF: 230 });
  assert.ok(ids(warn).includes("discharge_temp_warn"));
  assert.ok(!ids(warn).includes("discharge_temp_critical"));
  const crit = diagnose(kb, { ...base, dischargeLineTempF: 255 });
  assert.equal(crit.findings[0]!.ruleId, "discharge_temp_critical");
  assert.equal(crit.findings[0]!.severity, "critical");
});

test("validity: outdoor 50 F cooling without head control downgrades undercharge to info", () => {
  const r = diagnose(kb, { ...base, outdoorDbF: 50, suctionPsig: 118, suctionLineTempF: 55, liquidPsig: 340, liquidLineTempF: 100 });
  assert.equal(r.validity.ok, false);
  const under = r.findings.find((f) => f.ruleId === "undercharge_txv")!;
  assert.equal(under.severity, "info");
  assert.ok(under.condition.startsWith("readings not valid for charge determination"));
  assert.ok(under.explanation.startsWith("readings not valid for charge determination"));
  assert.equal(r.findings[0]!.ruleId, "low_ambient_head_control");
  assert.ok(!ids(r).includes("low_condenser_airflow_dirty_coil"), "split rule must not fire at low ambient");
  assert.ok(r.missing.some((s) => /head-pressure control/i.test(s)));
  assert.ok(/Not valid for charge determination/.test(r.summary));
});

test("validity: confirmed head-pressure control makes low-ambient readings usable", () => {
  const r = diagnose(kb, { ...base, outdoorDbF: 50, headPressureControl: "fan_cycling", suctionPsig: 118, suctionLineTempF: 55, liquidPsig: 340, liquidLineTempF: 100 });
  assert.equal(r.validity.ok, true);
  assert.equal(r.findings[0]!.ruleId, "undercharge_txv");
  assert.ok(!ids(r).includes("low_ambient_head_control"));
});

test("low ambient: head control failed (condSat < 85, high SH) is a head-pressure finding, not undercharge", () => {
  const r = diagnose(kb, { ...base, outdoorDbF: 45, headPressureControl: "fan_cycling", suctionPsig: 100, suctionLineTempF: 60, liquidPsig: 240, liquidLineTempF: 78 });
  assert.ok(r.derived.condSatF! < 85);
  assert.ok(ids(r).includes("low_ambient_head_control_failed"));
});

test("flooding valve suppresses overcharge from subcooling alone", () => {
  const withValve = diagnose(kb, { ...base, headPressureControl: "flooding_valve", suctionPsig: 130, suctionLineTempF: 52, liquidPsig: 420, liquidLineTempF: 98 });
  assert.ok(!ids(withValve).includes("overcharge_txv"));
  assert.ok(ids(withValve).includes("flooding_valve_suppress"));
});

test("economizer open → validity issue and economizer_open finding", () => {
  const r = diagnose(kb, { ...base, economizerPosition: "open", suctionPsig: 118, suctionLineTempF: 55, liquidPsig: 340, liquidLineTempF: 100 });
  assert.equal(r.validity.ok, false);
  assert.ok(r.validity.issues.some((i) => /economizer/i.test(i)));
  assert.ok(ids(r).includes("economizer_open"));
  assert.equal(r.findings.find((f) => f.ruleId === "undercharge_txv")!.severity, "info");
});

test("mixed-air temperatures take precedence over indoor temperatures", () => {
  const d = deriveMetrics(kb, { ...base, mixedAirDbF: 85, mixedAirWbF: 70, suctionPsig: 118, supplyDbF: 60 });
  assert.equal(d.evapTdF, 85 - d.evapSatF!);
  assert.equal(d.deltaTF, 25);
});

test("part load and short run time are validity issues with info findings", () => {
  const r = diagnose(kb, { ...base, capacityPercent: 50, runtimeMinutes: 4, suctionPsig: 118, suctionLineTempF: 55, liquidPsig: 340, liquidLineTempF: 100 });
  assert.equal(r.validity.ok, false);
  assert.ok(ids(r).includes("readings_part_load"));
  assert.ok(ids(r).includes("readings_not_stable"));
  assert.equal(r.findings.find((f) => f.ruleId === "undercharge_txv")!.severity, "info");
});

test("hot gas bypass suppresses the low-amps finding", () => {
  const r = diagnose(kb, { ...base, hotGasBypass: true, compressorAmps: 8, compressorRla: 20, suctionPsig: 118, suctionLineTempF: 55, liquidPsig: 380, liquidLineTempF: 101 });
  assert.ok(!ids(r).includes("amps_low"));
  assert.ok(ids(r).includes("hot_gas_bypass"));
});

const heatingBase: DxMeasurements = {
  refrigerant: "R-410A", meteringDevice: "txv", mode: "heat_pump_heating", outdoorDbF: 35, indoorDbF: 70,
  suctionPsig: 60, suctionLineTempF: 20, liquidPsig: 320, liquidLineTempF: 90,
};

test("heating mode: cooling chart rules do not fire, hp_charge_by_chart fires, coil TDs computed from the compressor suction port", () => {
  const r = diagnose(kb, { ...heatingBase, suctionMeasuredAt: "compressor_suction" });
  assert.equal(r.derived.condenserSplitF, undefined);
  assert.ok(Math.abs(r.derived.indoorCoilTdF! - (r.derived.condSatF! - 70)) < 0.01);
  assert.ok(Math.abs(r.derived.evapTdF! - (35 - r.derived.evapSatF!)) < 0.01);
  assert.equal(r.derived.targetSubcoolingF, undefined);
  assert.ok(ids(r).includes("hp_charge_by_chart"));
  assert.ok(!ids(r).includes("hp_ports_swapped"));
  for (const id of ["undercharge_txv", "overcharge_txv", "liquid_line_restriction", "low_condenser_airflow_dirty_coil", "metering_txv_guidance"]) {
    assert.ok(!ids(r).includes(id), `${id} must not fire in heating`);
  }
  assert.equal(r.validity.ok, false);
  assert.ok(r.validity.issues[0]!.includes("heating"));
});

test("heating: suction read at the vapor service valve is warned and suction-side metrics are withheld", () => {
  const r = diagnose(kb, { ...heatingBase, suctionMeasuredAt: "vapor_service_valve" });
  assert.equal(r.findings[0]!.ruleId, "hp_ports_swapped");
  assert.equal(r.findings[0]!.severity, "warning");
  for (const k of ["evapSatF", "superheatF", "evapTdF", "compressionRatio"] as const) assert.equal(r.derived[k], undefined, k);
  assert.ok(r.derived.condSatF !== undefined && r.derived.subcoolingF !== undefined && r.derived.indoorCoilTdF !== undefined);
  assert.deepEqual(ids(r), ["hp_ports_swapped", "hp_charge_by_chart"]);
});

test("heating mode without outdoor DB lists it first in missing[]", () => {
  const r = diagnose(kb, { refrigerant: "R-410A", meteringDevice: "txv", mode: "heat_pump_heating", suctionPsig: 60, suctionLineTempF: 20, liquidPsig: 320 });
  assert.ok(/outdoor dry bulb/i.test(r.missing[0]!));
});

test("heating: reversing valve leak-by (low discharge SH + high suction) and temperature rise", () => {
  const r = diagnose(kb, {
    refrigerant: "R-410A", meteringDevice: "txv", mode: "heat_pump_heating", outdoorDbF: 40, indoorDbF: 70, supplyDbF: 92,
    suctionPsig: 110, suctionLineTempF: 45, liquidPsig: 260, liquidLineTempF: 80, dischargeLineTempF: 105, suctionMeasuredAt: "compressor_suction",
  });
  assert.equal(r.derived.deltaTF, 22);
  assert.ok(r.derived.dischargeSuperheatF! < 30);
  assert.ok(ids(r).includes("reversing_valve_leak"));
});

test("defrost active invalidates readings", () => {
  const r = diagnose(kb, { ...base, mode: "heat_pump_cooling", defrostActive: true, suctionPsig: 118, liquidPsig: 380 });
  assert.equal(r.validity.ok, false);
  assert.ok(ids(r).includes("defrost_active"));
});

test("suction >= liquid → swapped finding, no charge rules, validity not ok", () => {
  const r = diagnose(kb, { ...base, suctionPsig: 300, suctionLineTempF: 55, liquidPsig: 200, liquidLineTempF: 100 });
  assert.equal(r.findings[0]!.ruleId, "readings_swapped_or_off");
  assert.equal(r.derived.superheatF, undefined);
  assert.equal(r.derived.compressionRatio, undefined);
  assert.equal(r.validity.ok, false);
  for (const id of ["undercharge_txv", "overcharge_txv", "liquid_line_restriction", "min_superheat_floodback", "inefficient_compressor"]) {
    assert.ok(!ids(r).includes(id), id);
  }
});

test("implausible saturation temps → wrong_refrigerant sanity finding", () => {
  // R-22 pressures fed as R-410A: 70 psig suction reads as 14 F evap sat, 200 psig liquid reads as ~70 F cond sat below 95 F outdoor
  const r = diagnose(kb, { ...base, suctionPsig: 70, suctionLineTempF: 50, liquidPsig: 200, liquidLineTempF: 95 });
  assert.ok(ids(r).includes("wrong_refrigerant"));
  assert.equal(ids(r).filter((i) => i === "wrong_refrigerant").length, 1, "deduped by ruleId");
  const f = r.findings.find((x) => x.ruleId === "wrong_refrigerant")!;
  assert.ok(/condensing sat .* below outdoor air/.test(f.explanation));
});

test("elevation 5000 ft shifts evapSat by a plausible amount", () => {
  const sea = deriveMetrics(kb, { ...base, suctionPsig: 118, suctionLineTempF: 55, liquidPsig: 340 });
  const high = deriveMetrics(kb, { ...base, suctionPsig: 118, suctionLineTempF: 55, liquidPsig: 340, elevationFt: 5000 });
  assert.ok(Math.abs(high.patmPsia! - 12.23) < 0.05, `patm ${high.patmPsia}`);
  const shift = high.evapSatF! - sea.evapSatF!;
  assert.ok(shift > 0.5 && shift < 2, `evapSat shift ${shift}`);
  assert.ok(high.superheatF! < sea.superheatF!);
  assert.ok(high.compressionRatio! > sea.compressionRatio!);
});

test("missing[] names the suction line temperature when it is absent", () => {
  const r = diagnose(kb, { ...base, suctionPsig: 118, liquidPsig: 340, liquidLineTempF: 100 });
  assert.equal(r.derived.superheatF, undefined);
  assert.ok(r.missing.some((s) => /suction line temperature/i.test(s)), r.missing.join("|"));
  assert.ok(ids(r).includes("missing_suction_line_temp"));
  assert.ok(ids(r).includes("subcooling_low_txv_sh_unknown"));
  assert.ok(!ids(r).includes("undercharge_txv"));
  assert.ok(r.missing.length <= 8);
});

const refr: DxMeasurements = { refrigerant: "R-404A", meteringDevice: "txv", mode: "refrigeration", outdoorDbF: 85 };

test("refrigeration byMode thresholds: CR bands depend on evaporating temperature (medium vs low temp)", () => {
  // low-temp freezer (evap sat -21.5 F, CR 8.9): 8-12 is normal there, no compression-ratio finding at all
  const freezer = diagnose(kb, { ...refr, indoorDbF: 0, suctionPsig: 15, suctionLineTempF: 5, liquidPsig: 250, liquidLineTempF: 95 });
  assert.ok(freezer.derived.compressionRatio! > 8 && freezer.derived.compressionRatio! < 12);
  assert.ok(freezer.derived.evapSatF! < 10);
  assert.ok(!ids(freezer).some((i) => i.startsWith("compression_ratio_")), ids(freezer).join("|"));
  assert.ok(ids(freezer).includes("refrigeration_targets"));
  assert.ok(ids(freezer).includes("refrigeration_evap_td_high"));
  // medium temp (evap sat ~ +12 F) at CR ~8.1: the medium-temp advisory, not the AC rules
  const medium = diagnose(kb, { ...refr, outdoorDbF: 95, indoorDbF: 35, suctionPsig: 45, suctionLineTempF: 45, liquidPsig: 470, liquidLineTempF: 140 });
  assert.ok(medium.derived.evapSatF! >= 10 && medium.derived.compressionRatio! > 8 && medium.derived.compressionRatio! < 12);
  assert.ok(ids(medium).includes("compression_ratio_advisory_refrigeration"));
  assert.ok(!ids(medium).includes("compression_ratio_warn"));
  assert.ok(!ids(medium).includes("compression_ratio_advisory"));
  // low temp at CR 13.9 (suction 5 psig): advisory 12-15, not the warning
  const lowAdv = diagnose(kb, { ...refr, suctionPsig: 5, suctionLineTempF: 0, liquidPsig: 260 });
  assert.ok(lowAdv.derived.compressionRatio! > 12 && lowAdv.derived.compressionRatio! < 15);
  assert.ok(ids(lowAdv).includes("compression_ratio_advisory_refrigeration_lowtemp"));
  assert.ok(!ids(lowAdv).includes("compression_ratio_warn_refrigeration"));
  assert.ok(!ids(lowAdv).includes("compression_ratio_warn_refrigeration_lowtemp"));
  // low temp at CR 16.4 (suction 2 psig): the low-temp warning
  const lowWarn = diagnose(kb, { ...refr, suctionPsig: 2, suctionLineTempF: 0, liquidPsig: 260 });
  assert.ok(lowWarn.derived.compressionRatio! > 15);
  assert.equal(lowWarn.findings[0]!.ruleId, "compression_ratio_warn_refrigeration_lowtemp");
  assert.equal(lowWarn.findings[0]!.severity, "warning");
});

test("standing pressure test and 3-phase current imbalance", () => {
  const r = diagnose(kb, { ...base, standingPsig: 300, equalizedAmbientF: 80, compressorAmps: 20, compressorAmpsL2: 20, compressorAmpsL3: 26, compressorRla: 30 });
  assert.ok(r.derived.standingExcessPsi! > 5, `excess ${r.derived.standingExcessPsi}`);
  assert.ok(ids(r).includes("non_condensables_standing"));
  assert.ok(r.derived.currentImbalancePercent! > 10);
  assert.ok(ids(r).includes("current_imbalance"));
  assert.equal(r.derived.ampsPercentRla, 86.7);
});

test("sight glass rules", () => {
  const restriction = diagnose(kb, { ...base, sightGlass: "bubbles", liquidPsig: 380, liquidLineTempF: 100 });
  assert.ok(ids(restriction).includes("sight_glass_bubbles_restriction"));
  const under = diagnose(kb, { ...base, sightGlass: "bubbles", liquidPsig: 380, liquidLineTempF: 111 });
  assert.ok(ids(under).includes("sight_glass_bubbles_undercharge"));
  const flashing = diagnose(kb, { ...base, sightGlass: "flashing" });
  assert.ok(ids(flashing).includes("sight_glass_flashing"));
});

test("unknown refrigerant → info finding, never throws", () => {
  const r = diagnose(kb, { ...base, refrigerant: "R-999", suctionPsig: 118, suctionLineTempF: 55 });
  assert.ok(ids(r).includes("unknown_refrigerant"));
  assert.equal(r.derived.evapSatF, undefined);
  assert.ok(r.findings.every((f) => f.severity !== "warning" && f.severity !== "critical"));
});

test("garbage input never throws", () => {
  const r = diagnose(kb, { refrigerant: 5, meteringDevice: "x", mode: "y", suctionPsig: "abc", liquidPsig: null, outdoorDbF: "95" } as unknown as DxMeasurements);
  assert.equal(r.measurements.mode, "ac_cooling");
  assert.equal(r.measurements.meteringDevice, "unknown");
  assert.equal(r.measurements.outdoorDbF, 95);
  assert.ok(r.summary.length > 0);
  const r2 = diagnose(kb, undefined as unknown as DxMeasurements);
  assert.ok(Array.isArray(r2.findings));
  const r3 = diagnose(kb, { refrigerant: "R-410A", meteringDevice: "txv", mode: "ac_cooling" });
  assert.ok(r3.missing.length > 0);
});

test("VRF / mini-split scope advisory from notes and compressor type", () => {
  const a = diagnose(kb, { ...base, notes: "Daikin VRV outdoor unit" });
  assert.ok(ids(a).includes("vrf_chiller_scope"));
  const b = diagnose(kb, { ...base, compressorType: "variable_speed", capacityPercent: 100 });
  assert.ok(ids(b).includes("vrf_chiller_scope"));
});

test("ranking: severity, then confidence, then priority; deduped", () => {
  const r = diagnose(kb, { ...base, dischargeLineTempF: 230, drierInletTempF: 100, drierOutletTempF: 90, suctionPsig: 118, suctionLineTempF: 55, liquidPsig: 340, liquidLineTempF: 100 });
  const sev = r.findings.map((f) => ({ critical: 4, warning: 3, advisory: 2, info: 1 })[f.severity]);
  for (let i = 1; i < sev.length; i++) assert.ok(sev[i]! <= sev[i - 1]!);
  const highWarnings = r.findings.filter((f) => f.severity === "warning" && f.confidence === "high").map((f) => f.ruleId);
  assert.deepEqual(highWarnings.slice(0, 2), ["drier_restriction", "discharge_temp_warn"]); // priority 92 > 90
  assert.equal(new Set(ids(r)).size, ids(r).length);
});

// ---------------------------------------------------------------------------
// Rule coverage: every rule below is hit by at least one focused vector at its declared severity
// ---------------------------------------------------------------------------

const fixedBase: DxMeasurements = { ...base, meteringDevice: "fixed", outdoorDbF: 85, indoorWbF: 64 }; // chart target 14 F
const hp = (m: Partial<DxMeasurements>): DxMeasurements => ({ ...heatingBase, suctionMeasuredAt: "compressor_suction", ...m });

/** ruleId → one vector that must fire it. */
const RULE_VECTORS: Record<string, DxMeasurements> = {
  superheat_high_fixed_sc_unknown: { ...fixedBase, suctionPsig: 105, suctionLineTempF: 59.6, liquidPsig: 340 },
  superheat_low_fixed_sc_unknown: { ...fixedBase, suctionPsig: 105, suctionLineTempF: 40.6, liquidPsig: 340 },
  subcooling_high_txv_sh_unknown: { ...base, suctionPsig: 130, liquidPsig: 420, liquidLineTempF: 98 },
  metering_unknown_guidance: { ...base, meteringDevice: "unknown" },
  inefficient_compressor_cr_only: { ...base, outdoorDbF: 80, suctionPsig: 160, suctionLineTempF: 70, liquidPsig: 280, liquidLineTempF: 80 },
  compression_ratio_advisory_heating: hp({ outdoorDbF: 20, suctionPsig: 45, suctionLineTempF: 10, liquidPsig: 300, liquidLineTempF: 85 }),
  compression_ratio_warn_heating: hp({ outdoorDbF: 10, suctionPsig: 30, suctionLineTempF: 0, liquidPsig: 320, liquidLineTempF: 90 }),
  sight_glass_bubbles_sc_unknown: { ...base, sightGlass: "bubbles", liquidPsig: 380 },
  moisture_indicator_wet: { ...base, moistureIndicator: "wet" },
  low_ambient_head_control_ok: { ...base, outdoorDbF: 50, headPressureControl: "fan_cycling", suctionPsig: 118, suctionLineTempF: 55, liquidPsig: 340, liquidLineTempF: 100 },
  readings_part_stage_tandem: { ...base, stageCommanded: "1", compressorCount: 2 },
  dehumid_reheat_active: { ...base, dehumidReheatActive: true },
  hp_outdoor_coil_td_high: hp({ outdoorDbF: 40, suctionPsig: 40, suctionLineTempF: 5, liquidPsig: 300, liquidLineTempF: 85 }),
  hp_indoor_coil_td_high: hp({ outdoorDbF: 40, suctionPsig: 70, suctionLineTempF: 30, liquidPsig: 400, liquidLineTempF: 105 }),
  hp_indoor_coil_td_low: hp({ outdoorDbF: 40, suctionPsig: 70, suctionLineTempF: 30, liquidPsig: 250, liquidLineTempF: 75 }),
  reversing_valve_leak_cooling: { ...base, mode: "heat_pump_cooling", outdoorDbF: 80, suctionPsig: 160, suctionLineTempF: 70, liquidPsig: 280, liquidLineTempF: 80, dischargeLineTempF: 110 },
  refrigeration_evap_td_low: { ...refr, indoorDbF: 35, suctionPsig: 69.3, suctionLineTempF: 55, liquidPsig: 250, liquidLineTempF: 95 },
  refrigeration_superheat_high: { ...refr, indoorDbF: 35, suctionPsig: 52.7, suctionLineTempF: 60, liquidPsig: 250, liquidLineTempF: 95 },
  refrigeration_superheat_low: { ...refr, indoorDbF: 35, suctionPsig: 52.7, suctionLineTempF: 30, liquidPsig: 250, liquidLineTempF: 95 },
  high_side_at_discharge_line: { ...base, highSideMeasuredAt: "discharge_line" },
  high_external_static: { ...base, externalStaticInWc: 1.2 },
  delta_t_low: { ...base, indoorDbF: 74, indoorWbF: 70, supplyDbF: 67 }, // target ~12.5, reading 7
  delta_t_high: { ...base, indoorDbF: 80, indoorWbF: 54, supplyDbF: 50 }, // target ~24.3, reading 30
  missing_outdoor_db: { refrigerant: "R-410A", meteringDevice: "txv", mode: "ac_cooling", indoorDbF: 75 },
  undercharge_txv_sc: { ...base, suctionPsig: 118, suctionLineTempF: 50.4, liquidPsig: 340, liquidLineTempF: 102.5 },
  superheat_high_fixed_sc_normal: { ...fixedBase, suctionPsig: 105, suctionLineTempF: 59.6, liquidPsig: 340, liquidLineTempF: 92 },
  undercharge_fixed_high_sh: { refrigerant: "R-22", meteringDevice: "fixed", mode: "ac_cooling", outdoorDbF: 100, indoorDbF: 75, indoorWbF: 58, suctionPsig: 55, suctionLineTempF: 60, liquidPsig: 242.8, liquidLineTempF: 112 },
  liquid_line_restriction_fixed: { ...fixedBase, suctionPsig: 105, suctionLineTempF: 59.6, liquidPsig: 340, liquidLineTempF: 85 },
  liquid_line_restriction_unknown_metering: { ...base, meteringDevice: "unknown", suctionPsig: 100, suctionLineTempF: 60, liquidPsig: 360, liquidLineTempF: 85 },
  compression_ratio_advisory_refrigeration_lowtemp: { ...refr, suctionPsig: 5, suctionLineTempF: 0, liquidPsig: 260 },
  compression_ratio_warn_refrigeration_lowtemp: { ...refr, suctionPsig: 2, suctionLineTempF: 0, liquidPsig: 260 },
  // medium temp (evap sat 10 F) at CR 12.2: only reachable with the head pushed far past the condenser's normal range
  compression_ratio_warn_refrigeration: { refrigerant: "R-134a", meteringDevice: "txv", mode: "refrigeration", outdoorDbF: 95, indoorDbF: 35, suctionPsig: 12, suctionLineTempF: 40, liquidPsig: 310, liquidLineTempF: 130 },
  amps_near_mcc: { ...base, compressorAmps: 26, compressorRla: 20 },
  non_condensables_standing_possible: { ...base, standingPsig: 243.5, equalizedAmbientF: 80 },
  sight_glass_bubbles_low_head: { ...base, outdoorDbF: 70, sightGlass: "bubbles", liquidPsig: 240 },
  low_condenser_airflow_dirty_coil_high_eff: { ...base, efficiencyTier: "high", suctionPsig: 120, suctionLineTempF: 52.7, liquidPsig: 436.4, liquidLineTempF: 113 },
  non_condensables_high_eff: { ...base, efficiencyTier: "high", suctionPsig: 120, suctionLineTempF: 52.7, liquidPsig: 436.4, liquidLineTempF: 100 },
};

test("every rule in RULE_VECTORS fires at its declared severity (validity ok in cooling/refrigeration vectors)", () => {
  const byId = new Map(kb.diagnostics.rules.rules.map((r) => [r.id, r]));
  for (const [id, m] of Object.entries(RULE_VECTORS)) {
    const rule = byId.get(id);
    assert.ok(rule, `rule ${id} exists`);
    const r = diagnose(kb, m);
    const f = r.findings.find((x) => x.ruleId === id);
    assert.ok(f, `${id} did not fire: ${ids(r).join("|")}`);
    // chargeRelated rules keep their severity only when validity is ok; undercharge_fixed_high_sh is the null-chart case (downgraded by design)
    const expected = rule.chargeRelated && !r.validity.ok ? "info" : rule.severity;
    assert.equal(f.severity, expected, `${id} severity`);
  }
});

test("no rule id is left without a vector, apart from the documented unreachable-by-design fallbacks", () => {
  const covered = new Set<string>([
    ...Object.keys(RULE_VECTORS),
    // exercised by the named tests above / below
    "undercharge_txv", "undercharge_fixed", "overcharge_txv", "overcharge_fixed", "liquid_line_restriction", "drier_restriction", "low_evap_airflow_fixed",
    "low_evap_airflow_txv", "evap_td_high", "high_load_or_airflow", "low_condenser_airflow_dirty_coil", "non_condensables", "non_condensables_standing",
    "wrong_refrigerant", "txv_overfeeding", "txv_starving", "metering_fixed_guidance", "metering_txv_guidance", "metering_eev_guidance", "inefficient_compressor",
    "min_superheat_floodback", "low_discharge_superheat", "high_discharge_superheat", "discharge_temp_warn", "discharge_temp_critical", "compression_ratio_advisory",
    "compression_ratio_warn", "compression_ratio_advisory_refrigeration", "amps_over_rla", "amps_low", "current_imbalance",
    "sight_glass_bubbles_restriction", "sight_glass_bubbles_undercharge", "sight_glass_flashing", "low_ambient_head_control", "low_ambient_head_control_failed",
    "flooding_valve_suppress", "hot_gas_bypass", "readings_part_load", "readings_not_stable", "economizer_open", "defrost_active", "hp_ports_swapped",
    "hp_charge_by_chart", "reversing_valve_leak", "refrigeration_targets", "refrigeration_evap_td_high", "vrf_chiller_scope", "missing_suction_line_temp",
    "missing_liquid_line_temp", "subcooling_low_txv_sh_unknown",
    // fallbacks: only fire when no delta-T target exists, which deriveMetrics never leaves undefined in cooling (table or mode default)
    "delta_t_low_no_target", "delta_t_high_no_target",
  ]);
  const uncovered = kb.diagnostics.rules.rules.map((r) => r.id).filter((id) => !covered.has(id));
  assert.deepEqual(uncovered, []);
});

test("a handful of the coverage rules are checked individually (evap TD, discharge SH, refrigeration ranges)", () => {
  const cr = diagnose(kb, RULE_VECTORS.compression_ratio_warn_refrigeration!);
  assert.ok(cr.derived.compressionRatio! > 12 && cr.derived.evapSatF! >= 10);
  const rvc = diagnose(kb, RULE_VECTORS.reversing_valve_leak_cooling!);
  assert.ok(rvc.derived.dischargeSuperheatF! < 30 && rvc.derived.compressionRatio! < 2.2);
  const tdLow = diagnose(kb, RULE_VECTORS.refrigeration_evap_td_low!);
  assert.equal(tdLow.derived.evapTdF, 5);
  const odTd = diagnose(kb, RULE_VECTORS.hp_outdoor_coil_td_high!);
  assert.ok(odTd.derived.evapTdF! > 30);
  const mcc = diagnose(kb, RULE_VECTORS.amps_near_mcc!);
  assert.equal(mcc.derived.ampsPercentRla, 130);
  assert.equal(mcc.findings[0]!.ruleId, "amps_near_mcc");
  assert.equal(mcc.findings[0]!.severity, "warning");
  assert.equal(mcc.findings.find((f) => f.ruleId === "amps_over_rla")!.severity, "advisory");
  const standing = diagnose(kb, RULE_VECTORS.non_condensables_standing_possible!);
  assert.equal(standing.derived.standingExcessPsi, 7);
  assert.deepEqual(ids(standing), ["non_condensables_standing_possible"]);
});

test("normal fixed-orifice system (WB 64 / DB 85, SH 14, SC 10) produces no warning", () => {
  const r = diagnose(kb, {
    ...fixedBase, indoorDbF: 75, suctionPsig: 118, suctionLineTempF: 54.4, liquidPsig: 340, liquidLineTempF: 95, supplyDbF: 57,
    compressorAmps: 16, compressorRla: 20, runtimeMinutes: 20,
  });
  assert.equal(r.derived.targetSuperheatF, 14);
  assert.ok(Math.abs(r.derived.superheatF! - 14) < 1 && Math.abs(r.derived.subcoolingF! - 10) < 1);
  assert.equal(severities(r, "warning").length, 0);
  assert.equal(severities(r, "critical").length, 0);
  assert.ok(r.findings.every((f) => f.severity === "info"), ids(r).join("|"));
  assert.equal(r.validity.ok, true);
});

// ---------------------------------------------------------------------------
// Verifier scenarios (regressions)
// ---------------------------------------------------------------------------

test("P1: TXV with normal SH (10 F) but SC 4+ under target → undercharge_txv_sc warning first", () => {
  const r = diagnose(kb, RULE_VECTORS.undercharge_txv_sc!);
  assert.ok(r.derived.superheatF! > 5 && r.derived.superheatF! < 14 && r.derived.subcoolingF! < 6);
  assert.equal(r.findings[0]!.ruleId, "undercharge_txv_sc");
  assert.equal(r.findings[0]!.severity, "warning");
  assert.ok(!ids(r).includes("undercharge_txv"));
});

test("P2: TXV high SC with normal SH → overcharge_txv first", () => {
  const r = diagnose(kb, { ...base, suctionPsig: 130, suctionLineTempF: 52, liquidPsig: 420, liquidLineTempF: 98 });
  assert.equal(r.findings[0]!.ruleId, "overcharge_txv");
  assert.equal(r.findings[0]!.severity, "warning");
});

test("P3: fixed orifice SH well over the chart with low SC → undercharge_fixed first", () => {
  const r = diagnose(kb, { ...fixedBase, suctionPsig: 105, suctionLineTempF: 59.6, liquidPsig: 340, liquidLineTempF: 99 });
  assert.equal(r.findings[0]!.ruleId, "undercharge_fixed");
  assert.equal(r.findings[0]!.severity, "warning");
});

test("P4: fixed orifice on a null chart cell (WB 58 / DB 100) → no-target advisory, validity not ok, high-SH fallback present", () => {
  const r = diagnose(kb, RULE_VECTORS.undercharge_fixed_high_sh!);
  assert.equal(r.derived.targetSuperheatF, undefined);
  assert.ok(r.derived.superheatF! >= 25 && r.derived.subcoolingF! < 6);
  assert.equal(r.validity.ok, false);
  assert.ok(r.validity.issues.some((i) => /chart gives no target at indoor WB 58 °F \/ outdoor DB 100 °F/.test(i)), r.validity.issues.join("|"));
  assert.equal(r.findings[0]!.ruleId, "fixed_chart_no_target");
  assert.equal(r.findings[0]!.severity, "advisory");
  assert.ok(ids(r).includes("undercharge_fixed_high_sh"));
  assert.equal(r.findings.find((f) => f.ruleId === "undercharge_fixed_high_sh")!.severity, "info"); // downgraded by the validity gate
  assert.ok(!/Readings are valid for charge determination/.test(r.summary));
  assert.ok(/no target/.test(r.summary));
});

test("scenario 2 / 2d: R-22 and R-410A fixed orifice at 95 / 75 / 63 get chart target 7.5 and undercharge_fixed first", () => {
  const r22 = diagnose(kb, { refrigerant: "R-22", meteringDevice: "fixed", mode: "ac_cooling", outdoorDbF: 95, indoorDbF: 75, indoorWbF: 63, suctionPsig: 55, suctionLineTempF: 65, liquidPsig: 226.4, liquidLineTempF: 108 });
  assert.equal(r22.derived.targetSuperheatF, 7.5);
  assert.equal(r22.derived.superheatF, 35);
  assert.equal(r22.derived.subcoolingF, 2);
  assert.equal(r22.findings[0]!.ruleId, "undercharge_fixed");
  const r410 = diagnose(kb, { ...base, meteringDevice: "fixed", suctionPsig: 118, suctionLineTempF: 75, liquidPsig: 340, liquidLineTempF: 103 });
  assert.equal(r410.derived.targetSuperheatF, 7.5);
  assert.equal(r410.findings[0]!.ruleId, "undercharge_fixed");
  assert.equal(r410.findings[0]!.severity, "warning");
});

test("scenario 7a: digital scroll at 50 % capacity → everything at info (amps_low and undercharge downgraded, readings_part_load)", () => {
  const r = diagnose(kb, { ...base, compressorType: "digital_scroll", capacityPercent: 50, compressorAmps: 9, compressorRla: 20, suctionPsig: 118, suctionLineTempF: 55, liquidPsig: 340, liquidLineTempF: 100 });
  assert.equal(r.validity.ok, false);
  assert.ok(ids(r).includes("readings_part_load"));
  assert.ok(ids(r).includes("amps_low"));
  assert.ok(ids(r).includes("undercharge_txv"));
  assert.ok(r.findings.every((f) => f.severity === "info"), r.findings.map((f) => `${f.ruleId}[${f.severity}]`).join("|"));
});

test("scenarios 9d / 9e: heating with the low-side gauge on the vapor valve yields only hp_ports_swapped + hp_charge_by_chart", () => {
  const vapor: DxMeasurements = {
    refrigerant: "R-410A", meteringDevice: "txv", mode: "heat_pump_heating", outdoorDbF: 35, indoorDbF: 70, supplyDbF: 95,
    suctionPsig: 318, suctionLineTempF: 160, liquidPsig: 322, liquidLineTempF: 92, suctionMeasuredAt: "vapor_service_valve",
  };
  const e = diagnose(kb, { ...vapor, dischargeLineTempF: 185 });
  assert.deepEqual(ids(e), ["hp_ports_swapped", "hp_charge_by_chart"]);
  assert.equal(e.derived.evapSatF, undefined);
  assert.equal(e.derived.superheatF, undefined);
  assert.equal(e.derived.evapTdF, undefined);
  assert.equal(e.derived.compressionRatio, undefined);
  assert.ok(Math.abs(e.derived.condSatF! - 100.8) < 0.2 && Math.abs(e.derived.subcoolingF! - 8.8) < 0.2);
  assert.equal(e.derived.deltaTF, 25);
  const d = diagnose(kb, { ...vapor, dischargeLineTempF: 120 });
  assert.deepEqual(ids(d), ["hp_ports_swapped", "hp_charge_by_chart"]);
  assert.ok(!/impossible/.test(d.summary));
});

test("scenario 10b: healthy low-temp freezer (evap sat -8 F, TD 8, SH 25, CR 6.6) → no advisory-or-higher finding", () => {
  const r = diagnose(kb, { ...refr, indoorDbF: 0, suctionPsig: 25.3, suctionLineTempF: 17, liquidPsig: 250, liquidLineTempF: 95, compressorAmps: 14, compressorRla: 20, dischargeLineTempF: 190 });
  assert.equal(r.derived.evapTdF, 8);
  assert.ok(r.findings.every((f) => f.severity === "info"), r.findings.map((f) => `${f.ruleId}[${f.severity}]`).join("|"));
  assert.equal(r.validity.ok, true);
});

test("scenario 10c: refrigeration at 50 F outdoor with fan cycling holding only 80 F cond sat → head-control finding, no charge-related warning", () => {
  const r = diagnose(kb, { ...refr, outdoorDbF: 50, indoorDbF: 35, headPressureControl: "fan_cycling", suctionPsig: 55, suctionLineTempF: 45, liquidPsig: 175.4, liquidLineTempF: 70, compressorAmps: 14, compressorRla: 20 });
  assert.equal(r.derived.condSatF, 80);
  assert.equal(r.validity.ok, true); // head-pressure control is confirmed
  assert.ok(ids(r).includes("low_ambient_head_control_failed"));
  const byId = new Map(kb.diagnostics.rules.rules.map((x) => [x.id, x]));
  const chargeWarnings = r.findings.filter((f) => byId.get(f.ruleId)?.chargeRelated && (f.severity === "warning" || f.severity === "critical"));
  assert.deepEqual(chargeWarnings.map((f) => f.ruleId), []);
});

test("scenario 10d: refrigeration at 40 F outdoor with no head-pressure control is not valid for charge determination", () => {
  const r = diagnose(kb, {
    refrigerant: "R-448A", meteringDevice: "txv", mode: "refrigeration", outdoorDbF: 40, indoorDbF: 35, headPressureControl: "none",
    suctionPsig: 40, suctionLineTempF: 55, liquidPsig: 129.7, liquidLineTempF: 58, compressorAmps: 5, compressorRla: 10,
  });
  assert.equal(r.derived.condSatF, 60);
  assert.equal(r.derived.subcoolingF, 2);
  assert.ok(Math.abs(r.derived.compressionRatio! - 2.64) < 0.02);
  assert.equal(r.validity.ok, false);
  assert.ok(r.validity.issues.some((i) => /below 65 °F without confirmed head-pressure control/.test(i)));
  assert.ok(["low_ambient_head_control", "low_ambient_head_control_failed"].includes(r.findings[0]!.ruleId), r.findings[0]!.ruleId);
  assert.ok(ids(r).includes("low_ambient_head_control") && ids(r).includes("low_ambient_head_control_failed"));
  assert.ok(!r.missing.some((s) => /head-pressure control/i.test(s)), "head control was stated as none, not unknown");
  assert.ok(/Not valid for charge determination/.test(r.summary));
});

// ---------------------------------------------------------------------------
// Engine behaviours added with the verifier fixes
// ---------------------------------------------------------------------------

test("delta-T rules judge the reading against the table target (deltaTDelta), not fixed 12 / 24 F thresholds", () => {
  // 74 DB / 70 WB: target ~12.5 → 11.5 F is normal, 7 F is low
  const humidOk = diagnose(kb, { ...base, indoorDbF: 74, indoorWbF: 70, supplyDbF: 62.5 });
  assert.ok(!ids(humidOk).includes("delta_t_low"), ids(humidOk).join("|"));
  const humidLow = diagnose(kb, { ...base, indoorDbF: 74, indoorWbF: 70, supplyDbF: 67 });
  assert.equal(humidLow.findings.find((f) => f.ruleId === "delta_t_low")!.severity, "advisory");
  // 80 DB / 54 WB: target ~24.3 → 25 F is normal, 30 F is high
  const dryOk = diagnose(kb, { ...base, indoorDbF: 80, indoorWbF: 54, supplyDbF: 55 });
  assert.ok(!ids(dryOk).includes("delta_t_high"), ids(dryOk).join("|"));
  const dryHigh = diagnose(kb, { ...base, indoorDbF: 80, indoorWbF: 54, supplyDbF: 50 });
  assert.ok(ids(dryHigh).includes("delta_t_high"));
  // summary band is the +/-3 F field tolerance
  const normal = diagnose(kb, { ...base, supplyDbF: 58 });
  assert.deepEqual(normal.derived.targetDeltaTF, { min: 15, max: 21 });
  assert.ok(/delta-T 17 °F \(expect 15-21\)/.test(normal.summary), normal.summary);
  assert.ok(!ids(normal).includes("delta_t_low"));
});

test("efficiencyTier: high-efficiency coil warns at a 28 F split, a standard coil does not; split 40 fires exactly one dirty-coil rule", () => {
  const readings = { suctionPsig: 120, suctionLineTempF: 52.7, liquidPsig: 436.4, liquidLineTempF: 113 };
  const hi = diagnose(kb, { ...base, efficiencyTier: "high", ...readings });
  assert.equal(hi.derived.condenserSplitF, 28);
  assert.equal(hi.findings[0]!.ruleId, "low_condenser_airflow_dirty_coil_high_eff");
  assert.equal(hi.findings[0]!.severity, "warning");
  assert.ok(!ids(hi).includes("low_condenser_airflow_dirty_coil"));
  const std = diagnose(kb, { ...base, ...readings });
  assert.ok(!ids(std).some((i) => i.startsWith("low_condenser_airflow")), ids(std).join("|"));
  const stdTagged = diagnose(kb, { ...base, efficiencyTier: "standard", suctionPsig: 120, suctionLineTempF: 52.7, liquidPsig: 520, liquidLineTempF: 124 });
  assert.deepEqual(ids(stdTagged).filter((i) => i.startsWith("low_condenser_airflow")), ["low_condenser_airflow_dirty_coil"]);
  const hiFouled = diagnose(kb, { ...base, efficiencyTier: "high", suctionPsig: 120, suctionLineTempF: 52.7, liquidPsig: 520, liquidLineTempF: 124 });
  assert.deepEqual(ids(hiFouled).filter((i) => i.startsWith("low_condenser_airflow")), ["low_condenser_airflow_dirty_coil_high_eff"]);
  // non-condensables variants do not double-fire either
  const nc = diagnose(kb, RULE_VECTORS.non_condensables_high_eff!);
  assert.ok(ids(nc).includes("non_condensables_high_eff") && !ids(nc).includes("non_condensables"));
});

test("fixed_chart_no_target does not fire when a nameplate superheat target is given or on TXV systems", () => {
  const nameplate = diagnose(kb, { ...RULE_VECTORS.undercharge_fixed_high_sh!, nameplateSuperheatF: 12 });
  assert.ok(!ids(nameplate).includes("fixed_chart_no_target"));
  assert.equal(nameplate.validity.ok, true);
  assert.equal(nameplate.findings[0]!.ruleId, "undercharge_fixed");
  const txv = diagnose(kb, { ...base, outdoorDbF: 100, indoorWbF: 58, suctionPsig: 118, suctionLineTempF: 55, liquidPsig: 340, liquidLineTempF: 100 });
  assert.ok(!ids(txv).includes("fixed_chart_no_target"));
});

test("R-22 dirty condenser at 450 psig head (above the 160 °F table top): cond sat / SC / split are derived and the airflow rule fires", () => {
  // Finding: the high side used to be reported as "transcritical" (R-22 critical is 205 °F / 709 psig) and
  // condSatF/subcoolingF/condenserSplitF were lost, so low_condenser_airflow_dirty_coil could not fire.
  const m: DxMeasurements = {
    refrigerant: "R-22",
    meteringDevice: "txv",
    mode: "ac_cooling",
    suctionPsig: 75,
    suctionLineTempF: 60,
    liquidPsig: 450,
    liquidLineTempF: 150,
    outdoorDbF: 105,
    indoorDbF: 78,
    indoorWbF: 64,
    supplyDbF: 62,
  };
  const d = deriveMetrics(kb, m);
  assert.ok(d.condSatF !== undefined && Math.abs(d.condSatF - 164) < 1.5, `condSatF ${d.condSatF}`);
  assert.ok(d.subcoolingF !== undefined && Math.abs(d.subcoolingF - 14) < 1.5, `subcoolingF ${d.subcoolingF}`);
  assert.ok(d.condenserSplitF !== undefined && d.condenserSplitF > 55, `split ${d.condenserSplitF}`);
  const r = diagnose(kb, m);
  assert.ok(ids(r).includes("low_condenser_airflow_dirty_coil"), ids(r).join(","));
  assert.ok(!ids(r).includes("wrong_refrigerant"));
  const flag = r.findings.find((f) => f.ruleId === "pt_extrapolated");
  assert.ok(flag, "pt_extrapolated info finding");
  assert.equal(flag!.severity, "info");
  assert.match(flag!.explanation, /extrapolated/);
  assert.ok(flag!.nextChecks.some((n) => /high-pressure switch/.test(n)));
  // in-table readings carry no extrapolation flag
  const normal = diagnose(kb, { ...m, liquidPsig: 300, liquidLineTempF: 120 });
  assert.ok(!ids(normal).includes("pt_extrapolated"));
});
