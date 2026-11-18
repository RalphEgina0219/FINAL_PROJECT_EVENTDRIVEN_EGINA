/*
 * Employee request approvals, P7 (blueprint supplement; master prompt §XI). HR/ESS owns leave, attendance and overtime records: CRM
 * never creates, edits or deletes one. CRM only (1) receives a request that HR/ESS sends, (2) routes it to the right approver,
 * (3) records the decision, and (4) publishes the decision back to HR (EmployeeRequestDecided, outbox).
 *
 * Everything is behind APPROVALS_ENABLED (default false). While it is false the Approvals Queue says so and shows nothing, inbound
 * requests are stored in the inbox as "ignored" (they can be reprocessed once the feature is on) and no request is ever routed.
 *
 * Routing (resolved when the request arrives; the first valid approver wins):
 *   Agent         -> the Team Leader of the agent's team
 *   Team Leader   -> the CRM Manager (any active Manager other than the requester)
 *   CRM Manager   -> nobody (there is nobody above): exception
 *   anyone else (not a CRM employee, no team, no Team Leader, an approver who is inactive, separated, without CRM access or not linked to HR)
 *                 -> exception queue for the Manager
 * A pending request whose approver becomes invalid later (revalidatePending) moves to the exception queue too.
 * Nobody decides their own request (service check, 403 audited, and a CHECK constraint on the table). A request is NEVER approved
 * automatically: no timer, job or default ever changes a pending request into an approved one.
 *
 * Status: pending -> approved | rejected (comment required) ; exception -> pending (Manager assigns an approver) | approved | rejected
 * (Manager decides directly, not for their own request) | returned (Manager sends it back to HR with a comment).
 */
import crypto from "crypto";
import { QueryTypes } from "sequelize";
import { sequelize, ACCESS_BLOCKING_STATUSES } from "../models/index.js";
import { config } from "../config/index.js";
import { AppError } from "../helpers/errors.js";
import { audit } from "./auditService.js";
import { notify, userIdsByRole } from "./notificationService.js";
import { publishEvent } from "./eventService.js";
import { isoWithOffset } from "./integration/signing.js";

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
const exec = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction });

export const approvalsEnabled = () => Boolean(config.features.approvalsEnabled);

export const REQUEST_TYPES = { leave: "Leave / PTO", attendance_correction: "Attendance correction", overtime: "Overtime" };
export const STATUS_LABELS = { pending: "Pending", approved: "Approved", rejected: "Rejected", returned: "Returned to HR", exception: "Needs the Manager", superseded: "Superseded" };
const CLOSED = ["approved", "rejected", "returned", "superseded"];
export const MIN_COMMENT = 5;

// A request HR/ESS sent that CRM cannot use (malformed): retrying cannot fix it.
export class RequestFormatError extends Error {}

// ---------------------------------------------------------------- the request format (DRAFT, docs/integration-contract.md §5)

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const str = (v, max) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));
const must = (cond, message) => { if (!cond) throw new RequestFormatError(message); };
const validDay = (v) => DAY.test(String(v || "")) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const num = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN);

/*
 * Returns { requestId, type, employeeId, summary, details } or throws RequestFormatError.
 *   all:                  request_id, request_type (leave | attendance_correction | overtime), employee_id, reason (text, optional for leave)
 *   leave:                leave_type, start_date, end_date (not before start_date), days (number above 0)
 *   attendance_correction: date, time_in and/or time_out (HH:MM), reason
 *   overtime:             date, start_time, end_time (HH:MM), hours (number above 0, up to 24), reason
 */
export const parseRequest = (data) => {
  must(data && typeof data === "object", "The request data must be an object.");
  const requestId = str(data.request_id, 64);
  const employeeId = str(data.employee_id, 64);
  const type = str(data.request_type, 30);
  must(requestId, "request_id is required.");
  must(employeeId, "employee_id is required.");
  must(REQUEST_TYPES[type], `request_type must be one of ${Object.keys(REQUEST_TYPES).join(", ")}.`);
  const replaces = str(data.replaces_request_id, 64);
  must(!replaces || replaces !== requestId, "replaces_request_id cannot be the request itself.");
  const reason = str(data.reason, 255);
  let summary;
  let details;
  if (type === "leave") {
    must(str(data.leave_type, 40), "leave_type is required for a leave request.");
    must(validDay(data.start_date) && validDay(data.end_date), "start_date and end_date must be dates (YYYY-MM-DD).");
    must(data.end_date >= data.start_date, "end_date cannot be before start_date.");
    const days = num(data.days);
    must(days > 0 && days <= 365, "days must be a number above 0.");
    details = { leave_type: str(data.leave_type, 40), start_date: data.start_date, end_date: data.end_date, days, reason };
    summary = `${details.leave_type} · ${days} day${days === 1 ? "" : "s"} · ${data.start_date}${data.end_date !== data.start_date ? ` to ${data.end_date}` : ""}`;
  } else if (type === "attendance_correction") {
    must(validDay(data.date), "date must be a date (YYYY-MM-DD).");
    const timeIn = str(data.time_in, 5);
    const timeOut = str(data.time_out, 5);
    must(timeIn || timeOut, "time_in or time_out is required for an attendance correction.");
    must(!timeIn || TIME.test(timeIn), "time_in must be HH:MM.");
    must(!timeOut || TIME.test(timeOut), "time_out must be HH:MM.");
    must(reason.length >= 3, "reason is required for an attendance correction.");
    details = { date: data.date, time_in: timeIn || null, time_out: timeOut || null, reason };
    summary = `Attendance correction · ${data.date}${timeIn ? ` · in ${timeIn}` : ""}${timeOut ? ` · out ${timeOut}` : ""}`;
  } else {
    must(validDay(data.date), "date must be a date (YYYY-MM-DD).");
    must(TIME.test(str(data.start_time, 5)) && TIME.test(str(data.end_time, 5)), "start_time and end_time must be HH:MM.");
    const hours = num(data.hours);
    must(hours > 0 && hours <= 24, "hours must be a number above 0 and up to 24.");
    must(reason.length >= 3, "reason is required for overtime.");
    details = { date: data.date, start_time: str(data.start_time, 5), end_time: str(data.end_time, 5), hours, reason };
    summary = `Overtime · ${hours} h · ${data.date} · ${details.start_time}-${details.end_time}`;
  }
  if (replaces) details.replaces_request_id = replaces;
  return { requestId, type, employeeId, replaces: replaces || null, summary: summary.slice(0, 255), details };
};

// ---------------------------------------------------------------- who may approve

// A user is a valid approver when the login is active, not revoked by HR, and linked to an HR employee who is not inactive or separated.
const approverProblem = (u) => {
  if (!u) return "does not exist";
  if (!u.is_active) return "has CRM access switched off";
  if (u.employment_status && ACCESS_BLOCKING_STATUSES.includes(u.employment_status)) return `is ${u.employment_status} in HR`; // the cause, named first
  if (u.access_revoked_at) return "lost CRM access (HR status)";
  if (!u.employment_status) return "is not linked to an HR employee record";
  return null;
};

const USER_SQL = `SELECT u.id, u.display_name, u.role, u.team_id, u.is_active, u.access_revoked_at, e.employment_status
                  FROM crm_users u LEFT JOIN employee_references e ON e.employee_id = u.employee_id`;

const validManagers = async (exceptUserId, transaction) => {
  const rows = await select(`${USER_SQL} WHERE u.role = 'crm_manager' AND u.user_type = 'staff' ${exceptUserId ? "AND u.id <> :except" : ""}`, { except: exceptUserId || 0 }, transaction);
  return rows.filter((u) => !approverProblem(u));
};

/*
 * Decides who gets a request from this HR employee. Returns { requesterUserId, status, approverUserId, approverRole, exceptionReason }.
 * `status` is "pending" (a valid approver exists) or "exception" (nobody valid: the Manager decides what happens).
 */
export const resolveRoute = async (employeeId, transaction) => {
  const [requester] = await select(`${USER_SQL} WHERE u.employee_id = :employeeId AND u.user_type = 'staff'`, { employeeId }, transaction);
  const exception = (reason, requesterUserId = null) => ({ requesterUserId, status: "exception", approverUserId: null, approverRole: null, exceptionReason: reason.slice(0, 255) });
  if (!requester) return exception("The requester is not a CRM employee, so CRM cannot route this request. Return it to HR.");
  if (requester.role === "crm_manager") return exception("The CRM Manager has nobody above in CRM and cannot approve their own request. Return it to HR.", requester.id);
  if (requester.role === "team_leader") {
    const managers = await validManagers(requester.id, transaction);
    if (!managers.length) return exception("There is no active CRM Manager who can approve a Team Leader's request.", requester.id);
    return { requesterUserId: requester.id, status: "pending", approverUserId: null, approverRole: "crm_manager", exceptionReason: null };
  }
  if (requester.role !== "agent") return exception(`A ${requester.role} account is not part of the approval chain.`, requester.id);
  if (!requester.team_id) return exception("The agent is not in a team, so there is no Team Leader to route to.", requester.id);
  const [team] = await select("SELECT team_leader_id FROM crm_teams WHERE id = :id", { id: requester.team_id }, transaction);
  if (!team?.team_leader_id) return exception("The agent's team has no Team Leader.", requester.id);
  const [leader] = await select(`${USER_SQL} WHERE u.id = :id`, { id: team.team_leader_id }, transaction);
  const problem = approverProblem(leader);
  if (problem || leader.role !== "team_leader" || leader.id === requester.id) return exception(`The agent's Team Leader ${leader ? leader.display_name : ""} ${problem || "cannot approve this request"}.`.replace(/\s+/g, " "), requester.id);
  return { requesterUserId: requester.id, status: "pending", approverUserId: leader.id, approverRole: "team_leader", exceptionReason: null };
};

// ---------------------------------------------------------------- receiving a request

const COLUMNS = `r.id, r.request_id, r.request_type, r.requester_employee_id, r.requester_user_id, r.approver_user_id, r.approver_role, r.status, r.exception_reason,
  r.summary, r.payload, r.decided_by, r.decided_at, r.decision_reason, r.source_event_id, r.decision_event_id, r.is_mock, r.received_at,
  req.display_name AS requester_name, req.role AS requester_role, ap.display_name AS approver_name, decider.display_name AS decided_by_name,
  e.full_name AS employee_name`;
const FROM = `FROM approval_requests r
  LEFT JOIN crm_users req ON req.id = r.requester_user_id LEFT JOIN crm_users ap ON ap.id = r.approver_user_id LEFT JOIN crm_users decider ON decider.id = r.decided_by
  LEFT JOIN employee_references e ON e.employee_id = r.requester_employee_id`;

const parsePayload = (v) => { if (v && typeof v === "object") return v; try { return JSON.parse(v || "{}"); } catch { return {}; } };

const approverLabel = (r) => (r.approver_role === "crm_manager" ? "CRM Manager" : r.approver_name || null);

/*
 * Stores one request that HR/ESS sent and routes it. Idempotent on the HR request_id: the same request arriving again (a new event
 * with the same request_id) changes nothing and returns { duplicate: true }. `silent` (the demo seeder only) skips the audit row.
 */
export const receiveRequest = async ({ data, eventId = null, isMock = false, at = null, silent = false }) => {
  const parsed = parseRequest(data);
  const [existing] = await select("SELECT id, status FROM approval_requests WHERE request_id = :id", { id: parsed.requestId });
  if (existing) return { duplicate: true, id: existing.id, status: existing.status };
  const route = await resolveRoute(parsed.employeeId);
  const now = at || new Date();
  let id;
  try {
    [id] = await sequelize.query(
      `INSERT INTO approval_requests (request_id, request_type, requester_employee_id, requester_user_id, approver_user_id, approver_role, status, exception_reason, summary, payload,
                                      source_event_id, is_mock, received_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      { replacements: [parsed.requestId, parsed.type, parsed.employeeId, route.requesterUserId, route.approverUserId, route.approverRole, route.status, route.exceptionReason, parsed.summary,
        JSON.stringify(parsed.details), eventId, isMock ? 1 : 0, now, now, now] });
  } catch (err) {
    if (err?.original?.code === "ER_DUP_ENTRY") return { duplicate: true };
    throw err;
  }
  if (!silent) {
    await audit(null, "approval_request_received", {
      actor: null, recordType: "approval_request", recordId: parsed.requestId, details: `${REQUEST_TYPES[parsed.type]} from ${parsed.employeeId}: ${route.status === "pending" ? `routed to ${route.approverRole === "crm_manager" ? "the CRM Manager" : "the Team Leader"}` : `exception (${route.exceptionReason})`}`.slice(0, 480),
      after: { status: route.status, approver_role: route.approverRole, source: isMock ? "mock" : "hr" },
    });
  }
  const superseded = parsed.replaces ? await supersede({ oldRequestId: parsed.replaces, byRequestId: parsed.requestId, employeeId: parsed.employeeId, at: now, silent }) : null;
  const link = `/crm/approvals/${id}`;
  if (route.status === "pending") {
    const to = route.approverUserId ? [route.approverUserId] : (await validManagers(route.requesterUserId)).map((m) => m.id);
    await notify(to, { type: "approval", title: `Request to decide: ${REQUEST_TYPES[parsed.type]}`, message: parsed.summary, link, relatedType: "approval", relatedId: id });
  } else {
    await notify(await userIdsByRole("crm_manager"), { type: "approval", title: "Approval request needs you (no valid approver)", message: route.exceptionReason, link, relatedType: "approval", relatedId: id });
  }
  return { duplicate: false, id, status: route.status, approverRole: route.approverRole, exceptionReason: route.exceptionReason, superseded };
};

/*
 * A changed request: HR/ESS sends a NEW request_id that names the old one (replaces_request_id). The old one, if it belongs to the same
 * employee and is still open (pending or exception), becomes 'superseded': audited, NOT a decision, no event to HR, out of every queue.
 * An old request that was already decided is left as it is (its decision stands). Returns what happened, for the inbox note.
 */
const supersede = async ({ oldRequestId, byRequestId, employeeId, at, silent }) => {
  const [old] = await select("SELECT id, status, requester_employee_id, approver_user_id, approver_role FROM approval_requests WHERE request_id = :id", { id: oldRequestId });
  if (!old) return { done: false, note: `${oldRequestId} is not in CRM` };
  if (old.requester_employee_id !== employeeId) return { done: false, note: `${oldRequestId} belongs to another employee, so it was not changed` };
  if (!["pending", "exception"].includes(old.status)) return { done: false, note: `${oldRequestId} was already ${STATUS_LABELS[old.status].toLowerCase()}; that stands` };
  const [, meta] = await sequelize.query(
    "UPDATE approval_requests SET status = 'superseded', decision_reason = :why WHERE id = :id AND status IN ('pending','exception')",
    { replacements: { id: old.id, why: `Replaced by ${byRequestId} (a changed request from HR/ESS)`.slice(0, 255) } });
  if (!(meta?.affectedRows ?? meta)) return { done: false, note: `${oldRequestId} changed meanwhile` };
  if (!silent) {
    await audit(null, "approval_superseded", { actor: null, recordType: "approval_request", recordId: oldRequestId, before: { status: old.status }, after: { status: "superseded", replaced_by: byRequestId }, details: "a changed request from HR/ESS replaced it; this is not a decision and nothing is sent to HR" });
    if (old.approver_user_id) await notify(old.approver_user_id, { type: "approval", title: `Request ${oldRequestId} was replaced`, message: `HR/ESS sent a changed request (${byRequestId}); the old one left your queue.`, link: `/crm/approvals/${old.id}`, relatedType: "approval", relatedId: old.id });
  }
  return { done: true, note: `${oldRequestId} superseded` };
};

// ---------------------------------------------------------------- reading

const shape = (r) => ({ ...r, payload: parsePayload(r.payload), type_label: REQUEST_TYPES[r.request_type] || r.request_type, status_label: STATUS_LABELS[r.status] || r.status, approver_label: approverLabel(r) });

// Who may see which request: a Team Leader the requests routed to them; the CRM Manager all of them.
const scopeOf = (user) => {
  if (user.role === "crm_manager") return { sql: "1=1", params: {} };
  if (user.role === "team_leader") return { sql: "r.approver_user_id = :ascMe", params: { ascMe: user.id } };
  return { sql: "1=0", params: {} };
};

// What the user can decide right now (the ones in "My queue").
const decidableSql = (user) => {
  if (user.role === "team_leader") return { sql: "(r.status = 'pending' AND r.approver_user_id = :dcMe AND (r.requester_user_id IS NULL OR r.requester_user_id <> :dcMe))", params: { dcMe: user.id } };
  if (user.role === "crm_manager") return { sql: "((r.status = 'pending' AND r.approver_role = 'crm_manager') OR r.status = 'exception') AND (r.requester_user_id IS NULL OR r.requester_user_id <> :dcMe)", params: { dcMe: user.id } };
  return { sql: "1=0", params: {} };
};

export const VIEWS = { queue: "My queue", exceptions: "Exceptions", decided: "Decided", all: "All" };

export const listRequests = async (user, { view = "queue", q = "", type = "", status = "", limit = 20, offset = 0 } = {}) => {
  const scope = scopeOf(user);
  const dec = decidableSql(user);
  const where = [scope.sql];
  const params = { ...scope.params, ...dec.params };
  if (view === "queue") where.push(`(${dec.sql}) AND r.status = 'pending'`);
  else if (view === "exceptions") where.push("r.status = 'exception'");
  else if (view === "decided") where.push("r.status IN ('approved','rejected','returned','superseded')");
  if (type && REQUEST_TYPES[type]) { where.push("r.request_type = :type"); params.type = type; }
  if (status && STATUS_LABELS[status]) { where.push("r.status = :status"); params.status = status; }
  if (q) { where.push("(r.request_id LIKE :q OR r.summary LIKE :q OR r.requester_employee_id LIKE :q OR req.display_name LIKE :q OR e.full_name LIKE :q)"); params.q = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`; }
  const [{ total }] = await select(`SELECT COUNT(*) AS total ${FROM} WHERE ${where.join(" AND ")}`, params);
  const rows = await select(
    `SELECT ${COLUMNS} ${FROM} WHERE ${where.join(" AND ")} ORDER BY FIELD(r.status, 'exception', 'pending') = 0, r.received_at DESC, r.id DESC LIMIT :limit OFFSET :offset`, { ...params, limit, offset });
  return { total: Number(total), rows: rows.map(shape) };
};

export const approvalCounts = async (user) => {
  if (!approvalsEnabled()) return { enabled: false, mine: 0, exceptions: 0, pending: 0 };
  const scope = scopeOf(user);
  const dec = decidableSql(user);
  const [row] = await select(
    `SELECT COALESCE(SUM((${dec.sql}) AND r.status = 'pending'), 0) AS mine, COALESCE(SUM(r.status = 'exception'), 0) AS exceptions, COALESCE(SUM(r.status = 'pending'), 0) AS pending
     FROM approval_requests r WHERE ${scope.sql}`, { ...scope.params, ...dec.params });
  return { enabled: true, mine: Number(row.mine), exceptions: user.role === "crm_manager" ? Number(row.exceptions) : 0, pending: Number(row.pending) };
};

// One request with what the user may do with it.
export const getRequest = async (user, id) => {
  const scope = scopeOf(user);
  const [row] = await select(`SELECT ${COLUMNS} ${FROM} WHERE r.id = :id AND ${scope.sql}`, { id, ...scope.params });
  if (!row) return null;
  const r = shape(row);
  const own = r.requester_user_id === user.id;
  const canDecide = !own && ((r.status === "pending" && ((user.role === "team_leader" && r.approver_user_id === user.id) || (user.role === "crm_manager" && r.approver_role === "crm_manager"))) || (r.status === "exception" && user.role === "crm_manager"));
  const canManage = user.role === "crm_manager" && r.status === "exception";
  return { ...r, own, canDecide, canManage };
};

// Approvers the Manager can hand an exception to: valid Team Leaders (not the requester) and the Manager queue itself.
export const assignableApprovers = async (request) => {
  const leaders = (await select(`${USER_SQL} WHERE u.role = 'team_leader' AND u.user_type = 'staff' ORDER BY u.display_name`)).filter((u) => !approverProblem(u) && u.id !== request.requester_user_id);
  const managers = request.requester_user_id ? await validManagers(request.requester_user_id) : await validManagers(null);
  return { leaders: leaders.map((u) => ({ id: u.id, name: u.display_name })), managerQueue: managers.length > 0 && request.requester_role !== "crm_manager" };
};

export const history = (requestId) =>
  select(
    `SELECT a.created_at, a.action, a.outcome, a.reason, a.details, u.display_name AS actor_name FROM crm_audit_logs a LEFT JOIN crm_users u ON u.id = a.actor_user_id
     WHERE a.record_type = 'approval_request' AND a.record_id = :id ORDER BY a.id`, { id: requestId });

// ---------------------------------------------------------------- deciding

const forbidden = async (req, user, request, why) => {
  await audit(req, "access_denied", { actor: user, outcome: "denied", recordType: "approval_request", recordId: request?.request_id || null, details: why });
  return new AppError(why, 403);
};

const publishDecision = async ({ request, decision, decidedBy, comment, at, transaction }) => {
  const now = at || new Date();
  const [decider] = await select("SELECT employee_id FROM crm_users WHERE id = :id", { id: decidedBy }, transaction);
  const key = `EmployeeRequestDecided:${request.request_id}`;
  await publishEvent({
    type: "EmployeeRequestDecided", entityId: request.request_id, correlationId: crypto.randomUUID(), idempotencyKey: key, at: now, transaction, forceMock: Boolean(request.is_mock),
    data: {
      request_id: request.request_id, request_type: request.request_type, employee_id: request.requester_employee_id, decision,
      decided_by_employee_id: decider?.employee_id || null, decided_at: isoWithOffset(now), reason: comment || null,
    },
  });
  const [ev] = await select("SELECT event_id FROM integration_outbox WHERE idempotency_key = :key ORDER BY id LIMIT 1", { key }, transaction);
  return ev?.event_id || null;
};

/*
 * Approve or reject. Rejecting needs a comment (5+ characters). Not allowed on your own request; a Team Leader decides only requests routed
 * to them, the Manager only manager-level and exception requests. Publishes EmployeeRequestDecided to HR through the outbox (mock: never sent).
 */
export const decideRequest = async ({ id, user, decision, comment = "", req = null, at = null, silent = false }) => {
  if (!["approve", "reject"].includes(decision)) throw new AppError("Choose approve or reject.", 422);
  const text = String(comment || "").trim().slice(0, 255);
  if (decision === "reject" && text.length < MIN_COMMENT) throw new AppError(`Give a comment for rejecting (at least ${MIN_COMMENT} characters).`, 422);
  const out = await sequelize.transaction(async (transaction) => {
    const [row] = await select(`SELECT r.*, req.role AS requester_role FROM approval_requests r LEFT JOIN crm_users req ON req.id = r.requester_user_id WHERE r.id = :id FOR UPDATE`, { id }, transaction);
    if (row && row.requester_user_id && row.requester_user_id === user.id) throw await forbidden(req, user, row, "You cannot decide your own request.");
    if (!row || (user.role === "team_leader" && row.approver_user_id !== user.id) || scopeOf(user).sql === "1=0") throw new AppError("Request not found.", 404);
    if (CLOSED.includes(row.status)) throw new AppError(`This request is already ${STATUS_LABELS[row.status].toLowerCase()}.`, 422);
    const allowed = (row.status === "pending" && ((user.role === "team_leader" && row.approver_user_id === user.id) || (user.role === "crm_manager" && row.approver_role === "crm_manager"))) || (row.status === "exception" && user.role === "crm_manager");
    if (!allowed) throw await forbidden(req, user, row, "This request is not routed to you.");
    const now = at || new Date();
    const status = decision === "approve" ? "approved" : "rejected";
    await exec("UPDATE approval_requests SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ? WHERE id = ?", [status, user.id, now, text || null, id], transaction);
    const eventId = await publishDecision({ request: row, decision: status, decidedBy: user.id, comment: text, at: now, transaction });
    await exec("UPDATE approval_requests SET decision_event_id = ? WHERE id = ?", [eventId, id], transaction);
    return { row, status };
  });
  if (!silent) {
    await audit(req, "approval_decided", { actor: user, recordType: "approval_request", recordId: out.row.request_id, reason: text || null, before: { status: out.row.status }, after: { status: out.status, decided_by: user.name || user.id }, details: `${REQUEST_TYPES[out.row.request_type]} ${out.status}${out.row.is_mock ? " (mock source)" : ""}; decision sent to HR through the outbox` });
    if (out.row.requester_user_id) await notify(out.row.requester_user_id, { type: "approval", title: `Your ${REQUEST_TYPES[out.row.request_type].toLowerCase()} request was ${out.status}`, message: text || null, link: `/crm/my-requests/${id}`, relatedType: "approval", relatedId: id });
  }
  return { status: out.status, request: out.row };
};

// Manager only, exception queue: send the request back to HR without deciding it (a comment is required).
export const returnToHr = async ({ id, user, comment, req = null, at = null, silent = false }) => {
  if (user.role !== "crm_manager") throw await forbidden(req, user, null, "Only the CRM Manager works the exception queue.");
  const text = String(comment || "").trim().slice(0, 255);
  if (text.length < MIN_COMMENT) throw new AppError(`Say why it goes back to HR (at least ${MIN_COMMENT} characters).`, 422);
  const row = await sequelize.transaction(async (transaction) => {
    const [r] = await select("SELECT * FROM approval_requests WHERE id = :id FOR UPDATE", { id }, transaction);
    if (!r) throw new AppError("Request not found.", 404);
    if (r.status !== "exception") throw new AppError("Only a request in the exception queue can be returned to HR.", 422);
    const now = at || new Date();
    await exec("UPDATE approval_requests SET status = 'returned', decided_by = ?, decided_at = ?, decision_reason = ? WHERE id = ?", [user.id, now, text, id], transaction);
    const eventId = await publishDecision({ request: r, decision: "returned", decidedBy: user.id, comment: text, at: now, transaction });
    await exec("UPDATE approval_requests SET decision_event_id = ? WHERE id = ?", [eventId, id], transaction);
    return r;
  });
  if (!silent && row.requester_user_id) await notify(row.requester_user_id, { type: "approval", title: `Your ${REQUEST_TYPES[row.request_type].toLowerCase()} request was returned to HR`, message: text, link: `/crm/my-requests/${id}`, relatedType: "approval", relatedId: id });
  if (!silent) await audit(req, "approval_returned_to_hr", { actor: user, recordType: "approval_request", recordId: row.request_id, reason: text, before: { status: "exception" }, after: { status: "returned" }, details: "returned to HR without a decision; HR is told through the outbox" });
  return row;
};

// Manager only, exception queue: hand the request to a valid Team Leader or to the Manager queue.
export const assignApprover = async ({ id, user, approver, req = null }) => {
  if (user.role !== "crm_manager") throw await forbidden(req, user, null, "Only the CRM Manager works the exception queue.");
  const row = await sequelize.transaction(async (transaction) => {
    const [r] = await select(`SELECT r.*, req.role AS requester_role FROM approval_requests r LEFT JOIN crm_users req ON req.id = r.requester_user_id WHERE r.id = :id FOR UPDATE`, { id }, transaction);
    if (!r) throw new AppError("Request not found.", 404);
    if (r.status !== "exception") throw new AppError("Only a request in the exception queue can be assigned.", 422);
    let approverUserId = null;
    let approverRole;
    if (approver === "manager") {
      if (r.requester_role === "crm_manager") throw new AppError("The CRM Manager's own request cannot go to the Manager queue.", 422);
      if (!(await validManagers(r.requester_user_id, transaction)).length) throw new AppError("There is no other active CRM Manager.", 422);
      approverRole = "crm_manager";
    } else {
      const [leader] = await select(`${USER_SQL} WHERE u.id = :id AND u.role = 'team_leader'`, { id: Number(approver) || 0 }, transaction);
      const problem = approverProblem(leader);
      if (!leader || problem) throw new AppError(`That Team Leader ${problem || "is not valid"}.`, 422);
      if (leader.id === r.requester_user_id) throw new AppError("Nobody approves their own request.", 422);
      approverUserId = leader.id;
      approverRole = "team_leader";
    }
    await exec("UPDATE approval_requests SET status = 'pending', approver_user_id = ?, approver_role = ?, exception_reason = NULL WHERE id = ?", [approverUserId, approverRole, id], transaction);
    return { ...r, approverUserId, approverRole };
  });
  await audit(req, "approval_assigned", { actor: user, recordType: "approval_request", recordId: row.request_id, before: { status: "exception" }, after: { status: "pending", approver_role: row.approverRole, approver_user_id: row.approverUserId }, details: "the Manager assigned an approver to an exception request" });
  const to = row.approverUserId ? [row.approverUserId] : (await validManagers(row.requester_user_id)).map((m) => m.id);
  await notify(to, { type: "approval", title: `Request to decide: ${REQUEST_TYPES[row.request_type]}`, message: row.summary, link: `/crm/approvals/${id}`, relatedType: "approval", relatedId: id });
  return row;
};

/*
 * Moves pending requests whose approver is no longer valid (inactive, separated, no CRM access, not linked to HR, or the requester) into the
 * exception queue. Called when the queue is opened, by the 5-minute job and after an HR status change. Never approves or rejects anything.
 */
export const revalidatePending = async () => {
  if (!approvalsEnabled()) return 0;
  const pending = await select("SELECT id, request_id, approver_user_id, approver_role, requester_user_id FROM approval_requests WHERE status = 'pending'");
  let moved = 0;
  for (const r of pending) {
    let reason = null;
    if (r.approver_user_id) {
      const [u] = await select(`${USER_SQL} WHERE u.id = :id`, { id: r.approver_user_id });
      const problem = approverProblem(u);
      if (problem) reason = `The Team Leader ${u ? u.display_name : ""} ${problem}.`.replace(/\s+/g, " ");
      else if (r.requester_user_id === u.id) reason = "The approver is the requester.";
    } else if (r.approver_role === "crm_manager" && !(await validManagers(r.requester_user_id)).length) reason = "There is no active CRM Manager who can approve this request.";
    if (!reason) continue;
    const [, meta] = await sequelize.query("UPDATE approval_requests SET status = 'exception', exception_reason = :reason, approver_user_id = NULL, approver_role = NULL WHERE id = :id AND status = 'pending'", { replacements: { id: r.id, reason: reason.slice(0, 255) } });
    if (!(meta?.affectedRows ?? meta)) continue;
    moved += 1;
    await audit(null, "approval_moved_to_exception", { actor: null, recordType: "approval_request", recordId: r.request_id, before: { status: "pending" }, after: { status: "exception" }, details: reason });
    await notify(await userIdsByRole("crm_manager"), { type: "approval", title: "Approval request needs you (approver no longer valid)", message: reason, link: `/crm/approvals/${r.id}`, relatedType: "approval", relatedId: r.id });
  }
  return moved;
};

// ---------------------------------------------------------------- mock source (setup simulator and the demo seeder)

// A request from the MOCK ESS: it goes through the same inbox and the same code as a signed live request, flagged is_mock = 1.
export const mockEnvelope = (data) => ({
  event_id: crypto.randomUUID(), event_type: "EmployeeRequestSubmitted", schema_version: 1, source: "johnvivz_hr", occurred_at: isoWithOffset(new Date()), entity_id: String(data.request_id),
  correlation_id: crypto.randomUUID(), idempotency_key: `EmployeeRequestSubmitted:${data.request_id}`, data,
});

export const recentRequests = (limit = 10) => select(`SELECT ${COLUMNS} ${FROM} ORDER BY r.id DESC LIMIT ${Number(limit) | 0}`).then((rows) => rows.map(shape));

// ---------------------------------------------------------------- My Requests (read-only copy for the requester)

// Only the signed-in person's OWN requests (requester_user_id = me). A Team Leader sees other people's requests only in the Approvals Queue.
export const myRequests = async (user, { limit = 20, offset = 0 } = {}) => {
  const [{ total }] = await select("SELECT COUNT(*) AS total FROM approval_requests r WHERE r.requester_user_id = :me", { me: user.id });
  const rows = await select(`SELECT ${COLUMNS} ${FROM} WHERE r.requester_user_id = :me ORDER BY r.received_at DESC, r.id DESC LIMIT :limit OFFSET :offset`, { me: user.id, limit, offset });
  return { total: Number(total), rows: rows.map(shape) };
};

export const myRequest = async (user, id) => {
  const [row] = await select(`SELECT ${COLUMNS} ${FROM} WHERE r.id = :id AND r.requester_user_id = :me`, { id, me: user.id });
  return row ? shape(row) : null;
};

export const myRequestCounts = async (user) => {
  if (!approvalsEnabled()) return { enabled: false, open: 0, decided: 0 };
  const [row] = await select("SELECT COALESCE(SUM(status IN ('pending','exception')), 0) AS open, COALESCE(SUM(status IN ('approved','rejected','returned')), 0) AS decided FROM approval_requests WHERE requester_user_id = :me", { me: user.id });
  return { enabled: true, open: Number(row.open), decided: Number(row.decided) };
};
