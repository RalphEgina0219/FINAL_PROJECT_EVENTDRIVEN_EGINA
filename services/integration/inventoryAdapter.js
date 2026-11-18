/*
 * Inventory adapter. Inventory owns products, prices and stock (blueprint §8). CRM never edits any of them:
 * it asks Inventory, reserves through Inventory, and keeps only a read-only snapshot (product_references).
 *
 *   getProducts({ids,q,category})  fresh product, price and availability answers
 *   reserveStock({...})            reserve stock for an order; idempotent on the order id (a retried call never reserves twice)
 *   releaseStock({...})            give a reservation back (checkout failed after the reservation, or the order was cancelled)
 *   issueStock({...})              mock: Inventory consumes the reservation at SaleCompleted. live: Inventory does that when the
 *                                  SaleCompleted EVENT arrives (the contract has no separate "issue" call), then sends StockIssued
 *   syncProducts()                 refresh the product_references snapshot
 *
 * Modes (INTEGRATION_INVENTORY_MODE):
 *   disabled  no calls, nothing is pretended
 *   mock      answers come from fixtures/mockInventory.js; clearly labelled, never sent anywhere
 *   live      HTTP calls to Inventory (docs/integration-contract.md §6). Off by default. The contract is a DRAFT until the
 *             Inventory team confirms it; the adapter is contract-tested against a local fake server only.
 *             With INTEGRATION_INVENTORY_DIALECT=johnvivz_inventory the Inventory app's own API is used instead
 *             (services/integration/inventoryDialect.js, contract §12.2): the reservation is its order.confirmed event.
 *
 * MOCK AVAILABILITY: stock on hand (fixture, or a test override stored in crm_settings as mock_inventory.<product_id>) minus the
 * quantity held (a) by CRM orders whose reservation is requested / reserved / issued and (b) by a mock reservation (crm_settings
 * mock_reservation.<order_id>) that was made before its order was saved and is not older than 30 minutes. A mock reservation is made
 * under lockInventory(), so two checkouts cannot both take the last unit. Every call is written to integration_logs.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../../models/index.js";
import { AppError } from "../../helpers/errors.js";
import { modeOf, SYSTEMS, logIntegration, signedRequest, refusedMessage, IntegrationDisabledError, IntegrationUnavailableError } from "./adapterBase.js";
import { isInventoryDialect, dialectOne, dialectCatalog, reserveViaOrderConfirmed, releaseViaOrderCancelled } from "./inventoryDialect.js";
import { MOCK_PRODUCTS, MOCK_SOURCE_VERSION } from "./fixtures/mockInventory.js";

const SYSTEM = SYSTEMS.inventory;
const MOCK_SOURCE = "johnvivz_inventory (mock)";
const HELD = "('requested','reserved','partially_reserved','issued')";
const API = "/api/integration/v1";
const MOCK_RESERVATION_TTL_MINUTES = 30;

export const inventoryMode = () => modeOf("inventory");
export const isMockInventory = () => inventoryMode() === "mock";

const assertUsable = () => {
  const mode = inventoryMode();
  if (mode === "disabled") throw new IntegrationDisabledError("inventory");
  return mode;
};

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
const money = (n) => Math.round(Number(n) * 100) / 100;
const qty3 = (n) => Math.round(Number(n) * 1000) / 1000;

// The reservation answer never arrived, so CRM does not know whether Inventory holds stock for the order.
export class ReservationUnknownError extends AppError {
  constructor(orderId, detail) {
    super("Inventory did not confirm the stock reservation in time, so the order was not placed. Please try again in a moment.", 503);
    this.orderId = orderId;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------- mock stock helpers

const overridesOf = async (transaction) => {
  const rows = await select("SELECT setting_key, setting_value FROM crm_settings WHERE setting_key LIKE 'mock_inventory.%'", {}, transaction);
  const map = {};
  for (const r of rows) {
    try { map[r.setting_key.slice("mock_inventory.".length)] = JSON.parse(r.setting_value); } catch { /* ignore a damaged override */ }
  }
  return map;
};

const mockReservations = async (transaction) => {
  const rows = await select("SELECT setting_key, setting_value FROM crm_settings WHERE setting_key LIKE 'mock_reservation.%'", {}, transaction);
  const out = [];
  for (const r of rows) {
    try { out.push({ orderId: r.setting_key.slice("mock_reservation.".length), ...JSON.parse(r.setting_value) }); } catch { /* ignore a damaged row */ }
  }
  return out;
};

const heldQuantities = async (ids, excludeOrderId, transaction) => {
  if (!ids.length) return {};
  const rows = await select(
    `SELECT i.product_id, SUM(i.quantity) AS held FROM sales_order_items i JOIN sales_orders o ON o.id = i.sales_order_id
     WHERE o.reservation_status IN ${HELD} AND o.status <> 'cancelled' AND i.product_id IN (:ids)
       ${excludeOrderId ? "AND o.order_id <> :exclude" : ""} GROUP BY i.product_id`,
    { ids, exclude: excludeOrderId || "" }, transaction
  );
  const held = Object.fromEntries(rows.map((r) => [r.product_id, Number(r.held)]));
  // reservations made before their order was saved (the order row takes over the hold once it exists)
  const pending = (await mockReservations(transaction)).filter((r) => r.orderId !== excludeOrderId && Date.now() - Date.parse(r.at) <= MOCK_RESERVATION_TTL_MINUTES * 60000);
  if (pending.length) {
    const saved = new Set((await select("SELECT order_id FROM sales_orders WHERE order_id IN (:ids)", { ids: pending.map((r) => r.orderId) }, transaction)).map((r) => r.order_id));
    for (const r of pending) if (!saved.has(r.orderId)) for (const l of r.lines) if (ids.includes(l.product_id)) held[l.product_id] = (held[l.product_id] || 0) + Number(l.quantity);
  }
  return held;
};

// Serializes mock reservations: call first thing inside the transaction that reserves (released at commit).
export const lockInventory = async (transaction) => {
  await sequelize.query("INSERT INTO number_sequences (scope, period, last_no) VALUES ('inventory_lock', 'ALL', 0) ON DUPLICATE KEY UPDATE last_no = last_no", { transaction });
  await sequelize.query("SELECT last_no FROM number_sequences WHERE scope = 'inventory_lock' AND period = 'ALL' FOR UPDATE", { transaction });
};

// ---------------------------------------------------------------- live helpers

// Maps an HTTP answer that means "the call itself failed" to an error the user can read.
const failIfBroken = (res, what) => {
  if (res.status >= 500) throw new IntegrationUnavailableError("inventory", `HTTP ${res.status}`);
  if (res.status === 401 || res.status === 403) throw new AppError(refusedMessage("inventory", what), 503);
};

const fromInventory = (p, availability = null, price = null) => {
  const available = availability?.available_qty ?? p.available_qty ?? 0; // unknown availability is never treated as stock
  const low = availability?.low_stock ?? p.low_stock ?? false;
  return {
    product_id: String(p.product_id), sku: p.sku || String(p.product_id), name: p.name, unit: p.unit || "", category_name: p.category_name || null,
    selling_price: money(price?.selling_price ?? p.selling_price), is_vatable: p.is_vatable ? 1 : 0, status: p.status === "inactive" ? "inactive" : "active",
    available_qty: Math.max(0, qty3(available)), low_stock: low && Number(available) > 0 ? 1 : 0, is_mock: 0,
  };
};

const liveOne = async (id) => {
  if (isInventoryDialect()) {
    const answer = await dialectOne(id);
    return answer ? fromInventory(...answer) : null;
  }
  const base = `${API}/products/${encodeURIComponent(id)}`;
  const [detail, availability, price] = await Promise.all([
    signedRequest("inventory", { path: base }), signedRequest("inventory", { path: `${base}/availability` }), signedRequest("inventory", { path: `${base}/price` }),
  ]);
  if (detail.status === 404) return null;
  failIfBroken(detail, "product"); failIfBroken(availability, "availability"); failIfBroken(price, "price");
  if (!detail.ok || !detail.json) throw new AppError(`Inventory answered ${detail.status} for product ${id}.`, 502);
  return fromInventory(detail.json, availability.ok ? availability.json : null, price.ok ? price.json : null);
};

const liveCatalog = async ({ q, category }) => {
  if (isInventoryDialect()) return (await dialectCatalog({ q })).map((p) => fromInventory(p));
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const res = await signedRequest("inventory", { path: `${API}/products`, query: { query: q || undefined, category: category || undefined, page } });
    failIfBroken(res, "product list");
    if (!res.ok || !Array.isArray(res.json?.items)) throw new AppError(`Inventory answered ${res.status} for the product list.`, 502);
    items.push(...res.json.items.map((p) => fromInventory(p)));
    if (page >= Number(res.json.total_pages || 1)) break;
  }
  return items;
};

// ---------------------------------------------------------------- products and availability

export const getProducts = async ({ ids = null, q = "", category = "", includeInactive = false, excludeOrderId = null, transaction } = {}) => {
  const mode = assertUsable();
  if (mode === "live") {
    let list;
    if (ids) list = (await Promise.all([...new Set(ids)].map(liveOne))).filter(Boolean);
    else list = await liveCatalog({ q, category });
    if (!includeInactive) list = list.filter((p) => p.status === "active");
    if (category) list = list.filter((p) => p.category_name === category);
    if (q) { const needle = q.toLowerCase(); list = list.filter((p) => p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle)); }
    return list;
  }
  const overrides = await overridesOf(transaction);
  let list = MOCK_PRODUCTS.map((p) => ({ ...p, ...(overrides[p.product_id] ? { selling_price: overrides[p.product_id].price ?? p.selling_price, stock: overrides[p.product_id].stock ?? p.stock, status: overrides[p.product_id].status ?? p.status } : {}) }));
  if (ids) list = list.filter((p) => ids.includes(p.product_id));
  if (!includeInactive) list = list.filter((p) => p.status === "active");
  if (category) list = list.filter((p) => p.category_name === category);
  if (q) { const needle = q.toLowerCase(); list = list.filter((p) => p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle)); }
  const held = await heldQuantities(list.map((p) => p.product_id), excludeOrderId, transaction);
  if (ids) await logIntegration({ direction: "api_call", system: SYSTEM, endpoint: "/products/availability", method: "POST", success: true, mode, message: `MOCK availability check for ${ids.length} product(s)` });
  return list.map((p) => {
    const available = Math.max(0, Math.round((Number(p.stock) - (held[p.product_id] || 0)) * 1000) / 1000);
    return {
      product_id: p.product_id, sku: p.sku, name: p.name, unit: p.unit, category_name: p.category_name, selling_price: money(p.selling_price),
      is_vatable: p.is_vatable ? 1 : 0, status: p.status, available_qty: available, low_stock: available > 0 && available <= p.low_stock_level ? 1 : 0, is_mock: 1,
    };
  });
};

// Categories for the shop filter and the promotion form. Live: from the snapshot (refreshed by "Refresh product snapshot" and product events).
export const productCategories = async () => {
  if (inventoryMode() === "live") {
    const rows = await select("SELECT DISTINCT category_name FROM product_references WHERE is_mock = 0 AND status = 'active' AND category_name IS NOT NULL ORDER BY category_name");
    return rows.map((r) => r.category_name);
  }
  return [...new Set(MOCK_PRODUCTS.filter((p) => p.status === "active").map((p) => p.category_name))].sort();
};

// Test helper (mock mode only): change a product's price, stock or status in the MOCK Inventory.
export const mockOverride = async (productId, patch) => {
  if (!isMockInventory()) throw new Error("Overrides exist only in mock mode.");
  const key = `mock_inventory.${productId}`;
  const [row] = await select("SELECT setting_value FROM crm_settings WHERE setting_key = :key", { key });
  const next = { ...(row ? JSON.parse(row.setting_value) : {}), ...patch };
  await sequelize.query("INSERT INTO crm_settings (setting_key, setting_value, description) VALUES (:key, :value, 'MOCK Inventory override (tests only)') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", { replacements: { key, value: JSON.stringify(next) } });
};
export const mockClearOverrides = () => sequelize.query("DELETE FROM crm_settings WHERE setting_key LIKE 'mock_inventory.%'");

// ---------------------------------------------------------------- reserve / release / issue

/*
 * lines: [{ product_id, quantity }]. Returns { status: "reserved" | "failed", reservation_ref, lines: [{ product_id, quantity,
 * available, ok, reason }], duplicate }. A repeated call for the same order returns the first answer without reserving again.
 * Live: POST /reservations with the order id as the natural key plus an Idempotency-Key header. If the answer never arrives (timeout,
 * 5xx) the call is repeated once, then ReservationUnknownError is thrown so the caller can queue a compensation.
 */
export const reserveStock = async ({ key, orderId, correlationId, lines }) => {
  const mode = assertUsable();
  if (mode === "live" && isInventoryDialect()) {
    const out = await reserveViaOrderConfirmed({ orderId, correlationId, lines });
    if (out.status === "unknown") throw new ReservationUnknownError(orderId, out.detail); // the caller queues the clean-up task
    if (out.kind === "unavailable") await refreshSnapshotFor(out.productIds);
    return out;
  }
  if (mode === "live") return reserveLive({ key, orderId, correlationId, lines });
  const started = Date.now();
  const outcome = await sequelize.transaction(async (transaction) => {
    await lockInventory(transaction);
    const [held] = await select("SELECT setting_value FROM crm_settings WHERE setting_key = :k", { k: `mock_reservation.${orderId}` }, transaction);
    if (held) return { duplicate: true, ref: JSON.parse(held.setting_value).ref };
    const [existing] = await select("SELECT inventory_reservation_ref AS ref, reservation_status AS st FROM sales_orders WHERE order_id = :orderId AND inventory_reservation_ref IS NOT NULL", { orderId }, transaction);
    if (existing && ["reserved", "issued"].includes(existing.st)) return { duplicate: true, ref: existing.ref };
    const products = await getProducts({ ids: lines.map((l) => l.product_id), includeInactive: true, excludeOrderId: orderId, transaction });
    const byId = Object.fromEntries(products.map((p) => [p.product_id, p]));
    const answers = lines.map((l) => {
      const p = byId[l.product_id];
      if (!p || p.status !== "active") return { product_id: l.product_id, quantity: l.quantity, available: 0, ok: false, reason: "not sold any more" };
      if (p.available_qty < l.quantity) return { product_id: l.product_id, quantity: l.quantity, available: p.available_qty, ok: false, reason: "not enough stock" };
      return { product_id: l.product_id, quantity: l.quantity, available: p.available_qty, ok: true, reason: null };
    });
    const ok = answers.every((a) => a.ok);
    const ref = ok ? `MOCK-RSV-${String(orderId).replace(/-/g, "").slice(0, 12).toUpperCase()}` : null;
    if (ok) {
      await sequelize.query(
        "INSERT INTO crm_settings (setting_key, setting_value, description) VALUES (:k, :v, 'MOCK Inventory reservation (held until the order is saved or 30 minutes pass)')",
        { replacements: { k: `mock_reservation.${orderId}`, v: JSON.stringify({ ref, at: new Date().toISOString(), lines: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })) }) }, transaction }
      );
    }
    return { duplicate: false, ok, ref, answers };
  });
  if (outcome.duplicate) {
    await logIntegration({ direction: "api_call", system: SYSTEM, endpoint: "/reservations", method: "POST", correlationId, success: true, mode, durationMs: Date.now() - started, message: `MOCK reserve ${key}: duplicate, the earlier reservation is returned` });
    return { status: "reserved", reservation_ref: outcome.ref, duplicate: true, lines: [] };
  }
  await logIntegration({
    direction: "api_call", system: SYSTEM, endpoint: "/reservations", method: "POST", correlationId, success: outcome.ok, mode, durationMs: Date.now() - started,
    message: outcome.ok ? `MOCK reserve ${key}: reserved ${lines.length} line(s)` : `MOCK reserve ${key}: refused (${outcome.answers.filter((a) => !a.ok).map((a) => `${a.product_id} ${a.reason}`).join(", ")})`,
  });
  return { status: outcome.ok ? "reserved" : "failed", reservation_ref: outcome.ref, lines: outcome.answers, duplicate: false };
};

const reserveLive = async ({ key, orderId, correlationId, lines }) => {
  const body = { order_id: orderId, correlation_id: correlationId, items: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })) };
  let res = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 2 && !res; attempt++) {
    try {
      const r = await signedRequest("inventory", { method: "POST", path: `${API}/reservations`, body, headers: { "Idempotency-Key": key }, correlationId, logMessage: `reserve ${key} (attempt ${attempt})` });
      if (r.status >= 500) { lastError = `HTTP ${r.status}`; continue; }
      res = r;
    } catch (err) {
      if (!err.unreachable) throw err;
      lastError = err.message;
    }
  }
  if (!res) throw new ReservationUnknownError(orderId, lastError);
  failIfBroken(res, "reservation");
  const json = res.json || {};
  const items = Array.isArray(json.items) ? json.items : [];
  const answers = items.map((i) => ({ product_id: i.product_id, quantity: Number(i.quantity), available: Number(i.available_qty ?? 0), ok: i.ok !== false && i.reason == null, reason: i.reason || null }));
  if (res.status === 404) throw new AppError("Inventory does not offer the reservation endpoint (docs/integration-contract.md §6 is not confirmed yet).", 503);
  if ((res.status === 200 || res.status === 201) && json.status === "reserved" && json.reservation_id) {
    return { status: "reserved", reservation_ref: String(json.reservation_id), duplicate: res.status === 200, lines: answers };
  }
  // 409 (not enough stock) or a refusal; a partial reservation (reservation_id present) must be given back by the caller
  return {
    status: "failed", reservation_ref: json.reservation_id ? String(json.reservation_id) : null, duplicate: false,
    lines: answers.length ? answers : lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity, available: 0, ok: false, reason: json.error || `refused (HTTP ${res.status})` })),
  };
};

export const releaseStock = async ({ key, orderId, reservationRef, correlationId }) => {
  const mode = assertUsable();
  if (mode === "live" && isInventoryDialect()) return releaseViaOrderCancelled({ orderId, correlationId });
  if (mode === "live") {
    if (!reservationRef) return { status: "nothing_to_release", reservation_ref: null };
    const res = await signedRequest("inventory", { method: "DELETE", path: `${API}/reservations/${encodeURIComponent(reservationRef)}`, correlationId, headers: { "Idempotency-Key": key }, logMessage: `release ${key}` });
    failIfBroken(res, "release");
    if ([200, 202, 204, 404].includes(res.status)) return { status: res.status === 404 ? "already_released" : "released", reservation_ref: reservationRef };
    throw new AppError(`Inventory answered ${res.status} when the reservation ${reservationRef} was released.`, 502);
  }
  await sequelize.query("DELETE FROM crm_settings WHERE setting_key = :k", { replacements: { k: `mock_reservation.${orderId}` } });
  await logIntegration({ direction: "api_call", system: SYSTEM, endpoint: `/reservations/${reservationRef}/release`, method: "POST", correlationId, success: true, mode, message: `MOCK release ${key} for order ${orderId}` });
  return { status: "released", reservation_ref: reservationRef };
};

// The order was saved: from now on the order row itself is the hold, so the separate mock reservation row is removed (live: nothing to do).
export const settleReservation = async ({ orderId }) => {
  if (inventoryMode() === "mock") await sequelize.query("DELETE FROM crm_settings WHERE setting_key = :k", { replacements: { k: `mock_reservation.${orderId}` } });
};

export const issueStock = async ({ key, orderId, reservationRef, correlationId }) => {
  const mode = assertUsable();
  if (mode === "live") return { status: "requested_by_sale_completed_event", reservation_ref: reservationRef };
  await logIntegration({ direction: "api_call", system: SYSTEM, endpoint: `/reservations/${reservationRef}/issue`, method: "POST", correlationId, success: true, mode, message: `MOCK issue ${key} for order ${orderId} (Inventory consumes the reservation)` });
  return { status: "issued", reservation_ref: reservationRef };
};

// ---------------------------------------------------------------- snapshot (product_references)

const upsertSnapshot = (p, { source, version, isMock }) =>
  sequelize.query(
    `INSERT INTO product_references (product_id, sku, name, category_name, unit, selling_price, is_vatable, status, available_qty, availability_checked_at,
                                     low_stock, source, source_version, is_mock, last_synced_at)
     VALUES (:product_id, :sku, :name, :category_name, :unit, :selling_price, :is_vatable, :status, :available_qty, NOW(), :low_stock, :source, :version, :isMock, NOW())
     ON DUPLICATE KEY UPDATE sku = VALUES(sku), name = VALUES(name), category_name = VALUES(category_name), unit = VALUES(unit), selling_price = VALUES(selling_price),
       is_vatable = VALUES(is_vatable), status = VALUES(status), available_qty = VALUES(available_qty), availability_checked_at = NOW(),
       low_stock = VALUES(low_stock), source = VALUES(source), source_version = VALUES(source_version), is_mock = VALUES(is_mock), last_synced_at = NOW()`,
    { replacements: { ...p, source, version, isMock: isMock ? 1 : 0 } }
  );

export const syncProducts = async () => {
  const mode = assertUsable();
  const started = Date.now();
  const products = await getProducts({ includeInactive: true });
  const meta = mode === "live" ? { source: SYSTEM, version: null, isMock: false } : { source: MOCK_SOURCE, version: MOCK_SOURCE_VERSION, isMock: true };
  for (const p of products) await upsertSnapshot(p, meta);
  await logIntegration({
    direction: "sync", system: SYSTEM, endpoint: mode === "live" ? `${API}/products` : "fixtures/mockInventory.js", success: true, mode, durationMs: Date.now() - started,
    message: `Refreshed ${products.length} product snapshot(s) from the ${mode === "live" ? "live" : "MOCK"} Inventory`,
  });
  return products.length;
};

// Re-reads some products from Inventory (live) and refreshes their snapshot; one Inventory no longer knows is marked inactive. Never throws.
export const refreshSnapshotFor = async (productIds) => {
  const ids = [...new Set((productIds || []).map(String))];
  if (!ids.length || inventoryMode() !== "live") return 0;
  try {
    const found = await getProducts({ ids, includeInactive: true });
    for (const p of found) await upsertSnapshot(p, { source: SYSTEM, version: null, isMock: false });
    const gone = ids.filter((id) => !found.some((p) => p.product_id === id));
    if (gone.length) await sequelize.query("UPDATE product_references SET status = 'inactive', available_qty = 0, low_stock = 0, last_synced_at = NOW() WHERE product_id IN (:gone) AND is_mock = 0", { replacements: { gone } });
    await logIntegration({ direction: "sync", system: SYSTEM, endpoint: `${API}/products`, success: true, mode: "live", message: `Snapshot refreshed for ${ids.join(", ")} after Inventory said a product is unavailable${gone.length ? ` (${gone.join(", ")} no longer known: marked inactive)` : ""}` });
    return found.length;
  } catch (err) {
    await logIntegration({ direction: "sync", system: SYSTEM, endpoint: `${API}/products`, success: false, mode: "live", message: `Snapshot refresh for ${ids.join(", ")} failed: ${err.message}` });
    return 0;
  }
};

// Used by the inbound event processors (ProductCreated / ProductUpdated / ProductPriceUpdated / StockUpdated ...).
export const applyProductSnapshot = (p, { eventId = null } = {}) =>
  upsertSnapshot(fromInventory(p), { source: SYSTEM, version: eventId ? String(eventId).slice(0, 40) : null, isMock: false });
