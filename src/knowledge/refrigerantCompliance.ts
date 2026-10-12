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
 *  - Leak-rate formula ("annualizing method", 40 CFR 82.152 / 84.102 definition of "leak rate"):
 *      leak rate % = (lb added / full charge lb) × (365 / days since the last add) × 100.
 *    EPA worked example: 25 lb added to a 400 lb rack 60 days after the previous add = 38.02 % per year.
 *
 * Everything date-based uses YYYY-MM-DD strings (an ISO timestamp is reduced to its date) and a `today`
 * parameter; nothing here reads the clock.
 */
import type { ApplianceType, RefrigerantEventType } from "../types.ts";

export const LEAK_RATE_FORMULA = "leak rate % = (lb added ÷ full charge lb) × (365 ÷ days since last add) × 100";
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

/** Whether the HFC leak-repair rule applies: full charge ≥ 15 lb (ODS appliances: ≥ 50 lb, see `appliesOds`). */
export function applies(fullChargeLbs: number | null | undefined): boolean {
  return typeof fullChargeLbs === "number" && Number.isFinite(fullChargeLbs) && fullChargeLbs >= HFC_APPLICABILITY_LBS;
}

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
  /** Days since the previous add (or since installation for the first add); < 1 counts as 1. Null = unknown. */
  daysSinceLastAdd: number | null | undefined;
}

export interface LeakRateResult {
  ratePct: number | null;
  /** Days actually used in the formula (after the < 1 → 1 floor). */
  days: number | null;
  formula: string;
  reason?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Annualized leak rate per the EPA method: (added / fullCharge) × (365 / days) × 100. Days below 1 are
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
  const days = Math.max(1, daysSinceLastAdd);
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
  /** Where the elapsed days came from. */
  basis: "previous_add" | "install_year" | "none";
  previousAddDate: string | null;
  reason?: string;
  formula: string;
}

/**
 * Leak-rate evaluation of one add: elapsed days from the previous add on the same circuit (any circuit when
 * the add has none), else from the middle of the install year (approximate, flagged), else unknown.
 */
export function evaluateAdd(input: { amountLbs: number; date: string; circuit?: number | null; previousAddDate?: string | null; unit: ComplianceUnit }): AddEvaluation {
  const { amountLbs, date, circuit, previousAddDate, unit } = input;
  const thresholdPct = thresholdFor(unit.applianceType);
  const charge = applianceChargeLbs(unit, circuit);
  let basis: AddEvaluation["basis"] = "none";
  let days: number | null = null;
  let reason: string | undefined;
  if (previousAddDate) {
    days = daysBetween(previousAddDate, date);
    basis = "previous_add";
  } else if (typeof unit.installYear === "number" && Number.isFinite(unit.installYear)) {
    days = daysBetween(`${unit.installYear}-07-01`, date);
    basis = "install_year";
    reason = `no previous add on record; days counted from mid-${unit.installYear} (install year) — approximate`;
  }
  if (days !== null && days < 0) {
    days = null;
    basis = "none";
    reason = "the add is dated before the previous add; enter events in date order";
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
 * Open obligations from the event history. When the latest add exceeded its threshold: repair within 30 days
 * of that add, an initial verification test (passed) before refrigerant is added again, a follow-up
 * verification within 10 days of a passed initial test, and a retrofit/retirement plan when the exceedance is
 * more than 30 days old with no passed verification. After any exceedance on record the leak-inspection cadence
 * applies (quarterly ≥ 500 lb, annual 15–499 lb) from the last leak check; the four-clean-quarters reset is out
 * of scope. Only when the rule applies (charge ≥ 15 lb).
 */
export function nextObligations(events: ComplianceEvent[], unit: ComplianceUnit, today: string): Obligation[] {
  const out: Obligation[] = [];
  if (!applies(unit.fullChargeLbs)) return out;
  const sorted = sortedByDate(events);
  const adds = sorted.filter((e) => e.type === "add");
  const lastAdd = adds[adds.length - 1];
  const todayDay = dateOnly(today) ?? today;
  const push = (kind: ObligationKind, dueDate: string | null, text: string): void => {
    out.push({ kind, dueDate, text, overdue: dueDate !== null && dueDate < todayDay });
  };

  if (lastAdd && truthy(lastAdd.exceeded)) {
    const exceedDate = dateOnly(lastAdd.date)!;
    const repairDue = addDays(exceedDate, REPAIR_DAYS);
    const repair = latest(sorted, "repair", exceedDate);
    const initial = latest(sorted, "verification_initial", exceedDate);
    const initialPassed = initial && truthy(initial.passed) ? initial : undefined;
    const followup = initialPassed ? latest(sorted, "verification_followup", initialPassed.date) : undefined;
    const followupPassed = followup && truthy(followup.passed) ? followup : undefined;
    const rate = typeof lastAdd.leakRatePct === "number" ? `${lastAdd.leakRatePct} %` : "the threshold";
    const threshold = typeof lastAdd.thresholdPct === "number" ? `${lastAdd.thresholdPct} %` : `${thresholdFor(unit.applianceType)} %`;
    if (!repair) {
      push("repair", repairDue, `Repair within ${REPAIR_DAYS} days of ${exceedDate} (leak rate ${rate} exceeds ${threshold}; by ${repairDue}, ${REPAIR_DAYS_SHUTDOWN} days when a shutdown is required)`);
    }
    if (!initialPassed) {
      const due = repair ? dateOnly(repair.date) : repairDue;
      push("verification_initial", due, `Initial verification test before adding refrigerant${repair ? ` (repair logged ${dateOnly(repair.date)}; test not yet passed)` : " (after the repair)"}`);
    } else if (!followupPassed) {
      const initDate = dateOnly(initialPassed.date)!;
      push("verification_followup", addDays(initDate, FOLLOWUP_VERIFICATION_DAYS), `Follow-up verification test within ${FOLLOWUP_VERIFICATION_DAYS} days of the initial test (${initDate}) with the appliance at normal operating conditions`);
    }
    const planLogged = latest(sorted, "retrofit_plan", exceedDate);
    if (!followupPassed && !planLogged && todayDay > repairDue) {
      push("retrofit_plan", addDays(repairDue, REPAIR_DAYS), `Retrofit or retirement plan: the ${exceedDate} exceedance is older than ${REPAIR_DAYS} days with no passed verification test — EPA requires a plan within ${REPAIR_DAYS} days of the repair deadline (${repairDue}) and completion within 1 year`);
    }
  }

  const everExceeded = adds.some((e) => truthy(e.exceeded));
  if (everExceeded) {
    const full = unit.fullChargeLbs as number;
    const quarterly = full >= INSPECTION_QUARTERLY_LBS;
    const interval = quarterly ? INSPECTION_QUARTERLY_DAYS : INSPECTION_ANNUAL_DAYS;
    const cadence = quarterly ? `Quarterly leak inspection (charge ≥ ${INSPECTION_QUARTERLY_LBS} lb)` : `Annual leak inspection (charge ${HFC_APPLICABILITY_LBS}–${INSPECTION_QUARTERLY_LBS - 1} lb)`;
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
  lastAdd: { id?: string; date: string; amountLbs: number | null; circuit: number | null; refrigerant: string | null; leakRatePct: number | null; exceeded: boolean } | null;
  lastLeakRatePct: number | null;
  exceeded: boolean;
  obligations: Obligation[];
  formula: string;
  source: string;
  notes: string[];
}

export function complianceSummary(events: ComplianceEvent[], unit: ComplianceUnit, today: string): ComplianceSummary {
  const sorted = sortedByDate(events);
  const adds = sorted.filter((e) => e.type === "add");
  const last = adds[adds.length - 1];
  const full = typeof unit.fullChargeLbs === "number" && Number.isFinite(unit.fullChargeLbs) ? unit.fullChargeLbs : null;
  const applianceType = APPLIANCE_TYPES.includes(unit.applianceType as ApplianceType) ? (unit.applianceType as ApplianceType) : null;
  const notes: string[] = [];
  const on = applies(full);
  if (full === null) notes.push("Full charge not recorded: set full_charge_lbs (and appliance_type, circuits_count) on the unit to compute leak rates.");
  else if (!on) notes.push(`Full charge ${full} lb is below the ${HFC_APPLICABILITY_LBS} lb HFC threshold (40 CFR 84.106); ODS appliances (R-22) are regulated from ${ODS_APPLICABILITY_LBS} lb (40 CFR 82.157). Leak rates are still computed for the record.`);
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
  return {
    applies: on,
    fullChargeLbs: full,
    applianceType,
    thresholdPct: thresholdFor(unit.applianceType),
    circuitsCount: circuits,
    circuitChargeLbs: full === null ? null : round2(full / circuits),
    lastAdd,
    lastLeakRatePct: lastAdd?.leakRatePct ?? null,
    exceeded: lastAdd?.exceeded ?? false,
    obligations: nextObligations(sorted, unit, today),
    formula: LEAK_RATE_FORMULA,
    source: LEAK_RATE_SOURCE,
    notes,
  };
}
