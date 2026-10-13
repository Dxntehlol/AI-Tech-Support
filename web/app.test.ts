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

describe("service reports — client helpers", () => {
  test("truncateText + filenameFromDisposition + reportFilename", () => {
    assert.equal(UI.truncateText("  a   b\nc ", 50), "a b c");
    assert.ok(UI.truncateText("word ".repeat(50), 30).endsWith("…"));
    assert.ok(UI.truncateText("word ".repeat(50), 30).length <= 30);
    assert.equal(UI.filenameFromDisposition('inline; filename="hvac-report-rtu-7-2026-10-12.html"'), "hvac-report-rtu-7-2026-10-12.html");
    assert.equal(UI.filenameFromDisposition('inline; filename="../x.html"'), null);
    assert.equal(UI.filenameFromDisposition(null), null);
    const now = new Date("2026-10-12T15:30:00Z");
    assert.equal(UI.reportFilename("conversation", "RTU-7 / Kitchen", "md", now), "hvac-report-rtu-7-kitchen-2026-10-12.md");
    assert.equal(UI.reportFilename("unit", "", "html", now), "hvac-unit-untitled-2026-10-12.html");
    assert.equal(UI.reportFilename("unit", "Ünïcode", "json", now), "hvac-unit-unicode-2026-10-12.json");
  });
  test("reportSharePayload: compact plain text from the JSON report, no markdown, no HTML", () => {
    const report = {
      kind: "conversation",
      conversation: { title: "RTU-7 no cooling", createdAt: "2026-10-12T10:00:00Z" },
      unit: { tag: "RTU-7", nickname: null, manufacturer: "Carrier", model: "48TCDA04", site: "Main St" },
      complaint: "Not cooling since this morning. ".repeat(20),
      readings: [{ ok: true, derived: [{ key: "superheatF", label: "Superheat (°F)", value: "11.9" }, { key: "subcoolingF", label: "Subcooling (°F)", value: "9.4" }, { key: "evapSatF", label: "Evap", value: "40" }], validity: { ok: false, issues: ["low ambient"] } }],
      findings: [{ symptom: "Low suction", cause: "Plugged drier", resolution: "Replaced", confirmed: true }, { symptom: "Fan noise", cause: null, resolution: null, confirmed: false }],
      openItems: ["Open: Fan noise — order bearing"],
      assistantSummary: "## heading **bold**",
    };
    const p = UI.reportSharePayload(report);
    assert.equal(p.title, "Service report — RTU-7 no cooling");
    assert.equal(p.url, undefined);
    const lines = p.text.split("\n");
    assert.equal(lines[0], "Service report: RTU-7 no cooling (2026-10-12)");
    assert.equal(lines[1], "Unit: RTU-7 — Carrier 48TCDA04 — Main St");
    assert.match(p.text, /Complaint: Not cooling since this morning\./);
    assert.ok(p.text.split("\n").find((l: string) => l.startsWith("Complaint:"))!.length <= 260);
    assert.match(p.text, /Readings: Superheat 11\.9, Subcooling 9\.4 \(not valid for charge\)/);
    assert.match(p.text, /- Low suction → Plugged drier → Replaced\n- Fan noise \(unconfirmed\)/);
    assert.match(p.text, /Open items:\n- Open: Fan noise — order bearing/);
    assert.doesNotMatch(p.text, /heading|\*\*|<|>/);
    const withUrl = UI.reportSharePayload(report, "https://x/#chat/1");
    assert.equal(withUrl.url, "https://x/#chat/1");
    const unitReport = { kind: "unit", unit: { tag: null, nickname: null, model: "YSC060", serial: "S1", tonnage: 5, refrigerant: "R-410A", manufactureDate: "2019-03" }, findingsByDate: [{ date: "2026-10-12", findings: [{ date: "2026-10-12", symptom: "A", cause: "B", resolution: "C", status: "resolved" }] }, { date: "2025-01-01", findings: [{ date: "2025-01-01", symptom: "D", status: "open" }] }] };
    const u = UI.reportSharePayload(unitReport);
    assert.equal(u.title, "Unit report — YSC060");
    assert.match(u.text, /^Unit report: YSC060 — YSC060\nS\/N S1 · 5 ton · R-410A · mfd 2019-03\n\nFindings \(2\):\n- 2026-10-12 A → B → C\n- 2025-01-01 D \[open\]$/);
    assert.equal(UI.reportShareText(null), "");
  });
});

describe("QR labels — client helpers", () => {
  test("appBaseUrl + unitUrl: absolute #unit link for this install", () => {
    const id = "0123456789abcdef";
    assert.equal(UI.unitUrl(UI.appBaseUrl({ origin: "https://shop-pc.tail1234.ts.net", pathname: "/" }), id), `https://shop-pc.tail1234.ts.net/#unit/${id}`);
    assert.equal(UI.unitUrl(UI.appBaseUrl({ origin: "http://127.0.0.1:8787", pathname: "/index.html" }), id), `http://127.0.0.1:8787/#unit/${id}`);
    assert.equal(UI.unitUrl(UI.appBaseUrl({ origin: "https://h.example.com", pathname: "/app/" }), id), `https://h.example.com/app/#unit/${id}`);
    assert.equal(UI.unitUrl("https://x.y/", id), `https://x.y/#unit/${id}`);
  });
  test("labelText: tag/nickname title, site · customer, manufacturer model, S/N (max 3 lines)", () => {
    assert.deepEqual(UI.labelText({ unit_tag: "RTU-7", nickname: "Kitchen", site: "Main St", customer: "Acme", manufacturer: "Carrier", model: "48TCDA04", serial: "1523G12345" }), { title: "RTU-7 · Kitchen", lines: ["Main St · Acme", "Carrier 48TCDA04", "S/N 1523G12345"] });
    assert.deepEqual(UI.labelText({ model: "YSC060" }), { title: "YSC060", lines: [] });
    assert.deepEqual(UI.labelText({ model: "YSC060", brand: "York" }), { title: "YSC060", lines: ["York YSC060"] });
    assert.deepEqual(UI.labelText(null), { title: "Unit", lines: [] });
  });
  test("qrPathFromMatrix merges horizontal runs into unit-square rectangles", () => {
    assert.equal(UI.qrPathFromMatrix(["1101", "0000", "1111"]), "M0 0h2v1h-2zM3 0h1v1h-1zM0 2h4v1h-4z");
    assert.equal(UI.qrPathFromMatrix([[true, false], [false, true]]), "M0 0h1v1h-1zM1 1h1v1h-1z");
    assert.equal(UI.qrPathFromMatrix([]), "");
  });
  test("qrSvgMarkup: crisp black-on-white SVG with a quiet zone", () => {
    const svg = UI.qrSvgMarkup(["10", "01"], { margin: 2, size: 100, title: 'A "quoted" <title>' });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 6 6" shape-rendering="crispEdges"/);
    assert.match(svg, /width="100" height="100"/);
    assert.match(svg, /<rect width="6" height="6" fill="#fff"\/>/);
    assert.match(svg, /<path transform="translate\(2 2\)" d="M0 0h1v1h-1zM1 1h1v1h-1z" fill="#000"\/>/);
    assert.match(svg, /aria-label="A &quot;quoted&quot; &lt;title&gt;"/);
  });
  test("labelsDocumentHtml: self-contained, two columns in print, every string escaped", () => {
    const html = UI.labelsDocumentHtml([{ title: "RTU-7 <b>", lines: ["Main & St"], url: "https://x/#unit/1", matrix: ["1"] }], { heading: "Labels <x>", generatedAt: new Date("2026-10-12T00:00:00Z") });
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>Labels &lt;x&gt;<\/title>/);
    assert.match(html, /@media print \{ \.bar \{ display: none; \} \.labels \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(html, /class="title">RTU-7 &lt;b&gt;</);
    assert.match(html, /class="line">Main &amp; St</);
    assert.match(html, /class="url">https:\/\/x\/#unit\/1</);
    assert.doesNotMatch(html, /<b>/);
    assert.doesNotMatch(html, /src=["']?https?:/);
    assert.match(html, /1 label · 2026-10-12/);
    assert.match(html, /window\.print\(\)/);
  });

  /**
   * Known encodings produced by an independent implementation (python-qrcode 8.2, byte mode, EC level M,
   * forced mask pattern as noted): the vendored encoder must reproduce them module for module. The two encoders
   * pick masks by slightly different penalty heuristics, so the fixtures pin the mask the vendored library chooses.
   */
  const QR_FIXTURES = [
  { text: "RTU-7", mask: 2, rows: [
    "111111100000101111111",
    "100000100111001000001",
    "101110101100101011101",
    "101110101111101011101",
    "101110101100101011101",
    "100000101101001000001",
    "111111101010101111111",
    "000000001110000000000",
    "101111100111001111100",
    "110101011111111001110",
    "100001111010101100110",
    "100110010011111001101",
    "010000100110100101100",
    "000000001000100101110",
    "111111100111010011110",
    "100000101000000110110",
    "101110101011010010010",
    "101110101101111101000",
    "101110101110101101100",
    "100000100001111010100",
    "111111101000100001010",
  ] },
  { text: "https://hvac.example.com/#unit/0123456789abcdef", mask: 2, rows: [
    "111111100010101010111101001111111",
    "100000100011100110100110101000001",
    "101110101101101100011101001011101",
    "101110101010000000110011101011101",
    "101110101111101110001101001011101",
    "100000101001101001110110001000001",
    "111111101010101010101010101111111",
    "000000001101100010011111100000000",
    "101111100011010001010010101111100",
    "101001010011010011110111101101111",
    "000100100001011101001110010010100",
    "100110011110110011101111111011110",
    "101100111110001010001010100011000",
    "110111011000000101100001011100111",
    "010110101000111111001100111110010",
    "001111000101010100000101111000100",
    "110100100010111101000010110111001",
    "100100010010101010111101001101111",
    "101100101110000110100010001110100",
    "101010001010111110001100100111100",
    "011110100000111100110100100011000",
    "101001001010101111001101011100101",
    "100011111011010000010100001001010",
    "101010001001000010011110100000111",
    "101101111101000011110010111111011",
    "000000001001011011111000100010111",
    "111111100010101111000011101010100",
    "100000101111101001100001100011111",
    "101110101010101110001110111111011",
    "101110101101100101100000010011101",
    "101110101001010111001111111100100",
    "100000100111100100000110001010100",
    "111111101100001101101011110101010",
  ] },
  { text: "Hello, World!", mask: 4, rows: [
    "111111101101001111111",
    "100000100101101000001",
    "101110100000001011101",
    "101110101110101011101",
    "101110101110101011101",
    "100000101111001000001",
    "111111101010101111111",
    "000000001011100000000",
    "100010111111011111001",
    "010111000000101101110",
    "111100101001011010010",
    "111101011010010110000",
    "110001111110110000010",
    "000000001010000011011",
    "111111101011011111010",
    "100000100101010110010",
    "101110101111100110000",
    "101110100010011011011",
    "101110100010001111000",
    "100000100101010000000",
    "111111101001010110001",
  ] },
  ];
  test("vendored qrcode.js (web/vendor/qrcode.js, MIT) reproduces known encodings module for module", () => {
    const src = readFileSync(join(here, "vendor", "qrcode.js"), "utf8");
    assert.match(src, /Licensed under the MIT license/);
    assert.ok(readFileSync(join(here, "vendor", "qrcode.LICENSE"), "utf8").includes("MIT"));
    // The file is a classic script (UMD tail); evaluate it with no module system so `var qrcode` is the export.
    const lib = new Function("module", "exports", "define", `${src};return qrcode;`)(undefined, undefined, undefined);
    assert.equal(typeof lib, "function");
    for (const fx of QR_FIXTURES) {
      const m = UI.qrMatrix(fx.text, lib);
      assert.ok(m, fx.text);
      assert.equal(m.length, fx.rows.length, `${fx.text}: size`);
      const rows = m.map((r: boolean[]) => r.map((c) => (c ? "1" : "0")).join(""));
      assert.deepEqual(rows, fx.rows, `${fx.text}: modules differ from the reference (mask ${fx.mask})`);
      // finder pattern top-left, as a sanity check independent of the fixture
      assert.equal(rows[0]!.slice(0, 7), "1111111");
      assert.equal(rows[6]!.slice(0, 7), "1111111");
    }
    assert.equal(UI.qrMatrix("x", null), null, "no library → null");
  });
  test("parseHash routes the share, report, QR and labels sheets", () => {
    const id = "0123456789abcdef";
    assert.deepEqual([UI.parseHash(`#chat/${id}/share`).sheet, UI.parseHash(`#chat/${id}/share`).conv], ["share", id]);
    assert.equal(UI.parseHash(`#unit/${id}/qr`).sheet, "qr");
    assert.equal(UI.parseHash(`#unit/${id}/report`).sheet, "report");
    assert.equal(UI.parseHash("#units/labels").sheet, "labels");
    assert.equal(UI.parseHash("#units/actions").sheet, "unitsActions");
    assert.equal(UI.parseHash("#unit/nope/qr").sheet, null);
    assert.equal(UI.parseHash("#chat/nope/share").sheet, null);
  });
});

describe("native shell — server URL prompt", () => {
  test("serverUrlPrompt: bundled or native origin without a saved base needs the prompt; web installs never do", () => {
    assert.equal(UI.serverUrlPrompt({ configBase: "", savedBase: "", bundled: true, protocol: "https:" }).needed, true);
    assert.equal(UI.serverUrlPrompt({ configBase: "", savedBase: null, bundled: false, protocol: "capacitor:" }).needed, true);
    assert.equal(UI.serverUrlPrompt({ configBase: "", savedBase: "", bundled: false, protocol: "file:" }).needed, true);
    assert.equal(UI.serverUrlPrompt({ configBase: "", savedBase: "https://hvac.example.com", bundled: true, protocol: "capacitor:" }).needed, false);
    assert.equal(UI.serverUrlPrompt({ configBase: "https://hvac.example.com", savedBase: "", bundled: true, protocol: "capacitor:" }).needed, false);
    assert.equal(UI.serverUrlPrompt({ configBase: "", savedBase: "", bundled: false, protocol: "https:" }).needed, false);
    assert.equal(UI.serverUrlPrompt({}).needed, false);
    const p = UI.serverUrlPrompt({ bundled: true });
    assert.match(p.message, /Set your server URL/);
    assert.match(p.message, /Save connection/);
    assert.equal(UI.serverUrlPrompt({}).message, "");
  });
  test("styles.css: unit-card actions keep 44 px targets and the QR label stays black on white", () => {
    const css = readFileSync(join(here, "styles.css"), "utf8");
    assert.match(css, /\.np-actions \.np-report, \.np-actions \.np-unit-report \{[^}]*min-height: 44px/);
    assert.match(css, /\.qr-label \{[^}]*background: #fff;[^}]*color: #111/);
    assert.ok(css.indexOf(".np-actions { grid-template-columns: repeat(4, 1fr); }") > css.indexOf(".np-actions { display: grid;"), "the 4-column override comes after the base rule");
  });
});

// ---------------------------------------------------------------------------
// Readings history + follow-ups (DESIGN.md "Readings history", "Follow-ups")
// ---------------------------------------------------------------------------

describe("readings history helpers", () => {
  const NOW = Date.parse("2026-10-12T12:00:00Z");
  const reading = {
    id: "0123456789abcdef",
    created_at: "2026-10-05T15:20:00Z",
    mode: "ac_cooling",
    refrigerant: "R-410A",
    metering_device: "txv",
    source: "sheet",
    note: "",
    measurements: { outdoorDbF: 88, suctionPsig: 118, liquidPsig: 340, compressorAmps: 20.4, compressorRla: 25, economizerPosition: "closed" },
    derived: { superheatF: 12.3, subcoolingF: 4, deltaTF: 18, ampsPercentRla: 81.6, compressionRatio: 2.667, targetDeltaTF: { min: 15, max: 21 } },
    validity: { ok: true, issues: [] },
  };
  test("readingSummary: date · mode title and SH/SC/ΔT/amps values", () => {
    const s = UI.readingSummary(reading, NOW);
    assert.equal(s.title, "Oct 5 · AC cooling");
    assert.equal(s.values, "SH 12 · SC 4 · ΔT 18 · 20.4 A (82%)");
    assert.equal(s.valid, true);
    assert.equal(s.source, "sheet");
  });
  test("readingSummary: missing numbers show as dashes; % RLA alone; invalid readings flagged; other years dated", () => {
    const s = UI.readingSummary({ created_at: "2025-02-01T10:00:00Z", mode: "heat_pump_heating", measurements: {}, derived: { ampsPercentRla: 70 }, validity: { ok: false, issues: ["x"] }, source: "chat" }, NOW);
    assert.equal(s.title, "Feb 1, 2025 · HP heating");
    assert.equal(s.values, "SH — · SC — · ΔT — · 70% RLA");
    assert.equal(s.valid, false);
    assert.equal(UI.readingSummary({ mode: "refrigeration" }, NOW).values, "SH — · SC — · ΔT — · amps —");
    assert.equal(UI.readingSummary({ mode: "refrigeration" }, NOW).title, "Refrigeration");
  });
  test("readingDetailRows lists entered measurements then derived metrics with units", () => {
    const rows = UI.readingDetailRows(reading);
    const by = Object.fromEntries(rows.map((r: { label: string; value: string }) => [r.label, r.value]));
    assert.equal(by.Refrigerant, "R-410A");
    assert.equal(by.Metering, "TXV");
    assert.equal(by["Outdoor DB"], "88 °F");
    assert.equal(by.Suction, "118 psig");
    assert.equal(by["Amps L1"], "20.4 A");
    assert.equal(by.Economizer, "closed");
    assert.equal(by.Superheat, "12.3 °F");
    assert.equal(by["Comp. ratio"], "2.67");
    assert.equal(by["Target ΔT"], "15–21 °F");
    assert.equal("Amps L2" in by, false, "absent fields are skipped");
    // measurements come before derived
    const labels = rows.map((r: { label: string }) => r.label);
    assert.ok(labels.indexOf("Suction") < labels.indexOf("Superheat"));
    assert.deepEqual(UI.readingDetailRows(null), []);
  });
  test("formatDelta: arrow, short metric name, prev → cur with unit", () => {
    assert.equal(UI.formatDelta({ metric: "subcoolingF", label: "Subcooling", unit: "°F", prev: 12, cur: 4, delta: -8, direction: "down" }), "↓ SC 12 → 4 °F");
    assert.equal(UI.formatDelta({ metric: "ampsPercentRla", unit: "% RLA", prev: 80, cur: 94.5, direction: "up" }), "↑ Amps 80 → 94.5 % RLA");
    assert.equal(UI.formatDelta({ metric: "other", label: "Other", prev: 1, cur: 2, direction: "up" }), "↑ Other 1 → 2");
    assert.equal(UI.formatDelta(null), "");
  });
});

describe("follow-up helpers", () => {
  const TODAY = "2026-09-26";
  test("dueChip: overdue / due today / due soon (7 days) / later / none / done", () => {
    assert.deepEqual(UI.dueChip("2026-09-01", 0, TODAY), { kind: "overdue", label: "Overdue · Sep 1" });
    assert.deepEqual(UI.dueChip("2026-09-26", 0, TODAY), { kind: "soon", label: "Due today" });
    assert.deepEqual(UI.dueChip("2026-10-03", 0, TODAY), { kind: "soon", label: "Due Oct 3" });
    assert.deepEqual(UI.dueChip("2026-10-04", 0, TODAY), { kind: "later", label: "Due Oct 4" });
    assert.deepEqual(UI.dueChip("2027-01-15", 0, TODAY), { kind: "later", label: "Due Jan 15, 2027" });
    assert.deepEqual(UI.dueChip(null, 0, TODAY), { kind: "none", label: "No date" });
    assert.deepEqual(UI.dueChip("2026-09-01", 1, TODAY), { kind: "done", label: "Done" });
    assert.deepEqual(UI.dueChip("2026-09-01", true, TODAY), { kind: "done", label: "Done" });
  });
  test("date helpers are calendar-safe (no timezone shift) and tolerate junk", () => {
    assert.equal(UI.addDaysYmd("2026-12-30", 7), "2027-01-06");
    assert.equal(UI.addDaysYmd("junk", 7), "junk");
    assert.equal(UI.ymdLabel("2026-03-01", "2026-09-26"), "Mar 1");
    assert.equal(UI.ymdLabel("2025-03-01", "2026-09-26"), "Mar 1, 2025");
    assert.equal(UI.ymdLabel("tomorrow", "2026-09-26"), "tomorrow");
    assert.match(UI.localYmd(new Date(2026, 0, 5)), /^2026-01-05$/);
    assert.equal(UI.readingDateLabel("not a date"), "");
  });
  test("parseHash routes the picker and finding sheets", () => {
    const id = "0123456789abcdef";
    const fid = "fedcba9876543210";
    assert.equal(UI.parseHash("#readings/pick").sheet, "pick");
    assert.equal(UI.parseHash("#readings/pick").screen, "readings");
    assert.equal(UI.parseHash("#chat/pick").sheet, "pick");
    const cp = UI.parseHash(`#chat/${id}/pick`);
    assert.equal(cp.sheet, "pick");
    assert.equal(cp.conv, id);
    const add = UI.parseHash(`#unit/${id}/finding`);
    assert.equal(add.sheet, "finding");
    assert.equal(add.unit, id);
    assert.equal(add.finding, null);
    const edit = UI.parseHash(`#unit/${id}/finding/${fid}`);
    assert.equal(edit.sheet, "finding");
    assert.equal(edit.finding, fid);
    assert.equal(UI.parseHash(`#unit/${id}/finding/nope`).finding, null);
    assert.equal(UI.parseHash("#unit/nope/finding").sheet, null);
    assert.equal(UI.parseHash("#chat").sheet, null);
  });
});

describe("styles.css — readings / follow-ups tap targets", () => {
  const css = readFileSync(join(here, "styles.css"), "utf8");
  const block = (selector: string) => {
    const i = css.indexOf(selector + " {");
    assert.ok(i >= 0, `selector not found: ${selector}`);
    return css.slice(i, css.indexOf("}", i));
  };
  const px = (decl: string, prop: string) => {
    const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*(\\d+)px`).exec(decl);
    return m ? Number(m[1]) : NaN;
  };
  test("follow-up Done checkbox and reading expand button are at least 44 px", () => {
    for (const sel of [".fu-check", ".rd-expand"]) {
      const b = block(sel);
      assert.ok(px(b, "width") >= 44 && px(b, "height") >= 44, b);
    }
    assert.ok(px(block(".fu-body"), "min-height") >= 44);
    assert.ok(px(block(".rd-row"), "min-height") >= 44);
  });
  test("due chips carry text, not only color (each kind styles a labelled chip)", () => {
    for (const kind of ["overdue", "soon", "later", "none", "done"]) assert.ok(css.includes(`.due-chip.${kind} {`), kind);
    assert.ok(css.includes(".tab-count {"));
  });
});

// ---------------------------------------------------------------------------
// Wave 2 (DESIGN.md "Web UI"): refrigerant log, PM checklists, chiller mode, job clock + signature,
// field calculators (offline parity with the server), voice dictation, manufacturer support, most likely cause
// ---------------------------------------------------------------------------

describe("refrigerant log helpers", () => {
  const TODAY = "2026-10-13";
  test("lbsFromLbsOz + formatLbs: lb and oz to decimal pounds and back", () => {
    assert.equal(UI.lbsFromLbsOz("12", "4"), 12.25);
    assert.equal(UI.lbsFromLbsOz("", "8"), 0.5);
    assert.equal(UI.lbsFromLbsOz("", ""), null);
    assert.equal(UI.lbsFromLbsOz("x", ""), null);
    assert.deepEqual([UI.formatLbs(12.25), UI.formatLbs(0.5), UI.formatLbs(3), UI.formatLbs(2.999), UI.formatLbs(null)], ["12 lb 4 oz", "8 oz", "3 lb", "3 lb", ""]);
  });
  test("complianceChip: unknown charge / not applicable / exceeded with the 30-day clock / OK", () => {
    assert.equal(UI.complianceChip(null).kind, "unknown");
    assert.equal(UI.complianceChip({ fullChargeLbs: null, applies: false }).label, "Unknown charge");
    assert.equal(UI.complianceChip({ fullChargeLbs: 8, applies: false, thresholdPct: 10 }).label, "Not applicable · 8 lb < 15 lb");
    const ex = UI.complianceChip({ fullChargeLbs: 40, applies: true, exceeded: true, lastLeakRatePct: 45.63, thresholdPct: 10, obligations: [{ kind: "repair", dueDate: "2026-10-20", text: "Repair", overdue: false }] }, TODAY);
    assert.deepEqual([ex.kind, ex.label], ["exceeded", "Exceeded 45.6 % · 7 d to repair"]);
    assert.equal(UI.complianceChip({ fullChargeLbs: 40, applies: true, exceeded: true, lastLeakRatePct: 45.63, thresholdPct: 10, obligations: [{ kind: "repair", dueDate: "2026-10-01", overdue: true }] }, TODAY).label, "Exceeded 45.6 % · repair 12 d overdue");
    // obligations missing or reshaped by the backend: still a readable chip
    assert.equal(UI.complianceChip({ fullChargeLbs: 40, applies: true, exceeded: true, thresholdPct: 10 }, TODAY).label, "Exceeded threshold");
    const ok = UI.complianceChip({ fullChargeLbs: 40, applies: true, exceeded: false, lastLeakRatePct: 3.2, thresholdPct: 10, lastAdd: { date: "2026-10-01" } }, TODAY);
    assert.deepEqual([ok.kind, ok.label], ["ok", "OK · 3.2 %"]);
  });
  test("refrigerantEventText: date · type · lbs · refrigerant, then rate / circuit / cylinder / tech", () => {
    const add = UI.refrigerantEventText({ event_type: "add", amount_lbs: 2.5, refrigerant: "R-410A", date: "2026-10-05", leak_rate_pct: 12.5, threshold_pct: 10, exceeded: true, circuit: 2, cylinder_id: "C-77", tech_name: "J. Tech", tech_cert: "608-U" }, TODAY);
    assert.equal(add.title, "Oct 5 · Added 2 lb 8 oz R-410A");
    assert.equal(add.meta, "12.5 % of 10 % — exceeded · ckt 2 · cyl C-77 · J. Tech (608-U)");
    assert.equal(add.tone, "danger");
    assert.deepEqual(UI.refrigerantEventText({ event_type: "leak_check", date: "2026-10-05", leak_found: true }, TODAY), { title: "Oct 5 · Leak check", meta: "leak found", tone: "warn" });
    assert.equal(UI.refrigerantEventText({ event_type: "verification_followup", date: "2026-10-05", passed: false }, TODAY).meta, "failed");
    assert.equal(UI.refrigerantEventText({ event_type: "repair", created_at: "2026-09-30T10:00:00Z" }, TODAY).title, "Sep 30 · Repair");
  });
  test("obligationChip + export filename + the one-line rule", () => {
    assert.deepEqual(UI.obligationChip({ dueDate: null }, TODAY), { kind: "none", label: "Schedule" });
    assert.deepEqual(UI.obligationChip({ dueDate: "2026-10-01", overdue: true }, TODAY), { kind: "overdue", label: "Overdue · Oct 1" });
    assert.deepEqual(UI.obligationChip({ dueDate: "2026-10-15", overdue: false }, TODAY), { kind: "soon", label: "Due Oct 15" });
    assert.equal(UI.refrigerantExportFilename('attachment; filename="hvac-refrigerant-log-2026-10-13.csv"'), "hvac-refrigerant-log-2026-10-13.csv");
    assert.equal(UI.refrigerantExportFilename('attachment; filename="../evil.sh"', new Date("2026-10-13T12:00:00Z")), "hvac-refrigerant-log-2026-10-13.csv");
    assert.match(UI.LEAK_RATE_RULE_LINE, /lb added ÷ full charge × 365 ÷ days since last add, up to 365 days/);
  });
});

describe("PM checklist helpers", () => {
  const tpl = { id: "t", sections: [{ title: "A", items: [{ id: "a1", kind: "check" }, { id: "a2", kind: "number" }] }, { title: "B", items: [{ id: "b1", kind: "text" }, { id: "b2", kind: "check" }] }] };
  test("pmProgress counts recorded items, an explicit N/A included", () => {
    assert.deepEqual(UI.pmProgress(tpl, { a1: { checked: true, pass: true }, a2: { asFound: 230 }, b2: { checked: null, pass: null }, b1: { value: "" } }), { done: 3, total: 4 });
    assert.deepEqual(UI.pmProgress(tpl, null), { done: 0, total: 4 });
    assert.equal(UI.pmItemDone({ note: "only a note" }), false);
  });
  test("pmCheckPatch / pmItemState: pass, fail, n/a round-trip", () => {
    for (const s of ["pass", "fail"]) assert.equal(UI.pmItemState(UI.pmCheckPatch(s)), s);
    assert.deepEqual(UI.pmCheckPatch("na"), { checked: null, pass: null });
    assert.equal(UI.pmItemState(UI.pmCheckPatch("na")), null);
  });
  test("pmFeedback: inline nameplate comparison from the server summary", () => {
    assert.deepEqual(UI.pmFeedback({ status: "fail", reference: "nameplate 208–230 V ±10 %", deviationPct: -14 }), { text: "Fail · nameplate 208–230 V ±10 % (−14 %)", tone: "danger" });
    assert.deepEqual(UI.pmFeedback({ status: "pass", reference: "45 µF ±6 %", deviationPct: 2.2 }), { text: "Pass · 45 µF ±6 % (+2.2 %)", tone: "ok" });
    assert.deepEqual(UI.pmFeedback({ status: "pass" }), { text: "", tone: "" });
    assert.deepEqual(UI.pmFeedback(null), { text: "", tone: "" });
  });
  test("pmVisitSummaryText: last visit line, counts, flagged / failed / safety labels", () => {
    const s = UI.pmVisitSummaryText({ date: "2026-10-05", template_name: "Packaged RTU — gas heat", status: "complete", tech_name: "J", summary: { total: 30, pass: 20, fail: 3, na: 7, flagged: ["v"], fails: ["v", "f", "s"], safetyFails: ["s"], items: [{ id: "v", label: "Voltage" }, { id: "f", label: "Filters" }, { id: "s", label: "Rollout" }] } }, "2026-10-13");
    assert.equal(s.title, "Oct 5 · Packaged RTU — gas heat");
    assert.equal(s.counts, "20 pass · 3 fail · 7 n/a of 30");
    assert.deepEqual([s.flagged, s.safetyFails, s.status], [["Voltage"], ["Rollout"], "Complete"]);
    assert.equal(UI.pmVisitSummaryText({ summary: null }).counts, "No items recorded");
  });
  test("suggestPmTemplate + orderPmTemplates: the suggestion is listed first and flagged", () => {
    assert.equal(UI.suggestPmTemplate({ heat_type: "gas" }, { model: [{ productType: "packaged_rtu" }] }).templateId, "rtu_gas");
    assert.equal(UI.suggestPmTemplate({}, { model: [{ productType: "chiller", family: "RTHD water-cooled" }] }).templateId, "chiller_water_cooled");
    assert.equal(UI.suggestPmTemplate({ manufacturer: "Hoshizaki" }, null).templateId, "ice_machine");
    assert.equal(UI.suggestPmTemplate({ decoded_json: JSON.stringify({ model: [{ productType: "split_heat_pump" }] }) }).templateId, "heat_pump");
    assert.equal(UI.suggestPmTemplate({}, null).templateId, null);
    assert.deepEqual(UI.orderPmTemplates([{ id: "a" }, { id: "b" }, { id: "c" }], { templateId: "c" }).map((t: { id: string; suggested: boolean }) => `${t.id}${t.suggested ? "*" : ""}`), ["c*", "a", "b"]);
    assert.equal(UI.pmPendingKey("abc"), "hvac.pmPending.abc");
  });
});

describe("chiller mode + most likely cause", () => {
  test("buildChillerMeasurements keeps the chosen condenser side and drops blanks", () => {
    assert.deepEqual(UI.buildChillerMeasurements({ refrigerant: "R-134a", condenserType: "water_cooled", chwSupplyF: "44", chwReturnF: "54", outdoorDbF: "90", condWaterOutF: "95", circuit: "", rla: "" }), { refrigerant: "R-134a", condenserType: "water_cooled", chwSupplyF: 44, chwReturnF: 54, condWaterOutF: 95 });
    assert.deepEqual(UI.buildChillerMeasurements({ condenserType: "air_cooled", outdoorDbF: "90", condWaterOutF: "95" }), { condenserType: "air_cooled", outdoorDbF: 90 });
    assert.equal(UI.chillerHasReadings({ refrigerant: "R-134a" }), false);
    assert.equal(UI.chillerHasReadings({ chwSupplyF: 44 }), true);
  });
  test("composeChillerMessage: compact readings line plus derived values", () => {
    assert.equal(UI.composeChillerMessage({ refrigerant: "R-134a", condenserType: "water_cooled", chwSupplyF: 44, chwReturnF: 54, chwFlowGpm: 240 }, { chwDeltaTF: 10, tons: 100, evapApproachF: 6, ampsPercentRla: 82 }),
      "Chiller readings (chiller, R-134a, water-cooled): CHW 54 in / 44 out °F; flow 240 gpm. Derived: CHW ΔT 10 °F, load 100 tons, evap approach 6 °F, amps 82 % RLA.");
    assert.match(UI.composeChillerMessage({}, null), /no measurements entered/);
  });
  test("chiller readings in the unit history use chiller fields", () => {
    const r = { mode: "chiller", created_at: "2026-10-05T15:00:00Z", measurements: { chwSupplyF: 44, compressorAmps: 210 }, derived: { chwDeltaTF: 9.8, evapApproachF: 6.2, condApproachF: 3 }, source: "sheet" };
    const s = UI.readingSummary(r, Date.parse("2026-10-13T12:00:00Z"));
    assert.equal(s.title, "Oct 5 · Chiller");
    assert.equal(s.values, "ΔT 10 · evap app 6 · cond app 3 · 210 A");
    const by = Object.fromEntries(UI.readingDetailRows(r).map((x: { label: string; value: string }) => [x.label, x.value]));
    assert.equal(by["CHW supply"], "44 °F");
    assert.equal(by["Evap approach"], "6.2 °F");
  });
  test("splitFindings: the top non-info finding is the most likely cause; firstSentence trims the why", () => {
    const { top, rest } = UI.splitFindings([{ severity: "info", condition: "scope" }, { severity: "warning", condition: "w" }, { severity: "advisory", condition: "a" }]);
    assert.equal(top.condition, "w");
    assert.deepEqual(rest.map((f: { condition: string }) => f.condition), ["scope", "a"]);
    assert.equal(UI.splitFindings([{ severity: "info" }]).top, null);
    assert.equal(UI.splitFindings(null).top, null);
    assert.equal(UI.firstSentence("Low charge. Then more text."), "Low charge.");
    assert.equal(UI.firstSentence("x".repeat(200), 20), `${"x".repeat(19)}…`);
  });
});

describe("job clock + signature helpers", () => {
  test("formatElapsed / formatMinutes", () => {
    assert.deepEqual([UI.formatElapsed(65000), UI.formatElapsed(3725000), UI.formatElapsed(-5)], ["01:05", "1:02:05", "00:00"]);
    assert.deepEqual([UI.formatMinutes(45), UI.formatMinutes(65), UI.formatMinutes(null)], ["45 min", "1 h 05 min", "0 min"]);
  });
  test("jobBarState: running survives a reload (elapsed from job_started_at), stopped, idle, signed", () => {
    const run = UI.jobBarState({ job_started_at: "2026-10-13T10:00:00Z" }, Date.parse("2026-10-13T10:12:34Z"));
    assert.deepEqual([run.state, UI.formatElapsed(run.elapsedMs)], ["running", "12:34"]);
    const done = UI.jobBarState({ job_started_at: "2026-10-13T10:00:00Z", job_ended_at: "2026-10-13T11:05:00Z", minutes_on_site: 65, signed: true, signed_by: "Pat", signed_at: "2026-10-13T11:06:00Z" });
    assert.deepEqual([done.state, done.minutes, done.signed, done.signedBy], ["stopped", 65, true, "Pat"]);
    assert.equal(UI.jobBarState({ job_started_at: "2026-10-13T10:00:00Z", job_ended_at: "2026-10-13T10:30:00Z" }).minutes, 30);
    assert.equal(UI.jobBarState(null).state, "idle");
  });
  test("signatureNote folds the declined checkbox and the note", () => {
    assert.equal(UI.signatureNote(true, " coil cleaning "), "Declined recommendation — coil cleaning");
    assert.equal(UI.signatureNote(false, ""), null);
    assert.equal(UI.signatureNote(false, "x".repeat(600)).length, 500);
  });
  test("reportShareText mentions time on site and the signature", () => {
    const text = UI.reportShareText({ conversation: { title: "RTU-7" }, unit: null, findings: [], readings: [], job: { startedAt: "2026-10-13T10:00:00Z", endedAt: "2026-10-13T11:05:00Z", minutesOnSite: 65 }, signature: { signedBy: "Pat", signedAt: "2026-10-13T11:06:00Z", note: null } });
    assert.match(text, /Time on site: 1 h 05 min/);
    assert.match(text, /Signed by Pat on 2026-10-13/);
  });
});

describe("calculators — grouping, form parsing, flags", () => {
  test("CALC_GROUPS: Refrigerant · Airflow · Combustion · Electrical · Parts, every wave-2 kind listed once", () => {
    assert.deepEqual(UI.CALC_GROUPS.map((g: { title: string }) => g.title), ["Refrigerant", "Airflow", "Combustion", "Electrical", "Parts"]);
    const all = UI.CALC_GROUPS.flatMap((g: { kinds: string[] }) => g.kinds);
    for (const k of ["leak_rate", "gas_meter_clock", "combustion_co", "sensible_cfm", "static_pressure", "fan_laws", "belt_drive", "voltage_drop", "motor_fla", "capacitor_replacement", "motor_replacement"]) assert.equal(all.filter((x: string) => x === k).length, 1, k);
    const html = readFileSync(join(here, "index.html"), "utf8");
    for (const k of all) assert.ok(html.includes(`data-calc="${k}"`), `index.html has the ${k} calculator`);
  });
  test("calcRequestFromForm: numbers parsed, optional blanks dropped, strings and phase passed, first error named", () => {
    assert.deepEqual(UI.calcRequestFromForm("voltage_drop", { volts: "240", amps: "30", oneWayFt: "100", awg: "10", material: "cu", phase: "1" }).body, { kind: "voltage_drop", volts: 240, amps: 30, oneWayFt: 100, awg: "10", material: "cu", phase: 1 });
    assert.equal(UI.calcRequestFromForm("voltage_drop", { volts: "240", amps: "30", oneWayFt: "100", awg: "", phase: "3" }).error, "Enter the wire size (AWG / kcmil) or circular mils.");
    assert.deepEqual(UI.calcRequestFromForm("motor_replacement", { hp: "", rpm: "1075", frame: "48Y", phase: "", rotationFromShaftEnd: "" }).body, { kind: "motor_replacement", rpm: 1075, frame: "48Y" });
    assert.equal(UI.calcRequestFromForm("leak_rate", { addedLbs: "abc", fullChargeLbs: "400" }, { addedLbs: "Refrigerant added" }).error, "Refrigerant added must be a number.");
    assert.equal(UI.calcRequestFromForm("leak_rate", { addedLbs: "", fullChargeLbs: "400" }, { addedLbs: "Refrigerant added" }).error, "Enter Refrigerant added.");
    assert.equal(UI.calcRequestFromForm("motor_fla", { hp: "5", volts: "460", phase: "" }).error, "Pick the phase.");
  });
  test("calcFlagChip: CO level, exceeded, pass/fail chips carry words", () => {
    assert.deepEqual([UI.calcFlagChip("flag", 2), UI.calcFlagChip("flag", 1), UI.calcFlagChip("flag", 0)], [{ label: "Shutdown", tone: "danger" }, { label: "Action", tone: "warn" }, { label: "OK", tone: "ok" }]);
    assert.deepEqual([UI.calcFlagChip("exceeded", 1), UI.calcFlagChip("exceeded", 0), UI.calcFlagChip("pass", 0)], [{ label: "EXCEEDED", tone: "danger" }, { label: "Within", tone: "ok" }, { label: "FAIL", tone: "danger" }]);
    assert.equal(UI.calcFlagChip("cfm", 2), null);
  });
});

describe("web/calc.js — offline calculators match the server (src/knowledge/electrical.ts)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let CALC: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  before(async () => {
    const calcMod = "./calc.js";
    await import(calcMod);
    CALC = (globalThis as { HVAC_CALC?: unknown }).HVAC_CALC;
    // Imported through Node type stripping; the path is a variable so tsc (rootDir web/) does not pull src/ in.
    const serverMod = new URL("../src/knowledge/electrical.ts", import.meta.url).href;
    server = await import(serverMod);
  });
  const CASES: Record<string, Record<string, unknown>[]> = {
    leak_rate: [
      { addedLbs: 25, fullChargeLbs: 400, daysSinceLastAdd: 60, applianceType: "commercial_refrigeration" }, // EPA worked example → 38.02 %
      { addedLbs: 2, fullChargeLbs: 20, daysSinceLastAdd: 0 },
      { addedLbs: 3.5, fullChargeLbs: 120, daysSinceLastAdd: 200, applianceType: "industrial_process" },
      { addedLbs: 10, fullChargeLbs: 100, daysSinceLastAdd: 500 }, // > 365 days: the client caps at 365 (see below)
    ],
    gas_meter_clock: [
      { dialCuft: 1, secondsPerRev: 36 },
      { dialCuft: 2, secondsPerRev: 50, revolutions: 2, heatingValueBtuPerCuft: 1030, nameplateInputBtuh: 300000 },
      { dialCuft: 0.5, secondsPerRev: 20, nameplateInputBtuh: 100000 },
    ],
    combustion_co: [{ coPpm: 40, o2Pct: 6 }, { coPpm: 150, o2Pct: 9.5, ambientCoPpm: 12 }, { coPpm: 300, o2Pct: 10, ambientCoPpm: 35 }],
    sensible_cfm: [{ btuh: 54000, deltaTF: 25 }, { btuh: 34120, deltaTF: 30, tons: 3 }, { btuh: 120000, deltaTF: 20, tons: 4 }],
    static_pressure: [{ supplyInWc: 0.35, returnInWc: -0.3 }, { supplyInWc: 0.5, returnInWc: -0.4, blowerType: "ecm" }, { supplyInWc: 0.2, returnInWc: 0.15, ratedMaxInWc: 0.6 }],
    fan_laws: [{ rpm1: 1000, rpm2: 1100, cfm1: 4000, sp1: 0.8, bhp1: 2 }, { rpm1: 900, rpm2: 800, cfm1: 3000 }, { rpm1: 1200, rpm2: 1250, bhp1: 5 }],
    belt_drive: [{ motorRpm: 1750, motorSheaveIn: 4, fanSheaveIn: 8 }, { motorRpm: 1725, motorSheaveIn: 3.5, fanSheaveIn: 9, centerDistanceIn: 20 }, { motorRpm: 1160, motorSheaveIn: 6, fanSheaveIn: 5, centerDistanceIn: 15 }],
    voltage_drop: [{ volts: 240, amps: 30, oneWayFt: 100, awg: "10" }, { volts: 460, amps: 80, oneWayFt: 250, awg: "1/0", material: "al", phase: 3 }, { volts: 208, amps: 40, oneWayFt: 150, circularMils: 26240, phase: 3 }],
    motor_fla: [{ hp: 15, volts: 460, phase: 3 }, { hp: 0.5, volts: 115, phase: 1 }, { hp: 12, volts: 208, phase: 3 }],
    capacitor_replacement: [{ ratedUf: 45, ratedV: 370, replacementUf: 45, replacementV: 440 }, { ratedUf: 35, ratedV: 440, replacementUf: 40, replacementV: 370 }, { ratedUf: 7.5, ratedV: 370, replacementUf: 7, replacementV: 370 }],
    motor_replacement: [{}, { hp: 0.5, rpm: 1075, volts: 208, phase: 1, rotationFromShaftEnd: "ccw", frame: "48Y", shaftDiaIn: 0.5, enclosure: "TEAO" }, { hp: 3, rpm: 1725, phase: 3 }],
  };
  const r2 = (n: unknown) => (typeof n === "number" ? Math.round(n * 100) / 100 : n);
  const norm = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, r2(x)]));
  for (const [kind, inputs] of Object.entries(CASES)) {
    inputs.forEach((input, i) => {
      test(`${kind} #${i + 1}`, (t) => {
        const req = { kind, ...input };
        const mine = CALC.electrical(req);
        const theirs = server.calcElectrical(req);
        assert.ok(mine, `calc.js handles ${kind} offline`);
        assert.ok(CALC.OFFLINE_KINDS.includes(kind));
        if (kind === "leak_rate" && (input.daysSinceLastAdd as number) > 365) {
          // EPA annualizing method: days = min(365, max(1, days)); both calc.js and the server apply the cap.
          const capped = Math.round(((input.addedLbs as number) / (input.fullChargeLbs as number)) * (365 / 365) * 100 * 100) / 100;
          assert.equal(mine.values.leakRatePct, capped);
          assert.equal(mine.values.daysUsed, 365);
          assert.equal(theirs.values.daysUsed, 365, "server caps the days at 365 too");
        }
        assert.deepEqual(norm(mine.values), norm(theirs.values));
        assert.deepEqual(mine.warnings, theirs.warnings);
        assert.ok(mine.interpretation.length > 0 && theirs.interpretation.length > 0);
        if (kind !== "leak_rate") assert.equal(mine.interpretation[0], theirs.interpretation[0], "interpretation[0] states the same formula");
      });
    });
  }
  test("leak_rate: EPA worked example (25 lb into a 400 lb rack 60 days after the prior add) = 38.02 %", () => {
    assert.equal(CALC.electrical({ kind: "leak_rate", addedLbs: 25, fullChargeLbs: 400, daysSinceLastAdd: 60 }).values.leakRatePct, 38.02);
    assert.equal(CALC.annualizedLeakRate({ addedLbs: 1, fullChargeLbs: 10, daysSinceLastAdd: 0.2 }).days, 1);
    assert.equal(CALC.annualizedLeakRate({ addedLbs: 1, fullChargeLbs: 10, daysSinceLastAdd: 900 }).days, 365);
  });
  test("chillerLocal: ΔT, tons, approaches offline; findings left to the server", () => {
    const r = CALC.chillerLocal({ chwSupplyF: 44, chwReturnF: 54, chwFlowGpm: 240, evapSatF: 38, condSatF: 98, condWaterOutF: 95, condWaterInF: 85, compressorAmps: 200, rla: 250 });
    assert.deepEqual(r.derived, { evapSatF: 38, condSatF: 98, chwDeltaTF: 10, tons: 100, evapApproachF: 6, condApproachF: 3, condWaterDeltaTF: 10, ampsPercentRla: 80 });
    assert.equal(r.condenserType, "water_cooled");
    assert.deepEqual(r.findings, []);
    assert.equal(r.offline, true);
    const air = CALC.chillerLocal({ chwSupplyF: 45, condPressurePsig: 200, outdoorDbF: 95, refrigerant: "R-134a" }, () => 125);
    assert.deepEqual([air.condenserType, air.derived.condApproachF], ["air_cooled", 30]);
    assert.ok(CALC.chillerLocal({ evapPressurePsig: 40 }, () => null).notes.some((n: string) => /could not be converted offline/.test(n)));
  });
});

describe("voice dictation (web/voice.js) + composer insertion", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let VOICE: any;
  before(async () => {
    const mod = "./voice.js";
    await import(mod);
    VOICE = (globalThis as { HVAC_VOICE?: unknown }).HVAC_VOICE;
  });
  test("normalizeDictation: psig, refrigerants, degrees", () => {
    assert.equal(VOICE.normalizeDictation("suction 118 p s i g line 52 degrees"), "suction 118 psig line 52 °F");
    assert.equal(VOICE.normalizeDictation("head 340 PSIG, super heat 12 sub cooling 9"), "head 340 psig, superheat 12 subcooling 9");
    assert.equal(VOICE.normalizeDictation("are four ten a system"), "R-410A system");
    assert.equal(VOICE.normalizeDictation("R 22 at 68 psi"), "R-22 at 68 psig");
    assert.equal(VOICE.normalizeDictation("r454b and R 32"), "R-454B and R-32");
    assert.equal(VOICE.normalizeDictation("r 134a"), "R-134a");
    assert.equal(VOICE.normalizeDictation("outdoor 95 degrees fahrenheit"), "outdoor 95 °F");
    assert.equal(VOICE.normalizeDictation("temps are 22 degrees"), "temps are 22 °F", "'are' alone is not R-");
    assert.equal(VOICE.normalizeDictation("delta t 18"), "ΔT 18");
    assert.equal(VOICE.normalizeDictation("  "), "");
    assert.equal(VOICE.supported, false, "no recognizer in Node: the mic button stays hidden");
  });
  test("insertAtCursor spaces the join; dictationDelta returns only new final text", () => {
    assert.deepEqual(UI.insertAtCursor("suction", 7, 7, "118 psig"), { value: "suction 118 psig", cursor: 16 });
    assert.deepEqual(UI.insertAtCursor("a, b", 1, 1, "x"), { value: "a x, b", cursor: 3 });
    assert.deepEqual(UI.insertAtCursor("", 0, 0, "hi"), { value: "hi", cursor: 2 });
    assert.deepEqual(UI.insertAtCursor("ab cd", 2, 2, ""), { value: "ab cd", cursor: 2 });
    assert.deepEqual(UI.dictationDelta("suction 118", "suction 118 psig line 52"), "psig line 52");
    assert.equal(UI.dictationDelta("abc", "xyz"), "xyz");
    assert.equal(UI.DICTATION_SILENCE_MS, 20000);
  });
  test("index.html loads voice.js before app.js and the service worker caches it", () => {
    const html = readFileSync(join(here, "index.html"), "utf8");
    assert.ok(html.indexOf('src="voice.js"') > 0 && html.indexOf('src="voice.js"') < html.indexOf('src="app.js"'));
    const sw = readFileSync(join(here, "sw.js"), "utf8");
    assert.ok(sw.includes('"./voice.js"'));
    assert.match(html, /id="btn-mic"[^>]*aria-pressed="false"[^>]*hidden/);
  });
});

describe("manufacturer support (OEM fallback)", () => {
  test("supportPhones: tel: links from the pack's free-text phone line, vanity numbers converted, labelled", () => {
    const p = UI.supportPhones("1-800-379-6484 (Carrier Commercial Service 24-hour line); residential/Bryant/Payne product support: 1-800-CARRIER (1-800-227-7437)");
    assert.deepEqual(p.map((x: { tel: string }) => x.tel), ["tel:+18003796484", "tel:+18002277437"]);
    assert.equal(p[0].label, "Carrier Commercial Service 24-hour line");
    assert.equal(p[1].label, "residential/Bryant/Payne product support");
    assert.deepEqual(UI.supportPhones(""), []);
  });
  test("supportRows: phone, site, literature link, hints; nothing without support info", () => {
    const rows = UI.supportRows({ phone: "Call 1-800-379-6484", url: "https://www.carrier.com/commercial/en/us/", literatureUrl: "https://www.carrier.com/x/ (each product page)", literatureSearchHint: "Search", notes: "n" });
    assert.deepEqual(rows.map((r: { kind: string }) => r.kind), ["phone", "link", "link", "text", "text"]);
    assert.equal(rows[2].href, "https://www.carrier.com/x/");
    assert.deepEqual(UI.supportRows(null), []);
    assert.deepEqual(UI.supportRows({ url: "javascript:alert(1)" }), []);
  });
});

describe("wave-2 routes", () => {
  const id = "0123456789abcdef";
  const vid = "fedcba9876543210";
  test("parseHash: refrigerant / charge / PM picker / PM checklist / PM report / sign-off / chiller mode", () => {
    assert.equal(UI.parseHash(`#unit/${id}/refrigerant`).sheet, "refrigerant");
    assert.equal(UI.parseHash(`#unit/${id}/charge`).sheet, "charge");
    assert.equal(UI.parseHash(`#unit/${id}/pm`).sheet, "pmPick");
    const pm = UI.parseHash(`#unit/${id}/pm/${vid}`);
    assert.deepEqual([pm.screen, pm.unit, pm.pmVisit, pm.sheet], ["pm", id, vid, null]);
    assert.equal(UI.parseHash(`#unit/${id}/pm/${vid}/report`).sheet, "report");
    assert.equal(UI.parseHash(`#unit/${id}/pm/nope`).screen, "units");
    const sign = UI.parseHash(`#chat/${id}/sign`);
    assert.deepEqual([sign.screen, sign.conv, sign.sheet], ["chat", id, "sign"]);
    assert.equal(UI.parseHash("#readings/chiller").mode, "chiller");
    const cp = UI.parseHash("#readings/chiller/pick");
    assert.deepEqual([cp.mode, cp.sheet], ["chiller", "pick"], "the unit picker keeps chiller mode");
    assert.equal(UI.parseHash("#readings").mode, "dx");
  });
});

describe("styles.css — glove and sun modes", () => {
  const css = readFileSync(join(here, "styles.css"), "utf8");
  const block = (selector: string) => {
    const i = css.indexOf(selector + " {");
    assert.ok(i >= 0, `selector not found: ${selector}`);
    return css.slice(i, css.indexOf("}", i));
  };
  test("glove mode raises every size variable to ≥ 56 px targets and 18 px body text", () => {
    const g = block(":root[data-glove]");
    for (const v of ["--tap", "--btn-h", "--icon-btn", "--input-h"]) assert.match(g, new RegExp(`${v}: (5[6-9]|[6-9]\\d)px`), v);
    assert.match(g, /--fs-3: 18px/);
    assert.match(g, /--composer-h: (5[2-9]|[6-9]\d)px/);
    // controls read the variables (no hard-coded sizes left on the main controls)
    assert.match(block(".btn"), /min-height: var\(--btn-h\)/);
    assert.match(block(".icon-btn"), /width: var\(--icon-btn\)/);
    assert.match(css, /\.field input, \.field select, \.field textarea, \.input \{[^}]*min-height: var\(--input-h\)/);
  });
  test("sun mode: white surfaces, black text and borders, thick borders, no shadows, nothing translucent", () => {
    const s = block(":root[data-sun]");
    for (const v of ["--surface-0", "--surface-1", "--surface-2"]) assert.match(s, new RegExp(`${v}: #ffffff`), v);
    for (const v of ["--text-primary", "--text-secondary", "--text-muted", "--border"]) assert.match(s, new RegExp(`${v}: #000000`), v);
    assert.match(s, /--bw: 2px/);
    assert.match(s, /--shadow-soft: none/);
    assert.doesNotMatch(s, /rgba\(/);
  });
});
