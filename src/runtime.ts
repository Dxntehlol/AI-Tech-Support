import type { MessagesStreamer } from "./agent/client.ts";
import type { AppConfig } from "./types.ts";

/**
 * The swappable part of the app: the model client, the config it runs with, and the demo flag. Saving the
 * AI connection in Settings replaces the whole state at once; readers (/api/health, /config.js, the chat
 * route) call get() per request, and a turn snapshots the state when it starts so an in-flight turn keeps
 * the client it began with.
 */
export interface RuntimeState {
  client: MessagesStreamer;
  config: AppConfig;
  demo: boolean;
}

export interface Runtime {
  get(): RuntimeState;
  set(next: RuntimeState): void;
}

export function createRuntime(initial: RuntimeState): Runtime {
  let state: RuntimeState = { ...initial };
  return {
    get: () => state,
    set(next: RuntimeState): void {
      state = { ...next };
    },
  };
}
