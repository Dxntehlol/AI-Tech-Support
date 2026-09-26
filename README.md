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

Everything runs on one machine with Node.js; the only external call is to the Anthropic API.

## What's inside

| Area | Contents |
| --- | --- |
| Refrigerants | 45 PT tables generated from CoolProp (dew/bubble for zeotropes, elevation correction) |
| Manufacturer packs | 8 packs covering 83 brand names: 46 serial-number formats, 75 model nomenclatures, 44 control platforms |
| Fault codes | 1,047 sourced fault/alarm codes and 201 LED flash patterns, plus 76 common-issue entries and 20 per-family electrical profiles |
| Worked examples | 367 real nameplates that decode as tests on every run |
| Diagnostics | 90 refrigeration-cycle rules with mode overrides (AC, heat-pump cooling/heating, refrigeration) |
| Electrical | 29 component test procedures, 22 symptom procedures, 10 calculators |

Every manufacturer claim carries a confidence level (`high` / `medium` / `low`), an evidence
level, and the sources it came from, so the assistant can tell you when to check the nameplate
instead of trusting the pack.

## Quick start

Requirements: Node.js 22.18 or newer and an Anthropic API key.

```bash
cd hvac-assistant
npm install
cp .env.example .env        # put your ANTHROPIC_API_KEY in .env
npm run dev                 # http://127.0.0.1:8787
```

Production: `npm run build && npm start`. Without an API key the server starts in **demo mode**
with canned responses so you can explore the UI and calculators.

## Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Required for the assistant (or `ANTHROPIC_AUTH_TOKEN` / an `ant auth login` profile). |
| `CLAUDE_MODEL` | `claude-opus-5` | Model id. |
| `CLAUDE_EFFORT` | `high` | `low` … `max`; trade thinking depth for cost. |
| `CLAUDE_FALLBACKS` | `default` | Server-side refusal fallback (`off` to disable). |
| `ENABLE_WEB_SEARCH` | `1` in `.env.example` | Let the assistant search the web for manufacturer literature (each search adds API cost). |
| `REPLAY_IMAGE_WINDOW` | `10` | Photos older than this many user turns are dropped from model context (0 = keep all). |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Bind address. The server refuses to start on a non-loopback host without `APP_PASSWORD`. |
| `APP_PASSWORD` | — | Enables HTTP basic auth (any username). |
| `DB_PATH` | `./data/hvac.sqlite` | SQLite file (WAL mode). |
| `CLAUDE_FAKE` | `0` | `1` forces demo mode. |
| `ALLOW_ORIGINS` | — | Comma-separated origins allowed via CORS, for native app shells (e.g. `capacitor://localhost,http://localhost`). Empty = same-origin only. |
| `MAX_TOOL_ITERATIONS` | `12` | Tool calls the assistant may make in one turn before it must answer. |

## Using it on a phone

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

Once installed, the app shell, the refrigerant tables, and the calculators (PT chart,
superheat/subcooling, electrical) work with no signal. Chat, decoding, and history need the
server. A service worker caches the shell and refreshes it on the next launch after an update.

## Native app (App Store / Play Store)

The client is a static bundle (`web/`) that talks to the API over HTTP with no same-origin
assumptions, so it can be wrapped as a native app with [Capacitor](https://capacitorjs.com)
without code changes. The sketch:

```bash
npm install @capacitor/core @capacitor/cli
npx cap init "HVAC Field Assistant" com.example.hvacassistant --web-dir web
npx cap add ios && npx cap add android
npx cap sync && npx cap open ios
```

Then:

- **Point the app at your server.** Either set `window.APP_CONFIG = { apiBase: "https://hvac.example.com" }`
  in a `web/config.js` shipped with the bundle, or enter the URL in **Settings → Server URL**.
  The token entered in Settings is sent as `Authorization: Bearer <APP_PASSWORD>`.
- **Allow the native origin on the server.** Set `ALLOW_ORIGINS=capacitor://localhost,http://localhost`
  (add `ionic://localhost` for older shells). Only listed origins get CORS headers; the default
  is same-origin only.
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
- Charge diagnosis is for DX systems. For VRF, mini-splits and chillers the assistant reads
  codes and guides procedure but does not judge charge from gauges.

## Development

```bash
npm run check            # typecheck sources and tests
npm test                 # unit tests (node --test)
npm run check:knowledge  # validate every knowledge pack and decode every example
npm run gen:refrigerants # regenerate PT tables (needs: pip install CoolProp)
```

The UI is plain HTML/CSS/JS with no build step (`web/`). It was reviewed with screenshots at
360×780, 390×844, 820×1180 and 1280×800 in both themes; `node --check web/*.js` and a
Playwright run against the demo server are the quick checks after a client change.

Layout, contracts and the verification protocol for knowledge packs are in `DESIGN.md`.
Manufacturer packs live in `knowledge/manufacturers/*.json`; every serial format and model
format ships with worked examples that run as tests, and every fault code carries its source.

## Backup

`sqlite3 data/hvac.sqlite '.backup data/backup.sqlite'` is WAL-safe; `GET /api/export` returns a
JSON export of units, conversations, messages (without photos) and findings.
