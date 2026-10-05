// End-to-end HTTP smoke test against a running server (start one with CLAUDE_FAKE=1 for a keyless run).
// usage: node scripts/smoke.mjs http://127.0.0.1:8787 [http://127.0.0.1:8788 <APP_PASSWORD of that second server>]
import net from "node:net";

const BASE = process.argv[2] || "http://127.0.0.1:8793";
const AUTH_BASE = process.argv[3];
const PASSWORD = process.argv[4];
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}
async function j(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// 1. health
const h = await j("/api/health");
check("health 200", h.status === 200, JSON.stringify(h.body).slice(0, 160));
check("health demo=true", h.body && h.body.demo === true);
check("health packs/refrigerants/rules", h.body.packs >= 8 && h.body.refrigerants >= 45 && h.body.rules >= 80, `packs=${h.body.packs} refrigerants=${h.body.refrigerants} rules=${h.body.rules}`);

// 2. decode
const d = await j("/api/decode", { method: "POST", body: JSON.stringify({ model: "48TCDA04A2A5-0A0A0", serial: "3216E54321" }) });
const top = d.body && d.body.manufacturerCandidates && d.body.manufacturerCandidates[0];
check("decode 200", d.status === 200, `${top && top.id} — ${String(d.body && d.body.summary).slice(0, 120)}`);
check("decode carrier + date", top && top.id === "carrier" && /Built 2016 week 32/.test(d.body.summary));
const dw = await j("/api/decode", { method: "POST", body: JSON.stringify({ model: "48TCDA04A2A5-0A0A0", manufacturer: "Copeland" }) });
check("decode wrong hint warns", dw.status === 200 && JSON.stringify(dw.body.warnings || "").includes("may be wrong"), (dw.body.warnings || []).join(" | ").slice(0, 200));

// 3. PT
const pt = await j("/api/reference/pt?refrigerant=R-410A&psig=118");
check("pt R-410A 118 psig ≈ 40 °F", pt.status === 200 && Math.abs(pt.body.dewTempF - 40) < 1.5, `dew=${pt.body.dewTempF} bubble=${pt.body.bubbleTempF}`);
const ptx = await j("/api/reference/pt?refrigerant=R-22&psig=450");
check("pt R-22 450 psig extrapolated ≈ 164 °F", ptx.status === 200 && Math.abs(ptx.body.dewTempF - 164) < 2 && /EXTRAPOLATED/.test((ptx.body.notes || []).join(" ")), `dew=${ptx.body.dewTempF}`);
const ptc = await j("/api/reference/pt?refrigerant=R-744&temp_f=95");
check("pt R-744 95 °F transcritical", ptc.status === 200 && /transcritical/i.test((ptc.body.notes || []).join(" ")));
const pte = await j("/api/reference/pt?refrigerant=R-454B&temp_f=40&elevation_ft=5000");
check("pt elevation note", pte.status === 200 && /5,?000 ft/.test((pte.body.notes || []).join(" ")), (pte.body.notes || []).join(" | ").slice(0, 160));

// 4. diagnose
const dx = await j("/api/calc/diagnose", { method: "POST", body: JSON.stringify({ refrigerant: "R-410A", metering_device: "txv", mode: "ac_cooling", outdoor_db_f: 91.4, indoor_db_f: 75, indoor_wb_f: 63, suction_psig: 118, suction_line_temp_f: 50, liquid_psig: 380, liquid_line_temp_f: 101.5, supply_db_f: 57, compressor_amps: 16, compressor_rla: 20, runtime_minutes: 20 }) });
check("diagnose 200 valid", dx.status === 200 && dx.body.validity && dx.body.validity.ok === true, `validity=${JSON.stringify(dx.body.validity)} findings=${(dx.body.findings || []).length} SH=${dx.body.derived && dx.body.derived.superheatF} SC=${dx.body.derived && dx.body.derived.subcoolingF}`);
check("diagnose returns findings", Array.isArray(dx.body.findings) && dx.body.findings.length > 0, (dx.body.findings || []).slice(0, 3).map((f) => f.ruleId).join(","));
const dxlow = await j("/api/calc/diagnose", { method: "POST", body: JSON.stringify({ refrigerant: "R-410A", metering_device: "txv", mode: "ac_cooling", outdoor_db_f: 50, indoor_db_f: 72, suction_psig: 100, suction_line_temp_f: 60, liquid_psig: 220, liquid_line_temp_f: 70 }) });
check("diagnose low-ambient gate", dxlow.status === 200 && dxlow.body.validity && dxlow.body.validity.ok === false && /65/.test((dxlow.body.validity.issues || []).join(" ")), `issues=${JSON.stringify(dxlow.body.validity && dxlow.body.validity.issues)}`);

// 5. electrical + fault
const el = await j("/api/calc/electrical", { method: "POST", body: JSON.stringify({ kind: "voltage_imbalance", vab: 480, vbc: 470, vca: 475 }) });
check("electrical calc", el.status === 200 && el.body.values && typeof el.body.values.imbalancePercent === "number", JSON.stringify(el.body.values));
const fc = await j("/api/reference/fault?code=A140");
check("fault lookup", fc.status === 200 && JSON.stringify(fc.body).length > 50, JSON.stringify(fc.body).slice(0, 140));
const er = await j("/api/reference/electrical?component=run%20capacitor");
check("electrical reference", er.status === 200 && JSON.stringify(er.body).includes("apacitor"));

// 6. unit + conversation + chat over SSE
const u = await j("/api/units", { method: "POST", body: JSON.stringify({ model: "48TCDA04A2A5-0A0A0", serial: "3216E54321", unit_tag: "RTU-7", site: "Pharmacy" }) });
const unit = u.body && u.body.unit;
if (!unit || !unit.id) {
  console.log(`FAIL unit create — HTTP ${u.status} ${JSON.stringify(u.body).slice(0, 160)}; the rest of the run depends on it (is the server password-protected? pass the auth server/password as the 2nd and 3rd arguments)`);
  process.exit(1);
}
check("unit create", (u.status === 200 || u.status === 201) && unit && unit.id && unit.tonnage === 3, `id=${unit && unit.id} ${unit && unit.manufacturer} ${unit && unit.tonnage} t ${unit && unit.refrigerant}`);
const c = await j("/api/conversations", { method: "POST", body: JSON.stringify({ unit_id: unit.id }) });
const cid = (c.body && (c.body.id || (c.body.conversation && c.body.conversation.id))) || null;
check("conversation create", (c.status === 200 || c.status === 201) && cid, `id=${cid}`);
const sse = await fetch(`${BASE}/api/conversations/${cid}/messages`, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ text: "RTU-7 is not cooling. Suction 118 psig, line temp 50 F, liquid 380 psig at 101.5 F, outdoor 91 F. What do you think?" }) });
check("sse 200 event-stream", sse.status === 200 && /text\/event-stream/.test(sse.headers.get("content-type") || ""), sse.headers.get("content-type"));
const events = [];
{
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5).trim()));
    }
  }
}
const types = events.map((e) => e.type);
check("sse has text deltas and done", types.includes("done") && types.some((t) => /text|delta/.test(t)), [...new Set(types)].join(","));
const conv = await j(`/api/conversations/${cid}`);
check("conversation persisted assistant message", conv.status === 200 && conv.body.messages.some((m) => m.role === "assistant" && (m.text || "").length > 20), `messages=${conv.body.messages.length}`);
const s = await j("/api/search?q=RTU-7");
check("search finds unit", s.status === 200 && JSON.stringify(s.body).includes("RTU-7"));

// 7. findings validation + export envelope
const f = await j("/api/findings", { method: "POST", body: JSON.stringify({ unit_id: unit.id, symptom: "Low charge on circuit 1", cause: "Schrader leak", status: "open" }) });
const finding = f.body && f.body.finding;
check("finding create", (f.status === 200 || f.status === 201) && finding && finding.id && finding.status === "open", `status=${finding && finding.status}`);
const fp = await j(`/api/findings/${finding.id}`, { method: "PATCH", body: JSON.stringify({ status: "" }) });
check("finding PATCH empty status → 400", fp.status === 400, JSON.stringify(fp.body).slice(0, 120));
const fp2 = await j(`/api/findings/${finding.id}`, { method: "PATCH", body: JSON.stringify({ status: "resolved", resolution: "Replaced core, charged 1.5 lb" }) });
check("finding PATCH resolved", fp2.status === 200 && ((fp2.body.finding && fp2.body.finding.status) || fp2.body.status) === "resolved", JSON.stringify(fp2.body).slice(0, 100));
const ex = await j("/api/export");
check("export envelope", ex.status === 200 && ex.body.complete === true && Array.isArray(ex.body.truncated) && ex.body.limit === 1000 && ex.body.findings.length >= 1, `complete=${ex.body.complete} limit=${ex.body.limit}`);

// 8. AI settings (read-only here: a smoke run must never overwrite a real server's key)
const ai = await j("/api/settings/ai");
const aiText = JSON.stringify(ai.body);
check("settings/ai 200 with view fields", ai.status === 200 && typeof ai.body.demo === "boolean" && typeof ai.body.model === "string" && ["settings", "env", "profile", "none"].includes(ai.body.keySource) && Array.isArray(ai.body.models) && typeof ai.body.settingsPath === "string", `demo=${ai.body.demo} keySource=${ai.body.keySource} model=${ai.body.model} path=${ai.body.settingsPath}`);
check("settings/ai leaks no key", !/sk-ant-[A-Za-z0-9_-]{5,}/.test(aiText) && !("apiKey" in (ai.body || {})) && (ai.body.keyHint === null || /^….{0,4}$/.test(ai.body.keyHint)), `keyHint=${ai.body.keyHint}`);
const aiBad = await j("/api/settings/ai", { method: "PUT", body: JSON.stringify({ apiKey: "not-a-key" }) });
check("settings/ai PUT bad key → 400 envelope", aiBad.status === 400 && aiBad.body.error && aiBad.body.error.code === "validation" && !JSON.stringify(aiBad.body).includes("not-a-key"), JSON.stringify(aiBad.body).slice(0, 140));

// 9. usage
const us = await j("/api/usage");
check("usage 200 default 30 days", us.status === 200 && us.body.days === 30 && us.body.priceLabel === "estimated at list price" && typeof us.body.totals.requests === "number" && Array.isArray(us.body.byDay) && us.body.byDay.length === 30 && Array.isArray(us.body.byModel), `requests=${us.body.totals && us.body.totals.requests} cost=${us.body.totals && us.body.totals.estimatedCostUsd}`);
const us7 = await j("/api/usage?days=7");
const usBig = await j("/api/usage?days=9999");
check("usage days=7 and clamp to 365", us7.status === 200 && us7.body.days === 7 && us7.body.byDay.length === 7 && usBig.status === 200 && usBig.body.days === 365, `7→${us7.body.days} 9999→${usBig.body.days}`);
if (h.body.demo === true) check("usage: demo chat not recorded", !(us.body.byModel || []).some((m) => /fake|demo/i.test(m.model)), JSON.stringify(us.body.byModel).slice(0, 120));

// 10. fleet import: dry run writes nothing, real run creates, re-run is all duplicates
const tagSuffix = Date.now().toString(36).slice(-5).toUpperCase();
const serialA = `3216E${String(Math.floor(Math.random() * 90000) + 10000)}`;
const importText = [
  "Model,Serial,Site,Tag",
  `48TCDA04A2A5-0A0A0,${serialA},Smoke Plaza,RTU-S${tagSuffix}`,
  `48TCDA04A2A5-0A0A0,${serialA.toLowerCase()},Smoke Plaza,RTU-S${tagSuffix}b`,
  ",,Smoke Plaza,",
  `,,Smoke Plaza,AHU-S${tagSuffix}`,
].join("\n");
const smokeSite = () => j("/api/units?site=" + encodeURIComponent("Smoke Plaza") + "&limit=500");
const unitsBefore = await smokeSite();
const countOf = (r) => (Array.isArray(r.body) ? r.body : (r.body && r.body.units) || []).length;
const dry = await j("/api/units/import", { method: "POST", body: JSON.stringify({ text: importText, dryRun: true }) });
const sum = dry.body && dry.body.summary;
check("import dryRun classifies rows", dry.status === 200 && dry.body.dryRun === true && dry.body.header === true && sum && sum.total === 4 && sum.new === 2 && sum.duplicate === 1 && sum.error === 1 && sum.created === 0 && dry.body.createdIds.length === 0, JSON.stringify(sum));
const dr0 = dry.body.rows && dry.body.rows[0];
check("import dryRun decodes row 1", dr0 && dr0.status === "new" && dr0.decoded && dr0.decoded.tonnage === 3 && dr0.decoded.refrigerant === "R-410A" && ["high", "medium", "low"].includes(dr0.decoded.confidence), dr0 && JSON.stringify(dr0.decoded).slice(0, 160));
const unitsMid = await smokeSite();
check("import dryRun wrote nothing", countOf(unitsMid) === countOf(unitsBefore), `before=${countOf(unitsBefore)} after=${countOf(unitsMid)}`);
const real = await j("/api/units/import", { method: "POST", body: JSON.stringify({ text: importText, dryRun: false }) });
check("import real creates the new rows", real.status === 200 && real.body.dryRun === false && real.body.summary.created === 2 && real.body.createdIds.length === 2, JSON.stringify(real.body.summary));
const unitsAfter = await smokeSite();
check("import real: exactly 2 more units at the site", countOf(unitsAfter) === countOf(unitsBefore) + 2, `before=${countOf(unitsBefore)} after=${countOf(unitsAfter)}`);
const imported = real.body.createdIds && real.body.createdIds[0] ? await j(`/api/units/${real.body.createdIds[0]}`) : { status: 0, body: {} };
check("imported unit is saved and decoded", imported.status === 200 && imported.body.unit && imported.body.unit.serial === serialA && imported.body.unit.tonnage === 3, imported.body.unit && `${imported.body.unit.unit_tag} ${imported.body.unit.manufacturer}`);
const again = await j("/api/units/import", { method: "POST", body: JSON.stringify({ text: importText, dryRun: true }) });
check("import re-run: saved rows are duplicates", again.status === 200 && again.body.summary.new === 0 && again.body.summary.duplicate === 3 && again.body.rows[0].existingUnitId === real.body.createdIds[0], JSON.stringify(again.body.summary));
const impBad = await j("/api/units/import", { method: "POST", body: JSON.stringify({ text: "", dryRun: true }) });
check("import empty → 400 envelope", impBad.status === 400 && impBad.body.error && impBad.body.error.code === "validation", JSON.stringify(impBad.body).slice(0, 120));

// 11. decode corrections: create, list, export (marks exported), delete
const corrUnit = real.body.createdIds && real.body.createdIds[0];
const cr = await j(`/api/units/${corrUnit}/corrections`, { method: "POST", body: JSON.stringify({ field: "tonnage", actual_value: "4", note: "smoke: nameplate says 4 ton" }) });
const corr = cr.body && cr.body.correction;
check("correction create 201", cr.status === 201 && corr && corr.id && corr.field === "tonnage" && corr.app_value === "3" && corr.actual_value === "4" && corr.status === "open" && !corr.applied && corr.pack_id === "carrier", corr && `app=${corr.app_value} actual=${corr.actual_value} pack=${corr.pack_id} format=${corr.format_id} applied=${corr.applied}`);
check("correction without apply leaves the unit", cr.body.unit && cr.body.unit.tonnage === 3);
const crApply = await j(`/api/units/${corrUnit}/corrections`, { method: "POST", body: JSON.stringify({ field: "refrigerant", actual_value: "R-454B", apply: true }) });
check("correction apply updates the unit", crApply.status === 201 && Number(crApply.body.correction.applied) === 1 && crApply.body.unit.refrigerant === "R-454B", `refrigerant=${crApply.body.unit && crApply.body.unit.refrigerant}`);
const crBad = await j(`/api/units/${corrUnit}/corrections`, { method: "POST", body: JSON.stringify({ field: "tonnage" }) });
check("correction missing actual_value → 400", crBad.status === 400 && crBad.body.error && crBad.body.error.code === "validation", JSON.stringify(crBad.body).slice(0, 120));
const cl = await j("/api/corrections?status=open");
check("corrections list (open) has both", cl.status === 200 && Array.isArray(cl.body.corrections) && [corr.id, crApply.body.correction.id].every((id) => cl.body.corrections.some((c) => c.id === id)), `open=${(cl.body.corrections || []).length}`);
const unitWithCorr = await j(`/api/units/${corrUnit}`);
check("unit detail carries its corrections", unitWithCorr.status === 200 && Array.isArray(unitWithCorr.body.corrections) && unitWithCorr.body.corrections.length === 2);
const exRes = await fetch(BASE + "/api/corrections/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
const exBody = await exRes.json().catch(() => ({}));
const cd = exRes.headers.get("content-disposition") || "";
check("corrections export attachment", exRes.status === 200 && /attachment; filename="hvac-corrections-\d{4}-\d{2}-\d{2}\.json"/.test(cd) && exBody.kind === "hvac-corrections" && exBody.version === 1 && exBody.newlyExported >= 2 && exBody.count === exBody.corrections.length, `${cd} count=${exBody.count} newlyExported=${exBody.newlyExported}`);
const exMine = (exBody.corrections || []).find((c) => c.id === corr.id);
check("export marks rows exported", exMine && exMine.status === "exported" && exMine.model === "48TCDA04A2A5-0A0A0" && exMine.serial === serialA);
const clOpen = await j("/api/corrections?status=open");
check("no open corrections after export", clOpen.status === 200 && !clOpen.body.corrections.some((c) => c.id === corr.id));
const cdel = await j(`/api/corrections/${corr.id}`, { method: "DELETE" });
const cdel404 = await j(`/api/corrections/${corr.id}`, { method: "DELETE" });
check("correction delete, then 404", cdel.status === 200 && cdel.body.deleted === true && cdel404.status === 404 && cdel404.body.error && cdel404.body.error.code, `${cdel.status}/${cdel404.status}`);
const bk = await j("/api/export");
check("backup export includes corrections", bk.status === 200 && Array.isArray(bk.body.corrections) && bk.body.corrections.some((c) => c.id === crApply.body.correction.id));

// 12. auth server: dot-segment bypass closed, Bearer accepted
if (AUTH_BASE && PASSWORD) {
  const url = new URL(AUTH_BASE);
  const raw = (path) => new Promise((resolve, reject) => {
    const sock = net.connect(Number(url.port), url.hostname, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("end", () => resolve(data));
    sock.on("error", reject);
  });
  const statusOf = (resp) => Number((resp.split("\r\n")[0] || "").split(" ")[1]);
  check("auth: /app.js without password → 401", statusOf(await raw("/app.js")) === 401);
  check("auth: /icons/../app.js → 401", statusOf(await raw("/icons/../app.js")) === 401);
  check("auth: /icons/%2e%2e/app.js → 401", statusOf(await raw("/icons/%2e%2e/app.js")) === 401);
  check("auth: /icons/icon-192.png public → 200", statusOf(await raw("/icons/icon-192.png")) === 200);
  check("auth: /api/health public → 200", statusOf(await raw("/api/health")) === 200);
  const bearer = await fetch(`${AUTH_BASE}/api/units`, { headers: { authorization: `Bearer ${PASSWORD}` } });
  check("auth: Bearer token accepted", bearer.status === 200);
  const wrong = await fetch(`${AUTH_BASE}/api/units`, { headers: { authorization: `Bearer nope` } });
  check("auth: wrong token → 401", wrong.status === 401);
  const basic = await fetch(`${AUTH_BASE}/api/units`, { headers: { authorization: `Basic ${Buffer.from("tech:" + PASSWORD).toString("base64")}` } });
  check("auth: Basic accepted", basic.status === 200);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
