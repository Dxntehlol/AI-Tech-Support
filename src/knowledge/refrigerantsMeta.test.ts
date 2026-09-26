import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import { loadKnowledge, SAFETY_CLASSES, validateRefrigerantIndex } from "./loader.ts";
import { canonicalRefrigerantId, resolveRefrigerant, satPressuresAtTemp } from "./refrigerants.ts";
import type { RefrigerantMeta } from "../types.ts";

const KNOWLEDGE_DIR = join(PROJECT_ROOT, "knowledge");
const REF_DIR = join(KNOWLEDGE_DIR, "refrigerants");
const kb = loadKnowledge(KNOWLEDGE_DIR, { strict: false });
const index = JSON.parse(readFileSync(join(REF_DIR, "index.json"), "utf8")) as RefrigerantMeta[];
const tableFiles = readdirSync(REF_DIR).filter((f) => f.endsWith(".json") && f !== "index.json" && !f.startsWith("_"));
const generated = JSON.parse(readFileSync(join(REF_DIR, "_generated_meta.json"), "utf8")) as {
  id: string;
  file: string;
  type: string;
  glideF: number;
  criticalTempF: number;
  tableSource: string;
  extrapolatedAboveF?: number;
  composition?: { component: string; massPercent: number }[];
}[];

test("index.json is a non-empty RefrigerantMeta[] with unique ids", () => {
  assert.ok(Array.isArray(index));
  assert.equal(index.length, 45);
  const ids = new Set(index.map((m) => m.id.toUpperCase()));
  assert.equal(ids.size, index.length, "duplicate ids");
});

test("every table file has an index entry and every entry has a table", () => {
  const tableIds = new Set<string>();
  for (const f of tableFiles) {
    const t = JSON.parse(readFileSync(join(REF_DIR, f), "utf8")) as { id: string };
    tableIds.add(t.id.toUpperCase());
  }
  assert.equal(tableIds.size, 45, "expected 45 table files");
  for (const m of index) assert.ok(tableIds.has(m.id.toUpperCase()), `${m.id} has no table file`);
  const metaIds = new Set(index.map((m) => m.id.toUpperCase()));
  for (const id of tableIds) assert.ok(metaIds.has(id), `table ${id} has no index entry`);
  // and the loader agrees
  assert.equal(kb.refrigerants.meta.length, 45);
  assert.equal(kb.refrigerants.tables.size, 45);
  for (const m of kb.refrigerants.meta) assert.ok(kb.refrigerants.tables.has(m.id.toUpperCase()));
});

test("loader strict validation of the index reports no problems", () => {
  const problems: string[] = [];
  validateRefrigerantIndex(index, kb.refrigerants.tables, problems, { indexExists: true, strict: true });
  assert.deepEqual(problems, []);
});

test("safety classes are valid ASHRAE 34 classes and match known designations", () => {
  for (const m of index) assert.ok(SAFETY_CLASSES.has(m.safetyClass), `${m.id} safetyClass ${m.safetyClass}`);
  const expected: Record<string, string> = {
    "R-410A": "A1", "R-22": "A1", "R-134a": "A1", "R-404A": "A1", "R-407C": "A1", "R-448A": "A1", "R-449A": "A1", "R-513A": "A1",
    "R-32": "A2L", "R-454B": "A2L", "R-1234yf": "A2L", "R-1234ze(E)": "A2L", "R-454A": "A2L", "R-454C": "A2L", "R-455A": "A2L",
    "R-290": "A3", "R-600a": "A3", "R-717": "B2L", "R-744": "A1", "R-123": "B1", "R-245fa": "B1", "R-152a": "A2", "R-1233zd(E)": "A1",
  };
  for (const [id, sc] of Object.entries(expected)) {
    const m = index.find((x) => x.id === id);
    assert.ok(m, id);
    assert.equal(m!.safetyClass, sc, id);
  }
});

test("gwp.ar4 present and numeric for all, with spot values", () => {
  for (const m of index) {
    assert.ok(m.gwp && typeof m.gwp.ar4 === "number" && Number.isFinite(m.gwp.ar4), `${m.id} gwp.ar4`);
    assert.ok(m.gwp!.ar4! >= 0);
    if (m.gwp!.ar5 !== undefined) assert.ok(Number.isFinite(m.gwp!.ar5));
  }
  const spot: Record<string, number> = { "R-410A": 2088, "R-22": 1810, "R-134a": 1430, "R-404A": 3922, "R-32": 675, "R-454B": 466, "R-744": 1, "R-717": 0, "R-1234yf": 4 };
  for (const [id, v] of Object.entries(spot)) assert.equal(index.find((m) => m.id === id)!.gwp!.ar4, v, id);
});

test("type matches ASHRAE designation series", () => {
  for (const m of index) {
    const num = Number(/^R-(\d+)/.exec(m.id)![1]);
    if (num >= 400 && num < 500) assert.equal(m.type, "zeotrope", m.id);
    else if (num >= 500 && num < 600) assert.equal(m.type, "azeotrope", m.id);
    else assert.equal(m.type, "pure", m.id);
    if (m.type === "pure") assert.equal(m.composition, undefined, `${m.id} pure fluid should not list a composition`);
    else {
      assert.ok(m.composition && m.composition.length >= 2, `${m.id} composition`);
      const total = m.composition!.reduce((s, c) => s + c.massPercent, 0);
      assert.ok(Math.abs(total - 100) < 0.2, `${m.id} composition sums to ${total}`);
      for (const c of m.composition!) assert.match(c.component, /^R-\d+[a-z]*(\([A-Z]\))?$/, `${m.id} component ${c.component}`);
    }
  }
  const r410 = index.find((m) => m.id === "R-410A")!;
  assert.deepEqual(r410.composition, [{ component: "R-32", massPercent: 50 }, { component: "R-125", massPercent: 50 }]);
});

test("generated fields (glide, critical temp, table source, extrapolation) match _generated_meta.json", () => {
  for (const g of generated) {
    const m = index.find((x) => x.id === g.id);
    assert.ok(m, g.id);
    assert.equal(m!.type, g.type, `${g.id} type`);
    assert.equal(m!.glideF, Math.abs(g.glideF) < 0.05 ? 0 : g.glideF, `${g.id} glideF`);
    assert.equal(m!.criticalTempF, g.criticalTempF, `${g.id} criticalTempF`);
    assert.equal(m!.tableSource, g.tableSource, `${g.id} tableSource`);
    assert.equal(m!.extrapolatedAboveF, g.extrapolatedAboveF, `${g.id} extrapolatedAboveF`);
  }
});

test("blendType follows the glide thresholds", () => {
  for (const m of index) {
    const g = m.glideF ?? 0;
    if (m.type !== "zeotrope") {
      assert.equal(m.blendType, undefined, m.id);
      continue;
    }
    if (g < 1.5) assert.equal(m.blendType, "near_azeotrope", m.id);
    else if (g >= 5) assert.equal(m.blendType, "high_glide", m.id);
    else assert.equal(m.blendType, undefined, m.id);
  }
  assert.equal(index.find((m) => m.id === "R-410A")!.blendType, "near_azeotrope");
  assert.equal(index.find((m) => m.id === "R-407C")!.blendType, "high_glide");
  assert.equal(index.find((m) => m.id === "R-454B")!.blendType, undefined);
});

test("aliases resolve via resolveRefrigerant", () => {
  const cases: [string, string][] = [
    ["410a", "R-410A"], ["R410A", "R-410A"], ["R-410a", "R-410A"], ["Puron", "R-410A"], ["puron", "R-410A"],
    ["xl41", "R-454B"], ["Opteon XL41", "R-454B"], ["454b", "R-454B"],
    ["n40", "R-448A"], ["Solstice N40", "R-448A"],
    ["mo99", "R-438A"], ["Freon MO99", "R-438A"],
    ["xp40", "R-449A"], ["xp10", "R-513A"], ["xp44", "R-452A"], ["N13", "R-450A"],
    ["Performax LT", "R-407F"], ["NU-22B", "R-422B"], ["MO29", "R-422D"], ["RS-45", "R-434A"], ["HP62", "R-404A"], ["AZ-50", "R-507A"],
    ["ammonia", "R-717"], ["NH3", "R-717"], ["CO2", "R-744"], ["propane", "R-290"], ["isobutane", "R-600a"],
    ["freon 22", "R-22"], ["hcfc-22", "R-22"], ["Klea 134a", "R-134a"],
    ["1234yf", "R-1234yf"], ["r1234ze(e)", "R-1234ze(E)"], ["1233zd", "R-1233zd(E)"],
  ];
  for (const [input, id] of cases) {
    const m = resolveRefrigerant(kb, input);
    assert.ok(m, `resolve ${input}`);
    assert.equal(m!.id, id, `resolve ${input}`);
    assert.notEqual(m!.safetyClass, "unknown", `${input} resolved via table fallback, not metadata`);
  }
  // bare brand names cover several refrigerants and must not resolve to one
  for (const ambiguous of ["Freon", "Klea"]) assert.equal(resolveRefrigerant(kb, ambiguous), undefined, `${ambiguous} is ambiguous`);
  // every alias in the index resolves to its own entry
  for (const m of index) for (const a of m.aliases) assert.equal(resolveRefrigerant(kb, a)?.id, m.id, `alias ${a}`);
});

test("no duplicate aliases across entries (raw or canonical form)", () => {
  const raw = new Map<string, string>();
  const canon = new Map<string, string>();
  for (const m of index) {
    assert.ok(m.aliases.length >= 2, `${m.id} needs aliases`);
    for (const a of m.aliases) {
      const k = a.toLowerCase();
      assert.ok(!raw.has(k) || raw.get(k) === m.id, `alias ${a} shared by ${raw.get(k)} and ${m.id}`);
      raw.set(k, m.id);
      const c = canonicalRefrigerantId(a).toUpperCase();
      if (/^R-\d/.test(c)) {
        assert.ok(!canon.has(c) || canon.get(c) === m.id, `alias ${a} canonicalizes to ${c}, owned by ${canon.get(c)} and ${m.id}`);
        canon.set(c, m.id);
        const other = index.find((x) => x.id.toUpperCase() === c && x.id !== m.id);
        assert.equal(other, undefined, `alias ${a} of ${m.id} collides with id ${other?.id}`);
      }
    }
  }
});

test("required text fields are present", () => {
  for (const m of index) {
    assert.ok(m.applications.length >= 1, `${m.id} applications`);
    assert.ok(m.serviceNotes.length >= 2, `${m.id} serviceNotes`);
    assert.ok(m.lubricant && m.lubricant.length > 1, `${m.id} lubricant`);
    assert.ok(typeof m.criticalTempF === "number", `${m.id} criticalTempF`);
    if (m.criticalPsig !== undefined) {
      // the table top must sit at or below the critical pressure
      const t = kb.refrigerants.tables.get(m.id.toUpperCase())!;
      const top = t.bubblePsig[t.bubblePsig.length - 1]!;
      assert.ok(top <= m.criticalPsig + 1, `${m.id} table top ${top} exceeds criticalPsig ${m.criticalPsig}`);
    }
    if (m.safetyClass === "A2L") assert.ok(m.serviceNotes.some((n) => /A2L/.test(n) && /ignition/i.test(n)), `${m.id} needs A2L handling note`);
    if (m.safetyClass === "A3") assert.ok(m.serviceNotes.some((n) => /A3/.test(n) && /flammable/i.test(n)), `${m.id} needs A3 handling note`);
    if (m.type === "zeotrope" && (m.glideF ?? 0) >= 0.5) assert.ok(m.serviceNotes.some((n) => /liquid/i.test(n)), `${m.id} needs charge-as-liquid note`);
    if (m.extrapolatedAboveF !== undefined) assert.ok(m.serviceNotes.some((n) => n.includes(`${m.extrapolatedAboveF} °F`) && /extrapolat/i.test(n)), `${m.id} extrapolation warning`);
    if (m.tableSource === "coolprop_mixture_approx") assert.ok(m.serviceNotes.some((n) => /APPROXIMATE/.test(n)), `${m.id} approximate warning`);
  }
});

test("tableVerified spot checks are recorded and the tables reproduce the reference points", () => {
  const required = ["R-410A", "R-22", "R-134a", "R-404A", "R-407C", "R-454B", "R-32", "R-448A", "R-449A"];
  const optional = ["R-513A"]; // verified only when a published chart was available to the verifier
  for (const id of [...required, ...optional]) {
    const m = index.find((x) => x.id === id)!;
    if (!m.tableVerified && optional.includes(id)) continue;
    assert.ok(m.tableVerified, `${id} tableVerified`);
    assert.ok(m.tableVerified!.pointsChecked >= 5, id);
    assert.ok(m.tableVerified!.against.length > 10, id);
    // DESIGN.md tolerance: ±1 psi or 1.5 % (predefined), ±2 psi or 2.5 % (mixtures) — the percent applies at the checked pressures
    const table = kb.refrigerants.tables.get(id.toUpperCase())!;
    const topPsig = table.bubblePsig[table.bubblePsig.length - 1]!;
    const tol = m.tableSource === "coolprop_predefined" ? Math.max(1.0, 0.015 * Math.min(topPsig, 320)) : Math.max(2.0, 0.025 * Math.min(topPsig, 320));
    assert.ok(m.tableVerified!.maxErrorPsi <= tol, `${id} maxErrorPsi ${m.tableVerified!.maxErrorPsi} > ${tol.toFixed(1)}`);
  }
  // R-502 is known to read ~3 % low and must say so
  const r502 = index.find((x) => x.id === "R-502")!;
  assert.ok(r502.tableVerified!.maxErrorPsi > 2);
  assert.ok(r502.serviceNotes.some((n) => /LOW/.test(n) && /approximate/i.test(n)));
  // reference chart points (psig at sea level; bubble/dew)
  const refs: [string, number, number, number?][] = [
    ["R-410A", 40, 118.8, 118.4], ["R-410A", 100, 318.5, 317.5], ["R-410A", -20, 26.4, 26.2],
    ["R-22", 0, 24.0], ["R-22", 40, 68.5], ["R-22", 130, 296.8],
    ["R-134a", 40, 35.0], ["R-134a", 100, 124.1],
    ["R-404A", 40, 86.9, 85.4], ["R-404A", -20, 16.8, 16.0],
    ["R-407C", 40, 80.2, 63.2], ["R-407C", 100, 225.4, 196.1],
    ["R-32", 40, 120.9], ["R-32", 100, 325.6],
    ["R-513A", 40, 39.9], ["R-513A", 130, 206.2],
    ["R-454B", 40, 113.3, 107.5], ["R-448A", 40, 89.5, 71.4], ["R-449A", 40, 87.9, 71.3],
  ];
  for (const [id, tF, bubble, dew] of refs) {
    const t = kb.refrigerants.tables.get(id.toUpperCase())!;
    const p = satPressuresAtTemp(t, tF)!;
    const tol = index.find((x) => x.id === id)!.tableSource === "coolprop_predefined" ? 1.0 : 2.0;
    assert.ok(Math.abs(p.bubblePsig - bubble) <= tol, `${id} ${tF}F bubble ${p.bubblePsig} vs ${bubble}`);
    assert.ok(Math.abs(p.dewPsig - (dew ?? bubble)) <= tol, `${id} ${tF}F dew ${p.dewPsig} vs ${dew ?? bubble}`);
  }
});
