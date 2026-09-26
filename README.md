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

Using it from a phone: run the server on a laptop or home server and reach it over a VPN
(Tailscale/WireGuard) rather than exposing plain HTTP. If you must bind to the LAN, set
`HOST=0.0.0.0` and an `APP_PASSWORD`.

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

Layout, contracts and the verification protocol for knowledge packs are in `DESIGN.md`.
Manufacturer packs live in `knowledge/manufacturers/*.json`; every serial format and model
format ships with worked examples that run as tests, and every fault code carries its source.

## Backup

`sqlite3 data/hvac.sqlite '.backup data/backup.sqlite'` is WAL-safe; `GET /api/export` returns a
JSON export of units, conversations, messages (without photos) and findings.
