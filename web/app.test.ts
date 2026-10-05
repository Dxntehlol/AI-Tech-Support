/* Tests for the web client's pure helpers (globalThis.HVAC_UI) and the tap-target CSS contract.
 * Run: node --disable-warning=ExperimentalWarning --test web/app.test.ts
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// app.js is a plain script that publishes its helpers on globalThis.HVAC_UI; boot() is skipped without a DOM.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let UI: any;
before(async () => {
  const mod = "./app.js";
  await import(mod);
  UI = (globalThis as { HVAC_UI?: unknown }).HVAC_UI;
  assert.ok(UI, "HVAC_UI not exported");
});

/** A fake ReadableStreamDefaultReader fed from a script of chunks / hangs. */
function fakeReader(script: (string | "hang")[]) {
  const enc = new TextEncoder();
  let i = 0;
  let cancelled = 0;
  const reads: number[] = [];
  return {
    cancelled: () => cancelled,
    reads,
    read(): Promise<{ value?: Uint8Array; done: boolean }> {
      reads.push(i);
      const step = script[i++];
      if (step === undefined) return Promise.resolve({ done: true });
      if (step === "hang") return new Promise(() => {});
      return Promise.resolve({ value: enc.encode(step), done: false });
    },
    cancel() {
      cancelled += 1;
      return Promise.resolve();
    },
  };
}

/** Manual timers so the watchdog can be fired deterministically. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let id = 0;
  return {
    setTimeout(fn: () => void, _ms: number) {
      pending.set(++id, fn);
      return id;
    },
    clearTimeout(t: number) {
      pending.delete(t);
    },
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    armed: () => pending.size,
  };
}

describe("pumpSse — heartbeat watchdog (finding: half-open SSE)", () => {
  test("delivers events and the terminal event; heartbeats are ignored", async () => {
    const reader = fakeReader([
      'data: {"type":"delta","text":"Hel"}\n\n',
      ": ping\n\n",
      'data: {"type":"delta","text":"lo"}\n\ndata: {"type":"done","conversationId":"c1","messageIds":[]}\n\n',
    ]);
    const seen: string[] = [];
    const out = await UI.pumpSse(reader, (ev: { type: string }) => seen.push(ev.type), { idleMs: 1000 });
    assert.deepEqual(seen, ["delta", "delta", "done"]);
    assert.equal(out.terminal.type, "done");
    assert.equal(out.idle, false);
    assert.equal(reader.cancelled(), 0);
  });

  test("a stream that goes silent is cancelled and reported idle instead of hanging", async () => {
    const timers = fakeTimers();
    const reader = fakeReader(['data: {"type":"delta","text":"partial"}\n\n', "hang"]);
    const seen: string[] = [];
    const p = UI.pumpSse(reader, (ev: { type: string }) => seen.push(ev.type), { idleMs: 45000, timers });
    // Let the first chunk be consumed and the second read() hang with a watchdog armed.
    await new Promise((r) => setImmediate(r));
    assert.equal(timers.armed(), 1, "watchdog armed while read() is pending");
    timers.fire();
    const out = await p;
    assert.deepEqual(seen, ["delta"]);
    assert.equal(out.terminal, null);
    assert.equal(out.idle, true);
    assert.equal(reader.cancelled(), 1, "reader cancelled so the fetch does not linger");
  });

  test("every received chunk (including a bare heartbeat) re-arms the watchdog", async () => {
    const timers = fakeTimers();
    const reader = fakeReader([": ping\n\n", ": ping\n\n", 'data: {"type":"done","conversationId":"c","messageIds":[]}\n\n']);
    const out = await UI.pumpSse(reader, () => {}, { idleMs: 45000, timers });
    assert.equal(out.idle, false);
    assert.equal(out.terminal.type, "done");
    assert.equal(timers.armed(), 0, "no timer left armed after the stream ends");
    assert.equal(reader.reads.length, 4);
  });

  test("a rejected read (AbortError from Stop) propagates and clears the watchdog", async () => {
    const timers = fakeTimers();
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const reader = { read: () => Promise.reject(err), cancel: () => Promise.resolve() };
    await assert.rejects(UI.pumpSse(reader, () => {}, { idleMs: 1000, timers }), (e: Error) => e.name === "AbortError");
    assert.equal(timers.armed(), 0);
  });

  test("default idle timeout is comfortably above the server's 15 s heartbeat", () => {
    assert.ok(UI.SSE_IDLE_MS >= 30000 && UI.SSE_IDLE_MS <= 90000, String(UI.SSE_IDLE_MS));
  });
});

describe("dropLocalEcho — composer kept until the server accepts (finding: lost text on 409/4xx)", () => {
  test("removes only the optimistic echo", () => {
    const msgs = [
      { id: "a1", seq: 1, role: "user", text: "old" },
      { id: "local-1", seq: 0, role: "user", text: "typed" },
    ];
    const out = UI.dropLocalEcho(msgs, "local-1");
    assert.deepEqual(out.map((m: { id: string }) => m.id), ["a1"]);
    assert.equal(msgs.length, 2, "input is not mutated");
  });
  test("is a no-op when the echo is already gone", () => {
    const msgs = [{ id: "a1", seq: 1, role: "user", text: "old" }];
    assert.deepEqual(UI.dropLocalEcho(msgs, "local-9"), msgs);
  });
});

describe("conversationFingerprint — reconcile re-renders only on change (finding: visibilitychange scroll jump)", () => {
  const base = () => ({
    conversation: { id: "c1", title: "RTU-7 no cooling", updated_at: "2026-09-26T10:00:00Z" },
    unit: { id: "u1", updated_at: "2026-09-01T00:00:00Z" },
    busy: false,
    messages: [
      { id: "m1", seq: 1, role: "user", text: "hi", createdAt: "2026-09-26T10:00:00Z" },
      { id: "m2", seq: 2, role: "assistant", text: "hello", createdAt: "2026-09-26T10:00:05Z", tools: [{ id: "t1" }] },
    ],
  });

  test("identical payloads fingerprint the same (so nothing re-renders)", () => {
    assert.equal(UI.conversationFingerprint(base()), UI.conversationFingerprint(base()));
  });
  test("a new message, busy flag, title, unit or folded tool result changes it", () => {
    const a = UI.conversationFingerprint(base());
    const withMsg = base();
    withMsg.messages.push({ id: "m3", seq: 3, role: "user", text: "more", createdAt: "2026-09-26T10:01:00Z" });
    assert.notEqual(UI.conversationFingerprint(withMsg), a);
    const busy = base();
    busy.busy = true;
    assert.notEqual(UI.conversationFingerprint(busy), a);
    const title = base();
    title.conversation.title = "Renamed";
    assert.notEqual(UI.conversationFingerprint(title), a);
    const unit = base();
    unit.unit = { id: "u2", updated_at: "" };
    assert.notEqual(UI.conversationFingerprint(unit), a);
    const tools = base();
    (tools.messages[1] as { tools: unknown[] }).tools = [];
    assert.notEqual(UI.conversationFingerprint(tools), a);
    const noUnit = base();
    (noUnit as { unit: unknown }).unit = null;
    assert.notEqual(UI.conversationFingerprint(noUnit), a);
  });
  test("a local echo differs from the server's row for the same text", () => {
    const local = base();
    local.messages.push({ id: "local-1", seq: 0, role: "user", text: "sent", createdAt: "x" });
    const server = base();
    server.messages.push({ id: "abcd1234abcd1234", seq: 3, role: "user", text: "sent", createdAt: "x" });
    assert.notEqual(UI.conversationFingerprint(local), UI.conversationFingerprint(server));
  });
  test("tolerates missing fields", () => {
    assert.equal(typeof UI.conversationFingerprint({}), "string");
    assert.equal(UI.conversationFingerprint({ messages: null }), UI.conversationFingerprint({}));
  });
});

describe("serverReachable / healthRetryDelay — sticky 'server unreachable' banner (finding)", () => {
  const res = (status: number, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers) });
  test("any real HTTP response, including errors, proves the server is up", () => {
    assert.equal(UI.serverReachable(res(200)), true);
    assert.equal(UI.serverReachable(res(404)), true);
    assert.equal(UI.serverReachable(res(409)), true);
    assert.equal(UI.serverReachable(res(500)), true);
  });
  test("service-worker cache hits and offline 503 stubs do not count", () => {
    assert.equal(UI.serverReachable(res(200, { "x-hvac-cache": "hit" })), false);
    assert.equal(UI.serverReachable(res(503)), false);
    assert.equal(UI.serverReachable(null), false);
  });
  test("retry backoff doubles from 5 s and caps at 60 s", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map((n) => UI.healthRetryDelay(n)), [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
    assert.equal(UI.healthRetryDelay(undefined), 5000);
    assert.equal(UI.healthRetryDelay(-3), 5000);
  });
});

describe("styles.css — tap targets (finding: undersized buttons override the coarse-pointer rule)", () => {
  const css = readFileSync(join(here, "styles.css"), "utf8");
  /** First declaration block for an exact selector (outside any @media unless `inMedia`). */
  const block = (selector: string, inMedia?: string) => {
    const src = inMedia ? css.slice(css.indexOf(inMedia)) : css;
    const i = src.indexOf(selector + " {");
    assert.ok(i >= 0, `selector not found: ${selector}`);
    return src.slice(i, src.indexOf("}", i));
  };
  const px = (decl: string, prop: string) => {
    const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*(\\d+)px`).exec(decl);
    return m ? Number(m[1]) : NaN;
  };
  test("search clear button is at least 44 px", () => {
    const b = block(".search-field .clear");
    assert.ok(px(b, "width") >= 44 && px(b, "height") >= 44, b);
    assert.ok(px(block(".search-field input"), "padding") >= 8);
    assert.match(block(".search-field input"), /padding:\s*8px 44px/);
  });
  test("banner dismiss button is at least 44 px", () => {
    const b = block(".banner .icon-btn");
    assert.ok(px(b, "width") >= 44 && px(b, "height") >= 44, b);
  });
  test("remove-photo button is at least 44 px with the disc drawn by ::before", () => {
    const b = block(".preview button");
    assert.ok(px(b, "width") >= 44 && px(b, "height") >= 44, b);
    assert.ok(css.includes(".preview button::before {"));
    // the overflow container leaves room so the corner button is not clipped
    assert.match(block(".image-previews"), /padding:\s*8px 8px/);
  });
  test("segmented controls (effort, usage period) are at least 44 px on coarse pointers", () => {
    const m = /@media \(pointer: coarse\) \{ \.seg span, \.seg-sm span \{([^}]*)\}/.exec(css);
    assert.ok(m, "coarse-pointer .seg-sm override missing");
    assert.ok(px(m![1]!, "min-height") >= 44, m![1]);
    // it must come after the base 40 px rules, or the cascade puts them back
    assert.ok(m!.index > css.indexOf(".seg-sm span {"), "override precedes the base .seg-sm rule");
  });
  test("sheet footer buttons wrap long labels instead of overflowing", () => {
    const b = block(".sheet-foot .btn");
    assert.match(b, /white-space:\s*normal/);
    assert.match(b, /min-width:\s*0/);
  });
  test("composer attach button is at least 44 px on coarse pointers", () => {
    const coarse = css.slice(css.indexOf(".composer-field .icon-btn {"));
    const m = /@media \(pointer: coarse\) \{ \.composer-field \.icon-btn \{([^}]*)\}/.exec(coarse);
    assert.ok(m, "coarse-pointer override missing");
    assert.ok(px(m![1]!, "width") >= 44 && px(m![1]!, "height") >= 44, m![1]);
  });
});

describe("usage formatting helpers", () => {
  test("formatUsd: null, zero, sub-cent, cents, thousands", () => {
    assert.equal(UI.formatUsd(null), "—");
    assert.equal(UI.formatUsd(undefined), "—");
    assert.equal(UI.formatUsd(Number.NaN), "—");
    assert.equal(UI.formatUsd(0), "$0.00");
    assert.equal(UI.formatUsd(0.0004), "< $0.01");
    assert.equal(UI.formatUsd(0.426), "$0.43");
    assert.equal(UI.formatUsd(12.5), "$12.50");
    assert.equal(UI.formatUsd(1234.4), "$1,234");
  });
  test("formatTokens: compact K/M", () => {
    assert.equal(UI.formatTokens(0), "0");
    assert.equal(UI.formatTokens(-5), "0");
    assert.equal(UI.formatTokens(950), "950");
    assert.equal(UI.formatTokens(1000), "1K");
    assert.equal(UI.formatTokens(1250), "1.3K");
    assert.equal(UI.formatTokens(48_200), "48K");
    assert.equal(UI.formatTokens(1_500_000), "1.5M");
    assert.equal(UI.formatTokens(23_000_000), "23M");
    assert.equal(UI.formatCount(12345.6), "12,346");
    assert.equal(UI.formatCount("x"), "0");
  });
  test("barWidths scales to the max, floors tiny positives, zeroes nulls", () => {
    assert.deepEqual(UI.barWidths([0, 5, 10, null, -1]), [0, 50, 100, 0, 0]);
    assert.deepEqual(UI.barWidths([1, 1000]), [2, 100]);
    assert.deepEqual(UI.barWidths([0, null]), [0, 0]);
    assert.deepEqual(UI.barWidths([]), []);
    assert.deepEqual(UI.barWidths([1, 3]), [33.3, 100]);
  });
  test("usageDayLabel reads YYYY-MM-DD as a local date", () => {
    assert.equal(UI.usageDayLabel("2026-10-05"), "Mon 5 Oct");
    assert.equal(UI.usageDayLabel("2026-01-01"), "Thu 1 Jan");
    assert.equal(UI.usageDayLabel("garbage"), "garbage");
  });
  test("usageDayRows: newest first, cost metric when priced, empty days hidden past 7 days", () => {
    const summary = {
      days: 30,
      totals: { estimatedCostUsd: 0.3 },
      byDay: [
        { date: "2026-10-01", requests: 2, estimatedCostUsd: 0.1 },
        { date: "2026-10-02", requests: 0, estimatedCostUsd: 0 },
        { date: "2026-10-03", requests: 4, estimatedCostUsd: 0.2 },
        ...Array.from({ length: 5 }, (_, i) => ({ date: `2026-10-0${4 + i}`, requests: 0, estimatedCostUsd: 0 })),
      ],
    };
    const r = UI.usageDayRows(summary);
    assert.equal(r.metric, "cost");
    assert.equal(r.hidden, 6);
    assert.deepEqual(r.rows.map((x: { date: string; width: number }) => [x.date, x.width]), [["2026-10-03", 100], ["2026-10-01", 50]]);
    const week = UI.usageDayRows({ totals: { estimatedCostUsd: null }, byDay: summary.byDay.slice(0, 3) });
    assert.equal(week.metric, "requests");
    assert.equal(week.hidden, 0);
    assert.deepEqual(week.rows.map((x: { width: number }) => x.width), [100, 0, 50]);
    assert.deepEqual(UI.usageDayRows(null).rows, []);
  });
});

describe("AI connection helpers", () => {
  test("aiStatusCopy: live, demo without key, demo forced by CLAUDE_FAKE", () => {
    const live = UI.aiStatusCopy({ demo: false, model: "claude-opus-5", effort: "high", webSearch: true });
    assert.equal(live.tone, "ok");
    assert.equal(live.label, "Live");
    assert.equal(live.detail, "claude-opus-5 · effort high · web search on");
    const demo = UI.aiStatusCopy({ demo: true, fakeForced: false });
    assert.equal(demo.label, "Demo mode");
    assert.match(demo.detail, /API key/);
    assert.match(UI.aiStatusCopy({ demo: true, fakeForced: true }).detail, /CLAUDE_FAKE=1/);
    assert.equal(UI.aiStatusCopy(null).tone, "muted");
  });
  test("apiKeyFieldCopy shows the hint, never a key", () => {
    assert.equal(UI.apiKeyFieldCopy({ keySource: "settings", keyHint: "…a1b2" }).placeholder, "Saved key …a1b2");
    assert.match(UI.apiKeyFieldCopy({ keySource: "env", keyHint: "…zz99" }).placeholder, /…zz99/);
    assert.match(UI.apiKeyFieldCopy({ keySource: "profile", keyHint: null }).hint, /ant auth login/);
    assert.equal(UI.apiKeyFieldCopy({ keySource: "none", keyHint: null }).placeholder, "sk-ant-…");
  });
  test("apiKeyProblem mirrors the server rule", () => {
    assert.equal(UI.apiKeyProblem(""), "");
    assert.equal(UI.apiKeyProblem("  sk-ant-test-0000000000000000KEY1\n"), "");
    assert.match(UI.apiKeyProblem("sk-proj-abc"), /sk-ant-/);
    assert.match(UI.apiKeyProblem("sk-ant-test 000000000000000000"), /spaces/);
    assert.match(UI.apiKeyProblem("sk-ant-short"), /short/);
    assert.match(UI.apiKeyProblem("sk-ant-" + "x".repeat(300)), /long/);
  });
  test("mergeModelLists dedupes and always includes the current model", () => {
    assert.deepEqual(UI.mergeModelLists(["a", "b"], ["b", "c"], "d"), ["a", "b", "c", "d"]);
    assert.deepEqual(UI.mergeModelLists(null, undefined, "a"), ["a"]);
    assert.deepEqual(UI.mergeModelLists(["a"], [], ""), ["a"]);
  });
  test("testResultCopy maps every code to a title and tone", () => {
    const ok = UI.testResultCopy({ ok: true, code: "ok", model: "claude-opus-5", latencyMs: 1234, message: "OK" });
    assert.equal(ok.tone, "ok");
    assert.equal(ok.title, "Connected");
    assert.equal(ok.body, "claude-opus-5 answered in 1.2 s. The assistant is ready.");
    for (const code of ["invalid_key", "permission", "billing", "network", "unknown"]) {
      const c = UI.testResultCopy({ ok: false, code, model: "m", latencyMs: 5, message: "Plain sentence." });
      assert.equal(c.tone, "danger", code);
      assert.equal(c.body, "Plain sentence.");
      assert.ok(c.title && c.title !== "Connected");
    }
    for (const code of ["rate_limited", "overloaded", "no_key"]) assert.equal(UI.testResultCopy({ ok: false, code, message: "x" }).tone, "warn");
    assert.equal(UI.testResultCopy({ ok: false, code: "weird", message: "x" }).title, "Test failed");
    assert.equal(UI.testResultCopy(null).tone, "danger");
  });
  test("testResultCopy: a typed, unsaved key that works says to tap Save, not that the assistant is ready", () => {
    const r = { ok: true, code: "ok", model: "claude-opus-5-5", latencyMs: 900 };
    const typed = UI.testResultCopy(r, { typedKey: true });
    assert.equal(typed.tone, "ok");
    assert.equal(typed.title, "Key works");
    assert.equal(typed.body, "claude-opus-5-5 answered in 0.9 s. Tap Save to use this key.");
    assert.doesNotMatch(typed.body, /ready/);
    assert.equal(typed.saveHint, true);
    const saved = UI.testResultCopy(r);
    assert.equal(saved.body, "claude-opus-5-5 answered in 0.9 s. The assistant is ready.");
    assert.equal(saved.saveHint, false);
    // a failed test of a typed key is not a save hint
    assert.equal(UI.testResultCopy({ ok: false, code: "invalid_key", message: "x" }, { typedKey: true }).saveHint, false);
  });
  test("testResultCopy: phone → server failure blames the server link, not Anthropic", () => {
    const c = UI.testResultCopy({ ok: false, code: "server_unreachable", message: "Network error: Failed to fetch" });
    assert.equal(c.title, "Can't reach the server");
    assert.match(c.body, /can't reach the HVAC server/);
    assert.doesNotMatch(c.title + c.body, /Anthropic|Failed to fetch/);
    assert.equal(c.tone, "warn");
    // the server's own "network" result still names Anthropic
    assert.equal(UI.testResultCopy({ ok: false, code: "network", message: "x" }).title, "Can't reach Anthropic");
  });
  test("demoBannerMode: settings view wins, forced demo, stale cached config ignored when unreachable", () => {
    assert.equal(UI.demoBannerMode({ ai: { demo: false }, configDemo: true }), null);
    assert.equal(UI.demoBannerMode({ ai: { demo: true, fakeForced: false } }), "demo");
    assert.equal(UI.demoBannerMode({ ai: { demo: true, fakeForced: true } }), "forced");
    assert.equal(UI.demoBannerMode({ health: { demo: true } }), "demo");
    assert.equal(UI.demoBannerMode({ health: { demo: false }, configDemo: true }), null);
    // no live data and the server is down: the cached config.js may predate a saved key
    assert.equal(UI.demoBannerMode({ unreachable: true, configDemo: true }), null);
    assert.equal(UI.demoBannerMode({ unreachable: false, configDemo: true }), "demo");
    assert.equal(UI.demoBannerMode({ configDemo: false }), null);
    assert.equal(UI.demoBannerMode(undefined), null);
  });
  test("correctionsExportToast: a cancelled share sheet does not claim success", () => {
    assert.equal(UI.correctionsExportToast("saved", "hvac-corrections-2026-10-05.json"), "Exported hvac-corrections-2026-10-05.json");
    const c = UI.correctionsExportToast("cancelled", "hvac-corrections-2026-10-05.json");
    assert.doesNotMatch(c, /^Exported/);
    assert.match(c, /cancelled/);
    assert.match(c, /export again/);
  });
  test("testResultCopy offers 'Use <model>' only for model_unavailable with alternatives", () => {
    const r = { ok: false, code: "model_unavailable", model: "claude-opus-5", message: "Not available.", suggestion: "Pick claude-opus-5-5.", availableModels: ["claude-opus-5", "claude-opus-5-5"] };
    const c = UI.testResultCopy(r);
    assert.equal(c.useModel, "claude-opus-5-5");
    assert.equal(c.suggestion, "Pick claude-opus-5-5.");
    assert.equal(UI.testResultCopy({ ...r, availableModels: [] }).useModel, null);
    assert.equal(UI.testResultCopy({ ...r, code: "billing" }).useModel, null);
    assert.deepEqual(UI.EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("fleet import + decode corrections helpers", () => {
  test("importTemplateText has the Model, Serial, Site, Tag header and example rows", () => {
    const lines = UI.importTemplateText().trim().split("\n");
    assert.equal(lines[0], "Model,Serial,Site,Tag");
    assert.ok(lines.length >= 2);
    for (const l of lines) assert.equal(l.split(",").length, 4, l);
  });
  test("importSummaryText pluralizes and omits zero duplicates/errors", () => {
    assert.equal(UI.importSummaryText({ new: 12, duplicate: 2, error: 1 }), "12 new · 2 duplicates · 1 error");
    assert.equal(UI.importSummaryText({ new: 1, duplicate: 1, error: 3 }), "1 new · 1 duplicate · 3 errors");
    assert.equal(UI.importSummaryText({ new: 5, duplicate: 0, error: 0 }), "5 new");
    assert.equal(UI.importSummaryText({ new: 0, duplicate: 4 }), "0 new · 4 duplicates");
    assert.equal(UI.importSummaryText(null), "0 new");
  });
  test("importButtonLabel", () => {
    assert.equal(UI.importButtonLabel(12), "Import 12 units");
    assert.equal(UI.importButtonLabel(1), "Import 1 unit");
    assert.equal(UI.importButtonLabel(0), "Nothing new");
    assert.equal(UI.importButtonLabel(undefined), "Nothing new");
  });
  test("importRowText: title = tag or model, subtitle = manufacturer · tonnage · refrigerant · age", () => {
    const row = {
      index: 0,
      input: { model: "48TCDD08A2A5", serial: "1219C12345", site: "Main St", unit_tag: "RTU-1" },
      decoded: { manufacturer: "Carrier", tonnage: 7.5, refrigerant: "R-410A", ageYears: 6.4, manufactureDate: "2019-03" },
    };
    const t = UI.importRowText(row);
    assert.equal(t.title, "RTU-1");
    assert.equal(t.subtitle, "Carrier · 7.5 ton · R-410A · 6.4 yr");
    assert.equal(t.ident, "48TCDD08A2A5 · S/N 1219C12345 · Main St");
    const noTag = UI.importRowText({ index: 2, input: { model: "YSC060" }, decoded: null });
    assert.equal(noTag.title, "YSC060");
    assert.equal(noTag.subtitle, "");
    assert.equal(noTag.ident, "");
    assert.equal(UI.importRowText({ index: 4, input: {}, decoded: null }).title, "Row 5");
    assert.equal(UI.importRowText({ index: 4, line: 6, input: {}, decoded: null }).title, "Row 6");
    assert.equal(UI.importRowText({ index: 0, input: { model: "X" }, decoded: { manufactureDate: "2010" } }).subtitle, "2010");
  });
  test("canApplyCorrection only for unit-column fields", () => {
    for (const f of ["manufacturer", "tonnage", "voltage", "phase", "refrigerant"]) assert.equal(UI.canApplyCorrection(f), true, f);
    for (const f of ["family", "manufacture_date", "control_platform", "fault_code", "other", "", undefined]) assert.equal(UI.canApplyCorrection(f), false, String(f));
    assert.deepEqual(UI.CORRECTION_FIELDS.map((f: string[]) => f[0]), ["manufacturer", "family", "tonnage", "voltage", "phase", "refrigerant", "manufacture_date", "control_platform", "fault_code", "other"]);
  });
  test("correctionPrefill reads the unit column or the decode", () => {
    const unit = { manufacturer: "Carrier", tonnage: 7.5, voltage: "460", phase: 3, refrigerant: "R-410A", control_platform: "ComfortLink" };
    const decoded = { model: [{ family: "WeatherMaker" }], serial: [{ manufactureDate: "2019-03" }] };
    assert.equal(UI.correctionPrefill("manufacturer", unit, decoded), "Carrier");
    assert.equal(UI.correctionPrefill("tonnage", unit, decoded), "7.5");
    assert.equal(UI.correctionPrefill("phase", unit, decoded), "3");
    assert.equal(UI.correctionPrefill("voltage", unit, decoded), "460");
    assert.equal(UI.correctionPrefill("refrigerant", unit, decoded), "R-410A");
    assert.equal(UI.correctionPrefill("control_platform", unit, decoded), "ComfortLink");
    assert.equal(UI.correctionPrefill("family", unit, decoded), "WeatherMaker");
    assert.equal(UI.correctionPrefill("manufacture_date", unit, decoded), "2019-03");
    assert.equal(UI.correctionPrefill("fault_code", unit, decoded), "");
    assert.equal(UI.correctionPrefill("other", unit, decoded), "");
    assert.equal(UI.correctionPrefill("tonnage", { tonnage: null }, null), "");
    assert.equal(UI.correctionPrefill("family", unit, null), "");
    assert.equal(UI.correctionPrefill("manufacturer", { brand: "Trane" }, null), "Trane");
  });
  test("correctionsExportFilename uses Content-Disposition, else a dated default", () => {
    assert.equal(UI.correctionsExportFilename('attachment; filename="hvac-corrections-2026-10-05.json"'), "hvac-corrections-2026-10-05.json");
    assert.equal(UI.correctionsExportFilename(null, new Date("2026-01-02T10:00:00Z")), "hvac-corrections-2026-01-02.json");
    assert.equal(UI.correctionsExportFilename('attachment; filename="../evil path.json"', new Date("2026-01-02T10:00:00Z")), "hvac-corrections-2026-01-02.json");
  });
  test("parseHash routes the import and correct sheets", () => {
    const id = "0123456789abcdef";
    assert.equal(UI.parseHash("#units/import").sheet, "import");
    const r = UI.parseHash(`#unit/${id}/correct`);
    assert.equal(r.sheet, "correct");
    assert.equal(r.unit, id);
    assert.equal(UI.parseHash("#unit/nope/correct").sheet, null);
  });
});
