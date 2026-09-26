/* HVAC Field Assistant — service worker.
 *
 * Cache-first app shell (versioned), network-first for GET /api/* with a cache fallback for
 * /api/reference/*, never touches POST or SSE. Offline navigation falls back to the shell itself:
 * app.js shows the offline banner and keeps the on-device calculators usable.
 */
"use strict";

const VERSION = "0.1.0-2026.09.26.2";
const SHELL_CACHE = `hvac-shell-${VERSION}`;
const API_CACHE = `hvac-api-${VERSION}`;
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./calc.js",
  "./styles.css",
  "./manifest.webmanifest",
  "./vendor/marked.umd.js",
  "./vendor/purify.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon-180.png",
  "./icons/favicon-32.png",
];
// Served by the Node server (not a static file) — cached opportunistically, tolerated when absent.
const OPTIONAL = ["./config.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        SHELL.concat(OPTIONAL).map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: "reload" }));
            if (res.ok) await cache.put(url, res);
          } catch {
            /* offline install or optional file missing */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== SHELL_CACHE && n !== API_CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();
});

function offlineJson(message) {
  return new Response(JSON.stringify({ error: { code: "offline", message } }), {
    status: 503,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function networkFirstApi(request, cacheable) {
  // The page sends API requests with cache: "no-store"; key the cache by URL only so such requests can be stored.
  const key = new Request(request.url, { method: "GET" });
  try {
    const res = await fetch(request);
    if (cacheable && res.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(key, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    if (cacheable) {
      const cached = await caches.match(key, { cacheName: API_CACHE });
      if (cached) {
        // Re-wrap so the page can tell a cache fallback from a live answer.
        const headers = new Headers(cached.headers);
        headers.set("X-HVAC-Cache", "hit");
        headers.set("X-HVAC-Cached-At", cached.headers.get("date") || "");
        return new Response(await cached.arrayBuffer(), { status: cached.status, statusText: cached.statusText, headers });
      }
    }
    return offlineJson("You are offline and this data is not cached.");
  }
}

async function cacheFirstShell(request, url) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok && (res.type === "basic" || res.type === "default")) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    if (request.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith("/index.html")) {
      const shell = (await cache.match("./index.html")) || (await cache.match("./"));
      if (shell) return shell;
    }
    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

async function networkFirstStatic(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response("", { status: 204 });
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // POST/PATCH/DELETE and SSE POSTs go straight to the network
  const accept = req.headers.get("accept") || "";
  if (accept.includes("text/event-stream")) return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // a configured remote API base is never intercepted

  if (url.pathname.startsWith("/api/") || url.pathname.includes("/api/")) {
    const apiPath = url.pathname.slice(url.pathname.indexOf("/api/"));
    if (apiPath.startsWith("/api/conversations/") && apiPath.endsWith("/messages")) return;
    const cacheable = apiPath.startsWith("/api/reference/");
    event.respondWith(networkFirstApi(req, cacheable));
    return;
  }
  if (url.pathname.endsWith("/config.js")) {
    event.respondWith(networkFirstStatic(req));
    return;
  }
  if (req.mode === "navigate") {
    event.respondWith(cacheFirstShell(new Request("./index.html"), url));
    return;
  }
  event.respondWith(cacheFirstShell(req, url));
});
