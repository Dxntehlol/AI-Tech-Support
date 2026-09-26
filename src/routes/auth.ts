import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { sendError } from "./util.ts";

const REALM = "HVAC Field Assistant";
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/** Constant-time comparison of two secrets via their SHA-256 digests. */
export function secretsMatch(candidate: string, expected: string): boolean {
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

/** Extract the password from an Authorization header: Basic (any username) or Bearer <password>. */
export function passwordFromAuthorization(header: string | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const m = /^\s*(Basic|Bearer)\s+(.+?)\s*$/i.exec(header);
  if (!m) return undefined;
  const scheme = m[1]!.toLowerCase();
  const value = m[2]!;
  if (scheme === "bearer") return value;
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const colon = decoded.indexOf(":");
  return colon >= 0 ? decoded.slice(colon + 1) : decoded;
}

/**
 * HTTP basic auth (any username; Bearer <password> also accepted for native shells). /api/health and
 * CORS preflights are exempt. Passthrough when no password is configured.
 */
export function authMiddleware(appPassword: string | null | undefined): RequestHandler {
  const expected = typeof appPassword === "string" && appPassword !== "" ? appPassword : null;
  return (req, res, next) => {
    if (!expected) return next();
    if (req.method === "OPTIONS") return next();
    if (req.path === "/api/health" || req.path === "/api/health/") return next();
    const supplied = passwordFromAuthorization(req.headers.authorization);
    if (supplied !== undefined && secretsMatch(supplied, expected)) return next();
    res.setHeader("WWW-Authenticate", `Basic realm="${REALM}", charset="UTF-8"`);
    sendError(res, 401, "auth", "Authentication required — enter the app password (any username).");
  };
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Cross-origin guards for state-changing /api requests:
 *  - when an Origin header is present its host must equal the request Host (or be allowlisted) → 403;
 *  - POST/PUT/PATCH must carry Content-Type: application/json → 400 validation.
 */
export function originAndContentTypeGuard(allowOrigins: readonly string[] = []): RequestHandler {
  const allowed = new Set(allowOrigins.map((o) => o.trim().toLowerCase()).filter(Boolean));
  return (req, res, next) => {
    if (!STATE_CHANGING.has(req.method)) return next();
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "") {
      const host = (req.headers.host ?? "").toLowerCase();
      const originHost = hostOf(origin);
      const sameHost = originHost !== null && originHost === host;
      if (!sameHost && !allowed.has(origin.toLowerCase())) {
        sendError(res, 403, "forbidden", "Cross-origin request rejected (Origin does not match Host).");
        return;
      }
    }
    if (WITH_BODY.has(req.method)) {
      const ct = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (ct !== "application/json") {
        sendError(res, 400, "validation", "Content-Type must be application/json.");
        return;
      }
    }
    next();
  };
}

/**
 * CORS for allowlisted origins (native shells): echoes the origin, allows Authorization + Content-Type,
 * answers preflights with 204. No-op when the allowlist is empty or the origin is not listed.
 */
export function corsMiddleware(allowOrigins: readonly string[] = []): RequestHandler {
  const allowed = new Set(allowOrigins.map((o) => o.trim().toLowerCase()).filter(Boolean));
  return (req, res, next) => {
    if (allowed.size === 0) return next();
    const origin = req.headers.origin;
    res.setHeader("Vary", "Origin");
    if (typeof origin !== "string" || !allowed.has(origin.toLowerCase())) {
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      return next();
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
