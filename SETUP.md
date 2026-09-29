# Setting up the prototype

Four things stand between the code and a working prototype in the field: an Anthropic API
key, a machine that runs the server, the phone install, and a few of your own units in the
database. Everything below can be re-run safely.

## 1. Anthropic API key (10 minutes)

1. Sign in at https://console.anthropic.com, add a payment method or credits, open **API Keys**
   and create a key. Copy it now; it is shown once.
2. It goes into `.env` on the server, either by editing the `ANTHROPIC_API_KEY=` line or by
   handing it to the setup script through the environment (step 2). Never paste it into chat
   logs or command-line arguments.

Without a key the app still runs, in **demo mode** with canned answers, so the rest of the setup
can be done first.

## 2. The server (one command, about 15 minutes)

Pick an always-on machine at the shop: a spare laptop, a mini PC, or a small VPS. Install
[Node.js](https://nodejs.org) 22.18 or newer, then:

```bash
git clone https://github.com/Dxntehlol/AI-Tech-Support.git
cd AI-Tech-Support
node scripts/setup.mjs
```

The script installs dependencies, builds, creates `.env` with a generated access password,
starts the server under **pm2** (so it restarts on reboot and after crashes), checks
`/api/health`, and prints the password and next steps. To have the key written into `.env`
without typing it into the command line:

```bash
( read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY && node scripts/setup.mjs )   # macOS / Linux: paste, Enter
```

```powershell
$env:ANTHROPIC_API_KEY = Read-Host -MaskInput "API key"; node scripts/setup.mjs; Remove-Item Env:ANTHROPIC_API_KEY   # Windows PowerShell 7
```

Options: `--port 9000` (remembered in `.env`), `--no-tailscale` for a machine-only install,
`--no-service` to skip pm2 and run `npm start` yourself.

Check: `node scripts/setup.mjs --check` prints OK on every line except Tailscale (until the
next section) and, on Linux without root, "Start on boot" until you run the `sudo` command it
shows once. Running the script with a key in the environment again replaces the key in `.env`;
editing `.env` by hand works too.

Open `http://127.0.0.1:8787` on that machine. The browser asks for a username and password
first: type anything as the username and the printed access password.

### Reach it from the phone over HTTPS with Tailscale

The installed app (home-screen icon, offline calculators) needs HTTPS. Tailscale gives every
machine a private HTTPS address that only your own devices can reach, with no port forwarding.

1. Install Tailscale on the server from https://tailscale.com/download and sign in
   (`tailscale up` on Linux; the app on macOS/Windows).
2. In the Tailscale admin console under **DNS**, turn on **MagicDNS** and **HTTPS Certificates**.
3. Re-run `node scripts/setup.mjs`. It detects Tailscale, runs `tailscale serve --bg 8787`, and
   prints the address, like `https://shop-pc.tail1234.ts.net`.

### Other ways to run it

- **Docker** (VPS or NAS): `cp .env.example .env`, set `APP_PASSWORD` (and the key) in it, then
  `docker compose up -d --build`. The port is published on `127.0.0.1:8787` of the host only and
  the database lives in the named volume `hvac-data`. For phones, install Tailscale on the host
  and run `tailscale serve --bg 8787` there. Any other reverse proxy must pass the original
  `Host` header or set `X-Forwarded-Host`, or writes are rejected as cross-site.
  Backup: `docker compose exec hvac npm run backup` writes a dated copy inside the container; fetch
  them with `docker compose cp hvac:/app/backups ./backups`.
- **No service manager**: `npm run build && npm start` in a terminal you keep open.

## 3. The phone (5 minutes)

1. Install Tailscale on the phone and sign in to the same account.
2. Open the address from step 2 in Safari (iOS) or Chrome (Android). At the login prompt type
   anything as the username and the access password.
3. **Settings → Access password**: enter the same password and save. This keeps the installed
   app signed in without the browser prompt.
4. Install: iOS **Share → Add to Home Screen**; Android **menu → Install app**.

Check: create a unit from the Units tab. Then turn on airplane mode and open Readings; the
calculators must still work.

## 4. Seed it with your own fleet (an afternoon, then ongoing)

1. Add five to ten real units from **Units → +** (type model and serial, or photograph the
   nameplate in chat and ask the assistant to decode and save it).
2. Compare each decode with the nameplate and the IOM: manufacturer, tonnage, refrigerant,
   voltage, manufacture date and age, control platform. Anything below **high** confidence is a
   claim to verify, not a fact.
3. Look up two or three fault codes you meet often on those platforms and confirm them against the
   manual.
4. After the next few calls, let the assistant save the finding when the cause is confirmed (or add
   it on the unit card). History and the assistant's memory become useful once real findings exist.
5. Keep a list of anything it gets wrong (model, serial, what it said, what was true). Each is a
   one-line correction to a manufacturer pack under `knowledge/manufacturers/`.

## 5. Cost knobs (after a week)

Every model request logs its input, output and cached-input token counts (`pm2 logs hvac`).
After a few days of real use, compare with the usage page in the Anthropic console and adjust
in `.env`:

- `CLAUDE_EFFORT=medium` trades some reasoning depth for cost (default `high`).
- `ENABLE_WEB_SEARCH=0` if you rarely need literature it does not already know.
- `REPLAY_IMAGE_WINDOW` lower if conversations carry many photos.

Apply any `.env` change with `node scripts/setup.mjs` (it restarts the server with exactly what
is in `.env`; a plain `pm2 restart hvac` also works, ignore its `--update-env` hint).

## Everyday commands

```bash
node scripts/setup.mjs --check      # doctor: state of every step, changes nothing
node scripts/setup.mjs              # apply .env changes / update after git pull (restarts the server)
pm2 logs hvac                       # live server log (token counts per request, errors)
npm run backup                      # WAL-safe copy of the database into backups/ (no sqlite3 needed)
```

The access password is the `APP_PASSWORD` line in `.env`. Changing it means re-entering it on
every phone. `GET /api/export` in a signed-in browser downloads a JSON export as well.
