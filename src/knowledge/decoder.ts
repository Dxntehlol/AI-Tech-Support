import type {
  CommonIssue,
  Confidence,
  ControlPlatform,
  DecodeResult,
  DecodedModel,
  DecodedSerial,
  EvidenceLevel,
  FamilyElectrical,
  KnowledgeBase,
  ManufacturerPack,
  ModelAttribute,
  ModelFormat,
  ModelSegment,
  SerialDateRule,
  SerialFormat,
} from "../types.ts";

export interface DecodeInput {
  model: string;
  serial?: string;
  manufacturer?: string; // optional hint (brand or manufacturer name)
  now?: Date; // for age calculation (tests)
}

/** Normalized nameplate strings are capped at this length (DESIGN.md "Normalization"). */
export const MAX_NAMEPLATE_LENGTH = 64;
/** Pack regexes longer than this are refused (pathological-regex guard). */
export const MAX_REGEX_LENGTH = 400;
/** Earliest manufacture year the engine accepts. */
export const MIN_SERIAL_YEAR = 1965;
/** Units older than this get an age warning. */
export const OLD_UNIT_YEARS = 20;

// ---------------------------------------------------------------------------
// Regex guard
// ---------------------------------------------------------------------------

export type RegexAnalysis =
  | { ok: true; groups: number; anchored: boolean }
  | { ok: false; reason: string };

/**
 * Heuristic nested-quantifier detector: a group that contains an unbounded/repeating
 * quantifier (`+`, `*`, `{n,}`, `{n,m}`) and is itself followed by a repeating quantifier,
 * e.g. `(a+)+`, `(a*)*`, `(\d{2,3})+`, `((a)+)+`. `(a+)?` and `(?:x*)?` are fine.
 */
export function hasNestedQuantifier(source: string): boolean {
  const stack: { rep: boolean }[] = [];
  let i = 0;
  let inClass = false;
  let lastGroupRep: boolean | null = null;
  const markRep = () => {
    const top = stack[stack.length - 1];
    if (top) top.rep = true;
  };
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      lastGroupRep = null;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      lastGroupRep = null;
      continue;
    }
    if (c === "(") {
      stack.push({ rep: false });
      i++;
      lastGroupRep = null;
      continue;
    }
    if (c === ")") {
      const g = stack.pop();
      lastGroupRep = g?.rep ?? false;
      if (g?.rep) markRep();
      i++;
      continue;
    }
    let kind: "rep" | "opt" | "exact" | null = null;
    let len = 1;
    if (c === "+" || c === "*") kind = "rep";
    else if (c === "?") kind = "opt";
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (m) {
        len = m[0].length;
        if (m[2] === undefined) kind = "exact";
        else if (m[3] === "" || m[3] === undefined) kind = "rep";
        else kind = Number(m[3]) > Number(m[1]) ? "rep" : "exact";
      }
    }
    if (kind) {
      if (kind === "rep") {
        if (lastGroupRep) return true;
        markRep();
      }
      i += len;
      if (source[i] === "?") i++; // lazy modifier
      lastGroupRep = null;
      continue;
    }
    lastGroupRep = null;
    i++;
  }
  return false;
}

function isAnchored(source: string): boolean {
  if (!source.startsWith("^")) return false;
  if (!source.endsWith("$")) return false;
  // `$` must not be escaped
  let backslashes = 0;
  for (let i = source.length - 2; i >= 0 && source[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 0;
}

/** Count capture groups of a regex source (`new RegExp(re + "|").exec("").length - 1`). */
export function countRegexGroups(source: string): number {
  try {
    const m = new RegExp(source + "|").exec("");
    return m ? m.length - 1 : 0;
  } catch {
    return 0;
  }
}

/** Static safety analysis of a pack regex: length, compile, nested quantifiers, group count, anchoring. */
export function analyzeRegex(source: unknown): RegexAnalysis {
  if (typeof source !== "string" || source.length === 0) return { ok: false, reason: "regex is empty or not a string" };
  if (source.length > MAX_REGEX_LENGTH) return { ok: false, reason: `regex longer than ${MAX_REGEX_LENGTH} chars (${source.length})` };
  try {
    new RegExp(source, "i");
  } catch (e) {
    return { ok: false, reason: `regex does not compile: ${(e as Error).message}` };
  }
  if (hasNestedQuantifier(source)) return { ok: false, reason: "regex has nested quantifiers (e.g. (a+)+), refused" };
  return { ok: true, groups: countRegexGroups(source), anchored: isAnchored(source) };
}

const regexCache = new Map<string, RegExp | null>();

/** Compiled case-insensitive regex, or null when the guard refuses it. */
export function safeRegex(source: unknown): RegExp | null {
  if (typeof source !== "string") return null;
  const cached = regexCache.get(source);
  if (cached !== undefined) return cached;
  const a = analyzeRegex(source);
  const re = a.ok ? new RegExp(source, "i") : null;
  if (regexCache.size > 2000) regexCache.clear();
  regexCache.set(source, re);
  return re;
}

/** Match a guarded regex against the normalized string, then against its compact (space-free) form. */
function matchEither(re: RegExp, value: string, compact: string): RegExpExecArray | null {
  if (value.length > MAX_NAMEPLATE_LENGTH || compact.length > MAX_NAMEPLATE_LENGTH) return null;
  re.lastIndex = 0;
  const m = re.exec(value);
  if (m) return m;
  if (compact !== value) {
    re.lastIndex = 0;
    return re.exec(compact);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export interface NormalizedNameplate {
  value: string; // normalized (≤ 64 chars)
  compact: string; // normalized with spaces removed
  truncated: boolean;
}

/** Normalize with detail (whether the input was truncated to 64 chars). */
export function normalizeNameplateDetailed(s: unknown): NormalizedNameplate {
  let v = typeof s === "string" ? s : s == null ? "" : String(s);
  v = v.trim().toUpperCase().replace(/\s+/g, " ");
  // strip a leading MODEL / M/N / S/N / SERIAL label (with optional NO / NUMBER)
  v = v.replace(/^(?:MODEL|M\/N|S\/N|SERIAL)(?![A-Z0-9])(?:\s*(?:NO|NUMBER|NBR)(?![A-Z0-9])\.?)?[\s.:#=-]*/, "");
  v = v.replace(/[^A-Z0-9 /().-]/g, "");
  v = v.replace(/\s+/g, " ").trim();
  const truncated = v.length > MAX_NAMEPLATE_LENGTH;
  if (truncated) v = v.slice(0, MAX_NAMEPLATE_LENGTH).trim();
  return { value: v, compact: v.replace(/ /g, ""), truncated };
}

/** Normalize a nameplate string: trim, uppercase, collapse whitespace, strip stray punctuation. */
export function normalizeNameplate(s: string): string {
  return normalizeNameplateDetailed(s).value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONF_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

function confRank(c: unknown): number {
  return CONF_RANK[c as Confidence] ?? 0;
}

function asConfidence(c: unknown): Confidence {
  return c === "high" || c === "medium" || c === "low" ? c : "low";
}

function minConfidence(...cs: (Confidence | undefined)[]): Confidence {
  let best: Confidence | undefined;
  for (const c of cs) {
    if (!c) continue;
    if (!best || confRank(c) < confRank(best)) best = c;
  }
  return best ?? "low";
}

function safeNow(now: unknown): Date {
  return now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function lookupMap(map: Record<string, string> | undefined, code: string): string | undefined {
  if (!map || typeof map !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(map, code)) return str(map[code]);
  const upper = code.toUpperCase();
  for (const k of Object.keys(map)) if (k.toUpperCase() === upper) return str(map[k]);
  return undefined;
}

function lookupNumberMap(map: Record<string, number> | undefined, code: string): number | undefined {
  if (!map || typeof map !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(map, code)) return Number(map[code]);
  const upper = code.toUpperCase();
  for (const k of Object.keys(map)) if (k.toUpperCase() === upper) return Number(map[k]);
  return undefined;
}

function groupValue(m: RegExpExecArray, idx: unknown): string | undefined {
  if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 1) return undefined;
  const v = m[idx];
  return v === undefined || v === null ? undefined : String(v).toUpperCase();
}

/** Format tons with up to one decimal and no trailing ".0" ("036" MBH → "3", "090" → "7.5"). */
export function formatTons(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Apply a numeric segment transform; undefined when it does not apply (map_tons is handled by the map). */
export function applyTransform(transform: ModelSegment["transform"], code: string): string | undefined {
  const digits = code.replace(/[^0-9.]/g, "");
  const n = digits ? Number.parseFloat(digits) : Number.NaN;
  switch (transform) {
    case "mbh_to_tons":
      return Number.isFinite(n) ? formatTons(n / 12) : undefined;
    case "tons_x10":
      return Number.isFinite(n) ? formatTons(n / 10) : undefined;
    case "kbtuh":
      // kept as the number string exactly as printed on the plate ("115" → "115", "072" → "072")
      return Number.isFinite(n) ? code : undefined;
    case "raw":
      return code;
    case "map_tons":
      return undefined;
    default:
      return undefined;
  }
}

const EVIDENCE_LABEL: Record<EvidenceLevel, string> = {
  manufacturer_doc: "manufacturer document",
  multi_secondary: "two or more secondary sources agree",
  single_secondary: "one secondary source",
  inferred: "inferred (unverified)",
};

function evidenceLabel(evidence: EvidenceLevel | undefined, confidence: Confidence): string {
  const base = evidence ? (EVIDENCE_LABEL[evidence] ?? evidence) : "evidence not stated";
  return `${base}, ${confidence} confidence`;
}

function shortSource(sources: string[] | undefined): string {
  const s = sources?.find((x) => typeof x === "string" && x.trim());
  if (!s) return "";
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 110 ? `${t.slice(0, 107)}...` : t;
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serial decoding
// ---------------------------------------------------------------------------

export interface SerialDecodeDetail {
  results: DecodedSerial[]; // ranked, best first
  warnings: string[]; // rejected matches (sanity/era), ambiguity
  truncated: boolean;
  normalized: string;
}

type DateParts = { year?: number; month?: number; week?: number; dayOfYear?: number; altYears: number[]; notes: string[] };

function methodLabel(method: SerialDateRule["method"]): string {
  switch (method) {
    case "twoDigitYear":
      return "two-digit year";
    case "oneDigitYear":
      return "one-digit year";
    case "decadeDigitYear":
      return "decade+year digits";
    case "letterYear":
      return "letter year";
    case "fourDigitYear":
      return "four-digit year";
    default:
      return "serial date";
  }
}

function inEra(sf: SerialFormat, year: number): boolean {
  if (typeof sf.eraStart === "number" && year < sf.eraStart) return false;
  if (typeof sf.eraEnd === "number" && year > sf.eraEnd) return false;
  return true;
}

/** Compute the date parts for one matched serial format. Returns a string reason when the match must be rejected. */
function computeDate(sf: SerialFormat, m: RegExpExecArray, now: Date): DateParts | string {
  const rule = sf.date;
  const maxYear = now.getUTCFullYear() + 1;
  const parts: DateParts = { altYears: [], notes: [] };
  if (!rule || typeof rule !== "object") return "missing date rule";
  if (rule.method === "manual") {
    parts.notes.push(rule.note || "Manufacture date must be read manually for this format.");
    return parts;
  }

  let year: number | undefined;
  switch (rule.method) {
    case "twoDigitYear": {
      const raw = groupValue(m, rule.yearGroup);
      if (raw === undefined) return "year group did not capture";
      const mapped = lookupNumberMap(rule.yearMap, raw);
      if (mapped !== undefined && Number.isFinite(mapped)) year = mapped;
      else {
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n)) return `year digits "${raw}" not numeric`;
        const pivot = typeof rule.pivot === "number" ? rule.pivot : 70;
        year = n >= pivot ? 1900 + n : 2000 + n;
      }
      break;
    }
    case "oneDigitYear": {
      const raw = groupValue(m, rule.yearGroup);
      if (raw === undefined) return "year group did not capture";
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) return `year digit "${raw}" not numeric`;
      const base = Number(rule.decadeBase);
      if (!Number.isFinite(base)) return "decadeBase missing";
      year = base + n;
      for (const alt of [year - 10, year + 10]) {
        if (alt >= MIN_SERIAL_YEAR && alt <= maxYear && inEra(sf, alt)) parts.altYears.push(alt);
      }
      break;
    }
    case "decadeDigitYear": {
      const d = groupValue(m, rule.decadeGroup);
      const y = groupValue(m, rule.yearGroup);
      if (d === undefined || y === undefined) return "decade/year group did not capture";
      const dn = Number.parseInt(d, 10);
      const yn = Number.parseInt(y, 10);
      if (!Number.isFinite(yn)) return `year digit "${y}" not numeric`;
      const mapped = lookupNumberMap(rule.decadeMap, d);
      const base = mapped !== undefined && Number.isFinite(mapped) ? mapped : Number.isFinite(dn) ? 2000 + 10 * dn : Number.NaN;
      if (!Number.isFinite(base)) return `decade digit "${d}" unknown`;
      year = base + yn;
      break;
    }
    case "letterYear": {
      const raw = groupValue(m, rule.yearGroup);
      if (raw === undefined) return "year group did not capture";
      const mapped = lookupNumberMap(rule.map, raw);
      if (mapped === undefined || !Number.isFinite(mapped)) return `year letter "${raw}" not in map`;
      year = mapped;
      break;
    }
    case "fourDigitYear": {
      const raw = groupValue(m, rule.yearGroup);
      if (raw === undefined) return "year group did not capture";
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) return `year "${raw}" not numeric`;
      year = n;
      break;
    }
    default:
      return `unknown date method "${(rule as { method?: string }).method}"`;
  }

  if (year === undefined) return "year could not be computed";
  if (year < MIN_SERIAL_YEAR || year > maxYear) return `year ${year} outside ${MIN_SERIAL_YEAR}..${maxYear}`;
  if (!inEra(sf, year)) return `year ${year} outside format era ${sf.eraStart ?? "?"}-${sf.eraEnd ?? "present"}`;
  parts.year = year;

  const r = rule as Extract<SerialDateRule, { yearGroup: number }>;
  if (typeof r.monthGroup === "number") {
    const raw = groupValue(m, r.monthGroup);
    if (raw !== undefined) {
      let month: number | undefined;
      if (r.monthLetterMap) {
        month = lookupNumberMap(r.monthLetterMap, raw);
        if (month === undefined) return `month letter "${raw}" not in map`;
      } else {
        month = Number.parseInt(raw, 10);
        if (!Number.isFinite(month)) return `month "${raw}" not numeric`;
      }
      if (month < 1 || month > 12) return `month ${month} outside 1..12`;
      parts.month = month;
    }
  }
  if (typeof r.weekGroup === "number") {
    const raw = groupValue(m, r.weekGroup);
    if (raw !== undefined) {
      const week = Number.parseInt(raw, 10);
      if (!Number.isFinite(week)) return `week "${raw}" not numeric`;
      if (week < 1 || week > 53) return `week ${week} outside 1..53`;
      parts.week = week;
    }
  }
  const doyGroup = (rule as { dayOfYearGroup?: number }).dayOfYearGroup;
  if (typeof doyGroup === "number") {
    const raw = groupValue(m, doyGroup);
    if (raw !== undefined) {
      const doy = Number.parseInt(raw, 10);
      if (!Number.isFinite(doy)) return `day-of-year "${raw}" not numeric`;
      if (doy < 1 || doy > 366) return `day-of-year ${doy} outside 1..366`;
      parts.dayOfYear = doy;
      if (parts.month === undefined) {
        const d = new Date(Date.UTC(year, 0, doy));
        if (d.getUTCFullYear() === year) parts.month = d.getUTCMonth() + 1;
      }
    }
  }
  return parts;
}

function manufactureDate(p: { year?: number; month?: number; week?: number }): string | undefined {
  if (p.year === undefined) return undefined;
  if (p.month !== undefined) return `${p.year}-${String(p.month).padStart(2, "0")}`;
  if (p.week !== undefined) return `${p.year}-W${String(p.week).padStart(2, "0")}`;
  return String(p.year);
}

function ageYears(p: { year?: number; month?: number; week?: number; dayOfYear?: number }, now: Date): number | undefined {
  if (p.year === undefined) return undefined;
  let ref: number;
  if (p.month !== undefined) ref = Date.UTC(p.year, p.month - 1, 15);
  else if (p.week !== undefined) ref = Date.UTC(p.year, 0, 1) + ((p.week - 1) * 7 + 3) * 86400000;
  else if (p.dayOfYear !== undefined) ref = Date.UTC(p.year, 0, p.dayOfYear);
  else ref = Date.UTC(p.year, 6, 1);
  const years = (now.getTime() - ref) / (365.25 * 86400000);
  return Math.max(0, Math.round(years * 10) / 10);
}

function rankSerials(list: DecodedSerial[]): DecodedSerial[] {
  return list
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const c = confRank(b.s.confidence) - confRank(a.s.confidence);
      if (c) return c;
      const amb = Number(a.s.ambiguous ?? false) - Number(b.s.ambiguous ?? false);
      if (amb) return amb;
      const y = Number(b.s.year !== undefined) - Number(a.s.year !== undefined);
      if (y) return y;
      return a.i - b.i;
    })
    .map((x) => x.s);
}

/** Decode a serial against one pack with rejection warnings and ambiguity detail. */
export function decodeSerialWithPackDetailed(pack: ManufacturerPack, serial: string, now?: Date): SerialDecodeDetail {
  const clock = safeNow(now);
  const norm = normalizeNameplateDetailed(serial);
  const detail: SerialDecodeDetail = { results: [], warnings: [], truncated: norm.truncated, normalized: norm.value };
  if (!norm.value || !pack || !Array.isArray(pack.serialFormats)) return detail;
  const mfr = pack.manufacturer || pack.id;

  for (const sf of pack.serialFormats) {
    if (!sf || typeof sf !== "object") continue;
    const re = safeRegex(sf.regex);
    if (!re) {
      detail.warnings.push(`${mfr} serial format ${sf.id}: regex refused by the safety guard`);
      continue;
    }
    const m = matchEither(re, norm.value, norm.compact);
    if (!m) continue;
    const parts = computeDate(sf, m, clock);
    if (typeof parts === "string") {
      detail.warnings.push(`${mfr} serial format ${sf.id} matched "${norm.value}" but was rejected: ${parts}`);
      continue;
    }
    let plant: string | undefined;
    if (sf.plant && typeof sf.plant.group === "number") {
      const raw = groupValue(m, sf.plant.group);
      if (raw !== undefined) plant = lookupMap(sf.plant.map, raw) ?? raw;
    }
    const notes = [...(Array.isArray(sf.notes) ? sf.notes.filter((n) => typeof n === "string") : []), ...parts.notes];
    const decoded: DecodedSerial = {
      formatId: sf.id,
      manufacturerId: pack.id,
      description: sf.description ?? "",
      confidence: asConfidence(sf.confidence),
    };
    if (parts.year !== undefined) decoded.year = parts.year;
    if (parts.month !== undefined) decoded.month = parts.month;
    if (parts.week !== undefined) decoded.week = parts.week;
    if (parts.dayOfYear !== undefined) decoded.dayOfYear = parts.dayOfYear;
    const md = manufactureDate(parts);
    if (md) decoded.manufactureDate = md;
    const age = ageYears(parts, clock);
    if (age !== undefined) decoded.ageYears = age;
    if (plant) decoded.plant = plant;
    if (sf.evidence) decoded.evidence = sf.evidence;
    if (Array.isArray(sf.sources) && sf.sources.length) decoded.sources = [...sf.sources];
    if (parts.altYears.length && parts.year !== undefined) {
      decoded.ambiguous = true;
      decoded.candidateYears = [...new Set([parts.year, ...parts.altYears])].sort((a, b) => a - b);
      decoded.confidence = "low";
      const label = methodLabel(sf.date.method);
      notes.push(`${mfr} ${label}: ${decoded.candidateYears.join(" or ")} — confirm with the nameplate era or compressor date stamps.`);
      detail.warnings.push(
        `Serial date is ambiguous (${decoded.candidateYears.join(" or ")}) — confirm from the unit's era/nameplate (refrigerant, controls, compressor date code).`,
      );
    }
    if (notes.length) decoded.notes = notes;
    detail.results.push(decoded);
  }

  // Cross-format ambiguity: two formats of the same pack yielding different years.
  const years = new Set<number>();
  for (const r of detail.results) {
    if (r.year !== undefined) years.add(r.year);
    for (const y of r.candidateYears ?? []) years.add(y);
  }
  const distinctPrimary = new Set(detail.results.map((r) => r.year).filter((y): y is number => y !== undefined));
  if (distinctPrimary.size > 1) {
    const all = [...years].sort((a, b) => a - b);
    for (const r of detail.results) {
      if (r.year === undefined) continue;
      r.confidence = "low";
      r.ambiguous = true;
      r.candidateYears = all;
      const note = `Serial matches more than one ${mfr} format (${all.join(" or ")}) — the date must be confirmed from the era/nameplate.`;
      r.notes = [...(r.notes ?? []), note];
    }
    detail.warnings.push(
      `Serial date is ambiguous: ${mfr} formats disagree (${all.join(" or ")}) — confirm the manufacture date from the unit's era/nameplate style, refrigerant on the plate, or compressor date code.`,
    );
  }

  detail.results = rankSerials(detail.results);
  detail.warnings = dedupe(detail.warnings);
  return detail;
}

export function decodeSerialWithPack(pack: ManufacturerPack, serial: string, now?: Date): DecodedSerial[] {
  try {
    return decodeSerialWithPackDetailed(pack, serial, now).results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Model decoding
// ---------------------------------------------------------------------------

export interface ModelDecodeDetail {
  results: DecodedModel[]; // ranked, best first
  warnings: string[];
  truncated: boolean;
  normalized: string;
}

function decodeWithFormat(pack: ManufacturerPack, mf: ModelFormat, m: RegExpExecArray): DecodedModel {
  const attributes: Partial<Record<ModelAttribute, string>> = {};
  const segments: DecodedModel["segments"] = [];
  for (const seg of Array.isArray(mf.segments) ? mf.segments : []) {
    if (!seg || typeof seg !== "object") continue;
    const raw = m[seg.group];
    if (raw === undefined || raw === null || raw === "") continue;
    const code = String(raw).toUpperCase();
    const mapped = lookupMap(seg.map, code);
    const transformed = seg.transform ? applyTransform(seg.transform, code) : undefined;
    const value = mapped ?? transformed ?? code;
    const entry: DecodedModel["segments"][number] = { name: seg.name ?? seg.attribute ?? `group ${seg.group}`, code };
    const meaning = mapped ?? transformed;
    if (meaning !== undefined) entry.meaning = meaning;
    segments.push(entry);
    // When several segments share an attribute the later segment wins; every code stays in segments[].
    if (seg.attribute) attributes[seg.attribute] = value;
  }
  const decoded: DecodedModel = {
    formatId: mf.id,
    manufacturerId: pack.id,
    family: mf.family ?? mf.id,
    productType: mf.productType ?? "other",
    attributes,
    segments,
    confidence: asConfidence(mf.confidence),
  };
  const refrigerant = attributes.refrigerant ?? mf.refrigerant;
  if (refrigerant) decoded.refrigerant = refrigerant;
  if (Array.isArray(mf.controlPlatformIds) && mf.controlPlatformIds.length) decoded.controlPlatformIds = [...mf.controlPlatformIds];
  if (Array.isArray(mf.equivalentFamilies) && mf.equivalentFamilies.length) decoded.equivalentFamilies = [...mf.equivalentFamilies];
  if (Array.isArray(mf.notes) && mf.notes.length) decoded.notes = mf.notes.filter((n) => typeof n === "string");
  if (mf.evidence) decoded.evidence = mf.evidence;
  if (Array.isArray(mf.sources) && mf.sources.length) decoded.sources = [...mf.sources];
  return decoded;
}

function rankModels(list: DecodedModel[]): DecodedModel[] {
  return list
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const c = confRank(b.s.confidence) - confRank(a.s.confidence);
      if (c) return c;
      const n = b.s.segments.length - a.s.segments.length;
      if (n) return n;
      return a.i - b.i;
    })
    .map((x) => x.s);
}

/** Decode a model against one pack with warnings. */
export function decodeModelWithPackDetailed(pack: ManufacturerPack, model: string): ModelDecodeDetail {
  const norm = normalizeNameplateDetailed(model);
  const detail: ModelDecodeDetail = { results: [], warnings: [], truncated: norm.truncated, normalized: norm.value };
  if (!norm.value || !pack || !Array.isArray(pack.modelFormats)) return detail;
  const mfr = pack.manufacturer || pack.id;
  for (const mf of pack.modelFormats) {
    if (!mf || typeof mf !== "object") continue;
    const re = safeRegex(mf.regex);
    if (!re) {
      detail.warnings.push(`${mfr} model format ${mf.id}: regex refused by the safety guard`);
      continue;
    }
    const m = matchEither(re, norm.value, norm.compact);
    if (!m) continue;
    detail.results.push(decodeWithFormat(pack, mf, m));
  }
  detail.results = rankModels(detail.results);
  return detail;
}

export function decodeModelWithPack(pack: ManufacturerPack, model: string): DecodedModel[] {
  try {
    return decodeModelWithPackDetailed(pack, model).results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Manufacturer ranking
// ---------------------------------------------------------------------------

function normKey(s: unknown): string {
  return str(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The pack label (id/manufacturer/brand/alias) matched by the hint, or null. */
export function hintMatchesPack(pack: ManufacturerPack, hint: string | undefined): string | null {
  const h = normKey(hint);
  if (!h) return null;
  const candidates = [pack.id, pack.manufacturer, ...(Array.isArray(pack.brands) ? pack.brands : []), ...(Array.isArray(pack.aliases) ? pack.aliases : [])];
  for (const c of candidates) {
    const k = normKey(c);
    if (!k) continue;
    if (k === h) return str(c);
    if (h.length >= 3 && k.includes(h)) return str(c);
    if (k.length >= 3 && h.includes(k)) return str(c);
  }
  return null;
}

interface PackEvaluation {
  pack: ManufacturerPack;
  score: number;
  reason: string;
  hintLabel: string | null;
  model: ModelDecodeDetail;
  serial: SerialDecodeDetail;
}

function evaluatePacks(kb: KnowledgeBase, input: DecodeInput, now: Date): { ranked: PackEvaluation[]; hintRecognized: boolean } {
  const packs = Array.isArray(kb?.manufacturers) ? kb.manufacturers.filter((p) => p && typeof p === "object") : [];
  const hint = str(input?.manufacturer).trim();
  const evals: PackEvaluation[] = packs.map((pack) => {
    const hintLabel = hintMatchesPack(pack, hint);
    let model: ModelDecodeDetail;
    let serial: SerialDecodeDetail;
    try {
      model = decodeModelWithPackDetailed(pack, str(input?.model));
    } catch (e) {
      model = { results: [], warnings: [`${pack.id}: model decode error: ${(e as Error).message}`], truncated: false, normalized: "" };
    }
    try {
      serial = input?.serial ? decodeSerialWithPackDetailed(pack, str(input.serial), now) : { results: [], warnings: [], truncated: false, normalized: "" };
    } catch (e) {
      serial = { results: [], warnings: [`${pack.id}: serial decode error: ${(e as Error).message}`], truncated: false, normalized: "" };
    }
    let score = 0;
    const reasons: string[] = [];
    if (hintLabel) {
      score += 100;
      reasons.push(`hint "${hint}" matches ${hintLabel}`);
    }
    let modelPts = 0;
    for (const r of model.results) modelPts += r.confidence === "low" ? 20 : 40;
    if (model.results.length) {
      score += modelPts;
      reasons.push(`${model.results.length} model format${model.results.length > 1 ? "s" : ""} matched (${model.results.map((r) => r.formatId).join(", ")})`);
    }
    if (serial.results.length) {
      score += 30 * serial.results.length;
      reasons.push(`${serial.results.length} serial format${serial.results.length > 1 ? "s" : ""} matched (${serial.results.map((r) => r.formatId).join(", ")})`);
    }
    if (model.results.length && serial.results.length) {
      score += 10;
      reasons.push("model and serial both match this pack");
    }
    return { pack, score, reason: reasons.join("; ") || "no match", hintLabel, model, serial };
  });
  const hintRecognized = Boolean(hint) && evals.some((e) => e.hintLabel);
  const pool = hintRecognized ? evals.filter((e) => e.hintLabel) : evals;
  const ranked = pool
    .map((e, i) => ({ e, i }))
    .filter((x) => x.e.score > 0)
    .sort((a, b) => b.e.score - a.e.score || a.i - b.i)
    .map((x) => x.e);
  return { ranked, hintRecognized };
}

/** Rank manufacturer packs by how well they match the hint / model / serial. */
export function rankManufacturers(kb: KnowledgeBase, input: DecodeInput): { pack: ManufacturerPack; score: number; reason: string }[] {
  try {
    const { ranked } = evaluatePacks(kb, input ?? { model: "" }, safeNow(input?.now));
    return ranked.map((e) => ({ pack: e.pack, score: e.score, reason: e.reason }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Family scoping helpers (controls / electrical / common issues)
// ---------------------------------------------------------------------------

/** Does a family selector (format id, label, or regex) apply to the matched model format / model string? */
export function familySelectorMatches(selector: unknown, formatId: string | undefined, model: string | undefined): boolean {
  if (typeof selector !== "string" || !selector.trim()) return false;
  const sel = selector.trim();
  if (formatId && sel.toLowerCase() === formatId.toLowerCase()) return true;
  if (typeof sel === "string" && sel.length <= MAX_REGEX_LENGTH && !hasNestedQuantifier(sel)) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(sel, "i");
    } catch {
      re = null;
    }
    if (re) {
      if (formatId && formatId.length <= MAX_NAMEPLATE_LENGTH * 2 && re.test(formatId)) return true;
      if (model && model.length <= MAX_NAMEPLATE_LENGTH && re.test(model)) return true;
      const compact = model?.replace(/ /g, "");
      if (compact && compact !== model && re.test(compact)) return true;
    }
  }
  // loose: selector text contains the format id (e.g. "rheem-commercial-package-rk-rl-rq (revision C and later)")
  if (formatId && sel.toLowerCase().includes(formatId.toLowerCase())) return true;
  return false;
}

export function selectControls(pack: ManufacturerPack, best: DecodedModel | undefined, model: string | undefined): ControlPlatform[] {
  const controls = Array.isArray(pack.controls) ? pack.controls.filter((c) => c && typeof c === "object") : [];
  if (!best) return [];
  const out: ControlPlatform[] = [];
  for (const id of best.controlPlatformIds ?? []) {
    const c = controls.find((x) => x.id === id);
    if (c && !out.includes(c)) out.push(c);
  }
  for (const c of controls) {
    if (out.includes(c)) continue;
    if ((c.appliesTo ?? []).some((sel) => familySelectorMatches(sel, best.formatId, model))) out.push(c);
  }
  return out;
}

export function selectElectrical(pack: ManufacturerPack, best: DecodedModel | undefined, model: string | undefined): FamilyElectrical[] {
  const list = Array.isArray(pack.electrical) ? pack.electrical.filter((e) => e && typeof e === "object") : [];
  return list.filter((e) => !e.familyRegex || (best ? familySelectorMatches(e.familyRegex, best.formatId, model) : false));
}

export function selectCommonIssues(pack: ManufacturerPack, best: DecodedModel | undefined, model: string | undefined): CommonIssue[] {
  const list = Array.isArray(pack.commonIssues) ? pack.commonIssues.filter((e) => e && typeof e === "object") : [];
  return list.filter((e) => !e.appliesTo || (best ? familySelectorMatches(e.appliesTo, best.formatId, model) : false));
}

// ---------------------------------------------------------------------------
// Full decode
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function describeAttributes(m: DecodedModel): string {
  const a = m.attributes;
  const bits: string[] = [];
  if (a.tonnage) bits.push(`${a.tonnage} ton${a.tonnage === "1" ? "" : "s"}`);
  if (a.unit_type) bits.push(a.unit_type);
  if (m.refrigerant) bits.push(m.refrigerant);
  if (a.voltage) bits.push(a.voltage);
  if (a.heat_type) bits.push(a.heat_type);
  if (a.efficiency) bits.push(a.efficiency);
  return bits.join(", ");
}

function describeDate(s: DecodedSerial): string {
  if (s.year === undefined) return "";
  let d = `built ${s.year}`;
  if (s.month !== undefined) d = `built ${s.year}-${String(s.month).padStart(2, "0")}`;
  else if (s.week !== undefined) d = `built ${s.year} week ${s.week}`;
  if (s.ageYears !== undefined) d += ` (about ${s.ageYears} years old)`;
  if (s.plant) d += `, plant ${s.plant}`;
  return d;
}

/** Full decode across all packs. Never throws on bad input; returns warnings instead. */
export function decodeUnit(kb: KnowledgeBase, input: DecodeInput): DecodeResult {
  const modelRaw = str(input?.model);
  const serialRaw = str(input?.serial);
  const hintRaw = str(input?.manufacturer).trim();
  const result: DecodeResult = {
    input: { model: modelRaw },
    manufacturerCandidates: [],
    model: [],
    serial: [],
    controls: [],
    electrical: [],
    commonIssues: [],
    summary: "",
    warnings: [],
  };
  if (serialRaw) result.input.serial = serialRaw;
  if (hintRaw) result.input.manufacturer = hintRaw;

  try {
    const now = safeNow(input?.now);
    const model = normalizeNameplateDetailed(modelRaw);
    const serial = normalizeNameplateDetailed(serialRaw);
    const warnings: string[] = [];
    if (model.truncated) warnings.push(`Model input was truncated to ${MAX_NAMEPLATE_LENGTH} characters ("${model.value}").`);
    if (serial.truncated) warnings.push(`Serial input was truncated to ${MAX_NAMEPLATE_LENGTH} characters ("${serial.value}").`);

    if (!model.value && !serial.value) {
      warnings.push("No model or serial number given — nothing to decode.");
      result.summary = "Low confidence: no model or serial number was given; read the nameplate and try again.";
      result.warnings = warnings;
      return result;
    }

    const { ranked, hintRecognized } = evaluatePacks(
      kb,
      { model: model.value, serial: serial.value || undefined, manufacturer: hintRaw || undefined, now },
      now,
    );
    if (hintRaw && !hintRecognized) warnings.push(`Manufacturer hint "${hintRaw}" is not a known pack; searched all manufacturers.`);

    result.manufacturerCandidates = ranked.map((e) => ({ id: e.pack.id, manufacturer: e.pack.manufacturer, score: e.score, reason: e.reason }));
    for (const e of ranked) {
      result.model.push(...e.model.results);
      result.serial.push(...e.serial.results);
    }

    const best = ranked[0];
    if (!best) {
      warnings.push("No manufacturer matched; verify the nameplate (model and serial) and the manufacturer/brand.");
      const what = [model.value ? `model "${model.value}"` : "", serial.value ? `serial "${serial.value}"` : ""].filter(Boolean).join(" or ");
      result.summary = `Low confidence: no manufacturer pack matched ${what}. Verify the nameplate; there is no manufacturer-specific data for this unit yet.`;
      result.warnings = dedupe(warnings);
      return result;
    }

    const pack = best.pack;
    const mfr = pack.manufacturer || pack.id;
    const bestModel = best.model.results[0];
    const bestSerial = best.serial.results[0];
    warnings.push(...best.model.warnings, ...best.serial.warnings);

    result.controls = selectControls(pack, bestModel, model.value);
    result.electrical = selectElectrical(pack, bestModel, model.value);
    result.commonIssues = selectCommonIssues(pack, bestModel, model.value);
    if (pack.support) result.support = pack.support;

    if (model.value && !bestModel) {
      warnings.push(`Model "${model.value}" did not match any ${mfr} model format — attributes unknown; confirm the nomenclature in the IOM.`);
    }
    if (serial.value && !bestSerial) {
      warnings.push(`Serial "${serial.value}" did not match any ${mfr} serial format — model-only match; manufacture date unknown. Read the serial from the unit nameplate (not a component tag).`);
    } else if (!serial.value) {
      warnings.push("No serial number given — manufacture date and age unknown.");
    }
    if (bestSerial && bestSerial.year === undefined && !bestSerial.ambiguous) {
      warnings.push(`${mfr} serial format ${bestSerial.formatId} matched but the date must be read manually — see the format notes.`);
    }
    const overall: Confidence = minConfidence(bestModel?.confidence, bestSerial?.confidence);
    if (overall === "low") warnings.push("Low-confidence match — verify tonnage, voltage, refrigerant and age on the nameplate/IOM before relying on them.");
    if (bestSerial?.ageYears !== undefined && bestSerial.ageYears > OLD_UNIT_YEARS) {
      warnings.push(
        `Unit is about ${bestSerial.ageYears} years old (built ${bestSerial.year}) — over ${OLD_UNIT_YEARS} years; parts and refrigerant availability may be limited and the nameplate data may not reflect later retrofits.`,
      );
    }

    // Summary
    const parts: string[] = [];
    let head = `${capitalize(overall)} confidence: ${mfr}`;
    if (bestModel) {
      head += ` ${bestModel.family}`;
      const attrs = describeAttributes(bestModel);
      if (attrs) head += ` — ${attrs}`;
      if (bestModel.equivalentFamilies?.length) head += ` (equivalent: ${bestModel.equivalentFamilies.join(", ")})`;
    } else {
      head += model.value ? ` (model "${model.value}" not decoded)` : " (no model given)";
    }
    parts.push(`${head}.`);
    if (bestSerial) {
      if (bestSerial.ambiguous && bestSerial.candidateYears?.length) {
        const sf = pack.serialFormats.find((f) => f.id === bestSerial.formatId);
        const label = sf ? methodLabel(sf.date?.method) : "serial date";
        parts.push(
          `${mfr} ${label}: ${bestSerial.candidateYears.join(" or ")} — confirm with the nameplate era (refrigerant, controls) or compressor date stamps.`,
        );
      } else if (bestSerial.year !== undefined) {
        parts.push(`${capitalize(describeDate(bestSerial))}.`);
      } else {
        parts.push("Manufacture date must be read manually for this serial format.");
      }
    } else if (serial.value) {
      parts.push("Serial did not decode — manufacture date unknown.");
    }
    if (overall !== "high") parts.push("Verify on the nameplate.");
    if (result.controls.length) parts.push(`Controls: ${result.controls.map((c) => c.name).join("; ")}.`);
    result.summary = parts.join(" ");

    // Evidence summary
    const ev: string[] = [];
    if (bestModel) {
      const src = shortSource(bestModel.sources);
      ev.push(`Nomenclature: ${bestModel.family} — ${evidenceLabel(bestModel.evidence, bestModel.confidence)}${src ? ` (${src})` : ""}`);
    }
    if (bestSerial) {
      const src = shortSource(bestSerial.sources);
      ev.push(`Serial rule: ${bestSerial.formatId} — ${evidenceLabel(bestSerial.evidence, bestSerial.confidence)}${src ? ` (${src})` : ""}`);
    }
    if (result.controls.length) {
      const cov = result.controls.map((c) => `${c.name}: ${c.coverage ?? "unknown"} coverage`).join("; ");
      ev.push(`Fault codes: ${cov}`);
    }
    result.evidenceSummary = ev.length ? ev.join(". ") : "No manufacturer evidence available for this unit.";

    result.warnings = dedupe(warnings);
    return result;
  } catch (e) {
    result.warnings.push(`Decoder error: ${(e as Error)?.message ?? String(e)}`);
    if (!result.summary) result.summary = "Low confidence: the decoder hit an internal error; verify the nameplate manually.";
    return result;
  }
}
