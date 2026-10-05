import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db/index.ts";
import { createRepos } from "../db/repos.ts";
import { CACHE_WRITE_MULTIPLIER, KNOWN_MODELS, PRICES_PER_MTOK, estimateCost, priceFor } from "./pricing.ts";
import { clampUsageDays, localDate, summarizeUsage, usageWindowStart, type UsageEventRow } from "./usage.ts";

const close = (a: number | null, b: number): void => {
  assert.ok(a !== null, "expected a number");
  assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
};

const base = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, web_searches: 0 };

describe("pricing", () => {
  test("only the three priced models have a price; every priced model is a known catalog id", () => {
    assert.deepEqual(Object.keys(PRICES_PER_MTOK).sort(), ["claude-fable-5-1", "claude-opus-5", "claude-opus-5-5"]);
    for (const id of Object.keys(PRICES_PER_MTOK)) assert.ok(KNOWN_MODELS.includes(id), id);
    assert.equal(priceFor("claude-sonnet-5"), undefined);
    assert.equal(estimateCost({ ...base, model: "claude-haiku-4-5", input_tokens: 1000 }), null);
  });

  test("input/output at list price", () => {
    close(estimateCost({ ...base, model: "claude-opus-5", input_tokens: 1_000_000, output_tokens: 1_000_000 }), 5 + 25);
    close(estimateCost({ ...base, model: "claude-opus-5-5", input_tokens: 1_000_000, output_tokens: 1_000_000 }), 4 + 20);
    close(estimateCost({ ...base, model: "claude-fable-5-1", input_tokens: 1_000_000, output_tokens: 1_000_000 }), 10 + 50);
  });

  test("cache reads: stated price, else 0.1x input; cache writes 1.25x input; web search $10 / 1000", () => {
    close(estimateCost({ ...base, model: "claude-opus-5", cache_read_tokens: 1_000_000 }), 0.5);
    close(estimateCost({ ...base, model: "claude-opus-5-5", cache_read_tokens: 1_000_000 }), 0.2);
    close(estimateCost({ ...base, model: "claude-fable-5-1", cache_read_tokens: 1_000_000 }), 0.25);
    close(estimateCost({ ...base, model: "claude-opus-5", cache_write_tokens: 1_000_000 }), 5 * CACHE_WRITE_MULTIPLIER);
    close(estimateCost({ ...base, model: "claude-opus-5", web_searches: 3 }), 0.03);
  });

  test("a dated snapshot id falls back to its alias price", () => {
    close(estimateCost({ ...base, model: "claude-opus-5-20260101", output_tokens: 1_000_000 }), 25);
  });
});

describe("usage summary", () => {
  const NOW = new Date(2026, 8, 26, 15, 0, 0); // local time
  let id = 0;
  const row = (daysAgo: number, model: string, extra: Partial<UsageEventRow> = {}): UsageEventRow => ({
    id: ++id,
    conversation_id: "c1",
    created_at: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysAgo, 10).toISOString(),
    model,
    ...base,
    input_tokens: 1_000_000,
    stop_reason: "end_turn",
    ...extra,
  });

  test("clampUsageDays: default 30, clamp 1–365", () => {
    assert.equal(clampUsageDays(undefined), 30);
    assert.equal(clampUsageDays("abc"), 30);
    assert.equal(clampUsageDays("7"), 7);
    assert.equal(clampUsageDays("0"), 1);
    assert.equal(clampUsageDays("9999"), 365);
    assert.equal(clampUsageDays("12.7"), 12);
  });

  test("window is local calendar days ending today", () => {
    const start = usageWindowStart(7, NOW);
    assert.equal(localDate(start), "2026-09-20");
    assert.equal(start.getHours(), 0);
  });

  test("totals, byDay (zero-filled), byModel, per-conversation average", () => {
    const rows = [
      row(0, "claude-opus-5", { output_tokens: 1000, web_searches: 1, cache_read_tokens: 10, cache_write_tokens: 20 }),
      row(1, "claude-opus-5", { conversation_id: "c2" }),
      row(2, "claude-fable-5-1", { conversation_id: null }),
      row(30, "claude-opus-5"), // outside a 7-day window
    ];
    const s = summarizeUsage(rows, { days: 7, now: NOW });
    assert.equal(s.days, 7);
    assert.equal(s.totals.requests, 3);
    assert.equal(s.totals.inputTokens, 3_000_000);
    assert.equal(s.totals.outputTokens, 1000);
    assert.equal(s.totals.cacheReadTokens, 10);
    assert.equal(s.totals.cacheWriteTokens, 20);
    assert.equal(s.totals.webSearches, 1);
    assert.equal(s.totals.costComplete, true);
    const c0 = estimateCost(rows[0]!)!;
    close(s.totals.estimatedCostUsd, Math.round((c0 + 5 + 10) * 1e6) / 1e6);
    assert.equal(s.byDay.length, 7);
    assert.equal(s.byDay[6]!.date, localDate(NOW));
    assert.equal(s.byDay[6]!.requests, 1);
    assert.equal(s.byDay[0]!.requests, 0);
    assert.equal(s.byDay[0]!.estimatedCostUsd, 0);
    assert.deepEqual(
      s.byModel.map((m) => [m.model, m.requests]),
      [
        ["claude-opus-5", 2],
        ["claude-fable-5-1", 1],
      ],
    );
    // conversations c1 and c2 (the NULL row is not a conversation)
    close(s.perConversationAvgUsd, Math.round(((c0 + 5) / 2) * 1e6) / 1e6);
  });

  test("an unpriced model makes the cost incomplete; all-unpriced costs are null", () => {
    const mixed = summarizeUsage([row(0, "claude-opus-5"), row(0, "claude-sonnet-5")], { days: 30, now: NOW });
    assert.equal(mixed.totals.costComplete, false);
    close(mixed.totals.estimatedCostUsd, 5);
    assert.equal(mixed.byModel.find((m) => m.model === "claude-sonnet-5")!.estimatedCostUsd, null);
    const none = summarizeUsage([row(0, "claude-haiku-4-5")], { days: 30, now: NOW });
    assert.equal(none.totals.estimatedCostUsd, null);
    assert.equal(none.perConversationAvgUsd, null);
    // A conversation on an unpriced model is left out of the average instead of counting as $0.
    const avg = summarizeUsage(
      [
        row(0, "claude-opus-5", { conversation_id: "a", input_tokens: 100_000 }),
        row(0, "claude-sonnet-5", { conversation_id: "b", input_tokens: 100_000 }),
        row(0, "claude-opus-5", { conversation_id: "c", input_tokens: 100_000 }),
        row(0, "claude-sonnet-5", { conversation_id: "c", input_tokens: 100_000 }),
      ],
      { days: 30, now: NOW },
    );
    close(avg.perConversationAvgUsd, 0.5);
    assert.equal(summarizeUsage([row(0, "claude-sonnet-5", { conversation_id: "b" })], { days: 30, now: NOW }).perConversationAvgUsd, null);
    const empty = summarizeUsage([], { days: 30, now: NOW });
    assert.equal(empty.totals.estimatedCostUsd, 0);
    assert.equal(empty.totals.costComplete, true);
    assert.equal(empty.perConversationAvgUsd, null);
  });
});

describe("usage repo", () => {
  test("record / listSince / prune; conversation delete keeps the row with NULL id", () => {
    const db = openDatabase(":memory:");
    try {
      const repos = createRepos(db);
      const conv = repos.conversations.create({});
      repos.usage.record({ conversation_id: conv.id, model: "claude-opus-5", ...base, input_tokens: 12, output_tokens: -5, stop_reason: "end_turn", created_at: "2026-09-01T00:00:00.000Z" });
      repos.usage.record({ conversation_id: null, model: "claude-opus-5", ...base, stop_reason: null, created_at: "2024-01-01T00:00:00.000Z" });
      assert.equal(repos.usage.listSince("2000-01-01T00:00:00.000Z").length, 2);
      const [r] = repos.usage.listSince("2026-01-01T00:00:00.000Z");
      assert.equal(r!.input_tokens, 12);
      assert.equal(r!.output_tokens, 0, "negative counts are stored as 0");
      assert.equal(repos.usage.prune("2025-01-01T00:00:00.000Z"), 1);
      repos.conversations.remove(conv.id);
      const after = repos.usage.listSince("2000-01-01T00:00:00.000Z");
      assert.equal(after.length, 1);
      assert.equal(after[0]!.conversation_id, null);
    } finally {
      db.close();
    }
  });
});
