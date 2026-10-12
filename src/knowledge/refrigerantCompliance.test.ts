import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  annualizedLeakRate,
  applianceChargeLbs,
  applies,
  appliesOds,
  complianceSummary,
  daysBetween,
  evaluateAdd,
  nextObligations,
  thresholdFor,
  type ComplianceEvent,
  type ComplianceUnit,
} from "./refrigerantCompliance.ts";

const RACK: ComplianceUnit = { fullChargeLbs: 400, applianceType: "commercial_refrigeration", circuitsCount: 1 };
const RTU: ComplianceUnit = { fullChargeLbs: 40, applianceType: "comfort_cooling", circuitsCount: 2, installYear: 2020 };

describe("thresholds and applicability", () => {
  test("thresholdFor: 10 / 20 / 30, other and unknown → 10 (40 CFR 84.106)", () => {
    assert.equal(thresholdFor("comfort_cooling"), 10);
    assert.equal(thresholdFor("commercial_refrigeration"), 20);
    assert.equal(thresholdFor("industrial_process"), 30);
    assert.equal(thresholdFor("other"), 10);
    assert.equal(thresholdFor(null), 10);
    assert.equal(thresholdFor("bogus"), 10);
  });
  test("applies from 15 lb (HFC); ODS from 50 lb", () => {
    assert.equal(applies(14.9), false);
    assert.equal(applies(15), true);
    assert.equal(applies(null), false);
    assert.equal(applies(Number.NaN), false);
    assert.equal(appliesOds(49), false);
    assert.equal(appliesOds(50), true);
  });
});

describe("annualizedLeakRate: (added / full charge) × (365 / days) × 100", () => {
  test("EPA worked example: 25 lb into a 400 lb rack 60 days after the prior add = 38.02 %", () => {
    const r = annualizedLeakRate({ addedLbs: 25, fullChargeLbs: 400, daysSinceLastAdd: 60 });
    assert.equal(r.ratePct, 38.02);
    assert.equal(r.days, 60);
    assert.match(r.formula, /365/);
  });
  test("days < 1 are treated as 1 (same-day adds)", () => {
    assert.equal(annualizedLeakRate({ addedLbs: 1, fullChargeLbs: 100, daysSinceLastAdd: 0 }).ratePct, 365);
    assert.equal(annualizedLeakRate({ addedLbs: 1, fullChargeLbs: 100, daysSinceLastAdd: 0.3 }).days, 1);
  });
  test("a full year at 10 % of the charge is exactly 10 %", () => {
    assert.equal(annualizedLeakRate({ addedLbs: 4, fullChargeLbs: 40, daysSinceLastAdd: 365 }).ratePct, 10);
  });
  test("null rate with a reason when the charge or the days are unknown", () => {
    const noCharge = annualizedLeakRate({ addedLbs: 5, fullChargeLbs: null, daysSinceLastAdd: 30 });
    assert.equal(noCharge.ratePct, null);
    assert.match(noCharge.reason ?? "", /full charge/);
    const noDays = annualizedLeakRate({ addedLbs: 5, fullChargeLbs: 100, daysSinceLastAdd: null });
    assert.equal(noDays.ratePct, null);
    assert.match(noDays.reason ?? "", /days since/);
    assert.equal(annualizedLeakRate({ addedLbs: 0, fullChargeLbs: 100, daysSinceLastAdd: 10 }).ratePct, null);
    assert.equal(annualizedLeakRate({ addedLbs: 5, fullChargeLbs: 0, daysSinceLastAdd: 10 }).ratePct, null);
  });
});

describe("dates", () => {
  test("daysBetween and addDays work on YYYY-MM-DD and ISO timestamps", () => {
    assert.equal(daysBetween("2026-01-01", "2026-03-02"), 60);
    assert.equal(daysBetween("2026-01-01T23:00:00Z", "2026-01-02T01:00:00Z"), 1);
    assert.equal(daysBetween("2026-03-02", "2026-01-01"), -60);
    assert.equal(daysBetween("nope", "2026-01-01"), null);
    assert.equal(addDays("2026-12-30", 7), "2027-01-06");
    assert.equal(addDays("2026-03-15", 30), "2026-04-14");
  });
});

describe("evaluateAdd", () => {
  test("uses the previous add on record and the unit threshold", () => {
    const e = evaluateAdd({ amountLbs: 25, date: "2026-03-02", previousAddDate: "2026-01-01", unit: RACK });
    assert.equal(e.leakRatePct, 38.02);
    assert.equal(e.thresholdPct, 20);
    assert.equal(e.exceeded, true);
    assert.equal(e.basis, "previous_add");
    assert.equal(e.applianceChargeLbs, 400);
  });
  test("per-circuit charge on a multi-circuit unit; whole charge when no circuit is given", () => {
    assert.equal(applianceChargeLbs(RTU, 1), 20);
    assert.equal(applianceChargeLbs(RTU, null), 40);
    assert.equal(applianceChargeLbs({ ...RTU, circuitsCount: null }, 1), 40);
    const e = evaluateAdd({ amountLbs: 2, date: "2026-07-01", circuit: 1, previousAddDate: "2026-01-01", unit: RTU });
    // 2 / 20 × 365 / 181 × 100 = 20.17 %
    assert.equal(e.leakRatePct, 20.17);
    assert.equal(e.exceeded, true);
  });
  test("first add falls back to the install year (approximate) or reports no basis", () => {
    const e = evaluateAdd({ amountLbs: 4, date: "2026-07-01", unit: RTU });
    assert.equal(e.basis, "install_year");
    assert.match(e.reason ?? "", /install year/);
    // 4 / 40 × 365 / (6 years ≈ 2191 days) × 100 ≈ 1.67 %
    assert.ok((e.leakRatePct ?? 0) > 1.5 && (e.leakRatePct ?? 0) < 1.8, String(e.leakRatePct));
    assert.equal(e.exceeded, false);
    const none = evaluateAdd({ amountLbs: 4, date: "2026-07-01", unit: RACK });
    assert.equal(none.basis, "none");
    assert.equal(none.leakRatePct, null);
    assert.match(none.reason ?? "", /days since/);
  });
  test("an add dated before the previous add has no basis", () => {
    const e = evaluateAdd({ amountLbs: 4, date: "2025-01-01", previousAddDate: "2026-01-01", unit: RACK });
    assert.equal(e.leakRatePct, null);
    assert.match(e.reason ?? "", /date order/);
  });
});

describe("nextObligations", () => {
  const exceededAdd: ComplianceEvent = { type: "add", date: "2026-03-02", amountLbs: 25, leakRatePct: 38.02, thresholdPct: 20, exceeded: true };
  test("nothing when the rule does not apply", () => {
    assert.deepEqual(nextObligations([exceededAdd], { fullChargeLbs: 10, applianceType: "comfort_cooling", circuitsCount: 1 }, "2026-03-10"), []);
  });
  test("exceedance → repair within 30 days + initial verification + inspection cadence", () => {
    const o = nextObligations([exceededAdd], RACK, "2026-03-10");
    assert.deepEqual(o.map((x) => x.kind), ["repair", "verification_initial", "inspection"]);
    assert.equal(o[0]!.dueDate, "2026-04-01");
    assert.equal(o[0]!.overdue, false);
    assert.match(o[0]!.text, /Repair within 30 days of 2026-03-02/);
    assert.match(o[1]!.text, /Initial verification test before adding refrigerant/);
    assert.equal(o[2]!.dueDate, null);
    assert.match(o[2]!.text, /Annual leak inspection/);
  });
  test("repair logged → initial verification due on the repair date; passed initial → follow-up within 10 days", () => {
    const repaired = [exceededAdd, { type: "repair", date: "2026-03-15" } as ComplianceEvent];
    let o = nextObligations(repaired, RACK, "2026-03-16");
    assert.deepEqual(o.map((x) => x.kind), ["verification_initial", "inspection"]);
    assert.equal(o[0]!.dueDate, "2026-03-15");
    const initial = [...repaired, { type: "verification_initial", date: "2026-03-16", passed: true } as ComplianceEvent];
    o = nextObligations(initial, RACK, "2026-03-17");
    assert.equal(o[0]!.kind, "verification_followup");
    assert.equal(o[0]!.dueDate, "2026-03-26");
    assert.match(o[0]!.text, /10 days of the initial test \(2026-03-16\)/);
    // a failed initial test does not count
    const failed = [...repaired, { type: "verification_initial", date: "2026-03-16", passed: false } as ComplianceEvent];
    assert.equal(nextObligations(failed, RACK, "2026-03-17")[0]!.kind, "verification_initial");
  });
  test("passed follow-up clears the repair chain; the inspection cadence stays (quarterly ≥ 500 lb)", () => {
    const events: ComplianceEvent[] = [
      exceededAdd,
      { type: "repair", date: "2026-03-15" },
      { type: "verification_initial", date: "2026-03-16", passed: true },
      { type: "verification_followup", date: "2026-03-20", passed: true },
      { type: "leak_check", date: "2026-04-01", leakFound: false },
    ];
    const o = nextObligations(events, { ...RACK, fullChargeLbs: 800 }, "2026-05-01");
    assert.deepEqual(o.map((x) => x.kind), ["inspection"]);
    assert.equal(o[0]!.dueDate, "2026-06-30");
    assert.match(o[0]!.text, /Quarterly/);
    assert.equal(o[0]!.overdue, false);
    assert.equal(nextObligations(events, { ...RACK, fullChargeLbs: 800 }, "2026-07-15")[0]!.overdue, true);
  });
  test("exceedance older than 30 days with no passed verification → retrofit/retirement plan (and overdue flags)", () => {
    const o = nextObligations([exceededAdd], RACK, "2026-04-15");
    assert.deepEqual(o.map((x) => x.kind), ["repair", "verification_initial", "retrofit_plan", "inspection"]);
    assert.equal(o[0]!.overdue, true);
    assert.equal(o[2]!.dueDate, "2026-05-01");
    assert.match(o[2]!.text, /Retrofit or retirement plan/);
    const planned = [exceededAdd, { type: "retrofit_plan", date: "2026-04-10" } as ComplianceEvent];
    assert.ok(!nextObligations(planned, RACK, "2026-04-15").some((x) => x.kind === "retrofit_plan"));
  });
  test("a clean latest add after an old exceedance keeps only the inspection cadence", () => {
    const events: ComplianceEvent[] = [exceededAdd, { type: "add", date: "2026-09-01", amountLbs: 2, leakRatePct: 5, thresholdPct: 20, exceeded: false }];
    assert.deepEqual(nextObligations(events, RACK, "2026-09-02").map((x) => x.kind), ["inspection"]);
    assert.deepEqual(nextObligations([{ type: "add", date: "2026-09-01", amountLbs: 2, leakRatePct: 5, exceeded: false }], RACK, "2026-09-02"), []);
  });
});

describe("complianceSummary", () => {
  test("summarizes the last add, the exceedance flag, obligations and notes", () => {
    const s = complianceSummary([{ id: "e1", type: "add", date: "2026-03-02T10:00:00Z", amountLbs: 25, circuit: null, refrigerant: "R-404A", leakRatePct: 38.02, thresholdPct: 20, exceeded: 1 }], RACK, "2026-03-10");
    assert.equal(s.applies, true);
    assert.equal(s.thresholdPct, 20);
    assert.equal(s.exceeded, true);
    assert.equal(s.lastLeakRatePct, 38.02);
    assert.deepEqual(s.lastAdd, { id: "e1", date: "2026-03-02", amountLbs: 25, circuit: null, refrigerant: "R-404A", leakRatePct: 38.02, exceeded: true });
    assert.equal(s.obligations[0]!.kind, "repair");
    assert.equal(s.circuitChargeLbs, 400);
    assert.match(s.formula, /365/);
  });
  test("no full charge → not applicable with an explanatory note; unknown type → 10 % assumed", () => {
    const s = complianceSummary([], { fullChargeLbs: null, applianceType: null, circuitsCount: null }, "2026-03-10");
    assert.equal(s.applies, false);
    assert.equal(s.lastAdd, null);
    assert.equal(s.exceeded, false);
    assert.equal(s.thresholdPct, 10);
    assert.ok(s.notes.some((n) => /full_charge_lbs/.test(n)));
    assert.ok(s.notes.some((n) => /10 % comfort-cooling threshold is assumed/.test(n)));
    const small = complianceSummary([], { fullChargeLbs: 8, applianceType: "comfort_cooling", circuitsCount: 2 }, "2026-03-10");
    assert.equal(small.applies, false);
    assert.equal(small.circuitChargeLbs, 4);
    assert.ok(small.notes.some((n) => /below the 15 lb/.test(n)));
    assert.ok(small.notes.some((n) => /2 circuits/.test(n)));
  });
});
