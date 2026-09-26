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
  const r = { screen: "chat", conv: null, unit: null, sheet: null, pane: "dx", isNew: false };
  switch (parts[0]) {
    case undefined:
    case "chat":
      r.screen = "chat";
      if (parts[1] === "new") r.isNew = true;
      else if (isId(parts[1])) r.conv = parts[1];
      break;
    case "units":
      r.screen = "units";
      if (parts[1] === "decode") r.sheet = "decode";
      break;
    case "unit":
      r.screen = "units";
      if (isId(parts[1])) r.unit = parts[1];
      if (parts[2] === "actions") r.sheet = "actions";
      else if (parts[2] === "edit") r.sheet = "decode";
      break;
    case "readings":
      r.screen = "readings";
      if (parts[1] === "calcs") r.pane = "calcs";
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

/* ------------------------------------------------------------------------------------------
 * Browser app
 * ---------------------------------------------------------------------------------------- */

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
    const init = { method: opts.method || "GET", headers, body, signal: opts.signal, cache: "no-store" };
    let res;
    try {
      res = await fetch(apiBase() + path, init);
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new ApiFailure("network", `Network error: ${e && e.message ? e.message : "request failed"}`, 0);
    }
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
    hideSheet(els.sheetDecode);
    hideSheet(els.sheetUnitActions);
    els.backdrop.hidden = true;
    if (r.sheet === "decode") showDecodeSheet(r.unit);
    else if (r.sheet === "actions" && r.unit) showUnitActions(r.unit);

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
      if (state.unit) prefillReadingsFromUnit(state.unit);
      renderReadingsUnitChip();
      requestWake();
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
  function setInert(on) {
    // The page behind a sheet is inert for keyboard and AT; aria-hidden is the fallback for browsers without `inert`.
    if ("inert" in els.app) els.app.inert = on;
    if (on) els.app.setAttribute("aria-hidden", "true");
    else els.app.removeAttribute("aria-hidden");
  }
  function showSheet(sheet) {
    const noneOpen = els.sheetDecode.hidden && els.sheetUnitActions.hidden;
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
    if (wasOpen && els.sheetDecode.hidden && els.sheetUnitActions.hidden) {
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
  for (const sheet of [els.sheetDecode, els.sheetUnitActions]) sheet.addEventListener("keydown", trapTab);
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
  function updateOnline(serverDown = state.serverDown) {
    const off = navigator.onLine === false;
    state.serverDown = !!serverDown;
    els.offline.hidden = !(off || serverDown);
    const text = els.offline.querySelector("span");
    if (text) text.textContent = off ? "Offline — chat needs a connection. Calculators and cached data still work." : "Server unreachable — chat is paused. Calculators and cached data still work.";
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
      banner.append(h("button", { class: "icon-btn", type: "button", "aria-label": "Dismiss", onclick: () => banner.remove() }, icon("close", "icon icon-sm")));
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
    doc.title = state.conversation && state.conversation.title ? `${state.conversation.title} · HVAC Field Assistant` : "HVAC Field Assistant";
    renderCtxPanel();
  }
  els.btnChatUnit.addEventListener("click", () => {
    if (state.unit) navigate(`#unit/${state.unit.id}`);
    else {
      navigate("#units");
      toast("Pick a unit, then tap Attach to conversation");
    }
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

  function applyConversation(data) {
    state.conversation = data.conversation || null;
    state.unit = data.unit || null;
    state.ctx = null;
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    state.busy = !!data.busy;
    state.stickToBottom = true;
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

  async function reconcile() {
    if (!state.conversationId || state.streaming) return;
    try {
      const data = await apiJson(`/api/conversations/${encodeURIComponent(state.conversationId)}`);
      applyConversation(data);
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

  async function sendMessage(text, images) {
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
    els.composerInput.value = "";
    autoGrow();
    clearPendingImages();

    const body = { text: trimmed };
    if (images && images.length) body.images = images.map((i) => ({ media_type: i.media_type, data: i.data }));
    await streamTurn(convId, body);
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

  async function streamTurn(convId, body) {
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
    try {
      const res = await api(`/api/conversations/${encodeURIComponent(convId)}/messages`, { method: "POST", json: body, signal: ac.signal, headers: { Accept: "text/event-stream" } });
      if (res.status === 409) {
        busy409 = true;
      } else if (!res.ok) {
        const err = await readError(res);
        showError(err.code, err.message);
      } else if (!res.body) {
        showError("internal", "Streaming is not supported by this browser.");
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parsed = parseSseFrames(buf);
          buf = parsed.rest;
          for (const ev of parsed.events) {
            onEvent(ev);
            if (ev && (ev.type === "done" || ev.type === "error")) terminal = ev;
          }
        }
        buf += decoder.decode();
        const tail = parseSseFrames(buf + "\n\n");
        for (const ev of tail.events) {
          onEvent(ev);
          if (ev && (ev.type === "done" || ev.type === "error")) terminal = ev;
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
      return;
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
      // Stream dropped without a terminal event: the server keeps running; poll until it finishes.
      if (state.busy) {
        showBusyBanner();
        startPolling();
      }
    }
    loadConversations();
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
    sendMessage(els.composerInput.value, state.pendingImages.slice());
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
  function clearPendingImages() {
    state.pendingImages = [];
    renderPreviews();
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
        h("div", { class: "row-sub" }, convUnitBadge(c), h("span", { text: [relTime(c.updated_at || c.created_at), c.summary].filter(Boolean).join(" · ") })),
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
      const data = await apiJson(`/api/units/${encodeURIComponent(unitId)}`);
      const unit = data.unit || data;
      let decoded = data.decoded || null;
      if (!decoded && unit.decoded_json) {
        try {
          decoded = JSON.parse(unit.decoded_json);
        } catch {
          decoded = null;
        }
      }
      state.panelUnit = { unit, decoded, findings: pickList(data.findings || [], "findings"), conversations: pickList(data.conversations || [], "conversations") };
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
      ) : null,
    );
  }

  function buildFindingsCard(findingsRaw, { onChanged } = {}) {
    const findings = sortFindings(findingsRaw || []);
    const fcard = h("div", { class: "card" }, h("div", { class: "card-title" }, h("span", { text: `Findings (${findings.length})` })));
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

    // Decode details
    if (d) {
      const card = h("div", { class: "card" }, h("div", { class: "card-title", text: "Decoded from the nameplate" }));
      card.append(renderDecodeCard(d, { compact: false }));
      els.unitContent.append(card);
    }

    // Findings timeline
    els.unitContent.append(buildFindingsCard(pu.findings));

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
    if (f.follow_up) item.append(h("div", { class: "tl-line" }, h("b", { text: "Follow-up: " }), f.follow_up));
    const actions = h("div", { class: "tl-actions" });
    if (!Number(f.confirmed)) actions.append(h("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => patch({ confirmed: 1 }, "Finding confirmed") }, icon("check", "icon icon-sm"), "Confirm"));
    if (f.status !== "resolved") actions.append(h("button", { class: "btn btn-sm", type: "button", text: "Mark resolved", onclick: () => patch({ status: "resolved" }, "Marked resolved") }));
    if (f.status === "open") actions.append(h("button", { class: "btn btn-sm btn-ghost", type: "button", text: "Monitor", onclick: () => patch({ status: "monitor" }, "Set to monitor") }));
    if (f.status === "resolved") actions.append(h("button", { class: "btn btn-sm btn-ghost", type: "button", text: "Reopen", onclick: () => patch({ status: "open" }, "Reopened") }));
    actions.append(h("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => shareFinding(f) }, icon("share", "icon icon-sm"), navigator.share ? "Share" : "Copy"));
    item.append(actions);
    return item;
  }

  async function patchFinding(f, patch, msg, onChanged) {
    try {
      await apiJson(`/api/findings/${encodeURIComponent(f.id)}`, { method: "PATCH", json: patch });
      toast(msg);
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
    const u = state.unit;
    els.readingsUnitChip.hidden = !u;
    els.readingsUnitChip.textContent = u ? unitLabel(u) : "";
    els.readingsSub.textContent = "";
    if (u) els.readingsSub.append(h("span", { text: `${[u.manufacturer, u.model].filter(Boolean).join(" ")} · ${u.refrigerant || "refrigerant?"}` }));
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
    box.append(h("div", { class: "card-title" }, h("span", { text: "Diagnosis" }), r.source && r.source !== "server" ? sourceTag(r.source) : null));
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
    box.append(h("div", { class: "btn-row", style: "margin-top:8px" }, h("button", { class: "btn btn-primary grow", type: "button", onclick: () => sendReadingsToChat(true) }, icon("send"), "Send to chat")));
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
      els.ctxBody.append(buildFindingsCard(c.findings, { onChanged: () => { state.ctx = null; renderCtxPanel(); } }));
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

  /* ---------- settings ---------- */
  function fillSettings() {
    $("s-apibase").value = store.get("hvac.apiBase") || "";
    $("s-token").value = store.get("hvac.token") || "";
    applyTheme(store.get("hvac.theme"));
    renderInstallState();
    renderOfflineInfo();
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
    setStatus(null, "Checking…");
    try {
      const hlth = await apiJson("/api/health");
      state.health = hlth;
      els.demoBadge.hidden = !hlth.demo;
      els.demoBadgeSettings.hidden = !hlth.demo;
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
      els.demoBadge.hidden = true;
      if (isNetworkError(e)) updateOnline(true);
      setStatus(false, e.code === "auth" ? "Password required" : `Unreachable: ${e.message}`);
      els.healthInfo.textContent = "";
      els.healthInfo.append(h("div", { class: "list-empty", text: "Server status unavailable." }));
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

  /* ---------- init ---------- */
  let booted = false;
  async function init() {
    loadHealth();
    loadRefrigerants();
    await loadUnits();
    loadConversations();
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
  renderReadingsUnitChip();
  renderInstallState();
  registerServiceWorker();
  init();
}

/* ------------------------------------------------------------------------------------------
 * Exports for tests + guarded boot
 * ---------------------------------------------------------------------------------------- */

globalThis.HVAC_UI = {
  parseSseFrames, escapeHtml, relTime, dayLabel, groupUnitsBySite, unitLabel, unitBadgeText, sortFindings, isHypothesis,
  needsNameplateVerify, toNum, buildMeasurements, composeReadingsMessage, composeCalcMessage, pickList, fmtNum,
  parseHash, groupSearchHits, filterUnits, timeOfDay,
  DECODE_PROMPT, QUICK_PROMPTS, FALLBACK_REFRIGERANTS, APP_VERSION,
};

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
