import { Router, type Response } from "express";
import type { AppDeps } from "../app.ts";
import { isTurnRunning, runTurn, stopTurn, type UserTurnInput } from "../agent/chat.ts";
import type { ChatEvent, ConversationRow, UnitRow } from "../types.ts";
import { HttpError, badRequest, body, foldMessages, notFound, optString, optionalId, parseImages, queryInt, queryString, requireId, sendError } from "./util.ts";

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

function withUnit(deps: AppDeps, c: ConversationRow): Record<string, unknown> {
  const unit = c.unit_id ? deps.repos.units.get(c.unit_id) : undefined;
  return { ...c, unit: unitBadge(unit), unit_tag: unit?.unit_tag ?? null, unit_model: unit?.model ?? null };
}

export function conversationsRouter(deps: AppDeps): Router {
  const r = Router();
  const { repos } = deps;
  const log = deps.log ?? (() => {});

  // GET /api/conversations?q=&unit_id=&limit=
  r.get("/", (req, res) => {
    const unitId = optionalId(queryString(req, "unit_id"), "unit_id") ?? undefined;
    const q = queryString(req, "q");
    const limit = queryInt(req, "limit", { min: 1, max: 1000 });
    const rows = repos.conversations.list({ q, unitId, limit: limit ?? 100 });
    res.json({ conversations: rows.map((c) => withUnit(deps, c)) });
  });

  // POST /api/conversations {unit_id?, title?}
  r.post("/", (req, res) => {
    const b = body(req);
    const unitId = optionalId(b.unit_id, "unit_id");
    if (unitId && !repos.units.get(unitId)) throw notFound("Unit not found.");
    const title = optString(b.title, "title", 200)?.trim();
    const conversation = repos.conversations.create({ title: title || undefined, unit_id: unitId });
    res.status(201).json({ conversation: withUnit(deps, conversation) });
  });

  // GET /api/conversations/:id → {conversation, unit, messages, busy}
  r.get("/:id", (req, res) => {
    const id = requireId(req.params.id);
    const conversation = repos.conversations.get(id);
    if (!conversation) throw notFound("Conversation not found.");
    const unit = conversation.unit_id ? (repos.units.get(conversation.unit_id) ?? null) : null;
    const messages = foldMessages(repos.messages.list(id));
    res.json({ conversation, unit, messages, busy: isTurnRunning(id) });
  });

  // PATCH /api/conversations/:id {title?, unit_id?|null}
  r.patch("/:id", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.conversations.get(id)) throw notFound("Conversation not found.");
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
    if (isTurnRunning(id)) throw new HttpError(409, "busy", "A response is in progress for this conversation — stop it first.");
    if (!repos.conversations.remove(id)) throw notFound("Conversation not found.");
    res.json({ deleted: true, id });
  });

  // POST /api/conversations/:id/stop → {stopped}
  r.post("/:id/stop", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.conversations.get(id)) throw notFound("Conversation not found.");
    res.json({ stopped: stopTurn(id) });
  });

  // POST /api/conversations/:id/messages {text, images?} → SSE
  r.post("/:id/messages", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.conversations.get(id)) throw notFound("Conversation not found.");
    const b = body(req);
    const text = optString(b.text, "text", MAX_TEXT_CHARS) ?? "";
    const images = parseImages(b.images);
    if (text.trim() === "" && !images) throw badRequest("Message text or at least one image is required.");
    if (isTurnRunning(id)) {
      sendError(res, 409, "busy", "A response is already in progress for this conversation.");
      return;
    }
    const input: UserTurnInput = images ? { text, images } : { text };

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
      write(`data: ${JSON.stringify(e)}\n\n`);
    };
    // runTurn takes the busy lock synchronously (before its first await), so the 409 check above is exact.
    void runTurn(deps, id, input, emit).then(finish, (err) => {
      log(`runTurn rejected for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      stream.end({ type: "error", code: "internal", message: "The turn failed unexpectedly." });
    });
  });

  return r;
}
