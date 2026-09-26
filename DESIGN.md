# HVAC Field Assistant — Design Spec (v2, post-critique)

A self-hosted web app for commercial HVAC technicians. It combines a Claude-powered
troubleshooting assistant with a local knowledge base (manufacturer model/serial decoders,
refrigerant PT data, refrigeration-cycle diagnostics, electrical procedures) and a
persistent job memory (units, conversations, findings) stored in SQLite.

Reference point: apps like Bluon (nameplate lookup, manuals, tech chat), but self-hosted,
with an LLM that reasons over live measurements and remembers past jobs.

## Goals (from the user)

1. Basic-to-intermediate refrigeration cycle troubleshooting (superheat/subcooling, PT
   charts, delta-T, compression ratio, charge/airflow/restriction/metering diagnosis).
2. System-specific troubleshooting steps driven by manufacturer data decoded from the model
   and serial number (family, tonnage, voltage/phase, refrigerant, heat type, control
   platform, age, fault codes, known issues), plus optional live web lookup of service
   literature.
3. Unit-specific electrical troubleshooting (control circuit tracing, component tests,
   3-phase checks, fault codes, safeties, typical component designators per family).
4. Store and recall previous conversations and findings per unit/site (job memory).

## Non-goals (v1)

- Multi-user accounts / cloud sync. Single-tech, single-instance. Optional shared password.
- Replacing manufacturer literature. The app decodes and guides; it tells the tech when to
  confirm against the nameplate, wiring diagram, or IOM.
- Building automation integration, PWA/offline mode, VRF/chiller charge diagnosis (see
  scope statement under Diagnostics).

## Stack and builder rules

- Node.js ≥ 22.18 (built-in `node:sqlite`, no native builds), TypeScript run directly by
  Node's type stripping in dev/tests; `tsc` emits `dist/` for production (`npm run build`).
- Express 5 + a static single-page UI (vanilla JS, no bundler). `marked` + `DOMPurify`
  vendored into `web/vendor/`.
- `@anthropic-ai/sdk` — model `claude-opus-5`, adaptive thinking, streaming, manual tool loop,
  server-side refusal fallbacks (`fallbacks: "default"`), optional server-side `web_search`.
- Knowledge packs are JSON under `knowledge/`; refrigerant PT tables are generated with
  CoolProp (`scripts/gen_refrigerants.py`) and committed.
- Tests: `node --test` with `*.test.ts` beside sources. The Claude client is a narrow
  interface (`src/agent/client.ts`) so the loop is tested with `src/agent/fakeClient.ts`.

Builder rules (Node type stripping): no `enum`, `namespace`, parameter properties,
decorators, `declare` fields, or JSON imports (read JSON with `fs`); relative imports end in
`.ts`; `import type` for type-only imports; no top-level `await` in modules imported by
tests; no new npm dependencies.

## Directory layout and ownership

```
hvac-assistant/
  DESIGN.md  README.md  package.json  tsconfig.json  .env.example  .gitignore
  scripts/gen_refrigerants.py           # CoolProp -> knowledge/refrigerants/*.json (+ _generated_meta.json)
  knowledge/
    refrigerants/index.json             # hand-maintained RefrigerantMeta[] (REQUIRED)
    refrigerants/<id>.json              # generated PT tables (bubble/dew psig by °F)
    diagnostics/refrigeration-cycle.json  # DxRuleSet
    diagnostics/charging-targets.json   # ChargingTargets
    electrical/components.json          # { version, components: ElectricalComponent[], reference: [...] }
    electrical/procedures.json          # { version, procedures: ElectricalProcedure[] }
    manufacturers/<mfr>.json            # one ManufacturerPack per manufacturer family
  src/
    types.ts            # shared contracts (FROZEN — optional additions only)
    config.ts           # env/config loading (loadDotEnv, loadConfig, PROJECT_ROOT)
    server.ts           # entry: builds deps, starts listening, graceful shutdown
    app.ts              # createApp(deps) — express app factory
    routes/*.ts         # conversations, units, reference, search, auth
    db/schema.ts        # SCHEMA_SQL constant (idempotent)
    db/index.ts         # openDatabase(path), newId(), isId(), nowIso()
    db/repos.ts         # createRepos(db): units/conversations/messages/findings + search
    knowledge/loader.ts # loads + validates all JSON packs (KnowledgeBase)
    knowledge/refrigerants.ts   # PT lookup, interpolation, SH/SC, elevation correction (DONE)
    knowledge/diagnostics.ts    # DX rule engine
    knowledge/electrical.ts     # electrical calculators + reference lookup
    knowledge/decoder.ts        # model/serial decoder engine
    knowledge/faults.ts         # fault-code lookup across packs
    agent/client.ts             # MessagesStreamer / StreamLike interfaces + real client (DONE)
    agent/fakeClient.ts         # scripted fake client for tests and demo mode
    agent/systemPrompt.ts       # static system prompt + unit-context builder
    agent/tools.ts              # tool definitions + dispatcher
    agent/chat.ts               # runTurn(): streaming manual tool loop, persistence, events
  web/
    index.html  app.js  styles.css  vendor/
```

Parallel builders own disjoint files. `src/types.ts`, `db/schema.ts` and this document are
the contract; extend types with optional fields only.

## Data model (SQLite) — see `src/db/schema.ts`

- `units`: identity (manufacturer, brand, model, serial, unit_tag, nickname, site, customer,
  location_note), decoded attributes (refrigerant, tonnage, voltage, phase, control_platform,
  heat_type, metering_device, install_year, elevation_ft), `decoded_json` (DecodeResult),
  nameplate data the decoder cannot infer (`circuits`, `charge_json`, `nameplate_json`),
  notes, last_service_at, `archived_at` (soft delete: `DELETE /api/units/:id` archives; lists
  exclude archived unless `include_archived=1`). `model` may be NULL when the plate is
  unreadable (record keyed by site + unit_tag; decoder skipped); at least one of model,
  unit_tag, nickname is required.
- `conversations`: title, unit_id (SET NULL on unit delete), summary (set by the
  `set_conversation` tool), timestamps.
- `messages`: `rid INTEGER PRIMARY KEY` (internal, FTS rowid), `id` (public 16-hex), seq,
  role, `kind` (`chat` | `tool_result`), `content_json` (Anthropic content blocks verbatim),
  `text` (searchable: user text / assistant text blocks; `""` for tool_result rows).
- `findings`: symptom/cause/resolution, measurements_json, parts_json, tags
  (comma-separated lowercase tokens), circuit, `status` (open|resolved|monitor),
  service_date, refrigerant, refrigerant_added_lbs, refrigerant_recovered_lbs, follow_up,
  `origin` (tech|assistant), `confirmed` (0|1).
- FTS5 external-content tables over messages (chat rows) and findings, kept in sync by
  triggers on `rid`.
- IDs: 16 lowercase hex (`crypto.randomBytes(8)`), validated by `isId()`; all `:id` params
  and `unit_id`/`conversation_id` body fields → 400 otherwise. Timestamps ISO-8601 UTC.
- `messages.append` allocates `seq` atomically (single `INSERT … SELECT COALESCE(MAX(seq),0)+1`
  or inside `BEGIN IMMEDIATE`) and touches `conversations.updated_at` in the same transaction.
- Deleting a unit archives it (soft delete); findings and conversations keep their link. The UI
  asks for confirmation. Sites table and unit photo storage are deferred to a later version
  (free-text `units.site` for now).

## Knowledge pack contracts

### Manufacturer pack (`knowledge/manufacturers/<id>.json`, type `ManufacturerPack`)

- `serialFormats[]`: anchored `^…$` regex over the normalized serial, a `SerialDateRule`
  (`twoDigitYear` with pivot/yearMap, `oneDigitYear`, `decadeDigitYear`, `letterYear`,
  `fourDigitYear`, `manual`; month numeric or letter via `monthLetterMap`; `weekGroup`,
  `dayOfYearGroup`), `eraStart`/`eraEnd` (required), plant map, ≥ 2 worked examples (≥ 3 from
  distinct years for `high`), `confidence`, `evidence`, `sources`, `notes` telling the tech how
  to disambiguate ambiguous year digits (nameplate style, refrigerant on plate, compressor
  date code).
- `modelFormats[]`: anchored regex over the normalized model; `segments[]` map capture groups
  to attributes (`unit_type`, `series`, `tonnage`, `refrigerant`, `voltage`, `heat_type`,
  `heat_capacity`, `efficiency`, `controls`, `revision`, `options`, …) via `map` and/or
  `transform` (`mbh_to_tons`, `tons_x10`, `kbtuh`, `raw`, `map_tons` — see `types.ts`);
  `refrigerant` default per family/era; `controlPlatformIds`; `equivalentFamilies` (Bryant
  580J ≙ Carrier 48TC); ≥ 2 examples with expected attributes; `evidence`/`sources`.
  Regexes must tolerate trailing feature strings where the nomenclature has them (AAON,
  Lennox) — use a non-captured `(?:[-A-Z0-9/]*)?` tail.
- `controls[]`: control platforms with `faultCodes[]` (code, meaning verbatim from the
  manual, likelyCauses, checks, severity, `source`, `evidence`), LED patterns, diagnostic
  tips (service/test mode entry, clearing lockouts), `coverage` (`complete` | `partial`),
  `sourceDocs`.
- `electrical[]`: per family: control voltage, component designators (C, IFC, OFC, CLO, HPS,
  LPS, TRAN, DFB, ECON, IGC, LAS, FS, TB, CB…), safety devices, terminal labels (thermostat and
  BAS), sequence of operation for cooling/heating, notes (e.g. phase monitor standard since
  year X, RDS sensors on 2025+ A2L units).
- `commonIssues[]`: symptom → likely causes → checks, scoped by `appliesTo` regex; capped at
  `medium` confidence unless from a service bulletin.
- `support`: commercial tech-support phone, literature URL, `literatureSearchHint`.
- `sources`, `confidence`, `lastReviewed`.

Normalization (decoder): trim; uppercase; collapse whitespace runs to one space; remove every
character not in `[A-Z0-9 /().-]`; strip a leading `MODEL`, `M/N`, `S/N`, `SERIAL` label;
cap at 64 chars (warn if truncated). Regexes are tried against the normalized string first,
then against a "compact" form with spaces removed. Hyphens, slashes, colons, parentheses are
preserved (Lennox `XC21-036-230-02`, AAON `RN-010-3-0-EB09-…`).

Decoder date sanity: reject a match whose month ∉ 1..12, week ∉ 1..53, dayOfYear ∉ 1..366, or
year ∉ 1965..now+1, and fall through to the next format (adding a warning). If two formats of
the same pack match and yield different years, all are downgraded to `low`, `ambiguous:
true`, `candidateYears` lists every year, and `DecodeResult.warnings` says the date must be
confirmed from the era/nameplate. `DecodeResult.summary` opens with the confidence level and
the caveat where applicable ("Trane one-digit year: 2007 or 1997 — confirm with compressor
date stamps"); `evidenceSummary` names the evidence behind nomenclature and serial rules.

Manufacturer ranking: +100 hint matches manufacturer/brand/alias; +40 per modelFormat regex
match (×0.5 if `low`); +30 per serialFormat match; +10 when the same pack matches both; ties by
pack order; only packs with score > 0 are returned (empty → warning "no manufacturer matched;
verify nameplate"). `twoDigitYear`: yy ≥ pivot → 1900+yy else 2000+yy (pivot default 70), then
clamp by era (out of era → drop candidate). `manufactureDate` is `YYYY-MM` when the month is
known, `YYYY-Www` when only the week, else `YYYY`; `ageYears` = round((now − date)/365.25, 1).

Loader validation (strict; the test suite fails on any problem): regex compiles, is anchored
`^…$`, ≤ 400 chars, no nested quantifiers `(x+)+`; every referenced group index ≤ the regex's
group count; `high` confidence requires `sources`; ≥ 2 serial examples per format and ≥ 1
model example per format unless `low`; letter maps in range; every control platform has ≥ 1
fault code; `refrigerants/index.json` exists and every entry has a table, an ASHRAE 34 safety
class (A1, A2L, A2, A3, B1, B2L, B2, B3) and `gwp.ar4`; DxRuleSet `when[].metric` is a known
MetricKey with numeric ops carrying `value` (and `value2` for `between`); ChargingTargets grids
are the right shape. `src/knowledge/packs.test.ts` additionally runs every pack example through
the decoder and asserts the expected year/month/week and attributes.

Verification protocol (binding for builders and verifiers):

- Serial formats: `high` only when confirmed by manufacturer documentation or a warranty/
  serial lookup and ≥ 3 dated examples from distinct years; `medium` when two independent
  secondary decoders agree; otherwise `low` with a note. Every example is a unit test.
- Model formats: `high` only from the manufacturer's published nomenclature (product data / IOM
  nomenclature page) with the document named in `sources`; ≥ 2 real catalog examples; note
  in `segments[].notes` whether a `map` covers all published codes.
- Fault codes: only from the controller/service manual (doc + section); meaning transcribed
  verbatim; third-party lists corroborate only; never from memory; `coverage` set honestly.
- Electrical designators / sequence of operation: from the IOM wiring-diagram legend.
- Verifiers try to refute: re-derive each example date independently, check ≥ 3 random
  codes per platform against a source, and flag any claim without evidence. Unverifiable
  claims are downgraded to `low` or removed, never left at `high`.
- Builders and verifiers have WebSearch (search summaries). WebFetch/curl are blocked.

### Refrigerants

`index.json` (`RefrigerantMeta[]`, required) covers at least: R-22, R-410A, R-32, R-454B,
R-134a, R-513A, R-407C, R-407A, R-407F, R-404A, R-507A, R-448A, R-449A, R-452A, R-438A,
R-422D, R-427A, R-421A, R-417A, R-422B, R-434A, R-454A, R-454C, R-455A, R-450A, R-515B,
R-744, R-290, R-600a, R-1234yf, R-1234ze(E), R-123, R-1233zd(E), R-245fa, R-717, R-11, R-12,
R-500, R-502, R-401A, R-409A, R-408A, R-402A, R-152a, R-23 (every generated table has an entry).
Fields: aliases (trade names: Puron, Freon, Opteon XL41, Solstice N40, MO99, Genetron…), `type`
by ASHRAE designation (400-series zeotrope, 500-series azeotrope, single component pure),
composition (mass %), safetyClass, `gwp.ar4` (and ar5 when known), glideF (from
`_generated_meta.json`), `blendType`, lubricant, applications, `serviceNotes` (charge blends as
liquid; A2L: ventilation, no ignition sources, A2L-rated detector/recovery machine, left-hand
thread cylinders, purge before brazing, never retrofit A1 equipment to A2L; R-22 retrofit oil
notes; obsolete/approximate-table warnings), `replacementFor`, `criticalTempF`/`criticalPsig`,
`tableSource`, `extrapolatedAboveF`, `tableVerified` (spot checks against a published chart).

`<id>.json`: `{ id, tempF[], bubblePsig[], dewPsig[] }` from −60 °F to 160 °F (1 °F steps),
clipped below the critical temperature; blends whose flash fails above ~130 °F are extrapolated
to 150 °F with a Clausius–Clapeyron fit and flagged. Reference checks at 40 °F: R-410A ≈ 118.8,
R-22 ≈ 68.6, R-134a ≈ 35.0, R-404A ≈ 86.9 psig. R-502's mixture table reads ~3 % low vs
published charts and is marked approximate.

Superheat uses **dew** point for zeotropes; subcooling uses **bubble** point. Sub-atmospheric
pressures are also reported in inHg vacuum (inHg = −psig × 2.036). Elevation: local
Patm(psia) = 14.696 × (1 − 6.8754e-6 × elevationFt)^5.2559; a field gauge reading is
converted to sea-level basis with `psigSeaLevel = psig + (14.696 − Patm)` before table
lookup (inverse for temp → psig); the note is quantitative ("at 5,000 ft your gauge reads
~2.5 psi lower than the chart"). Above the critical temperature ptLookup says "above critical
temperature — no saturation (transcritical)" (R-744 above 87.8 °F). Every PT answer carries the
safety class and, for A2L/A3, a one-line handling reminder.

### Diagnostics rule set (`knowledge/diagnostics/refrigeration-cycle.json`, `DxRuleSet`)

Inputs: `DxMeasurements` (see types). Engine (`src/knowledge/diagnostics.ts`):

1. **Sanity gate** before anything else: `suctionPsig >= liquidPsig` → finding "readings look
   swapped or unit off", skip charge rules; in `heat_pump_heating` warn (do not silently
   compute) if `suctionMeasuredAt` is the vapor service valve (it carries hot gas in heating);
   implausible saturation temps for the stated refrigerant (evap sat > entering air DB, cond sat
   < outdoor DB while running) → advise verifying refrigerant on the nameplate/retrofit sticker
   and gauge calibration; `heat_pump_heating` without `outdoorDbF` → add to `missing` first.
2. **Derived metrics** (`DxDerived`): `patmPsia` from elevation; evapSat (dew at suction, after
   elevation correction), condSat (bubble at liquid ?? discharge), superheat, subcooling
   (`superheatSubcooling`), target superheat (nameplate; else fixed-orifice table by entering
   WB (mixedAirWbF ?? indoorWbF, or from returnRhPercent+DB) and outdoor DB, bilinear
   interpolation, undefined below 55 °F outdoor or on null cells), target subcooling
   (nameplate ?? defaults for txv/eev only), condenser split, evaporator TD (entering DB −
   evapSat; uses mixed-air temps when supplied), delta-T (entering − supply), target delta-T
   from the `targetDeltaT` table when DB/WB known else the default range, compression ratio on
   absolute pressures (`(high + Patm)/(suction + Patm)`), discharge superheat, amps % RLA,
   current imbalance from L1/L2/L3, drier temperature drop, standing excess pressure.
   Heating mode (`heat_pump_heating`): indoor coil is the condenser → `indoorCoilTdF = condSat −
   indoorDb` (typical 25–35 °F), `evapTdF = outdoorDb − evapSat` (typical 15–30 °F, shrinking with
   frost), `deltaTF = supply − entering` (temperature rise), `condenserSplitF` undefined; SH/SC
   charging-chart rules are disabled and a finding says to charge by the manufacturer heating
   check chart or weigh-in; frost/defrost invalidates readings.
3. **Validity gate** (`DxResult.validity`): issues from outdoorDb < `lowAmbientMinOutdoorDbF`
   (65; 60 for fixed orifice when the chart allows) in cooling unless head-pressure control is
   confirmed, `economizerPosition == open`, `capacityPercent < 100` / part stage /
   digital-variable compressor with unknown capacity, `runtimeMinutes < 10`, dehumid reheat
   active, defrost active, heating mode. When not ok, `chargeRelated` findings are downgraded to
   `info` and prefixed "readings not valid for charge determination"; the assistant must not
   recommend adding/removing refrigerant.
4. **Rules** (data, ≥ 35): the six-parameter cooling-cycle chart (suction pressure, head
   pressure, superheat, subcooling, amps, delta-T vs expected) for undercharge, overcharge,
   liquid-line restriction (drier/TXV screen; drier drop > 3 °F, frost/sweat at drier), low
   evaporator airflow (fixed orifice: low suction, low SH, normal-to-slightly-high SC, low
   delta-T; TXV: low suction, normal SH, high delta-T), high load/airflow, low condenser
   airflow/dirty coil/recirculation (high split), non-condensables (high head + high SC not
   responding to charge; standing pressure > sat at ambient by > 5 psi), TXV overfeeding (low
   SH, normal SC; bulb loose/stuck open), TXV underfeeding/starving (high SH with normal SC:
   lost power-head charge, plugged inlet screen, bulb location), inefficient compressor (high
   suction, low head, low amps, low CR), wrong refrigerant, minimum superheat < 5 °F at the
   compressor (floodback, critical), discharge superheat < ~30–35 °F (wet compression), > 100 °F
   with high SH (starving/overheating), discharge line > 225 warn / > 250 critical (Copeland,
   6 in. from compressor; R-32/R-454B run 15–25 °F hotter), compression ratio per mode
   (AC advisory > 3.5, warning > 4.5; medium-temp refrigeration normal 4–8; low-temp 8–12),
   amps > RLA warning, amps < 50 % RLA running → low load/undercharge/not pumping (normal
   running current 60–90 % RLA), sight-glass rules (bubbles + normal/high SC → restriction
   upstream; bubbles + low SC → undercharge; flashing), low-ambient head-pressure control
   (below 65 °F expect fan cycling/VFD/flooding valve holding condSat ≈ 90–105 °F; condSat < 85 °F
   with low suction and high SH → head control failed, not undercharge; flooded condensers hold
   extra charge — suppress overcharge from SC alone when `headPressureControl == flooding_valve`),
   hot gas bypass holding suction (suppress low-load finding), part-load/tandem (amps, TD and
   delta-T per running stage; check oil equalization), reversing-valve leak-by (heating: low
   discharge SH + high suction; > 3–4 °F across the suction-side tubes), defrost diagnostics,
   metering-device guidance (fixed orifice → total SH at the outdoor unit; TXV → SC method with
   evaporator SH 8–12 °F and total SH 10–25 °F, TXV not blamed until SC is right; EEV → SH is
   controller-set, abnormal SH points to sensors/board/drive), refrigeration-mode targets
   (medium-temp evap TD 10–12 °F, low-temp 6–10, evaporator SH 6–10, total SH 20–30 °F, split
   20–30 °F), VRF/chiller scope advisory (see below), missing-measurement guidance.
   Every rule: id, condition, severity, confidence, priority, chargeRelated, appliesTo
   (meteringDevice/mode), when[], explanation (field language), nextChecks (measure X at Y,
   expect Z), safety, and a `source` note in explanation or notes (chart/bulletin it follows).
   Ranking: severity (critical > warning > advisory > info), then confidence, then priority,
   then rule order; dedupe by ruleId. `missing[]` names the measurements that would sharpen the
   result. Summary: 2–4 plain sentences with numbers and units.
5. **Test vectors**: every classic condition has a positive vector; a "normal system" vector
   (R-410A TXV: SH 10, SC 10, split 20, delta-T 18, CR 2.9, amps 80 % RLA) produces no
   warning-level finding; heating-mode and low-ambient vectors exercise the gates.

Defaults: `defaults` are for AC cooling (compressionRatioAdvisory 3.5, compressionRatioWarn
4.5, evapTd 30–40, split 15–30, delta-T 16–22); `byMode` overrides for refrigeration
(compression ratio advisory 8 / warn 12, evap TD 8–12) and heat-pump heating;
`efficiencyTier` narrows the split range (standard 25–30 °F; high-efficiency/microchannel
10–20 °F).

Scope statement (also in the system prompt): for `vrf_outdoor`/`vrf_indoor`/`mini_split` and
chillers the assistant never evaluates charge from gauge readings — charge is by weight/trim
per the manufacturer service tool (Daikin Service Checker, Mitsubishi Maintenance Tool, LG
LGMV); it decodes error codes, checks power/communication, and points to the procedure.

### Charging targets (`charging-targets.json`, `ChargingTargets`)

`fixedOrificeSuperheat`: the standard field chart (indoor WB 50–76 °F in 2 °F rows × outdoor DB
55–115 °F in 5 °F columns; null where charging is not recommended). `targetDeltaT`: evaporator
temperature-drop table by entering DB/WB (75/63 → 18–20, 75/58 → 22–24, 75/68 → 13–15 style).
`heatPumpHeating.notes`, refrigeration targets in `notes`. Nameplate/manufacturer charts take
precedence; the engine says so.

### Electrical (`components.json`, `procedures.json`, `ElectricalKnowledge`)

Components (≥ 22): run capacitor (±6 % of rating or the printed tolerance; µF under load =
2652 × A / V with amps on the capacitor lead, never compressor common; replace if bulged/
leaking), start capacitor (−0/+20 % typical; verify printed range) + potential relay,
contactor (closed-contact drop under load near 0 V; > ~0.5–1 V per pole = burned; coil ohms),
control relay, control transformer (taps, 24 VAC ≈ 27 V unloaded, VA sizing, secondary fuse),
single-phase compressor (R(S–R) = R(C–S) + R(C–R), C–R lowest, C–S highest; open C–S and C–R
with intact S–R usually = internal overload open, cool 1–2 h before condemning; megohm at
500 VDC: > 100 MΩ good, < 20 MΩ investigate, < 1 MΩ condemn; never megger in a vacuum; terminal
venting hazard), three-phase compressor (windings equal within ±5 %; scroll reverse rotation:
loud, no pumping, low amps, trips; phase rotation meter), scroll IPR/internal overload, condenser
fan PSC, belt-drive blower (tension, alignment, amps vs FLA), ECM/X13/constant-torque (high-voltage
present + low-voltage command test order; module vs motor), VFD (never megger with the drive
connected; output volts read wrong on most meters — use amps or a low-pass meter; DC-bus
discharge wait per manual, verify < 50 VDC; faults OC/OV/UV/OH/GF first checks; HOA/bypass),
crankcase heater, phase monitor, high-pressure switch (typical R-410A trip 600–650 psig — verify),
low-pressure switch (loss-of-charge vs low pressure), freeze stat, limit/rollout, defrost board +
sensors, economizer controller (W7220/JADE, Belimo ZIP, EconoMi$er; MAT/OAT/enthalpy sensors;
2–10 VDC actuator), thermostat/24 V circuit (R, C, Y1, Y2, G, W1, W2, O/B), fuses/breakers/
disconnect, low-ambient head-pressure controls (fan cycling switch, Motormaster/fan VFD, flooding
valve), hot-gas bypass / reversing-valve solenoids, anti-short-cycle timer, current sensor,
refrigerant detection system (RDS) on A2L units (sensor location, end-of-life codes, mitigation:
blower forced on, compressor/heat lockout).

Reference topics: voltage imbalance (NEMA MG-1: 100 × max|V − Vavg| / Vavg; investigate > 1 %,
derate > 2 % (≈0.95 @ 2 %, 0.88 @ 3 %, 0.82 @ 4 %, 0.75 @ 5 %), do not run > 5 %), current
imbalance (≤ 10 %; expect 6–10× the voltage imbalance), reading nameplates (RLA = MCC/1.56,
FLA, LRA, SF), rotation checks, voltage-drop measurement, safety (LOTO per NFPA 70E; live-dead-
live meter proof; CAT III/IV for 480/575 V; arc-flash PPE; capacitor discharge through a
bleed resistor; A2L + ignition sources), 24 V path tracing method (TRAN → fuse → board → HPS →
LPS → freeze stat → condensate overflow → duct smoke → fire-alarm relay → phase monitor →
contactor coil), reading ladder diagrams, wire-color caveats.

Procedures (≥ 16): unit completely dead; no cooling — fans run, compressor off; compressor hums/
won't start (1-ph); compressor won't start (3-ph); breaker/fuse trips; short cycling; condenser
fan dead; blower won't run; blower runs constantly; intermittent 24 V loss / control fuse
blowing; HPS trips; LPS trips/lockout; no heat on gas RTU (ignition sequence with flame-sense µA
board-specific, never bypass rollout/limit/pressure switch, CO check before return to service);
economizer not modulating; VFD fault / motor won't ramp; phase loss / reversed rotation after
power work; ECM blower dead; call present but unit idle (`no_call_verify_demand`: 24 V on Y1/Y2/
W1/G at the board with stat/BAS calling, BAS override/schedule); `24v_safety_chain_trace`
(momentary diagnostic jumper only, attended, never left); `a2l_mitigation_active` (blower
running continuously, no compressor → check RDS alarm before refrigerant work).

Calculators (`calcElectrical`): voltage_imbalance (avg, max deviation, %, NEMA derate factor),
current_imbalance (10 % guideline), capacitor_under_load (µF, % of rated, pass/fail ±6 %, invalid-
if-measured-on-common note), amps_vs_rla, temp_rise_cfm (CFM = output BTUh / (1.08 × ΔT); electric
heat: BTUh = kW × 3412 at 100 %), ohms_law, electric_heat_kw (kW = V·A·(√3 for 3-ph)/1000 vs
nameplate ±10 %), psychrometrics (RH, dew point, enthalpy, grains from DB/WB/elevation),
winding_check (1-ph C-S + C-R ≈ S-R within ~10 %; 3-ph legs within ±5 %; open/short flags),
megohm (bands above). Inputs validated; warnings instead of throws.

## Assistant (agent layer)

Request shape (`client.beta.messages.stream`): model `config.claudeModel`; `thinking: { type:
"adaptive" }`; `output_config: { effort }`; `max_tokens: 16000`; `system: [static block with
cache_control ephemeral, optional unit-context block (uncached)]`; `tools`: custom tools (last one
carries `cache_control`) + `{ type: "web_search_20260209", name: "web_search", max_uses: 5 }` when
enabled; `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"` when
`claudeFallbacks === "default"`. If the first request of a turn fails with
`Anthropic.BadRequestError` whose message matches /fallback/i, retry once without fallbacks,
set a process-wide `fallbacksSupported = false`, and emit a notice. Any other 400 → error
`api_error`. Log `usage.cache_read_input_tokens` per turn.

Custom tools (strict JSON schemas, `additionalProperties: false`; optional fields expressed as
nullable so `required` lists every property; results are compact JSON ≤ 8 kB):
`decode_unit` (model, serial?, manufacturer?, save?, site?, unit_tag?, nickname?) — upserts a
unit when `save` or a matching unit exists and returns `attachUnitId`; `find_unit` (query over
site/customer/tag/nickname/model/serial → top matches with last finding date; may attach);
`refrigerant_pt` (refrigerant, psig?, temp_f?, elevation_ft?) — bubble/dew/glide/safety class +
retrofit/lubricant notes; `calc_superheat_subcooling`; `diagnose_refrigeration` (all
DxMeasurements fields in snake_case) — returns derived, validity, findings (top 6), missing,
summary; `electrical_reference` (query, kind); `calc_electrical`; `lookup_fault_code` (code,
manufacturer?, platform?; accepts LED patterns like "IGC 3 flashes") — result text includes the
platform's `coverage` and each entry's `source`; `search_history` (query, unit_only?, site?,
since?) ≤ 10 hits, 300-char snippets; `get_unit_history` (unit_id?); `save_finding` (symptom,
cause?, resolution?, measurements?, parts?, tags?, circuit?, status?, refrigerant?,
refrigerant_added_lbs?, follow_up?, confirmed?) — `origin: "assistant"`, `confirmed` only when
the tech explicitly confirmed; `update_unit` (nickname, unit_tag, site, customer,
location_note, refrigerant, tonnage, voltage, phase, circuits, charge, nameplate, control_platform,
heat_type, metering_device, install_year, elevation_ft, notes); `set_conversation` (title?,
summary?).

Turn loop (`runTurn`), write order and stop reasons:

1. Reject with error `busy` if a turn is already running for the conversation (module-level map;
   route returns 409 before opening SSE). Reject `not_found` for unknown conversation.
2. **History repair**: load rows; if the last row is an assistant row containing `tool_use`
   blocks with no following `tool_result` row matching those ids, persist one synthetic
   `tool_result` row (`is_error: true`, "Tool execution was interrupted (server restart). Re-run
   the tool if still needed.") for every unmatched id. Two consecutive user rows are legal and sent
   as-is.
3. Persist the user row (images first, then text; `text` = user text). Set the title from the
   first 60 chars of the first user text (whitespace-collapsed) only while the title is still
   "New conversation" ("Photo of nameplate" when only images).
4. Build API messages with `buildApiMessages`: assistant rows through `toApiContent` (drop
   `fallback` blocks and every thinking/redacted_thinking/tool_use/server_tool_use-without-result
   block that precedes the last fallback block; keep text; replay everything after verbatim,
   thinking blocks included); user rows with image blocks older than `replayImageWindow` user
   turns get `[photo omitted from context: see earlier message]` text instead.
5. Stream. Stop reasons: `end_turn` → persist assistant row, done. `tool_use` → persist assistant
   row (verbatim `finalMessage().content`), execute only tool_use blocks after the last
   `fallback` block (all of them when none), in order; emit `tool_start`/`tool_end` per tool;
   persist ONE `tool_result` user row (kind `tool_result`, results in the same order as the
   tool_use blocks; `is_error: true` for failures); apply side effects (`attachUnitId` →
   `conversations.update` + `unit_attached` event; `setTitle`/`setSummary`); loop.
   `pause_turn` → persist assistant row, re-send with the assistant row last (no trailing user
   row), counts toward the cap, ≤ 3 continuations. `max_tokens` with a tool_use block → do not
   persist, error `max_tokens`. `max_tokens` text only → persist, notice "Response was cut
   off". `refusal` → do not persist, do not run tools, error `refusal` with
   `stop_details?.explanation`. Context-window errors → `context_full`. Iteration cap
   (`maxToolIterations`) → error `iteration_cap`.
6. Never persist an assistant message you did not get from `finalMessage()`. Exactly one terminal
   event (`done` with messageIds/model/usage, or `error`). Never throw.
7. Client disconnect does not abort the turn: `emit` becomes a no-op once the response is gone;
   the turn completes and persists. `POST /api/conversations/:id/stop` calls `stopTurn()` which
   aborts the SDK stream (request option `{ signal }`); on abort nothing is persisted for that
   assistant message and error `aborted` is emitted.
8. Error mapping: AuthenticationError → `auth` ("Anthropic API key missing or invalid — set
   ANTHROPIC_API_KEY"), RateLimitError → `rate_limit`, APIConnectionError → `network`, other
   APIError → `api_error` (status + message), anything else → `internal`.
9. Emit a `notice` when web search or a slow tool runs so the screen is not blank.

Unit context block (second system block, ≤ ~1500 tokens): unit record (tag, model, serial, site/
customer, refrigerant, tonnage, voltage/phase, circuits, charge, nameplate data, control
platform, age), decoded summary + warnings, open/monitor findings first, then the last 5
confirmed findings (date, circuit, symptom → cause → resolution, measurements condensed),
assistant hypotheses (unconfirmed) listed separately, refrigerant added in the last 12 months,
last 5 conversation titles + summaries + dates excluding the current one; no "now" timestamps.

System prompt (deterministic; cached) — required content:

- Persona: senior commercial HVAC/R tech and trainer working alongside a field tech who is on a
  roof reading a phone. Concise, tech-to-tech, numbers with units, bold the single next step, a
  "what we know so far" recap every 3–4 exchanges or when readings arrive; disclaimers brief.
- Call flow: (1) nameplate/decode + attach unit, pull job memory and mention prior findings
  unprompted; (2) complaint, what changed, who called; (3) confirm demand at the unit (Y1/W1/G at
  the board, BAS override/schedule); (4) fault history (board LEDs/codes, tripped safeties: HPS/
  LPS/freeze/limit/rollout/phase monitor/duct smoke/fire-alarm relay, breakers/fuses); (5)
  non-invasive checks (filters, belts, coils, ESP, delta-T, amps, temps); (6) gauges only when
  justified (every hookup loses charge and admits contaminants; A2L needs rated gear); (7)
  `diagnose_refrigeration` with validity; (8) verify the fix, then offer `save_finding`, asking
  the tech to confirm before saving `confirmed`. Batch entry of readings is fine; otherwise one
  or two measurements at a time with the expected value and what each outcome means.
- Provenance: never state a fault-code meaning, serial date, or model attribute that did not
  come from a tool result or a cited web page; if a lookup has no hit say "no verified entry for
  this code on this platform" and offer to web-search the manual; prefix manufacturer-specific
  statements with their evidence ("Verified from Carrier product data", "Two third-party sources
  agree", "Low confidence — confirm on nameplate/IOM"); present every serial candidate when the
  decoder is ambiguous; never quote PT values, superheat targets, or tonnage from memory —
  always call the tool; label general-knowledge diagnostics vs unit-specific data. Web search
  (when enabled): prefer manufacturer domains, cite document title and section, treat forums as
  single-secondary evidence and say so.
- Hard safety rules (verbatim-level): never bypass or permanently jumper high-pressure switches,
  high limits, flame rollout, gas pressure switches, flame safeguards, or A2L detection
  mitigation; an LPS may be jumpered only momentarily for a diagnostic test the manufacturer's
  literature describes, attended, and removed before leaving; EPA §608 certification, no
  venting, recover before opening, never use refrigerant as a leak-test gas, pressure-test only
  with dry nitrogen through a regulator with relief, purge nitrogen while brazing, never mix
  refrigerants or retrofit R-454B/R-32 into R-410A equipment, follow AIM Act leak-repair rules
  for HFC appliances ≥ 15 lb; A2L: ventilate, no ignition sources, A2L-rated detector and
  recovery machine, RDS mitigation behavior; never add refrigerant without a leak check and
  valid readings; never diagnose charge below 65 °F outdoor without confirmed head-pressure
  control; LOTO per NFPA 70E with live-dead-live meter proof; CAT III/IV meter for 480/575 V;
  arc-flash PPE; discharge capacitors through a resistor; never megger in a vacuum or with a VFD
  connected; combustion/CO check after any gas-heat repair; warn at discharge temps > 225 °F;
  burnout/acid handling. The assistant says "not in my manufacturer data" rather than guessing.

## HTTP API (Express 5)

Error envelope for every non-2xx: `{ error: { code, message } }` — 400 validation, 401 auth, 404
unknown id, 409 busy, 413 too large, 500 other (no stack traces).

```
GET  /api/health                                   {ok, model, effort, webSearch, fallbacks, packs, refrigerants, rules, demo}
GET  /api/conversations?q=&unit_id=&limit=         newest updated first
POST /api/conversations {unit_id?, title?}
GET  /api/conversations/:id                        {conversation, unit, messages: DisplayMessage[], busy}
PATCH /api/conversations/:id {title?, unit_id?|null}
DELETE /api/conversations/:id
POST /api/conversations/:id/messages {text, images?} -> SSE (409 if busy)
POST /api/conversations/:id/stop                   {stopped: boolean}
GET  /api/units?q=&site=&limit=&include_archived=   POST /api/units {model?, serial?, manufacturer?, unit_tag?, ...} (decodes when model given; 200 if exists)
GET  /api/units/:id                 {unit, decoded, findings, conversations}   PATCH / DELETE (archives)
POST /api/decode {model, serial?, manufacturer?}   DecodeResult
GET  /api/search?q=&unit_id=&site=&since=&limit=   SearchHit[] (messages + findings + units)
GET  /api/findings?unit_id=&conversation_id=       POST /api/findings   DELETE /api/findings/:id
GET  /api/export                                   JSON of units, conversations, messages (no image data), findings
GET  /api/reference/refrigerants
GET  /api/reference/pt?refrigerant=&psig=|temp_f=&elevation_ft=   (bubble, dew, midpoint, glide, safety class, notes)
POST /api/calc/superheat-subcooling  {DxMeasurements-like; snake_case or camelCase}
POST /api/calc/diagnose              {DxMeasurements-like}
POST /api/calc/electrical            {ElectricalCalcRequest}
GET  /api/reference/electrical?component=|symptom=|q=
GET  /api/reference/fault?code=&manufacturer=&platform=
```

SSE wire format: headers `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control:
no-cache, no-transform`, `X-Accel-Buffering: no`; `res.flushHeaders()` before the model call;
each event `data: ${JSON.stringify(chatEvent)}\n\n` (no `event:` line — the client uses fetch +
ReadableStream because the request is a POST); heartbeat comment `: ping\n\n` every 15 s; the
client parses on blank lines. `DisplayMessage` folding: an assistant row's tool_use blocks are
joined with the tool_result blocks of the following tool_result row (by id; `ok = !is_error`;
`summary` = the result JSON's `summary` field if present else the first 200 chars; `label` =
`describeToolCall`); tool_result rows are not emitted separately; thinking blocks never reach
the browser.

Security: the server refuses to start (exit 1, clear message) when HOST is not a loopback
address and APP_PASSWORD is empty. Basic auth (any username) compares SHA-256 digests with
`crypto.timingSafeEqual`; `/api/health` is exempt. `express.json` limit 25 MB only on
`POST /api/conversations/:id/messages` (≤ 4 images, each ≤ 3.5 MB base64, data-URL prefix
stripped, media type validated by magic bytes), 1 MB elsewhere. State-changing routes require
`Content-Type: application/json` and, when an `Origin` header is present, its host must equal
the request `Host` (else 403). Parameterized SQL only; no shell/eval; chat markdown sanitized
with DOMPurify in the browser; `x-powered-by` disabled.
README recommends a VPN/Tailscale for phone → server rather than exposing plain HTTP.

Graceful shutdown: on SIGINT/SIGTERM stop accepting connections, wait up to 30 s for in-flight
turns (`turnsInFlight()`), end open SSE responses with error `aborted`, close the DB, then
`server.closeAllConnections()`. Backup: `sqlite3 data/hvac.sqlite '.backup data/backup.sqlite'`.

Demo mode: `CLAUDE_FAKE=1`, or no `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` in the environment,
uses `createFakeClient()` and logs loudly; `/api/health` reports `demo: true`.

## Web UI

Single page, mobile-first (≥ 900 px: sidebar | chat | unit panel; phones: top bar toggling
slide-over drawers). Theme follows `prefers-color-scheme` by default with a one-tap toggle
(persisted in localStorage, try/catch); dark theme for low light, high-contrast light theme
(≥ 7:1 text contrast) for sunlight. 48 px tap targets, 17 px base font (inputs ≥ 16 px), safe-area
insets, no hover-only affordances, plain textarea so OS dictation works, composer and quick
chips at the bottom, no horizontal scroll at 360 px, `navigator.wakeLock` while a procedure is
shown (best effort).

- Sidebar: FTS search (debounced), New conversation, Units grouped by site (click → unit panel +
  its conversations), Conversations list (title, relative time, unit tag/model badge), delete
  with confirmation.
- Chat: markdown via marked + DOMPurify (links target=_blank rel=noopener), user images as
  thumbnails, tool chips inline in order (spinner → ✓/✗ + summary; click to expand input/
  result), streaming deltas, auto-scroll unless scrolled up, notices muted, errors as a banner
  with the code; Stop button (POST /stop); composer (Enter sends on desktop, newline on touch;
  Send button), photo attach (`capture="environment"`, client-side resize ≤ 1568 px JPEG 0.85,
  ≤ 4 images), quick-start chips when empty: "Decode a nameplate" (opens the camera directly
  and sends with a fixed prompt to read model/serial and call decode_unit), "Refrigeration
  cycle check" (opens the Readings sheet), "Unit is dead — electrical", "Look up a fault code",
  "What did we do last time on this unit?". On reconnect/visibility change the client
  re-fetches the conversation and reconciles (the server keeps running after a dropped SSE);
  409 busy → show "response in progress" and poll.
- Readings sheet (bottom sheet on mobile) with `inputmode="decimal"` fields: circuit,
  refrigerant (prefilled from unit), metering device, mode, suction psig/line temp, liquid psig/
  temp, discharge temp, outdoor DB, entering DB/WB, supply DB, amps L1/L2/L3 + RLA, ESP,
  capacity %, economizer position, elevation; "Diagnose" posts to `/api/calc/diagnose`, shows
  the result, and "Send to chat" inserts a compact readings message.
- Unit panel: form (manufacturer hint, model, serial, unit tag, nickname, site, customer,
  elevation) → Decode (POST /api/decode) → card: manufacturer/family/product type, attributes
  table, manufacture date & age, control platforms (codes count), warnings, confidence chips,
  "verify on nameplate" badge whenever any match is not `high`, evidence summary, literature
  link; Save unit; Attach to conversation; findings list (open/monitor first; hypotheses marked)
  with a "confirm" action; "New conversation on this unit". Calculators accordion: PT lookup,
  SH/SC, voltage imbalance, capacitor, temp-rise CFM, winding check, psychrometrics — each with
  "Send to chat".

## Configuration (`.env`)

```
ANTHROPIC_API_KEY=...        required (or ANTHROPIC_AUTH_TOKEN / `ant auth login`); demo mode otherwise
CLAUDE_MODEL=claude-opus-5
CLAUDE_EFFORT=high           low|medium|high|xhigh|max
CLAUDE_FALLBACKS=default     default|off
ENABLE_WEB_SEARCH=0          1 lets the assistant search the web for manufacturer literature (.env.example ships 1; adds API cost per search)
REPLAY_IMAGE_WINDOW=10       user turns whose photos are kept in model context (0 = all)
MAX_TOOL_ITERATIONS=12
PORT=8787  HOST=127.0.0.1  DB_PATH=./data/hvac.sqlite  APP_PASSWORD=   CLAUDE_FAKE=0
```

## Testing

- `npm run check` typechecks sources and tests (tsconfig.test.json); `npm run check:knowledge`
  (`scripts/check-knowledge.ts`) loads every pack strictly and runs every example through the
  decoder — a bad pack fails CI. `packs.test.ts` does the same under `node --test`.
- Unit tests per module; refrigerant tables spot-checked against published points.
- Agent loop tested with the fake client (plain answer, tool round-trip and replay pairing,
  history repair, unit context, busy lock, title, refusal, max_tokens, pause_turn, iteration
  cap, fallback retry, stop/abort).
- API tested with `fetch` against `createApp()` on an ephemeral port with an in-memory DB.
