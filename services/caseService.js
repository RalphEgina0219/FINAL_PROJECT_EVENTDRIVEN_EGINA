/*
 * Customer case rules (customer_cases): numbering, record-level access, status flow, assignment,
 * escalation chain, comments, attachments, ratings, unread tracking, auto-close and SLA alerts.
 *
 * Record-level access (blueprint supplement G), applied in SQL on every read:
 *   customer     own cases only (customer_accounts link)
 *   agent        cases assigned to the agent
 *   team_leader  cases of the leader's team, plus the unrouted queue (no team, no agent)
 *   crm_manager  every case
 *   system_admin none (setup account; no customer data)
 *
 * Status flow (server-enforced): Open -> Assigned (on assignment) -> In Progress <-> Waiting for Customer
 *   -> Resolved -> Closed. Escalated is entered only through escalateCase (Agent -> Team Leader ->
 *   CRM Manager) and left only through handleEscalation (take over / return to agent / resolve).
 *   Reopen is an action (Resolved/Closed -> In Progress, reopen_count + 1) inside the reopen window.
 *   The "Update status" dropdown (statusChoices) is only a convenience: every change is checked again here.
 */
import { QueryTypes, UniqueConstraintError } from "sequelize";
import {
  sequelize, CrmUser, CustomerCase, CaseComment, Attachment, CaseStatusHistory, CaseAssignment, TicketEscalation,
  CustomerRating, CustomerFeedback, ACTIVE_CASE_STATUSES,
} from "../models/index.js";
import { AppError } from "../helpers/errors.js";
import { addHours } from "../helpers/dates.js";
import { STATUS_LABELS, PRIORITY_LABELS, ESCALATION_LEVEL_LABELS } from "../helpers/labels.js";
import { saveFiles, removeFiles } from "./storageService.js";
import { getSettings } from "./settingsService.js";
import { notify, userIdsByRole } from "./notificationService.js";
import { nextDailyNumber } from "./numberService.js";
import { directoryScope } from "./customerService.js";

export const CUSTOMER_PRIORITIES = ["low", "medium", "high"]; // only staff can set Urgent
const ACTIVE_SQL_LIST = ACTIVE_CASE_STATUSES.map((s) => `'${s}'`).join(",");
export const ACTIVE_SQL = (alias = "k") => `${alias}.status IN (${ACTIVE_SQL_LIST})`;
export const OVERDUE_SQL = `(k.status IN (${ACTIVE_SQL_LIST}) AND k.resolution_due_at IS NOT NULL AND k.resolution_due_at < NOW())`;
export const CUSTOMER_NAME_SQL = "CONCAT(cu.first_name, ' ', cu.last_name)";

// Plain status changes a handler may make. Escalated is not listed: it is entered through escalateCase and
// left through handleEscalation. Agents get no change at all on Resolved/Closed (see allowedTransitions).
const STAFF_FLOW = {
  open: [],
  assigned: ["in_progress", "waiting_for_customer"],
  in_progress: ["waiting_for_customer", "resolved"],
  waiting_for_customer: ["in_progress"],
  escalated: [],
  resolved: ["closed", "in_progress"],
  closed: ["in_progress"],
};

// A reason / resolution note must be at least this long (checked here, not only in the form).
export const MIN_NOTE_LENGTH = 5;

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });

// ---------------------------------------------------------------- access

export const scopeFor = (user) => {
  switch (user.role) {
    case "customer": return { sql: "k.customer_id = :viewerCustomerId", params: { viewerCustomerId: user.customer_id || 0 } };
    case "agent": return { sql: "k.assigned_agent_id = :viewerId", params: { viewerId: user.id } };
    case "team_leader":
      return { sql: "(k.team_id = :viewerTeamId OR (k.team_id IS NULL AND k.assigned_agent_id IS NULL))", params: { viewerTeamId: user.team_id || 0 } };
    case "crm_manager":
    case "system": return { sql: "1=1", params: {} };
    default: return { sql: "1=0", params: {} };
  }
};

const inScope = (k, user) => {
  switch (user.role) {
    case "customer": return Number(k.customer_id) === Number(user.customer_id);
    case "agent": return Number(k.assigned_agent_id) === Number(user.id);
    case "team_leader": return (k.team_id && Number(k.team_id) === Number(user.team_id)) || (!k.team_id && !k.assigned_agent_id);
    case "crm_manager":
    case "system": return true;
    default: return false;
  }
};

// Who may work on the case right now (reply publicly, change status/priority/category).
export const canHandle = (k, user) => {
  if (!inScope(k, user)) return false;
  if (user.role === "crm_manager") return true;
  if (user.role === "team_leader") return Number(k.escalation_level) <= 1; // level 2 belongs to the CRM Manager
  if (user.role === "agent") return Number(k.escalation_level) === 0 && k.status !== "escalated";
  return false;
};

export const canEscalate = (k, user) => {
  if (!inScope(k, user) || ["resolved", "closed", "open"].includes(k.status)) return false;
  if (user.role === "agent") return Number(k.escalation_level) === 0 && k.status !== "escalated";
  if (user.role === "team_leader") return Number(k.escalation_level) === 1;
  return false; // the CRM Manager is the top of the chain
};

// Level 1 escalations: the case's Team Leader (or any CRM Manager). Level 2: CRM Manager only.
export const canHandleEscalation = (k, user) =>
  k.status === "escalated" && inScope(k, user) &&
  (user.role === "crm_manager" || (user.role === "team_leader" && Number(k.escalation_level) === 1));

export const canAssign = (k, user) =>
  k.status !== "closed" && inScope(k, user) && ["team_leader", "crm_manager"].includes(user.role);

export const reopenDeadline = (k) => {
  const base = k.resolved_at || k.closed_at;
  return base ? addHours(base, getSettings().reopenWindowDays * 24) : null;
};
const withinReopenWindow = (k) => {
  const d = reopenDeadline(k);
  return Boolean(d && d > new Date());
};

export const allowedTransitions = (k, user) => {
  if (user.role === "customer") {
    if (!inScope(k, user) || k.status !== "resolved") return [];
    return withinReopenWindow(k) ? ["closed", "in_progress"] : ["closed"];
  }
  if (!canHandle(k, user)) return [];
  let next = STAFF_FLOW[k.status] || [];
  if (["resolved", "closed"].includes(k.status) && !withinReopenWindow(k)) next = next.filter((s) => s !== "in_progress");
  if (user.role === "agent" && ["resolved", "closed"].includes(k.status)) next = []; // the customer, a Team Leader or the Manager moves it on
  return next;
};

// The error for a status jump the rules don't allow. The code lets the controller audit it.
export const invalidTransition = (k, newStatus) => {
  const err = new AppError(`You can't change this case from "${STATUS_LABELS[k.status]}" to "${STATUS_LABELS[newStatus] || newStatus}".`, 422);
  err.code = "invalid_transition";
  return err;
};

const ESCALATION_PANEL_HINT = "Use the Handle escalation panel to take over, return the case to the agent or resolve it.";

// Why a staff member has nothing to pick in "Update status" (shown instead of an empty dropdown).
const noChoicesReason = (k, user) => {
  const days = getSettings().reopenWindowDays;
  const level = Number(k.escalation_level);
  if (k.status === "escalated") {
    if (user.role === "agent") {
      return `This case is escalated to the ${ESCALATION_LEVEL_LABELS[level]} (level ${level}), so its status can't be changed here. Your supervisor is handling it; you can still add internal notes.`;
    }
    return `This case is escalated to the CRM Manager (level 2). Only the CRM Manager can act on it.`;
  }
  if (["resolved", "closed"].includes(k.status)) {
    if (user.role === "agent") {
      return k.status === "resolved"
        ? "Agents can't change a Resolved case. The customer, a Team Leader or the CRM Manager can reopen it."
        : "Agents can't change a Closed case. Only a Team Leader or the CRM Manager can reopen it.";
    }
    if (!canHandle(k, user)) return "This case was escalated to the CRM Manager (level 2). Only the CRM Manager can change it.";
    return `The ${days}-day reopen window has passed, so this ${STATUS_LABELS[k.status]} case can't be reopened.`;
  }
  if (k.status === "open") return "An Open case becomes Assigned when a Team Leader or the CRM Manager assigns an agent.";
  if (!canHandle(k, user)) return "This case is at escalation level 2 and is handled by the CRM Manager.";
  return "No status changes are available for this case right now.";
};

/*
 * What the "Update status" dropdown offers staff, built from the same rules the server enforces:
 *   - plain changes from allowedTransitions            (action "status",   changeStatus)
 *   - "Escalated" when the Escalate button is available (action "escalate", escalateCase)
 *   Supervisor actions on an Escalated case (take over / return / resolve) are NOT here: the "Handle escalation"
 *   panel is their only place, so each action has one way.
 * `requires` says which note the form must collect: "reason" (escalation) or "resolution" (Resolved).
 * Returns { choices, explanation, hint }: explanation is set only when there is nothing to choose; hint points a
 * supervisor to the Handle escalation panel.
 */
export const statusChoices = (k, user) => {
  if (user.role === "customer") return { choices: [], explanation: null, hint: null };
  const choices = [];
  const hint = canHandleEscalation(k, user) ? ESCALATION_PANEL_HINT : null;
  for (const value of allowedTransitions(k, user)) {
    const reopen = ["resolved", "closed"].includes(k.status) && value === "in_progress";
    choices.push({ value, label: reopen ? "Reopen (In Progress)" : STATUS_LABELS[value], action: "status", requires: value === "resolved" ? "resolution" : null });
  }
  if (canEscalate(k, user)) {
    choices.push({ value: "escalated", label: `Escalated (to ${user.role === "agent" ? "your Team Leader" : "the CRM Manager"})`, action: "escalate", requires: "reason" });
  }
  return { choices, hint, explanation: choices.length ? null : hint || noChoicesReason(k, user) };
};

export const canReply = (k, user) => {
  if (k.status === "closed") return false;
  if (user.role === "customer") return inScope(k, user);
  return canHandle(k, user);
};

// The assigned agent can still leave internal notes while a supervisor handles the escalation.
export const canInternalNote = (k, user) => k.status !== "closed" && (canHandle(k, user) || (user.role === "agent" && inScope(k, user)));

export const canRate = (k, user, existingRating) =>
  user.role === "customer" && inScope(k, user) && ["resolved", "closed"].includes(k.status) && !existingRating;

const lockCaseForUser = async (caseId, user, transaction) => {
  const row = await CustomerCase.findByPk(caseId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!row || !inScope(row.get({ plain: true }), user)) throw new AppError("Case not found.", 404);
  return row;
};

// ---------------------------------------------------------------- helpers

export const computeDueDates = (priority, from) => {
  const s = getSettings();
  return {
    first_response_due_at: addHours(from, s.firstResponseHours[priority]),
    resolution_due_at: addHours(from, s.resolutionHours[priority]),
  };
};

const stamp = (at) => (at ? { createdAt: at, updatedAt: at } : {});

const recordHistory = (caseId, userId, field, oldValue, newValue, note, transaction, at) =>
  CaseStatusHistory.create(
    { case_id: caseId, changed_by: userId, field, old_value: oldValue, new_value: newValue, note: note || null, ...(at ? { createdAt: at } : {}) },
    { transaction }
  );

// The resolution note is shown to the customer as a public comment, so they can read it before they confirm,
// reopen or rate. It counts as the first public reply when none was sent yet (returns the columns to update).
const postResolution = async (k, user, note, transaction, at) => {
  await CaseComment.create({ case_id: k.id, author_id: user.id, visibility: "public", body: `Resolution: ${String(note).trim()}`, ...stamp(at) }, { transaction, silent: Boolean(at) });
  return k.first_response_at ? {} : { first_response_at: at || new Date() };
};

const customerUserId = async (customerId, transaction) => {
  const [row] = await select("SELECT user_id FROM customer_accounts WHERE customer_id = :customerId AND status = 'active'", { customerId }, transaction);
  return row ? row.user_id : null;
};

const teamLeaderOf = async (teamId, transaction) => {
  if (!teamId) return null;
  const [row] = await select(
    `SELECT u.id, u.display_name FROM crm_teams t JOIN crm_users u ON u.id = t.team_leader_id
     WHERE t.id = :teamId AND u.is_active = 1 AND u.access_revoked_at IS NULL`,
    { teamId }, transaction
  );
  return row || null;
};

const managerFor = async (teamId, transaction) => {
  const [row] = await select(
    `SELECT u.id, u.display_name FROM crm_users u
     WHERE u.role = 'crm_manager' AND u.is_active = 1 AND u.access_revoked_at IS NULL
     ORDER BY (u.id = (SELECT manager_id FROM crm_teams WHERE id = :teamId)) DESC, u.id LIMIT 1`,
    { teamId: teamId || 0 }, transaction
  );
  return row || null;
};

// Staff who should hear about customer activity: assigned agent, else the team leader, else managers.
const staffRecipients = async (k) => {
  if (k.assigned_agent_id && Number(k.escalation_level) === 0) return [k.assigned_agent_id];
  const ids = [];
  if (k.assigned_agent_id) ids.push(k.assigned_agent_id);
  const tl = await teamLeaderOf(k.team_id);
  if (tl && Number(k.escalation_level) <= 1) ids.push(tl.id);
  if (!ids.length || Number(k.escalation_level) === 2 || !k.team_id) ids.push(...(await userIdsByRole("crm_manager")));
  return ids;
};

// ---------------------------------------------------------------- create (customer portal)

export const createCase = async ({ user, data, validatedFiles = [], createdAt = null, isDemo = false }) => {
  if (user.role !== "customer" || !user.customer_id) throw new AppError("Only customers can submit cases from the portal.", 403);
  const stored = await saveFiles(validatedFiles);
  let k;
  try {
    k = await sequelize.transaction(async (transaction) => {
      const now = createdAt || new Date();
      const row = await CustomerCase.create({
        case_no: await nextDailyNumber("case", now, transaction),
        customer_id: user.customer_id,
        case_type: data.case_type,
        category_id: data.category_id,
        subject: data.subject,
        description: data.description,
        priority: data.priority,
        status: "open",
        channel: "portal",
        order_reference: data.order_reference || null,
        ...computeDueDates(data.priority, now),
        created_by: user.id,
        is_demo: isDemo,
        ...stamp(createdAt),
      }, { transaction, silent: Boolean(createdAt) });
      for (const file of stored) {
        await Attachment.create({ ...file, entity_type: "case", entity_id: row.id, case_id: row.id, uploaded_by: user.id, visibility: "public" }, { transaction });
      }
      await recordHistory(row.id, user.id, "created", null, "open", null, transaction, createdAt);
      return row.get({ plain: true });
    });
  } catch (err) {
    await removeFiles(stored.map((s) => s.stored_name));
    throw err;
  }
  if (!createdAt) {
    await markCaseRead(user.id, k.id);
    // New cases are unrouted: every Team Leader sees them in the Customer Queue, Managers in Customer Service.
    await notify(await userIdsByRole("team_leader", "crm_manager"), {
      type: "new_case", caseId: k.id, title: `New case ${k.case_no}`, message: `${user.name}: ${k.subject}`,
    });
  }
  return k;
};

// ---------------------------------------------------------------- create (staff, for customers who phoned or walked in)

export const STAFF_CASE_CHANNELS = ["phone", "walk_in", "sms", "social", "email"];
const INTERACTION_FOR_CHANNEL = { phone: "call", walk_in: "visit", sms: "sms", email: "email", social: "chat", portal: "portal" };

/*
 * A case opened by staff for a customer in their scope (phone, walk-in, SMS, social, email). An Agent becomes the
 * case's agent (status Assigned); a Team Leader or the Manager may pick an agent, otherwise the case waits in the
 * Customer Queue like a portal case. The contact is also written to the customer's interaction timeline.
 */
export const createStaffCase = async (args) => {
  const result = await sequelize.transaction((transaction) => buildStaffCase(args, transaction));
  return afterStaffCase(args.user, result);
};

// The database part of createStaffCase, so an inquiry can be converted in the same transaction as its status change.
// `scopeChecked`: the caller already verified access (an inquiry the user may handle), so the customer scope is not applied again.
export const buildStaffCase = async ({ user, customerId, data, agentId = null, scopeChecked = false, isDemo = false }, transaction) => {
  if (!["agent", "team_leader", "crm_manager"].includes(user.role)) throw new AppError("Only staff can open a case for a customer.", 403);
  {
    const scope = scopeChecked ? { sql: "1=1", params: {} } : directoryScope(user);
    const [customer] = await select(`SELECT c.id, c.customer_no, c.first_name, c.last_name FROM customers c WHERE c.id = :customerId AND c.status <> 'merged' AND ${scope.sql}`, { customerId, ...scope.params }, transaction);
    if (!customer) throw new AppError("Customer not found.", 404);
    let agent = null;
    if (user.role === "agent") agent = { id: user.id, team_id: user.team_id || null };
    else if (agentId) {
      [agent] = await select(
        `SELECT u.id, u.display_name AS name, u.team_id FROM crm_users u
         JOIN employee_references e ON e.employee_id = u.employee_id AND e.employment_status IN ('active','on_leave')
         WHERE u.id = :agentId AND u.role = 'agent' AND u.is_active = 1 AND u.access_revoked_at IS NULL`, { agentId }, transaction);
      if (!agent) throw new AppError("Choose an active agent.", 422);
      if (user.role === "team_leader" && Number(agent.team_id) !== Number(user.team_id)) throw new AppError("Team Leaders can assign only agents from their own team.", 403);
    }
    const now = new Date();
    const row = await CustomerCase.create({
      case_no: await nextDailyNumber("case", now, transaction),
      customer_id: customer.id, case_type: data.case_type, category_id: data.category_id, subject: data.subject, description: data.description,
      priority: data.priority, status: agent ? "assigned" : "open", channel: data.channel, order_reference: data.order_reference || null,
      assigned_agent_id: agent ? agent.id : null, team_id: agent ? agent.team_id : null,
      ...computeDueDates(data.priority, now), created_by: user.id, is_demo: isDemo,
    }, { transaction });
    const k = row.get({ plain: true });
    await recordHistory(k.id, user.id, "created", null, "open", `Opened by ${user.role === "agent" ? "the agent" : "staff"} (${data.channel.replace("_", "-")})`, transaction);
    if (agent) {
      await CaseAssignment.create({ case_id: k.id, agent_id: agent.id, team_id: agent.team_id, assigned_by: user.id, assigned_at: now, note: "Assigned when the case was opened" }, { transaction });
      await recordHistory(k.id, user.id, "assignment", null, agent.name || user.name, "Assigned when the case was opened", transaction);
      await recordHistory(k.id, user.id, "status", "open", "assigned", null, transaction);
    }
    await sequelize.query(
      `INSERT INTO customer_interactions (customer_id, crm_user_id, interaction_type, direction, subject, summary, related_type, related_id, occurred_at, is_demo)
       VALUES (?, ?, ?, 'inbound', ?, ?, 'case', ?, ?, ?)`,
      { replacements: [customer.id, user.id, INTERACTION_FOR_CHANNEL[data.channel], `Case ${k.case_no}: ${data.subject}`.slice(0, 150), "Case opened by staff for the customer.", k.id, now, isDemo ? 1 : 0], transaction }
    );
    return { k, customer, agent };
  }
};

// Notifications after the transaction has committed.
export const afterStaffCase = async (user, { k, customer, agent }) => {
  await markCaseRead(user.id, k.id);
  await notify(await customerUserId(customer.id), { type: "new_case", caseId: k.id, title: `A case ${k.case_no} was opened for you`, message: k.subject });
  if (agent) {
    if (agent.id !== user.id) await notify(agent.id, { type: "assignment", caseId: k.id, title: `Case ${k.case_no} was assigned to you`, message: k.subject });
  } else {
    await notify(await userIdsByRole("team_leader", "crm_manager"), { type: "new_case", caseId: k.id, title: `New case ${k.case_no}`, message: `${customer.first_name} ${customer.last_name}: ${k.subject}` });
  }
  return { ...k, customer_no: customer.customer_no };
};

// ---------------------------------------------------------------- read

const unreadSql = (user) => `(
  GREATEST(
    COALESCE((SELECT MAX(r.created_at) FROM case_comments r WHERE r.case_id = k.id AND r.author_id <> :me
              ${user.role === "customer" ? "AND r.visibility = 'public'" : ""}), '1970-01-01'),
    IF(COALESCE(k.created_by, 0) <> :me, k.created_at, '1970-01-01')
  ) > COALESCE((SELECT cr.last_read_at FROM case_reads cr WHERE cr.case_id = k.id AND cr.user_id = :me), '1970-01-01'))`;

export const listCases = async (user, filters, { limit, offset }) => {
  const scope = scopeFor(user);
  const where = [scope.sql];
  const params = { ...scope.params, me: user.id };
  if (filters.q) {
    where.push(`(k.case_no LIKE :q OR k.subject LIKE :q OR ${CUSTOMER_NAME_SQL} LIKE :q OR cu.customer_no LIKE :q OR k.order_reference LIKE :q)`);
    params.q = `%${filters.q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  }
  if (filters.status === "active") where.push(ACTIVE_SQL());
  else if (filters.status) { where.push("k.status = :status"); params.status = filters.status; }
  if (filters.priority) { where.push("k.priority = :priority"); params.priority = filters.priority; }
  if (filters.category_id) { where.push("k.category_id = :categoryId"); params.categoryId = filters.category_id; }
  if (filters.case_type) { where.push("k.case_type = :caseType"); params.caseType = filters.case_type; }
  if (filters.agent === "unassigned") where.push("k.assigned_agent_id IS NULL");
  else if (filters.agent) { where.push("k.assigned_agent_id = :agentId"); params.agentId = filters.agent; }
  if (filters.team) { where.push("k.team_id = :teamId"); params.teamId = filters.team; }
  if (filters.queue) where.push("k.assigned_agent_id IS NULL AND k.status = 'open'");
  if (filters.escalated) where.push("k.status = 'escalated'");
  if (filters.overdue) where.push(OVERDUE_SQL);
  if (filters.unread) where.push(unreadSql(user));
  if (filters.demo === "demo") where.push("k.is_demo = 1");
  if (filters.demo === "real") where.push("k.is_demo = 0");

  const ORDER = {
    newest: "k.created_at DESC, k.id DESC",
    oldest: "k.created_at ASC, k.id ASC",
    due: "(k.resolution_due_at IS NULL), k.resolution_due_at ASC",
    priority: "FIELD(k.priority,'urgent','high','medium','low'), k.created_at DESC",
    updated: "k.updated_at DESC",
  };
  const from = `FROM customer_cases k
    JOIN customers cu ON cu.id = k.customer_id
    JOIN case_categories c ON c.id = k.category_id
    LEFT JOIN crm_users ag ON ag.id = k.assigned_agent_id
    LEFT JOIN crm_teams tm ON tm.id = k.team_id
    WHERE ${where.join(" AND ")}`;
  const [{ total }] = await select(`SELECT COUNT(*) AS total ${from}`, params);
  const rows = await select(
    `SELECT k.id, k.case_no, k.subject, k.status, k.priority, k.case_type, k.escalation_level, k.created_at, k.updated_at,
            k.resolution_due_at, k.is_demo, c.name AS category_name, ${CUSTOMER_NAME_SQL} AS customer_name, cu.customer_no,
            ag.display_name AS agent_name, tm.name AS team_name, ${OVERDUE_SQL} AS is_overdue, ${unreadSql(user)} AS is_unread,
            (SELECT COUNT(*) FROM case_comments r WHERE r.case_id = k.id
               ${user.role === "customer" ? "AND r.visibility = 'public'" : ""}) AS reply_count
     ${from} ORDER BY ${ORDER[filters.sort] || ORDER.newest} LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset }
  );
  return { total: Number(total), rows };
};

export const unreadCaseCount = async (user) => {
  const scope = scopeFor(user);
  const [row] = await select(
    `SELECT COUNT(*) AS n FROM customer_cases k WHERE ${scope.sql} AND k.status <> 'closed' AND ${unreadSql(user)}`,
    { ...scope.params, me: user.id }
  );
  return Number(row.n) || 0;
};

export const queueCount = async (user) => {
  const scope = scopeFor(user);
  const [row] = await select(
    `SELECT COUNT(*) AS n FROM customer_cases k WHERE ${scope.sql} AND k.status = 'open' AND k.assigned_agent_id IS NULL`,
    scope.params
  );
  return Number(row.n) || 0;
};

export const pendingEscalationCount = async (user) => {
  const scope = scopeFor(user);
  const levelSql = user.role === "team_leader" ? "AND k.escalation_level = 1" : "";
  const [row] = await select(`SELECT COUNT(*) AS n FROM customer_cases k WHERE ${scope.sql} AND k.status = 'escalated' ${levelSql}`, scope.params);
  return Number(row.n) || 0;
};

export const markCaseRead = (userId, caseId) =>
  sequelize.query(
    `INSERT INTO case_reads (user_id, case_id, last_read_at) VALUES (:userId, :caseId, NOW())
     ON DUPLICATE KEY UPDATE last_read_at = NOW()`,
    { replacements: { userId, caseId } }
  );

export const findCaseForUser = async (caseId, user) => {
  const scope = scopeFor(user);
  const [k] = await select(
    `SELECT k.*, c.name AS category_name, ${CUSTOMER_NAME_SQL} AS customer_name, cu.customer_no, cu.email AS customer_email,
            cu.mobile AS customer_mobile, cu.customer_id AS customer_uuid,
            (SELECT a.line1 FROM customer_addresses a WHERE a.customer_id = cu.id AND a.is_default = 1 ORDER BY a.id LIMIT 1) AS customer_address,
            ag.display_name AS agent_name, tm.name AS team_name, ${OVERDUE_SQL} AS is_overdue
     FROM customer_cases k
     JOIN customers cu ON cu.id = k.customer_id
     JOIN case_categories c ON c.id = k.category_id
     LEFT JOIN crm_users ag ON ag.id = k.assigned_agent_id
     LEFT JOIN crm_teams tm ON tm.id = k.team_id
     WHERE k.id = :caseId AND ${scope.sql}`,
    { caseId, ...scope.params }
  );
  return k || null;
};

export const getThread = async (caseId, user) => {
  const customerOnly = user.role === "customer" ? "AND r.visibility = 'public'" : "";
  const messages = await select(
    `SELECT r.id, r.body, r.visibility, r.created_at, u.display_name AS author_name, u.role AS author_role, r.author_id
     FROM case_comments r JOIN crm_users u ON u.id = r.author_id
     WHERE r.case_id = :caseId ${customerOnly} ORDER BY r.created_at ASC, r.id ASC`,
    { caseId }
  );
  const files = await select(
    `SELECT a.id, a.entity_id AS comment_id, a.original_name, a.size_bytes FROM attachments a
     WHERE a.case_id = :caseId AND a.entity_type = 'case_comment' ${user.role === "customer" ? "AND a.visibility = 'public'" : ""}`,
    { caseId }
  );
  return messages.map((m) => ({ ...m, files: files.filter((f) => f.comment_id === m.id) }));
};

export const getAttachments = (caseId, user) =>
  select(
    `SELECT a.id, a.original_name, a.mime_type, a.size_bytes, a.visibility, a.created_at, u.display_name AS uploaded_by_name
     FROM attachments a JOIN crm_users u ON u.id = a.uploaded_by
     WHERE a.case_id = :caseId AND a.entity_type = 'case' ${user.role === "customer" ? "AND a.visibility = 'public'" : ""}
     ORDER BY a.id`,
    { caseId }
  );

export const getHistory = (caseId) =>
  select(
    `SELECT h.field, h.old_value, h.new_value, h.note, h.created_at, u.display_name AS changed_by_name, u.role AS changed_by_role
     FROM case_status_history h LEFT JOIN crm_users u ON u.id = h.changed_by
     WHERE h.case_id = :caseId ORDER BY h.created_at ASC, h.id ASC`,
    { caseId }
  );

export const getEscalations = (caseId) =>
  select(
    `SELECT e.id, e.from_level, e.to_level, e.reason, e.outcome, e.created_at, e.handled_at, e.handling_note,
            eb.display_name AS escalated_by_name, eb.role AS escalated_by_role, et.display_name AS escalated_to_name,
            hb.display_name AS handled_by_name
     FROM ticket_escalations e JOIN crm_users eb ON eb.id = e.escalated_by
     LEFT JOIN crm_users et ON et.id = e.escalated_to LEFT JOIN crm_users hb ON hb.id = e.handled_by
     WHERE e.case_id = :caseId ORDER BY e.created_at, e.id`,
    { caseId }
  );

export const getRating = async (caseId) => {
  const [row] = await select(
    `SELECT r.rating, r.created_at, f.comment FROM customer_ratings r LEFT JOIN customer_feedback f ON f.rating_id = r.id
     WHERE r.case_id = :caseId`,
    { caseId }
  );
  return row || null;
};

export const findAttachmentForUser = async (attachmentId, user) => {
  const scope = scopeFor(user);
  const [row] = await select(
    `SELECT a.* FROM attachments a JOIN customer_cases k ON k.id = a.case_id
     WHERE a.id = :attachmentId AND ${scope.sql} ${user.role === "customer" ? "AND a.visibility = 'public'" : ""}`,
    { attachmentId, ...scope.params }
  );
  return row || null;
};

// Agents a user may assign to: Team Leader -> own team; CRM Manager -> every team.
export const assignableAgents = (user) =>
  select(
    `SELECT u.id, u.display_name AS name, u.is_available, u.team_id, t.name AS team_name,
            (SELECT COUNT(*) FROM customer_cases k WHERE k.assigned_agent_id = u.id AND ${ACTIVE_SQL()}) AS active_count
     FROM crm_users u
     JOIN employee_references e ON e.employee_id = u.employee_id AND e.employment_status IN ('active','on_leave')
     LEFT JOIN crm_teams t ON t.id = u.team_id
     WHERE u.role = 'agent' AND u.is_active = 1 AND u.access_revoked_at IS NULL
       ${user.role === "team_leader" ? "AND u.team_id = :teamId" : ""}
     ORDER BY t.name, u.display_name`,
    { teamId: user.team_id || 0 }
  );

// Rule-based suggestion (no AI): among assignable, available agents, the one with the fewest active
// cases in this category, then the fewest active cases overall.
export const suggestAgent = async (k, user) => {
  const [row] = await select(
    `SELECT u.id, u.display_name AS name,
            COALESCE(SUM(x.category_id = :categoryId AND ${ACTIVE_SQL("x")}), 0) AS open_in_category,
            COALESCE(SUM(${ACTIVE_SQL("x")}), 0) AS open_total
     FROM crm_users u
     JOIN employee_references e ON e.employee_id = u.employee_id AND e.employment_status = 'active'
     LEFT JOIN customer_cases x ON x.assigned_agent_id = u.id AND x.id <> :caseId
     WHERE u.role = 'agent' AND u.is_active = 1 AND u.is_available = 1 AND u.access_revoked_at IS NULL
       ${user.role === "team_leader" ? "AND u.team_id = :teamId" : k.team_id ? "AND u.team_id = :caseTeam" : ""}
     GROUP BY u.id, u.display_name
     ORDER BY open_in_category ASC, open_total ASC, u.display_name ASC LIMIT 1`,
    { categoryId: k.category_id, caseId: k.id, teamId: user.team_id || 0, caseTeam: k.team_id || 0 }
  );
  return row || null;
};

// ---------------------------------------------------------------- updates

export const changeStatus = async ({ caseId, user, newStatus, note, at = null }) => {
  const result = await sequelize.transaction(async (transaction) => {
    const row = await lockCaseForUser(caseId, user, transaction);
    const k = { ...row.get({ plain: true }) }; // a copy: row.update() would otherwise change k too (history "old value")
    if (!allowedTransitions(k, user).includes(newStatus)) throw invalidTransition(k, newStatus);
    if (newStatus === "resolved" && String(note || "").trim().length < MIN_NOTE_LENGTH) {
      throw new AppError(`Describe the resolution (at least ${MIN_NOTE_LENGTH} characters).`, 422);
    }
    const now = at || new Date();
    const isReopen = ["resolved", "closed"].includes(k.status) && newStatus === "in_progress";
    const changes = { status: newStatus };
    if (newStatus === "resolved") {
      changes.resolved_at = now;
      Object.assign(changes, await postResolution(k, user, note, transaction, at));
    }
    if (newStatus === "closed") changes.closed_at = now;
    if (isReopen) {
      Object.assign(changes, {
        reopen_count: k.reopen_count + 1, resolved_at: null, closed_at: null, sla_breach_notified_at: null,
        resolution_due_at: addHours(now, getSettings().resolutionHours[k.priority]),
      });
    }
    await row.update(changes, { transaction, silent: Boolean(at) });
    await recordHistory(k.id, user.id, "status", k.status, newStatus, isReopen ? `Reopened${note ? `: ${note}` : ""}` : note, transaction, at);
    if (isReopen && user.role === "customer" && note) {
      await CaseComment.create({ case_id: k.id, author_id: user.id, visibility: "public", body: `Reopened: ${note}`, ...stamp(at) }, { transaction, silent: Boolean(at) });
    }
    return { k: { ...k, ...changes }, from: k.status, isReopen };
  });

  if (!at) {
    const { k, isReopen } = result;
    if (user.role === "customer") {
      await notify(await staffRecipients(k), {
        type: "status_change", caseId: k.id,
        title: `${k.case_no} was ${isReopen ? "reopened" : "confirmed and closed"} by the customer`, message: note || k.subject,
      });
    } else {
      const customerUser = await customerUserId(k.customer_id);
      await notify(customerUser, {
        type: newStatus === "resolved" ? "resolved" : "status_change", caseId: k.id,
        title: newStatus === "resolved" ? `Your case ${k.case_no} was resolved` : `Case ${k.case_no} is now ${STATUS_LABELS[newStatus]}`,
        message: newStatus === "resolved" ? "Please confirm the solution or rate our service." : k.subject,
      });
    }
  }
  return result.k;
};

export const changePriority = ({ caseId, user, priority }) =>
  sequelize.transaction(async (transaction) => {
    const row = await lockCaseForUser(caseId, user, transaction);
    const k = { ...row.get({ plain: true }) }; // a copy: row.update() would otherwise change k too (history "old value")
    if (!canHandle(k, user) || k.status === "closed") throw new AppError("You can't change the priority of this case.", 403);
    if (k.priority === priority) throw new AppError(`Priority is already ${PRIORITY_LABELS[priority]}.`, 422);
    await row.update({ priority, ...computeDueDates(priority, row.get("createdAt")), sla_breach_notified_at: null }, { transaction });
    await recordHistory(k.id, user.id, "priority", k.priority, priority, "SLA due dates recalculated", transaction);
    return { before: k.priority, after: priority };
  });

export const changeCategory = ({ caseId, user, categoryId, categoryName }) =>
  sequelize.transaction(async (transaction) => {
    const row = await lockCaseForUser(caseId, user, transaction);
    const k = { ...row.get({ plain: true }) }; // a copy: row.update() would otherwise change k too (history "old value")
    if (!canHandle(k, user) || k.status === "closed") throw new AppError("You can't change the category of this case.", 403);
    if (k.category_id === categoryId) throw new AppError("The case already has this category.", 422);
    const [old] = await select("SELECT name FROM case_categories WHERE id = :id", { id: k.category_id }, transaction);
    await row.update({ category_id: categoryId }, { transaction });
    await recordHistory(k.id, user.id, "category", old ? old.name : null, categoryName, null, transaction);
  });

export const assignCase = async ({ caseId, actor, agentId, note, at = null }) => {
  const result = await sequelize.transaction(async (transaction) => {
    if (!["team_leader", "crm_manager"].includes(actor.role)) throw new AppError("Only a Team Leader or the CRM Manager can assign cases.", 403);
    const row = await lockCaseForUser(caseId, actor, transaction);
    const k = { ...row.get({ plain: true }) }; // a copy: row.update() would otherwise change k too (history "old value")
    if (k.status === "closed") throw new AppError("Closed cases cannot be reassigned.", 422);
    const [agent] = await select(
      `SELECT u.id, u.display_name AS name, u.team_id FROM crm_users u
       JOIN employee_references e ON e.employee_id = u.employee_id AND e.employment_status IN ('active','on_leave')
       WHERE u.id = :agentId AND u.role = 'agent' AND u.is_active = 1 AND u.access_revoked_at IS NULL`,
      { agentId }, transaction
    );
    if (!agent) throw new AppError("Choose an active agent.", 422);
    if (actor.role === "team_leader" && Number(agent.team_id) !== Number(actor.team_id)) {
      throw new AppError("Team Leaders can assign only agents from their own team.", 403);
    }
    if (k.assigned_agent_id === agent.id) throw new AppError(`This case is already assigned to ${agent.name}.`, 422);

    const now = at || new Date();
    let previousName = null;
    if (k.assigned_agent_id) {
      const prev = await CrmUser.findByPk(k.assigned_agent_id, { attributes: ["display_name"], transaction, raw: true });
      previousName = prev ? prev.display_name : null;
      await CaseAssignment.update({ unassigned_at: now }, { where: { case_id: k.id, unassigned_at: null }, transaction });
    }
    await CaseAssignment.create({ case_id: k.id, agent_id: agent.id, team_id: agent.team_id, assigned_by: actor.id, assigned_at: now, note: note || null }, { transaction });
    const changes = { assigned_agent_id: agent.id, team_id: agent.team_id };
    if (k.status === "open") changes.status = "assigned";
    await row.update(changes, { transaction, silent: Boolean(at) });
    await recordHistory(k.id, actor.id, "assignment", previousName, agent.name, note, transaction, at);
    if (changes.status) await recordHistory(k.id, actor.id, "status", "open", "assigned", null, transaction, at);
    return { agent, k: { ...k, ...changes } };
  });

  if (!at) {
    const { agent, k } = result;
    await notify(agent.id, { type: "assignment", caseId: k.id, title: `Case ${k.case_no} was assigned to you`, message: note || k.subject });
    await notify(await customerUserId(k.customer_id), {
      type: "assignment", caseId: k.id, title: `${agent.name} is handling your case ${k.case_no}`, message: k.subject,
    });
  }
  return result.agent;
};

// Agent -> Team Leader (level 1); Team Leader -> CRM Manager (level 2). Reason is required.
export const escalateCase = async ({ caseId, user, reason, at = null }) => {
  const result = await sequelize.transaction(async (transaction) => {
    const row = await lockCaseForUser(caseId, user, transaction);
    const k = { ...row.get({ plain: true }) }; // a copy: row.update() would otherwise change k too (history "old value")
    if (!canEscalate(k, user)) throw new AppError("You can't escalate this case at its current level or status.", 403);
    if (String(reason || "").trim().length < MIN_NOTE_LENGTH) {
      throw new AppError(`Give a reason for the escalation (at least ${MIN_NOTE_LENGTH} characters).`, 422);
    }
    const fromLevel = Number(k.escalation_level);
    const toLevel = fromLevel + 1;
    const target = toLevel === 1 ? (await teamLeaderOf(k.team_id, transaction)) || (await managerFor(k.team_id, transaction)) : await managerFor(k.team_id, transaction);
    const now = at || new Date();
    await TicketEscalation.update(
      { outcome: "escalated", handled_by: user.id, handled_at: now, handling_note: "Escalated to the next level" },
      { where: { case_id: k.id, outcome: "pending" }, transaction }
    );
    await TicketEscalation.create({
      case_id: k.id, from_level: fromLevel, to_level: toLevel, escalated_by: user.id, escalated_to: target ? target.id : null,
      reason, ...(at ? { createdAt: at } : {}),
    }, { transaction });
    await row.update({ status: "escalated", escalation_level: toLevel }, { transaction, silent: Boolean(at) });
    await recordHistory(k.id, user.id, "escalation", `Level ${fromLevel}`, `Level ${toLevel}${target ? ` (${target.display_name})` : ""}`, reason, transaction, at);
    if (k.status !== "escalated") await recordHistory(k.id, user.id, "status", k.status, "escalated", null, transaction, at);
    return { k: { ...k, status: "escalated", escalation_level: toLevel }, target, toLevel };
  });
  if (!at) {
    const { k, target, toLevel } = result;
    if (target) {
      await notify(target.id, {
        type: "escalation", caseId: k.id,
        title: `Case ${k.case_no} escalated to you (${toLevel === 1 ? "Team Leader" : "CRM Manager"})`, message: reason,
      });
    }
    await notify(await customerUserId(k.customer_id), {
      type: "status_change", caseId: k.id, title: `Your case ${k.case_no} was escalated to a supervisor`, message: k.subject,
    });
  }
  return result;
};

// Supervisor actions on an escalated case: take_over (-> In Progress), return (-> Assigned, level 0), resolve.
export const handleEscalation = async ({ caseId, user, action, note, at = null }) => {
  const result = await sequelize.transaction(async (transaction) => {
    const row = await lockCaseForUser(caseId, user, transaction);
    const k = { ...row.get({ plain: true }) }; // a copy: row.update() would otherwise change k too (history "old value")
    if (!canHandleEscalation(k, user)) throw new AppError("Only the Team Leader (level 1) or the CRM Manager can act on this escalation.", 403);
    const now = at || new Date();
    let changes;
    let outcome = "handled";
    if (action === "take_over") changes = { status: "in_progress" };
    else if (action === "resolve") {
      if (String(note || "").trim().length < MIN_NOTE_LENGTH) throw new AppError(`Describe the resolution (at least ${MIN_NOTE_LENGTH} characters).`, 422);
      changes = { status: "resolved", resolved_at: now, ...(await postResolution(k, user, note, transaction, at)) };
    }
    else if (action === "return") {
      if (!k.assigned_agent_id) throw new AppError("Assign an agent before returning the case.", 422);
      changes = { status: "assigned", escalation_level: 0 };
      outcome = "returned";
    } else throw new AppError("Unknown escalation action.", 422);
    await TicketEscalation.update(
      { outcome, handled_by: user.id, handled_at: now, handling_note: note || null },
      { where: { case_id: k.id, outcome: "pending" }, transaction }
    );
    await row.update(changes, { transaction, silent: Boolean(at) });
    await recordHistory(k.id, user.id, "status", "escalated", changes.status,
      { take_over: "Supervisor took over the case", resolve: "Resolved by supervisor", return: "Returned to the assigned agent" }[action] + (note ? `: ${note}` : ""),
      transaction, at);
    return { k: { ...k, ...changes }, action };
  });
  if (!at) {
    const { k, action: done } = result;
    if (done === "return") await notify(k.assigned_agent_id, { type: "escalation", caseId: k.id, title: `Case ${k.case_no} was returned to you`, message: note || k.subject });
    if (done === "resolve") {
      await notify(await customerUserId(k.customer_id), {
        type: "resolved", caseId: k.id, title: `Your case ${k.case_no} was resolved`, message: "Please confirm the solution or rate our service.",
      });
    }
  }
  return result.k;
};

export const addComment = async ({ caseId, user, body, internal = false, validatedFiles = [], at = null }) => {
  const stored = await saveFiles(validatedFiles);
  let result;
  try {
    result = await sequelize.transaction(async (transaction) => {
      const row = await lockCaseForUser(caseId, user, transaction);
      const k = { ...row.get({ plain: true }) }; // a copy: row.update() would otherwise change k too (history "old value")
      const wantsInternal = user.role !== "customer" && internal;
      if (wantsInternal ? !canInternalNote(k, user) : !canReply(k, user)) {
        throw new AppError(k.status === "closed" ? "This case is closed." : "You can't reply on this case.", 403);
      }
      const visibility = wantsInternal ? "internal" : "public";
      const comment = await CaseComment.create({ case_id: k.id, author_id: user.id, visibility, body, ...stamp(at) }, { transaction, silent: Boolean(at) });
      for (const file of stored) {
        await Attachment.create({ ...file, entity_type: "case_comment", entity_id: comment.id, case_id: k.id, uploaded_by: user.id, visibility }, { transaction });
      }
      const changes = {};
      if (user.role !== "customer" && visibility === "public" && !k.first_response_at) changes.first_response_at = at || new Date();
      // A customer reply brings a "Waiting for Customer" case back to "In Progress".
      if (user.role === "customer" && k.status === "waiting_for_customer") {
        changes.status = "in_progress";
        await recordHistory(k.id, user.id, "status", "waiting_for_customer", "in_progress", "Customer replied", transaction, at);
      }
      if (Object.keys(changes).length) await row.update(changes, { transaction, silent: Boolean(at) });
      else if (!at) { row.changed("updated_at", true); await row.save({ transaction }); }
      return { visibility, k: { ...k, ...changes } };
    });
  } catch (err) {
    await removeFiles(stored.map((s) => s.stored_name));
    throw err;
  }
  if (!at) {
    const { visibility, k } = result;
    await markCaseRead(user.id, k.id);
    if (user.role === "customer") {
      await notify(await staffRecipients(k), { type: "new_reply", caseId: k.id, title: `New reply from ${user.name} on ${k.case_no}`, message: body.slice(0, 200) });
    } else if (visibility === "public") {
      await notify(await customerUserId(k.customer_id), { type: "new_reply", caseId: k.id, title: `New reply on your case ${k.case_no}`, message: body.slice(0, 200) });
    }
  }
  return result.visibility;
};

export const submitRating = async ({ caseId, user, rating, comment, at = null, isDemo = false }) => {
  const k = await findCaseForUser(caseId, user);
  if (!k) throw new AppError("Case not found.", 404);
  const existing = await getRating(caseId);
  if (!canRate(k, user, existing)) {
    throw new AppError(existing ? "You already rated this case." : "Rating is available once the case is resolved.", 422);
  }
  try {
    await sequelize.transaction(async (transaction) => {
      const r = await CustomerRating.create(
        { customer_id: user.customer_id, subject_type: "case", case_id: caseId, rating, is_demo: isDemo, ...(at ? { createdAt: at } : {}) },
        { transaction }
      );
      if (comment) {
        await CustomerFeedback.create({
          customer_id: user.customer_id, rating_id: r.id, case_id: caseId, feedback_type: "service", comment, is_demo: isDemo,
          ...(at ? { createdAt: at } : {}),
        }, { transaction });
      }
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw new AppError("You already rated this case.", 422);
    throw err;
  }
  if (!at && k.assigned_agent_id) {
    await notify(k.assigned_agent_id, { type: "feedback", caseId: k.id, title: `${user.name} rated ${k.case_no}: ${rating}/5`, message: comment || null });
  }
};

// ---------------------------------------------------------------- background rules (jobs/scheduler.js)

const SYSTEM_USER = { id: null, role: "system" };

export const autoCloseResolvedCases = async () => {
  const days = getSettings().autoCloseDays;
  const due = await select(
    `SELECT k.id FROM customer_cases k
     WHERE k.status = 'resolved' AND k.resolved_at <= NOW() - INTERVAL :days DAY
       AND NOT EXISTS (SELECT 1 FROM case_comments r JOIN customer_accounts ca ON ca.user_id = r.author_id
                       WHERE r.case_id = k.id AND ca.customer_id = k.customer_id AND r.created_at > k.resolved_at)`,
    { days }
  );
  let closed = 0;
  for (const { id } of due) {
    const k = await sequelize.transaction(async (transaction) => {
      const row = await lockCaseForUser(id, SYSTEM_USER, transaction);
      if (row.status !== "resolved") return null;
      await row.update({ status: "closed", closed_at: new Date() }, { transaction });
      await recordHistory(row.id, null, "status", "resolved", "closed", `Closed automatically: no customer reply within ${days} day(s) of resolution`, transaction);
      return row.get({ plain: true });
    });
    if (k) {
      closed++;
      await notify(await customerUserId(k.customer_id), {
        type: "status_change", caseId: k.id, title: `Case ${k.case_no} was closed automatically`,
        message: "No reply was received after it was resolved. You can still rate our service.",
      });
    }
  }
  return closed;
};

// One SLA overdue alert per case: assigned agent, team leader and CRM Managers.
export const notifyOverdueCases = async () => {
  const rows = await select(
    `SELECT k.id, k.case_no, k.subject, k.assigned_agent_id, k.team_id, k.priority, t.team_leader_id
     FROM customer_cases k LEFT JOIN crm_teams t ON t.id = k.team_id
     WHERE ${OVERDUE_SQL} AND k.sla_breach_notified_at IS NULL`
  );
  if (!rows.length) return 0;
  const managers = await userIdsByRole("crm_manager");
  for (const k of rows) {
    await notify([...managers, k.team_leader_id, k.assigned_agent_id], {
      type: "sla_overdue", caseId: k.id, title: `SLA overdue: ${k.case_no} (${PRIORITY_LABELS[k.priority]})`, message: k.subject,
    });
    await sequelize.query("UPDATE customer_cases SET sla_breach_notified_at = NOW() WHERE id = :id", { replacements: { id: k.id } });
  }
  return rows.length;
};
