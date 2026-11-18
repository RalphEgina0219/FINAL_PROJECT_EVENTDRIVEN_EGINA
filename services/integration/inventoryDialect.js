/*
 * Inventory dialect (interim, docs/integration-contract.md §12.2). Used when INTEGRATION_INVENTORY_MODE=live and
 * INTEGRATION_INVENTORY_DIALECT=johnvivz_inventory: the Inventory app's own event names and fields, a Bearer token, and an outbox CRM polls.
 *
 *   products     GET /products?search=&limit=&offset=, /products/:id, /:id/availability, /:id/price (price is a string)
 *   events out   POST /events {eventId, eventType, ...}:
 *                  OrderConfirmed -> order.confirmed {orderReference = our order_id, items[{productId, quantity}]}
 *                  SaleCompleted  -> sale.completed  {orderReference, transactionReference = our transaction_no}
 *                  SaleCancelled  -> order.cancelled {orderReference}
 *                  RefundRecorded -> sale.refunded   {orderReference, transactionReference}   (Inventory does not restore stock)
 *                eventId is a UUID made from the event and the order (or refund), so every attempt, and the release CRM sends at once
 *                with the SaleCancelled event, carry the SAME eventId: Inventory's duplicate check then applies it only once.
 *   events in    Inventory never pushes. CRM reads GET /crm/outbox every minute (jobs/scheduler.js) and on "Refresh product snapshot",
 *                stores each event in CRM's inbox (duplicate protection by Inventory's eventId), processes it, then acknowledges it with
 *                POST /crm/outbox/:eventId/ack. StockDeducted is CRM's StockIssued and ProductUnavailable is StockUnavailable.
 *
 *   checkout     the reservation IS order.confirmed (contract §12.2, answers confirmed by the Inventory team on 2026-11-16). Synchronous and
 *                all or nothing, in one Inventory transaction; reservations NEVER expire, so CRM always releases (order.cancelled) what it
 *                reserved when an order is cancelled, when saving fails after reserving, and when a clean-up task finds no saved order.
 *                  202 {eventId, duplicate:false, result:{orderReference, reservations:[{productId, quantity, status}]}}   reserved
 *                  200 {duplicate:true, result:<original>}                       the same reservation again (retry, same eventId or same items)
 *                  409 code insufficient_stock, details.shortages[{productId, sku, requestedQuantity, availableStock}]   nothing reserved
 *                  409 code product_unavailable                                  unknown or archived product: nothing reserved
 *                  409 code conflict | reservation_conflict                       same order/event with different items: nothing new reserved
 *                  5xx or no answer                                              unknown: retried once, then a clean-up task finds out and releases
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../../models/index.js";
import { config } from "../../config/index.js";
import { AppError } from "../../helpers/errors.js";
import { modeOf, SYSTEMS, API, signedRequest, logIntegration, refusedMessage, uuidFrom, IntegrationUnavailableError } from "./adapterBase.js";
import { isoWithOffset } from "./signing.js";

export const DIALECT = "johnvivz_inventory";
export const OUTBOX_POLL_SECONDS = 60;
const SYSTEM = SYSTEMS.inventory;
const PAGE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isInventoryDialect = () => modeOf("inventory") === "live" && config.integration.inventory.dialect === DIALECT;

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const pick = (o, ...names) => { for (const n of names) if (o && o[n] !== undefined && o[n] !== null && o[n] !== "") return o[n]; return undefined; };
// The Inventory app may wrap answers as {success, data}. Field names are read in camelCase or snake_case.
const unwrap = (json) => (json && typeof json === "object" && !Array.isArray(json) && json.data !== undefined ? json.data : json);
const listOf = (data) => (Array.isArray(data) ? data : ["items", "products", "events", "rows", "results"].map((k) => data?.[k]).find(Array.isArray) || null);


const broken = (res, what) => {
  if (res.status >= 500) throw new IntegrationUnavailableError("inventory", `HTTP ${res.status}`);
  if (res.status === 401 || res.status === 403) throw new AppError(refusedMessage("inventory", what), 503);
};

// ---------------------------------------------------------------- products

const truthy = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ""));
/*
 * One product in CRM's field names. is_vatable defaults to true when Inventory does not say (Accounting treats prices as VAT-inclusive);
 * that default is listed as a question for the Inventory team.
 */
export const normalizeProduct = (raw) => {
  const p = raw || {};
  const id = pick(p, "productId", "product_id", "id");
  const category = pick(p, "categoryName", "category_name") ?? (p.category && typeof p.category === "object" ? pick(p.category, "name", "categoryName", "category_name") : p.category);
  const statusText = String(pick(p, "status") ?? "");
  const inactive = /^(inactive|discontinued|archived|disabled|unavailable)$/i.test(statusText) || p.isActive === false || p.active === false || p.is_active === false;
  const vat = pick(p, "isVatable", "is_vatable", "vatable", "vatApplicable");
  return {
    product_id: id === undefined ? undefined : String(id),
    sku: String(pick(p, "sku", "productCode", "product_code", "code") ?? id ?? ""),
    name: pick(p, "name", "productName", "product_name"),
    unit: pick(p, "unit", "unitOfMeasure", "unit_of_measure", "uom") || "",
    category_name: category ?? null,
    selling_price: pick(p, "sellingPrice", "selling_price", "price", "unitPrice", "unit_price"),
    is_vatable: vat === undefined ? true : truthy(vat),
    status: inactive ? "inactive" : "active",
    available_qty: pick(p, "availableQty", "available_qty", "available", "availableQuantity", "quantityAvailable", "stockAvailable"),
    low_stock: truthy(pick(p, "lowStock", "low_stock", "isLowStock")),
  };
};

const getJson = async (path, query) => {
  const res = await signedRequest("inventory", { path: `${API}${path}`, query });
  return res;
};

// Answers in CRM's form for inventoryAdapter.fromInventory(): [product, availability, price]
export const dialectOne = async (id) => {
  const base = `/products/${encodeURIComponent(id)}`;
  const [detail, availability, price] = await Promise.all([getJson(base), getJson(`${base}/availability`), getJson(`${base}/price`)]);
  if (detail.status === 404) return null;
  broken(detail, "product"); broken(availability, "availability"); broken(price, "price");
  if (!detail.ok || !detail.json) throw new AppError(`Inventory answered ${detail.status} for product ${id}.`, 502);
  const p = normalizeProduct(unwrap(detail.json));
  const a = availability.ok ? unwrap(availability.json) : null;
  const pr = price.ok ? unwrap(price.json) : null;
  const priceValue = pr === null ? undefined : (typeof pr === "string" || typeof pr === "number" ? pr : pick(pr, "sellingPrice", "selling_price", "price", "unitPrice", "unit_price"));
  return [
    { ...p, product_id: p.product_id ?? String(id) },
    a ? { available_qty: pick(a, "availableQty", "available_qty", "available", "availableQuantity", "quantityAvailable"), low_stock: truthy(pick(a, "lowStock", "low_stock", "isLowStock")) } : null,
    priceValue === undefined ? null : { selling_price: Number(String(priceValue).replace(/,/g, "")) },
  ];
};

export const dialectCatalog = async ({ q }) => {
  const items = [];
  for (let page = 0; page < 20; page++) {
    const res = await getJson("/products", { search: q || undefined, limit: PAGE, offset: page * PAGE });
    broken(res, "product list");
    const list = res.ok ? listOf(unwrap(res.json)) : null;
    if (!list) throw new AppError(`Inventory answered ${res.status} for the product list.`, 502);
    items.push(...list.map(normalizeProduct).filter((p) => p.product_id && p.name));
    if (list.length < PAGE) break;
  }
  return items;
};

// ---------------------------------------------------------------- events out (outbox dispatcher, release)

export const dialectEventId = (type, ref) => uuidFrom(`${config.appSource}:${type}:${ref}`);
// Inventory's product ids are numbers (12); CRM keeps them as text ("12"). Numeric text goes back as a number.
export const invProductId = (id) => (/^\d+$/.test(String(id)) ? Number(id) : String(id));
// One body for order.confirmed, used by checkout AND by the outbox: Inventory answers "conflict" when the same eventId comes with another body.
export const orderConfirmedBody = (orderId, lines) => ({
  eventId: dialectEventId("order.confirmed", orderId), eventType: "order.confirmed", orderReference: orderId,
  items: lines.map((l) => ({ productId: invProductId(l.product_id), quantity: Number(l.quantity) })),
});
// What CRM stores in sales_orders.inventory_reservation_ref: Inventory has no reservation id, the order reference is the key.
export const dialectReservationRef = (orderId) => `INV-ORDER:${orderId}`;

/*
 * Turns one of CRM's outbox envelopes (contract §4) into the Inventory app's event body. Returns null when Inventory has no equivalent.
 */
export const toInventoryEvent = async (envelope) => {
  const d = envelope.data || {};
  switch (envelope.event_type) {
    case "OrderConfirmed": // the same body as at checkout, so Inventory answers "duplicate"
      return orderConfirmedBody(d.order_id, d.items || []);
    case "SaleCompleted":
      return { eventId: dialectEventId("sale.completed", d.order_id), eventType: "sale.completed", orderReference: d.order_id, transactionReference: d.transaction_no };
    case "SaleCancelled":
      return { eventId: dialectEventId("order.cancelled", d.order_id), eventType: "order.cancelled", orderReference: d.order_id };
    case "RefundRecorded": {
      const [sale] = d.sale_id ? await select("SELECT transaction_no FROM sales_transactions WHERE sale_id = :id", { id: d.sale_id }) : [];
      return { eventId: dialectEventId("sale.refunded", d.refund_id), eventType: "sale.refunded", orderReference: d.order_id, transactionReference: sale?.transaction_no || null };
    }
    default:
      return null;
  }
};

export const sendInventoryEvent = (body, { eventId = null, correlationId = null, direction = "outbound_event", logMessage = null } = {}) =>
  signedRequest("inventory", { method: "POST", path: `${API}/events`, body, direction, eventId, correlationId, headers: { "Idempotency-Key": body.eventId }, logMessage: logMessage || `${body.eventType} ${body.orderReference || ""}`.trim() });

// The release CRM sends when an order is cancelled or could not be saved: order.cancelled, with the same eventId as the SaleCancelled event.
export const releaseViaOrderCancelled = async ({ orderId, correlationId }) => {
  const body = { eventId: dialectEventId("order.cancelled", orderId), eventType: "order.cancelled", orderReference: orderId };
  const res = await sendInventoryEvent(body, { correlationId, direction: "api_call", logMessage: `release ${orderId} (order.cancelled)` });
  broken(res, "order.cancelled");
  if (res.ok || res.status === 404) return { status: res.status === 404 ? "already_released" : res.json?.duplicate ? "already_released" : "released", reservation_ref: null };
  throw new AppError(`Inventory answered ${res.status} to order.cancelled for ${orderId}.`, 502);
};

// ---------------------------------------------------------------- checkout reservation (order.confirmed)

const ids = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(String);
/*
 * Reads Inventory's answer to order.confirmed (no database, no network: unit-tested). Returns one of
 *   { outcome: "reserved", duplicate, reservations }   { outcome: "short", shortages }   { outcome: "unavailable", productIds }
 *   { outcome: "conflict", code, message }   { outcome: "refused", code, message }   { outcome: "unknown", detail }
 */
export const readReservationAnswer = (res) => {
  const json = res.json && typeof res.json === "object" ? res.json : {};
  const reservations = (Array.isArray(json.result?.reservations) ? json.result.reservations : [])
    .map((r) => ({ product_id: String(r.productId ?? r.product_id), quantity: Number(r.quantity), status: r.status || "reserved" }));
  if (res.status === 202) return { outcome: "reserved", duplicate: false, reservations };
  if (res.status === 200 && json.duplicate === true) return { outcome: "reserved", duplicate: true, reservations };
  if (res.status === 409) {
    const code = String(json.code || "");
    const d = json.details || {};
    if (code === "insufficient_stock") {
      return { outcome: "short", shortages: (Array.isArray(d.shortages) ? d.shortages : []).map((x) => ({ product_id: x.productId === undefined || x.productId === null ? null : String(x.productId), sku: x.sku || null, requested: Number(x.requestedQuantity), available: Number(x.availableStock) })) };
    }
    if (code === "product_unavailable") return { outcome: "unavailable", productIds: [...ids(d.productId), ...ids(d.productIds), ...(Array.isArray(d.products) ? d.products.map((p) => String(p.productId ?? p)) : [])] };
    if (code === "conflict" || code === "reservation_conflict") return { outcome: "conflict", code, message: String(json.error || code).slice(0, 200) };
    return { outcome: "refused", code: code || "409", message: String(json.error || "").slice(0, 200) };
  }
  if (res.status >= 500 || (res.status >= 200 && res.status < 300)) return { outcome: "unknown", detail: `HTTP ${res.status}${res.status < 300 ? " without a reservation result" : ""}` }; // never assumed reserved or free
  return { outcome: "refused", code: `HTTP ${res.status}`, message: String(json.error || json.message || "").slice(0, 200) };
};

const nameMap = async (lines) => {
  const rows = lines.length ? await select("SELECT product_id, sku, name FROM product_references WHERE product_id IN (:ids)", { ids: lines.map((l) => String(l.product_id)) }) : [];
  return { byId: Object.fromEntries(rows.map((r) => [r.product_id, r])), bySku: Object.fromEntries(rows.filter((r) => r.sku).map((r) => [r.sku, r])) };
};

/*
 * Reserves stock for a checkout. Same eventId on every attempt (and in the outbox), so a retry can never reserve twice.
 * Returns { status: "reserved" | "failed" | "unknown", kind, reservation_ref, duplicate, lines[{product_id, quantity, ok, reason, name}], ... }.
 */
export const reserveViaOrderConfirmed = async ({ orderId, correlationId, lines }) => {
  const body = orderConfirmedBody(orderId, lines);
  let res = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 2 && !res; attempt++) {
    try {
      const r = await sendInventoryEvent(body, { correlationId, direction: "api_call", logMessage: `reserve ${orderId} (order.confirmed, attempt ${attempt})` });
      if (r.status >= 500) { lastError = `HTTP ${r.status}`; continue; }
      res = r;
    } catch (err) {
      if (!err.unreachable) throw err;
      lastError = err.message;
    }
  }
  if (!res) return { status: "unknown", detail: lastError };
  broken(res, "order.confirmed");
  const a = readReservationAnswer(res);
  const log = (success, message) => logIntegration({ direction: "api_call", system: SYSTEM, endpoint: "order.confirmed", method: "POST", correlationId, httpStatus: res.status, success, mode: "live", message: message.slice(0, 480) });
  const okLines = lines.map((l) => ({ product_id: String(l.product_id), quantity: Number(l.quantity), ok: true, reason: null, available: null }));
  if (a.outcome === "reserved") {
    const held = a.reservations.length ? a.reservations : okLines;
    await log(true, `RESERVED order ${orderId}${a.duplicate ? " (already reserved: duplicate answer)" : ""}: ${held.map((r) => `${r.product_id} x${r.quantity}`).join(", ")}`);
    return { status: "reserved", reservation_ref: dialectReservationRef(orderId), duplicate: a.duplicate, lines: okLines, reservations: held };
  }
  if (a.outcome === "short") {
    const names = await nameMap(lines);
    const out = okLines.map((l) => {
      const s = a.shortages.find((x) => (x.product_id !== null && x.product_id === l.product_id) || (x.sku && names.byId[l.product_id]?.sku === x.sku));
      if (!s) return l;
      return { ...l, ok: false, available: s.available, name: names.byId[l.product_id]?.name || null, reason: s.available > 0 ? `only ${s.available} available (you asked for ${s.requested})` : "out of stock" };
    });
    // a shortage that matches no line of ours is still shown, by our product name (never the bare SKU) when we know it
    for (const x of a.shortages.filter((x) => !out.some((l) => !l.ok && (l.product_id === x.product_id || names.byId[l.product_id]?.sku === x.sku)))) {
      const known = (x.sku && names.bySku[x.sku]) || (x.product_id && names.byId[x.product_id]);
      out.push({ product_id: x.product_id || known?.product_id || "?", quantity: x.requested, ok: false, available: x.available, name: known?.name || "A product in your order", reason: `only ${x.available} available (you asked for ${x.requested})` });
    }
    await log(false, `SHORT order ${orderId}: nothing reserved; ${a.shortages.map((x) => `${x.product_id || x.sku} asked ${x.requested}, available ${x.available}`).join("; ")}`);
    return { status: "failed", kind: "stock", reservation_ref: null, duplicate: false, lines: out };
  }
  if (a.outcome === "unavailable") {
    const bad = a.productIds.length ? a.productIds : okLines.map((l) => l.product_id);
    await log(false, `UNAVAILABLE order ${orderId}: nothing reserved; product(s) ${bad.join(", ")} unknown or archived at Inventory`);
    return { status: "failed", kind: "unavailable", productIds: bad, reservation_ref: null, duplicate: false, lines: okLines.map((l) => (bad.includes(l.product_id) ? { ...l, ok: false, reason: "is not sold any more" } : l)) };
  }
  if (a.outcome === "conflict" || a.outcome === "refused") {
    await log(false, `${a.outcome === "conflict" ? "CONFLICT" : "REFUSED"} ${a.code} for order ${orderId}: ${a.message || "no detail"}. No order was created; anything Inventory holds for this order reference is released by a clean-up task.`);
    return { status: "failed", kind: a.outcome, code: a.code, reservation_ref: null, duplicate: false, lines: okLines };
  }
  return { status: "unknown", detail: a.detail };
};

// ---------------------------------------------------------------- events in (polled outbox)

export const INBOUND_TYPES = { StockDeducted: "StockIssued", ProductUnavailable: "StockUnavailable" };

const isoOf = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? isoWithOffset(new Date(t)) : isoWithOffset();
};

// One Inventory outbox event -> CRM inbox envelope (contract §3), or null when it has no id.
export const fromInventoryOutbox = (item) => {
  const id = pick(item, "eventId", "event_id", "id");
  if (id === undefined) return null;
  const original = String(pick(item, "eventType", "event_type", "type") || "Unknown");
  const p = (item.payload && typeof item.payload === "object" ? item.payload : item.data && typeof item.data === "object" ? item.data : item) || {};
  const type = INBOUND_TYPES[original] || original;
  const productId = pick(p, "productId", "product_id");
  const orderId = pick(p, "orderReference", "order_reference", "orderId", "order_id");
  let data;
  if (["ProductCreated", "ProductUpdated"].includes(type)) data = normalizeProduct(p);
  else if (type === "ProductPriceUpdated") data = { product_id: productId, selling_price: pick(p, "sellingPrice", "selling_price", "price", "newPrice"), effective_from: pick(p, "effectiveFrom", "effective_from") };
  else if (["StockUnavailable", "LowStockDetected", "StockAdjusted", "StockReleased"].includes(type) && productId !== undefined) data = { product_id: productId, available_qty: pick(p, "availableQty", "available_qty", "available", "quantityAvailable", "newQuantity") };
  else data = {};
  if (orderId !== undefined) data.order_id = String(orderId);
  if (type === "StockReserved") data.reservation_id = String(pick(p, "reservationId", "reservation_id", "reservationReference") ?? `INV-${orderId}`);
  if (type === "StockIssued") data.issued_at = pick(p, "deductedAt", "issuedAt", "occurredAt");
  if (data.product_id !== undefined) data.product_id = String(data.product_id);
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  data.inventory_event = { id: String(id), type: original };
  return {
    event_id: UUID.test(String(id)) ? String(id).toLowerCase() : uuidFrom(`${SYSTEM}:outbox:${id}`),
    event_type: type.replace(/[^A-Za-z0-9]/g, "").slice(0, 60) || "Unknown", schema_version: 1, source: SYSTEM,
    occurred_at: isoOf(pick(item, "occurredAt", "occurred_at", "createdAt", "created_at")),
    entity_id: String(data.product_id ?? data.order_id ?? id).slice(0, 64), correlation_id: null,
    idempotency_key: `inventory-outbox:${id}`.slice(0, 160), data,
  };
};

let polling = false;

/*
 * Reads Inventory's outbox once, stores + processes every event, then acknowledges it. An event is acknowledged once it is safely in
 * CRM's inbox (processed, ignored, failed — retried by CRM's own job — or dead, kept for a manual reprocess), or when CRM already had it.
 * Returns { read, stored, duplicate, acked, ack_failed, skipped }.
 */
export const pollInventoryOutbox = async ({ trigger = "job" } = {}) => {
  if (!isInventoryDialect()) return { off: true };
  if (polling) return { skipped_run: true };
  polling = true;
  const started = Date.now();
  const out = { read: 0, stored: 0, duplicate: 0, acked: 0, ack_failed: 0, skipped: 0 };
  try {
    const res = await signedRequest("inventory", { path: `${API}/crm/outbox`, direction: "sync" });
    broken(res, "crm/outbox");
    const list = res.ok ? listOf(unwrap(res.json)) : null;
    if (!list) throw new AppError(`Inventory answered ${res.status} for crm/outbox.`, 502);
    const { receiveEvent } = await import("./inboxService.js");
    for (const item of list) {
      out.read += 1;
      const envelope = fromInventoryOutbox(item);
      if (!envelope) { out.skipped += 1; continue; }
      const result = await receiveEvent(envelope);
      if (result.duplicate) out.duplicate += 1; else out.stored += 1;
      const id = envelope.data.inventory_event.id;
      const ack = await signedRequest("inventory", { method: "POST", path: `${API}/crm/outbox/${encodeURIComponent(id)}/ack`, body: {}, direction: "sync", eventId: envelope.event_id, logMessage: `ack ${id}` }).catch((err) => ({ ok: false, status: 0, err }));
      if (ack.ok) out.acked += 1; else out.ack_failed += 1; // not acknowledged = Inventory offers it again; CRM's inbox answers duplicate
    }
    if (out.read || trigger !== "job") {
      await logIntegration({ direction: "sync", system: SYSTEM, endpoint: `${API}/crm/outbox`, success: out.ack_failed === 0, mode: "live", durationMs: Date.now() - started, message: `Inventory outbox (${trigger}): ${out.read} read, ${out.stored} new, ${out.duplicate} already in CRM, ${out.acked} acknowledged${out.ack_failed ? `, ${out.ack_failed} NOT acknowledged` : ""}${out.skipped ? `, ${out.skipped} without an eventId` : ""}` });
    }
    return out;
  } catch (err) {
    await logIntegration({ direction: "sync", system: SYSTEM, endpoint: `${API}/crm/outbox`, success: false, mode: "live", durationMs: Date.now() - started, message: `Inventory outbox (${trigger}) not read: ${err.message}` });
    throw err;
  } finally {
    polling = false;
  }
};

