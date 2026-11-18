/*
 * Read model for the Integration Health page (CRM Manager: Settings > Integration Health; setup System Administrator: /setup/integration).
 * Everything here is real data from integration_outbox, integration_inbox, integration_compensations, integration_logs and the
 * adapter settings; nothing is invented.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../../models/index.js";
import { config } from "../../config/index.js";
import { SYSTEMS, modeOf, authOf, AUTH_LABELS, hasCredential, connectionStyle } from "./adapterBase.js";
import { hrPullEnabled } from "./hrPullSync.js";
import { isInventoryDialect } from "./inventoryDialect.js";
import { salesReconciliation } from "./reconciliationService.js";

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const countBy = (rows, key = "status") => Object.fromEntries(rows.map((r) => [r[key], Number(r.n)]));

export const APP_LABELS = { hr: "JOHNVIVZ HR", inventory: "JOHNVIVZ Inventory", accounting: "JOHNVIVZ Accounting & Payroll" };

export const connectedApps = async () => {
  const apps = [];
  for (const [key, system] of Object.entries(SYSTEMS)) {
    const cfg = config.integration[key];
    const [ok] = await select("SELECT created_at, http_status, endpoint FROM integration_logs WHERE `system` = :system AND mode = 'live' AND success = 1 ORDER BY id DESC LIMIT 1", { system });
    const [bad] = await select("SELECT created_at, message, endpoint FROM integration_logs WHERE `system` = :system AND mode = 'live' AND success = 0 ORDER BY id DESC LIMIT 1", { system });
    apps.push({
      key, system, label: APP_LABELS[key], mode: modeOf(key), live: modeOf(key) === "live", mock: modeOf(key) === "mock",
      auth: authOf(key), authLabel: AUTH_LABELS[authOf(key)], bearer: authOf(key) === "bearer", style: connectionStyle(key),
      hrPull: key === "hr" && hrPullEnabled(), inventoryDialect: key === "inventory" && isInventoryDialect(),
      baseUrl: Boolean(cfg.baseUrl), outboundSecret: hasCredential(key), inboundSecret: authOf(key) === "bearer" ? hasCredential(key) : Boolean(config.integration.inboundSecrets[system]),
      lastOk: ok || null, lastError: bad || null,
    });
  }
  return apps;
};

export const healthOverview = async () => {
  const outbox = countBy(await select("SELECT status, COUNT(*) n FROM integration_outbox GROUP BY status"));
  const inbox = countBy(await select("SELECT status, COUNT(*) n FROM integration_inbox GROUP BY status"));
  const comp = countBy(await select("SELECT status, COUNT(*) n FROM integration_compensations GROUP BY status"));
  const [sent24] = await select("SELECT COUNT(*) n FROM integration_outbox WHERE status = 'sent' AND sent_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)");
  const [mockSnap] = await select("SELECT (SELECT COUNT(*) FROM product_references WHERE is_mock = 1) products, (SELECT COUNT(*) FROM employee_references WHERE is_mock = 1) employees");
  const recon = await salesReconciliation({ onlyProblems: false, limit: 0 });
  return {
    // things a person has to act on: dead letters, inbound events that died, stock clean-up tasks that died
    problems: (outbox.dead || 0) + (inbox.dead || 0) + (comp.dead || 0),
    outbox: { pending: outbox.pending || 0, failed: outbox.failed || 0, dead: outbox.dead || 0, sent: outbox.sent || 0, sent24: Number(sent24.n), mock: outbox.mock_delivered || 0, skipped: outbox.skipped_disabled || 0 },
    inbox: { received: inbox.received || 0, processed: inbox.processed || 0, failed: inbox.failed || 0, dead: inbox.dead || 0, ignored: inbox.ignored || 0 },
    compensations: { pending: comp.pending || 0, dead: comp.dead || 0, done: comp.done || 0 },
    reconciliation: recon.summary,
    mockSnapshots: { products: Number(mockSnap.products), employees: Number(mockSnap.employees) },
  };
};

const OUTBOX_STATUSES = ["pending", "failed", "dead", "sent", "mock_delivered", "skipped_disabled"];
const INBOX_STATUSES = ["received", "processed", "ignored", "failed", "dead"];
export const outboxStatuses = OUTBOX_STATUSES;
export const inboxStatuses = INBOX_STATUSES;

export const listOutbox = ({ status = "", limit = 25 } = {}) =>
  select(
    `SELECT id, event_id, event_type, target, entity_id, status, attempts, next_attempt_at, last_error, sent_at, is_mock, created_at
     FROM integration_outbox ${OUTBOX_STATUSES.includes(status) ? "WHERE status = :status" : ""}
     ORDER BY (status = 'dead') DESC, (status = 'failed') DESC, (status = 'pending') DESC, id DESC LIMIT ${Number(limit) | 0}`, { status });

export const listInbox = ({ status = "", limit = 25 } = {}) =>
  select(
    `SELECT id, event_id, event_type, source, entity_id, status, attempts, last_error, received_at, processed_at
     FROM integration_inbox ${INBOX_STATUSES.includes(status) ? "WHERE status = :status" : ""}
     ORDER BY (status = 'dead') DESC, (status = 'failed') DESC, (status = 'received') DESC, id DESC LIMIT ${Number(limit) | 0}`, { status });

export const listCompensations = ({ limit = 15 } = {}) =>
  select(`SELECT id, kind, order_id, reservation_ref, reason, status, attempts, next_attempt_at, last_error, created_at, done_at FROM integration_compensations ORDER BY (status = 'dead') DESC, (status = 'pending') DESC, id DESC LIMIT ${Number(limit) | 0}`);

// Reservations never expire at Inventory (contract §12.2): a CRM order that still holds stock there 24 hours after it was confirmed, and is
// neither completed nor cancelled, needs a person (complete it, or cancel it so CRM sends order.cancelled). Mock reservations are left out.
export const STALE_RESERVATION_HOURS = 24;
export const staleReservations = ({ hours = STALE_RESERVATION_HOURS, limit = 50 } = {}) =>
  select(
    `SELECT o.id, o.order_no, o.order_id, o.status, o.payment_status, o.reservation_status, o.inventory_reservation_ref, o.confirmed_at, o.is_demo,
            TIMESTAMPDIFF(HOUR, o.confirmed_at, NOW()) AS age_hours
     FROM sales_orders o
     WHERE o.reservation_status IN ('requested','reserved','partially_reserved') AND o.status NOT IN ('completed','cancelled')
       AND o.confirmed_at < DATE_SUB(NOW(), INTERVAL :hours HOUR)
       AND o.inventory_reservation_ref IS NOT NULL AND o.inventory_reservation_ref NOT LIKE 'MOCK-%'
     ORDER BY o.confirmed_at LIMIT ${Number(limit) | 0}`, { hours });

// order.confirmed answers that refused an order for a reason a person should look at (conflict / unexpected refusal), last 7 days.
export const reservationConflicts = ({ limit = 20 } = {}) =>
  select(
    `SELECT id, created_at, http_status, message, correlation_id FROM integration_logs
     WHERE \`system\` = 'johnvivz_inventory' AND endpoint = 'order.confirmed' AND (message LIKE 'CONFLICT%' OR message LIKE 'REFUSED%')
       AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
     ORDER BY id DESC LIMIT ${Number(limit) | 0}`);

export const recentLogs = ({ limit = 20 } = {}) =>
  select(`SELECT id, direction, \`system\`, endpoint, http_method, http_status, duration_ms, success, mode, message, created_at FROM integration_logs ORDER BY id DESC LIMIT ${Number(limit) | 0}`);
