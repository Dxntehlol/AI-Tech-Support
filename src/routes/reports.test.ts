import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PROJECT_ROOT, loadConfig } from "../config.ts";
import { loadKnowledge } from "../knowledge/loader.ts";
import { openDatabase, type Db } from "../db/index.ts";
import { createRepos, type Repos } from "../db/repos.ts";
import { createFakeClient } from "../agent/fakeClient.ts";
import type { AppConfig, KnowledgeBase, MessageRow } from "../types.ts";
import { createApp, type AppDeps } from "../app.ts";
import { buildConversationReport, extractReadings, renderMarkdownSafe, reportFilename, slugify, truncateText, type ConversationReport, type UnitReport } from "../reports.ts";
import { parseReportFormat } from "./reports.ts";

const NOW = new Date("2026-10-12T15:30:00Z");
const CARRIER_MODEL = "48TCDA04A2A5-0A0A0";
const CARRIER_SERIAL = "1523G12345";

let kb: KnowledgeBase;
before(() => {
  kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });
});

interface Ctx {
  db: Db;
  repos: Repos;
  get(path: string, init?: RequestInit): Promise<Response>;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>, config: Partial<AppConfig> = {}): Promise<void> {
  const db = openDatabase(":memory:");
  const repos = createRepos(db);
  const cfg: AppConfig = { ...loadConfig({}), ...config };
  const deps: AppDeps = { client: createFakeClient(), config: cfg, kb, repos, log: () => {}, now: () => NOW, demo: true, version: "9.9.9" };
  const app = createApp(deps);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn({ db, repos, get: (path, init) => fetch(base + path, init) });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

const DIAG_INPUT = { refrigerant: "R-410A", metering_device: "txv", mode: "ac_cooling", circuit: "1", suction_psig: 118, suction_line_temp_f: 52, liquid_psig: 340, liquid_line_temp_f: 95, outdoor_db_f: 90, indoor_db_f: 75, indoor_wb_f: 63, supply_db_f: 57 };
const DIAG_RESULT = {
  refrigerant: "R-410A",
  meteringDevice: "txv",
  mode: "ac_cooling",
  derived: { evapSatF: 40.1, condSatF: 104.4, superheatF: 11.9, subcoolingF: 9.4, condenserSplitF: 14.4, deltaTF: 18, compressionRatio: 2.67, targetDeltaTF: { min: 16, max: 22 } },
  validity: { ok: true, issues: [] },
  findings: [{ ruleId: "normal", condition: "System within normal ranges", severity: "info", confidence: "high", explanation: "x", nextChecks: [] }],
  missing: ["compressorAmps"],
  summary: "SH 11.9 °F and SC 9.4 °F are on target; the circuit looks healthy.",
};

/** A conversation with a complaint, a diagnose round-trip, a readings-sheet message and a markdown answer with hostile text. */
function seed(repos: Repos): { unitId: string; convId: string; findingId: string } {
  const decoded_json = JSON.stringify({ input: { model: CARRIER_MODEL }, manufacturerCandidates: [], model: [{ family: "48TC WeatherMaker packaged rooftop", confidence: "high" }], serial: [{ manufactureDate: "2015-06", ageYears: 11.3, confidence: "medium" }], warnings: ["Serial year digits: confirm on the nameplate"] });
  const unit = repos.units.create({ model: CARRIER_MODEL, serial: CARRIER_SERIAL, manufacturer: "Carrier", unit_tag: "RTU-7", site: "Main St <Pharmacy>", refrigerant: "R-410A", tonnage: 3, voltage: "208-230/3/60", decoded_json });
  const conv = repos.conversations.create({ title: "RTU-7 no cooling | second stage", unit_id: unit.id });
  repos.messages.append(conv.id, "user", [{ type: "text", text: "RTU-7 not cooling <script>alert(1)</script> since this morning; stat calling.\n\nBreaker is on." }], "RTU-7 not cooling <script>alert(1)</script> since this morning; stat calling.\n\nBreaker is on.");
  repos.messages.append(conv.id, "assistant", [{ type: "text", text: "Let me run the numbers." }, { type: "tool_use", id: "toolu_1", name: "diagnose_refrigeration", input: DIAG_INPUT }], "Let me run the numbers.");
  repos.messages.append(conv.id, "user", [{ type: "tool_result", tool_use_id: "toolu_1", content: JSON.stringify(DIAG_RESULT) }], "", "tool_result");
  repos.messages.append(conv.id, "user", [{ type: "text", text: "Readings (circuit 2, R-410A, TXV, AC cooling): suction 60 psig / 40 °F line; liquid 300 psig." }], "Readings (circuit 2, R-410A, TXV, AC cooling): suction 60 psig / 40 °F line; liquid 300 psig.");
  repos.messages.append(conv.id, "assistant", [{ type: "tool_use", id: "toolu_2", name: "calc_superheat_subcooling", input: { refrigerant: "R-410A", suction_psig: 60, suction_line_temp_f: 40 } }], "");
  repos.messages.append(conv.id, "user", [{ type: "tool_result", tool_use_id: "toolu_2", content: JSON.stringify({ refrigerant: "R-410A", evapSatF: 11.2, superheatF: 28.8, notes: [], summary: "R-410A: SH 28.8 °F" }) }], "", "tool_result");
  const summary = "## What we know\n\n**Circuit 2 is starved** — SH 28.8 °F.\n\n<img src=x onerror=alert(1)> raw html here\n\n[bad link](javascript:alert(1)) and [good link](https://docs.carrier.com/iom)\n\n| a | b |\n| - | - |\n| 1 | 2 |";
  repos.messages.append(conv.id, "assistant", [{ type: "text", text: summary }], summary);
  const finding = repos.findings.create({ unit_id: unit.id, conversation_id: conv.id, symptom: "Circuit 2 low suction", cause: "Plugged liquid line drier", resolution: "Replaced drier & recharged", parts_json: JSON.stringify(["Drier 083S"]), refrigerant: "R-410A", refrigerant_added_lbs: 2.5, status: "monitor", follow_up: "Re-check SH in 2 weeks", confirmed: 1, service_date: "2026-10-12", origin: "tech" });
  repos.findings.create({ unit_id: unit.id, symptom: "Older unrelated finding", status: "resolved", confirmed: 1, service_date: "2025-06-01", origin: "tech" });
  return { unitId: unit.id, convId: conv.id, findingId: finding.id };
}

describe("reports — pure builders", () => {
  test("truncateText collapses whitespace and cuts at a word boundary with an ellipsis", () => {
    assert.equal(truncateText("  a  b\n\nc ", 100), "a b c");
    const long = "word ".repeat(100).trim();
    const t = truncateText(long, 40);
    assert.ok(t.length <= 40, t);
    assert.ok(t.endsWith("…"));
    assert.doesNotMatch(t, /wor…$/);
    assert.equal(truncateText("x".repeat(50), 10), "x".repeat(9) + "…");
  });
  test("slugify + reportFilename", () => {
    assert.equal(slugify("RTU-7 / Kitchen roof (A2L)"), "rtu-7-kitchen-roof-a2l");
    assert.equal(slugify("Ünïcode café"), "unicode-cafe");
    assert.equal(slugify("x".repeat(60)).length, 40);
    const base = { generatedAt: "2026-10-12T15:30:00Z", appVersion: "1" };
    const conv = { ...base, kind: "conversation", conversation: { id: "0123456789abcdef", title: "Weird: title!" }, unit: null } as unknown as ConversationReport;
    assert.equal(reportFilename(conv, "md"), "hvac-report-weird-title-2026-10-12.md");
    const withUnit = { ...conv, unit: { id: "u", tag: "RTU-7", nickname: null, model: "48TC" } } as unknown as ConversationReport;
    assert.equal(reportFilename(withUnit, "html"), "hvac-report-rtu-7-2026-10-12.html");
    const unit = { ...base, kind: "unit", unit: { id: "u", tag: null, nickname: null, model: "48TCDA04A2A5-0A0A0" } } as unknown as UnitReport;
    assert.equal(reportFilename(unit, "json"), "hvac-unit-48tcda04a2a5-0a0a0-2026-10-12.json");
  });
  test("parseReportFormat accepts md/markdown/html/json and rejects the rest", () => {
    assert.equal(parseReportFormat(undefined), "md");
    assert.equal(parseReportFormat("markdown"), "md");
    assert.equal(parseReportFormat("HTML"), "html");
    assert.equal(parseReportFormat("json"), "json");
    assert.throws(() => parseReportFormat("pdf"), /format must be one of/);
  });
  test("renderMarkdownSafe keeps markdown, escapes raw HTML, drops images and javascript: links", () => {
    const html = renderMarkdownSafe("**b** <img src=x onerror=alert(1)> ![alt](http://x/y.png) [j](javascript:alert(1)) [ok](https://a.b/c)");
    assert.match(html, /<strong>b<\/strong>/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /javascript:/);
    assert.match(html, /<a href="https:\/\/a\.b\/c" rel="noopener noreferrer">ok<\/a>/);
    assert.match(html, /alt/);
  });
  test("extractReadings pairs tool_use with its result, keeps interrupted calls and readings-sheet text", () => {
    const row = (i: number, role: MessageRow["role"], kind: MessageRow["kind"], content: unknown[], text = ""): MessageRow => ({ id: `m${i}`, conversation_id: "c", seq: i, role, kind, content_json: JSON.stringify(content), text, created_at: `2026-10-12T10:0${i}:00Z` });
    const rows = [
      row(1, "user", "chat", [{ type: "text", text: "Readings (R-410A, TXV, AC cooling): suction 118 psig." }], "Readings (R-410A, TXV, AC cooling): suction 118 psig."),
      row(2, "assistant", "chat", [{ type: "tool_use", id: "t1", name: "diagnose_refrigeration", input: DIAG_INPUT }]),
      row(3, "user", "tool_result", [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: JSON.stringify(DIAG_RESULT) }] }]),
      row(4, "assistant", "chat", [{ type: "tool_use", id: "t2", name: "diagnose_refrigeration", input: { refrigerant: "R-22", mode: "ac_cooling", metering_device: "fixed" } }]),
      row(5, "user", "tool_result", [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "Tool execution was interrupted (server restart)." }]),
      row(6, "assistant", "chat", [{ type: "tool_use", id: "t3", name: "decode_unit", input: { model: "x" } }, { type: "tool_use", id: "t4", name: "calc_superheat_subcooling", input: { refrigerant: "R-410A", suction_psig: 118, suction_line_temp_f: 52 } }]),
    ];
    const r = extractReadings(rows);
    assert.deepEqual(r.map((x) => x.tool), ["readings_sheet", "diagnose_refrigeration", "diagnose_refrigeration", "calc_superheat_subcooling"]);
    assert.match(r[0]!.text!, /suction 118 psig/);
    const d = r[1]!;
    assert.equal(d.ok, true);
    assert.equal(d.circuit, "1");
    assert.match(d.label, /Diagnosis · R-410A · ac cooling · circuit 1/);
    assert.deepEqual(d.measurements.find((m) => m.key === "suctionPsig"), { key: "suctionPsig", label: "Suction pressure (psig)", value: "118" });
    assert.ok(!d.measurements.some((m) => m.key === "refrigerant"), "refrigerant lives in the label, not the table");
    assert.deepEqual(d.derived.find((m) => m.key === "superheatF"), { key: "superheatF", label: "Superheat (°F)", value: "11.9" });
    assert.equal(d.derived.find((m) => m.key === "targetDeltaTF")?.value, "16–22");
    assert.deepEqual(d.validity, { ok: true, issues: [] });
    assert.deepEqual(d.findings, [{ severity: "info", condition: "System within normal ranges" }]);
    assert.equal(d.summary, DIAG_RESULT.summary);
    assert.equal(r[2]!.ok, false);
    assert.match(r[2]!.summary!, /interrupted/);
    assert.equal(r[3]!.ok, false, "no result row: stays pending");
    assert.match(r[3]!.summary!, /No result recorded/);
  });
  test("buildConversationReport: complaint = first user text trimmed to 400, summary = last assistant text, open items from findings", () => {
    const long = "complaint ".repeat(100);
    const rows: MessageRow[] = [
      { id: "a", conversation_id: "c", seq: 1, role: "user", kind: "chat", content_json: "[]", text: long, created_at: "2026-10-12T10:00:00Z" },
      { id: "b", conversation_id: "c", seq: 2, role: "assistant", kind: "chat", content_json: "[]", text: "first answer", created_at: "2026-10-12T10:00:01Z" },
      { id: "c", conversation_id: "c", seq: 3, role: "assistant", kind: "chat", content_json: "[]", text: "last answer", created_at: "2026-10-12T10:00:02Z" },
    ];
    const r = buildConversationReport({
      conversation: { id: "c", title: "t", unit_id: null, summary: null, created_at: "2026-10-12T09:00:00Z", updated_at: "2026-10-12T10:00:02Z" },
      unit: null,
      messages: rows,
      findings: [
        { id: "f1", unit_id: null, conversation_id: "c", symptom: "Fan noisy", cause: null, resolution: null, measurements_json: null, parts_json: null, tags: "fan,noise", circuit: null, status: "open", service_date: null, refrigerant: null, refrigerant_added_lbs: null, refrigerant_recovered_lbs: null, follow_up: "Order bearing", origin: "assistant", confirmed: 0, created_at: "2026-10-12T10:00:00Z" },
        { id: "f2", unit_id: null, conversation_id: "c", symptom: "Fixed thing", cause: null, resolution: "done", measurements_json: null, parts_json: null, tags: null, circuit: null, status: "resolved", service_date: "2026-10-12", refrigerant: null, refrigerant_added_lbs: null, refrigerant_recovered_lbs: null, follow_up: "Tell the customer", origin: "tech", confirmed: 1, created_at: "2026-10-12T10:00:00Z" },
      ],
      now: NOW,
      appVersion: "1.2.3",
    });
    assert.ok(r.complaint!.length <= 400 && r.complaint!.endsWith("…"));
    assert.equal(r.assistantSummary, "last answer");
    assert.deepEqual(r.openItems, ["Open: Fan noisy — Order bearing", "Follow-up: Tell the customer"]);
    assert.deepEqual(r.findings[0]!.tags, ["fan", "noise"]);
    assert.equal(r.findings[0]!.date, "2026-10-12");
    assert.equal(r.unit, null);
  });
});

describe("GET /api/conversations/:id/report", () => {
  test("markdown (default): header, complaint, readings tables, findings, open items, assistant summary kept as markdown", async () => {
    await withServer(async (ctx) => {
      const { convId } = seed(ctx.repos);
      const res = await ctx.get(`/api/conversations/${convId}/report`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^text\/markdown/);
      assert.equal(res.headers.get("content-disposition"), 'inline; filename="hvac-report-rtu-7-2026-10-12.md"');
      const md = await res.text();
      assert.match(md, /^# Service report — RTU-7 no cooling \\\| second stage/);
      assert.match(md, /Generated 2026-10-12 15:30 UTC · HVAC Field Assistant v9\.9\.9/);
      assert.match(md, /- \*\*Site:\*\* Main St <Pharmacy>/);
      assert.match(md, /- \*\*Model:\*\* 48TCDA04A2A5-0A0A0/);
      assert.match(md, /- \*\*Tonnage:\*\* 3 ton/);
      assert.match(md, /- \*\*Manufactured:\*\* 2015-06 \(11\.3 yr\)/);
      assert.match(md, /- \*\*Technician:\*\* ______/);
      assert.match(md, /## Complaint\n\nRTU-7 not cooling <script>alert\(1\)<\/script> since this morning; stat calling\. Breaker is on\./);
      assert.match(md, /### Diagnosis · R-410A · ac cooling · circuit 1 — 2026-10-12/);
      assert.match(md, /\| Suction pressure \(psig\) \| 118 \|/);
      assert.match(md, /\| Superheat \(°F\) \| 11\.9 \|/);
      assert.match(md, /Validity: readings valid for charge determination/);
      assert.match(md, /Findings: info — System within normal ranges/);
      assert.match(md, /### Readings sheet — 2026-10-12/);
      assert.match(md, /### Superheat \/ subcooling · R-410A/);
      assert.match(md, /\| Superheat \(°F\) \| 28\.8 \|/);
      assert.match(md, /## Findings\n\n- \*\*Circuit 2 low suction → Plugged liquid line drier → Replaced drier & recharged\*\* _\(confirmed, monitor, 2026-10-12\)_ — parts: Drier 083S; refrigerant added: 2\.5 lb R-410A; follow-up: Re-check SH in 2 weeks/);
      assert.doesNotMatch(md, /Older unrelated finding/, "findings of other conversations are not listed");
      assert.match(md, /## Open items \/ follow-up\n\n- Monitor: Circuit 2 low suction — Re-check SH in 2 weeks/);
      assert.match(md, /## Assistant summary\n\n## What we know\n\n\*\*Circuit 2 is starved\*\*/);
    });
  });

  test("html: self-contained printable page; every stored string is escaped, the summary is rendered markdown without raw HTML", async () => {
    await withServer(async (ctx) => {
      const { convId } = seed(ctx.repos);
      const res = await ctx.get(`/api/conversations/${convId}/report?format=html`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
      assert.equal(res.headers.get("content-disposition"), 'inline; filename="hvac-report-rtu-7-2026-10-12.html"');
      const html = await res.text();
      assert.match(html, /^<!doctype html>/);
      assert.match(html, /<title>Service report — RTU-7 no cooling \| second stage<\/title>/);
      assert.match(html, /@media print/);
      assert.match(html, /window\.print\(\)/);
      assert.match(html, /Print \/ Save as PDF/);
      assert.doesNotMatch(html, /<(script|link|img)[^>]*\s(src|href)=["']?https?:/i, "no external assets");
      assert.doesNotMatch(html, /<script>alert/);
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.match(html, /Main St &lt;Pharmacy&gt;/);
      assert.match(html, /<strong>Circuit 2 is starved<\/strong>/);
      assert.doesNotMatch(html, /<img/);
      assert.doesNotMatch(html, /javascript:/);
      assert.match(html, /<a href="https:\/\/docs\.carrier\.com\/iom" rel="noopener noreferrer">good link<\/a>/);
      assert.match(html, /<table>/);
      assert.match(html, /<td>Suction pressure \(psig\)<\/td><td>118<\/td>/);
      assert.match(html, /Monitor: Circuit 2 low suction — Re-check SH in 2 weeks/);
      assert.match(html, /Technician signature/);
    });
  });

  test("json: the structured data behind both", async () => {
    await withServer(async (ctx) => {
      const { convId, unitId, findingId } = seed(ctx.repos);
      const res = await ctx.get(`/api/conversations/${convId}/report?format=json`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      const j = (await res.json()) as ConversationReport;
      assert.equal(j.kind, "conversation");
      assert.equal(j.appVersion, "9.9.9");
      assert.equal(j.generatedAt, NOW.toISOString());
      assert.equal(j.unit?.id, unitId);
      assert.equal(j.unit?.tag, "RTU-7");
      assert.equal(j.unit?.manufactureDate, "2015-06");
      assert.equal(j.readings.length, 3);
      assert.equal(j.findings.length, 1);
      assert.equal(j.findings[0]!.id, findingId);
      assert.deepEqual(j.findings[0]!.parts, ["Drier 083S"]);
      assert.equal(j.complaint!.includes("<script>"), true, "json carries the raw text; escaping is the renderer's job");
    });
  });

  test("conversation without a unit, without messages", async () => {
    await withServer(async (ctx) => {
      const conv = ctx.repos.conversations.create({ title: "Empty" });
      const md = await (await ctx.get(`/api/conversations/${conv.id}/report`)).text();
      assert.match(md, /No unit attached to this conversation/);
      assert.match(md, /_No complaint recorded\._/);
      assert.match(md, /_No readings or diagnoses in this conversation\._/);
      assert.match(md, /_No assistant reply yet\._/);
      const res = await ctx.get(`/api/conversations/${conv.id}/report?format=html`);
      assert.equal(res.headers.get("content-disposition"), 'inline; filename="hvac-report-empty-2026-10-12.html"');
    });
  });

  test("errors: bad format 400, bad id 400, unknown id 404, auth 401", async () => {
    await withServer(async (ctx) => {
      const { convId } = seed(ctx.repos);
      const bad = await ctx.get(`/api/conversations/${convId}/report?format=pdf`);
      assert.equal(bad.status, 400);
      assert.equal(((await bad.json()) as { error: { code: string } }).error.code, "validation");
      assert.equal((await ctx.get("/api/conversations/nope/report")).status, 400);
      assert.equal((await ctx.get("/api/conversations/0123456789abcdef/report")).status, 404);
      assert.equal((await ctx.get("/api/units/0123456789abcdef/report")).status, 404);
    });
    await withServer(async (ctx) => {
      const { convId, unitId } = seed(ctx.repos);
      assert.equal((await ctx.get(`/api/conversations/${convId}/report`)).status, 401);
      assert.equal((await ctx.get(`/api/units/${unitId}/report?format=html`)).status, 401);
      const ok = await ctx.get(`/api/units/${unitId}/report`, { headers: { Authorization: "Bearer s3cret" } });
      assert.equal(ok.status, 200);
    }, { appPassword: "s3cret" });
  });
});

describe("GET /api/units/:id/report", () => {
  test("markdown: nameplate, findings grouped by date (newest first), corrections, last 5 conversations", async () => {
    await withServer(async (ctx) => {
      const { unitId } = seed(ctx.repos);
      for (let i = 0; i < 7; i++) ctx.repos.conversations.create({ title: `Visit ${i}`, unit_id: unitId });
      ctx.repos.corrections.create({ unit_id: unitId, field: "tonnage", app_value: "3", actual_value: "4", note: "nameplate says 4", model: CARRIER_MODEL, serial: CARRIER_SERIAL, manufacturer: "Carrier", pack_id: "carrier", format_id: null, applied: true });
      const res = await ctx.get(`/api/units/${unitId}/report`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-disposition"), 'inline; filename="hvac-unit-rtu-7-2026-10-12.md"');
      const md = await res.text();
      assert.match(md, /^# Unit report — RTU-7/);
      assert.match(md, /## Nameplate\n\n- \*\*Site:\*\* Main St <Pharmacy>/);
      assert.match(md, /- \*\*Serial:\*\* 1523G12345/);
      assert.match(md, /- \*\*Family:\*\* 48TC WeatherMaker packaged rooftop/);
      assert.match(md, /- \*\*Decoder warnings:\*\* Serial year digits: confirm on the nameplate/);
      assert.match(md, /## Findings \(2, 1 open\)/);
      const d1 = md.indexOf("### 2026-10-12");
      const d2 = md.indexOf("### 2025-06-01");
      assert.ok(d1 > 0 && d2 > d1, "newest date first");
      assert.match(md, /Older unrelated finding/);
      assert.match(md, /## Corrections\n\n- 2026-10-12 · \*\*tonnage\*\*: app said 3 → actually 4 \(unit updated\) — nameplate says 4/);
      assert.match(md, /## Recent conversations \(5 of 8\)/);
      assert.equal((md.match(/^- 2026-10-12 — /gm) ?? []).length, 5);
      const j = (await (await ctx.get(`/api/units/${unitId}/report?format=json`)).json()) as UnitReport;
      assert.equal(j.kind, "unit");
      assert.equal(j.conversations.length, 5);
      assert.equal(j.totals.conversations, 8);
      assert.equal(j.corrections[0]!.applied, true);
      const html = await (await ctx.get(`/api/units/${unitId}/report?format=html`)).text();
      assert.match(html, /<title>Unit report — RTU-7<\/title>/);
      assert.match(html, /Main St &lt;Pharmacy&gt;/);
      assert.match(html, /@media print/);
    });
  });
});
