/*
 * Signed machine-to-machine API (docs/integration-contract.md §5 and §7). Mounted BEFORE the session, flash and CSRF middleware
 * (index.js): there are no cookies, no logins and no CSRF tokens here, only the HMAC signature.
 *
 * Every request must carry X-JVZ-Client, X-JVZ-Timestamp and X-JVZ-Signature (services/integration/signing.js), or, for an app set to
 * INTEGRATION_<APP>_AUTH=bearer (interim dialect, contract §12), "Authorization: Bearer <APP>_API_TOKEN" (X-API-Key is accepted too).
 *   - one inbound secret per connected app (JVZ_CRM_INBOUND_SECRET_HR / _INVENTORY / _ACCOUNTING); no secret set = that app is refused
 *   - a timestamp more than JVZ_MAX_CLOCK_SKEW_SECONDS (default 300) from now is refused
 *   - replay protection: a signature that was already accepted is refused (integration_request_nonces)
 *   - an app whose adapter is not in LIVE mode is answered 503: real events are never accepted while mocked or disabled
 * Answers: 202 accepted, 200 duplicate, 400 invalid envelope, 401 signature/timestamp/replay, 403 not allowed for that app, 503 not live.
 */
import crypto from "crypto";
import express from "express";
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { config } from "../config/index.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { SYSTEMS, modeOf, keyOfTarget, logIntegration, authOf } from "../services/integration/adapterBase.js";
import { verifyRequest } from "../services/integration/signing.js";
import { validateEnvelope, receiveEvent } from "../services/integration/inboxService.js";
import { salesReconciliation } from "../services/integration/reconciliationService.js";

const router = express.Router();
const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const money = (n) => Number(n || 0).toFixed(2);
const iso = (d) => (d ? new Date(d).toISOString() : null);

router.use(express.raw({ type: () => true, limit: "256kb" }));
router.use(rateLimit({ windowMs: 60 * 1000, max: 600, onLimit: (req, res) => fail(res, 429, "rate_limited") }));

// ---------------------------------------------------------------- authentication

// Bearer (interim dialect, contract §12): an app whose INTEGRATION_<APP>_AUTH=bearer may call CRM with "Authorization: Bearer <APP>_API_TOKEN"
// (or X-API-Key), the same token CRM uses to call it. Compared in constant time; no replay guard (there is no signature to remember).
const sameToken = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const bearerOf = (req) => {
  const h = String(req.get("Authorization") || "");
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
  return String(req.get("X-API-Key") || "").trim();
};

const authenticate = async (req, res, next) => {
  let client = String(req.get("X-JVZ-Client") || "").slice(0, 40);
  let key = keyOfTarget(client);
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const refuse = async (status, error, why) => {
    await logIntegration({ direction: "api_served", system: key ? client : "unknown", endpoint: req.originalUrl.slice(0, 250), method: req.method, httpStatus: status, success: false, mode: "live", message: `Refused: ${why || error}` });
    return fail(res, status, error);
  };
  const token = bearerOf(req);
  if (token && !req.get("X-JVZ-Signature")) {
    const match = Object.keys(SYSTEMS).find((k) => authOf(k) === "bearer" && config.integration[k].token && sameToken(token, config.integration[k].token));
    if (!match || (key && key !== match)) return refuse(401, "unauthorized", match ? "the token belongs to another app" : "unknown API token");
    key = match;
    client = SYSTEMS[match];
    if (modeOf(key) !== "live") return refuse(503, "integration_not_live", `the ${client} integration is ${modeOf(key)}, not live`);
    req.service = { key, client, body };
    return next();
  }
  const secret = key ? config.integration.inboundSecrets[client] : "";
  const signature = String(req.get("X-JVZ-Signature") || "");
  if (key && authOf(key) === "bearer") return refuse(401, "unauthorized", "this app is set to API-token authentication (INTEGRATION_*_AUTH=bearer)");
  if (!key || !secret) return refuse(401, "unauthorized", key ? "no inbound secret is set for this client" : "unknown client");
  const check = verifyRequest({
    secret, method: req.method, path: req.originalUrl, timestamp: String(req.get("X-JVZ-Timestamp") || ""), body, signature,
    maxSkewSeconds: config.integration.maxClockSkewSeconds,
  });
  if (!check.ok) return refuse(401, check.reason === "stale_timestamp" ? "stale_timestamp" : "invalid_signature", check.reason);
  if (modeOf(key) !== "live") return refuse(503, "integration_not_live", `the ${client} integration is ${modeOf(key)}, not live`);
  try {
    await sequelize.query("INSERT INTO integration_request_nonces (signature, client) VALUES (:signature, :client)", { replacements: { signature, client } });
  } catch (err) {
    if (err?.original?.code === "ER_DUP_ENTRY" || err?.parent?.code === "ER_DUP_ENTRY") return refuse(401, "replayed_request", "this signed request was already accepted once");
    throw err;
  }
  req.service = { key, client, body };
  next();
};

const only = (...keys) => (req, res, next) => (keys.includes(req.service.key) ? next() : fail(res, 403, "forbidden", { message: `${req.service.client} may not call this endpoint.` }));
const served = (req, status, message) => logIntegration({ direction: "api_served", system: req.service.client, endpoint: req.originalUrl.slice(0, 250), method: req.method, httpStatus: status, success: status < 400, mode: "live", message });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(wrap(authenticate));

// ---------------------------------------------------------------- health

router.get("/v1/health", (req, res) => {
  res.json({ status: "ok", app: config.appSource, as_of: new Date().toISOString(), your_mode: modeOf(req.service.key) });
});

// Signed test endpoint (merge kit): proves that a signed POST with a body gets through. Returns the SHA-256 of the body CRM received.
router.post("/v1/test/echo", (req, res) => {
  res.json({ status: "ok", app: config.appSource, your_client: req.service.client, received_sha256: crypto.createHash("sha256").update(req.service.body).digest("hex"), server_time: new Date().toISOString() });
});

// ---------------------------------------------------------------- events in

router.post("/v1/events", wrap(async (req, res) => {
  let envelope;
  try { envelope = JSON.parse(req.service.body.toString("utf8")); } catch { return fail(res, 400, "invalid_json"); }
  const errors = validateEnvelope(envelope, req.service.client);
  if (errors.length) {
    await logIntegration({ direction: "inbound_event", system: req.service.client, endpoint: String(envelope?.event_type || "?").slice(0, 60), eventId: UUIDish(envelope?.event_id), success: false, mode: "live", httpStatus: 400, message: `Invalid envelope: ${errors.join(" ")}`.slice(0, 480) });
    return fail(res, 400, "invalid_envelope", { details: errors });
  }
  const out = await receiveEvent(envelope);
  if (out.duplicate) return res.status(200).json({ status: "duplicate", event_id: envelope.event_id });
  return res.status(202).json({ status: "accepted", event_id: envelope.event_id });
}));

const UUIDish = (v) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null);

// ---------------------------------------------------------------- data CRM serves (contract §7)

router.get("/v1/customers/:id", only("accounting", "inventory"), wrap(async (req, res) => {
  const [c] = await select("SELECT customer_id, customer_no, first_name, last_name, status FROM customers WHERE customer_id = :id", { id: req.params.id });
  if (!c) { await served(req, 404, "customer not found"); return fail(res, 404, "not_found"); }
  await served(req, 200, `customer ${c.customer_no}`);
  res.json({ customer_id: c.customer_id, customer_no: c.customer_no, display_name: `${c.first_name} ${c.last_name}`.trim(), status: c.status });
}));

router.get("/v1/orders/:id", only("inventory", "accounting"), wrap(async (req, res) => {
  const [o] = await select(
    `SELECT o.*, c.customer_id AS customer_uuid FROM sales_orders o JOIN customers c ON c.id = o.customer_id WHERE o.order_id = :id`, { id: req.params.id });
  if (!o) { await served(req, 404, "order not found"); return fail(res, 404, "not_found"); }
  const items = await select("SELECT line_no, product_id, sku, quantity, unit_price, is_vatable, discount_amount, line_total FROM sales_order_items WHERE sales_order_id = :id ORDER BY line_no", { id: o.id });
  await served(req, 200, `order ${o.order_no}`);
  res.json({
    order_id: o.order_id, order_no: o.order_no, customer_id: o.customer_uuid, status: o.status, payment_status: o.payment_status, channel: o.channel, fulfillment: o.fulfillment,
    reservation_status: o.reservation_status, reservation_id: o.inventory_reservation_ref, correlation_id: o.correlation_id, currency: o.currency,
    totals: { subtotal: money(o.subtotal), discount_total: money(o.discount_total), grand_total: money(o.grand_total) },
    confirmed_at: iso(o.confirmed_at), completed_at: iso(o.completed_at), cancelled_at: iso(o.cancelled_at),
    items: items.map((i) => ({ line_no: i.line_no, product_id: i.product_id, sku: i.sku, quantity: Number(i.quantity), unit_price: money(i.unit_price), discount_amount: money(i.discount_amount), line_total: money(i.line_total), is_vatable: Boolean(i.is_vatable) })),
  });
}));

router.get("/v1/sales/:id", only("accounting"), wrap(async (req, res) => {
  const [s] = await select(
    `SELECT s.*, o.order_id AS order_uuid, c.customer_id AS customer_uuid FROM sales_transactions s JOIN sales_orders o ON o.id = s.sales_order_id JOIN customers c ON c.id = s.customer_id WHERE s.sale_id = :id`, { id: req.params.id });
  if (!s) { await served(req, 404, "sale not found"); return fail(res, 404, "not_found"); }
  const payments = await select("SELECT method, reference_no, amount, paid_at FROM payment_references WHERE sales_order_id = :id AND status = 'verified' ORDER BY id", { id: s.sales_order_id });
  const refunds = await select("SELECT refund_id, amount, status, recorded_at FROM refunds WHERE sales_transaction_id = :id ORDER BY id", { id: s.id });
  await served(req, 200, `sale ${s.transaction_no}`);
  res.json({
    sale_id: s.sale_id, transaction_no: s.transaction_no, order_id: s.order_uuid, customer_id: s.customer_uuid, status: s.status, payment_status: s.payment_status, completed_at: iso(s.completed_at), currency: s.currency,
    totals: { gross: money(s.gross_amount), discount_total: money(s.discount_total), net: money(s.net_amount) }, correlation_id: s.correlation_id,
    payments: payments.map((p) => ({ method: p.method, reference_no: p.reference_no, amount: money(p.amount), paid_at: iso(p.paid_at) })),
    refunds: refunds.map((r) => ({ refund_id: r.refund_id, amount: money(r.amount), status: r.status, recorded_at: iso(r.recorded_at) })),
  });
}));

router.get("/v1/reconciliation/sales", only("accounting"), wrap(async (req, res) => {
  const report = await salesReconciliation({ from: req.query.from, to: req.query.to, limit: 1000 });
  await served(req, 200, `${report.rows.length} sale(s)`);
  res.json({
    summary: report.summary,
    sales: report.rows.map((r) => ({
      sale_id: r.sale_id, transaction_no: r.transaction_no, order_id: r.order_id, completed_at: iso(r.completed_at), net_amount: r.net_amount, currency: r.currency, sale_status: r.sale_status,
      status: r.status, deliveries: Object.fromEntries(Object.entries(r.deliveries).map(([t, d]) => [t, d.state])),
    })),
    truncated: report.truncated,
  });
}));

// ---------------------------------------------------------------- errors (always JSON)

router.use((req, res) => fail(res, 404, "not_found"));
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === "entity.too.large") return fail(res, 413, "payload_too_large");
  console.error("❌ integration API:", err);
  return fail(res, 500, "server_error");
});

export default router;
