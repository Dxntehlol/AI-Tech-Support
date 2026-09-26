import type { DxMeasurements, KnowledgeBase, PtLookupResult, RefrigerantMeta, RefrigerantTable } from "../types.ts";

/** Standard sea-level atmospheric pressure, psia. */
export const SEA_LEVEL_PATM_PSIA = 14.696;

/** Local atmospheric pressure (psia) at an elevation in feet (ISA barometric formula). */
export function patmPsia(elevationFt: number | undefined): number {
  const ft = Number.isFinite(elevationFt) ? (elevationFt as number) : 0;
  if (ft <= 0) return SEA_LEVEL_PATM_PSIA;
  const p = SEA_LEVEL_PATM_PSIA * Math.pow(1 - 6.8754e-6 * ft, 5.2559);
  return Math.round(p * 1000) / 1000;
}

/** Field gauge reading (psig at elevation) -> sea-level-basis psig that the PT table is built on. */
export function fieldToSeaLevelPsig(psig: number, elevationFt: number | undefined): number {
  return psig + (SEA_LEVEL_PATM_PSIA - patmPsia(elevationFt));
}

/** Sea-level-basis psig (from the PT table) -> what a field gauge reads at elevation. */
export function seaLevelToFieldPsig(psigSeaLevel: number, elevationFt: number | undefined): number {
  return psigSeaLevel - (SEA_LEVEL_PATM_PSIA - patmPsia(elevationFt));
}

/** inHg vacuum for a sub-atmospheric gauge reading (psig < 0); 0 when at/above atmospheric. */
export function inHgVacuum(psig: number): number {
  if (!(psig < 0)) return 0;
  return round1(-psig * 2.036);
}

/** One-line handling reminder for flammable classes; undefined for A1/B1 and unknown. */
export function safetyReminder(safetyClass: string | undefined): string | undefined {
  const sc = (safetyClass ?? "").toUpperCase();
  if (sc === "A2L" || sc === "B2L") {
    return `${sc} (mildly flammable): ventilate, no ignition sources, A2L-rated leak detector and recovery machine, left-hand-thread cylinders, purge with nitrogen before brazing; never retrofit into A1 equipment.`;
  }
  if (sc === "A2" || sc === "A3" || sc === "B2" || sc === "B3") {
    return `${sc} (flammable): treat as a flammable gas — ventilate, no ignition sources or open flame nearby, rated detector and recovery equipment, charge limits per the equipment listing.`;
  }
  if (sc.startsWith("B")) {
    return `${sc} (higher toxicity): ventilate, monitor, respiratory protection per the SDS.`;
  }
  return undefined;
}

/** Canonical form of a refrigerant designation: "r410a", "410-A", "R 410A" -> "R-410A"; "1234ze(e)" -> "R-1234ZE(E)". */
export function canonicalRefrigerantId(input: string): string {
  let s = input.trim().toUpperCase().replace(/\s+/g, "");
  s = s.replace(/^(R|HFC|HCFC|CFC|HFO|FREON)-?/, "");
  s = s.replace(/^-+/, "");
  // "410-A" -> "410A"
  s = s.replace(/^(\d+)-([A-Z])$/, "$1$2");
  if (!s) return "";
  // Preserve mixed-case forms like "R-134a", "R-1234yf", "R-1234ze(E)", "R-1233zd(E)", "R-245fa", "R-152a", "R-600a"
  const m = /^(\d+)([A-Z]*)(\([A-Z]\))?$/.exec(s);
  if (!m) return `R-${s}`;
  const num = m[1]!;
  let suffix = m[2] ?? "";
  const iso = m[3] ?? "";
  if (suffix.length > 0 && !(suffix.length === 1 && /^\d{3}$/.test(num) && /^[A-Z]$/.test(suffix) && Number(num) >= 400 && Number(num) < 600)) {
    // isomer/lettered suffixes are lowercase in ASHRAE style (134a, 245fa, 1234yf, 600a)
    suffix = suffix.toLowerCase();
  }
  return `R-${num}${suffix}${iso}`;
}

/** Resolve user input like "410a", "R410A", "Puron" to the refrigerant metadata. */
export function resolveRefrigerant(kb: KnowledgeBase, input: string): RefrigerantMeta | undefined {
  if (!input) return undefined;
  const raw = input.trim().toLowerCase();
  const canon = canonicalRefrigerantId(input).toUpperCase();
  for (const m of kb.refrigerants.meta) {
    if (m.id.toUpperCase() === canon) return m;
  }
  for (const m of kb.refrigerants.meta) {
    if (m.aliases.some((a) => a.toLowerCase() === raw || canonicalRefrigerantId(a).toUpperCase() === canon)) return m;
  }
  // Fall back to a table without metadata
  const table = kb.refrigerants.tables.get(canon);
  if (table) {
    return {
      id: table.id,
      aliases: [],
      type: "pure",
      safetyClass: "unknown",
      applications: [],
      serviceNotes: [],
    };
  }
  return undefined;
}

export function getTable(kb: KnowledgeBase, id: string): RefrigerantTable | undefined {
  const meta = resolveRefrigerant(kb, id);
  const key = (meta?.id ?? canonicalRefrigerantId(id)).toUpperCase();
  return kb.refrigerants.tables.get(key);
}

function interp(xs: number[], ys: number[], x: number): number | undefined {
  const n = xs.length;
  if (n === 0) return undefined;
  const first = xs[0]!;
  const last = xs[n - 1]!;
  if (x < first || x > last) return undefined;
  // binary search for the interval
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const x0 = xs[lo]!;
  const x1 = xs[hi]!;
  const y0 = ys[lo]!;
  const y1 = ys[hi]!;
  if (x1 === x0) return y0;
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** Pressure -> saturation temperatures (bubble & dew), linear interpolation. Undefined if out of table range. */
export function satTempsAtPressure(table: RefrigerantTable, psig: number): { bubbleF: number; dewF: number } | undefined {
  // Pressure rises monotonically with temperature, so invert each column.
  const bubbleF = interp(table.bubblePsig, table.tempF, psig);
  const dewF = interp(table.dewPsig, table.tempF, psig);
  if (bubbleF === undefined || dewF === undefined) return undefined;
  return { bubbleF: round1(bubbleF), dewF: round1(dewF) };
}

/** Temperature -> saturation pressures (bubble & dew). Undefined if out of table range. */
export function satPressuresAtTemp(table: RefrigerantTable, tempF: number): { bubblePsig: number; dewPsig: number } | undefined {
  const bubblePsig = interp(table.tempF, table.bubblePsig, tempF);
  const dewPsig = interp(table.tempF, table.dewPsig, tempF);
  if (bubblePsig === undefined || dewPsig === undefined) return undefined;
  return { bubblePsig: round1(bubblePsig), dewPsig: round1(dewPsig) };
}

/** Blends whose CoolProp table needed approximate binary mixing rules (R-438A, R-401A, R-408A). */
export function isApproximateTable(meta: RefrigerantMeta | undefined): boolean {
  return meta?.tableSource === "coolprop_mixture_approx";
}

export function approximateTableNote(id: string): string {
  return `APPROXIMATE TABLE: the ${id} pressure-temperature data was built with approximate mixing rules and can be several psi (a few °F) off the manufacturer's chart. Do not make superheat/subcooling or charge decisions from these numbers — use the refrigerant manufacturer's PT chart (e.g. Chemours/Honeywell/Arkema) for ${id}.`;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function tableTopF(table: RefrigerantTable): number {
  return table.tempF[table.tempF.length - 1] ?? 0;
}

/** Table range description with bubble and dew reported separately (they differ for zeotropes). */
function pressureRangeText(table: RefrigerantTable): string {
  const n = table.tempF.length;
  const b0 = table.bubblePsig[0] ?? 0;
  const b1 = table.bubblePsig[n - 1] ?? 0;
  const d0 = table.dewPsig[0] ?? 0;
  const d1 = table.dewPsig[n - 1] ?? 0;
  return `bubble ${b0} to ${b1} psig, dew ${d0} to ${d1} psig`;
}

// ---------------------------------------------------------------------------
// Above-table tail (the generated tables stop at 160 °F, well below the critical point of R-22,
// R-134a, R-407C, R-290, R-717 ...). A Clausius–Clapeyron fit ln(P_abs) = A − B / T_abs to the top
// ~10 °F of a column extends it up to the critical temperature on file; results are flagged.
// ---------------------------------------------------------------------------

const RANKINE_OFFSET = 459.67;
const TAIL_FIT_SPAN = 10; // table points (°F) used for the fit

interface TailFit {
  a: number;
  b: number;
}

function tailFit(tempF: number[], psig: number[]): TailFit | undefined {
  const n = Math.min(tempF.length, psig.length);
  if (n < 2) return undefined;
  const i1 = n - 1;
  const i0 = Math.max(0, n - 1 - TAIL_FIT_SPAN);
  const t0 = tempF[i0]! + RANKINE_OFFSET;
  const t1 = tempF[i1]! + RANKINE_OFFSET;
  const p0 = psig[i0]! + SEA_LEVEL_PATM_PSIA;
  const p1 = psig[i1]! + SEA_LEVEL_PATM_PSIA;
  if (!(p0 > 0 && p1 > p0 && t1 > t0)) return undefined;
  const b = (Math.log(p1) - Math.log(p0)) / (1 / t0 - 1 / t1);
  const a = Math.log(p1) + b / t1;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return undefined;
  return { a, b };
}

function tailTempAtPressure(fit: TailFit, psig: number): number | undefined {
  const pAbs = psig + SEA_LEVEL_PATM_PSIA;
  if (!(pAbs > 0)) return undefined;
  const denom = fit.a - Math.log(pAbs);
  if (!(denom > 0)) return undefined; // pressure beyond what the fit can represent
  const t = fit.b / denom - RANKINE_OFFSET;
  return Number.isFinite(t) ? t : undefined;
}

function tailPressureAtTemp(fit: TailFit, tempF: number): number | undefined {
  const p = Math.exp(fit.a - fit.b / (tempF + RANKINE_OFFSET)) - SEA_LEVEL_PATM_PSIA;
  return Number.isFinite(p) ? p : undefined;
}

export type SatRangeStatus =
  | "table" // inside the table
  | "extrapolated" // above the table top, below the critical point: Clausius–Clapeyron tail (approximate)
  | "transcritical" // above the critical pressure / temperature on file: no saturation
  | "below_table" // below the table bottom
  | "above_table"; // above the table top and no critical data on file to bound an extrapolation

export interface SatTempsResolution {
  bubbleF?: number;
  dewF?: number;
  status: SatRangeStatus;
}

export interface SatPressuresResolution {
  bubblePsig?: number;
  dewPsig?: number;
  status: SatRangeStatus;
}

/**
 * Pressure -> saturation temperatures with the above-table tail. Transcritical is claimed only from
 * `meta.criticalPsig` (or a tail temperature beyond `meta.criticalTempF`), never from the table top.
 */
export function resolveSatTemps(table: RefrigerantTable, meta: RefrigerantMeta | undefined, psig: number): SatTempsResolution {
  const bubble = interp(table.bubblePsig, table.tempF, psig);
  const dew = interp(table.dewPsig, table.tempF, psig);
  const out: SatTempsResolution = { status: "table" };
  if (bubble !== undefined) out.bubbleF = round1(bubble);
  if (dew !== undefined) out.dewF = round1(dew);
  if (bubble !== undefined && dew !== undefined) return out;
  const n = table.tempF.length;
  const bottom = Math.min(table.bubblePsig[0] ?? Infinity, table.dewPsig[0] ?? Infinity);
  if (n === 0 || psig < bottom) return { ...out, status: "below_table" };
  const critP = meta?.criticalPsig;
  if (critP !== undefined && Number.isFinite(critP) && psig > critP) return { status: "transcritical" };
  const critT = meta?.criticalTempF;
  if (critT === undefined || !Number.isFinite(critT)) return { ...out, status: "above_table" };
  let bubbleF = bubble;
  let dewF = dew;
  if (bubbleF === undefined) {
    const fit = tailFit(table.tempF, table.bubblePsig);
    bubbleF = fit ? tailTempAtPressure(fit, psig) : undefined;
  }
  if (dewF === undefined) {
    const fit = tailFit(table.tempF, table.dewPsig);
    dewF = fit ? tailTempAtPressure(fit, psig) : undefined;
  }
  if (bubbleF === undefined || dewF === undefined) return { ...out, status: "above_table" };
  if (Math.min(bubbleF, dewF) > critT) return { status: "transcritical" };
  return { bubbleF: round1(bubbleF), dewF: round1(dewF), status: "extrapolated" };
}

/** Temperature -> saturation pressures with the above-table tail (bounded by `meta.criticalTempF`). */
export function resolveSatPressures(table: RefrigerantTable, meta: RefrigerantMeta | undefined, tempF: number): SatPressuresResolution {
  const p = satPressuresAtTemp(table, tempF);
  if (p) return { ...p, status: "table" };
  const n = table.tempF.length;
  if (n === 0 || tempF < (table.tempF[0] ?? -Infinity)) return { status: "below_table" };
  const critT = meta?.criticalTempF;
  if (critT !== undefined && Number.isFinite(critT) && tempF > critT) return { status: "transcritical" };
  if (critT === undefined || !Number.isFinite(critT)) return { status: "above_table" };
  const bf = tailFit(table.tempF, table.bubblePsig);
  const df = tailFit(table.tempF, table.dewPsig);
  const bubblePsig = bf ? tailPressureAtTemp(bf, tempF) : undefined;
  const dewPsig = df ? tailPressureAtTemp(df, tempF) : undefined;
  if (bubblePsig === undefined || dewPsig === undefined) return { status: "above_table" };
  return { bubblePsig: round1(bubblePsig), dewPsig: round1(dewPsig), status: "extrapolated" };
}

function tableTopText(table: RefrigerantTable): string {
  const n = table.tempF.length;
  const maxB = table.bubblePsig[n - 1] ?? 0;
  return `ends at ${tableTopF(table)} °F ≈ ${Math.round(maxB)} psig`;
}

function criticalText(meta: RefrigerantMeta | undefined): string {
  const parts: string[] = [];
  if (meta?.criticalTempF !== undefined) parts.push(`${meta.criticalTempF} °F`);
  if (meta?.criticalPsig !== undefined) parts.push(`${meta.criticalPsig} psig`);
  return parts.length ? ` (critical ≈ ${parts.join(" / ")})` : "";
}

const HIGH_HEAD_CHECKS = "Head pressure this high is extreme — check the high-pressure switch, condenser airflow/cleanliness, non-condensables and the gauge.";

/** Elevation note: quantitative above 1,000 ft, generic otherwise. */
function elevationNote(elevationFt: number | undefined): string {
  if (elevationFt === undefined || !Number.isFinite(elevationFt) || elevationFt <= 0) {
    return "Pressures are gauge at sea level (psig). Enter the site elevation for a field-gauge correction (roughly 0.5 psi per 1,000 ft).";
  }
  const patm = patmPsia(elevationFt);
  const shift = round1(SEA_LEVEL_PATM_PSIA - patm);
  if (elevationFt > 1000) {
    return `At ${Math.round(elevationFt).toLocaleString("en-US")} ft (Patm ${patm.toFixed(2)} psia) your gauge reads ~${shift.toFixed(1)} psi lower than the sea-level chart; readings were corrected by +${shift.toFixed(1)} psi before the lookup.`;
  }
  return `At ${Math.round(elevationFt)} ft the gauge shift is only ~${shift.toFixed(1)} psi (Patm ${patm.toFixed(2)} psia); correction applied.`;
}

export function ptLookup(kb: KnowledgeBase, refrigerant: string, query: { psig?: number; tempF?: number; elevationFt?: number }): PtLookupResult {
  const meta = resolveRefrigerant(kb, refrigerant);
  const table = getTable(kb, refrigerant);
  const notes: string[] = [];
  const id = meta?.id ?? canonicalRefrigerantId(refrigerant);
  if (!table) {
    return { refrigerant: id, notes: [`No PT data for "${refrigerant}". Known refrigerants: ${[...kb.refrigerants.tables.keys()].join(", ")}`] };
  }
  const elevationFt = query.elevationFt !== undefined && Number.isFinite(query.elevationFt) && query.elevationFt > 0 ? query.elevationFt : undefined;
  const glide = meta?.glideF;
  const zeotrope = (meta?.type ?? "pure") === "zeotrope" && (glide ?? 0) >= 0.5;
  if (isApproximateTable(meta)) notes.unshift(approximateTableNote(id));
  if (zeotrope) {
    notes.push(`${id} is a zeotropic blend with about ${glide} °F glide: use DEW point for superheat, BUBBLE point for subcooling. Charge as liquid.`);
  }
  notes.push(elevationNote(elevationFt));
  const result: PtLookupResult = { refrigerant: id, notes };
  if (isApproximateTable(meta)) result.approximate = true;
  if (elevationFt !== undefined) result.elevationFt = elevationFt;
  if (meta && meta.safetyClass && meta.safetyClass !== "unknown") {
    result.safetyClass = meta.safetyClass;
    notes.push(`Safety class ${meta.safetyClass} (ASHRAE 34).`);
    const reminder = safetyReminder(meta.safetyClass);
    if (reminder) notes.push(reminder);
  } else {
    notes.push("Safety class not on file — confirm the class on the cylinder label / SDS before service (A2L and A3 need rated equipment).");
  }
  if (glide !== undefined) result.glideF = glide;

  if (query.psig !== undefined && Number.isFinite(query.psig)) {
    const fieldPsig = query.psig;
    const psigSL = elevationFt !== undefined ? fieldToSeaLevelPsig(fieldPsig, elevationFt) : fieldPsig;
    result.psig = fieldPsig;
    if (fieldPsig < 0) {
      result.inHgVacuum = inHgVacuum(fieldPsig);
      notes.push(`${fieldPsig} psig is below atmospheric: ${result.inHgVacuum} inHg vacuum. Air leaks IN at any joint — pull-down and moisture risk.`);
    }
    const sat = resolveSatTemps(table, meta, psigSL);
    if (sat.bubbleF !== undefined) result.bubbleTempF = sat.bubbleF;
    if (sat.dewF !== undefined) result.dewTempF = sat.dewF;
    if (sat.bubbleF !== undefined && sat.dewF !== undefined) {
      result.midpointTempF = round1((sat.bubbleF + sat.dewF) / 2);
    }
    const basis = elevationFt !== undefined ? ` (${round1(psigSL)} psig sea-level basis)` : "";
    switch (sat.status) {
      case "table":
        break;
      case "extrapolated":
        notes.push(
          `${fieldPsig} psig${basis} is above the ${id} table (${tableTopText(table)}; ${pressureRangeText(table)}): saturation temperature EXTRAPOLATED from the table tail — approximate, not for charge decisions. ${HIGH_HEAD_CHECKS}`,
        );
        break;
      case "transcritical":
        notes.push(
          meta?.criticalPsig !== undefined && psigSL > meta.criticalPsig
            ? `${fieldPsig} psig${basis} is above the critical pressure of ${id}${criticalText(meta)} — above critical temperature — no saturation (transcritical); verify the gauge and the refrigerant.`
            : `${fieldPsig} psig${basis} corresponds to a saturation temperature above the ${id} critical temperature${criticalText(meta)} — no saturation (transcritical); verify the gauge and the refrigerant.`,
        );
        break;
      case "above_table":
        notes.push(`${fieldPsig} psig${basis} is above the ${id} table (${tableTopText(table)}; ${pressureRangeText(table)}) and no critical-point data is on file to extend it. ${HIGH_HEAD_CHECKS}`);
        break;
      case "below_table":
        notes.push(`${fieldPsig} psig${basis} is outside the ${id} table: ${pressureRangeText(table)}.`);
        break;
    }
  }
  if (query.tempF !== undefined && Number.isFinite(query.tempF)) {
    const p = resolveSatPressures(table, meta, query.tempF);
    result.tempF = query.tempF;
    const top = tableTopF(table);
    if (p.bubblePsig !== undefined && p.dewPsig !== undefined) {
      const bubble = elevationFt !== undefined ? round1(seaLevelToFieldPsig(p.bubblePsig, elevationFt)) : p.bubblePsig;
      const dew = elevationFt !== undefined ? round1(seaLevelToFieldPsig(p.dewPsig, elevationFt)) : p.dewPsig;
      result.bubblePsig = bubble;
      result.dewPsig = dew;
      if (bubble < 0 || dew < 0) {
        const lowest = Math.min(bubble, dew);
        result.inHgVacuum = inHgVacuum(lowest);
        notes.push(`Saturation at ${query.tempF} °F is below atmospheric: ${result.inHgVacuum} inHg vacuum on the gauge (${lowest} psig).`);
      }
      if (p.status === "extrapolated") {
        notes.push(`${query.tempF} °F is above the ${id} table (${tableTopText(table)}): saturation pressure EXTRAPOLATED from the table tail — approximate, not for charge decisions. ${HIGH_HEAD_CHECKS}`);
      }
    } else if (p.status === "transcritical") {
      notes.push(`${query.tempF} °F is above critical temperature — no saturation (transcritical)${criticalText(meta)}.`);
    } else if (p.status === "above_table") {
      notes.push(`${query.tempF} °F is above the ${id} table range (${table.tempF[0]} to ${top} °F) and no critical-point data is on file to extend it.`);
    } else {
      notes.push(`${query.tempF} °F is outside the ${id} table range (${table.tempF[0]} to ${top} °F).`);
    }
  }
  if (query.psig === undefined && query.tempF === undefined) {
    notes.push("Provide psig or tempF.");
  }
  return result;
}

export interface ShScResult {
  refrigerant: string;
  approximate?: boolean; // table built with approximate mixing rules: not for charge decisions
  extrapolated?: boolean; // a saturation temperature came from the above-table tail fit: approximate, not for charge decisions
  safetyClass?: string;
  patmPsia?: number;
  evapSatF?: number;
  condSatF?: number;
  superheatF?: number;
  subcoolingF?: number;
  notes: string[];
}

/** Superheat (dew point basis) and subcooling (bubble point basis) from field readings. */
export function superheatSubcooling(
  kb: KnowledgeBase,
  m: Pick<DxMeasurements, "refrigerant" | "suctionPsig" | "suctionLineTempF" | "liquidPsig" | "dischargePsig" | "liquidLineTempF" | "elevationFt">,
): ShScResult {
  const meta = resolveRefrigerant(kb, m.refrigerant);
  const table = getTable(kb, m.refrigerant);
  const id = meta?.id ?? canonicalRefrigerantId(m.refrigerant);
  const notes: string[] = [];
  const out: ShScResult = { refrigerant: id, notes };
  if (isApproximateTable(meta)) {
    out.approximate = true;
    notes.push(approximateTableNote(id));
  }
  if (!table) {
    notes.push(`No PT data for "${m.refrigerant}".`);
    return out;
  }
  const elevationFt = m.elevationFt !== undefined && Number.isFinite(m.elevationFt) && m.elevationFt > 0 ? m.elevationFt : undefined;
  out.patmPsia = patmPsia(elevationFt);
  if (elevationFt !== undefined && elevationFt > 1000) notes.push(elevationNote(elevationFt));
  if (meta && meta.safetyClass && meta.safetyClass !== "unknown") {
    out.safetyClass = meta.safetyClass;
    const reminder = safetyReminder(meta.safetyClass);
    if (reminder) notes.push(reminder);
  }
  /** Out-of-table note for one side; transcritical only when the critical point on file says so. */
  const rangeNote = (label: string, psig: number, status: SatRangeStatus, tail: string): void => {
    switch (status) {
      case "extrapolated":
        out.extrapolated = true;
        notes.push(`${label} ${psig} psig is above the ${id} table (${tableTopText(table)}): saturation temperature EXTRAPOLATED from the table tail — approximate, not for charge decisions. ${tail}`);
        break;
      case "transcritical":
        notes.push(`${label} ${psig} psig is above the critical point of ${id}${criticalText(meta)} — no saturation (transcritical); verify the gauge and the refrigerant.`);
        break;
      case "above_table":
        notes.push(`${label} ${psig} psig is above the ${id} table (${tableTopText(table)}) and no critical-point data is on file to extend it. ${tail}`);
        break;
      case "below_table":
        notes.push(`${label} ${psig} psig is outside the ${id} table (${pressureRangeText(table)}).`);
        break;
      case "table":
        break;
    }
  };
  if (m.suctionPsig !== undefined && Number.isFinite(m.suctionPsig)) {
    const psigSL = elevationFt !== undefined ? fieldToSeaLevelPsig(m.suctionPsig, elevationFt) : m.suctionPsig;
    const t = resolveSatTemps(table, meta, psigSL);
    if (t.dewF !== undefined) {
      out.evapSatF = t.dewF;
      if (m.suctionLineTempF !== undefined && Number.isFinite(m.suctionLineTempF)) {
        out.superheatF = round1(m.suctionLineTempF - t.dewF);
        if (out.superheatF < 0) notes.push("Negative superheat: check the line temperature probe placement and the gauge; liquid may be returning to the compressor.");
      }
    }
    rangeNote("Suction pressure", m.suctionPsig, t.status, "A suction pressure this high means the gauge is on the wrong port or the system is off and equalized.");
  }
  const highSide = m.liquidPsig ?? m.dischargePsig;
  if (highSide !== undefined && Number.isFinite(highSide)) {
    const psigSL = elevationFt !== undefined ? fieldToSeaLevelPsig(highSide, elevationFt) : highSide;
    const t = resolveSatTemps(table, meta, psigSL);
    if (t.bubbleF !== undefined) {
      out.condSatF = t.bubbleF;
      if (m.liquidLineTempF !== undefined && Number.isFinite(m.liquidLineTempF)) {
        out.subcoolingF = round1(t.bubbleF - m.liquidLineTempF);
        if (out.subcoolingF < 0) notes.push("Negative subcooling: liquid line warmer than saturation; verify the pressure is taken at the liquid line, and check for flash gas.");
      }
      if (m.liquidPsig === undefined && m.dischargePsig !== undefined) {
        notes.push("Subcooling computed from discharge pressure; liquid-line pressure is slightly lower (condenser pressure drop), so true subcooling is a little less.");
      }
    }
    rangeNote("High-side pressure", highSide, t.status, HIGH_HEAD_CHECKS);
  }
  if ((meta?.glideF ?? 0) >= 0.5) {
    notes.push(`${id} glide ≈ ${meta?.glideF} °F: superheat uses dew point, subcooling uses bubble point.`);
  }
  return out;
}
