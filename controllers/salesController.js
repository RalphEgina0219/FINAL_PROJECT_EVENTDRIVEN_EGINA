// Sales: staff pages (/crm/sales: orders, payments, refunds, new order) and the customer's shop, cart, orders and tracking.
// Rules, record scope and Inventory checks live in services/orderService.js, refundService.js and the Inventory adapter;
// they are checked again on every request, not only by hiding buttons.
import { customerLoyalty, RULES_TEXT } from "../services/loyaltyService.js";
import crypto from "crypto";
import {
  listOrders, findOrder, listPayments, listCatalog, placeOrder, recordPayment, verifyPayment, voidPayment, markReady, completeOrder, cancelOrder, trackingSteps,
  getCart, addToCart, setCartQuantity, removeFromCart, checkoutCart, addressesOf, salesSummary,
  ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS, CHANNEL_LABELS, FULFILLMENT_LABELS, PAYMENT_METHOD_LABELS, PAYMENT_RECORD_STATUS_LABELS, STAFF_CHANNELS,
} from "../services/orderService.js";
import { listRefunds, findRefund, refundCounts, refundableOn, requestRefund, decideRefund, recordRefund, REFUND_STATUS_LABELS, ITEM_CONDITIONS } from "../services/refundService.js";
import { syncProducts, inventoryMode, isMockInventory } from "../services/integration/inventoryAdapter.js";
import { isInventoryDialect, pollInventoryOutbox } from "../services/integration/inventoryDialect.js";
import { activePromotions } from "../services/marketingService.js";
import { pickableCustomers, findCustomerForUser } from "../services/customerMasterService.js";
import { audit } from "../services/auditService.js";
import { can } from "../services/permissionService.js";
import { buildPagination } from "../helpers/pagination.js";
import { clean, toId, toPage, oneOf } from "../helpers/validators.js";
import { AppError } from "../helpers/errors.js";
import { SALES_TABS, PORTAL_TABS } from "../helpers/navigation.js";

const tabs = (list, active) => list.map(([label, href]) => ({ label, href, active: label === active }));
const opts = (labels, selected) => Object.entries(labels).map(([value, label]) => ({ value, label, sel: value === selected }));
const notFound = (res, what = "order") => res.status(404).render("error", { title: `${what[0].toUpperCase()}${what.slice(1)} not found`, status: 404, message: `This ${what} does not exist or is not in your scope.` });
const inventoryNote = () => ({ inventoryMode: inventoryMode(), mockInventory: isMockInventory() });
const sameLines = (catalog, body) => catalog.map((p) => ({ product_id: p.product_id, quantity: body[`qty_${p.product_id}`], expected_price: body[`price_${p.product_id}`] === undefined || body[`price_${p.product_id}`] === "" ? null : Number(body[`price_${p.product_id}`]) }))
  .filter((l) => l.quantity !== undefined && String(l.quantity).trim() !== "" && Number(l.quantity) !== 0);

// Runs an action; known problems become a flash message on the order page. Forbidden actions are audited.
const ORDER_PAGE = (id) => `/crm/sales/orders/${id}`;
const action = (name, fn, recordType = "order", back = ORDER_PAGE) => async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return notFound(res, recordType);
  let target = back(id);
  try {
    const out = await fn(req, id);
    if (out && typeof out === "object") { target = out.redirect || target; if (out.text) req.flash("success_msg", out.text); } else if (out) req.flash("success_msg", out);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.status === 404) return notFound(res, recordType);
    if (err.status === 403) {
      await audit(req, "access_denied", { outcome: "denied", recordType, recordId: id, details: `${name}: ${err.message}` });
      return res.status(403).render("error", { title: "Access denied", status: 403, message: err.message });
    }
    req.flash("error_msg", err.message);
  }
  res.redirect(target);
};

const orderLabels = (o) => ({ ...o, status_label: ORDER_STATUS_LABELS[o.status], payment_label: PAYMENT_STATUS_LABELS[o.payment_status], channel_label: CHANNEL_LABELS[o.channel], fulfillment_label: FULFILLMENT_LABELS[o.fulfillment] });

// ---------------------------------------------------------------- staff: orders

export const index = async (req, res) => {
  const filters = {
    q: clean(req.query.q, 80), status: oneOf(req.query.status, Object.keys(ORDER_STATUS_LABELS)) || "", payment: oneOf(req.query.payment, Object.keys(PAYMENT_STATUS_LABELS)) || "",
    channel: oneOf(req.query.channel, Object.keys(CHANNEL_LABELS)) || "", mine: req.query.mine === "1",
  };
  const first = await listOrders(req.user, { ...filters, limit: 1, offset: 0 });
  const pagination = buildPagination({ total: first.total, page: toPage(req.query.page), perPage: 15, basePath: "/crm/sales", query: { q: filters.q, status: filters.status, payment: filters.payment, channel: filters.channel, mine: filters.mine ? "1" : "" } });
  const [{ rows }, summary] = await Promise.all([listOrders(req.user, { ...filters, limit: pagination.limit, offset: pagination.offset }), salesSummary(req.user)]);
  res.render("sales/index", {
    title: req.user.role === "agent" ? "Orders / Sales" : req.user.role === "team_leader" ? "Orders" : "Sales & Orders", areaTabs: tabs(SALES_TABS, "Orders"),
    rows: rows.map(orderLabels), filters, pagination, summary, canCreate: can(req.user, "orders.create"),
    statusOptions: opts(ORDER_STATUS_LABELS, filters.status), paymentOptions: opts(PAYMENT_STATUS_LABELS, filters.payment), channelOptions: opts(CHANNEL_LABELS, filters.channel),
    hasFilters: Boolean(filters.q || filters.status || filters.payment || filters.channel || filters.mine), canSync: can(req.user, "inventory.sync"), ...inventoryNote(),
  });
};

const newModel = async (user, { customerId, form = {}, errors = [], requestKey = null }) => {
  const customers = await pickableCustomers(user);
  let customer = null;
  if (customerId) customer = await findCustomerForUser(customerId, user);
  const { products } = await listCatalog();
  return {
    title: "New order", areaTabs: tabs(SALES_TABS, "New order"), errors, form, customer, customers: customers.map((c) => ({ ...c, sel: c.id === customerId })),
    products: products.map((p) => ({ ...p, qty: form[`qty_${p.product_id}`] || "", out: p.available_qty <= 0 })),
    addresses: customer ? (await addressesOf(customer.id)).map((a) => ({ ...a, sel: String(a.id) === String(form.address_id) })) : [],
    requestKey: requestKey || crypto.randomUUID(), channelOptions: STAFF_CHANNELS.map((v) => ({ value: v, label: CHANNEL_LABELS[v], sel: v === (form.channel || "walk_in") })),
    fulfillmentOptions: opts(FULFILLMENT_LABELS, form.fulfillment || "in_store"),
    paymentOptions: [{ value: "", label: "No payment yet" }, ...Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => ({ value, label, sel: value === form.payment_method }))],
    promos: await activePromotions(), ...inventoryNote(), loyalty: customer ? await customerLoyalty(customer.id, { limit: 0 }) : null, loyaltyRules: RULES_TEXT,
  };
};

export const newForm = async (req, res) => {
  const customerId = toId(req.query.customer_id);
  const customer = customerId ? await findCustomerForUser(customerId, req.user) : null;
  if (customerId && !customer) return notFound(res, "customer");
  res.render("sales/new", await newModel(req.user, { customerId: customer ? customer.id : null }));
};

export const create = async (req, res) => {
  const customerId = toId(req.body.customer_id);
  const form = { ...req.body, customer_id: customerId ? String(customerId) : "" };
  const render = async (status, errors, extra = {}) => { res.status(status); return res.render("sales/new", await newModel(req.user, { customerId, form, errors, requestKey: req.body.request_key, ...extra })); };
  const { products } = await listCatalog();
  const lines = sameLines(products, req.body);
  if (lines.some((l) => !Number.isFinite(Number(l.quantity)))) return render(422, ["Quantities must be numbers."]);
  const method = oneOf(req.body.payment_method, Object.keys(PAYMENT_METHOD_LABELS));
  try {
    const order = await placeOrder({
      user: req.user, customerId, channel: oneOf(req.body.channel, STAFF_CHANNELS), fulfillment: oneOf(req.body.fulfillment, Object.keys(FULFILLMENT_LABELS)), addressId: toId(req.body.address_id),
      lines, promoCode: clean(req.body.promo_code, 30), loyaltyPoints: Number.parseInt(req.body.loyalty_points || "0", 10) || 0, requestKey: clean(req.body.request_key, 40), payment: method ? { method, reference: clean(req.body.payment_reference, 40) } : null,
    });
    if (order.duplicate) { req.flash("info_msg", `This order was already placed (${order.order_no}).`); return res.redirect(`/crm/sales/orders/${order.id}`); }
    await audit(req, "order_created", { recordType: "order", recordId: order.order_no, after: { customer_id: customerId, grand_total: order.grand_total, promo: order.promoCode } });
    req.flash("success_msg", `Order ${order.order_no} was placed and the stock is reserved.`);
    return res.redirect(`/crm/sales/orders/${order.id}`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.status === 403) { await audit(req, "access_denied", { outcome: "denied", recordType: "order", details: `create: ${err.message}` }); return res.status(403).render("error", { title: "Access denied", status: 403, message: err.message }); }
    if (err.status === 409 && err.issues) await audit(req, "order_rejected", { outcome: "denied", recordType: "order", details: err.issues.map((i) => `${i.kind}: ${i.message}`).join("; ").slice(0, 480) });
    return render([404, 409, 503].includes(err.status) ? err.status : 422, [err.message]);
  }
};

export const show = async (req, res) => {
  const id = toId(req.params.id);
  const o = id ? await findOrder(id, req.user) : null;
  if (!o) return notFound(res);
  const open = ["confirmed", "ready"].includes(o.status);
  const refundable = o.sale_row_id ? await refundableOn(o.sale_row_id) : 0;
  res.render("sales/show", {
    title: o.order_no, areaTabs: tabs(SALES_TABS, "Orders"), o: orderLabels(o), tracking: trackingSteps(o), ...inventoryNote(),
    payments: o.payments.map((p) => ({ ...p, method_label: PAYMENT_METHOD_LABELS[p.method], status_label: PAYMENT_RECORD_STATUS_LABELS[p.status], canVerify: p.status === "recorded" && !(p.method === "cod" && !p.reference_no) && Number(p.recorded_by) !== req.user.id && can(req.user, "payments.verify"),
      canVoid: p.status === "recorded", mine: Number(p.recorded_by) === req.user.id, pendingCod: p.method === "cod" && !p.reference_no && p.status === "recorded" })),
    refunds: o.refunds.map((r) => ({ ...r, status_label: REFUND_STATUS_LABELS[r.status] })),
    canPay: open && o.outstanding > 0 && can(req.user, "orders.create"), canReady: o.status === "confirmed" && can(req.user, "orders.create"),
    canComplete: open && o.payment_status === "paid" && can(req.user, "orders.create"), canCancel: open && can(req.user, "orders.create"),
    canRefund: Boolean(o.sale_row_id) && refundable > 0 && can(req.user, "refunds.request"), refundable,
    methodOptions: Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => ({ value, label })), conditionOptions: ITEM_CONDITIONS.map(([value, label]) => ({ value, label })),
    needsVerifyNote: o.payments.some((p) => p.status === "recorded" && p.method !== "cod"),
  });
};

export const pay = action("payment", async (req, id) => {
  const out = await recordPayment({ orderId: id, user: req.user, method: oneOf(req.body.method, Object.keys(PAYMENT_METHOD_LABELS)), reference: clean(req.body.reference, 40), amount: Number(req.body.amount) });
  await audit(req, "payment_recorded", { recordType: "order", recordId: id, after: { method: out.method, amount: out.amount, status: out.status } });
  return out.status === "verified" ? "Cash payment recorded." : "Payment recorded. A different staff member must verify the reference number.";
});
export const verify = action("verify", async (req, id) => {
  const pid = toId(req.params.paymentId);
  if (!pid) throw new AppError("Payment not found.", 404);
  const out = await verifyPayment({ paymentId: pid, user: req.user });
  await audit(req, "payment_verified", { recordType: "payment", recordId: pid, after: { order_id: id, payment_status: out.paymentStatus } });
  return out.paymentStatus === "paid" ? "Payment verified. The order is paid in full." : "Payment verified.";
});
export const voidIt = action("void", async (req, id) => {
  const pid = toId(req.params.paymentId);
  if (!pid) throw new AppError("Payment not found.", 404);
  const reason = clean(req.body.reason, 200);
  await voidPayment({ paymentId: pid, user: req.user, reason });
  await audit(req, "payment_voided", { recordType: "payment", recordId: pid, reason, after: { order_id: id } });
  return "Payment voided.";
});
export const ready = action("ready", async (req, id) => { await markReady({ orderId: id, user: req.user }); await audit(req, "order_ready", { recordType: "order", recordId: id }); return "The order is marked ready."; });
export const complete = action("complete", async (req, id) => {
  const out = await completeOrder({ orderId: id, user: req.user });
  if (!out.duplicate) await audit(req, "sale_completed", { recordType: "order", recordId: id, after: { sale: out.sale.transaction_no } });
  return out.duplicate ? `This sale was already completed (${out.sale.transaction_no}); nothing was sent again.` : `Sale ${out.sale.transaction_no} completed.`;
});
export const cancel = action("cancel", async (req, id) => {
  const reason = clean(req.body.reason, 200);
  await cancelOrder({ orderId: id, user: req.user, reason });
  await audit(req, "order_cancelled", { recordType: "order", recordId: id, reason });
  return "Order cancelled and the stock was released.";
});

export const requestRefundAction = action("refund", async (req, id) => {
  const o = await findOrder(id, req.user);
  if (!o || !o.sale_row_id) throw new AppError("Only a completed sale can be refunded.", 422);
  const items = [];
  for (const it of o.items) {
    const qty = Number(req.body[`ret_qty_${it.product_id}`] || 0);
    if (qty > 0) items.push({ product_id: it.product_id, quantity: qty, condition: req.body[`ret_cond_${it.product_id}`] });
  }
  const out = await requestRefund({ saleRowId: o.sale_row_id, user: req.user, amount: Number(req.body.amount), reason: clean(req.body.reason, 255), returnItems: items, caseNo: clean(req.body.case_no, 30) });
  await audit(req, "refund_requested", { recordType: "refund", recordId: out.refund_no, after: { order: o.order_no, amount: out.amount } });
  return { text: `Refund ${out.refund_no} was requested. A Team Leader or the Manager will decide it.`, redirect: `/crm/sales/refunds/${out.id}` };
});

// ---------------------------------------------------------------- staff: payments and refunds

export const payments = async (req, res) => {
  const filters = { q: clean(req.query.q, 80), status: oneOf(req.query.status, Object.keys(PAYMENT_RECORD_STATUS_LABELS)) || "", method: oneOf(req.query.method, Object.keys(PAYMENT_METHOD_LABELS)) || "" };
  const first = await listPayments(req.user, { ...filters, limit: 1, offset: 0 });
  const pagination = buildPagination({ total: first.total, page: toPage(req.query.page), perPage: 15, basePath: "/crm/sales/payments", query: filters });
  const { rows } = await listPayments(req.user, { ...filters, limit: pagination.limit, offset: pagination.offset });
  res.render("sales/payments", {
    title: "Payments", areaTabs: tabs(SALES_TABS, "Payments"), rows: rows.map((r) => ({ ...r, method_label: PAYMENT_METHOD_LABELS[r.method], status_label: PAYMENT_RECORD_STATUS_LABELS[r.status], pendingCod: r.method === "cod" && !r.reference_no && r.status === "recorded" })),
    filters, pagination, statusOptions: opts(PAYMENT_RECORD_STATUS_LABELS, filters.status), methodOptions: opts(PAYMENT_METHOD_LABELS, filters.method), hasFilters: Boolean(filters.q || filters.status || filters.method),
  });
};

export const refunds = async (req, res) => {
  const filters = { q: clean(req.query.q, 80), status: oneOf(req.query.status, Object.keys(REFUND_STATUS_LABELS)) || "" };
  const first = await listRefunds(req.user, { ...filters, limit: 1, offset: 0 });
  const pagination = buildPagination({ total: first.total, page: toPage(req.query.page), perPage: 15, basePath: "/crm/sales/refunds", query: filters });
  const [{ rows }, counts] = await Promise.all([listRefunds(req.user, { ...filters, limit: pagination.limit, offset: pagination.offset }), refundCounts(req.user)]);
  res.render("sales/refunds", { title: "Refunds", areaTabs: tabs(SALES_TABS, "Refunds"), rows: rows.map((r) => ({ ...r, status_label: REFUND_STATUS_LABELS[r.status] })), filters, pagination, counts, statusOptions: opts(REFUND_STATUS_LABELS, filters.status), hasFilters: Boolean(filters.q || filters.status) });
};

export const refundShow = async (req, res) => {
  const id = toId(req.params.id);
  const r = id ? await findRefund(id, req.user) : null;
  if (!r) return notFound(res, "refund");
  const decider = ["team_leader", "crm_manager"].includes(req.user.role);
  res.render("sales/refund_show", {
    title: r.refund_no, areaTabs: tabs(SALES_TABS, "Refunds"), r: { ...r, status_label: REFUND_STATUS_LABELS[r.status] }, items: r.items.map((i) => ({ ...i, condition_label: (ITEM_CONDITIONS.find(([k]) => k === i.condition) || [])[1] })),
    canDecide: decider && r.status === "requested" && Number(r.requested_by) !== req.user.id, ownRequest: r.status === "requested" && Number(r.requested_by) === req.user.id,
    canRecord: decider && r.status === "approved",
  });
};

export const refundDecide = action("refund decision", async (req, id) => {
  const decision = oneOf(req.body.decision, ["approve", "reject"]);
  const out = await decideRefund({ id, user: req.user, decision, reason: clean(req.body.reason, 255) });
  await audit(req, decision === "approve" ? "refund_approved" : "refund_rejected", { recordType: "refund", recordId: out.refund.refund_no, reason: clean(req.body.reason, 255) || null, after: { requested_by: out.refund.requested_by } });
  return { text: decision === "approve" ? "Refund approved. Record it once the money is returned." : "Refund rejected.", redirect: `/crm/sales/refunds/${id}` };
}, "refund", (id) => `/crm/sales/refunds/${id}`);
export const refundRecord = action("refund record", async (req, id) => {
  const out = await recordRefund({ id, user: req.user });
  await audit(req, "refund_recorded", { recordType: "refund", recordId: out.refund.refund_no, after: { full_refund: out.full } });
  return { text: out.full ? "Refund recorded. The sale is fully refunded." : "Refund recorded.", redirect: `/crm/sales/refunds/${id}` };
}, "refund", (id) => `/crm/sales/refunds/${id}`);

export const syncCatalog = async (req, res) => {
  const n = await syncProducts();
  // Inventory dialect: Inventory never pushes, so its outbox is read here too (and every minute by the scheduler)
  let polled = "";
  if (isInventoryDialect()) {
    try {
      const out = await pollInventoryOutbox({ trigger: `Refresh by ${req.user.email}` });
      polled = out.skipped_run ? " Inventory's events are being read already." : ` Inventory events: ${out.read} read, ${out.stored} new, ${out.acked} acknowledged.`;
    } catch (err) { polled = ` Inventory's events could not be read: ${err.message}`; }
  }
  await audit(req, "inventory_snapshot_refreshed", { recordType: "inventory", details: `${n} product(s) from the ${inventoryMode()} Inventory${polled}` });
  req.flash("success_msg", `Product snapshot refreshed from the ${inventoryMode()} Inventory (${n} products).${polled}`);
  res.redirect("/crm/sales");
};

// ---------------------------------------------------------------- customer portal: shop, cart, orders, tracking

export const shop = async (req, res) => {
  const q = clean(req.query.q, 60);
  const category = clean(req.query.category, 60);
  const { products, categories } = await listCatalog({ q, category });
  res.render("shop/shop", { title: "Shop", areaTabs: tabs(PORTAL_TABS, "Shop"), products: products.map((p) => ({ ...p, out: p.available_qty <= 0 })), q, categories: categories.map((c) => ({ name: c, sel: c === category })), promos: await activePromotions(), ...inventoryNote() });
};

const portalAction = (fn) => async (req, res) => {
  try { const msg = await fn(req, res); if (msg) req.flash("success_msg", msg); } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.status === 403) return res.status(403).render("error", { title: "Access denied", status: 403, message: err.message });
    req.flash("error_msg", err.message);
  }
  res.redirect(req._back || "/portal/cart");
};

export const cartAdd = portalAction(async (req) => {
  req._back = clean(req.body.back, 120).startsWith("/portal/") ? clean(req.body.back, 120) : "/portal/shop";
  const out = await addToCart({ user: req.user, productId: clean(req.body.product_id, 64), quantity: req.body.quantity });
  return `${out.name} is in your cart (${out.quantity}).`;
});
export const cartUpdate = portalAction(async (req) => { await setCartQuantity({ user: req.user, productId: clean(req.body.product_id, 64), quantity: req.body.quantity }); return "Cart updated."; });
export const cartRemove = portalAction(async (req) => { await removeFromCart({ user: req.user, productId: clean(req.body.product_id, 64) }); return "Removed from your cart."; });

export const cart = async (req, res) => {
  const [c, addresses, promos, loyalty] = await Promise.all([getCart(req.user), addressesOf(req.user.customer_id), activePromotions(), customerLoyalty(req.user.customer_id, { limit: 0 })]);
  res.render("shop/cart", {
    title: "Cart", areaTabs: tabs(PORTAL_TABS, "Cart"), cart: c, loyalty, loyaltyRules: RULES_TEXT, addresses: addresses.map((a) => ({ ...a, sel: Boolean(a.is_default) })), promos, requestKey: crypto.randomUUID(),
    methodOptions: [["cod", "Cash on delivery"], ["gcash", "GCash"], ["maya", "Maya"]].map(([value, label]) => ({ value, label })), ...inventoryNote(),
  });
};

export const checkout = async (req, res) => {
  try {
    const method = oneOf(req.body.payment_method, ["cod", "gcash", "maya"]);
    if (!method) throw new AppError("Choose how you will pay.", 422);
    const out = await checkoutCart({
      user: req.user, fulfillment: oneOf(req.body.fulfillment, ["pickup", "delivery"]), addressId: toId(req.body.address_id), promoCode: clean(req.body.promo_code, 30), loyaltyPoints: Number.parseInt(req.body.loyalty_points || "0", 10) || 0,
      payment: { method, reference: clean(req.body.payment_reference, 40) }, requestKey: clean(req.body.request_key, 40),
    });
    if (out.duplicate) { req.flash("info_msg", `Your order ${out.order_no} was already placed.`); return res.redirect(`/portal/orders/${out.id}`); }
    await audit(req, "order_created", { recordType: "order", recordId: out.order_no, after: { channel: "portal", grand_total: out.grand_total, promo: out.promoCode } });
    req.flash("success_msg", `Thank you! Your order ${out.order_no} is confirmed${method === "cod" ? ". Pay the cash when it arrives." : ". We will verify your payment reference shortly."}`);
    return res.redirect(`/portal/orders/${out.id}`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.status === 409 && err.issues) await audit(req, "order_rejected", { outcome: "denied", recordType: "order", details: err.issues.map((i) => `${i.kind}: ${i.message}`).join("; ").slice(0, 480) });
    req.flash("error_msg", err.message);
    return res.redirect("/portal/cart");
  }
};

export const portalOrders = async (req, res) => {
  const first = await listOrders(req.user, { limit: 1, offset: 0 });
  const pagination = buildPagination({ total: first.total, page: toPage(req.query.page), perPage: 10, basePath: "/portal/orders" });
  const { rows } = await listOrders(req.user, { limit: pagination.limit, offset: pagination.offset });
  res.render("shop/orders", { title: "My Orders", areaTabs: tabs(PORTAL_TABS, "My orders"), rows: rows.map(orderLabels), pagination });
};

export const portalOrder = async (req, res) => {
  const id = toId(req.params.id);
  const o = id ? await findOrder(id, req.user) : null;
  if (!o) return notFound(res);
  res.render("shop/order_show", {
    title: o.order_no, areaTabs: tabs(PORTAL_TABS, "My orders"), o: orderLabels(o), tracking: trackingSteps(o),
    payments: o.payments.map((p) => ({ ...p, method_label: PAYMENT_METHOD_LABELS[p.method], status_label: PAYMENT_RECORD_STATUS_LABELS[p.status] })),
    refunds: o.refunds.map((r) => ({ ...r, status_label: REFUND_STATUS_LABELS[r.status] })),
    canPay: o.status === "confirmed" && o.outstanding > 0, canCancel: o.status === "confirmed" && o.payment_status === "unpaid" && !o.payments.some((p) => p.status === "verified"),
  });
};

const PORTAL_ORDER_PAGE = (id) => `/portal/orders/${id}`;
export const portalPay = action("payment", async (req, id) => {
  const out = await recordPayment({ orderId: id, user: req.user, method: oneOf(req.body.method, ["gcash", "maya"]), reference: clean(req.body.reference, 40), amount: Number(req.body.amount) });
  await audit(req, "payment_recorded", { recordType: "order", recordId: id, after: { method: out.method, amount: out.amount, by: "customer" } });
  return { text: "Thank you. We will verify your payment reference shortly.", redirect: `/portal/orders/${id}` };
}, "order", PORTAL_ORDER_PAGE);
export const portalCancel = action("cancel", async (req, id) => {
  await cancelOrder({ orderId: id, user: req.user, reason: clean(req.body.reason, 200) });
  await audit(req, "order_cancelled", { recordType: "order", recordId: id, reason: "Cancelled by the customer" });
  return { text: "Your order was cancelled.", redirect: `/portal/orders/${id}` };
}, "order", PORTAL_ORDER_PAGE);

export const tracking = async (req, res) => {
  const { rows } = await listOrders(req.user, { limit: 20, offset: 0 });
  const detailed = [];
  for (const r of rows) { const o = await findOrder(r.id, req.user); detailed.push({ ...orderLabels(o), steps: trackingSteps(o) }); }
  res.render("shop/tracking", { title: "Order Tracking", areaTabs: tabs(PORTAL_TABS, "Order tracking"), orders: detailed });
};
