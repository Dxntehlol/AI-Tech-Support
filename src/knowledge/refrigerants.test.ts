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
