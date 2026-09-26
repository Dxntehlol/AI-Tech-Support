import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../types.ts";

/** Parameters accepted by client.beta.messages.stream (the beta namespace carries fallbacks + web search). */
export type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

/** The subset of the SDK's MessageStream the chat loop uses. The fake client implements the same shape. */
export interface StreamLike {
  on(event: "text", listener: (delta: string) => void): this;
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
  abort(): void;
}

/** Narrow client interface: the real SDK is wrapped, tests inject src/agent/fakeClient.ts. */
export interface MessagesStreamer {
  stream(params: StreamParams, opts?: { signal?: AbortSignal }): StreamLike;
}

export function createAnthropicClient(_config: AppConfig): MessagesStreamer {
  // Credentials resolve from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile.
  const client = new Anthropic();
  return {
    stream: (params, opts) => client.beta.messages.stream(params, opts),
  };
}

/** True when the process has API credentials in the environment (the SDK may also find an `ant auth login` profile). */
export function hasApiCredentialsInEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
}
