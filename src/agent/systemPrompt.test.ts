import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import { loadKnowledge } from "../knowledge/loader.ts";
import type { ConversationRow, DecodeResult, FindingRow, UnitRow } from "../types.ts";
import { staticSystemPrompt, unitContextBlock, wordCount, UNIT_CONTEXT_MAX_CHARS } from "./systemPrompt.ts";

// The prompt does not depend on the packs, but the harness expects every module test to load them non-strictly.
test("knowledge base loads (non-strict) alongside the prompt module", () => {
  const kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });
  assert.ok(kb);
});

// ---------------------------------------------------------------------------
// staticSystemPrompt
// ---------------------------------------------------------------------------

test("static prompt is deterministic and carries no dates or ids", () => {
  const a = staticSystemPrompt({ webSearchEnabled: true });
  const b = staticSystemPrompt({ webSearchEnabled: true });
  assert.equal(a, b);
  assert.doesNotMatch(a, /\b20\d\d-\d\d-\d\d\b/, "no ISO dates");
  assert.doesNotMatch(a, /\b[0-9a-f]{16}\b/, "no 16-hex ids");
});

test("static prompt word count is within 1100–1700 for both variants", () => {
  for (const webSearchEnabled of [true, false]) {
    const n = wordCount(staticSystemPrompt({ webSearchEnabled }));
    assert.ok(n >= 1100 && n <= 1700, `word count ${n} out of range (webSearchEnabled=${webSearchEnabled})`);
  }
});

test("static prompt contains the required phrases", () => {
  const p = staticSystemPrompt({ webSearchEnabled: true });
  for (const phrase of [
    "LOTO",
    "608",
    "dew",
    "bubble",
    "superheat",
    "subcooling",
    "save_finding",
    "decode_unit",
    "find_unit",
    "get_unit_history",
    "search_history",
    "refrigerant_pt",
    "calc_superheat_subcooling",
    "diagnose_refrigeration",
    "electrical_reference",
    "calc_electrical",
    "lookup_fault_code",
    "update_unit",
    "set_conversation",
    "validity",
    "not in my manufacturer data",
    "no verified entry for this code on this platform",
    "Verified from Carrier product data",
    "Two third-party sources agree",
    "Low confidence — confirm on nameplate/IOM",
    "every serial candidate",
    "What we know so far",
    "NFPA 70E",
    "live-dead-live",
    "CAT III/IV",
    "AIM Act",
    "R-454B",
    "225 °F",
    "65 °F",
    "head-pressure control",
    "megger",
    "Daikin Service Checker",
    "Mitsubishi Maintenance Tool",
    "LGMV",
    "confirmed=true",
    "1–2 sentence summary",
    "four or more readings",
  ]) {
    assert.ok(p.includes(phrase), `missing phrase: ${phrase}`);
  }
  assert.match(p, /never[^.\n]*jumper/i, "never + jumper rule");
  assert.match(p, /never quote PT values, superheat targets, subcooling targets or tonnage from memory/i);
});

test("static prompt lists the 8-step call flow in order", () => {
  const p = staticSystemPrompt({ webSearchEnabled: false });
  const flow = p.slice(p.indexOf("# Call flow"), p.indexOf("# Tools"));
  const steps = flow.match(/^\d\. /gm) ?? [];
  assert.deepEqual(steps, ["1. ", "2. ", "3. ", "4. ", "5. ", "6. ", "7. ", "8. "]);
  assert.ok(flow.indexOf("decode_unit") < flow.indexOf("Complaint"));
  assert.ok(flow.indexOf("Confirm demand") < flow.indexOf("Fault history"));
  assert.ok(flow.indexOf("Gauges only when justified") < flow.indexOf("diagnose_refrigeration"));
  assert.ok(flow.indexOf("diagnose_refrigeration") < flow.indexOf("save_finding"));
});

test("webSearchEnabled variants differ only in the web-search section", () => {
  const on = staticSystemPrompt({ webSearchEnabled: true });
  const off = staticSystemPrompt({ webSearchEnabled: false });
  assert.notEqual(on, off);
  assert.ok(on.includes("Web search is enabled"));
  assert.ok(on.includes("manufacturer domains"));
  assert.ok(on.includes("document title and section"));
  assert.ok(on.includes("single-secondary"));
  assert.ok(off.includes("Web search is not enabled"));
  assert.ok(!off.includes("Web search is enabled"));
  // Everything before the web-search heading is identical.
  const cut = (s: string) => s.slice(0, s.indexOf("# Web search"));
  assert.equal(cut(on), cut(off));
  // Both end with the same closing instruction.
  assert.ok(on.endsWith(off.slice(off.indexOf("# When you do not know"))));
});

// ---------------------------------------------------------------------------
// unitContextBlock
// ---------------------------------------------------------------------------

const NOW = new Date("2026-03-15T12:00:00Z");

function unit(over: Partial<UnitRow> = {}): UnitRow {
  return {
    id: "0123456789abcdef",
    manufacturer: "Carrier",
    brand: "Carrier",
    model: "48TCDA05A2A5",
    serial: "1234C56789",
    nickname: null,
    site: "Pharmacy #12",
    customer: "ACME Retail",
    location_note: "NE corner of roof",
    refrigerant: "R-410A",
    tonnage: 4,
    voltage: "208-230/3/60",
    phase: "3",
    decoded_json: null,
    notes: "Economizer disconnected by previous contractor",
    unit_tag: "RTU-7",
    circuits: 1,
    charge_json: JSON.stringify({ "1": "12 lb 4 oz" }),
    nameplate_json: JSON.stringify({ mca: 32, mop: 40, rla: { "1": 14.1 } }),
    control_platform: "SystemVu",
    heat_type: "gas",
    metering_device: "txv",
    install_year: 2016,
    last_service_at: "2025-08-01T10:00:00Z",
    elevation_ft: 5200,
    archived_at: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-08-01T10:00:00Z",
    ...over,
  };
}

let seq = 0;
function finding(over: Partial<FindingRow> = {}): FindingRow {
  seq += 1;
  return {
    id: `f${String(seq).padStart(15, "0")}`,
    unit_id: "0123456789abcdef",
    conversation_id: null,
    symptom: `Symptom ${seq}`,
    cause: `Cause ${seq}`,
    resolution: `Resolution ${seq}`,
    measurements_json: null,
    parts_json: null,
    tags: null,
    circuit: null,
    status: "resolved",
    service_date: null,
    refrigerant: null,
    refrigerant_added_lbs: null,
    refrigerant_recovered_lbs: null,
    follow_up: null,
    origin: "tech",
    confirmed: 1,
    created_at: "2025-06-01T00:00:00Z",
    ...over,
  };
}

function convo(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "c0000000000000001",
    title: "Title",
    unit_id: "0123456789abcdef",
    summary: null,
    created_at: "2025-06-01T00:00:00Z",
    updated_at: "2025-06-01T00:00:00Z",
    ...over,
  };
}

test("unit context contains the record, condensed nameplate data, and platform", () => {
  const text = unitContextBlock(unit(), [], [], "current", NOW);
  for (const s of [
    "Tag: RTU-7",
    "Site: Pharmacy #12",
    "Customer: ACME Retail",
    "Model: 48TCDA05A2A5",
    "Serial: 1234C56789",
    "Refrigerant: R-410A",
    "Tonnage: 4",
    "208-230/3/60 3-ph",
    "Circuits: 1",
    "Controls: SystemVu",
    "Metering: txv",
    "Heat: gas",
    "Installed: 2016",
    "Elevation: 5200 ft",
    "Last service: 2025-08-01",
    "Nameplate charge: ckt 1: 12 lb 4 oz",
    "Nameplate data: mca=32, mop=40, rla={\"1\":14.1}",
    "Notes: Economizer disconnected",
    "FINDINGS: none recorded",
    "OTHER CONVERSATIONS ON THIS UNIT: none.",
    "Reference this history",
  ]) {
    assert.ok(text.includes(s), `missing: ${s}`);
  }
  // Age computed from `now`, not from the wall clock.
  assert.match(text, /Installed: 2016 \(~9\.\d yr\)/);
});

test("unit context does not leak a wall-clock timestamp", () => {
  const text = unitContextBlock(unit(), [], [], "current", NOW);
  assert.ok(!text.includes(NOW.toISOString()));
  assert.ok(!text.includes("2026-03-15"));
});

test("decoded_json summary, ambiguity and warnings are shown; age derived from serial year with `now`", () => {
  const decoded: DecodeResult = {
    input: { model: "48TCDA05A2A5", serial: "1234C56789" },
    manufacturerCandidates: [{ id: "carrier", manufacturer: "Carrier", score: 140, reason: "model+serial" }],
    model: [
      {
        formatId: "48tc",
        manufacturerId: "carrier",
        family: "48TC WeatherMaker",
        productType: "packaged_rtu",
        attributes: { tonnage: "4", voltage: "208-230/3/60" },
        segments: [],
        confidence: "high",
      },
    ],
    serial: [
      {
        formatId: "carrier-wwyy",
        manufacturerId: "carrier",
        description: "week/year",
        year: 2012,
        week: 12,
        manufactureDate: "2012-W12",
        ageYears: 13.9,
        confidence: "low",
        ambiguous: true,
        candidateYears: [2012, 2002],
      },
    ],
    controls: [],
    electrical: [],
    commonIssues: [],
    summary: "Low confidence: Carrier 48TC, 4 ton, built week 12 of 2012 or 2002.",
    evidenceSummary: "Nomenclature: Carrier 48TC product data",
    warnings: ["Serial year ambiguous — confirm with compressor date stamps", "Verify nameplate"],
  };
  const text = unitContextBlock(unit({ install_year: null, decoded_json: JSON.stringify(decoded) }), [], [], "current", NOW);
  assert.ok(text.includes("Decoded: Low confidence: Carrier 48TC"));
  assert.ok(text.includes("Best model match (high confidence): 48TC WeatherMaker | packaged_rtu | tonnage=4, voltage=208-230/3/60"));
  assert.ok(text.includes("manufactured 2012-W12"));
  assert.ok(text.includes("AMBIGUOUS year: candidates 2012 / 2002"));
  assert.ok(text.includes("Evidence: Nomenclature: Carrier 48TC product data"));
  assert.ok(text.includes("Decoder warnings:"));
  assert.ok(text.includes("- Serial year ambiguous"));
  assert.ok(text.includes("- Verify nameplate"));
  // 2012-06 (no month → mid-year) to 2026-03 ≈ 13.8 yr; computed from `now`, not the stale ageYears.
  assert.match(text, /age ~13\.[0-9] yr/);
  assert.ok(text.includes("Age: ~13."));
});

test("malformed or non-object JSON never throws", () => {
  const cases: Partial<UnitRow>[] = [
    { decoded_json: "{not json", charge_json: "[[[", nameplate_json: "nope" },
    { decoded_json: "42", charge_json: "\"str\"", nameplate_json: "null" },
    { decoded_json: "[]", charge_json: "[1,2]", nameplate_json: "[]" },
    { decoded_json: JSON.stringify({ summary: 5, model: "x", serial: [null], warnings: "no" }) },
    { decoded_json: "", charge_json: "", nameplate_json: "" },
  ];
  for (const c of cases) {
    const text = unitContextBlock(unit(c), [finding({ measurements_json: "{bad", parts_json: "[oops" })], [], "current", NOW);
    assert.ok(text.includes("Model: 48TCDA05A2A5"));
    assert.ok(text.includes("Symptom"));
  }
  // Model may be NULL when the plate is unreadable.
  const t = unitContextBlock(unit({ model: null, serial: null, decoded_json: null }), [], [], "current", NOW);
  assert.ok(t.includes("Model: unreadable / not recorded"));
});

test("findings are ordered: open/monitor first, then resolved (last 5), hypotheses separate", () => {
  const findings = [
    finding({ symptom: "OLD RESOLVED", created_at: "2024-01-01T00:00:00Z" }),
    finding({ symptom: "RESOLVED A", created_at: "2025-01-01T00:00:00Z" }),
    finding({ symptom: "RESOLVED B", created_at: "2025-02-01T00:00:00Z" }),
    finding({ symptom: "RESOLVED C", created_at: "2025-03-01T00:00:00Z" }),
    finding({ symptom: "RESOLVED D", created_at: "2025-04-01T00:00:00Z", measurements_json: JSON.stringify({ suction_psig: 118, sh_f: 12 }) }),
    finding({ symptom: "RESOLVED E", created_at: "2025-05-01T00:00:00Z", parts_json: JSON.stringify(["P291-4553RS capacitor"]) }),
    finding({ symptom: "MONITOR ITEM", status: "monitor", created_at: "2024-06-01T00:00:00Z", follow_up: "Recheck SC next visit" }),
    finding({ symptom: "OPEN ITEM", status: "open", created_at: "2025-06-01T00:00:00Z", circuit: "2" }),
    finding({ symptom: "HYPOTHESIS X", origin: "assistant", confirmed: 0, status: "open", created_at: "2025-07-01T00:00:00Z" }),
    finding({ symptom: "CONFIRMED ASSISTANT", origin: "assistant", confirmed: 1, status: "resolved", created_at: "2025-08-01T00:00:00Z" }),
  ];
  const text = unitContextBlock(unit(), findings, [], "current", NOW);
  const idx = (s: string) => {
    const i = text.indexOf(s);
    assert.ok(i >= 0, `missing: ${s}`);
    return i;
  };
  assert.ok(idx("OPEN / MONITOR FINDINGS (2)") < idx("RESOLVED FINDINGS (7, last 5 shown)"));
  assert.ok(idx("RESOLVED FINDINGS") < idx("UNCONFIRMED ASSISTANT HYPOTHESES (1)"));
  assert.ok(idx("OPEN ITEM") < idx("MONITOR ITEM"), "newest open first");
  assert.ok(idx("MONITOR ITEM") < idx("CONFIRMED ASSISTANT"), "open block before resolved block");
  assert.ok(idx("CONFIRMED ASSISTANT") < idx("RESOLVED E"), "resolved newest first");
  assert.ok(idx("RESOLVED E") < idx("HYPOTHESIS X"), "hypotheses after resolved");
  assert.ok(!text.includes("OLD RESOLVED"), "only last 5 resolved");
  assert.ok(!text.includes("RESOLVED A"), "only last 5 resolved (A is the 6th newest)");
  assert.ok(text.includes("[open] 2025-06-01 ckt 2"));
  assert.ok(text.includes("meas: suction_psig=118, sh_f=12"));
  assert.ok(text.includes("parts: P291-4553RS capacitor"));
  assert.ok(text.includes("follow-up: Recheck SC next visit"));
  assert.ok(text.includes("assistant, confirmed by tech"));
  // The hypothesis line sits under the hypotheses heading, not among the open items.
  const hypHeading = idx("UNCONFIRMED ASSISTANT HYPOTHESES");
  assert.ok(idx("HYPOTHESIS X") > hypHeading);
  assert.ok(text.slice(idx("OPEN / MONITOR FINDINGS"), idx("RESOLVED FINDINGS")).includes("HYPOTHESIS X") === false);
});

test("refrigerant added is summed over the 12 months before the newest finding, anchored on findings not now", () => {
  const findings = [
    finding({ symptom: "Leak topped off", refrigerant_added_lbs: 3.5, created_at: "2025-01-10T00:00:00Z" }),
    finding({ symptom: "Topped off again", refrigerant_added_lbs: 2, service_date: "2025-09-01", created_at: "2025-09-02T00:00:00Z" }),
    finding({ symptom: "Old top-off", refrigerant_added_lbs: 10, created_at: "2023-09-01T00:00:00Z" }),
    finding({ symptom: "Newest, no gas", created_at: "2025-12-01T00:00:00Z" }),
  ];
  // `now` far in the future must not change the result: the window is anchored on 2025-12-01.
  const text = unitContextBlock(unit(), findings, [], "current", new Date("2031-01-01T00:00:00Z"));
  assert.ok(text.includes("Refrigerant added in the 12 months before the last finding (2025-12-01): 5.5 lb over 2 findings."));
  const none = unitContextBlock(unit(), [finding({ created_at: "2025-12-01T00:00:00Z" })], [], "current", NOW);
  assert.ok(none.includes("(2025-12-01): none recorded."));
});

test("other conversations: current excluded, newest first, capped at 5, title + date + summary", () => {
  const convos = [
    convo({ id: "current", title: "THIS ONE", updated_at: "2026-01-01T00:00:00Z", summary: "should not appear" }),
    convo({ id: "c1", title: "Oldest", updated_at: "2024-01-01T00:00:00Z" }),
    convo({ id: "c2", title: "Second", updated_at: "2025-02-01T00:00:00Z", summary: "Found bad run cap on OFM; replaced." }),
    convo({ id: "c3", title: "Third", updated_at: "2025-03-01T00:00:00Z" }),
    convo({ id: "c4", title: "Fourth", updated_at: "2025-04-01T00:00:00Z" }),
    convo({ id: "c5", title: "Fifth", updated_at: "2025-05-01T00:00:00Z" }),
    convo({ id: "c6", title: "Sixth", updated_at: "2025-06-01T00:00:00Z" }),
  ];
  const text = unitContextBlock(unit(), [], convos, "current", NOW);
  assert.ok(!text.includes("THIS ONE"));
  assert.ok(!text.includes("should not appear"));
  assert.ok(text.includes("OTHER CONVERSATIONS ON THIS UNIT (6, latest 5 shown)"));
  assert.ok(!text.includes("Oldest"));
  assert.ok(text.includes("- 2025-06-01 — Sixth (no summary)"));
  assert.ok(text.includes("- 2025-02-01 — Second: Found bad run cap on OFM; replaced."));
  assert.ok(text.indexOf("Sixth") < text.indexOf("Fifth"));
  assert.ok(text.indexOf("Fifth") < text.indexOf("Second"));
});

test("size cap is respected with many long findings and the closing instruction survives", () => {
  const long = "x".repeat(400);
  const findings: FindingRow[] = [];
  for (let i = 0; i < 60; i++) {
    findings.push(
      finding({
        status: i % 3 === 0 ? "open" : i % 3 === 1 ? "monitor" : "resolved",
        symptom: `${long} ${i}`,
        cause: long,
        resolution: long,
        measurements_json: JSON.stringify({ a: long, b: long }),
        follow_up: long,
        created_at: `2025-${String((i % 12) + 1).padStart(2, "0")}-01T00:00:00Z`,
      }),
    );
  }
  for (let i = 0; i < 10; i++) {
    findings.push(finding({ origin: "assistant", confirmed: 0, status: "open", symptom: `${long} hyp ${i}` }));
  }
  const convos = Array.from({ length: 8 }, (_, i) => convo({ id: `c${i}`, title: long, summary: long }));
  const text = unitContextBlock(unit({ notes: long, nameplate_json: JSON.stringify({ k: long }) }), findings, convos, "current", NOW);
  assert.ok(text.length <= UNIT_CONTEXT_MAX_CHARS, `length ${text.length} exceeds cap`);
  assert.ok(text.endsWith("not conclusions."));
  assert.ok(text.includes("[unit context truncated"));
  assert.ok(text.includes("OPEN / MONITOR FINDINGS (40, newest 8 shown)"));
});

test("moderate histories fit without truncation", () => {
  const findings = Array.from({ length: 12 }, (_, i) =>
    finding({
      status: i < 3 ? "open" : "resolved",
      symptom: "Low suction, high superheat on circuit 1",
      cause: "Undercharge from leaking Schrader core",
      resolution: "Replaced core, leak checked, weighed in 1.5 lb R-410A",
      measurements_json: JSON.stringify({ suction_psig: 98, liquid_psig: 340, sh_f: 22, sc_f: 4 }),
      refrigerant_added_lbs: 1.5,
      created_at: `2025-${String(i + 1).padStart(2, "0")}-05T00:00:00Z`,
    }),
  );
  const convos = Array.from({ length: 5 }, (_, i) =>
    convo({ id: `c${i}`, title: `RTU-7 no cooling ${i}`, summary: "Found undercharge; repaired leak and recharged.", updated_at: `2025-0${i + 1}-06T00:00:00Z` }),
  );
  const text = unitContextBlock(unit(), findings, convos, "current", NOW);
  assert.ok(text.length <= UNIT_CONTEXT_MAX_CHARS);
  assert.ok(!text.includes("[unit context truncated"));
});
