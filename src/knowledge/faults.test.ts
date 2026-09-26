import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeBase, ManufacturerPack } from "../types.ts";
import { lookupFaultCode, normalizeFaultCode, parseFlashCount, platformMatches, MAX_FAULT_HITS } from "./faults.ts";

function acme(): ManufacturerPack {
  return {
    id: "acme",
    manufacturer: "Acme Air",
    brands: ["Acme", "Acme Commercial"],
    aliases: ["ACME HVAC"],
    confidence: "medium",
    serialFormats: [],
    modelFormats: [],
    commonIssues: [],
    controls: [
      {
        id: "acme-ctl",
        name: "Acme SmartCtl unit controller",
        faultCodes: [
          { code: "A140", meaning: "High pressure switch open", severity: "lockout", source: "Acme SM-1 §4.2" },
          { code: "03", meaning: "Low pressure lockout", source: "Acme SM-1 §4.3" },
          { code: "E3", meaning: "Return air sensor fault", source: "Acme SM-1 §4.4" },
          { code: "A14", meaning: "Not the same as A140", source: "Acme SM-1 §4.5" },
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
        faultCodes: [{ code: "2 flashes", meaning: "Pressure switch open", source: "Acme IGC guide" }],
        ledPatterns: [{ pattern: "3 flashes", meaning: "Flame rollout / limit open" }],
        coverage: "complete",
        confidence: "medium",
        sources: ["Acme IGC guide"],
      },
    ],
  };
}

function zeta(): ManufacturerPack {
  return {
    id: "zeta",
    manufacturer: "Zeta Corp",
    brands: ["Zeta"],
    confidence: "medium",
    serialFormats: [],
    modelFormats: [],
    commonIssues: [],
    controls: [
      {
        id: "zeta-board",
        name: "Zeta Z-Board",
        faultCodes: [
          { code: "A140", meaning: "Zeta A140 means something else", source: "Zeta manual" },
          { code: "3", meaning: "Zeta code three", source: "Zeta manual" },
          ...Array.from({ length: 30 }, (_, i) => ({ code: `ZX${i}`, meaning: `Zeta code ${i}`, source: "Zeta manual" })),
        ],
        coverage: "complete",
        confidence: "low",
      },
    ],
  };
}

function kb(): KnowledgeBase {
  return {
    manufacturers: [acme(), zeta()],
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

describe("normalizeFaultCode", () => {
  test("uppercase, strip spaces/dashes, leading-zero-insensitive digit runs", () => {
    assert.equal(normalizeFaultCode("a-140"), "A140");
    assert.equal(normalizeFaultCode("A 140"), "A140");
    assert.equal(normalizeFaultCode("03"), "3");
    assert.equal(normalizeFaultCode("E03"), "E3");
    assert.equal(normalizeFaultCode("000"), "0");
    assert.equal(normalizeFaultCode("LED 3 flashes"), "LED3FLASHES");
    assert.equal(normalizeFaultCode(""), "");
    assert.equal(normalizeFaultCode(undefined), "");
  });
  test("parseFlashCount", () => {
    assert.equal(parseFlashCount("3 flashes"), 3);
    assert.equal(parseFlashCount("IGC 3 flashes"), 3);
    assert.equal(parseFlashCount("LED 3 flash"), 3);
    assert.equal(parseFlashCount("flashes 4 times"), 4);
    assert.equal(parseFlashCount("2x flash"), 2);
    assert.equal(parseFlashCount("Green 3 flashes"), 3);
    assert.equal(parseFlashCount("A140"), undefined);
    assert.equal(parseFlashCount("flashing"), undefined);
  });
  test("platformMatches is fuzzy on id/name", () => {
    const p = acme().controls[0]!;
    assert.equal(platformMatches(p, "acme-ctl"), true);
    assert.equal(platformMatches(p, "SmartCtl"), true);
    assert.equal(platformMatches(p, "smart ctl controller"), true);
    assert.equal(platformMatches(p, "Acme SmartCtl unit controller (v2)"), true);
    assert.equal(platformMatches(p, "zeta"), false);
  });
});

describe("lookupFaultCode", () => {
  test("exact > normalized > contains; hits carry coverage and source", () => {
    const hits = lookupFaultCode(kb(), "A140");
    assert.ok(hits.length >= 2);
    assert.equal(hits[0]?.fault.code, "A140");
    assert.equal(hits[0]?.manufacturerId, "acme");
    assert.equal(hits[0]?.score, 100);
    assert.equal(hits[0]?.platform.coverage, "partial");
    assert.equal(hits[0]?.fault.source, "Acme SM-1 §4.2");
    assert.equal(hits[1]?.manufacturerId, "zeta", "exact matches from every pack, pack order for ties");
    assert.equal(hits[1]?.score, 100);
    const contains = hits.find((h) => h.fault.code === "A14");
    assert.equal(contains, undefined, "a shorter code does not 'contain' the query");
    const partial = lookupFaultCode(kb(), "14");
    assert.ok(partial.some((h) => h.fault.code === "A140" && h.score === 60));
    assert.ok(partial.some((h) => h.fault.code === "A14" && h.score === 60));
    assert.equal(partial[0]?.fault.code, "A140", "ties keep pack/platform/code order");
    const phrase = lookupFaultCode(kb(), "code E-03 on the board");
    assert.equal(phrase[0]?.fault.code, "E3", "a phrase naming the code as a whole token matches");
    assert.equal(phrase[0]?.score, 50);
    assert.ok(!phrase.some((h) => h.fault.code === "03"), "'03' is not a token of the phrase");
  });

  test("normalization: a-140 ≙ A140, 3 ≙ 03, E03 ≙ E3", () => {
    const a = lookupFaultCode(kb(), "a-140", { manufacturer: "Acme" });
    assert.equal(a[0]?.fault.code, "A140");
    assert.equal(a[0]?.score, 90);
    const three = lookupFaultCode(kb(), "3", { manufacturer: "acme" });
    assert.equal(three[0]?.fault.code, "03");
    assert.equal(three[0]?.score, 90);
    const e3 = lookupFaultCode(kb(), "e03");
    assert.equal(e3[0]?.fault.code, "E3");
    const zeroThree = lookupFaultCode(kb(), "003");
    assert.ok(zeroThree.some((h) => h.fault.code === "03"));
    assert.ok(zeroThree.some((h) => h.fault.code === "3" && h.manufacturerId === "zeta"));
  });

  test("LED phrases match ledPatterns and codes containing '3 flash'; IGC token boosts the IGC platform", () => {
    const hits = lookupFaultCode(kb(), "IGC 3 flashes");
    assert.ok(hits.length >= 3, JSON.stringify(hits.map((h) => h.fault.code)));
    assert.equal(hits[0]?.platform.id, "acme-igc", "platform named IGC is boosted to the top");
    assert.equal(hits[0]?.fault.code, "3 flashes");
    assert.equal(hits[0]?.fault.notes, "LED flash pattern");
    assert.equal(hits[0]?.fault.source, "Acme IGC guide");
    const ledFromCtl = hits.find((h) => h.platform.id === "acme-ctl" && h.fault.notes === "LED flash pattern");
    assert.ok(ledFromCtl);
    assert.equal(ledFromCtl.fault.source, "Acme SM-1 service manual (SM-1)");
    assert.deepEqual(ledFromCtl.fault.checks, ["Check inducer"]);
    assert.ok(hits.some((h) => h.fault.code === "LED 3 flashes"), "fault code containing '3 flash' matches");
    assert.ok(!hits.some((h) => h.fault.code === "2 flashes"), "different flash count does not match");
    assert.ok(!hits.some((h) => h.manufacturerId === "zeta"), "plain '3' code is not an LED match");
    const plain = lookupFaultCode(kb(), "3 flashes");
    assert.ok(plain.length >= 3);
  });

  test("manufacturer filter by id/name/brand/alias; unknown hint searches everything", () => {
    assert.ok(lookupFaultCode(kb(), "A140", { manufacturer: "acme" }).every((h) => h.manufacturerId === "acme"));
    assert.ok(lookupFaultCode(kb(), "A140", { manufacturer: "Acme Air" }).every((h) => h.manufacturerId === "acme"));
    assert.ok(lookupFaultCode(kb(), "A140", { manufacturer: "Acme Commercial" }).every((h) => h.manufacturerId === "acme"));
    assert.ok(lookupFaultCode(kb(), "A140", { manufacturer: "ACME HVAC" }).every((h) => h.manufacturerId === "acme"));
    assert.ok(lookupFaultCode(kb(), "A140", { manufacturer: "Zeta" }).every((h) => h.manufacturerId === "zeta"));
    const unknown = lookupFaultCode(kb(), "A140", { manufacturer: "Nobody" });
    assert.equal(unknown.length, 2);
  });

  test("platform filter (fuzzy) narrows; unknown platform falls back to all", () => {
    const igc = lookupFaultCode(kb(), "3 flashes", { platform: "igc" });
    assert.ok(igc.length >= 1);
    assert.ok(igc.every((h) => h.platform.id === "acme-igc"));
    const smart = lookupFaultCode(kb(), "3", { manufacturer: "acme", platform: "SmartCtl" });
    assert.equal(smart[0]?.fault.code, "03");
    const fallback = lookupFaultCode(kb(), "A140", { platform: "does-not-exist" });
    assert.equal(fallback.length, 2);
  });

  test("caps at 20 hits", () => {
    const hits = lookupFaultCode(kb(), "ZX");
    assert.equal(hits.length, MAX_FAULT_HITS);
    assert.equal(MAX_FAULT_HITS, 20);
  });

  test("no hit / bad input never throws", () => {
    assert.deepEqual(lookupFaultCode(kb(), "QWERTY-999"), []);
    assert.deepEqual(lookupFaultCode(kb(), ""), []);
    assert.deepEqual(lookupFaultCode(kb(), undefined as unknown as string), []);
    assert.deepEqual(lookupFaultCode({} as KnowledgeBase, "A140"), []);
    const broken = kb();
    (broken.manufacturers[0]!.controls[0]!.faultCodes as unknown[]).push(null, { code: 5 }, {});
    assert.equal(lookupFaultCode(broken, "A140")[0]?.fault.code, "A140");
  });
});
