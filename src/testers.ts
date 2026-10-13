import { estimateCost } from "./agent/pricing.ts";
import { localDate, usageWindowStart } from "./agent/usage.ts";
import type { Repos } from "./db/repos.ts";
import type { AppConfig, TesterRow } from "./types.ts";

/** Estimated USD a tester has spent since `sinceIso` (unpriced models count as 0 but are flagged). */
export function testerSpendSince(repos: Repos, testerId: string, sinceIso: string): { usd: number; requests: number; unpriced: number } {
  let usd = 0;
  let requests = 0;
  let unpriced = 0;
  for (const row of repos.usage.listSince(sinceIso, testerId)) {
    requests += 1;
    const c = estimateCost(row);
    if (c === null) unpriced += 1;
    else usd += c;
  }
  return { usd: Math.round(usd * 1e6) / 1e6, requests, unpriced };
}

/** Start of the server-local calendar day, as ISO (usage rows are stored in UTC ISO, so compare on the instant). */
export function startOfTodayIso(now: Date): string {
  return usageWindowStart(1, now).toISOString();
}

/** Default per-tester daily cap when TESTER_DAILY_CAP_USD is unset (USD, estimated at list price). */
export const DEFAULT_TESTER_DAILY_CAP_USD = 2;

/** The cap that applies to a tester: their own daily_cap_usd, else the server default. 0 = unlimited. */
export function capFor(tester: Pick<TesterRow, "daily_cap_usd">, config: Pick<AppConfig, "testerDailyCapUsd">): number {
  if (typeof tester.daily_cap_usd === "number" && Number.isFinite(tester.daily_cap_usd)) return tester.daily_cap_usd;
  return typeof config.testerDailyCapUsd === "number" && Number.isFinite(config.testerDailyCapUsd) ? config.testerDailyCapUsd : DEFAULT_TESTER_DAILY_CAP_USD;
}

export interface TesterBudget {
  capUsd: number;
  spentTodayUsd: number;
  requestsToday: number;
  /** True when the tester must wait until tomorrow (server-local day). */
  exhausted: boolean;
  /** Server-local date the cap resets after. */
  day: string;
}

export function testerBudget(repos: Repos, tester: TesterRow, config: Pick<AppConfig, "testerDailyCapUsd">, now: Date): TesterBudget {
  const capUsd = capFor(tester, config);
  const spent = testerSpendSince(repos, tester.id, startOfTodayIso(now));
  return { capUsd, spentTodayUsd: spent.usd, requestsToday: spent.requests, exhausted: capUsd > 0 && spent.usd >= capUsd, day: localDate(now) };
}

/** Message shown to a tester who has hit the cap. */
export function capMessage(b: TesterBudget): string {
  return `Daily test budget reached ($${b.spentTodayUsd.toFixed(2)} of $${b.capUsd.toFixed(2)} today). It resets after midnight on the server, or the app owner can raise it.`;
}
