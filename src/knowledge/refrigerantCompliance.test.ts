import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  annualizedLeakRate,
  applianceChargeLbs,
  applicability,
  applies,
  appliesOds,
  complianceSummary,
  daysBetween,
  evaluateAdd,
  nextObligations,
  openExceedance,
  thresholdFor,
  LEAK_RATE_FORMULA,
  type ComplianceEvent,
  type ComplianceUnit,
  type RefrigerantLookup,
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
    // 6 years since mid-2020 → the annualizing method caps the days at 365: 4 / 40 × 365 / 365 × 100 = 10 %
    assert.equal(e.leakRatePct, 10);
    assert.equal(e.days, 365);
    assert.equal(e.exceeded, false, "10 % is not above the 10 % threshold");
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
  test("a clean latest add does not close an earlier exceedance; with no exceedance on record nothing is due", () => {
    const events: ComplianceEvent[] = [exceededAdd, { type: "add", date: "2026-09-01", amountLbs: 2, leakRatePct: 5, thresholdPct: 20, exceeded: false }];
    assert.deepEqual(nextObligations(events, RACK, "2026-09-02").map((x) => x.kind), ["repair", "verification_initial", "retrofit_plan", "inspection"]);
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

describe("annualizing method: shorter of days since the last add or 365 (40 CFR 82.152 / 84.102)", () => {
  test("100 lb into a 400 lb charge 730 days after the previous add = 25 % (added ÷ charge × 100), not 12.5 %", () => {
    const r = annualizedLeakRate({ addedLbs: 100, fullChargeLbs: 400, daysSinceLastAdd: 730 });
    assert.equal(r.ratePct, 25);
    assert.equal(r.days, 365);
    assert.match(LEAK_RATE_FORMULA, /shorter of days since last add or 365/);
    const e = evaluateAdd({ amountLbs: 100, date: "2028-01-01", previousAddDate: "2026-01-01", unit: RACK });
    assert.equal(e.leakRatePct, 25);
    assert.equal(e.exceeded, true, "25 % > 20 % commercial refrigeration");
  });
  test("install-year fallback: 60 lb into 400 lb installed 2016, first add 2026-03-01 = 15 % (not 1.55 %)", () => {
    const e = evaluateAdd({ amountLbs: 60, date: "2026-03-01", unit: { fullChargeLbs: 400, applianceType: "commercial_refrigeration", circuitsCount: 1, installYear: 2016 } });
    assert.equal(e.basis, "install_year");
    assert.equal(e.days, 365);
    assert.equal(e.leakRatePct, 15);
    assert.equal(e.exceeded, false);
  });
  test("install year after the add date → no basis, with a reason to fix install_year (not 'dated before the previous add')", () => {
    const e = evaluateAdd({ amountLbs: 4, date: "2026-07-01", unit: { ...RTU, installYear: 2027 } });
    assert.equal(e.basis, "none");
    assert.equal(e.leakRatePct, null);
    assert.equal(e.exceeded, false);
    assert.match(e.reason ?? "", /install year 2027 is after the add date \(2026-07-01\); set the correct install_year/);
    assert.doesNotMatch(e.reason ?? "", /previous add/);
    const sameYear = evaluateAdd({ amountLbs: 4, date: "2026-03-01", unit: { ...RTU, installYear: 2026 } });
    assert.equal(sameYear.basis, "none");
    assert.equal(sameYear.leakRatePct, null);
    assert.match(sameYear.reason ?? "", /before mid-2026 \(install year\)/);
  });
  test("a circuit add measured from an earlier unit-level add records the unit-level basis", () => {
    const e = evaluateAdd({ amountLbs: 2, date: "2026-03-02", circuit: 1, previousAddDate: "2026-01-01", previousAddUnitLevel: true, unit: RTU });
    assert.equal(e.basis, "previous_add_unit_level");
    assert.match(e.reason ?? "", /unit level/);
    // 2 / 20 × 365 / 60 × 100 = 60.83 %
    assert.equal(e.leakRatePct, 60.83);
  });
});

describe("open exceedance (most recent exceeded add without a passed follow-up / retrofit plan after it)", () => {
  const exceeded: ComplianceEvent = { id: "x1", type: "add", date: "2026-03-02T12:00:00.000Z", amountLbs: 25, leakRatePct: 38.02, thresholdPct: 20, exceeded: 1 };
  test("(a) exceedance 03-02 then a 2 lb top-off 03-20 below the threshold: obligations, exceeded and the rate stay on the 03-02 exceedance", () => {
    // 2 / 400 × 365 / 18 × 100 = 10.14 % < 20 %
    const topOff: ComplianceEvent = { id: "t1", type: "add", date: "2026-03-20T12:00:00.000Z", amountLbs: 2, leakRatePct: 10.14, thresholdPct: 20, exceeded: 0 };
    assert.equal(openExceedance([exceeded, topOff])?.id, "x1");
    const s = complianceSummary([exceeded, topOff], RACK, "2026-03-25");
    assert.equal(s.exceeded, true);
    assert.equal(s.lastLeakRatePct, 38.02);
    assert.equal(s.lastAdd?.id, "t1");
    assert.equal(s.lastAdd?.exceeded, false);
    assert.deepEqual(s.openExceedance, { id: "x1", date: "2026-03-02", amountLbs: 25, circuit: null, leakRatePct: 38.02, thresholdPct: 20 });
    assert.deepEqual(s.obligations.map((o) => o.kind), ["repair", "verification_initial", "inspection"]);
    assert.equal(s.obligations[0]!.dueDate, "2026-04-01");
    assert.match(s.obligations[0]!.text, /38.02 % exceeds 20 %/);
  });
  test("(b) exceedance 03-02, repair + passed initial 03-20, passed follow-up 03-28: on 04-15 nothing is open but the inspection cadence", () => {
    const events: ComplianceEvent[] = [
      exceeded,
      { type: "repair", date: "2026-03-20T12:00:00.000Z" },
      { type: "verification_initial", date: "2026-03-20T12:00:00.000Z", passed: 1 },
      { type: "verification_followup", date: "2026-03-28T12:00:00.000Z", passed: 1 },
    ];
    assert.equal(openExceedance(events), undefined);
    const s = complianceSummary(events, RACK, "2026-04-15");
    assert.equal(s.exceeded, false);
    assert.equal(s.openExceedance, null);
    assert.equal(s.lastLeakRatePct, 38.02, "no exceedance open: the last add's rate");
    assert.deepEqual(s.obligations.map((o) => o.kind), ["inspection"]);
  });
  test("a retrofit plan closes the exceedance; a failed follow-up does not; a newer exceedance reopens", () => {
    assert.equal(openExceedance([exceeded, { type: "retrofit_plan", date: "2026-04-20" }]), undefined);
    assert.equal(openExceedance([exceeded, { type: "verification_followup", date: "2026-03-28", passed: 0 }])?.id, "x1");
    const again: ComplianceEvent = { id: "x2", type: "add", date: "2026-06-01", amountLbs: 30, leakRatePct: 40, thresholdPct: 20, exceeded: 1 };
    assert.equal(openExceedance([exceeded, { type: "verification_followup", date: "2026-03-28", passed: 1 }, again])?.id, "x2");
  });
});

describe("retrofit / retirement plan only when the appliance is not repaired and verified by the deadline", () => {
  const exceeded: ComplianceEvent = { type: "add", date: "2026-03-02", amountLbs: 25, leakRatePct: 38.02, thresholdPct: 20, exceeded: true };
  test("on-time repair with a passed initial verification (03-20): no retrofit plan on 04-15, the follow-up stays due", () => {
    const events: ComplianceEvent[] = [exceeded, { type: "repair", date: "2026-03-20" }, { type: "verification_initial", date: "2026-03-20", passed: true }];
    const o = nextObligations(events, RACK, "2026-04-15");
    assert.deepEqual(o.map((x) => x.kind), ["verification_followup", "inspection"]);
    assert.equal(o[0]!.dueDate, "2026-03-30");
    assert.equal(o[0]!.overdue, true);
  });
  test("initial verification passed after the 04-01 deadline, or a failed follow-up, still needs the plan", () => {
    const late: ComplianceEvent[] = [exceeded, { type: "repair", date: "2026-04-05" }, { type: "verification_initial", date: "2026-04-05", passed: true }];
    const o = nextObligations(late, RACK, "2026-04-15");
    assert.deepEqual(o.map((x) => x.kind), ["verification_followup", "retrofit_plan", "inspection"]);
    assert.match(o[1]!.text, /passed only on 2026-04-05, after the deadline/);
    const failed: ComplianceEvent[] = [exceeded, { type: "repair", date: "2026-03-20" }, { type: "verification_initial", date: "2026-03-20", passed: true }, { type: "verification_followup", date: "2026-03-28", passed: false }];
    const f = nextObligations(failed, RACK, "2026-04-15");
    assert.deepEqual(f.map((x) => x.kind), ["verification_followup", "retrofit_plan", "inspection"]);
    assert.match(f[0]!.text, /2026-03-28 follow-up test failed/);
  });
});

describe("applicability by refrigerant (40 CFR 84.106(a): HFC with GWP > 53 from 15 lb; 82.157: ODS from 50 lb)", () => {
  const facts: Record<string, { id: string; gwp: number }> = {
    "R-22": { id: "R-22", gwp: 1810 },
    "R-410A": { id: "R-410A", gwp: 2088 },
    "R-744": { id: "R-744", gwp: 1 },
    "R-717": { id: "R-717", gwp: 0 },
    "R-290": { id: "R-290", gwp: 3 },
    "R-1234yf": { id: "R-1234yf", gwp: 4 },
    "R-123": { id: "R-123", gwp: 77 },
  };
  const lookup: RefrigerantLookup = (name) => facts[name.trim().toUpperCase().replace(/^R-?/, "R-").replace("YF", "yf")];
  test("ODS (R-22, R-123) apply from 50 lb; GWP ≤ 53 refrigerants are not covered; HFCs from 15 lb", () => {
    assert.deepEqual(applicability(40, "R-22", lookup), { applies: false, regime: "ods", thresholdLbs: 50, refrigerantId: "R-22", gwp: 1810 });
    assert.equal(applies(50, "R-22", lookup), true);
    assert.equal(applies(49, "R-22", lookup), false);
    assert.equal(applicability(400, "R-123", lookup).regime, "ods", "HCFC-123: ODS even though GWP 77");
    for (const r of ["R-744", "R-717", "R-290", "R-1234yf"]) {
      const a = applicability(400, r, lookup);
      assert.equal(a.applies, false, r);
      assert.equal(a.regime, "not_covered", r);
      assert.match(a.note ?? "", /neither an HFC with GWP > 53 nor an ODS/);
    }
    assert.deepEqual(applicability(20, "R-410A", lookup), { applies: true, regime: "hfc", thresholdLbs: 15, refrigerantId: "R-410A", gwp: 2088 });
  });
  test("unknown or missing refrigerant: HFC 15 lb assumed with a note; ODS ids are recognized even without a lookup", () => {
    const none = applicability(20, null);
    assert.equal(none.applies, true);
    assert.equal(none.regime, "unknown");
    assert.match(none.note ?? "", /Refrigerant not recorded/);
    const odd = applicability(20, "R-999", lookup);
    assert.equal(odd.regime, "unknown");
    assert.match(odd.note ?? "", /R-999 is not in the refrigerant knowledge base/);
    assert.equal(applicability(40, "HCFC-22").regime, "ods");
    assert.equal(applicability(40, "HCFC-22").applies, false);
  });
  test("obligations and the summary follow the refrigerant: a 40 lb R-22 unit and a 400 lb R-744 rack have none", () => {
    const exceeded: ComplianceEvent = { type: "add", date: "2026-03-02", amountLbs: 25, leakRatePct: 38.02, thresholdPct: 20, exceeded: true };
    const r22: ComplianceUnit = { fullChargeLbs: 40, applianceType: "comfort_cooling", circuitsCount: 1, refrigerant: "R-22" };
    assert.deepEqual(nextObligations([exceeded], r22, "2026-03-10", lookup), []);
    const s22 = complianceSummary([exceeded], r22, "2026-03-10", lookup);
    assert.equal(s22.applies, false);
    assert.equal(s22.regime, "ods");
    assert.equal(s22.applicabilityLbs, 50);
    assert.ok(s22.notes.some((n) => /ozone-depleting.*82.157.*applies from 50 lb/.test(n)), s22.notes.join(" | "));
    const co2: ComplianceUnit = { ...RACK, refrigerant: "R-744" };
    const sCo2 = complianceSummary([exceeded], co2, "2026-03-10", lookup);
    assert.equal(sCo2.applies, false);
    assert.equal(sCo2.regime, "not_covered");
    assert.equal(sCo2.applicabilityLbs, null);
    assert.deepEqual(sCo2.obligations, []);
    // 60 lb R-22 is covered (ODS ≥ 50 lb); the annual cadence starts at 50 lb
    const big = complianceSummary([exceeded], { ...r22, fullChargeLbs: 60 }, "2026-03-10", lookup);
    assert.equal(big.applies, true);
    assert.match(big.obligations.find((o) => o.kind === "inspection")!.text, /charge 50–499 lb/);
  });
});
