/**
 * Readings trend: compare two saved readings on the same unit and name the deltas a tech would care about.
 * Pure (no I/O): `compareReadings(prev, cur)` returns notable deltas with one plain-English line each, and
 * only compares rows taken in the same mode with outdoor ambient within TREND_AMBIENT_WINDOW_F.
 */
import type { DxDerived, DxMeasurements, ReadingRow } from "../types.ts";

/** Outdoor dry-bulb difference beyond which two readings are not compared (head pressure moves with ambient). */
export const TREND_AMBIENT_WINDOW_F = 15;

/** What compareReadings needs from a reading (a ReadingRow converts with `toTrendReading`). */
export interface TrendReading {
  id?: string;
  created_at: string;
  mode: string;
  measurements: Partial<DxMeasurements> | null | undefined;
  derived: Partial<DxDerived> | null | undefined;
}

export type TrendMetric = "superheatF" | "subcoolingF" | "condSatF" | "evapSatF" | "deltaTF" | "ampsPercentRla" | "suctionPsig" | "liquidPsig";

export interface TrendDelta {
  metric: TrendMetric;
  label: string;
  unit: string;
  prev: number;
  cur: number;
  /** cur − prev, rounded to one decimal. */
  delta: number;
  direction: "up" | "down";
  /** What the direction usually means, in field language. */
  hint: string;
  /** "Subcooling fell from 12 to 4 °F since 2026-08-02 (same mode) - charge loss or restriction trend" */
  line: string;
}

export interface TrendResult {
  /** The row the newest reading was compared against (its id when known). */
  prevId?: string;
  since: string; // YYYY-MM-DD of the previous reading
  mode: string;
  deltas: TrendDelta[];
  /** Plain-English lines, one per delta (same order). */
  lines: string[];
}

interface MetricSpec {
  metric: TrendMetric;
  label: string;
  unit: string;
  /** Minimum absolute change to report. */
  minAbs: number;
  /** Alternatively, minimum relative change (fraction of prev) when prev is large. */
  minRel?: number;
  get(r: TrendReading): number | undefined;
  up: string;
  down: string;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const d = (r: TrendReading, k: keyof DxDerived) => num(r.derived?.[k]);
const m = (r: TrendReading, k: keyof DxMeasurements) => num(r.measurements?.[k]);

/** Amps vs RLA: prefer the engine's %RLA; fall back to amps/RLA from the measurements when both are present. */
function ampsPercentRla(r: TrendReading): number | undefined {
  const pct = d(r, "ampsPercentRla");
  if (pct !== undefined) return pct;
  const amps = m(r, "compressorAmps");
  const rla = m(r, "compressorRla");
  if (amps === undefined || rla === undefined || rla <= 0) return undefined;
  return Math.round((amps / rla) * 1000) / 10;
}

const SPECS: MetricSpec[] = [
  {
    metric: "superheatF",
    label: "Superheat",
    unit: "°F",
    minAbs: 4,
    get: (r) => d(r, "superheatF"),
    up: "charge loss, restriction or starving TXV trend",
    down: "overfeeding, overcharge or low-load trend (watch for floodback)",
  },
  {
    metric: "subcoolingF",
    label: "Subcooling",
    unit: "°F",
    minAbs: 3,
    get: (r) => d(r, "subcoolingF"),
    up: "charge gain or condenser backing up (overcharge / non-condensables) trend",
    down: "charge loss or restriction trend",
  },
  {
    metric: "condSatF",
    label: "Condensing temp",
    unit: "°F",
    minAbs: 5,
    get: (r) => d(r, "condSatF"),
    up: "condenser heat rejection falling (dirty coil, fan, recirculation) or overcharge trend",
    down: "lower head pressure: lighter charge or load, or head-pressure control change",
  },
  {
    metric: "evapSatF",
    label: "Evaporating temp",
    unit: "°F",
    minAbs: 4,
    get: (r) => d(r, "evapSatF"),
    up: "higher load or lower compressor capacity trend",
    down: "airflow or charge falling trend (check filters, coil, charge)",
  },
  {
    metric: "deltaTF",
    label: "Delta-T",
    unit: "°F",
    minAbs: 3,
    get: (r) => d(r, "deltaTF"),
    up: "more temperature split: airflow falling or load change",
    down: "capacity loss trend (charge, airflow or compressor)",
  },
  {
    metric: "ampsPercentRla",
    label: "Compressor amps",
    unit: "% RLA",
    minAbs: 10,
    get: ampsPercentRla,
    up: "load or head pressure rising, or compressor wear trend",
    down: "pumping less: undercharge, low load or compressor wear trend",
  },
  {
    metric: "suctionPsig",
    label: "Suction pressure",
    unit: "psig",
    minAbs: 5,
    minRel: 0.08,
    get: (r) => m(r, "suctionPsig"),
    up: "higher evaporator load or weaker compressor trend",
    down: "airflow or charge falling trend",
  },
  {
    metric: "liquidPsig",
    label: "Liquid pressure",
    unit: "psig",
    minAbs: 15,
    minRel: 0.05,
    get: (r) => m(r, "liquidPsig"),
    up: "head pressure climbing: condenser airflow, overcharge or non-condensables trend",
    down: "head pressure falling: lighter charge or load trend",
  },
];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round1(n));
}

export function dateOnly(iso: string | null | undefined): string {
  if (typeof iso !== "string") return "an earlier visit";
  const mm = /^(\d{4}-\d{2}-\d{2})/.exec(iso.trim());
  return mm ? mm[1]! : iso.trim() || "an earlier visit";
}

export const MODE_LABEL: Record<string, string> = {
  ac_cooling: "AC cooling",
  heat_pump_cooling: "heat pump cooling",
  heat_pump_heating: "heat pump heating",
  refrigeration: "refrigeration",
  chiller: "chiller",
};

/**
 * Whether two readings are comparable: same mode, and outdoor dry-bulb known on both and within the window.
 * Returns the reason when not.
 */
export function readingsComparable(prev: TrendReading, cur: TrendReading): { ok: true } | { ok: false; reason: string } {
  if (!prev || !cur) return { ok: false, reason: "missing reading" };
  if (prev.mode !== cur.mode) return { ok: false, reason: `different mode (${MODE_LABEL[prev.mode] ?? prev.mode} vs ${MODE_LABEL[cur.mode] ?? cur.mode})` };
  const a = m(prev, "outdoorDbF");
  const b = m(cur, "outdoorDbF");
  if (a === undefined || b === undefined) return { ok: false, reason: "outdoor temperature not recorded on both readings" };
  if (Math.abs(a - b) > TREND_AMBIENT_WINDOW_F) return { ok: false, reason: `outdoor temperature differs by ${fmt(Math.abs(a - b))} °F (more than ${TREND_AMBIENT_WINDOW_F})` };
  return { ok: true };
}

/**
 * Notable deltas from `prev` to `cur`. Empty when the readings are not comparable (different mode, ambient
 * unknown or more than TREND_AMBIENT_WINDOW_F apart) or nothing moved beyond its threshold.
 */
export function compareReadings(prev: TrendReading, cur: TrendReading): TrendDelta[] {
  if (!readingsComparable(prev, cur).ok) return [];
  const since = dateOnly(prev.created_at);
  const out: TrendDelta[] = [];
  for (const spec of SPECS) {
    const a = spec.get(prev);
    const b = spec.get(cur);
    if (a === undefined || b === undefined) continue;
    const delta = round1(b - a);
    const abs = Math.abs(delta);
    let threshold = spec.minAbs;
    if (spec.minRel !== undefined && Math.abs(a) > 0) threshold = Math.max(spec.minAbs, Math.abs(a) * spec.minRel);
    if (abs < threshold) continue;
    const direction: "up" | "down" = delta > 0 ? "up" : "down";
    const verb = direction === "up" ? "rose" : "fell";
    const hint = direction === "up" ? spec.up : spec.down;
    const line = `${spec.label} ${verb} from ${fmt(a)} to ${fmt(b)} ${spec.unit} since ${since} (same mode) - ${hint}`;
    out.push({ metric: spec.metric, label: spec.label, unit: spec.unit, prev: round1(a), cur: round1(b), delta, direction, hint, line });
  }
  return out;
}

function parseJson(text: string | null | undefined): unknown {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A stored ReadingRow as compareReadings input (malformed JSON → empty objects). */
export function toTrendReading(row: ReadingRow): TrendReading {
  const meas = parseJson(row.measurements_json);
  const der = parseJson(row.derived_json);
  return {
    id: row.id,
    created_at: row.created_at,
    mode: row.mode,
    measurements: meas && typeof meas === "object" ? (meas as Partial<DxMeasurements>) : null,
    derived: der && typeof der === "object" ? (der as Partial<DxDerived>) : null,
  };
}

/**
 * Trend for a unit's readings (newest first, as repos.readings.list returns them): the newest row against the
 * most recent earlier row it is comparable with. Null when there is no comparable pair or nothing notable.
 */
export function trendFromReadings(rows: ReadingRow[]): TrendResult | null {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const sorted = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  const cur = toTrendReading(sorted[0]!);
  for (const row of sorted.slice(1)) {
    const prev = toTrendReading(row);
    if (!readingsComparable(prev, cur).ok) continue;
    const deltas = compareReadings(prev, cur);
    if (deltas.length === 0) return null;
    return { prevId: row.id, since: dateOnly(row.created_at), mode: cur.mode, deltas, lines: deltas.map((x) => x.line) };
  }
  return null;
}
