import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import { loadKnowledge } from "./loader.ts";
import { CHILLER_LIMITS, evaluateChiller, sanitizeChiller } from "./chiller.ts";

const kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });

function near(actual: number | undefined, expected: number, tol: number, label: string): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tol, `${label}: ${actual} not within ±${tol} of ${expected}`);
}

describe("evaluateChiller", () => {
  test("healthy water-cooled centrifugal: ΔT, tons = 500·gpm·ΔT/12000, approaches, % RLA; no warnings", () => {
    const r = evaluateChiller(kb, { chwSupplyF: 44, chwReturnF: 54, chwFlowGpm: 720, evapSatF: 41, condSatF: 97, condWaterInF: 85, condWaterOutF: 94.5, compressorAmps: 300, rla: 400, percentLoad: 78 });
    assert.equal(r.condenserType, "water_cooled");
    assert.equal(r.derived.chwDeltaTF, 10);
    assert.equal(r.derived.tons, 300);
    assert.equal(r.derived.evapApproachF, 3);
    assert.equal(r.derived.condApproachF, 2.5);
    assert.equal(r.derived.condWaterDeltaTF, 9.5);
    assert.equal(r.derived.ampsPercentRla, 75);
    assert.equal(r.validity.ok, true);
    assert.ok(!r.findings.some((f) => f.severity === "warning" || f.severity === "critical"), r.findings.map((f) => f.ruleId).join(","));
    assert.ok(r.findings.some((f) => f.ruleId === "chiller_scope"));
    assert.match(r.summary, /300 tons/);
    assert.match(r.summary, /Approaches within the healthy band/);
  });

  test("fouled evaporator and condenser tubes: approaches above 5 °F", () => {
    const r = evaluateChiller(kb, { chwSupplyF: 44, chwReturnF: 54, evapSatF: 36, condSatF: 103, condWaterOutF: 95, condenserType: "water_cooled" });
    assert.equal(r.derived.evapApproachF, 8);
    assert.equal(r.derived.condApproachF, 8);
    const ids = r.findings.map((f) => f.ruleId);
    assert.ok(ids.includes("chiller_evap_approach_high"));
    assert.ok(ids.includes("chiller_cond_approach_high_water"));
    const cond = r.findings.find((f) => f.ruleId === "chiller_cond_approach_high_water")!;
    assert.equal(cond.severity, "warning");
    assert.match(cond.explanation, /3 °F over the commissioning baseline/);
    assert.match(r.summary, /Warning: Evaporator approach 8 °F/);
    const critical = evaluateChiller(kb, { chwSupplyF: 44, evapSatF: 30 });
    assert.equal(critical.findings[0]!.ruleId, "chiller_evap_approach_critical");
    assert.equal(critical.findings[0]!.severity, "critical");
  });

  test("air-cooled: approach vs entering air > 25 °F → dirty coil / fan; pressures convert through the PT table", () => {
    // R-134a at 185 psig ≈ 125 °F bubble; outdoor 95 → approach ≈ 30
    const r = evaluateChiller(kb, { refrigerant: "R-134a", chwSupplyF: 44, chwReturnF: 52, evapPressurePsig: 35, condPressurePsig: 185, outdoorDbF: 95 });
    assert.equal(r.condenserType, "air_cooled");
    near(r.derived.evapSatF, 40, 1.5, "evap sat from 35 psig R-134a");
    near(r.derived.condSatF, 125, 2, "cond sat from 185 psig R-134a");
    assert.ok((r.derived.condApproachF ?? 0) > CHILLER_LIMITS.condApproachAirWarnF, String(r.derived.condApproachF));
    assert.ok(r.findings.some((f) => f.ruleId === "chiller_cond_approach_high_air"));
    assert.equal(r.validity.ok, true);
  });

  test("pressures without a refrigerant: validity issue + advisory, approaches missing", () => {
    const r = evaluateChiller(kb, { chwSupplyF: 44, evapPressurePsig: 35, condPressurePsig: 185, outdoorDbF: 95 });
    assert.equal(r.validity.ok, false);
    assert.match(r.validity.issues[0]!, /refrigerant not given/);
    assert.ok(r.findings.some((f) => f.ruleId === "chiller_refrigerant_required"));
    assert.equal(r.derived.evapApproachF, undefined);
    const bad = evaluateChiller(kb, { refrigerant: "R-999", chwSupplyF: 44, evapPressurePsig: 35 });
    assert.match(bad.validity.issues[0]!, /not in the PT tables/);
  });

  test("zero or negative CHW ΔT at high load reports chiller_chw_dt_zero, not low ΔT at load", () => {
    for (const [supply, ret] of [[44, 44], [46, 44]] as const) {
      const r = evaluateChiller(kb, { chwSupplyF: supply, chwReturnF: ret, percentLoad: 90 });
      assert.ok(r.findings.some((f) => f.ruleId === "chiller_chw_dt_zero"), `${supply}/${ret}`);
      assert.ok(!r.findings.some((f) => f.ruleId === "chiller_low_chw_dt_high_load"), `${supply}/${ret}`);
    }
  });

  test("low ΔT at high load, high ΔT, freeze risk, amps > 110 % RLA, oil bands", () => {
    const lowDt = evaluateChiller(kb, { chwSupplyF: 44, chwReturnF: 48, percentLoad: 90 });
    assert.ok(lowDt.findings.some((f) => f.ruleId === "chiller_low_chw_dt_high_load"));
    const lowDtLowLoad = evaluateChiller(kb, { chwSupplyF: 44, chwReturnF: 48, percentLoad: 30 });
    assert.ok(!lowDtLowLoad.findings.some((f) => f.ruleId === "chiller_low_chw_dt_high_load"));
    const highDt = evaluateChiller(kb, { chwSupplyF: 42, chwReturnF: 60 });
    assert.ok(highDt.findings.some((f) => f.ruleId === "chiller_high_chw_dt"));
    const freeze = evaluateChiller(kb, { chwSupplyF: 36, chwReturnF: 46 });
    assert.ok(freeze.findings.some((f) => f.ruleId === "chiller_chw_supply_low"));
    const amps = evaluateChiller(kb, { compressorAmps: 460, rla: 400 });
    assert.equal(amps.derived.ampsPercentRla, 115);
    assert.ok(amps.findings.some((f) => f.ruleId === "chiller_amps_high"));
    const lowAmps = evaluateChiller(kb, { compressorAmps: 100, rla: 400, percentLoad: 95 });
    assert.ok(lowAmps.findings.some((f) => f.ruleId === "chiller_amps_low_vs_load"));
    const oil = evaluateChiller(kb, { oilPressurePsig: 8, oilTempF: 80 });
    assert.ok(oil.findings.some((f) => f.ruleId === "chiller_oil_pressure_low"));
    assert.ok(oil.findings.some((f) => f.ruleId === "chiller_oil_temp_low"));
    const hotOil = evaluateChiller(kb, { oilPressurePsig: 150, oilTempF: 185 });
    assert.ok(hotOil.findings.some((f) => f.ruleId === "chiller_oil_pressure_high"));
    assert.ok(hotOil.findings.some((f) => f.ruleId === "chiller_oil_temp_high"));
    // ranking: warnings before advisories before info
    const sev = oil.findings.map((f) => f.severity);
    assert.deepEqual(sev, [...sev].sort((a, b) => ["critical", "warning", "advisory", "info"].indexOf(a) - ["critical", "warning", "advisory", "info"].indexOf(b)));
  });

  test("missing list names what would sharpen the result; sanitize coerces strings and drops junk", () => {
    const r = evaluateChiller(kb, { chwSupplyF: 44 });
    assert.ok(r.missing.includes("chwReturnF"));
    assert.ok(r.missing.some((m) => /evapSatF or evapPressurePsig/.test(m)));
    assert.match(r.summary, /Not enough readings/);
    const m = sanitizeChiller({ chwSupplyF: "44" as unknown as number, chwReturnF: Number.NaN, condenserType: "bogus" as never, refrigerant: " R-134a ", circuit: " 1 " });
    assert.deepEqual(m, { chwSupplyF: 44, refrigerant: "R-134a", circuit: "1" });
  });
});
