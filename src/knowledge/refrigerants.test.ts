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
  // R-407C at 470 psig: inside the bubble column, above the dew column (458.5 psig at 160 °F) but far below
  // the 656.8 psig critical pressure → dew extrapolated, both ranges reported, no transcritical claim.
  const blend = ptLookup(kb, "R-407C", { psig: 470 });
  assert.ok(blend.bubbleTempF !== undefined && blend.bubbleTempF < 160); // inside the bubble range
  assert.ok(blend.dewTempF !== undefined && blend.dewTempF > 160 && blend.dewTempF < 166, `dew ${blend.dewTempF}`);
  assert.ok(blend.notes.some((n) => /bubble -?[\d.]+ to [\d.]+ psig, dew -?[\d.]+ to [\d.]+ psig/.test(n)));
  assert.ok(blend.notes.some((n) => /EXTRAPOLATED/.test(n)));
  assert.ok(!blend.notes.some((n) => /transcritical/.test(n)));
  const pure = ptLookup(kb, "R-22", { psig: 5000 });
  assert.ok(pure.notes.some((n) => /above the critical pressure of R-22/.test(n) && /transcritical/.test(n)));
  assert.equal(pure.bubbleTempF, undefined);
  const below = ptLookup(kb, "R-407C", { psig: -12 });
  assert.equal(below.bubbleTempF, undefined);
  assert.ok(below.notes.some((n) => /outside the R-407C table: bubble/.test(n)));
});

// ---- above-table tail: transcritical only from the critical point on file (finding: R-22 at 450 psig
// was reported as "transcritical" although R-22's critical point is 205 °F / 709 psig)

test("ptLookup extrapolates above the 160 °F table top up to the critical point instead of claiming transcritical", () => {
  // R-22 head pressure 450 psig ≈ 164 °F condensing (published ≈ 163.7 °F); critical 205.1 °F / 709 psig
  const r = ptLookup(kb, "R-22", { psig: 450 });
  assert.ok(r.bubbleTempF !== undefined && Math.abs(r.bubbleTempF - 164) < 1.5, `bubble ${r.bubbleTempF}`);
  assert.equal(r.dewTempF, r.bubbleTempF);
  assert.equal(r.midpointTempF, r.bubbleTempF);
  assert.ok(!r.notes.some((n) => /transcritical/.test(n)), r.notes.join("\n"));
  assert.ok(r.notes.some((n) => /above the R-22 table \(ends at 160 °F ≈ 430 psig/.test(n) && /EXTRAPOLATED/.test(n) && /high-pressure switch/.test(n)));
  // temperature → pressure: R-22 at 170 °F ≈ 483 psig published
  const t = ptLookup(kb, "R-22", { tempF: 170 });
  assert.ok(t.bubblePsig !== undefined && Math.abs(t.bubblePsig - 483) < 4, `psig ${t.bubblePsig}`);
  assert.ok(t.notes.some((n) => /EXTRAPOLATED/.test(n)) && !t.notes.some((n) => /transcritical/.test(n)));
  // elevation correction still applies to the extrapolated tail
  const high = ptLookup(kb, "R-22", { psig: 450, elevationFt: 5000 });
  assert.ok(high.bubbleTempF! > r.bubbleTempF!);
  // R-134a (critical 213.9 °F / 574 psig): 320 psig ≈ 165 °F, not transcritical
  const r134 = ptLookup(kb, "R-134a", { psig: 320 });
  assert.ok(r134.bubbleTempF !== undefined && r134.bubbleTempF > 160 && r134.bubbleTempF < 170, `${r134.bubbleTempF}`);
  assert.ok(!r134.notes.some((n) => /transcritical/.test(n)));
});

test("ptLookup claims transcritical only from criticalPsig / criticalTempF", () => {
  // above the critical pressure on file
  const p = ptLookup(kb, "R-22", { psig: 720 });
  assert.equal(p.bubbleTempF, undefined);
  assert.ok(p.notes.some((n) => /above the critical pressure of R-22 \(critical ≈ 205.1 °F \/ 709 psig\)/.test(n) && /transcritical/.test(n)));
  // above the critical temperature on file
  const t = ptLookup(kb, "R-22", { tempF: 210 });
  assert.equal(t.bubblePsig, undefined);
  assert.ok(t.notes.some((n) => /above critical temperature — no saturation \(transcritical\) \(critical ≈ 205.1 °F/.test(n)));
  // zeotrope with criticalTempF but no criticalPsig (R-454B, 172.3 °F; table ends at 150 °F ≈ 580 psig)
  const ok = ptLookup(kb, "R-454B", { psig: 600 });
  assert.ok(ok.bubbleTempF !== undefined && ok.bubbleTempF > 150 && ok.bubbleTempF < 158, `${ok.bubbleTempF}`);
  assert.ok(ok.dewTempF !== undefined && ok.dewTempF > ok.bubbleTempF!); // glide preserved in the tail
  assert.ok(!ok.notes.some((n) => /transcritical/.test(n)));
  const beyond = ptLookup(kb, "R-454B", { psig: 900 });
  assert.equal(beyond.bubbleTempF, undefined);
  assert.ok(beyond.notes.some((n) => /above the R-454B critical temperature \(critical ≈ 172.3 °F\)/.test(n) && /transcritical/.test(n)));
  // no critical data on file at all: no extrapolation and no transcritical claim, just "above the table"
  const t22 = getTable(kb, "R-22")!;
  const noMeta = { ...kb, refrigerants: { tables: new Map([["R-22", t22]]), meta: [] } };
  const bare = ptLookup(noMeta, "R-22", { psig: 450 });
  assert.equal(bare.bubbleTempF, undefined);
  assert.ok(bare.notes.some((n) => /above the R-22 table/.test(n) && /no critical-point data/.test(n)));
  assert.ok(!bare.notes.some((n) => /transcritical/.test(n)));
  const bareT = ptLookup(noMeta, "R-22", { tempF: 170 });
  assert.equal(bareT.bubblePsig, undefined);
  assert.ok(bareT.notes.some((n) => /above the R-22 table range/.test(n)) && !bareT.notes.some((n) => /transcritical/.test(n)));
});

test("resolveSatTemps / resolveSatPressures report the range status", async () => {
  const { resolveSatTemps, resolveSatPressures } = await import("./refrigerants.ts");
  const t22 = getTable(kb, "R-22")!;
  const meta = resolveRefrigerant(kb, "R-22");
  assert.equal(resolveSatTemps(t22, meta, 68.6).status, "table");
  assert.equal(resolveSatTemps(t22, meta, 450).status, "extrapolated");
  assert.equal(resolveSatTemps(t22, meta, 710).status, "transcritical");
  assert.equal(resolveSatTemps(t22, meta, -14).status, "below_table");
  assert.equal(resolveSatTemps(t22, undefined, 450).status, "above_table");
  assert.equal(resolveSatPressures(t22, meta, 40).status, "table");
  assert.equal(resolveSatPressures(t22, meta, 180).status, "extrapolated");
  assert.equal(resolveSatPressures(t22, meta, 206).status, "transcritical");
  assert.equal(resolveSatPressures(t22, meta, -70).status, "below_table");
  assert.equal(resolveSatPressures(t22, undefined, 180).status, "above_table");
  // the plain table helpers stay strictly in-table
  assert.equal(satTempsAtPressure(t22, 450), undefined);
  assert.equal(satPressuresAtTemp(t22, 170), undefined);
});

test("superheatSubcooling keeps condensing sat / subcooling above the table top and flags the extrapolation", () => {
  // Dirty R-22 condenser on a 105 °F day: 450 psig head, 150 °F liquid line
  const r = superheatSubcooling(kb, { refrigerant: "R-22", suctionPsig: 75, suctionLineTempF: 60, liquidPsig: 450, liquidLineTempF: 150 });
  assert.ok(r.condSatF !== undefined && Math.abs(r.condSatF - 164) < 1.5, `cond sat ${r.condSatF}`);
  assert.ok(r.subcoolingF !== undefined && Math.abs(r.subcoolingF - 14) < 1.5, `SC ${r.subcoolingF}`);
  assert.equal(r.extrapolated, true);
  assert.ok(r.notes.some((n) => /High-side pressure 450 psig is above the R-22 table/.test(n) && /EXTRAPOLATED/.test(n) && /high-pressure switch/.test(n)));
  assert.ok(!r.notes.some((n) => /transcritical/.test(n)));
  // in-table readings are not flagged
  const normal = superheatSubcooling(kb, { refrigerant: "R-22", suctionPsig: 70, suctionLineTempF: 55, liquidPsig: 260, liquidLineTempF: 105 });
  assert.equal(normal.extrapolated, undefined);
  // genuinely above the critical pressure: no sat temp, transcritical from the critical point on file
  const beyond = superheatSubcooling(kb, { refrigerant: "R-22", liquidPsig: 720, liquidLineTempF: 150 });
  assert.equal(beyond.condSatF, undefined);
  assert.ok(beyond.notes.some((n) => /above the critical point of R-22/.test(n) && /transcritical/.test(n)));
  // R-454B at 600 psig (critical 172 °F, no criticalPsig on file) is not transcritical either
  const blend = superheatSubcooling(kb, { refrigerant: "R-454B", liquidPsig: 600, liquidLineTempF: 140 });
  assert.ok(blend.condSatF !== undefined && blend.condSatF > 150);
  assert.ok(!blend.notes.some((n) => /transcritical/.test(n)));
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
