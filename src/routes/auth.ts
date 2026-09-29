import { createHash, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";
import type { RequestHandler } from "express";
import { sendError } from "./util.ts";

const REALM = "HVAC Field Assistant";
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const WITH_BODY = new Set(["POST", "PUT", "PATCH"]);
const CORS_ALLOW_HEADERS = "Authorization, Content-Type";
const CORS_ALLOW_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const CORS_MAX_AGE_S = 600;

/** Paths that never require auth: health, the client config, and the PWA files a browser must fetch before it can sign in. */
const PUBLIC_EXACT = new Set(["/api/health", "/config.js", "/manifest.webmanifest", "/sw.js"]);
const PUBLIC_PREFIXES = ["/icons/"];

/**
 * The request path as the static file server will resolve it: percent-decoded, with `.`/`..` segments
 * and duplicate slashes collapsed (`/icons/../app.js`, `/icons/%2e%2e/app.js` and `/icons/..%2fapp.js`
 * all become `/app.js`). Express leaves `req.path` raw and serve-static normalizes afterwards, so any
 * path-based exemption must be decided on this form. Returns null when the path cannot be decoded.
 */
export function normalizeRequestPath(path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const normalized = posix.normalize(decoded.startsWith("/") ? decoded : `/${decoded}`);
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

/** True for the handful of paths served without a password (see PUBLIC_EXACT / PUBLIC_PREFIXES). */
export function isPublicPath(path: string): boolean {
  const normalized = normalizeRequestPath(path);
  if (normalized === null) return false;
  const p = normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  if (PUBLIC_EXACT.has(p)) return true;
  return PUBLIC_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Lower-cased, trailing-slash-free allowlist for O(1) origin lookups. */
function normalizeAllowlist(allowOrigins: readonly string[]): Set<string> {
  return new Set(allowOrigins.map((o) => o.trim().replace(/\/+$/, "").toLowerCase()).filter(Boolean));
}

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
 * HTTP auth: `Basic` (any username) or `Bearer <APP_PASSWORD>` (native shells / PWA Settings screen),
 * both compared in constant time. Exempt: CORS preflights and the public paths (`isPublicPath`, decided on
 * the decoded + normalized path so dot segments cannot smuggle protected files under a public prefix).
 * Passthrough when no password is configured. A 401 always carries WWW-Authenticate so browsers can
 * prompt; native clients read the JSON envelope and open Settings instead.
 */
export function authMiddleware(appPassword: string | null | undefined): RequestHandler {
  const expected = typeof appPassword === "string" && appPassword !== "" ? appPassword : null;
  return (req, res, next) => {
    if (!expected) return next();
    if (req.method === "OPTIONS") return next();
    if (isPublicPath(req.path)) return next();
    const supplied = passwordFromAuthorization(req.headers.authorization);
    if (supplied !== undefined && secretsMatch(supplied, expected)) return next();
    res.setHeader("WWW-Authenticate", `Basic realm="${REALM}", charset="UTF-8"`);
    sendError(res, 401, "auth", "Authentication required — enter the app password (any username) or a Bearer token.");
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
  const allowed = normalizeAllowlist(allowOrigins);
  return (req, res, next) => {
    if (!STATE_CHANGING.has(req.method)) return next();
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "") {
      const host = (req.headers.host ?? "").toLowerCase();
      // Behind a reverse proxy (Tailscale serve, Caddy, nginx) the Host header may name the backend while the
      // browser's Origin names the public host; the proxy then carries the public host in X-Forwarded-Host.
      // A cross-site browser request cannot set that header (it is not CORS-safelisted), so trusting it is safe.
      const forwardedRaw = req.headers["x-forwarded-host"];
      const forwardedHost = ((Array.isArray(forwardedRaw) ? forwardedRaw[0] : forwardedRaw) ?? "").split(",")[0]!.trim().toLowerCase();
      const originHost = hostOf(origin);
      const sameHost = originHost !== null && (originHost === host || (forwardedHost !== "" && originHost === forwardedHost));
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
 * CORS for allowlisted origins (native shells such as `capacitor://localhost`). Exact-match allowlist:
 * the origin is echoed in `Access-Control-Allow-Origin` (never `*`), `Vary: Origin` is always added so
 * caches keep per-origin copies, preflights are answered 204 before auth runs. Credentials are not
 * enabled — the client sends `Authorization: Bearer` explicitly, which is an allowed header. A preflight
 * from an origin that is not listed gets an empty 204 without CORS headers, which the browser treats as
 * a rejection. No-op when the allowlist is empty (same-origin only).
 */
export function corsMiddleware(allowOrigins: readonly string[] = []): RequestHandler {
  const allowed = normalizeAllowlist(allowOrigins);
  return (req, res, next) => {
    if (allowed.size === 0) return next();
    res.vary("Origin");
    const origin = req.headers.origin;
    const isPreflight = req.method === "OPTIONS" && typeof req.headers["access-control-request-method"] === "string";
    if (typeof origin !== "string" || !allowed.has(origin.toLowerCase())) {
      if (isPreflight) {
        res.status(204).end();
        return;
      }
      return next();
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
    res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Max-Age", String(CORS_MAX_AGE_S));
      res.status(204).end();
      return;
    }
    next();
  };
}
