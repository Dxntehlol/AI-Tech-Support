/**
 * Refrigerant log / compliance helpers shared by the routes, the assistant tools and the reports (kept
 * outside routes/ so agent/tools.ts can import it without a routes/util.ts ↔ agent/tools.ts cycle).
 */
import type { Repos } from "./db/repos.ts";
import { complianceSummary, type ComplianceEvent, type ComplianceSummary, type RefrigerantLookup } from "./knowledge/refrigerantCompliance.ts";
import type { RefrigerantEventRow, UnitRow } from "./types.ts";

/** Rows considered for the compliance summary (newest first from the repo). */
export const COMPLIANCE_WINDOW = 500;

export function toComplianceEvent(row: RefrigerantEventRow): ComplianceEvent {
  return {
    id: row.id,
    type: row.event_type,
    date: row.created_at,
    amountLbs: row.amount_lbs,
    circuit: row.circuit,
    leakRatePct: row.leak_rate_pct,
    thresholdPct: row.threshold_pct,
    exceeded: row.exceeded,
    passed: row.passed,
    leakFound: row.leak_found,
    refrigerant: row.refrigerant,
  };
}

/** Event as the API returns it (booleans instead of 0/1, date for display). */
export interface RefrigerantEventView {
  id: string;
  unit_id: string;
  conversation_id: string | null;
  created_at: string;
  date: string;
  event_type: RefrigerantEventRow["event_type"];
  refrigerant: string | null;
  amount_lbs: number | null;
  circuit: number | null;
  cylinder_id: string | null;
  tech_name: string | null;
  tech_cert: string | null;
  leak_found: boolean | null;
  passed: boolean | null;
  note: string | null;
  leak_rate_pct: number | null;
  threshold_pct: number | null;
  exceeded: boolean | null;
  finding_id: string | null;
}

function flag(v: 0 | 1 | null): boolean | null {
  return v === null || v === undefined ? null : v === 1;
}

export function refrigerantEventView(row: RefrigerantEventRow): RefrigerantEventView {
  return {
    id: row.id,
    unit_id: row.unit_id,
    conversation_id: row.conversation_id,
    created_at: row.created_at,
    date: row.created_at.slice(0, 10),
    event_type: row.event_type,
    refrigerant: row.refrigerant,
    amount_lbs: row.amount_lbs,
    circuit: row.circuit,
    cylinder_id: row.cylinder_id,
    tech_name: row.tech_name,
    tech_cert: row.tech_cert,
    leak_found: flag(row.leak_found),
    passed: flag(row.passed),
    note: row.note,
    leak_rate_pct: row.leak_rate_pct,
    threshold_pct: row.threshold_pct,
    exceeded: flag(row.exceeded),
    finding_id: row.finding_id,
  };
}

/**
 * The compliance object for a unit (GET /api/units/:id `compliance`, the refrigerant log route, tools, reports).
 * `lookup` resolves the unit's refrigerant to its id / GWP for the applicability (pass
 * `complianceRefrigerantLookup(kb)`; without it the HFC 15 lb rule is assumed unless the id is a known ODS).
 */
export function unitCompliance(repos: Repos, unit: UnitRow, today: string, events?: RefrigerantEventRow[], lookup?: RefrigerantLookup): ComplianceSummary {
  const rows = events ?? repos.refrigerantEvents.list({ unitId: unit.id, limit: COMPLIANCE_WINDOW });
  return complianceSummary(rows.map(toComplianceEvent), {
    fullChargeLbs: unit.full_charge_lbs ?? null,
    applianceType: unit.appliance_type ?? null,
    circuitsCount: unit.circuits_count ?? null,
    installYear: unit.install_year,
    refrigerant: unit.refrigerant,
  }, today, lookup);
}

/**
 * RFC 4180 CSV: fields with a comma, quote, CR or LF are quoted and inner quotes doubled; rows end in CRLF.
 * Spreadsheet formula injection (OWASP "CSV injection"): a string field starting with = + - @ tab or CR gets a
 * leading single quote and is quoted, so Excel / Sheets show it as text instead of evaluating it. Numbers
 * (a negative amount) are left alone.
 */
export function csvLine(fields: unknown[]): string {
  return fields
    .map((f) => {
      if (f === null || f === undefined) return "";
      let s = String(f);
      let quote = /[",\r\n]/.test(s);
      if (typeof f !== "number" && /^[=+\-@\t\r]/.test(s)) {
        s = `'${s}`;
        quote = true;
      }
      return quote ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

/** Most events one CSV export holds (the repo's listAll ceiling); a trailing row says so when it is reached. */
export const REFRIGERANT_CSV_CAP = 50_000;

export const REFRIGERANT_CSV_COLUMNS = [
  "date",
  "site",
  "unit_tag",
  "nickname",
  "model",
  "serial",
  "event_type",
  "refrigerant",
  "amount_lbs",
  "circuit",
  "cylinder_id",
  "tech_name",
  "tech_cert",
  "leak_found",
  "passed",
  "leak_rate_pct",
  "threshold_pct",
  "exceeded",
  "note",
  "unit_id",
  "event_id",
] as const;

/** The whole refrigerant log as CSV text (every event joined with its unit, oldest first). `cap` is for tests. */
export function refrigerantLogCsv(repos: Repos, cap: number = REFRIGERANT_CSV_CAP): string {
  const yn = (v: 0 | 1 | null): string => (v === null || v === undefined ? "" : v === 1 ? "yes" : "no");
  const lines = [csvLine([...REFRIGERANT_CSV_COLUMNS])];
  const rows = repos.refrigerantEvents.listAll({ limit: cap });
  for (const e of rows) {
    lines.push(
      csvLine([
        e.created_at.slice(0, 10),
        e.unit_site,
        e.unit_tag,
        e.unit_nickname,
        e.unit_model,
        e.unit_serial,
        e.event_type,
        e.refrigerant,
        e.amount_lbs,
        e.circuit,
        e.cylinder_id,
        e.tech_name,
        e.tech_cert,
        yn(e.leak_found),
        yn(e.passed),
        e.leak_rate_pct,
        e.threshold_pct,
        yn(e.exceeded),
        e.note,
        e.unit_id,
        e.id,
      ]),
    );
  }
  if (rows.length >= cap) {
    lines.push(csvLine([`TRUNCATED: export stopped at the ${cap}-event cap; events after ${rows[rows.length - 1]?.created_at.slice(0, 10) ?? "the last row"} are not included`]));
  }
  return `${lines.join("\r\n")}\r\n`;
}
