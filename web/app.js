/* HVAC Field Assistant — web client (plain ES2020+, no build step).
 *
 * Talks to the HTTP API described in DESIGN.md. Every request goes through api()/apiJson()
 * (configurable base + optional Bearer token). Chat replies stream over SSE via fetch + POST.
 * Pure helpers are exported on globalThis.HVAC_UI so they can be unit-tested outside a browser;
 * boot() only runs when a DOM is present.
 */
"use strict";

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

  /* ---------- DOM helper ---------- */
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
  function svgIcon(path) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const p = doc.createElementNS(ns, "path");
    p.setAttribute("d", path);
    svg.append(p);
    return svg;
  }
  const ICON = {
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
    close: "M6 6l12 12M18 6L6 18",
    unit: "M3 5h18v14H3zM7 9h10M7 13h6",
    chat: "M4 5h16v11H8l-4 4z",
    finding: "M9 12l2 2 4-4M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
    share: "M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 15V3M8 7l4-4 4 4",
  };

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
      openSettings();
      throw new ApiFailure("auth", "Sign-in required — enter the app password in Settings.", 401);
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
    return JSON.parse(text);
  }

  /* ---------- state ---------- */
  const state = {
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
    conversations: [],
    convFilterUnitId: null,
    panelUnit: null, // unit shown in the unit panel {unit, decoded, findings, conversations}
    decoded: null, // last decode result shown in the panel
    pendingImages: [], // {media_type, data, url}
    stickToBottom: true,
    refrigerants: FALLBACK_REFRIGERANTS,
    lastDx: null,
    wakeLock: null,
    wantWake: false,
    health: null,
  };

  const els = {
    sidebar: $("sidebar"), unitpanel: $("unitpanel"), backdrop: $("backdrop"),
    messages: $("messages"), emptyState: $("empty-state"), quickChips: $("quick-chips"), banners: $("banners"),
    composerInput: $("composer-input"), btnSend: $("btn-send"), btnStop: $("btn-stop"), btnAttach: $("btn-attach"),
    fileInput: $("file-input"), fileCamera: $("file-camera"), previews: $("image-previews"),
    search: $("search"), searchResults: $("search-results"), unitsList: $("units-list"), convList: $("conv-list"),
    convFilter: $("conv-filter"), btnConvFilterClear: $("btn-conv-filter-clear"),
    chatTitle: $("chat-title"), chatUnit: $("chat-unit"), topbarTitle: $("topbar-title"), topbarSub: $("topbar-sub"),
    btnConvDelete: $("btn-conv-delete"),
    unitForm: $("unit-form"), unitFormError: $("unit-form-error"), decodeCard: $("decode-card"), unitHeader: $("unit-header"),
    unitActions: $("unit-actions"), findingsSection: $("findings-section"), findingsList: $("findings-list"),
    unitConvsSection: $("unit-convs-section"), unitConvsList: $("unit-convs-list"),
    btnSaveUnit: $("btn-save-unit"), btnAttachUnit: $("btn-attach-unit"), btnNewConvUnit: $("btn-new-conv-unit"),
    btnArchiveUnit: $("btn-archive-unit"), btnClearUnit: $("btn-clear-unit"),
    sheetReadings: $("sheet-readings"), readingsForm: $("readings-form"), readingsResult: $("readings-result"), readingsError: $("readings-error"),
    btnReadingsSend: $("btn-readings-send"), btnReadingsClose: $("btn-readings-close"),
    sheetSettings: $("sheet-settings"), settingsForm: $("settings-form"), settingsError: $("settings-error"), healthInfo: $("health-info"),
    demoBadge: $("demo-badge"), toast: $("toast"), offline: $("offline-banner"), tabbar: $("tabbar"),
    linkExport: $("link-export"),
  };

  const isTouch = (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) || "ontouchstart" in window;
  const isWide = () => window.matchMedia("(min-width: 900px)").matches;

  /* ---------- theme ---------- */
  function applyTheme(pref) {
    if (pref === "light" || pref === "dark") html.setAttribute("data-theme", pref);
    else html.removeAttribute("data-theme");
    const dark = effectiveTheme() === "dark";
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#17191c" : "#f4f5f7");
    const sel = $("s-theme");
    if (sel) sel.value = pref === "light" || pref === "dark" ? pref : "auto";
  }
  function effectiveTheme() {
    const t = html.getAttribute("data-theme");
    if (t === "light" || t === "dark") return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
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
  $("btn-theme").addEventListener("click", toggleTheme);

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

  /* ---------- drawers, sheets, tabs ---------- */
  function setDrawer(side, open) {
    doc.body.classList.toggle(side === "left" ? "drawer-left" : "drawer-right", open);
    if (open) doc.body.classList.remove(side === "left" ? "drawer-right" : "drawer-left");
    $("btn-menu").setAttribute("aria-expanded", String(doc.body.classList.contains("drawer-left")));
    $("btn-unit").setAttribute("aria-expanded", String(doc.body.classList.contains("drawer-right")));
    updateBackdrop();
  }
  function closeDrawers() {
    doc.body.classList.remove("drawer-left", "drawer-right");
    $("btn-menu").setAttribute("aria-expanded", "false");
    $("btn-unit").setAttribute("aria-expanded", "false");
    updateBackdrop();
  }
  function openSheet(sheet) {
    closeSheets();
    sheet.hidden = false;
    updateBackdrop();
    const first = sheet.querySelector("input, select, textarea");
    if (first && !isTouch) first.focus();
    if (sheet === els.sheetReadings) requestWake();
    setTab(sheet === els.sheetReadings ? "readings" : sheet === els.sheetSettings ? "settings" : "chat");
  }
  function closeSheets() {
    if (!els.sheetReadings.hidden) releaseWake();
    els.sheetReadings.hidden = true;
    els.sheetSettings.hidden = true;
    updateBackdrop();
    setTab("chat");
  }
  function updateBackdrop() {
    const open = (!isWide() && (doc.body.classList.contains("drawer-left") || doc.body.classList.contains("drawer-right"))) ||
      !els.sheetReadings.hidden || !els.sheetSettings.hidden;
    els.backdrop.hidden = !open;
  }
  function setTab(name) {
    for (const t of els.tabbar.querySelectorAll(".tab")) {
      if (t.dataset.tab === name) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    }
  }
  els.backdrop.addEventListener("click", () => {
    closeDrawers();
    closeSheets();
  });
  $("btn-menu").addEventListener("click", () => setDrawer("left", !doc.body.classList.contains("drawer-left")));
  $("btn-unit").addEventListener("click", () => setDrawer("right", !doc.body.classList.contains("drawer-right")));
  $("btn-close-sidebar").addEventListener("click", closeDrawers);
  $("btn-close-unit").addEventListener("click", closeDrawers);
  els.btnReadingsClose.addEventListener("click", closeSheets);
  $("btn-settings-close").addEventListener("click", closeSheets);
  els.tabbar.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (tab === "chat") {
      closeDrawers();
      closeSheets();
    } else if (tab === "units") {
      closeSheets();
      setDrawer("right", true);
      setTab("units");
    } else if (tab === "history") {
      closeSheets();
      setDrawer("left", true);
      setTab("history");
    } else if (tab === "readings") {
      closeDrawers();
      openReadings();
    } else if (tab === "settings") {
      closeDrawers();
      openSettings();
    }
  });
  doc.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDrawers();
      closeSheets();
    }
  });
  window.addEventListener("resize", updateBackdrop);

  /* keyboard inset (composer above the on-screen keyboard) */
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onVv = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      html.style.setProperty("--kb-inset", inset > 40 ? `${inset}px` : "0px");
    };
    vv.addEventListener("resize", onVv);
    vv.addEventListener("scroll", onVv);
  }

  /* ---------- online / offline ---------- */
  function updateOnline() {
    els.offline.hidden = navigator.onLine !== false;
  }
  window.addEventListener("online", () => {
    updateOnline();
    reconcile();
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

  /* ---------- banners ---------- */
  function clearBanner(kind) {
    for (const b of els.banners.querySelectorAll(`[data-kind="${kind}"]`)) b.remove();
  }
  function showBanner(kind, cls, content, opts = {}) {
    clearBanner(kind);
    const body = h("div", { class: "banner-body" }, ...content);
    const banner = h("div", { class: `banner ${cls}`, role: cls === "banner-error" ? "alert" : "status", dataset: { kind } }, body);
    if (opts.dismiss !== false) {
      banner.append(h("button", { class: "icon-btn", type: "button", "aria-label": "Dismiss", onclick: () => banner.remove() }, svgIcon(ICON.close)));
    }
    els.banners.append(banner);
    return banner;
  }
  function showError(code, message) {
    showBanner("error", "banner-error", [h("code", { text: code || "error" }), " ", h("span", { text: message || "Something went wrong." })]);
  }
  function showBusyBanner() {
    showBanner("busy", "banner-info", [h("span", { class: "spinner" }), " ", h("span", { text: "Response in progress on the server — reconnecting…" })], { dismiss: false });
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
      const wrap = h("div", { class: "table-wrap" });
      t.replaceWith(wrap);
      wrap.append(t);
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

  /* ---------- messages ---------- */
  function imageSrc(img) {
    if (!img || !img.data) return "";
    if (String(img.data).startsWith("data:")) return img.data;
    return `data:${img.media_type || "image/jpeg"};base64,${img.data}`;
  }

  function toolChip(t) {
    const chip = h("details", { class: `tool-chip ${t.ok === true ? "ok" : t.ok === false ? "err" : "running"}`, dataset: { toolId: t.id } });
    const status = t.ok === true ? "✓" : t.ok === false ? "✗" : "";
    const summary = h("summary", null,
      t.ok === undefined ? h("span", { class: "spinner" }) : h("span", { class: "tool-status", text: status }),
      h("span", { class: "tool-label", text: t.label || t.name || "tool" }),
      h("span", { class: "tool-summary", text: t.summary || (t.ok === undefined ? "running…" : "") }),
    );
    let inputText = "";
    try {
      inputText = typeof t.input === "string" ? t.input : JSON.stringify(t.input ?? {}, null, 2);
    } catch {
      inputText = String(t.input);
    }
    const body = h("div", { class: "tool-body" },
      h("div", { class: "tool-body-title", text: "Input" }),
      h("pre", { text: inputText }),
      h("div", { class: "tool-body-title", text: "Result" }),
      h("pre", { class: "tool-result", text: t.summary || (t.ok === undefined ? "…" : "") }),
    );
    chip.append(summary, body);
    return chip;
  }

  function updateToolChip(chip, { ok, summary }) {
    chip.classList.remove("running", "ok", "err");
    chip.classList.add(ok ? "ok" : "err");
    const sum = chip.querySelector("summary");
    const spinner = sum.querySelector(".spinner");
    if (spinner) spinner.replaceWith(h("span", { class: "tool-status", text: ok ? "✓" : "✗" }));
    sum.querySelector(".tool-summary").textContent = summary || "";
    chip.querySelector(".tool-result").textContent = summary || "";
  }

  function renderMessage(m) {
    const time = h("div", { class: "msg-time", text: relTime(m.createdAt) });
    if (m.role === "user") {
      const wrap = h("div", { class: "msg msg-user", dataset: { id: m.id } });
      if (m.images && m.images.length) {
        wrap.append(h("div", { class: "thumbs" }, ...m.images.map((img) => h("img", { src: imageSrc(img), alt: "Attached photo", loading: "lazy" }))));
      }
      if (m.text) wrap.append(h("div", { class: "bubble", text: m.text }));
      wrap.append(time);
      return wrap;
    }
    const wrap = h("div", { class: "msg msg-assistant", dataset: { id: m.id } });
    if (m.tools && m.tools.length) wrap.append(...m.tools.map(toolChip));
    if (m.text) wrap.append(renderMarkdown(m.text));
    wrap.append(time);
    return wrap;
  }

  function renderMessages() {
    const list = els.messages;
    const wasStuck = state.stickToBottom;
    for (const n of [...list.children]) if (n !== els.emptyState) n.remove();
    let lastDay = "";
    for (const m of state.messages) {
      const k = dayKey(m.createdAt);
      if (k && k !== lastDay) {
        list.append(h("div", { class: "day-sep", text: dayLabel(m.createdAt) }));
        lastDay = k;
      }
      list.append(renderMessage(m));
    }
    const empty = state.messages.length === 0 && !state.streaming;
    els.emptyState.hidden = !empty;
    els.quickChips.hidden = !empty;
    if (wasStuck) scrollToBottom();
  }

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
  els.messages.addEventListener("scroll", () => {
    const el = els.messages;
    state.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  });

  /* ---------- conversation header ---------- */
  function renderHeader() {
    const title = state.conversation ? state.conversation.title || "New conversation" : "New conversation";
    els.chatTitle.textContent = title;
    els.topbarTitle.textContent = title;
    els.chatUnit.textContent = "";
    els.topbarSub.textContent = "";
    if (state.unit) {
      const label = [unitBadgeText(state.unit), state.unit.manufacturer, state.unit.site].filter(Boolean).join(" · ");
      els.chatUnit.append(h("span", { class: "badge", text: unitBadgeText(state.unit) }), h("span", { text: [state.unit.manufacturer, state.unit.model !== unitBadgeText(state.unit) ? state.unit.model : "", state.unit.site].filter(Boolean).join(" · ") }));
      els.topbarSub.textContent = label;
    } else if (state.conversation) {
      els.chatUnit.append(h("button", { class: "text-btn", type: "button", text: "Attach a unit", onclick: () => { closeSheets(); setDrawer("right", true); } }));
    }
    els.btnConvDelete.hidden = !state.conversation;
  }

  /* ---------- load conversation ---------- */
  async function openConversation(id, { silent = false } = {}) {
    if (state.streaming && state.conversationId !== id) {
      if (!confirm("A response is still streaming. Leave this conversation?")) return;
      stopStream(true);
    }
    stopPolling();
    state.conversationId = id;
    store.set("hvac.lastConversation", id);
    closeDrawers();
    if (!silent) {
      clearBanner("error");
      els.messages.append(h("div", { class: "skeleton", dataset: { skeleton: "1" } }));
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
        return;
      }
      showError(e.code, e.message);
    }
    markActiveRows();
  }

  function applyConversation(data) {
    state.conversation = data.conversation || null;
    state.unit = data.unit || null;
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
    if (state.unit && (!state.panelUnit || state.panelUnit.unit.id !== state.unit.id)) loadUnitPanel(state.unit.id, { quiet: true });
    updateUnitActions();
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
    renderMessages();
    renderHeader();
    updateUnitActions();
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
    loadConversations();
    return conv.id;
  }

  async function sendMessage(text, images) {
    const trimmed = (text || "").trim();
    if (!trimmed && !(images && images.length)) return;
    if (state.streaming) return toast("Wait for the current response (or press Stop).");
    if (state.busy) return toast("A response is still in progress on the server.");
    clearBanner("error");
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
    else if (els.sheetReadings.hidden) releaseWake();
  }

  async function streamTurn(convId, body) {
    const ac = new AbortController();
    state.abort = ac;
    setStreaming(true);

    // live assistant element: text segments and tool chips appended in stream order
    const live = h("div", { class: "msg msg-assistant streaming" });
    els.messages.append(live);
    let seg = null;
    let segText = "";
    let raf = 0;
    const chips = new Map();
    const flush = () => {
      raf = 0;
      if (!seg) return;
      const fresh = renderMarkdown(segText);
      fresh.classList.add("md-seg");
      seg.replaceWith(fresh);
      seg = fresh;
      if (state.stickToBottom) scrollToBottom();
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onEvent = (ev) => {
      if (!ev || typeof ev !== "object") return;
      switch (ev.type) {
        case "delta":
          if (!seg) {
            seg = h("div", { class: "md md-seg" });
            live.append(seg);
            segText = "";
          }
          segText += ev.text || "";
          schedule();
          break;
        case "tool_start": {
          if (raf) {
            cancelAnimationFrame(raf);
            flush();
          }
          seg = null;
          const chip = toolChip({ id: ev.id, name: ev.name, input: ev.input, label: ev.label });
          chips.set(ev.id, chip);
          live.append(chip);
          if (state.stickToBottom) scrollToBottom();
          break;
        }
        case "tool_end": {
          const chip = chips.get(ev.id);
          if (chip) updateToolChip(chip, { ok: !!ev.ok, summary: ev.summary });
          break;
        }
        case "notice":
          live.append(h("div", { class: "notice", text: ev.text || "" }));
          if (state.stickToBottom) scrollToBottom();
          break;
        case "unit_attached":
          if (ev.unitId) {
            loadUnitPanel(ev.unitId, { quiet: true }).then(() => {
              if (state.panelUnit && state.panelUnit.unit.id === ev.unitId) {
                state.unit = state.panelUnit.unit;
                renderHeader();
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
      live.classList.remove("streaming");
      state.abort = null;
      setStreaming(false);
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
    closeSheets();
    closeDrawers();
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
  els.fileInput.addEventListener("change", async () => {
    const files = [...(els.fileInput.files || [])];
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
  });
  els.fileCamera.addEventListener("change", async () => {
    const f = els.fileCamera.files && els.fileCamera.files[0];
    if (!f) return;
    try {
      const img = await resizeImage(f);
      await sendMessage(DECODE_PROMPT, [img]);
    } catch (e) {
      toast(`Could not read image: ${e.message || e}`);
    }
  });

  function renderPreviews() {
    els.previews.textContent = "";
    els.previews.hidden = state.pendingImages.length === 0;
    state.pendingImages.forEach((img, i) => {
      els.previews.append(h("div", { class: "preview" },
        h("img", { src: img.url, alt: `Photo ${i + 1}` }),
        h("button", { type: "button", "aria-label": "Remove photo", onclick: () => { state.pendingImages.splice(i, 1); renderPreviews(); } }, svgIcon(ICON.close)),
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
      els.fileCamera.value = "";
      els.fileCamera.click();
    } else if (q === "readings") {
      openReadings();
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

  /* ---------- sidebar: conversations ---------- */
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
      els.convList.textContent = "";
      els.convList.append(h("div", { class: "list-empty", text: `Could not load: ${e.message}` }));
    }
  }

  function convUnitBadge(c) {
    const u = c.unit || state.unitsById.get(c.unit_id);
    const txt = u ? unitBadgeText(u) : c.unit_tag || c.unit_model || "";
    return txt ? h("span", { class: "badge", text: txt }) : null;
  }

  function renderConversations() {
    els.convList.textContent = "";
    if (!state.conversations.length) {
      els.convList.append(h("div", { class: "list-empty", text: state.convFilterUnitId ? "No conversations on this unit yet." : "No conversations yet." }));
      return;
    }
    for (const c of state.conversations) {
      const row = h("button", { class: `row${c.id === state.conversationId ? " active" : ""}`, type: "button", role: "listitem", dataset: { convId: c.id }, onclick: () => openConversation(c.id) },
        h("div", { class: "row-body" },
          h("div", { class: "row-title", text: c.title || "New conversation" }),
          h("div", { class: "row-sub" }, convUnitBadge(c), h("span", { text: relTime(c.updated_at || c.created_at) })),
        ),
      );
      const del = h("button", { class: "icon-btn", type: "button", "aria-label": `Delete conversation ${c.title || ""}`, onclick: () => deleteConversation(c) }, svgIcon(ICON.trash));
      els.convList.append(h("div", { class: "row-item" }, row, del));
    }
  }

  async function deleteConversation(c) {
    if (!confirm(`Delete "${c.title || "this conversation"}"? This cannot be undone.`)) return;
    try {
      await apiJson(`/api/conversations/${encodeURIComponent(c.id)}`, { method: "DELETE" });
      if (state.conversationId === c.id) resetConversation();
      toast("Conversation deleted");
      loadConversations();
      if (state.panelUnit) loadUnitPanel(state.panelUnit.unit.id, { quiet: true });
    } catch (e) {
      showError(e.code, e.message);
    }
  }
  els.btnConvDelete.addEventListener("click", () => state.conversation && deleteConversation(state.conversation));

  function markActiveRows() {
    for (const r of els.convList.querySelectorAll(".row")) r.classList.toggle("active", r.dataset.convId === state.conversationId);
    for (const r of els.unitsList.querySelectorAll(".row")) r.classList.toggle("active", !!state.panelUnit && r.dataset.unitId === state.panelUnit.unit.id);
  }

  $("btn-new-conv").addEventListener("click", () => {
    if (state.streaming) return toast("Wait for the current response first.");
    resetConversation();
    closeDrawers();
    els.composerInput.focus();
  });

  function setConvFilter(unit) {
    state.convFilterUnitId = unit ? unit.id : null;
    els.convFilter.hidden = !unit;
    els.btnConvFilterClear.hidden = !unit;
    els.convFilter.textContent = unit ? `Showing ${unitLabel(unit)}` : "";
    loadConversations();
  }
  els.btnConvFilterClear.addEventListener("click", () => setConvFilter(null));

  /* ---------- sidebar: units ---------- */
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
  $("btn-units-refresh").addEventListener("click", loadUnits);

  function renderUnits() {
    els.unitsList.textContent = "";
    if (!state.units.length) {
      els.unitsList.append(h("div", { class: "list-empty", text: "No units saved yet. Decode a nameplate to add one." }));
      return;
    }
    for (const [site, list] of groupUnitsBySite(state.units)) {
      els.unitsList.append(h("div", { class: "site-group-title", text: site }));
      for (const u of list) {
        const sub = [u.manufacturer, u.model && u.model !== unitLabel(u) ? u.model : "", u.refrigerant, u.tonnage ? `${u.tonnage} t` : ""].filter(Boolean).join(" · ");
        els.unitsList.append(h("button", { class: `row${state.panelUnit && state.panelUnit.unit.id === u.id ? " active" : ""}`, type: "button", role: "listitem", dataset: { unitId: u.id }, onclick: () => selectUnit(u) },
          h("div", { class: "row-lead" }, svgIcon(ICON.unit)),
          h("div", { class: "row-body" }, h("div", { class: "row-title", text: unitLabel(u) }), h("div", { class: "row-sub" }, h("span", { text: sub }))),
        ));
      }
    }
  }

  async function selectUnit(u) {
    setConvFilter(u);
    await loadUnitPanel(u.id);
    if (!isWide()) setDrawer("right", true);
    else closeDrawers();
  }

  /* ---------- sidebar: search ---------- */
  let searchTimer = null;
  let searchSeq = 0;
  els.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = els.search.value.trim();
    if (q.length < 2) {
      els.searchResults.hidden = true;
      els.searchResults.textContent = "";
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 250);
  });
  async function runSearch(q) {
    const seq = ++searchSeq;
    els.searchResults.hidden = false;
    els.searchResults.textContent = "";
    els.searchResults.append(h("div", { class: "skeleton" }));
    try {
      const json = await apiJson(`/api/search?q=${encodeURIComponent(q)}&limit=30`);
      if (seq !== searchSeq) return;
      const hits = pickList(json, "hits");
      els.searchResults.textContent = "";
      if (!hits.length) {
        els.searchResults.append(h("div", { class: "list-empty", text: "No matches." }));
        return;
      }
      for (const hit of hits) {
        const title = hit.kind === "unit" ? "Unit" : hit.kind === "finding" ? "Finding" : hit.conversationTitle || "Message";
        els.searchResults.append(h("button", { class: "row", type: "button", role: "listitem", onclick: () => openSearchHit(hit) },
          h("div", { class: "row-body" },
            h("div", { class: "row-sub" }, h("span", { class: `kind-badge ${hit.kind}`, text: hit.kind }), h("span", { class: "row-title", text: title })),
            h("div", { class: "snippet", text: hit.snippet || "" }),
            h("div", { class: "row-sub" }, h("span", { text: relTime(hit.createdAt) })),
          ),
        ));
      }
    } catch (e) {
      if (seq !== searchSeq) return;
      els.searchResults.textContent = "";
      els.searchResults.append(h("div", { class: "list-empty", text: `Search failed: ${e.message}` }));
    }
  }
  function openSearchHit(hit) {
    if (hit.kind === "message" && hit.conversationId) return openConversation(hit.conversationId);
    if (hit.kind === "unit") return loadUnitPanel(hit.id).then(() => (isWide() ? closeDrawers() : setDrawer("right", true)));
    if (hit.kind === "finding") {
      if (hit.unitId) return loadUnitPanel(hit.unitId).then(() => (isWide() ? closeDrawers() : setDrawer("right", true)));
      if (hit.conversationId) return openConversation(hit.conversationId);
    }
    return undefined;
  }

  /* ---------- unit panel ---------- */
  function unitFormValues() {
    const fd = new FormData(els.unitForm);
    const v = {};
    for (const [k, val] of fd.entries()) v[k] = String(val).trim();
    return v;
  }
  function fillUnitForm(u) {
    const f = els.unitForm.elements;
    f.manufacturer.value = u.manufacturer || u.brand || "";
    f.model.value = u.model || "";
    f.serial.value = u.serial || "";
    f.unit_tag.value = u.unit_tag || "";
    f.nickname.value = u.nickname || "";
    f.site.value = u.site || "";
    f.customer.value = u.customer || "";
    f.elevation_ft.value = u.elevation_ft ?? "";
  }
  function showUnitFormError(msg) {
    els.unitFormError.hidden = !msg;
    els.unitFormError.textContent = msg || "";
  }

  els.unitForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = unitFormValues();
    if (!v.model) return showUnitFormError("Enter the model number to decode.");
    showUnitFormError("");
    const btn = $("btn-decode");
    btn.disabled = true;
    try {
      const body = { model: v.model };
      if (v.serial) body.serial = v.serial;
      if (v.manufacturer) body.manufacturer = v.manufacturer;
      const decoded = await apiJson("/api/decode", { method: "POST", json: body });
      state.decoded = decoded;
      renderDecodeCard(decoded);
      requestWake();
    } catch (err) {
      showUnitFormError(`${err.code}: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  els.btnClearUnit.addEventListener("click", () => {
    els.unitForm.reset();
    state.panelUnit = null;
    state.decoded = null;
    els.decodeCard.hidden = true;
    els.decodeCard.textContent = "";
    els.unitHeader.hidden = true;
    els.findingsSection.hidden = true;
    els.unitConvsSection.hidden = true;
    showUnitFormError("");
    updateUnitActions();
    markActiveRows();
  });

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
      const saved = await apiJson("/api/units", { method: "POST", json: body });
      const unit = saved && saved.unit ? saved.unit : saved;
      toast("Unit saved");
      await loadUnits();
      if (unit && unit.id) await loadUnitPanel(unit.id);
    } catch (err) {
      showUnitFormError(`${err.code}: ${err.message}`);
    } finally {
      els.btnSaveUnit.disabled = false;
    }
  });

  async function loadUnitPanel(unitId, { quiet = false } = {}) {
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
      state.decoded = decoded;
      state.unitsById.set(unit.id, unit);
      fillUnitForm(unit);
      renderUnitHeader(unit);
      if (decoded) renderDecodeCard(decoded);
      else {
        els.decodeCard.hidden = true;
        els.decodeCard.textContent = "";
      }
      renderFindings();
      renderUnitConversations();
      updateUnitActions();
      prefillReadingsFromUnit(unit);
      markActiveRows();
      if (state.unit && state.unit.id === unit.id) {
        state.unit = unit;
        renderHeader();
      }
    } catch (e) {
      if (!quiet) showUnitFormError(`${e.code}: ${e.message}`);
    }
  }

  function renderUnitHeader(u) {
    els.unitHeader.hidden = false;
    els.unitHeader.textContent = "";
    els.unitHeader.append(
      h("div", { class: "uh-tag", text: [u.unit_tag, u.nickname].filter(Boolean).join(" · ") || "Unit" }),
      h("div", { class: "uh-model", text: [u.manufacturer || u.brand, u.model].filter(Boolean).join(" ") || "No model on record" }),
      h("div", { class: "uh-sub", text: [u.site, u.customer, u.serial ? `S/N ${u.serial}` : "", u.refrigerant, u.tonnage ? `${u.tonnage} ton` : "", u.voltage ? `${u.voltage}${u.phase ? "/" + u.phase : ""}` : ""].filter(Boolean).join(" · ") }),
    );
  }

  function updateUnitActions() {
    const pu = state.panelUnit;
    els.unitActions.hidden = !pu;
    if (!pu) return;
    const attached = !!(state.unit && state.unit.id === pu.unit.id);
    els.btnAttachUnit.textContent = attached ? "Attached to this conversation" : state.conversationId ? "Attach to conversation" : "Start conversation on this unit";
    els.btnAttachUnit.disabled = attached;
  }

  els.btnAttachUnit.addEventListener("click", async () => {
    const pu = state.panelUnit;
    if (!pu) return;
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
      updateUnitActions();
      loadConversations();
      toast(`Attached ${unitLabel(pu.unit)}`);
      if (!isWide()) closeDrawers();
    } catch (e) {
      showError(e.code, e.message);
    }
  });

  els.btnNewConvUnit.addEventListener("click", async () => {
    const pu = state.panelUnit;
    if (!pu) return;
    if (state.streaming) return toast("Wait for the current response first.");
    resetConversation();
    try {
      await ensureConversation(pu.unit.id);
      state.unit = pu.unit;
      renderHeader();
      updateUnitActions();
      closeDrawers();
      els.composerInput.focus();
    } catch (e) {
      showError(e.code, e.message);
    }
  });

  els.btnArchiveUnit.addEventListener("click", async () => {
    const pu = state.panelUnit;
    if (!pu) return;
    if (!confirm(`Archive ${unitLabel(pu.unit)}? Its findings and conversations are kept; the unit leaves the list.`)) return;
    try {
      await apiJson(`/api/units/${encodeURIComponent(pu.unit.id)}`, { method: "DELETE" });
      toast("Unit archived");
      if (state.convFilterUnitId === pu.unit.id) setConvFilter(null);
      els.btnClearUnit.click();
      loadUnits();
    } catch (e) {
      showError(e.code, e.message);
    }
  });

  const CONF_CLASS = { high: "chip-ok", medium: "chip-warn", low: "chip-danger" };
  const ATTR_LABEL = {
    unit_type: "Unit type", series: "Series", tonnage: "Nominal tons", refrigerant: "Refrigerant", voltage: "Voltage/phase/Hz",
    heat_type: "Heat type", heat_capacity: "Heat capacity", efficiency: "Efficiency", controls: "Controls", revision: "Revision",
    compressor_type: "Compressor", stages: "Stages", airflow: "Airflow", cabinet: "Cabinet", options: "Options", other: "Other",
  };

  function renderDecodeCard(d) {
    const card = els.decodeCard;
    card.hidden = false;
    card.textContent = "";
    const bestModel = d.model && d.model[0];
    const bestSerial = d.serial && d.serial[0];
    const mfr = (d.manufacturerCandidates && d.manufacturerCandidates[0] && d.manufacturerCandidates[0].manufacturer) || d.input?.manufacturer || "Unknown manufacturer";

    card.append(h("div", { class: "dc-head" },
      h("div", { class: "dc-mfr", text: mfr }),
      h("div", { class: "dc-family", text: bestModel ? bestModel.family : d.input?.model || "" }),
      h("div", { class: "dc-type", text: bestModel ? String(bestModel.productType || "").replace(/_/g, " ") : "No model format matched" }),
    ));

    const body = h("div", { class: "dc-body" });
    const chips = h("div", { class: "dc-chips" });
    if (bestModel) chips.append(h("span", { class: `chip ${CONF_CLASS[bestModel.confidence] || ""}`, text: `Model: ${bestModel.confidence}` }));
    if (bestSerial) chips.append(h("span", { class: `chip ${CONF_CLASS[bestSerial.confidence] || ""}`, text: `Serial: ${bestSerial.confidence}${bestSerial.ambiguous ? " (ambiguous)" : ""}` }));
    if (needsNameplateVerify(d)) chips.append(h("span", { class: "chip chip-warn", text: "Verify on nameplate" }));
    body.append(chips);

    if (d.summary) body.append(h("p", { class: "dc-summary", text: d.summary }));

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
      body.append(h("table", { class: "attr-table" }, h("tbody", null, ...rows.map(([k, v]) => h("tr", null, h("th", { scope: "row", text: k }), h("td", { text: v }))))));
    }

    if (bestModel && bestModel.segments && bestModel.segments.length) {
      const det = h("details", null, h("summary", { class: "dc-section-title", text: `Nomenclature breakdown (${bestModel.segments.length})` }),
        h("table", { class: "attr-table" }, h("tbody", null, ...bestModel.segments.map((s) => h("tr", null, h("th", { scope: "row", text: `${s.name} · ${s.code}` }), h("td", { text: s.meaning || "—" }))))));
      body.append(det);
    }

    if (d.controls && d.controls.length) {
      body.append(h("div", { class: "dc-section-title", text: "Control platforms" }));
      body.append(h("div", null, ...d.controls.map((c) => h("div", { class: "platform" },
        h("span", { text: c.name }),
        h("span", { class: "chip", text: `${(c.faultCodes || []).length} codes${c.coverage ? ` · ${c.coverage}` : ""}` }),
      ))));
    }

    if (d.warnings && d.warnings.length) {
      body.append(h("div", { class: "dc-warn" }, h("ul", null, ...d.warnings.map((w) => h("li", { text: w })))));
    }

    const notes = [].concat(bestSerial?.notes || [], bestModel?.notes || []);
    if (notes.length) {
      body.append(h("details", null, h("summary", { class: "dc-section-title", text: "Notes" }), h("ul", { class: "dc-list" }, ...notes.map((n) => h("li", { text: n })))));
    }

    if (d.commonIssues && d.commonIssues.length) {
      body.append(h("details", null, h("summary", { class: "dc-section-title", text: `Known issues (${d.commonIssues.length})` }),
        h("ul", { class: "dc-list" }, ...d.commonIssues.map((ci) => h("li", null, h("b", { text: ci.symptom }), ` — ${(ci.likelyCauses || []).join("; ")}`)))));
    }

    if (d.evidenceSummary) body.append(h("p", { class: "dc-summary", text: `Evidence: ${d.evidenceSummary}` }));

    const litUrl = d.support && (d.support.literatureUrl || d.support.url);
    const support = h("div", { class: "btn-row" });
    if (litUrl && /^https?:\/\//i.test(litUrl)) support.append(h("a", { class: "btn", href: litUrl, target: "_blank", rel: "noopener noreferrer", text: "Literature" }));
    if (d.support && d.support.phone) support.append(h("a", { class: "btn", href: `tel:${d.support.phone.replace(/[^\d+]/g, "")}`, text: `Support ${d.support.phone}` }));
    if (support.childElementCount) body.append(support);
    if (d.support && d.support.literatureSearchHint) body.append(h("p", { class: "dc-summary", text: d.support.literatureSearchHint }));

    card.append(body);
  }

  function renderFindings() {
    const pu = state.panelUnit;
    els.findingsSection.hidden = !pu;
    els.findingsList.textContent = "";
    if (!pu) return;
    const findings = sortFindings(pu.findings || []);
    if (!findings.length) {
      els.findingsList.append(h("div", { class: "list-empty", text: "No findings on this unit yet." }));
      return;
    }
    for (const f of findings) {
      const hyp = isHypothesis(f);
      const statusCls = f.status === "open" ? "chip-danger" : f.status === "monitor" ? "chip-warn" : "chip-ok";
      const card = h("div", { class: `finding${hyp ? " hypothesis" : ""}`, role: "listitem" },
        h("div", { class: "finding-head" },
          h("span", { class: `chip ${statusCls}`, text: f.status || "open" }),
          hyp ? h("span", { class: "chip chip-info", text: "Hypothesis — unconfirmed" }) : null,
          Number(f.confirmed) ? h("span", { class: "chip chip-ok", text: "Confirmed" }) : null,
          f.circuit ? h("span", { class: "chip", text: `Circuit ${f.circuit}` }) : null,
          h("span", { class: "row-meta", text: relTime(f.service_date || f.created_at) }),
        ),
        h("div", { class: "finding-symptom", text: f.symptom }),
      );
      if (f.cause) card.append(h("div", { class: "finding-line" }, h("b", { text: "Cause: " }), f.cause));
      if (f.resolution) card.append(h("div", { class: "finding-line" }, h("b", { text: "Fix: " }), f.resolution));
      if (f.refrigerant_added_lbs) card.append(h("div", { class: "finding-line" }, h("b", { text: "Refrigerant added: " }), `${f.refrigerant_added_lbs} lb ${f.refrigerant || ""}`));
      if (f.follow_up) card.append(h("div", { class: "finding-line" }, h("b", { text: "Follow-up: " }), f.follow_up));
      const actions = h("div", { class: "finding-actions" });
      if (!Number(f.confirmed)) {
        actions.append(h("button", { class: "btn btn-sm btn-primary", type: "button", text: "Confirm", onclick: () => confirmFinding(f) }));
      }
      if (navigator.share) {
        actions.append(h("button", { class: "btn btn-sm", type: "button", onclick: () => shareFinding(f) }, svgIcon(ICON.share), "Share"));
      }
      card.append(actions);
      els.findingsList.append(card);
    }
  }

  async function confirmFinding(f) {
    try {
      await apiJson(`/api/findings/${encodeURIComponent(f.id)}`, { method: "PATCH", json: { confirmed: 1 } });
      toast("Finding confirmed");
      if (state.panelUnit) loadUnitPanel(state.panelUnit.unit.id, { quiet: true });
    } catch (e) {
      showError(e.code, e.message);
    }
  }
  function shareFinding(f) {
    const u = state.panelUnit ? state.panelUnit.unit : null;
    const text = [u ? `${unitLabel(u)} (${[u.manufacturer, u.model].filter(Boolean).join(" ")})` : "", `Symptom: ${f.symptom}`, f.cause ? `Cause: ${f.cause}` : "", f.resolution ? `Fix: ${f.resolution}` : "", f.service_date ? `Date: ${f.service_date}` : ""].filter(Boolean).join("\n");
    navigator.share({ title: "HVAC finding", text }).catch(() => {});
  }

  function renderUnitConversations() {
    const pu = state.panelUnit;
    const list = pu ? pu.conversations : [];
    els.unitConvsSection.hidden = !pu || !list.length;
    els.unitConvsList.textContent = "";
    for (const c of list) {
      els.unitConvsList.append(h("button", { class: "row", type: "button", role: "listitem", onclick: () => openConversation(c.id) },
        h("div", { class: "row-lead" }, svgIcon(ICON.chat)),
        h("div", { class: "row-body" }, h("div", { class: "row-title", text: c.title || "New conversation" }), h("div", { class: "row-sub" }, h("span", { text: [relTime(c.updated_at || c.created_at), c.summary].filter(Boolean).join(" · ") }))),
      ));
    }
  }

  /* ---------- readings sheet ---------- */
  function openReadings() {
    if (state.unit) prefillReadingsFromUnit(state.unit);
    openSheet(els.sheetReadings);
  }
  function prefillReadingsFromUnit(u) {
    const f = els.readingsForm.elements;
    if (u.refrigerant && !f.refrigerant.value) setSelectValue(f.refrigerant, u.refrigerant);
    if (u.metering_device && ["txv", "fixed", "eev", "unknown"].includes(u.metering_device)) f.meteringDevice.value = u.metering_device;
    if (u.elevation_ft !== null && u.elevation_ft !== undefined && !f.elevationFt.value) f.elevationFt.value = String(u.elevation_ft);
    for (const el of doc.querySelectorAll(".elevation-input")) if (!el.value && u.elevation_ft !== null && u.elevation_ft !== undefined) el.value = String(u.elevation_ft);
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
  function readingsValues() {
    const fd = new FormData(els.readingsForm);
    const v = {};
    for (const [k, val] of fd.entries()) v[k] = String(val);
    return v;
  }

  els.readingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const m = buildMeasurements(readingsValues());
    els.readingsError.hidden = true;
    if (!m.refrigerant) {
      els.readingsError.hidden = false;
      els.readingsError.textContent = "Pick a refrigerant.";
      return;
    }
    const btn = $("btn-diagnose");
    btn.disabled = true;
    try {
      const result = await apiJson("/api/calc/diagnose", { method: "POST", json: m });
      state.lastDx = result;
      renderDxResult(result);
      requestWake();
    } catch (err) {
      els.readingsError.hidden = false;
      els.readingsError.textContent = `${err.code}: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  const SEV_CLASS = { critical: "chip-danger", warning: "chip-warn", advisory: "chip-info", info: "" };
  const DERIVED_LABEL = {
    evapSatF: ["Evap sat", "°F"], condSatF: ["Cond sat", "°F"], superheatF: ["Superheat", "°F"], subcoolingF: ["Subcooling", "°F"],
    targetSuperheatF: ["Target SH", "°F"], targetSubcoolingF: ["Target SC", "°F"], condenserSplitF: ["Cond split", "°F"], evapTdF: ["Evap TD", "°F"],
    deltaTF: ["Delta-T", "°F"], indoorCoilTdF: ["Indoor coil TD", "°F"], compressionRatio: ["Compression ratio", ""], dischargeSuperheatF: ["Discharge SH", "°F"],
    ampsPercentRla: ["Amps % RLA", "%"], currentImbalancePercent: ["Current imbalance", "%"], drierTempDropF: ["Drier drop", "°F"], standingExcessPsi: ["Standing excess", "psi"], patmPsia: ["Patm", "psia"],
  };

  function renderDxResult(r) {
    const box = els.readingsResult;
    box.hidden = false;
    box.textContent = "";
    if (r.summary) box.append(h("div", { class: "dx-summary", text: r.summary }));
    if (r.validity && !r.validity.ok) {
      box.append(h("div", { class: "dx-validity" }, h("b", { text: "Readings not valid for charge determination" }), h("ul", null, ...(r.validity.issues || []).map((i) => h("li", { text: i })))));
    }
    const derived = r.derived || {};
    const stats = Object.entries(derived).filter(([k, v]) => typeof v === "number" && DERIVED_LABEL[k]);
    if (derived.targetDeltaTF && typeof derived.targetDeltaTF === "object") stats.push(["targetDeltaTF", derived.targetDeltaTF]);
    if (stats.length) {
      box.append(h("div", { class: "derived-grid" }, ...stats.map(([k, v]) => {
        const [label, unit] = DERIVED_LABEL[k] || ["Target ΔT", "°F"];
        const val = typeof v === "number" ? `${fmtNum(v, k === "compressionRatio" ? 2 : 1)}${unit ? " " + unit : ""}` : `${v.min}–${v.max} °F`;
        return h("div", { class: "stat" }, h("div", { class: "stat-label", text: label }), h("div", { class: "stat-value", text: val }));
      })));
    }
    if (r.findings && r.findings.length) {
      box.append(h("div", { class: "dc-section-title", text: "Findings" }));
      for (const f of r.findings) {
        const card = h("div", { class: `dx-finding ${f.severity || ""}` },
          h("div", { class: "dx-finding-head" }, h("span", { class: `chip ${SEV_CLASS[f.severity] || ""}`, text: f.severity }), h("span", { class: `chip ${CONF_CLASS[f.confidence] || ""}`, text: f.confidence }), h("span", { text: f.condition })),
          h("div", { text: f.explanation }),
        );
        if (f.nextChecks && f.nextChecks.length) card.append(h("ul", null, ...f.nextChecks.map((c) => h("li", { text: c }))));
        if (f.safety && f.safety.length) card.append(h("div", { class: "dx-safety", text: f.safety.join(" ") }));
        box.append(card);
      }
    }
    if (r.missing && r.missing.length) {
      box.append(h("div", { class: "dc-section-title", text: "Would sharpen the diagnosis" }), h("ul", { class: "dc-list" }, ...r.missing.map((m) => h("li", { text: m }))));
    }
    box.append(h("div", { class: "btn-row" }, h("button", { class: "btn btn-primary", type: "button", text: "Send readings + result to chat", onclick: () => sendReadingsToChat(true) })));
    // Scroll only the sheet's own scroller: scrollIntoView would also shift the overflow-hidden page ancestors.
    const scroller = box.closest(".sheet-body");
    if (scroller) scroller.scrollTo({ top: Math.max(0, box.offsetTop - scroller.offsetTop - 8), behavior: "smooth" });
  }

  function sendReadingsToChat(withResult) {
    const m = buildMeasurements(readingsValues());
    let text = composeReadingsMessage(m, withResult && state.lastDx ? state.lastDx.derived : null);
    if (withResult && state.lastDx && state.lastDx.summary) text += `\nDiagnose result: ${state.lastDx.summary}`;
    insertIntoComposer(text);
  }
  els.btnReadingsSend.addEventListener("click", () => sendReadingsToChat(false));

  /* ---------- calculators ---------- */
  function renderGeneric(obj, depth = 0) {
    const frag = doc.createDocumentFragment();
    if (!obj || typeof obj !== "object") return frag;
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined || k === "kind") continue;
      if (typeof v === "number") frag.append(h("div", { class: "kv" }, h("span", { text: k }), h("span", { text: fmtNum(v, 2) })));
      else if (typeof v === "string" || typeof v === "boolean") frag.append(h("div", { class: "kv" }, h("span", { text: k }), h("span", { text: String(v) })));
      else if (Array.isArray(v)) {
        if (!v.length) continue;
        frag.append(h("div", { class: k === "warnings" ? "kv-warn" : "", text: k }), h("ul", { class: "kv-list" }, ...v.map((x) => h("li", { text: typeof x === "string" ? x : JSON.stringify(x) }))));
      } else if (typeof v === "object" && depth < 2) {
        frag.append(h("div", { class: "dc-section-title", text: k }), renderGeneric(v, depth + 1));
      }
    }
    return frag;
  }

  const CALC_TITLE = {
    pt: "PT lookup", shsc: "Superheat/subcooling", voltage_imbalance: "Voltage imbalance", capacitor_under_load: "Capacitor under load",
    temp_rise_cfm: "Temp-rise CFM", winding_check: "Winding check", psychrometrics: "Psychrometrics",
  };

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
          const qs = new URLSearchParams({ refrigerant: raw.refrigerant });
          if (toNum(raw.psig) !== undefined) qs.set("psig", String(toNum(raw.psig)));
          else if (toNum(raw.temp_f) !== undefined) qs.set("temp_f", String(toNum(raw.temp_f)));
          else throw new ApiFailure("validation", "Enter a pressure or a temperature.", 0);
          if (toNum(raw.elevation_ft) !== undefined) qs.set("elevation_ft", String(toNum(raw.elevation_ft)));
          result = await apiJson(`/api/reference/pt?${qs}`);
        } else if (kind === "shsc") {
          const body = { refrigerant: raw.refrigerant, meteringDevice: "unknown", mode: "ac_cooling" };
          for (const k of ["suctionPsig", "suctionLineTempF", "liquidPsig", "liquidLineTempF", "elevationFt"]) {
            const n = toNum(raw[k]);
            if (n !== undefined) body[k] = n;
          }
          if (body.suctionPsig === undefined && body.liquidPsig === undefined) throw new ApiFailure("validation", "Enter suction and/or liquid pressure with its line temperature.", 0);
          result = await apiJson("/api/calc/superheat-subcooling", { method: "POST", json: body });
        } else {
          const body = { kind };
          for (const [k, v] of Object.entries(raw)) {
            if (k === "phase") body.phase = Number(v) === 3 ? 3 : 1;
            else {
              const n = toNum(v);
              if (n !== undefined) body[k] = n;
              else if (k !== "ratedUf" && k !== "elevationFt") throw new ApiFailure("validation", `Enter ${k}.`, 0);
            }
          }
          result = await apiJson("/api/calc/electrical", { method: "POST", json: body });
        }
        last = { inputs: raw, result };
        resultBox.textContent = "";
        resultBox.append(renderGeneric(result));
        sendBtn.disabled = false;
      } catch (err) {
        last = null;
        sendBtn.disabled = true;
        resultBox.textContent = "";
        resultBox.append(h("div", { class: "field-error", role: "alert", text: `${err.code || "error"}: ${err.message}` }));
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
      if (ids.length) state.refrigerants = ids;
    } catch {
      /* fallback list stays */
    }
    populateRefrigerantSelects();
    if (state.unit) prefillReadingsFromUnit(state.unit);
  }

  /* ---------- settings ---------- */
  function openSettings() {
    $("s-apibase").value = store.get("hvac.apiBase") || "";
    $("s-token").value = store.get("hvac.token") || "";
    $("s-theme").value = store.get("hvac.theme") || "auto";
    els.linkExport.href = `${apiBase()}/api/export`;
    openSheet(els.sheetSettings);
  }
  els.settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const base = $("s-apibase").value.trim().replace(/\/$/, "");
    if (base && !/^https?:\/\//i.test(base)) {
      els.settingsError.hidden = false;
      els.settingsError.textContent = "API base must start with http:// or https://";
      return;
    }
    els.settingsError.hidden = true;
    store.set("hvac.apiBase", base);
    store.set("hvac.token", $("s-token").value);
    const theme = $("s-theme").value;
    store.set("hvac.theme", theme === "auto" ? null : theme);
    applyTheme(theme);
    closeSheets();
    toast("Settings saved");
    init();
  });

  async function loadHealth() {
    els.healthInfo.textContent = "";
    try {
      const hlth = await apiJson("/api/health");
      state.health = hlth;
      els.demoBadge.hidden = !hlth.demo;
      const bits = [];
      if (hlth.model) bits.push(`model ${hlth.model}`);
      if (hlth.effort) bits.push(`effort ${hlth.effort}`);
      bits.push(`web search ${hlth.webSearch ? "on" : "off"}`);
      if (hlth.packs !== undefined) bits.push(`${hlth.packs} manufacturer packs`);
      if (hlth.refrigerants !== undefined) bits.push(`${hlth.refrigerants} refrigerants`);
      if (hlth.rules !== undefined) bits.push(`${hlth.rules} rules`);
      if (hlth.demo) bits.push("demo mode (no API key)");
      for (const b of bits) els.healthInfo.append(h("span", { class: "chip", text: b }));
    } catch (e) {
      els.healthInfo.append(h("span", { class: "chip chip-danger", text: `Server unreachable: ${e.message}` }));
    }
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
      const last = store.get("hvac.lastConversation");
      if (last && /^[0-9a-f]{16}$/.test(last)) await openConversation(last, { silent: true });
      else renderMessages();
      renderHeader();
    }
  }
  renderMessages();
  renderHeader();
  init();
}

/* ------------------------------------------------------------------------------------------
 * Exports for tests + guarded boot
 * ---------------------------------------------------------------------------------------- */

globalThis.HVAC_UI = {
  parseSseFrames, escapeHtml, relTime, dayLabel, groupUnitsBySite, unitLabel, unitBadgeText, sortFindings, isHypothesis,
  needsNameplateVerify, toNum, buildMeasurements, composeReadingsMessage, composeCalcMessage, pickList, fmtNum,
  DECODE_PROMPT, QUICK_PROMPTS, FALLBACK_REFRIGERANTS,
};

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
