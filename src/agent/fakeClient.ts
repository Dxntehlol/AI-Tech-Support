import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesStreamer, StreamLike, StreamParams } from "./client.ts";

/**
 * Scripted turns for the fake client.
 *
 *  - A full `Anthropic.Beta.BetaMessage`-like object (anything with a `content` array) is returned as-is
 *    (missing fields such as id/usage/model are filled in).
 *  - Shorthand `{ text?, toolCalls?, stop_reason?, stop_details? }` is expanded into a message: text block(s)
 *    plus one tool_use block per call (ids "toolu_fake_N"); stop_reason defaults to "tool_use" when toolCalls
 *    are present, else "end_turn".
 *  - `{ throw: Error }` makes the stream fail: finalMessage() rejects with that error.
 */
export type FakeTurn =
  | { throw: Error }
  | {
      text?: string;
      toolCalls?: { name: string; input: unknown; id?: string }[];
      stop_reason?: Anthropic.Beta.BetaStopReason;
      stop_details?: Anthropic.Beta.BetaMessage["stop_details"];
      usage?: Partial<Anthropic.Beta.BetaUsage>;
      model?: string;
    }
  | (Partial<Anthropic.Beta.BetaMessage> & { content: Anthropic.Beta.BetaContentBlock[] });

export interface FakeClient extends MessagesStreamer {
  /** Every params object passed to stream(), in call order. */
  calls: StreamParams[];
  /** Append more scripted turns at any time. */
  push(...turns: FakeTurn[]): void;
}

export const FAKE_MODEL = "fake-claude";

/** Model-number heuristic used by the demo script (letters then digits, e.g. 48TCDA04, XC21-036, RTU-7 does not match). */
export const MODEL_NUMBER_RE = /[A-Z]{2,}\d{2,}[A-Z0-9-]*/i;

let idCounter = 0;

function nextToolId(): string {
  idCounter += 1;
  return `toolu_fake_${idCounter}`;
}

function abortError(): Error {
  const e = new Error("Request was aborted.");
  e.name = "AbortError";
  return e;
}

function makeUsage(partial?: Partial<Anthropic.Beta.BetaUsage>): Anthropic.Beta.BetaUsage {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
    inference_geo: null,
    iterations: null,
    speed: null,
    ...(partial ?? {}),
  } as Anthropic.Beta.BetaUsage;
}

function isFullMessage(turn: FakeTurn): turn is Partial<Anthropic.Beta.BetaMessage> & { content: Anthropic.Beta.BetaContentBlock[] } {
  return Array.isArray((turn as { content?: unknown }).content);
}

function toMessage(turn: Exclude<FakeTurn, { throw: Error }>): Anthropic.Beta.BetaMessage {
  const base = {
    id: `msg_fake_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    type: "message" as const,
    role: "assistant" as const,
    model: FAKE_MODEL,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
  };
  if (isFullMessage(turn)) {
    const hasToolUse = turn.content.some((b) => b.type === "tool_use");
    return {
      ...base,
      stop_reason: hasToolUse ? "tool_use" : "end_turn",
      ...turn,
      usage: makeUsage(turn.usage ?? undefined),
    } as Anthropic.Beta.BetaMessage;
  }
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  if (typeof turn.text === "string" && turn.text.length > 0) content.push({ type: "text", text: turn.text, citations: null });
  for (const call of turn.toolCalls ?? []) {
    content.push({ type: "tool_use", id: call.id ?? nextToolId(), name: call.name, input: call.input ?? {} });
  }
  const stop_reason: Anthropic.Beta.BetaStopReason = turn.stop_reason ?? ((turn.toolCalls?.length ?? 0) > 0 ? "tool_use" : "end_turn");
  return {
    ...base,
    model: turn.model ?? FAKE_MODEL,
    content,
    stop_reason,
    stop_details: turn.stop_details ?? null,
    usage: makeUsage(turn.usage),
  } as Anthropic.Beta.BetaMessage;
}

function textOf(content: string | Anthropic.Beta.BetaContentBlockParam[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Summaries of the tool results in the last message, if it is a tool_result turn. */
function lastToolResultSummaries(params: StreamParams): string[] | null {
  const last = params.messages[params.messages.length - 1];
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return null;
  const results = last.content.filter((b): b is Anthropic.Beta.BetaToolResultBlockParam => b.type === "tool_result");
  if (results.length === 0) return null;
  return results.map((r) => {
    const raw = typeof r.content === "string" ? r.content : Array.isArray(r.content) ? r.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
    try {
      const parsed = JSON.parse(raw) as { summary?: unknown; error?: unknown };
      if (typeof parsed.summary === "string") return parsed.summary;
      if (typeof parsed.error === "string") return `error: ${parsed.error}`;
    } catch {
      /* not JSON */
    }
    return raw.slice(0, 200);
  });
}

function latestUserText(params: StreamParams): string {
  for (let i = params.messages.length - 1; i >= 0; i--) {
    const m = params.messages[i]!;
    if (m.role !== "user") continue;
    if (Array.isArray(m.content) && m.content.every((b) => b.type === "tool_result")) continue;
    return textOf(m.content);
  }
  return "";
}

/** The whole whitespace-delimited token around the first MODEL_NUMBER_RE match ("48TCDA04A2A5-0A0A0", not "TCDA04A2A5-0A0A0"). */
export function findModelNumber(text: string): string | undefined {
  const m = MODEL_NUMBER_RE.exec(text);
  if (!m) return undefined;
  let start = m.index;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  let end = m.index + m[0].length;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return text.slice(start, end).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9)]+$/g, "");
}

/**
 * Demo-mode script: tool call → canned answer, forever. The first call on a user message decodes a
 * model number when one is present, else does a PT lookup; the reply quotes the tool summary.
 */
function defaultTurn(params: StreamParams): FakeTurn {
  const summaries = lastToolResultSummaries(params);
  if (summaries) {
    const quoted = summaries.map((s) => `"${s.length > 300 ? `${s.slice(0, 299)}…` : s}"`).join("; ");
    return {
      text:
        `Demo mode (no API key): here is what the tool returned — ${quoted}.\n\n` +
        `**Next step:** confirm the nameplate data and give me the complaint plus any readings (suction/liquid psig, line temps, outdoor and return air temps, amps) and I will run the diagnosis. ` +
        `Set ANTHROPIC_API_KEY to talk to the real assistant.`,
    };
  }
  const text = latestUserText(params);
  const model = findModelNumber(text);
  if (model) return { toolCalls: [{ name: "decode_unit", input: { model } }] };
  return { toolCalls: [{ name: "refrigerant_pt", input: { refrigerant: "R-410A", psig: 118 } }] };
}

class FakeStream implements StreamLike {
  private listeners: ((delta: string) => void)[] = [];
  private aborted = false;
  private settled = false;
  private resolveFinal!: (m: Anthropic.Beta.BetaMessage) => void;
  private rejectFinal!: (e: unknown) => void;
  private readonly final: Promise<Anthropic.Beta.BetaMessage>;

  constructor(turn: FakeTurn, signal?: AbortSignal) {
    this.final = new Promise<Anthropic.Beta.BetaMessage>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
    // Nobody may ever await finalMessage() (e.g. abort races); keep the rejection from being "unhandled".
    this.final.catch(() => {});
    if (signal?.aborted) {
      this.abort();
      return;
    }
    signal?.addEventListener("abort", () => this.abort(), { once: true });
    setImmediate(() => this.run(turn));
  }

  private run(turn: FakeTurn): void {
    if (this.settled) return;
    if ("throw" in turn && turn.throw instanceof Error) {
      this.settle(() => this.rejectFinal(turn.throw));
      return;
    }
    const message = toMessage(turn as Exclude<FakeTurn, { throw: Error }>);
    const text = message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
    const chunks = splitChunks(text);
    const step = (i: number): void => {
      if (this.settled) return;
      if (i >= chunks.length) {
        this.settle(() => this.resolveFinal(message));
        return;
      }
      for (const l of this.listeners) l(chunks[i]!);
      setImmediate(() => step(i + 1));
    };
    step(0);
  }

  private settle(fn: () => void): void {
    if (this.settled) return;
    this.settled = true;
    fn();
  }

  on(event: "text", listener: (delta: string) => void): this {
    if (event === "text") this.listeners.push(listener);
    return this;
  }

  finalMessage(): Promise<Anthropic.Beta.BetaMessage> {
    return this.final;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.settle(() => this.rejectFinal(abortError()));
  }
}

function splitChunks(text: string): string[] {
  if (text.length === 0) return [];
  const n = Math.min(3, text.length);
  const size = Math.ceil(text.length / n);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * Scripted fake client. With `turns`, each stream() consumes the next turn (an exhausted script yields a
 * short end_turn message saying so). Without turns, the demo script runs forever (tool call → answer).
 */
export function createFakeClient(turns?: FakeTurn[]): FakeClient {
  const script = turns ? [...turns] : null;
  const calls: StreamParams[] = [];
  return {
    calls,
    push(...more: FakeTurn[]): void {
      if (script) script.push(...more);
      else throw new Error("push() is only available on a scripted fake client");
    },
    stream(params: StreamParams, opts?: { signal?: AbortSignal }): StreamLike {
      calls.push(params);
      let turn: FakeTurn;
      if (script) turn = script.length > 0 ? script.shift()! : { text: "(fake client: script exhausted)" };
      else turn = defaultTurn(params);
      return new FakeStream(turn, opts?.signal);
    },
  };
}
