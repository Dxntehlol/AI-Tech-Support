# HVAC Field Assistant — Design Spec

A self-hosted web app for commercial HVAC technicians. It combines a Claude-powered
troubleshooting assistant with a local knowledge base (manufacturer model/serial decoders,
refrigerant PT data, refrigeration-cycle diagnostics, electrical procedures) and a
persistent job memory (units, conversations, findings) stored in SQLite.

Reference point: apps like Bluon (nameplate lookup, manuals, tech chat), but self-hosted,
with an LLM that reasons over live measurements and remembers past jobs.

## Goals (from the user)

1. Basic-to-intermediate refrigeration cycle troubleshooting (superheat/subcooling, PT
   charts, delta-T, compression ratio, charge/airflow/restriction/metering diagnosis).
2. System-specific troubleshooting steps driven by manufacturer data decoded from the
   model and serial number (family, tonnage, voltage/phase, refrigerant, heat type,
   control platform, age, fault codes, known issues), plus optional live web lookup of
   manufacturer service literature.
3. Unit-specific electrical troubleshooting (control circuit tracing, component tests,
   3-phase checks, fault codes, safeties, typical component designators per family).
4. Store and recall previous conversations and findings per unit/site (job memory).

## Non-goals (v1)

- Multi-user accounts / cloud sync. Single-tech, single-instance. Optional shared password.
- Replacing manufacturer literature. The app decodes and guides; it tells the tech when to
  confirm against the nameplate, wiring diagram, or IOM.
- Building automation integration (BACnet etc.).

## Stack

- Node.js 22+ (uses built-in `node:sqlite`; no native build steps), TypeScript (erasable
  syntax only so Node can run `.ts` directly; `tsc` builds `dist/` for production).
- Express 5 HTTP server + static single-page web UI (vanilla JS, no bundler).
- `@anthropic-ai/sdk` — model `claude-opus-5`, adaptive thinking, streaming, tool use via a
  manual streaming loop, server-side refusal fallbacks (`fallbacks: "default"`), optional
  server-side `web_search` tool.
- Knowledge packs are JSON under `knowledge/`; refrigerant tables are generated with
  CoolProp (`scripts/gen_refrigerants.py`) and committed, so end users don't need Python.
- Tests: `node --test` (unit tests next to sources as `*.test.ts`). The Claude client is
  injectable so the agent loop is tested with a fake.

## Directory layout and ownership

```
hvac-assistant/
  DESIGN.md  README.md  package.json  tsconfig.json  .env.example  .gitignore
  scripts/gen_refrigerants.py           # CoolProp -> knowledge/refrigerants/*.json
  knowledge/
    refrigerants/index.json             # metadata for each refrigerant (see types)
    refrigerants/<id>.json              # generated PT tables (bubble/dew psig by °F)
    diagnostics/refrigeration-cycle.json  # rule set for the DX diagnostics engine
    diagnostics/charging-targets.json   # target SH (fixed orifice) / SC guidance tables
    electrical/components.json          # component test procedures & expected readings
    electrical/procedures.json          # symptom-driven electrical procedures
    manufacturers/<mfr>.json            # one pack per manufacturer family
  src/
    types.ts            # shared contracts (FROZEN — do not change without updating DESIGN)
    config.ts           # env/config loading
    server.ts           # entry: builds app, starts listening
    app.ts              # express app factory (createApp(deps)) — routes mount here
    routes/*.ts         # route modules (conversations, units, chat, reference, search)
    db/schema.sql       # SQLite schema (idempotent CREATE IF NOT EXISTS)
    db/index.ts         # openDatabase(path) -> Db (runs schema, FTS triggers)
    db/repos.ts         # Units/Conversations/Messages/Findings repositories + search
    knowledge/loader.ts # loads and validates all JSON packs once (KnowledgeBase)
    knowledge/refrigerants.ts   # PT lookup, interpolation, SH/SC calc
    knowledge/diagnostics.ts    # DX rule engine (derived metrics + ranked findings)
    knowledge/electrical.ts     # electrical calculators + reference lookup
    knowledge/decoder.ts        # model/serial decoder engine over manufacturer packs
    knowledge/faults.ts         # fault-code lookup across packs
    agent/systemPrompt.ts       # static system prompt + unit-context builder
    agent/tools.ts              # tool definitions (JSON schema) + dispatcher
    agent/chat.ts               # runTurn(): streaming manual tool loop, persistence, SSE
    agent/client.ts             # createAnthropicClient(config)
  web/
    index.html  app.js  styles.css   # single-page UI
    vendor/                          # copied marked + DOMPurify (served locally)
```

Parallel builders own disjoint files. `src/types.ts`, `db/schema.sql` and this document
are the contract. If a builder must extend a type, it adds optional fields only.

## Data model (SQLite)

```sql
units(id TEXT PK, manufacturer, brand, model, serial, nickname, site, customer,
      location_note, refrigerant, tonnage REAL, voltage, phase, decoded_json TEXT,
      notes, created_at, updated_at)
conversations(id TEXT PK, title, unit_id NULL -> units, summary, created_at, updated_at)
messages(id TEXT PK, conversation_id -> conversations, seq INTEGER, role TEXT (user|assistant),
         content_json TEXT (Anthropic content blocks, verbatim), text TEXT (searchable),
         created_at)
findings(id TEXT PK, unit_id NULL, conversation_id NULL, symptom, cause, resolution,
         measurements_json, parts_json, tags, created_at)
messages_fts (fts5 external-content over messages.text)
findings_fts (fts5 over symptom, cause, resolution)
```

IDs are random 16-hex strings (`crypto.randomBytes(8).toString("hex")`). Timestamps are ISO
strings. `seq` orders messages within a conversation.

## Knowledge pack contracts (see `src/types.ts` for exact shapes)

### Manufacturer pack (`knowledge/manufacturers/<id>.json`)

- `id`, `manufacturer`, `brands[]`, `aliases[]`
- `serialFormats[]`: anchored regex + `date` rule (`twoDigitYear`, `oneDigitYear`,
  `letterYear`, `fourDigitYear`, `manual`) + optional plant map + `examples[]` with expected
  year/month/week. Each has `confidence`.
- `modelFormats[]`: anchored regex over the model number, `segments[]` mapping capture groups
  to attributes (`tonnage`, `refrigerant`, `voltage`, `heat_type`, `unit_type`, …) with code
  maps and optional transforms (`mbh_to_tons`, `kbtuh`). `examples[]` with expected
  attributes.
- `controls[]`: control platforms (e.g. ComfortLink, ReliaTel, Prodigy, Simplicity SE,
  MicroTech III) with `faultCodes[]` (`code`, `meaning`, `likelyCauses[]`, `checks[]`,
  `severity`), LED flash patterns where applicable, `diagnosticTips[]`.
- `electrical`: typical control voltage, common component designators for the family
  (e.g. IFC, C, CLO, HPS, LPS, TRAN, ECON, DFB), safety devices, terminal labels, notes.
- `commonIssues[]`: symptom → likely causes → checks, scoped by family regex.
- `support`: tech-support phone/url, literature search URL pattern, notes.
- `sources[]`, `confidence`, `lastReviewed`.

Rules for pack authors: never invent fault codes. If unsure, omit or mark `confidence:
"low"` with a note. Every serial format needs at least two worked examples. Model
nomenclature must be verified against at least one published nomenclature sheet or two
independent sources (WebSearch is available to builders; the container cannot fetch pages
directly).

### Refrigerants

`index.json`: array of `RefrigerantMeta` (id like `R-410A`, aliases, type
pure/azeotrope/zeotrope, composition (mass %), safety class, GWP (AR4 and AR5 where known),
glide °F, lubricant, typical applications, service notes (e.g. charge as liquid for blends,
A2L handling, retrofit notes)). `<id>.json`: `{ id, tempF: number[], bubblePsig: number[],
dewPsig: number[] }` from −60 °F to 160 °F in 1 °F steps (clipped below critical temp).
Generated by CoolProp; blends missing from CoolProp are built from mass-fraction mixtures.
Reference checks: R-410A ≈ 118 psig @ 40 °F, R-22 ≈ 68.5 psig @ 40 °F, R-134a ≈ 35 psig @
40 °F, R-404A ≈ 87 psig @ 40 °F.

Superheat uses **dew** point for zeotropes; subcooling uses **bubble** point. Pure/azeotropic
refrigerants have bubble == dew.

### Diagnostics rule set

Input `DxMeasurements` (refrigerant, metering device, system type, outdoor DB, indoor DB/WB,
return/supply temps, suction psig + line temp, liquid/discharge psig + liquid line temp,
discharge line temp, compressor amps + RLA, etc.). Engine derives evap sat, cond sat,
superheat, subcooling, condenser split (cond sat − outdoor DB), evaporator TD, delta-T,
compression ratio, discharge superheat, target superheat (fixed orifice: from indoor WB and
outdoor DB table) or target subcooling (TXV: nameplate or 10–12 °F default), then evaluates
data-driven rules (`when` clauses over derived metrics, scoped by metering device / system
type) producing ranked findings: condition, explanation, confidence, next checks, safety
notes. Classic matrix must be covered: high SH + high SC → restriction; high SH + low SC →
undercharge; low SH + high SC → overcharge; low SH + low SC → low load/airflow (fixed
orifice) or flooding TXV; high cond split → dirty condenser / non-condensables / overcharge;
low cond split + low suction → low load; high compression ratio → inefficient compressor /
high head; low delta-T with normal SH/SC → airflow high / low load; discharge temp > 225 °F
warning; compressor amps vs RLA; heat pump heating mode differences.

### Electrical

`components.json`: for each component (run capacitor, start capacitor + potential relay,
contactor, control relay, control transformer, compressor (single-phase PSC/CSR and 3-phase),
condenser fan motor PSC, ECM/X13 motors, belt-drive blower motor, VFD, crankcase heater,
phase monitor, high/low pressure switches, freeze stat, limit switch, defrost board,
economizer actuator/controller, thermostat/24V circuit, fuses/breakers/disconnect, low ambient
controls, hot gas bypass solenoid): what it does, how to test (de-energized and energized
tests), expected readings and tolerances (e.g. run capacitor ±6 % of rating; contactor coil
typical resistance range; compressor winding C-S-R relationships), failure modes, safety
notes, tools needed.

`procedures.json`: symptom-driven procedures (unit completely dead; no cooling — fans run,
compressor off; compressor hums/trips; breaker/fuse trips; short cycling; blower won't run;
no heat (gas RTU ignition sequence); economizer stuck; VFD faults; phase loss), each a
stepwise flow with decision points and expected readings.

Calculators (TypeScript): voltage imbalance % (NEMA method) with derating warning above 2 %,
current imbalance, capacitor µF under load (µF = 2652 × A / V), amps vs RLA/FLA %, Ohm's
law helpers, temperature rise → CFM for gas heat (CFM = BTUh_output / (1.08 × ΔT)), sensible
capacity check.

## Assistant (agent layer)

- Model `claude-opus-5`, `thinking: { type: "adaptive" }`, `output_config.effort` from
  config (default `high`), streaming via `client.beta.messages.stream`, `max_tokens` 16000.
- `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"` when
  `CLAUDE_FALLBACKS=default` (default on). If the API rejects the fallback param (400), the
  turn is retried once without it and a warning logged.
- Optional server tool `{ type: "web_search_20260209", name: "web_search", max_uses: 5 }`
  when `ENABLE_WEB_SEARCH=1`; handles `pause_turn` by re-sending.
- Custom tools (all with `strict` JSON schemas): `decode_unit`, `refrigerant_pt`,
  `calc_superheat_subcooling`, `diagnose_refrigeration`, `electrical_reference`,
  `calc_electrical`, `lookup_fault_code`, `search_history`, `get_unit_history`,
  `save_finding`, `update_unit`.
- System prompt: senior commercial HVAC tech persona; safety-first (LOTO, arc-flash PPE,
  A2L/A1 handling, EPA 608); structured flow (identify unit → symptoms → measurements → decide);
  one or two measurements requested at a time; uses tools rather than recalling PT values;
  distinguishes verified manufacturer data from general knowledge; cites web sources when web
  search was used; concise formatting for a phone screen. A second `system` block carries
  unit context (unit record, decoded data, findings, past conversation titles) when the
  conversation is attached to a unit.
- Persistence: user message stored before the call; each assistant message and each
  tool-result user message stored verbatim (content blocks) so history replays exactly.
  Conversation title = first user text (truncated) if untitled.
- Loop guard: max 12 tool iterations per turn; `max_tokens` stop with a pending tool_use →
  error surfaced; `refusal` → message to user; API errors mapped to friendly text.
- SSE event stream to browser: `delta` (text), `tool_start`, `tool_end`, `done`, `error`.

## HTTP API

```
GET  /api/health
GET  /api/conversations?q=&unit_id=          list (newest first)
POST /api/conversations {unit_id?, title?}
GET  /api/conversations/:id                  with messages (display form)
PATCH/DELETE /api/conversations/:id
POST /api/conversations/:id/messages {text, images?:[{media_type,data}]} -> SSE
GET  /api/units?q=            POST /api/units {model, serial, ...} (auto-decodes)
GET  /api/units/:id           (unit + findings + conversations)   PATCH / DELETE
POST /api/decode {model, serial, manufacturer?}   decode without saving
GET  /api/search?q=           FTS over messages + findings
GET  /api/findings?unit_id=   POST /api/findings
GET  /api/reference/refrigerants
GET  /api/reference/pt?refrigerant=&psig=|temp_f=
POST /api/calc/superheat-subcooling  {DxMeasurements}
POST /api/calc/diagnose              {DxMeasurements}
POST /api/calc/electrical            {kind, ...}
GET  /api/reference/electrical?component=|symptom=
GET  /api/reference/fault?code=&manufacturer=
```

Security: binds to `127.0.0.1` unless `HOST` set; optional `APP_PASSWORD` enables HTTP
basic auth on everything; JSON body limit 25 MB (photos); images validated (media type
whitelist, size cap); all IDs validated; parameterized SQL only; no shell/eval; chat markdown
rendered through DOMPurify in the browser.

## Web UI

Single page, mobile-first, dark default with light toggle, large tap targets.

- Sidebar (drawer on mobile): search box (FTS), Units list, Conversations list, New
  conversation.
- Main: chat transcript (markdown, tool chips like "Decoded: Carrier 48TC…", "PT: R-410A
  118 psig → 40 °F"), streaming, composer with camera/photo attach (client-side resize to
  ≤1568 px longest edge, JPEG), quick-start chips (Decode nameplate, Refrigeration cycle
  check, Electrical: unit dead, Fault code lookup).
- Unit panel (right column / tab on mobile): model & serial fields → decode → card (family,
  tonnage, voltage/phase, refrigerant, heat type, control platform, manufacture date & age,
  confidence, notes, doc links); attach to conversation; findings log; calculators
  (SH/SC, PT chart, voltage imbalance, capacitor, temp-rise CFM).

## Configuration (`.env`)

```
ANTHROPIC_API_KEY=...        required (or ANTHROPIC_AUTH_TOKEN / `ant auth login`)
CLAUDE_MODEL=claude-opus-5
CLAUDE_EFFORT=high           low|medium|high|xhigh|max
CLAUDE_FALLBACKS=default     default|off
ENABLE_WEB_SEARCH=0          1 to allow the assistant to search the web for manuals
PORT=8787  HOST=127.0.0.1  DB_PATH=./data/hvac.sqlite  APP_PASSWORD=
```

## Testing

- Unit tests per module; knowledge packs validated on load (regex compiles, examples decode
  to expected values, fault codes have required fields). A pack whose examples fail its own
  rules fails the test suite.
- Agent loop tested with a fake client that scripts tool calls.
- API tested with supertest-style requests against `createApp()` with a temp DB.
