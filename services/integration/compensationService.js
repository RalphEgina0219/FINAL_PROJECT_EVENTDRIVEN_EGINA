/*
 * Compensations: work that must still happen after a checkout step went wrong, so a failure never leaves stock reserved for nothing.
 *
 *   release_reservation  Inventory holds a reservation (we know its id) but the order was not saved, or the release call failed.
 *                        Retry DELETE /reservations/{id} until it works.
 *   resolve_reservation  The reservation answer never arrived, so CRM does not know whether Inventory holds stock. Ask again with the
 *                        same order id (the call is idempotent, so it returns the existing reservation or makes one) and, if no order
 *                        was saved for that id, release it.
 *
 * Both are idempotent and are dropped without any call when a real order exists for the order id (the customer retried and the order
 * was saved, so the reservation is in use). Same retry delays as the outbox: +1 min, +5 min, +15 min, +1 h, +6 h, then `dead`.
 * In mock mode only the (local) mock reservation is released and nothing leaves CRM.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../../models/index.js";
import { inventoryMode, releaseStock, reserveStock } from "./inventoryAdapter.js";
import { logIntegration, SYSTEMS } from "./adapterBase.js";

export const RETRY_DELAYS_MINUTES = [1, 5, 15, 60, 360];
export const MAX_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1;

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });

export const queueCompensation = async ({ kind, orderId, reservationRef = null, correlationId = null, lines = null, reason = null }) => {
  await sequelize.query(
    `INSERT INTO integration_compensations (kind, order_id, reservation_ref, correlation_id, lines_json, reason, status, attempts, next_attempt_at, is_mock, created_at)
     VALUES (:kind, :orderId, :ref, :corr, :lines, :reason, 'pending', 0, NOW(), :mock, NOW())
     ON DUPLICATE KEY UPDATE reservation_ref = COALESCE(VALUES(reservation_ref), reservation_ref), status = IF(status = 'done', status, 'pending')`,
    { replacements: { kind, orderId, ref: reservationRef, corr: correlationId, lines: lines ? JSON.stringify(lines) : null, reason: reason ? String(reason).slice(0, 200) : null, mock: inventoryMode() === "mock" ? 1 : 0 } }
  );
};

// Release a reservation now; if that fails, keep the job so the dispatcher keeps trying. Never throws.
export const releaseOrQueue = async ({ orderId, reservationRef, correlationId, reason }) => {
  try {
    await releaseStock({ key: `release:${orderId}`, orderId, reservationRef, correlationId });
    return { released: true };
  } catch (err) {
    await queueCompensation({ kind: "release_reservation", orderId, reservationRef, correlationId, reason });
    await logIntegration({ direction: "api_call", system: SYSTEMS.inventory, endpoint: "/reservations (release)", method: "DELETE", correlationId, success: false, mode: inventoryMode(), message: `Release of ${reservationRef} failed (${err.message}); queued for retry` });
    return { released: false, queued: true };
  }
};

const orderIsSaved = async (orderId) => {
  const [row] = await select("SELECT id, status FROM sales_orders WHERE order_id = :orderId AND status <> 'cancelled'", { orderId });
  return Boolean(row);
};

const finish = (id, status, error = null) =>
  sequelize.query("UPDATE integration_compensations SET status = :status, last_error = :error, done_at = IF(:status = 'done', NOW(), NULL), next_attempt_at = NULL WHERE id = :id", { replacements: { id, status, error: error ? String(error).slice(0, 500) : null } });

const runOne = async (job) => {
  if (await orderIsSaved(job.order_id)) return { done: true, note: "an order exists for this id, so the reservation is in use and is kept" };
  let ref = job.reservation_ref;
  if (job.kind === "resolve_reservation" && !ref) {
    const lines = typeof job.lines_json === "string" ? JSON.parse(job.lines_json) : job.lines_json;
    const answer = await reserveStock({ key: `reserve:${job.order_id}`, orderId: job.order_id, correlationId: job.correlation_id, lines: lines || [] });
    ref = answer.reservation_ref;
    if (!ref) return { done: true, note: "Inventory holds nothing for this order" };
  }
  await releaseStock({ key: `release:${job.order_id}`, orderId: job.order_id, reservationRef: ref, correlationId: job.correlation_id });
  return { done: true, note: `reservation ${ref} released` };
};

export const processCompensations = async ({ limit = 20 } = {}) => {
  const jobs = await select(
    `SELECT * FROM integration_compensations WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()) ORDER BY id LIMIT ${Number(limit) | 0}`
  );
  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    // claim: if the process stops half-way, the job comes back after 5 minutes
    const [, claimed] = await sequelize.query("UPDATE integration_compensations SET next_attempt_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE) WHERE id = :id AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())", { replacements: { id: job.id } });
    if (!claimed?.affectedRows && claimed !== 1) continue;
    try {
      const outcome = await runOne(job);
      await finish(job.id, "done", outcome.note);
      done += 1;
    } catch (err) {
      const attempts = job.attempts + 1;
      failed += 1;
      if (attempts >= MAX_ATTEMPTS) {
        await sequelize.query("UPDATE integration_compensations SET status = 'dead', attempts = :attempts, last_error = :error, next_attempt_at = NULL WHERE id = :id", { replacements: { id: job.id, attempts, error: String(err.message).slice(0, 500) } });
      } else {
        await sequelize.query("UPDATE integration_compensations SET attempts = :attempts, last_error = :error, next_attempt_at = DATE_ADD(NOW(), INTERVAL :minutes MINUTE) WHERE id = :id", { replacements: { id: job.id, attempts, error: String(err.message).slice(0, 500), minutes: RETRY_DELAYS_MINUTES[attempts - 1] } });
      }
    }
  }
  return { checked: jobs.length, done, failed };
};

// Manual retry of a dead compensation (Integration Health).
export const retryCompensation = async (id) => {
  const [, meta] = await sequelize.query("UPDATE integration_compensations SET status = 'pending', attempts = 0, next_attempt_at = NOW() WHERE id = :id AND status = 'dead'", { replacements: { id } });
  return (meta?.affectedRows ?? meta) > 0;
};
