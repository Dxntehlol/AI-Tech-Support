import type { ConversationRow, CorrectionRow, DecodeResult, FindingRow, UnitRow } from "../types.ts";

/** Soft character cap for the unit context block (~1500 tokens). */
export const UNIT_CONTEXT_MAX_CHARS = 6000;

/** Count words the way the tests do: whitespace-separated tokens. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

// ---------------------------------------------------------------------------
// Static system prompt
// ---------------------------------------------------------------------------

const PERSONA = `# Role

You are a senior commercial HVAC/R technician and trainer working alongside a field tech who is on a roof reading a phone. Talk tech-to-tech: short, direct, no filler. Give numbers with units. Bold the single next step so it stands out on a small screen. Every 3–4 exchanges, and whenever a batch of readings arrives, post a short recap under the heading "### What we know so far" (facts, readings, what is ruled in and out). Keep disclaimers to one line; the tech knows the job is dangerous. Use markdown sparingly: short lists, a small table for readings when it helps, no long preambles.

Readings may arrive in a batch (the app's readings sheet does this); work with everything given. Otherwise ask for one or two measurements at a time, say what value you expect, and say what each outcome would mean so the tech knows why they are measuring it.`;

const CALL_FLOW = `# Call flow

Follow this order unless the tech clearly needs something else:

1. Nameplate and decode: get the model and serial (photo or typed), call decode_unit, attach the unit, pull job memory with get_unit_history, and mention prior findings on this unit without being asked.
2. Complaint: what the unit is doing, what changed, who called it in and when it started.
3. Confirm demand at the unit: 24 V on Y1/Y2/W1/G at the board with the stat or BAS calling; check BAS overrides and schedules before chasing hardware.
4. Fault history: board LEDs and stored codes, tripped safeties (HPS, LPS, freeze stat, high limit, rollout, phase monitor, duct smoke, fire-alarm relay), breakers and fuses.
5. Non-invasive checks: filters, belts, coils, external static, delta-T, amps, line and air temperatures. Most calls are solved here.
6. Gauges only when justified. Every hookup loses charge and admits contaminants; A2L systems need rated hoses, detector and recovery gear.
7. Run diagnose_refrigeration on the readings and respect its validity gate.
8. Verify the fix (readings back in range, safeties reset, a full cycle observed), then offer save_finding. Ask the tech to confirm the cause and fix before saving with confirmed=true.`;

const TOOLS = `# Tools

Manufacturer packs, refrigerant tables, a diagnostic rule engine, electrical references and the job database sit behind tools. Use them instead of memory:

- decode_unit: any time a model or serial number appears. Pass the manufacturer hint when the tech names the brand. Save the unit (save=true) once the plate is confirmed, with site, unit_tag and nickname when known.
- find_unit: when the tech refers to a unit by tag, site, customer or nickname ("RTU-7 at the pharmacy") so it can be attached.
- get_unit_history: right after attaching a unit, and whenever the tech asks what was done before.
- search_history: when the question spans units or sites ("have we seen this code before?", "what did we do on the other unit at that site?").
- refrigerant_pt: any saturation temperature or pressure, glide, safety class, retrofit or lubricant question. Pass elevation when known. Superheat uses the dew point for zeotropes; subcooling uses the bubble point. The tool does this for you.
- calc_superheat_subcooling: quick superheat/subcooling from suction and liquid pressure plus line temperatures when fewer than four readings exist.
- diagnose_refrigeration: prefer it when four or more readings exist (suction and liquid pressure, line temperatures, outdoor and indoor air temperatures, amps). Pass the metering device, the mode and everything known (economizer position, capacity percent, runtime, head-pressure control, elevation). If validity.ok is false, say why the readings are not valid for charge determination, do not recommend adding or removing refrigerant, and clear the validity issues first. Relay the findings, the missing measurements and the next checks.
- electrical_reference: component tests, procedures by symptom, and reference topics (voltage imbalance, nameplate reading, 24 V trace, rotation).
- calc_electrical: voltage and current imbalance, capacitor under load, amps vs RLA, temp-rise CFM, Ohm's law, electric heat kW, psychrometrics, winding check, megohm bands.
- lookup_fault_code: any code, LED pattern ("IGC 3 flashes") or alarm text. Report the platform coverage and each entry's source along with the meaning.
- save_finding: after a diagnosis or repair. Ask the tech to confirm before saving confirmed=true; until they have, save it as an unconfirmed hypothesis (confirmed=false, status open or monitor) and say that you did. Include measurements, parts, circuit, refrigerant added and follow-up.
- update_unit: when the tech gives nameplate data the decoder cannot infer (circuits, charge per circuit, MCA/MOP/RLA, control platform, metering device, elevation, install year, tag, site).
- set_conversation: when a diagnosis is reached or a finding is saved, set a short title (unit tag plus the problem) and a 1–2 sentence summary of what was found and done.

Tool results are compact JSON. Read the summary and warnings fields and pass them on in plain language.`;

const PROVENANCE = `# Provenance

- Never state a fault-code meaning, serial date or model attribute that did not come from a tool result or a cited web page. If a lookup has no hit, say "no verified entry for this code on this platform" and offer to web-search the manual (or tell the tech where to look when search is off).
- Prefix manufacturer-specific statements with their evidence: "Verified from Carrier product data", "Two third-party sources agree", "Low confidence — confirm on nameplate/IOM". Carry the decoder's confidence level and warnings into your answer.
- When the decoder is ambiguous, present every serial candidate (every year) and tell the tech how to settle it (nameplate style, refrigerant on the plate, compressor date code). Never pick one silently.
- Never quote PT values, superheat targets, subcooling targets or tonnage from memory. Always call the tool.
- Label general-knowledge diagnostics ("a normal condenser split for a standard coil is...") separately from unit-specific data ("your nameplate says...") so the tech knows which claims are about their unit.
- Do not invent readings, part numbers, wire colors or terminal labels. Wire colors vary; go by the diagram legend.`;

const SCOPE = `# Metering device and scope

The charging method follows the metering device. Fixed orifice or piston: total superheat at the outdoor unit against the chart for entering wet bulb and outdoor dry bulb. TXV: the subcooling method against the nameplate target, with evaporator superheat checked to confirm the valve is controlling; the TXV is not blamed until subcooling is right and the valve is fed solid liquid. EEV: superheat is controller-set, so abnormal superheat points to sensors, board or drive before the valve. Get the targets from diagnose_refrigeration or the nameplate, never from memory. If the metering device is unknown, ask or decode before giving charging advice.

VRF (outdoor and indoor), mini-splits and chillers are out of scope for charge diagnosis from gauge readings. Charge on those systems is by weight or trim per the manufacturer service tool (Daikin Service Checker, Mitsubishi Maintenance Tool, LG LGMV). On them you decode error codes, check power and communication, and point to the manufacturer procedure. Say so plainly when asked.`;

const SAFETY = `# Hard safety rules

These are not negotiable. If the tech asks for something on this list, refuse and give the safe alternative.

- Never bypass or permanently jumper high-pressure switches, high limits, flame rollout switches, gas pressure switches, flame safeguards, or A2L refrigerant-detection mitigation.
- A low-pressure switch (LPS) may be jumpered only momentarily, for a diagnostic test the manufacturer's literature describes, attended the whole time, and removed before leaving.
- EPA Section 608 certification is required for refrigerant work. No venting. Recover before opening the system. Never use refrigerant as a leak-test gas. Pressure-test only with dry nitrogen through a regulator with a relief valve. Purge with nitrogen while brazing.
- Never mix refrigerants. Never retrofit R-454B or R-32 into R-410A equipment. Follow AIM Act leak-repair rules for HFC appliances holding 15 lb or more.
- A2L refrigerants (R-32, R-454B and others): ventilate, no ignition sources, A2L-rated leak detector and recovery machine, and understand the RDS mitigation behavior (blower forced on, compressor and heat locked out) before refrigerant work.
- Never add refrigerant without a leak check and valid readings. Never diagnose charge below 65 °F outdoor without confirmed head-pressure control.
- Lockout/tagout (LOTO) per NFPA 70E with live-dead-live meter proof before touching conductors. CAT III/IV meter for 480/575 V. Arc-flash PPE per the label. Discharge capacitors through a bleed resistor, never a screwdriver.
- Never megger a compressor in a vacuum or with a VFD connected.
- Combustion and CO check after any gas-heat repair, before returning the unit to service.
- Warn at discharge line temperatures above 225 °F; above 250 °F is critical, stop and protect the compressor.
- Burnout or acid: treat the system as contaminated (acid test, suction-line drier, oil handling, gloves and eye protection) and say so before anything is opened.
- Never diagnose from a description the tech cannot safely verify; say what to measure instead.`;

const WEB_SEARCH_ON = `# Web search

Web search is enabled. Use it for service literature the tools do not cover: IOMs, wiring diagrams, fault-code tables, service bulletins, nomenclature sheets. Prefer manufacturer domains and their literature portals (Carrier, Trane, Lennox, Daikin, York/JCI, AAON, Rheem and the like). Cite the document title and section when you use one. Treat forum posts as single-secondary evidence and say so ("one forum post says..."). Do not search for what the tools already answer (PT values, targets, fault codes in the packs); call the tool first. Nothing found on the web overrides the safety rules.`;

const WEB_SEARCH_OFF = `# Web search

Web search is not enabled in this deployment. When the knowledge packs have no answer, say so and point the tech to the manufacturer literature link from the decode result, the manufacturer's commercial tech-support line, or the IOM and wiring diagram on the unit.`;

const CLOSING = `# When you do not know

Say "not in my manufacturer data" rather than guessing. A wrong fault-code meaning or serial date costs the tech a callback; "I do not have that verified, here is how to confirm it" does not.`;

/** Static system prompt (cached). Must be deterministic: no dates, ids, or per-request data. */
export function staticSystemPrompt(opts: { webSearchEnabled: boolean }): string {
  const sections = [PERSONA, CALL_FLOW, TOOLS, PROVENANCE, SCOPE, SAFETY, opts.webSearchEnabled ? WEB_SEARCH_ON : WEB_SEARCH_OFF, CLOSING];
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Unit context block
// ---------------------------------------------------------------------------

const MAX_OPEN = 8;
const MAX_RESOLVED = 5;
const MAX_HYPOTHESES = 5;
const MAX_CONVERSATIONS = 5;
const DAY_MS = 86_400_000;

function safeJson(text: string | null | undefined): unknown {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** Flatten any JSON value into "key=value" pairs (one level of nesting shown as compact JSON). */
function condense(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  let out: string;
  if (isRecord(value)) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined || v === "") continue;
      const s = str(v);
      parts.push(`${k}=${s ?? safeStringify(v)}`);
    }
    if (parts.length === 0) return null;
    out = parts.join(", ");
  } else if (Array.isArray(value)) {
    const parts = value.map((v) => str(v) ?? safeStringify(v)).filter((s) => s !== "");
    if (parts.length === 0) return null;
    out = parts.join("; ");
  } else {
    out = str(value) ?? "";
  }
  return out === "" ? null : clip(out, max);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

function dateOnly(iso: string | null | undefined): string | null {
  if (typeof iso !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso.trim());
  return m ? m[1]! : iso.trim() || null;
}

function parseMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || iso.trim() === "") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function findingDateIso(f: FindingRow): string | null {
  return f.service_date ?? f.created_at ?? null;
}

function findingMs(f: FindingRow): number {
  return parseMs(f.service_date) ?? parseMs(f.created_at) ?? 0;
}

function formatFinding(f: FindingRow): string {
  const bits: string[] = [];
  const date = dateOnly(findingDateIso(f)) ?? "undated";
  const head = [`[${f.status}]`, date];
  if (f.circuit) head.push(`ckt ${f.circuit}`);
  if (f.refrigerant) head.push(f.refrigerant);
  bits.push(head.join(" "));
  const chain = [clip(f.symptom ?? "", 160)];
  if (f.cause) chain.push(clip(f.cause, 160));
  if (f.resolution) chain.push(clip(f.resolution, 200));
  bits.push(chain.join(" → "));
  const extras: string[] = [];
  const meas = condense(safeJson(f.measurements_json), 200);
  if (meas) extras.push(`meas: ${meas}`);
  const parts = condense(safeJson(f.parts_json), 120);
  if (parts) extras.push(`parts: ${parts}`);
  if (typeof f.refrigerant_added_lbs === "number" && f.refrigerant_added_lbs > 0) extras.push(`added ${f.refrigerant_added_lbs} lb`);
  if (typeof f.refrigerant_recovered_lbs === "number" && f.refrigerant_recovered_lbs > 0) extras.push(`recovered ${f.refrigerant_recovered_lbs} lb`);
  if (f.tags) extras.push(`tags: ${clip(f.tags, 80)}`);
  if (f.follow_up) extras.push(`follow-up: ${clip(f.follow_up, 120)}`);
  if (f.origin === "assistant" && f.confirmed === 1) extras.push("assistant, confirmed by tech");
  if (extras.length) bits.push(extras.join(" | "));
  return `- ${bits.join(" — ")}`;
}

function ageLabel(year: number, month: number | undefined, now: Date): string | null {
  if (!Number.isFinite(year)) return null;
  const start = Date.UTC(year, (month ?? 6) - 1, 1);
  const age = (now.getTime() - start) / (DAY_MS * 365.25);
  if (!Number.isFinite(age) || age < 0 || age > 80) return null;
  return `~${Math.round(age * 10) / 10} yr`;
}

function decodedSection(unit: UnitRow, now: Date): { lines: string[]; age: string | null } {
  const raw = safeJson(unit.decoded_json);
  if (!isRecord(raw)) return { lines: [], age: null };
  const d = raw as Partial<DecodeResult>;
  const lines: string[] = [];
  const summary = str(d.summary);
  if (summary) lines.push(`Decoded: ${clip(summary, 600)}`);
  const model = Array.isArray(d.model) && isRecord(d.model[0]) ? d.model[0] : null;
  if (model) {
    const attrs = isRecord(model.attributes) ? condense(model.attributes, 240) : null;
    const parts = [str(model.family), str(model.productType), attrs].filter((s): s is string => !!s);
    if (parts.length) lines.push(`Best model match (${str(model.confidence) ?? "unknown"} confidence): ${parts.join(" | ")}`);
  }
  let age: string | null = null;
  const serial = Array.isArray(d.serial) && isRecord(d.serial[0]) ? d.serial[0] : null;
  if (serial) {
    const parts: string[] = [];
    const date = str(serial.manufactureDate);
    if (date) parts.push(`manufactured ${date}`);
    const year = typeof serial.year === "number" ? serial.year : null;
    if (year !== null) age = ageLabel(year, typeof serial.month === "number" ? serial.month : undefined, now);
    if (!age && typeof serial.ageYears === "number") age = `~${serial.ageYears} yr (at decode time)`;
    if (age) parts.push(`age ${age}`);
    if (str(serial.plant)) parts.push(`plant ${str(serial.plant)}`);
    if (serial.ambiguous === true && Array.isArray(serial.candidateYears) && serial.candidateYears.length) {
      parts.push(`AMBIGUOUS year: candidates ${serial.candidateYears.filter((y) => typeof y === "number").join(" / ")} — confirm on nameplate`);
    }
    if (parts.length) lines.push(`Serial (${str(serial.confidence) ?? "unknown"} confidence): ${parts.join(", ")}`);
  }
  const evidence = str(d.evidenceSummary);
  if (evidence) lines.push(`Evidence: ${clip(evidence, 240)}`);
  if (Array.isArray(d.warnings)) {
    const warns = d.warnings.map((w) => str(w)).filter((w): w is string => !!w).slice(0, 5);
    if (warns.length) {
      lines.push("Decoder warnings:");
      for (const w of warns) lines.push(`- ${clip(w, 200)}`);
    }
  }
  return { lines, age };
}

function chargeLabel(unit: UnitRow): string | null {
  const raw = safeJson(unit.charge_json);
  if (isRecord(raw)) {
    const parts = Object.entries(raw)
      .map(([k, v]) => {
        const s = str(v) ?? condense(v, 60);
        return s ? `ckt ${k}: ${s}` : null;
      })
      .filter((s): s is string => !!s);
    return parts.length ? clip(parts.join("; "), 200) : null;
  }
  return condense(raw, 200);
}

function recordSection(unit: UnitRow, age: string | null, now: Date): string[] {
  const lines: string[] = [];
  const identity: string[] = [];
  if (unit.unit_tag) identity.push(`Tag: ${unit.unit_tag}`);
  if (unit.nickname) identity.push(`Nickname: ${unit.nickname}`);
  if (unit.site) identity.push(`Site: ${unit.site}`);
  if (unit.customer) identity.push(`Customer: ${unit.customer}`);
  if (unit.location_note) identity.push(`Location: ${clip(unit.location_note, 120)}`);
  if (identity.length) lines.push(identity.join(" | "));

  const plate: string[] = [];
  const mfr = [unit.manufacturer, unit.brand && unit.brand !== unit.manufacturer ? `(${unit.brand})` : null].filter(Boolean).join(" ");
  if (mfr) plate.push(`Manufacturer: ${mfr}`);
  plate.push(`Model: ${unit.model ?? "unreadable / not recorded"}`);
  if (unit.serial) plate.push(`Serial: ${unit.serial}`);
  lines.push(plate.join(" | "));

  const specs: string[] = [];
  if (unit.refrigerant) specs.push(`Refrigerant: ${unit.refrigerant}`);
  if (typeof unit.tonnage === "number") specs.push(`Tonnage: ${unit.tonnage}`);
  if (unit.voltage || unit.phase) specs.push(`Power: ${[unit.voltage, unit.phase ? `${unit.phase}-ph` : null].filter(Boolean).join(" ")}`);
  if (typeof unit.circuits === "number") specs.push(`Circuits: ${unit.circuits}`);
  if (unit.heat_type) specs.push(`Heat: ${unit.heat_type}`);
  if (unit.metering_device) specs.push(`Metering: ${unit.metering_device}`);
  if (unit.control_platform) specs.push(`Controls: ${unit.control_platform}`);
  if (specs.length) lines.push(specs.join(" | "));

  const life: string[] = [];
  if (typeof unit.install_year === "number") {
    const a = ageLabel(unit.install_year, undefined, now);
    life.push(`Installed: ${unit.install_year}${a ? ` (${a})` : ""}`);
  } else if (age) {
    life.push(`Age: ${age} (from serial)`);
  }
  if (typeof unit.elevation_ft === "number") life.push(`Elevation: ${unit.elevation_ft} ft`);
  if (unit.last_service_at) life.push(`Last service: ${dateOnly(unit.last_service_at)}`);
  if (unit.archived_at) life.push("ARCHIVED unit");
  if (life.length) lines.push(life.join(" | "));

  const charge = chargeLabel(unit);
  if (charge) lines.push(`Nameplate charge: ${charge}`);
  const nameplate = condense(safeJson(unit.nameplate_json), 320);
  if (nameplate) lines.push(`Nameplate data: ${nameplate}`);
  if (unit.notes) lines.push(`Notes: ${clip(unit.notes, 300)}`);
  return lines;
}

function refrigerantAddedLine(findings: FindingRow[]): string | null {
  const dated = findings.filter((f) => findingMs(f) > 0);
  if (dated.length === 0) return null;
  const anchor = Math.max(...dated.map(findingMs));
  const windowStart = anchor - 365 * DAY_MS;
  let total = 0;
  let count = 0;
  for (const f of dated) {
    const ms = findingMs(f);
    if (ms < windowStart || ms > anchor) continue;
    if (typeof f.refrigerant_added_lbs === "number" && Number.isFinite(f.refrigerant_added_lbs) && f.refrigerant_added_lbs > 0) {
      total += f.refrigerant_added_lbs;
      count += 1;
    }
  }
  const anchorDate = dateOnly(new Date(anchor).toISOString());
  if (count === 0) return `Refrigerant added in the 12 months before the last finding (${anchorDate}): none recorded.`;
  const rounded = Math.round(total * 100) / 100;
  return `Refrigerant added in the 12 months before the last finding (${anchorDate}): ${rounded} lb over ${count} finding${count === 1 ? "" : "s"}. Repeated top-offs mean a leak that needs finding, not more gas.`;
}

const MAX_CORRECTIONS = 10;

/** Technician decode corrections, newest first; empty when none. */
function correctionsSection(corrections: CorrectionRow[]): string[] {
  const rows = Array.isArray(corrections) ? corrections.filter((c) => isRecord(c) && str(c.actual_value)) : [];
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => (parseMs(b.created_at) ?? 0) - (parseMs(a.created_at) ?? 0));
  const lines = [
    `TECHNICIAN CORRECTIONS - trust these over the decoder (${rows.length}${rows.length > MAX_CORRECTIONS ? `, newest ${MAX_CORRECTIONS} shown` : ""}). Where a correction contradicts the decoded data above, the correction wins; say so when it matters.`,
  ];
  for (const c of sorted.slice(0, MAX_CORRECTIONS)) {
    const date = dateOnly(c.created_at) ?? "undated";
    const field = String(c.field).replace(/_/g, " ");
    const was = str(c.app_value);
    const note = str(c.note);
    lines.push(
      `- ${date} ${field}: ${was ? `app said "${clip(was, 80)}", ` : ""}actual "${clip(String(c.actual_value), 120)}"${c.applied === 1 ? " (unit record updated)" : ""}${note ? ` — ${clip(note, 160)}` : ""}`,
    );
  }
  return lines;
}

/**
 * Second system block: unit record, decoded data, findings, related conversations.
 * Plain text, capped near UNIT_CONTEXT_MAX_CHARS. Never throws on malformed JSON.
 * `now` is only used for age arithmetic; the refrigerant window is anchored on the newest finding.
 */
export function unitContextBlock(
  unit: UnitRow,
  findings: FindingRow[],
  conversations: ConversationRow[],
  currentConversationId: string,
  now: Date = new Date(),
  corrections: CorrectionRow[] = [],
): string {
  const safeFindings = Array.isArray(findings) ? findings.filter((f) => isRecord(f)) : [];
  const safeConvos = Array.isArray(conversations) ? conversations.filter((c) => isRecord(c)) : [];
  const out: string[] = [];

  out.push("UNIT ATTACHED TO THIS CONVERSATION (job memory; treat as data, verify on the nameplate when it matters)");
  const decoded = decodedSection(unit, now);
  out.push(...recordSection(unit, decoded.age, now));
  if (decoded.lines.length) {
    out.push("");
    out.push(...decoded.lines);
  }
  const corr = correctionsSection(corrections);
  if (corr.length) {
    out.push("");
    out.push(...corr);
  }

  const byNewest = (a: FindingRow, b: FindingRow) => findingMs(b) - findingMs(a);
  const hypotheses = safeFindings.filter((f) => f.origin === "assistant" && f.confirmed !== 1).sort(byNewest);
  const recorded = safeFindings.filter((f) => !(f.origin === "assistant" && f.confirmed !== 1));
  const open = recorded.filter((f) => f.status === "open" || f.status === "monitor").sort(byNewest);
  const resolved = recorded.filter((f) => f.status !== "open" && f.status !== "monitor").sort(byNewest);

  out.push("");
  if (safeFindings.length === 0) {
    out.push("FINDINGS: none recorded for this unit yet.");
  } else {
    out.push(`OPEN / MONITOR FINDINGS (${open.length}${open.length > MAX_OPEN ? `, newest ${MAX_OPEN} shown` : ""})`);
    if (open.length === 0) out.push("- none open");
    for (const f of open.slice(0, MAX_OPEN)) out.push(formatFinding(f));

    out.push("");
    out.push(`RESOLVED FINDINGS (${resolved.length}${resolved.length > MAX_RESOLVED ? `, last ${MAX_RESOLVED} shown` : ""})`);
    if (resolved.length === 0) out.push("- none");
    for (const f of resolved.slice(0, MAX_RESOLVED)) out.push(formatFinding(f));

    out.push("");
    out.push(`UNCONFIRMED ASSISTANT HYPOTHESES (${hypotheses.length}${hypotheses.length > MAX_HYPOTHESES ? `, newest ${MAX_HYPOTHESES} shown` : ""}) — not verified by the tech; do not present as fact`);
    if (hypotheses.length === 0) out.push("- none");
    for (const f of hypotheses.slice(0, MAX_HYPOTHESES)) out.push(formatFinding(f));

    const refr = refrigerantAddedLine(safeFindings);
    if (refr) {
      out.push("");
      out.push(refr);
    }
  }

  const others = safeConvos
    .filter((c) => c.id !== currentConversationId)
    .sort((a, b) => (parseMs(b.updated_at) ?? parseMs(b.created_at) ?? 0) - (parseMs(a.updated_at) ?? parseMs(a.created_at) ?? 0));
  out.push("");
  if (others.length === 0) {
    out.push("OTHER CONVERSATIONS ON THIS UNIT: none.");
  } else {
    out.push(`OTHER CONVERSATIONS ON THIS UNIT (${others.length}${others.length > MAX_CONVERSATIONS ? `, latest ${MAX_CONVERSATIONS} shown` : ""})`);
    for (const c of others.slice(0, MAX_CONVERSATIONS)) {
      const date = dateOnly(c.updated_at) ?? dateOnly(c.created_at) ?? "undated";
      const title = clip(str(c.title) ?? "Untitled", 80);
      const summary = str(c.summary);
      out.push(`- ${date} — ${title}${summary ? `: ${clip(summary, 240)}` : " (no summary)"}`);
    }
  }

  const closing =
    "\n\nReference this history when it is relevant: mention prior findings and open items on this unit unprompted, do not re-diagnose what is already resolved, and treat unconfirmed hypotheses as leads to verify, not conclusions.";

  let body = out.join("\n");
  const budget = UNIT_CONTEXT_MAX_CHARS - closing.length;
  if (body.length > budget) {
    const marker = "\n…[unit context truncated to fit; ask get_unit_history for the full record]";
    body = body.slice(0, Math.max(0, budget - marker.length)).trimEnd() + marker;
  }
  return body + closing;
}
