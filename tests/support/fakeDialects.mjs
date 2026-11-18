/*
 * Local fakes of the teammates' apps AS THEY ARE TODAY (2026-11-16), written from the inspection notes in docs/integration-contract.md §12.
 * They are test doubles, NOT the real apps: a pass against them is "contract-tested against the interim dialect", never "verified live".
 *
 *   fake JohnVivzHR   pull-only API, API key auth (Authorization: Bearer <key> or X-API-Key), no HMAC, no events, no /health (GET /ping).
 *                     GET /employees (status, department_id, q, page, page_size -> {success, data:{items, page, page_size, total, total_pages}}),
 *                     GET /employees/:identifier (number, JV-YYYY-NNNNN or code), GET /departments (positions nested), GET /departments/:id.
 *                     Errors are {success:false, message}. page_size is capped (maxPageSize) so CRM's paging is exercised.
 *   fake Inventory    Bearer token. GET /products (search, limit, offset), /products/:id, /:id/availability, /:id/price (price as a string).
 *                     POST /events {eventId, eventType, ...}: order.confirmed, sale.completed, order.cancelled, sale.refunded, return.received;
 *                     duplicate-safe by eventId; every body is checked field by field (400 on drift). Inventory never pushes: its events
 *                     for CRM wait in GET /crm/outbox until POST /crm/outbox/:eventId/ack.
 *                     order.confirmed answers as the Inventory team documented them (see startFakeInventoryDialect).
 */
import http from "http";
import crypto from "crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const readBody = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); };
const send = (res, status, json) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); };
const safeEqual = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());

export const HR_PULL_FIXTURE = () => ({
  departments: [
    { department_id: 1, department_name: "Customer Relations", department_code: "CRM", positions: [{ position_title: "Customer Service Representative" }, { position_title: "Team Leader" }] },
    { department_id: 2, department_name: "Operations", department_code: "OPS", positions: [{ position_title: "Store Clerk" }] },
  ],
  employees: [
    { employee_id: 101, permanent_employee_id: "JV-2026-00001", employee_code: "EMP-101", first_name: "Pia", last_name: "Lagman", full_name: "Pia Lagman", email: "pia.lagman@hr.example.test", phone_number: "09170000101",
      department: { department_id: 1, department_name: "Customer Relations", department_code: "CRM" }, position: "Team Leader", employment_type: "Regular", reporting_supervisor_id: null, hire_date: "2024-01-15", status: "Active" },
    { employee_id: 102, permanent_employee_id: "JV-2026-00002", employee_code: "EMP-102", first_name: "Rico", last_name: "Dimaano", full_name: "Rico Dimaano", email: "rico.dimaano@hr.example.test", phone_number: "09170000102",
      department: { department_id: 1, department_name: "Customer Relations", department_code: "CRM" }, position: "Customer Service Representative", employment_type: "Regular", reporting_supervisor_id: 101, hire_date: "2025-03-01", status: "Active" },
    { employee_id: 103, permanent_employee_id: null, employee_code: "EMP-103", first_name: "Nina", last_name: "Onboard", full_name: "Nina Onboard", email: "nina@hr.example.test", phone_number: "09170000103",
      department: { department_id: 1, department_name: "Customer Relations", department_code: "CRM" }, position: "Customer Service Representative", employment_type: "Probationary", reporting_supervisor_id: 101, hire_date: "2026-11-20", status: "Onboarding" },
    { employee_id: 104, permanent_employee_id: null, employee_code: "EMP-104", first_name: "Rey", last_name: "Rejected", full_name: "Rey Rejected", email: "rey@hr.example.test", phone_number: null,
      department: { department_id: 2, department_name: "Operations", department_code: "OPS" }, position: "Store Clerk", employment_type: "Probationary", reporting_supervisor_id: null, hire_date: null, status: "Rejected" },
    { employee_id: 105, permanent_employee_id: "JV-2026-00005", employee_code: "EMP-105", first_name: "Lea", last_name: "Leave", full_name: "Lea Leave", email: "lea.leave@hr.example.test", phone_number: "09170000105",
      department: { department_id: 1, department_name: "Customer Relations", department_code: "CRM" }, position: "Customer Service Representative", employment_type: "Regular", reporting_supervisor_id: "JV-2026-00001", hire_date: "2023-06-01", status: "On Leave" },
    { employee_id: 106, permanent_employee_id: "JV-2026-00006", employee_code: "EMP-106", first_name: "Ramil", last_name: "Resigned", full_name: "Ramil Resigned", email: "ramil@hr.example.test", phone_number: "09170000106",
      department: { department_id: 2, department_name: "Operations", department_code: "OPS" }, position: "Store Clerk", employment_type: "Regular", reporting_supervisor_id: null, hire_date: "2022-02-01", status: "Resigned" },
    { employee_id: 107, permanent_employee_id: null, employee_code: "EMP-107", first_name: "Tess", last_name: "Temporary", full_name: "Tess Temporary", email: "tess@hr.example.test", phone_number: "09170000107",
      department: { department_id: 2, department_name: "Operations", department_code: "OPS" }, position: "Store Clerk", employment_type: "Contractual", reporting_supervisor_id: "EMP-101", hire_date: "2026-08-01", status: "Active" },
  ],
});

export const INVENTORY_DIALECT_PRODUCTS = () => [
  { productId: "INV-1001", sku: "RICE-25", name: "Dialect Rice 25kg", unit: "sack", categoryName: "Rice & Grains", sellingPrice: "1250.00", isVatable: false, status: "active", stock: 40 },
  { productId: "INV-1002", sku: "OIL-1L", name: "Dialect Cooking Oil 1L", unit: "bottle", categoryName: "Pantry", sellingPrice: "115.50", isVatable: true, status: "active", stock: 8 },
  { productId: "INV-1003", sku: "SOAP-OLD", name: "Dialect Old Soap", unit: "bar", categoryName: "Household", sellingPrice: "25.00", isVatable: true, status: "inactive", stock: 5 },
  // Inventory's real ids are numbers: CRM keeps "12" and sends 12 back
  { productId: 12, sku: "SKU-SCARCE", name: "Dialect Scarce Item", unit: "pc", categoryName: "Pantry", sellingPrice: "50.00", isVatable: true, status: "active", stock: 3 },
];

const createServer = ({ name, route, authorize }) => {
  const state = { name, requests: [], isDown: false };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const entry = { method: req.method, path: req.url, headers: req.headers, body: body.toString("utf8"), authorized: false, status: null };
    state.requests.push(entry);
    const answer = (status, json) => { entry.status = status; send(res, status, json); };
    if (state.isDown) { req.socket.destroy(); return; }
    if (!authorize(req)) return answer(401, { success: false, message: "Unauthorized" });
    entry.authorized = true;
    let json = null;
    if (body.length) { try { json = JSON.parse(body.toString("utf8")); } catch { return answer(400, { success: false, message: "Invalid JSON" }); } }
    const url = new URL(req.url, "http://fake");
    const out = await route({ req, url, json, entry });
    if (out.drop) { entry.status = "dropped"; req.socket.destroy(); return; } // the work is done, the answer is lost
    return answer(out.status, out.json);
  });
  state.start = (port = 0, host = "127.0.0.1") => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { state.port = server.address().port; state.baseUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${state.port}`; resolve(state); }); });
  state.stop = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  state.down = (v = true) => { state.isDown = v; };
  return state;
};

const bearerAuth = (token) => (req) => {
  const h = String(req.headers.authorization || "");
  const given = /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "") : String(req.headers["x-api-key"] || "");
  return Boolean(token && given && safeEqual(given, token));
};

// ---------------------------------------------------------------- fake JohnVivzHR

export const startFakeHrPull = async ({ token, port = 0, host = "127.0.0.1", maxPageSize = 2 }) => {
  const data = HR_PULL_FIXTURE();
  const base = "/api/integration/v1";
  const notFound = (message = "Not found") => ({ status: 404, json: { success: false, message } });
  const find = (identifier) => data.employees.find((e) => [String(e.employee_id), e.permanent_employee_id, e.employee_code].includes(decodeURIComponent(identifier)));
  const hr = createServer({
    name: "hr", authorize: bearerAuth(token),
    async route({ req, url }) {
      const p = url.pathname;
      if (req.method !== "GET") return notFound();
      if (p === `${base}/ping`) return { status: 200, json: { success: true, message: "pong", time: new Date().toISOString() } };
      if (p === `${base}/employees`) {
        const status = url.searchParams.get("status");
        const dep = url.searchParams.get("department_id");
        const q = (url.searchParams.get("q") || "").toLowerCase();
        const list = data.employees.filter((e) => (!status || e.status === status) && (!dep || String(e.department.department_id) === dep) && (!q || e.full_name.toLowerCase().includes(q)));
        const pageSize = Math.min(maxPageSize, Math.max(1, Number(url.searchParams.get("page_size") || 20)));
        const page = Math.max(1, Number(url.searchParams.get("page") || 1));
        return { status: 200, json: { success: true, data: { items: list.slice((page - 1) * pageSize, page * pageSize), page, page_size: pageSize, total: list.length, total_pages: Math.max(1, Math.ceil(list.length / pageSize)) } } };
      }
      let m = p.match(new RegExp(`^${base}/employees/([^/]+)$`));
      if (m) { const e = find(m[1]); return e ? { status: 200, json: { success: true, data: e } } : notFound("Employee not found"); }
      if (p === `${base}/departments`) return { status: 200, json: { success: true, data: data.departments } };
      m = p.match(new RegExp(`^${base}/departments/([^/]+)$`));
      if (m) { const d = data.departments.find((x) => String(x.department_id) === m[1]); return d ? { status: 200, json: { success: true, data: d } } : notFound("Department not found"); }
      return notFound();
    },
  });
  hr.data = data;
  hr.employee = (id) => find(String(id));
  hr.setStatus = (id, status) => { find(String(id)).status = status; };
  hr.patch = (id, patch) => Object.assign(find(String(id)), patch);
  hr.add = (e) => data.employees.push(e);
  return hr.start(port, host);
};

// ---------------------------------------------------------------- fake Inventory (its own dialect)

const EVENT_RULES = {
  "order.confirmed": (b) => [typeof b.orderReference === "string" && UUID.test(b.orderReference) ? null : "orderReference must be the CRM order id (a UUID)",
    Array.isArray(b.items) && b.items.length && b.items.every((i) => (typeof i.productId === "string" || Number.isInteger(i.productId)) && typeof i.quantity === "number" && i.quantity > 0) ? null : "items must be [{productId, quantity}]"],
  "sale.completed": (b) => [typeof b.orderReference === "string" && UUID.test(b.orderReference) ? null : "orderReference must be the CRM order id", typeof b.transactionReference === "string" && b.transactionReference ? null : "transactionReference is required"],
  "order.cancelled": (b) => [typeof b.orderReference === "string" && UUID.test(b.orderReference) ? null : "orderReference must be the CRM order id"],
  "sale.refunded": (b) => [typeof b.orderReference === "string" && UUID.test(b.orderReference) ? null : "orderReference must be the CRM order id", typeof b.transactionReference === "string" && b.transactionReference ? null : "transactionReference is required"],
  "return.received": (b) => [typeof b.transactionReference === "string" && b.transactionReference ? null : "transactionReference is required", Array.isArray(b.items) ? null : "items must be a list"],
};

/*
 * Answers exactly as the Inventory team described them on 2026-11-16 (from their code and tests):
 *   order.confirmed  202 {eventId, duplicate:false, result:{orderReference, reservations:[{productId, quantity, status:"reserved"}]}}
 *                    409 {error, code:"insufficient_stock", details:{orderReference, reserved:false, shortages:[{productId, sku, requestedQuantity, availableStock}]}}
 *                    409 code "product_unavailable" (unknown or archived) | "reservation_conflict" | "conflict"
 *                    same eventId again: 200 {eventId, duplicate:true, result:<original>}; same eventId, other body: 409 "conflict"
 *                    same orderReference, NEW eventId: same items 200 duplicate (original result), other items 409 "conflict"
 *                    all or nothing in one transaction; a refused event is NOT recorded (the same eventId can be sent again later)
 *   reservations never expire: only order.cancelled (released) or sale.completed (consumed, stock deducted once) change them.
 * Test knobs: failNext(n, status) answers 5xx without doing anything; dropAnswers(n) does the work, then closes the connection;
 * archiveOnReserve(productId) archives it at the next order.confirmed; conflictNext(code) refuses the next order.confirmed with that code;
 * availabilityOverride[productId] = n makes the read API claim n available (so CRM's own pre-check passes and Inventory's answer decides).
 */
export const startFakeInventoryDialect = async ({ token, port = 0, host = "127.0.0.1" }) => {
  const products = INVENTORY_DIALECT_PRODUCTS();
  const stock = Object.fromEntries(products.map((p) => [String(p.productId), p.stock]));
  const reservations = new Map(); // orderReference -> { items, state: reserved | consumed | released, result, body }
  const seen = new Map(); // eventId -> { body, out }   (only recorded events)
  const events = [];
  const rejected = [];
  const outbox = [];
  let seq = 0;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const itemsKey = (items) => JSON.stringify(items.map((i) => [String(i.productId), Number(i.quantity)]).sort());
  const reserved = (pid) => [...reservations.values()].filter((r) => r.state === "reserved").reduce((n, r) => n + (r.items.filter((i) => String(i.productId) === String(pid)).reduce((k, i) => k + i.quantity, 0)), 0);
  const avail = (p) => Math.max(0, stock[String(p.productId)] - reserved(p.productId));
  const shown = (p) => (inv.availabilityOverride[String(p.productId)] ?? avail(p));
  const view = (p) => ({ productId: p.productId, sku: p.sku, name: p.name, unit: p.unit, categoryName: p.categoryName, sellingPrice: p.sellingPrice, isVatable: p.isVatable, status: p.status, availableQty: shown(p) });
  const emit = (eventType, payload) => { const e = { eventId: `INV-EVT-${String(++seq).padStart(4, "0")}`, eventType, occurredAt: new Date().toISOString(), payload, acked: false }; outbox.push(e); return e; };
  const findProduct = (id) => products.find((x) => String(x.productId) === String(id));
  const base = "/api/integration/v1";

  const orderConfirmed = (json) => {
    const prior = reservations.get(json.orderReference);
    if (prior) { // same order reference with a NEW eventId
      if (itemsKey(prior.items) !== itemsKey(json.items)) return { status: 409, json: { error: `Order ${json.orderReference} is already reserved with other items`, code: "conflict" } };
      return { status: 200, json: { eventId: json.eventId, duplicate: true, result: prior.result }, record: false };
    }
    if (inv.forceConflict) { const code = inv.forceConflict; inv.forceConflict = null; return { status: 409, json: { error: "Reservation conflict for this order", code } }; }
    if (inv.archiveNext) { const x = findProduct(inv.archiveNext); inv.archiveNext = null; if (x) x.status = "archived"; }
    const unavailable = json.items.filter((i) => { const x = findProduct(i.productId); return !x || x.status !== "active"; });
    if (unavailable.length) return { status: 409, json: { error: `Product ${unavailable.map((i) => i.productId).join(", ")} is unknown or archived`, code: "product_unavailable", details: { orderReference: json.orderReference, productId: unavailable[0].productId } } };
    const need = {};
    for (const i of json.items) need[String(i.productId)] = (need[String(i.productId)] || 0) + i.quantity;
    const shortages = Object.entries(need).map(([pid, q]) => ({ x: findProduct(pid), q })).filter(({ x, q }) => avail(x) < q)
      .map(({ x, q }) => ({ productId: x.productId, sku: x.sku, requestedQuantity: q, availableStock: avail(x) }));
    if (shortages.length) {
      return { status: 409, json: { error: `Insufficient available stock for ${shortages.map((s) => s.sku).join(", ")}`, code: "insufficient_stock", details: { orderReference: json.orderReference, reserved: false, shortages } } };
    }
    const result = { orderReference: json.orderReference, reservations: json.items.map((i) => ({ productId: i.productId, quantity: i.quantity, status: "reserved" })) };
    reservations.set(json.orderReference, { items: json.items.map((i) => ({ ...i })), state: "reserved", result, body: json });
    for (const i of json.items) {
      emit("StockReserved", { orderReference: json.orderReference, productId: i.productId, quantity: i.quantity });
      const x = findProduct(i.productId);
      if (avail(x) === 0) emit("ProductUnavailable", { productId: x.productId });
    }
    return { status: 202, json: { eventId: json.eventId, duplicate: false, result }, record: true };
  };

  const inv = createServer({
    name: "inventory", authorize: bearerAuth(token),
    async route({ req, url, json }) {
      const p = url.pathname;
      if (p === `${base}/products` && req.method === "GET") {
        const q = (url.searchParams.get("search") || "").toLowerCase();
        const limit = Math.max(1, Number(url.searchParams.get("limit") || 20));
        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
        const list = products.filter((x) => !q || x.name.toLowerCase().includes(q));
        return { status: 200, json: { success: true, data: list.slice(offset, offset + limit).map(view), total: list.length } };
      }
      let m = p.match(new RegExp(`^${base}/products/([^/]+)(/availability|/price)?$`));
      if (m && req.method === "GET") {
        const x = findProduct(decodeURIComponent(m[1]));
        if (!x) return { status: 404, json: { success: false, message: "Product not found" } };
        if (m[2] === "/availability") return { status: 200, json: { success: true, data: { productId: x.productId, availableQty: shown(x), lowStock: shown(x) > 0 && shown(x) <= 10 } } };
        if (m[2] === "/price") return { status: 200, json: { success: true, data: { productId: x.productId, price: x.sellingPrice, currency: "PHP" } } };
        const { availableQty, ...detail } = view(x);
        return { status: 200, json: { success: true, data: detail } };
      }
      if (p === `${base}/events` && req.method === "POST") {
        if (inv.failures > 0) { inv.failures -= 1; return { status: inv.failStatus, json: { error: "injected failure" } }; }
        const rule = EVENT_RULES[json?.eventType];
        const problems = [typeof json?.eventId === "string" && json.eventId ? null : "eventId is required", rule ? null : `unknown eventType ${json?.eventType}`, ...(rule ? rule(json) : [])].filter(Boolean);
        if (problems.length) { rejected.push({ body: json, problems }); return { status: 400, json: { error: "Invalid event", code: "validation_error", details: problems } }; }
        const before = seen.get(json.eventId);
        if (before) {
          if (!same(before.body, json)) return { status: 409, json: { error: `Event ${json.eventId} was already received with another body`, code: "conflict" } };
          return { status: 200, json: { eventId: json.eventId, duplicate: true, result: before.out.json.result ?? null }, drop: inv.drop() };
        }
        let out;
        if (json.eventType === "order.confirmed") out = orderConfirmed(json);
        else {
          const r = reservations.get(json.orderReference);
          let result = { orderReference: json.orderReference || null };
          if (json.eventType === "sale.completed" && r && r.state === "reserved") {
            for (const i of r.items) stock[String(i.productId)] -= i.quantity; // deducted once
            r.state = "consumed";
            result = { ...result, consumed: true };
            emit("StockDeducted", { orderReference: json.orderReference, transactionReference: json.transactionReference });
          } else if (json.eventType === "order.cancelled" && r && r.state === "reserved") {
            r.state = "released";
            result = { ...result, released: true };
            emit("StockReleased", { orderReference: json.orderReference });
          }
          out = { status: 202, json: { eventId: json.eventId, duplicate: false, result }, record: true };
        }
        if (out.record !== false && out.status < 300) { seen.set(json.eventId, { body: json, out }); events.push(json); } // refused events are NOT recorded
        return { ...out, drop: out.status < 300 && inv.drop() };
      }
      if (p === `${base}/crm/outbox` && req.method === "GET") return { status: 200, json: { success: true, data: outbox.filter((e) => !e.acked).map(({ acked, ...e }) => e) } };
      m = p.match(new RegExp(`^${base}/crm/outbox/([^/]+)/ack$`));
      if (m && req.method === "POST") {
        const e = outbox.find((x) => x.eventId === decodeURIComponent(m[1]));
        if (!e) return { status: 404, json: { success: false, message: "Event not found" } };
        e.acked = true;
        return { status: 200, json: { success: true, eventId: e.eventId, acknowledged: true } };
      }
      return { status: 404, json: { success: false, message: "Not found" } };
    },
  });
  Object.assign(inv, {
    products, stock, reservations, events, rejected, outbox, emit, reserved, availabilityOverride: {},
    failures: 0, failStatus: 503, dropCount: 0, forceConflict: null, archiveNext: null,
    eventsOf: (t) => events.filter((e) => e.eventType === t),
    failNext: (n, status = 503) => { inv.failures = n; inv.failStatus = status; },
    dropAnswers: (n) => { inv.dropCount = n; },
    drop: () => (inv.dropCount > 0 ? (inv.dropCount -= 1, true) : false),
    conflictNext: (code = "reservation_conflict") => { inv.forceConflict = code; },
    archiveOnReserve: (productId) => { inv.archiveNext = productId; },
    postsFor: (type, orderReference) => inv.requests.filter((r) => r.path === `${base}/events` && r.body && (() => { try { const b = JSON.parse(r.body); return b.eventType === type && (!orderReference || b.orderReference === orderReference); } catch { return false; } })()),
  });
  inv.reset = () => { inv.requests.length = 0; events.length = 0; rejected.length = 0; };
  return inv.start(port, host);
};
