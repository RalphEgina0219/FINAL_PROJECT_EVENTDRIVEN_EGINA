// Employee request approvals (P7): the Approvals Queue for Team Leaders and the CRM Manager, and the setup-only mock ESS request simulator.
// All rules (routing, "nobody approves their own request", comments, events) live in services/approvalService.js; this file only reads the
// form, calls the service and shows the result. Every page says so plainly when APPROVALS_ENABLED is false.
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { AppError } from "../helpers/errors.js";
import { buildPagination } from "../helpers/pagination.js";
import { clean, toId, toPage, oneOf } from "../helpers/validators.js";
import { platformStatus } from "../services/dashboardService.js";
import { paths } from "./configController.js";
import {
  approvalsEnabled, listRequests, getRequest, decideRequest, returnToHr, assignApprover, assignableApprovers, history, revalidatePending, approvalCounts,
  recentRequests, mockEnvelope, myRequests, myRequest, REQUEST_TYPES, STATUS_LABELS, VIEWS, MIN_COMMENT,
} from "../services/approvalService.js";
import { receiveEvent } from "../services/integration/inboxService.js";
import { hrMode } from "../services/integration/hrAdapter.js";
import { audit } from "../services/auditService.js";

const render = (req, res, view, data) => res.render(view, { ...data, cfg: paths(req), platform: platformStatus(), tab: "approvals", minComment: MIN_COMMENT });

const typeOptions = () => Object.entries(REQUEST_TYPES).map(([value, label]) => ({ value, label }));
const statusOptions = () => Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }));

const FIELD_LABELS = {
  replaces_request_id: "Replaces request", leave_type: "Leave type", start_date: "From", end_date: "To", days: "Days", date: "Date", time_in: "Time in", time_out: "Time out", start_time: "Start", end_time: "End", hours: "Hours", reason: "Reason",
};

// ---------------------------------------------------------------- the queue

export const index = async (req, res) => {
  if (!approvalsEnabled()) return render(req, res, "approvals/disabled", { title: req.user.role === "crm_manager" ? "Settings" : "Approvals Queue" });
  await revalidatePending();
  const counts = await approvalCounts(req.user);
  const isManager = req.user.role === "crm_manager";
  const allowed = isManager ? ["queue", "exceptions", "decided", "all"] : ["queue", "decided", "all"];
  const view = oneOf(req.query.view, allowed) || "queue";
  const q = clean(req.query.q, 80);
  const type = oneOf(req.query.type, Object.keys(REQUEST_TYPES)) || "";
  const status = oneOf(req.query.status, Object.keys(STATUS_LABELS)) || "";
  const first = await listRequests(req.user, { view, q, type, status, limit: 1, offset: 0 });
  const pagination = buildPagination({ total: first.total, page: toPage(req.query.page), perPage: 15, basePath: "/crm/approvals", query: { view, q, type, status } });
  const { rows } = await listRequests(req.user, { view, q, type, status, limit: pagination.limit, offset: pagination.offset });
  render(req, res, "approvals/index", {
    title: isManager ? "Settings" : "Approvals Queue", rows, counts, view, q, type, status, pagination, isManager,
    views: allowed.map((v) => ({ value: v, label: VIEWS[v], active: v === view })), typeOptions: typeOptions(), statusOptions: statusOptions(),
    hasFilters: Boolean(q || type || status),
  });
};

export const show = async (req, res) => {
  if (!approvalsEnabled()) return render(req, res, "approvals/disabled", { title: req.user.role === "crm_manager" ? "Settings" : "Approvals Queue" });
  const id = toId(req.params.id);
  const request = id ? await getRequest(req.user, id) : null;
  if (!request) return res.status(404).render("error", { title: "Not found", status: 404, message: "This request does not exist or is not routed to you." });
  const order = Object.keys(FIELD_LABELS);
  const fields = Object.entries(request.payload).filter(([, v]) => v !== null && v !== "" && v !== undefined).sort(([x], [y]) => (order.indexOf(x) + 99) % 99 - (order.indexOf(y) + 99) % 99).map(([k, v]) => ({ label: FIELD_LABELS[k] || k, value: String(v) }));
  render(req, res, "approvals/show", {
    title: request.request_id, r: request, fields, assignable: request.canManage ? await assignableApprovers(request) : null, history: await history(request.request_id),
  });
};

const back = (req, res, id) => res.redirect(`/crm/approvals/${id}`);

const run = (action) => async (req, res) => {
  const id = toId(req.params.id);
  if (!approvalsEnabled()) { req.flash("error_msg", "Approvals are not enabled yet."); return res.redirect("/crm/approvals"); }
  try {
    const message = await action(req, id);
    req.flash("success_msg", message);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.status === 404) return res.status(404).render("error", { title: "Not found", status: 404, message: "This request does not exist or is not routed to you." });
    if (err.status === 403) return res.status(403).render("error", { title: "Access denied", status: 403, message: err.message });
    req.flash("error_msg", err.message);
  }
  return back(req, res, id);
};

export const decide = run(async (req, id) => {
  const decision = oneOf(req.body.decision, ["approve", "reject"]);
  const out = await decideRequest({ id, user: req.user, decision, comment: clean(req.body.comment, 255), req });
  return `The request was ${out.status}. The decision is sent back to HR through the outbox${out.request.is_mock ? " (mock source: it is recorded and never sent)" : ""}.`;
});

export const sendBack = run(async (req, id) => {
  await returnToHr({ id, user: req.user, comment: clean(req.body.comment, 255), req });
  return "The request was returned to HR without a decision.";
});

export const assign = run(async (req, id) => {
  const approver = req.body.approver === "manager" ? "manager" : toId(req.body.approver);
  if (!approver) throw new AppError("Choose who should decide this request.", 422);
  await assignApprover({ id, user: req.user, approver, req });
  return "The request was assigned and the approver was notified.";
});

// ---------------------------------------------------------------- setup: mock ESS requests

const mockReady = () => approvalsEnabled() && hrMode() === "mock";

const mockEmployees = () => sequelize.query("SELECT employee_id, full_name FROM employee_references WHERE is_mock = 1 ORDER BY full_name", { type: QueryTypes.SELECT });

export const mockPage = async (req, res) => {
  res.render("setup/approvals", {
    title: "Mock ESS Requests", ready: mockReady(), enabled: approvalsEnabled(), hrMode: hrMode(), employees: await mockEmployees(), typeOptions: typeOptions(),
    recent: (await recentRequests(10)).map((r) => ({ ...r, received: r.received_at })),
  });
};

// Builds the HR/ESS request exactly as the contract describes it (docs/integration-contract.md §5), then sends it through the SAME inbox and code as a signed live request.
export const mockCreate = async (req, res) => {
  if (!mockReady()) {
    req.flash("error_msg", !approvalsEnabled() ? "Approvals are not enabled (APPROVALS_ENABLED=false)." : "The mock ESS is available only while HR is in mock mode.");
    return res.redirect("/setup/approvals");
  }
  const b = req.body;
  const type = oneOf(b.request_type, Object.keys(REQUEST_TYPES));
  if (!type) { req.flash("error_msg", "Choose a request type."); return res.redirect("/setup/approvals"); }
  const employeeId = b.employee_id === "__unknown" ? "MOCK-EMP-9001" : clean(b.employee_id, 64);
  const data = { request_id: `MOCK-REQ-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`, request_type: type, employee_id: employeeId, reason: clean(b.reason, 255) };
  if (clean(b.replaces_request_id, 64)) data.replaces_request_id = clean(b.replaces_request_id, 64); // a changed request (DRAFT): the old one becomes superseded
  if (type === "leave") Object.assign(data, { leave_type: clean(b.leave_type, 40), start_date: clean(b.start_date, 10), end_date: clean(b.end_date || b.start_date, 10), days: clean(b.days, 6) });
  else if (type === "attendance_correction") Object.assign(data, { date: clean(b.date, 10), time_in: clean(b.time_in, 5), time_out: clean(b.time_out, 5) });
  else Object.assign(data, { date: clean(b.date, 10), start_time: clean(b.start_time, 5), end_time: clean(b.end_time, 5), hours: clean(b.hours, 5) });
  const out = await receiveEvent(mockEnvelope(data), { isMock: true });
  await audit(req, "mock_ess_request_sent", { recordType: "approval_request", recordId: data.request_id, details: `${out.status}: ${out.note}`.slice(0, 480) });
  req.flash(out.status === "processed" ? "success_msg" : "error_msg", out.status === "processed" ? `MOCK ESS: ${out.note}.` : `MOCK ESS request was ${out.status}: ${out.note}`);
  res.redirect("/setup/approvals");
};

// ---------------------------------------------------------------- My Requests (staff: Agent, Team Leader, CRM Manager)
// A read-only copy of the signed-in person's OWN requests. Filing, changing and cancelling happen in ESS/HR, never here.

const fieldsOf = (payload) => {
  const order = Object.keys(FIELD_LABELS);
  return Object.entries(payload).filter(([, v]) => v !== null && v !== "" && v !== undefined)
    .sort(([x], [y]) => (order.indexOf(x) + 99) % 99 - (order.indexOf(y) + 99) % 99).map(([k, v]) => ({ label: FIELD_LABELS[k] || k, value: String(v) }));
};

export const mine = async (req, res) => {
  if (!approvalsEnabled()) return res.render("approvals/disabled", { title: "My Requests", cfg: {} });
  const first = await myRequests(req.user, { limit: 1, offset: 0 });
  const pagination = buildPagination({ total: first.total, page: toPage(req.query.page), perPage: 15, basePath: "/crm/my-requests" });
  const { rows } = await myRequests(req.user, { limit: pagination.limit, offset: pagination.offset });
  res.render("approvals/mine", { title: "My Requests", rows: rows.map((r) => ({ ...r, dates: r.payload.start_date ? (r.payload.end_date && r.payload.end_date !== r.payload.start_date ? `${r.payload.start_date} to ${r.payload.end_date}` : r.payload.start_date) : r.payload.date || "" })), pagination });
};

export const mineShow = async (req, res) => {
  if (!approvalsEnabled()) return res.render("approvals/disabled", { title: "My Requests", cfg: {} });
  const id = toId(req.params.id);
  const r = id ? await myRequest(req.user, id) : null;
  if (!r) return res.status(404).render("error", { title: "Not found", status: 404, message: "This request does not exist or is not yours." });
  res.render("approvals/mine_show", { title: r.request_id, r, fields: fieldsOf(r.payload) });
};
