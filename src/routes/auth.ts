import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";
import type { Request, RequestHandler } from "express";
import type { TesterRow } from "../types.ts";
import { sendError } from "./util.ts";

/**
 * Who a request is from, decided by authMiddleware and stored in res.locals.principal:
 *  - owner: the APP_PASSWORD holder, or anyone when no password is configured (loopback-only install);
 *  - tester: a Settings → Testers login (its own password; usage attributed and capped, owner-only routes refused).
 */
export type Principal = { role: "owner" } | { role: "tester"; id: string; name: string };

/** Minimal tester lookup the middleware needs (Repos["testers"] satisfies it). */
export interface TesterSource {
  list(): TesterRow[];
  getByName(name: string): TesterRow | undefined;
  touch(id: string): void;
}

/** How often last_seen_at is written per tester (one UPDATE per request would be wasteful). */
export const TESTER_TOUCH_INTERVAL_MS = 60_000;

const REALM = "HVAC Field Assistant";
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const WITH_BODY = new Set(["POST", "PUT", "PATCH"]);
const CORS_ALLOW_HEADERS = "Authorization, Content-Type";
const CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
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

/** Hex SHA-256 of a tester password, as stored in testers.password_sha256. */
export function hashTesterPassword(password: string): string {
  return createHash("sha256").update(password, "utf8").digest("hex");
}

/** A fresh tester password: 16 chars from an unambiguous alphabet (no 0/O/1/l), ~82 bits. */
export function generateTesterPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

/** Credentials from an Authorization header: Basic (username kept, may name a tester) or Bearer <password>. */
export function credentialsFromAuthorization(header: string | undefined): { username: string | null; password: string } | undefined {
  if (typeof header !== "string") return undefined;
  const m = /^\s*(Basic|Bearer)\s+(.+?)\s*$/i.exec(header);
  if (!m) return undefined;
  const scheme = m[1]!.toLowerCase();
  const value = m[2]!;
  if (scheme === "bearer") return { username: null, password: value };
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const colon = decoded.indexOf(":");
  return colon >= 0 ? { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) } : { username: null, password: decoded };
}

/** Extract the password from an Authorization header: Basic (any username) or Bearer <password>. */
export function passwordFromAuthorization(header: string | undefined): string | undefined {
  return credentialsFromAuthorization(header)?.password;
}

/** The principal authMiddleware attached (owner when auth is off or the middleware did not run). */
export function principalOf(req: Request): Principal {
  const p = (req.res?.locals as { principal?: Principal } | undefined)?.principal;
  return p ?? { role: "owner" };
}

/** Tester id of the request, or null for the owner. */
export function testerIdOf(req: Request): string | null {
  const p = principalOf(req);
  return p.role === "tester" ? p.id : null;
}

/**
 * Match a supplied password against the tester table. The Basic username, when it names a tester, narrows
 * the comparison to that row; otherwise every enabled-or-disabled row is compared (constant time each) so a
 * disabled tester gets a clear message instead of a generic 401.
 */
export function matchTester(testers: TesterSource, creds: { username: string | null; password: string }): { tester: TesterRow; disabled: boolean } | undefined {
  const digest = hashTesterPassword(creds.password);
  const candidates = creds.username ? [testers.getByName(creds.username)].filter((t): t is TesterRow => !!t) : [];
  const rows = candidates.length > 0 ? candidates : testers.list();
  for (const t of rows) {
    if (t.password_sha256.length === digest.length && timingSafeEqual(Buffer.from(t.password_sha256, "hex"), Buffer.from(digest, "hex"))) {
      return { tester: t, disabled: t.disabled !== 0 };
    }
  }
  return undefined;
}

/** Only the owner may continue; testers get 403. Mount on /api/settings, /api/usage, /api/testers, /api/export. */
export function ownerOnly(): RequestHandler {
  return (req, res, next) => {
    if (principalOf(req).role === "owner") return next();
    sendError(res, 403, "forbidden", "Only the app owner can do that.");
  };
}

/**
 * HTTP auth: `Basic` (any username) or `Bearer <APP_PASSWORD>` (native shells / PWA Settings screen),
 * both compared in constant time. Exempt: CORS preflights and the public paths (`isPublicPath`, decided on
 * the decoded + normalized path so dot segments cannot smuggle protected files under a public prefix).
 * Passthrough when no password is configured. A 401 always carries WWW-Authenticate so browsers can
 * prompt; native clients read the JSON envelope and open Settings instead.
 */
export function authMiddleware(appPassword: string | null | undefined, testers?: TesterSource, opts: { now?: () => number } = {}): RequestHandler {
  const expected = typeof appPassword === "string" && appPassword !== "" ? appPassword : null;
  const clock = opts.now ?? Date.now;
  const lastTouch = new Map<string, number>();
  return (req, res, next) => {
    res.locals.principal = { role: "owner" } satisfies Principal;
    if (!expected) return next();
    if (req.method === "OPTIONS") return next();
    if (isPublicPath(req.path)) return next();
    const creds = credentialsFromAuthorization(req.headers.authorization);
    if (creds !== undefined && secretsMatch(creds.password, expected)) return next();
    if (creds !== undefined && testers) {
      const hit = matchTester(testers, creds);
      if (hit && !hit.disabled) {
        res.locals.principal = { role: "tester", id: hit.tester.id, name: hit.tester.name } satisfies Principal;
        const t = clock();
        if ((lastTouch.get(hit.tester.id) ?? 0) + TESTER_TOUCH_INTERVAL_MS <= t) {
          lastTouch.set(hit.tester.id, t);
          try {
            testers.touch(hit.tester.id);
          } catch {
            /* bookkeeping only */
          }
        }
        return next();
      }
      if (hit && hit.disabled) {
        res.setHeader("WWW-Authenticate", `Basic realm="${REALM}", charset="UTF-8"`);
        sendError(res, 401, "auth", "This tester login has been turned off. Ask the app owner to enable it again.");
        return;
      }
    }
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
