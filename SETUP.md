# Setting up the prototype

Four things stand between the code and a working prototype in the field: an Anthropic API
key, a machine that runs the server, the phone install, and a few of your own units in the
database. Everything below can be re-run safely.

## 1. Anthropic API key (10 minutes)

1. Sign in at https://console.anthropic.com, add a payment method or credits, open **API Keys**
   and create a key. Copy it now; it is shown once.
2. **Easiest: paste it in the app.** Once the server runs (step 2), open the app on the phone or
   in a browser on the server machine and go to **Settings → AI connection**. Paste the key, tap
   **Test** (it checks the key, the model and that the account can be billed, and says which one
   failed), then **Save**. It takes effect immediately, no restart, and the card shows only the
   last four characters from then on.
3. **Alternative: the terminal.** Put the key into `.env` on the server, either by editing the
   `ANTHROPIC_API_KEY=` line or by handing it to the setup script through the environment
   (step 2). Never paste it into chat logs or command-line arguments.

A key saved in the app is written to `settings.env` next to the database (`data/settings.env`,
mode 600; the `hvac-data` volume in Docker) and wins over `.env`, as do the model, effort and web
search set on the same card (**Remove saved key** clears only the key, so the `.env` key applies again).

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
editing `.env` by hand works too (a key saved in the app still wins over either).

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

1. Import the fleet in one go: **Units → Import units** (the upload icon in the Units top bar).
   Paste rows copied from a spreadsheet (columns **Model, Serial, Site, Tag**; a header row is
   optional, Manufacturer, Customer and Notes columns are read too), or **Choose CSV file**.
   **Copy template** puts a header plus two example rows on the clipboard. Tap **Preview**: every
   row is decoded and marked new, duplicate (already saved, or repeated in the paste) or error,
   with manufacturer, tonnage, refrigerant, age and a confidence chip. Nothing is saved yet. Then
   tap **Import N units** to save the new rows (duplicates and errors are skipped). Up to 200
   units per import. Single units still go in through **Units → +** (type model and serial, or
   photograph the nameplate in chat and ask the assistant to decode and save it).
2. Compare each decode with the nameplate and the IOM: manufacturer, tonnage, refrigerant,
   voltage, manufacture date and age, control platform. Anything below **high** confidence is a
   claim to verify, not a fact.
3. When something is wrong, open the unit and tap **Report a wrong detail** (also under **More**
   on the unit card). Pick what is wrong, type what the nameplate actually says, and tick **Also
   update this unit** to fix the saved manufacturer, tonnage, voltage, phase or refrigerant as
   well. The assistant trusts the correction over the decoder for that unit from then on.
4. Look up two or three fault codes you meet often on those platforms and confirm them against the
   manual.
5. After the next few calls, let the assistant save the finding when the cause is confirmed (or add
   it on the unit card). History and the assistant's memory become useful once real findings exist.
6. Every so often, **Settings → Decode corrections → Export** downloads
   `hvac-corrections-YYYY-MM-DD.json` (on iPhone it opens the share sheet) with every correction,
   the model and serial it was about and the decoder format that produced it, and marks them
   exported. Send that file to whoever maintains the manufacturer packs under
   `knowledge/manufacturers/`; each entry is a one-line fix there.

## 5. Cost knobs (after a week)

**Settings → Usage** shows the last 7, 30 or 90 days: requests, tokens in and out, web searches,
the cost estimated at list price, an average per conversation, and a breakdown by day and by model.
Models without a list price on file show "cost not estimated". Your Anthropic invoice (the usage
page in the console) is the source of truth; compare the two after a few days of real use. Demo
answers are not counted. If the app is not reachable, `pm2 logs hvac` still prints the input,
output and cached-input token counts of every model request.

Adjust on **Settings → AI connection** and tap **Save** (applies immediately):

- **Effort** Med trades some reasoning depth for cost (default High).
- **Web search** off if you rarely need literature it does not already know ($10 per 1,000
  searches).
- **Model**: a cheaper model lowers the per-token price.

Saving that card writes the model, effort and web search into `data/settings.env`, so from then on
those three win over `CLAUDE_MODEL`, `CLAUDE_EFFORT` and `ENABLE_WEB_SEARCH` in `.env`. The other
knobs live only in `.env`, for example `REPLAY_IMAGE_WINDOW` lower if conversations carry many
photos. Apply a `.env` change with `node scripts/setup.mjs` (it restarts the server with exactly
what is in `.env`; a plain `pm2 restart hvac` also works, ignore its `--update-env` hint).

## Everyday commands

```bash
node scripts/setup.mjs --check      # doctor: state of every step, changes nothing
node scripts/setup.mjs              # apply .env changes / update after git pull (restarts the server)
pm2 logs hvac                       # live server log (token counts per request, errors; Settings → Usage is the friendlier view)
npm run backup                      # WAL-safe copy of the database into backups/ (no sqlite3 needed)
```

The access password is the `APP_PASSWORD` line in `.env`. Changing it means re-entering it on
every phone. `GET /api/export` in a signed-in browser downloads a JSON export as well.
