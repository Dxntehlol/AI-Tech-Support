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

// 8. auth server: dot-segment bypass closed, Bearer accepted
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
