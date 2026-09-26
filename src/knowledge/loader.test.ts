import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChargingTargets, DxRuleSet, ElectricalComponent, ElectricalProcedure, ManufacturerPack, RefrigerantMeta, RefrigerantTable } from "../types.ts";
import {
  KnowledgeValidationError,
  METRIC_KEYS,
  MIN_ELECTRICAL_COMPONENTS,
  MIN_ELECTRICAL_PROCEDURES,
  NUMERIC_METRIC_KEYS,
  loadKnowledge,
  validateChargingTargets,
  validateElectricalComponents,
  validateElectricalProcedures,
  validateElectricalReference,
  validateManufacturerPack,
  validateRefrigerantIndex,
  validateRuleSet,
} from "./loader.ts";
import { findComponent, findProcedure, findReference } from "./electrical.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validPack(): ManufacturerPack {
  return {
    id: "acme",
    manufacturer: "Acme Air",
    brands: ["Acme"],
    confidence: "high",
    sources: ["Acme nomenclature sheet"],
    serialFormats: [
      {
        id: "acme-yyww",
        description: "YYWW + plant + 5 digits",
        eraStart: 2000,
        regex: "^(\\d{2})(\\d{2})([A-Z])\\d{5}$",
        date: { method: "twoDigitYear", yearGroup: 1, weekGroup: 2, pivot: 70 },
        plant: { group: 3, map: { T: "Tulsa" } },
        examples: [
          { serial: "1204T12345", expect: { year: 2012, week: 4 } },
          { serial: "2415T12345", expect: { year: 2024, week: 15 } },
        ],
        confidence: "high",
        evidence: "manufacturer_doc",
        sources: ["Acme warranty guide"],
      },
      {
        id: "acme-letter",
        description: "month letter + year letter + 6 digits",
        regex: "^([A-M])([A-F])(\\d{6})$",
        date: {
          method: "letterYear",
          yearGroup: 2,
          map: { A: 2010, B: 2011 },
          monthGroup: 1,
          monthLetterMap: { A: 1, B: 2, C: 3, M: 12 },
        },
        examples: [
          { serial: "CB123456", expect: { year: 2011, month: 3 } },
          { serial: "MA654321", expect: { year: 2010, month: 12 } },
        ],
        confidence: "medium",
        sources: ["x"],
      },
      {
        id: "acme-decade",
        description: "X + decade + year + MM",
        regex: "^X(\\d)(\\d)(\\d{2})$",
        date: { method: "decadeDigitYear", decadeGroup: 1, yearGroup: 2, monthGroup: 3 },
        confidence: "low",
      },
      {
        id: "acme-manual",
        description: "manual",
        regex: "^MAN[A-Z0-9]+$",
        date: { method: "manual", note: "Read the compressor tag." },
        confidence: "low",
      },
    ],
    modelFormats: [
      {
        id: "acme-rtu",
        family: "Acme rooftop",
        productType: "packaged_rtu",
        regex: "^(A)([GC])(\\d{3})([A-Z])(\\d)(?:[-A-Z0-9/]*)?$",
        segments: [
          { group: 1, name: "Series", attribute: "series", map: { A: "Acme rooftop" } },
          { group: 3, name: "MBH", attribute: "tonnage", transform: "mbh_to_tons" },
          { group: 5, name: "Voltage", attribute: "voltage", map: { "3": "208-230/3/60" } },
        ],
        controlPlatformIds: ["acme-ctl"],
        examples: [{ model: "AG036B3", expect: { tonnage: "3" } }],
        confidence: "high",
        evidence: "manufacturer_doc",
        sources: ["Acme product data"],
      },
      {
        id: "acme-low",
        family: "Acme low-confidence guess",
        productType: "other",
        regex: "^(AX)\\d+$",
        segments: [{ group: 1, name: "Prefix", attribute: "series" }],
        confidence: "low",
      },
    ],
    controls: [
      {
        id: "acme-ctl",
        name: "Acme SmartCtl",
        faultCodes: [{ code: "A140", meaning: "High pressure", source: "SM-1" }],
        coverage: "partial",
        confidence: "medium",
      },
    ],
    electrical: [{ familyRegex: "acme-rtu", familyLabel: "Acme rooftops", components: [{ designator: "C", name: "Contactor" }], confidence: "medium" }],
    commonIssues: [{ symptom: "Short cycling", likelyCauses: ["Dirty coil"], checks: ["Wash coil"], appliesTo: "acme-rtu" }],
  };
}

function validRules(): DxRuleSet {
  return {
    version: "1",
    defaults: {
      targetSubcoolingTxvF: 10,
      condenserSplitNormalF: { min: 15, max: 30 },
      evapTdNormalF: { min: 30, max: 40 },
      deltaTNormalF: { min: 16, max: 22 },
      dischargeTempWarnF: 225,
      dischargeTempCriticalF: 250,
      compressionRatioWarn: 4.5,
      byMode: { refrigeration: { compressionRatioWarn: 12 } },
    },
    rules: [
      {
        id: "undercharge",
        condition: "Undercharge",
        severity: "warning",
        confidence: "medium",
        chargeRelated: true,
        appliesTo: { meteringDevice: ["txv"], mode: ["ac_cooling"] },
        when: [
          { metric: "superheatF", op: ">", value: 20 },
          { metric: "subcoolingF", op: "<", value: 5 },
          { metric: "sightGlass", op: "between", value: 1, value2: 2 },
          { metric: "headPressureControl", op: "present" },
          { metric: "refrigerant", op: "present" },
        ],
        explanation: "x",
        nextChecks: ["y"],
      },
    ],
  };
}

function validCharging(): ChargingTargets {
  return {
    version: "1",
    fixedOrificeSuperheat: { indoorWbF: [50, 52], outdoorDbF: [55, 60, 65], targetF: [[30, 25, null], [32, 27, 22]] },
    targetDeltaT: { indoorDbF: [75], indoorWbF: [58, 63], targetF: [[23, 19]] },
    notes: ["n"],
  };
}

function table(id: string): RefrigerantTable {
  return { id, tempF: [0, 1], bubblePsig: [10, 11], dewPsig: [10.5, 11.5] };
}

function meta(id: string, extra: Partial<RefrigerantMeta> = {}): RefrigerantMeta {
  return { id, aliases: [], type: "pure", safetyClass: "A1", gwp: { ar4: 100 }, applications: [], serviceNotes: [], ...extra };
}

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

interface KbFiles {
  packs?: Record<string, unknown>;
  index?: unknown;
  tables?: RefrigerantTable[];
  rules?: unknown;
  charging?: unknown;
  components?: unknown; // electrical/components.json (whole file)
  procedures?: unknown; // electrical/procedures.json (whole file)
}

function writeKb(files: KbFiles): string {
  const dir = mkdtempSync(join(tmpdir(), "hvac-kb-"));
  roots.push(dir);
  mkdirSync(join(dir, "manufacturers"), { recursive: true });
  mkdirSync(join(dir, "refrigerants"), { recursive: true });
  mkdirSync(join(dir, "diagnostics"), { recursive: true });
  for (const [name, pack] of Object.entries(files.packs ?? {})) writeFileSync(join(dir, "manufacturers", `${name}.json`), JSON.stringify(pack));
  if (files.index !== undefined) writeFileSync(join(dir, "refrigerants", "index.json"), JSON.stringify(files.index));
  for (const t of files.tables ?? []) writeFileSync(join(dir, "refrigerants", `${t.id}.json`), JSON.stringify(t));
  if (files.rules !== undefined) writeFileSync(join(dir, "diagnostics", "refrigeration-cycle.json"), JSON.stringify(files.rules));
  if (files.charging !== undefined) writeFileSync(join(dir, "diagnostics", "charging-targets.json"), JSON.stringify(files.charging));
  if (files.components !== undefined || files.procedures !== undefined) mkdirSync(join(dir, "electrical"), { recursive: true });
  if (files.components !== undefined) writeFileSync(join(dir, "electrical", "components.json"), JSON.stringify(files.components));
  if (files.procedures !== undefined) writeFileSync(join(dir, "electrical", "procedures.json"), JSON.stringify(files.procedures));
  return dir;
}

function component(id: string, extra: Partial<ElectricalComponent> = {}): ElectricalComponent {
  return {
    id,
    name: id.replace(/_/g, " "),
    function: `what ${id} does`,
    tests: [{ name: "ohm it", energized: false, steps: ["discharge", "measure"], expected: "within tolerance" }],
    failureModes: ["open"],
    safety: ["LOTO"],
    ...extra,
  };
}

function procedure(id: string, extra: Partial<ElectricalProcedure> = {}): ElectricalProcedure {
  return { id, symptom: id.replace(/_/g, " "), safety: ["LOTO"], steps: [{ step: "check power", expect: "24 V" }], commonCauses: ["blown fuse"], ...extra };
}

function componentsFile(n = MIN_ELECTRICAL_COMPONENTS, reference: unknown = [{ topic: "voltage imbalance", content: ["NEMA MG-1"] }]): unknown {
  return { version: "1", components: Array.from({ length: n }, (_, i) => component(`comp_${i}`)), reference };
}

function proceduresFile(n = MIN_ELECTRICAL_PROCEDURES): unknown {
  return { version: "1", procedures: Array.from({ length: n }, (_, i) => procedure(`proc_${i}`)) };
}

function fullValid(): KbFiles {
  return {
    packs: { acme: validPack() },
    index: [meta("R-410A", { safetyClass: "A1" }), meta("R-454B", { safetyClass: "A2L", type: "zeotrope" })],
    tables: [table("R-410A"), table("R-454B")],
    rules: validRules(),
    charging: validCharging(),
  };
}

function packProblems(mutate: (p: ManufacturerPack) => void): string[] {
  const p = validPack();
  mutate(p);
  const problems: string[] = [];
  validateManufacturerPack(p, problems);
  return problems;
}

function expectProblem(problems: string[], re: RegExp): void {
  assert.ok(problems.some((p) => re.test(p)), `expected a problem matching ${re}, got:\n${problems.join("\n")}`);
}

// ---------------------------------------------------------------------------
// loadKnowledge end to end
// ---------------------------------------------------------------------------

describe("loadKnowledge", () => {
  test("a fully valid knowledge dir loads strictly with no problems", () => {
    const kb = loadKnowledge(writeKb(fullValid()), { strict: true });
    assert.equal(kb.manufacturers.length, 1);
    assert.equal(kb.manufacturers[0]?.id, "acme");
    assert.equal(kb.refrigerants.meta.length, 2);
    assert.equal(kb.refrigerants.tables.size, 2);
    assert.equal(kb.diagnostics.rules.rules.length, 1);
    assert.equal(kb.diagnostics.charging.fixedOrificeSuperheat.targetF.length, 2);
    assert.equal(kb.electrical.components.length, 0);
  });

  test("strict mode throws KnowledgeValidationError listing every problem", () => {
    const files = fullValid();
    (files.packs as Record<string, ManufacturerPack>).acme!.serialFormats[0]!.regex = "(\\d{2})(\\d{2})";
    (files.rules as DxRuleSet).rules[0]!.when.push({ metric: "bogus" as never, op: ">", value: 1 });
    const dir = writeKb(files);
    assert.throws(
      () => loadKnowledge(dir, { strict: true }),
      (e: unknown) => {
        assert.ok(e instanceof KnowledgeValidationError);
        assert.ok(e.problems.length >= 3, e.problems.join("\n"));
        expectProblem(e.problems, /acme-yyww: regex must be anchored/);
        expectProblem(e.problems, /plant.group = 3 exceeds the regex group count \(2\)/);
        expectProblem(e.problems, /unknown metric "bogus"/);
        assert.match(e.message, /Knowledge validation failed/);
        return true;
      },
    );
  });

  test("strict: false warns and continues with what loaded", () => {
    const files = fullValid();
    delete files.index; // required in strict mode
    (files.packs as Record<string, ManufacturerPack>).acme!.controls[0]!.faultCodes = [];
    const dir = writeKb(files);
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    };
    try {
      const kb = loadKnowledge(dir, { strict: false });
      assert.equal(kb.manufacturers.length, 1);
      assert.equal(kb.refrigerants.tables.size, 2);
      assert.equal(kb.refrigerants.meta.length, 0);
    } finally {
      console.warn = orig;
    }
    assert.equal(warned.length, 1);
    assert.match(warned[0]!, /needs >= 1 fault code/);
    assert.ok(!/index\.json: missing/.test(warned[0]!), "missing index is only a problem in strict mode");
  });

  test("strict mode requires refrigerants/index.json", () => {
    const files = fullValid();
    delete files.index;
    assert.throws(() => loadKnowledge(writeKb(files), { strict: true }), (e: unknown) => {
      assert.ok(e instanceof KnowledgeValidationError);
      expectProblem(e.problems, /refrigerants\/index\.json: missing \(required in strict mode\)/);
      return true;
    });
  });

  test("malformed JSON and malformed tables are reported, not thrown", () => {
    const dir = writeKb(fullValid());
    writeFileSync(join(dir, "manufacturers", "broken.json"), "{ not json");
    writeFileSync(join(dir, "refrigerants", "R-BAD.json"), JSON.stringify({ id: "R-BAD", tempF: [1, 2], bubblePsig: [1], dewPsig: [1, 2] }));
    writeFileSync(join(dir, "refrigerants", "_generated_meta.json"), "[]");
    assert.throws(() => loadKnowledge(dir, { strict: true }), (e: unknown) => {
      assert.ok(e instanceof KnowledgeValidationError);
      expectProblem(e.problems, /broken\.json/);
      expectProblem(e.problems, /R-BAD\.json: malformed refrigerant table/);
      assert.ok(!e.problems.some((p) => /_generated_meta/.test(p)), "underscore files are skipped");
      return true;
    });
  });

  test("missing optional files fall back to defaults", () => {
    const dir = writeKb({ packs: {}, index: [], tables: [] });
    const kb = loadKnowledge(dir, { strict: true });
    assert.equal(kb.diagnostics.rules.rules.length, 0);
    assert.equal(kb.diagnostics.charging.version, "0");
    assert.equal(kb.manufacturers.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Manufacturer pack checks
// ---------------------------------------------------------------------------

describe("validateManufacturerPack", () => {
  test("valid pack has no problems", () => {
    assert.deepEqual(packProblems(() => {}), []);
  });

  test("regex must be anchored, ≤ 400 chars, compile, and have no nested quantifiers", () => {
    expectProblem(packProblems((p) => (p.serialFormats[0]!.regex = "(\\d{2})(\\d{2})([A-Z])\\d{5}")), /serialFormat acme-yyww: regex must be anchored/);
    expectProblem(packProblems((p) => (p.modelFormats[0]!.regex = "^(A)([GC])(\\d{3})([A-Z])(\\d)")), /modelFormat acme-rtu: regex must be anchored/);
    expectProblem(packProblems((p) => (p.serialFormats[0]!.regex = "^" + "(a)".repeat(140) + "$")), /longer than 400 chars/);
    expectProblem(packProblems((p) => (p.serialFormats[0]!.regex = "^(\\d+)+(\\d+)(x)$")), /nested quantifiers/);
    expectProblem(packProblems((p) => (p.modelFormats[0]!.regex = "^(A*)*$")), /nested quantifiers/);
    expectProblem(packProblems((p) => (p.serialFormats[0]!.regex = "^(unclosed$")), /does not compile/);
  });

  test("every referenced group index must be ≤ the group count", () => {
    expectProblem(packProblems((p) => ((p.serialFormats[0]!.date as { yearGroup: number }).yearGroup = 4)), /date.yearGroup = 4 exceeds the regex group count \(3\)/);
    expectProblem(packProblems((p) => ((p.serialFormats[0]!.date as { weekGroup?: number }).weekGroup = 9)), /date.weekGroup = 9 exceeds/);
    expectProblem(packProblems((p) => ((p.serialFormats[1]!.date as { monthGroup?: number }).monthGroup = 5)), /date.monthGroup = 5 exceeds/);
    expectProblem(packProblems((p) => ((p.serialFormats[0]!.date as { dayOfYearGroup?: number }).dayOfYearGroup = 7)), /date.dayOfYearGroup = 7 exceeds/);
    expectProblem(packProblems((p) => ((p.serialFormats[2]!.date as { decadeGroup: number }).decadeGroup = 4)), /date.decadeGroup = 4 exceeds/);
    expectProblem(packProblems((p) => (p.serialFormats[0]!.plant!.group = 4)), /plant.group = 4 exceeds/);
    expectProblem(packProblems((p) => (p.modelFormats[0]!.segments[0]!.group = 6)), /segment\[0\]: group = 6 exceeds the regex group count \(5\)/);
    expectProblem(packProblems((p) => (p.modelFormats[0]!.segments[0]!.group = 0)), /group must be a positive integer/);
    expectProblem(packProblems((p) => delete (p.serialFormats[0]!.date as { yearGroup?: number }).yearGroup), /date.yearGroup is required/);
  });

  test("high confidence requires sources (pack, serialFormats, modelFormats, controls, electrical, commonIssues)", () => {
    expectProblem(packProblems((p) => delete p.sources), /manufacturers\/acme: high confidence requires non-empty sources/);
    expectProblem(packProblems((p) => (p.serialFormats[0]!.sources = [])), /serialFormat acme-yyww: high confidence requires non-empty sources/);
    expectProblem(packProblems((p) => delete p.modelFormats[0]!.sources), /modelFormat acme-rtu: high confidence requires non-empty sources/);
    expectProblem(packProblems((p) => (p.controls[0]!.confidence = "high")), /control acme-ctl: high confidence requires non-empty sources/);
    expectProblem(packProblems((p) => (p.electrical![0]!.confidence = "high")), /electrical\[0\]: high confidence requires non-empty sources/);
    expectProblem(packProblems((p) => (p.commonIssues[0]!.confidence = "high")), /commonIssue\[0\]: high confidence requires non-empty sources/);
    assert.deepEqual(packProblems((p) => (p.controls[0]!.confidence = "medium")), []);
  });

  test("examples: ≥ 2 serial and ≥ 1 model example unless low", () => {
    expectProblem(packProblems((p) => (p.serialFormats[0]!.examples = [p.serialFormats[0]!.examples![0]!])), /acme-yyww: needs >= 2 serial examples for high confidence \(has 1\)/);
    expectProblem(packProblems((p) => delete p.serialFormats[1]!.examples), /acme-letter: needs >= 2 serial examples for medium confidence/);
    expectProblem(packProblems((p) => (p.modelFormats[0]!.examples = [])), /acme-rtu: needs >= 1 model example for high confidence/);
    assert.deepEqual(packProblems((p) => { p.serialFormats[2]!.examples = []; p.modelFormats[1]!.examples = undefined; }), [], "low confidence is exempt");
    expectProblem(packProblems((p) => (p.serialFormats[0]!.examples![0] = { serial: "", expect: {} })), /example\[0\] needs a serial/);
    expectProblem(packProblems((p) => (p.modelFormats[0]!.examples![0] = { model: "AG036B3", expect: { bogus: "x" } as never })), /expects unknown attribute "bogus"/);
  });

  test("letterYear map values 1965–2100, monthLetterMap 1–12, decadeMap and yearMap ranges", () => {
    expectProblem(packProblems((p) => ((p.serialFormats[1]!.date as { map: Record<string, number> }).map.Z = 1960)), /date.map\["Z"\] = 1960 outside 1965..2100/);
    expectProblem(packProblems((p) => ((p.serialFormats[1]!.date as { map: Record<string, number> }).map.Z = 2101)), /date.map\["Z"\] = 2101 outside/);
    expectProblem(packProblems((p) => ((p.serialFormats[1]!.date as { monthLetterMap: Record<string, number> }).monthLetterMap.Q = 13)), /monthLetterMap\["Q"\] = 13 outside 1..12/);
    expectProblem(packProblems((p) => ((p.serialFormats[1]!.date as { monthLetterMap: Record<string, number> }).monthLetterMap.Q = 0)), /monthLetterMap\["Q"\] = 0 outside 1..12/);
    expectProblem(packProblems((p) => ((p.serialFormats[0]!.date as { yearMap?: Record<string, number> }).yearMap = { "99": 1899 })), /yearMap\["99"\] = 1899 outside/);
    expectProblem(packProblems((p) => ((p.serialFormats[2]!.date as { decadeMap?: Record<string, number> }).decadeMap = { "1": "x" as never })), /decadeMap\["1"\] = "x" outside/);
    expectProblem(packProblems((p) => ((p.serialFormats[1]!.date as { map?: unknown }).map = undefined)), /date.map is required/);
  });

  test("date rule shape: known method, manual note, decadeBase, pivot", () => {
    expectProblem(packProblems((p) => ((p.serialFormats[0]!.date as { method: string }).method = "magic")), /unknown date method "magic"/);
    expectProblem(packProblems((p) => ((p.serialFormats[3]!.date as { note: string }).note = "")), /manual date rule needs a note/);
    expectProblem(packProblems((p) => (p.serialFormats[0]!.date = { method: "oneDigitYear", yearGroup: 1, decadeBase: "2000" as never })), /oneDigitYear needs a numeric decadeBase/);
    expectProblem(packProblems((p) => ((p.serialFormats[0]!.date as { pivot?: number }).pivot = 150)), /date.pivot must be 0..99/);
    expectProblem(packProblems((p) => delete (p.serialFormats[0] as { date?: unknown }).date), /missing date rule/);
  });

  test("model formats: productType, attribute, transform, map_tons needs map, unknown control platform ids, family", () => {
    expectProblem(packProblems((p) => (p.modelFormats[0]!.productType = "spaceship" as never)), /unknown productType "spaceship"/);
    expectProblem(packProblems((p) => (p.modelFormats[0]!.segments[0]!.attribute = "colour" as never)), /unknown attribute "colour"/);
    expectProblem(packProblems((p) => (p.modelFormats[0]!.segments[1]!.transform = "cubits" as never)), /unknown transform "cubits"/);
    expectProblem(packProblems((p) => (p.modelFormats[0]!.segments[1]!.transform = "map_tons")), /map_tons requires a map/);
    expectProblem(packProblems((p) => (p.modelFormats[0]!.controlPlatformIds = ["ghost"])), /references unknown control platform "ghost"/);
    expectProblem(packProblems((p) => (p.modelFormats[0]!.family = "")), /missing family/);
    expectProblem(packProblems((p) => (p.modelFormats[1]!.id = "acme-rtu")), /duplicate id/);
  });

  test("controls: ≥ 1 fault code with code + meaning, coverage enum, LED patterns", () => {
    expectProblem(packProblems((p) => (p.controls[0]!.faultCodes = [])), /control acme-ctl: needs >= 1 fault code/);
    expectProblem(packProblems((p) => (p.controls[0]!.faultCodes = [{ code: "A1", meaning: "" }])), /fault code without code\/meaning/);
    expectProblem(packProblems((p) => (p.controls[0]!.coverage = "most" as never)), /coverage must be complete\|partial/);
    expectProblem(packProblems((p) => (p.controls[0]!.ledPatterns = [{ pattern: "", meaning: "x" }])), /LED pattern without pattern\/meaning/);
    expectProblem(packProblems((p) => ((p.controls[0] as { name?: string }).name = undefined)), /control platform missing id\/name/);
  });

  test("electrical and commonIssues shape", () => {
    expectProblem(packProblems((p) => (p.electrical![0]!.familyRegex = "(?i)x")), /electrical\[0\]: familyRegex invalid/);
    expectProblem(packProblems((p) => (p.electrical![0]!.components = [{ designator: "", name: "x" }])), /component\[0\] needs designator and name/);
    expectProblem(packProblems((p) => (p.commonIssues[0]!.appliesTo = "(?i)x")), /commonIssue\[0\]: appliesTo regex invalid/);
    expectProblem(packProblems((p) => (p.commonIssues[0]!.likelyCauses = [])), /likelyCauses\[\] required/);
    expectProblem(packProblems((p) => (p.commonIssues[0]!.checks = undefined as never)), /checks\[\] required/);
    expectProblem(packProblems((p) => (p.commonIssues[0]!.evidence = "gut_feeling" as never)), /unknown evidence level "gut_feeling"/);
  });

  test("top-level: id/manufacturer/brands/confidence", () => {
    expectProblem(packProblems((p) => (p.brands = [])), /brands\[\] required/);
    expectProblem(packProblems((p) => (p.confidence = "sure" as never)), /confidence must be high\|medium\|low/);
    const problems: string[] = [];
    validateManufacturerPack({ id: "", manufacturer: "" } as ManufacturerPack, problems);
    expectProblem(problems, /id and manufacturer are required/);
    expectProblem(problems, /serialFormats\[\] is required/);
  });
});

// ---------------------------------------------------------------------------
// Refrigerants
// ---------------------------------------------------------------------------

describe("validateRefrigerantIndex", () => {
  const tables = new Map<string, RefrigerantTable>([
    ["R-410A", table("R-410A")],
    ["R-22", table("R-22")],
  ]);

  test("valid index", () => {
    const problems: string[] = [];
    validateRefrigerantIndex([meta("R-410A"), meta("R-22")], tables, problems, { indexExists: true, strict: true });
    assert.deepEqual(problems, []);
  });

  test("entry needs a table, ASHRAE 34 safety class and gwp.ar4; reverse check", () => {
    const problems: string[] = [];
    validateRefrigerantIndex(
      [meta("R-410A"), meta("R-999"), meta("R-22", { safetyClass: "A4" }), { ...meta("R-22"), gwp: {} }],
      tables,
      problems,
      { indexExists: true, strict: true },
    );
    expectProblem(problems, /R-999 has no table file/);
    expectProblem(problems, /R-22 safetyClass "A4" is not an ASHRAE 34 class/);
    expectProblem(problems, /R-22 gwp.ar4 must be a number/);
    expectProblem(problems, /duplicate entry R-22/);
    const reverse: string[] = [];
    validateRefrigerantIndex([meta("R-410A")], tables, reverse, { indexExists: true, strict: false });
    assert.deepEqual(reverse, ["refrigerants/index.json: table R-22 has no index entry"]);
    for (const cls of ["A1", "A2L", "A2", "A3", "B1", "B2L", "B2", "B3"]) {
      const ok: string[] = [];
      validateRefrigerantIndex([meta("R-410A", { safetyClass: cls }), meta("R-22")], tables, ok, { indexExists: true, strict: true });
      assert.deepEqual(ok, [], cls);
    }
  });

  test("missing index: problem only in strict mode; non-array index is a problem", () => {
    const strict: string[] = [];
    validateRefrigerantIndex(undefined, tables, strict, { indexExists: false, strict: true });
    assert.deepEqual(strict, ["refrigerants/index.json: missing (required in strict mode)"]);
    const lax: string[] = [];
    validateRefrigerantIndex(undefined, tables, lax, { indexExists: false, strict: false });
    assert.deepEqual(lax, []);
    const bad: string[] = [];
    validateRefrigerantIndex({} as never, tables, bad, { indexExists: true, strict: true });
    expectProblem(bad, /must be an array/);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

describe("validateRuleSet", () => {
  function ruleProblems(mutate: (r: DxRuleSet) => void): string[] {
    const r = validRules();
    mutate(r);
    const problems: string[] = [];
    validateRuleSet(r, problems);
    return problems;
  }

  test("valid rule set", () => {
    assert.deepEqual(ruleProblems(() => {}), []);
  });

  test("MetricKey list covers DxDerived, DxMeasurements and deltas", () => {
    for (const k of ["evapSatF", "targetDeltaTF", "standingExcessPsi", "outdoorDbF", "nameplateSuperheatF", "notes", "sightGlass", "superheatDelta", "subcoolingDelta"]) {
      assert.ok(METRIC_KEYS.has(k), k);
    }
    assert.ok(NUMERIC_METRIC_KEYS.has("superheatF"));
    assert.ok(NUMERIC_METRIC_KEYS.has("sightGlass"), "enum-coded categoricals compare numerically");
    assert.ok(!NUMERIC_METRIC_KEYS.has("targetDeltaTF"));
    assert.ok(!NUMERIC_METRIC_KEYS.has("refrigerant"));
    assert.ok(!NUMERIC_METRIC_KEYS.has("mode"));
  });

  test("when[]: known metric, numeric ops carry value (value2 for between), numeric ops only on numeric keys", () => {
    expectProblem(ruleProblems((r) => r.rules[0]!.when.push({ metric: "bogus" as never, op: ">", value: 1 })), /when\[5\]: unknown metric "bogus"/);
    expectProblem(ruleProblems((r) => r.rules[0]!.when.push({ metric: "superheatF", op: ">" })), /op ">" needs a numeric value/);
    expectProblem(ruleProblems((r) => r.rules[0]!.when.push({ metric: "superheatF", op: "between", value: 1 })), /between needs value2/);
    expectProblem(ruleProblems((r) => r.rules[0]!.when.push({ metric: "superheatF", op: "between", value: 5, value2: 1 })), /between has value2 < value/);
    expectProblem(ruleProblems((r) => r.rules[0]!.when.push({ metric: "refrigerant", op: ">", value: 1 })), /numeric op ">" on non-numeric metric "refrigerant"/);
    expectProblem(ruleProblems((r) => r.rules[0]!.when.push({ metric: "targetDeltaTF", op: "<=", value: 1 })), /non-numeric metric "targetDeltaTF"/);
    expectProblem(ruleProblems((r) => r.rules[0]!.when.push({ metric: "superheatF", op: "~" as never })), /unknown op "~"/);
    assert.deepEqual(ruleProblems((r) => r.rules[0]!.when.push({ metric: "mode", op: "absent" }, { metric: "targetDeltaTF", op: "present" })), []);
  });

  test("appliesTo enums, severity, confidence, duplicates, malformed rules, defaults", () => {
    expectProblem(ruleProblems((r) => (r.rules[0]!.appliesTo = { meteringDevice: ["orifice" as never] })), /appliesTo.meteringDevice has unknown "orifice"/);
    expectProblem(ruleProblems((r) => (r.rules[0]!.appliesTo = { mode: ["defrost" as never] })), /appliesTo.mode has unknown "defrost"/);
    expectProblem(ruleProblems((r) => (r.rules[0]!.severity = "fatal" as never)), /unknown severity "fatal"/);
    expectProblem(ruleProblems((r) => (r.rules[0]!.confidence = "sure" as never)), /unknown confidence "sure"/);
    expectProblem(ruleProblems((r) => r.rules.push({ ...r.rules[0]! })), /rule undercharge: duplicate id/);
    expectProblem(ruleProblems((r) => r.rules.push({ id: "empty", when: [] } as never)), /rule empty malformed/);
    expectProblem(ruleProblems((r) => (r.defaults.compressionRatioWarn = "high" as never)), /defaults.compressionRatioWarn must be a number/);
    expectProblem(ruleProblems((r) => (r.defaults.evapTdNormalF = { min: 40, max: 30 })), /defaults.evapTdNormalF must be \{min <= max\}/);
    expectProblem(ruleProblems((r) => (r.defaults.byMode = { cooling: {} } as never)), /byMode has unknown mode "cooling"/);
  });
});

describe("validateChargingTargets", () => {
  function chargingProblems(mutate: (c: ChargingTargets) => void): string[] {
    const c = validCharging();
    mutate(c);
    const problems: string[] = [];
    validateChargingTargets(c, problems);
    return problems;
  }

  test("valid grid", () => {
    assert.deepEqual(chargingProblems(() => {}), []);
  });

  test("grids must be rows × cols of number|null", () => {
    expectProblem(chargingProblems((c) => (c.fixedOrificeSuperheat.targetF = [[30, 25, null]])), /fixedOrificeSuperheat: targetF has 1 rows, expected 2/);
    expectProblem(chargingProblems((c) => (c.fixedOrificeSuperheat.targetF[1] = [32, 27])), /targetF\[1\] has 2 columns, expected 3/);
    expectProblem(chargingProblems((c) => (c.fixedOrificeSuperheat.targetF[0]![0] = "30" as never)), /targetF\[0\]\[0\] must be a number or null/);
    expectProblem(chargingProblems((c) => (c.fixedOrificeSuperheat.indoorWbF = ["50"] as never)), /row axis must be a number\[\]/);
    expectProblem(chargingProblems((c) => (c.targetDeltaT!.targetF = [[23, 19], [1, 2]])), /targetDeltaT: targetF has 2 rows, expected 1/);
    expectProblem(chargingProblems((c) => delete (c as { notes?: unknown }).notes), /notes\[\] required/);
    expectProblem(chargingProblems((c) => delete (c as { fixedOrificeSuperheat?: unknown }).fixedOrificeSuperheat), /fixedOrificeSuperheat required/);
  });
});

// ---------------------------------------------------------------------------
// Electrical packs (finding: malformed components/procedures/reference passed strict loading and
// then made findComponent/findProcedure/findReference throw)
// ---------------------------------------------------------------------------

describe("electrical validation", () => {
  test("a complete electrical dir loads strictly and the lookups work", () => {
    const kb = loadKnowledge(writeKb({ ...fullValid(), components: componentsFile(), procedures: proceduresFile() }), { strict: true });
    assert.equal(kb.electrical.version, "1");
    assert.equal(kb.electrical.components.length, MIN_ELECTRICAL_COMPONENTS);
    assert.equal(kb.electrical.procedures.length, MIN_ELECTRICAL_PROCEDURES);
    assert.equal(kb.electrical.reference.length, 1);
    assert.equal(findComponent(kb, "comp 3")[0]?.id, "comp_3");
    assert.equal(findProcedure(kb, "proc 2")[0]?.id, "proc_2");
    assert.equal(findReference(kb, "voltage imbalance")[0]?.topic, "voltage imbalance");
  });

  test("strict loading rejects a component missing failureModes/tests (the scenario that used to throw in findComponent)", () => {
    const files = { ...fullValid(), components: { version: "1", components: [{ id: "x", name: "x thing", function: "f" }] } };
    assert.throws(
      () => loadKnowledge(writeKb(files), { strict: true }),
      (e: unknown) => {
        assert.ok(e instanceof KnowledgeValidationError);
        const ps = e.problems.join("\n");
        assert.match(ps, /components\[0\]: failureModes must be a string array/);
        assert.match(ps, /components\[0\]: tests\[\] required/);
        assert.match(ps, /components\[0\]: safety must be a string array/);
        assert.match(ps, /1 components, spec minimum is 22/);
        return true;
      },
    );
    // non-strict: the entry is kept and the lookup returns it without throwing
    const kb = loadKnowledge(writeKb(files), { strict: false });
    assert.equal(kb.electrical.components.length, 1);
    assert.equal(findComponent(kb, "x thing")[0]?.id, "x");
  });

  test("strict loading rejects a procedure without steps/commonCauses and a reference topic without content", () => {
    const files = {
      ...fullValid(),
      components: componentsFile(MIN_ELECTRICAL_COMPONENTS, [{ topic: "z" }]),
      procedures: { version: "1", procedures: [{ id: "y", symptom: "unit dead" }] },
    };
    assert.throws(
      () => loadKnowledge(writeKb(files), { strict: true }),
      (e: unknown) => {
        assert.ok(e instanceof KnowledgeValidationError);
        const ps = e.problems.join("\n");
        assert.match(ps, /reference\[0\]: content must be a string array/);
        assert.match(ps, /procedures\[0\]: steps\[\] required/);
        assert.match(ps, /procedures\[0\]: commonCauses must be a string array/);
        assert.match(ps, /procedures\[0\]: safety must be a string array/);
        assert.match(ps, /1 procedures, spec minimum is 16/);
        return true;
      },
    );
    const kb = loadKnowledge(writeKb(files), { strict: false });
    assert.equal(findProcedure(kb, "unit dead")[0]?.id, "y");
    assert.equal(findReference(kb, "z")[0]?.topic, "z");
  });

  test("spec minimums: ≥ 22 components and ≥ 16 procedures when the file is present; absent files still default", () => {
    const short = { ...fullValid(), components: componentsFile(21), procedures: proceduresFile(15) };
    assert.throws(
      () => loadKnowledge(writeKb(short), { strict: true }),
      (e: unknown) => {
        assert.ok(e instanceof KnowledgeValidationError);
        assert.equal(e.problems.length, 2, e.problems.join("\n"));
        assert.match(e.problems[0]!, /21 components, spec minimum is 22/);
        assert.match(e.problems[1]!, /15 procedures, spec minimum is 16/);
        return true;
      },
    );
    const none = loadKnowledge(writeKb(fullValid()), { strict: true });
    assert.equal(none.electrical.components.length, 0);
    assert.equal(none.electrical.procedures.length, 0);
  });

  test("validateElectricalComponents: field types, test shape, duplicate ids, non-objects", () => {
    const problems: string[] = [];
    validateElectricalComponents(
      [
        component("a", { aliases: "cap" as unknown as string[], tools: [1] as unknown as string[] }),
        component("a", { tests: [{ name: "", energized: "yes" as unknown as boolean, steps: "x" as unknown as string[], expected: "" }, null as unknown as ElectricalComponent["tests"][number]] }),
        null as unknown as ElectricalComponent,
        { id: "", name: 3, function: "" } as unknown as ElectricalComponent,
      ],
      problems,
      "c.json",
    );
    const ps = problems.join("\n");
    assert.match(ps, /c.json: components\[0\]: aliases must be a string array/);
    assert.match(ps, /components\[0\]: tools must be a string array/);
    assert.match(ps, /components\[1\]: duplicate component id a/);
    assert.match(ps, /components\[1\].tests\[0\]: name must be a non-empty string/);
    assert.match(ps, /components\[1\].tests\[0\]: energized must be a boolean/);
    assert.match(ps, /components\[1\].tests\[0\]: steps must be a string array/);
    assert.match(ps, /components\[1\].tests\[0\]: expected must be a non-empty string/);
    assert.match(ps, /components\[1\].tests\[1\]: not an object/);
    assert.match(ps, /components\[2\]: not an object/);
    assert.match(ps, /components\[3\]: id must be a non-empty string/);
    assert.match(ps, /components\[3\]: name must be a non-empty string/);
    assert.match(ps, /components\[3\]: function must be a non-empty string/);
    const clean: string[] = [];
    validateElectricalComponents([component("a"), component("b", { aliases: ["x"], tools: ["meter"], notes: ["n"] })], clean);
    assert.deepEqual(clean, []);
    const notArray: string[] = [];
    validateElectricalComponents({ a: 1 }, notArray, "c.json");
    assert.deepEqual(notArray, ["c.json: components[] required"]);
  });

  test("validateElectricalProcedures: field types, step shape, duplicate ids", () => {
    const problems: string[] = [];
    validateElectricalProcedures(
      [
        procedure("p", { appliesTo: "rtu" as unknown as string[], steps: [{ step: "", expect: 1 as unknown as string, ifNot: 2 as unknown as string }, 5 as unknown as ElectricalProcedure["steps"][number]] }),
        procedure("p", { aliases: [1] as unknown as string[] }),
        { symptom: "" } as unknown as ElectricalProcedure,
      ],
      problems,
      "p.json",
    );
    const ps = problems.join("\n");
    assert.match(ps, /p.json: procedures\[0\]: appliesTo must be a string array/);
    assert.match(ps, /procedures\[0\].steps\[0\]: step must be a non-empty string/);
    assert.match(ps, /procedures\[0\].steps\[0\]: expect must be a string/);
    assert.match(ps, /procedures\[0\].steps\[0\]: ifNot must be a string/);
    assert.match(ps, /procedures\[0\].steps\[1\]: not an object/);
    assert.match(ps, /procedures\[1\]: duplicate procedure id p/);
    assert.match(ps, /procedures\[1\]: aliases must be a string array/);
    assert.match(ps, /procedures\[2\]: id must be a non-empty string/);
    assert.match(ps, /procedures\[2\]: symptom must be a non-empty string/);
    const clean: string[] = [];
    validateElectricalProcedures([procedure("a"), procedure("b", { aliases: ["x"], appliesTo: ["rtu"] })], clean);
    assert.deepEqual(clean, []);
  });

  test("validateElectricalReference: optional, must be an array of { topic, content[] }", () => {
    const none: string[] = [];
    validateElectricalReference(undefined, none);
    assert.deepEqual(none, []);
    const problems: string[] = [];
    validateElectricalReference([{ topic: "ok", content: ["x"] }, { topic: "", content: "x" }, 7], problems, "r.json");
    assert.deepEqual(problems, [
      "r.json: reference[1]: topic must be a non-empty string",
      "r.json: reference[1]: content must be a string array",
      "r.json: reference[2]: not an object",
    ]);
    const notArray: string[] = [];
    validateElectricalReference("x", notArray, "r.json");
    assert.deepEqual(notArray, ["r.json: reference must be an array"]);
  });

  test("a components.json that is not an object is reported, not thrown", () => {
    const kb = loadKnowledge(writeKb({ ...fullValid(), components: "nope", procedures: 42 }), { strict: false });
    assert.equal(kb.electrical.components.length, 0);
    assert.throws(() => loadKnowledge(writeKb({ ...fullValid(), components: "nope" }), { strict: true }), /not an object/);
  });
});
