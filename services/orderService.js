/*
 * Orders, payments and sales, P5 (blueprint §7). CRM owns the order and sale source records; Inventory owns products,
 * prices and stock; Accounting owns the ledger. CRM never types a price and never edits stock.
 *
 * Order lifecycle (the status column of the schema; the blueprint defines no delivery steps such as "Preparing"):
 *   (placed and stock reserved) -> confirmed -> ready -> completed          confirmed | ready -> cancelled
 *   - An order exists only after Inventory accepted the reservation, so it starts as `confirmed` (OrderConfirmed event).
 *   - `completed` needs the payment verified in full; it creates ONE sales_transactions row and one SaleCompleted event.
 *
 * Checkout (portal cart and staff order builder) re-asks Inventory for price and availability inside the transaction that
 * creates the order, and REJECTS the order if a price changed, a product is not sold any more, or stock is not enough.
 * The reservation uses the idempotency key reserve:<order_id>; the order_id is generated when the form is shown, so a
 * resubmitted form returns the order that already exists instead of reserving or creating again.
 *
 * Payments: no live gateway. Cash (in store), Cash on Delivery, GCash and Maya are recorded with a manually entered
 * reference number; a staff member verifies it (never the one who recorded it). Order payment_status follows the
 * verified payments.
 *
 * Record scope (applied in SQL on every read and again on every action):
 *   customer     own orders
 *   agent        orders of customers in the agent's customer scope, or created for her (agent_id)
 *   team_leader  orders of customers in the team's scope (includes unrouted customers) or of the team
 *   crm_manager  every order
 */
import crypto from "crypto";
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { AppError } from "../helpers/errors.js";
import { directoryScope } from "./customerService.js";
import { nextDailyNumber } from "./numberService.js";
import { notify, userIdsByRole } from "./notificationService.js";
import { publishEvent } from "./eventService.js";
import { getProducts, reserveStock, issueStock, settleReservation, productCategories, inventoryMode, ReservationUnknownError } from "./integration/inventoryAdapter.js";
import { queueCompensation, releaseOrQueue } from "./integration/compensationService.js";
import { isoWithOffset } from "./integration/signing.js";
import { checkRedemption, redeemOnOrder, returnRedemption, earnForSale, redemptionOf } from "./loyaltyService.js";

// Splits `total` cents over lines in proportion to `bases` (each line's remaining amount); rounding goes to the last line that can take it.
const spread = (total, bases) => {
  const sum = bases.reduce((a, b) => a + b, 0);
  if (!total || !sum) return bases.map(() => 0);
  const out = bases.map((b) => Math.floor((total * b) / sum));
  let left = total - out.reduce((a, b) => a + b, 0);
  for (let i = out.length - 1; i >= 0 && left > 0; i--) { const room = bases[i] - out[i]; const add = Math.min(room, left); out[i] += add; left -= add; }
  return out;
};

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
const exec = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction });

export const ORDER_STATUS_LABELS = { draft: "Draft", submitted: "Submitted", pending_stock: "Waiting for stock", confirmed: "Confirmed", ready: "Ready", completed: "Completed", cancelled: "Cancelled" };
export const PAYMENT_STATUS_LABELS = { unpaid: "Unpaid", partially_paid: "Partly paid", paid: "Paid", partially_refunded: "Partly refunded", refunded: "Refunded" };
export const CHANNEL_LABELS = { walk_in: "Walk-in", phone: "Phone", portal: "Customer portal", delivery: "Delivery" };
export const FULFILLMENT_LABELS = { in_store: "In store", pickup: "Pickup", delivery: "Delivery" };
export const PAYMENT_METHOD_LABELS = { cash: "Cash (in store)", cod: "Cash on delivery", gcash: "GCash", maya: "Maya" };
export const PAYMENT_RECORD_STATUS_LABELS = { recorded: "Recorded, not verified", verified: "Verified", voided: "Voided" };
export const STAFF_CHANNELS = ["walk_in", "phone"];
export const MIN_REASON_LENGTH = 5;
const REFERENCE_METHODS = ["gcash", "maya"]; // the customer can enter these at checkout
const MAX_LINES = 30;
const MAX_QTY = 999;

const cents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => Math.round(c) / 100;
const dec = (n) => Number(n).toFixed(2); // money in events is a decimal string (docs/integration-contract.md §3)
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ---------------------------------------------------------------- errors

// 409: Inventory's answer differs from what the user saw (price changed, not enough stock, not sold any more).
const conflict = (issues) => {
  const err = new AppError(`The order was not placed: ${issues.map((i) => i.message).join("; ")}.`, 409);
  err.issues = issues;
  return err;
};

// ---------------------------------------------------------------- scope

export const orderScope = (user) => {
  if (user.role === "customer") return { sql: "o.customer_id = :viewerCustomerId", params: { viewerCustomerId: user.customer_id || 0 } };
  if (user.role === "crm_manager") return { sql: "1=1", params: {} };
  const cs = directoryScope(user); // refers to the customers alias `c`
  if (user.role === "agent") return { sql: `(o.agent_id = :ordMe OR ${cs.sql})`, params: { ...cs.params, ordMe: user.id } };
  if (user.role === "team_leader") return { sql: `(${cs.sql} OR o.team_id = :ordTeam)`, params: { ...cs.params, ordTeam: user.team_id || 0 } };
  return { sql: "1=0", params: {} };
};

const PAID_SQL = "(SELECT COALESCE(SUM(p.amount), 0) FROM payment_references p WHERE p.sales_order_id = o.id AND p.status = 'verified')";
const COMMITTED_SQL = "(SELECT COALESCE(SUM(p.amount), 0) FROM payment_references p WHERE p.sales_order_id = o.id AND p.status IN ('recorded','verified'))";
const COLUMNS = `o.id, o.order_id, o.order_no, o.customer_id, o.agent_id, o.team_id, o.channel, o.fulfillment, o.delivery_address_id, o.status, o.payment_status,
  o.reservation_status, o.inventory_reservation_ref, o.subtotal, o.discount_total, o.grand_total, o.currency, o.correlation_id, o.submitted_at, o.confirmed_at,
  o.completed_at, o.cancelled_at, o.cancel_reason, o.created_by, o.is_demo, o.created_at,
  c.customer_no, CONCAT(c.first_name, ' ', c.last_name) AS customer_name, ag.display_name AS agent_name,
  s.id AS sale_row_id, s.sale_id, s.transaction_no, s.status AS sale_status,
  ${PAID_SQL} AS verified_total, ${COMMITTED_SQL} AS committed_total,
  (SELECT COUNT(*) FROM sales_order_items i WHERE i.sales_order_id = o.id) AS item_count`;
const FROM = `FROM sales_orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN crm_users ag ON ag.id = o.agent_id LEFT JOIN sales_transactions s ON s.sales_order_id = o.id`;

const shape = (r) => ({ ...r, subtotal: Number(r.subtotal), discount_total: Number(r.discount_total), grand_total: Number(r.grand_total), verified_total: Number(r.verified_total), committed_total: Number(r.committed_total) });

export const listOrders = async (user, { q, status, payment, channel, mine, limit, offset }) => {
  const scope = orderScope(user);
  const where = [scope.sql];
  const params = { ...scope.params };
  if (q) {
    where.push("(o.order_no LIKE :q OR c.customer_no LIKE :q OR CONCAT(c.first_name, ' ', c.last_name) LIKE :q OR s.transaction_no LIKE :q)");
    params.q = `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
  }
  if (status) { where.push("o.status = :status"); params.status = status; }
  if (payment) { where.push("o.payment_status = :payment"); params.payment = payment; }
  if (channel) { where.push("o.channel = :channel"); params.channel = channel; }
  if (mine) { where.push("o.agent_id = :mine"); params.mine = user.id; }
  const [{ total }] = await select(`SELECT COUNT(*) AS total ${FROM} WHERE ${where.join(" AND ")}`, params);
  const rows = await select(`SELECT ${COLUMNS} ${FROM} WHERE ${where.join(" AND ")} ORDER BY o.created_at DESC, o.id DESC LIMIT :limit OFFSET :offset`, { ...params, limit, offset });
  return { total: Number(total), rows: rows.map(shape) };
};

export const findOrder = async (id, user) => {
  const scope = orderScope(user);
  const [row] = await select(`SELECT ${COLUMNS} ${FROM} WHERE o.id = :id AND ${scope.sql}`, { id, ...scope.params });
  if (!row) return null;
  const order = shape(row);
  const [items, payments, refunds, address] = await Promise.all([
    select(`SELECT i.line_no, i.product_id, i.sku, i.product_name, i.unit, i.quantity, i.unit_price, i.discount_amount, i.line_total, i.promotion_id
            FROM sales_order_items i WHERE i.sales_order_id = :id ORDER BY i.line_no`, { id }),
    select(`SELECT p.id, p.method, p.reference_no, p.amount, p.paid_at, p.status, p.recorded_by, p.void_reason, u.display_name AS recorded_by_name, u.role AS recorded_by_role,
                   (SELECT v.display_name FROM crm_audit_logs l JOIN crm_users v ON v.id = l.actor_user_id WHERE l.action = 'payment_verified' AND l.record_id = CAST(p.id AS CHAR) COLLATE utf8mb4_unicode_ci ORDER BY l.id DESC LIMIT 1) AS verified_by_name
            FROM payment_references p LEFT JOIN crm_users u ON u.id = p.recorded_by WHERE p.sales_order_id = :id ORDER BY p.id`, { id }),
    row.sale_row_id
      ? select(`SELECT r.id, r.refund_no, r.amount, r.reason, r.status, r.created_at FROM refunds r WHERE r.sales_transaction_id = :sid ORDER BY r.id`, { sid: row.sale_row_id })
      : [],
    row.delivery_address_id ? select("SELECT label, line1, barangay, city_municipality, province, postal_code FROM customer_addresses WHERE id = :id", { id: row.delivery_address_id }) : [],
  ]);
  const promo = await select(
    `SELECT pr.promo_code, pr.name, r.discount_amount FROM promotion_redemptions r JOIN promotions pr ON pr.id = r.promotion_id WHERE r.sales_order_id = :id LIMIT 1`, { id });
  return {
    ...order, items: items.map((i) => ({ ...i, quantity: Number(i.quantity), unit_price: Number(i.unit_price), discount_amount: Number(i.discount_amount), line_total: Number(i.line_total) })),
    payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })), refunds: refunds.map((r) => ({ ...r, amount: Number(r.amount) })), address: address[0] || null,
    promotion: promo[0] ? { ...promo[0], discount_amount: Number(promo[0].discount_amount) } : null,
    loyalty: await redemptionOf(id),
    outstanding: Math.max(0, fromCents(cents(order.grand_total) - cents(order.committed_total))),
  };
};

// What the customer sees on Order Tracking: the lifecycle steps and which are done.
export const trackingSteps = (o) => {
  const steps = [
    { label: "Order placed", done: true, at: o.submitted_at || o.created_at },
    { label: "Confirmed, stock reserved", done: Boolean(o.confirmed_at), at: o.confirmed_at },
    { label: "Payment verified", done: ["paid", "partially_refunded", "refunded"].includes(o.payment_status), at: null },
    { label: o.fulfillment === "delivery" ? "Ready for delivery" : "Ready for pickup", done: ["ready", "completed"].includes(o.status), at: null },
    { label: "Completed", done: o.status === "completed", at: o.completed_at },
  ];
  if (o.status === "cancelled") steps.push({ label: `Cancelled: ${o.cancel_reason || "no reason given"}`, done: true, at: o.cancelled_at, cancelled: true });
  return steps;
};

// ---------------------------------------------------------------- catalog

export const listCatalog = async ({ q = "", category = "" } = {}) => ({ products: await getProducts({ q, category }), categories: await productCategories() });

// ---------------------------------------------------------------- cart (customer portal)

const cartFor = async (customerId, transaction, create = true) => {
  let [cart] = await select("SELECT id FROM cart_records WHERE customer_id = :customerId AND status = 'active' ORDER BY id DESC LIMIT 1", { customerId }, transaction);
  if (!cart && create) {
    const [id] = await sequelize.query("INSERT INTO cart_records (customer_id, status) VALUES (?, 'active')", { replacements: [customerId], transaction });
    cart = { id };
  }
  return cart || null;
};

// The cart with the CURRENT price and availability next to the price shown when the item was added.
export const getCart = async (user) => {
  if (user.role !== "customer") throw new AppError("Only customers have a cart.", 403);
  const cart = await cartFor(user.customer_id, undefined, false);
  if (!cart) return { cart: null, items: [], total: 0, issues: 0 };
  const rows = await select("SELECT product_id, sku, product_name, quantity, unit_price_snapshot FROM cart_items WHERE cart_id = :id ORDER BY id", { id: cart.id });
  const fresh = Object.fromEntries((await getProducts({ ids: rows.map((r) => r.product_id), includeInactive: true })).map((p) => [p.product_id, p]));
  let total = 0;
  let issues = 0;
  const items = rows.map((r) => {
    const p = fresh[r.product_id];
    const qty = Number(r.quantity);
    const shown = Number(r.unit_price_snapshot);
    const current = p ? p.selling_price : null;
    const problems = [];
    if (!p || p.status !== "active") problems.push("not sold any more");
    else {
      if (p.available_qty < qty) problems.push(p.available_qty <= 0 ? "out of stock" : `only ${p.available_qty} left`);
      if (current !== shown) problems.push(`price changed from ₱${shown.toFixed(2)} to ₱${current.toFixed(2)}`);
    }
    if (problems.length) issues += 1;
    const line = fromCents(cents(current ?? shown) * qty);
    total += cents(current ?? shown) * qty;
    return { product_id: r.product_id, sku: r.sku, name: r.product_name, unit: p?.unit || "", quantity: qty, price_shown: shown, price_now: current, line_total: line, available: p ? p.available_qty : 0, problems };
  });
  return { cart, items, total: fromCents(total), issues };
};

const parseQty = (value, unit) => {
  const q = Number(value);
  if (!Number.isFinite(q) || q <= 0) throw new AppError("Enter a quantity greater than zero.", 422);
  if (q > MAX_QTY) throw new AppError(`The quantity cannot be more than ${MAX_QTY}.`, 422);
  if (Math.round(q * 1000) / 1000 !== q) throw new AppError("The quantity can have at most 3 decimals.", 422);
  if (unit !== "kg" && !Number.isInteger(q)) throw new AppError("This product is sold in whole units.", 422);
  return q;
};

export const addToCart = async ({ user, productId, quantity }) => {
  if (user.role !== "customer") throw new AppError("Only customers have a cart.", 403);
  const [p] = await getProducts({ ids: [productId] });
  if (!p) throw new AppError("This product is not sold any more.", 422);
  const qty = parseQty(quantity, p.unit);
  return sequelize.transaction(async (transaction) => {
    const cart = await cartFor(user.customer_id, transaction);
    const [line] = await select("SELECT quantity FROM cart_items WHERE cart_id = :cartId AND product_id = :productId", { cartId: cart.id, productId }, transaction);
    const total = (line ? Number(line.quantity) : 0) + qty;
    if (total > MAX_QTY) throw new AppError(`The quantity cannot be more than ${MAX_QTY}.`, 422);
    if (p.available_qty <= 0) throw new AppError(`${p.name} is out of stock.`, 422);
    if (total > p.available_qty) throw new AppError(`Only ${p.available_qty} ${p.unit} of ${p.name} are available.`, 422);
    await exec(
      `INSERT INTO cart_items (cart_id, product_id, sku, product_name, quantity, unit_price_snapshot) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = VALUES(quantity), unit_price_snapshot = VALUES(unit_price_snapshot), product_name = VALUES(product_name)`,
      [cart.id, p.product_id, p.sku, p.name, total, p.selling_price], transaction);
    return { name: p.name, quantity: total };
  });
};

export const setCartQuantity = async ({ user, productId, quantity }) => {
  const cart = await cartFor(user.customer_id, undefined, false);
  if (!cart) throw new AppError("Your cart is empty.", 422);
  if (Number(quantity) === 0) { await exec("DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?", [cart.id, productId]); return; }
  const [p] = await getProducts({ ids: [productId] });
  if (!p) throw new AppError("This product is not sold any more.", 422);
  const qty = parseQty(quantity, p.unit);
  if (qty > p.available_qty) throw new AppError(`Only ${p.available_qty} ${p.unit} of ${p.name} are available.`, 422);
  await exec("UPDATE cart_items SET quantity = ?, unit_price_snapshot = ? WHERE cart_id = ? AND product_id = ?", [qty, p.selling_price, cart.id, productId]);
};

export const removeFromCart = async ({ user, productId }) => {
  const cart = await cartFor(user.customer_id, undefined, false);
  if (cart) await exec("DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?", [cart.id, productId]);
};

// Accept the current prices of the cart (the customer saw the "price changed" notice and confirms).
export const acceptCartPrices = async ({ user }) => {
  const cart = await cartFor(user.customer_id, undefined, false);
  if (!cart) return 0;
  const rows = await select("SELECT product_id FROM cart_items WHERE cart_id = :id", { id: cart.id });
  const fresh = await getProducts({ ids: rows.map((r) => r.product_id) });
  for (const p of fresh) await exec("UPDATE cart_items SET unit_price_snapshot = ?, product_name = ? WHERE cart_id = ? AND product_id = ?", [p.selling_price, p.name, cart.id, p.product_id]);
  return fresh.length;
};

// ---------------------------------------------------------------- promotions at checkout

const promotionFor = async (code, items, subtotalCents, customerId, transaction) => {
  const [promo] = await select("SELECT * FROM promotions WHERE promo_code = :code", { code: String(code).trim().toUpperCase() }, transaction);
  if (!promo) throw new AppError("That promo code does not exist.", 422);
  const now = new Date();
  if (promo.status !== "active") throw new AppError(promo.status === "pending_approval" ? "That promotion has not been approved yet." : "That promotion is not active.", 422);
  if (now < new Date(promo.start_at) || now > new Date(promo.end_at)) throw new AppError("That promotion is outside its dates.", 422);
  if (promo.usage_limit) {
    const [{ n }] = await select("SELECT COUNT(*) AS n FROM promotion_redemptions WHERE promotion_id = :id", { id: promo.id }, transaction);
    if (Number(n) >= promo.usage_limit) throw new AppError("That promotion has reached its usage limit.", 422);
  }
  if (promo.min_order_amount && subtotalCents < cents(promo.min_order_amount)) throw new AppError(`That promotion needs an order of at least ₱${Number(promo.min_order_amount).toFixed(2)}.`, 422);
  const applies = items.map((it) => promo.applies_to === "order" || (promo.applies_to === "product" && it.product_id === promo.product_id) || (promo.applies_to === "category" && it.category_name === promo.category_name));
  const base = items.reduce((s, it, i) => s + (applies[i] ? it.gross : 0), 0);
  if (base <= 0) throw new AppError("That promotion does not apply to the items in this order.", 422);
  const total = Math.min(base, promo.promo_type === "percent" ? Math.round((base * Number(promo.value)) / 100) : cents(promo.value));
  const per = items.map(() => 0);
  let left = total;
  const idx = applies.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
  idx.forEach((i, n) => { const share = n === idx.length - 1 ? left : Math.min(left, Math.round((total * items[i].gross) / base)); per[i] = share; left -= share; });
  return { promo, total, per };
};

// ---------------------------------------------------------------- place an order

const normalizeLines = (lines) => {
  if (!Array.isArray(lines) || !lines.length) throw new AppError("Add at least one product to the order.", 422);
  const merged = new Map();
  for (const l of lines) {
    if (!l || !l.product_id) continue;
    const prev = merged.get(l.product_id);
    merged.set(l.product_id, { product_id: l.product_id, quantity: (prev ? prev.quantity : 0) + Number(l.quantity), expected_price: l.expected_price ?? prev?.expected_price ?? null });
  }
  if (!merged.size) throw new AppError("Add at least one product to the order.", 422);
  if (merged.size > MAX_LINES) throw new AppError(`An order can have at most ${MAX_LINES} products.`, 422);
  return [...merged.values()];
};

const checkPayment = (payment, grand) => {
  if (!payment || !payment.method) return null;
  if (!PAYMENT_METHOD_LABELS[payment.method]) throw new AppError("Choose a payment method.", 422);
  const ref = String(payment.reference || "").trim();
  if (REFERENCE_METHODS.includes(payment.method) && !/^[A-Za-z0-9-]{6,30}$/.test(ref)) throw new AppError(`Enter the ${PAYMENT_METHOD_LABELS[payment.method]} reference number (6 to 30 letters, numbers or dashes) exactly as it appears in your receipt.`, 422);
  if (payment.method === "cod" && ref) throw new AppError("The Cash on Delivery receipt number is entered when the cash is collected.", 422);
  return { method: payment.method, reference: ref || null, grand };
};

const referenceTaken = async (method, reference, transaction) => {
  if (!reference) return false;
  const [row] = await select("SELECT id FROM payment_references WHERE method = :method AND reference_no = :reference AND status <> 'voided' LIMIT 1", { method, reference }, transaction);
  return Boolean(row);
};

// Checkout order of work (the reservation is a call to another application, so it cannot sit inside the database transaction):
//   A. check everything that needs no stock hold: customer, address, Inventory's current price and availability, promotion, payment.
//      Nothing is reserved yet, so a failure here has nothing to undo.
//   B. reserve through Inventory (idempotent on the order id). A refusal rejects the order. If the answer never arrives, a
//      compensation is queued that finds out what Inventory holds and gives it back.
//   C. save the order, its items, the payment and the OrderConfirmed event in ONE database transaction. If saving fails, the
//      reservation is released at once; if that release fails too, a compensation retries it until it works.
export const placeOrder = async ({ user, customerId = null, channel = null, fulfillment, addressId = null, lines, promoCode = "", loyaltyPoints = 0, payment = null, requestKey = null, cartId = null, at = null, isDemo = false }) => {
  const isCustomer = user.role === "customer";
  if (!isCustomer && !["agent", "team_leader", "crm_manager"].includes(user.role)) throw new AppError("You cannot place orders.", 403);
  const owner = isCustomer ? user.customer_id : customerId;
  const chan = isCustomer ? "portal" : channel;
  if (!owner) throw new AppError("Choose the customer.", 422);
  if (!isCustomer && !STAFF_CHANNELS.includes(chan)) throw new AppError("Choose how the order was received (walk-in or phone).", 422);
  if (!FULFILLMENT_LABELS[fulfillment] || (isCustomer && fulfillment === "in_store")) throw new AppError("Choose pickup or delivery.", 422);
  const wanted = normalizeLines(lines);
  const orderId = isUuid(requestKey) ? requestKey.toLowerCase() : crypto.randomUUID();

  const [dup] = await select("SELECT id, order_no, customer_id FROM sales_orders WHERE order_id = :orderId", { orderId });
  if (dup) {
    if (Number(dup.customer_id) !== Number(owner)) throw new AppError("This order request belongs to another customer.", 409);
    return { id: dup.id, order_no: dup.order_no, duplicate: true };
  }

  // ---- A. checks that need no stock hold
  const scope = isCustomer ? null : directoryScope(user);
  const [customer] = await select(
    `SELECT c.id, c.customer_id AS customer_uuid, c.customer_no, c.first_name, c.last_name FROM customers c WHERE c.id = :id AND c.status <> 'merged'
     ${isCustomer ? "" : `AND ${scope.sql}`}`, { id: owner, ...(isCustomer ? {} : scope.params) });
  if (!customer) throw new AppError("Customer not found.", 404);
  let addressRow = null;
  if (fulfillment === "delivery") {
    if (!addressId) throw new AppError("Choose a delivery address.", 422);
    [addressRow] = await select("SELECT id FROM customer_addresses WHERE id = :id AND customer_id = :customerId", { id: addressId, customerId: owner });
    if (!addressRow) throw new AppError("That delivery address does not belong to this customer.", 422);
  }

  // ask Inventory again: current price and availability (not what the form or the cart remembered)
  const products = await getProducts({ ids: wanted.map((l) => l.product_id), includeInactive: true, excludeOrderId: orderId });
  const byId = Object.fromEntries(products.map((p) => [p.product_id, p]));
  const issues = [];
  for (const l of wanted) {
    const p = byId[l.product_id];
    if (!p || p.status !== "active") { issues.push({ product_id: l.product_id, kind: "unavailable", message: `${p ? p.name : l.product_id} is not sold any more` }); continue; }
    l.quantity = parseQty(l.quantity, p.unit);
    if (l.expected_price !== null && l.expected_price !== undefined && cents(l.expected_price) !== cents(p.selling_price)) {
      issues.push({ product_id: p.product_id, kind: "price", message: `the price of ${p.name} changed from ₱${Number(l.expected_price).toFixed(2)} to ₱${p.selling_price.toFixed(2)}`, current_price: p.selling_price });
    }
    if (p.available_qty < l.quantity) {
      issues.push({ product_id: p.product_id, kind: "stock", message: p.available_qty <= 0 ? `${p.name} is out of stock` : `only ${p.available_qty} ${p.unit} of ${p.name} are available (you asked for ${l.quantity})`, available: p.available_qty });
    }
  }
  if (issues.length) throw conflict(issues);

  // price the order from Inventory's prices
  const items = wanted.map((l, i) => {
    const p = byId[l.product_id];
    return { line_no: i + 1, product_id: p.product_id, sku: p.sku, name: p.name, unit: p.unit, category_name: p.category_name, is_vatable: p.is_vatable, quantity: l.quantity, unit_price: p.selling_price, gross: Math.round(cents(p.selling_price) * l.quantity) };
  });
  const subtotal = items.reduce((s, it) => s + it.gross, 0);
  // promotion and payment are checked now (so a bad code never reserves stock) and again inside the saving transaction (usage limits, duplicate references)
  const priceIt = async (transaction) => {
    const promo = promoCode ? await promotionFor(promoCode, items, subtotal, owner, transaction) : null;
    const promoOff = promo ? promo.total : 0;
    // loyalty (P8): 100 points = PHP 10 off, never more than what is left after the promotion
    const loyaltyOff = await checkRedemption({ customerId: owner, points: loyaltyPoints, payableCents: subtotal - promoOff, transaction });
    const discount = promoOff + loyaltyOff;
    const grand = subtotal - discount;
    const pay = checkPayment(payment, fromCents(grand));
    if (pay && isCustomer && pay.method === "cash") throw new AppError("Cash is paid to our staff. Choose Cash on Delivery, GCash or Maya.", 422);
    if (pay && REFERENCE_METHODS.includes(pay.method) && (await referenceTaken(pay.method, pay.reference, transaction))) throw new AppError("That payment reference number was already used. Check the number and try again.", 422);
    return { promo, loyaltyOff, discount, grand, pay };
  };
  await priceIt();

  // who handles it
  let agentId = null;
  let teamId = null;
  if (!isCustomer && user.role === "agent") { agentId = user.id; teamId = user.team_id || null; }
  else {
    const [asg] = await select("SELECT ag.id, ag.team_id FROM agent_assignments aa JOIN crm_users ag ON ag.id = aa.agent_id WHERE aa.customer_id = :id AND aa.ended_at IS NULL ORDER BY aa.id DESC LIMIT 1", { id: owner });
    if (asg) { agentId = asg.id; teamId = asg.team_id; } else if (user.role === "team_leader") teamId = user.team_id || null;
  }

  // ---- B. reserve through Inventory
  const key = `reserve:${orderId}`;
  const correlationId = crypto.randomUUID();
  const reserveLines = wanted.map((l) => ({ product_id: l.product_id, quantity: l.quantity }));
  let reservation;
  try {
    reservation = await reserveStock({ key, orderId, correlationId, lines: reserveLines });
  } catch (err) {
    if (err instanceof ReservationUnknownError) await queueCompensation({ kind: "resolve_reservation", orderId, correlationId, lines: reserveLines, reason: `no answer to the reservation call (${err.detail})` });
    throw err;
  }
  if (reservation.status !== "reserved") {
    if (reservation.reservation_ref) await releaseOrQueue({ orderId, reservationRef: reservation.reservation_ref, correlationId, reason: "partial reservation refused" });
    // Inventory dialect: a conflict (or any other refusal) means CRM cannot know what Inventory holds under this order reference; as no
    // order is saved, a clean-up task releases it (order.cancelled). Reservations there never expire. Staff see it on Integration Health.
    if (reservation.kind === "conflict" || reservation.kind === "refused") {
      await queueCompensation({ kind: "release_reservation", orderId, reservationRef: `INV-ORDER:${orderId}`, correlationId, reason: `Inventory answered ${reservation.code} to order.confirmed` });
      throw new AppError("The order was not placed: the stock reservation for this order was refused by Inventory. Nothing was charged. Please try again in a moment, or contact us if it happens again.", 409);
    }
    throw conflict(reservation.lines.filter((a) => !a.ok).map((a) => ({ product_id: a.product_id, kind: reservation.kind === "unavailable" ? "unavailable" : "stock", message: `${byId[a.product_id]?.name || a.name || "A product in your order"}${String(a.reason).startsWith("is ") ? " " : ": "}${a.reason}` })));
  }

  // ---- C. save in one transaction; give the reservation back if that fails
  let result;
  try {
    result = await sequelize.transaction(async (transaction) => {
      const [again] = await select("SELECT id, order_no FROM sales_orders WHERE order_id = :orderId", { orderId }, transaction);
      if (again) return { id: again.id, order_no: again.order_no, duplicate: true };
      const { promo, loyaltyOff, discount, grand, pay } = await priceIt(transaction);
      const loyaltyPer = spread(loyaltyOff, items.map((it, i) => it.gross - (promo ? promo.per[i] : 0)));
      const now = at || new Date();
      const orderNo = await nextDailyNumber("order", now, transaction);
      const [id] = await sequelize.query(
        `INSERT INTO sales_orders (order_id, order_no, customer_id, agent_id, team_id, channel, fulfillment, delivery_address_id, status, payment_status, reservation_status,
                                   inventory_reservation_ref, subtotal, discount_total, grand_total, currency, correlation_id, submitted_at, confirmed_at, created_by, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'unpaid', 'reserved', ?, ?, ?, ?, 'PHP', ?, ?, ?, ?, ?, ?, ?)`,
        { replacements: [orderId, orderNo, owner, agentId, teamId, chan, fulfillment, addressRow ? addressRow.id : null, reservation.reservation_ref, fromCents(subtotal), fromCents(discount), fromCents(grand), correlationId, now, now, user.id, isDemo ? 1 : 0, now, now], transaction }
      );
      for (const [i, it] of items.entries()) {
        const promoDisc = promo ? promo.per[i] : 0;
        const disc = promoDisc + loyaltyPer[i];
        await exec(
          `INSERT INTO sales_order_items (sales_order_id, line_no, product_id, sku, product_name, unit, quantity, unit_price, is_vatable, promotion_id, discount_amount, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, it.line_no, it.product_id, it.sku, it.name, it.unit, it.quantity, it.unit_price, it.is_vatable, promo && promoDisc > 0 ? promo.promo.id : null, fromCents(disc), fromCents(it.gross - disc)], transaction);
      }
      if (loyaltyOff > 0) await redeemOnOrder({ customerId: owner, orderRowId: id, orderNo, points: Number(loyaltyPoints), userId: user.id, at: now, transaction });
      if (promo) await exec("INSERT INTO promotion_redemptions (promotion_id, sales_order_id, customer_id, discount_amount, redeemed_at) VALUES (?, ?, ?, ?, ?)", [promo.promo.id, id, owner, fromCents(discount), now], transaction);
      let paymentStatus = "unpaid";
      if (pay) {
        // Cash counted at the counter is verified on the spot; COD (reference entered on collection), GCash and Maya wait for a staff check.
        await exec("INSERT INTO payment_references (sales_order_id, method, reference_no, amount, paid_at, status, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, pay.method, pay.reference, fromCents(grand), now, pay.method === "cash" ? "verified" : "recorded", user.id, now], transaction);
        paymentStatus = await refreshPaymentStatus(id, transaction);
      }
      if (cartId) await exec("UPDATE cart_records SET status = 'checked_out', checked_out_order_id = ? WHERE id = ?", [id, cartId], transaction);
      await publishEvent({
        type: "OrderConfirmed", entityId: orderId, correlationId, idempotencyKey: `OrderConfirmed:${orderId}`, at: now, isDemo, transaction,
        data: {
          order_id: orderId, order_no: orderNo, customer_id: customer.customer_uuid, channel: chan, fulfillment, reservation_id: reservation.reservation_ref, currency: "PHP",
          items: items.map((it) => ({ line_no: it.line_no, product_id: it.product_id, sku: it.sku, quantity: it.quantity, unit_price: dec(it.unit_price), is_vatable: Boolean(it.is_vatable) })),
          totals: { subtotal: dec(fromCents(subtotal)), discount_total: dec(fromCents(discount)), grand_total: dec(fromCents(grand)) },
        },
      });
      return { id, order_no: orderNo, order_id: orderId, grand_total: fromCents(grand), customerId: owner, agentId, duplicate: false, promoCode: promo ? promo.promo.promo_code : null, loyaltyPoints: loyaltyOff > 0 ? Number(loyaltyPoints) : 0, paymentStatus };
    });
  } catch (err) {
    // A concurrent request with the same order id may have saved the order: then the reservation is in use and must stay.
    const [saved] = await select("SELECT id, order_no FROM sales_orders WHERE order_id = :orderId", { orderId });
    if (saved) return { id: saved.id, order_no: saved.order_no, duplicate: true };
    await releaseOrQueue({ orderId, reservationRef: reservation.reservation_ref, correlationId, reason: `the order could not be saved: ${err.message}` });
    throw err;
  }
  await settleReservation({ orderId });

  if (!result.duplicate && !at) await notifyNewOrder(result, user);
  return result;
};

const customerUserId = async (customerId, transaction) => {
  const [row] = await select("SELECT user_id FROM customer_accounts WHERE customer_id = :customerId AND status = 'active'", { customerId }, transaction);
  return row ? row.user_id : null;
};

const notifyNewOrder = async (o, user) => {
  const link = (role) => (role === "customer" ? `/portal/orders/${o.id}` : `/crm/sales/orders/${o.id}`);
  if (user.role === "customer") {
    await notify(o.agentId ? [o.agentId, ...(await userIdsByRole("team_leader"))] : await userIdsByRole("team_leader", "crm_manager"), { type: "order", title: `New order ${o.order_no}`, message: `₱${o.grand_total.toFixed(2)} from ${user.name}`, link: link("staff"), relatedType: "order", relatedId: o.id });
  } else {
    await notify(await customerUserId(o.customerId), { type: "order", title: `Your order ${o.order_no} is confirmed`, message: `Total ₱${o.grand_total.toFixed(2)}`, link: link("customer"), relatedType: "order", relatedId: o.id });
  }
};

// Checkout of the portal cart. A price change refuses the order and refreshes the cart's remembered prices so the
// customer can review and confirm again.
export const checkoutCart = async ({ user, fulfillment, addressId, promoCode, loyaltyPoints = 0, payment, requestKey }) => {
  if (isUuid(requestKey)) { // a double-click or a refresh replays the same form: answer with the order that already exists
    const [dup] = await select("SELECT id, order_no, customer_id FROM sales_orders WHERE order_id = :orderId", { orderId: requestKey.toLowerCase() });
    if (dup) {
      if (Number(dup.customer_id) !== Number(user.customer_id)) throw new AppError("This order request belongs to another customer.", 409);
      return { id: dup.id, order_no: dup.order_no, duplicate: true };
    }
  }
  const cart = await getCart(user);
  if (!cart.cart || !cart.items.length) throw new AppError("Your cart is empty.", 422);
  try {
    return await placeOrder({
      user, fulfillment, addressId, promoCode, loyaltyPoints, payment, requestKey, cartId: cart.cart.id,
      lines: cart.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity, expected_price: i.price_shown })),
    });
  } catch (err) {
    if (err.issues?.some((i) => i.kind === "price")) {
      await acceptCartPrices({ user });
      err.message += " Your cart now shows the current prices; review it and place the order again.";
    }
    throw err;
  }
};

// ---------------------------------------------------------------- payments

const lockOrder = async (id, user, transaction) => {
  const scope = orderScope(user);
  const [row] = await select(`SELECT o.* FROM sales_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = :id AND ${scope.sql} FOR UPDATE`, { id, ...scope.params }, transaction);
  if (!row) throw new AppError("Order not found.", 404);
  return row;
};

const refreshPaymentStatus = async (orderId, transaction) => {
  const [o] = await select("SELECT grand_total, payment_status FROM sales_orders WHERE id = :id", { id: orderId }, transaction);
  if (["partially_refunded", "refunded"].includes(o.payment_status)) return o.payment_status;
  const [{ v }] = await select("SELECT COALESCE(SUM(amount), 0) AS v FROM payment_references WHERE sales_order_id = :id AND status = 'verified'", { id: orderId }, transaction);
  const next = cents(v) >= cents(o.grand_total) && cents(o.grand_total) > 0 ? "paid" : cents(v) > 0 ? "partially_paid" : "unpaid";
  await exec("UPDATE sales_orders SET payment_status = ? WHERE id = ?", [next, orderId], transaction);
  return next;
};

export const recordPayment = async ({ orderId, user, method, reference = "", amount, at = null }) => {
  const out = await sequelize.transaction(async (transaction) => {
    const order = await lockOrder(orderId, user, transaction);
    const isCustomer = user.role === "customer";
    if (isCustomer && !REFERENCE_METHODS.includes(method)) throw new AppError("You can record a GCash or Maya payment here. Cash is paid to our staff.", 422);
    if (!PAYMENT_METHOD_LABELS[method]) throw new AppError("Choose a payment method.", 422);
    if (!["confirmed", "ready"].includes(order.status)) throw new AppError(`A payment cannot be recorded on a ${ORDER_STATUS_LABELS[order.status].toLowerCase()} order.`, 422);
    const ref = String(reference || "").trim();
    if (REFERENCE_METHODS.includes(method) && !/^[A-Za-z0-9-]{6,30}$/.test(ref)) throw new AppError(`Enter the ${PAYMENT_METHOD_LABELS[method]} reference number (6 to 30 letters, numbers or dashes).`, 422);
    if (method === "cod" && !/^[A-Za-z0-9-]{3,30}$/.test(ref)) throw new AppError("Enter the delivery receipt number for the cash collected (3 to 30 letters, numbers or dashes).", 422);
    if (method === "cash" && ref && !/^[A-Za-z0-9-]{2,30}$/.test(ref)) throw new AppError("The receipt number can have letters, numbers and dashes only.", 422);
    const [cod] = method === "cod" ? await select("SELECT id, amount FROM payment_references WHERE sales_order_id = :id AND method = 'cod' AND reference_no IS NULL AND status = 'recorded' LIMIT 1", { id: orderId }, transaction) : [];
    const [{ c }] = await select("SELECT COALESCE(SUM(amount), 0) AS c FROM payment_references WHERE sales_order_id = :id AND status IN ('recorded','verified') AND NOT (method = 'cod' AND reference_no IS NULL)", { id: orderId }, transaction);
    const outstanding = cents(order.grand_total) - cents(c);
    const pay = cents(amount);
    if (!(pay > 0)) throw new AppError("Enter the amount received.", 422);
    if (outstanding <= 0) throw new AppError("This order is already fully paid or has enough payments recorded.", 422);
    if (pay > outstanding) throw new AppError(`The amount is more than what is still due (₱${fromCents(outstanding).toFixed(2)}).`, 422);
    if (method !== "cod" && (await referenceTaken(method, ref, transaction))) throw new AppError("That payment reference number was already used on another payment.", 422);
    if (method === "cod" && ref && (await referenceTaken("cod", ref, transaction))) throw new AppError("That receipt number was already used on another payment.", 422);
    const now = at || new Date();
    const status = method === "cash" ? "verified" : "recorded"; // cash is counted at the counter; the rest need a staff check of the reference
    let paymentId;
    if (cod) {
      await exec("UPDATE payment_references SET reference_no = ?, amount = ?, paid_at = ?, status = ?, recorded_by = ? WHERE id = ?", [ref, fromCents(pay), now, status, user.id, cod.id], transaction);
      paymentId = cod.id;
    } else {
      [paymentId] = await sequelize.query("INSERT INTO payment_references (sales_order_id, method, reference_no, amount, paid_at, status, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", { replacements: [orderId, method, ref || null, fromCents(pay), now, status, user.id, now], transaction });
    }
    if (method !== "cod") await exec("UPDATE payment_references SET status = 'voided', void_reason = 'The customer paid another way' WHERE sales_order_id = ? AND method = 'cod' AND reference_no IS NULL AND status = 'recorded'", [orderId], transaction);
    const paymentStatus = await refreshPaymentStatus(orderId, transaction);
    return { order, paymentId, status, paymentStatus, method, amount: fromCents(pay) };
  });
  if (!at && out.status === "verified") await notify(await customerUserId(out.order.customer_id), { type: "order", title: `Payment received for ${out.order.order_no}`, message: `₱${out.amount.toFixed(2)}`, link: `/portal/orders/${out.order.id}`, relatedType: "order", relatedId: out.order.id });
  if (!at && user.role === "customer") await notify(out.order.agent_id ? [out.order.agent_id] : await userIdsByRole("team_leader", "crm_manager"), { type: "order", title: `Payment reference to verify for ${out.order.order_no}`, message: `${PAYMENT_METHOD_LABELS[method]} ₱${out.amount.toFixed(2)}`, link: `/crm/sales/orders/${out.order.id}`, relatedType: "order", relatedId: out.order.id });
  return out;
};

// Staff check the reference against the e-wallet / delivery receipt. Never the person who recorded it.
export const verifyPayment = async ({ paymentId, user }) => {
  const out = await sequelize.transaction(async (transaction) => {
    if (user.role === "customer") throw new AppError("Only staff can verify payments.", 403);
    const [p] = await select("SELECT p.*, u.role AS recorder_role FROM payment_references p LEFT JOIN crm_users u ON u.id = p.recorded_by WHERE p.id = :id FOR UPDATE", { id: paymentId }, transaction);
    if (!p) throw new AppError("Payment not found.", 404);
    const order = await lockOrder(p.sales_order_id, user, transaction);
    if (p.status !== "recorded") throw new AppError(`This payment is already ${p.status}.`, 422);
    if (order.status === "cancelled") throw new AppError("The order is cancelled.", 422);
    if (p.method === "cod" && !p.reference_no) throw new AppError("Record the cash collected on delivery (with the receipt number) before verifying.", 422);
    if (p.recorded_by && Number(p.recorded_by) === Number(user.id)) throw new AppError("You recorded this payment, so someone else must verify it.", 403);
    await exec("UPDATE payment_references SET status = 'verified' WHERE id = ?", [paymentId], transaction);
    const paymentStatus = await refreshPaymentStatus(order.id, transaction);
    return { order, payment: p, paymentStatus };
  });
  await notify(await customerUserId(out.order.customer_id), { type: "order", title: `Your payment for ${out.order.order_no} was verified`, link: `/portal/orders/${out.order.id}`, relatedType: "order", relatedId: out.order.id });
  return out;
};

export const voidPayment = ({ paymentId, user, reason }) =>
  sequelize.transaction(async (transaction) => {
    if (user.role === "customer") throw new AppError("Only staff can void payments.", 403);
    const [p] = await select("SELECT * FROM payment_references WHERE id = :id FOR UPDATE", { id: paymentId }, transaction);
    if (!p) throw new AppError("Payment not found.", 404);
    const order = await lockOrder(p.sales_order_id, user, transaction);
    if (p.status !== "recorded") throw new AppError(p.status === "verified" ? "A verified payment cannot be voided; refund the sale instead." : `This payment is already ${p.status}.`, 422);
    if (String(reason || "").trim().length < MIN_REASON_LENGTH) throw new AppError(`Give a reason for voiding (at least ${MIN_REASON_LENGTH} characters).`, 422);
    await exec("UPDATE payment_references SET status = 'voided', void_reason = ? WHERE id = ?", [String(reason).trim(), paymentId], transaction);
    await refreshPaymentStatus(order.id, transaction);
    return { order, payment: p };
  });

// ---------------------------------------------------------------- ready, complete (sale), cancel

export const markReady = ({ orderId, user }) =>
  sequelize.transaction(async (transaction) => {
    if (user.role === "customer") throw new AppError("Only staff can do this.", 403);
    const order = await lockOrder(orderId, user, transaction);
    if (order.status !== "confirmed") throw new AppError(`Only a confirmed order can be marked ready (this one is ${ORDER_STATUS_LABELS[order.status].toLowerCase()}).`, 422);
    await exec("UPDATE sales_orders SET status = 'ready' WHERE id = ?", [orderId], transaction);
    return order;
  });

// Completes the order: ONE sale row and ONE SaleCompleted event per order, however many times it is requested.
export const completeOrder = async ({ orderId, user, at = null }) => {
  const out = await sequelize.transaction(async (transaction) => {
    if (user.role === "customer") throw new AppError("Only staff can complete a sale.", 403);
    const order = await lockOrder(orderId, user, transaction);
    const [existing] = await select("SELECT id, sale_id, transaction_no FROM sales_transactions WHERE sales_order_id = :id", { id: orderId }, transaction);
    if (existing) return { order, sale: existing, duplicate: true };
    if (!["confirmed", "ready"].includes(order.status)) throw new AppError(`A ${ORDER_STATUS_LABELS[order.status].toLowerCase()} order cannot be completed.`, 422);
    if (order.reservation_status !== "reserved") throw new AppError("Stock is not reserved for this order.", 422);
    if (order.payment_status !== "paid") throw new AppError("Verify the payment in full before completing the sale.", 422);
    const now = at || new Date();
    const saleUuid = crypto.randomUUID();
    const txnNo = await nextDailyNumber("sale", now, transaction);
    const key = `SaleCompleted:${saleUuid}`;
    const [saleId] = await sequelize.query(
      `INSERT INTO sales_transactions (sale_id, transaction_no, sales_order_id, customer_id, gross_amount, discount_total, tax_total, net_amount, currency, payment_status, status, completed_at,
                                       correlation_id, idempotency_key, is_demo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'PHP', 'paid', 'completed', ?, ?, ?, ?, ?)`,
      { replacements: [saleUuid, txnNo, orderId, order.customer_id, order.subtotal, order.discount_total, order.grand_total, now, order.correlation_id, key, order.is_demo, now], transaction }
    );
    const issued = await issueStock({ key: `issue:${order.order_id}`, orderId: order.order_id, reservationRef: order.inventory_reservation_ref, correlationId: order.correlation_id });
    // mock: the (local) Inventory consumed the reservation. live: Inventory consumes it when it receives SaleCompleted and answers with
    // StockIssued, which moves the order to `issued`; until then the order shows `reserved`.
    await exec("UPDATE sales_orders SET status = 'completed', completed_at = ?, reservation_status = ? WHERE id = ?", [now, issued.status === "issued" ? "issued" : "reserved", orderId], transaction);
    const items = await select("SELECT line_no, product_id, sku, quantity, unit_price, is_vatable, discount_amount, line_total FROM sales_order_items WHERE sales_order_id = :id ORDER BY line_no", { id: orderId }, transaction);
    const pays = await select("SELECT method, reference_no, amount, paid_at FROM payment_references WHERE sales_order_id = :id AND status = 'verified' ORDER BY id", { id: orderId }, transaction);
    const discounts = await select("SELECT p.promo_code, p.promo_type, r.discount_amount FROM promotion_redemptions r JOIN promotions p ON p.id = r.promotion_id WHERE r.sales_order_id = :id", { id: orderId }, transaction);
    const loyaltyUsed = await redemptionOf(orderId, transaction);
    if (loyaltyUsed && loyaltyUsed.status === "applied") discounts.push({ promo_code: "LOYALTY", promo_type: "loyalty_points", discount_amount: loyaltyUsed.amount });
    const earned = await earnForSale({ customerId: order.customer_id, saleRowId: saleId, transactionNo: txnNo, netAmount: order.grand_total, userId: user.id, at: now, transaction });
    const [cust] = await select("SELECT customer_id AS uuid FROM customers WHERE id = :id", { id: order.customer_id }, transaction);
    await publishEvent({
      type: "SaleCompleted", entityId: saleUuid, correlationId: order.correlation_id, idempotencyKey: key, at: now, transaction,
      data: {
        sale_id: saleUuid, order_id: order.order_id, transaction_no: txnNo, customer_id: cust.uuid, completed_at: isoWithOffset(now),
        items: items.map((i) => ({ line_no: i.line_no, product_id: i.product_id, sku: i.sku, quantity: Number(i.quantity), unit_price: dec(i.unit_price), discount_amount: dec(i.discount_amount), line_total: dec(i.line_total), is_vatable: Boolean(i.is_vatable) })),
        discounts: discounts.map((d) => ({ code: d.promo_code, type: d.promo_type, amount: dec(d.discount_amount) })),
        totals: { gross: dec(order.subtotal), discount_total: dec(order.discount_total), net: dec(order.grand_total) },
        payments: pays.map((p) => ({ method: p.method, reference_no: p.reference_no, amount: dec(p.amount), paid_at: isoWithOffset(new Date(p.paid_at)) })),
        payment_status: "paid", currency: "PHP",
      },
    });
    return { order, sale: { id: saleId, sale_id: saleUuid, transaction_no: txnNo }, duplicate: false, earned };
  });
  if (!at && !out.duplicate) await notify(await customerUserId(out.order.customer_id), { type: "order", title: `Your order ${out.order.order_no} is complete`, message: `Sale ${out.sale.transaction_no}. Thank you!`, link: `/portal/orders/${out.order.id}`, relatedType: "order", relatedId: out.order.id });
  return out;
};

// Cancels an order that has no verified payment: stock goes back to Inventory (idempotent release), SaleCancelled is published once.
export const cancelOrder = async ({ orderId, user, reason, at = null }) => {
  const out = await sequelize.transaction(async (transaction) => {
    const order = await lockOrder(orderId, user, transaction);
    const text = String(reason || "").trim() || (user.role === "customer" ? "Cancelled by the customer" : "");
    if (!["confirmed", "ready"].includes(order.status)) throw new AppError(`A ${ORDER_STATUS_LABELS[order.status].toLowerCase()} order cannot be cancelled.${order.status === "completed" ? " Request a refund instead." : ""}`, 422);
    if (user.role === "customer" && order.status !== "confirmed") throw new AppError("This order is already being prepared. Please contact us to cancel it.", 422);
    if (text.length < MIN_REASON_LENGTH) throw new AppError(`Give a reason for cancelling (at least ${MIN_REASON_LENGTH} characters).`, 422);
    const [{ v }] = await select("SELECT COUNT(*) AS v FROM payment_references WHERE sales_order_id = :id AND status = 'verified'", { id: orderId }, transaction);
    if (Number(v) > 0) throw new AppError("This order has a verified payment. Complete the sale and refund it instead.", 422);
    const now = at || new Date();
    await exec("UPDATE payment_references SET status = 'voided', void_reason = 'Order cancelled' WHERE sales_order_id = ? AND status = 'recorded'", [orderId], transaction);
    await exec("UPDATE sales_orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, reservation_status = 'released', payment_status = 'unpaid' WHERE id = ?", [now, text.slice(0, 255), orderId], transaction);
    await returnRedemption({ orderRowId: orderId, orderNo: order.order_no, userId: user.id, at: now, transaction });
    const releaseItems = await select("SELECT product_id, quantity FROM sales_order_items WHERE sales_order_id = :id ORDER BY line_no", { id: orderId }, transaction);
    await publishEvent({
      type: "SaleCancelled", entityId: order.order_id, correlationId: order.correlation_id, idempotencyKey: `SaleCancelled:${order.order_id}`, at: now, transaction,
      data: {
        order_id: order.order_id, sale_id: null, reason: text.slice(0, 255), cancelled_at: isoWithOffset(now),
        release_items: releaseItems.map((i) => ({ product_id: i.product_id, quantity: Number(i.quantity) })),
      },
    });
    return { order, reason: text };
  });
  // Give the stock back right away through Inventory (idempotent). If that call fails the cancellation stands: a compensation keeps
  // retrying, and the SaleCancelled event also tells Inventory to release.
  await releaseOrQueue({ orderId: out.order.order_id, reservationRef: out.order.inventory_reservation_ref, correlationId: out.order.correlation_id, reason: "order cancelled" });
  if (!at && user.role !== "customer") await notify(await customerUserId(out.order.customer_id), { type: "order", title: `Your order ${out.order.order_no} was cancelled`, message: out.reason, link: `/portal/orders/${out.order.id}`, relatedType: "order", relatedId: out.order.id });
  return out;
};

// ---------------------------------------------------------------- payments list, dashboards

export const listPayments = async (user, { q, status, method, limit, offset }) => {
  const scope = orderScope(user);
  const where = [scope.sql];
  const params = { ...scope.params };
  if (q) { where.push("(o.order_no LIKE :q OR p.reference_no LIKE :q OR c.customer_no LIKE :q OR CONCAT(c.first_name, ' ', c.last_name) LIKE :q)"); params.q = `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`; }
  if (status) { where.push("p.status = :status"); params.status = status; }
  if (method) { where.push("p.method = :method"); params.method = method; }
  const from = `FROM payment_references p JOIN sales_orders o ON o.id = p.sales_order_id JOIN customers c ON c.id = o.customer_id LEFT JOIN crm_users u ON u.id = p.recorded_by WHERE ${where.join(" AND ")}`;
  const [{ total }] = await select(`SELECT COUNT(*) AS total ${from}`, params);
  const rows = await select(
    `SELECT p.id, p.method, p.reference_no, p.amount, p.paid_at, p.status, p.recorded_by, u.display_name AS recorded_by_name, o.id AS order_id, o.order_no, o.status AS order_status,
            c.customer_no, CONCAT(c.first_name, ' ', c.last_name) AS customer_name, o.is_demo
     ${from} ORDER BY FIELD(p.status, 'recorded', 'verified', 'voided'), p.paid_at DESC, p.id DESC LIMIT :limit OFFSET :offset`, { ...params, limit, offset });
  return { total: Number(total), rows: rows.map((r) => ({ ...r, amount: Number(r.amount) })) };
};

export const salesSummary = async (user) => {
  const scope = orderScope(user);
  const [row] = await select(
    `SELECT COALESCE(SUM(o.status IN ('confirmed','ready')), 0) AS in_progress,
            COALESCE(SUM(o.status IN ('confirmed','ready') AND o.payment_status IN ('unpaid','partially_paid')), 0) AS awaiting_payment,
            COALESCE(SUM(o.status = 'completed'), 0) AS completed,
            COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.grand_total ELSE 0 END), 0) AS sales_total,
            COALESCE(SUM(DATE(o.created_at) = CURDATE()), 0) AS today_orders,
            COALESCE(SUM(CASE WHEN o.status = 'completed' AND DATE(o.completed_at) = CURDATE() THEN o.grand_total ELSE 0 END), 0) AS today_sales
     ${FROM} WHERE ${scope.sql}`, scope.params);
  const unverified = await select(`SELECT COUNT(*) AS n FROM payment_references p JOIN sales_orders o ON o.id = p.sales_order_id JOIN customers c ON c.id = o.customer_id WHERE p.status = 'recorded' AND p.reference_no IS NOT NULL AND ${scope.sql}`, scope.params);
  return {
    in_progress: Number(row.in_progress), awaiting_payment: Number(row.awaiting_payment), completed: Number(row.completed), sales_total: Number(row.sales_total),
    today_orders: Number(row.today_orders), today_sales: Number(row.today_sales), to_verify: Number(unverified[0].n),
  };
};

// Completed sales per day for the last N days and the best-selling products (units), from real order rows.
export const salesTrend = async (user, days = 14) => {
  const scope = orderScope(user);
  const rows = await select(
    `SELECT DATE(s.completed_at) AS d, SUM(s.net_amount) AS total FROM sales_transactions s JOIN sales_orders o ON o.id = s.sales_order_id JOIN customers c ON c.id = o.customer_id
     WHERE s.status <> 'voided' AND s.completed_at >= CURDATE() - INTERVAL :days DAY AND ${scope.sql} GROUP BY DATE(s.completed_at)`, { ...scope.params, days: days - 1 });
  return rows;
};

export const topProducts = async (user, limit = 5) => {
  const scope = orderScope(user);
  return select(
    `SELECT i.product_name AS label, SUM(i.quantity) AS value FROM sales_order_items i JOIN sales_orders o ON o.id = i.sales_order_id JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'completed' AND ${scope.sql} GROUP BY i.product_id, i.product_name ORDER BY value DESC LIMIT :limit`, { ...scope.params, limit });
};

export const recentOrdersForCustomer = async (customerId, user, limit = 10) => {
  const scope = orderScope(user);
  const rows = await select(`SELECT ${COLUMNS} ${FROM} WHERE o.customer_id = :customerId AND ${scope.sql} ORDER BY o.created_at DESC LIMIT :limit`, { ...scope.params, customerId, limit });
  return rows.map(shape);
};

export const addressesOf = (customerId) => select("SELECT id, label, line1, barangay, city_municipality, is_default FROM customer_addresses WHERE customer_id = :customerId ORDER BY is_default DESC, id", { customerId });
