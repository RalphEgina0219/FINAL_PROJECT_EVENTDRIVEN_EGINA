/*
 * Outbox dispatcher (blueprint §13, docs/integration-contract.md §4). Events are written to integration_outbox in the same
 * transaction as the business change (services/eventService.js); this module delivers the ones whose target is in LIVE mode.
 *
 *   pending  -> never attempted        failed -> attempted, next try scheduled        sent -> accepted by the target
 *   dead     -> the dead-letter queue: shown on Integration Health, retried by hand
 *   mock_delivered / skipped_disabled -> never sent (mock / disabled target); this dispatcher never touches them
 *
 * Delivery: signed POST {target}/api/integration/v1/events with the envelope as the body. 202, or 200 with status "duplicate", = accepted.
 * Retries after the 1st..5th failure: +1 min, +5 min, +15 min, +1 h, +6 h. The 6th failure moves the event to `dead`.
 * A 400 answer (the target says the envelope is invalid) goes to `dead` at once: sending the same bytes again cannot help.
 * 401 / 403 / 5xx / timeouts are retried (a secret can be fixed while the event waits).
 * There is no ordering guarantee between events; receivers use occurred_at and the idempotency_key.
 * Inventory dialect (INTEGRATION_INVENTORY_DIALECT=johnvivz_inventory, contract §12.2): events to Inventory are translated to its own
 * format (order.confirmed, sale.completed, order.cancelled, sale.refunded) with a stable eventId; any 2xx = accepted; 400 / 409 / 422 = dead.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../../models/index.js";
import { modeOf, SYSTEMS, keyOfTarget, signedRequest } from "./adapterBase.js";
import { RETRY_DELAYS_MINUTES, MAX_ATTEMPTS, processCompensations } from "./compensationService.js";
import { isInventoryDialect, toInventoryEvent, sendInventoryEvent } from "./inventoryDialect.js";

export { RETRY_DELAYS_MINUTES, MAX_ATTEMPTS };

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const affected = (meta) => Number(meta?.affectedRows ?? meta ?? 0);

let running = false;

const markSent = (row, note) =>
  sequelize.query("UPDATE integration_outbox SET status = 'sent', attempts = attempts + 1, sent_at = NOW(), next_attempt_at = NULL, last_error = :note WHERE id = :id", { replacements: { id: row.id, note: note || null } });

const markFailed = async (row, error, { final = false } = {}) => {
  const attempts = row.attempts + 1;
  const message = String(error).slice(0, 500);
  if (final || attempts >= MAX_ATTEMPTS) {
    await sequelize.query("UPDATE integration_outbox SET status = 'dead', attempts = :attempts, next_attempt_at = NULL, last_error = :message WHERE id = :id", { replacements: { id: row.id, attempts, message } });
    return "dead";
  }
  await sequelize.query("UPDATE integration_outbox SET status = 'failed', attempts = :attempts, next_attempt_at = DATE_ADD(NOW(), INTERVAL :minutes MINUTE), last_error = :message WHERE id = :id", { replacements: { id: row.id, attempts, minutes: RETRY_DELAYS_MINUTES[attempts - 1], message } });
  return "failed";
};

// Delivers one row. Returns "sent" | "failed" | "dead" | "skipped".
export const deliver = async (row) => {
  const key = keyOfTarget(row.target);
  if (!key || modeOf(key) !== "live") return "skipped"; // the target is not live (any more): nothing is ever sent
  if (key === "inventory" && isInventoryDialect()) return deliverInventoryDialect(row);
  const envelope = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
  let res;
  try {
    res = await signedRequest(key, {
      method: "POST", path: "/api/integration/v1/events", body: envelope, direction: "outbound_event", eventId: row.event_id, correlationId: row.correlation_id,
      headers: { "Idempotency-Key": row.idempotency_key }, logMessage: `${row.event_type} attempt ${row.attempts + 1}`,
    });
  } catch (err) {
    return markFailed(row, err.message);
  }
  if (res.status === 202 || (res.status === 200 && (res.json?.status === "duplicate" || res.json?.status === "accepted"))) {
    await markSent(row, res.json?.status === "duplicate" ? "The target already had this event (duplicate acknowledged)." : null);
    return "sent";
  }
  if (res.status === 400) return markFailed(row, `Rejected by ${row.target}: ${res.json?.error || "invalid envelope"}${res.json?.details ? ` ${JSON.stringify(res.json.details)}` : ""}`, { final: true });
  return markFailed(row, `HTTP ${res.status}${res.json?.error ? ` ${res.json.error}` : ""}`);
};

const deliverInventoryDialect = async (row) => {
  const envelope = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  let body;
  try { body = await toInventoryEvent(envelope); } catch (err) { return markFailed(row, `Could not translate for Inventory: ${err.message}`); }
  if (!body) { await markSent(row, "Not sent: the Inventory dialect has no equivalent of this event."); return "sent"; }
  let res;
  try {
    res = await sendInventoryEvent(body, { eventId: row.event_id, correlationId: row.correlation_id, logMessage: `${row.event_type} as ${body.eventType} attempt ${row.attempts + 1}` });
  } catch (err) {
    return markFailed(row, err.message);
  }
  const why = res.json?.error || res.json?.message;
  if (res.ok) { await markSent(row, `Sent as ${body.eventType} (eventId ${body.eventId}).`); return "sent"; }
  if ([400, 409, 422].includes(res.status)) return markFailed(row, `Rejected by Inventory (${body.eventType}): HTTP ${res.status}${why ? ` ${String(why).slice(0, 200)}` : ""}`, { final: true });
  return markFailed(row, `HTTP ${res.status}${why ? ` ${String(why).slice(0, 200)}` : ""}`);
};

/*
 * One dispatcher pass: sends every due live event (oldest first) and runs the due compensations.
 * Safe to call from the scheduler, from the "Send pending events now" button and from tests; two passes never overlap.
 */
export const dispatchDue = async ({ limit = 50 } = {}) => {
  if (running) return { skipped: true, attempted: 0, sent: 0, failed: 0, dead: 0 };
  running = true;
  const summary = { skipped: false, attempted: 0, sent: 0, failed: 0, dead: 0, waiting: 0 };
  try {
    const liveTargets = Object.entries(SYSTEMS).filter(([key]) => modeOf(key) === "live").map(([, name]) => name);
    if (liveTargets.length) {
      const rows = await select(
        `SELECT * FROM integration_outbox WHERE status IN ('pending','failed') AND is_mock = 0 AND target IN (:targets) AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         ORDER BY id LIMIT ${Number(limit) | 0}`, { targets: liveTargets });
      for (const row of rows) {
        // claim the row: another pass (or process) that sees it now will skip it; if this process dies, it is retried after 5 minutes
        const [, claimed] = await sequelize.query(
          "UPDATE integration_outbox SET next_attempt_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE) WHERE id = :id AND status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())", { replacements: { id: row.id } });
        if (!affected(claimed)) continue;
        summary.attempted += 1;
        const outcome = await deliver(row);
        if (outcome === "sent") summary.sent += 1;
        else if (outcome === "failed") summary.failed += 1;
        else if (outcome === "dead") summary.dead += 1;
      }
    }
    summary.compensations = await processCompensations();
  } finally {
    running = false;
  }
  return summary;
};

// Manual retry of one event in the dead-letter queue (or one that is waiting for its next automatic try): a fresh schedule starts now.
export const retryEvent = async (id) => {
  const [, meta] = await sequelize.query(
    "UPDATE integration_outbox SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = CONCAT('Manual retry. Previous error: ', COALESCE(last_error, 'none')) WHERE id = :id AND status IN ('dead','failed') AND is_mock = 0",
    { replacements: { id } });
  return affected(meta) > 0;
};

export const retryAllDead = async () => {
  const [, meta] = await sequelize.query(
    "UPDATE integration_outbox SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = CONCAT('Manual retry. Previous error: ', COALESCE(last_error, 'none')) WHERE status = 'dead' AND is_mock = 0");
  return affected(meta);
};

// Purges replay-guard rows older than twice the allowed clock skew (an older signature is refused by its timestamp anyway).
export const purgeNonces = (maxSkewSeconds) =>
  sequelize.query("DELETE FROM integration_request_nonces WHERE received_at < DATE_SUB(NOW(3), INTERVAL :seconds SECOND)", { replacements: { seconds: maxSkewSeconds * 2 } });
