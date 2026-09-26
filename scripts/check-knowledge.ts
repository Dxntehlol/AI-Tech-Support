#!/usr/bin/env node
/**
 * check-knowledge: loads knowledge/ strictly, runs every manufacturer-pack example through the decoder,
 * prints a per-pack summary table and exits 1 on any failure.
 *
 *   node --disable-warning=ExperimentalWarning scripts/check-knowledge.ts [knowledgeDir]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManufacturerPack } from "../src/types.ts";
import { PROJECT_ROOT } from "../src/config.ts";
import { KnowledgeValidationError, loadKnowledge, validateManufacturerPack } from "../src/knowledge/loader.ts";
import { decodeModelWithPack, decodeSerialWithPackDetailed } from "../src/knowledge/decoder.ts";

const here = dirname(fileURLToPath(import.meta.url));
const knowledgeDir = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : join(PROJECT_ROOT, "knowledge");
const now = new Date();

interface PackRow {
  id: string;
  serialFormats: number;
  modelFormats: number;
  examplesOk: number;
  examplesFailed: number;
  faultCodes: number;
  lowConfidence: number;
  problems: number;
}

const failures: string[] = [];
const rows: PackRow[] = [];

function fail(msg: string): void {
  failures.push(msg);
}

function countLow(pack: ManufacturerPack): number {
  let n = 0;
  for (const sf of pack.serialFormats ?? []) if (sf.confidence === "low") n++;
  for (const mf of pack.modelFormats ?? []) if (mf.confidence === "low") n++;
  for (const c of pack.controls ?? []) if (c.confidence === "low") n++;
  for (const e of pack.electrical ?? []) if (e.confidence === "low") n++;
  for (const ci of pack.commonIssues ?? []) if (ci.confidence === "low") n++;
  return n;
}

function checkPack(pack: ManufacturerPack): PackRow {
  const row: PackRow = {
    id: pack.id ?? "?",
    serialFormats: pack.serialFormats?.length ?? 0,
    modelFormats: pack.modelFormats?.length ?? 0,
    examplesOk: 0,
    examplesFailed: 0,
    faultCodes: (pack.controls ?? []).reduce((n, c) => n + (c.faultCodes?.length ?? 0), 0),
    lowConfidence: countLow(pack),
    problems: 0,
  };
  const problems: string[] = [];
  validateManufacturerPack(pack, problems);
  row.problems = problems.length;
  for (const p of problems) fail(p);

  for (const sf of pack.serialFormats ?? []) {
    for (const ex of sf.examples ?? []) {
      const detail = decodeSerialWithPackDetailed(pack, ex.serial, now);
      const r = detail.results.find((x) => x.formatId === sf.id);
      const bad: string[] = [];
      if (!r) bad.push(`no result from ${sf.id} (results: ${detail.results.map((x) => x.formatId).join(", ") || "none"}; ${detail.warnings.join(" | ") || "no warnings"})`);
      else {
        for (const key of ["year", "month", "week", "dayOfYear"] as const) {
          if (ex.expect?.[key] !== undefined && r[key] !== ex.expect[key]) bad.push(`${key}: got ${r[key]}, expected ${ex.expect[key]}`);
        }
      }
      if (bad.length) {
        row.examplesFailed++;
        fail(`${pack.id}: serial ${sf.id} "${ex.serial}": ${bad.join("; ")}`);
      } else row.examplesOk++;
    }
  }
  for (const mf of pack.modelFormats ?? []) {
    for (const ex of mf.examples ?? []) {
      const results = decodeModelWithPack(pack, ex.model);
      const r = results.find((x) => x.formatId === mf.id);
      const bad: string[] = [];
      if (!r) bad.push(`no match from ${mf.id} (matched: ${results.map((x) => x.formatId).join(", ") || "none"})`);
      else {
        const { family, ...attrs } = ex.expect ?? {};
        if (family !== undefined && r.family !== family) bad.push(`family: got "${r.family}", expected "${family}"`);
        for (const [k, v] of Object.entries(attrs)) {
          const got = r.attributes[k as keyof typeof r.attributes];
          if (String(got ?? "").trim().toLowerCase() !== String(v ?? "").trim().toLowerCase()) bad.push(`${k}: got ${JSON.stringify(got)}, expected ${JSON.stringify(v)}`);
        }
      }
      if (bad.length) {
        row.examplesFailed++;
        fail(`${pack.id}: model ${mf.id} "${ex.model}": ${bad.join("; ")}`);
      } else row.examplesOk++;
    }
  }
  return row;
}

function printTable(list: PackRow[]): void {
  const headers = ["pack", "serialFmts", "modelFmts", "examples ok", "failed", "faultCodes", "lowConf", "problems"];
  const cells = list.map((r) => [
    r.id,
    String(r.serialFormats),
    String(r.modelFormats),
    String(r.examplesOk),
    String(r.examplesFailed),
    String(r.faultCodes),
    String(r.lowConfidence),
    String(r.problems),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => (i === 0 ? v.padEnd(widths[i]!) : v.padStart(widths[i]!))).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const c of cells) console.log(line(c));
}

console.log(`check-knowledge: ${knowledgeDir} (script at ${here})`);

// 1. Strict load of everything (refrigerants index, diagnostics, charging, electrical, packs).
let loadedPacks: ManufacturerPack[] = [];
try {
  const kb = loadKnowledge(knowledgeDir, { strict: true });
  loadedPacks = kb.manufacturers;
  console.log(
    `strict load OK: ${kb.manufacturers.length} pack(s), ${kb.refrigerants.tables.size} refrigerant table(s), ${kb.refrigerants.meta.length} index entries, ${kb.diagnostics.rules.rules.length} dx rule(s), ${kb.electrical.components.length} electrical component(s), ${kb.electrical.procedures.length} procedure(s)`,
  );
} catch (e) {
  if (e instanceof KnowledgeValidationError) {
    console.log(`strict load FAILED with ${e.problems.length} problem(s):`);
    for (const p of e.problems) {
      console.log(`  - ${p}`);
      fail(p);
    }
  } else {
    const msg = (e as Error).message ?? String(e);
    console.log(`strict load FAILED: ${msg}`);
    fail(msg);
  }
}

// 2. Packs: read the files directly so examples are still checked when the strict load failed elsewhere.
const packDir = join(knowledgeDir, "manufacturers");
const packFiles = existsSync(packDir) ? readdirSync(packDir).filter((f) => f.endsWith(".json")).sort() : [];
const packsToCheck: ManufacturerPack[] = [];
for (const f of packFiles) {
  try {
    packsToCheck.push(JSON.parse(readFileSync(join(packDir, f), "utf8")) as ManufacturerPack);
  } catch (e) {
    fail(`${f}: ${(e as Error).message}`);
  }
}
if (packsToCheck.length === 0 && loadedPacks.length === 0) console.log("no manufacturer packs found");

const packProblemsSeen = new Set(failures);
for (const pack of packsToCheck) {
  const before = failures.length;
  const row = checkPack(pack);
  // de-duplicate pack validation problems already reported by the strict load
  const added = failures.splice(before);
  for (const p of added) if (!packProblemsSeen.has(p)) failures.push(p);
  rows.push(row);
}

console.log("");
printTable(rows);
console.log("");

if (failures.length) {
  console.log(`FAILED: ${failures.length} problem(s)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`OK: ${rows.reduce((n, r) => n + r.examplesOk, 0)} example(s) decoded across ${rows.length} pack(s)`);
