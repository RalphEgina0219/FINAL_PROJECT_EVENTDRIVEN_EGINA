/*
 * Event publisher (blueprint §13). CRM never calls another app inline for business events: it writes them to
 * integration_outbox in the SAME transaction as the change, one row per target. The envelope carries event_id,
 * event_type, schema_version, source, occurred_at, entity_id, correlation_id, idempotency_key and data (TC-15).
 *
 * Idempotency: (target, idempotency_key) is unique, so publishing the same event twice (a retried request, a duplicate
 * SaleCompleted) inserts nothing the second time and returns 0.
 *
 * What happens to a row depends on the target's mode (config INTEGRATION_*_MODE):
 *   mock      -> status mock_delivered, is_mock = 1. NOTHING IS SENT, ever. The row only shows what would be sent.
 *   disabled  -> status skipped_disabled.
 *   live      -> status pending; services/integration/outboxDispatcher.js sends it (signed POST, retries +1m/+5m/+15m/+1h/+6h, dead-letter queue).
 * The data of every event follows docs/integration-contract.md §4 (money as decimal strings, times as ISO-8601 with an offset).
 */
import crypto from "crypto";
import { sequelize } from "../models/index.js";
import { modeOf, SYSTEMS } from "./integration/adapterBase.js";
import { isoWithOffset } from "./integration/signing.js";

export const EVENT_TARGETS = {
  OrderConfirmed: ["inventory"],
  SaleCompleted: ["inventory", "accounting"],
  SaleCancelled: ["inventory", "accounting"],
  RefundRecorded: ["inventory", "accounting"],
  EmployeeRequestDecided: ["hr"], // P7: the decision on a leave / attendance / overtime request goes back to HR/ESS
};

const STATUS_BY_MODE = { mock: "mock_delivered", disabled: "skipped_disabled", live: "pending" };

// forceMock: the record itself came from a MOCK source (for example a mock ESS request), so its events are stored as mock and never sent, whatever the adapter mode is.
export const publishEvent = async ({ type, entityId, correlationId, idempotencyKey, data, at = null, isDemo = false, forceMock = false, transaction }) => {
  const targets = EVENT_TARGETS[type];
  if (!targets) throw new Error(`Unknown event type ${type}`);
  const occurred = at || new Date();
  let inserted = 0;
  for (const key of targets) {
    const mode = forceMock ? "mock" : modeOf(key);
    const eventId = crypto.randomUUID();
    const envelope = {
      event_id: eventId, event_type: type, schema_version: 1, source: "johnvivz_crm", occurred_at: isoWithOffset(occurred),
      entity_id: String(entityId), correlation_id: correlationId, idempotency_key: idempotencyKey, data,
    };
    const [, meta] = await sequelize.query(
      `INSERT IGNORE INTO integration_outbox (event_id, event_type, schema_version, source, target, occurred_at, entity_id, correlation_id, idempotency_key,
                                              payload, status, attempts, is_mock, created_at)
       VALUES (?, ?, 1, 'johnvivz_crm', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      { replacements: [eventId, type, SYSTEMS[key], occurred, String(entityId), correlationId, idempotencyKey, JSON.stringify(envelope), STATUS_BY_MODE[mode] || "pending", mode === "mock" ? 1 : 0, occurred], transaction }
    );
    if (meta === 1 || meta?.affectedRows === 1) inserted += 1;
  }
  return inserted;
};
