/* HVAC Field Assistant — web client (plain ES2020+, no build step).
 *
 * Talks to the HTTP API described in DESIGN.md. Every request goes through api()/apiJson()
 * (configurable base + optional Bearer token). Chat replies stream over SSE via fetch + POST.
 * Screens are routed through location.hash (#chat/<id>, #unit/<id>, #readings, #history, #settings)
 * so browser/OS back gestures work in the PWA and native shells.
 * Pure helpers are exported on globalThis.HVAC_UI so they can be unit-tested outside a browser;
 * boot() only runs when a DOM is present.
 */
"use strict";

const APP_VERSION = "0.1.0";

/* ------------------------------------------------------------------------------------------
 * Pure helpers (no DOM)
 * ---------------------------------------------------------------------------------------- */

/** Parse complete SSE frames out of a text buffer. Returns parsed JSON `data:` payloads and the unconsumed remainder. */
function parseSseFrames(buffer) {
  const events = [];
  let rest = buffer;
  for (;;) {
    const m = /\r?\n\r?\n/.exec(rest);
    if (!m) break;
    const frame = rest.slice(0, m.index);
    rest = rest.slice(m.index + m[0].length);
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue; // comment / heartbeat
      if (!line.startsWith("data:")) continue; // event:, id:, retry: are ignored
      const raw = line.slice(5).replace(/^ /, "");
      if (!raw) continue;
      try {
        events.push(JSON.parse(raw));
      } catch {
        /* malformed frame: skip */
      }
    }
  }
  return { events, rest };
}

/** The server heartbeats every 15 s; a stream with no bytes for this long is treated as half-open. */
const SSE_IDLE_MS = 45000;

/**
 * Read an SSE body until it ends, aborts, or falls silent for `idleMs` (a half-open socket after a Wi-Fi→LTE
 * hand-off keeps reader.read() pending forever; the ': ping' comments reset the watchdog). Every parsed event is
 * passed to onEvent. Resolves {terminal, idle}: `terminal` is the done/error event if one arrived, `idle` is true
 * when the watchdog cancelled the reader.
 */
async function pumpSse(reader, onEvent, { idleMs = SSE_IDLE_MS, timers = globalThis } = {}) {
  const decoder = new TextDecoder();
  let buf = "";
  let terminal = null;
  let idle = false;
  const handle = (events) => {
    for (const ev of events) {
      onEvent(ev);
      if (ev && (ev.type === "done" || ev.type === "error")) terminal = ev;
    }
  };
  for (;;) {
    let timer = null;
    const watchdog = new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve({ idle: true }), idleMs);
    });
    let result;
    try {
      result = await Promise.race([reader.read(), watchdog]);
    } finally {
      timers.clearTimeout(timer);
    }
    if (result && result.idle) {
      idle = true;
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      break;
    }
    if (result.done) break;
    buf += decoder.decode(result.value, { stream: true });
    const parsed = parseSseFrames(buf);
    buf = parsed.rest;
    handle(parsed.events);
  }
  buf += decoder.decode();
  handle(parseSseFrames(buf + "\n\n").events);
  return { terminal, idle };
}

/** Everything reconcile() cares about, as one comparable string: busy flag, message ids/seqs, title, attached unit. */
function conversationFingerprint(data) {
  const conv = (data && data.conversation) || null;
  const unit = (data && data.unit) || null;
  const messages = Array.isArray(data && data.messages) ? data.messages : [];
  const ids = messages.map((m) => `${m.id}:${m.seq}:${(m.tools && m.tools.length) || 0}:${(m.text || "").length}`);
  return [
    data && data.busy ? "busy" : "idle",
    conv ? `${conv.id || ""}|${conv.title || ""}|${conv.updated_at || ""}` : "",
    unit ? `${unit.id || ""}|${unit.updated_at || ""}` : "",
    ids.join(","),
  ].join("\n");
}

/** Drop the optimistic local echo of a message the server did not accept. */
function dropLocalEcho(messages, localId) {
  return messages.filter((m) => m.id !== localId);
}

/** True when a fetch Response came from the real server, not the service worker's cache fallback or offline stub. */
function serverReachable(res) {
  if (!res) return false;
  const cache = res.headers && typeof res.headers.get === "function" ? res.headers.get("x-hvac-cache") : null;
  if (cache === "hit") return false;
  if (res.status === 503) return false; // the service worker answers 503 when the network is down
  return true;
}

/** Backoff for re-checking /api/health while the "server unreachable" banner is up: 5, 10, 20, 40, 60, 60… s. */
function healthRetryDelay(attempt) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(60000, 5000 * 2 ** n);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Relative time ("just now", "5 min", "3 h", "2 d", else short date). */
function relTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d`;
  const dt = new Date(t);
  const nowDt = new Date(now);
  const opts = { month: "short", day: "numeric" };
  if (dt.getFullYear() !== nowDt.getFullYear()) opts.year = "numeric";
  return dt.toLocaleDateString(undefined, opts);
}

function dayKey(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayLabel(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const k = dayKey(iso);
  if (k === dayKey(new Date(now).toISOString())) return "Today";
  if (k === dayKey(new Date(now - 86400000).toISOString())) return "Yesterday";
  return new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function timeOfDay(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Group units by site (null/empty → "No site"), sites sorted, units sorted by tag/model. */
function groupUnitsBySite(units) {
  const groups = new Map();
  for (const u of units) {
    const site = (u.site || "").trim() || "No site";
    if (!groups.has(site)) groups.set(site, []);
    groups.get(site).push(u);
  }
  const out = [...groups.entries()].sort((a, b) => {
    if (a[0] === "No site") return 1;
    if (b[0] === "No site") return -1;
    return a[0].localeCompare(b[0]);
  });
  for (const [, list] of out) list.sort((a, b) => unitLabel(a).localeCompare(unitLabel(b)));
  return out;
}

function unitLabel(u) {
  if (!u) return "";
  return u.unit_tag || u.nickname || u.model || "Unit";
}

function unitBadgeText(u) {
  if (!u) return "";
  return u.unit_tag || u.model || u.nickname || "";
}

/** Case-insensitive unit filter over site/customer/tag/nickname/model/serial/manufacturer. */
function filterUnits(units, q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return units;
  const terms = needle.split(/\s+/).filter(Boolean);
  return units.filter((u) => {
    const hay = [u.site, u.customer, u.unit_tag, u.nickname, u.model, u.serial, u.manufacturer, u.brand, u.refrigerant].filter(Boolean).join(" ").toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

const STATUS_ORDER = { open: 0, monitor: 1, resolved: 2 };

/** open/monitor first, then resolved; newest first within a status. */
function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 3;
    const sb = STATUS_ORDER[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    return (Date.parse(b.service_date || b.created_at || 0) || 0) - (Date.parse(a.service_date || a.created_at || 0) || 0);
  });
}

function isHypothesis(f) {
  return f.origin === "assistant" && !Number(f.confirmed);
}

/** True when the decode needs a nameplate check (no match or any best match below "high"). */
function needsNameplateVerify(decoded) {
  if (!decoded) return true;
  const best = [decoded.model && decoded.model[0], decoded.serial && decoded.serial[0]];
  if (!best[0] && !best[1]) return true;
  return best.some((m) => m && m.confidence !== "high") || !best[0] || !best[1];
}

function toNum(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim().replace(/,/g, "");
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Build DxMeasurements from a plain object of form values (strings). Numbers parsed, blanks dropped. */
function buildMeasurements(values) {
  const numeric = [
    "suctionPsig", "suctionLineTempF", "liquidPsig", "liquidLineTempF", "dischargeLineTempF",
    "outdoorDbF", "indoorDbF", "indoorWbF", "supplyDbF", "externalStaticInWc",
    "compressorAmps", "compressorAmpsL2", "compressorAmpsL3", "compressorRla", "capacityPercent", "elevationFt",
  ];
  const out = {
    refrigerant: String(values.refrigerant || "").trim(),
    meteringDevice: values.meteringDevice || "unknown",
    mode: values.mode || "ac_cooling",
  };
  if (values.circuit && String(values.circuit).trim()) out.circuit = String(values.circuit).trim();
  if (values.economizerPosition) out.economizerPosition = values.economizerPosition;
  for (const k of numeric) {
    const n = toNum(values[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

const MODE_LABEL = {
  ac_cooling: "AC cooling",
  heat_pump_cooling: "heat pump cooling",
  heat_pump_heating: "heat pump heating",
  refrigeration: "refrigeration",
};
const METERING_LABEL = { txv: "TXV", fixed: "fixed orifice", eev: "EEV", unknown: "metering device unknown" };

function fmtNum(n, digits = 1) {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n ?? "");
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  return String(r);
}

/** Compact readings message for the chat: every entered value with units. */
function composeReadingsMessage(m, derived) {
  const head = [];
  if (m.circuit) head.push(`circuit ${m.circuit}`);
  if (m.refrigerant) head.push(m.refrigerant);
  head.push(METERING_LABEL[m.meteringDevice] || m.meteringDevice);
  head.push(MODE_LABEL[m.mode] || m.mode);
  const parts = [];
  const pair = (label, a, aUnit, b, bUnit) => {
    const bits = [];
    if (a !== undefined) bits.push(`${fmtNum(a)} ${aUnit}`);
    if (b !== undefined) bits.push(`${fmtNum(b)} ${bUnit}`);
    if (bits.length) parts.push(`${label} ${bits.join(" / ")}`);
  };
  pair("suction", m.suctionPsig, "psig", m.suctionLineTempF, "°F line");
  pair("liquid", m.liquidPsig, "psig", m.liquidLineTempF, "°F line");
  if (m.dischargeLineTempF !== undefined) parts.push(`discharge line ${fmtNum(m.dischargeLineTempF)} °F`);
  if (m.outdoorDbF !== undefined) parts.push(`outdoor ${fmtNum(m.outdoorDbF)} °F DB`);
  pair("entering", m.indoorDbF, "°F DB", m.indoorWbF, "°F WB");
  if (m.supplyDbF !== undefined) parts.push(`supply ${fmtNum(m.supplyDbF)} °F`);
  const amps = [];
  if (m.compressorAmps !== undefined) amps.push(`L1 ${fmtNum(m.compressorAmps)}`);
  if (m.compressorAmpsL2 !== undefined) amps.push(`L2 ${fmtNum(m.compressorAmpsL2)}`);
  if (m.compressorAmpsL3 !== undefined) amps.push(`L3 ${fmtNum(m.compressorAmpsL3)}`);
  if (amps.length) parts.push(`compressor amps ${amps.join(" / ")} A`);
  if (m.compressorRla !== undefined) parts.push(`RLA ${fmtNum(m.compressorRla)} A`);
  if (m.externalStaticInWc !== undefined) parts.push(`ESP ${fmtNum(m.externalStaticInWc, 2)} in. wc`);
  if (m.capacityPercent !== undefined) parts.push(`capacity ${fmtNum(m.capacityPercent)} %`);
  if (m.economizerPosition) parts.push(`economizer ${m.economizerPosition}`);
  if (m.elevationFt !== undefined) parts.push(`elevation ${fmtNum(m.elevationFt, 0)} ft`);
  let text = `Readings (${head.join(", ")}): ${parts.length ? parts.join("; ") : "no measurements entered"}.`;
  if (derived) {
    const d = [];
    if (derived.evapSatF !== undefined) d.push(`evap sat ${fmtNum(derived.evapSatF)} °F`);
    if (derived.condSatF !== undefined) d.push(`cond sat ${fmtNum(derived.condSatF)} °F`);
    if (derived.superheatF !== undefined) d.push(`SH ${fmtNum(derived.superheatF)} °F`);
    if (derived.subcoolingF !== undefined) d.push(`SC ${fmtNum(derived.subcoolingF)} °F`);
    if (derived.deltaTF !== undefined) d.push(`ΔT ${fmtNum(derived.deltaTF)} °F`);
    if (derived.compressionRatio !== undefined) d.push(`CR ${fmtNum(derived.compressionRatio, 2)}`);
    if (d.length) text += ` Derived: ${d.join(", ")}.`;
  }
  return text;
}

/** Accept either a bare array or an envelope ({units: [...]}, {conversations: [...]}, {hits: [...]}, {items: [...]}). */
function pickList(json, ...keys) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    for (const k of [...keys, "items", "results", "data"]) if (Array.isArray(json[k])) return json[k];
  }
  return [];
}

/** Compose a one-line chat message from a calculator result. */
function composeCalcMessage(title, inputs, result) {
  const inParts = Object.entries(inputs)
    .filter(([, v]) => v !== undefined && v !== "" && v !== null)
    .map(([k, v]) => `${k} ${v}`);
  const outParts = [];
  if (result && typeof result === "object") {
    const values = result.values && typeof result.values === "object" ? result.values : result;
    for (const [k, v] of Object.entries(values)) {
      if (k === "source" || k === "cachedAt" || k === "estimated") continue;
      if (typeof v === "number") outParts.push(`${k} ${fmtNum(v, 2)}`);
      else if (typeof v === "string" && k !== "kind" && k !== "refrigerant") outParts.push(`${k} ${v}`);
    }
  }
  let text = `${title}: ${inParts.join(", ")}`;
  if (outParts.length) text += ` → ${outParts.join(", ")}`;
  const notes = [].concat(result?.interpretation || [], result?.notes || [], result?.warnings || []).filter((x) => typeof x === "string");
  if (notes.length) text += `. ${notes.join(" ")}`;
  return text;
}

/** Parse a location.hash into a route. */
function parseHash(raw) {
  const s = String(raw || "").replace(/^#\/?/, "");
  const parts = s.split("/").map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  }).filter(Boolean);
  const isId = (x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x);
  const r = { screen: "chat", conv: null, unit: null, sheet: null, pane: "dx", isNew: false, finding: null };
  switch (parts[0]) {
    case undefined:
    case "chat":
      r.screen = "chat";
      if (parts[1] === "new") r.isNew = true;
      else if (isId(parts[1])) {
        r.conv = parts[1];
        if (parts[2] === "share") r.sheet = "share";
        else if (parts[2] === "pick") r.sheet = "pick"; // unit picker (attach to this chat)
      } else if (parts[1] === "pick") r.sheet = "pick";
      break;
    case "units":
      r.screen = "units";
      if (parts[1] === "decode") r.sheet = "decode";
      else if (parts[1] === "import") r.sheet = "import";
      else if (parts[1] === "labels") r.sheet = "labels";
      else if (parts[1] === "actions") r.sheet = "unitsActions";
      break;
    case "unit":
      r.screen = "units";
      if (isId(parts[1])) r.unit = parts[1];
      if (parts[2] === "actions") r.sheet = "actions";
      else if (parts[2] === "edit") r.sheet = "decode";
      else if (parts[2] === "correct" && r.unit) r.sheet = "correct";
      else if (parts[2] === "qr" && r.unit) r.sheet = "qr";
      else if (parts[2] === "report" && r.unit) r.sheet = "report";
      else if (parts[2] === "finding" && r.unit) {
        r.sheet = "finding"; // add a finding, or edit one (#unit/<id>/finding/<findingId>)
        r.finding = isId(parts[3]) ? parts[3] : null;
      }
      break;
    case "readings":
      r.screen = "readings";
      if (parts[1] === "calcs") r.pane = "calcs";
      else if (parts[1] === "pick") r.sheet = "pick"; // unit picker (save readings to a unit)
      break;
    case "history":
      r.screen = "history";
      break;
    case "settings":
      r.screen = "settings";
      break;
    default:
      r.screen = "chat";
  }
  return r;
}

/** Group search hits: message hits by conversation, finding hits by unit, unit hits together. */
function groupSearchHits(hits, unitsById = new Map()) {
  const groups = new Map();
  for (const hit of hits) {
    let key;
    let title;
    let kind;
    if (hit.kind === "message") {
      key = `c:${hit.conversationId || hit.id}`;
      title = hit.conversationTitle || "Conversation";
      kind = "conversation";
    } else if (hit.kind === "finding") {
      key = hit.unitId ? `u:${hit.unitId}` : hit.conversationId ? `c:${hit.conversationId}` : "f:none";
      const u = hit.unitId ? unitsById.get(hit.unitId) : null;
      title = u ? unitLabel(u) : hit.unitId ? "Unit" : hit.conversationTitle || "Findings";
      kind = "unit";
    } else {
      key = "units";
      title = "Units";
      kind = "units";
    }
    if (!groups.has(key)) groups.set(key, { key, title, kind, conversationId: hit.conversationId, unitId: hit.unitId, hits: [] });
    groups.get(key).hits.push(hit);
  }
  return [...groups.values()].sort((a, b) => Math.min(...a.hits.map((h) => h.rank)) - Math.min(...b.hits.map((h) => h.rank)));
}

const FALLBACK_REFRIGERANTS = [
  "R-410A", "R-22", "R-32", "R-454B", "R-134a", "R-513A", "R-407C", "R-407A", "R-407F", "R-404A", "R-507A",
  "R-448A", "R-449A", "R-452A", "R-438A", "R-422D", "R-427A", "R-421A", "R-417A", "R-422B", "R-434A", "R-454A",
  "R-454C", "R-455A", "R-450A", "R-515B", "R-744", "R-290", "R-600a", "R-1234yf", "R-1234ze(E)", "R-123",
  "R-1233zd(E)", "R-245fa", "R-717", "R-11", "R-12", "R-500", "R-502", "R-401A", "R-409A", "R-408A", "R-402A", "R-152a", "R-23",
];

const DECODE_PROMPT =
  "Here is a photo of the unit nameplate. Read the manufacturer, model number and serial number from it, " +
  "then call decode_unit with what you read and tell me family, tonnage, voltage/phase, refrigerant, control platform and manufacture date. " +
  "If any character is unclear, say which one and ask me to confirm before saving the unit.";

const QUICK_PROMPTS = {
  dead: "The unit is completely dead — no fans, no compressor, nothing. Walk me through the electrical checks in order, one step at a time with what to expect.",
  history: "What did we do last time on this unit? Summarize prior findings, open items and any refrigerant added.",
};

/* ---------- AI connection + usage helpers ---------- */

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** "$0.42", "< $0.01", "$1,234", "—" for null/unknown. Always an estimate; callers add the caption. */
function formatUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v === 0) return "$0.00";
  if (v > 0 && v < 0.01) return "< $0.01";
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

/** Compact token count: 950, 12.3K, 4.5M. */
function formatTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(v / 1e6).toFixed(v < 1e7 ? 1 : 0).replace(/\.0$/, "")}M`;
}

/** Integer with thousands separators. */
function formatCount(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "0";
}

/**
 * Bar widths (percent of the largest value) for a horizontal bar list. Null/negative → 0; any
 * positive value gets at least `minPct` so a tiny day is still visible next to a big one.
 */
function barWidths(values, minPct = 2) {
  const nums = values.map((v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0));
  const max = Math.max(0, ...nums);
  if (max === 0) return nums.map(() => 0);
  return nums.map((v) => (v === 0 ? 0 : Math.max(minPct, Math.round((v / max) * 1000) / 10)));
}

/** Which measure the per-day bars use: estimated cost when anything was priced, else request counts. */
function usageBarMetric(summary) {
  const t = summary && summary.totals;
  return t && typeof t.estimatedCostUsd === "number" && t.estimatedCostUsd > 0 ? "cost" : "requests";
}

/**
 * Rows for the per-day bar list, newest first. Windows longer than 7 days hide empty days (reported
 * as `hidden`) so a phone isn't a wall of zeros.
 */
function usageDayRows(summary) {
  const days = (summary && Array.isArray(summary.byDay) ? summary.byDay : []).slice().reverse();
  const metric = usageBarMetric(summary);
  const keep = days.length > 7 ? days.filter((d) => d.requests > 0) : days;
  const widths = barWidths(keep.map((d) => (metric === "cost" ? d.estimatedCostUsd : d.requests)));
  return {
    metric,
    hidden: days.length - keep.length,
    rows: keep.map((d, i) => ({ date: d.date, label: usageDayLabel(d.date), requests: d.requests, cost: d.estimatedCostUsd, width: widths[i] })),
  };
}

/** "Mon 5 Oct" for a YYYY-MM-DD (read as a local calendar date, not UTC). */
function usageDayLabel(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  if (!m) return String(ymd || "");
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${wd} ${d.getDate()} ${mo}`;
}

/** Status chip copy for the AI connection card. */
function aiStatusCopy(view) {
  if (!view) return { tone: "muted", label: "Unknown", detail: "AI connection status is unavailable." };
  if (!view.demo) {
    return { tone: "ok", label: "Live", detail: `${view.model} · effort ${view.effort}${view.webSearch ? " · web search on" : ""}` };
  }
  if (view.fakeForced) {
    return {
      tone: "warn",
      label: "Demo mode",
      detail: "CLAUDE_FAKE=1 on the server forces demo mode. Your settings are saved and take effect once it is removed.",
    };
  }
  return { tone: "warn", label: "Demo mode", detail: "No API key yet, so answers are canned. Paste your Anthropic API key below." };
}

/** Placeholder and hint for the API key field. */
function apiKeyFieldCopy(view) {
  const src = view && view.keySource;
  if (src === "settings" && view.keyHint) return { placeholder: `Saved key ${view.keyHint}`, hint: "Saved in the app. Paste a new key to replace it." };
  if (src === "env") return { placeholder: view.keyHint ? `Server key ${view.keyHint}` : "Set on the server", hint: "Using the key from the server's .env. A key saved here overrides it." };
  if (src === "profile") return { placeholder: "Using server sign-in", hint: "Using the server's “ant auth login” profile. A key saved here overrides it." };
  return { placeholder: "sk-ant-…", hint: "Create a key in the Claude Console under API keys. It is stored on the server, never on this phone." };
}

/** Client-side check matching the server's (sk-ant-, no whitespace, 20–300 chars). Returns an error sentence or "". */
function apiKeyProblem(raw) {
  const key = String(raw || "").trim();
  if (!key) return "";
  if (!key.startsWith("sk-ant-")) return "An Anthropic API key starts with sk-ant-.";
  if (/\s/.test(key)) return "The key can't contain spaces. Paste it again.";
  if (key.length < 20) return "That key looks too short. Copy the whole key.";
  if (key.length > 300) return "That key looks too long. Copy just the key.";
  return "";
}

/** Model picker options: known models, then models the test found, with the current value always present. */
function mergeModelLists(known, available, current) {
  const out = [];
  for (const m of [...(known || []), ...(available || []), current]) {
    if (typeof m === "string" && m && !out.includes(m)) out.push(m);
  }
  return out;
}

const TEST_TITLES = {
  ok: "Connected",
  invalid_key: "Key rejected",
  permission: "Permission denied",
  model_unavailable: "Model not available",
  billing: "No credit on the account",
  rate_limited: "Rate limited",
  overloaded: "Anthropic is busy",
  network: "Can't reach Anthropic",
  server_unreachable: "Can't reach the server",
  no_key: "No API key",
  unknown: "Test failed",
};
const SERVER_UNREACHABLE_COPY = "Your phone can't reach the HVAC server. Check Wi-Fi or mobile data and try again.";

/**
 * UI copy for a POST /api/settings/ai/test result.
 * opts.typedKey: the test used a key typed into the field but not saved yet, so the assistant is not using it.
 * Code "server_unreachable" is client-side only (the phone → HVAC server request failed); "network" is the server's own
 * result (the server couldn't reach Anthropic).
 */
function testResultCopy(r, opts) {
  if (!r || typeof r !== "object") return { tone: "danger", title: TEST_TITLES.unknown, body: "No result.", suggestion: "", useModel: null, saveHint: false };
  const typed = !!(opts && opts.typedKey);
  const code = TEST_TITLES[r.code] ? r.code : "unknown";
  const ok = !!r.ok && code === "ok";
  const tone = ok ? "ok" : code === "rate_limited" || code === "overloaded" || code === "no_key" || code === "server_unreachable" ? "warn" : "danger";
  const secs = typeof r.latencyMs === "number" ? `${(r.latencyMs / 1000).toFixed(1)} s` : "";
  const body = ok
    ? `${r.model} answered in ${secs}. ${typed ? "Tap Save to use this key." : "The assistant is ready."}`
    : code === "server_unreachable"
      ? SERVER_UNREACHABLE_COPY
      : String(r.message || "The test failed.");
  const avail = Array.isArray(r.availableModels) ? r.availableModels.filter((m) => m && m !== r.model) : [];
  const useModel = code === "model_unavailable" && avail.length ? avail[0] : null;
  return { tone, title: ok && typed ? "Key works" : TEST_TITLES[code], body, suggestion: r.suggestion ? String(r.suggestion) : "", useModel, saveHint: ok && typed };
}

/**
 * Which chat demo banner to show: null (none), "demo" (no key yet → "Add API key") or "forced" (CLAUDE_FAKE=1 on the server).
 * The AI settings view wins, then /api/health. When neither is known and the server is unreachable, the page's
 * config.js may be a stale cached copy from before a key was saved, so it is not trusted.
 */
function demoBannerMode(input) {
  const i = input || {};
  if (i.ai) return i.ai.demo ? (i.ai.fakeForced ? "forced" : "demo") : null;
  if (i.health) return i.health.demo ? (i.health.fakeForced ? "forced" : "demo") : null;
  if (i.unreachable) return null;
  return i.configDemo ? "demo" : null;
}

/** Toast after a corrections export. The server marks rows exported before the file reaches the phone. */
function correctionsExportToast(outcome, name) {
  if (outcome === "cancelled") return "Export cancelled — corrections were marked exported; export again to resend";
  return `Exported ${name}`;
}

/* ------------------------------------------------------------------------------------------
 * Browser app
 * ---------------------------------------------------------------------------------------- */

/* ---------- fleet import + decode corrections (pure) ---------- */

/** Spreadsheet template the Import sheet copies to the clipboard (header row matches the server's aliases). */
const IMPORT_TEMPLATE_COLUMNS = ["Model", "Serial", "Site", "Tag"];
function importTemplateText() {
  return `${IMPORT_TEMPLATE_COLUMNS.join(",")}\n48TCDD08A2A5,1219C12345,Main St store,RTU-1\nYSC060A3RHA,130410355L,Main St store,RTU-2\n`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "12 new · 2 duplicates · 1 error" (new always shown; zero duplicates/errors omitted). */
function importSummaryText(summary) {
  const s = summary || {};
  const n = (k) => (Number.isFinite(s[k]) ? s[k] : 0);
  const parts = [`${n("new")} new`];
  if (n("duplicate")) parts.push(plural(n("duplicate"), "duplicate", "duplicates"));
  if (n("error")) parts.push(plural(n("error"), "error", "errors"));
  return parts.join(" · ");
}

/** Primary button label once a preview is in: "Import 12 units" / "Import 1 unit" / "Nothing new" (fits a phone footer half). */
function importButtonLabel(newCount) {
  const n = Number.isFinite(newCount) ? newCount : 0;
  return n > 0 ? `Import ${plural(n, "unit", "units")}` : "Nothing new";
}

/** Import report row → { title, subtitle, ident } for the preview list. */
function importRowText(row) {
  const input = (row && row.input) || {};
  const d = (row && row.decoded) || {};
  const tag = (input.unit_tag || "").trim();
  const model = (input.model || "").trim();
  const rowNo = (row && row.line) || ((row && row.index) || 0) + 1;
  const title = tag || model || (input.serial ? `S/N ${input.serial}` : `Row ${rowNo}`);
  const age = typeof d.ageYears === "number" ? `${fmtNum(d.ageYears)} yr` : d.manufactureDate || "";
  const subtitle = [d.manufacturer || input.manufacturer, typeof d.tonnage === "number" ? `${d.tonnage} ton` : "", d.refrigerant, age].filter(Boolean).join(" · ");
  const ident = [tag && model ? model : "", input.serial ? `S/N ${input.serial}` : "", input.site].filter(Boolean).join(" · ");
  return { title, subtitle, ident };
}

const CORRECTION_FIELDS = [
  ["manufacturer", "Manufacturer"],
  ["family", "Model family / series"],
  ["tonnage", "Tonnage"],
  ["voltage", "Voltage"],
  ["phase", "Phase"],
  ["refrigerant", "Refrigerant"],
  ["manufacture_date", "Manufacture date"],
  ["control_platform", "Control board / platform"],
  ["fault_code", "Fault code meaning"],
  ["other", "Something else"],
];
const CORRECTION_FIELD_LABEL = Object.fromEntries(CORRECTION_FIELDS);
/** Fields that map onto a unit column (server: APPLICABLE_CORRECTION_FIELDS). */
const APPLICABLE_CORRECTION_FIELDS = ["manufacturer", "tonnage", "voltage", "phase", "refrigerant"];
function canApplyCorrection(field) {
  return APPLICABLE_CORRECTION_FIELDS.includes(field);
}

/** What the app currently shows for `field` — prefills "App says" (mirrors the server's currentAppValue). */
function correctionPrefill(field, unit, decoded) {
  const u = unit || {};
  const s = (v) => (v === null || v === undefined ? "" : String(v));
  const bestModel = decoded && Array.isArray(decoded.model) ? decoded.model[0] : null;
  const bestSerial = decoded && Array.isArray(decoded.serial) ? decoded.serial[0] : null;
  switch (field) {
    case "manufacturer":
      return s(u.manufacturer || u.brand);
    case "tonnage":
    case "voltage":
    case "phase":
    case "refrigerant":
    case "control_platform":
      return s(u[field]);
    case "family":
      return s(bestModel && bestModel.family);
    case "manufacture_date":
      return s(bestSerial && bestSerial.manufactureDate);
    default:
      return "";
  }
}

/** Download name from Content-Disposition, else hvac-corrections-YYYY-MM-DD.json. */
function correctionsExportFilename(disposition, now = new Date()) {
  const m = /filename="?([^";]+)"?/i.exec(disposition || "");
  if (m && /^[\w.-]+$/.test(m[1])) return m[1];
  return `hvac-corrections-${now.toISOString().slice(0, 10)}.json`;
}

/* ------------------------------------------------------------------------------------------
 * Service reports, QR labels and the native shell (pure helpers; the UI parts live in boot())
 * ---------------------------------------------------------------------------------------- */

/** Whitespace-collapsed text cut at `max` characters with an ellipsis. */
function truncateText(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, Math.max(0, max - 1)).replace(/\s+\S*$/, "");
  return `${cut || s.slice(0, max - 1)}…`;
}

/** Filename from a Content-Disposition header when it is a plain safe name, else null. */
function filenameFromDisposition(disposition) {
  const m = /filename="([^"]+)"/.exec(String(disposition || ""));
  const name = m ? m[1] : "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name) && !name.includes("..") ? name : null;
}

const REPORT_EXT = { md: "md", html: "html", json: "json" };
/** `hvac-report-<label>-<date>.<ext>` (conversation) / `hvac-unit-<label>-<date>.<ext>` (unit); mirrors the server's naming. */
function reportFilename(kind, label, format, now = new Date()) {
  const stem = String(label || "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const ext = REPORT_EXT[format] || "md";
  const date = Number.isFinite(now.getTime()) ? now.toISOString().slice(0, 10) : "report";
  return `hvac-${kind === "unit" ? "unit" : "report"}-${stem || "untitled"}-${date}.${ext}`;
}

/** Unit heading for share text: tag · nickname, else model, else "Unit". */
function reportUnitHeading(u) {
  if (!u) return "";
  return [u.tag, u.nickname].filter(Boolean).join(" · ") || u.model || "Unit";
}

/** Plain-text share body built from a JSON report (conversation or unit); short enough for SMS/WhatsApp. */
function reportShareText(report) {
  if (!report || typeof report !== "object") return "";
  const u = report.unit || null;
  const lines = [];
  const unitLine = u ? [reportUnitHeading(u), [u.manufacturer, u.model].filter(Boolean).join(" "), u.site].filter(Boolean).join(" — ") : "";
  if (report.kind === "unit") {
    lines.push(`Unit report: ${unitLine || "unit"}`);
    const extras = [u && u.serial ? `S/N ${u.serial}` : "", u && u.tonnage ? `${u.tonnage} ton` : "", u && u.refrigerant, u && u.manufactureDate ? `mfd ${u.manufactureDate}` : ""].filter(Boolean);
    if (extras.length) lines.push(extras.join(" · "));
    const groups = Array.isArray(report.findingsByDate) ? report.findingsByDate : [];
    const findings = groups.flatMap((g) => (Array.isArray(g.findings) ? g.findings : []));
    if (findings.length) {
      lines.push("", `Findings (${findings.length}):`);
      for (const f of findings.slice(0, 6)) lines.push(`- ${f.date ? `${f.date} ` : ""}${[f.symptom, f.cause, f.resolution].filter(Boolean).join(" → ")}${f.status !== "resolved" ? ` [${f.status}]` : ""}`);
      if (findings.length > 6) lines.push(`…and ${findings.length - 6} more`);
    } else lines.push("", "No findings on record.");
    return lines.join("\n");
  }
  const c = report.conversation || {};
  lines.push(`Service report: ${c.title || "conversation"}${c.createdAt ? ` (${String(c.createdAt).slice(0, 10)})` : ""}`);
  if (unitLine) lines.push(`Unit: ${unitLine}`);
  if (report.complaint) lines.push("", `Complaint: ${truncateText(report.complaint, 240)}`);
  const readings = Array.isArray(report.readings) ? report.readings.filter((r) => r && r.ok && r.derived && r.derived.length) : [];
  if (readings.length) {
    const last = readings[readings.length - 1];
    const brief = last.derived.filter((d) => ["superheatF", "subcoolingF", "deltaTF", "compressionRatio"].includes(d.key)).map((d) => `${d.label.replace(/ \(.*\)$/, "")} ${d.value}`);
    if (brief.length) lines.push("", `Readings: ${brief.join(", ")}${last.validity && !last.validity.ok ? " (not valid for charge)" : ""}`);
  }
  const findings = Array.isArray(report.findings) ? report.findings : [];
  if (findings.length) {
    lines.push("", "Findings:");
    for (const f of findings.slice(0, 5)) lines.push(`- ${[f.symptom, f.cause, f.resolution].filter(Boolean).join(" → ")}${f.confirmed ? "" : " (unconfirmed)"}`);
  }
  const open = Array.isArray(report.openItems) ? report.openItems : [];
  if (open.length) {
    lines.push("", "Open items:");
    for (const o of open.slice(0, 5)) lines.push(`- ${o}`);
  }
  return lines.join("\n");
}

/** navigator.share payload for a report; `url` is added only when given (a printable link needs auth, so usually not). */
function reportSharePayload(report, url) {
  const title = report && report.kind === "unit" ? `Unit report — ${reportUnitHeading(report.unit)}` : `Service report — ${(report && report.conversation && report.conversation.title) || "conversation"}`;
  const payload = { title, text: reportShareText(report) };
  if (url) payload.url = url;
  return payload;
}

/** Base of the app URL (origin + path without index.html / trailing slash) so a scanned link lands on this install. */
function appBaseUrl(loc) {
  const origin = (loc && loc.origin) || "";
  let path = (loc && loc.pathname) || "/";
  path = path.replace(/index\.html?$/i, "").replace(/\/+$/, "");
  return origin + path;
}

/** Absolute URL that opens a unit: `<base>/#unit/<id>`. */
function unitUrl(base, id) {
  return `${String(base || "").replace(/\/+$/, "")}/#unit/${id}`;
}

/** Text printed under a unit's QR: title (tag / nickname / model) and up to three detail lines. */
function labelText(u) {
  if (!u) return { title: "Unit", lines: [] };
  const title = [u.unit_tag, u.nickname].filter(Boolean).join(" · ") || u.model || "Unit";
  const lines = [];
  if (u.site) lines.push([u.site, u.customer].filter(Boolean).join(" · "));
  const model = [u.manufacturer || u.brand, u.model].filter(Boolean).join(" ");
  if (model && model !== title) lines.push(model);
  if (u.serial) lines.push(`S/N ${u.serial}`);
  return { title, lines: lines.slice(0, 3) };
}

/**
 * QR module matrix (array of rows of booleans) for `text` at error-correction level M, smallest version that fits
 * (byte mode, UTF-8), using the vendored qrcode-generator (`lib` = window.qrcode). Returns null without the library.
 */
function qrMatrix(text, lib) {
  const make = lib || (typeof qrcode === "function" ? qrcode : null);
  if (typeof make !== "function") return null;
  const qr = make(0, "M");
  qr.addData(String(text), "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(!!qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/** SVG path (one unit square per dark module, rows merged into runs) for a matrix of booleans or "1"/"0" strings. */
function qrPathFromMatrix(matrix) {
  const parts = [];
  (matrix || []).forEach((row, y) => {
    const cells = typeof row === "string" ? row.split("") : row;
    let x = 0;
    while (x < cells.length) {
      const dark = cells[x] === true || cells[x] === 1 || cells[x] === "1";
      if (!dark) {
        x += 1;
        continue;
      }
      let w = 1;
      while (x + w < cells.length && (cells[x + w] === true || cells[x + w] === 1 || cells[x + w] === "1")) w += 1;
      parts.push(`M${x} ${y}h${w}v1h-${w}z`);
      x += w;
    }
  });
  return parts.join("");
}

/** Crisp black-on-white SVG markup for a QR matrix (quiet zone `margin` modules); `size` is the CSS size in px when given. */
function qrSvgMarkup(matrix, { margin = 4, size, title } = {}) {
  const n = (matrix && matrix.length) || 0;
  const total = n + margin * 2;
  const path = qrPathFromMatrix(matrix);
  const attrs = [`xmlns="http://www.w3.org/2000/svg"`, `viewBox="0 0 ${total} ${total}"`, `shape-rendering="crispEdges"`, `role="img"`, `aria-label="${escapeHtml(title || "QR code")}"`];
  if (size) attrs.push(`width="${size}"`, `height="${size}"`);
  return `<svg ${attrs.join(" ")}><rect width="${total}" height="${total}" fill="#fff"/><path transform="translate(${margin} ${margin})" d="${path}" fill="#000"/></svg>`;
}

/**
 * A self-contained printable page of QR labels (two columns on paper, one label per unit). Every string is escaped;
 * `labels` = [{ title, lines, url, matrix }].
 */
function labelsDocumentHtml(labels, { heading = "Unit QR labels", generatedAt = new Date() } = {}) {
  const items = (labels || []).map((l) => {
    const lines = (l.lines || []).map((x) => `<div class="line">${escapeHtml(x)}</div>`).join("");
    return `<div class="label">${qrSvgMarkup(l.matrix, { margin: 2, title: `QR code for ${l.title}` })}<div class="text"><div class="title">${escapeHtml(l.title)}</div>${lines}<div class="url">${escapeHtml(l.url)}</div></div></div>`;
  });
  const stamp = Number.isFinite(generatedAt.getTime()) ? generatedAt.toISOString().slice(0, 10) : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(heading)}</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.35 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; color: #111; background: #fff; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #d5dae0; }
.bar h1 { font-size: 17px; margin: 0; } .bar .meta { color: #5a6470; font-size: 12px; }
.btn { font: inherit; font-weight: 600; padding: 10px 14px; border-radius: 10px; border: 1px solid #b86200; background: #b86200; color: #fff; cursor: pointer; }
.labels { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 16px; }
.label { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: center; border: 1px solid #111; border-radius: 8px; padding: 10px; break-inside: avoid; page-break-inside: avoid; min-height: 118px; }
.label svg { width: 96px; height: 96px; flex: none; }
.text { min-width: 0; }
.title { font-size: 18px; font-weight: 800; letter-spacing: 0.02em; overflow-wrap: anywhere; }
.line { font-size: 12px; color: #333; overflow-wrap: anywhere; }
.url { font: 9.5px/1.3 ui-monospace, Menlo, Consolas, monospace; color: #5a6470; margin-top: 4px; overflow-wrap: anywhere; }
@media (max-width: 480px) { .labels { grid-template-columns: 1fr; } }
@media print { .bar { display: none; } .labels { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 0; gap: 8mm 6mm; } .label { border-color: #000; } }
@page { margin: 12mm; }
</style></head><body>
<div class="bar"><div><h1>${escapeHtml(heading)}</h1><div class="meta">${items.length} label${items.length === 1 ? "" : "s"}${stamp ? ` · ${stamp}` : ""} · scan with the phone camera to open the unit</div></div><button class="btn" type="button" id="print">Print</button></div>
<div class="labels">${items.join("")}</div>
<script>document.getElementById("print").addEventListener("click", function () { window.print(); });</script>
</body></html>`;
}

/**
 * Whether the client has no API to talk to yet: a bundled (Capacitor) build or a non-http origin with no server URL
 * saved in Settings. Same-origin web installs never need one.
 */
function serverUrlPrompt({ configBase, savedBase, bundled, protocol } = {}) {
  const base = String(configBase || "").trim() || String(savedBase || "").trim();
  const nativeOrigin = ["capacitor:", "ionic:", "file:"].includes(String(protocol || "").toLowerCase());
  const needed = !base && (bundled === true || nativeOrigin);
  return {
    needed,
    message: needed ? "Set your server URL: enter the address of your HVAC server (for example https://shop-pc.tail1234.ts.net) and the access password, then tap Save connection." : "",
  };
}

/* ------------------------------------------------------------------------------------------
 * Readings history + follow-ups: pure helpers (tested in web/app.test.ts)
 * ---------------------------------------------------------------------------------------- */
const MODE_SHORT = { ac_cooling: "AC cooling", heat_pump_cooling: "HP cooling", heat_pump_heating: "HP heating", refrigeration: "Refrigeration" };
/** [key, label, unit] for the expanded reading view: measurements as entered, then derived metrics. */
const READING_MEASUREMENT_FIELDS = [
  ["circuit", "Circuit", ""], ["outdoorDbF", "Outdoor DB", "°F"], ["indoorDbF", "Entering DB", "°F"], ["indoorWbF", "Entering WB", "°F"], ["supplyDbF", "Supply DB", "°F"],
  ["suctionPsig", "Suction", "psig"], ["suctionLineTempF", "Suction line", "°F"], ["liquidPsig", "Liquid", "psig"], ["liquidLineTempF", "Liquid line", "°F"],
  ["dischargePsig", "Discharge", "psig"], ["dischargeLineTempF", "Discharge line", "°F"], ["compressorAmps", "Amps L1", "A"], ["compressorAmpsL2", "Amps L2", "A"], ["compressorAmpsL3", "Amps L3", "A"],
  ["compressorRla", "RLA", "A"], ["externalStaticInWc", "External static", "in. wc"], ["capacityPercent", "Capacity", "%"], ["economizerPosition", "Economizer", ""], ["elevationFt", "Elevation", "ft"],
];
const READING_DERIVED_FIELDS = [
  ["superheatF", "Superheat", "°F"], ["targetSuperheatF", "Target SH", "°F"], ["subcoolingF", "Subcooling", "°F"], ["targetSubcoolingF", "Target SC", "°F"],
  ["evapSatF", "Evap sat", "°F"], ["condSatF", "Cond sat", "°F"], ["deltaTF", "Delta-T", "°F"], ["targetDeltaTF", "Target ΔT", "°F"], ["condenserSplitF", "Cond split", "°F"],
  ["evapTdF", "Evap TD", "°F"], ["indoorCoilTdF", "Indoor coil TD", "°F"], ["compressionRatio", "Comp. ratio", ""], ["dischargeSuperheatF", "Discharge SH", "°F"],
  ["ampsPercentRla", "Amps % RLA", "%"], ["currentImbalancePercent", "Amp imbalance", "%"], ["drierTempDropF", "Drier drop", "°F"], ["standingExcessPsi", "Standing excess", "psi"],
];
const TREND_METRIC_SHORT = { superheatF: "SH", subcoolingF: "SC", condSatF: "Cond sat", evapSatF: "Evap sat", deltaTF: "ΔT", ampsPercentRla: "Amps", suctionPsig: "Suction", liquidPsig: "Liquid" };

/** Local calendar date as YYYY-MM-DD (follow-up due dates are calendar dates, compared as strings). */
function localYmd(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** "Sep 1" for a YYYY-MM-DD (year appended when it differs from `today`'s). Not timezone-shifted. */
function ymdLabel(ymd, today = localYmd()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  if (!m) return String(ymd || "");
  const opts = { month: "short", day: "numeric", timeZone: "UTC" };
  if (m[1] !== today.slice(0, 4)) opts.year = "numeric";
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(undefined, opts);
}
function addDaysYmd(ymd, days) {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + days * 86400000).toISOString().slice(0, 10) : ymd;
}
/** Date part of a reading's timestamp, like relTime's long form ("Oct 5", "Oct 5, 2025"). */
function readingDateLabel(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const dt = new Date(t);
  const opts = { month: "short", day: "numeric" };
  if (dt.getFullYear() !== new Date(now).getFullYear()) opts.year = "numeric";
  return dt.toLocaleDateString(undefined, opts);
}

/** Compact row text for a saved reading: "Oct 5 · AC cooling" + "SH 12 · SC 4 · ΔT 18 · 20 A (80%)". */
function readingSummary(r, now = Date.now()) {
  const d = (r && r.derived) || {};
  const m = (r && r.measurements) || {};
  const n = (v, digits = 0) => (typeof v === "number" && Number.isFinite(v) ? fmtNum(v, digits) : null);
  const sh = n(d.superheatF);
  const sc = n(d.subcoolingF);
  const dt = n(d.deltaTF);
  const amps = n(m.compressorAmps, 1);
  const pct = n(d.ampsPercentRla);
  const parts = [`SH ${sh === null ? "—" : sh}`, `SC ${sc === null ? "—" : sc}`, `ΔT ${dt === null ? "—" : dt}`];
  if (amps !== null) parts.push(`${amps} A${pct !== null ? ` (${pct}%)` : ""}`);
  else if (pct !== null) parts.push(`${pct}% RLA`);
  else parts.push("amps —");
  const mode = MODE_SHORT[r && r.mode] || (r && r.mode) || "";
  return {
    title: [readingDateLabel(r && r.created_at, now), mode].filter(Boolean).join(" · "),
    values: parts.join(" · "),
    source: (r && r.source) || "sheet",
    note: (r && r.note) || "",
    valid: !(r && r.validity && r.validity.ok === false),
  };
}

/** Every entered measurement and derived metric of a reading as {label, value} rows (for the expanded view). */
function readingDetailRows(r) {
  const out = [];
  const m = (r && r.measurements) || {};
  const d = (r && r.derived) || {};
  const push = (label, v, unit) => {
    if (v === null || v === undefined || v === "") return;
    if (typeof v === "object") {
      if (typeof v.min === "number" && typeof v.max === "number") out.push({ label, value: `${fmtNum(v.min)}–${fmtNum(v.max)}${unit ? ` ${unit}` : ""}` });
      return;
    }
    const text = typeof v === "number" ? fmtNum(v, label === "Comp. ratio" ? 2 : 1) : String(v);
    out.push({ label, value: unit ? `${text} ${unit}` : text });
  };
  push("Refrigerant", r && r.refrigerant, "");
  push("Metering", r && r.metering_device ? (METERING_LABEL[r.metering_device] || r.metering_device) : null, "");
  for (const [k, label, unit] of READING_MEASUREMENT_FIELDS) push(label, m[k], unit);
  for (const [k, label, unit] of READING_DERIVED_FIELDS) push(label, d[k], unit);
  return out;
}

/** "↓ SC 12 → 4 °F" for a trend delta from compareReadings. */
function formatDelta(d) {
  if (!d) return "";
  const arrow = d.direction === "up" ? "↑" : "↓";
  const label = TREND_METRIC_SHORT[d.metric] || d.label || d.metric || "";
  const unit = d.unit ? ` ${d.unit}` : "";
  return `${arrow} ${label} ${fmtNum(d.prev)} → ${fmtNum(d.cur)}${unit}`;
}

/** Due chip for a follow-up: overdue (red) / soon (amber, within 7 days) / later / none / done. */
function dueChip(due, done, today = localYmd()) {
  if (Number(done) === 1 || done === true) return { kind: "done", label: "Done" };
  if (!due) return { kind: "none", label: "No date" };
  if (due < today) return { kind: "overdue", label: `Overdue · ${ymdLabel(due, today)}` };
  if (due === today) return { kind: "soon", label: "Due today" };
  if (due <= addDaysYmd(today, 7)) return { kind: "soon", label: `Due ${ymdLabel(due, today)}` };
  return { kind: "later", label: `Due ${ymdLabel(due, today)}` };
}

function boot() {
  const doc = document;
  const $ = (id) => doc.getElementById(id);
  const html = doc.documentElement;
  const CALC = globalThis.HVAC_CALC || null;

  /* ---------- storage ---------- */
  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        if (v === null || v === undefined || v === "") localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {
        /* private mode / blocked */
      }
    },
  };

  /* ---------- DOM helpers ---------- */
  function h(tag, attrs, ...children) {
    const el = doc.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "html") el.innerHTML = v; // only ever passed sanitized markup
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "dataset") Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : doc.createTextNode(String(c)));
    }
    return el;
  }
  const SVG_NS = "http://www.w3.org/2000/svg";
  /** Inline icon referencing a <symbol> in index.html. */
  function icon(name, cls = "icon") {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", cls);
    svg.setAttribute("aria-hidden", "true");
    const use = doc.createElementNS(SVG_NS, "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  /* ---------- API ---------- */
  class ApiFailure extends Error {
    constructor(code, message, status) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  function apiBase() {
    const cfg = typeof window.APP_CONFIG === "object" && window.APP_CONFIG ? window.APP_CONFIG.apiBase : undefined;
    if (typeof cfg === "string" && cfg) return cfg.replace(/\/$/, "");
    const saved = store.get("hvac.apiBase");
    if (saved) return saved.replace(/\/$/, "");
    return "";
  }

  async function api(path, opts = {}) {
    const headers = new Headers(opts.headers || {});
    let body = opts.body;
    if (opts.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(opts.json);
    }
    const token = store.get("hvac.token");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (noServerConfigured()) throw new ApiFailure("no_server", "No server URL set — enter it in Settings.", 0);
    const init = { method: opts.method || "GET", headers, body, signal: opts.signal, cache: "no-store" };
    let res;
    try {
      res = await fetch(apiBase() + path, init);
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new ApiFailure("network", `Network error: ${e && e.message ? e.message : "request failed"}`, 0);
    }
    if (state.serverDown && serverReachable(res)) updateOnline(false);
    if (res.status === 401) {
      authRequired();
      throw new ApiFailure("auth", "Sign-in required — enter the access password in Settings.", 401);
    }
    return res;
  }

  async function readError(res) {
    let code = "http_" + res.status;
    let message = `${res.status} ${res.statusText || ""}`.trim();
    try {
      const j = await res.json();
      if (j && j.error && typeof j.error === "object") {
        code = j.error.code || code;
        message = j.error.message || message;
      }
    } catch {
      /* not JSON */
    }
    return new ApiFailure(code, message, res.status);
  }

  async function apiJson(path, opts) {
    const res = await api(path, opts);
    if (!res.ok) throw await readError(res);
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    const json = JSON.parse(text);
    if (res.headers.get("x-hvac-cache") === "hit" && json && typeof json === "object" && !Array.isArray(json)) {
      json.source = "cache";
      const at = res.headers.get("x-hvac-cached-at");
      json.notes = [...(Array.isArray(json.notes) ? json.notes : []), `Served from the offline cache${at ? ` (fetched ${new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})` : ""} — reconnect to refresh.`];
    }
    return json;
  }

  const isNetworkError = (e) => !!e && (e.code === "network" || e.code === "offline" || e.status === 0 || e.status === 503);

  /* ---------- state ---------- */
  const state = {
    route: parseHash(""),
    conversationId: null,
    conversation: null,
    unit: null, // unit attached to the current conversation
    messages: [],
    busy: false, // server-side turn in progress (409 / GET busy)
    streaming: false, // we own an SSE stream
    abort: null,
    pollTimer: null,
    units: [],
    unitsById: new Map(),
    me: null, // /api/me: {role: "owner"|"tester", name?, budget?, authRequired}
    testers: [],
    testersDefaultCap: undefined,
    unitsQuery: "",
    conversations: [],
    convFilterUnitId: null,
    panelUnit: null, // unit shown in the unit detail {unit, decoded, findings, conversations}
    decoded: null, // last decode result shown in the decode sheet
    editingUnitId: null, // decode sheet in edit mode for this unit
    pendingImages: [], // {media_type, data, url}
    stickToBottom: true,
    refrigerants: FALLBACK_REFRIGERANTS,
    lastDx: null,
    wakeLock: null,
    wantWake: false,
    health: null,
    authNeeded: false,
    serverDown: false,
    healthFailed: false,
    installPrompt: null,
    swWaiting: null,
    lastAppliedHash: null,
    ctx: null, // desktop context panel: {unit, decoded, findings} for the attached unit
    ctxLoading: null,
  };

  const els = {
    app: $("app"),
    screenUnits: $("screen-units"), screenReadings: $("screen-readings"),
    messages: $("messages"), emptyState: $("empty-state"), quickChips: $("quick-chips"), banners: $("banners"),
    composerInput: $("composer-input"), btnSend: $("btn-send"), btnStop: $("btn-stop"), btnAttach: $("btn-attach"), btnCamera: $("btn-camera"),
    fileInput: $("file-input"), fileCamera: $("file-camera"), fileCameraSend: $("file-camera-send"), previews: $("image-previews"),
    chatTitle: $("chat-title"), chatSub: $("chat-sub"), btnChatUnit: $("btn-chat-unit"), btnConvDelete: $("btn-conv-delete"),
    convList: $("conv-list"), convListSide: $("conv-list-side"), convFilter: $("conv-filter"), convFilterSide: $("conv-filter-side"),
    search: $("search"), searchResults: $("search-results"), historyBrowse: $("history-browse"), btnSearchClear: $("btn-search-clear"),
    unitsList: $("units-list"), unitsSearch: $("units-search"), unitTitle: $("unit-title"), unitSub: $("unit-sub"),
    unitDetail: $("unit-detail"), unitEmpty: $("unit-empty"), unitContent: $("unit-content"), btnUnitMore: $("btn-unit-more"),
    sheetDecode: $("sheet-decode"), unitForm: $("unit-form"), unitFormError: $("unit-form-error"), decodeCard: $("decode-card"), decodeTitle: $("decode-title"),
    btnSaveUnit: $("btn-save-unit"), btnDecode: $("btn-decode"), btnDecodePhoto: $("btn-decode-photo"),
    sheetUnitActions: $("sheet-unit-actions"), unitActionsList: $("unit-actions-list"), unitActionsTitle: $("unit-actions-title"),
    sheetImport: $("sheet-import"), importForm: $("import-form"), importText: $("import-text"), importFile: $("import-file"), importFileName: $("import-file-name"),
    importError: $("import-error"), importPreview: $("import-preview"), btnImportPreview: $("btn-import-preview"), btnImportRun: $("btn-import-run"),
    sheetPick: $("sheet-pick"), sheetFinding: $("sheet-finding"), // readings history + follow-ups sheets
    sheetCorrect: $("sheet-correct"), correctForm: $("correct-form"), correctError: $("correct-error"), correctSub: $("correct-sub"), cField: $("c-field"), cApp: $("c-app"),
    sheetShare: $("sheet-share"), shareTitle: $("share-title"), shareSub: $("share-sub"), shareList: $("share-list"), shareFallback: $("share-fallback"), btnChatShare: $("btn-chat-share"),
    sheetQr: $("sheet-qr"), qrTitle: $("qr-title"), qrLabel: $("qr-label"), qrFallback: $("qr-fallback"), btnQrPrint: $("btn-qr-print"), btnQrCopy: $("btn-qr-copy"), btnQrShare: $("btn-qr-share"),
    sheetLabels: $("sheet-labels"), labelsBody: $("labels-body"), labelsFallback: $("labels-fallback"), btnLabelsPrint: $("btn-labels-print"),
    sheetUnitsActions: $("sheet-units-actions"), unitsActionsList: $("units-actions-list"), btnUnitsMore: $("btn-units-more"),
    cActual: $("c-actual"), cNote: $("c-note"), cApply: $("c-apply"), cApplyHint: $("c-apply-hint"), btnCorrectSave: $("btn-correct-save"),
    correctionsCount: $("corrections-count"), btnCorrectionsExport: $("btn-corrections-export"),
    readingsForm: $("readings-form"), readingsResult: $("readings-result"), readingsError: $("readings-error"), readingsUnitChip: $("readings-unit-chip"), readingsSub: $("readings-sub"),
    btnReadingsSend: $("btn-readings-send"), btnReadingsClear: $("btn-readings-clear"),
    settingsForm: $("settings-form"), settingsError: $("settings-error"), settingsNotice: $("settings-notice"), healthInfo: $("health-info"),
    settingsStatusText: $("settings-status-text"), settingsStatus: $("settings-status"),
    demoBadge: $("demo-badge"), demoBadgeSettings: $("demo-badge-settings"), toast: $("toast"), offline: $("offline-banner"), backdrop: $("backdrop"),
    btnExport: $("btn-export"), btnInstall: $("btn-install"), btnUpdate: $("btn-update"), installHint: $("install-hint"), offlineInfo: $("offline-info"), appVersion: $("app-version"),
    liveRegion: $("live-region"), searchSide: $("search-side"), searchResultsSide: $("search-results-side"), convBrowseSide: $("conv-browse-side"), btnSearchSideClear: $("btn-search-side-clear"),
    ctxCol: $("ctx-col"), ctxBody: $("ctx-body"), ctxSub: $("ctx-sub"), btnCtxOpen: $("btn-ctx-open"), btnChatList: $("btn-chat-list"), uTag: $("u-tag"),
  };

  const isTouch = (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) || "ontouchstart" in window;
  const mq = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
  const isTwoColDx = () => mq("(min-width: 720px)");
  const hasCtxPanel = () => mq("(min-width: 1200px)");
  /** "smooth" unless the OS asks for reduced motion (CSS scroll-behavior does not affect explicit JS options). */
  const scrollBehavior = () => (mq("(prefers-reduced-motion: reduce)") ? "instant" : "smooth");
  const isStandalone = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;

  /* ---------- theme ---------- */
  const THEME_COLORS = { dark: "#0b0d10", light: "#ffffff" };
  function effectiveTheme() {
    const t = html.getAttribute("data-theme");
    if (t === "light" || t === "dark") return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function applyTheme(pref) {
    if (pref === "light" || pref === "dark") html.setAttribute("data-theme", pref);
    else html.removeAttribute("data-theme");
    const eff = effectiveTheme();
    for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) {
      const media = meta.getAttribute("media") || "";
      const own = media.includes("light") ? "light" : "dark";
      meta.setAttribute("content", pref === "light" || pref === "dark" ? THEME_COLORS[eff] : THEME_COLORS[own]);
    }
    const radio = doc.querySelector(`#theme-seg input[value="${pref === "light" || pref === "dark" ? pref : "auto"}"]`);
    if (radio) radio.checked = true;
  }
  function toggleTheme() {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    store.set("hvac.theme", next);
    applyTheme(next);
  }
  applyTheme(store.get("hvac.theme"));
  if (window.matchMedia) {
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(store.get("hvac.theme")));
    } catch {
      /* older Safari */
    }
  }
  for (const b of doc.querySelectorAll(".btn-theme")) b.addEventListener("click", toggleTheme);
  $("theme-seg").addEventListener("change", (e) => {
    const v = e.target && e.target.value;
    store.set("hvac.theme", v === "auto" ? null : v);
    applyTheme(v);
  });

  /* ---------- toast ---------- */
  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 2600);
  }

  /* ---------- router ---------- */
  function currentHash() {
    return location.hash || "#chat";
  }
  function navigate(hash, { replace = false } = {}) {
    if (!hash.startsWith("#")) hash = `#${hash}`;
    if (hash === currentHash()) {
      applyRoute();
      return;
    }
    const depth = (history.state && typeof history.state.depth === "number" ? history.state.depth : 0) + (replace ? 0 : 1);
    try {
      if (replace) history.replaceState({ depth }, "", hash);
      else history.pushState({ depth }, "", hash);
    } catch {
      location.hash = hash;
      return;
    }
    applyRoute();
  }
  /** Rewrite the URL without re-rendering (e.g. after a new conversation gets its id). */
  function setHashSilently(hash) {
    if (!hash.startsWith("#")) hash = `#${hash}`;
    if (hash === currentHash()) return;
    try {
      history.replaceState(history.state, "", hash);
    } catch {
      /* ignore */
    }
    state.lastAppliedHash = hash;
    state.route = parseHash(hash);
  }
  function parentHash(r) {
    if (r.screen === "units") return r.unit ? `#unit/${r.unit}` : "#units";
    if (r.screen === "chat") return r.conv ? `#chat/${r.conv}` : "#chat";
    if (r.screen === "readings") return r.pane === "calcs" ? "#readings/calcs" : "#readings";
    return `#${r.screen}`;
  }
  function goBack(fallback) {
    if (history.state && history.state.depth > 0) history.back();
    else navigate(fallback, { replace: true });
  }
  function closeSheets() {
    if (state.route.sheet) goBack(parentHash(state.route));
  }
  window.addEventListener("popstate", applyRoute);
  window.addEventListener("hashchange", applyRoute);

  function setTabs(screen) {
    for (const t of doc.querySelectorAll(".tab[data-tab]")) {
      if (t.dataset.tab === screen) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    }
  }

  function applyRoute() {
    const hash = currentHash();
    const r = parseHash(hash);
    const prev = state.route;
    state.route = r;
    state.lastAppliedHash = hash;
    els.app.dataset.screen = r.screen;
    setTabs(r.screen);

    // sheets
    for (const sh of allSheets()) hideSheet(sh);
    els.backdrop.hidden = true;
    if (r.sheet === "decode") showDecodeSheet(r.unit);
    else if (r.sheet === "actions" && r.unit) showUnitActions(r.unit);
    else if (r.sheet === "import") showImportSheet(prev.sheet === "import");
    else if (r.sheet === "correct" && r.unit) showCorrectSheet(r.unit);
    else if (r.sheet === "pick") showPickSheet(r);
    else if (r.sheet === "finding" && r.unit) showFindingSheet(r.unit, r.finding);
    else if (r.sheet === "share" && r.conv) showShareSheet("conversation", r.conv);
    else if (r.sheet === "report" && r.unit) showShareSheet("unit", r.unit);
    else if (r.sheet === "qr" && r.unit) showQrSheet(r.unit);
    else if (r.sheet === "labels") showLabelsSheet();
    else if (r.sheet === "unitsActions") showUnitsActions();

    // screens
    if (r.screen === "chat") {
      if (r.isNew) {
        if (state.streaming) toast("Wait for the current response first.");
        else resetConversation();
        setHashSilently("#chat");
      } else if (r.conv && r.conv !== state.conversationId) {
        openConversation(r.conv);
      } else if (!r.conv && state.conversationId) {
        setHashSilently(`#chat/${state.conversationId}`);
      }
      if (prev.screen !== "chat" && !isTouch) els.composerInput.focus({ preventScroll: true });
    } else if (r.screen === "units") {
      els.screenUnits.dataset.view = r.unit ? "detail" : "list";
      if (r.unit && (!state.panelUnit || state.panelUnit.unit.id !== r.unit)) loadUnitPanel(r.unit);
      markActiveRows();
    } else if (r.screen === "readings") {
      els.screenReadings.dataset.pane = r.pane;
      const radio = doc.querySelector(`input[name="readings-pane"][value="${r.pane}"]`);
      if (radio) radio.checked = true;
      if (readingsTargetUnit()) prefillReadingsFromUnit(readingsTargetUnit());
      renderReadingsUnitChip();
      requestWake();
    } else if (r.screen === "history") {
      loadFollowUps({ quiet: true });
    } else if (r.screen === "settings") {
      fillSettings();
    }
    if (r.screen !== "readings" && !state.streaming) releaseWake();
    if (r.screen !== "chat") stopPollingIfHidden();
  }
  function stopPollingIfHidden() {
    /* polling keeps running in the background so the chat is fresh when the tech comes back */
  }

  /* ---------- sheets ---------- */
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]):not(.sr-only), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  let sheetOpener = null;
  const allSheets = () => [els.sheetDecode, els.sheetUnitActions, els.sheetImport, els.sheetCorrect, els.sheetShare, els.sheetQr, els.sheetLabels, els.sheetUnitsActions, els.sheetPick, els.sheetFinding];
  const noSheetOpen = () => allSheets().every((sh) => sh.hidden);
  function setInert(on) {
    // The page behind a sheet is inert for keyboard and AT; aria-hidden is the fallback for browsers without `inert`.
    if ("inert" in els.app) els.app.inert = on;
    if (on) els.app.setAttribute("aria-hidden", "true");
    else els.app.removeAttribute("aria-hidden");
  }
  function showSheet(sheet) {
    const noneOpen = noSheetOpen();
    const active = doc.activeElement;
    if (noneOpen && active && active !== doc.body && !active.closest(".sheet")) sheetOpener = active;
    sheet.hidden = false;
    els.backdrop.hidden = false;
    setInert(true);
    const first = sheet.querySelector("input:not([type=hidden]):not(.sr-only), select, textarea, button.row");
    const title = sheet.querySelector("h2[tabindex]");
    if (first && !isTouch) first.focus({ preventScroll: true });
    else if (title) title.focus({ preventScroll: true });
  }
  function hideSheet(sheet) {
    const wasOpen = !sheet.hidden;
    sheet.hidden = true;
    if (wasOpen && noSheetOpen()) {
      setInert(false);
      const opener = sheetOpener;
      sheetOpener = null;
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
    }
  }
  function trapTab(e) {
    const sheet = e.currentTarget;
    if (e.key !== "Tab") return;
    const nodes = [...sheet.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden && el.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && (doc.activeElement === first || !sheet.contains(doc.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && doc.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
  for (const sheet of allSheets()) sheet.addEventListener("keydown", trapTab);
  els.backdrop.addEventListener("click", closeSheets);
  for (const b of doc.querySelectorAll(".btn-sheet-close")) b.addEventListener("click", closeSheets);
  doc.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.route.sheet) closeSheets();
  });
  els.btnChatList.addEventListener("click", () => navigate("#history"));
  for (const b of doc.querySelectorAll("[data-back]")) b.addEventListener("click", () => goBack(b.dataset.back));
  doc.querySelectorAll("a.tab").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = a.getAttribute("href");
      const screen = a.dataset.tab;
      // Re-tapping the active tab returns to that section's root (list / current chat).
      if (screen === "chat" && state.conversationId) navigate(`#chat/${state.conversationId}`);
      else navigate(target);
    });
  });

  /* keyboard inset (composer above the on-screen keyboard) */
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onVv = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const open = inset > 40;
      html.style.setProperty("--kb-inset", open ? `${inset}px` : "0px");
      html.classList.toggle("kb-open", open);
    };
    vv.addEventListener("resize", onVv);
    vv.addEventListener("scroll", onVv);
  }

  /* ---------- online / offline ---------- */
  let healthRetryTimer = null;
  let healthRetryAttempt = 0;
  function scheduleHealthRetry() {
    if (healthRetryTimer) return;
    healthRetryTimer = setTimeout(() => {
      healthRetryTimer = null;
      if (!state.serverDown) return;
      healthRetryAttempt += 1;
      loadHealth();
    }, healthRetryDelay(healthRetryAttempt));
  }
  function updateOnline(serverDown = state.serverDown) {
    const off = navigator.onLine === false;
    state.serverDown = !!serverDown;
    els.offline.hidden = !(off || serverDown);
    const text = els.offline.querySelector("span");
    if (text) text.textContent = off ? "Offline — chat needs a connection. Calculators and cached data still work." : "Server unreachable — chat is paused. Calculators and cached data still work.";
    // The banner must not outlive the outage: keep probing /api/health with backoff until it answers.
    if (state.serverDown && !off) scheduleHealthRetry();
    else {
      healthRetryAttempt = 0;
      if (healthRetryTimer) clearTimeout(healthRetryTimer);
      healthRetryTimer = null;
    }
  }
  window.addEventListener("online", () => {
    updateOnline();
    reconcile();
    loadHealth();
  });
  window.addEventListener("offline", updateOnline);
  updateOnline();

  /* ---------- wake lock (best effort) ---------- */
  async function requestWake() {
    state.wantWake = true;
    if (!("wakeLock" in navigator) || state.wakeLock) return;
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
      });
    } catch {
      state.wakeLock = null;
    }
  }
  function releaseWake() {
    state.wantWake = false;
    if (state.wakeLock) {
      state.wakeLock.release().catch(() => {});
      state.wakeLock = null;
    }
  }

  /* ---------- auth ---------- */
  function authRequired() {
    state.authNeeded = true;
    for (const d of doc.querySelectorAll(".settings-dot")) d.hidden = false;
    showSettingsNotice("This server needs the access password. Enter it below and save.");
    if (state.route.screen !== "settings") navigate("#settings");
  }
  function showSettingsNotice(text) {
    els.settingsNotice.hidden = !text;
    els.settingsNotice.querySelector(".banner-body").textContent = text || "";
  }

  /* ---------- banners ---------- */
  function clearBanner(kind) {
    for (const b of els.banners.querySelectorAll(`[data-kind="${kind}"]`)) b.remove();
  }
  function showBanner(kind, cls, content, opts = {}) {
    clearBanner(kind);
    const body = h("div", { class: "banner-body" }, ...content);
    const banner = h("div", { class: `banner ${cls}`, role: cls === "banner-error" ? "alert" : "status", dataset: { kind } }, body);
    if (opts.dismiss !== false) {
      banner.append(h("button", { class: "icon-btn", type: "button", "aria-label": "Dismiss", onclick: () => { banner.remove(); if (opts.onDismiss) opts.onDismiss(); } }, icon("close", "icon icon-sm")));
    }
    els.banners.append(banner);
    return banner;
  }
  function showError(code, message) {
    showBanner("error", "banner-error", [h("code", { text: code || "error" }), h("span", { text: message || "Something went wrong." })]);
  }
  function showBusyBanner() {
    showBanner("busy", "banner-info", [h("span", { class: "spinner", style: "vertical-align:-3px;margin-right:8px" }), h("span", { text: "Response in progress on the server — reconnecting…" })], { dismiss: false });
  }

  /* ---------- markdown ---------- */
  if (typeof DOMPurify !== "undefined") {
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
  }
  function renderMarkdown(text) {
    let htmlOut;
    try {
      htmlOut = typeof marked !== "undefined" ? marked.parse(text || "", { gfm: true, breaks: true, async: false }) : escapeHtml(text || "");
    } catch {
      htmlOut = escapeHtml(text || "");
    }
    const clean = typeof DOMPurify !== "undefined"
      ? DOMPurify.sanitize(htmlOut, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "button"] })
      : escapeHtml(text || "");
    const box = h("div", { class: "md", html: clean });
    for (const t of box.querySelectorAll("table")) {
      const wrap = h("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "Table, scrolls sideways" });
      t.replaceWith(wrap);
      wrap.append(t);
      watchTableScroll(wrap);
    }
    // "what we know so far" recaps → highlighted card
    for (const head of box.querySelectorAll("h1, h2, h3, h4")) {
      if (!/what we know/i.test(head.textContent || "")) continue;
      const card = h("div", { class: "recap-card" });
      head.replaceWith(card);
      card.append(head);
      let sib = card.nextSibling;
      while (sib && !(sib.nodeType === 1 && /^H[1-4]$/.test(sib.tagName))) {
        const next = sib.nextSibling;
        card.append(sib);
        sib = next;
      }
    }
    return box;
  }

  /** Fade the right edge of a table while there is more to pan to. */
  const tableObserver = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => { for (const en of entries) updateTableHint(en.target); }) : null;
  function updateTableHint(wrap) {
    wrap.classList.toggle("can-scroll", wrap.scrollWidth - wrap.clientWidth - wrap.scrollLeft > 4);
  }
  function watchTableScroll(wrap) {
    wrap.addEventListener("scroll", () => updateTableHint(wrap), { passive: true });
    if (tableObserver) tableObserver.observe(wrap);
    requestAnimationFrame(() => updateTableHint(wrap));
  }

  /* ---------- messages ---------- */
  function imageSrc(img) {
    if (!img || !img.data) return "";
    if (String(img.data).startsWith("data:")) return img.data;
    return `data:${img.media_type || "image/jpeg"};base64,${img.data}`;
  }

  function toolIconFor(name) {
    if (/decode|find_unit|update_unit|get_unit/.test(name || "")) return "units";
    if (/refrigerant|superheat|diagnose/.test(name || "")) return "gauge";
    if (/electrical|calc/.test(name || "")) return "bolt";
    if (/fault/.test(name || "")) return "alert";
    if (/search|history/.test(name || "")) return "history";
    if (/finding|conversation/.test(name || "")) return "finding";
    return "tool";
  }
  const TOOL_LABEL = {
    decode_unit: "Decode unit", find_unit: "Find unit", refrigerant_pt: "PT lookup", calc_superheat_subcooling: "Superheat / subcooling",
    diagnose_refrigeration: "Diagnose cycle", electrical_reference: "Electrical reference", calc_electrical: "Electrical calc", lookup_fault_code: "Fault code lookup",
    search_history: "Search history", get_unit_history: "Unit history", save_finding: "Save finding", update_unit: "Update unit", set_conversation: "Update conversation",
    web_search: "Web search",
  };
  const TOOL_STATE_TEXT = { running: "running", ok: "done", err: "failed" };
  const RESULT_CAP = 700;
  function toolState(t) {
    return t.ok === true ? "ok" : t.ok === false ? "err" : "running";
  }
  function toolChip(t) {
    const st = toolState(t);
    const chip = h("details", { class: `tool-chip ${st}`, dataset: { toolId: t.id } });
    const iconBox = h("span", { class: "tool-icon" }, st === "running" ? h("span", { class: "spinner" }) : icon(st === "ok" ? "check" : "close", "icon"));
    const summary = h("summary", null,
      iconBox,
      h("span", { class: "tool-label", text: TOOL_LABEL[t.name] || t.label || t.name || "Tool" }),
      h("span", { class: "tool-state", text: st === "running" ? "running…" : st === "err" ? "failed" : "" }),
      h("span", { class: "sr-only tool-sr", text: `, ${TOOL_STATE_TEXT[st]}` }),
      h("span", { class: "tool-summary", text: st === "running" ? "" : t.summary || "" }),
    );
    let inputText = "";
    try {
      inputText = typeof t.input === "string" ? t.input : JSON.stringify(t.input ?? {}, null, 2);
    } catch {
      inputText = String(t.input);
    }
    const resultText = t.summary || (st === "running" ? "…" : "");
    const pre = h("pre", { class: `tool-result${resultText.length > RESULT_CAP ? " capped" : ""}`, text: resultText });
    const more = h("button", { class: "text-btn", type: "button", text: "Show full result", hidden: resultText.length <= RESULT_CAP, onclick: () => { pre.classList.remove("capped"); more.hidden = true; } });
    const body = h("div", { class: "tool-body" },
      h("div", { class: "tool-body-title", text: `${t.label || t.name || "Tool"} — input` }),
      h("pre", { text: inputText }),
      h("div", { class: "tool-body-title", text: "Result" }),
      pre,
      more,
    );
    chip.append(summary, body);
    return chip;
  }

  function updateToolChip(chip, { ok, summary }) {
    const st = ok ? "ok" : "err";
    chip.classList.remove("running", "ok", "err");
    chip.classList.add(st);
    const box = chip.querySelector(".tool-icon");
    box.textContent = "";
    box.append(icon(ok ? "check" : "close", "icon"));
    chip.querySelector(".tool-state").textContent = ok ? "" : "failed";
    chip.querySelector(".tool-sr").textContent = `, ${TOOL_STATE_TEXT[st]}`;
    chip.querySelector(".tool-summary").textContent = summary || "";
    const pre = chip.querySelector(".tool-result");
    pre.textContent = summary || "";
    const capped = (summary || "").length > RESULT_CAP;
    pre.classList.toggle("capped", capped);
    const more = chip.querySelector(".tool-body .text-btn");
    if (more) more.hidden = !capped;
  }

  function timeEl(iso) {
    const t = Date.parse(iso);
    return h("time", { class: "msg-time", datetime: Number.isFinite(t) ? new Date(t).toISOString() : null, text: timeOfDay(iso) || relTime(iso) });
  }
  function renderMessage(m, showTime = true) {
    if (m.role === "user") {
      const wrap = h("div", { class: "msg msg-user", dataset: { id: m.id } }, h("span", { class: "sr-only", text: "You: " }));
      if (m.images && m.images.length) {
        wrap.append(h("div", { class: "thumbs" }, ...m.images.map((img) => h("img", { src: imageSrc(img), alt: "Attached photo", loading: "lazy" }))));
      }
      if (m.text) wrap.append(h("div", { class: "bubble", text: m.text }));
      if (showTime) wrap.append(timeEl(m.createdAt));
      return wrap;
    }
    const wrap = h("div", { class: "msg msg-assistant", dataset: { id: m.id } }, h("span", { class: "sr-only", text: "Assistant: " }));
    if (m.tools && m.tools.length) wrap.append(...m.tools.map(toolChip));
    if (m.text) wrap.append(renderMarkdown(m.text));
    if (showTime) wrap.append(timeEl(m.createdAt));
    return wrap;
  }

  /** A timestamp goes on the last message of a same-role run within 3 minutes, so a tool row and its answer read as one turn. */
  function showTimeFor(list, i) {
    const m = list[i];
    const next = list[i + 1];
    if (!next || next.role !== m.role) return true;
    const gap = Date.parse(next.createdAt) - Date.parse(m.createdAt);
    return !(Number.isFinite(gap) && gap >= 0 && gap <= 180000);
  }

  function renderMessages() {
    const list = els.messages;
    const wasStuck = state.stickToBottom;
    for (const n of [...list.children]) if (n !== els.emptyState) n.remove();
    let lastDay = "";
    state.messages.forEach((m, i) => {
      const k = dayKey(m.createdAt);
      if (k && k !== lastDay) {
        list.append(h("div", { class: "day-sep", text: dayLabel(m.createdAt) }));
        lastDay = k;
      }
      list.append(renderMessage(m, showTimeFor(state.messages, i)));
    });
    const empty = state.messages.length === 0 && !state.streaming;
    els.emptyState.hidden = !empty;
    els.quickChips.hidden = !empty;
    if (wasStuck) scrollToBottom();
  }

  function scrollToBottom() {
    const el = els.messages;
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  }
  els.messages.addEventListener("scroll", () => {
    const el = els.messages;
    state.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  });

  /* ---------- conversation header ---------- */
  function renderHeader() {
    const title = state.conversation ? state.conversation.title || "New conversation" : "New conversation";
    els.chatTitle.textContent = title;
    els.chatSub.textContent = "";
    if (state.unit) {
      const u = state.unit;
      const model = u.model && u.model !== unitBadgeText(u) ? u.model : "";
      els.chatSub.append(h("span", { class: "badge", text: unitBadgeText(u) }), h("span", { text: [model || u.manufacturer, u.site].filter(Boolean).join(" · ") }));
      els.btnChatUnit.setAttribute("aria-label", `Open unit ${unitLabel(state.unit)}`);
      els.btnChatUnit.classList.add("has-unit");
    } else {
      if (state.conversation) els.chatSub.append(h("span", { class: "muted", text: "No unit attached" }));
      els.btnChatUnit.setAttribute("aria-label", "Attach a unit");
      els.btnChatUnit.classList.remove("has-unit");
    }
    els.btnConvDelete.hidden = !state.conversation;
    els.btnChatShare.hidden = !state.conversation;
    doc.title = state.conversation && state.conversation.title ? `${state.conversation.title} · HVAC Field Assistant` : "HVAC Field Assistant";
    renderCtxPanel();
  }
  els.btnChatUnit.addEventListener("click", () => {
    if (state.unit) navigate(`#unit/${state.unit.id}`);
    else navigate(state.conversationId ? `#chat/${state.conversationId}/pick` : "#chat/pick");
  });

  /* ---------- load conversation ---------- */
  async function openConversation(id, { silent = false } = {}) {
    if (state.streaming && state.conversationId !== id) {
      if (!confirm("A response is still streaming. Leave this conversation?")) {
        setHashSilently(`#chat/${state.conversationId}`);
        return;
      }
      stopStream(true);
    }
    stopPolling();
    state.conversationId = id;
    store.set("hvac.lastConversation", id);
    if (!silent) {
      clearBanner("error");
      for (const n of [...els.messages.children]) if (n !== els.emptyState) n.remove();
      els.emptyState.hidden = true;
      els.quickChips.hidden = true;
      els.messages.append(h("div", { class: "skeleton", dataset: { skeleton: "1" } }), h("div", { class: "skeleton", dataset: { skeleton: "1" }, style: "min-height:96px" }));
    }
    try {
      const data = await apiJson(`/api/conversations/${encodeURIComponent(id)}`);
      if (state.conversationId !== id) return;
      applyConversation(data);
    } catch (e) {
      for (const n of els.messages.querySelectorAll("[data-skeleton]")) n.remove();
      if (e.code === "not_found" || e.status === 404) {
        store.set("hvac.lastConversation", null);
        resetConversation();
        setHashSilently("#chat");
        return;
      }
      renderMessages();
      showError(e.code, e.message);
    }
    markActiveRows();
  }

  function applyConversation(data, { keepScroll = false } = {}) {
    state.conversation = data.conversation || null;
    state.unit = data.unit || null;
    state.ctx = null;
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    state.busy = !!data.busy;
    if (!keepScroll) state.stickToBottom = true;
    renderMessages();
    renderHeader();
    if (state.busy && !state.streaming) {
      showBusyBanner();
      startPolling();
    } else if (!state.busy) {
      clearBanner("busy");
    }
    renderReadingsUnitChip();
    markActiveRows();
  }

  function resetConversation() {
    stopPolling();
    state.conversationId = null;
    state.conversation = null;
    state.unit = null;
    state.messages = [];
    state.busy = false;
    store.set("hvac.lastConversation", null);
    clearBanner("busy");
    clearBanner("error");
    renderMessages();
    renderHeader();
    renderReadingsUnitChip();
    markActiveRows();
  }

  /** What the transcript currently shows, in the same shape GET /api/conversations/:id returns. */
  function currentFingerprint() {
    return conversationFingerprint({ conversation: state.conversation, unit: state.unit, messages: state.messages, busy: state.busy });
  }
  async function reconcile() {
    if (!state.conversationId || state.streaming) return;
    const id = state.conversationId;
    try {
      const data = await apiJson(`/api/conversations/${encodeURIComponent(id)}`);
      if (state.conversationId !== id || state.streaming) return;
      // Re-render only when the server has something new; otherwise the tech keeps their scroll position
      // and any expanded tool details (nothing changed, so nothing moves).
      if (conversationFingerprint(data) !== currentFingerprint()) applyConversation(data, { keepScroll: true });
      loadConversations();
    } catch {
      /* stay as-is; the offline banner covers connectivity */
    }
  }
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "visible") {
      reconcile();
      if (state.wantWake && !state.wakeLock) requestWake();
    }
  });

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(async () => {
      if (!state.conversationId || state.streaming) return stopPolling();
      try {
        const data = await apiJson(`/api/conversations/${encodeURIComponent(state.conversationId)}`);
        if (!data.busy) {
          stopPolling();
          applyConversation(data);
          loadConversations();
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
  }
  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  /* ---------- sending + SSE ---------- */
  async function ensureConversation(unitId) {
    if (state.conversationId) return state.conversationId;
    const body = {};
    if (unitId) body.unit_id = unitId;
    const created = await apiJson("/api/conversations", { method: "POST", json: body });
    const conv = created && created.conversation ? created.conversation : created;
    state.conversation = conv;
    state.conversationId = conv.id;
    state.messages = [];
    store.set("hvac.lastConversation", conv.id);
    if (unitId && !state.unit) state.unit = state.unitsById.get(unitId) || (state.panelUnit && state.panelUnit.unit.id === unitId ? state.panelUnit.unit : null);
    renderHeader();
    if (state.route.screen === "chat") setHashSilently(`#chat/${conv.id}`);
    loadConversations();
    return conv.id;
  }

  async function sendMessage(text, images, { onAccepted } = {}) {
    const trimmed = (text || "").trim();
    if (!trimmed && !(images && images.length)) return;
    if (state.streaming) return toast("Wait for the current response (or press Stop).");
    if (state.busy) return toast("A response is still in progress on the server.");
    if (navigator.onLine === false) return toast("You're offline — chat needs a connection.");
    clearBanner("error");
    if (state.route.screen !== "chat") navigate(state.conversationId ? `#chat/${state.conversationId}` : "#chat");
    let convId;
    try {
      convId = await ensureConversation();
    } catch (e) {
      return showError(e.code, e.message);
    }
    const now = new Date().toISOString();
    const local = { id: `local-${Date.now()}`, seq: 0, role: "user", createdAt: now, text: trimmed, images: images && images.length ? images : undefined };
    state.messages.push(local);
    state.stickToBottom = true;
    renderMessages();

    const body = { text: trimmed };
    if (images && images.length) body.images = images.map((i) => ({ media_type: i.media_type, data: i.data }));
    // The composer text and photos are cleared only once the server has accepted the message (2xx). On a
    // 409 busy, a 4xx/5xx envelope or a network failure before headers they stay put so the tech can retry,
    // and the optimistic echo is removed so the transcript matches what the server holds.
    const accepted = await streamTurn(convId, body, { onAccepted });
    if (!accepted && state.messages.includes(local)) {
      state.messages = dropLocalEcho(state.messages, local.id);
      if (!state.streaming) renderMessages();
    }
  }

  function setStreaming(on) {
    state.streaming = on;
    els.btnStop.hidden = !on;
    els.btnSend.hidden = on;
    els.emptyState.hidden = true;
    els.quickChips.hidden = true;
    if (on) requestWake();
    else if (state.route.screen !== "readings") releaseWake();
  }

  /** Returns true when the server accepted the message (2xx) — even if the stream later dropped. */
  async function streamTurn(convId, body, { onAccepted } = {}) {
    const ac = new AbortController();
    state.abort = ac;
    setStreaming(true);

    // live assistant element: text segments and tool chips appended in stream order
    const live = h("div", { class: "msg msg-assistant streaming" }, h("span", { class: "sr-only", text: "Assistant: " }));
    const cursor = h("span", { class: "cursor", "aria-hidden": "true" });
    const typing = h("div", { class: "notice" }, h("span", { class: "spinner" }), "Thinking…");
    live.append(typing, cursor);
    els.messages.append(live);
    if (state.stickToBottom) scrollToBottom();
    let seg = null;
    let segText = "";
    let raf = 0;
    const chips = new Map();
    const keepCursorLast = () => live.append(cursor);
    // Screen readers hear only new text, announced at sentence/paragraph boundaries — never the whole reply per frame.
    let announceBuf = "";
    const announce = (text) => {
      const plain = String(text || "").replace(/[*_`#>|]+/g, " ").replace(/\s+/g, " ").trim();
      if (!plain) return;
      els.liveRegion.append(h("p", { text: plain }));
    };
    const announceReady = () => {
      const m = /^([\s\S]*?[.!?:](?:\s|$)|[\s\S]*?\n)([\s\S]*)$/.exec(announceBuf);
      if (!m) return;
      announceBuf = m[2];
      announce(m[1]);
      if (announceBuf.length) announceReady();
    };
    els.liveRegion.textContent = "";
    const flush = () => {
      raf = 0;
      if (!seg) return;
      const fresh = renderMarkdown(segText);
      fresh.classList.add("md-seg");
      seg.replaceWith(fresh);
      seg = fresh;
      keepCursorLast();
      if (state.stickToBottom) scrollToBottom();
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onEvent = (ev) => {
      if (!ev || typeof ev !== "object") return;
      if (typing.isConnected && (ev.type === "delta" || ev.type === "tool_start")) typing.remove();
      switch (ev.type) {
        case "delta":
          if (!seg) {
            seg = h("div", { class: "md md-seg" });
            live.append(seg);
            keepCursorLast();
            segText = "";
          }
          segText += ev.text || "";
          announceBuf += ev.text || "";
          announceReady();
          schedule();
          break;
        case "tool_start": {
          if (raf) {
            cancelAnimationFrame(raf);
            flush();
          }
          seg = null;
          announce(announceBuf);
          announceBuf = "";
          const chip = toolChip({ id: ev.id, name: ev.name, input: ev.input, label: ev.label });
          chips.set(ev.id, chip);
          live.append(chip);
          keepCursorLast();
          announce(`Running ${TOOL_LABEL[ev.name] || ev.label || ev.name}.`);
          if (state.stickToBottom) scrollToBottom();
          break;
        }
        case "tool_end": {
          const chip = chips.get(ev.id);
          if (chip) updateToolChip(chip, { ok: !!ev.ok, summary: ev.summary });
          announce(`${TOOL_LABEL[ev.name] || ev.name} ${ev.ok ? "done" : "failed"}.`);
          break;
        }
        case "notice":
          live.append(h("div", { class: "notice", text: ev.text || "" }));
          keepCursorLast();
          announce(ev.text || "");
          if (state.stickToBottom) scrollToBottom();
          break;
        case "unit_attached":
          if (ev.unitId) {
            loadUnitPanel(ev.unitId, { quiet: true }).then(() => {
              if (state.panelUnit && state.panelUnit.unit.id === ev.unitId) {
                state.unit = state.panelUnit.unit;
                state.ctx = null;
                renderHeader();
                renderReadingsUnitChip();
              }
            });
            toast("Unit attached to this conversation");
          }
          break;
        case "error":
          showError(ev.code, ev.message);
          break;
        case "done":
          break;
        default:
          break;
      }
    };

    let terminal = null;
    let busy409 = false;
    let accepted = false;
    try {
      const res = await api(`/api/conversations/${encodeURIComponent(convId)}/messages`, { method: "POST", json: body, signal: ac.signal, headers: { Accept: "text/event-stream" } });
      if (res.status === 409) {
        busy409 = true;
      } else if (!res.ok) {
        const err = await readError(res);
        showError(err.code, err.message);
      } else {
        accepted = true;
        if (typeof onAccepted === "function") onAccepted();
        if (!res.body) {
          showError("internal", "Streaming is not supported by this browser.");
        } else {
          // Heartbeat watchdog: a half-open socket (Wi-Fi→LTE hand-off, backgrounded phone) would otherwise
          // keep reader.read() pending for minutes with streaming=true, blocking Send and reconcile.
          // A watchdog-cancelled (idle) stream ends here with no terminal event and falls into the reconcile/poll path.
          terminal = (await pumpSse(res.body.getReader(), onEvent)).terminal;
        }
      }
    } catch (e) {
      if (!(e && e.name === "AbortError")) showError(e.code || "network", e.message || "Connection lost");
    } finally {
      if (raf) cancelAnimationFrame(raf);
      flush();
      typing.remove();
      cursor.remove();
      live.classList.remove("streaming");
      state.abort = null;
      setStreaming(false);
      announce(announceBuf);
      announceBuf = "";
      setTimeout(() => { els.liveRegion.textContent = ""; }, 1500);
    }

    if (busy409) {
      live.remove();
      state.busy = true;
      showBusyBanner();
      startPolling();
      return false;
    }
    if (!accepted) {
      live.remove();
      return false;
    }
    // Reconcile with the server's canonical state (ids, folded tool results, title changes).
    if (state.conversationId === convId) {
      try {
        const data = await apiJson(`/api/conversations/${encodeURIComponent(convId)}`);
        applyConversation(data);
      } catch {
        /* keep the live rendering */
      }
    }
    if (!terminal && !ac.signal.aborted) {
      // Stream dropped (or went silent past the heartbeat) without a terminal event: the server keeps running;
      // poll until it finishes.
      if (state.busy) {
        showBusyBanner();
        startPolling();
      }
    }
    loadConversations();
    return true;
  }

  async function stopStream(silent) {
    const id = state.conversationId;
    if (state.abort) state.abort.abort();
    if (!id) return;
    try {
      const r = await apiJson(`/api/conversations/${encodeURIComponent(id)}/stop`, { method: "POST", json: {} });
      if (!silent) toast(r && r.stopped ? "Stopped" : "Nothing to stop");
    } catch (e) {
      if (!silent) showError(e.code, e.message);
    }
  }
  els.btnStop.addEventListener("click", () => stopStream(false));

  /* ---------- composer ---------- */
  function autoGrow() {
    const ta = els.composerInput;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }
  els.composerInput.addEventListener("input", autoGrow);
  els.composerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !isTouch && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitComposer();
    }
  });
  function submitComposer() {
    const text = els.composerInput.value;
    const images = state.pendingImages.slice();
    sendMessage(text, images, {
      onAccepted: () => {
        // Clear what was sent; keep anything typed while the request was in flight.
        const cur = els.composerInput.value;
        els.composerInput.value = cur === text ? "" : cur.startsWith(text) ? cur.slice(text.length) : cur;
        autoGrow();
        // Drop only the photos that went with this message; anything attached since stays.
        state.pendingImages = state.pendingImages.filter((img) => !images.includes(img));
        renderPreviews();
      },
    });
  }
  els.btnSend.addEventListener("click", submitComposer);

  function insertIntoComposer(text) {
    const ta = els.composerInput;
    ta.value = ta.value.trim() ? `${ta.value.trimEnd()}\n${text}` : text;
    autoGrow();
    navigate(state.conversationId ? `#chat/${state.conversationId}` : "#chat");
    ta.focus();
    toast("Added to the message — press Send");
  }

  /* photos */
  const MAX_IMAGES = 4;
  els.btnAttach.addEventListener("click", () => {
    if (state.pendingImages.length >= MAX_IMAGES) return toast(`Up to ${MAX_IMAGES} photos per message`);
    els.fileInput.value = "";
    els.fileInput.click();
  });
  els.btnCamera.addEventListener("click", () => {
    if (state.pendingImages.length >= MAX_IMAGES) return toast(`Up to ${MAX_IMAGES} photos per message`);
    els.fileCamera.value = "";
    els.fileCamera.click();
  });
  async function addFiles(files) {
    for (const f of files) {
      if (state.pendingImages.length >= MAX_IMAGES) {
        toast(`Up to ${MAX_IMAGES} photos per message`);
        break;
      }
      try {
        state.pendingImages.push(await resizeImage(f));
      } catch (e) {
        toast(`Could not read image: ${e.message || e}`);
      }
    }
    renderPreviews();
  }
  els.fileInput.addEventListener("change", () => addFiles([...(els.fileInput.files || [])]));
  els.fileCamera.addEventListener("change", () => addFiles([...(els.fileCamera.files || [])]));
  els.fileCameraSend.addEventListener("change", async () => {
    const f = els.fileCameraSend.files && els.fileCameraSend.files[0];
    if (!f) return;
    try {
      const img = await resizeImage(f);
      await sendMessage(DECODE_PROMPT, [img]);
    } catch (e) {
      toast(`Could not read image: ${e.message || e}`);
    }
  });
  function openCameraForDecode() {
    els.fileCameraSend.value = "";
    els.fileCameraSend.click();
  }

  function renderPreviews() {
    els.previews.textContent = "";
    els.previews.hidden = state.pendingImages.length === 0;
    state.pendingImages.forEach((img, i) => {
      els.previews.append(h("div", { class: "preview" },
        h("img", { src: img.url, alt: `Photo ${i + 1}` }),
        h("button", { type: "button", "aria-label": "Remove photo", onclick: () => { state.pendingImages.splice(i, 1); renderPreviews(); } }, icon("close", "icon")),
      ));
    });
  }

  function loadImageEl(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("unsupported image"));
      };
      img.src = url;
    });
  }
  /** Downscale to ≤ 1568 px on the long edge, JPEG 0.85. Returns {media_type, data (base64, no prefix), url}. */
  async function resizeImage(file) {
    const img = await loadImageEl(file);
    const w = img.naturalWidth || img.width;
    const hgt = img.naturalHeight || img.height;
    const scale = Math.min(1, 1568 / Math.max(w, hgt));
    const canvas = doc.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(hgt * scale));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", 0.85);
    const data = url.slice(url.indexOf(",") + 1);
    return { media_type: "image/jpeg", data, url };
  }

  /* quick-start chips */
  els.quickChips.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-quick]");
    if (!btn) return;
    const q = btn.dataset.quick;
    if (q === "decode") {
      openCameraForDecode();
    } else if (q === "readings") {
      navigate("#readings");
    } else if (q === "fault") {
      els.composerInput.value = "Look up fault code ";
      autoGrow();
      els.composerInput.focus();
      const len = els.composerInput.value.length;
      els.composerInput.setSelectionRange(len, len);
    } else if (QUICK_PROMPTS[q]) {
      sendMessage(QUICK_PROMPTS[q], []);
    }
  });

  /* ---------- conversations (history tab + chat side column) ---------- */
  async function loadConversations() {
    const qs = new URLSearchParams();
    if (state.convFilterUnitId) qs.set("unit_id", state.convFilterUnitId);
    qs.set("limit", "100");
    try {
      const json = await apiJson(`/api/conversations?${qs}`);
      state.conversations = pickList(json, "conversations");
      renderConversations();
      if (state.conversation) {
        const mine = state.conversations.find((c) => c.id === state.conversationId);
        if (mine && mine.title !== state.conversation.title) {
          state.conversation = mine;
          renderHeader();
        }
      }
    } catch (e) {
      for (const list of [els.convList, els.convListSide]) {
        list.textContent = "";
        list.append(h("div", { class: "list-empty", text: `Could not load: ${e.message}` }));
      }
    }
  }

  function convUnitBadge(c) {
    const u = c.unit || state.unitsById.get(c.unit_id);
    const txt = u ? unitBadgeText(u) : c.unit_tag || c.unit_model || "";
    return txt ? h("span", { class: "badge", text: txt }) : null;
  }

  function conversationRow(c, { compact = false } = {}) {
    const active = c.id === state.conversationId;
    const row = h("button", { class: "row", type: "button", onclick: () => navigate(`#chat/${c.id}`) },
      compact ? null : h("div", { class: "row-lead" }, icon("chat")),
      h("div", { class: "row-body" },
        h("div", { class: "row-title", text: c.title || "New conversation" }),
        h("div", { class: "row-sub" }, convUnitBadge(c), c.tester_name ? h("span", { class: "badge badge-tester", text: c.tester_name }) : null, h("span", { text: [relTime(c.updated_at || c.created_at), c.summary].filter(Boolean).join(" · ") })),
      ),
    );
    const del = h("button", { class: "icon-btn", type: "button", "aria-label": `Delete conversation ${c.title || ""}`, onclick: () => deleteConversation(c) }, icon("trash", "icon icon-sm"));
    return h("div", { class: `row-item${active ? " active" : ""}`, role: "listitem", "aria-current": active ? "true" : null, dataset: { convId: c.id } }, row, del);
  }
  /** Plain list row (button) wrapped in a listitem so AT hears "button", not "list item". */
  function listRow(rowBtn, attrs = {}) {
    return h("div", { class: "row-item", role: "listitem", ...attrs }, rowBtn);
  }

  function renderConversations() {
    for (const [list, compact] of [[els.convList, false], [els.convListSide, true]]) {
      list.textContent = "";
      if (!state.conversations.length) {
        list.append(h("div", { class: "empty" },
          h("div", { class: "empty-icon" }, icon("chat")),
          h("div", { class: "empty-title", text: state.convFilterUnitId ? "No conversations on this unit" : "No conversations yet" }),
          h("p", { class: "empty-sub", text: "Start a job from the Chat tab — every conversation and finding lands here, searchable." }),
          h("button", { class: "btn btn-primary", type: "button", onclick: () => navigate("#chat/new") }, icon("plus"), "New conversation"),
        ));
        continue;
      }
      let lastDay = "";
      for (const c of state.conversations) {
        const k = dayKey(c.updated_at || c.created_at);
        if (!compact && k && k !== lastDay) {
          list.append(h("div", { class: "group-head" }, h("span", { text: dayLabel(c.updated_at || c.created_at) })));
          lastDay = k;
        }
        list.append(conversationRow(c, { compact }));
      }
    }
    renderConvFilter();
  }
  function renderConvFilter() {
    const unit = state.convFilterUnitId ? state.unitsById.get(state.convFilterUnitId) : null;
    for (const el of [els.convFilter, els.convFilterSide]) {
      el.hidden = !unit;
      el.textContent = "";
      if (unit) el.append(h("span", { text: "Showing" }), h("span", { class: "badge", text: unitLabel(unit) }), h("button", { class: "text-btn", type: "button", text: "All", style: "margin-left:auto", onclick: () => setConvFilter(null) }));
    }
  }

  async function deleteConversation(c) {
    if (!confirm(`Delete "${c.title || "this conversation"}"? This cannot be undone.`)) return;
    try {
      await apiJson(`/api/conversations/${encodeURIComponent(c.id)}`, { method: "DELETE" });
      if (state.conversationId === c.id) {
        resetConversation();
        if (state.route.screen === "chat") setHashSilently("#chat");
      }
      toast("Conversation deleted");
      loadConversations();
      if (state.panelUnit) loadUnitPanel(state.panelUnit.unit.id, { quiet: true });
    } catch (e) {
      showError(e.code, e.message);
    }
  }
  els.btnConvDelete.addEventListener("click", () => state.conversation && deleteConversation(state.conversation));

  function setActive(el, on) {
    el.classList.toggle("active", on);
    if (on) el.setAttribute("aria-current", "true");
    else el.removeAttribute("aria-current");
  }
  function markActiveRows() {
    for (const r of doc.querySelectorAll("[data-conv-id]")) setActive(r, r.dataset.convId === state.conversationId);
    for (const r of els.unitsList.querySelectorAll("[data-unit-id]")) setActive(r, !!state.panelUnit && state.route.screen === "units" && r.dataset.unitId === state.panelUnit.unit.id);
  }

  for (const b of doc.querySelectorAll(".btn-new-conv")) {
    b.addEventListener("click", () => {
      if (state.streaming) return toast("Wait for the current response first.");
      navigate("#chat/new");
    });
  }

  function setConvFilter(unit) {
    state.convFilterUnitId = unit ? unit.id : null;
    loadConversations();
  }

  /* ---------- units list ---------- */
  async function loadUnits() {
    try {
      const json = await apiJson("/api/units?limit=200");
      state.units = pickList(json, "units");
      state.unitsById = new Map(state.units.map((u) => [u.id, u]));
      renderUnits();
      renderConversations();
    } catch (e) {
      els.unitsList.textContent = "";
      els.unitsList.append(h("div", { class: "list-empty", text: `Could not load: ${e.message}` }));
    }
  }
  $("btn-units-refresh").addEventListener("click", () => {
    loadUnits().then(() => toast("Units refreshed"));
  });
  els.unitsSearch.addEventListener("input", () => {
    state.unitsQuery = els.unitsSearch.value;
    renderUnits();
  });

  function unitSubtitle(u) {
    return [u.manufacturer || u.brand, u.model && u.model !== unitLabel(u) ? u.model : "", u.refrigerant, u.tonnage ? `${u.tonnage} ton` : ""].filter(Boolean).join(" · ");
  }

  function renderUnits() {
    els.unitsList.textContent = "";
    if (!state.units.length) {
      els.unitsList.append(h("div", { class: "empty" },
        h("div", { class: "empty-icon" }, icon("units")),
        h("div", { class: "empty-title", text: "No units yet" }),
        h("p", { class: "empty-sub", text: "Decode a nameplate to save the first unit. Every finding and conversation attaches to it." }),
        h("button", { class: "btn btn-primary", type: "button", onclick: () => navigate("#units/decode") }, icon("scan"), "Decode a nameplate"),
      ));
      return;
    }
    const list = filterUnits(state.units, state.unitsQuery);
    if (!list.length) {
      els.unitsList.append(h("div", { class: "list-empty", text: "No units match." }));
      return;
    }
    for (const [site, units] of groupUnitsBySite(list)) {
      els.unitsList.append(h("div", { class: "site-head" }, h("span", null, icon("site", "icon icon-sm"), " ", site), h("span", { class: "muted", text: `${units.length}` })));
      const card = h("div", { class: "list-card", role: "list" });
      for (const u of units) {
        const active = !!(state.panelUnit && state.panelUnit.unit.id === u.id && state.route.screen === "units");
        card.append(listRow(h("button", { class: "row", type: "button", onclick: () => navigate(`#unit/${u.id}`) },
          h("div", { class: "row-lead" }, icon("units")),
          h("div", { class: "row-body" }, h("div", { class: "row-title", text: unitLabel(u) }), h("div", { class: "row-sub" }, h("span", { text: unitSubtitle(u) || "No details yet" }))),
          h("div", { class: "row-meta" }, u.last_service_at ? h("span", { text: relTime(u.last_service_at) }) : null, icon("chevron", "icon icon-sm row-chevron")),
        ), { class: `row-item${active ? " active" : ""}`, "aria-current": active ? "true" : null, dataset: { unitId: u.id } }));
      }
      els.unitsList.append(card);
    }
  }

  /* ---------- unit detail ---------- */
  async function loadUnitPanel(unitId, { quiet = false } = {}) {
    if (!quiet && state.route.screen === "units") {
      els.unitEmpty.hidden = true;
      els.unitContent.hidden = false;
      els.unitContent.textContent = "";
      els.unitContent.append(h("div", { class: "skeleton", style: "min-height:180px" }), h("div", { class: "skeleton" }), h("div", { class: "skeleton" }));
    }
    try {
      const [data, readingsData] = await Promise.all([
        apiJson(`/api/units/${encodeURIComponent(unitId)}`),
        apiJson(`/api/units/${encodeURIComponent(unitId)}/readings?limit=20`).catch(() => null),
      ]);
      const unit = data.unit || data;
      let decoded = data.decoded || null;
      if (!decoded && unit.decoded_json) {
        try {
          decoded = JSON.parse(unit.decoded_json);
        } catch {
          decoded = null;
        }
      }
      state.panelUnit = {
        unit, decoded, findings: pickList(data.findings || [], "findings"), conversations: pickList(data.conversations || [], "conversations"), corrections: pickList(data.corrections || [], "corrections"),
        readings: readingsData ? pickList(readingsData.readings || [], "readings") : [], readingsFailed: !readingsData, trend: data.trend || (readingsData && readingsData.trend) || null,
      };
      state.unitsById.set(unit.id, unit);
      renderUnitDetail();
      markActiveRows();
      if (state.unit && state.unit.id === unit.id) {
        state.unit = unit;
        renderHeader();
      }
    } catch (e) {
      if (!quiet) {
        els.unitContent.textContent = "";
        els.unitContent.append(h("div", { class: "field-error", role: "alert", text: `${e.code}: ${e.message}` }));
      }
    }
  }

  const ATTR_LABEL = {
    unit_type: "Unit type", series: "Series", tonnage: "Nominal tons", refrigerant: "Refrigerant", voltage: "Voltage/phase/Hz",
    heat_type: "Heat type", heat_capacity: "Heat capacity", efficiency: "Efficiency", controls: "Controls", revision: "Revision",
    compressor_type: "Compressor", stages: "Stages", airflow: "Airflow", cabinet: "Cabinet", options: "Options", other: "Other",
  };
  const CONF_CLASS = { high: "chip-ok", medium: "chip-warn", low: "chip-danger" };
  const CONF_LABEL = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };

  function attr(label, value, cls = "") {
    if (value === null || value === undefined || value === "") return null;
    const text = String(value);
    // Long values (equivalent families, product descriptions) take the full row instead of being clipped in a half column.
    const wide = text.length > 30 && !cls.includes("num");
    return h("div", { class: `attr${wide ? " attr-wide" : ""}` }, h("div", { class: "attr-label", text: label }), h("div", { class: `attr-value${cls ? ` ${cls}` : ""}`, text }));
  }
  /** Confidence chip with one short, consistent wording everywhere ("Model: medium"). */
  function confChip(kind, m) {
    if (!m) return null;
    return h("span", { class: `chip ${CONF_CLASS[m.confidence] || ""}`, title: `${kind} match ${CONF_LABEL[m.confidence] ? CONF_LABEL[m.confidence].toLowerCase() : m.confidence}`, text: `${kind}: ${m.confidence}${m.ambiguous ? " (ambiguous)" : ""}` });
  }
  /** Control platform name without its trailing " — LED flash codes" style description. */
  function shortPlatform(v) {
    return v ? String(v).split(" — ")[0] : v;
  }

  /** Nameplate-style unit card (unit detail and the desktop context panel). */
  function buildPlate(u, d, { attached, actions = true } = {}) {
    const bestSerial = d && d.serial && d.serial[0];
    const bestModel = d && d.model && d.model[0];
    let age = "";
    if (bestSerial && bestSerial.manufactureDate) age = `${bestSerial.manufactureDate}${bestSerial.ageYears !== undefined ? ` · ${fmtNum(bestSerial.ageYears)}\u00a0yr` : ""}`;
    else if (u.install_year) age = String(u.install_year);
    let charge = "";
    if (u.charge_json) {
      try {
        const c = JSON.parse(u.charge_json);
        charge = typeof c === "object" && c ? Object.entries(c).map(([k, v]) => `${k}: ${v}`).join(", ") : String(c);
      } catch {
        charge = u.charge_json;
      }
    }
    return h("div", { class: "nameplate" },
      h("div", { class: "np-head" },
        h("div", { class: "np-tag", text: [u.unit_tag, u.nickname].filter(Boolean).join(" · ") || "Unit" }),
        h("div", { class: "np-model", text: u.model || "No model on record" }),
        h("div", { class: "np-mfr", text: u.manufacturer || u.brand || "Manufacturer unknown" }),
        bestModel && bestModel.family ? h("div", { class: "np-family", text: bestModel.family }) : null,
        u.serial ? h("div", { class: "np-serial" }, h("span", { class: "muted", text: "S/N" }), h("span", { text: u.serial })) : null,
      ),
      h("div", { class: "np-body" },
        (u.site || u.customer) ? h("div", { class: "np-site" }, icon("site", "icon icon-sm"), h("span", { text: [u.site, u.customer, u.location_note].filter(Boolean).join(" · ") })) : null,
        h("div", { class: "chip-row" },
          confChip("Model", bestModel),
          confChip("Serial", bestSerial),
          needsNameplateVerify(d) ? h("span", { class: "chip chip-warn" }, icon("alert", "icon"), "Verify on nameplate") : null,
          attached ? h("span", { class: "chip chip-accent" }, icon("link", "icon"), "In this chat") : null,
        ),
        h("div", { class: "attr-grid" },
          attr("Refrigerant", u.refrigerant), attr("Tonnage", u.tonnage ? `${u.tonnage}\u00a0ton` : null, "num"), attr("Voltage", u.voltage && u.phase && !String(u.voltage).includes(String(u.phase)) ? `${u.voltage} · ${u.phase}-ph` : u.voltage || (u.phase ? `${u.phase}-phase` : null), "num"),
          attr("Controls", shortPlatform(u.control_platform)), attr("Heat", u.heat_type), attr("Metering", u.metering_device ? (METERING_LABEL[u.metering_device] || u.metering_device) : null),
          attr("Manufactured", age, "num"), attr("Circuits", u.circuits), attr("Charge", charge), attr("Elevation", u.elevation_ft !== null && u.elevation_ft !== undefined ? `${u.elevation_ft}\u00a0ft` : null, "num"),
        ),
        u.notes ? h("p", { class: "dc-summary", text: u.notes }) : null,
      ),
      actions ? h("div", { class: "np-actions" },
        h("button", { class: "btn btn-primary", type: "button", onclick: attachOrStart }, icon(attached ? "chat" : "link"), attached ? "Open chat" : state.conversationId ? "Attach to chat" : "Start chat"),
        h("button", { class: "btn", type: "button", onclick: () => { prefillReadingsFromUnit(u, { force: true }); navigate("#readings"); } }, icon("gauge"), "Readings"),
        h("button", { class: "btn", type: "button", onclick: () => navigate(`#unit/${u.id}/edit`) }, icon("edit"), "Edit"),
        h("button", { class: "btn", type: "button", onclick: () => navigate(`#unit/${u.id}/actions`) }, icon("more"), "More"),
        h("button", { class: "btn np-qr", type: "button", onclick: () => navigate(`#unit/${u.id}/qr`) }, icon("scan"), "QR label"),
        h("button", { class: "btn np-unit-report", type: "button", onclick: () => navigate(`#unit/${u.id}/report`) }, icon("file"), "Unit report"),
        h("button", { class: "btn btn-ghost np-report", type: "button", onclick: () => navigate(`#unit/${u.id}/correct`) }, icon("flag"), "Report a wrong detail"),
      ) : null,
    );
  }

  function buildFindingsCard(findingsRaw, { onChanged, unitId } = {}) {
    const findings = sortFindings(findingsRaw || []);
    const fcard = h("div", { class: "card" }, h("div", { class: "card-title" }, h("span", { text: `Findings (${findings.length})` }),
      unitId ? h("button", { class: "text-btn", type: "button", text: "Add", onclick: () => navigate(`#unit/${unitId}/finding`) }) : null));
    if (!findings.length) fcard.append(h("div", { class: "list-empty", text: "No findings on this unit yet. The assistant offers to save one after a fix is verified." }));
    else fcard.append(h("div", { class: "timeline", role: "list" }, ...findings.map((f) => findingItem(f, onChanged))));
    return fcard;
  }

  function renderUnitDetail() {
    const pu = state.panelUnit;
    els.unitEmpty.hidden = !!pu;
    els.unitContent.hidden = !pu;
    els.btnUnitMore.hidden = !pu;
    els.unitContent.textContent = "";
    if (!pu) {
      els.unitTitle.textContent = "Unit";
      els.unitSub.textContent = "";
      return;
    }
    const u = pu.unit;
    const d = pu.decoded;
    els.unitTitle.textContent = unitLabel(u);
    els.unitSub.textContent = "";
    els.unitSub.append(h("span", { text: [u.site, u.customer].filter(Boolean).join(" · ") }));
    const attached = !!(state.unit && state.unit.id === u.id);

    els.unitContent.append(buildPlate(u, d, { attached }));
    if (pu.corrections && pu.corrections.length) els.unitContent.append(buildCorrectionsCard(pu.corrections, u.id));

    // Decode details
    if (d) {
      const card = h("div", { class: "card" }, h("div", { class: "card-title", text: "Decoded from the nameplate" }));
      card.append(renderDecodeCard(d, { compact: false }));
      els.unitContent.append(card);
    }

    // Findings timeline (with Add / Edit → finding sheet)
    els.unitContent.append(buildFindingsCard(pu.findings, { unitId: u.id }));
    // Readings history + trend since last visit
    els.unitContent.append(buildReadingsCard(pu, u));

    // Conversations on this unit
    const convs = pu.conversations || [];
    const ccard = h("div", { class: "card" }, h("div", { class: "card-title" }, h("span", { text: `Conversations (${convs.length})` }), h("button", { class: "text-btn", type: "button", text: "New", onclick: startConversationOnUnit })));
    if (!convs.length) ccard.append(h("div", { class: "list-empty", text: "No conversations on this unit yet." }));
    else {
      const list = h("div", { class: "list", role: "list" });
      for (const c of convs) {
        const active = c.id === state.conversationId;
        list.append(listRow(h("button", { class: "row", type: "button", onclick: () => navigate(`#chat/${c.id}`) },
          h("div", { class: "row-lead" }, icon("chat")),
          h("div", { class: "row-body" }, h("div", { class: "row-title", text: c.title || "New conversation" }), h("div", { class: "row-sub" }, h("span", { text: [relTime(c.updated_at || c.created_at), c.summary].filter(Boolean).join(" · ") }))),
          icon("chevron", "icon icon-sm row-chevron"),
        ), { class: `row-item${active ? " active" : ""}`, "aria-current": active ? "true" : null, dataset: { convId: c.id } }));
      }
      ccard.append(list);
    }
    els.unitContent.append(ccard);
    els.unitDetail.scrollTo({ top: 0, behavior: "instant" });
  }

  function findingItem(f, onChanged) {
    const hyp = isHypothesis(f);
    const statusCls = f.status === "open" ? "chip-danger" : f.status === "monitor" ? "chip-warn" : "chip-ok";
    const patch = (patchBody, msg) => patchFinding(f, patchBody, msg, onChanged);
    const item = h("div", { class: `tl-item ${f.status || "open"}${hyp ? " hypothesis" : ""}`, role: "listitem" },
      h("div", { class: "tl-head" },
        h("span", { class: `chip ${statusCls}`, text: f.status || "open" }),
        hyp ? h("span", { class: "chip chip-info", text: "Hypothesis — unconfirmed" }) : null,
        Number(f.confirmed) && (f.cause || f.resolution) ? h("span", { class: "chip chip-ok" }, icon("check", "icon"), "Confirmed") : null,
        f.circuit ? h("span", { class: "chip", text: `Circuit ${f.circuit}` }) : null,
        h("span", { class: "row-meta", text: relTime(f.service_date || f.created_at) }),
      ),
      h("div", { class: "tl-symptom", text: f.symptom }),
    );
    if (f.cause) item.append(h("div", { class: "tl-line" }, h("b", { text: "Cause: " }), f.cause));
    if (f.resolution) item.append(h("div", { class: "tl-line" }, h("b", { text: "Fix: " }), f.resolution));
    if (f.refrigerant_added_lbs) item.append(h("div", { class: "tl-line" }, h("b", { text: "Refrigerant added: " }), `${f.refrigerant_added_lbs} lb ${f.refrigerant || ""}`));
    if (f.follow_up) {
      const chip = dueChip(f.follow_up_due, f.follow_up_done);
      item.append(h("div", { class: "tl-line tl-follow" }, h("b", { text: "Follow-up: " }), f.follow_up, " ", h("span", { class: `chip due-chip ${chip.kind}`, text: chip.label })));
    }
    const actions = h("div", { class: "tl-actions" });
    if (!Number(f.confirmed)) actions.append(h("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => patch({ confirmed: 1 }, "Finding confirmed") }, icon("check", "icon icon-sm"), "Confirm"));
    if (f.status !== "resolved") actions.append(h("button", { class: "btn btn-sm", type: "button", text: "Mark resolved", onclick: () => patch({ status: "resolved" }, "Marked resolved") }));
    if (f.status === "open") actions.append(h("button", { class: "btn btn-sm btn-ghost", type: "button", text: "Monitor", onclick: () => patch({ status: "monitor" }, "Set to monitor") }));
    if (f.status === "resolved") actions.append(h("button", { class: "btn btn-sm btn-ghost", type: "button", text: "Reopen", onclick: () => patch({ status: "open" }, "Reopened") }));
    if (f.unit_id) actions.append(h("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => navigate(`#unit/${f.unit_id}/finding/${f.id}`) }, icon("edit", "icon icon-sm"), "Edit"));
    actions.append(h("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => shareFinding(f) }, icon("share", "icon icon-sm"), navigator.share ? "Share" : "Copy"));
    item.append(actions);
    return item;
  }

  async function patchFinding(f, patch, msg, onChanged) {
    try {
      await apiJson(`/api/findings/${encodeURIComponent(f.id)}`, { method: "PATCH", json: patch });
      toast(msg);
      loadFollowUps({ quiet: true });
      if (state.panelUnit) loadUnitPanel(state.panelUnit.unit.id, { quiet: true });
      if (state.ctx && f.unit_id === state.ctx.unit.id) state.ctx = null;
      if (typeof onChanged === "function") onChanged();
      else renderCtxPanel();
    } catch (e) {
      showError(e.code, e.message);
      if (state.route.screen !== "chat") toast(`${e.code}: ${e.message}`);
    }
  }
  function findingText(f) {
    const u = state.panelUnit ? state.panelUnit.unit : null;
    return [u ? `${unitLabel(u)} (${[u.manufacturer, u.model].filter(Boolean).join(" ")})` : "", `Symptom: ${f.symptom}`, f.cause ? `Cause: ${f.cause}` : "", f.resolution ? `Fix: ${f.resolution}` : "", f.service_date ? `Date: ${f.service_date}` : ""].filter(Boolean).join("\n");
  }
  async function shareFinding(f) {
    const text = findingText(f);
    if (navigator.share) {
      navigator.share({ title: "HVAC finding", text }).catch(() => {});
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard");
    } catch {
      toast("Copy not available in this browser");
    }
  }
  function unitText(u) {
    return [`${unitLabel(u)}`, [u.manufacturer, u.model].filter(Boolean).join(" "), u.serial ? `S/N ${u.serial}` : "", [u.site, u.customer].filter(Boolean).join(" · "), [u.refrigerant, u.tonnage ? `${u.tonnage} ton` : "", u.voltage].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
  }

  async function attachOrStart() {
    const pu = state.panelUnit;
    if (!pu) return;
    if (state.unit && state.unit.id === pu.unit.id) return navigate(`#chat/${state.conversationId}`);
    try {
      if (!state.conversationId) {
        await ensureConversation(pu.unit.id);
        state.unit = pu.unit;
      } else {
        const r = await apiJson(`/api/conversations/${encodeURIComponent(state.conversationId)}`, { method: "PATCH", json: { unit_id: pu.unit.id } });
        state.conversation = (r && r.conversation) || r || state.conversation;
        state.unit = pu.unit;
      }
      renderHeader();
      renderReadingsUnitChip();
      loadConversations();
      toast(`Attached ${unitLabel(pu.unit)}`);
      navigate(`#chat/${state.conversationId}`);
    } catch (e) {
      showError(e.code, e.message);
      toast(`${e.code}: ${e.message}`);
    }
  }

  async function startConversationOnUnit() {
    const pu = state.panelUnit;
    if (!pu) return;
    if (state.streaming) return toast("Wait for the current response first.");
    resetConversation();
    try {
      await ensureConversation(pu.unit.id);
      state.unit = pu.unit;
      renderHeader();
      renderReadingsUnitChip();
      navigate(`#chat/${state.conversationId}`);
      if (!isTouch) els.composerInput.focus();
    } catch (e) {
      showError(e.code, e.message);
      toast(`${e.code}: ${e.message}`);
    }
  }

  async function archiveUnit() {
    const pu = state.panelUnit;
    if (!pu) return;
    if (!confirm(`Archive ${unitLabel(pu.unit)}? Its findings and conversations are kept; the unit leaves the list.`)) return;
    try {
      await apiJson(`/api/units/${encodeURIComponent(pu.unit.id)}`, { method: "DELETE" });
      toast("Unit archived");
      if (state.convFilterUnitId === pu.unit.id) setConvFilter(null);
      state.panelUnit = null;
      renderUnitDetail();
      await loadUnits();
      navigate("#units", { replace: true });
    } catch (e) {
      showError(e.code, e.message);
      toast(`${e.code}: ${e.message}`);
    }
  }

  /* unit actions sheet */
  els.btnUnitMore.addEventListener("click", () => {
    if (state.panelUnit) navigate(`#unit/${state.panelUnit.unit.id}/actions`);
  });
  function showUnitActions(unitId) {
    const pu = state.panelUnit && state.panelUnit.unit.id === unitId ? state.panelUnit : null;
    const u = pu ? pu.unit : state.unitsById.get(unitId);
    els.unitActionsTitle.textContent = u ? unitLabel(u) : "Unit";
    const list = els.unitActionsList;
    list.textContent = "";
    const attached = !!(u && state.unit && state.unit.id === u.id);
    const action = (ic, title, sub, fn, cls = "") => h("button", { class: `row ${cls}`, type: "button", onclick: () => { closeSheets(); setTimeout(fn, 0); } },
      h("div", { class: "row-lead" }, icon(ic)), h("div", { class: "row-body" }, h("div", { class: "row-title", text: title }), sub ? h("div", { class: "row-sub" }, h("span", { text: sub })) : null), icon("chevron", "icon icon-sm row-chevron"));
    list.append(
      action("link", attached ? "Open the chat" : state.conversationId ? "Attach to this conversation" : "Start a conversation", attached ? "This unit is attached to the current chat" : "Job memory follows the unit", attachOrStart),
      action("plus", "New conversation on this unit", null, startConversationOnUnit),
      action("gauge", "Enter readings", "Prefilled with refrigerant and elevation", () => { if (u) prefillReadingsFromUnit(u, { force: true }); navigate("#readings"); }),
      action("history", "Show its conversations", "Filter History to this unit", () => { if (u) setConvFilter(u); navigate("#history"); }),
      action("edit", "Edit or re-decode", "Change model, serial, tag, site…", () => navigate(`#unit/${unitId}/edit`)),
      action("flag", "Report a wrong detail", "Correct what the decoder got wrong", () => navigate(`#unit/${unitId}/correct`)),
      action("file", "Unit report", "Share, print or copy the unit history", () => navigate(`#unit/${unitId}/report`)),
      action("scan", "QR label", "Sticker that opens this unit when scanned", () => navigate(`#unit/${unitId}/qr`)),
      action("share", navigator.share ? "Share unit" : "Copy unit details", null, async () => {
        if (!u) return;
        const text = unitText(u);
        if (navigator.share) navigator.share({ title: unitLabel(u), text }).catch(() => {});
        else {
          try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Copy not available"); }
        }
      }),
      action("archive", "Archive unit", "Findings and conversations are kept", archiveUnit, "danger"),
    );
    showSheet(els.sheetUnitActions);
  }

  /* ---------- bulk fleet import sheet ---------- */
  const imp = { previewText: null, result: null, busy: false };
  $("btn-unit-import").addEventListener("click", () => navigate("#units/import"));
  function showImportSheet() {
    els.importError.hidden = true;
    renderImportPreview();
    showSheet(els.sheetImport);
  }
  function importInvalidate() {
    if (imp.previewText === null) return;
    imp.previewText = null;
    imp.result = null;
    renderImportPreview();
  }
  function showImportError(msg) {
    els.importError.hidden = !msg;
    els.importError.textContent = msg || "";
  }
  const IMPORT_STATUS = { new: ["chip-ok", "New"], duplicate: ["chip-warn", "Duplicate"], error: ["chip-danger", "Error"] };
  const IMPORT_CONF = { high: ["chip-ok", "High"], medium: ["chip-warn", "Medium"], low: ["chip-danger", "Low"], none: ["chip-outline", "No match"] };
  function importRow(row) {
    const t = importRowText(row);
    const d = row.decoded;
    const [stCls, stText] = IMPORT_STATUS[row.status] || IMPORT_STATUS.error;
    const conf = d ? IMPORT_CONF[d.confidence] || IMPORT_CONF.none : null;
    const warnings = d && Array.isArray(d.warnings) ? d.warnings : [];
    const rowNo = row.line || row.index + 1;
    return h("div", { class: `imp-row imp-${row.status}`, role: "listitem" },
      h("div", { class: "imp-title" }, h("span", { class: "imp-no", text: `${rowNo}`, title: `Row ${rowNo}` }), h("span", { class: "imp-name", text: t.title, title: t.title })),
      h("div", { class: "imp-chips" },
        conf ? h("span", { class: `chip ${conf[0]}`, title: "Decode confidence", text: conf[1] }) : null,
        h("span", { class: `chip ${stCls}`, text: stText }),
      ),
      t.subtitle ? h("div", { class: "imp-sub", text: t.subtitle, title: t.subtitle }) : null,
      t.ident ? h("div", { class: "imp-ident mono", text: t.ident, title: t.ident }) : null,
      row.error ? h("div", { class: `imp-note${row.status === "error" ? " danger" : ""}`, text: row.error }) : null,
      warnings.length ? h("details", { class: "imp-warn" },
        h("summary", null, icon("alert", "icon icon-sm"), h("span", { text: plural(warnings.length, "warning", "warnings") })),
        h("ul", null, ...warnings.map((w) => h("li", { text: w }))),
      ) : null,
    );
  }
  function renderImportPreview() {
    const r = imp.result;
    const box = els.importPreview;
    box.textContent = "";
    box.hidden = !r;
    els.btnImportRun.disabled = !r || !r.summary.new || imp.busy;
    els.btnImportRun.textContent = r ? importButtonLabel(r.summary.new) : "Import units";
    if (!r) return;
    const notes = (r.warnings || []).filter(Boolean);
    box.append(...[
      h("div", { class: "imp-summary" },
        h("span", { class: "imp-summary-text", text: importSummaryText(r.summary) }),
        h("span", { class: "muted small", text: plural(r.summary.total, "row", "rows") }),
      ),
      notes.length ? h("ul", { class: "kv-list imp-notes" }, ...notes.map((n) => h("li", { text: n }))) : null,
      h("div", { class: "list-card imp-list", role: "list", "aria-label": "Import preview" }, ...r.rows.map(importRow)),
    ].filter(Boolean));
  }
  async function runImport(dryRun) {
    const text = dryRun ? els.importText.value : imp.previewText;
    if (!text || !text.trim()) {
      showImportError("Paste rows or choose a CSV file first.");
      return;
    }
    if (imp.busy) return;
    imp.busy = true;
    showImportError("");
    const btn = dryRun ? els.btnImportPreview : els.btnImportRun;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    try {
      const res = await apiJson("/api/units/import", { method: "POST", json: { text, dryRun } });
      if (dryRun) {
        imp.previewText = text;
        imp.result = res;
      } else {
        const n = res && res.summary ? res.summary.created : 0;
        imp.previewText = null;
        imp.result = null;
        els.importText.value = "";
        els.importFileName.hidden = true;
        toast(n ? `Imported ${plural(n, "unit", "units")}` : "Nothing new to import");
        closeSheets();
        loadUnits();
      }
    } catch (e) {
      showImportError(e.code === "network" ? "Can't reach the server — import needs a connection." : e.message);
    } finally {
      imp.busy = false;
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      renderImportPreview();
      if (dryRun && imp.result) {
        const first = els.importPreview.querySelector(".imp-summary");
        if (first) first.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
      }
    }
  }
  els.importForm.addEventListener("submit", (e) => {
    e.preventDefault();
    runImport(true);
  });
  els.btnImportRun.addEventListener("click", () => runImport(false));
  els.importText.addEventListener("input", () => {
    showImportError("");
    if (imp.previewText !== null && els.importText.value !== imp.previewText) importInvalidate();
  });
  $("btn-import-template").addEventListener("click", async () => {
    const text = importTemplateText();
    try {
      await navigator.clipboard.writeText(text);
      toast("Template copied — paste it into a spreadsheet");
    } catch {
      if (!els.importText.value.trim()) {
        els.importText.value = text;
        importInvalidate();
        toast("Template added to the box");
      } else toast("Copy not available in this browser");
    }
  });
  $("btn-import-file").addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", async () => {
    const file = els.importFile.files && els.importFile.files[0];
    els.importFile.value = "";
    if (!file) return;
    if (file.size > 1024 * 1024) {
      showImportError("That file is larger than 1 MB — split it into smaller imports.");
      return;
    }
    try {
      els.importText.value = await file.text();
      els.importFileName.hidden = false;
      els.importFileName.textContent = `Loaded ${file.name}`;
      showImportError("");
      importInvalidate();
      runImport(true);
    } catch (e) {
      showImportError(`Could not read the file: ${e.message || e}`);
    }
  });

  /* ---------- decode corrections ---------- */
  const corr = { unitId: null, appDirty: false };
  for (const [value, label] of CORRECTION_FIELDS) els.cField.append(h("option", { value, text: label }));
  function correctionUnit(unitId) {
    const pu = state.panelUnit && state.panelUnit.unit.id === unitId ? state.panelUnit : null;
    return { unit: pu ? pu.unit : state.unitsById.get(unitId) || null, decoded: pu ? pu.decoded : null };
  }
  const CORRECTION_PLACEHOLDER = { manufacturer: "Trane", tonnage: "7.5", voltage: "460", phase: "3", refrigerant: "R-454B", manufacture_date: "2019-03", family: "Voyager", control_platform: "ReliaTel", fault_code: "Code 31 = pressure switch" };
  function syncCorrectionField() {
    const field = els.cField.value;
    const { unit, decoded } = correctionUnit(corr.unitId);
    if (!corr.appDirty) els.cApp.value = correctionPrefill(field, unit, decoded);
    els.cActual.placeholder = CORRECTION_PLACEHOLDER[field] ? `e.g. ${CORRECTION_PLACEHOLDER[field]}` : "From the nameplate";
    els.cActual.inputMode = field === "tonnage" || field === "phase" || field === "voltage" ? "decimal" : "text";
    const can = canApplyCorrection(field);
    els.cApply.disabled = !can;
    if (!can) els.cApply.checked = false;
    els.cApplyHint.hidden = can;
    $("c-apply-row").classList.toggle("disabled", !can);
  }
  function showCorrectSheet(unitId) {
    const { unit } = correctionUnit(unitId);
    if (corr.unitId !== unitId) {
      corr.unitId = unitId;
      els.correctForm.reset();
      corr.appDirty = false;
    }
    els.correctSub.textContent = `${unit ? `${unitLabel(unit)}: ` : ""}the assistant trusts your correction over the decoder for this unit.`;
    els.correctError.hidden = true;
    els.cActual.removeAttribute("aria-invalid");
    syncCorrectionField();
    showSheet(els.sheetCorrect);
  }
  els.cField.addEventListener("change", () => {
    corr.appDirty = false;
    syncCorrectionField();
  });
  els.cApp.addEventListener("input", () => {
    corr.appDirty = true;
  });
  els.cActual.addEventListener("input", () => {
    els.cActual.removeAttribute("aria-invalid");
    els.correctError.hidden = true;
  });
  els.correctForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const unitId = corr.unitId;
    const actual = els.cActual.value.trim();
    if (!actual) {
      els.cActual.setAttribute("aria-invalid", "true");
      els.correctError.hidden = false;
      els.correctError.textContent = "Enter what the nameplate actually says.";
      els.cActual.focus();
      return;
    }
    const field = els.cField.value;
    const apply = els.cApply.checked && canApplyCorrection(field);
    els.btnCorrectSave.disabled = true;
    try {
      await apiJson(`/api/units/${encodeURIComponent(unitId)}/corrections`, {
        method: "POST",
        json: { field, app_value: els.cApp.value.trim(), actual_value: actual, note: els.cNote.value.trim() || undefined, apply },
      });
      corr.unitId = null;
      toast(apply ? "Correction saved — unit updated" : "Correction saved");
      closeSheets();
      await loadUnitPanel(unitId, { quiet: true });
      if (apply) loadUnits();
    } catch (err) {
      els.correctError.hidden = false;
      els.correctError.textContent = err.message;
      if (err.status === 400) els.cActual.setAttribute("aria-invalid", "true");
    } finally {
      els.btnCorrectSave.disabled = false;
    }
  });
  function correctionItem(c, unitId) {
    const label = CORRECTION_FIELD_LABEL[c.field] || c.field;
    const del = async () => {
      if (!confirm(`Delete this ${label.toLowerCase()} correction?`)) return;
      try {
        await apiJson(`/api/corrections/${encodeURIComponent(c.id)}`, { method: "DELETE" });
        toast("Correction deleted");
        loadUnitPanel(unitId, { quiet: true });
      } catch (e) {
        toast(`${e.code}: ${e.message}`);
      }
    };
    return h("div", { class: "corr-item", role: "listitem" },
      h("div", { class: "corr-body" },
        h("div", { class: "corr-field" }, h("span", { text: label }),
          c.applied ? h("span", { class: "chip chip-accent", text: "Applied" }) : null,
          c.status === "exported" ? h("span", { class: "chip chip-outline", text: "Exported" }) : null),
        h("div", { class: "corr-change" },
          h("span", { class: "corr-old", text: c.app_value || "not shown", title: c.app_value ? `App said ${c.app_value}` : "App showed nothing" }),
          h("span", { class: "corr-arrow", "aria-label": "corrected to", text: "→" }),
          h("span", { class: "corr-new", text: c.actual_value, title: `Actually ${c.actual_value}` })),
        c.note ? h("div", { class: "corr-note", text: c.note }) : null,
        h("div", { class: "corr-date" }, h("time", { datetime: c.created_at, title: new Date(c.created_at).toLocaleString(), text: relTime(c.created_at) })),
      ),
      h("button", { class: "icon-btn", type: "button", "aria-label": `Delete ${label} correction`, onclick: del }, icon("trash")),
    );
  }
  function buildCorrectionsCard(list, unitId) {
    const card = h("div", { class: "card corr-card" }, h("div", { class: "card-title" }, h("span", { text: `Corrections (${list.length})` }),
      h("button", { class: "text-btn", type: "button", text: "Add", onclick: () => navigate(`#unit/${unitId}/correct`) })));
    card.append(
      h("p", { class: "hint corr-hint", text: "The assistant trusts these over the decoder for this unit." }),
      h("div", { class: "corr-list", role: "list" }, ...list.map((c) => correctionItem(c, unitId))),
    );
    return card;
  }

  /* settings: export corrections */
  async function loadCorrectionsCount() {
    try {
      const all = pickList(await apiJson("/api/corrections"), "corrections");
      const open = all.filter((c) => c.status === "open").length;
      const exported = all.length - open;
      els.correctionsCount.textContent = all.length
        ? [plural(open, "open correction", "open corrections"), exported ? `${exported} exported` : ""].filter(Boolean).join(" · ")
        : "No corrections yet. Use “Report a wrong detail” on a unit.";
      els.btnCorrectionsExport.disabled = !all.length;
    } catch (e) {
      els.correctionsCount.textContent = e.code === "auth" ? "Enter the access password to see corrections." : `Couldn't load corrections: ${e.message}`;
      els.btnCorrectionsExport.disabled = true;
    }
  }
  const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  els.btnCorrectionsExport.addEventListener("click", async () => {
    const btn = els.btnCorrectionsExport;
    btn.disabled = true;
    try {
      const res = await api("/api/corrections/export", { method: "POST", json: {} });
      if (!res.ok) throw await readError(res);
      const name = correctionsExportFilename(res.headers.get("content-disposition"));
      const blob = new Blob([await res.blob()], { type: "application/json" });
      let done = false;
      let outcome = "saved";
      if (isIOS()) {
        // iOS ignores <a download> in some contexts (installed PWA); prefer the share sheet, else open the JSON in a tab.
        const file = typeof File === "function" ? new File([blob], name, { type: "application/json" }) : null;
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: name });
            done = true;
          } catch (err) {
            if (err && err.name === "AbortError") {
              done = true;
              outcome = "cancelled";
            }
          }
        }
        if (!done) {
          const url = URL.createObjectURL(blob);
          window.open(url, "_blank") || (location.href = url);
          setTimeout(() => URL.revokeObjectURL(url), 60000);
          done = true;
        }
      } else {
        const url = URL.createObjectURL(blob);
        const a = h("a", { href: url, download: name });
        doc.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      toast(correctionsExportToast(outcome, name));
    } catch (e) {
      toast(`Export failed: ${e.message}`);
    } finally {
      loadCorrectionsCount();
    }
  });

  /* ---------- decode sheet ---------- */
  function unitFormValues() {
    const fd = new FormData(els.unitForm);
    const v = {};
    for (const [k, val] of fd.entries()) v[k] = String(val).trim();
    return v;
  }
  function fillUnitForm(u) {
    const f = els.unitForm.elements;
    f.manufacturer.value = (u && (u.manufacturer || u.brand)) || "";
    f.model.value = (u && u.model) || "";
    f.serial.value = (u && u.serial) || "";
    f.unit_tag.value = (u && u.unit_tag) || "";
    f.nickname.value = (u && u.nickname) || "";
    f.site.value = (u && u.site) || "";
    f.customer.value = (u && u.customer) || "";
    f.elevation_ft.value = u && u.elevation_ft !== null && u.elevation_ft !== undefined ? String(u.elevation_ft) : "";
  }
  function showUnitFormError(msg) {
    els.unitFormError.hidden = !msg;
    els.unitFormError.textContent = msg || "";
  }
  function showDecodeSheet(unitId) {
    const editing = unitId && state.panelUnit && state.panelUnit.unit.id === unitId ? state.panelUnit.unit : unitId ? state.unitsById.get(unitId) : null;
    state.editingUnitId = editing ? editing.id : null;
    els.decodeTitle.textContent = editing ? `Edit ${unitLabel(editing)}` : "Decode a nameplate";
    els.btnSaveUnit.textContent = editing ? "Save changes" : "Save unit";
    els.btnDecodePhoto.hidden = !!editing;
    fillUnitForm(editing);
    showUnitFormError("");
    els.decodeCard.hidden = true;
    els.decodeCard.textContent = "";
    state.decoded = editing && state.panelUnit && state.panelUnit.decoded ? state.panelUnit.decoded : null;
    if (state.decoded) renderDecodePreview(state.decoded);
    updateSaveLabel();
    showSheet(els.sheetDecode);
  }
  $("btn-unit-add").addEventListener("click", () => navigate("#units/decode"));
  $("btn-unit-add-2").addEventListener("click", () => navigate("#units/decode"));
  els.btnDecodePhoto.addEventListener("click", () => {
    closeSheets();
    openCameraForDecode();
  });

  els.unitForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = unitFormValues();
    if (!v.model) return showUnitFormError("Enter the model number to decode.");
    showUnitFormError("");
    els.btnDecode.disabled = true;
    try {
      const body = { model: v.model };
      if (v.serial) body.serial = v.serial;
      if (v.manufacturer) body.manufacturer = v.manufacturer;
      const decoded = await apiJson("/api/decode", { method: "POST", json: body });
      state.decoded = decoded;
      renderDecodePreview(decoded);
    } catch (err) {
      showUnitFormError(`${err.code}: ${err.message}`);
    } finally {
      els.btnDecode.disabled = false;
    }
  });

  function renderDecodePreview(d) {
    els.decodeCard.hidden = false;
    els.decodeCard.textContent = "";
    els.decodeCard.append(renderDecodeCard(d, { compact: true }));
    els.decodeCard.scrollIntoView({ block: "start", behavior: scrollBehavior() });
    updateSaveLabel();
  }
  /** "Save unit" becomes "Save RTU-7" once a tag is typed, so the sticky footer says what it will do. */
  function updateSaveLabel() {
    const tag = els.uTag.value.trim();
    els.btnSaveUnit.textContent = state.editingUnitId ? "Save changes" : tag ? `Save ${tag.slice(0, 14)}` : "Save unit";
  }
  els.uTag.addEventListener("input", updateSaveLabel);

  els.btnSaveUnit.addEventListener("click", async () => {
    const v = unitFormValues();
    if (!v.model && !v.unit_tag && !v.nickname) return showUnitFormError("Enter at least a model, unit tag or nickname.");
    showUnitFormError("");
    const body = {};
    for (const k of ["model", "serial", "manufacturer", "unit_tag", "nickname", "site", "customer"]) if (v[k]) body[k] = v[k];
    const elev = toNum(v.elevation_ft);
    if (elev !== undefined) body.elevation_ft = elev;
    els.btnSaveUnit.disabled = true;
    try {
      let unit;
      if (state.editingUnitId) {
        for (const k of ["model", "serial", "manufacturer", "unit_tag", "nickname", "site", "customer"]) if (!v[k]) body[k] = null;
        if (elev === undefined) body.elevation_ft = null;
        const saved = await apiJson(`/api/units/${encodeURIComponent(state.editingUnitId)}`, { method: "PATCH", json: body });
        unit = saved && saved.unit ? saved.unit : saved;
        toast("Unit updated");
      } else {
        const saved = await apiJson("/api/units", { method: "POST", json: body });
        unit = saved && saved.unit ? saved.unit : saved;
        toast(saved && saved.existing ? "Unit already on file — opened" : "Unit saved");
      }
      state.panelUnit = null;
      await loadUnits();
      if (unit && unit.id) navigate(`#unit/${unit.id}`, { replace: true });
      else navigate("#units", { replace: true });
    } catch (err) {
      showUnitFormError(`${err.code}: ${err.message}`);
    } finally {
      els.btnSaveUnit.disabled = false;
    }
  });

  /** Decode result → DOM. compact: preview inside the decode sheet; full: unit detail card. */
  function renderDecodeCard(d, { compact }) {
    const frag = doc.createDocumentFragment();
    const bestModel = d.model && d.model[0];
    const bestSerial = d.serial && d.serial[0];
    const mfr = (d.manufacturerCandidates && d.manufacturerCandidates[0] && d.manufacturerCandidates[0].manufacturer) || d.input?.manufacturer || "Unknown manufacturer";

    if (compact) {
      frag.append(
        h("div", { class: "np-tag", text: mfr }),
        h("div", { class: "np-family", style: "font-weight:700;color:var(--text-primary)", text: bestModel ? bestModel.family : d.input?.model || "" }),
        h("div", { class: "muted small", text: bestModel ? String(bestModel.productType || "").replace(/_/g, " ") : "No model format matched" }),
      );
    }
    const chips = h("div", { class: "chip-row", style: "margin:10px 0" }, confChip("Model", bestModel), confChip("Serial", bestSerial));
    if (needsNameplateVerify(d)) chips.append(h("span", { class: "chip chip-warn" }, icon("alert", "icon"), "Verify on nameplate"));
    // The unit detail's nameplate card already shows these chips; only the sheet preview (and a no-match card) repeats them.
    if (compact || !bestModel) frag.append(chips);

    if (d.summary) {
      const para = h("p", { class: `dc-summary${d.summary.length > 220 ? " clamped" : ""}`, text: d.summary });
      const wrap = h("div", { class: "dc-summary-wrap" }, para);
      if (d.summary.length > 220) {
        const more = h("button", { class: "text-btn", type: "button", text: "Show more", "aria-expanded": "false", onclick: () => {
          const open = para.classList.toggle("clamped");
          more.textContent = open ? "Show more" : "Show less";
          more.setAttribute("aria-expanded", open ? "false" : "true");
        } });
        wrap.append(more);
      }
      frag.append(wrap);
    }

    const rows = [];
    if (bestModel && bestModel.attributes) {
      for (const [k, v] of Object.entries(bestModel.attributes)) if (v) rows.push([ATTR_LABEL[k] || k, k === "tonnage" ? `${v} ton` : v]);
      if (bestModel.refrigerant && !bestModel.attributes.refrigerant) rows.push(["Refrigerant (family default)", bestModel.refrigerant]);
      if (bestModel.equivalentFamilies && bestModel.equivalentFamilies.length) rows.push(["Equivalent families", bestModel.equivalentFamilies.join(", ")]);
    }
    if (bestSerial) {
      if (bestSerial.manufactureDate) rows.push(["Manufactured", `${bestSerial.manufactureDate}${bestSerial.ageYears !== undefined ? ` (${fmtNum(bestSerial.ageYears)} yr)` : ""}`]);
      if (bestSerial.ambiguous && bestSerial.candidateYears) rows.push(["Candidate years", bestSerial.candidateYears.join(" or ")]);
      if (bestSerial.plant) rows.push(["Plant", bestSerial.plant]);
    }
    if (rows.length) {
      frag.append(h("div", { class: "attr-grid", style: "margin-top:12px" }, ...rows.map(([k, v]) => attr(k, v))));
    }

    if (d.warnings && d.warnings.length) {
      frag.append(h("div", { class: "dc-warn", style: "margin-top:12px" }, h("ul", null, ...d.warnings.map((w) => h("li", { text: w })))));
    }

    const details = h("div", { style: "margin-top:12px" });
    if (bestModel && bestModel.segments && bestModel.segments.length) {
      details.append(h("details", { class: "disclosure" }, h("summary", { text: `Nomenclature breakdown (${bestModel.segments.length})` }),
        h("div", { class: "disclosure-body" }, h("table", { class: "attr-table" }, h("tbody", null, ...bestModel.segments.map((s) => h("tr", null, h("th", { scope: "row", text: `${s.name} · ${s.code}` }), h("td", { text: s.meaning || "—" }))))))));
    }
    if (d.controls && d.controls.length) {
      details.append(h("details", { class: "disclosure", open: !compact }, h("summary", { text: `Control platforms (${d.controls.length})` }),
        h("div", { class: "disclosure-body" }, ...d.controls.map((c) => h("div", { class: "platform" }, h("span", { text: c.name }), h("span", { class: `chip ${c.coverage === "complete" ? "chip-ok" : ""}`, text: `${(c.faultCodes || []).length} codes${c.coverage ? ` · ${c.coverage}` : ""}` }))))));
    }
    const notes = [].concat(bestSerial?.notes || [], bestModel?.notes || []);
    if (notes.length) details.append(h("details", { class: "disclosure" }, h("summary", { text: "Decoder notes" }), h("div", { class: "disclosure-body" }, h("ul", { class: "dc-list" }, ...notes.map((n) => h("li", { text: n }))))));
    if (d.commonIssues && d.commonIssues.length) {
      details.append(h("details", { class: "disclosure" }, h("summary", { text: `Known issues (${d.commonIssues.length})` }),
        h("div", { class: "disclosure-body" }, h("ul", { class: "dc-list" }, ...d.commonIssues.map((ci) => h("li", null, h("b", { text: ci.symptom }), ` — ${(ci.likelyCauses || []).join("; ")}`))))));
    }
    if (d.electrical && d.electrical.length && !compact) {
      details.append(h("details", { class: "disclosure" }, h("summary", { text: "Electrical (designators, safeties)" }),
        h("div", { class: "disclosure-body" }, ...d.electrical.map((fe) => h("div", null,
          h("div", { class: "form-subhead", text: `${fe.familyLabel}${fe.controlVoltage ? ` · ${fe.controlVoltage}` : ""}` }),
          h("table", { class: "attr-table" }, h("tbody", null, ...(fe.components || []).map((c) => h("tr", null, h("th", { scope: "row", text: c.designator }), h("td", { text: `${c.name}${c.notes ? ` — ${c.notes}` : ""}` }))))),
          fe.safetyDevices && fe.safetyDevices.length ? h("p", { class: "dc-summary", style: "margin-top:8px", text: `Safeties: ${fe.safetyDevices.join(", ")}` }) : null,
        )))));
    }
    if (d.evidenceSummary) details.append(h("details", { class: "disclosure" }, h("summary", { text: "Evidence and sources" }), h("div", { class: "disclosure-body" }, h("p", { class: "dc-summary small", text: d.evidenceSummary }))));
    if (details.childElementCount) frag.append(details);

    const litUrl = d.support && (d.support.literatureUrl || d.support.url);
    const support = h("div", { class: "btn-row", style: "margin-top:12px" });
    if (litUrl && /^https?:\/\//i.test(litUrl)) support.append(h("a", { class: "btn", href: litUrl, target: "_blank", rel: "noopener noreferrer" }, icon("book"), "Literature"));
    let phoneNote = "";
    if (d.support && d.support.phone) {
      const m = /\+?\d[\d\s().-]{6,}\d/.exec(d.support.phone);
      const number = m ? m[0].trim() : d.support.phone;
      phoneNote = m ? d.support.phone.replace(m[0], "").replace(/^[\s(,:-]+|[\s),]+$/g, "").trim() : "";
      support.append(h("a", { class: "btn", href: `tel:${number.replace(/[^\d+]/g, "")}` }, icon("phone"), `Call ${number}`));
    }
    if (support.childElementCount) frag.append(support);
    if (phoneNote) frag.append(h("p", { class: "hint", text: `Support line: ${phoneNote}` }));
    if (d.support && d.support.literatureSearchHint) frag.append(h("p", { class: "hint", text: d.support.literatureSearchHint }));
    return frag;
  }

  /* ---------- history: search ---------- */
  /** FTS snippet → nodes: "[term]" markers become <mark>, markdown table pipes and emphasis are flattened. */
  function snippetNodes(snippet) {
    const cleaned = String(snippet || "").replace(/\s*\|\s*/g, " · ").replace(/(^|\s)[#>*_`-]+(?=\s|$)/g, "$1").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
    return cleaned.split(/(\[[^\]]+\])/).filter(Boolean).map((p) => (/^\[[^\]]+\]$/.test(p) ? h("mark", { text: p.slice(1, -1) }) : p));
  }
  function searchHitRow(hit, { compact }) {
    const kindLabel = hit.kind === "unit" ? "Unit" : hit.kind === "finding" ? "Finding" : "Message";
    const leadCls = hit.kind === "finding" ? "ok" : hit.kind === "unit" ? "info" : "";
    return listRow(h("button", { class: "row", type: "button", onclick: () => openSearchHit(hit) },
      compact ? null : h("div", { class: `row-lead ${leadCls}` }, icon(hit.kind === "unit" ? "units" : hit.kind === "finding" ? "finding" : "chat")),
      h("div", { class: "row-body" },
        h("div", { class: "row-sub" }, h("span", { class: "chip", text: kindLabel }), h("span", { text: relTime(hit.createdAt) })),
        h("div", { class: "snippet" }, ...snippetNodes(hit.snippet)),
      ),
      compact ? null : icon("chevron", "icon icon-sm row-chevron"),
    ));
  }
  function renderSearchHits(target, hits, q, { compact = false } = {}) {
    target.textContent = "";
    if (!hits.length) {
      target.append(h("div", { class: "empty" }, h("div", { class: "empty-icon" }, icon("search")), h("div", { class: "empty-title", text: "No matches" }), h("p", { class: "empty-sub", text: `Nothing in conversations, findings or units matches “${q}”.` })));
      return;
    }
    for (const g of groupSearchHits(hits, state.unitsById)) {
      const card = h("div", { class: compact ? "list" : "list-card", role: "list", style: compact ? "" : "margin-bottom:12px" });
      const headIcon = g.kind === "conversation" ? "chat" : g.kind === "unit" ? "units" : "search";
      card.append(h("div", { class: "group-head" }, icon(headIcon, "icon icon-sm"), h("span", { text: g.title }), h("span", { class: "muted", text: `${g.hits.length} hit${g.hits.length === 1 ? "" : "s"}` })));
      for (const hit of g.hits) card.append(searchHitRow(hit, { compact }));
      target.append(card);
    }
  }
  /** Debounced FTS search bound to an input; results replace `browse` inside the same scroller. */
  function bindSearch({ input, clear, results, browse, compact }) {
    let timer = null;
    let seq = 0;
    const reset = () => {
      results.hidden = true;
      results.textContent = "";
      browse.hidden = false;
    };
    const run = async (q) => {
      const mine = ++seq;
      results.hidden = false;
      browse.hidden = true;
      results.textContent = "";
      results.append(h("div", { class: "skeleton" }), h("div", { class: "skeleton" }));
      try {
        const json = await apiJson(`/api/search?q=${encodeURIComponent(q)}&limit=30`);
        if (mine !== seq) return;
        renderSearchHits(results, pickList(json, "hits"), q, { compact });
      } catch (e) {
        if (mine !== seq) return;
        results.textContent = "";
        results.append(h("div", { class: "field-error", role: "alert", text: `Search failed: ${e.message}` }));
      }
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      clear.hidden = !q;
      if (q.length < 2) return reset();
      timer = setTimeout(() => run(q), 250);
      return undefined;
    });
    clear.addEventListener("click", () => {
      input.value = "";
      input.dispatchEvent(new Event("input"));
      input.focus();
    });
  }
  bindSearch({ input: els.search, clear: els.btnSearchClear, results: els.searchResults, browse: els.historyBrowse, compact: false });
  bindSearch({ input: els.searchSide, clear: els.btnSearchSideClear, results: els.searchResultsSide, browse: els.convBrowseSide, compact: true });
  function openSearchHit(hit) {
    if (hit.kind === "message" && hit.conversationId) return navigate(`#chat/${hit.conversationId}`);
    if (hit.kind === "unit") return navigate(`#unit/${hit.id}`);
    if (hit.kind === "finding") {
      if (hit.unitId) return navigate(`#unit/${hit.unitId}`);
      if (hit.conversationId) return navigate(`#chat/${hit.conversationId}`);
    }
    return undefined;
  }

  /* ---------- readings ---------- */
  function renderReadingsUnitChip() {
    const u = readingsTargetUnit();
    els.readingsUnitChip.hidden = !u;
    els.readingsUnitChip.textContent = u ? unitLabel(u) : "";
    els.readingsSub.textContent = "";
    if (u) els.readingsSub.append(h("span", { text: `${[u.manufacturer, u.model].filter(Boolean).join(" ")} · ${u.refrigerant || "refrigerant?"}` }));
    renderReadingsSaveButton();
  }
  function prefillReadingsFromUnit(u, { force = false } = {}) {
    const f = els.readingsForm.elements;
    if (u.refrigerant && (force || !f.refrigerant.dataset.touched)) setSelectValue(f.refrigerant, u.refrigerant);
    if (u.metering_device && ["txv", "fixed", "eev", "unknown"].includes(u.metering_device)) {
      const radio = els.readingsForm.querySelector(`input[name="meteringDevice"][value="${u.metering_device}"]`);
      if (radio) radio.checked = true;
    }
    if (u.elevation_ft !== null && u.elevation_ft !== undefined && (force || !f.elevationFt.value)) f.elevationFt.value = String(u.elevation_ft);
    for (const el of doc.querySelectorAll(".elevation-input")) if ((force || !el.value) && u.elevation_ft !== null && u.elevation_ft !== undefined) el.value = String(u.elevation_ft);
    for (const sel of doc.querySelectorAll("#calculators .refrigerant-select")) if (u.refrigerant && (force || !sel.dataset.touched)) setSelectValue(sel, u.refrigerant);
  }
  function setSelectValue(sel, value) {
    const norm = String(value).replace(/[\s-]/g, "").toUpperCase();
    for (const o of sel.options) {
      if (o.value.replace(/[\s-]/g, "").toUpperCase() === norm) {
        sel.value = o.value;
        return;
      }
    }
    sel.append(h("option", { value, text: value }));
    sel.value = value;
  }
  for (const sel of doc.querySelectorAll(".refrigerant-select")) sel.addEventListener("change", () => { sel.dataset.touched = "1"; });
  function readingsValues() {
    const fd = new FormData(els.readingsForm);
    const v = {};
    for (const [k, val] of fd.entries()) v[k] = String(val);
    return v;
  }
  doc.querySelectorAll('input[name="readings-pane"]').forEach((r) => r.addEventListener("change", () => navigate(r.value === "calcs" ? "#readings/calcs" : "#readings", { replace: true })));
  els.btnReadingsClear.addEventListener("click", () => {
    if (state.route.pane === "calcs") {
      for (const form of doc.querySelectorAll("#calculators form")) {
        form.reset();
        const box = form.querySelector(".calc-result");
        box.hidden = true;
        box.textContent = "";
        form.querySelector(".btn-send").disabled = true;
      }
      populateRefrigerantSelects();
      toast("Calculators cleared");
      return;
    }
    els.readingsForm.reset();
    populateRefrigerantSelects();
    els.readingsResult.hidden = true;
    els.readingsResult.textContent = "";
    els.readingsError.hidden = true;
    state.lastDx = null;
    if (state.unit) prefillReadingsFromUnit(state.unit, { force: true });
    toast("Readings cleared");
  });

  els.readingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const m = buildMeasurements(readingsValues());
    els.readingsError.hidden = true;
    if (!m.refrigerant) {
      els.readingsError.hidden = false;
      els.readingsError.textContent = "Pick a refrigerant.";
      return;
    }
    if (m.suctionPsig === undefined && m.liquidPsig === undefined && m.outdoorDbF === undefined && m.compressorAmps === undefined && m.supplyDbF === undefined) {
      els.readingsError.hidden = false;
      els.readingsError.textContent = "Enter at least one reading — suction/liquid pressure with line temps gives the most.";
      return;
    }
    const btn = $("btn-diagnose");
    btn.disabled = true;
    els.readingsResult.hidden = false;
    els.readingsResult.textContent = "";
    els.readingsResult.append(h("div", { class: "skeleton" }), h("div", { class: "skeleton", style: "min-height:120px" }));
    try {
      const result = await apiJson("/api/calc/diagnose", { method: "POST", json: m });
      state.lastDx = result;
      renderDxResult(result);
      requestWake();
    } catch (err) {
      els.readingsResult.hidden = true;
      els.readingsResult.textContent = "";
      els.readingsError.hidden = false;
      els.readingsError.textContent = isNetworkError(err)
        ? "Diagnosis needs a connection. The superheat/subcooling and electrical calculators still work offline."
        : `${err.code}: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  const SEV_CLASS = { critical: "chip-danger", warning: "chip-warn", advisory: "chip-info", info: "" };
  const DERIVED_LABEL = {
    evapSatF: ["Evap sat", "°F"], condSatF: ["Cond sat", "°F"], superheatF: ["Superheat", "°F"], subcoolingF: ["Subcooling", "°F"],
    targetSuperheatF: ["Target SH", "°F"], targetSubcoolingF: ["Target SC", "°F"], condenserSplitF: ["Cond split", "°F"], evapTdF: ["Evap TD", "°F"],
    deltaTF: ["Delta-T", "°F"], indoorCoilTdF: ["Indoor coil TD", "°F"], compressionRatio: ["Comp. ratio", ""], dischargeSuperheatF: ["Discharge SH", "°F"],
    ampsPercentRla: ["Amps % RLA", "%"], currentImbalancePercent: ["Amp imbalance", "%"], drierTempDropF: ["Drier drop", "°F"], standingExcessPsi: ["Standing excess", "psi"], patmPsia: ["Patm", "psia"],
  };
  const DERIVED_ORDER = ["superheatF", "targetSuperheatF", "subcoolingF", "targetSubcoolingF", "evapSatF", "condSatF", "deltaTF", "targetDeltaTF", "condenserSplitF", "evapTdF", "indoorCoilTdF", "compressionRatio", "dischargeSuperheatF", "ampsPercentRla", "currentImbalancePercent", "drierTempDropF", "standingExcessPsi", "patmPsia"];

  function statTile(label, value, unit, cls = "") {
    return h("div", { class: `stat ${cls}` }, h("div", { class: "stat-label", text: label }), h("div", { class: "stat-value" }, value, unit ? h("small", { text: unit }) : null));
  }
  function derivedStats(derived) {
    const tiles = [];
    for (const k of DERIVED_ORDER) {
      const v = derived[k];
      if (k === "targetDeltaTF") {
        if (v && typeof v === "object") tiles.push(statTile("Target ΔT", `${v.min}–${v.max}`, "°F"));
        continue;
      }
      if (typeof v !== "number" || !DERIVED_LABEL[k]) continue;
      const [label, unit] = DERIVED_LABEL[k];
      let cls = "";
      if (k === "superheatF" && typeof derived.targetSuperheatF === "number") cls = v - derived.targetSuperheatF > 5 ? "hi" : derived.targetSuperheatF - v > 5 ? "lo" : "";
      if (k === "subcoolingF" && typeof derived.targetSubcoolingF === "number") cls = v - derived.targetSubcoolingF > 4 ? "hi" : derived.targetSubcoolingF - v > 4 ? "lo" : "";
      tiles.push(statTile(cls === "hi" ? `${label} · high` : cls === "lo" ? `${label} · low` : label, fmtNum(v, k === "compressionRatio" ? 2 : 1), unit, cls));
    }
    return tiles;
  }

  function renderDxResult(r) {
    const box = els.readingsResult;
    box.hidden = false;
    box.textContent = "";
    box.append(h("div", { class: "card-title" }, h("span", { text: "Diagnosis" }), r.readingId ? h("span", { class: "chip chip-ok" }, icon("check", "icon"), "Saved to unit") : r.source && r.source !== "server" ? sourceTag(r.source) : null));
    const ok = !r.validity || r.validity.ok;
    const val = h("div", { class: `validity ${ok ? "ok" : "bad"}` }, icon(ok ? "ok" : "alert"), h("div", null, h("div", { text: ok ? "Readings valid for charge determination" : "Readings not valid for charge determination" })));
    if (!ok && r.validity.issues && r.validity.issues.length) val.lastChild.append(h("ul", null, ...r.validity.issues.map((i) => h("li", { text: i }))));
    box.append(val);
    const tiles = derivedStats(r.derived || {});
    if (tiles.length) box.append(h("div", { class: "stats" }, ...tiles));
    if (r.summary) box.append(h("p", { class: "dx-summary", text: r.summary }));
    if (r.findings && r.findings.length) {
      box.append(h("div", { class: "section-title", text: `Findings (${r.findings.length})` }));
      for (const f of r.findings) {
        const card = h("div", { class: `dx-finding ${f.severity || "info"}` },
          h("div", { class: "dx-finding-head" }, h("span", { class: `chip ${SEV_CLASS[f.severity] || ""}`, text: f.severity }), h("span", { class: `chip ${CONF_CLASS[f.confidence] || ""}`, text: `${f.confidence} confidence` }), h("div", { class: "dx-finding-title", text: f.condition })),
          h("p", { text: f.explanation }),
        );
        if (f.nextChecks && f.nextChecks.length) card.append(h("ul", null, ...f.nextChecks.map((c) => h("li", { text: c }))));
        if (f.safety && f.safety.length) card.append(h("div", { class: "dx-safety", text: f.safety.join(" ") }));
        box.append(card);
      }
    }
    if (r.missing && r.missing.length) {
      box.append(h("div", { class: "section-title", text: "Would sharpen the diagnosis" }), h("ul", { class: "dc-list" }, ...r.missing.map((m) => h("li", { text: m }))));
    }
    box.append(h("div", { class: "btn-row", style: "margin-top:8px" },
      h("button", { class: "btn btn-primary grow", type: "button", onclick: () => sendReadingsToChat(true) }, icon("send"), "Send to chat"),
      r.readingId ? null : h("button", { class: "btn grow", type: "button", onclick: () => saveReadingToUnit() }, icon("units"), readingsTargetUnit() ? `Save to ${unitLabel(readingsTargetUnit())}` : "Save to unit"),
    ));
    if (!isTwoColDx()) box.scrollIntoView({ block: "start", behavior: scrollBehavior() });
  }

  function sendReadingsToChat(withResult) {
    const m = buildMeasurements(readingsValues());
    let text = composeReadingsMessage(m, withResult && state.lastDx ? state.lastDx.derived : null);
    if (withResult && state.lastDx && state.lastDx.summary) text += `\nDiagnose result: ${state.lastDx.summary}`;
    insertIntoComposer(text);
  }
  els.btnReadingsSend.addEventListener("click", () => sendReadingsToChat(false));

  /* ---------- calculators ---------- */
  function sourceTag(source) {
    const map = { server: ["server", "From the server"], device: ["device", "Computed on this device (offline)"], cache: ["clock", "From the on-device cache"] };
    const [ic, label] = map[source] || map.server;
    return h("span", { class: "source-tag" }, icon(ic, "icon"), label);
  }
  const VALUE_LABEL = {
    average: "Average", maxDeviation: "Max deviation", imbalancePercent: "Imbalance %", derateFactor: "NEMA derate factor", worstLeg: "Worst leg",
    microfarads: "Measured µF", percentOfRated: "% of rated", deviationPercent: "Deviation %", pass: "Pass", outputBtuh: "Output BTU/h", cfm: "CFM",
    r1: "R1 Ω", r2: "R2 Ω", r3: "R3 Ω", openCount: "Open readings", shortCount: "Shorted readings", csPlusCr: "C-S + C-R", sumErrorPercent: "Sum error %",
    rhPercent: "Relative humidity %", dewPointF: "Dew point °F", enthalpyBtuLb: "Enthalpy BTU/lb", grainsPerLb: "Grains/lb", humidityRatio: "Humidity ratio",
    evapSatF: "Evap sat °F", condSatF: "Cond sat °F", superheatF: "Superheat °F", subcoolingF: "Subcooling °F", targetSuperheatF: "Target SH °F", targetSubcoolingF: "Target SC °F",
    superheatDelta: "SH vs target", subcoolingDelta: "SC vs target", patmPsia: "Patm psia", safetyClass: "Safety class", inHgVacuum: "Vacuum inHg", glideF: "Glide °F",
  };
  function renderCalcResult(kind, result) {
    const frag = doc.createDocumentFragment();
    const source = result && result.source ? result.source : "server";
    frag.append(h("div", { class: "card-title" }, h("span", { text: "Result" }), source !== "server" ? sourceTag(source) : null));
    if (kind === "pt") {
      const tiles = [];
      if (typeof result.bubbleTempF === "number") tiles.push(statTile("Bubble (SC)", fmtNum(result.bubbleTempF), "°F"));
      if (typeof result.dewTempF === "number") tiles.push(statTile("Dew (SH)", fmtNum(result.dewTempF), "°F"));
      if (typeof result.midpointTempF === "number" && result.bubbleTempF !== result.dewTempF) tiles.push(statTile("Midpoint", fmtNum(result.midpointTempF), "°F"));
      if (typeof result.bubblePsig === "number") tiles.push(statTile("Bubble", fmtNum(result.bubblePsig), "psig"));
      if (typeof result.dewPsig === "number") tiles.push(statTile("Dew", fmtNum(result.dewPsig), "psig"));
      if (typeof result.inHgVacuum === "number") tiles.push(statTile("Vacuum", fmtNum(result.inHgVacuum), "inHg"));
      if (typeof result.glideF === "number" && result.glideF >= 0.5) tiles.push(statTile("Glide", fmtNum(result.glideF), "°F"));
      if (result.safetyClass) tiles.push(statTile("Safety class", result.safetyClass, ""));
      if (tiles.length) frag.append(h("div", { class: "stats" }, ...tiles));
    } else if (kind === "shsc") {
      const tiles = [];
      for (const k of ["superheatF", "targetSuperheatF", "subcoolingF", "targetSubcoolingF", "evapSatF", "condSatF", "patmPsia"]) {
        if (typeof result[k] === "number") tiles.push(statTile(VALUE_LABEL[k].replace(/ (°F|psia)$/, ""), fmtNum(result[k], k === "patmPsia" ? 2 : 1), k === "patmPsia" ? "psia" : "°F"));
      }
      if (result.safetyClass) tiles.push(statTile("Safety class", result.safetyClass, ""));
      if (tiles.length) frag.append(h("div", { class: "stats" }, ...tiles));
    } else {
      const values = result && result.values && typeof result.values === "object" ? result.values : {};
      const rows = Object.entries(values).filter(([, v]) => typeof v === "number" || typeof v === "string");
      if (rows.length) {
        frag.append(h("div", null, ...rows.map(([k, v]) => {
          const label = VALUE_LABEL[k] || k;
          const val = k === "pass" ? (v ? "PASS" : "FAIL") : typeof v === "number" ? fmtNum(v, 2) : String(v);
          return h("div", { class: "kv" }, h("span", { class: "kv-key", text: label }), h("span", { class: `kv-value${k === "pass" ? (v ? " chip chip-ok" : " chip chip-danger") : ""}`, text: val }));
        })));
      }
    }
    const lists = [["interpretation", ""], ["notes", ""], ["warnings", "kv-warn"]];
    for (const [key, cls] of lists) {
      const arr = Array.isArray(result[key]) ? result[key].filter((x) => typeof x === "string") : [];
      if (!arr.length) continue;
      if (key === "warnings") frag.append(h("div", { class: "dc-warn", style: "margin-top:10px" }, h("ul", null, ...arr.map((x) => h("li", { text: x })))));
      else frag.append(h("ul", { class: `kv-list ${cls}` }, ...arr.map((x) => h("li", { text: x }))));
    }
    return frag;
  }

  const CALC_TITLE = {
    pt: "PT lookup", shsc: "Superheat/subcooling", voltage_imbalance: "Voltage imbalance", capacitor_under_load: "Capacitor under load",
    temp_rise_cfm: "Temp-rise CFM", winding_check: "Winding check", psychrometrics: "Psychrometrics",
  };

  /** Offline saturation lookup for the SH/SC calculator, from cached PT answers. */
  function satFromCache(refrigerant) {
    return (psigSL) => {
      if (!CALC) return null;
      const r = CALC.ptLookupOffline(refrigerant, { psig: Math.round(psigSL * 10) / 10 });
      if (!r || typeof r.dewTempF !== "number") return null;
      return { bubbleF: r.bubbleTempF, dewF: r.dewTempF };
    };
  }

  for (const det of doc.querySelectorAll(".calc")) {
    const kind = det.dataset.calc;
    const form = det.querySelector("form");
    const resultBox = det.querySelector(".calc-result");
    const sendBtn = det.querySelector(".btn-send");
    let last = null;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const raw = {};
      for (const [k, v] of fd.entries()) raw[k] = String(v).trim();
      resultBox.hidden = false;
      resultBox.textContent = "";
      resultBox.append(h("div", { class: "skeleton" }));
      try {
        let result;
        if (kind === "pt") {
          const q = {};
          if (toNum(raw.psig) !== undefined) q.psig = toNum(raw.psig);
          else if (toNum(raw.temp_f) !== undefined) q.tempF = toNum(raw.temp_f);
          else throw new ApiFailure("validation", "Enter a pressure or a temperature.", 0);
          if (toNum(raw.elevation_ft) !== undefined) q.elevationFt = toNum(raw.elevation_ft);
          const qs = new URLSearchParams({ refrigerant: raw.refrigerant });
          if (q.psig !== undefined) qs.set("psig", String(q.psig));
          else qs.set("temp_f", String(q.tempF));
          if (q.elevationFt !== undefined) qs.set("elevation_ft", String(q.elevationFt));
          try {
            result = await apiJson(`/api/reference/pt?${qs}`);
            if (CALC) CALC.ptCachePut(raw.refrigerant, q, result);
          } catch (err) {
            if (!isNetworkError(err) || !CALC) throw err;
            result = CALC.ptLookupOffline(raw.refrigerant, q);
            if (!result) throw new ApiFailure("offline", "Offline and no cached PT point near this value. Run this lookup once while connected — the last 20 are kept on the device.", 0);
          }
        } else if (kind === "shsc") {
          const body = { refrigerant: raw.refrigerant, meteringDevice: "unknown", mode: "ac_cooling" };
          for (const k of ["suctionPsig", "suctionLineTempF", "liquidPsig", "liquidLineTempF", "elevationFt"]) {
            const n = toNum(raw[k]);
            if (n !== undefined) body[k] = n;
          }
          if (body.suctionPsig === undefined && body.liquidPsig === undefined) throw new ApiFailure("validation", "Enter suction and/or liquid pressure with its line temperature.", 0);
          try {
            result = await apiJson("/api/calc/superheat-subcooling", { method: "POST", json: body });
            if (CALC) CALC.calcCachePut(kind, raw, result);
          } catch (err) {
            if (!isNetworkError(err) || !CALC) throw err;
            result = CALC.calcCacheGet(kind, raw) || CALC.superheatSubcooling(body, satFromCache(raw.refrigerant));
          }
        } else {
          const body = { kind };
          for (const [k, v] of Object.entries(raw)) {
            if (k === "phase") body.phase = Number(v) === 3 ? 3 : 1;
            else {
              const n = toNum(v);
              if (n !== undefined) body[k] = n;
              else if (k !== "ratedUf" && k !== "elevationFt") throw new ApiFailure("validation", `Enter ${VALUE_LABEL[k] || k}.`, 0);
            }
          }
          try {
            result = await apiJson("/api/calc/electrical", { method: "POST", json: body });
            if (CALC) CALC.calcCachePut(kind, raw, result);
          } catch (err) {
            if (!isNetworkError(err) || !CALC) throw err;
            result = CALC.electrical(body) || CALC.calcCacheGet(kind, raw);
            if (!result) throw new ApiFailure("offline", "This calculator needs a connection (no cached result for these inputs).", 0);
          }
        }
        last = { inputs: raw, result };
        resultBox.textContent = "";
        resultBox.append(renderCalcResult(kind, result));
        sendBtn.disabled = false;
      } catch (err) {
        last = null;
        sendBtn.disabled = true;
        resultBox.textContent = "";
        resultBox.append(h("div", { class: "field-error", role: "alert", text: `${err.message}` }));
      }
    });
    sendBtn.addEventListener("click", () => {
      if (!last) return;
      insertIntoComposer(composeCalcMessage(CALC_TITLE[kind] || kind, last.inputs, last.result));
    });
  }

  /* ---------- refrigerant selects ---------- */
  function populateRefrigerantSelects() {
    for (const sel of doc.querySelectorAll(".refrigerant-select")) {
      const current = sel.value;
      sel.textContent = "";
      for (const id of state.refrigerants) sel.append(h("option", { value: id, text: id }));
      if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
      else sel.value = state.refrigerants.includes("R-410A") ? "R-410A" : state.refrigerants[0];
    }
  }
  async function loadRefrigerants() {
    try {
      const json = await apiJson("/api/reference/refrigerants");
      const list = pickList(json, "refrigerants", "meta");
      const ids = list.map((r) => (typeof r === "string" ? r : r && r.id)).filter(Boolean);
      if (ids.length) {
        state.refrigerants = ids;
        store.set("hvac.refrigerants", JSON.stringify(ids));
      }
    } catch {
      try {
        const cached = JSON.parse(store.get("hvac.refrigerants") || "null");
        if (Array.isArray(cached) && cached.length) state.refrigerants = cached;
      } catch {
        /* fallback list stays */
      }
    }
    populateRefrigerantSelects();
    if (state.unit) prefillReadingsFromUnit(state.unit);
  }

  /* ---------- desktop context panel (attached unit beside the chat, ≥ 1200 px) ---------- */
  function renderCtxPanel() {
    if (!hasCtxPanel()) return;
    const u = state.unit;
    els.ctxSub.textContent = "";
    if (!u) {
      state.ctx = null;
      els.btnCtxOpen.hidden = true;
      els.ctxBody.textContent = "";
      els.ctxBody.append(h("div", { class: "empty" },
        h("div", { class: "empty-icon" }, icon("units")),
        h("div", { class: "empty-title", text: state.conversation ? "No unit attached" : "Attach a unit" }),
        h("p", { class: "empty-sub", text: "Decode the nameplate or pick a saved unit — its readings, findings and prior jobs then stay in view while you chat." }),
        h("button", { class: "btn btn-primary", type: "button", onclick: () => navigate("#units") }, icon("link"), "Pick a unit"),
        h("button", { class: "btn", type: "button", onclick: () => navigate("#units/decode") }, icon("scan"), "Decode a nameplate"),
      ));
      return;
    }
    els.btnCtxOpen.hidden = false;
    els.ctxSub.append(h("span", { class: "badge", text: unitBadgeText(u) }), h("span", { text: [u.site, u.customer].filter(Boolean).join(" · ") }));
    if (state.ctx && state.ctx.unit.id === u.id) {
      const c = state.ctx;
      els.ctxBody.textContent = "";
      els.ctxBody.append(buildPlate(c.unit, c.decoded, { attached: true, actions: false }));
      els.ctxBody.append(buildFindingsCard(c.findings, { onChanged: () => { state.ctx = null; renderCtxPanel(); }, unitId: c.unit.id }));
      els.ctxBody.append(h("div", { class: "btn-row", style: "margin-top:16px" },
        h("button", { class: "btn grow", type: "button", onclick: () => { prefillReadingsFromUnit(c.unit, { force: true }); navigate("#readings"); } }, icon("gauge"), "Readings"),
        h("button", { class: "btn grow", type: "button", onclick: () => navigate(`#unit/${c.unit.id}`) }, icon("units"), "Unit page"),
      ));
      return;
    }
    if (state.ctxLoading === u.id) return;
    state.ctxLoading = u.id;
    els.ctxBody.textContent = "";
    els.ctxBody.append(h("div", { class: "skeleton", style: "min-height:180px" }), h("div", { class: "skeleton" }));
    apiJson(`/api/units/${encodeURIComponent(u.id)}`).then((data) => {
      const unit = data.unit || data;
      let decoded = data.decoded || null;
      if (!decoded && unit.decoded_json) {
        try { decoded = JSON.parse(unit.decoded_json); } catch { decoded = null; }
      }
      state.ctx = { unit, decoded, findings: pickList(data.findings || [], "findings") };
    }).catch((e) => {
      els.ctxBody.textContent = "";
      els.ctxBody.append(h("div", { class: "list-empty", text: `Could not load the unit: ${e.message}` }));
    }).finally(() => {
      if (state.ctxLoading === u.id) state.ctxLoading = null;
      if (state.unit && state.unit.id === u.id && state.ctx) renderCtxPanel();
    });
  }
  els.btnCtxOpen.addEventListener("click", () => state.unit && navigate(`#unit/${state.unit.id}`));
  if (window.matchMedia) {
    try {
      window.matchMedia("(min-width: 1200px)").addEventListener("change", () => renderCtxPanel());
    } catch {
      /* older Safari */
    }
  }

  /* Tool chips (the lookups the assistant runs) are hidden unless "Show tool activity" is on. */
  function applyToolVisibility(on) {
    html.classList.toggle("hide-tools", !on);
    const box = $("show-tools");
    if (box) box.checked = !!on;
  }
  applyToolVisibility(store.get("hvac.showTools") === "1");
  $("show-tools").addEventListener("change", (e) => {
    const on = !!(e.target && e.target.checked);
    store.set("hvac.showTools", on ? "1" : null);
    applyToolVisibility(on);
  });

  /* ---------- settings ---------- */
  function fillSettings() {
    $("s-apibase").value = store.get("hvac.apiBase") || "";
    $("s-token").value = store.get("hvac.token") || "";
    applyTheme(store.get("hvac.theme"));
    applyToolVisibility(store.get("hvac.showTools") === "1");
    renderInstallState();
    renderOfflineInfo();
    if (noServerConfigured()) {
      renderNoServer();
      return;
    }
    loadMe();
    if (!isTester()) {
      loadAiSettings();
      loadUsage();
      loadCorrectionsCount();
    }
  }
  els.settingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const base = $("s-apibase").value.trim().replace(/\/$/, "");
    if (base && !/^https?:\/\//i.test(base)) {
      els.settingsError.hidden = false;
      els.settingsError.textContent = "Server URL must start with http:// or https://";
      return;
    }
    els.settingsError.hidden = true;
    store.set("hvac.apiBase", base);
    store.set("hvac.token", $("s-token").value);
    state.authNeeded = false;
    for (const d of doc.querySelectorAll(".settings-dot")) d.hidden = true;
    showSettingsNotice("");
    toast("Connection saved");
    await loadHealth();
    if (state.health) init();
  });
  $("btn-health-refresh").addEventListener("click", () => loadHealth().then(() => toast(state.health ? "Server reachable" : "Server unreachable")));

  function setStatus(ok, text) {
    els.settingsStatus.querySelector(".status-dot").className = `status-dot ${ok === null ? "" : ok ? "ok" : "bad"}`;
    els.settingsStatusText.textContent = text;
  }
  function kvRow(key, value) {
    return h("div", { class: "kv" }, h("span", { class: "kv-key", text: key }), value instanceof Node ? value : h("span", { class: "kv-value", text: String(value) }));
  }
  async function loadHealth() {
    if (noServerConfigured()) {
      renderNoServer();
      return;
    }
    setStatus(null, "Checking…");
    // api() clears serverDown on the first reachable response, so remember the outage before the request.
    const wasDown = !!state.serverDown || !!state.healthFailed;
    try {
      const hlth = await apiJson("/api/health");
      state.health = hlth;
      if (!state.ai) {
        applyDemo(!!hlth.demo);
        // The AI view tells the chat banner whether CLAUDE_FAKE=1 forces demo, and the Settings card stays
        // "Unknown" with disabled controls until it loads (e.g. after an outage).
        loadAiSettings();
      } else if (!!hlth.demo !== !!state.ai.demo) loadAiSettings();
      state.healthFailed = false;
      // Back from an outage with Settings open: the usage and corrections cards still show "Couldn't load…".
      if (wasDown && state.route && state.route.screen === "settings") {
        loadMe();
        loadUsage();
        loadCorrectionsCount();
      }
      const where = apiBase() || `${location.origin} (same origin)`;
      setStatus(true, `Connected to ${where}${hlth.demo ? " · demo mode" : ""}`);
      updateOnline(false);
      els.healthInfo.textContent = "";
      els.healthInfo.append(
        kvRow("Model", hlth.model || "—"),
        kvRow("Effort", hlth.effort || "—"),
        kvRow("Web search", h("span", { class: `chip ${hlth.webSearch ? "chip-ok" : ""}`, text: hlth.webSearch ? "On — manufacturer literature lookups" : "Off" })),
        kvRow("Refusal fallbacks", hlth.fallbacks === undefined ? "—" : String(hlth.fallbacks)),
        kvRow("Knowledge", [hlth.packs !== undefined ? `${hlth.packs} manufacturer packs` : "", hlth.refrigerants !== undefined ? `${hlth.refrigerants} refrigerants` : "", hlth.rules !== undefined ? `${hlth.rules} diagnostic rules` : ""].filter(Boolean).join(" · ") || "—"),
        kvRow("Mode", h("span", { class: `chip ${hlth.demo ? "chip-warn" : "chip-ok"}`, text: hlth.demo ? "Demo — no API key, canned replies" : "Live assistant" })),
      );
    } catch (e) {
      state.health = null;
      state.healthFailed = true;
      els.demoBadge.hidden = true;
      if (isNetworkError(e)) updateOnline(true);
      renderDemoBanner();
      setStatus(false, e.code === "auth" ? "Password required" : `Unreachable: ${e.message}`);
      els.healthInfo.textContent = "";
      els.healthInfo.append(h("div", { class: "list-empty", text: "Server status unavailable." }));
    }
  }


  /* ---------- AI connection (Settings) ---------- */
  const ai = {
    card: $("ai-card"), chip: $("ai-chip"), detail: $("ai-status-detail"), form: $("ai-form"), key: $("ai-key"), keyHint: $("ai-key-hint"),
    keyError: $("ai-key-error"), model: $("ai-model"), effort: $("ai-effort"), webSearch: $("ai-websearch"), result: $("ai-test-result"),
    btnTest: $("btn-ai-test"), btnSave: $("btn-ai-save"), btnRemove: $("btn-ai-remove"), path: $("ai-settings-path"),
  };
  state.ai = null;
  state.aiExtraModels = [];
  state.aiLoading = null;

  const session = {
    get(k) {
      try {
        return sessionStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        sessionStorage.setItem(k, v);
      } catch {
        /* blocked */
      }
    },
  };
  const DEMO_DISMISS_KEY = "hvac.demoBannerDismissed";

  function demoMode() {
    return demoBannerMode({
      ai: state.ai,
      health: state.health,
      unreachable: !!state.serverDown || navigator.onLine === false,
      configDemo: !!(window.APP_CONFIG && window.APP_CONFIG.demo),
    });
  }
  function isDemo() {
    return demoMode() !== null;
  }
  /** Demo flag changed (or first known): badges, the chat banner and window.APP_CONFIG stay in step without a reload. */
  function applyDemo(demo) {
    if (window.APP_CONFIG && typeof window.APP_CONFIG === "object") window.APP_CONFIG.demo = !!demo;
    els.demoBadge.hidden = !demo;
    els.demoBadgeSettings.hidden = !demo;
    renderDemoBanner();
  }
  function focusAiKey() {
    const go = () => {
      // Scroll only the settings scroller: scrollIntoView would also shift overflow:hidden ancestors (the app frame).
      const scroller = ai.card.closest(".scroll");
      if (scroller) {
        const top = scroller.scrollTop + ai.card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
        scroller.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior() });
      }
      ai.key.focus({ preventScroll: true });
    };
    requestAnimationFrame(() => requestAnimationFrame(go));
  }
  function renderDemoBanner() {
    const mode = demoMode();
    if (!mode || session.get(DEMO_DISMISS_KEY) === "1") {
      clearBanner("demo");
      return;
    }
    const existing = els.banners.querySelector('[data-kind="demo"]');
    if (existing && existing.dataset.mode === mode) return;
    if (existing) clearBanner("demo");
    const content = mode === "forced"
      ? [h("span", { class: "demo-banner-text" }, h("strong", { text: "Demo mode is forced on the server (CLAUDE_FAKE=1)." }), " Answers are canned until it is removed there.")]
      : [
        h("span", { class: "demo-banner-text" }, h("strong", { text: "Demo mode — answers are canned." }), " Add your Anthropic API key in Settings → AI connection."),
        h("button", {
          class: "btn btn-sm demo-banner-btn",
          type: "button",
          onclick: () => {
            navigate("#settings");
            focusAiKey();
          },
        }, icon("settings", "icon icon-sm"), "Add API key"),
      ];
    const banner = showBanner("demo", "banner-warn", content, { onDismiss: () => session.set(DEMO_DISMISS_KEY, "1") });
    banner.classList.add("banner-demo");
    banner.dataset.mode = mode;
  }

  function selectedEffort() {
    const r = ai.effort.querySelector("input:checked");
    return r ? r.value : null;
  }
  function renderModelOptions(current) {
    const list = mergeModelLists(state.ai ? state.ai.models : [], state.aiExtraModels, current);
    ai.model.textContent = "";
    for (const m of list) ai.model.append(h("option", { value: m, text: m, selected: m === current }));
    ai.model.value = current;
  }
  function renderAi() {
    const v = state.ai;
    const s = aiStatusCopy(v);
    ai.chip.className = `chip ${s.tone === "ok" ? "chip-ok" : s.tone === "warn" ? "chip-warn" : "chip-outline"}`;
    ai.chip.textContent = "";
    ai.chip.append(icon(s.tone === "ok" ? "check" : "alert", "icon"), s.label);
    ai.detail.textContent = s.detail;
    ai.detail.className = `ai-detail${s.tone === "ok" ? " mono-detail" : ""}`;
    const disabled = !v;
    for (const el of [ai.key, ai.model, ai.webSearch, ai.btnTest, ai.btnSave]) el.disabled = disabled;
    for (const r of ai.effort.querySelectorAll("input")) r.disabled = disabled;
    if (!v) return;
    const k = apiKeyFieldCopy(v);
    ai.key.placeholder = k.placeholder;
    ai.keyHint.textContent = k.hint;
    renderModelOptions(v.model);
    const er = ai.effort.querySelector(`input[value="${v.effort}"]`);
    if (er) er.checked = true;
    ai.webSearch.checked = !!v.webSearch;
    ai.btnRemove.hidden = v.keySource !== "settings";
    ai.path.textContent = v.settingsPath ? `Saved on the server in ${v.settingsPath}.` : "";
  }
  function showAiKeyError(msg) {
    ai.keyError.hidden = !msg;
    ai.keyError.textContent = msg || "";
    if (msg) ai.key.setAttribute("aria-invalid", "true");
    else ai.key.removeAttribute("aria-invalid");
  }
  async function loadAiSettings() {
    if (state.aiLoading) return state.aiLoading;
    state.aiLoading = (async () => {
      try {
        state.ai = await apiJson("/api/settings/ai");
        renderAi();
        applyDemo(state.ai.demo);
      } catch (e) {
        if (!state.ai) {
          renderAi();
          ai.detail.textContent = e.code === "auth" ? "Enter the access password below first." : `Couldn't load the AI connection: ${e.message}`;
        }
      } finally {
        state.aiLoading = null;
      }
    })();
    return state.aiLoading;
  }

  function setBtnBusy(btn, busy, label) {
    if (busy) {
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.textContent = "";
      btn.append(h("span", { class: "spinner" }), label);
    } else {
      if (btn.dataset.label !== undefined) btn.innerHTML = btn.dataset.label;
      delete btn.dataset.label;
      btn.disabled = !state.ai;
      btn.removeAttribute("aria-busy");
    }
  }

  function renderTestResult(r, opts) {
    const c = testResultCopy(r, opts);
    ai.result.hidden = false;
    ai.result.className = `test-result test-${c.tone}`;
    ai.result.textContent = "";
    const head = h("div", { class: "test-head" }, icon(c.tone === "ok" ? "ok" : "alert", "icon"), h("strong", { text: c.title }));
    ai.result.append(head, h("p", { class: "test-body", text: c.body }));
    if (c.suggestion) ai.result.append(h("p", { class: "test-suggestion", text: c.suggestion }));
    if (!c.saveHint && state.ai && ai.model.value && r && r.model && ai.model.value !== r.model) {
      ai.result.append(h("p", { class: "test-suggestion", text: `This tested the saved model (${r.model}). Save to switch to ${ai.model.value}.` }));
    }
    if (c.useModel) {
      ai.result.append(
        h("div", { class: "btn-row" }, h("button", {
          class: "btn btn-sm",
          type: "button",
          onclick: () => {
            renderModelOptions(c.useModel);
            toast(`Model set to ${c.useModel} — tap Save to keep it`);
            ai.btnSave.focus();
          },
        }, `Use ${c.useModel}`)),
      );
    }
  }

  ai.btnTest.addEventListener("click", async () => {
    const raw = ai.key.value.trim();
    let saveHint = false;
    const problem = apiKeyProblem(raw);
    showAiKeyError(problem);
    if (problem) return ai.key.focus();
    setBtnBusy(ai.btnTest, true, "Testing…");
    try {
      const r = await apiJson("/api/settings/ai/test", { method: "POST", json: raw ? { apiKey: raw } : {} });
      if (r && Array.isArray(r.availableModels) && r.availableModels.length) {
        state.aiExtraModels = r.availableModels;
        renderModelOptions(ai.model.value || (state.ai && state.ai.model));
      }
      renderTestResult(r, { typedKey: !!raw });
      if (r && r.ok && raw) saveHint = true;
    } catch (e) {
      // A thrown "network" code means this phone never reached the HVAC server; Anthropic was not involved.
      if (e.code === "validation") showAiKeyError(e.message);
      else renderTestResult({ ok: false, code: e.code === "rate_limited" ? "rate_limited" : e.code === "network" ? "server_unreachable" : "unknown", message: e.message });
    } finally {
      setBtnBusy(ai.btnTest, false);
      if (saveHint) ai.btnSave.focus();
    }
  });

  async function saveAi(patch, okMsg) {
    try {
      const v = await apiJson("/api/settings/ai", { method: "PUT", json: patch });
      state.ai = v;
      ai.key.value = "";
      showAiKeyError("");
      // The last test described the old key/model; it would contradict the new status chip.
      ai.result.hidden = true;
      renderAi();
      applyDemo(v.demo);
      toast(okMsg(v));
      // Refresh the service worker's cached config.js so a later offline start doesn't boot with a stale demo flag.
      fetch("config.js", { cache: "no-store" }).catch(() => {});
      loadHealth();
      loadUsage();
      return true;
    } catch (e) {
      if (e.code === "validation" && /key/i.test(e.message)) showAiKeyError(e.message);
      else toast(`${e.code}: ${e.message}`);
      return false;
    }
  }
  ai.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.ai) return;
    const raw = ai.key.value.trim();
    const problem = apiKeyProblem(raw);
    showAiKeyError(problem);
    if (problem) return ai.key.focus();
    const patch = { model: ai.model.value, webSearch: ai.webSearch.checked };
    const effort = selectedEffort();
    if (effort) patch.effort = effort;
    if (raw) patch.apiKey = raw;
    setBtnBusy(ai.btnSave, true, "Saving…");
    try {
      await saveAi(patch, (v) => (v.demo ? (v.fakeForced ? "Saved · CLAUDE_FAKE=1 keeps demo on" : "Saved · still demo (no key)") : "Saved · assistant is live"));
    } finally {
      setBtnBusy(ai.btnSave, false);
    }
  });
  ai.btnRemove.addEventListener("click", async () => {
    if (!confirm("Remove the API key saved in the app? The server falls back to its .env key, or demo mode if it has none.")) return;
    ai.btnRemove.disabled = true;
    try {
      await saveAi({ apiKey: null }, (v) => (v.demo ? "Key removed · demo mode" : "Key removed · using server key"));
    } finally {
      ai.btnRemove.disabled = false;
    }
  });
  ai.key.addEventListener("input", () => {
    if (!ai.keyError.hidden) showAiKeyError("");
  });

  /* ---------- who am I + testers (Settings → Testers; DESIGN.md "Testers") ---------- */
  const testerUi = {
    card: $("tester-card"), chip: $("tester-chip"), body: $("tester-body"),
    adminCard: $("testers-card"), list: $("testers-list"), reveal: $("tester-reveal"), addForm: $("tester-add-form"),
    name: $("tester-name"), cap: $("tester-cap"), addError: $("tester-add-error"), btnAdd: $("btn-tester-add"), capHint: $("testers-cap-hint"),
    btnRefresh: $("btn-testers-refresh"),
  };
  /** Cards only the owner should see (a tester's /api calls to them answer 403 anyway). */
  const ownerOnlyCards = () => ["ai-card", "usage-card", "corrections-card"].map((id) => $(id)).filter(Boolean);

  function isTester() {
    return !!(state.me && state.me.role === "tester");
  }
  function applyRole() {
    const tester = isTester();
    for (const c of ownerOnlyCards()) c.hidden = tester;
    if (els.btnExport) els.btnExport.hidden = tester;
    testerUi.card.hidden = !tester;
    testerUi.adminCard.hidden = tester || !(state.me && state.me.authRequired);
    if (tester) renderTesterBudget();
  }
  let meSeq = 0;
  async function loadMe() {
    const seq = ++meSeq;
    try {
      const me = await apiJson("/api/me");
      if (seq !== meSeq) return;
      state.me = me;
      applyRole();
      if (me.role === "owner" && me.authRequired) loadTesters();
    } catch (e) {
      if (seq !== meSeq) return;
      // Older server without /api/me, or not signed in yet: behave as before (owner view).
      if (e.code !== "auth") {
        state.me = null;
        applyRole();
      }
    }
  }
  function renderTesterBudget() {
    const me = state.me || {};
    const b = me.budget;
    testerUi.body.textContent = "";
    testerUi.chip.textContent = me.name ? `Signed in as ${me.name}` : "Tester";
    if (!b) {
      testerUi.body.append(h("p", { class: "hint", text: "Your chats are kept separate from the owner's. Thanks for testing!" }));
      return;
    }
    const unlimited = !(b.capUsd > 0);
    const pct = unlimited ? 0 : Math.min(100, Math.round((b.spentTodayUsd / b.capUsd) * 100));
    testerUi.body.append(
      h("div", { class: "stats" },
        h("div", { class: `stat${b.exhausted ? " hi" : ""}` }, h("div", { class: "stat-label", text: "Spent today" }), h("div", { class: "stat-value", text: formatUsd(b.spentTodayUsd) })),
        h("div", { class: "stat" }, h("div", { class: "stat-label", text: "Daily budget" }), h("div", { class: "stat-value", text: unlimited ? "No cap" : formatUsd(b.capUsd) })),
        h("div", { class: "stat" }, h("div", { class: "stat-label", text: "Requests today" }), h("div", { class: "stat-value", text: String(b.requestsToday || 0) })),
      ),
      unlimited ? null : h("div", { class: "meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": "Share of today's budget used" }, h("div", { class: `meter-fill${b.exhausted ? " meter-full" : ""}`, style: `width:${pct}%` })),
      h("p", { class: "hint", text: b.exhausted ? "You've used today's test budget. It resets after midnight on the server; ask the owner if you need more today." : "Costs are estimated at list price. The budget resets each day on the server's clock. Your chats are kept separate from the owner's." }),
    );
  }

  /* --- owner: testers list --- */
  let testersSeq = 0;
  async function loadTesters() {
    if (testerUi.adminCard.hidden) return;
    const seq = ++testersSeq;
    if (!testerUi.list.firstChild) testerUi.list.append(h("div", { class: "skeleton" }));
    testerUi.list.setAttribute("aria-busy", "true");
    try {
      const r = await apiJson("/api/testers");
      if (seq !== testersSeq) return;
      state.testers = r.testers || [];
      state.testersDefaultCap = r.defaultCapUsd;
      renderTesters();
    } catch (e) {
      if (seq !== testersSeq) return;
      testerUi.list.textContent = "";
      testerUi.list.append(h("div", { class: "list-empty", text: e.code === "auth" ? "Enter the access password to manage testers." : `Couldn't load testers: ${e.message}` }));
    } finally {
      if (seq === testersSeq) testerUi.list.removeAttribute("aria-busy");
    }
  }
  function testerStatusChip(t) {
    if (t.disabled) return h("span", { class: "chip chip-outline", text: "Off" });
    if (t.today && t.today.exhausted) return h("span", { class: "chip chip-warn", text: "Over budget" });
    return h("span", { class: "chip chip-ok", text: "Active" });
  }
  function renderTesters() {
    testerUi.list.textContent = "";
    const def = state.testersDefaultCap;
    testerUi.capHint.textContent = `Leave the cap empty for the server default${Number.isFinite(def) ? ` (${def > 0 ? formatUsd(def) : "no cap"} per day)` : ""}; 0 means no cap for that person. Estimated at list price.`;
    if (!state.testers.length) {
      testerUi.list.append(h("div", { class: "list-empty", text: "No testers yet. Add a friend below; you'll get a password to send them." }));
      return;
    }
    for (const t of state.testers) {
      const today = t.today || {};
      const month = t.last30Days || {};
      const capText = t.effectiveCapUsd > 0 ? `${formatUsd(today.spentUsd)} of ${formatUsd(t.effectiveCapUsd)} today` : `${formatUsd(today.spentUsd)} today · no cap`;
      const seen = t.lastSeenAt ? `seen ${relTime(t.lastSeenAt)} ago` : "never signed in";
      const errs = month.errors ? ` · ${month.errors} error${month.errors === 1 ? "" : "s"}` : "";
      const caps = month.capHits ? ` · hit the cap ${month.capHits}×` : "";
      const actions = h("div", { class: "btn-row tester-actions" },
        h("button", { class: "btn btn-sm", type: "button", onclick: () => toggleTester(t) , text: t.disabled ? "Turn on" : "Turn off" }),
        h("button", { class: "btn btn-sm", type: "button", onclick: () => editTesterCap(t), text: "Cap" }),
        h("button", { class: "btn btn-sm", type: "button", onclick: () => resetTesterPassword(t), text: "New password" }),
        h("button", { class: "btn btn-sm btn-danger", type: "button", onclick: () => removeTester(t) }, icon("trash", "icon icon-sm"), "Remove"),
      );
      testerUi.list.append(
        h("div", { class: `tester-row${t.disabled ? " is-off" : ""}`, role: "listitem" },
          h("div", { class: "tester-head" }, h("div", { class: "row-title", text: t.name }), testerStatusChip(t)),
          h("div", { class: "row-sub tester-sub" }, h("span", { text: capText })),
          h("div", { class: "row-sub tester-sub" }, h("span", { text: `Last 30 days: ${formatUsd(month.spentUsd)} · ${month.turns || 0} chat${month.turns === 1 ? "" : "s"}${errs}${caps} · ${seen}` })),
          actions,
        ),
      );
    }
  }
  function showTesterPassword(t, password, { fresh }) {
    const url = (apiBase() || location.origin).replace(/\/$/, "");
    const text = `${fresh ? "You're in" : "New password"} for the HVAC Field Assistant.\nOpen: ${url}\nUsername: ${t.name}\nPassword: ${password}\n\nPhone: add it to your home screen (iPhone: Share → Add to Home Screen; Android: menu → Install app), then Settings → Access password → paste the password.`;
    testerUi.reveal.hidden = false;
    testerUi.reveal.textContent = "";
    testerUi.reveal.append(
      h("div", { class: "tester-reveal-title", text: `${fresh ? "Password for" : "New password for"} ${t.name}` }),
      h("div", { class: "tester-reveal-pw", text: password }),
      h("p", { class: "hint", text: "Shown once. Copy the message below and send it to them; you can make a new password any time." }),
      h("div", { class: "btn-row" },
        h("button", { class: "btn btn-primary", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(text); toast("Copied the invite"); } catch { toast("Copy not available — long-press the password instead"); } } }, icon("copy", "icon icon-sm"), "Copy invite"),
        h("button", { class: "btn", type: "button", onclick: () => { testerUi.reveal.hidden = true; testerUi.reveal.textContent = ""; }, text: "Done" }),
      ),
    );
    testerUi.reveal.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  async function toggleTester(t) {
    if (!t.disabled && !confirm(`Turn off ${t.name}'s login? They're signed out immediately; you can turn it on again here.`)) return;
    try {
      await apiJson(`/api/testers/${encodeURIComponent(t.id)}`, { method: "PATCH", json: { disabled: !t.disabled } });
      toast(t.disabled ? `${t.name} can sign in again` : `${t.name} turned off`);
      loadTesters();
    } catch (e) {
      toast(`${e.code}: ${e.message}`);
    }
  }
  async function editTesterCap(t) {
    const current = t.dailyCapUsd === null || t.dailyCapUsd === undefined ? "" : String(t.dailyCapUsd);
    const raw = prompt(`Daily cap for ${t.name} in dollars (empty = server default, 0 = no cap):`, current);
    if (raw === null) return;
    const v = raw.trim();
    const cap = v === "" ? null : Number(v);
    if (cap !== null && (!Number.isFinite(cap) || cap < 0)) {
      toast("Enter a dollar amount like 2 or 0.50");
      return;
    }
    try {
      await apiJson(`/api/testers/${encodeURIComponent(t.id)}`, { method: "PATCH", json: { dailyCapUsd: cap } });
      toast(cap === null ? `${t.name}: default cap` : cap === 0 ? `${t.name}: no cap` : `${t.name}: ${formatUsd(cap)} per day`);
      loadTesters();
    } catch (e) {
      toast(`${e.code}: ${e.message}`);
    }
  }
  async function resetTesterPassword(t) {
    if (!confirm(`Make a new password for ${t.name}? The old one stops working right away.`)) return;
    try {
      const r = await apiJson(`/api/testers/${encodeURIComponent(t.id)}/password`, { method: "POST", json: {} });
      showTesterPassword(r.tester || t, r.password, { fresh: false });
      loadTesters();
    } catch (e) {
      toast(`${e.code}: ${e.message}`);
    }
  }
  async function removeTester(t) {
    if (!confirm(`Remove ${t.name}? Their login is deleted. Their chats and usage history stay on the server.`)) return;
    try {
      await apiJson(`/api/testers/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      toast(`${t.name} removed`);
      loadTesters();
    } catch (e) {
      toast(`${e.code}: ${e.message}`);
    }
  }
  testerUi.addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = testerUi.name.value.trim();
    const capRaw = testerUi.cap.value.trim();
    testerUi.addError.hidden = true;
    if (!name) {
      testerUi.addError.hidden = false;
      testerUi.addError.textContent = "Give the tester a name.";
      testerUi.name.focus();
      return;
    }
    const json = { name };
    if (capRaw !== "") {
      const cap = Number(capRaw);
      if (!Number.isFinite(cap) || cap < 0) {
        testerUi.addError.hidden = false;
        testerUi.addError.textContent = "The cap must be a dollar amount, like 2 or 0.50.";
        return;
      }
      json.dailyCapUsd = cap;
    }
    testerUi.btnAdd.disabled = true;
    try {
      const r = await apiJson("/api/testers", { method: "POST", json });
      testerUi.name.value = "";
      testerUi.cap.value = "";
      showTesterPassword(r.tester, r.password, { fresh: true });
      loadTesters();
    } catch (err) {
      testerUi.addError.hidden = false;
      testerUi.addError.textContent = err.code === "no_password" ? "Set an access password on the server first (APP_PASSWORD in .env); tester logins only work when the app asks for a password." : err.message;
    } finally {
      testerUi.btnAdd.disabled = false;
    }
  });
  testerUi.btnRefresh.addEventListener("click", () => loadTesters());

  /* ---------- usage (Settings) ---------- */
  const usage = { seg: $("usage-seg"), body: $("usage-body") };
  state.usageDays = (() => {
    const v = Number(store.get("hvac.usageDays"));
    return v === 7 || v === 90 ? v : 30;
  })();
  {
    const r = usage.seg.querySelector(`input[value="${state.usageDays}"]`);
    if (r) r.checked = true;
  }
  usage.seg.addEventListener("change", (e) => {
    const v = Number(e.target && e.target.value);
    if (![7, 30, 90].includes(v)) return;
    state.usageDays = v;
    store.set("hvac.usageDays", String(v));
    loadUsage();
  });
  let usageSeq = 0;
  async function loadUsage() {
    const seq = ++usageSeq;
    if (!usage.body.firstChild) usage.body.append(h("div", { class: "skeleton" }), h("div", { class: "skeleton" }));
    usage.body.setAttribute("aria-busy", "true");
    try {
      const s = await apiJson(`/api/usage?days=${state.usageDays}`);
      if (seq !== usageSeq) return;
      renderUsage(s);
    } catch (e) {
      if (seq !== usageSeq) return;
      usage.body.textContent = "";
      usage.body.append(h("div", { class: "list-empty", text: e.code === "auth" ? "Enter the access password to see usage." : `Couldn't load usage: ${e.message}` }));
    } finally {
      if (seq === usageSeq) usage.body.removeAttribute("aria-busy");
    }
  }
  function usageStat(label, value, sub) {
    return h("div", { class: "stat" }, h("div", { class: "stat-label", text: label }), h("div", { class: "stat-value", text: value }), sub ? h("div", { class: "stat-sub", text: sub }) : null);
  }
  function renderUsage(s) {
    usage.body.textContent = "";
    const t = s.totals || {};
    if (!t.requests) {
      const demo = isDemo();
      usage.body.append(
        h("div", { class: "empty empty-compact" },
          h("div", { class: "empty-icon" }, icon("gauge")),
          h("div", { class: "empty-title", text: "No usage yet" }),
          h("p", {
            class: "empty-sub",
            text: demo
              ? "Usage is recorded once the real model is connected. Demo answers are free and not counted."
              : `No assistant requests in the last ${s.days} days. Usage shows here after the next answer.`,
          }),
          demoMode() === "demo" ? h("button", { class: "btn", type: "button", onclick: focusAiKey }, "Add API key") : null,
        ),
      );
      return;
    }
    const days = s.days;
    usage.body.append(
      h("div", { class: "stats usage-stats" },
        usageStat("Requests", formatCount(t.requests), `${formatTokens(t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens)} in · ${formatTokens(t.outputTokens)} out`),
        usageStat("Estimated cost", formatUsd(t.estimatedCostUsd), `last ${days} days`),
        usageStat("Avg per conversation", formatUsd(s.perConversationAvgUsd), null),
        usageStat("Web searches", formatCount(t.webSearches), null),
      ),
      h("p", { class: "hint usage-caption", text: `Costs are ${s.priceLabel || "estimated at list price"} (USD); your invoice is the source of truth.` }),
    );
    if (t.costComplete === false) {
      usage.body.append(h("p", { class: "usage-note" }, icon("info", "icon icon-sm"), h("span", { text: "Cost not estimated for some models (no list price on file), so totals are partial." })));
    }

    const dr = usageDayRows(s);
    usage.body.append(h("h3", { class: "form-subhead usage-subhead", text: dr.metric === "cost" ? "By day · estimated cost" : "By day · requests" }));
    if (!dr.rows.length) {
      usage.body.append(h("div", { class: "list-empty", text: "No requests in this period." }));
    } else {
      const list = h("ul", { class: "bars", role: "list" });
      for (const r of dr.rows) {
        const costText = r.cost === null || r.cost === undefined ? "cost not estimated" : formatUsd(r.cost);
        const value = dr.metric === "cost" ? costText : `${formatCount(r.requests)} req`;
        const sub = dr.metric === "cost" ? `${formatCount(r.requests)} req` : r.requests ? costText : "";
        const full = `${r.label}: ${formatCount(r.requests)} request${r.requests === 1 ? "" : "s"}, ${costText}`;
        list.append(
          h("li", { class: "bar-row", title: full, "aria-label": full },
            h("span", { class: "bar-label", text: r.label, "aria-hidden": "true" }),
            h("span", { class: "bar-track", "aria-hidden": "true" }, h("span", { class: "bar-fill", style: `width:${r.width}%` })),
            h("span", { class: "bar-value", "aria-hidden": "true" }, h("span", { text: value }), sub ? h("small", { text: sub }) : null),
          ),
        );
      }
      usage.body.append(list);
      if (dr.hidden) usage.body.append(h("p", { class: "hint", text: `${dr.hidden} day${dr.hidden === 1 ? "" : "s"} with no requests not shown.` }));
    }

    if (Array.isArray(s.byModel) && s.byModel.length) {
      usage.body.append(h("h3", { class: "form-subhead usage-subhead", text: "By model" }));
      const models = h("div", { class: "list" });
      for (const m of s.byModel) {
        models.append(
          h("div", { class: "kv" },
            h("span", { class: "kv-key mono", text: m.model }),
            h("span", { class: "kv-value" }, `${formatCount(m.requests)} req · `, m.estimatedCostUsd === null ? h("span", { class: "muted", text: "cost not estimated" }) : formatUsd(m.estimatedCostUsd)),
          ),
        );
      }
      usage.body.append(models);
    }
  }

  /* ---------- PWA: install, service worker, export ---------- */
  els.appVersion.textContent = `Version ${(window.APP_CONFIG && window.APP_CONFIG.version) || APP_VERSION}`;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.installPrompt = e;
    renderInstallState();
  });
  window.addEventListener("appinstalled", () => {
    state.installPrompt = null;
    toast("Installed — open it from your home screen");
    renderInstallState();
  });
  function renderInstallState() {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
    if (isStandalone()) {
      els.btnInstall.hidden = true;
      els.installHint.textContent = "Installed as an app on this device.";
    } else if (state.installPrompt) {
      els.btnInstall.hidden = false;
      els.installHint.textContent = "Install for a full-screen app with offline calculators.";
    } else if (ios) {
      els.btnInstall.hidden = true;
      els.installHint.textContent = "Install: tap Share in Safari, then “Add to Home Screen”.";
    } else {
      els.btnInstall.hidden = true;
      els.installHint.textContent = "Install: open the browser menu and choose “Install app” or “Add to Home screen”.";
    }
  }
  els.btnInstall.addEventListener("click", async () => {
    const p = state.installPrompt;
    if (!p) return;
    p.prompt();
    try {
      await p.userChoice;
    } catch {
      /* dismissed */
    }
    state.installPrompt = null;
    renderInstallState();
  });
  function renderOfflineInfo() {
    if (!CALC) {
      els.offlineInfo.textContent = "";
      return;
    }
    const s = CALC.ptCacheSummary();
    els.offlineInfo.textContent = s.count
      ? `Offline cache: ${s.count} PT lookup${s.count === 1 ? "" : "s"} (${s.refrigerants.map(([id, n]) => `${id} ×${n}`).join(", ")}). Electrical and SH/SC calculators run on the device.`
      : "Offline: electrical and SH/SC calculators run on the device; PT lookups are cached as you use them (last 20).";
  }
  els.btnExport.addEventListener("click", async () => {
    els.btnExport.disabled = true;
    try {
      const res = await api("/api/export");
      if (!res.ok) throw await readError(res);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: `hvac-export-${new Date().toISOString().slice(0, 10)}.json` });
      doc.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast("Export downloaded");
    } catch (e) {
      toast(`Export failed: ${e.message}`);
    } finally {
      els.btnExport.disabled = false;
    }
  });
  els.btnUpdate.addEventListener("click", () => {
    if (state.swWaiting) state.swWaiting.postMessage({ type: "SKIP_WAITING" });
    else location.reload();
  });
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    const configVersion = window.APP_CONFIG && window.APP_CONFIG.version ? String(window.APP_CONFIG.version) : APP_VERSION;
    const known = store.get("hvac.version");
    navigator.serviceWorker.register("sw.js").then((reg) => {
      if (known !== configVersion) {
        store.set("hvac.version", configVersion);
        reg.update().catch(() => {});
      }
      const track = (worker) => {
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            state.swWaiting = worker;
            els.btnUpdate.hidden = false;
          }
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) {
        state.swWaiting = reg.waiting;
        els.btnUpdate.hidden = false;
      }
      reg.addEventListener("updatefound", () => track(reg.installing));
    }).catch(() => {
      /* http origin without SW support, or blocked */
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading || !state.swWaiting) return;
      reloading = true;
      location.reload();
    });
  }

  /* ---------- service reports (share sheet), QR labels, print labels ---------- */
  const rep = { mode: null, id: null, busy: false };

  /** Copy text that is still being fetched: Safari keeps the clipboard permission only for a ClipboardItem built in the tap. */
  async function copyTextAsync(textPromise) {
    if (!navigator.clipboard) throw new Error("Clipboard not available");
    if (typeof ClipboardItem === "function" && navigator.clipboard.write) {
      try {
        const blobPromise = textPromise.then((t) => new Blob([t], { type: "text/plain" }));
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": blobPromise })]);
        return;
      } catch {
        /* fall through: older Chrome rejects promise-valued items */
      }
    }
    await navigator.clipboard.writeText(await textPromise);
  }

  function reportPath(mode, id, format) {
    return `/api/${mode === "unit" ? "units" : "conversations"}/${encodeURIComponent(id)}/report?format=${format}`;
  }
  async function fetchReport(mode, id, format) {
    const res = await api(reportPath(mode, id, format));
    if (!res.ok) throw await readError(res);
    return { text: await res.text(), filename: filenameFromDisposition(res.headers.get("content-disposition")) };
  }
  function shareLabel(mode, id) {
    if (mode === "unit") {
      const u = (state.panelUnit && state.panelUnit.unit.id === id && state.panelUnit.unit) || state.unitsById.get(id) || null;
      return u ? unitLabel(u) : "Unit";
    }
    return state.conversation && state.conversationId === id ? state.conversation.title || "Conversation" : "Conversation";
  }
  function showShareFallback(href, name, text) {
    els.shareFallback.textContent = "";
    els.shareFallback.hidden = false;
    els.shareFallback.append(
      h("p", { class: "hint", style: "margin:0 0 8px", text: "The browser blocked the new tab. Open it from here:" }),
      h("a", { class: "btn btn-primary btn-block", href, target: "_blank", rel: "noopener", download: name || null }, icon("file"), text),
    );
  }
  /** Open the printable HTML report: a window is opened synchronously in the tap (iOS blocks one opened after a fetch), then filled. */
  function openPrintable(mode, id) {
    let win = null;
    try {
      win = window.open("", "_blank");
    } catch {
      win = null;
    }
    if (win) {
      try {
        win.document.write("<!doctype html><title>Report</title><p style=\"font:16px system-ui;padding:24px\">Preparing the report…</p>");
      } catch {
        /* cross-origin about:blank on some shells */
      }
    }
    setRowBusy("printable", true);
    fetchReport(mode, id, "html").then(({ text, filename }) => {
      if (win && !win.closed) {
        win.document.open();
        win.document.write(text);
        win.document.close();
        toast("Report opened in a new tab");
        closeSheets();
        return;
      }
      const url = URL.createObjectURL(new Blob([text], { type: "text/html" }));
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      showShareFallback(url, filename || reportFilename(mode, shareLabel(mode, id), "html"), "Open printable report");
    }).catch((e) => {
      if (win && !win.closed) win.close();
      toast(`Report failed: ${e.message}`);
    }).finally(() => setRowBusy("printable", false));
  }
  function setRowBusy(key, busy) {
    rep.busy = busy;
    for (const row of els.shareList.querySelectorAll("button.row")) {
      row.disabled = busy;
      const lead = row.querySelector(".row-lead");
      if (row.dataset.key === key && lead) {
        lead.textContent = "";
        lead.append(busy ? h("span", { class: "spinner" }) : icon(row.dataset.icon));
      }
    }
  }
  function shareRow(key, ic, title, sub, fn) {
    return h("button", { class: "row", type: "button", dataset: { key, icon: ic }, onclick: () => { if (!rep.busy) fn(); } },
      h("div", { class: "row-lead" }, icon(ic)), h("div", { class: "row-body" }, h("div", { class: "row-title", text: title }), sub ? h("div", { class: "row-sub" }, h("span", { text: sub })) : null), icon("chevron", "icon icon-sm row-chevron"));
  }
  function showShareSheet(mode, id) {
    rep.mode = mode;
    rep.id = id;
    rep.busy = false;
    els.shareTitle.textContent = mode === "unit" ? "Unit report" : "Share report";
    els.shareSub.textContent = mode === "unit" ? `${shareLabel(mode, id)} — nameplate, findings by date, corrections, recent conversations` : `${shareLabel(mode, id)} — complaint, readings, findings, open items, summary`;
    els.shareFallback.hidden = true;
    els.shareFallback.textContent = "";
    els.shareList.textContent = "";
    els.shareList.append(
      shareRow("text", "share", navigator.share ? "Share text" : "Copy text", navigator.share ? "Messages, email, WhatsApp…" : "Plain-text summary to the clipboard", async () => {
        setRowBusy("text", true);
        try {
          if (navigator.share) {
            const { text } = await fetchReport(mode, id, "json");
            const payload = reportSharePayload(JSON.parse(text));
            try {
              await navigator.share(payload);
              closeSheets();
            } catch (err) {
              if (!err || err.name !== "AbortError") {
                await navigator.clipboard.writeText(`${payload.title}\n\n${payload.text}`);
                toast("Sharing not available — copied instead");
              }
            }
          } else {
            await copyTextAsync(fetchReport(mode, id, "json").then(({ text }) => { const p = reportSharePayload(JSON.parse(text)); return `${p.title}\n\n${p.text}`; }));
            toast("Report text copied");
            closeSheets();
          }
        } catch (e) {
          toast(`Share failed: ${e.message}`);
        } finally {
          setRowBusy("text", false);
        }
      }),
      shareRow("printable", "file", "Open printable", "HTML page with a Print / Save as PDF button", () => openPrintable(mode, id)),
      shareRow("markdown", "copy", "Copy Markdown", "Paste into notes, email or a work order", async () => {
        setRowBusy("markdown", true);
        try {
          await copyTextAsync(fetchReport(mode, id, "md").then(({ text }) => text));
          toast("Markdown copied");
          closeSheets();
        } catch (e) {
          toast(`Copy failed: ${e.message}`);
        } finally {
          setRowBusy("markdown", false);
        }
      }),
    );
    showSheet(els.sheetShare);
  }
  els.btnChatShare.addEventListener("click", () => {
    if (state.conversationId) navigate(`#chat/${state.conversationId}/share`);
  });

  /* QR label sheet */
  const qrState = { unitId: null };
  function qrSvgEl(matrix, size) {
    const wrap = h("div", { class: "qr-svg", html: qrSvgMarkup(matrix, { margin: 2, size, title: "Unit QR code" }) });
    return wrap;
  }
  function buildLabel(u) {
    const url = unitUrl(appBaseUrl(location), u.id);
    const t = labelText(u);
    return { title: t.title, lines: t.lines, url, matrix: qrMatrix(url) };
  }
  function renderQrLabel(u) {
    els.qrLabel.textContent = "";
    if (!u) {
      els.qrLabel.append(h("div", { class: "skeleton", style: "min-height:220px" }));
      return;
    }
    const label = buildLabel(u);
    els.qrTitle.textContent = `QR label — ${label.title}`;
    if (!label.matrix) {
      els.qrLabel.append(h("div", { class: "field-error", role: "alert", text: "QR encoder not loaded — reload the app once online." }));
      return;
    }
    els.qrLabel.append(
      h("div", { class: "qr-label" },
        qrSvgEl(label.matrix, 180),
        h("div", { class: "qr-text" },
          h("div", { class: "qr-tag", text: label.title }),
          ...label.lines.map((l) => h("div", { class: "qr-line", text: l })),
          h("div", { class: "qr-url", text: label.url }),
        ),
      ),
      h("p", { class: "hint", text: "Stick it on the unit. Scanning with the phone camera opens this unit in the app (in the browser when the app is installed)." }),
    );
  }
  function showQrSheet(unitId) {
    qrState.unitId = unitId;
    const u = (state.panelUnit && state.panelUnit.unit.id === unitId && state.panelUnit.unit) || state.unitsById.get(unitId) || null;
    els.qrTitle.textContent = "QR label";
    renderQrLabel(u);
    if (!u) {
      apiJson(`/api/units/${encodeURIComponent(unitId)}`).then((data) => {
        const unit = data.unit || data;
        state.unitsById.set(unit.id, unit);
        if (qrState.unitId === unitId && !els.sheetQr.hidden) renderQrLabel(unit);
      }).catch((e) => {
        if (qrState.unitId !== unitId) return;
        els.qrLabel.textContent = "";
        els.qrLabel.append(h("div", { class: "field-error", role: "alert", text: `${e.code}: ${e.message}` }));
      });
    }
    els.btnQrShare.hidden = !navigator.share;
    showSheet(els.sheetQr);
  }
  function currentQrUnit() {
    const id = qrState.unitId;
    return id ? ((state.panelUnit && state.panelUnit.unit.id === id && state.panelUnit.unit) || state.unitsById.get(id) || null) : null;
  }
  /** Write a generated document into a window opened synchronously in the same tap; false when blocked. */
  function openDocument(html, name) {
    let win = null;
    try {
      win = window.open("", "_blank");
    } catch {
      win = null;
    }
    if (win) {
      win.document.open();
      win.document.write(html);
      win.document.close();
      return true;
    }
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return { url, name };
  }
  function showDocFallback(container, result, text) {
    container.textContent = "";
    container.hidden = false;
    container.append(
      h("p", { class: "hint", style: "margin:0 0 8px", text: "The browser blocked the new tab. Open it from here:" }),
      h("a", { class: "btn btn-primary btn-block", href: result.url, target: "_blank", rel: "noopener" }, icon("file"), text),
    );
  }
  els.btnQrPrint.addEventListener("click", () => {
    const u = currentQrUnit();
    if (!u) return;
    const label = buildLabel(u);
    const r = openDocument(labelsDocumentHtml([label], { heading: `QR label — ${label.title}` }), `hvac-label-${label.title}.html`);
    if (r === true) toast("Label opened — use Print there");
    else showDocFallback(els.qrFallback, r, "Open printable label");
  });
  els.btnQrCopy.addEventListener("click", async () => {
    const u = currentQrUnit();
    if (!u) return;
    try {
      await navigator.clipboard.writeText(unitUrl(appBaseUrl(location), u.id));
      toast("Link copied");
    } catch {
      toast("Copy not available in this browser");
    }
  });
  els.btnQrShare.addEventListener("click", () => {
    const u = currentQrUnit();
    if (!u || !navigator.share) return;
    navigator.share({ title: labelText(u).title, text: `${labelText(u).title} — HVAC Field Assistant`, url: unitUrl(appBaseUrl(location), u.id) }).catch(() => {});
  });

  /* Units overflow + print labels sheet */
  els.btnUnitsMore.addEventListener("click", () => navigate("#units/actions"));
  function showUnitsActions() {
    const list = els.unitsActionsList;
    list.textContent = "";
    const n = filterUnits(state.units, state.unitsQuery).length;
    const action = (ic, title, sub, fn) => h("button", { class: "row", type: "button", onclick: () => { closeSheets(); setTimeout(fn, 0); } },
      h("div", { class: "row-lead" }, icon(ic)), h("div", { class: "row-body" }, h("div", { class: "row-title", text: title }), sub ? h("div", { class: "row-sub" }, h("span", { text: sub })) : null), icon("chevron", "icon icon-sm row-chevron"));
    list.append(
      action("scan", "Print QR labels", n ? `${n} unit${n === 1 ? "" : "s"} on the current filter, two per row on paper` : "Add units first", () => navigate("#units/labels")),
      action("upload", "Import units", "Paste rows or pick a CSV", () => navigate("#units/import")),
      action("refresh", "Refresh units", null, () => loadUnits().then(() => toast("Units refreshed"))),
    );
    showSheet(els.sheetUnitsActions);
  }
  function showLabelsSheet() {
    const units = filterUnits(state.units, state.unitsQuery);
    els.labelsFallback.hidden = true;
    els.labelsFallback.textContent = "";
    els.labelsBody.textContent = "";
    const q = (state.unitsQuery || "").trim();
    els.labelsBody.append(
      h("p", { style: "margin:0 0 8px", text: units.length ? `${units.length} label${units.length === 1 ? "" : "s"}${q ? ` for units matching “${q}”` : " — every unit in the list"}.` : "No units match the current filter." }),
      h("p", { class: "hint", style: "margin:0", text: "Each label has the unit's QR code (opens the unit in this app), tag, site and model. Prints two per row; use the Print button on the page that opens." }),
    );
    if (units.length) {
      const preview = h("div", { class: "labels-preview" });
      for (const u of units.slice(0, 4)) {
        const label = buildLabel(u);
        preview.append(h("div", { class: "qr-mini" }, label.matrix ? qrSvgEl(label.matrix, 56) : null, h("div", { class: "qr-mini-text" }, h("div", { class: "qr-mini-title", text: label.title }), h("div", { class: "qr-mini-sub", text: label.lines[0] || "" }))));
      }
      if (units.length > 4) preview.append(h("div", { class: "qr-mini qr-mini-more", text: `+${units.length - 4} more` }));
      els.labelsBody.append(preview);
    }
    els.btnLabelsPrint.disabled = !units.length;
    els.btnLabelsPrint.textContent = units.length ? `Print ${units.length} label${units.length === 1 ? "" : "s"}` : "Print labels";
    showSheet(els.sheetLabels);
  }
  els.btnLabelsPrint.addEventListener("click", () => {
    const units = filterUnits(state.units, state.unitsQuery);
    if (!units.length) return;
    const labels = units.map(buildLabel);
    const r = openDocument(labelsDocumentHtml(labels, { heading: `Unit QR labels${state.unitsQuery ? ` — ${state.unitsQuery.trim()}` : ""}` }), "hvac-unit-labels.html");
    if (r === true) {
      toast(`${labels.length} label${labels.length === 1 ? "" : "s"} opened — use Print there`);
      closeSheets();
    } else showDocFallback(els.labelsFallback, r, "Open printable labels");
  });

  /* ---------- native shell: no server configured yet ---------- */
  function serverPrompt() {
    return serverUrlPrompt({
      configBase: window.APP_CONFIG && typeof window.APP_CONFIG === "object" ? window.APP_CONFIG.apiBase : "",
      savedBase: store.get("hvac.apiBase"),
      bundled: !!(window.APP_CONFIG && window.APP_CONFIG.bundled),
      protocol: location.protocol,
    });
  }
  function noServerConfigured() {
    return serverPrompt().needed;
  }
  /** Settings screen state when the bundle has no server yet: a clear prompt instead of "unreachable" errors. */
  function renderNoServer() {
    const p = serverPrompt();
    showSettingsNotice(p.message);
    setStatus(false, "No server URL set");
    els.healthInfo.textContent = "";
    els.healthInfo.append(h("div", { class: "list-empty", text: "Enter the server URL above to connect." }));
    els.demoBadge.hidden = true;
    els.demoBadgeSettings.hidden = true;
    // The AI, usage and corrections cards need the server too: say so instead of leaving them at "Checking…".
    state.ai = null;
    renderAi();
    ai.detail.textContent = "Connect to your server first (Server card below); the AI connection is configured there.";
    usage.body.textContent = "";
    usage.body.append(h("div", { class: "list-empty", text: "Connect to a server to see usage." }));
    els.correctionsCount.textContent = "Connect to a server to see corrections.";
    els.btnCorrectionsExport.disabled = true;
    for (const d of doc.querySelectorAll(".settings-dot")) d.hidden = false;
    const field = $("s-apibase");
    if (field && !isTouch) field.focus({ preventScroll: true });
  }

  /* ======================================================================================
   * Readings history + follow-ups (DESIGN.md "Readings history", "Follow-ups")
   * ==================================================================================== */
  state.readingsUnit = null; // unit picked for "Save to unit" when no unit is attached to the chat
  state.followups = null; // {status, items, counts, today}
  state.pickPurpose = null; // "attach" | "readings"
  const fx = {
    btnReadingsSave: $("btn-readings-save"),
    followups: $("followups"), historyCounts: [...doc.querySelectorAll(".history-count")],
    pickTitle: $("pick-title"), pickSub: $("pick-sub"), pickSearch: $("pick-search"), pickList: $("pick-list"), btnPickDecode: $("btn-pick-decode"),
    findingForm: $("finding-form"), findingTitle: $("finding-title"), findingSub: $("finding-sub"), findingError: $("finding-error"),
    fiSymptom: $("fi-symptom"), fiCause: $("fi-cause"), fiResolution: $("fi-resolution"), fiStatus: $("fi-status"), fiCircuit: $("fi-circuit"),
    fiFollowUp: $("fi-follow-up"), fiDue: $("fi-due"), fiDone: $("fi-done"), fiDoneRow: $("fi-done-row"), btnFindingSave: $("btn-finding-save"),
  };

  /* ---- readings: save to unit ---- */
  function readingsTargetUnit() {
    return state.unit || state.readingsUnit || null;
  }
  function renderReadingsSaveButton() {
    const u = readingsTargetUnit();
    // Short label in the action bar (three buttons share a phone width); the result card carries the long one.
    fx.btnReadingsSave.textContent = "";
    fx.btnReadingsSave.append(icon("units"), "Save");
    fx.btnReadingsSave.setAttribute("aria-label", u ? `Save readings to ${unitLabel(u)}` : "Save readings to a unit");
    fx.btnReadingsSave.title = u ? `Save to ${unitLabel(u)}` : "Save to unit";
  }
  /** Same gate as Diagnose: a refrigerant and at least one reading. Returns the error text or null. */
  function readingsFormProblem(m) {
    if (!m.refrigerant) return "Pick a refrigerant.";
    if (m.suctionPsig === undefined && m.liquidPsig === undefined && m.outdoorDbF === undefined && m.compressorAmps === undefined && m.supplyDbF === undefined) {
      return "Enter at least one reading — suction/liquid pressure with line temps gives the most.";
    }
    return null;
  }
  async function saveReadingToUnit() {
    const target = readingsTargetUnit();
    if (!target) return navigate("#readings/pick");
    const m = buildMeasurements(readingsValues());
    const problem = readingsFormProblem(m);
    els.readingsError.hidden = !problem;
    if (problem) {
      els.readingsError.textContent = problem;
      return;
    }
    fx.btnReadingsSave.disabled = true;
    try {
      const body = { ...m, unit_id: target.id };
      if (state.conversationId && state.unit && state.unit.id === target.id) body.conversation_id = state.conversationId;
      const result = await apiJson("/api/calc/diagnose", { method: "POST", json: body });
      state.lastDx = result;
      renderDxResult(result);
      toast(`Saved to ${unitLabel(target)}`);
      if (state.panelUnit && state.panelUnit.unit.id === target.id) loadUnitPanel(target.id, { quiet: true });
      if (state.ctx && state.ctx.unit.id === target.id) state.ctx = null;
    } catch (err) {
      els.readingsError.hidden = false;
      els.readingsError.textContent = isNetworkError(err) ? "Saving needs a connection." : `${err.code}: ${err.message}`;
    } finally {
      fx.btnReadingsSave.disabled = false;
    }
  }
  fx.btnReadingsSave.addEventListener("click", () => saveReadingToUnit());
  renderReadingsSaveButton();

  /* ---- unit picker sheet (attach to chat / save readings to) ---- */
  function showPickSheet(r) {
    state.pickPurpose = r.screen === "chat" ? "attach" : "readings";
    const attach = state.pickPurpose === "attach";
    fx.pickTitle.textContent = attach ? "Attach a unit" : "Save readings to…";
    fx.pickSub.textContent = attach ? "Job memory follows the unit: its findings, saved readings and prior jobs stay in view while you chat." : "The diagnosis is stored in this unit's readings history for the next visit.";
    fx.pickSearch.value = "";
    renderPickList();
    showSheet(els.sheetPick);
    if (!state.units.length) loadUnits().then(renderPickList);
  }
  function renderPickList() {
    const list = fx.pickList;
    list.textContent = "";
    const units = filterUnits(state.units, fx.pickSearch.value);
    if (!units.length) {
      list.append(h("div", { class: "list-empty", text: state.units.length ? "No units match." : "No units yet — decode a nameplate first." }));
      return;
    }
    for (const [site, group] of groupUnitsBySite(units)) {
      list.append(h("div", { class: "group-head" }, h("span", null, icon("site", "icon icon-sm"), " ", site)));
      for (const u of group) {
        list.append(listRow(h("button", { class: "row", type: "button", onclick: () => pickUnit(u) },
          h("div", { class: "row-lead" }, icon("units")),
          h("div", { class: "row-body" }, h("div", { class: "row-title", text: unitLabel(u) }), h("div", { class: "row-sub" }, h("span", { text: unitSubtitle(u) || "No details yet" }))),
          icon("chevron", "icon icon-sm row-chevron"),
        ), { dataset: { pickUnitId: u.id } }));
      }
    }
  }
  fx.pickSearch.addEventListener("input", renderPickList);
  fx.btnPickDecode.addEventListener("click", () => navigate("#units/decode"));
  async function pickUnit(u) {
    const purpose = state.pickPurpose;
    closeSheets();
    if (purpose === "attach") {
      await attachUnitToChat(u);
      return;
    }
    state.readingsUnit = u;
    prefillReadingsFromUnit(u, { force: true });
    renderReadingsUnitChip();
    setTimeout(() => saveReadingToUnit(), 0);
  }
  async function attachUnitToChat(u) {
    try {
      if (!state.conversationId) {
        await ensureConversation(u.id);
      } else {
        const r = await apiJson(`/api/conversations/${encodeURIComponent(state.conversationId)}`, { method: "PATCH", json: { unit_id: u.id } });
        state.conversation = (r && r.conversation) || r || state.conversation;
      }
      state.unit = u;
      renderHeader();
      renderReadingsUnitChip();
      loadConversations();
      toast(`Attached ${unitLabel(u)}`);
      if (state.route.screen !== "chat") navigate(`#chat/${state.conversationId}`);
    } catch (e) {
      showError(e.code, e.message);
      toast(`${e.code}: ${e.message}`);
    }
  }

  /* ---- unit card: readings history + trend ---- */
  function buildReadingsCard(pu, u) {
    const readings = pu.readings || [];
    const card = h("div", { class: "card readings-card" },
      h("div", { class: "card-title" }, h("span", { text: `Readings (${readings.length})` }),
        h("button", { class: "text-btn", type: "button", text: "Add", onclick: () => { state.readingsUnit = u; prefillReadingsFromUnit(u, { force: true }); navigate("#readings"); } })));
    if (pu.trend && Array.isArray(pu.trend.deltas) && pu.trend.deltas.length) card.append(buildTrendCallout(pu.trend));
    if (pu.readingsFailed) card.append(h("div", { class: "list-empty", text: "Could not load the readings history." }));
    else if (!readings.length) card.append(h("div", { class: "list-empty", text: "No saved readings yet. Diagnose on the Readings tab and tap Save to unit; the next visit then shows the trend." }));
    else card.append(h("div", { class: "list rd-list", role: "list" }, ...readings.map((r) => readingRow(r, u))));
    return card;
  }
  function buildTrendCallout(trend) {
    return h("div", { class: "trend-callout", role: "note" },
      h("div", { class: "trend-title" }, icon("wave", "icon icon-sm"), h("span", { text: `Trend since last visit · ${ymdLabel(trend.since)}` })),
      h("div", { class: "chip-row" }, ...trend.deltas.map((d) => h("span", { class: `chip trend-chip ${d.direction}`, text: formatDelta(d) }))),
      h("details", { class: "trend-more" },
        h("summary", null, icon("chevron", "icon icon-sm"), h("span", { text: `What this suggests (${trend.deltas.length})` })),
        h("ul", { class: "trend-lines" }, ...trend.deltas.map((d) => h("li", { text: d.line }))),
      ),
    );
  }
  function readingRow(r, u) {
    const sm = readingSummary(r);
    const detail = h("div", { class: "rd-detail", hidden: true });
    const expand = h("button", { class: "icon-btn rd-expand", type: "button", "aria-expanded": "false", "aria-label": `Show every value from ${sm.title}` }, icon("chevron", "icon icon-sm"));
    expand.addEventListener("click", () => {
      const open = detail.hidden;
      if (open && !detail.childElementCount) {
        detail.append(h("div", { class: "rd-kv" }, ...readingDetailRows(r).map((row) => h("div", { class: "kv" }, h("span", { class: "kv-key", text: row.label }), h("span", { class: "kv-value", text: row.value })))));
        if (!sm.valid && r.validity && r.validity.issues && r.validity.issues.length) detail.append(h("div", { class: "dc-warn", text: `Not valid for charge determination: ${r.validity.issues.join("; ")}` }));
        if (sm.note) detail.append(h("p", { class: "dc-summary", text: sm.note }));
        detail.append(h("div", { class: "btn-row" },
          h("button", { class: "btn btn-sm", type: "button", onclick: () => insertIntoComposer(composeReadingsMessage(r.measurements || {}, r.derived || null)) }, icon("send", "icon icon-sm"), "Send to chat"),
        ));
      }
      detail.hidden = !open;
      expand.setAttribute("aria-expanded", String(open));
      expand.classList.toggle("open", open);
    });
    const row = h("div", { class: "rd-row" },
      h("div", { class: `row-lead ${sm.valid ? "ok" : "warn"}` }, icon("gauge")),
      h("div", { class: "row-body" },
        h("div", { class: "row-title", text: sm.title }),
        h("div", { class: "row-sub rd-vals" }, h("span", { text: sm.values })),
        h("div", { class: "row-sub" }, h("span", { class: "muted", text: `${sm.source === "chat" ? "From chat" : sm.source === "import" ? "Imported" : "Readings sheet"}${sm.valid ? "" : " · not valid for charge"}${sm.note ? ` · ${sm.note}` : ""}` })),
      ),
      h("div", { class: "rd-actions" }, expand, h("button", { class: "icon-btn", type: "button", "aria-label": `Delete reading from ${sm.title}`, onclick: () => deleteReading(r, u) }, icon("trash", "icon icon-sm"))),
    );
    return h("div", { class: "rd-item", role: "listitem" }, row, detail);
  }
  async function deleteReading(r, u) {
    if (!confirm("Delete this saved reading? The trend will use the remaining readings.")) return;
    try {
      await apiJson(`/api/units/${encodeURIComponent(u.id)}/readings/${encodeURIComponent(r.id)}`, { method: "DELETE" });
      toast("Reading deleted");
      loadUnitPanel(u.id, { quiet: true });
    } catch (e) {
      toast(`${e.code}: ${e.message}`);
    }
  }

  /* ---- finding sheet (add / edit, with follow-up due date) ---- */
  let findingEdit = null; // {unitId, finding|null}
  async function showFindingSheet(unitId, findingId) {
    const pu = state.panelUnit && state.panelUnit.unit.id === unitId ? state.panelUnit : null;
    const u = (pu && pu.unit) || state.unitsById.get(unitId) || (state.ctx && state.ctx.unit.id === unitId ? state.ctx.unit : null);
    let finding = null;
    if (findingId) {
      finding = (pu && pu.findings.find((f) => f.id === findingId)) || (state.ctx && state.ctx.findings.find((f) => f.id === findingId)) || null;
      if (!finding) {
        try {
          const j = await apiJson(`/api/findings/${encodeURIComponent(findingId)}`);
          finding = (j && j.finding) || null;
        } catch (e) {
          toast(`${e.code}: ${e.message}`);
        }
        if (state.route.sheet !== "finding" || state.route.finding !== findingId) return; // navigated away meanwhile
        if (!finding) return closeSheets();
      }
    }
    findingEdit = { unitId, finding };
    fx.findingTitle.textContent = finding ? "Edit finding" : "Add a finding";
    fx.findingSub.textContent = u ? [unitLabel(u), u.site].filter(Boolean).join(" · ") : "";
    fx.fiSymptom.value = finding ? finding.symptom || "" : "";
    fx.fiCause.value = finding ? finding.cause || "" : "";
    fx.fiResolution.value = finding ? finding.resolution || "" : "";
    fx.fiStatus.value = finding ? finding.status || "open" : "open";
    fx.fiCircuit.value = finding ? finding.circuit || "" : "";
    fx.fiFollowUp.value = finding ? finding.follow_up || "" : "";
    fx.fiDue.value = finding && finding.follow_up_due ? finding.follow_up_due : "";
    fx.fiDone.checked = !!(finding && Number(finding.follow_up_done) === 1);
    fx.fiDoneRow.hidden = !finding;
    fx.findingError.hidden = true;
    showSheet(els.sheetFinding);
  }
  fx.findingForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!findingEdit) return;
    const symptom = fx.fiSymptom.value.trim();
    if (!symptom) {
      fx.findingError.hidden = false;
      fx.findingError.textContent = "Symptom is required.";
      fx.fiSymptom.focus();
      return;
    }
    const followUp = fx.fiFollowUp.value.trim() || null;
    const body = {
      symptom,
      cause: fx.fiCause.value.trim() || null,
      resolution: fx.fiResolution.value.trim() || null,
      status: fx.fiStatus.value,
      circuit: fx.fiCircuit.value.trim() || null,
      follow_up: followUp,
      follow_up_due: followUp ? fx.fiDue.value || null : null,
    };
    const { unitId, finding } = findingEdit;
    if (finding) body.follow_up_done = fx.fiDone.checked ? 1 : 0;
    else {
      body.unit_id = unitId;
      if (state.conversationId && state.unit && state.unit.id === unitId) body.conversation_id = state.conversationId;
    }
    fx.btnFindingSave.disabled = true;
    try {
      if (finding) await apiJson(`/api/findings/${encodeURIComponent(finding.id)}`, { method: "PATCH", json: body });
      else await apiJson("/api/findings", { method: "POST", json: body });
      toast(finding ? "Finding updated" : "Finding saved");
      closeSheets();
      if (state.panelUnit && state.panelUnit.unit.id === unitId) loadUnitPanel(unitId, { quiet: true });
      if (state.ctx && state.ctx.unit.id === unitId) {
        state.ctx = null;
        renderCtxPanel();
      }
      loadFollowUps({ quiet: true });
    } catch (err) {
      fx.findingError.hidden = false;
      fx.findingError.textContent = `${err.code}: ${err.message}`;
    } finally {
      fx.btnFindingSave.disabled = false;
    }
  });

  /* ---- History: follow-ups section + tab badge ---- */
  async function loadFollowUps({ quiet = false } = {}) {
    const status = state.followups && state.followups.status === "done" ? "done" : "open";
    try {
      const json = await apiJson(`/api/followups?status=${status}&limit=100`);
      state.followups = { status, items: pickList(json, "followups"), counts: (json && json.counts) || {}, today: (json && json.today) || localYmd() };
      renderFollowUps();
      renderHistoryBadge();
    } catch (e) {
      if (quiet) return;
      fx.followups.hidden = false;
      fx.followups.textContent = "";
      fx.followups.append(h("div", { class: "list-empty", text: `Could not load follow-ups: ${e.message}` }));
    }
  }
  function renderHistoryBadge() {
    const n = state.followups && state.followups.counts ? Number(state.followups.counts.overdue || 0) : 0;
    for (const el of fx.historyCounts) {
      el.hidden = !(n > 0);
      el.textContent = n > 99 ? "99+" : String(n);
      el.setAttribute("aria-label", `${n} overdue follow-up${n === 1 ? "" : "s"}`);
    }
  }
  function renderFollowUps() {
    const fu = state.followups;
    const box = fx.followups;
    box.textContent = "";
    if (!fu) {
      box.hidden = true;
      return;
    }
    const { items, counts, status } = fu;
    const openCount = Number(counts.open || 0);
    if (status === "open" && !items.length && !openCount) {
      box.hidden = true; // nothing to follow up: keep History clean
      return;
    }
    box.hidden = false;
    box.append(h("div", { class: "card-title" },
      h("h2", { id: "followups-title", class: "card-title-text", text: `Follow-ups (${status === "open" ? openCount : items.length})` }),
      h("button", { class: "text-btn", type: "button", text: status === "open" ? "Show done" : "Show open", onclick: () => { state.followups.status = status === "open" ? "done" : "open"; loadFollowUps(); } }),
    ));
    if (status === "open" && (counts.overdue || counts.dueThisWeek)) {
      box.append(h("div", { class: "chip-row fu-counts" },
        counts.overdue ? h("span", { class: "chip chip-danger", text: `${counts.overdue} overdue` }) : null,
        counts.dueThisWeek ? h("span", { class: "chip chip-warn", text: `${counts.dueThisWeek} due this week` }) : null,
      ));
    }
    if (!items.length) box.append(h("div", { class: "list-empty", text: status === "open" ? "Nothing open." : "No completed follow-ups yet." }));
    else box.append(h("div", { class: "list fu-list", role: "list" }, ...items.map(followUpRow)));
  }
  /** Follow-up text longer than this gets the two-line clamp and a More button. */
  const FU_CLAMP_CHARS = 90;
  function followUpRow(f) {
    const chip = dueChip(f.follow_up_due, f.follow_up_done, state.followups.today);
    const done = Number(f.follow_up_done) === 1;
    const unitTitle = [f.unit_tag || f.unit_nickname || f.unit_model || "No unit", f.unit_site].filter(Boolean).join(" · ");
    const check = h("button", { class: `fu-check${done ? " done" : ""}`, type: "button", role: "checkbox", "aria-checked": String(done), "aria-label": `${done ? "Reopen" : "Done"}: ${f.follow_up}`, onclick: () => toggleFollowUp(f) }, icon("check", "icon icon-sm"));
    const open = () => {
      if (f.unit_id) navigate(`#unit/${f.unit_id}`);
      else if (f.conversation_id) navigate(`#chat/${f.conversation_id}`);
    };
    // Long follow-ups (the assistant sometimes writes a paragraph) are clamped to two lines; "More" expands in place.
    const text = h("div", { class: "fu-text fu-clamp", text: f.follow_up });
    const long = (f.follow_up || "").length > FU_CLAMP_CHARS;
    const more = long
      ? h("button", { class: "text-btn fu-more", type: "button", "aria-expanded": "false", text: "More", onclick: (e) => {
          e.stopPropagation();
          const expanded = text.classList.toggle("fu-clamp");
          more.textContent = expanded ? "More" : "Less";
          more.setAttribute("aria-expanded", expanded ? "false" : "true");
        } })
      : null;
    const sub = [];
    if (chip.kind !== "none") sub.push(h("span", { class: `chip due-chip ${chip.kind}`, text: chip.label }));
    const context = f.conversation_title || f.symptom || "";
    if (context) sub.push(h("span", { class: "fu-context", text: context }));
    const body = h("button", { class: "fu-body", type: "button", onclick: open },
      h("div", { class: "row-title", text: unitTitle }),
      text,
      sub.length ? h("div", { class: "row-sub" }, ...sub) : null,
    );
    return h("div", { class: `fu-row${done ? " done" : ""}`, role: "listitem" }, check, h("div", { class: "fu-main" }, body, more));
  }
  async function toggleFollowUp(f) {
    const next = Number(f.follow_up_done) === 1 ? 0 : 1;
    try {
      await apiJson(`/api/findings/${encodeURIComponent(f.id)}`, { method: "PATCH", json: { follow_up_done: next } });
      toast(next ? "Follow-up done" : "Follow-up reopened");
      await loadFollowUps({ quiet: true });
      if (state.panelUnit && f.unit_id && state.panelUnit.unit.id === f.unit_id) loadUnitPanel(f.unit_id, { quiet: true });
    } catch (e) {
      toast(`${e.code}: ${e.message}`);
    }
  }

  /* ---------- init ---------- */
  let booted = false;
  async function init() {
    if (noServerConfigured()) {
      // Bundled build with no server yet: go straight to Settings with the prompt instead of a wall of errors.
      booted = true;
      renderReadingsUnitChip();
      navigate("#settings", { replace: true });
      renderNoServer();
      return;
    }
    loadHealth();
    loadRefrigerants();
    await loadUnits();
    loadConversations();
    loadFollowUps({ quiet: true });
    if (!booted) {
      booted = true;
      const r = parseHash(currentHash());
      if (r.screen === "chat" && !r.conv && !r.isNew) {
        const last = store.get("hvac.lastConversation");
        if (last && /^[0-9a-f]{16}$/.test(last)) setHashSilently(`#chat/${last}`);
      }
      if (!location.hash) setHashSilently(currentHash());
      applyRoute();
      if (state.route.screen === "chat" && state.route.conv) await openConversation(state.route.conv, { silent: true });
      renderHeader();
    }
  }
  renderMessages();
  renderHeader();
  renderDemoBanner();
  renderReadingsUnitChip();
  renderInstallState();
  registerServiceWorker();
  init();
}

/* ------------------------------------------------------------------------------------------
 * Exports for tests + guarded boot
 * ---------------------------------------------------------------------------------------- */

globalThis.HVAC_UI = {
  // readings history + follow-ups
  readingSummary, readingDetailRows, formatDelta, dueChip, localYmd, ymdLabel, addDaysYmd, readingDateLabel, MODE_SHORT, READING_MEASUREMENT_FIELDS, READING_DERIVED_FIELDS,
  parseSseFrames, escapeHtml, relTime, dayLabel, groupUnitsBySite, unitLabel, unitBadgeText, sortFindings, isHypothesis,
  needsNameplateVerify, toNum, buildMeasurements, composeReadingsMessage, composeCalcMessage, pickList, fmtNum,
  parseHash, groupSearchHits, filterUnits, timeOfDay,
  pumpSse, conversationFingerprint, dropLocalEcho, serverReachable, healthRetryDelay,
  formatUsd, formatTokens, formatCount, barWidths, usageBarMetric, usageDayRows, usageDayLabel, aiStatusCopy,
  apiKeyFieldCopy, apiKeyProblem, mergeModelLists, testResultCopy, demoBannerMode, correctionsExportToast, EFFORT_LEVELS,
  importTemplateText, importSummaryText, importButtonLabel, importRowText, canApplyCorrection, correctionPrefill,
  correctionsExportFilename, CORRECTION_FIELDS, APPLICABLE_CORRECTION_FIELDS,
  truncateText, filenameFromDisposition, reportFilename, reportShareText, reportSharePayload, appBaseUrl, unitUrl, labelText,
  qrMatrix, qrPathFromMatrix, qrSvgMarkup, labelsDocumentHtml, serverUrlPrompt,
  DECODE_PROMPT, QUICK_PROMPTS, FALLBACK_REFRIGERANTS, APP_VERSION, SSE_IDLE_MS,
};

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
