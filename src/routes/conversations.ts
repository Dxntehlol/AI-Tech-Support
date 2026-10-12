import { Router, type Response } from "express";
import type { AppDeps } from "../app.ts";
import { isTurnRunning, runTurn, stopTurn, type UserTurnInput } from "../agent/chat.ts";
import type { ChatEvent, ConversationRow, UnitRow } from "../types.ts";
import { HttpError, badRequest, body, foldMessages, notFound, optEnum, optString, optionalId, parseImages, parseSignaturePng, queryInt, queryString, requireId, sendError } from "./util.ts";
import { principalOf, testerIdOf } from "./auth.ts";
import { capMessage, testerBudget } from "../testers.ts";

export const JOB_ACTIONS = ["start", "stop", "clear"] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

/** Whole minutes between job start and end (null unless both are set and ordered). */
export function minutesOnSite(startedAt: string | null | undefined, endedAt: string | null | undefined): number | null {
  if (!startedAt || !endedAt) return null;
  const a = Date.parse(startedAt);
  const b = Date.parse(endedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 60_000);
}

/** Conversation row for the API: job clock + signature metadata (never the PNG), minutes on site. */
export function conversationPayload(c: ConversationRow): Record<string, unknown> {
  return {
    ...c,
    job_started_at: c.job_started_at ?? null,
    job_ended_at: c.job_ended_at ?? null,
    signed_by: c.signed_by ?? null,
    signed_at: c.signed_at ?? null,
    signature_note: c.signature_note ?? null,
    minutes_on_site: minutesOnSite(c.job_started_at, c.job_ended_at),
    signed: !!c.signed_at,
  };
}

export const SSE_HEARTBEAT_MS = 15_000;
export const MAX_TEXT_CHARS = 100_000;

/** Open SSE responses (for graceful shutdown). */
interface OpenStream {
  conversationId: string;
  res: Response;
  end(event?: ChatEvent): void;
}
const openStreams = new Set<OpenStream>();

/** Number of SSE responses currently open. */
export function openStreamCount(): number {
  return openStreams.size;
}

/**
 * Shutdown helper: emit error `aborted` on every open SSE response, end it, and abort the turn.
 * Returns how many streams were closed.
 */
export function abortOpenStreams(): number {
  let n = 0;
  for (const s of [...openStreams]) {
    s.end({ type: "error", code: "aborted", message: "Server is shutting down." });
    stopTurn(s.conversationId);
    n += 1;
  }
  return n;
}

/** Lightweight unit summary attached to conversation rows for list badges. */
function unitBadge(u: UnitRow | undefined): Record<string, unknown> | null {
  if (!u) return null;
  return { id: u.id, unit_tag: u.unit_tag, nickname: u.nickname, model: u.model, manufacturer: u.manufacturer, site: u.site, refrigerant: u.refrigerant };
}

function withUnit(deps: AppDeps, c: ConversationRow, testerNames?: Map<string, string>): Record<string, unknown> {
  const unit = c.unit_id ? deps.repos.units.get(c.unit_id) : undefined;
  const testerName = c.tester_id ? (testerNames?.get(c.tester_id) ?? null) : null;
  return { ...conversationPayload(c), unit: unitBadge(unit), unit_tag: unit?.unit_tag ?? null, unit_model: unit?.model ?? null, tester_name: testerName };
}

export function conversationsRouter(deps: AppDeps): Router {
  const r = Router();
  const { repos } = deps;
  const log = deps.log ?? (() => {});

  /**
   * A tester sees only the conversations they started (a foreign id answers 404, like a missing one); the owner
   * sees everything. Call before any read or write on /:id.
   */
  const ownConversation = (req: Parameters<typeof principalOf>[0], id: string): ConversationRow => {
    const conversation = repos.conversations.get(id);
    const testerId = testerIdOf(req);
    if (!conversation || (testerId !== null && (conversation.tester_id ?? null) !== testerId)) throw notFound("Conversation not found.");
    return conversation;
  };
  const testerNames = (): Map<string, string> => new Map(repos.testers.list().map((t) => [t.id, t.name] as const));

  // GET /api/conversations?q=&unit_id=&limit=
  r.get("/", (req, res) => {
    const unitId = optionalId(queryString(req, "unit_id"), "unit_id") ?? undefined;
    const q = queryString(req, "q");
    const limit = queryInt(req, "limit", { min: 1, max: 1000 });
    const testerId = testerIdOf(req);
    const rows = repos.conversations.list({ q, unitId, limit: limit ?? 100, testerId: testerId ?? undefined });
    const names = testerId === null ? testerNames() : undefined;
    res.json({ conversations: rows.map((c) => withUnit(deps, c, names)) });
  });

  // POST /api/conversations {unit_id?, title?}
  r.post("/", (req, res) => {
    const b = body(req);
    const unitId = optionalId(b.unit_id, "unit_id");
    if (unitId && !repos.units.get(unitId)) throw notFound("Unit not found.");
    const title = optString(b.title, "title", 200)?.trim();
    const conversation = repos.conversations.create({ title: title || undefined, unit_id: unitId, tester_id: testerIdOf(req) });
    res.status(201).json({ conversation: withUnit(deps, conversation) });
  });

  // GET /api/conversations/:id[?include=signature] → {conversation, unit, messages, busy, signature?}
  r.get("/:id", (req, res) => {
    const id = requireId(req.params.id);
    const conversation = ownConversation(req, id);
    const unit = conversation.unit_id ? (repos.units.get(conversation.unit_id) ?? null) : null;
    const messages = foldMessages(repos.messages.list(id));
    const out: Record<string, unknown> = { conversation: conversationPayload(conversation), unit, messages, busy: isTurnRunning(id) };
    const include = (queryString(req, "include") ?? "").split(",").map((s) => s.trim());
    if (include.includes("signature")) {
      const png = repos.conversations.signaturePng(id);
      out.signature = png ? { png, signed_by: conversation.signed_by ?? null, signed_at: conversation.signed_at ?? null, note: conversation.signature_note ?? null } : null;
    }
    res.json(out);
  });

  // POST /api/conversations/:id/job {action: start|stop|clear} → {conversation}
  r.post("/:id/job", (req, res) => {
    const id = requireId(req.params.id);
    const existing = repos.conversations.get(id);
    if (!existing) throw notFound("Conversation not found.");
    const action = optEnum<JobAction>(body(req).action, "action", JOB_ACTIONS);
    if (!action) throw badRequest(`action is required: one of ${JOB_ACTIONS.join(", ")}.`);
    const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
    let patch: { job_started_at?: string | null; job_ended_at?: string | null };
    if (action === "start") patch = { job_started_at: nowIso, job_ended_at: null };
    else if (action === "stop") {
      if (!existing.job_started_at) throw badRequest("The job clock has not been started.");
      patch = { job_ended_at: nowIso };
    } else patch = { job_started_at: null, job_ended_at: null };
    const conversation = repos.conversations.setJob(id, patch);
    if (!conversation) throw notFound("Conversation not found.");
    res.json({ conversation: withUnit(deps, conversation) });
  });

  // POST /api/conversations/:id/signature {png (data:image/png;base64,…), signed_by?, note?} → {conversation}
  r.post("/:id/signature", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.conversations.get(id)) throw notFound("Conversation not found.");
    const b = body(req);
    const png = parseSignaturePng(b.png);
    const signedBy = optString(b.signed_by, "signed_by", 120)?.trim() || null;
    const note = optString(b.note, "note", 500)?.trim() || null;
    const conversation = repos.conversations.setSignature(id, { png, signed_by: signedBy, note, signed_at: (deps.now ? deps.now() : new Date()).toISOString() });
    if (!conversation) throw notFound("Conversation not found.");
    res.status(201).json({ conversation: withUnit(deps, conversation) });
  });

  // DELETE /api/conversations/:id/signature → {conversation}
  r.delete("/:id/signature", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.conversations.get(id)) throw notFound("Conversation not found.");
    const conversation = repos.conversations.clearSignature(id);
    if (!conversation) throw notFound("Conversation not found.");
    res.json({ conversation: withUnit(deps, conversation) });
  });

  // PATCH /api/conversations/:id {title?, unit_id?|null}
  r.patch("/:id", (req, res) => {
    const id = requireId(req.params.id);
    ownConversation(req, id);
    const b = body(req);
    const patch: { title?: string; unit_id?: string | null } = {};
    if ("title" in b) {
      const title = optString(b.title, "title", 200)?.trim();
      if (!title) throw badRequest("title must not be empty.");
      patch.title = title;
    }
    if ("unit_id" in b) {
      const unitId = optionalId(b.unit_id, "unit_id");
      if (unitId && !repos.units.get(unitId)) throw notFound("Unit not found.");
      patch.unit_id = unitId;
    }
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to update: send title and/or unit_id.");
    const conversation = repos.conversations.update(id, patch);
    if (!conversation) throw notFound("Conversation not found.");
    res.json({ conversation: withUnit(deps, conversation) });
  });

  // DELETE /api/conversations/:id
  r.delete("/:id", (req, res) => {
    const id = requireId(req.params.id);
    ownConversation(req, id);
    if (isTurnRunning(id)) throw new HttpError(409, "busy", "A response is in progress for this conversation — stop it first.");
    if (!repos.conversations.remove(id)) throw notFound("Conversation not found.");
    res.json({ deleted: true, id });
  });

  // POST /api/conversations/:id/stop → {stopped}
  r.post("/:id/stop", (req, res) => {
    const id = requireId(req.params.id);
    ownConversation(req, id);
    res.json({ stopped: stopTurn(id) });
  });

  // POST /api/conversations/:id/messages {text, images?} → SSE
  r.post("/:id/messages", (req, res) => {
    const id = requireId(req.params.id);
    ownConversation(req, id);
    const b = body(req);
    const text = optString(b.text, "text", MAX_TEXT_CHARS) ?? "";
    const images = parseImages(b.images);
    if (text.trim() === "" && !images) throw badRequest("Message text or at least one image is required.");
    if (isTurnRunning(id)) {
      sendError(res, 409, "busy", "A response is already in progress for this conversation.");
      return;
    }
    const input: UserTurnInput = images ? { text, images } : { text };

    // --- tester budget (Settings → Testers): refuse the turn once today's estimated spend reaches the cap ---
    const principal = principalOf(req);
    const tester = principal.role === "tester" ? repos.testers.get(principal.id) : undefined;
    if (principal.role === "tester" && tester) {
      const budget = testerBudget(repos, tester, deps.config, deps.now ? deps.now() : new Date());
      if (budget.exhausted) {
        const message = capMessage(budget);
        try {
          repos.testers.logEvent({ tester_id: tester.id, kind: "cap", conversation_id: id, code: "cap", detail: message });
        } catch {
          /* bookkeeping only */
        }
        log(`tester ${tester.name} hit the daily cap ($${budget.spentTodayUsd.toFixed(2)} of $${budget.capUsd.toFixed(2)})`);
        sendError(res, 429, "cap", message);
        return;
      }
    }
    const logTesterEvent = (e: ChatEvent): void => {
      if (!tester) return;
      if (e.type !== "done" && e.type !== "error") return;
      try {
        if (e.type === "done") repos.testers.logEvent({ tester_id: tester.id, kind: "turn", conversation_id: id, code: e.model ?? null, detail: e.usage ? `in=${e.usage.input} out=${e.usage.output}` : null });
        else if (e.code !== "aborted") repos.testers.logEvent({ tester_id: tester.id, kind: "error", conversation_id: id, code: e.code, detail: e.message });
      } catch (err) {
        log(`tester event failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (e.type === "error") log(`tester ${tester.name} turn ${id} error: ${e.code} ${e.message}`);
    };

    // --- open the stream ---
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    let closed = false;
    const write = (chunk: string): void => {
      if (closed) return;
      try {
        res.write(chunk);
      } catch (err) {
        closed = true;
        log(`sse write failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const heartbeat = setInterval(() => write(": ping\n\n"), SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      openStreams.delete(stream);
      try {
        res.end();
      } catch {
        /* already gone */
      }
    };
    const stream: OpenStream = {
      conversationId: id,
      res,
      end(event) {
        if (event) write(`data: ${JSON.stringify(event)}\n\n`);
        finish();
      },
    };
    openStreams.add(stream);
    res.on("close", () => {
      // Client went away: emit becomes a no-op; the turn keeps running and persists (DESIGN.md).
      closed = true;
      clearInterval(heartbeat);
      openStreams.delete(stream);
    });

    const emit = (e: ChatEvent): void => {
      logTesterEvent(e);
      write(`data: ${JSON.stringify(e)}\n\n`);
    };
    // runTurn takes the busy lock synchronously (before its first await), so the 409 check above is exact.
    const turnDeps: AppDeps = tester ? { ...deps, client: deps.client, config: deps.config, demo: deps.demo, testerId: tester.id } : deps;
    void runTurn(turnDeps, id, input, emit).then(finish, (err) => {
      log(`runTurn rejected for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      stream.end({ type: "error", code: "internal", message: "The turn failed unexpectedly." });
    });
  });

  return r;
}
