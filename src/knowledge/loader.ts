import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ChargingTargets,
  DxRuleSet,
  ElectricalKnowledge,
  KnowledgeBase,
  ManufacturerPack,
  RefrigerantMeta,
  RefrigerantTable,
} from "../types.ts";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));
}

export interface LoadOptions {
  /** Throw if a pack fails validation (default true). */
  strict?: boolean;
}

export class KnowledgeValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Knowledge validation failed:\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

/** Basic structural validation; deeper checks (examples decode) live in decoder tests. */
export function validateManufacturerPack(pack: ManufacturerPack, problems: string[]): void {
  const where = `manufacturers/${pack.id ?? "?"}`;
  if (!pack.id || !pack.manufacturer) problems.push(`${where}: id and manufacturer are required`);
  if (!Array.isArray(pack.brands) || pack.brands.length === 0) problems.push(`${where}: brands[] required`);
  for (const sf of pack.serialFormats ?? []) {
    try {
      new RegExp(sf.regex, "i");
    } catch (e) {
      problems.push(`${where}: serialFormat ${sf.id} regex invalid: ${(e as Error).message}`);
    }
    if (!sf.date) problems.push(`${where}: serialFormat ${sf.id} missing date rule`);
  }
  for (const mf of pack.modelFormats ?? []) {
    try {
      new RegExp(mf.regex, "i");
    } catch (e) {
      problems.push(`${where}: modelFormat ${mf.id} regex invalid: ${(e as Error).message}`);
    }
    if (!mf.family) problems.push(`${where}: modelFormat ${mf.id} missing family`);
  }
  for (const c of pack.controls ?? []) {
    if (!c.id || !c.name) problems.push(`${where}: control platform missing id/name`);
    for (const fc of c.faultCodes ?? []) {
      if (!fc.code || !fc.meaning) problems.push(`${where}: control ${c.id} has a fault code without code/meaning`);
    }
  }
}

export function loadKnowledge(dir: string, opts: LoadOptions = {}): KnowledgeBase {
  const strict = opts.strict ?? true;
  const problems: string[] = [];

  const manufacturers: ManufacturerPack[] = [];
  for (const file of listJson(join(dir, "manufacturers"))) {
    try {
      const pack = readJson<ManufacturerPack>(file);
      validateManufacturerPack(pack, problems);
      manufacturers.push(pack);
    } catch (e) {
      problems.push(`${file}: ${(e as Error).message}`);
    }
  }

  const refDir = join(dir, "refrigerants");
  const metaPath = join(refDir, "index.json");
  const meta: RefrigerantMeta[] = existsSync(metaPath) ? readJson<RefrigerantMeta[]>(metaPath) : [];
  const tables = new Map<string, RefrigerantTable>();
  for (const file of listJson(refDir)) {
    if (file.endsWith("index.json") || /[\/\\]_[^\/\\]*$/.test(file)) continue;
    try {
      const t = readJson<RefrigerantTable>(file);
      if (!t.id || !Array.isArray(t.tempF) || t.tempF.length !== t.bubblePsig?.length || t.tempF.length !== t.dewPsig?.length) {
        problems.push(`${file}: malformed refrigerant table`);
        continue;
      }
      tables.set(t.id.toUpperCase(), t);
    } catch (e) {
      problems.push(`${file}: ${(e as Error).message}`);
    }
  }
  for (const m of meta) {
    if (!tables.has(m.id.toUpperCase())) problems.push(`refrigerants/index.json: ${m.id} has no table file`);
  }

  const rulesPath = join(dir, "diagnostics", "refrigeration-cycle.json");
  const chargingPath = join(dir, "diagnostics", "charging-targets.json");
  const rules: DxRuleSet = existsSync(rulesPath)
    ? readJson<DxRuleSet>(rulesPath)
    : {
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
      };
  const charging: ChargingTargets = existsSync(chargingPath)
    ? readJson<ChargingTargets>(chargingPath)
    : { version: "0", fixedOrificeSuperheat: { indoorWbF: [], outdoorDbF: [], targetF: [] }, notes: [] };
  for (const r of rules.rules) {
    if (!r.id || !Array.isArray(r.when) || r.when.length === 0) problems.push(`diagnostics: rule ${r.id ?? "?"} malformed`);
  }

  const elDir = join(dir, "electrical");
  const compPath = join(elDir, "components.json");
  const procPath = join(elDir, "procedures.json");
  const electrical: ElectricalKnowledge = {
    version: "0",
    components: existsSync(compPath) ? readJson<{ components: ElectricalKnowledge["components"] }>(compPath).components ?? [] : [],
    procedures: existsSync(procPath) ? readJson<{ procedures: ElectricalKnowledge["procedures"] }>(procPath).procedures ?? [] : [],
    reference: [],
  };
  if (existsSync(compPath)) {
    const raw = readJson<Partial<ElectricalKnowledge>>(compPath);
    electrical.version = raw.version ?? "0";
    electrical.reference = raw.reference ?? [];
  }
  if (existsSync(procPath)) {
    const raw = readJson<Partial<ElectricalKnowledge>>(procPath);
    if (raw.reference?.length) electrical.reference = [...electrical.reference, ...raw.reference];
  }

  if (problems.length && strict) throw new KnowledgeValidationError(problems);
  if (problems.length) console.warn(`[knowledge] ${problems.length} problem(s):\n- ${problems.join("\n- ")}`);

  return { manufacturers, refrigerants: { meta, tables }, diagnostics: { rules, charging }, electrical };
}
