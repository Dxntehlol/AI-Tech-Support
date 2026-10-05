import Anthropic from "@anthropic-ai/sdk";
import { KNOWN_MODELS } from "./pricing.ts";

/** Result of Settings → AI connection → Test. `message` is a plain sentence for the technician. */
export interface ConnectionTestResult {
  ok: boolean;
  stage: "auth" | "model" | "message";
  model: string;
  latencyMs: number;
  message: string;
  code: ConnectionTestCode;
  availableModels?: string[];
  suggestion?: string;
}

export type ConnectionTestCode =
  | "ok"
  | "invalid_key"
  | "permission"
  | "model_unavailable"
  | "billing"
  | "rate_limited"
  | "overloaded"
  | "network"
  | "no_key"
  | "unknown";

export interface ConnectionTestInput {
  /** Key to test; absent means the SDK's default credential chain (auth token / `ant auth login` profile). */
  apiKey?: string;
  model: string;
  /** Overall budget for the whole test. */
  timeoutMs: number;
}

/** Injected through AppDeps.connectionTester so route tests never touch the network. */
export type ConnectionTester = (input: ConnectionTestInput) => Promise<ConnectionTestResult>;

export const CONNECTION_TEST_TIMEOUT_MS = 20_000;
export const CONNECTION_TEST_PROMPT = "Reply with OK.";

/** Replace every `sk-ant-…` substring with `sk-ant-…<last4>` so a key never leaves the server in full. */
export function scrubKeys(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, (m) => `sk-ant-…${m.slice(-4)}`);
}

/** "…" + the last 4 characters (never the key). */
export function keyHint(key: string | undefined | null): string | null {
  const k = key?.trim();
  return k ? `…${k.slice(-4)}` : null;
}

/** Map an SDK error (or anything thrown) to a result code and a technician-facing sentence. */
export function describeConnectionError(err: unknown, model: string): { code: ConnectionTestCode; message: string } {
  if (err instanceof Anthropic.APIConnectionTimeoutError || (err instanceof Error && err.name === "TimeoutError")) {
    return { code: "network", message: "Anthropic did not answer in time. Check this server's internet connection and try again." };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { code: "network", message: "Couldn't reach Anthropic. Check this server's internet connection (and any proxy or firewall)." };
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const detail = typeof err.message === "string" ? err.message : "";
    if (status === 401) return { code: "invalid_key", message: "Anthropic rejected this API key. Check that it was copied completely, or create a new key in the Claude Console." };
    if (status === 403) return { code: "permission", message: "This API key is not allowed to use that model or feature. Check the key's workspace permissions in the Claude Console." };
    if (status === 404) return { code: "model_unavailable", message: `The model "${model}" is not available to this API key.` };
    if (status === 402 || (status === 400 && /credit balance|billing|purchase credits|plans? (&|and) billing/i.test(detail))) {
      return { code: "billing", message: "The key works, but the account has no credit left. Add credits or a payment method under Plans & Billing in the Claude Console." };
    }
    if (status === 429) return { code: "rate_limited", message: "The key works, but the account is rate limited right now. Wait a minute and test again." };
    if (status >= 500) return { code: "overloaded", message: "Anthropic's servers are busy or having trouble right now. Try again in a minute." };
    return { code: "unknown", message: scrubKeys(`Anthropic returned an error (${status || "no status"}): ${detail || "no details"}`) };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { code: "unknown", message: scrubKeys(`The test failed: ${msg}`) };
}

/** Model ids the key can see (first page set, capped), or undefined when listing fails. */
async function listModelIds(client: Anthropic, signal: AbortSignal): Promise<string[] | undefined> {
  try {
    const ids: string[] = [];
    for await (const m of client.models.list({ limit: 100 }, { signal })) {
      ids.push(m.id);
      if (ids.length >= 200) break;
    }
    return ids;
  } catch {
    return undefined;
  }
}

/** Suggest a catalog model the key can use (the first known id present in the key's list). */
export function suggestModel(available: readonly string[] | undefined): string | undefined {
  if (!available?.length) return undefined;
  const set = new Set(available);
  return KNOWN_MODELS.find((id) => set.has(id)) ?? available[0];
}

/**
 * The real tester: models.retrieve (free; proves the key and the model), then one tiny messages request
 * (max_tokens 16, effort low) to prove the account can actually be billed. No retries; one shared timeout.
 */
export const defaultConnectionTester: ConnectionTester = async ({ apiKey, model, timeoutMs }) => {
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  const client = apiKey ? new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs }) : new Anthropic({ maxRetries: 0, timeout: timeoutMs });
  const done = (r: Omit<ConnectionTestResult, "model" | "latencyMs">): ConnectionTestResult => ({ ...r, model, latencyMs: Date.now() - started });

  try {
    await client.models.retrieve(model, {}, { signal });
  } catch (err) {
    const d = describeConnectionError(err, model);
    if (d.code === "model_unavailable") {
      const availableModels = await listModelIds(client, signal);
      const s = suggestModel(availableModels);
      return done({ ok: false, stage: "model", ...d, ...(availableModels ? { availableModels } : {}), ...(s ? { suggestion: `Pick ${s} in the model list.` } : {}) });
    }
    return done({ ok: false, stage: "auth", ...d });
  }

  const ask = (withEffort: boolean): Promise<unknown> =>
    client.messages.create(
      {
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: CONNECTION_TEST_PROMPT }],
        ...(withEffort ? { output_config: { effort: "low" as const } } : {}),
      },
      { signal },
    );
  try {
    try {
      await ask(true);
    } catch (err) {
      // Older models reject the effort parameter; the billing check does not need it.
      if (err instanceof Anthropic.BadRequestError && /effort|output_config/i.test(err.message)) await ask(false);
      else throw err;
    }
  } catch (err) {
    return done({ ok: false, stage: "message", ...describeConnectionError(err, model) });
  }

  const availableModels = await listModelIds(client, signal);
  return done({
    ok: true,
    stage: "message",
    code: "ok",
    message: `Connected. ${model} answered in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
    ...(availableModels ? { availableModels } : {}),
  });
};
