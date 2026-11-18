/*
 * Strict checks of what CRM sends, written straight from docs/integration-contract.md §3 and §4 and independent of CRM's own code.
 * The fake HR / Inventory / Accounting servers (fakeApps.mjs) use them, so a field name or format that drifts from the contract
 * makes the fake answer 400 and the contract test fails. Returns a list of problems (empty = the event follows the contract).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const MONEY = /^\d+\.\d{2}$/;

const isStr = (v) => typeof v === "string" && v.length > 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

const field = (errors, where, obj, name, test, what) => {
  if (!obj || !test(obj[name])) errors.push(`${where}${name} must be ${what}`);
};
const money = (errors, where, obj, name) => field(errors, where, obj, name, (v) => typeof v === "string" && MONEY.test(v), "a decimal string such as \"285.00\"");
const uuid = (errors, where, obj, name) => field(errors, where, obj, name, (v) => typeof v === "string" && UUID.test(v), "a UUID");
const iso = (errors, where, obj, name) => field(errors, where, obj, name, (v) => typeof v === "string" && ISO.test(v), "an ISO-8601 time with an offset");
const list = (errors, where, obj, name, min = 0) => {
  const v = obj?.[name];
  if (!Array.isArray(v) || v.length < min) { errors.push(`${where}${name} must be a list${min ? " with at least one entry" : ""}`); return []; }
  return v;
};

const DATA = {
  OrderConfirmed(d, e) {
    uuid(e, "data.", d, "order_id"); field(e, "data.", d, "order_no", isStr, "text"); uuid(e, "data.", d, "customer_id");
    field(e, "data.", d, "channel", isStr, "text"); field(e, "data.", d, "fulfillment", isStr, "text"); field(e, "data.", d, "reservation_id", isStr, "text"); field(e, "data.", d, "currency", (v) => v === "PHP", "PHP");
    list(e, "data.", d, "items", 1).forEach((i, n) => {
      field(e, `data.items[${n}].`, i, "line_no", Number.isInteger, "a whole number"); field(e, `data.items[${n}].`, i, "product_id", isStr, "text"); field(e, `data.items[${n}].`, i, "sku", isStr, "text");
      field(e, `data.items[${n}].`, i, "quantity", isNum, "a number above 0"); money(e, `data.items[${n}].`, i, "unit_price"); field(e, `data.items[${n}].`, i, "is_vatable", (v) => typeof v === "boolean", "true or false");
    });
    for (const k of ["subtotal", "discount_total", "grand_total"]) money(e, "data.totals.", d.totals, k);
  },
  SaleCompleted(d, e) {
    uuid(e, "data.", d, "sale_id"); uuid(e, "data.", d, "order_id"); field(e, "data.", d, "transaction_no", isStr, "text"); uuid(e, "data.", d, "customer_id"); iso(e, "data.", d, "completed_at");
    field(e, "data.", d, "payment_status", isStr, "text"); field(e, "data.", d, "currency", (v) => v === "PHP", "PHP");
    list(e, "data.", d, "items", 1).forEach((i, n) => {
      const w = `data.items[${n}].`;
      field(e, w, i, "line_no", Number.isInteger, "a whole number"); field(e, w, i, "product_id", isStr, "text"); field(e, w, i, "sku", isStr, "text"); field(e, w, i, "quantity", isNum, "a number above 0");
      for (const k of ["unit_price", "discount_amount", "line_total"]) money(e, w, i, k);
      field(e, w, i, "is_vatable", (v) => typeof v === "boolean", "true or false");
    });
    list(e, "data.", d, "discounts").forEach((x, n) => { field(e, `data.discounts[${n}].`, x, "code", isStr, "text"); field(e, `data.discounts[${n}].`, x, "type", isStr, "text"); money(e, `data.discounts[${n}].`, x, "amount"); });
    for (const k of ["gross", "discount_total", "net"]) money(e, "data.totals.", d.totals, k);
    list(e, "data.", d, "payments", 1).forEach((p, n) => { field(e, `data.payments[${n}].`, p, "method", isStr, "text"); field(e, `data.payments[${n}].`, p, "reference_no", (v) => v === null || isStr(v), "text or null"); money(e, `data.payments[${n}].`, p, "amount"); iso(e, `data.payments[${n}].`, p, "paid_at"); });
  },
  SaleCancelled(d, e) {
    uuid(e, "data.", d, "order_id"); field(e, "data.", d, "sale_id", (v) => v === null || UUID.test(v), "a UUID or null"); field(e, "data.", d, "reason", isStr, "text"); iso(e, "data.", d, "cancelled_at");
    list(e, "data.", d, "release_items").forEach((i, n) => { field(e, `data.release_items[${n}].`, i, "product_id", isStr, "text"); field(e, `data.release_items[${n}].`, i, "quantity", isNum, "a number above 0"); });
  },
  RefundRecorded(d, e) {
    uuid(e, "data.", d, "refund_id"); uuid(e, "data.", d, "sale_id"); uuid(e, "data.", d, "order_id"); money(e, "data.", d, "amount"); field(e, "data.", d, "reason", isStr, "text");
    field(e, "data.", d, "approved_by_employee_id", (v) => v === null || isStr(v), "text or null"); iso(e, "data.", d, "recorded_at");
    list(e, "data.", d, "return_items").forEach((i, n) => { field(e, `data.return_items[${n}].`, i, "product_id", isStr, "text"); field(e, `data.return_items[${n}].`, i, "quantity", isNum, "a number above 0"); field(e, `data.return_items[${n}].`, i, "condition", isStr, "text"); });
  },
};

// P7 (DRAFT, docs/integration-contract.md §4): the decision on an employee request, sent back to HR/ESS.
DATA.EmployeeRequestDecided = (d, e) => {
  field(e, "data.", d, "request_id", isStr, "text");
  field(e, "data.", d, "request_type", (v) => ["leave", "attendance_correction", "overtime"].includes(v), "leave, attendance_correction or overtime");
  field(e, "data.", d, "employee_id", isStr, "text");
  field(e, "data.", d, "decision", (v) => ["approved", "rejected", "returned"].includes(v), "approved, rejected or returned");
  field(e, "data.", d, "decided_by_employee_id", (v) => v === null || isStr(v), "text or null");
  iso(e, "data.", d, "decided_at");
  field(e, "data.", d, "reason", (v) => v === null || isStr(v), "text or null");
  if (d && ["rejected", "returned"].includes(d.decision) && !isStr(d.reason)) e.push("data.reason is required when the decision is rejected or returned");
};

export const contractEventTypes = Object.keys(DATA);

export const checkEnvelope = (env, { expectSource = "johnvivz_crm" } = {}) => {
  const errors = [];
  if (!env || typeof env !== "object") return ["the body is not a JSON object"];
  uuid(errors, "", env, "event_id");
  field(errors, "", env, "event_type", (v) => contractEventTypes.includes(v), `one of ${contractEventTypes.join(", ")}`);
  field(errors, "", env, "schema_version", (v) => v === 1, "1");
  field(errors, "", env, "source", (v) => v === expectSource, expectSource);
  iso(errors, "", env, "occurred_at");
  field(errors, "", env, "entity_id", isStr, "text");
  uuid(errors, "", env, "correlation_id");
  field(errors, "", env, "idempotency_key", (v) => isStr(v) && v.includes(":"), "text such as SaleCompleted:<id>");
  if (!env.data || typeof env.data !== "object") errors.push("data must be an object");
  else if (DATA[env.event_type]) DATA[env.event_type](env.data, errors);
  if (env.event_type && env.idempotency_key && isStr(env.idempotency_key) && !env.idempotency_key.startsWith(`${env.event_type}:`)) errors.push("idempotency_key must start with the event type and a colon");
  return errors;
};
