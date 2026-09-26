import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeBase, ManufacturerPack } from "../types.ts";
import {
  analyzeRegex,
  applyTransform,
  countRegexGroups,
  decodeModelWithPack,
  decodeSerialWithPack,
  decodeSerialWithPackDetailed,
  decodeUnit,
  familySelectorMatches,
  formatTons,
  hasNestedQuantifier,
  normalizeNameplate,
  normalizeNameplateDetailed,
  rankManufacturers,
} from "./decoder.ts";

// ---------------------------------------------------------------------------
// Synthetic "Acme" pack (real packs are being written in parallel; never depend on them here)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-26T12:00:00Z");

const MONTH_LETTERS = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 9, K: 10, L: 11, M: 12 };

export function acmePack(): ManufacturerPack {
  return {
    id: "acme",
    manufacturer: "Acme Air",
    brands: ["Acme", "Acme Commercial"],
    aliases: ["ACME HVAC"],
    confidence: "medium",
    sources: ["Acme nomenclature sheet AC-NOM-1"],
    lastReviewed: "2026-09-01",
    serialFormats: [
      {
        id: "acme-yyww",
        description: "2000-present: YYWW + plant letter + 5 digits",
        eraStart: 2000,
        regex: "^(\\d{2})(\\d{2})([A-Z])\\d{5}$",
        date: { method: "twoDigitYear", yearGroup: 1, weekGroup: 2, pivot: 70 },
        plant: { group: 3, map: { T: "Tulsa, OK" } },
        examples: [
          { serial: "1204T12345", expect: { year: 2012, week: 4 } },
          { serial: "2415T12345", expect: { year: 2024, week: 15 } },
          { serial: "0752Q00001", expect: { year: 2007, week: 52 } },
        ],
        confidence: "high",
        evidence: "manufacturer_doc",
        sources: ["Acme warranty lookup guide WL-2"],
        notes: ["Week is 01-53."],
      },
      {
        id: "acme-letter-month",
        description: "2010-2015: month letter + year letter + 6 digits",
        eraStart: 2010,
        eraEnd: 2015,
        regex: "^([A-M])([A-F])(\\d{6})$",
        date: {
          method: "letterYear",
          yearGroup: 2,
          map: { A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015 },
          monthGroup: 1,
          monthLetterMap: MONTH_LETTERS,
        },
        examples: [
          { serial: "CB123456", expect: { year: 2011, month: 3 } },
          { serial: "MF654321", expect: { year: 2015, month: 12 } },
        ],
        confidence: "medium",
        evidence: "multi_secondary",
        sources: ["decoder site 1", "decoder site 2"],
      },
      {
        id: "acme-decade",
        description: "X + decade digit + year digit + MM + 4 digits",
        eraStart: 2000,
        regex: "^X(\\d)(\\d)(\\d{2})(\\d{4})$",
        date: { method: "decadeDigitYear", decadeGroup: 1, yearGroup: 2, monthGroup: 3 },
        examples: [
          { serial: "X23061234", expect: { year: 2023, month: 6 } },
          { serial: "X10121234", expect: { year: 2010, month: 12 } },
        ],
        confidence: "medium",
        evidence: "single_secondary",
        sources: ["forum post"],
      },
      {
        id: "acme-legacy-mmyy",
        description: "1980-2010: X + MM + YY + 4 digits (collides with acme-decade)",
        eraStart: 1980,
        eraEnd: 2010,
        regex: "^X(\\d{2})(\\d{2})(\\d{4})$",
        date: { method: "twoDigitYear", yearGroup: 2, monthGroup: 1, pivot: 70 },
        examples: [
          { serial: "X11951234", expect: { year: 1995, month: 11 } },
          { serial: "X03881234", expect: { year: 1988, month: 3 } },
        ],
        confidence: "low",
        evidence: "inferred",
      },
      {
        id: "acme-onedigit",
        description: "2002-2009: Q + year digit + WW + 3 letters",
        eraStart: 2002,
        eraEnd: 2009,
        regex: "^Q(\\d)(\\d{2})[A-Z]{3}$",
        date: { method: "oneDigitYear", yearGroup: 1, decadeBase: 2000, weekGroup: 2 },
        examples: [
          { serial: "Q712ABC", expect: { year: 2007, week: 12 } },
          { serial: "Q305XYZ", expect: { year: 2003, week: 5 } },
        ],
        confidence: "medium",
        evidence: "multi_secondary",
        sources: ["a", "b"],
      },
      {
        id: "acme-doy",
        description: "D + YYYY + day of year",
        regex: "^D(\\d{4})(\\d{3})$",
        date: { method: "fourDigitYear", yearGroup: 1, dayOfYearGroup: 2 },
        examples: [
          { serial: "D2021045", expect: { year: 2021, dayOfYear: 45 } },
          { serial: "D2019300", expect: { year: 2019, dayOfYear: 300 } },
        ],
        confidence: "medium",
        sources: ["x"],
      },
      {
        id: "acme-manual",
        description: "MAN prefix: date on the compressor tag only",
        regex: "^MAN[A-Z0-9]{4,10}$",
        date: { method: "manual", note: "Read the date from the compressor data tag." },
        examples: [{ serial: "MAN12345", expect: {} }, { serial: "MANABCDE", expect: {} }],
        confidence: "low",
      },
    ],
    modelFormats: [
      {
        id: "acme-rtu",
        family: "Acme AG/AC packaged rooftop",
        productType: "packaged_rtu",
        regex: "^(A)([GC])(\\d{3})([A-Z])(\\d)(?:[-A-Z0-9/]*)?$",
        segments: [
          { group: 1, name: "Series", attribute: "series", map: { A: "Acme rooftop" } },
          { group: 2, name: "Unit type", attribute: "unit_type", map: { G: "Gas heat / electric cooling", C: "Cooling only" } },
          { group: 3, name: "Nominal cooling (MBH)", attribute: "tonnage", transform: "mbh_to_tons", map: { "181": "15" } },
          { group: 4, name: "Revision", attribute: "revision" },
          { group: 5, name: "Voltage", attribute: "voltage", map: { "1": "208-230/1/60", "3": "208-230/3/60", "4": "460/3/60" } },
        ],
        refrigerant: "R-410A",
        controlPlatformIds: ["acme-ctl"],
        equivalentFamilies: ["Zeta ZR (rebadge)"],
        examples: [
          { model: "AG036B3", expect: { tonnage: "3", unit_type: "Gas heat / electric cooling", voltage: "208-230/3/60", revision: "B", family: "Acme AG/AC packaged rooftop" } },
          { model: "AG090C4-XYZ/12", expect: { tonnage: "7.5", voltage: "460/3/60" } },
          { model: "AC150A3", expect: { tonnage: "12.5", unit_type: "Cooling only" } },
        ],
        confidence: "high",
        evidence: "manufacturer_doc",
        sources: ["Acme product data PD-AG-2024, nomenclature page"],
      },
      {
        id: "acme-chiller",
        family: "Acme ACH air-cooled chiller",
        productType: "chiller",
        regex: "^(ACH)(\\d{2})([A-Z])(?:[-A-Z0-9/]*)?$",
        segments: [
          { group: 1, name: "Series", attribute: "series", map: { ACH: "Acme chiller" } },
          { group: 2, name: "Size", attribute: "tonnage", transform: "map_tons", map: { "04": "3", "08": "7.5", "12": "10" } },
          { group: 3, name: "Revision", attribute: "revision" },
        ],
        examples: [{ model: "ACH08A", expect: { tonnage: "7.5" } }],
        confidence: "low",
        evidence: "inferred",
      },
      {
        id: "acme-heater",
        family: "Acme AH unit heater",
        productType: "other",
        regex: "^(AH)(\\d{3})(\\d{3})$",
        segments: [
          { group: 1, name: "Series", attribute: "series", map: { AH: "Acme heater" } },
          { group: 2, name: "Cooling (tons x10)", attribute: "tonnage", transform: "tons_x10" },
          { group: 3, name: "Heat input (kBTUh)", attribute: "heat_capacity", transform: "kbtuh" },
        ],
        examples: [{ model: "AH030072", expect: { tonnage: "3", heat_capacity: "072" } }],
        confidence: "medium",
        sources: ["x"],
      },
    ],
    controls: [
      {
        id: "acme-ctl",
        name: "Acme SmartCtl unit controller",
        appliesTo: ["acme-rtu"],
        faultCodes: [
          { code: "A140", meaning: "High pressure switch open", likelyCauses: ["Dirty condenser"], checks: ["Check head pressure"], severity: "lockout", source: "Acme SM-1 §4.2" },
          { code: "03", meaning: "Low pressure lockout", source: "Acme SM-1 §4.3" },
          { code: "E3", meaning: "Return air sensor fault", source: "Acme SM-1 §4.4" },
          { code: "LED 3 flashes", meaning: "Pressure switch stuck open", source: "Acme SM-1 §5" },
        ],
        ledPatterns: [{ pattern: "3 flashes", meaning: "Pressure switch stuck open (LED)", checks: ["Check inducer"] }],
        coverage: "partial",
        sourceDocs: [{ title: "Acme SM-1 service manual", docId: "SM-1" }],
        confidence: "medium",
        sources: ["Acme SM-1"],
      },
      {
        id: "acme-igc",
        name: "Acme IGC ignition control",
        appliesTo: ["acme-rtu"],
        faultCodes: [{ code: "2 flashes", meaning: "Pressure switch open", source: "Acme IGC guide" }],
        ledPatterns: [{ pattern: "3 flashes", meaning: "Flame rollout / limit open" }],
        coverage: "complete",
        confidence: "medium",
        sources: ["Acme IGC guide"],
      },
      {
        id: "acme-chiller-ctl",
        name: "Acme ChillCtl",
        appliesTo: ["^ACH"],
        faultCodes: [{ code: "C1", meaning: "Evaporator freeze protection", source: "Acme CH-SM" }],
        confidence: "low",
      },
    ],
    electrical: [
      { familyRegex: "acme-rtu", familyLabel: "Acme rooftops", controlVoltage: "24 VAC", components: [{ designator: "C", name: "Compressor contactor" }], confidence: "medium", sources: ["IOM"] },
      { familyRegex: "^ACH", familyLabel: "Acme chillers", components: [{ designator: "CB", name: "Circuit breaker" }], confidence: "low" },
    ],
    commonIssues: [
      { symptom: "Rooftop short cycles on high pressure", likelyCauses: ["Dirty condenser"], checks: ["Wash coil"], appliesTo: "acme-rtu", confidence: "medium" },
      { symptom: "Generic Acme issue", likelyCauses: ["x"], checks: ["y"] },
      { symptom: "Chiller freeze trips", likelyCauses: ["Low flow"], checks: ["Check strainer"], appliesTo: "^ACH" },
    ],
    support: { phone: "800-555-0100", literatureUrl: "https://example.invalid/literature", literatureSearchHint: "search '<model> IOM'" },
  };
}

function zetaPack(): ManufacturerPack {
  return {
    id: "zeta",
    manufacturer: "Zeta Corp",
    brands: ["Zeta"],
    confidence: "medium",
    serialFormats: [
      {
        id: "zeta-yyww",
        description: "YYWW + 2 letters",
        regex: "^(\\d{2})(\\d{2})[A-Z]{2}$",
        date: { method: "twoDigitYear", yearGroup: 1, weekGroup: 2 },
        examples: [{ serial: "1510AB", expect: { year: 2015, week: 10 } }, { serial: "2001ZZ", expect: { year: 2020, week: 1 } }],
        confidence: "medium",
        sources: ["z"],
      },
    ],
    modelFormats: [
      {
        id: "zeta-z",
        family: "Zeta Z rooftop",
        productType: "packaged_rtu",
        regex: "^(Z)(\\d{3})$",
        segments: [{ group: 2, name: "MBH", attribute: "tonnage", transform: "mbh_to_tons" }],
        examples: [{ model: "Z060", expect: { tonnage: "5" } }],
        confidence: "medium",
        sources: ["z"],
      },
    ],
    controls: [],
    commonIssues: [],
  };
}

function kbWith(...packs: ManufacturerPack[]): KnowledgeBase {
  return {
    manufacturers: packs,
    refrigerants: { meta: [], tables: new Map() },
    diagnostics: {
      rules: {
        version: "0",
        defaults: {
          targetSubcoolingTxvF: 10,
          condenserSplitNormalF: { min: 15, max: 30 },
          evapTdNormalF: { min: 30, max: 40 },
          deltaTNormalF: { min: 16, max: 22 },
          dischargeTempWarnF: 225,
          dischargeTempCriticalF: 250,
          compressionRatioWarn: 4,
        },
        rules: [],
      },
      charging: { version: "0", fixedOrificeSuperheat: { indoorWbF: [], outdoorDbF: [], targetF: [] }, notes: [] },
    },
    electrical: { version: "0", components: [], procedures: [], reference: [] },
  };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe("normalizeNameplate", () => {
  test("trims, uppercases, collapses whitespace and strips stray punctuation", () => {
    assert.equal(normalizeNameplate("  ag036b3 "), "AG036B3");
    assert.equal(normalizeNameplate("RN-010-3-0-EB09-2E3:AAG0"), "RN-010-3-0-EB09-2E3AAG0");
    assert.equal(normalizeNameplate("xc21 \t -036\n230"), "XC21 -036 230");
    assert.equal(normalizeNameplate("48TC*D08A2A5"), "48TCD08A2A5");
    assert.equal(normalizeNameplate("R-1234ze(E)"), "R-1234ZE(E)");
  });
  test("strips a leading MODEL / M/N / S/N / SERIAL label", () => {
    assert.equal(normalizeNameplate("Model: AG036B3"), "AG036B3");
    assert.equal(normalizeNameplate("MODEL NO. AG036B3"), "AG036B3");
    assert.equal(normalizeNameplate("M/N AG036B3"), "AG036B3");
    assert.equal(normalizeNameplate("S/N 1204T12345"), "1204T12345");
    assert.equal(normalizeNameplate("Serial # 1204T12345"), "1204T12345");
    assert.equal(normalizeNameplate("MODELX123"), "MODELX123", "label must be a whole word");
  });
  test("caps at 64 chars and reports truncation", () => {
    const long = "A".repeat(80);
    const d = normalizeNameplateDetailed(long);
    assert.equal(d.value.length, 64);
    assert.equal(d.truncated, true);
    assert.equal(normalizeNameplateDetailed("short").truncated, false);
    assert.equal(normalizeNameplateDetailed("A B C").compact, "ABC");
  });
  test("tolerates non-string input", () => {
    assert.equal(normalizeNameplate(undefined as unknown as string), "");
    assert.equal(normalizeNameplate(null as unknown as string), "");
    assert.equal(normalizeNameplate(123 as unknown as string), "123");
  });
});

// ---------------------------------------------------------------------------
// Regex guard
// ---------------------------------------------------------------------------

describe("regex guard", () => {
  test("rejects nested quantifiers heuristically", () => {
    assert.equal(hasNestedQuantifier("^(a+)+$"), true);
    assert.equal(hasNestedQuantifier("^(a*)*$"), true);
    assert.equal(hasNestedQuantifier("^(\\d{2,3})+$"), true);
    assert.equal(hasNestedQuantifier("^((a)+)+$"), true);
    assert.equal(hasNestedQuantifier("^(a|b+)+$"), true);
    assert.equal(hasNestedQuantifier("^(\\d{2,})*$"), true);
    assert.equal(hasNestedQuantifier("^(a+)?$"), false);
    assert.equal(hasNestedQuantifier("^(?:[-A-Z0-9/ ]*)?$"), false);
    assert.equal(hasNestedQuantifier("^([12]\\d)([0-5]\\d)[A-Z0-9]{5,9}$"), false);
    assert.equal(hasNestedQuantifier("^([A-Z0-9]{2,6}) ?([FMGNW]) ?(\\d{2})(\\d{2}) ?(\\d{3,6})$"), false);
    assert.equal(hasNestedQuantifier("^(a{2})+$"), false, "bounded exact inner count is fine");
    assert.equal(hasNestedQuantifier("^[+*]+(x)$"), false, "quantifier chars inside a class are literals");
    assert.equal(hasNestedQuantifier("^(\\++)+$"), true, "escaped plus then real quantifiers");
  });
  test("analyzeRegex reports length, compile, anchoring and group count", () => {
    const ok = analyzeRegex("^(\\d{2})(\\d{2})([A-Z])\\d{5}$");
    assert.deepEqual(ok, { ok: true, groups: 3, anchored: true });
    const un = analyzeRegex("(\\d{2})");
    assert.ok(un.ok && un.anchored === false);
    assert.equal(analyzeRegex("^(a+)+$").ok, false);
    assert.equal(analyzeRegex("^" + "a".repeat(400) + "$").ok, false);
    assert.equal(analyzeRegex("^(unclosed$").ok, false);
    assert.equal(analyzeRegex("").ok, false);
    assert.equal(analyzeRegex(42).ok, false);
    assert.equal(countRegexGroups("^(a)(?:b)(c(d))$"), 3);
    const esc = analyzeRegex("^abc\\$");
    assert.ok(esc.ok && esc.anchored === false, "escaped $ is not an anchor");
  });
  test("a pathological regex in a pack is skipped with a warning, other formats still work", () => {
    const pack = acmePack();
    pack.serialFormats.unshift({
      id: "evil",
      description: "evil",
      regex: "^(\\d+)+$",
      date: { method: "fourDigitYear", yearGroup: 1 },
      confidence: "low",
    });
    const d = decodeSerialWithPackDetailed(pack, "1204T12345", NOW);
    assert.ok(d.warnings.some((w) => /evil.*refused/.test(w)));
    assert.equal(d.results[0]?.formatId, "acme-yyww");
    const modelPack = acmePack();
    modelPack.modelFormats.unshift({ id: "evil-m", family: "x", productType: "other", regex: "^(A*)*$", segments: [], confidence: "low" });
    const m = decodeModelWithPack(modelPack, "AG036B3");
    assert.equal(m[0]?.formatId, "acme-rtu");
    assert.ok(!m.some((x) => x.formatId === "evil-m"));
  });
});

// ---------------------------------------------------------------------------
// Serial decoding
// ---------------------------------------------------------------------------

describe("decodeSerialWithPack", () => {
  const pack = acmePack();

  test("twoDigitYear with week, plant map, manufactureDate and age", () => {
    const [r] = decodeSerialWithPack(pack, "1204T12345", NOW);
    assert.ok(r);
    assert.equal(r.formatId, "acme-yyww");
    assert.equal(r.year, 2012);
    assert.equal(r.week, 4);
    assert.equal(r.plant, "Tulsa, OK");
    assert.equal(r.manufactureDate, "2012-W04");
    assert.equal(r.ageYears, 14.7);
    assert.equal(r.confidence, "high");
    assert.equal(r.evidence, "manufacturer_doc");
    assert.deepEqual(r.sources, ["Acme warranty lookup guide WL-2"]);
    assert.equal(r.ambiguous, undefined);
    assert.equal(r.manufacturerId, "acme");
    const [q] = decodeSerialWithPack(pack, "0752Q00001", NOW);
    assert.equal(q?.plant, "Q", "unmapped plant code passes through");
  });

  test("letterYear with month letter map", () => {
    const [r] = decodeSerialWithPack(pack, "cb123456", NOW);
    assert.equal(r?.formatId, "acme-letter-month");
    assert.equal(r?.year, 2011);
    assert.equal(r?.month, 3);
    assert.equal(r?.manufactureDate, "2011-03");
    const [d] = decodeSerialWithPack(pack, "MF654321", NOW);
    assert.equal(d?.year, 2015);
    assert.equal(d?.month, 12);
  });

  test("decadeDigitYear with numeric month", () => {
    const rs = decodeSerialWithPack(pack, "X23061234", NOW);
    const r = rs.find((x) => x.formatId === "acme-decade");
    assert.ok(r);
    assert.equal(r.year, 2023);
    assert.equal(r.month, 6);
    assert.equal(r.manufactureDate, "2023-06");
    assert.equal(r.ambiguous, undefined, "the colliding legacy format is rejected by month sanity");
    assert.equal(rs.length, 1);
    const custom = acmePack();
    custom.serialFormats = [
      {
        id: "dm",
        description: "decade map",
        regex: "^Y(\\d)(\\d)$",
        date: { method: "decadeDigitYear", decadeGroup: 1, yearGroup: 2, decadeMap: { "9": 1990, "0": 2000 } },
        confidence: "low",
      },
    ];
    assert.equal(decodeSerialWithPack(custom, "Y95", NOW)[0]?.year, 1995);
    assert.equal(decodeSerialWithPack(custom, "Y03", NOW)[0]?.year, 2003);
  });

  test("oneDigitYear with era; alternatives listed when the era does not exclude them", () => {
    const [r] = decodeSerialWithPack(pack, "Q712ABC", NOW);
    assert.equal(r?.formatId, "acme-onedigit");
    assert.equal(r?.year, 2007);
    assert.equal(r?.week, 12);
    assert.equal(r?.ambiguous, undefined);
    const open = acmePack();
    const f = open.serialFormats.find((x) => x.id === "acme-onedigit")!;
    delete f.eraStart;
    delete f.eraEnd;
    const [o] = decodeSerialWithPack(open, "Q712ABC", NOW);
    assert.equal(o?.year, 2007);
    assert.equal(o?.ambiguous, true);
    assert.deepEqual(o?.candidateYears, [1997, 2007, 2017]);
    assert.equal(o?.confidence, "low");
    assert.ok(o?.notes?.some((n) => /one-digit year: 1997 or 2007 or 2017/.test(n)));
  });

  test("fourDigitYear with dayOfYear derives the month", () => {
    const [r] = decodeSerialWithPack(pack, "D2021045", NOW);
    assert.equal(r?.year, 2021);
    assert.equal(r?.dayOfYear, 45);
    assert.equal(r?.month, 2);
    assert.equal(r?.manufactureDate, "2021-02");
  });

  test("manual formats match without a date and carry the note", () => {
    const [r] = decodeSerialWithPack(pack, "MAN12345", NOW);
    assert.equal(r?.formatId, "acme-manual");
    assert.equal(r?.year, undefined);
    assert.equal(r?.manufactureDate, undefined);
    assert.ok(r?.notes?.some((n) => /compressor data tag/.test(n)));
  });

  test("date sanity rejects month/week/year out of range and falls through with a warning", () => {
    const d = decodeSerialWithPackDetailed(pack, "1254T12345", NOW); // week 54
    assert.equal(d.results.length, 0);
    assert.ok(d.warnings.some((w) => /week 54 outside 1..53/.test(w)), d.warnings.join("\n"));
    const future = decodeSerialWithPackDetailed(pack, "2812T12345", NOW); // 2028 > now+1
    assert.equal(future.results.length, 0);
    assert.ok(future.warnings.some((w) => /year 2028 outside 1965..2027/.test(w)));
    const nextYear = decodeSerialWithPack(pack, "2712T12345", NOW); // now+1 is allowed
    assert.equal(nextYear[0]?.year, 2027);
    const month = decodeSerialWithPackDetailed(pack, "X23061234", NOW);
    assert.ok(month.warnings.some((w) => /acme-legacy-mmyy.*month 23 outside 1..12/.test(w)));
    const era = decodeSerialWithPackDetailed(pack, "X10121234", NOW); // legacy: 2012 > eraEnd 2010
    assert.ok(era.warnings.some((w) => /acme-legacy-mmyy.*outside format era 1980-2010/.test(w)));
    assert.equal(era.results.length, 1);
    assert.equal(era.results[0]?.formatId, "acme-decade");
  });

  test("two formats of the same pack yielding different years are downgraded to low + ambiguous", () => {
    const d = decodeSerialWithPackDetailed(pack, "X05061234", NOW); // decade: 2005-06, legacy: 2006-05
    assert.equal(d.results.length, 2);
    for (const r of d.results) {
      assert.equal(r.confidence, "low");
      assert.equal(r.ambiguous, true);
      assert.deepEqual(r.candidateYears, [2005, 2006]);
      assert.ok(r.notes?.some((n) => /2005 or 2006/.test(n)));
    }
    assert.ok(d.warnings.some((w) => /ambiguous.*2005 or 2006.*confirm/i.test(w)), d.warnings.join("\n"));
  });

  test("retries against the compact form (spaces removed) and tolerates labels", () => {
    const [r] = decodeSerialWithPack(pack, "S/N 1204 T 12345", NOW);
    assert.equal(r?.year, 2012);
    assert.equal(r?.week, 4);
  });

  test("ranking prefers higher confidence, unambiguous, dated results", () => {
    const p = acmePack();
    p.serialFormats.push({
      id: "acme-yyww-low",
      description: "duplicate low-confidence reading of the same digits",
      regex: "^(\\d{2})(\\d{2})[A-Z]\\d{5}$",
      date: { method: "twoDigitYear", yearGroup: 1, weekGroup: 2 },
      confidence: "low",
    });
    const rs = decodeSerialWithPack(p, "1204T12345", NOW);
    assert.equal(rs.length, 2);
    assert.equal(rs[0]?.formatId, "acme-yyww");
    assert.equal(rs[0]?.confidence, "high", "same year → no ambiguity downgrade");
  });

  test("never throws on bad input", () => {
    assert.deepEqual(decodeSerialWithPack(pack, "", NOW), []);
    assert.deepEqual(decodeSerialWithPack(pack, undefined as unknown as string, NOW), []);
    assert.deepEqual(decodeSerialWithPack({} as ManufacturerPack, "1204T12345", NOW), []);
    assert.deepEqual(decodeSerialWithPack(pack, "1204T12345", new Date("garbage")).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Model decoding
// ---------------------------------------------------------------------------

describe("decodeModelWithPack", () => {
  const pack = acmePack();

  test("mbh_to_tons formatting rules", () => {
    assert.equal(applyTransform("mbh_to_tons", "036"), "3");
    assert.equal(applyTransform("mbh_to_tons", "090"), "7.5");
    assert.equal(applyTransform("mbh_to_tons", "150"), "12.5");
    assert.equal(applyTransform("mbh_to_tons", "180"), "15");
    assert.equal(applyTransform("mbh_to_tons", "042"), "3.5");
    assert.equal(applyTransform("mbh_to_tons", "102"), "8.5");
    assert.equal(applyTransform("mbh_to_tons", "210"), "17.5");
    assert.equal(applyTransform("mbh_to_tons", "XYZ"), undefined);
    assert.equal(applyTransform("tons_x10", "030"), "3");
    assert.equal(applyTransform("tons_x10", "075"), "7.5");
    assert.equal(applyTransform("kbtuh", "115"), "115");
    assert.equal(applyTransform("kbtuh", "072"), "072");
    assert.equal(applyTransform("raw", "060"), "060");
    assert.equal(applyTransform("map_tons", "04"), undefined);
    assert.equal(formatTons(12.5), "12.5");
    assert.equal(formatTons(3.0), "3");
    assert.equal(formatTons(6.0833), "6.1");
  });

  test("attribute precedence map → transform → raw and full attribute set", () => {
    const [r] = decodeModelWithPack(pack, "AG036B3");
    assert.ok(r);
    assert.equal(r.formatId, "acme-rtu");
    assert.equal(r.family, "Acme AG/AC packaged rooftop");
    assert.equal(r.productType, "packaged_rtu");
    assert.deepEqual(r.attributes, {
      series: "Acme rooftop",
      unit_type: "Gas heat / electric cooling",
      tonnage: "3",
      revision: "B",
      voltage: "208-230/3/60",
    });
    assert.equal(r.refrigerant, "R-410A", "default refrigerant from the format");
    assert.deepEqual(r.controlPlatformIds, ["acme-ctl"]);
    assert.deepEqual(r.equivalentFamilies, ["Zeta ZR (rebadge)"]);
    assert.equal(r.confidence, "high");
    assert.equal(r.evidence, "manufacturer_doc");
    assert.deepEqual(r.sources, ["Acme product data PD-AG-2024, nomenclature page"]);
    assert.deepEqual(
      r.segments.map((s) => [s.name, s.code, s.meaning]),
      [
        ["Series", "A", "Acme rooftop"],
        ["Unit type", "G", "Gas heat / electric cooling"],
        ["Nominal cooling (MBH)", "036", "3"],
        ["Revision", "B", undefined],
        ["Voltage", "3", "208-230/3/60"],
      ],
    );
    // map entry wins over the transform
    assert.equal(decodeModelWithPack(pack, "AG181B3")[0]?.attributes.tonnage, "15");
    // unmapped code → raw code
    assert.equal(decodeModelWithPack(pack, "AG036B9")[0]?.attributes.voltage, "9");
  });

  test("trailing feature string and lowercase / punctuation input", () => {
    const [r] = decodeModelWithPack(pack, "ag090c4-xyz/12");
    assert.equal(r?.attributes.tonnage, "7.5");
    assert.equal(r?.attributes.voltage, "460/3/60");
    assert.equal(r?.attributes.revision, "C");
    assert.equal(decodeModelWithPack(pack, "Model: AC150A3")[0]?.attributes.tonnage, "12.5");
  });

  test("map_tons, tons_x10 and kbtuh", () => {
    const [c] = decodeModelWithPack(pack, "ACH08A");
    assert.equal(c?.attributes.tonnage, "7.5");
    assert.equal(c?.confidence, "low");
    assert.equal(decodeModelWithPack(pack, "ACH99A")[0]?.attributes.tonnage, "99", "map_tons with no map entry keeps the code");
    const [h] = decodeModelWithPack(pack, "AH030072");
    assert.equal(h?.attributes.tonnage, "3");
    assert.equal(h?.attributes.heat_capacity, "072");
  });

  test("compact-form retry for models typed with spaces", () => {
    assert.equal(decodeModelWithPack(pack, "AG 036 B3")[0]?.attributes.tonnage, "3");
  });

  test("ranking: higher confidence first, then more segments", () => {
    const p = acmePack();
    p.modelFormats.push({
      id: "acme-any-a",
      family: "Anything starting with A (low)",
      productType: "other",
      regex: "^(A)[A-Z0-9-/]*$",
      segments: [{ group: 1, name: "Prefix", attribute: "series" }],
      confidence: "low",
    });
    const rs = decodeModelWithPack(p, "AG036B3");
    assert.equal(rs.length, 2);
    assert.equal(rs[0]?.formatId, "acme-rtu");
    assert.equal(rs[1]?.formatId, "acme-any-a");
  });

  test("never throws on bad input", () => {
    assert.deepEqual(decodeModelWithPack(pack, ""), []);
    assert.deepEqual(decodeModelWithPack(pack, null as unknown as string), []);
    assert.deepEqual(decodeModelWithPack({ id: "x" } as ManufacturerPack, "AG036B3"), []);
  });
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

describe("rankManufacturers", () => {
  const kb = kbWith(acmePack(), zetaPack());

  test("scores: model +40 (×0.5 low), serial +30, both +10, hint +100", () => {
    const modelOnly = rankManufacturers(kb, { model: "AG036B3", now: NOW });
    assert.equal(modelOnly[0]?.pack.id, "acme");
    assert.equal(modelOnly[0]?.score, 40);
    const lowModel = rankManufacturers(kb, { model: "ACH08A", now: NOW });
    assert.equal(lowModel[0]?.score, 20);
    const serialOnly = rankManufacturers(kb, { model: "", serial: "1204T12345", now: NOW });
    assert.equal(serialOnly[0]?.pack.id, "acme");
    assert.equal(serialOnly[0]?.score, 30);
    const both = rankManufacturers(kb, { model: "AG036B3", serial: "1204T12345", now: NOW });
    assert.equal(both[0]?.score, 80);
    assert.match(both[0]!.reason, /model and serial both match/);
    const hinted = rankManufacturers(kb, { model: "AG036B3", serial: "1204T12345", manufacturer: "acme commercial", now: NOW });
    assert.equal(hinted[0]?.score, 180);
    assert.match(hinted[0]!.reason, /hint "acme commercial" matches/);
  });

  test("only packs with score > 0; ties keep pack order", () => {
    assert.deepEqual(rankManufacturers(kb, { model: "NOPE-123", now: NOW }), []);
    const tie = rankManufacturers(kbWith(zetaPack(), acmePack()), { model: "", serial: "1510AB", now: NOW });
    assert.equal(tie[0]?.pack.id, "zeta");
  });

  test("a recognized hint ranks its pack first (+100) but does not hide other packs; unknown hint searches everything", () => {
    const hinted = rankManufacturers(kb, { model: "Z060", manufacturer: "Acme", now: NOW });
    assert.equal(hinted.length, 2);
    assert.equal(hinted[0]?.pack.id, "acme");
    assert.equal(hinted[0]?.score, 100);
    assert.equal(hinted[1]?.pack.id, "zeta"); // the model really decodes as Zeta: still returned (score 40)
    assert.equal(hinted[1]?.score, 40);
    const hintOnly = rankManufacturers(kb, { model: "NOPE-123", manufacturer: "Acme", now: NOW });
    assert.deepEqual(hintOnly.map((r) => r.pack.id), ["acme"]);
    const unknown = rankManufacturers(kb, { model: "Z060", manufacturer: "Bogus Brand", now: NOW });
    assert.equal(unknown[0]?.pack.id, "zeta");
    assert.equal(unknown[0]?.score, 40);
    const alias = rankManufacturers(kb, { model: "", manufacturer: "ACME HVAC", now: NOW });
    assert.equal(alias[0]?.pack.id, "acme");
  });

  test("a serial that matches two packs ranks the one whose model also matches first", () => {
    const rs = rankManufacturers(kb, { model: "Z060", serial: "1204T12345", now: NOW });
    assert.equal(rs[0]?.pack.id, "zeta"); // model 40 vs acme serial 30
    assert.equal(rs[1]?.pack.id, "acme");
  });

  test("never throws", () => {
    assert.deepEqual(rankManufacturers({} as KnowledgeBase, { model: "x" }), []);
    assert.deepEqual(rankManufacturers(kb, undefined as unknown as { model: string }), []);
  });
});

// ---------------------------------------------------------------------------
// Family selectors
// ---------------------------------------------------------------------------

test("familySelectorMatches accepts format ids, id-regexes, model regexes and loose labels", () => {
  assert.equal(familySelectorMatches("acme-rtu", "acme-rtu", "AG036B3"), true);
  assert.equal(familySelectorMatches("acme-(rtu|chiller)", "acme-rtu", "AG036B3"), true);
  assert.equal(familySelectorMatches("^ACH", "acme-chiller", "ACH08A"), true);
  assert.equal(familySelectorMatches("^ACH", "acme-rtu", "AG036B3"), false);
  assert.equal(familySelectorMatches("acme-rtu (revision C and later)", "acme-rtu", "AG036C3"), true);
  assert.equal(familySelectorMatches("(?i)broken", "acme-rtu", "AG036C3"), false, "invalid regex never matches");
  assert.equal(familySelectorMatches(undefined, "acme-rtu", "AG036C3"), false);
});

// ---------------------------------------------------------------------------
// Full decode
// ---------------------------------------------------------------------------

describe("decodeUnit", () => {
  const kb = kbWith(acmePack(), zetaPack());

  test("full result: summary opens with confidence, evidence summary, controls/electrical/issues/support from the best pack", () => {
    const r = decodeUnit(kb, { model: "AG036B3", serial: "1204T12345", now: NOW });
    assert.deepEqual(r.input, { model: "AG036B3", serial: "1204T12345" });
    assert.equal(r.manufacturerCandidates[0]?.id, "acme");
    assert.equal(r.model[0]?.formatId, "acme-rtu");
    assert.equal(r.serial[0]?.formatId, "acme-yyww");
    assert.ok(r.summary.startsWith("High confidence: Acme Air Acme AG/AC packaged rooftop"), r.summary);
    assert.match(r.summary, /3 tons/);
    assert.match(r.summary, /R-410A/);
    assert.match(r.summary, /Built 2012 week 4 \(about 14\.7 years old\)/);
    assert.match(r.summary, /plant Tulsa, OK/);
    assert.ok(!/Verify on the nameplate/.test(r.summary), "high confidence needs no verify sentence");
    assert.match(r.evidenceSummary ?? "", /Nomenclature: Acme AG\/AC packaged rooftop — manufacturer document, high confidence \(Acme product data PD-AG-2024/);
    assert.match(r.evidenceSummary ?? "", /Serial rule: acme-yyww — manufacturer document, high confidence \(Acme warranty lookup guide WL-2\)/);
    assert.match(r.evidenceSummary ?? "", /Acme SmartCtl unit controller: partial coverage/);
    assert.deepEqual(
      r.controls.map((c) => c.id),
      ["acme-ctl", "acme-igc"],
      "controlPlatformIds first, then platforms whose appliesTo matches",
    );
    assert.deepEqual(
      r.electrical.map((e) => e.familyLabel),
      ["Acme rooftops"],
    );
    assert.deepEqual(
      r.commonIssues.map((c) => c.symptom),
      ["Rooftop short cycles on high pressure", "Generic Acme issue"],
    );
    assert.equal(r.support?.phone, "800-555-0100");
    assert.deepEqual(r.warnings, []);
  });

  test("medium/low confidence summaries carry the verify sentence and warnings", () => {
    const r = decodeUnit(kb, { model: "ACH08A", serial: "MAN12345", now: NOW });
    assert.ok(r.summary.startsWith("Low confidence: Acme Air Acme ACH air-cooled chiller"), r.summary);
    assert.match(r.summary, /Verify on the nameplate/);
    assert.match(r.summary, /Manufacture date must be read manually/);
    assert.ok(r.warnings.some((w) => /Low-confidence match/.test(w)));
    assert.ok(r.warnings.some((w) => /read manually/.test(w)));
    assert.deepEqual(r.controls.map((c) => c.id), ["acme-chiller-ctl"]);
    assert.deepEqual(r.electrical.map((e) => e.familyLabel), ["Acme chillers"]);
    assert.deepEqual(r.commonIssues.map((c) => c.symptom), ["Generic Acme issue", "Chiller freeze trips"]);
  });

  test("no manufacturer matched → warning and low-confidence summary", () => {
    const r = decodeUnit(kb, { model: "QQQ-999", serial: "NOPE", now: NOW });
    assert.deepEqual(r.manufacturerCandidates, []);
    assert.ok(r.warnings.some((w) => /No manufacturer matched; verify the nameplate/.test(w)));
    assert.ok(r.summary.startsWith("Low confidence: no manufacturer pack matched"), r.summary);
    assert.deepEqual(r.model, []);
    assert.deepEqual(r.controls, []);
  });

  test("model-only match warns that the serial did not decode", () => {
    const r = decodeUnit(kb, { model: "AG036B3", serial: "ZZZ-NOT-A-SERIAL", now: NOW });
    assert.equal(r.serial.length, 0);
    assert.ok(r.warnings.some((w) => /did not match any Acme Air serial format — model-only match/.test(w)), r.warnings.join("\n"));
    assert.match(r.summary, /Serial did not decode/);
    const noSerial = decodeUnit(kb, { model: "AG036B3", now: NOW });
    assert.ok(noSerial.warnings.some((w) => /No serial number given/.test(w)));
    assert.equal(noSerial.input.serial, undefined);
  });

  test("ambiguous date: caveat in the summary, candidates listed, warning present", () => {
    const r = decodeUnit(kb, { model: "AG036B3", serial: "X05061234", now: NOW });
    assert.ok(r.summary.startsWith("Low confidence:"), r.summary);
    assert.match(r.summary, /Acme Air (decade\+year digits|two-digit year): 2005 or 2006 — confirm with the nameplate era/);
    assert.ok(r.warnings.some((w) => /ambiguous/i.test(w) && /2005 or 2006/.test(w)));
    assert.equal(r.serial[0]?.ambiguous, true);
  });

  test("old unit warning (> 20 years)", () => {
    const r = decodeUnit(kb, { model: "AG036B3", serial: "Q305XYZ", now: NOW });
    assert.equal(r.serial[0]?.year, 2003);
    assert.ok(r.warnings.some((w) => /about 23\.\d years old \(built 2003\) — over 20 years/.test(w)), r.warnings.join("\n"));
    const young = decodeUnit(kb, { model: "AG036B3", serial: "2415T12345", now: NOW });
    assert.ok(!young.warnings.some((w) => /over 20 years/.test(w)));
  });

  test("truncated input warning", () => {
    const r = decodeUnit(kb, { model: "AG036B3-" + "X".repeat(80), now: NOW });
    assert.ok(r.warnings.some((w) => /Model input was truncated to 64 characters/.test(w)));
    assert.equal(r.model[0]?.formatId, "acme-rtu", "the truncated tail still matches the feature-string regex");
  });

  test("manufacturer hint: hinted pack first, unknown-hint warning, hint-only pack with unmatched model", () => {
    const r = decodeUnit(kb, { model: "Z060", manufacturer: "Acme", now: NOW });
    assert.deepEqual(r.manufacturerCandidates.map((c) => c.id), ["acme", "zeta"]);
    assert.ok(r.warnings.some((w) => /Model "Z060" did not match any Acme Air model format/.test(w)));
    assert.match(r.summary, /Acme Air \(model "Z060" not decoded\)/);
    assert.deepEqual(r.controls, []);
    const unknown = decodeUnit(kb, { model: "Z060", manufacturer: "Bogus", now: NOW });
    assert.equal(unknown.manufacturerCandidates[0]?.id, "zeta");
    assert.ok(unknown.warnings.some((w) => /hint "Bogus" is not a known pack/.test(w)));
    assert.equal(unknown.input.manufacturer, "Bogus");
  });

  test("a wrong manufacturer hint does not hide the model decode from the right pack (finding: 48TC + hint Copeland)", () => {
    // hint matches acme (+100) but the model is a Zeta format (+40): Zeta stays a candidate and its decode is returned
    const r = decodeUnit(kb, { model: "Z060", manufacturer: "Acme", now: NOW });
    assert.deepEqual(r.manufacturerCandidates.map((c) => [c.id, c.score]), [["acme", 100], ["zeta", 40]]);
    assert.equal(r.model.length, 1);
    assert.equal(r.model[0]?.formatId, "zeta-z");
    assert.ok(r.warnings.some((w) => /Model "Z060" does match the Zeta .* format zeta-z/.test(w) && /hint "Acme" may be wrong/.test(w)), r.warnings.join("\n"));
    // a correct hint produces no mismatch warning and no foreign candidates
    const ok = decodeUnit(kb, { model: "AG036B3", manufacturer: "Acme", now: NOW });
    assert.deepEqual(ok.manufacturerCandidates.map((c) => c.id), ["acme"]);
    assert.ok(!ok.warnings.some((w) => /may be wrong/.test(w)));
    // no hint: no mismatch warning even when the model matches nothing
    const none = decodeUnit(kb, { model: "NOPE-123", now: NOW });
    assert.ok(!none.warnings.some((w) => /may be wrong/.test(w)));
  });

  test("never throws on garbage input", () => {
    const cases: unknown[] = [undefined, null, {}, { model: null }, { model: 42, serial: {} }, { model: "", serial: "" }, { model: "AG036B3", now: "not a date" }];
    for (const c of cases) {
      const r = decodeUnit(kb, c as never);
      assert.ok(typeof r.summary === "string" && r.summary.length > 0);
      assert.ok(Array.isArray(r.warnings));
    }
    const empty = decodeUnit(kb, { model: "", serial: "", now: NOW });
    assert.ok(empty.warnings.some((w) => /No model or serial number given/.test(w)));
    assert.ok(empty.summary.startsWith("Low confidence:"));
    const brokenKb = decodeUnit({ manufacturers: [null as unknown as ManufacturerPack] } as KnowledgeBase, { model: "AG036B3" });
    assert.ok(brokenKb.summary.length > 0);
  });

  test("uses the injected clock for age", () => {
    const later = decodeUnit(kb, { model: "AG036B3", serial: "1204T12345", now: new Date("2030-01-26T00:00:00Z") });
    assert.equal(later.serial[0]?.ageYears, 18);
  });
});
