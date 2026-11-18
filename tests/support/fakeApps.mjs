/*
 * Local fake JOHNVIVZ HR, Inventory and Accounting servers that follow docs/integration-contract.md. They are what the live adapters are
 * CONTRACT-TESTED against; they are NOT the real applications, and a pass here is never "verified live".
 *
 * Each fake checks a request the way the contract describes, with its own HMAC code (not CRM's):
 *   X-JVZ-Client = johnvivz_crm, X-JVZ-Timestamp within 5 minutes, X-JVZ-Signature = hex(HMAC_SHA256(secret, METHOD\npath\ntimestamp\nsha256(body)))
 * and validates every event envelope and event data against tests/support/contractSchemas.mjs (400 on any drift).
 * Inventory also keeps a stock table with idempotent reservations. Knobs for failure tests: failNext(n, status), dropAnswers(n) (do the
 * work, then close the connection without answering), down().
 * Each fake can also act as a publisher: sendToCrm(envelope) signs with the inbound secret, exactly as the real app would have to.
 */
import http from "http";
import crypto from "crypto";
import { checkEnvelope } from "./contractSchemas.mjs";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const hmac = (secret, method, path, ts, body) => crypto.createHmac("sha256", secret).update([method, path, ts, sha256(body)].join("\n")).digest("hex");
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
export const offsetNow = () => new Date(Date.now() + 8 * 3600e3).toISOString().replace("Z", "+08:00");

export const INVENTORY_PRODUCTS = [
  { product_id: "LIVE-P-1", sku: "LIVE-RICE-5", name: "Live Rice 5kg", unit: "bag", category_name: "Rice & Grains", selling_price: "285.00", is_vatable: false, status: "active", stock: 100 },
  { product_id: "LIVE-P-2", sku: "LIVE-MILK-1", name: "Live Milk 1L", unit: "carton", category_name: "Dairy & Eggs", selling_price: "98.00", is_vatable: true, status: "active", stock: 50 },
  { product_id: "LIVE-P-3", sku: "LIVE-EGG-30", name: "Live Eggs (tray of 30)", unit: "tray", category_name: "Dairy & Eggs", selling_price: "245.00", is_vatable: false, status: "active", stock: 3 },
  { product_id: "LIVE-P-4", sku: "LIVE-BISC", name: "Live Discontinued Biscuits", unit: "pack", category_name: "Biscuits & Snacks", selling_price: "30.00", is_vatable: true, status: "inactive", stock: 20 },
];
export const HR_FIXTURE = {
  departments: [{ department_id: "LIVE-DEP-1", code: "CRM", name: "Customer Relations", is_active: true }, { department_id: "LIVE-DEP-2", code: "OPS", name: "Operations", is_active: true }],
  positions: [{ position_id: "LIVE-POS-1", department_id: "LIVE-DEP-1", title: "Customer Service Representative", is_active: true }],
  employees: [
    { employee_id: "LIVE-EMP-1", full_name: "Live Employee One", work_email: "live1@example.test", department_id: "LIVE-DEP-1", position_id: "LIVE-POS-1", employment_status: "active", supervisor_employee_id: null,
      salary: 99999, bank_account: "0123456789" }, // restricted fields: HR may send them by mistake; CRM must never store them
    { employee_id: "LIVE-EMP-2", full_name: "Live Employee Two", work_email: "live2@example.test", department_id: "LIVE-DEP-1", position_id: "LIVE-POS-1", employment_status: "active", supervisor_employee_id: "LIVE-EMP-1" },
  ],
};

const readBody = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); };
const send = (res, status, json) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); };

const createApp = ({ name, client, secretFromCrm, secretToCrm, route }) => {
  const state = {
    name, client, secretToCrm, requests: [], events: [], rejected: [], seenEvents: new Set(), crmBase: null,
    failures: 0, failStatus: 503, dropCount: 0, dropEventAnswers: 0, isDown: false,
  };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const entry = { method: req.method, path: req.url, headers: req.headers, body: body.toString("utf8"), authorized: false, status: null };
    state.requests.push(entry);
    const answer = (status, json) => { entry.status = status; send(res, status, json); };
    if (state.isDown) { req.socket.destroy(); return; }
    // --- authentication exactly as the contract describes
    const ts = req.headers["x-jvz-timestamp"];
    const sig = String(req.headers["x-jvz-signature"] || "");
    const expected = ts ? hmac(secretFromCrm, req.method, req.url, ts, body) : "";
    if (req.headers["x-jvz-client"] !== "johnvivz_crm") return answer(401, { error: "unknown_client" });
    if (!ts || !ISO.test(ts) || Math.abs(Date.now() + (state.clockOffsetMs || 0) - Date.parse(ts)) > 300000) return answer(401, { error: "stale_timestamp" });
    if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return answer(401, { error: "invalid_signature" });
    entry.authorized = true;
    // --- injected failures
    if (state.failures > 0) { state.failures -= 1; return answer(state.failStatus, { error: "injected_failure" }); }
    const url = new URL(req.url, "http://fake");
    let json = null;
    if (body.length) { try { json = JSON.parse(body.toString("utf8")); } catch { return answer(400, { error: "invalid_json" }); } }
    if (url.pathname === "/api/integration/v1/health") return answer(200, { status: "ok", app: client });
    if (url.pathname === "/api/integration/v1/test/echo" && req.method === "POST") return answer(200, { status: "ok", app: client, received_sha256: sha256(body), server_time: new Date().toISOString() });
    if (url.pathname === "/api/integration/v1/events" && req.method === "POST") {
      const problems = checkEnvelope(json);
      if (problems.length) { state.rejected.push({ envelope: json, problems }); return answer(400, { error: "invalid_envelope", details: problems }); }
      if (state.seenEvents.has(json.event_id)) return answer(200, { status: "duplicate", event_id: json.event_id });
      state.seenEvents.add(json.event_id);
      state.events.push(json);
      if (state.dropEventAnswers > 0) { state.dropEventAnswers -= 1; entry.status = "dropped"; req.socket.destroy(); return; } // accepted, but the answer is lost
      return answer(202, { status: "accepted", event_id: json.event_id });
    }
    const out = await route({ req, url, json, state, answer, entry });
    if (out === undefined) return;
    if (state.dropCount > 0 && out.drop) { state.dropCount -= 1; entry.status = "dropped"; req.socket.destroy(); return; }
    return answer(out.status, out.json);
  });
  state.server = server;
  state.start = (port = 0, host = "127.0.0.1") => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { state.port = server.address().port; state.baseUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${state.port}`; resolve(state); }); });
  state.stop = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  state.failNext = (n, status = 503) => { state.failures = n; state.failStatus = status; };
  state.dropAnswers = (n) => { state.dropCount = n; };
  state.down = (v = true) => { state.isDown = v; };
  state.eventsOf = (type) => state.events.filter((e) => e.event_type === type);
  state.reset = () => { state.dropEventAnswers = 0; state.requests.length = 0; state.events.length = 0; state.rejected.length = 0; state.seenEvents.clear(); state.failures = 0; state.dropCount = 0; state.isDown = false; };
  // act as the real app would when it publishes an event to CRM
  state.sendToCrm = async (envelope, { secret = state.secretToCrm, client: asClient = client, timestamp = offsetNow(), path = "/api/integration/v1/events", method = "POST", raw = null, signAs = null } = {}) => {
    const body = raw ?? JSON.stringify(envelope);
    const target = path;
    const res = await fetch(state.crmBase + target, {
      method, body: method === "GET" ? undefined : body,
      headers: { "Content-Type": "application/json", "X-JVZ-Client": asClient, "X-JVZ-Timestamp": timestamp, "X-JVZ-Signature": signAs ?? hmac(secret, method, target, timestamp, method === "GET" ? "" : body) },
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json: parsed, text };
  };
  state.getFromCrm = (path, opts = {}) => state.sendToCrm(null, { ...opts, path, method: "GET" });
  return state;
};

const paged = (items, url) => {
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const size = 1; // one item per page, so every list call exercises the paging
  return { items: items.slice((page - 1) * size, page * size), page, total_pages: Math.max(1, Math.ceil(items.length / size)) };
};

export const startFakeApps = async ({ secrets, crmBase, ports = {}, host = "127.0.0.1" }) => {
  // ---------------- Inventory
  const stock = Object.fromEntries(INVENTORY_PRODUCTS.map((p) => [p.product_id, p.stock]));
  const reservations = new Map(); // order_id -> { reservation_id, items, released }
  let rsvSeq = 0;
  const reservedOf = (pid) => [...reservations.values()].filter((r) => !r.released).reduce((n, r) => n + (r.items.find((i) => i.product_id === pid)?.quantity || 0), 0);
  const productJson = (p, extra = {}) => ({ product_id: p.product_id, sku: p.sku, name: p.name, unit: p.unit, category_name: p.category_name, selling_price: p.selling_price, is_vatable: p.is_vatable, status: p.status, ...extra });
  const inventory = createApp({
    name: "inventory", client: "johnvivz_inventory", secretFromCrm: secrets.inventory.out, secretToCrm: secrets.inventory.in,
    async route({ req, url, json }) {
      const p = url.pathname;
      const base = "/api/integration/v1";
      const find = (id) => INVENTORY_PRODUCTS.find((x) => x.product_id === decodeURIComponent(id));
      const avail = (x) => Math.max(0, stock[x.product_id] - reservedOf(x.product_id));
      if (p === `${base}/products` && req.method === "GET") {
        const q = (url.searchParams.get("query") || "").toLowerCase();
        const cat = url.searchParams.get("category") || "";
        const list = INVENTORY_PRODUCTS.filter((x) => (!q || x.name.toLowerCase().includes(q)) && (!cat || x.category_name === cat));
        const page = paged(list, url);
        return { status: 200, json: { ...page, items: page.items.map((x) => productJson(x, { available_qty: avail(x), low_stock: avail(x) > 0 && avail(x) <= 10 })) } };
      }
      let m = p.match(new RegExp(`^${base}/products/([^/]+)(/availability|/price)?$`));
      if (m && req.method === "GET") {
        const x = find(m[1]);
        if (!x) return { status: 404, json: { error: "not_found" } };
        if (m[2] === "/availability") return { status: 200, json: { product_id: x.product_id, available_qty: avail(x), low_stock: avail(x) > 0 && avail(x) <= 10, as_of: offsetNow() } };
        if (m[2] === "/price") return { status: 200, json: { product_id: x.product_id, selling_price: x.selling_price, currency: "PHP", effective_from: "2026-01-01T00:00:00.000+08:00" } };
        return { status: 200, json: productJson(x) };
      }
      if (p === `${base}/reservations` && req.method === "POST") {
        if (!json || !/^[0-9a-f-]{36}$/i.test(json.order_id || "") || !/^[0-9a-f-]{36}$/i.test(json.correlation_id || "") || !Array.isArray(json.items) || !json.items.length) return { status: 400, json: { error: "invalid_request" } };
        if (reservations.has(json.order_id)) return { status: 200, json: { reservation_id: reservations.get(json.order_id).reservation_id, status: "reserved", items: json.items }, drop: true };
        const answers = json.items.map((i) => {
          const x = find(i.product_id);
          if (!x || x.status !== "active") return { product_id: i.product_id, quantity: i.quantity, available_qty: 0, ok: false, reason: "not sold any more" };
          if (avail(x) < i.quantity) return { product_id: i.product_id, quantity: i.quantity, available_qty: avail(x), ok: false, reason: "not enough stock" };
          return { product_id: i.product_id, quantity: i.quantity, available_qty: avail(x), ok: true, reason: null };
        });
        if (answers.some((a) => !a.ok)) return { status: 409, json: { status: "rejected", items: answers } };
        const reservation_id = `RSV-${String(++rsvSeq).padStart(4, "0")}`;
        reservations.set(json.order_id, { reservation_id, items: json.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })), released: false, idempotency_key: req.headers["idempotency-key"] || null });
        return { status: 201, json: { reservation_id, status: "reserved", items: answers }, drop: true };
      }
      m = p.match(new RegExp(`^${base}/reservations/([^/]+)$`));
      if (m && req.method === "DELETE") {
        if (inventory.failDeletes > 0) { inventory.failDeletes -= 1; return { status: 503, json: { error: "injected_failure" } }; }
        const found = [...reservations.values()].find((r) => r.reservation_id === decodeURIComponent(m[1]));
        if (!found) return { status: 404, json: { error: "not_found" } };
        found.released = true;
        return { status: 200, json: { reservation_id: found.reservation_id, status: "released" } };
      }
      return { status: 404, json: { error: "not_found" } };
    },
  });
  inventory.failDeletes = 0;
  inventory.stock = stock;
  inventory.reservations = reservations;
  inventory.reservedOf = reservedOf;

  // ---------------- HR
  const hr = createApp({
    name: "hr", client: "johnvivz_hr", secretFromCrm: secrets.hr.out, secretToCrm: secrets.hr.in,
    async route({ req, url }) {
      const base = "/api/integration/v1";
      if (req.method !== "GET") return { status: 404, json: { error: "not_found" } };
      if (url.pathname === `${base}/departments`) return { status: 200, json: paged(HR_FIXTURE.departments, url) };
      if (url.pathname === `${base}/positions`) return { status: 200, json: paged(HR_FIXTURE.positions, url) };
      if (url.pathname === `${base}/employees`) return { status: 200, json: paged(HR_FIXTURE.employees, url) };
      const m = url.pathname.match(new RegExp(`^${base}/employees/([^/]+)$`));
      if (m) {
        const e = [...HR_FIXTURE.employees, ...(hr.extraEmployees || [])].find((x) => x.employee_id === decodeURIComponent(m[1]));
        return e ? { status: 200, json: e } : { status: 404, json: { error: "not_found" } };
      }
      return { status: 404, json: { error: "not_found" } };
    },
  });
  hr.extraEmployees = [];

  // ---------------- Accounting (events) + ESS department login, as JVzPay offers it (contract §12.5)
  // POST /api/integration/v1/auth/login {email, password}, HMAC-signed by CRM: 200 profile | 401 invalid_credentials | 403 not_allowed.
  const essUsers = new Map(); // email -> { password, profile, allowed }
  const accounting = createApp({
    name: "accounting", client: "johnvivz_accounting", secretFromCrm: secrets.accounting.out, secretToCrm: secrets.accounting.in,
    async route({ req, url, json }) {
      if (url.pathname === "/api/integration/v1/auth/login" && req.method === "POST") {
        if (accounting.essDown) return { status: 503, json: { error: "unavailable" } };
        const u = essUsers.get(String(json?.email || "").trim().toLowerCase());
        if (!u || typeof json?.password !== "string" || json.password !== u.password) return { status: 401, json: { error: "invalid_credentials" } };
        if (u.allowed === false) return { status: 403, json: { error: "not_allowed" } };
        return { status: 200, json: { ...u.profile, email: u.profile.email || json.email } };
      }
      return { status: 404, json: { error: "not_found" } };
    },
  });
  accounting.essUsers = essUsers;
  accounting.essDown = false;
  // a new hire registering in ESS (ESS validates against HR; the fake trusts the test)
  accounting.registerEss = (email, password, profile, { allowed = true } = {}) => essUsers.set(String(email).toLowerCase(), {
    password, allowed,
    profile: { employee_id: null, employee_code: null, full_name: "", email, department_code: "CRM", department_name: "Customer Relations", position: "", employment_status: "Active", ess_registered_at: offsetNow(), ...profile },
  });

  for (const app of [inventory, hr, accounting]) app.crmBase = crmBase;
  await Promise.all([inventory.start(ports.inventory || 0, host), hr.start(ports.hr || 0, host), accounting.start(ports.accounting || 0, host)]);
  return { inventory, hr, accounting, stop: () => Promise.all([inventory.stop(), hr.stop(), accounting.stop()]) };
};
