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
    for (const v of row) if (v !== null) assert.ok(v >= 5 && v <= 40, `value ${v}`);
  }
  assert.equal(c.fixedOrificeSuperheat.targetF[0]![12], null); // 50 WB / 115 DB: not recommended
  assert.ok(c.targetDeltaT);
  assert.ok(c.heatPumpHeating!.notes.length >= 3);
  assert.ok(c.notes.some((n) => /precedence/i.test(n)));
});

test("fixed-orifice chart: grid points, midpoints, clamping and nulls", () => {
  const chart = kb.diagnostics.charging.fixedOrificeSuperheat;
  const cell = (wb: number, db: number) => chart.targetF[chart.indoorWbF.indexOf(wb)]![chart.outdoorDbF.indexOf(db)];
  assert.equal(targetSuperheatFixedOrifice(kb, 64, 85), cell(64, 85));
  assert.equal(targetSuperheatFixedOrifice(kb, 70, 95), cell(70, 95));
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

test("delta-T table follows the Carrier style reference points", () => {
  const a = targetDeltaTFromTable(kb, 75, 63)!;
  const b = targetDeltaTFromTable(kb, 75, 58)!;
  const c = targetDeltaTFromTable(kb, 75, 68)!;
  assert.ok(a.min <= 19 && a.max >= 19, `75/63 ${JSON.stringify(a)}`);
  assert.ok(b.min <= 23 && b.max >= 23, `75/58 ${JSON.stringify(b)}`);
  assert.ok(c.min <= 14 && c.max >= 14, `75/68 ${JSON.stringify(c)}`);
  assert.ok(b.min > a.min && a.min > c.min, "humid air → smaller delta-T");
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

test("heating mode: cooling chart rules do not fire, hp_charge_by_chart fires, vapor-valve suction warned", () => {
  const r = diagnose(kb, {
    refrigerant: "R-410A", meteringDevice: "txv", mode: "heat_pump_heating", outdoorDbF: 35, indoorDbF: 70,
    suctionPsig: 60, suctionLineTempF: 20, liquidPsig: 320, liquidLineTempF: 90, suctionMeasuredAt: "vapor_service_valve",
  });
  assert.equal(r.derived.condenserSplitF, undefined);
  assert.ok(Math.abs(r.derived.indoorCoilTdF! - (r.derived.condSatF! - 70)) < 0.01);
  assert.ok(Math.abs(r.derived.evapTdF! - (35 - r.derived.evapSatF!)) < 0.01);
  assert.equal(r.derived.targetSubcoolingF, undefined);
  assert.ok(ids(r).includes("hp_charge_by_chart"));
  assert.equal(r.findings[0]!.ruleId, "hp_ports_swapped");
  for (const id of ["undercharge_txv", "overcharge_txv", "liquid_line_restriction", "low_condenser_airflow_dirty_coil", "metering_txv_guidance"]) {
    assert.ok(!ids(r).includes(id), `${id} must not fire in heating`);
  }
  assert.equal(r.validity.ok, false);
  assert.ok(r.validity.issues[0]!.includes("heating"));
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

test("refrigeration byMode thresholds: CR 9 is an advisory, not the AC warning", () => {
  const r = diagnose(kb, { refrigerant: "R-404A", meteringDevice: "txv", mode: "refrigeration", outdoorDbF: 85, indoorDbF: 0, suctionPsig: 15, suctionLineTempF: 5, liquidPsig: 250, liquidLineTempF: 95 });
  assert.ok(r.derived.compressionRatio! > 8 && r.derived.compressionRatio! < 12);
  assert.ok(ids(r).includes("compression_ratio_advisory_refrigeration"));
  assert.ok(!ids(r).includes("compression_ratio_warn"));
  assert.ok(!ids(r).includes("compression_ratio_advisory"));
  assert.ok(ids(r).includes("refrigeration_targets"));
  assert.ok(ids(r).includes("refrigeration_evap_td_high"));
  const warn = diagnose(kb, { refrigerant: "R-404A", meteringDevice: "txv", mode: "refrigeration", outdoorDbF: 85, suctionPsig: 5, suctionLineTempF: 0, liquidPsig: 260 });
  assert.ok(warn.derived.compressionRatio! > 12);
  assert.ok(ids(warn).includes("compression_ratio_warn_refrigeration"));
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
