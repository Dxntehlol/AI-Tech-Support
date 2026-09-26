import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../types.ts";

/**
 * The subset of the Anthropic client the chat loop uses. Tests inject a fake.
 * We use the beta namespace because server-side fallbacks and web search live there.
 */
export type MessagesStreamer = {
  beta: { messages: { stream: Anthropic["beta"]["messages"]["stream"] } };
};

export function createAnthropicClient(_config: AppConfig): Anthropic {
  // Credentials resolve from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile.
  return new Anthropic();
}
