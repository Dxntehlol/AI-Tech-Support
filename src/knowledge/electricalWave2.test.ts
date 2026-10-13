/* Wave-2 calculators: every kind with hand-checked numbers (formula cited in the test name). */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AWG_CMIL, CALC_KINDS, NEC_FLA_1PH, NEC_FLA_3PH, calcElectrical, normalizeAwg } from "./electrical.ts";

function near(actual: number | undefined, expected: number, tol: number, label: string): void {
  assert.ok(actual !== undefined && Number.isFinite(actual), `${label}: got ${actual}`);
  assert.ok(Math.abs((actual as number) - expected) <= tol, `${label}: ${actual} not within ±${tol} of ${expected}`);
}

describe("wave-2 calculators", () => {
  test("CALC_KINDS lists every kind once, originals first", () => {
    assert.equal(new Set(CALC_KINDS).size, CALC_KINDS.length);
    assert.equal(CALC_KINDS[0], "voltage_imbalance");
    for (const k of ["leak_rate", "gas_meter_clock", "combustion_co", "sensible_cfm", "static_pressure", "fan_laws", "belt_drive", "voltage_drop", "motor_fla", "capacitor_replacement", "motor_replacement"]) assert.ok((CALC_KINDS as readonly string[]).includes(k), k);
  });

  test("leak_rate: (25 / 400) × (365 / 60) × 100 = 38.02 % (EPA example), threshold by appliance type", () => {
    const r = calcElectrical({ kind: "leak_rate", addedLbs: 25, fullChargeLbs: 400, daysSinceLastAdd: 60, applianceType: "commercial_refrigeration" });
    assert.equal(r.values.leakRatePct, 38.02);
    assert.equal(r.values.thresholdPct, 20);
    assert.equal(r.values.exceeded, 1);
    assert.equal(r.values.applies, 1);
    assert.match(r.interpretation[0]!, /\(25 ÷ 400\) × \(365 ÷ 60\) × 100 = 38.02 %/);
    assert.match(r.interpretation[1]!, /EXCEEDS the 20 %/);
    const ok = calcElectrical({ kind: "leak_rate", addedLbs: 1, fullChargeLbs: 40, daysSinceLastAdd: 365 });
    assert.equal(ok.values.leakRatePct, 2.5);
    assert.equal(ok.values.thresholdPct, 10);
    assert.equal(ok.values.exceeded, 0);
    const small = calcElectrical({ kind: "leak_rate", addedLbs: 2, fullChargeLbs: 10, daysSinceLastAdd: 0 });
    assert.equal(small.values.daysUsed, 1, "days < 1 → 1");
    assert.equal(small.values.applies, 0);
    const bad = calcElectrical({ kind: "leak_rate", addedLbs: 0, fullChargeLbs: 10, daysSinceLastAdd: 5 });
    assert.ok(bad.warnings.length > 0);
    assert.deepEqual(bad.values, {});
  });

  test("leak_rate: days beyond 365 count as 365 (40 CFR 82.152 / 84.102 annualizing method): 100 lb into 400 lb after 730 days = 25 %", () => {
    const r = calcElectrical({ kind: "leak_rate", addedLbs: 100, fullChargeLbs: 400, daysSinceLastAdd: 730, applianceType: "commercial_refrigeration" });
    assert.equal(r.values.leakRatePct, 25);
    assert.equal(r.values.daysUsed, 365);
    assert.equal(r.values.exceeded, 1);
    assert.match(r.interpretation[0]!, /\(100 ÷ 400\) × \(365 ÷ 365\) × 100 = 25 %.*shorter of the days since the last add or 365/);
  });

  test("leak_rate applicability by refrigerant with an injected lookup: ODS from 50 lb, GWP ≤ 53 not covered", () => {
    const lookup = (n: string) => (n === "R-22" ? { id: "R-22", gwp: 1810 } : n === "R-290" ? { id: "R-290", gwp: 3 } : undefined);
    const r22 = calcElectrical({ kind: "leak_rate", addedLbs: 5, fullChargeLbs: 40, daysSinceLastAdd: 90, refrigerant: "R-22" }, { refrigerantLookup: lookup });
    assert.equal(r22.values.applies, 0);
    assert.match(r22.interpretation[2]!, /R-22 is an ODS: full charge 40 lb is below the 50 lb applicability \(40 CFR 82.157\)/);
    const r290 = calcElectrical({ kind: "leak_rate", addedLbs: 5, fullChargeLbs: 40, daysSinceLastAdd: 90, refrigerant: "R-290" }, { refrigerantLookup: lookup });
    assert.equal(r290.values.applies, 0);
    assert.match(r290.interpretation[2]!, /R-290 \(GWP 3\) is neither an HFC with GWP > 53 nor an ODS/);
  });

  test("gas_meter_clock: CFH = 3600 × dial × rev / s; BTU/h = CFH × HV; ±5 % of nameplate", () => {
    // 1 ft³ dial, 36 s per rev → 100 CFH → 100,000 BTU/h at 1000 BTU/ft³
    const r = calcElectrical({ kind: "gas_meter_clock", dialCuft: 1, secondsPerRev: 36, nameplateInputBtuh: 100000 });
    assert.equal(r.values.cfh, 100);
    assert.equal(r.values.btuh, 100000);
    assert.equal(r.values.percentOfNameplate, 100);
    assert.equal(r.values.pass, 1);
    // 1/2 ft³ dial, 2 revolutions in 45 s, HV 1030 → 80 CFH → 82,400 BTU/h; vs 100,000 nameplate = 82.4 % under-fired
    const u = calcElectrical({ kind: "gas_meter_clock", dialCuft: 0.5, secondsPerRev: 45, revolutions: 2, heatingValueBtuPerCuft: 1030, nameplateInputBtuh: 100000 });
    assert.equal(u.values.cfh, 80);
    assert.equal(u.values.btuh, 82400);
    assert.equal(u.values.pass, 0);
    assert.ok(u.interpretation.some((s) => /UNDER-FIRED/.test(s)));
    const o = calcElectrical({ kind: "gas_meter_clock", dialCuft: 1, secondsPerRev: 30, nameplateInputBtuh: 100000 });
    assert.equal(o.values.btuh, 120000);
    assert.ok(o.interpretation.some((s) => /OVER-FIRED/.test(s)));
  });

  test("combustion_co: CO air-free = CO × 20.9 / (20.9 − O2); flags at 100 (NCI) and 400 (ANSI Z21.47); ambient > 20 ppm stop work", () => {
    // 50 ppm at 9 % O2 → 50 × 20.9 / 11.9 = 87.8 → 88
    const r = calcElectrical({ kind: "combustion_co", coPpm: 50, o2Pct: 9 });
    assert.equal(r.values.coAirFreePpm, 88);
    assert.equal(r.values.flag, 0);
    near(r.values.excessAirPct, 75.6, 0.1, "excess air");
    const action = calcElectrical({ kind: "combustion_co", coPpm: 80, o2Pct: 8 }); // 80 × 20.9 / 12.9 = 129.6
    assert.equal(action.values.coAirFreePpm, 130);
    assert.equal(action.values.flag, 1);
    assert.ok(action.interpretation.some((s) => /100 ppm action level/.test(s)));
    const stop = calcElectrical({ kind: "combustion_co", coPpm: 300, o2Pct: 8, ambientCoPpm: 25 }); // 486
    assert.equal(stop.values.coAirFreePpm, 486);
    assert.equal(stop.values.flag, 2);
    assert.equal(stop.values.stopWork, 1);
    assert.ok(stop.interpretation.some((s) => /STOP WORK/.test(s)));
    const amb = calcElectrical({ kind: "combustion_co", coPpm: 10, o2Pct: 5, ambientCoPpm: 12 });
    assert.equal(amb.values.stopWork, 0);
    assert.ok(amb.interpretation.some((s) => /9 ppm/.test(s)));
    const noComb = calcElectrical({ kind: "combustion_co", coPpm: 10, o2Pct: 20.9 });
    assert.equal(noComb.values.coAirFreePpm, undefined);
    assert.ok(noComb.warnings.some((w) => /20.9/.test(w)));
  });

  test("sensible_cfm: CFM = BTU/h / (1.08 × ΔT); CFM/ton band 350–450", () => {
    // 54,000 BTU/h at 50 °F rise → 1000 CFM
    const r = calcElectrical({ kind: "sensible_cfm", btuh: 54000, deltaTF: 50, tons: 2.5 });
    assert.equal(r.values.cfm, 1000);
    assert.equal(r.values.cfmPerTon, 400);
    assert.ok(r.interpretation.some((s) => /within the 350–450/.test(s)));
    const low = calcElectrical({ kind: "sensible_cfm", btuh: 54000, deltaTF: 50, tons: 4 });
    assert.equal(low.values.cfmPerTon, 250);
    assert.ok(low.interpretation.some((s) => /below the 350–450/.test(s)));
  });

  test("static_pressure: TESP = |supply| + |return|; PSC max 0.5 / ECM 0.8 unless rated given", () => {
    const r = calcElectrical({ kind: "static_pressure", supplyInWc: 0.35, returnInWc: -0.3 });
    assert.equal(r.values.tespInWc, 0.65);
    assert.equal(r.values.ratedMaxInWc, 0.5);
    assert.equal(r.values.overMax, 1);
    assert.equal(r.values.percentOfRated, 130);
    const ecm = calcElectrical({ kind: "static_pressure", supplyInWc: 0.35, returnInWc: 0.3, blowerType: "ecm" });
    assert.equal(ecm.values.ratedMaxInWc, 0.8);
    assert.equal(ecm.values.overMax, 0);
    const rated = calcElectrical({ kind: "static_pressure", supplyInWc: 0.5, returnInWc: 0.5, ratedMaxInWc: 1.2, blowerType: "psc" });
    assert.equal(rated.values.ratedMaxInWc, 1.2);
    assert.equal(rated.values.percentOfRated, 83);
  });

  test("fan_laws: CFM ∝ RPM, SP ∝ RPM², BHP ∝ RPM³", () => {
    const r = calcElectrical({ kind: "fan_laws", rpm1: 1000, rpm2: 1100, cfm1: 5000, sp1: 1.0, bhp1: 2.0 });
    assert.equal(r.values.cfm2, 5500);
    assert.equal(r.values.sp2, 1.21);
    assert.equal(r.values.bhp2, 2.662);
    assert.ok(r.interpretation.some((s) => /33 % more power/.test(s)));
    const only = calcElectrical({ kind: "fan_laws", rpm1: 1000, rpm2: 500 });
    assert.equal(only.values.speedRatio, 0.5);
    assert.equal(only.values.cfm2, undefined);
  });

  test("belt_drive: fan rpm = motor rpm × D_motor / D_fan; L = 2C + 1.57(D + d) + (D − d)²/4C; deflection = span/64", () => {
    // 1750 × 4 / 8 = 875 rpm; C = 20: L = 40 + 1.57 × 12 + 16 / 80 = 40 + 18.84 + 0.2 = 59.04
    const r = calcElectrical({ kind: "belt_drive", motorRpm: 1750, motorSheaveIn: 4, fanSheaveIn: 8, centerDistanceIn: 20 });
    assert.equal(r.values.fanRpm, 875);
    assert.equal(r.values.beltLengthIn, 59.04);
    // span = sqrt(20² − 2²) = 19.9; deflection 19.9 / 64 = 0.311
    near(r.values.spanIn, 19.9, 0.01, "span");
    near(r.values.deflectionIn, 0.311, 0.001, "deflection");
    const noC = calcElectrical({ kind: "belt_drive", motorRpm: 1750, motorSheaveIn: 3.5, fanSheaveIn: 7 });
    assert.equal(noC.values.fanRpm, 875);
    assert.equal(noC.values.beltLengthIn, undefined);
  });

  test("voltage_drop: VD = 2 K I L / CM (1-ph) or 1.732 K I L / CM (3-ph); K 12.9 Cu / 21.2 Al; 3 % / 5 % flags", () => {
    // 10 AWG Cu, 20 A, 100 ft one way, 240 V: 2 × 12.9 × 20 × 100 / 10380 = 4.97 V = 2.07 %
    const r = calcElectrical({ kind: "voltage_drop", volts: 240, amps: 20, oneWayFt: 100, awg: "10" });
    assert.equal(r.values.voltageDrop, 4.97);
    assert.equal(r.values.voltageDropPct, 2.07);
    assert.equal(r.values.flag, 0);
    assert.equal(r.values.circularMils, 10380);
    // same run 3-phase 208 V aluminum: 1.732 × 21.2 × 20 × 100 / 10380 = 7.07 V = 3.4 % → flag 1
    const a = calcElectrical({ kind: "voltage_drop", volts: 208, amps: 20, oneWayFt: 100, awg: "#10 AWG", material: "al", phase: 3 });
    assert.equal(a.values.voltageDrop, 7.07);
    assert.equal(a.values.flag, 1);
    const big = calcElectrical({ kind: "voltage_drop", volts: 120, amps: 20, oneWayFt: 200, awg: "14" });
    assert.ok((big.values.voltageDropPct as number) > 5);
    assert.equal(big.values.flag, 2);
    const cm = calcElectrical({ kind: "voltage_drop", volts: 480, amps: 100, oneWayFt: 300, circularMils: 250000, phase: 3 });
    assert.equal(cm.values.circularMils, 250000);
    const unknown = calcElectrical({ kind: "voltage_drop", volts: 480, amps: 100, oneWayFt: 300, awg: "9" });
    assert.ok(unknown.warnings.some((w) => /Unknown conductor size/.test(w)));
    assert.equal(normalizeAwg("1/0"), "1/0");
    assert.equal(normalizeAwg("00"), "2/0");
    assert.equal(normalizeAwg("4-0"), "4/0");
    assert.equal(normalizeAwg("250 kcmil"), "250");
    assert.equal(normalizeAwg("500 MCM"), "500");
    assert.equal(AWG_CMIL["4/0"], 211600);
    assert.equal(Object.keys(AWG_CMIL).length, 18);
  });

  test("motor_fla: NEC 430.250 (15 HP 460 V = 21 A, 25 HP 230 V = 68 A) and 430.248 (1 HP 115 V = 16 A); 125 % sizing; nearest column / next HP", () => {
    const r = calcElectrical({ kind: "motor_fla", hp: 15, volts: 460, phase: 3 });
    assert.equal(r.values.tableFla, 21);
    assert.equal(r.values.conductorAmps125, 26.3);
    assert.equal(r.values.tableVolts, 460);
    assert.equal(calcElectrical({ kind: "motor_fla", hp: 25, volts: 230, phase: 3 }).values.tableFla, 68);
    assert.equal(calcElectrical({ kind: "motor_fla", hp: 15, volts: 230, phase: 3 }).values.tableFla, 42);
    assert.equal(calcElectrical({ kind: "motor_fla", hp: 1, volts: 115, phase: 1 }).values.tableFla, 16);
    assert.equal(calcElectrical({ kind: "motor_fla", hp: 0.5, volts: 230, phase: 1 }).values.tableFla, 4.9);
    const v480 = calcElectrical({ kind: "motor_fla", hp: 10, volts: 480, phase: 3 });
    assert.equal(v480.values.tableVolts, 460);
    assert.equal(v480.values.tableFla, 14);
    const next = calcElectrical({ kind: "motor_fla", hp: 12, volts: 208, phase: 3 });
    assert.equal(next.values.tableHp, 15);
    assert.equal(next.values.tableFla, 46.2);
    assert.match(next.interpretation[0]!, /next size up from 12 HP/);
    const over = calcElectrical({ kind: "motor_fla", hp: 300, volts: 460, phase: 3 });
    assert.ok(over.warnings.some((w) => /above the 200 HP/.test(w)));
    assert.equal(Object.keys(NEC_FLA_3PH).length, 21);
    assert.equal(Object.keys(NEC_FLA_1PH).length, 12);
    assert.equal(NEC_FLA_3PH["200"]!["575"], 192);
  });

  test("capacitor_replacement: ok within ±6 % µF and voltage ≥ rated", () => {
    const ok = calcElectrical({ kind: "capacitor_replacement", ratedUf: 45, ratedV: 370, replacementUf: 45, replacementV: 440 });
    assert.equal(ok.values.ok, 1);
    assert.equal(ok.values.deviationPct, 0);
    const edge = calcElectrical({ kind: "capacitor_replacement", ratedUf: 50, ratedV: 440, replacementUf: 47, replacementV: 440 });
    assert.equal(edge.values.deviationPct, -6);
    assert.equal(edge.values.ok, 1);
    const badUf = calcElectrical({ kind: "capacitor_replacement", ratedUf: 45, ratedV: 370, replacementUf: 40, replacementV: 370 });
    assert.equal(badUf.values.microfaradsOk, 0);
    assert.equal(badUf.values.ok, 0);
    assert.ok(badUf.interpretation.some((s) => /too small/.test(s)));
    const badV = calcElectrical({ kind: "capacitor_replacement", ratedUf: 45, ratedV: 440, replacementUf: 45, replacementV: 370 });
    assert.equal(badV.values.voltageOk, 0);
    assert.ok(badV.interpretation.some((s) => /Voltage rating too low/.test(s)));
  });

  test("motor_replacement: checklist lines name what must match (rpm, volts/phase, rotation from the shaft end, frame/shaft) and what may substitute (hp up)", () => {
    const r = calcElectrical({ kind: "motor_replacement", hp: 1, rpm: 1075, volts: 230, phase: 1, frame: "48Y", rotationFromShaftEnd: "ccw", shaftDiaIn: 0.5, enclosure: "TEAO" });
    assert.deepEqual(r.values, { hp: 1, rpm: 1075, volts: 230, phase: 1, shaftDiaIn: 0.5 });
    const text = r.interpretation.join("\n");
    assert.match(text, /RPM: 1075 — must match/);
    assert.match(text, /HP: 1 — equal, or the next size up ONLY/);
    assert.match(text, /Rotation \(from the shaft end\): ccw/);
    assert.match(text, /Frame: 48Y/);
    assert.match(text, /Enclosure: TEAO/);
    assert.match(text, /never smaller/);
    assert.equal(r.warnings.length, 0);
    const empty = calcElectrical({ kind: "motor_replacement" });
    assert.ok(empty.warnings.some((w) => /generic/.test(w)));
    assert.match(empty.interpretation.join("\n"), /RPM: not given/);
  });

  test("every new kind survives missing inputs with warnings instead of throwing", () => {
    for (const kind of ["leak_rate", "gas_meter_clock", "combustion_co", "sensible_cfm", "static_pressure", "fan_laws", "belt_drive", "voltage_drop", "motor_fla", "capacitor_replacement"] as const) {
      const r = calcElectrical({ kind } as never);
      assert.equal(r.kind, kind);
      assert.ok(r.warnings.length > 0, kind);
    }
  });
});
