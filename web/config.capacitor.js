/* HVAC Field Assistant — client bootstrap for the Capacitor (App Store / Play Store) bundle.
 *
 * When the client is served by the Node server, /config.js is generated per request (same-origin API,
 * version, demo flag). A Capacitor bundle has no server behind it, so `npm run cap:prepare`
 * (scripts/cap-prepare.mjs) copies this file to web/config.js with the version from package.json.
 *
 *  - apiBase ""  → the API origin comes from Settings → Server URL (localStorage hvac.apiBase); until one is
 *                  saved the app opens Settings with a "Set your server URL" prompt instead of failing requests.
 *  - bundled true → tells the client it runs without a server behind it.
 *  - The server must list the shell's origin in ALLOW_ORIGINS (capacitor://localhost, https://localhost).
 */
window.APP_CONFIG = { apiBase: "", version: "__VERSION__", demo: false, bundled: true };
