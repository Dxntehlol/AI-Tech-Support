import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compareReadings, readingsComparable, toTrendReading, trendFromReadings, TREND_AMBIENT_WINDOW_F, type TrendReading } from "./trend.ts";
import type { ReadingRow } from "../types.ts";

function reading(over: Partial<TrendReading> & { measurements?: Record<string, unknown>; derived?: Record<string, unknown> } = {}): TrendReading {
  return {
    created_at: "2026-08-02T15:00:00Z",
    mode: "ac_cooling",
    measurements: { outdoorDbF: 88, suctionPsig: 118, liquidPsig: 340, compressorAmps: 20, compressorRla: 25 },
    derived: { superheatF: 12, subcoolingF: 12, condSatF: 105, evapSatF: 40, deltaTF: 18, ampsPercentRla: 80 },
    ...over,
  } as TrendReading;
}

function row(over: Partial<ReadingRow> & { measurements?: Record<string, unknown>; derived?: Record<string, unknown> } = {}): ReadingRow {
  const { measurements, derived, ...rest } = over;
  const base = reading({ ...(measurements ? { measurements } : {}), ...(derived ? { derived } : {}) });
  return {
    id: "0000000000000001",
    unit_id: "0000000000000002",
    conversation_id: null,
    created_at: "2026-08-02T15:00:00Z",
    mode: "ac_cooling",
    refrigerant: "R-410A",
    metering_device: "txv",
    measurements_json: JSON.stringify(base.measurements),
    derived_json: JSON.stringify(base.derived),
    validity_json: '{"ok":true,"issues":[]}',
    findings_json: "[]",
    note: null,
    source: "sheet",
    ...rest,
  };
}

describe("compareReadings", () => {
  test("subcooling fall produces the spec'd plain-English line", () => {
    const prev = reading();
    const cur = reading({ created_at: "2026-10-01T15:00:00Z", derived: { ...(prev.derived as object), subcoolingF: 4 } });
    const deltas = compareReadings(prev, cur);
    const sc = deltas.find((d) => d.metric === "subcoolingF");
    assert.ok(sc, "subcooling delta present");
    assert.equal(sc.line, "Subcooling fell from 12 to 4 °F since 2026-08-02 (same mode) - charge loss or restriction trend");
    assert.equal(sc.direction, "down");
    assert.equal(sc.delta, -8);
    assert.equal(sc.prev, 12);
    assert.equal(sc.cur, 4);
    // nothing else moved
    assert.deepEqual(deltas.map((d) => d.metric), ["subcoolingF"]);
  });

  test("every tracked metric reports when it moves past its threshold, with direction-specific hints", () => {
    const prev = reading();
    const cur = reading({
      created_at: "2026-10-01T15:00:00Z",
      measurements: { outdoorDbF: 90, suctionPsig: 100, liquidPsig: 380, compressorAmps: 23.5, compressorRla: 25 },
      derived: { superheatF: 22, subcoolingF: 18, condSatF: 115, evapSatF: 32, deltaTF: 13, ampsPercentRla: 94 },
    });
    const deltas = compareReadings(prev, cur);
    const by = Object.fromEntries(deltas.map((d) => [d.metric, d]));
    assert.deepEqual(Object.keys(by).sort(), ["ampsPercentRla", "condSatF", "deltaTF", "evapSatF", "liquidPsig", "subcoolingF", "suctionPsig", "superheatF"]);
    assert.match(by.superheatF!.line, /^Superheat rose from 12 to 22 °F since 2026-08-02 \(same mode\) - charge loss, restriction or starving TXV trend$/);
    assert.match(by.subcoolingF!.line, /^Subcooling rose from 12 to 18 °F/);
    assert.match(by.condSatF!.line, /^Condensing temp rose from 105 to 115 °F .*dirty coil/);
    assert.match(by.evapSatF!.line, /^Evaporating temp fell from 40 to 32 °F .*airflow or charge falling/);
    assert.match(by.deltaTF!.line, /^Delta-T fell from 18 to 13 °F .*capacity loss/);
    assert.match(by.ampsPercentRla!.line, /^Compressor amps rose from 80 to 94 % RLA/);
    assert.match(by.suctionPsig!.line, /^Suction pressure fell from 118 to 100 psig/);
    assert.match(by.liquidPsig!.line, /^Liquid pressure rose from 340 to 380 psig/);
  });

  test("small moves are not notable; pressures use the larger of absolute and relative thresholds", () => {
    const prev = reading();
    const cur = reading({
      created_at: "2026-10-01T15:00:00Z",
      measurements: { outdoorDbF: 86, suctionPsig: 122, liquidPsig: 352, compressorAmps: 21, compressorRla: 25 },
      derived: { superheatF: 14, subcoolingF: 10.5, condSatF: 108, evapSatF: 42, deltaTF: 16.5, ampsPercentRla: 84 },
    });
    assert.deepEqual(compareReadings(prev, cur), []);
    // liquid: 340 → 357 is 17 psi (5 % of 340), exactly at the relative threshold → notable; 340 → 356 is not
    const at = reading({ measurements: { ...(prev.measurements as object), liquidPsig: 357 }, derived: prev.derived as Record<string, unknown> });
    assert.equal(compareReadings(prev, at).length, 1);
    const under = reading({ measurements: { ...(prev.measurements as object), liquidPsig: 356 }, derived: prev.derived as Record<string, unknown> });
    assert.equal(compareReadings(prev, under).length, 0);
  });

  test("amps vs RLA falls back to amps / RLA from the measurements when the engine did not derive it", () => {
    const prev = reading({ derived: { superheatF: 12 }, measurements: { outdoorDbF: 85, compressorAmps: 20, compressorRla: 25 } });
    const cur = reading({ derived: { superheatF: 12 }, measurements: { outdoorDbF: 85, compressorAmps: 12, compressorRla: 25 } });
    const d = compareReadings(prev, cur);
    assert.equal(d.length, 1);
    assert.equal(d[0]!.metric, "ampsPercentRla");
    assert.equal(d[0]!.prev, 80);
    assert.equal(d[0]!.cur, 48);
  });

  test("only compares the same mode with ambient known on both and within the window", () => {
    const prev = reading();
    const big = reading({ derived: { ...(prev.derived as object), subcoolingF: 2 } });
    assert.equal(compareReadings(prev, { ...big, mode: "heat_pump_heating" }).length, 0, "different mode");
    assert.match((readingsComparable(prev, { ...big, mode: "heat_pump_heating" }) as { reason: string }).reason, /different mode/);
    const hot = { ...big, measurements: { ...(big.measurements as object), outdoorDbF: 88 + TREND_AMBIENT_WINDOW_F + 1 } };
    assert.equal(compareReadings(prev, hot).length, 0, "ambient too far");
    assert.match((readingsComparable(prev, hot) as { reason: string }).reason, /outdoor temperature differs by 16/);
    const edge = { ...big, measurements: { ...(big.measurements as object), outdoorDbF: 88 + TREND_AMBIENT_WINDOW_F } };
    assert.equal(compareReadings(prev, edge).length, 1, "exactly at the window still compares");
    const noAmbient = { ...big, measurements: { suctionPsig: 118 } };
    assert.equal(compareReadings(prev, noAmbient).length, 0, "ambient unknown");
    assert.equal(readingsComparable(prev, noAmbient).ok, false);
    assert.equal(compareReadings(prev, { ...big, measurements: null, derived: null }).length, 0);
  });
});

describe("trendFromReadings", () => {
  test("compares the newest row against the most recent earlier comparable row and skips non-comparable ones", () => {
    const rows: ReadingRow[] = [
      row({ id: "0000000000000003", created_at: "2026-10-05T10:00:00Z", derived: { superheatF: 12, subcoolingF: 3, condSatF: 105, evapSatF: 40, deltaTF: 18, ampsPercentRla: 80 } }),
      // heating-mode row in between is skipped
      row({ id: "0000000000000002", created_at: "2026-09-20T10:00:00Z", mode: "heat_pump_heating" }),
      row({ id: "0000000000000001", created_at: "2026-08-02T10:00:00Z" }),
    ];
    const t = trendFromReadings(rows);
    assert.ok(t);
    assert.equal(t.prevId, "0000000000000001");
    assert.equal(t.since, "2026-08-02");
    assert.equal(t.mode, "ac_cooling");
    assert.deepEqual(t.lines, ["Subcooling fell from 12 to 3 °F since 2026-08-02 (same mode) - charge loss or restriction trend"]);
    // order does not matter: rows are sorted newest first internally
    assert.equal(trendFromReadings([...rows].reverse())?.prevId, "0000000000000001");
  });

  test("null with fewer than two rows, no comparable pair, or nothing notable", () => {
    assert.equal(trendFromReadings([]), null);
    assert.equal(trendFromReadings([row()]), null);
    assert.equal(trendFromReadings([row({ id: "0000000000000003", created_at: "2026-10-05T10:00:00Z" }), row()]), null, "identical readings");
    assert.equal(trendFromReadings([row({ id: "0000000000000003", created_at: "2026-10-05T10:00:00Z", mode: "refrigeration" }), row()]), null);
  });

  test("toTrendReading tolerates malformed JSON columns", () => {
    const t = toTrendReading(row({ measurements_json: "{not json", derived_json: "" }));
    assert.equal(t.measurements, null);
    assert.equal(t.derived, null);
    assert.equal(t.mode, "ac_cooling");
  });
});
