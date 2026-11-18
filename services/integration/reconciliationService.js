/*
 * Unmatched-sales reconciliation (docs/integration-contract.md §8). For every completed sale it shows what happened to the
 * SaleCompleted event for each target (Inventory, Accounting) and flags the sales that have no confirmation after 24 hours.
 *
 * "Confirmed" means the target ACCEPTED the event (HTTP 202, or 200 duplicate): the outbox row is `sent`. CRM cannot see inside
 * Accounting's ledger, so this is delivery confirmation, not proof of posting; the contract asks Accounting whether it will expose
 * a "posted sales" endpoint (§8, open question) so a real posting match can be added later.
 *
 * Overall status of a sale:
 *   confirmed     every target that is live accepted the event
 *   in_progress   a live target has not accepted it yet, and the sale is younger than 24 hours
 *   unmatched     a live target has not accepted it and the sale is 24 hours old or more  (the report's main list)
 *   not_sent      every target is mock or disabled: nothing was ever sent, so there is nothing to match
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../../models/index.js";
import { SYSTEMS } from "./adapterBase.js";

export const STALE_HOURS = 24;
const TARGETS = [SYSTEMS.inventory, SYSTEMS.accounting];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const money = (n) => Number(n || 0).toFixed(2);

export const deliveryState = (row) => {
  if (!row) return "missing";
  return { sent: "confirmed", pending: "waiting", failed: "retrying", dead: "dead", mock_delivered: "mock", skipped_disabled: "disabled" }[row.status] || row.status;
};

export const overallStatus = (states, ageHours) => {
  const real = states.filter((s) => !["mock", "disabled"].includes(s));
  if (!real.length) return "not_sent";
  if (real.every((s) => s === "confirmed")) return "confirmed";
  return ageHours >= STALE_HOURS ? "unmatched" : "in_progress";
};

export const parseRange = ({ from, to } = {}, now = new Date()) => {
  const end = DAY.test(String(to || "")) ? String(to) : new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
  const start = DAY.test(String(from || "")) ? String(from) : new Date(Date.parse(`${end}T00:00:00Z`) - 29 * 86400e3).toISOString().slice(0, 10);
  return { from: start <= end ? start : end, to: end };
};

export const salesReconciliation = async ({ from, to, onlyProblems = false, limit = 500, now = new Date() } = {}) => {
  const range = parseRange({ from, to }, now);
  const sales = await select(
    `SELECT s.sale_id, s.transaction_no, s.completed_at, s.net_amount, s.currency, s.status, s.is_demo, o.order_id, o.order_no
     FROM sales_transactions s JOIN sales_orders o ON o.id = s.sales_order_id
     WHERE s.completed_at >= :from AND s.completed_at < DATE_ADD(:to, INTERVAL 1 DAY) ORDER BY s.completed_at DESC, s.id DESC`, range);
  const events = sales.length
    ? await select("SELECT entity_id, target, status, attempts, last_error, sent_at FROM integration_outbox WHERE event_type = 'SaleCompleted' AND entity_id IN (:ids)", { ids: sales.map((s) => s.sale_id) })
    : [];
  const byKey = new Map(events.map((e) => [`${e.entity_id}|${e.target}`, e]));
  const rows = sales.map((s) => {
    const ageHours = (now.getTime() - new Date(s.completed_at).getTime()) / 3600e3;
    const deliveries = Object.fromEntries(TARGETS.map((t) => {
      const e = byKey.get(`${s.sale_id}|${t}`);
      return [t, { state: deliveryState(e), attempts: e ? e.attempts : 0, last_error: e?.last_error || null, sent_at: e?.sent_at || null }];
    }));
    return {
      sale_id: s.sale_id, transaction_no: s.transaction_no, order_id: s.order_id, order_no: s.order_no, completed_at: s.completed_at, net_amount: money(s.net_amount), currency: s.currency,
      sale_status: s.status, is_demo: Boolean(s.is_demo), age_hours: Math.floor(ageHours * 10) / 10, deliveries,
      status: overallStatus(TARGETS.map((t) => deliveries[t].state), ageHours),
    };
  });
  const count = (status) => rows.filter((r) => r.status === status).length;
  const sum = (status) => money(rows.filter((r) => r.status === status).reduce((t, r) => t + Number(r.net_amount), 0));
  const summary = {
    from: range.from, to: range.to, completed_sales: rows.length, confirmed: count("confirmed"), in_progress: count("in_progress"), unmatched: count("unmatched"), not_sent: count("not_sent"),
    unmatched_amount: sum("unmatched"), total_amount: money(rows.reduce((t, r) => t + Number(r.net_amount), 0)), stale_after_hours: STALE_HOURS,
  };
  const shown = onlyProblems ? rows.filter((r) => ["unmatched", "in_progress"].includes(r.status)) : rows;
  return { summary, rows: shown.slice(0, limit), truncated: shown.length > limit };
};
