import { Router } from "express";
import type { AppDeps } from "../app.ts";
import { deriveMetrics, diagnose } from "../knowledge/diagnostics.ts";
import { calcElectrical, lookupElectrical, type ElectricalLookupKind } from "../knowledge/electrical.ts";
import { lookupFaultCode } from "../knowledge/faults.ts";
import { getTable, ptLookup, resolveRefrigerant, superheatSubcooling } from "../knowledge/refrigerants.ts";
import type { ElectricalCalcRequest, RefrigerantMeta, RefrigerantTable } from "../types.ts";
import { badRequest, body, camelize, notFound, optEnum, optNumber, parseMeasurements, queryNumber, queryString, requireNumber, type Body } from "./util.ts";

// ---------------------------------------------------------------------------
// Refrigerants
// ---------------------------------------------------------------------------

function tableRange(t: RefrigerantTable | undefined): { minTempF: number; maxTempF: number } | undefined {
  if (!t || t.tempF.length === 0) return undefined;
  return { minTempF: t.tempF[0]!, maxTempF: t.tempF[t.tempF.length - 1]! };
}

function refrigerantSummary(meta: RefrigerantMeta, table: RefrigerantTable | undefined): Record<string, unknown> {
  return {
    id: meta.id,
    aliases: meta.aliases,
    type: meta.type,
    blendType: meta.blendType,
    composition: meta.composition,
    safetyClass: meta.safetyClass,
    gwp: meta.gwp,
    glideF: meta.glideF,
    glideAtCondF: meta.glideAtCondF,
    lubricant: meta.lubricant,
    applications: meta.applications,
    replacementFor: meta.replacementFor,
    serviceNotes: meta.serviceNotes,
    criticalTempF: meta.criticalTempF,
    criticalPsig: meta.criticalPsig,
    tableSource: meta.tableSource,
    tableVerified: meta.tableVerified,
    extrapolatedAboveF: meta.extrapolatedAboveF,
    hasTable: table !== undefined,
    tableRange: tableRange(table),
  };
}

export function referenceRouter(deps: AppDeps): Router {
  const r = Router();
  const { kb } = deps;

  // GET /api/reference/refrigerants
  r.get("/refrigerants", (_req, res) => {
    const seen = new Set<string>();
    const refrigerants: Record<string, unknown>[] = [];
    for (const meta of kb.refrigerants.meta) {
      seen.add(meta.id);
      refrigerants.push(refrigerantSummary(meta, kb.refrigerants.tables.get(meta.id)));
    }
    for (const [id, table] of kb.refrigerants.tables) {
      if (seen.has(id)) continue;
      refrigerants.push({ id, aliases: [], type: undefined, safetyClass: undefined, applications: [], serviceNotes: ["No metadata entry for this table — safety class unknown."], hasTable: true, tableRange: tableRange(table), noMeta: true });
    }
    res.json({ refrigerants });
  });

  // GET /api/reference/pt?refrigerant=&psig=|temp_f=&elevation_ft=
  r.get("/pt", (req, res) => {
    const refrigerant = queryString(req, "refrigerant");
    if (!refrigerant) throw badRequest("refrigerant is required.");
    const psig = queryNumber(req, "psig");
    const tempF = queryNumber(req, "temp_f") ?? queryNumber(req, "tempF");
    if (psig === undefined && tempF === undefined) throw badRequest("Provide psig or temp_f.");
    const elevationFt = queryNumber(req, "elevation_ft") ?? queryNumber(req, "elevationFt");
    if (elevationFt !== undefined && (elevationFt < -1500 || elevationFt > 30000)) throw badRequest("elevation_ft must be between -1500 and 30000.");
    if (!resolveRefrigerant(kb, refrigerant) && !getTable(kb, refrigerant)) {
      throw notFound(`Unknown refrigerant "${refrigerant}". Known: ${[...kb.refrigerants.tables.keys()].join(", ")}.`);
    }
    const query: { psig?: number; tempF?: number; elevationFt?: number } = {};
    if (psig !== undefined) query.psig = psig;
    else query.tempF = tempF;
    if (elevationFt !== undefined) query.elevationFt = elevationFt;
    res.json(ptLookup(kb, refrigerant, query));
  });

  // GET /api/reference/electrical?component=|symptom=|q=&kind=
  r.get("/electrical", (req, res) => {
    const component = queryString(req, "component");
    const symptom = queryString(req, "symptom");
    const q = queryString(req, "q");
    const kindParam = optEnum(queryString(req, "kind"), "kind", ["component", "procedure", "reference", "any"]);
    let query: string;
    let kind: ElectricalLookupKind;
    if (component) {
      query = component;
      kind = kindParam ?? "component";
    } else if (symptom) {
      query = symptom;
      kind = kindParam ?? "procedure";
    } else if (q) {
      query = q;
      kind = kindParam ?? "any";
    } else throw badRequest("Provide component, symptom or q.");
    const result = lookupElectrical(kb, query, kind);
    res.json({ query, kind, ...result });
  });

  // GET /api/reference/fault?code=&manufacturer=&platform=
  r.get("/fault", (req, res) => {
    const code = queryString(req, "code");
    if (!code) throw badRequest("code is required.");
    const manufacturer = queryString(req, "manufacturer");
    const platform = queryString(req, "platform");
    const hits = lookupFaultCode(kb, code, { manufacturer, platform }).map((h) => ({
      manufacturerId: h.manufacturerId,
      manufacturer: h.manufacturer,
      platform: {
        id: h.platform.id,
        name: h.platform.name,
        coverage: h.platform.coverage,
        confidence: h.platform.confidence,
        diagnosticTips: h.platform.diagnosticTips,
        sourceDocs: h.platform.sourceDocs,
      },
      fault: h.fault,
      score: h.score,
    }));
    res.json({ code, manufacturer: manufacturer ?? null, platform: platform ?? null, hits });
  });

  return r;
}

// ---------------------------------------------------------------------------
// Calculators
// ---------------------------------------------------------------------------

const CALC_KINDS = ["voltage_imbalance", "current_imbalance", "capacitor_under_load", "amps_vs_rla", "temp_rise_cfm", "ohms_law", "electric_heat_kw", "psychrometrics", "winding_check", "megohm"] as const;

function phaseOf(v: unknown): 1 | 3 {
  const n = optNumber(v, "phase");
  if (n === undefined) throw badRequest("phase is required (1 or 3).");
  if (n !== 1 && n !== 3) throw badRequest("phase must be 1 or 3.");
  return n;
}

/** Validate an ElectricalCalcRequest body (camelCase or snake_case keys). */
export function parseElectricalCalc(b: Body): ElectricalCalcRequest {
  const v: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(b)) v[camelize(k)] = val;
  const kind = optEnum(v.kind, "kind", CALC_KINDS);
  if (!kind) throw badRequest(`kind is required: one of ${CALC_KINDS.join(", ")}.`);
  const req = (name: string): number => requireNumber(v[name], name);
  const opt = (name: string): number | undefined => optNumber(v[name], name);
  switch (kind) {
    case "voltage_imbalance":
      return { kind, vab: req("vab"), vbc: req("vbc"), vca: req("vca") };
    case "current_imbalance":
      return { kind, ia: req("ia"), ib: req("ib"), ic: req("ic") };
    case "capacitor_under_load": {
      const out: ElectricalCalcRequest = { kind, amps: req("amps"), volts: req("volts") };
      const ratedUf = opt("ratedUf");
      if (ratedUf !== undefined) out.ratedUf = ratedUf;
      return out;
    }
    case "amps_vs_rla":
      return { kind, amps: req("amps"), rla: req("rla") };
    case "temp_rise_cfm":
      return { kind, inputBtuh: req("inputBtuh"), efficiencyPercent: req("efficiencyPercent"), riseF: req("riseF") };
    case "ohms_law": {
      const out: Record<string, unknown> = { kind };
      let n = 0;
      for (const f of ["volts", "amps", "ohms", "watts"] as const) {
        const x = opt(f);
        if (x !== undefined) {
          out[f] = x;
          n += 1;
        }
      }
      if (n < 2) throw badRequest("ohms_law needs any two of volts, amps, ohms, watts.");
      return out as ElectricalCalcRequest;
    }
    case "electric_heat_kw": {
      const out: ElectricalCalcRequest = { kind, volts: req("volts"), amps: req("amps"), phase: phaseOf(v.phase) };
      const nameplateKw = opt("nameplateKw");
      if (nameplateKw !== undefined) out.nameplateKw = nameplateKw;
      return out;
    }
    case "psychrometrics": {
      const out: ElectricalCalcRequest = { kind, dbF: req("dbF"), wbF: req("wbF") };
      const elevationFt = opt("elevationFt");
      if (elevationFt !== undefined) out.elevationFt = elevationFt;
      return out;
    }
    case "winding_check":
      return { kind, phase: phaseOf(v.phase), r1: req("r1"), r2: req("r2"), r3: req("r3") };
    case "megohm": {
      const out: ElectricalCalcRequest = { kind, megohms: req("megohms") };
      const testVolts = opt("testVolts");
      if (testVolts !== undefined) out.testVolts = testVolts;
      return out;
    }
    default:
      throw badRequest("Unknown calculator kind.");
  }
}

export function calcRouter(deps: AppDeps): Router {
  const r = Router();
  const { kb } = deps;

  // POST /api/calc/superheat-subcooling {DxMeasurements-like; snake_case or camelCase}
  r.post("/superheat-subcooling", (req, res) => {
    const m = parseMeasurements(body(req));
    if (!resolveRefrigerant(kb, m.refrigerant) && !getTable(kb, m.refrigerant)) throw badRequest(`Unknown refrigerant "${m.refrigerant}".`);
    if (m.suctionPsig === undefined && m.liquidPsig === undefined && m.dischargePsig === undefined) {
      throw badRequest("Provide suction_psig (with suction_line_temp_f) and/or liquid_psig (with liquid_line_temp_f).");
    }
    const shsc = superheatSubcooling(kb, m);
    const derived = deriveMetrics(kb, m);
    res.json({
      ...shsc,
      targetSuperheatF: derived.targetSuperheatF,
      targetSubcoolingF: derived.targetSubcoolingF,
      superheatDelta: shsc.superheatF !== undefined && derived.targetSuperheatF !== undefined ? Math.round((shsc.superheatF - derived.targetSuperheatF) * 10) / 10 : undefined,
      subcoolingDelta: shsc.subcoolingF !== undefined && derived.targetSubcoolingF !== undefined ? Math.round((shsc.subcoolingF - derived.targetSubcoolingF) * 10) / 10 : undefined,
      derived,
      inputs: m,
    });
  });

  // POST /api/calc/diagnose {DxMeasurements-like}
  r.post("/diagnose", (req, res) => {
    const m = parseMeasurements(body(req));
    if (!resolveRefrigerant(kb, m.refrigerant) && !getTable(kb, m.refrigerant)) throw badRequest(`Unknown refrigerant "${m.refrigerant}".`);
    res.json(diagnose(kb, m));
  });

  // POST /api/calc/electrical {ElectricalCalcRequest}
  r.post("/electrical", (req, res) => {
    res.json(calcElectrical(parseElectricalCalc(body(req))));
  });

  return r;
}
