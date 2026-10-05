/**
 * List prices for the usage screen (USD per million tokens). Source: the Claude model catalog
 * (claude-api skill, shared/models.md, as of 2026-10). These are LIST prices: the estimate ignores
 * discounts, batch pricing, committed-use contracts and taxes, so the UI labels every figure
 * "estimated at list price". Models not in this table get a null cost ("cost not estimated").
 *
 * Rules used for the estimate:
 *   - cache reads use the model's stated cache-read price, else 0.1x the input price;
 *   - cache writes (5-minute TTL, which is what the chat loop's cache_control uses) cost 1.25x input;
 *   - web search costs $10 per 1,000 searches.
 */
export interface ModelPrice {
  input: number;
  output: number;
  /** Stated cache-read price; absent means 0.1x input. */
  cacheRead?: number;
}

export const PRICES_PER_MTOK: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};

export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_DEFAULT_MULTIPLIER = 0.1;
export const WEB_SEARCH_USD_EACH = 10 / 1000;
export const PRICE_LABEL = "estimated at list price";

/**
 * Current model ids from the catalog, offered by the Settings model picker (the Glasswing-only Mythos
 * models are left out: ordinary accounts cannot call them).
 */
export const KNOWN_MODELS: readonly string[] = [
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

export interface UsageCounts {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  web_searches: number;
}

/** Price entry for a model id; a dated snapshot id (`…-20260101`) falls back to its alias. */
export function priceFor(model: string): ModelPrice | undefined {
  const id = model.trim().toLowerCase();
  return PRICES_PER_MTOK[id] ?? PRICES_PER_MTOK[id.replace(/-\d{8}$/, "")];
}

/** Estimated USD cost of one model request at list price, or null when the model has no price here. */
export function estimateCost(row: UsageCounts): number | null {
  const p = priceFor(row.model);
  if (!p) return null;
  const cacheRead = p.cacheRead ?? p.input * CACHE_READ_DEFAULT_MULTIPLIER;
  const tokens =
    (row.input_tokens || 0) * p.input +
    (row.output_tokens || 0) * p.output +
    (row.cache_read_tokens || 0) * cacheRead +
    (row.cache_write_tokens || 0) * p.input * CACHE_WRITE_MULTIPLIER;
  return tokens / 1_000_000 + (row.web_searches || 0) * WEB_SEARCH_USD_EACH;
}
