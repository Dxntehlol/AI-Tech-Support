import { test } from "node:test";
import assert from "node:assert/strict";
import { loadKnowledge } from "./loader.ts";
import { canonicalRefrigerantId, ptLookup, resolveRefrigerant, satPressuresAtTemp, satTempsAtPressure, superheatSubcooling, getTable } from "./refrigerants.ts";
import { PROJECT_ROOT } from "../config.ts";
import { join } from "node:path";

const kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });

test("canonical ids", () => {
  assert.equal(canonicalRefrigerantId("r410a"), "R-410A");
  assert.equal(canonicalRefrigerantId("410-A"), "R-410A");
  assert.equal(canonicalRefrigerantId("R 22"), "R-22");
  assert.equal(canonicalRefrigerantId("134A"), "R-134a");
  assert.equal(canonicalRefrigerantId("r1234ze(e)"), "R-1234ze(E)");
  assert.equal(canonicalRefrigerantId("R-454B"), "R-454B");
  assert.equal(canonicalRefrigerantId("hfc-32"), "R-32");
  assert.equal(canonicalRefrigerantId("R-600a"), "R-600a");
});

test("PT reference points (published chart values)", () => {
  const cases: [string, number, number][] = [
    ["R-410A", 40, 118.8],
    ["R-22", 40, 68.6],
    ["R-134a", 40, 35.0],
    ["R-404A", 40, 86.9],
    ["R-32", 40, 121.0],
    ["R-407C", 40, 80.2],
  ];
  for (const [id, tF, psig] of cases) {
    const t = getTable(kb, id);
    assert.ok(t, `table ${id}`);
    const p = satPressuresAtTemp(t!, tF)!;
    assert.ok(Math.abs(p.bubblePsig - psig) < 1.0, `${id} @ ${tF}F bubble ${p.bubblePsig} vs ${psig}`);
  }
});

test("pressure to temperature inversion", () => {
  const t = getTable(kb, "R-410A")!;
  const s = satTempsAtPressure(t, 118.8)!;
  assert.ok(Math.abs(s.bubbleF - 40) < 0.3, `got ${s.bubbleF}`);
  assert.equal(satTempsAtPressure(t, 100000), undefined);
});

test("superheat/subcooling on R-410A TXV system", () => {
  const r = superheatSubcooling(kb, { refrigerant: "410a", suctionPsig: 118.8, suctionLineTempF: 50, liquidPsig: 365, liquidLineTempF: 98 });
  assert.ok(Math.abs(r.superheatF! - 10) < 0.5, `SH ${r.superheatF}`);
  // 365 psig ~ 110 F sat for R-410A -> SC ~ 12
  assert.ok(r.subcoolingF! > 10 && r.subcoolingF! < 14, `SC ${r.subcoolingF}`);
});

test("zeotrope uses dew for superheat and bubble for subcooling", () => {
  const t = getTable(kb, "R-407C")!;
  const p = satPressuresAtTemp(t, 40)!;
  assert.ok(p.bubblePsig - p.dewPsig > 8, "R-407C should show glide");
  const r = superheatSubcooling(kb, { refrigerant: "R-407C", suctionPsig: p.dewPsig, suctionLineTempF: 52 });
  assert.ok(Math.abs(r.superheatF! - 12) < 0.5, `SH ${r.superheatF}`);
});

test("ptLookup reports unknown refrigerant gracefully", () => {
  const r = ptLookup(kb, "R-999", { psig: 100 });
  assert.equal(r.bubbleTempF, undefined);
  assert.ok(r.notes[0]!.includes("No PT data"));
  assert.ok(resolveRefrigerant(kb, "R-999") === undefined);
});

// ---- extensions: elevation, vacuum, midpoint, transcritical, range messages

test("patmPsia follows the barometric formula", async () => {
  const { patmPsia, fieldToSeaLevelPsig, seaLevelToFieldPsig, inHgVacuum } = await import("./refrigerants.ts");
  assert.equal(patmPsia(0), 14.696);
  assert.ok(Math.abs(patmPsia(5000) - 12.23) < 0.02, `${patmPsia(5000)}`);
  assert.ok(Math.abs(patmPsia(10000) - 10.11) < 0.03);
  assert.equal(patmPsia(undefined), 14.696);
  assert.equal(patmPsia(-100), 14.696);
  assert.ok(Math.abs(fieldToSeaLevelPsig(100, 5000) - 102.47) < 0.05);
  assert.ok(Math.abs(seaLevelToFieldPsig(fieldToSeaLevelPsig(100, 5000), 5000) - 100) < 1e-9);
  assert.equal(inHgVacuum(-5), 10.2);
  assert.equal(inHgVacuum(3), 0);
});

test("ptLookup elevation correction shifts saturation temperature and adds a quantitative note", () => {
  const sea = ptLookup(kb, "R-410A", { psig: 118 });
  const high = ptLookup(kb, "R-410A", { psig: 118, elevationFt: 5000 });
  assert.equal(high.elevationFt, 5000);
  assert.ok(high.dewTempF! - sea.dewTempF! > 0.5 && high.dewTempF! - sea.dewTempF! < 2);
  assert.ok(high.notes.some((n) => /5,000 ft/.test(n) && /~2\.5 psi lower/.test(n)));
  assert.equal(high.midpointTempF, Math.round(((high.bubbleTempF! + high.dewTempF!) / 2) * 10) / 10);
  // temp → psig: field gauge reads lower at elevation
  const t = ptLookup(kb, "R-410A", { tempF: 40, elevationFt: 5000 });
  assert.ok(t.bubblePsig! < 118.8 - 2 && t.bubblePsig! > 118.8 - 3, `${t.bubblePsig}`);
  // below 1000 ft: no quantitative "lower than the chart" claim
  const low = ptLookup(kb, "R-410A", { psig: 118, elevationFt: 500 });
  assert.ok(!low.notes.some((n) => /reads ~/.test(n)));
});

test("ptLookup reports inHg vacuum for sub-atmospheric results", () => {
  const p = ptLookup(kb, "R-22", { psig: -5 });
  assert.equal(p.inHgVacuum, 10.2);
  const t = ptLookup(kb, "R-22", { tempF: -50 });
  assert.ok(t.bubblePsig! < 0);
  assert.ok(t.inHgVacuum! > 0);
  assert.ok(t.notes.some((n) => /inHg vacuum/.test(n)));
});

test("ptLookup flags transcritical conditions and reports bubble/dew ranges separately", () => {
  const co2 = ptLookup(kb, "R-744", { tempF: 95 });
  assert.equal(co2.bubblePsig, undefined);
  assert.ok(co2.notes.some((n) => /above critical temperature — no saturation \(transcritical\)/.test(n)));
  const blend = ptLookup(kb, "R-407C", { psig: 470 });
  assert.equal(blend.dewTempF, undefined);
  assert.ok(blend.bubbleTempF !== undefined); // still inside the bubble range
  assert.ok(blend.notes.some((n) => /bubble -?[\d.]+ to [\d.]+ psig, dew -?[\d.]+ to [\d.]+ psig/.test(n)));
  const pure = ptLookup(kb, "R-22", { psig: 5000 });
  assert.ok(pure.notes.some((n) => /transcritical/.test(n)));
});

test("safety class and A2L reminder come from meta when present", () => {
  const kb2 = { ...kb, refrigerants: { tables: kb.refrigerants.tables, meta: [{ id: "R-454B", aliases: ["Opteon XL41"], type: "zeotrope" as const, safetyClass: "A2L", glideF: 2.4, criticalTempF: 172, applications: [], serviceNotes: [] }] } };
  const r = ptLookup(kb2, "Opteon XL41", { psig: 120 });
  assert.equal(r.refrigerant, "R-454B");
  assert.equal(r.safetyClass, "A2L");
  assert.ok(r.notes.some((n) => /A2L/.test(n) && /ignition/.test(n)));
  const hot = ptLookup(kb2, "R-454B", { tempF: 175 });
  assert.ok(hot.notes.some((n) => /transcritical/.test(n)));
  const sh = superheatSubcooling(kb2, { refrigerant: "R-454B", suctionPsig: 120, suctionLineTempF: 55, elevationFt: 6000 });
  assert.equal(sh.safetyClass, "A2L");
  assert.ok(Math.abs(sh.patmPsia! - 11.78) < 0.02);
  assert.ok(sh.notes.some((n) => /6,000 ft/.test(n)));
});

test("superheatSubcooling accepts elevationFt", () => {
  const sea = superheatSubcooling(kb, { refrigerant: "R-410A", suctionPsig: 118.8, suctionLineTempF: 50 });
  const high = superheatSubcooling(kb, { refrigerant: "R-410A", suctionPsig: 118.8, suctionLineTempF: 50, elevationFt: 5000 });
  assert.ok(high.evapSatF! > sea.evapSatF!);
  assert.ok(high.superheatF! < sea.superheatF!);
  assert.equal(sea.patmPsia, 14.696);
});
