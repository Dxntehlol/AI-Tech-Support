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

/** Elevation note: quantitative above 1,000 ft, generic otherwise. */
function elevationNote(elevationFt: number | undefined): string {
  if (elevationFt === undefined || !Number.isFinite(elevationFt) || elevationFt <= 0) {
    return "Pressures are gauge at sea level (psig). Pass elevationFt for a field-gauge correction (roughly 0.5 psi per 1,000 ft).";
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
  if (zeotrope) {
    notes.push(`${id} is a zeotropic blend with about ${glide} °F glide: use DEW point for superheat, BUBBLE point for subcooling. Charge as liquid.`);
  }
  notes.push(elevationNote(elevationFt));
  const result: PtLookupResult = { refrigerant: id, notes };
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
  const criticalTempF = meta?.criticalTempF;
  const pureLike = (meta?.type ?? "pure") !== "zeotrope";

  if (query.psig !== undefined && Number.isFinite(query.psig)) {
    const fieldPsig = query.psig;
    const psigSL = elevationFt !== undefined ? fieldToSeaLevelPsig(fieldPsig, elevationFt) : fieldPsig;
    result.psig = fieldPsig;
    if (fieldPsig < 0) {
      result.inHgVacuum = inHgVacuum(fieldPsig);
      notes.push(`${fieldPsig} psig is below atmospheric: ${result.inHgVacuum} inHg vacuum. Air leaks IN at any joint — pull-down and moisture risk.`);
    }
    const bubbleF = interp(table.bubblePsig, table.tempF, psigSL);
    const dewF = interp(table.dewPsig, table.tempF, psigSL);
    if (bubbleF !== undefined) result.bubbleTempF = round1(bubbleF);
    if (dewF !== undefined) result.dewTempF = round1(dewF);
    if (bubbleF !== undefined && dewF !== undefined) {
      result.midpointTempF = round1((bubbleF + dewF) / 2);
    }
    if (bubbleF === undefined || dewF === undefined) {
      const basis = elevationFt !== undefined ? ` (${round1(psigSL)} psig sea-level basis)` : "";
      const maxB = table.bubblePsig[table.bubblePsig.length - 1] ?? 0;
      const critP = meta?.criticalPsig;
      if ((critP !== undefined && psigSL > critP) || (psigSL > maxB && pureLike)) {
        notes.push(`${fieldPsig} psig${basis} is above the critical pressure of ${id} — above critical temperature — no saturation (transcritical).`);
      } else {
        notes.push(`${fieldPsig} psig${basis} is outside the ${id} table: ${pressureRangeText(table)}.`);
      }
    }
  }
  if (query.tempF !== undefined && Number.isFinite(query.tempF)) {
    const p = satPressuresAtTemp(table, query.tempF);
    result.tempF = query.tempF;
    if (p) {
      const bubble = elevationFt !== undefined ? round1(seaLevelToFieldPsig(p.bubblePsig, elevationFt)) : p.bubblePsig;
      const dew = elevationFt !== undefined ? round1(seaLevelToFieldPsig(p.dewPsig, elevationFt)) : p.dewPsig;
      result.bubblePsig = bubble;
      result.dewPsig = dew;
      if (bubble < 0 || dew < 0) {
        const lowest = Math.min(bubble, dew);
        result.inHgVacuum = inHgVacuum(lowest);
        notes.push(`Saturation at ${query.tempF} °F is below atmospheric: ${result.inHgVacuum} inHg vacuum on the gauge (${lowest} psig).`);
      }
    } else {
      const top = tableTopF(table);
      const aboveCritical = (criticalTempF !== undefined && query.tempF > criticalTempF) || (criticalTempF === undefined && pureLike && query.tempF > top);
      if (aboveCritical || (pureLike && query.tempF > top)) {
        const crit = criticalTempF !== undefined ? ` (critical ≈ ${criticalTempF} °F)` : "";
        notes.push(`${query.tempF} °F is above critical temperature — no saturation (transcritical)${crit}.`);
      } else {
        notes.push(`${query.tempF} °F is outside the ${id} table range (${table.tempF[0]} to ${top} °F).`);
      }
    }
  }
  if (query.psig === undefined && query.tempF === undefined) {
    notes.push("Provide psig or tempF.");
  }
  return result;
}

export interface ShScResult {
  refrigerant: string;
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
  if (m.suctionPsig !== undefined && Number.isFinite(m.suctionPsig)) {
    const psigSL = elevationFt !== undefined ? fieldToSeaLevelPsig(m.suctionPsig, elevationFt) : m.suctionPsig;
    const t = satTempsAtPressure(table, psigSL);
    if (t) {
      out.evapSatF = t.dewF;
      if (m.suctionLineTempF !== undefined && Number.isFinite(m.suctionLineTempF)) {
        out.superheatF = round1(m.suctionLineTempF - t.dewF);
        if (out.superheatF < 0) notes.push("Negative superheat: check the line temperature probe placement and the gauge; liquid may be returning to the compressor.");
      }
    } else {
      notes.push(`Suction pressure ${m.suctionPsig} psig is outside the ${id} table (${pressureRangeText(table)}).`);
    }
  }
  const highSide = m.liquidPsig ?? m.dischargePsig;
  if (highSide !== undefined && Number.isFinite(highSide)) {
    const psigSL = elevationFt !== undefined ? fieldToSeaLevelPsig(highSide, elevationFt) : highSide;
    const t = satTempsAtPressure(table, psigSL);
    if (t) {
      out.condSatF = t.bubbleF;
      if (m.liquidLineTempF !== undefined && Number.isFinite(m.liquidLineTempF)) {
        out.subcoolingF = round1(t.bubbleF - m.liquidLineTempF);
        if (out.subcoolingF < 0) notes.push("Negative subcooling: liquid line warmer than saturation; verify the pressure is taken at the liquid line, and check for flash gas.");
      }
      if (m.liquidPsig === undefined && m.dischargePsig !== undefined) {
        notes.push("Subcooling computed from discharge pressure; liquid-line pressure is slightly lower (condenser pressure drop), so true subcooling is a little less.");
      }
    } else {
      const maxB = table.bubblePsig[table.bubblePsig.length - 1] ?? 0;
      if (psigSL > maxB) {
        notes.push(`High-side pressure ${highSide} psig is above the ${id} table top (${maxB} psig) — above critical temperature — no saturation (transcritical); verify the gauge and refrigerant.`);
      } else {
        notes.push(`High-side pressure ${highSide} psig is outside the ${id} table (${pressureRangeText(table)}).`);
      }
    }
  }
  if ((meta?.glideF ?? 0) >= 0.5) {
    notes.push(`${id} glide ≈ ${meta?.glideF} °F: superheat uses dew point, subcooling uses bubble point.`);
  }
  return out;
}
