/**
 * Chiller readings mode (pure): approach temperatures, chilled-water ΔT / tons, amps vs RLA, oil band, with
 * findings in the DxFinding shape so the UI and reports render them like DX results. Charge is never judged
 * from these numbers (chiller charge is by weight / manufacturer procedure); approaches are the health signal.
 *
 * Field guidance used (general practice, confirm against the manufacturer's log sheet):
 *  - Evaporator approach (leaving CHW − evaporator saturated temp): ≤ 5 °F healthy; higher = fouled tubes, low
 *    charge, low flow or oil in the evaporator.
 *  - Condenser approach: water-cooled (condensing sat − leaving condenser water) ≤ 5 °F, with a rise of ~3 °F
 *    over the commissioning baseline as the tube-cleaning trigger; air-cooled (condensing sat − entering air)
 *    ≤ 25 °F, higher = dirty coil / fan out / recirculation.
 *  - CHW ΔT: design is usually 10 °F; a small ΔT at high load = flow too high or low capacity.
 *  - Tons = 500 × gpm × ΔT ÷ 12000 (water, 8.33 lb/gal × 60 min).
 *  - Amps > 110 % RLA = overload territory; oil pressure 15–100 psig and oil temperature 90–170 °F as generic
 *    bands (manufacturer band wins).
 */
import type { ChillerCondenserType, ChillerDerived, ChillerMeasurements, ChillerResult, DxFinding, KnowledgeBase } from "../types.ts";
import { resolveRefrigerant, superheatSubcooling } from "./refrigerants.ts";

export const CHILLER_NUMERIC_KEYS = [
  "chwSupplyF",
  "chwReturnF",
  "chwFlowGpm",
  "evapSatF",
  "evapPressurePsig",
  "condSatF",
  "condPressurePsig",
  "condWaterInF",
  "condWaterOutF",
  "outdoorDbF",
  "oilPressurePsig",
  "oilTempF",
  "compressorAmps",
  "rla",
  "percentLoad",
  "elevationFt",
] as const;
export type ChillerNumericKey = (typeof CHILLER_NUMERIC_KEYS)[number];
export const CHILLER_CONDENSER_TYPES: readonly ChillerCondenserType[] = ["water_cooled", "air_cooled"];

export const CHILLER_LIMITS = {
  evapApproachWarnF: 5,
  evapApproachCriticalF: 10,
  condApproachWaterWarnF: 5,
  condApproachWaterCleanTriggerRiseF: 3,
  condApproachAirWarnF: 25,
  chwDeltaTLowF: 6,
  chwDeltaTHighF: 14,
  highLoadPercent: 70,
  ampsHighPercentRla: 110,
  ampsLowPercentRla: 40,
  oilPressureMinPsig: 15,
  oilPressureMaxPsig: 100,
  oilTempMinF: 90,
  oilTempMaxF: 170,
  chwSupplyFreezeWarnF: 38,
} as const;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Defensive copy: numeric fields coerced/dropped, enums checked. Never throws. */
export function sanitizeChiller(input: ChillerMeasurements | null | undefined): ChillerMeasurements {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of CHILLER_NUMERIC_KEYS) {
    const v = num(raw[k]);
    if (v !== undefined) out[k] = v;
  }
  if (typeof raw.refrigerant === "string" && raw.refrigerant.trim()) out.refrigerant = raw.refrigerant.trim();
  if (CHILLER_CONDENSER_TYPES.includes(raw.condenserType as ChillerCondenserType)) out.condenserType = raw.condenserType;
  if (typeof raw.circuit === "string" && raw.circuit.trim()) out.circuit = raw.circuit.trim();
  if (typeof raw.notes === "string" && raw.notes.trim()) out.notes = raw.notes.trim();
  return out as ChillerMeasurements;
}

function finding(ruleId: string, condition: string, severity: DxFinding["severity"], confidence: DxFinding["confidence"], explanation: string, nextChecks: string[], safety?: string[]): DxFinding {
  const f: DxFinding = { ruleId, condition, severity, confidence, explanation, nextChecks };
  if (safety) f.safety = safety;
  return f;
}

const SEVERITY_RANK: Record<DxFinding["severity"], number> = { critical: 0, warning: 1, advisory: 2, info: 3 };
const CONF_RANK: Record<DxFinding["confidence"], number> = { high: 0, medium: 1, low: 2 };

export function evaluateChiller(kb: KnowledgeBase, input: ChillerMeasurements): ChillerResult {
  const m = sanitizeChiller(input);
  const derived: ChillerDerived = {};
  const findings: DxFinding[] = [];
  const missing: string[] = [];
  const issues: string[] = [];

  // Condenser type: explicit, else inferred from which side was measured.
  let condenserType: ChillerResult["condenserType"] = m.condenserType ?? "unknown";
  if (condenserType === "unknown") {
    if (m.condWaterOutF !== undefined || m.condWaterInF !== undefined) condenserType = "water_cooled";
    else if (m.outdoorDbF !== undefined) condenserType = "air_cooled";
  }

  // Saturation temperatures: given directly, or from pressures through the PT tables (refrigerant required).
  let evapSat = m.evapSatF;
  let condSat = m.condSatF;
  const needPt = (evapSat === undefined && m.evapPressurePsig !== undefined) || (condSat === undefined && m.condPressurePsig !== undefined);
  if (needPt) {
    if (!m.refrigerant || !resolveRefrigerant(kb, m.refrigerant)) {
      const why = m.refrigerant ? `refrigerant "${m.refrigerant}" is not in the PT tables` : "refrigerant not given";
      issues.push(`pressures were given but ${why}: saturation temperatures (and approaches) could not be computed`);
      findings.push(finding("chiller_refrigerant_required", "Refrigerant needed to convert pressures", "advisory", "high", `Evaporator/condenser pressures convert to saturation temperatures through the PT table, and ${why}. Read the refrigerant off the chiller nameplate (R-134a, R-513A, R-123, R-1233zd(E), R-410A, R-32…) or enter the saturated temperatures the controller displays.`, ["Enter refrigerant, or evap_sat_f / cond_sat_f from the chiller display."]));
    } else {
      const r = superheatSubcooling(kb, { refrigerant: m.refrigerant, suctionPsig: m.evapPressurePsig, liquidPsig: m.condPressurePsig, elevationFt: m.elevationFt });
      if (evapSat === undefined && r.evapSatF !== undefined) evapSat = r.evapSatF;
      if (condSat === undefined && r.condSatF !== undefined) condSat = r.condSatF;
      if (r.patmPsia !== undefined) derived.patmPsia = r.patmPsia;
      if (r.extrapolated) issues.push("a saturation temperature came from the extrapolated PT tail (approximate)");
      for (const n of r.notes) if (/outside|above the|transcritical/.test(n)) issues.push(n);
    }
  }
  if (evapSat !== undefined) derived.evapSatF = round1(evapSat);
  if (condSat !== undefined) derived.condSatF = round1(condSat);

  // Chilled water side
  if (m.chwSupplyF !== undefined && m.chwReturnF !== undefined) {
    derived.chwDeltaTF = round1(m.chwReturnF - m.chwSupplyF);
    if (m.chwFlowGpm !== undefined && m.chwFlowGpm > 0) derived.tons = round1((500 * m.chwFlowGpm * derived.chwDeltaTF) / 12000);
    else missing.push("chwFlowGpm (tons = 500 × gpm × ΔT ÷ 12000)");
  } else {
    if (m.chwSupplyF === undefined) missing.push("chwSupplyF");
    if (m.chwReturnF === undefined) missing.push("chwReturnF");
  }
  if (m.chwSupplyF !== undefined && evapSat !== undefined) derived.evapApproachF = round1(m.chwSupplyF - evapSat);
  else if (evapSat === undefined && m.evapPressurePsig === undefined) missing.push("evapSatF or evapPressurePsig (evaporator approach)");

  // Condenser side
  if (condSat !== undefined) {
    if (condenserType === "water_cooled" && m.condWaterOutF !== undefined) derived.condApproachF = round1(condSat - m.condWaterOutF);
    else if (condenserType === "air_cooled" && m.outdoorDbF !== undefined) derived.condApproachF = round1(condSat - m.outdoorDbF);
    else missing.push(condenserType === "air_cooled" ? "outdoorDbF (condenser approach)" : "condWaterOutF (condenser approach)");
  } else if (m.condPressurePsig === undefined) missing.push("condSatF or condPressurePsig (condenser approach)");
  if (m.condWaterInF !== undefined && m.condWaterOutF !== undefined) derived.condWaterDeltaTF = round1(m.condWaterOutF - m.condWaterInF);

  // Load
  if (m.compressorAmps !== undefined && m.rla !== undefined && m.rla > 0) derived.ampsPercentRla = round1((100 * m.compressorAmps) / m.rla);
  else if (m.compressorAmps !== undefined && m.rla === undefined) missing.push("rla (amps as % RLA)");
  const load = m.percentLoad ?? derived.ampsPercentRla;

  // ---- findings ----
  const L = CHILLER_LIMITS;
  if (derived.evapApproachF !== undefined) {
    if (derived.evapApproachF > L.evapApproachCriticalF) {
      findings.push(finding("chiller_evap_approach_critical", `Evaporator approach ${derived.evapApproachF} °F (> ${L.evapApproachCriticalF})`, "critical", "high", `Leaving chilled water is ${derived.evapApproachF} °F above the evaporator saturated temperature; healthy machines run ≤ ${L.evapApproachWarnF} °F. At this level the evaporator is badly fouled, low on charge, short of flow, or oil-logged; low saturated temperature also risks a freeze trip.`, ["Compare the refrigerant charge level / sight glass with the commissioning log.", "Verify chilled-water flow (pressure drop across the evaporator vs design) and strainer.", "Check the oil return / level; an oil-logged evaporator raises approach.", "Plan tube cleaning / eddy-current inspection if flow and charge check out."], ["Watch the leaving-water low limit: do not lower setpoints to compensate."]));
    } else if (derived.evapApproachF > L.evapApproachWarnF) {
      findings.push(finding("chiller_evap_approach_high", `Evaporator approach ${derived.evapApproachF} °F (> ${L.evapApproachWarnF})`, "warning", "high", `Leaving chilled water sits ${derived.evapApproachF} °F above the evaporator saturated temperature (healthy ≤ ${L.evapApproachWarnF} °F): fouled evaporator tubes, low refrigerant charge, low chilled-water flow, or oil in the evaporator.`, ["Trend against earlier logs: a steady rise over months points to fouling; a step change points to charge or flow.", "Confirm chilled-water flow / ΔP vs design and clean the strainer.", "Check charge level and oil return per the manufacturer procedure (never by gauges alone)."]));
    } else if (derived.evapApproachF < 0) {
      findings.push(finding("chiller_evap_approach_negative", "Evaporator approach negative", "advisory", "medium", "Leaving water colder than the evaporator saturated temperature is not physical: a sensor, a wrong refrigerant, or a reading from the wrong circuit.", ["Verify the CHW supply sensor against a reference thermometer and the refrigerant on the nameplate."]));
    }
  }
  if (derived.condApproachF !== undefined) {
    if (condenserType === "water_cooled") {
      if (derived.condApproachF > L.condApproachWaterWarnF) {
        findings.push(finding("chiller_cond_approach_high_water", `Condenser approach ${derived.condApproachF} °F (> ${L.condApproachWaterWarnF}, water-cooled)`, derived.condApproachF > 2 * L.condApproachWaterWarnF ? "critical" : "warning", "high", `Condensing saturated temperature is ${derived.condApproachF} °F above the leaving condenser water (healthy ≤ ${L.condApproachWaterWarnF} °F): fouled or scaled condenser tubes, non-condensables (low-pressure machines: check purge run time), or low condenser water flow. A rise of about ${L.condApproachWaterCleanTriggerRiseF} °F over the commissioning baseline is the tube-cleaning trigger.`, ["Compare with the baseline approach in the chiller log.", "Check condenser water flow / ΔP and tower performance (leaving-water vs wet bulb).", "Check the purge counter on low-pressure machines; excessive pump-outs = air leak.", "Schedule tube brushing / cleaning."]));
      }
    } else if (condenserType === "air_cooled") {
      if (derived.condApproachF > L.condApproachAirWarnF) {
        findings.push(finding("chiller_cond_approach_high_air", `Condenser approach ${derived.condApproachF} °F (> ${L.condApproachAirWarnF}, air-cooled)`, derived.condApproachF > L.condApproachAirWarnF + 15 ? "critical" : "warning", "high", `Condensing saturated temperature is ${derived.condApproachF} °F above the entering air (typical ≤ ${L.condApproachAirWarnF} °F): dirty condenser coils, a condenser fan out or running backwards, recirculation of hot discharge air, or an overcharge / non-condensables.`, ["Inspect and clean the condenser coils (both faces; microchannel: low pressure rinse only).", "Verify every condenser fan runs the right way and the fan staging / VFD responds.", "Look for recirculation (walls, adjacent units, wind screens)."]));
      }
    }
  }
  if (derived.chwDeltaTF !== undefined) {
    // Zero / negative ΔT first: at high load it is a sensor or no-flow problem, not low-ΔT syndrome.
    if (derived.chwDeltaTF <= 0) {
      findings.push(finding("chiller_chw_dt_zero", "Chilled-water ΔT zero or negative", "advisory", "medium", "Return water is not warmer than supply: no load, no flow through the evaporator, or swapped sensors.", ["Confirm flow and sensor placement; confirm the compressor is actually loaded."]));
    } else if (derived.chwDeltaTF < L.chwDeltaTLowF && load !== undefined && load >= L.highLoadPercent) {
      findings.push(finding("chiller_low_chw_dt_high_load", `Low chilled-water ΔT (${derived.chwDeltaTF} °F) at ${Math.round(load)} % load`, "advisory", "medium", `Design ΔT is usually 10 °F. A ΔT this small while the compressor is loaded means chilled-water flow is above design (pumps, bypass, balancing) or the chiller is not delivering its capacity (approaches, charge). Low ΔT syndrome wastes pump energy and starves other loads.`, ["Measure flow / evaporator ΔP against design; check bypass valves and balancing.", "Compare the evaporator approach and amps with the log at the same load."]));
    } else if (derived.chwDeltaTF > L.chwDeltaTHighF) {
      findings.push(finding("chiller_high_chw_dt", `High chilled-water ΔT (${derived.chwDeltaTF} °F)`, "advisory", "medium", "A ΔT well above the usual 10 °F design means low chilled-water flow (strainer, pump, closed valves, VFD at minimum) or a very high load; the leaving-water low limit may trip.", ["Check the evaporator ΔP / flow switch and the pump; clean the strainer."]));
    }
  }
  if (m.chwSupplyF !== undefined && m.chwSupplyF < L.chwSupplyFreezeWarnF) {
    findings.push(finding("chiller_chw_supply_low", `Leaving chilled water ${m.chwSupplyF} °F (freeze risk)`, "warning", "high", `Leaving water below ${L.chwSupplyFreezeWarnF} °F without glycol is close to the evaporator freeze protection cutout; a low setpoint, low flow or a failing leaving-water sensor will freeze tubes.`, ["Verify the setpoint and the freeze-protection setting; confirm glycol concentration if the loop is glycol."], ["Do not lower the low-limit cutout to keep the machine running."]));
  }
  if (derived.ampsPercentRla !== undefined) {
    if (derived.ampsPercentRla > L.ampsHighPercentRla) {
      findings.push(finding("chiller_amps_high", `Compressor amps ${derived.ampsPercentRla} % of RLA (> ${L.ampsHighPercentRla})`, "warning", "high", "Current above RLA means high condensing pressure (dirty condenser / fouled tubes / poor tower), low or imbalanced line voltage, or a mechanical problem; the current limit or overload will trip.", ["Check condenser approach and the supply voltage / imbalance.", "Compare with the controller's current-limit setting and the log at the same load."]));
    } else if (derived.ampsPercentRla < L.ampsLowPercentRla && m.percentLoad !== undefined && m.percentLoad > 80) {
      findings.push(finding("chiller_amps_low_vs_load", `Amps ${derived.ampsPercentRla} % RLA while the controller reports ${m.percentLoad} % load`, "advisory", "medium", "The compressor is not drawing what the commanded load implies: unloaders / slide valve / inlet guide vanes not responding, low charge, or a CT scaling issue.", ["Verify the capacity control actuator position against the command; check charge level per the manufacturer."]));
    }
  }
  if (m.oilPressurePsig !== undefined) {
    if (m.oilPressurePsig < L.oilPressureMinPsig) {
      findings.push(finding("chiller_oil_pressure_low", `Oil pressure ${m.oilPressurePsig} psig (< ${L.oilPressureMinPsig})`, "warning", "medium", "Low oil pressure (generic band; the manufacturer's net-oil-pressure band wins): low oil level, refrigerant-diluted oil, a failing oil pump or a plugged filter. Oil safeties trip before damage only if they work.", ["Check oil level in the sight glass with the compressor running and the oil heater operation.", "Check the oil filter ΔP and the oil-pressure safety setting against the manual."], ["Never bypass an oil safety."]));
    } else if (m.oilPressurePsig > L.oilPressureMaxPsig) {
      findings.push(finding("chiller_oil_pressure_high", `Oil pressure ${m.oilPressurePsig} psig (> ${L.oilPressureMaxPsig})`, "advisory", "low", "Oil pressure above the generic band: verify it is the net (differential) figure and compare with the manufacturer's band; a plugged oil return or regulator can raise it.", ["Confirm which pressure the gauge/controller reports (net vs absolute) and the manufacturer's band."]));
    }
  }
  if (m.oilTempF !== undefined) {
    if (m.oilTempF < L.oilTempMinF) {
      findings.push(finding("chiller_oil_temp_low", `Oil temperature ${m.oilTempF} °F (< ${L.oilTempMinF})`, "advisory", "medium", "Cold oil holds dissolved refrigerant and foams on start: oil heater off or failed, or the machine was just started.", ["Verify the oil heater is energized when the compressor is off; allow the warm-up time the manual specifies."]));
    } else if (m.oilTempF > L.oilTempMaxF) {
      findings.push(finding("chiller_oil_temp_high", `Oil temperature ${m.oilTempF} °F (> ${L.oilTempMaxF})`, "warning", "medium", "Hot oil loses viscosity and bearings suffer: oil cooler fouled or its water/refrigerant supply restricted, high discharge temperature, or low oil level.", ["Check the oil cooler and its control valve; compare discharge temperature with the log."]));
    }
  }
  findings.push(finding("chiller_scope", "Chiller: charge by weight / manufacturer procedure, approaches tell the story", "info", "high", "These readings judge heat-exchanger health and load, not charge. Adjust charge only per the manufacturer's charging procedure (sight glass / level at specified conditions), and log any add in the refrigerant log (leak rate).", ["Record the log line (CHW/CW temps, approaches, amps, oil) for trend comparison next visit."]));

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || CONF_RANK[a.confidence] - CONF_RANK[b.confidence]);

  // Summary
  const bits: string[] = [];
  if (derived.chwDeltaTF !== undefined) bits.push(`CHW ${m.chwReturnF}→${m.chwSupplyF} °F (ΔT ${derived.chwDeltaTF}${derived.tons !== undefined ? `, ${derived.tons} tons` : ""})`);
  if (derived.evapApproachF !== undefined) bits.push(`evap approach ${derived.evapApproachF} °F`);
  if (derived.condApproachF !== undefined) bits.push(`cond approach ${derived.condApproachF} °F (${condenserType === "water_cooled" ? "water" : "air"}-cooled)`);
  if (derived.ampsPercentRla !== undefined) bits.push(`${derived.ampsPercentRla} % RLA`);
  const top = findings.find((f) => f.severity !== "info");
  const summary = `${bits.length ? bits.join("; ") + ". " : ""}${top ? `${top.severity[0]!.toUpperCase()}${top.severity.slice(1)}: ${top.condition}.` : derived.evapApproachF !== undefined || derived.condApproachF !== undefined ? "Approaches within the healthy band." : "Not enough readings for approaches; enter CHW supply plus evaporator saturated temperature/pressure (with refrigerant)."}`;

  return { measurements: m, condenserType, derived, validity: { ok: issues.length === 0, issues }, findings, missing, summary };
}
