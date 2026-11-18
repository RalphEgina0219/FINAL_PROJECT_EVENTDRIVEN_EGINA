/*
 * Inbox (blueprint §13, docs/integration-contract.md §5). Events other apps send to POST /api/integration/v1/events are stored in
 * integration_inbox FIRST and processed after. Duplicate protection is enforced by the database: event_id is UNIQUE, and so is
 * (source, idempotency_key), so a redelivered or replayed event is answered "duplicate" and never processed twice.
 *
 *   received -> processed | ignored (valid, nothing to do) | failed (will be retried, up to 5 times) | dead (kept for a manual reprocess)
 *
 * The publisher is authenticated by the HMAC signature; each publisher may send only its own event types, and the envelope's
 * `source` must be the authenticated client. HR payloads are stripped of any restricted field (salary, bank, government ID,
 * payroll) BEFORE they are stored: CRM must not hold that data, not even in a log.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../../models/index.js";
import { SYSTEMS, logIntegration, keyOfTarget, modeOf } from "./adapterBase.js";
import { applyEmployeeStatus, applyEmployeeSnapshot, applyDepartmentSnapshot, applyDepartmentUpdate, applyPositionSnapshot, applyPositionUpdate, lookupEmployee } from "./hrAdapter.js";
import { applyProductSnapshot } from "./inventoryAdapter.js";
import { approvalsEnabled, receiveRequest, revalidatePending, RequestFormatError } from "../approvalService.js";

export const MAX_INBOX_ATTEMPTS = 5;

export const PUBLISHER_EVENTS = {
  [SYSTEMS.inventory]: ["StockReserved", "StockIssued", "LowStockDetected", "ProductCreated", "ProductUpdated", "ProductPriceUpdated", "StockUpdated", "StockUnavailable"],
  [SYSTEMS.hr]: ["EmployeeCreated", "EmployeeUpdated", "EmployeeStatusChanged", "DepartmentCreated", "DepartmentUpdated", "DepartmentDeactivated",
    "PositionCreated", "PositionUpdated", "PositionDeactivated", "EmployeeRequestSubmitted"],
  [SYSTEMS.accounting]: [], // the contract defines no Accounting event yet (docs/integration-contract.md §5)
};

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const affected = (meta) => Number(meta?.affectedRows ?? meta ?? 0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

// Data CRM must never store (master prompt §VIII): any key that looks like one of these is removed from the payload.
const RESTRICTED_KEY = /(salary|wage|payroll|pay_rate|basic_pay|bank|account_no|account_number|iban|(^|_)tin($|_)|(^|_)sss($|_)|philhealth|pag_?ibig|gsis|passport|government|national_id|(^|_)ssn($|_)|tax_id)/i;

export const redactRestricted = (value, counter = { n: 0 }) => {
  if (Array.isArray(value)) return value.map((v) => redactRestricted(v, counter));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (RESTRICTED_KEY.test(k)) { counter.n += 1; continue; }
      out[k] = redactRestricted(v, counter);
    }
    return out;
  }
  return value;
};

// A problem that retrying cannot fix (malformed data): the event goes to `dead` at once.
class PermanentError extends Error {}
// A valid event that needs no action.
class IgnoredEvent extends Error {}

// ---------------------------------------------------------------- envelope

export const validateEnvelope = (e, client) => {
  const errors = [];
  if (!e || typeof e !== "object" || Array.isArray(e)) return ["The body must be a JSON object (the event envelope)."];
  if (typeof e.event_id !== "string" || !UUID.test(e.event_id)) errors.push("event_id must be a UUID.");
  if (typeof e.event_type !== "string" || !/^[A-Za-z][A-Za-z0-9]{1,59}$/.test(e.event_type)) errors.push("event_type is required (letters and digits, up to 60).");
  if (!Number.isInteger(e.schema_version) || e.schema_version !== 1) errors.push("schema_version must be 1 (the only version CRM understands).");
  if (typeof e.source !== "string" || e.source !== client) errors.push(`source must be "${client}", the authenticated sender.`);
  if (typeof e.occurred_at !== "string" || !ISO.test(e.occurred_at) || !Number.isFinite(Date.parse(e.occurred_at))) errors.push("occurred_at must be an ISO-8601 time with an offset.");
  if (typeof e.entity_id !== "string" || !e.entity_id || e.entity_id.length > 64) errors.push("entity_id is required (up to 64 characters).");
  if (e.correlation_id !== undefined && e.correlation_id !== null && (typeof e.correlation_id !== "string" || !UUID.test(e.correlation_id))) errors.push("correlation_id must be a UUID when present.");
  if (typeof e.idempotency_key !== "string" || !e.idempotency_key || e.idempotency_key.length > 160) errors.push("idempotency_key is required (up to 160 characters).");
  if (!e.data || typeof e.data !== "object" || Array.isArray(e.data)) errors.push("data must be an object.");
  if (!errors.length && !PUBLISHER_EVENTS[client]?.includes(e.event_type)) errors.push(`${client} may not send ${e.event_type} to CRM.`);
  return errors;
};

// ---------------------------------------------------------------- processors

const need = (data, ...fields) => {
  const missing = fields.filter((f) => data[f] === undefined || data[f] === null || data[f] === "");
  if (missing.length) throw new PermanentError(`The event data is missing: ${missing.join(", ")}.`);
};
const nonNegative = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new PermanentError(`${name} must be a number of 0 or more.`);
  return n;
};

const orderOf = async (orderId) => {
  const [o] = await select("SELECT id, status, reservation_status, inventory_reservation_ref FROM sales_orders WHERE order_id = :orderId", { orderId });
  if (!o) throw new Error(`Order ${orderId} is not in CRM (yet); will be retried.`); // a reservation event can arrive before the order is saved
  return o;
};

const updateProductRow = async (data, sets) => {
  need(data, "product_id");
  const [, meta] = await sequelize.query(`UPDATE product_references SET ${sets}, availability_checked_at = NOW(), last_synced_at = NOW() WHERE product_id = :id`, { replacements: { id: String(data.product_id), qty: data.available_qty === undefined ? null : Number(data.available_qty), price: data.selling_price === undefined ? null : Number(data.selling_price) } });
  if (!affected(meta)) throw new IgnoredEvent(`Product ${data.product_id} is not in the snapshot yet; refresh the product snapshot.`);
};

const PROCESSORS = {
  async StockReserved(data) {
    need(data, "order_id", "reservation_id");
    const o = await orderOf(data.order_id);
    if (o.reservation_status === "issued") throw new IgnoredEvent("Stock was already issued for this order.");
    await sequelize.query("UPDATE sales_orders SET reservation_status = 'reserved', inventory_reservation_ref = COALESCE(inventory_reservation_ref, :ref) WHERE id = :id", { replacements: { id: o.id, ref: String(data.reservation_id).slice(0, 64) } });
    return `order ${data.order_id}: reserved`;
  },
  async StockIssued(data) {
    need(data, "order_id");
    const o = await orderOf(data.order_id);
    if (o.status !== "completed") throw new Error("The order is not completed in CRM yet; will be retried.");
    await sequelize.query("UPDATE sales_orders SET reservation_status = 'issued' WHERE id = :id", { replacements: { id: o.id } });
    return `order ${data.order_id}: stock issued`;
  },
  async LowStockDetected(data) {
    await updateProductRow(data, "low_stock = 1, available_qty = COALESCE(:qty, available_qty)");
    return `product ${data.product_id}: flagged as low stock`;
  },
  async StockUpdated(data) {
    need(data, "available_qty");
    nonNegative(data.available_qty, "available_qty");
    await updateProductRow(data, "available_qty = :qty");
    return `product ${data.product_id}: available ${data.available_qty}`;
  },
  async StockUnavailable(data) {
    await updateProductRow(data, "available_qty = 0, low_stock = 0");
    return `product ${data.product_id}: out of stock`;
  },
  async ProductPriceUpdated(data) {
    need(data, "product_id", "selling_price");
    nonNegative(data.selling_price, "selling_price");
    await updateProductRow(data, "selling_price = :price");
    return `product ${data.product_id}: price ${Number(data.selling_price).toFixed(2)}`;
  },
  async ProductCreated(data, ctx) {
    need(data, "product_id", "name", "selling_price");
    nonNegative(data.selling_price, "selling_price");
    await applyProductSnapshot(data, { eventId: ctx.eventId });
    return `product ${data.product_id}: snapshot saved`;
  },
  async ProductUpdated(data, ctx) { return PROCESSORS.ProductCreated(data, ctx); },

  async EmployeeCreated(data, ctx) {
    need(data, "employee_id", "full_name", "employment_status");
    await applyEmployeeSnapshot(data, { source: ctx.source });
    // employee account flow: a CRM-department hire gets a deactivated staff account right away (the HR pull runs one pass for all)
    if (!String(ctx.source).startsWith("hr-sync")) {
      const { provisionStaffAccounts } = await import("../staffAccountService.js");
      const out = await provisionStaffAccounts({ source: "HR event " + ctx.eventId, employeeId: String(data.employee_id) });
      if (out.created.length) return `employee ${data.employee_id}: saved; CRM staff account created (waiting for ESS registration)`;
    }
    return `employee ${data.employee_id}: saved`;
  },
  async EmployeeUpdated(data, ctx) { return PROCESSORS.EmployeeCreated(data, ctx); },
  async EmployeeStatusChanged(data, ctx) {
    need(data, "employee_id", "employment_status");
    const [known] = await select("SELECT employee_id FROM employee_references WHERE employee_id = :id", { id: String(data.employee_id) });
    if (!known) {
      const found = await lookupEmployee(String(data.employee_id)); // unknown to CRM: ask HR once, then apply
      if (!found) throw new PermanentError(`Employee ${data.employee_id} is unknown to CRM and HR did not return it.`);
      await applyEmployeeSnapshot({ ...found, employee_id: String(data.employee_id) }, { source: ctx.source });
    }
    const result = await applyEmployeeStatus({ employeeId: String(data.employee_id), status: data.employment_status, source: ctx.source });
    if (result.changed) await revalidatePending(); // an approver who just left must not keep a pending request
    return `employee ${data.employee_id}: ${result.changed ? `status now ${data.employment_status}${result.revoked ? ", CRM access revoked" : ""}${result.restored ? ", HR block lifted" : ""}` : "status unchanged"}`;
  },

  async DepartmentCreated(data, ctx) {
    need(data, "department_id", "name");
    await applyDepartmentSnapshot(data, { source: ctx.source });
    return `department ${data.department_id}: saved`;
  },
  async DepartmentUpdated(data, ctx) {
    need(data, "department_id");
    const [known] = await select("SELECT department_id FROM department_references WHERE department_id = :id", { id: String(data.department_id) });
    if (!known) return PROCESSORS.DepartmentCreated(data, ctx);
    await applyDepartmentUpdate({ departmentId: String(data.department_id), name: data.name, code: data.code, isActive: data.is_active, source: ctx.source });
    return `department ${data.department_id}: updated`;
  },
  async DepartmentDeactivated(data, ctx) {
    need(data, "department_id");
    await applyDepartmentUpdate({ departmentId: String(data.department_id), isActive: false, source: ctx.source });
    return `department ${data.department_id}: deactivated`;
  },
  async PositionCreated(data, ctx) {
    need(data, "position_id", "title");
    await applyPositionSnapshot(data, { source: ctx.source });
    return `position ${data.position_id}: saved`;
  },
  async PositionUpdated(data, ctx) {
    need(data, "position_id");
    const [known] = await select("SELECT position_id FROM position_references WHERE position_id = :id", { id: String(data.position_id) });
    if (!known) return PROCESSORS.PositionCreated(data, ctx);
    await applyPositionUpdate({ positionId: String(data.position_id), title: data.title, departmentId: data.department_id, isActive: data.is_active, source: ctx.source });
    return `position ${data.position_id}: updated`;
  },
  async PositionDeactivated(data, ctx) {
    need(data, "position_id");
    await applyPositionUpdate({ positionId: String(data.position_id), isActive: false, source: ctx.source });
    return `position ${data.position_id}: deactivated`;
  },
  // P7: a leave / attendance / overtime request from HR/ESS. Routed by services/approvalService.js; CRM never creates the HR record itself.
  async EmployeeRequestSubmitted(data, ctx) {
    if (!approvalsEnabled()) throw new IgnoredEvent("Approvals are not enabled yet (APPROVALS_ENABLED=false): the request was stored but not routed. Turn the feature on and press Reprocess.");
    try {
      const out = await receiveRequest({ data, eventId: ctx.eventId, isMock: ctx.isMock });
      if (out.duplicate) return `request ${data.request_id}: already received, nothing changed`;
      return `request ${data.request_id}: ${out.status === "pending" ? `routed to the ${out.approverRole === "crm_manager" ? "CRM Manager" : "Team Leader"}` : `exception queue (${out.exceptionReason})`}${out.superseded ? `; ${out.superseded.note}` : ""}`;
    } catch (err) {
      if (err instanceof RequestFormatError) throw new PermanentError(err.message);
      throw err;
    }
  },
};

// ---------------------------------------------------------------- processing

const setResult = (id, status, note, { attempts = 1 } = {}) =>
  sequelize.query(
    "UPDATE integration_inbox SET status = :status, attempts = attempts + :attempts, last_error = :note, processed_at = IF(:status IN ('processed','ignored'), NOW(), processed_at) WHERE id = :id",
    { replacements: { id, status, note: note ? String(note).slice(0, 500) : null, attempts } });

// Where an event came from, for the audit log: the HR pull sync and the polled Inventory outbox (interim dialects, contract §12) make their
// own events; anything else is a pushed event and is named by its event_id.
export const ORIGINS = { "hr-sync:": "hr-sync", "inventory-outbox:": "inventory-outbox" };
const originOf = (row) => {
  const prefix = Object.keys(ORIGINS).find((p) => String(row.idempotency_key || "").startsWith(p));
  return prefix ? `${ORIGINS[prefix]} ${row.event_id}` : row.event_id;
};

// Runs the processor for one stored event and records the outcome. Never throws.
export const processInboxRow = async (row) => {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  const handler = PROCESSORS[row.event_type];
  const key = keyOfTarget(row.source);
  const mode = key ? modeOf(key) : "live";
  let status;
  let note;
  try {
    if (!handler) throw new IgnoredEvent(`No handler for ${row.event_type}.`);
    note = await handler(payload.data || {}, { eventId: row.event_id, source: originOf(row), isMock: Boolean(row.is_mock) });
    status = "processed";
  } catch (err) {
    if (err instanceof IgnoredEvent) { status = "ignored"; note = err.message; }
    else if (err instanceof PermanentError) { status = "dead"; note = err.message; }
    else {
      status = row.attempts + 1 >= MAX_INBOX_ATTEMPTS ? "dead" : "failed";
      note = err.message;
    }
  }
  await setResult(row.id, status, note);
  await logIntegration({ direction: "inbound_event", system: row.source, endpoint: row.event_type, eventId: row.event_id, correlationId: row.correlation_id || null, success: status === "processed" || status === "ignored", mode, message: `${status}: ${note}`.slice(0, 480) });
  return { status, note };
};

/*
 * Stores a validated envelope and processes it. Returns { duplicate: true } when the event_id or the (source, idempotency_key)
 * pair is already in the inbox. The caller has already authenticated the sender and validated the envelope.
 */
export const receiveEvent = async (envelope, { isMock = false } = {}) => {
  const counter = { n: 0 };
  const clean = redactRestricted(envelope, counter);
  const [, meta] = await sequelize.query(
    `INSERT IGNORE INTO integration_inbox (event_id, event_type, schema_version, source, occurred_at, entity_id, correlation_id, idempotency_key, payload, status, attempts, is_mock, received_at)
     VALUES (:eventId, :type, 1, :source, :occurred, :entity, :corr, :idem, :payload, 'received', 0, :mock, NOW())`,
    { replacements: { eventId: envelope.event_id, type: envelope.event_type, source: envelope.source, occurred: new Date(envelope.occurred_at), entity: envelope.entity_id, corr: envelope.correlation_id || null, idem: envelope.idempotency_key, payload: JSON.stringify(clean), mock: isMock ? 1 : 0 } });
  if (!affected(meta)) {
    await logIntegration({ direction: "inbound_event", system: envelope.source, endpoint: envelope.event_type, eventId: envelope.event_id, correlationId: envelope.correlation_id || null, success: true, mode: "live", message: "duplicate: already in the inbox, not processed again" });
    return { duplicate: true };
  }
  const [row] = await select("SELECT * FROM integration_inbox WHERE event_id = :id", { id: envelope.event_id });
  if (counter.n) await logIntegration({ direction: "inbound_event", system: envelope.source, endpoint: envelope.event_type, eventId: envelope.event_id, success: true, mode: "live", message: `Removed ${counter.n} restricted field(s) before storing the payload` });
  const result = await processInboxRow(row);
  return { duplicate: false, ...result };
};

// Retries events that failed (called by the 5-minute job). Events that keep failing become `dead` after MAX_INBOX_ATTEMPTS.
export const processInboxBacklog = async ({ limit = 50 } = {}) => {
  const rows = await select(`SELECT * FROM integration_inbox WHERE status IN ('received','failed') AND attempts < ${MAX_INBOX_ATTEMPTS} ORDER BY id LIMIT ${Number(limit) | 0}`);
  let processed = 0;
  for (const row of rows) if ((await processInboxRow(row)).status === "processed") processed += 1;
  return { checked: rows.length, processed };
};

// Manual reprocess of one failed, dead or ignored event (Integration Health). An ignored one is safe to run again: every processor is idempotent.
export const reprocessInboxEvent = async (id) => {
  const [, meta] = await sequelize.query("UPDATE integration_inbox SET status = 'received', attempts = 0 WHERE id = :id AND status IN ('failed','dead','ignored')", { replacements: { id } });
  if (!affected(meta)) return null;
  const [row] = await select("SELECT * FROM integration_inbox WHERE id = :id", { id });
  return processInboxRow(row);
};
