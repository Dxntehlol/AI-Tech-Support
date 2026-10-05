import { estimateCost, type UsageCounts } from "./pricing.ts";

/** One model request, as stored in usage_events. */
export interface UsageEventRow extends UsageCounts {
  id: number;
  conversation_id: string | null;
  created_at: string;
  stop_reason: string | null;
}

export type UsageEventInput = Omit<UsageEventRow, "id" | "created_at"> & { created_at?: string };

export interface UsageSummary {
  days: number;
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    webSearches: number;
    /** Sum over priced rows; null when there were rows and none could be priced. */
    estimatedCostUsd: number | null;
    /** False when any row had a model without a list price. */
    costComplete: boolean;
  };
  byDay: { date: string; requests: number; estimatedCostUsd: number | null }[];
  byModel: { model: string; requests: number; estimatedCostUsd: number | null }[];
  /** Average over conversations whose requests were all priced; null when there is none. */
  perConversationAvgUsd: number | null;
}

export const USAGE_DEFAULT_DAYS = 30;
export const USAGE_MAX_DAYS = 365;
export const USAGE_RETENTION_DAYS = 400;

/** Clamp the `days` query to 1–365 (default 30). */
export function clampUsageDays(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return USAGE_DEFAULT_DAYS;
  return Math.min(USAGE_MAX_DAYS, Math.max(1, Math.trunc(n)));
}

/** Server-local calendar date (YYYY-MM-DD). */
export function localDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Start (server-local midnight) of the window that ends today and spans `days` calendar days. */
export function usageWindowStart(days: number, now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Running cost total that knows whether anything was priced. */
class CostSum {
  total = 0;
  priced = 0;
  unpriced = 0;
  add(cost: number | null): void {
    if (cost === null) this.unpriced += 1;
    else {
      this.total += cost;
      this.priced += 1;
    }
  }
  value(): number | null {
    if (this.priced === 0 && this.unpriced > 0) return null;
    return round6(this.total);
  }
}

/** Aggregate the rows of the window (rows outside [start, now] are ignored). */
export function summarizeUsage(rows: readonly UsageEventRow[], opts: { days: number; now: Date }): UsageSummary {
  const days = opts.days;
  const start = usageWindowStart(days, opts.now);
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 };
  const totalCost = new CostSum();
  const dayMap = new Map<string, { requests: number; cost: CostSum }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    dayMap.set(localDate(d), { requests: 0, cost: new CostSum() });
  }
  const modelMap = new Map<string, { requests: number; cost: CostSum }>();
  const conversationCosts = new Map<string, CostSum>();

  for (const row of rows) {
    const at = new Date(row.created_at);
    if (Number.isNaN(at.getTime()) || at < start) continue;
    const cost = estimateCost(row);
    totals.requests += 1;
    totals.inputTokens += row.input_tokens || 0;
    totals.outputTokens += row.output_tokens || 0;
    totals.cacheReadTokens += row.cache_read_tokens || 0;
    totals.cacheWriteTokens += row.cache_write_tokens || 0;
    totals.webSearches += row.web_searches || 0;
    totalCost.add(cost);
    const day = dayMap.get(localDate(at));
    if (day) {
      day.requests += 1;
      day.cost.add(cost);
    }
    let m = modelMap.get(row.model);
    if (!m) {
      m = { requests: 0, cost: new CostSum() };
      modelMap.set(row.model, m);
    }
    m.requests += 1;
    m.cost.add(cost);
    if (row.conversation_id) {
      let c = conversationCosts.get(row.conversation_id);
      if (!c) {
        c = new CostSum();
        conversationCosts.set(row.conversation_id, c);
      }
      c.add(cost);
    }
  }

  // Average over conversations whose every request was priced; a partly priced conversation would understate it.
  const pricedConversations = [...conversationCosts.values()].filter((c) => c.unpriced === 0);
  const convTotal = pricedConversations.reduce((sum, c) => sum + c.total, 0);
  return {
    days,
    totals: { ...totals, estimatedCostUsd: totalCost.value(), costComplete: totalCost.unpriced === 0 },
    byDay: [...dayMap].map(([date, v]) => ({ date, requests: v.requests, estimatedCostUsd: v.cost.value() })),
    byModel: [...modelMap]
      .map(([model, v]) => ({ model, requests: v.requests, estimatedCostUsd: v.cost.value() }))
      .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model)),
    perConversationAvgUsd: pricedConversations.length > 0 ? round6(convTotal / pricedConversations.length) : null,
  };
}
