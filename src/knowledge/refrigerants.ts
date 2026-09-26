import type { DxMeasurements, KnowledgeBase, PtLookupResult, RefrigerantMeta, RefrigerantTable } from "../types.ts";

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

export function ptLookup(kb: KnowledgeBase, refrigerant: string, query: { psig?: number; tempF?: number }): PtLookupResult {
  const meta = resolveRefrigerant(kb, refrigerant);
  const table = getTable(kb, refrigerant);
  const notes: string[] = [];
  const id = meta?.id ?? canonicalRefrigerantId(refrigerant);
  if (!table) {
    return { refrigerant: id, notes: [`No PT data for "${refrigerant}". Known refrigerants: ${[...kb.refrigerants.tables.keys()].join(", ")}`] };
  }
  const glide = meta?.glideF;
  const zeotrope = (meta?.type ?? "pure") === "zeotrope" && (glide ?? 0) >= 0.5;
  if (zeotrope) {
    notes.push(`${id} is a zeotropic blend with about ${glide} °F glide: use DEW point for superheat, BUBBLE point for subcooling. Charge as liquid.`);
  }
  notes.push("Pressures are gauge at sea level (psig). Above ~2,500 ft elevation, gauge readings shift by roughly 0.5 psi per 1,000 ft.");
  const result: PtLookupResult = { refrigerant: id, notes };
  if (glide !== undefined) result.glideF = glide;
  if (query.psig !== undefined && Number.isFinite(query.psig)) {
    const t = satTempsAtPressure(table, query.psig);
    result.psig = query.psig;
    if (t) {
      result.bubbleTempF = t.bubbleF;
      result.dewTempF = t.dewF;
    } else {
      notes.push(`${query.psig} psig is outside the table range for ${id} (${table.bubblePsig[0]} to ${table.dewPsig[table.dewPsig.length - 1]} psig).`);
    }
  }
  if (query.tempF !== undefined && Number.isFinite(query.tempF)) {
    const p = satPressuresAtTemp(table, query.tempF);
    result.tempF = query.tempF;
    if (p) {
      result.bubblePsig = p.bubblePsig;
      result.dewPsig = p.dewPsig;
    } else {
      notes.push(`${query.tempF} °F is outside the table range for ${id} (${table.tempF[0]} to ${table.tempF[table.tempF.length - 1]} °F).`);
    }
  }
  if (query.psig === undefined && query.tempF === undefined) {
    notes.push("Provide psig or tempF.");
  }
  return result;
}

export interface ShScResult {
  refrigerant: string;
  evapSatF?: number;
  condSatF?: number;
  superheatF?: number;
  subcoolingF?: number;
  notes: string[];
}

/** Superheat (dew point basis) and subcooling (bubble point basis) from field readings. */
export function superheatSubcooling(
  kb: KnowledgeBase,
  m: Pick<DxMeasurements, "refrigerant" | "suctionPsig" | "suctionLineTempF" | "liquidPsig" | "dischargePsig" | "liquidLineTempF">,
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
  if (m.suctionPsig !== undefined) {
    const t = satTempsAtPressure(table, m.suctionPsig);
    if (t) {
      out.evapSatF = t.dewF;
      if (m.suctionLineTempF !== undefined) {
        out.superheatF = round1(m.suctionLineTempF - t.dewF);
        if (out.superheatF < 0) notes.push("Negative superheat: check the line temperature probe placement and the gauge; liquid may be returning to the compressor.");
      }
    } else {
      notes.push(`Suction pressure ${m.suctionPsig} psig is outside the ${id} table range.`);
    }
  }
  const highSide = m.liquidPsig ?? m.dischargePsig;
  if (highSide !== undefined) {
    const t = satTempsAtPressure(table, highSide);
    if (t) {
      out.condSatF = t.bubbleF;
      if (m.liquidLineTempF !== undefined) {
        out.subcoolingF = round1(t.bubbleF - m.liquidLineTempF);
        if (out.subcoolingF < 0) notes.push("Negative subcooling: liquid line warmer than saturation; verify the pressure is taken at the liquid line, and check for flash gas.");
      }
      if (m.liquidPsig === undefined && m.dischargePsig !== undefined) {
        notes.push("Subcooling computed from discharge pressure; liquid-line pressure is slightly lower (condenser pressure drop), so true subcooling is a little less.");
      }
    } else {
      notes.push(`High-side pressure ${highSide} psig is outside the ${id} table range.`);
    }
  }
  if ((meta?.glideF ?? 0) >= 0.5) {
    notes.push(`${id} glide ≈ ${meta?.glideF} °F: superheat uses dew point, subcooling uses bubble point.`);
  }
  return out;
}
