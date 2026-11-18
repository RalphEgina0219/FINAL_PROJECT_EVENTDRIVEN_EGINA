/*
 * Refunds, P5 (TC-14). A refund is requested for a COMPLETED sale, decided by someone else, then recorded:
 *   requested -> approved | rejected;  approved -> recorded (the money was returned by hand; no payment gateway)
 * The approver must differ from the requester: checked here, and by the CHECK constraint refunds_self_approval_chk.
 * Recording a refund updates the sale and order payment status and publishes ONE RefundRecorded event (idempotent).
 * Record scope = the order's scope (orderScope).
 */
import crypto from "crypto";
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { AppError } from "../helpers/errors.js";
import { orderScope } from "./orderService.js";
import { scopeFor } from "./caseService.js";
import { nextDailyNumber } from "./numberService.js";
import { publishEvent } from "./eventService.js";
import { isoWithOffset } from "./integration/signing.js";
import { reverseForRefund } from "./loyaltyService.js";
import { notify, userIdsByRole } from "./notificationService.js";

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
const exec = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction });
const cents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => Math.round(c) / 100;

export const REFUND_STATUS_LABELS = { requested: "Requested", approved: "Approved", rejected: "Rejected", recorded: "Recorded" };
export const ITEM_CONDITIONS = [["good", "Good, can be resold"], ["damaged", "Damaged"], ["expired", "Expired / spoiled"]];
export const MIN_REASON_LENGTH = 5;

const FROM = `FROM refunds r JOIN sales_transactions s ON s.id = r.sales_transaction_id JOIN sales_orders o ON o.id = s.sales_order_id JOIN customers c ON c.id = o.customer_id
  LEFT JOIN crm_users rb ON rb.id = r.requested_by LEFT JOIN crm_users ab ON ab.id = r.approved_by LEFT JOIN customer_cases k ON k.id = r.case_id`;
const COLUMNS = `r.id, r.refund_id, r.refund_no, r.amount, r.reason, r.return_items, r.status, r.requested_by, r.approved_by, r.approved_at, r.decision_reason, r.recorded_at, r.created_at,
  s.id AS sale_row_id, s.sale_id, s.transaction_no, s.net_amount AS sale_net, o.id AS order_id, o.order_no, o.is_demo, c.id AS customer_id, c.customer_no,
  CONCAT(c.first_name, ' ', c.last_name) AS customer_name, rb.display_name AS requested_by_name, ab.display_name AS approved_by_name, k.case_no, k.id AS case_id`;

// MySQL returns a JSON column already parsed (an array); older rows or other drivers may hand back text.
const parseItems = (v) => { if (Array.isArray(v)) return v; if (typeof v === "string") { try { return JSON.parse(v || "[]"); } catch { return []; } } return []; };
const shape = (r) => ({ ...r, amount: Number(r.amount), sale_net: Number(r.sale_net), items: parseItems(r.return_items) });

export const listRefunds = async (user, { q, status, limit, offset }) => {
  const scope = orderScope(user);
  const where = [scope.sql];
  const params = { ...scope.params };
  if (q) { where.push("(r.refund_no LIKE :q OR o.order_no LIKE :q OR s.transaction_no LIKE :q OR c.customer_no LIKE :q OR CONCAT(c.first_name, ' ', c.last_name) LIKE :q)"); params.q = `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`; }
  if (status) { where.push("r.status = :status"); params.status = status; }
  const [{ total }] = await select(`SELECT COUNT(*) AS total ${FROM} WHERE ${where.join(" AND ")}`, params);
  const rows = await select(`SELECT ${COLUMNS} ${FROM} WHERE ${where.join(" AND ")} ORDER BY FIELD(r.status,'requested','approved','recorded','rejected'), r.created_at DESC LIMIT :limit OFFSET :offset`, { ...params, limit, offset });
  return { total: Number(total), rows: rows.map(shape) };
};

export const findRefund = async (id, user) => {
  const scope = orderScope(user);
  const [row] = await select(`SELECT ${COLUMNS} ${FROM} WHERE r.id = :id AND ${scope.sql}`, { id, ...scope.params });
  return row ? shape(row) : null;
};

export const refundCounts = async (user) => {
  const scope = orderScope(user);
  const [row] = await select(`SELECT COALESCE(SUM(r.status = 'requested'), 0) AS requested, COALESCE(SUM(r.status = 'approved'), 0) AS approved ${FROM} WHERE ${scope.sql}`, scope.params);
  return { requested: Number(row.requested), approved: Number(row.approved) };
};

// What can still be refunded on a sale: its net amount minus refunds that are requested, approved or recorded.
export const refundableOn = async (saleRowId, transaction) => {
  const [s] = await select("SELECT net_amount FROM sales_transactions WHERE id = :id", { id: saleRowId }, transaction);
  const [{ used }] = await select("SELECT COALESCE(SUM(amount), 0) AS used FROM refunds WHERE sales_transaction_id = :id AND status IN ('requested','approved','recorded')", { id: saleRowId }, transaction);
  return Math.max(0, fromCents(cents(s.net_amount) - cents(used)));
};

const lockSale = async (saleRowId, user, transaction) => {
  const scope = orderScope(user);
  const [row] = await select(
    `SELECT s.*, o.order_no, o.order_id AS order_uuid, o.id AS order_row_id FROM sales_transactions s JOIN sales_orders o ON o.id = s.sales_order_id JOIN customers c ON c.id = o.customer_id
     WHERE s.id = :id AND ${scope.sql} FOR UPDATE`, { id: saleRowId, ...scope.params }, transaction);
  if (!row) throw new AppError("Sale not found.", 404);
  return row;
};

export const requestRefund = async ({ saleRowId, user, amount, reason, returnItems = [], caseNo = "", at = null, isDemo = false }) => {
  if (user.role === "customer") throw new AppError("Only staff can request a refund.", 403);
  const out = await sequelize.transaction(async (transaction) => {
    const sale = await lockSale(saleRowId, user, transaction);
    if (!["completed", "partially_refunded"].includes(sale.status)) throw new AppError("Only a completed sale can be refunded.", 422);
    const text = String(reason || "").trim();
    if (text.length < MIN_REASON_LENGTH) throw new AppError(`Give a reason for the refund (at least ${MIN_REASON_LENGTH} characters).`, 422);
    const amt = cents(amount);
    if (!(amt > 0)) throw new AppError("Enter the refund amount.", 422);
    const refundable = cents(await refundableOn(saleRowId, transaction));
    if (amt > refundable) throw new AppError(`The amount is more than can still be refunded on this sale (₱${fromCents(refundable).toFixed(2)}).`, 422);
    // items coming back to Inventory must be products of this order, with a quantity not above what was sold
    const sold = Object.fromEntries((await select("SELECT product_id, quantity FROM sales_order_items WHERE sales_order_id = :id", { id: sale.order_row_id }, transaction)).map((i) => [i.product_id, Number(i.quantity)]));
    const items = [];
    for (const it of returnItems) {
      if (!it || !it.product_id) continue;
      const qty = Number(it.quantity);
      if (!(sold[it.product_id] > 0)) throw new AppError("A returned item is not part of this order.", 422);
      if (!(qty > 0) || qty > sold[it.product_id]) throw new AppError("A returned quantity is more than was sold.", 422);
      if (!ITEM_CONDITIONS.some(([k]) => k === it.condition)) throw new AppError("Choose the condition of each returned item.", 422);
      items.push({ product_id: it.product_id, quantity: qty, condition: it.condition });
    }
    let caseId = null;
    if (caseNo) {
      const cs = scopeFor(user);
      const [k] = await select(`SELECT k.id, k.customer_id FROM customer_cases k WHERE k.case_no = :no AND ${cs.sql}`, { no: String(caseNo).trim().toUpperCase(), ...cs.params }, transaction);
      if (!k || Number(k.customer_id) !== Number(sale.customer_id)) throw new AppError("That case number was not found for this customer.", 422);
      caseId = k.id;
    }
    const now = at || new Date();
    const refundUuid = crypto.randomUUID();
    const no = await nextDailyNumber("refund", now, transaction);
    const [id] = await sequelize.query(
      `INSERT INTO refunds (refund_id, refund_no, sales_transaction_id, case_id, amount, reason, return_items, status, requested_by, correlation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
      { replacements: [refundUuid, no, saleRowId, caseId, fromCents(amt), text.slice(0, 255), items.length ? JSON.stringify(items) : null, user.id, sale.correlation_id, now], transaction }
    );
    return { id, refund_no: no, sale, amount: fromCents(amt), caseId, isDemo };
  });
  if (!at) await notify((await userIdsByRole("team_leader", "crm_manager")).filter((u) => u !== user.id), { type: "order", title: `Refund ${out.refund_no} needs a decision`, message: `₱${out.amount.toFixed(2)} on ${out.sale.order_no}`, link: `/crm/sales/refunds/${out.id}`, relatedType: "refund", relatedId: out.id });
  return out;
};

export const decideRefund = async ({ id, user, decision, reason = "", at = null }) => {
  const out = await sequelize.transaction(async (transaction) => {
    if (!["team_leader", "crm_manager"].includes(user.role)) throw new AppError("Only a Team Leader or the CRM Manager can decide a refund.", 403);
    const scope = orderScope(user);
    const [r] = await select(`SELECT r.*, o.order_no FROM refunds r JOIN sales_transactions s ON s.id = r.sales_transaction_id JOIN sales_orders o ON o.id = s.sales_order_id JOIN customers c ON c.id = o.customer_id WHERE r.id = :id AND ${scope.sql} FOR UPDATE`, { id, ...scope.params }, transaction);
    if (!r) throw new AppError("Refund not found.", 404);
    if (r.status !== "requested") throw new AppError(`This refund is already ${r.status}.`, 422);
    if (Number(r.requested_by) === Number(user.id)) throw new AppError("You requested this refund, so someone else must decide it.", 403);
    const text = String(reason || "").trim();
    if (decision === "reject" && text.length < MIN_REASON_LENGTH) throw new AppError(`Give a reason for rejecting (at least ${MIN_REASON_LENGTH} characters).`, 422);
    if (!["approve", "reject"].includes(decision)) throw new AppError("Choose approve or reject.", 422);
    const now = at || new Date();
    await exec("UPDATE refunds SET status = ?, approved_by = ?, approved_at = ?, decision_reason = ? WHERE id = ?", [decision === "approve" ? "approved" : "rejected", user.id, now, text.slice(0, 255) || null, id], transaction);
    return { refund: r, decision };
  });
  if (!at) await notify(out.refund.requested_by, { type: "order", title: `Refund ${out.refund.refund_no} was ${out.decision === "approve" ? "approved" : "rejected"}`, message: out.refund.order_no, link: `/crm/sales/refunds/${id}`, relatedType: "refund", relatedId: id });
  return out;
};

export const recordRefund = async ({ id, user, at = null }) => {
  const out = await sequelize.transaction(async (transaction) => {
    if (!["team_leader", "crm_manager"].includes(user.role)) throw new AppError("Only a Team Leader or the CRM Manager can record a refund.", 403);
    const scope = orderScope(user);
    const [r] = await select(`SELECT r.*, o.order_no, o.id AS order_row_id, o.order_id AS order_uuid FROM refunds r JOIN sales_transactions s ON s.id = r.sales_transaction_id JOIN sales_orders o ON o.id = s.sales_order_id JOIN customers c ON c.id = o.customer_id WHERE r.id = :id AND ${scope.sql} FOR UPDATE`, { id, ...scope.params }, transaction);
    if (!r) throw new AppError("Refund not found.", 404);
    if (r.status !== "approved") throw new AppError(r.status === "recorded" ? "This refund is already recorded." : "Only an approved refund can be recorded.", 422);
    const now = at || new Date();
    await exec("UPDATE refunds SET status = 'recorded', recorded_at = ? WHERE id = ?", [now, id], transaction);
    const [sale] = await select("SELECT id, sale_id, transaction_no, net_amount, customer_id FROM sales_transactions WHERE id = :id FOR UPDATE", { id: r.sales_transaction_id }, transaction);
    const [{ done }] = await select("SELECT COALESCE(SUM(amount), 0) AS done FROM refunds WHERE sales_transaction_id = :id AND status = 'recorded'", { id: sale.id }, transaction);
    const full = cents(done) >= cents(sale.net_amount);
    await exec("UPDATE sales_transactions SET status = ?, payment_status = ? WHERE id = ?", [full ? "refunded" : "partially_refunded", full ? "refunded" : "partially_refunded", sale.id], transaction);
    await exec("UPDATE sales_orders SET payment_status = ? WHERE id = ?", [full ? "refunded" : "partially_refunded", r.order_row_id], transaction);
    await reverseForRefund({ customerId: sale.customer_id, saleRowId: sale.id, transactionNo: sale.transaction_no, netAmount: sale.net_amount, refundedTotal: done, refundId: r.id, refundNo: r.refund_no, userId: user.id, at: now, transaction });
    const [approver] = await select("SELECT employee_id FROM crm_users WHERE id = :id", { id: r.approved_by }, transaction);
    await publishEvent({
      type: "RefundRecorded", entityId: r.refund_id, correlationId: r.correlation_id, idempotencyKey: `RefundRecorded:${r.refund_id}`, at: now, transaction,
      data: {
        refund_id: r.refund_id, sale_id: sale.sale_id, order_id: r.order_uuid, amount: Number(r.amount).toFixed(2), reason: r.reason,
        return_items: parseItems(r.return_items).map((i) => ({ product_id: i.product_id, quantity: Number(i.quantity), condition: i.condition })),
        approved_by_employee_id: approver?.employee_id || null, recorded_at: isoWithOffset(now),
      },
    });
    return { refund: r, full };
  });
  if (!at) await notify(out.refund.requested_by, { type: "order", title: `Refund ${out.refund.refund_no} was recorded`, message: out.refund.order_no, link: `/crm/sales/refunds/${id}`, relatedType: "refund", relatedId: id });
  return out;
};
