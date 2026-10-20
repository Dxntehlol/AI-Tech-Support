# HVAC Field Assistant

A self-hosted troubleshooting assistant for commercial HVAC/R technicians. It pairs a
Claude-powered chat assistant with a local knowledge base and a job memory:

- **Refrigeration-cycle diagnostics** — PT charts for 45 refrigerants (generated from
  CoolProp), superheat/subcooling with dew/bubble handling for blends, elevation correction,
  a rule engine that evaluates suction/head/SH/SC/amps/ΔT together, and a *validity gate* that
  refuses to call a charge problem when the readings can't support it (low ambient, economizer
  open, part load, defrost, heating mode).
- **Model & serial decoding** — manufacturer packs (Carrier/Bryant/ICP, Trane/American
  Standard, Lennox, York/JCI/Coleman/Luxaire, Daikin/Goodman/Amana, Rheem/Ruud, AAON,
  Copeland/Danfoss/Bristol compressors, and others) decode the nameplate into family,
  tonnage, voltage/phase, refrigerant, heat type, control platform and manufacture date,
  with confidence and provenance on every claim, plus fault/alarm code tables, typical
  component designators and known issues per family. Optional web search lets the assistant
  pull the manufacturer's literature for the exact model.
- **Electrical troubleshooting** — component test procedures with pinned tolerances, symptom
  procedures (unit dead, compressor won't start, gas ignition, phase loss, A2L mitigation…),
  and calculators (voltage/current imbalance, capacitor under load, amps vs RLA, temp-rise
  CFM, electric heat kW, winding checks, megohm bands, psychrometrics).
- **Job memory** — units, conversations, and findings live in SQLite with full-text search.
  Attach a conversation to a unit and the assistant sees its history (open items, confirmed
  fixes, refrigerant added) before you ask.
- **Fleet import** — paste rows from a spreadsheet or pick a CSV (Model, Serial, Site, Tag; up to
  200 units), preview every row decoded and marked new / duplicate / error, then import the new ones
  in one transaction (**Units → Import units**, `POST /api/units/import`).
- **Decode corrections** — "Report a wrong detail" on a unit records what the app said and what the
  nameplate says (optionally fixing the unit too); the assistant trusts it over the decoder, and
  **Settings → Decode corrections → Export** downloads them as JSON for fixing the manufacturer packs.
- **Readings history and trend** — "Save to unit" on the Readings tab (and every diagnosis the assistant runs on an
  attached unit) keeps the readings on the unit; the unit card and the assistant compare a new visit with the last
  one in the same mode and similar weather ("Subcooling fell from 12 to 4 °F since 2026-08-02 - charge loss or
  restriction trend").
- **Follow-ups** — a finding's follow-up gets a due date; the History tab lists open follow-ups (overdue / due
  this week, tap Done), the tab badge counts the overdue ones, and the assistant raises them at the start of a visit.
- **In-app AI connection** — paste the API key on the phone (**Settings → AI connection**), test it
  (key, model and billing are checked separately), pick model, effort and web search; changes apply
  without a restart.
- **Usage and cost** — **Settings → Usage** shows requests, tokens, web searches and cost estimated
  at list price over 7/30/90 days, by day and by model.
- **Service reports** — the share button in a chat (and **Unit report** on a unit card) shares a plain-text
  summary, opens a printable page (Print / Save as PDF) or copies Markdown: unit header, complaint, every
  readings/diagnosis in the conversation, findings, open items and the assistant's summary
  (`GET /api/conversations/:id/report`, `GET /api/units/:id/report`, `?format=md|html|json`).
- **QR labels** — **QR label** on a unit card prints a sticker whose code opens that unit in the app;
  **Units → ⋮ → Print QR labels** prints one label per unit, two per row.
- **Refrigerant log and EPA compliance** — every add, recovery, leak check, verification test, repair or retrofit plan
  is logged on the unit (the unit card's **Refrigerant** card → **Log refrigerant**, `POST /api/units/:id/refrigerant`,
  or the assistant's `log_refrigerant`); the card shows a compliance chip (not applicable / OK / exceeded with the
  30-day repair clock / "Set full charge"), the obligations with due dates and the event list; an add gets the
  annualized leak rate `(lb added ÷ full charge) × (365 ÷ days since last add) × 100` against the 10 / 20 / 30 %
  threshold for the appliance type (40 CFR 84.106), an exceedance opens a "repair within 30 days and verify" follow-up
  and the unit card shows the open obligations (repair, initial and follow-up verification, retrofit plan, inspection
  cadence); **Settings → Refrigerant log** (`GET /api/refrigerant/export.csv`) exports the whole log and reports carry an
  owner-documentation block.
- **PM checklists** — templates per equipment type (gas and electric RTUs, splits, heat pumps, air- and water-cooled
  chillers, walk-in coolers and freezers, ice machines, MAU/exhaust, boilers) with pass/fail, as-found/as-left numbers
  and nameplate comparisons (volts ±10 %, amps vs RLA, capacitors ±6 %); visits are stored per unit
  (`/api/pm/templates`, `/api/units/:id/pm`), the assistant sees the last visit's fails, and reports include the summary.
  On the phone: unit card → **Maintenance → Start PM** → template (suggested first) → a full-screen checklist with
  pass / fail / n/a, as-found / as-left numbers, inline nameplate verdicts, autosave that survives losing signal, and
  **Complete visit**.
- **Chiller readings mode** — chilled-water supply/return, evaporator and condenser saturated temperatures or pressures,
  condenser water or entering air, amps and oil become ΔT, tons, evaporator/condenser approaches and ranked findings
  (fouled tubes, dirty coil, low flow, overload) via `POST /api/calc/chiller` or the assistant's `diagnose_chiller`,
  stored as readings with mode `chiller` (Readings tab → **DX | Chiller** switch; the top finding is shown as the
  "Most likely cause" with its first check, in DX mode too).
- **Job clock and customer signature** — start/stop a job clock on a conversation (`POST /api/conversations/:id/job`)
  and capture a PNG signature with a name and a note such as "declined recommendation"
  (`POST /api/conversations/:id/signature`); the service report shows time on site and embeds the signature. In a chat
  with a unit attached, the bar under the header has **Start job** (a running timer that survives a reload) and
  **Customer sign-off** (signature pad).
- **Field calculators** — leak rate, gas meter clocking, CO air-free (100 / 400 ppm flags, ambient stop-work),
  sensible CFM, total external static (PSC/ECM limits), fan laws, belt drive (sheave ratio, belt length, deflection),
  voltage drop (Cu/Al, 1- and 3-phase, 3 % / 5 %), NEC 430.248/430.250 motor FLA, capacitor replacement check and a
  motor replacement checklist, all through `POST /api/calc/electrical` with the formula stated in every result; the
  Readings tab's calculators (grouped Refrigerant · Airflow · Combustion · Electrical · Parts) compute the same
  formulas on the phone when there is no signal.
- **Field ergonomics** — **Settings → Display**: glove mode (56 px targets, 18 px text) and sun mode (forced
  maximum-contrast light theme); a microphone in the composer dictates readings ("suction 118 p s i g" → "suction
  118 psig") where the browser supports speech recognition; the unit card lists the manufacturer's support phone
  numbers (tap to call) and literature links from the pack.

Everything runs on one machine with Node.js; the only external call is to the Anthropic API.

## What's inside

| Area | Contents |
| --- | --- |
| Refrigerants | 45 PT tables generated from CoolProp (dew/bubble for zeotropes, elevation correction) |
| Manufacturer packs | 12 packs covering 242 brand names: 47 serial-number formats, 158 model nomenclatures, 134 control platforms (incl. STULZ, Liebert/Vertiv, Data Aire, Uniflair, APC InRow, Rittal precision cooling) |
| Fault codes | 9,300 sourced fault/alarm codes and 458 LED flash patterns, plus 153 common-issue entries and 20 per-family electrical profiles |
| Worked examples | 547 real nameplates that decode as tests on every run |
| Manual library | Optional private full-text search over manufacturer manuals (`search_manuals`); see Configuration |
| Diagnostics | 90 refrigeration-cycle rules with mode overrides (AC, heat-pump cooling/heating, refrigeration) |
| Electrical | 29 component test procedures, 22 symptom procedures, 21 calculators |
| PM checklists | 11 equipment-type templates, 206 items with nameplate comparisons |

Every manufacturer claim carries a confidence level (`high` / `medium` / `low`), an evidence
level, and the sources it came from, so the assistant can tell you when to check the nameplate
instead of trusting the pack.

## Quick start

Requirements: Node.js 22.18 or newer and an Anthropic API key.

```bash
git clone https://github.com/Dxntehlol/AI-Tech-Support.git
cd AI-Tech-Support
npm install
cp .env.example .env        # put your ANTHROPIC_API_KEY in .env
npm run dev                 # http://127.0.0.1:8787
```

Instead of editing `.env` you can paste the key in the running app under **Settings → AI connection**
(Test, then Save).

Production: `npm run build && npm start`. Without an API key the server starts in **demo mode**
with canned responses so you can explore the UI and calculators.

## Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Required for the assistant (or `ANTHROPIC_AUTH_TOKEN` / an `ant auth login` profile). Overridden by a key saved in the app. |
| `CLAUDE_MODEL` | `claude-opus-5` | Model id. Overridden by Settings → AI connection once saved there. |
| `CLAUDE_EFFORT` | `high` | `low`, `medium`, `high`, `xhigh`, `max`; trade thinking depth for cost. Overridden once saved in the app. |
| `CLAUDE_FALLBACKS` | `default` | Server-side refusal fallback (`off` to disable). |
| `ENABLE_WEB_SEARCH` | `1` in `.env.example` | Let the assistant search the web for manufacturer literature ($10 per 1,000 searches). Overridden once saved in the app. |
| `REPLAY_IMAGE_WINDOW` | `10` | Photos older than this many user turns are dropped from model context (0 = keep all). |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Bind address. The server refuses to start on a non-loopback host without `APP_PASSWORD`. |
| `APP_PASSWORD` | — | Enables HTTP basic auth (any username). |
| `DB_PATH` | `./data/hvac.sqlite` | SQLite file (WAL mode). |
| `CLAUDE_FAKE` | `0` | `1` forces demo mode. |
| `TESTER_DAILY_CAP_USD` | `2` | Default estimated spend per tester per day (server-local) before chat is refused; `0` = no cap. Per-tester values override it. |
| `ALLOW_ORIGINS` | — | Comma-separated origins allowed via CORS, for native app shells (e.g. `capacitor://localhost,http://localhost`). Empty = same-origin only. |
| `MAX_TOOL_ITERATIONS` | `12` | Tool calls the assistant may make in one turn before it must answer. |
| `LIBRARY_DIR` | `./library` | Private manual library (see below). The search index is kept beside `DB_PATH` as `library-index.sqlite`. |

**Manual library.** The assistant's `search_manuals` tool searches the full text of manufacturer
manuals (IOMs, controller and service manuals) plus curated notes, and cites document, page and the
public URL. The manuals are the manufacturers' copyright and this repository is public, so the library
is **never committed**: copy the library folder (`manifest.json`, `<maker>/text/*.txt`, `<maker>/*.md`)
to `LIBRARY_DIR` on the server, then run `node scripts/setup.mjs` (or `npm run library:index`). The
index (SQLite FTS5, bm25) rebuilds automatically when `manifest.json` changes. Without a library the
tool says so and the assistant falls back to the packs and web search.

**Photos.** Tap the camera to send a nameplate, controller screen, board LEDs, wiring diagram or gauge
photo, with or without text. The assistant reads it, transcribes the model, serial, alarm text or
readings, and runs the matching tools (decode, fault-code lookup, manual search, diagnostics) on its own.

**Settings in the app.** **Settings → AI connection** writes `settings.env` next to the database
(`data/settings.env`, mode 600; the `/app/data` volume in Docker). It holds only `ANTHROPIC_API_KEY`,
`CLAUDE_MODEL`, `CLAUDE_EFFORT` and `ENABLE_WEB_SEARCH`; values there override `.env` and the process
environment, apply without a restart, and an empty value means "use `.env`". Saving the card stores
the model, effort and web search it shows (and the key, if one was typed); **Remove saved key** clears
only the key. `GET /api/settings/ai` reports the key's source and last four characters, never the key.
With `CLAUDE_FAKE=1` the settings still save but demo mode stays on.

**Usage.** Every real model request is recorded in the database (tokens, cache reads and writes, web
searches; demo answers are not). **Settings → Usage** (`GET /api/usage?days=7|30|90`) shows totals,
by day and by model, with cost **estimated at list price** for `claude-opus-5`, `claude-opus-5-5` and
`claude-fable-5-1` (cache writes 1.25x input, cache reads at the stated price or 0.1x input, web
search $10 per 1,000). Other models show "cost not estimated". Records older than 400 days are pruned
at startup.

## Using it on a phone

**Shortcut:** on the machine that will run the server, `node scripts/setup.mjs` does the whole
server side (install, build, `.env` with a generated password, pm2 service, Tailscale HTTPS) and
prints what to enter on the phone. `SETUP.md` walks through every step, including Docker.

The web client is a mobile-first progressive web app (PWA). Phones are the primary platform:
a bottom tab bar (Chat · Units · Readings · History · Settings), safe-area aware layouts, a
composer that stays above the keyboard, camera capture for nameplates, and light/dark themes
tuned for sunlight and night work.

1. Run the server somewhere your phone can reach: a laptop on the same Wi-Fi, a home server, or
   a small VPS. Prefer a VPN (Tailscale/WireGuard) over exposing plain HTTP. If you bind to a
   non-loopback address, the server requires `APP_PASSWORD`.
2. Open the address in Safari (iOS) or Chrome (Android) and install it:
   - iOS: Share → **Add to Home Screen**.
   - Android: browser menu → **Install app** (or tap the *Install app* button in Settings).
3. Enter the access password in **Settings → Access password**. It is sent as a Bearer token
   on every request and stored only on that device.

### Letting friends test it

**Settings → Testers** (owner only, shown once `APP_PASSWORD` is set) creates a login per tester: the
app generates a password, shows it once with a ready-to-send invite, and you can turn a tester off,
reset their password, set their daily budget or remove them at any time. A tester signs in with their
name and password (browser prompt or Settings → Access password), sees only the conversations they
started, cannot open the AI connection, usage or export cards, and is refused new chats once their
estimated spend for the day reaches the cap (`TESTER_DAILY_CAP_USD`, default $2, or a per-tester
value; 0 = no cap). Each tester's requests are attributed in the usage history and their chat turns,
errors and cap hits are logged, so the owner's list shows spend, activity and last sign-in per person.
Send testers [docs/TESTERS.md](docs/TESTERS.md).

Once installed, the app shell, the refrigerant tables, and the calculators (PT chart,
superheat/subcooling, electrical) work with no signal. Chat, decoding, and history need the
server. A service worker caches the shell and refreshes it on the next launch after an update.

## Native app (App Store / Play Store)

The client is a static bundle (`web/`) that talks to the API over HTTP with no same-origin
assumptions, so it can be wrapped as a native app with [Capacitor](https://capacitorjs.com)
without code changes. The scaffold is in the repository: `capacitor.config.json` (app id
`com.hvacfieldassistant.app`, web dir `web`, Android scheme `https`) and two scripts:

```bash
npm run cap:init      # prints the setup commands below; runs nothing
npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
npx cap add ios && npx cap add android
npm run cap:prepare   # writes web/config.js for the bundle (apiBase "", version from package.json)
npx cap sync && npx cap open ios   # or: npx cap open android
```

Then:

- **Point the app at your server.** The Node server generates `/config.js` on the fly; a bundle has no
  server, so `cap:prepare` copies `web/config.capacitor.js` to `web/config.js` (git-ignored) with
  `apiBase: ""` and `bundled: true`. On first launch the app opens **Settings** with a "Set your server
  URL" prompt; enter the server address and the access password there (sent as
  `Authorization: Bearer <APP_PASSWORD>`). To hard-wire a server instead, put its origin in `apiBase`
  before running `cap sync`.
- **Allow the native origin on the server.** Set `ALLOW_ORIGINS=capacitor://localhost,https://localhost,http://localhost`
  (add `ionic://localhost` for older shells). Only listed origins get CORS headers; the default
  is same-origin only.
- **QR labels open in the browser.** A phone camera hands the scanned `https://…/#unit/<id>` link to the
  browser, not to the installed app; the web client routes it to the unit.
- **Store listing.** The app uses the camera only for nameplate photos, keeps the access
  password on the device, and does no tracking; say so in the privacy notes. Icons at
  192/512 px (plus a maskable variant and a 180 px Apple touch icon) are in `web/icons/`,
  generated by `scripts/gen_icons.py`.

## How a call flows

1. **Nameplate** — type the model/serial or take a photo; the decoder returns family,
   tonnage, voltage, refrigerant, control platform, manufacture date and age with a confidence
   level and the evidence behind it. Save the unit and attach the conversation.
2. **History** — the assistant reads that unit's prior findings and other conversations
   before it suggests anything, and you can search all past jobs.
3. **Complaint → demand → faults → non-invasive checks → gauges** — the assistant follows
   the same order a good tech does and asks for one or two readings at a time, stating what it
   expects and what each outcome means.
4. **Readings sheet** — enter suction/liquid pressures and temperatures, air temps, amps, and
   conditions; the engine returns derived metrics, a validity verdict, and ranked findings with
   next checks. "Send to chat" gives the assistant the same numbers.
5. **Fix and record** — when the cause is confirmed, the assistant offers to save the finding
   (symptom → cause → resolution, parts, measurements, refrigerant added). Unconfirmed
   hypotheses are stored separately so they never masquerade as history.

## Safety and limits

- The assistant is a second set of eyes, not a substitute for the manufacturer's literature,
  EPA 608 rules, NFPA 70E, or your judgment. It will not help bypass safeties, vent
  refrigerant, or work energized without PPE.
- Manufacturer data carries a confidence level. Anything below `high` should be confirmed on
  the nameplate, wiring diagram, or IOM; fault-code tables are marked `partial` unless the full
  table was transcribed.
- Refrigerant tables come from CoolProp. Blends that CoolProp does not ship as predefined
  mixtures are built from their mass fractions; a few legacy blends are marked approximate.
- PT tables run to 160 °F. Above that the saturation temperature is extrapolated from the table
  tail and flagged as approximate; a head pressure that high is itself the finding.
- Charge diagnosis is for DX systems. For VRF, mini-splits and chillers the assistant reads
  codes and guides procedure but does not judge charge from gauges.

## Development

```bash
npm run check            # typecheck sources, server tests and web-client tests
npm test                 # unit tests (node --test): src/**/*.test.ts and web/*.test.ts
npm run check:knowledge  # validate every knowledge pack and decode every example
npm run doctor           # state of a deployed instance (.env, service, health, Tailscale)
npm run gen:refrigerants # regenerate PT tables (needs: pip install CoolProp)
node scripts/smoke.mjs http://127.0.0.1:8787   # end-to-end HTTP smoke against a running (demo) server (incl. settings, usage, import, corrections)
```

The UI is plain HTML/CSS/JS with no build step (`web/`). It was reviewed with screenshots at
360×780, 390×844, 820×1180 and 1280×800 in both themes; `node --check web/*.js` and a
Playwright run against the demo server are the quick checks after a client change.

Layout, contracts and the verification protocol for knowledge packs are in `DESIGN.md`.
Manufacturer packs live in `knowledge/manufacturers/*.json`; every serial format and model
format ships with worked examples that run as tests, and every fault code carries its source.

## Backup

`npm run backup` writes a WAL-safe copy into `backups/` (no sqlite3 CLI needed); `GET /api/export` returns a
JSON export of units, conversations, messages (without photos), findings and decode corrections. The envelope's
`complete` flag is false when a collection hit the export cap, so a partial backup never looks whole.
