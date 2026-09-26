import type { ControlPlatform, FaultCode, KnowledgeBase, ManufacturerPack } from "../types.ts";

export interface FaultHit {
  manufacturerId: string;
  manufacturer: string;
  platform: ControlPlatform;
  fault: FaultCode;
  score: number;
}

/** Maximum hits returned by lookupFaultCode. */
export const MAX_FAULT_HITS = 20;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Canonical form of a fault code: uppercase, spaces/dashes/underscores/dots removed, and every
 * digit run stripped of leading zeros ("a-140" → "A140", "03" → "3", "E03" → "E3", "LED 3 flashes" → "LED3FLASHES").
 */
export function normalizeFaultCode(code: unknown): string {
  return str(code)
    .toUpperCase()
    .replace(/[\s\-_.:#]+/g, "")
    .replace(/\d+/g, (d) => {
      const t = d.replace(/^0+/, "");
      return t === "" ? "0" : t;
    });
}

/** Loose key for manufacturer/platform matching: lowercase alphanumerics only. */
function looseKey(s: unknown): string {
  return str(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokens(s: unknown): string[] {
  return str(s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/** Flash count in an LED phrase ("3 flashes", "flashes 3 times", "3x flash", "LED 3 flash"), or undefined. */
export function parseFlashCount(query: unknown): number | undefined {
  const q = str(query).toUpperCase();
  if (!/FLASH|BLINK/.test(q)) return undefined;
  let m = /(\d+)\s*(?:X\s*)?(?:FLASH|BLINK)/.exec(q);
  if (!m) m = /(?:FLASH|BLINK)(?:ES|ING|S)?\s*(\d+)/.exec(q);
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Non-LED words of a query ("IGC 3 flashes" → ["igc"]), used to boost matching platforms/codes. */
function extraTokens(query: string): string[] {
  const stop = new Set(["flash", "flashes", "flashing", "blink", "blinks", "blinking", "led", "code", "times", "fault", "alarm", "error"]);
  return tokens(query).filter((t) => !stop.has(t) && !/^\d+$/.test(t));
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function packMatchesManufacturer(pack: ManufacturerPack, hint: string): boolean {
  const h = looseKey(hint);
  if (!h) return true;
  const candidates = [pack.id, pack.manufacturer, ...(Array.isArray(pack.brands) ? pack.brands : []), ...(Array.isArray(pack.aliases) ? pack.aliases : [])];
  for (const c of candidates) {
    const k = looseKey(c);
    if (!k) continue;
    if (k === h) return true;
    if (h.length >= 3 && k.includes(h)) return true;
    if (k.length >= 3 && h.includes(k)) return true;
  }
  return false;
}

/** Fuzzy platform match on id/name: equality, containment, or a shared token (≥ 3 chars). */
export function platformMatches(platform: ControlPlatform, hint: string): boolean {
  const h = looseKey(hint);
  if (!h) return true;
  const id = looseKey(platform.id);
  const name = looseKey(platform.name);
  if (h === id || h === name) return true;
  if (h.length >= 3 && (id.includes(h) || name.includes(h))) return true;
  if (id.length >= 3 && h.includes(id)) return true;
  if (name.length >= 3 && h.includes(name)) return true;
  const want = tokens(hint);
  const have = new Set([...tokens(platform.id), ...tokens(platform.name)]);
  return want.some((t) => have.has(t));
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

const SCORE_EXACT = 100;
const SCORE_NORMALIZED = 90;
const SCORE_LED_PATTERN = 70;
const SCORE_FLASH_CODE = 65;
const SCORE_CONTAINS = 60;
const BOOST_TOKEN = 5;

function scoreCode(code: string, queryRaw: string, queryNorm: string, queryTokens: string[], flashCount: number | undefined): number {
  const raw = code.trim().toUpperCase();
  if (raw && raw === queryRaw) return SCORE_EXACT;
  const norm = normalizeFaultCode(code);
  if (!norm || !queryNorm) return 0;
  if (norm === queryNorm) return SCORE_NORMALIZED;
  if (flashCount !== undefined) {
    const n = parseFlashCount(code);
    if (n === flashCount) return SCORE_FLASH_CODE;
    if (norm.includes(`${flashCount}FLASH`) || norm.includes(`${flashCount}BLINK`)) return SCORE_FLASH_CODE;
  }
  if (queryNorm.length >= 2 && norm.includes(queryNorm)) return SCORE_CONTAINS;
  // a phrase query names the code as a whole token (e.g. "code E3 on the board" vs "E3"); never a substring
  if (flashCount === undefined && norm.length >= 2 && queryTokens.length > 1 && queryTokens.includes(norm)) return SCORE_CONTAINS - 10;
  return 0;
}

/** Normalized whole tokens of a query ("code E-03 on the board" → ["CODE", "E3", "ON", "THE", "BOARD"]). */
function queryTokenList(queryRaw: string): string[] {
  return queryRaw
    .split(/\s+/)
    .map((t) => normalizeFaultCode(t))
    .filter((t) => t.length > 0);
}

/** Look up a fault/alarm code, optionally scoped by manufacturer and/or control platform. */
export function lookupFaultCode(kb: KnowledgeBase, code: string, opts?: { manufacturer?: string; platform?: string }): FaultHit[] {
  try {
    const queryRaw = str(code).trim().toUpperCase();
    const queryNorm = normalizeFaultCode(code);
    if (!queryNorm) return [];
    const flashCount = parseFlashCount(queryRaw);
    const queryTokens = queryTokenList(queryRaw);
    // extra words only matter for LED phrases ("IGC 3 flashes" → boost the IGC platform)
    const extras = flashCount !== undefined ? extraTokens(queryRaw) : [];
    const mfrHint = str(opts?.manufacturer).trim();
    const platHint = str(opts?.platform).trim();

    const packs = (Array.isArray(kb?.manufacturers) ? kb.manufacturers : []).filter((p) => p && typeof p === "object");
    let scoped = mfrHint ? packs.filter((p) => packMatchesManufacturer(p, mfrHint)) : packs;
    if (mfrHint && scoped.length === 0) scoped = packs; // unknown hint: search everything

    let platforms: { pack: ManufacturerPack; platform: ControlPlatform }[] = [];
    for (const pack of scoped) {
      for (const platform of Array.isArray(pack.controls) ? pack.controls : []) {
        if (platform && typeof platform === "object") platforms.push({ pack, platform });
      }
    }
    if (platHint) {
      const filtered = platforms.filter((x) => platformMatches(x.platform, platHint));
      if (filtered.length) platforms = filtered;
    }

    const hits: { hit: FaultHit; order: number }[] = [];
    let order = 0;
    for (const { pack, platform } of platforms) {
      const platformText = `${looseKey(platform.id)} ${looseKey(platform.name)} ${looseKey(platform.description)}`;
      const platformBoost = extras.some((t) => platformText.includes(t)) ? BOOST_TOKEN : 0;
      const push = (fault: FaultCode, score: number) => {
        if (score <= 0) return;
        const codeText = looseKey(fault.code);
        const codeBoost = extras.some((t) => codeText.includes(t)) ? BOOST_TOKEN : 0;
        hits.push({
          hit: { manufacturerId: pack.id, manufacturer: pack.manufacturer, platform, fault, score: score + platformBoost + codeBoost },
          order: order++,
        });
      };
      for (const fault of Array.isArray(platform.faultCodes) ? platform.faultCodes : []) {
        if (!fault || typeof fault !== "object" || !fault.code) continue;
        push(fault, scoreCode(str(fault.code), queryRaw, queryNorm, queryTokens, flashCount));
      }
      for (const led of Array.isArray(platform.ledPatterns) ? platform.ledPatterns : []) {
        if (!led || typeof led !== "object" || !led.pattern) continue;
        let score = scoreCode(str(led.pattern), queryRaw, queryNorm, queryTokens, flashCount);
        if (flashCount !== undefined && parseFlashCount(led.pattern) === flashCount) score = Math.max(score, SCORE_LED_PATTERN);
        if (score <= 0) continue;
        const fault: FaultCode = { code: str(led.pattern), meaning: str(led.meaning) };
        if (Array.isArray(led.checks) && led.checks.length) fault.checks = [...led.checks];
        fault.notes = "LED flash pattern";
        const doc = platform.sourceDocs?.[0];
        if (doc?.title) fault.source = doc.docId ? `${doc.title} (${doc.docId})` : doc.title;
        else if (platform.sources?.[0]) fault.source = platform.sources[0];
        push(fault, score);
      }
    }

    hits.sort((a, b) => b.hit.score - a.hit.score || a.order - b.order);
    return hits.slice(0, MAX_FAULT_HITS).map((h) => h.hit);
  } catch {
    return [];
  }
}
