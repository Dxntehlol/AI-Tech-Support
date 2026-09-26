/**
 * Runs every real manufacturer pack under knowledge/manufacturers through strict validation and the
 * decoder: every serial example must decode under its own format to the expected date parts, and every
 * model example must yield every expected attribute. Also checks refrigerant tables ↔ index.json.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ManufacturerPack, ModelAttribute, RefrigerantMeta } from "../types.ts";
import { PROJECT_ROOT } from "../config.ts";
import { validateManufacturerPack } from "./loader.ts";
import { decodeModelWithPack, decodeSerialWithPackDetailed } from "./decoder.ts";

const KNOWLEDGE_DIR = join(PROJECT_ROOT, "knowledge");
const PACK_DIR = join(KNOWLEDGE_DIR, "manufacturers");
const NOW = new Date();

interface LoadedPack {
  file: string;
  pack: ManufacturerPack | null;
  parseError?: string;
}

function loadPacks(): LoadedPack[] {
  if (!existsSync(PACK_DIR)) return [];
  return readdirSync(PACK_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const file = join(PACK_DIR, f);
      try {
        return { file, pack: JSON.parse(readFileSync(file, "utf8")) as ManufacturerPack };
      } catch (e) {
        return { file, pack: null, parseError: (e as Error).message };
      }
    });
}

const packs = loadPacks();

if (packs.length === 0) {
  console.log(`[packs.test] no manufacturer packs found under ${PACK_DIR}; nothing to check yet`);
  test("no manufacturer packs present (skipped)", () => {
    assert.ok(true);
  });
}

for (const { file, pack, parseError } of packs) {
  const name = pack?.id ?? file;
  describe(`pack ${name}`, () => {
    test(`${name}: parses as JSON`, () => {
      assert.equal(parseError, undefined, parseError);
      assert.ok(pack, "pack parsed");
    });
    if (!pack) return;

    test(`${name}: strict validation passes`, () => {
      const problems: string[] = [];
      validateManufacturerPack(pack, problems);
      assert.deepEqual(problems, [], `${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
    });

    for (const sf of Array.isArray(pack.serialFormats) ? pack.serialFormats : []) {
      for (const ex of Array.isArray(sf.examples) ? sf.examples : []) {
        test(`${name}: serial ${sf.id} example "${ex.serial}" → ${JSON.stringify(ex.expect)}`, () => {
          const detail = decodeSerialWithPackDetailed(pack, ex.serial, NOW);
          const r = detail.results.find((x) => x.formatId === sf.id);
          assert.ok(
            r,
            `format ${sf.id} did not produce a result for "${ex.serial}" (normalized "${detail.normalized}"); results: ${detail.results.map((x) => x.formatId).join(", ") || "none"}; warnings: ${detail.warnings.join(" | ") || "none"}`,
          );
          for (const key of ["year", "month", "week", "dayOfYear"] as const) {
            if (ex.expect[key] !== undefined) assert.equal(r[key], ex.expect[key], `${key} for "${ex.serial}"`);
          }
        });
      }
    }

    for (const mf of Array.isArray(pack.modelFormats) ? pack.modelFormats : []) {
      for (const ex of Array.isArray(mf.examples) ? mf.examples : []) {
        test(`${name}: model ${mf.id} example "${ex.model}"`, () => {
          const results = decodeModelWithPack(pack, ex.model);
          const r = results.find((x) => x.formatId === mf.id);
          assert.ok(r, `format ${mf.id} did not match "${ex.model}"; matched: ${results.map((x) => x.formatId).join(", ") || "none"}`);
          const { family, ...attrs } = ex.expect;
          if (family !== undefined) assert.equal(r.family, family, "family");
          for (const [k, v] of Object.entries(attrs)) {
            const got: string | undefined = r.attributes[k as ModelAttribute];
            assert.equal(
              String(got ?? "").trim().toLowerCase(),
              String(v ?? "").trim().toLowerCase(),
              `attribute ${k} for "${ex.model}" (got ${JSON.stringify(got)}, expected ${JSON.stringify(v)}); all attributes: ${JSON.stringify(r.attributes)}`,
            );
          }
        });
      }
    }
  });
}

describe("refrigerants", () => {
  const refDir = join(KNOWLEDGE_DIR, "refrigerants");
  const indexPath = join(refDir, "index.json");
  test("every PT table has an index.json entry (when index.json exists)", () => {
    if (!existsSync(indexPath)) {
      console.log("[packs.test] refrigerants/index.json not present yet; skipping table ↔ index check");
      return;
    }
    const meta = JSON.parse(readFileSync(indexPath, "utf8")) as RefrigerantMeta[];
    assert.ok(Array.isArray(meta), "index.json is an array");
    const ids = new Set(meta.map((m) => String(m.id).toUpperCase()));
    const missing: string[] = [];
    for (const f of readdirSync(refDir)) {
      if (!f.endsWith(".json") || f === "index.json" || f.startsWith("_")) continue;
      const t = JSON.parse(readFileSync(join(refDir, f), "utf8")) as { id?: string };
      if (!t.id || !ids.has(t.id.toUpperCase())) missing.push(f);
    }
    assert.deepEqual(missing, [], `tables without an index entry: ${missing.join(", ")}`);
    // Table files drop parentheses from the id (R-1233zd(E) -> R-1233zdE.json); compare by the id inside each file.
    const tableIds = new Set<string>();
    for (const f of readdirSync(refDir)) {
      if (!f.endsWith(".json") || f === "index.json" || f.startsWith("_")) continue;
      const t = JSON.parse(readFileSync(join(refDir, f), "utf8")) as { id?: string };
      if (t.id) tableIds.add(t.id.toUpperCase());
    }
    for (const m of meta) {
      assert.ok(tableIds.has(String(m.id).toUpperCase()), `index entry ${m.id} has no table file`);
    }
  });
});
