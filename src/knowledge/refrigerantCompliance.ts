/**
 * EPA refrigerant leak-rate compliance (pure; no clocks, no I/O).
 *
 * Sources:
 *  - 40 CFR 84.106 (AIM Act Emissions Reduction and Reclamation rule; EPA "Leak Repair Requirements" fact
 *    sheet, January 2026): appliances with ≥ 15 lb of an HFC (or HFC-containing blend with GWP > 53) must be
 *    repaired when the annualized leak rate exceeds 10 % (comfort cooling), 20 % (commercial refrigeration) or
 *    30 % (industrial process refrigeration); repair within 30 days (120 when a shutdown is needed), initial
 *    verification test before adding refrigerant after the repair, follow-up verification within 10 days,
 *    leak inspections (quarterly ≥ 500 lb, annual 15–499 lb) after an exceedance, and a retrofit/retirement
 *    plan within 30 days when the appliance is not repaired in time.
 *  - 40 CFR 82.157 (ODS, e.g. R-22): the same structure for appliances with ≥ 50 lb.
 *  - Applicability (40 CFR 84.106(a) / 82.157(a)): the HFC rule covers refrigerants that are or contain an HFC
 *    with GWP > 53; ODS (CFC / HCFC and blends containing them) fall under 82.157 from 50 lb; refrigerants with
 *    GWP ≤ 53 that are not ODS (R-744, R-717, R-290, R-600a, HFOs) are not covered. The refrigerant facts (id,
 *    GWP) come from an injected `RefrigerantLookup` so this module stays pure (the store builds one from the
 *    knowledge base, src/knowledge/refrigerants.ts `complianceRefrigerantLookup`).
 *  - Leak-rate formula ("annualizing method", 40 CFR 82.152 / 84.102 definition of "leak rate"):
 *      leak rate % = (lb added / full charge lb) × (365 / shorter of: days since the last add, or 365) × 100.
 *    EPA worked example: 25 lb added to a 400 lb rack 60 days after the previous add = 38.02 % per year.
 *
 * Everything date-based uses YYYY-MM-DD strings (an ISO timestamp is reduced to its date) and a `today`
 * parameter; nothing here reads the clock.
 */
import type { ApplianceType, RefrigerantEventType } from "../types.ts";
import { canonicalRefrigerantId } from "./refrigerants.ts";

export const LEAK_RATE_FORMULA = "leak rate % = (lb added ÷ full charge lb) × (365 ÷ shorter of days since last add or 365) × 100";
export const LEAK_RATE_SOURCE = "40 CFR 84.106 (EPA leak repair fact sheet, Jan 2026); formula per 40 CFR 82.152 / 84.102 'annualizing method'";

/** Leak-rate thresholds (% per year) by appliance category; `other` is treated as comfort cooling (10 %). */
export const LEAK_RATE_THRESHOLDS: Record<ApplianceType, number> = {
  comfort_cooling: 10,
  commercial_refrigeration: 20,
  industrial_process: 30,
  other: 10,
};
export const APPLIANCE_TYPES: readonly ApplianceType[] = ["comfort_cooling", "commercial_refrigeration", "industrial_process", "other"];

/** HFC regime (40 CFR 84.106) applies from 15 lb; the ODS regime (40 CFR 82.157, R-22 etc.) from 50 lb. */
export const HFC_APPLICABILITY_LBS = 15;
export const ODS_APPLICABILITY_LBS = 50;
/** 40 CFR 84.106(a): only refrigerants that are or contain an HFC with a GWP above 53 are covered by the HFC rule. */
export const HFC_GWP_COVERAGE_LIMIT = 53;
/** Longest elapsed time the annualizing method uses (40 CFR 82.152 / 84.102: "shorter of … or 365 days"). */
export const ANNUALIZING_MAX_DAYS = 365;
/**
 * Ozone-depleting refrigerants regulated by 40 CFR 82.157 (class I CFCs, class II HCFCs and blends that contain
 * them). Matched against the canonical id (R-22, R-401A …); everything else is judged by its GWP.
 */
export const ODS_REFRIGERANT_IDS: readonly string[] = [
  "R-11", "R-12", "R-13", "R-22", "R-113", "R-114", "R-115", "R-123", "R-124", "R-142b",
  "R-401A", "R-401B", "R-402A", "R-402B", "R-403B", "R-406A", "R-408A", "R-409A", "R-411A", "R-411B",
  "R-412A", "R-414A", "R-414B", "R-416A", "R-500", "R-502", "R-503", "R-509A",
];
const ODS_ID_SET = new Set(ODS_REFRIGERANT_IDS.map((id) => id.toUpperCase()));
export const REPAIR_DAYS = 30;
export const REPAIR_DAYS_SHUTDOWN = 120;
export const FOLLOWUP_VERIFICATION_DAYS = 10;
export const INSPECTION_QUARTERLY_LBS = 500;
export const INSPECTION_QUARTERLY_DAYS = 90;
export const INSPECTION_ANNUAL_DAYS = 365;

export function thresholdFor(applianceType: string | null | undefined): number {
  if (applianceType && applianceType in LEAK_RATE_THRESHOLDS) return LEAK_RATE_THRESHOLDS[applianceType as ApplianceType];
  return LEAK_RATE_THRESHOLDS.other;
}

/** Refrigerant facts the applicability check needs; `gwp` is the AR4 100-year GWP (the AIM Act basis). */
export interface RefrigerantFacts {
  id: string;
  gwp: number | null;
}
/** Resolves a refrigerant name ("R22", "Puron", "CO2") to its facts; undefined when unknown. Injected by callers. */
export type RefrigerantLookup = (refrigerant: string) => RefrigerantFacts | undefined;

/** hfc: 40 CFR 84.106 from 15 lb; ods: 40 CFR 82.157 from 50 lb; not_covered: GWP ≤ 53 and not ODS; unknown: HFC assumed. */
export type ComplianceRegime = "hfc" | "ods" | "not_covered" | "unknown";

export interface Applicability {
  applies: boolean;
  regime: ComplianceRegime;
  /** Full charge from which the leak-repair rule applies (15 HFC / unknown, 50 ODS); null when not covered. */
  thresholdLbs: number | null;
  refrigerantId: string | null;
  gwp: number | null;
  /** Explains a not-covered or unknown refrigerant. */
  note?: string;
}

/**
 * Which leak-repair regime covers the appliance (40 CFR 84.106(a) and 82.157(a)): a known ODS → 82.157 from
 * 50 lb; GWP ≤ 53 (not ODS) → not covered; an HFC / HFC blend with GWP > 53 → 84.106 from 15 lb; a refrigerant
 * that is not recorded or not in the lookup → the HFC 15 lb applicability is assumed, with a note.
 */
export function applicability(fullChargeLbs: number | null | undefined, refrigerant?: string | null, lookup?: RefrigerantLookup): Applicability {
  const charge = typeof fullChargeLbs === "number" && Number.isFinite(fullChargeLbs) ? fullChargeLbs : null;
  const name = typeof refrigerant === "string" ? refrigerant.trim() : "";
  let facts: RefrigerantFacts | undefined;
  if (name && lookup) {
    try {
      facts = lookup(name);
    } catch {
      facts = undefined;
    }
  }
  const id = facts?.id ?? (name ? canonicalRefrigerantId(name) || null : null);
  const gwp = facts && typeof facts.gwp === "number" && Number.isFinite(facts.gwp) ? facts.gwp : null;
  if (id && ODS_ID_SET.has(id.toUpperCase())) {
    return { applies: appliesOds(charge), regime: "ods", thresholdLbs: ODS_APPLICABILITY_LBS, refrigerantId: id, gwp };
  }
  if (gwp !== null && gwp <= HFC_GWP_COVERAGE_LIMIT) {
    return {
      applies: false,
      regime: "not_covered",
      thresholdLbs: null,
      refrigerantId: id,
      gwp,
      note: `${id} (GWP ${gwp}) is neither an HFC with GWP > ${HFC_GWP_COVERAGE_LIMIT} nor an ODS: the EPA leak-repair rules (40 CFR 84.106 / 82.157) do not apply; leak rates are computed for the record only.`,
    };
  }
  if (facts && gwp !== null) return { applies: appliesHfc(charge), regime: "hfc", thresholdLbs: HFC_APPLICABILITY_LBS, refrigerantId: id, gwp };
  return {
    applies: appliesHfc(charge),
    regime: "unknown",
    thresholdLbs: HFC_APPLICABILITY_LBS,
    refrigerantId: id,
    gwp: null,
    note: name
      ? `${name} is not in the refrigerant knowledge base (GWP unknown): the HFC ${HFC_APPLICABILITY_LBS} lb applicability is assumed.`
      : `Refrigerant not recorded: the HFC ${HFC_APPLICABILITY_LBS} lb applicability is assumed (ODS such as R-22: ${ODS_APPLICABILITY_LBS} lb; refrigerants with GWP ≤ ${HFC_GWP_COVERAGE_LIMIT} are not covered).`,
  };
}

/**
 * Whether a leak-repair rule applies. Without a refrigerant: full charge ≥ 15 lb (HFC assumed); with one, per
 * `applicability` (ODS ≥ 50 lb, GWP ≤ 53 not covered).
 */
export function applies(fullChargeLbs: number | null | undefined, refrigerant?: string | null, lookup?: RefrigerantLookup): boolean {
  return applicability(fullChargeLbs, refrigerant, lookup).applies;
}

function appliesHfc(fullChargeLbs: number | null | undefined): boolean {
  return typeof fullChargeLbs === "number" && Number.isFinite(fullChargeLbs) && fullChargeLbs >= HFC_APPLICABILITY_LBS;
}

/** ODS appliances (40 CFR 82.157(a)): full charge ≥ 50 lb. */
export function appliesOds(fullChargeLbs: number | null | undefined): boolean {
  return typeof fullChargeLbs === "number" && Number.isFinite(fullChargeLbs) && fullChargeLbs >= ODS_APPLICABILITY_LBS;
}

// ---------------------------------------------------------------------------
// Dates (YYYY-MM-DD)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** YYYY-MM-DD of a date string or ISO timestamp (null when unparseable). */
export function dateOnly(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return m ? m[1]! : null;
}

function dayMs(day: string): number | null {
  const d = dateOnly(day);
  if (!d) return null;
  const ms = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Whole days from `from` to `to` (negative when `to` is earlier); null when either date is unparseable. */
export function daysBetween(from: string, to: string): number | null {
  const a = dayMs(from);
  const b = dayMs(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS);
}

/** Add (or subtract) days to a YYYY-MM-DD string. */
export function addDays(day: string, days: number): string {
  const ms = dayMs(day);
  if (ms === null) return day;
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Leak rate
// ---------------------------------------------------------------------------

export interface LeakRateInput {
  addedLbs: number;
  fullChargeLbs: number | null | undefined;
  /** Days since the previous add (or since installation for the first add); < 1 counts as 1, > 365 as 365. Null = unknown. */
  daysSinceLastAdd: number | null | undefined;
}

export interface LeakRateResult {
  ratePct: number | null;
  /** Days actually used in the formula (the shorter of the elapsed days or 365, floored at 1). */
  days: number | null;
  formula: string;
  reason?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Annualized leak rate per the EPA annualizing method (40 CFR 82.152 / 84.102 "leak rate"):
 * (added / fullCharge) × (365 / the shorter of the days since the last add or 365) × 100. Days below 1 are
 * treated as 1 (two adds on the same day). Null rate with a reason when the full charge or the days are
 * unknown or not positive.
 */
export function annualizedLeakRate(input: LeakRateInput): LeakRateResult {
  const formula = LEAK_RATE_FORMULA;
  const { addedLbs, fullChargeLbs, daysSinceLastAdd } = input;
  if (!(typeof addedLbs === "number" && Number.isFinite(addedLbs) && addedLbs > 0)) {
    return { ratePct: null, days: null, formula, reason: "amount added must be a positive number of pounds" };
  }
  if (!(typeof fullChargeLbs === "number" && Number.isFinite(fullChargeLbs) && fullChargeLbs > 0)) {
    return { ratePct: null, days: null, formula, reason: "full charge of the appliance is not recorded (set full_charge_lbs on the unit)" };
  }
  if (!(typeof daysSinceLastAdd === "number" && Number.isFinite(daysSinceLastAdd))) {
    return { ratePct: null, days: null, formula, reason: "days since the last add are unknown (no previous add and no installation date on record)" };
  }
  const days = Math.min(ANNUALIZING_MAX_DAYS, Math.max(1, daysSinceLastAdd));
  const ratePct = round2((addedLbs / fullChargeLbs) * (365 / days) * 100);
  return { ratePct, days, formula };
}

// ---------------------------------------------------------------------------
// Unit + event shapes the summary works on (rows are mapped to these by the store)
// ---------------------------------------------------------------------------

export interface ComplianceUnit {
  fullChargeLbs: number | null | undefined;
  applianceType: string | null | undefined;
  /** Independent circuits sharing the full charge equally; null/0 → 1. */
  circuitsCount: number | null | undefined;
  installYear?: number | null;
  refrigerant?: string | null;
}

export interface ComplianceEvent {
  id?: string;
  type: RefrigerantEventType;
  /** YYYY-MM-DD or ISO timestamp. */
  date: string;
  amountLbs?: number | null;
  circuit?: number | null;
  leakRatePct?: number | null;
  thresholdPct?: number | null;
  exceeded?: boolean | 0 | 1 | null;
  passed?: boolean | 0 | 1 | null;
  leakFound?: boolean | 0 | 1 | null;
  refrigerant?: string | null;
}

export function circuitsOf(unit: ComplianceUnit): number {
  const n = unit.circuitsCount;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.round(n) : 1;
}

/**
 * Charge of the appliance an add is measured against. EPA treats each independent circuit as its own
 * appliance, so an add logged on a circuit of a multi-circuit unit is compared with the full charge split
 * equally across `circuitsCount`; an add with no circuit is compared with the whole unit charge.
 */
export function applianceChargeLbs(unit: ComplianceUnit, circuit: number | null | undefined): number | null {
  const full = unit.fullChargeLbs;
  if (!(typeof full === "number" && Number.isFinite(full) && full > 0)) return null;
  const n = circuitsOf(unit);
  if (typeof circuit === "number" && Number.isFinite(circuit) && n > 1) return round2(full / n);
  return full;
}

export interface AddEvaluation {
  leakRatePct: number | null;
  thresholdPct: number;
  exceeded: boolean;
  days: number | null;
  applianceChargeLbs: number | null;
  /** Where the elapsed days came from ("previous_add_unit_level": a circuit add measured from an add logged with no circuit). */
  basis: "previous_add" | "previous_add_unit_level" | "install_year" | "none";
  previousAddDate: string | null;
  reason?: string;
  formula: string;
}

/**
 * Leak-rate evaluation of one add: elapsed days from the previous add on the same circuit or at unit level
 * (any circuit when the add has none; `previousAddUnitLevel` marks a circuit add measured from a unit-level
 * add), else from the middle of the install year (approximate, flagged), else unknown.
 */
export function evaluateAdd(input: { amountLbs: number; date: string; circuit?: number | null; previousAddDate?: string | null; previousAddUnitLevel?: boolean; unit: ComplianceUnit }): AddEvaluation {
  const { amountLbs, date, circuit, previousAddDate, previousAddUnitLevel, unit } = input;
  const thresholdPct = thresholdFor(unit.applianceType);
  const charge = applianceChargeLbs(unit, circuit);
  let basis: AddEvaluation["basis"] = "none";
  let days: number | null = null;
  let reason: string | undefined;
  if (previousAddDate) {
    days = daysBetween(previousAddDate, date);
    const unitLevel = previousAddUnitLevel === true && typeof circuit === "number";
    basis = unitLevel ? "previous_add_unit_level" : "previous_add";
    if (unitLevel) reason = `days counted from the previous add logged at unit level (no circuit) on ${dateOnly(previousAddDate)}`;
    if (days !== null && days < 0) {
      days = null;
      basis = "none";
      reason = "the add is dated before the previous add; enter events in date order";
    }
  } else if (typeof unit.installYear === "number" && Number.isFinite(unit.installYear)) {
    const installYear = Math.round(unit.installYear);
    days = daysBetween(`${installYear}-07-01`, date);
    basis = "install_year";
    reason = `no previous add on record; days counted from mid-${installYear} (install year) — approximate`;
    if (days !== null && days < 0) {
      days = null;
      basis = "none";
      const addYear = Number((dateOnly(date) ?? "").slice(0, 4));
      reason = installYear > addYear
        ? `install year ${installYear} is after the add date (${dateOnly(date)}); set the correct install_year`
        : `the add is dated before mid-${installYear} (install year), so the days since installation are unknown; the next add is annualized from this one`;
    }
  }
  const lr = annualizedLeakRate({ addedLbs: amountLbs, fullChargeLbs: charge, daysSinceLastAdd: days });
  const exceeded = lr.ratePct !== null && lr.ratePct > thresholdPct;
  return {
    leakRatePct: lr.ratePct,
    thresholdPct,
    exceeded,
    days: lr.days,
    applianceChargeLbs: charge,
    basis,
    previousAddDate: previousAddDate ?? null,
    reason: reason ?? lr.reason,
    formula: lr.formula,
  };
}

// ---------------------------------------------------------------------------
// Obligations
// ---------------------------------------------------------------------------

export type ObligationKind = "repair" | "verification_initial" | "verification_followup" | "retrofit_plan" | "inspection";

export interface Obligation {
  kind: ObligationKind;
  dueDate: string | null;
  text: string;
  overdue: boolean;
}

function truthy(v: boolean | 0 | 1 | null | undefined): boolean {
  return v === true || v === 1;
}

function sortedByDate(events: ComplianceEvent[]): ComplianceEvent[] {
  return [...events]
    .filter((e) => e && typeof e === "object" && typeof e.type === "string" && dateOnly(e.date) !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** A passed follow-up verification test or a retrofit/retirement plan closes the exceedance before it. */
function closesExceedance(e: ComplianceEvent): boolean {
  return (e.type === "verification_followup" && truthy(e.passed)) || e.type === "retrofit_plan";
}

/**
 * The open exceedance: the most recent add with exceeded = 1, unless a passed verification_followup or a
 * retrofit_plan is dated after it (same day counts). A later top-off below the threshold does not close it
 * (the repair / verification clock of 40 CFR 84.106(c)–(d) / 82.157(d)–(e) still runs). Undefined when none is open.
 */
export function openExceedance(events: ComplianceEvent[]): ComplianceEvent | undefined {
  const sorted = sortedByDate(events);
  let lastExceeded: ComplianceEvent | undefined;
  for (const e of sorted) if (e.type === "add" && truthy(e.exceeded)) lastExceeded = e;
  if (!lastExceeded) return undefined;
  const day = dateOnly(lastExceeded.date)!;
  return sorted.some((e) => closesExceedance(e) && e.date > day) ? undefined : lastExceeded;
}

/** The refrigerant the regime is judged by: the unit's, else the newest event that names one. */
function refrigerantOf(unit: ComplianceUnit, sorted: ComplianceEvent[]): string | null {
  if (typeof unit.refrigerant === "string" && unit.refrigerant.trim() !== "") return unit.refrigerant;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i]!.refrigerant;
    if (typeof r === "string" && r.trim() !== "") return r;
  }
  return null;
}

function latest(events: ComplianceEvent[], type: RefrigerantEventType, after?: string): ComplianceEvent | undefined {
  let best: ComplianceEvent | undefined;
  for (const e of events) {
    if (e.type !== type) continue;
    if (after !== undefined && !(e.date > after)) continue;
    best = e;
  }
  return best;
}

/**
 * Open obligations from the event history. While an exceedance is open (`openExceedance`): repair within 30 days
 * of that add, an initial verification test (passed) before refrigerant is added again, a follow-up verification
 * within 10 days of a passed initial test, and a retrofit/retirement plan once the repair deadline has passed
 * without a timely passed initial verification (none, or passed after the deadline) or after a failed follow-up.
 * After any exceedance on record the leak-inspection cadence applies (quarterly ≥ 500 lb, annual below) from the
 * last leak check; the four-clean-quarters reset is out of scope. Only when a rule applies (`applicability`:
 * HFC ≥ 15 lb, ODS ≥ 50 lb, not for GWP ≤ 53).
 */
export function nextObligations(events: ComplianceEvent[], unit: ComplianceUnit, today: string, lookup?: RefrigerantLookup): Obligation[] {
  const out: Obligation[] = [];
  const sorted = sortedByDate(events);
  const app = applicability(unit.fullChargeLbs, refrigerantOf(unit, sorted), lookup);
  if (!app.applies) return out;
  const adds = sorted.filter((e) => e.type === "add");
  const open = openExceedance(sorted);
  const todayDay = dateOnly(today) ?? today;
  const push = (kind: ObligationKind, dueDate: string | null, text: string): void => {
    out.push({ kind, dueDate, text, overdue: dueDate !== null && dueDate < todayDay });
  };

  if (open) {
    const exceedDate = dateOnly(open.date)!;
    const repairDue = addDays(exceedDate, REPAIR_DAYS);
    const repair = latest(sorted, "repair", exceedDate);
    const initial = latest(sorted, "verification_initial", exceedDate);
    const initialPassed = initial && truthy(initial.passed) ? initial : undefined;
    const followup = initialPassed ? latest(sorted, "verification_followup", initialPassed.date) : undefined;
    const followupFailed = followup !== undefined && !truthy(followup.passed);
    const rate = typeof open.leakRatePct === "number" ? `${open.leakRatePct} %` : "the threshold";
    const threshold = typeof open.thresholdPct === "number" ? `${open.thresholdPct} %` : `${thresholdFor(unit.applianceType)} %`;
    if (!repair) {
      push("repair", repairDue, `Repair within ${REPAIR_DAYS} days of ${exceedDate} (leak rate ${rate} exceeds ${threshold}; by ${repairDue}, ${REPAIR_DAYS_SHUTDOWN} days when a shutdown is required)`);
    }
    if (!initialPassed) {
      const due = repair ? dateOnly(repair.date) : repairDue;
      push("verification_initial", due, `Initial verification test before adding refrigerant${repair ? ` (repair logged ${dateOnly(repair.date)}; test not yet passed)` : " (after the repair)"}`);
    } else {
      const initDate = dateOnly(initialPassed.date)!;
      push("verification_followup", addDays(initDate, FOLLOWUP_VERIFICATION_DAYS), `Follow-up verification test within ${FOLLOWUP_VERIFICATION_DAYS} days of the initial test (${initDate}) with the appliance at normal operating conditions${followupFailed ? ` (the ${dateOnly(followup!.date)} follow-up test failed)` : ""}`);
    }
    // 40 CFR 84.106(h) / 82.157(h): a plan is due when the appliance is not repaired (verified) by the deadline.
    const initialLate = initialPassed !== undefined && dateOnly(initialPassed.date)! > repairDue;
    if (todayDay > repairDue && (!initialPassed || initialLate || followupFailed)) {
      const why = !initialPassed ? "with no passed verification test" : initialLate ? `and the initial verification passed only on ${dateOnly(initialPassed.date)}, after the deadline` : "and the follow-up verification test failed";
      push("retrofit_plan", addDays(repairDue, REPAIR_DAYS), `Retrofit or retirement plan: the ${exceedDate} exceedance is older than ${REPAIR_DAYS} days ${why} — EPA requires a plan within ${REPAIR_DAYS} days of the repair deadline (${repairDue}) and completion within 1 year`);
    }
  }

  const everExceeded = adds.some((e) => truthy(e.exceeded));
  if (everExceeded) {
    const full = unit.fullChargeLbs as number;
    const quarterly = full >= INSPECTION_QUARTERLY_LBS;
    const interval = quarterly ? INSPECTION_QUARTERLY_DAYS : INSPECTION_ANNUAL_DAYS;
    const cadence = quarterly ? `Quarterly leak inspection (charge ≥ ${INSPECTION_QUARTERLY_LBS} lb)` : `Annual leak inspection (charge ${app.thresholdLbs ?? HFC_APPLICABILITY_LBS}–${INSPECTION_QUARTERLY_LBS - 1} lb)`;
    const lastCheck = latest(sorted, "leak_check");
    if (lastCheck) {
      const lastDate = dateOnly(lastCheck.date)!;
      push("inspection", addDays(lastDate, interval), `${cadence}: next due ${addDays(lastDate, interval)} (last leak check ${lastDate}${truthy(lastCheck.leakFound) ? ", leak found" : ""}); required after an exceedance until four consecutive clean quarterly / one clean annual inspection`);
    } else {
      push("inspection", null, `${cadence}: none on record — schedule one; required after an exceedance until four consecutive clean quarterly / one clean annual inspection`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summary for the unit card / tools / reports
// ---------------------------------------------------------------------------

export interface ComplianceSummary {
  applies: boolean;
  fullChargeLbs: number | null;
  applianceType: ApplianceType | null;
  thresholdPct: number;
  circuitsCount: number;
  /** Charge each circuit is measured against (full charge ÷ circuits). */
  circuitChargeLbs: number | null;
  /** Which rule covers the appliance (`applicability`) and the full charge it applies from (null: not covered). */
  regime: ComplianceRegime;
  applicabilityLbs: number | null;
  lastAdd: { id?: string; date: string; amountLbs: number | null; circuit: number | null; refrigerant: string | null; leakRatePct: number | null; exceeded: boolean } | null;
  /** The open exceedance (`openExceedance`) that drives the repair / verification / retrofit obligations; null when none. */
  openExceedance: { id?: string; date: string; amountLbs: number | null; circuit: number | null; leakRatePct: number | null; thresholdPct: number | null } | null;
  /** The open exceedance's rate when one is open, else the last add's. */
  lastLeakRatePct: number | null;
  /** True while an exceedance is open (not just when the last add exceeded). */
  exceeded: boolean;
  obligations: Obligation[];
  formula: string;
  source: string;
  notes: string[];
}

export function complianceSummary(events: ComplianceEvent[], unit: ComplianceUnit, today: string, lookup?: RefrigerantLookup): ComplianceSummary {
  const sorted = sortedByDate(events);
  const adds = sorted.filter((e) => e.type === "add");
  const last = adds[adds.length - 1];
  const full = typeof unit.fullChargeLbs === "number" && Number.isFinite(unit.fullChargeLbs) ? unit.fullChargeLbs : null;
  const applianceType = APPLIANCE_TYPES.includes(unit.applianceType as ApplianceType) ? (unit.applianceType as ApplianceType) : null;
  const notes: string[] = [];
  const app = applicability(full, refrigerantOf(unit, sorted), lookup);
  const on = app.applies;
  if (full === null) notes.push("Full charge not recorded: set full_charge_lbs (and appliance_type, circuits_count) on the unit to compute leak rates.");
  if (app.regime === "not_covered") notes.push(app.note!);
  else if (app.regime === "ods") {
    if (full !== null && !on) notes.push(`${app.refrigerantId} is an ozone-depleting refrigerant: the leak-repair rule (40 CFR 82.157) applies from ${ODS_APPLICABILITY_LBS} lb and the full charge ${full} lb is below it. Leak rates are still computed for the record.`);
  } else {
    if (full !== null && !on) notes.push(`Full charge ${full} lb is below the ${HFC_APPLICABILITY_LBS} lb HFC threshold (40 CFR 84.106); ODS appliances (R-22) are regulated from ${ODS_APPLICABILITY_LBS} lb (40 CFR 82.157). Leak rates are still computed for the record.`);
    if (app.regime === "unknown") notes.push(app.note!);
  }
  if (applianceType === null) notes.push("Appliance type not set: the 10 % comfort-cooling threshold is assumed (20 % commercial refrigeration, 30 % industrial process).");
  const circuits = circuitsOf(unit);
  if (circuits > 1) notes.push(`${circuits} circuits: an add logged against a circuit is measured against the full charge ÷ ${circuits} (EPA treats each independent circuit as its own appliance).`);
  const lastAdd = last
    ? {
        id: last.id,
        date: dateOnly(last.date) ?? last.date,
        amountLbs: typeof last.amountLbs === "number" ? last.amountLbs : null,
        circuit: typeof last.circuit === "number" ? last.circuit : null,
        refrigerant: last.refrigerant ?? null,
        leakRatePct: typeof last.leakRatePct === "number" ? last.leakRatePct : null,
        exceeded: truthy(last.exceeded),
      }
    : null;
  const open = openExceedance(sorted);
  const openView = open
    ? {
        id: open.id,
        date: dateOnly(open.date) ?? open.date,
        amountLbs: typeof open.amountLbs === "number" ? open.amountLbs : null,
        circuit: typeof open.circuit === "number" ? open.circuit : null,
        leakRatePct: typeof open.leakRatePct === "number" ? open.leakRatePct : null,
        thresholdPct: typeof open.thresholdPct === "number" ? open.thresholdPct : null,
      }
    : null;
  return {
    applies: on,
    fullChargeLbs: full,
    applianceType,
    thresholdPct: thresholdFor(unit.applianceType),
    circuitsCount: circuits,
    circuitChargeLbs: full === null ? null : round2(full / circuits),
    regime: app.regime,
    applicabilityLbs: app.thresholdLbs,
    lastAdd,
    openExceedance: openView,
    lastLeakRatePct: openView ? openView.leakRatePct : (lastAdd?.leakRatePct ?? null),
    exceeded: openView !== null,
    obligations: nextObligations(sorted, unit, today, lookup),
    formula: LEAK_RATE_FORMULA,
    source: LEAK_RATE_SOURCE,
    notes,
  };
}
