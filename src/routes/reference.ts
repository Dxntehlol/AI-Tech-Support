import { Router } from "express";
import type { AppDeps } from "../app.ts";
import { deriveMetrics, diagnose } from "../knowledge/diagnostics.ts";
import { evaluateChiller } from "../knowledge/chiller.ts";
import { CALC_KINDS, calcElectrical, lookupElectrical, type ElectricalLookupKind } from "../knowledge/electrical.ts";
import { APPLIANCE_TYPES } from "../knowledge/refrigerantCompliance.ts";
import { lookupFaultCode } from "../knowledge/faults.ts";
import { complianceRefrigerantLookup, getTable, ptLookup, resolveRefrigerant, superheatSubcooling } from "../knowledge/refrigerants.ts";
import type { ElectricalCalcRequest, RefrigerantMeta, RefrigerantTable } from "../types.ts";
import { badRequest, body, camelize, notFound, optEnum, optNumber, optString, optionalId, parseChillerMeasurements, parseMeasurements, queryNumber, queryString, requireNumber, type Body } from "./util.ts";
import { storeChillerReading, storeReading } from "../readingsStore.ts";

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
    case "leak_rate": {
      const out: ElectricalCalcRequest = { kind, addedLbs: req("addedLbs"), fullChargeLbs: req("fullChargeLbs"), daysSinceLastAdd: req("daysSinceLastAdd") };
      const applianceType = optEnum(v.applianceType, "appliance_type", APPLIANCE_TYPES);
      if (applianceType) out.applianceType = applianceType;
      if (typeof v.refrigerant === "string" && v.refrigerant.trim() !== "") out.refrigerant = v.refrigerant.trim().slice(0, 40);
      return out;
    }
    case "gas_meter_clock": {
      const out: ElectricalCalcRequest = { kind, dialCuft: req("dialCuft"), secondsPerRev: req("secondsPerRev") };
      const hv = opt("heatingValueBtuPerCuft");
      if (hv !== undefined) out.heatingValueBtuPerCuft = hv;
      const revs = opt("revolutions");
      if (revs !== undefined) out.revolutions = revs;
      const np = opt("nameplateInputBtuh");
      if (np !== undefined) out.nameplateInputBtuh = np;
      return out;
    }
    case "combustion_co": {
      const out: ElectricalCalcRequest = { kind, coPpm: req("coPpm"), o2Pct: req("o2Pct") };
      const amb = opt("ambientCoPpm");
      if (amb !== undefined) out.ambientCoPpm = amb;
      return out;
    }
    case "sensible_cfm": {
      const out: ElectricalCalcRequest = { kind, btuh: req("btuh"), deltaTF: req("deltaTF") };
      const tons = opt("tons");
      if (tons !== undefined) out.tons = tons;
      return out;
    }
    case "static_pressure": {
      const out: ElectricalCalcRequest = { kind, supplyInWc: req("supplyInWc"), returnInWc: req("returnInWc") };
      const rated = opt("ratedMaxInWc");
      if (rated !== undefined) out.ratedMaxInWc = rated;
      const blowerType = optEnum(v.blowerType, "blower_type", ["psc", "ecm"] as const);
      if (blowerType) out.blowerType = blowerType;
      return out;
    }
    case "fan_laws": {
      const out: ElectricalCalcRequest = { kind, rpm1: req("rpm1"), rpm2: req("rpm2") };
      for (const f of ["cfm1", "sp1", "bhp1"] as const) {
        const x = opt(f);
        if (x !== undefined) out[f] = x;
      }
      return out;
    }
    case "belt_drive": {
      const out: ElectricalCalcRequest = { kind, motorRpm: req("motorRpm"), motorSheaveIn: req("motorSheaveIn"), fanSheaveIn: req("fanSheaveIn") };
      const c = opt("centerDistanceIn");
      if (c !== undefined) out.centerDistanceIn = c;
      return out;
    }
    case "voltage_drop": {
      const out: ElectricalCalcRequest = { kind, volts: req("volts"), amps: req("amps"), oneWayFt: req("oneWayFt") };
      const awg = optString(v.awg, "awg", 20)?.trim();
      if (awg) out.awg = awg;
      const cm = opt("circularMils");
      if (cm !== undefined) out.circularMils = cm;
      const material = optEnum(typeof v.material === "string" ? v.material.toLowerCase() : v.material, "material", ["cu", "al"] as const);
      if (material) out.material = material;
      if (v.phase !== undefined && v.phase !== null && v.phase !== "") out.phase = phaseOf(v.phase);
      if (!out.awg && out.circularMils === undefined) throw badRequest("voltage_drop needs awg (14…4/0, 250…500 kcmil) or circular_mils.");
      return out;
    }
    case "motor_fla":
      return { kind, hp: req("hp"), volts: req("volts"), phase: phaseOf(v.phase) };
    case "capacitor_replacement":
      return { kind, ratedUf: req("ratedUf"), ratedV: req("ratedV"), replacementUf: req("replacementUf"), replacementV: req("replacementV") };
    case "motor_replacement": {
      const out: ElectricalCalcRequest = { kind };
      for (const f of ["hp", "rpm", "volts", "shaftDiaIn"] as const) {
        const x = opt(f);
        if (x !== undefined) out[f] = x;
      }
      if (v.phase !== undefined && v.phase !== null && v.phase !== "") out.phase = phaseOf(v.phase);
      const frame = optString(v.frame, "frame", 40)?.trim();
      if (frame) out.frame = frame;
      const enclosure = optString(v.enclosure, "enclosure", 40)?.trim();
      if (enclosure) out.enclosure = enclosure;
      const rot = optEnum(typeof v.rotationFromShaftEnd === "string" ? v.rotationFromShaftEnd.toLowerCase() : v.rotationFromShaftEnd, "rotation_from_shaft_end", ["cw", "ccw"] as const);
      if (rot) out.rotationFromShaftEnd = rot;
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

  // POST /api/calc/diagnose {DxMeasurements-like, unit_id?, conversation_id?, note?}
  // With unit_id the diagnosis is also stored as a readings row on that unit (response gains readingId).
  r.post("/diagnose", (req, res) => {
    const b = body(req);
    const unitId = optionalId(b.unit_id, "unit_id");
    const conversationId = optionalId(b.conversation_id, "conversation_id");
    const note = optString(b.note, "note", 2000)?.trim() || null;
    const { unit_id: _u, conversation_id: _c, note: _n, ...rest } = b;
    const m = parseMeasurements(rest);
    if (!resolveRefrigerant(kb, m.refrigerant) && !getTable(kb, m.refrigerant)) throw badRequest(`Unknown refrigerant "${m.refrigerant}".`);
    if (unitId && !deps.repos.units.get(unitId)) throw notFound("Unit not found.");
    if (conversationId && !deps.repos.conversations.get(conversationId)) throw notFound("Conversation not found.");
    const result = diagnose(kb, m);
    if (!unitId) {
      res.json(result);
      return;
    }
    const row = storeReading(deps.repos, { unitId, conversationId, result, note, source: "sheet" });
    res.json({ ...result, readingId: row.id });
  });

  // POST /api/calc/electrical {ElectricalCalcRequest}
  r.post("/electrical", (req, res) => {
    res.json(calcElectrical(parseElectricalCalc(body(req)), { refrigerantLookup: complianceRefrigerantLookup(kb) }));
  });

  // POST /api/calc/chiller {ChillerMeasurements-like, unit_id?, conversation_id?, note?}  ChillerResult (+ readingId with unit_id)
  r.post("/chiller", (req, res) => {
    const b = body(req);
    const unitId = optionalId(b.unit_id, "unit_id");
    const conversationId = optionalId(b.conversation_id, "conversation_id");
    const note = optString(b.note, "note", 2000)?.trim() || null;
    const { unit_id: _u, conversation_id: _c, note: _n, ...rest } = b;
    const m = parseChillerMeasurements(rest);
    const hasAny = Object.keys(m).some((k) => k !== "refrigerant" && k !== "condenserType" && k !== "circuit" && k !== "notes");
    if (!hasAny) throw badRequest("Enter at least one chiller reading (chw_supply_f, chw_return_f, evap_sat_f / evap_pressure_psig, cond_sat_f / cond_pressure_psig, …).");
    if (m.refrigerant && !resolveRefrigerant(kb, m.refrigerant) && !getTable(kb, m.refrigerant)) throw badRequest(`Unknown refrigerant "${m.refrigerant}".`);
    const unit = unitId ? deps.repos.units.get(unitId) : undefined;
    if (unitId && !unit) throw notFound("Unit not found.");
    if (conversationId && !deps.repos.conversations.get(conversationId)) throw notFound("Conversation not found.");
    if (unit && !m.refrigerant && unit.refrigerant) m.refrigerant = unit.refrigerant;
    const result = evaluateChiller(kb, m);
    if (!unitId) {
      res.json(result);
      return;
    }
    const row = storeChillerReading(deps.repos, { unitId, conversationId, result, note, source: "sheet" });
    res.json({ ...result, readingId: row.id });
  });

  return r;
}
