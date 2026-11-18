/*
 * Follow-up tasks, P4 (blueprint: Agent "Follow-up Tasks", Team Leader "Follow-ups" / overdue follow-ups).
 * A task belongs to a customer, is assigned to one staff member and has a due date and a priority. Status flow:
 *   pending -> done | cancelled           (overdue is not a status: it is a pending task whose due time has passed)
 * Record scope (applied in SQL on every read, and again on every action):
 *   agent         tasks assigned to the agent
 *   team_leader   tasks assigned to the leader or a team agent
 *   crm_manager   every task
 * Who may be assigned: an agent only herself; a Team Leader herself or an agent of her team; the Manager any active
 * staff member. Creating a task needs the customer to be in the creator's customer scope.
 * Completing or cancelling a task appends a dated line to its notes (the table has no separate outcome column).
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { AppError } from "../helpers/errors.js";
import { config } from "../config/index.js";
import { directoryScope } from "./customerService.js";
import { scopeFor } from "./caseService.js";
import { notify } from "./notificationService.js";

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
const exec = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction });

export const FOLLOWUP_PRIORITIES = [["low", "Low"], ["medium", "Medium"], ["high", "High"]];
export const FOLLOWUP_STATUS_LABELS = { pending: "Pending", overdue: "Overdue", done: "Done", cancelled: "Cancelled" };
export const MIN_REASON_LENGTH = 5;

// "2026-11-13T14:30" (datetime-local, Asia/Manila) -> Date; empty means "not given".
export const parseLocal = (raw) => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(String(raw || ""));
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:00${config.db.timezone}`);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ---------------------------------------------------------------- scope

export const followUpScope = (user) => {
  if (user.role === "crm_manager") return { sql: "1=1", params: {} };
  if (user.role === "team_leader") return { sql: "(f.assigned_to = :fuMe OR a.team_id = :fuTeam)", params: { fuMe: user.id, fuTeam: user.team_id || 0 } };
  if (user.role === "agent") return { sql: "f.assigned_to = :fuMe", params: { fuMe: user.id } };
  return { sql: "1=0", params: {} };
};

// May this user change the task (complete, cancel, reschedule)? Already inside their scope.
const canChange = (task, user) => user.role !== "agent" || Number(task.assigned_to) === Number(user.id);

const OVERDUE_SQL = "(f.status = 'pending' AND f.due_at < NOW())";
const COLUMNS = `f.id, f.customer_id, f.case_id, f.assigned_to, f.created_by, f.title, f.notes, f.due_at, f.priority, f.status, f.completed_at, f.is_demo, f.created_at,
  ${OVERDUE_SQL} AS is_overdue, c.customer_no, CONCAT(c.first_name, ' ', c.last_name) AS customer_name,
  a.display_name AS assignee_name, a.team_id AS assignee_team, cb.display_name AS created_by_name, k.case_no`;
const FROM = `FROM follow_up_tasks f
  JOIN customers c ON c.id = f.customer_id
  JOIN crm_users a ON a.id = f.assigned_to
  LEFT JOIN crm_users cb ON cb.id = f.created_by
  LEFT JOIN customer_cases k ON k.id = f.case_id`;

export const listFollowUps = async (user, { q, status, priority, assignee, limit, offset }) => {
  const scope = followUpScope(user);
  const where = [scope.sql];
  const params = { ...scope.params };
  if (q) {
    where.push("(f.title LIKE :q OR f.notes LIKE :q OR c.customer_no LIKE :q OR CONCAT(c.first_name, ' ', c.last_name) LIKE :q OR k.case_no LIKE :q)");
    params.q = `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
  }
  if (status === "overdue") where.push(OVERDUE_SQL);
  else if (status === "today") where.push("(f.status = 'pending' AND DATE(f.due_at) <= CURDATE())");
  else if (status === "upcoming") where.push("(f.status = 'pending' AND f.due_at >= NOW())");
  else if (["pending", "done", "cancelled"].includes(status)) { where.push("f.status = :status"); params.status = status; }
  if (priority) { where.push("f.priority = :priority"); params.priority = priority; }
  if (assignee) { where.push("f.assigned_to = :assignee"); params.assignee = assignee; }
  const [{ total }] = await select(`SELECT COUNT(*) AS total ${FROM} WHERE ${where.join(" AND ")}`, params);
  const rows = await select(
    `SELECT ${COLUMNS} ${FROM} WHERE ${where.join(" AND ")}
     ORDER BY (f.status <> 'pending'), f.due_at ASC, FIELD(f.priority,'high','medium','low'), f.id DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset }
  );
  return { total: Number(total), rows };
};

export const findFollowUp = async (id, user) => {
  const scope = followUpScope(user);
  const [row] = await select(`SELECT ${COLUMNS} ${FROM} WHERE f.id = :id AND ${scope.sql}`, { id, ...scope.params });
  return row || null;
};

// Counts for the lists and dashboards.
export const followUpSummary = async (user) => {
  const scope = followUpScope(user);
  const [row] = await select(
    `SELECT COALESCE(SUM(f.status = 'pending'), 0) AS pending_count,
            COALESCE(SUM(${OVERDUE_SQL}), 0) AS overdue_count,
            COALESCE(SUM(f.status = 'pending' AND DATE(f.due_at) <= CURDATE()), 0) AS today_count,
            COALESCE(SUM(f.status = 'done'), 0) AS done_count
     ${FROM} WHERE ${scope.sql}`, scope.params);
  return { pending: Number(row.pending_count), overdue: Number(row.overdue_count), today: Number(row.today_count), done: Number(row.done_count) };
};

// Pending tasks due today or earlier (overdue first), for the agent's "Today's follow-ups".
export const dueFollowUps = async (user, limit = 5) => {
  const scope = followUpScope(user);
  return select(
    `SELECT ${COLUMNS} ${FROM} WHERE ${scope.sql} AND f.status = 'pending' AND DATE(f.due_at) <= CURDATE() ORDER BY f.due_at ASC LIMIT :limit`,
    { ...scope.params, limit }
  );
};

// People a user may assign a task to.
export const assignableStaff = async (user) => {
  if (user.role === "agent") return [{ id: user.id, name: user.name || "Me", role: "agent", team_name: null, self: true }];
  const rows = await select(
    `SELECT u.id, u.display_name AS name, u.role, t.name AS team_name FROM crm_users u LEFT JOIN crm_teams t ON t.id = u.team_id
     WHERE u.user_type = 'staff' AND u.is_active = 1 AND u.access_revoked_at IS NULL
       ${user.role === "team_leader" ? "AND (u.id = :me OR (u.role = 'agent' AND u.team_id = :teamId))" : ""}
     ORDER BY FIELD(u.role,'crm_manager','team_leader','agent'), u.display_name`,
    { me: user.id, teamId: user.team_id || 0 }
  );
  return rows.map((r) => ({ ...r, self: r.id === user.id }));
};

// ---------------------------------------------------------------- validation

export const validateFollowUp = (raw) => {
  const errors = [];
  const v = { customer_id: raw.customer_id, title: raw.title, notes: raw.notes, due_at: raw.due_at, priority: raw.priority, assigned_to: raw.assigned_to, case_no: raw.case_no };
  if (!v.customer_id) errors.push("Choose the customer.");
  if (!v.title || v.title.length < 5) errors.push("Describe the task (at least 5 characters).");
  if (!FOLLOWUP_PRIORITIES.some(([k]) => k === v.priority)) errors.push("Choose a priority.");
  const due = parseLocal(v.due_at);
  if (!due) errors.push("Enter a valid due date and time.");
  else if (due.getTime() < Date.now() - 5 * 60 * 1000) errors.push("The due date cannot be in the past.");
  else if (due.getTime() > Date.now() + 366 * 86400000) errors.push("The due date is more than a year away.");
  v.due = due;
  return { errors, values: v };
};

// ---------------------------------------------------------------- create / change

const requireAssignee = async (assigneeId, user, transaction) => {
  const id = assigneeId || user.id;
  if (user.role === "agent" && Number(id) !== Number(user.id)) throw new AppError("Agents can create follow-ups only for themselves.", 403);
  const [u] = await select(
    "SELECT id, display_name AS name, role, team_id FROM crm_users WHERE id = :id AND user_type = 'staff' AND is_active = 1 AND access_revoked_at IS NULL", { id }, transaction);
  if (!u) throw new AppError("Choose an active staff member.", 422);
  if (user.role === "team_leader" && Number(u.id) !== Number(user.id) && !(u.role === "agent" && Number(u.team_id) === Number(user.team_id))) {
    throw new AppError("Team Leaders can assign tasks only to themselves or to agents of their own team.", 403);
  }
  return u;
};

export const createFollowUp = async ({ user, values, at = null, isDemo = false }) => {
  const out = await sequelize.transaction(async (transaction) => {
    const scope = directoryScope(user);
    const [customer] = await select(`SELECT c.id FROM customers c WHERE c.id = :id AND c.status <> 'merged' AND ${scope.sql}`, { id: values.customer_id, ...scope.params }, transaction);
    if (!customer) throw new AppError("Customer not found.", 404);
    const assignee = await requireAssignee(values.assigned_to, user, transaction);
    let caseId = null;
    if (values.case_no) {
      const cs = scopeFor(user);
      const [k] = await select(`SELECT k.id, k.customer_id FROM customer_cases k WHERE k.case_no = :no AND ${cs.sql}`, { no: values.case_no, ...cs.params }, transaction);
      if (!k || Number(k.customer_id) !== Number(customer.id)) throw new AppError("That case number was not found for this customer.", 422);
      caseId = k.id;
    }
    const created = at || new Date();
    const [id] = await sequelize.query(
      `INSERT INTO follow_up_tasks (customer_id, case_id, assigned_to, created_by, title, notes, due_at, priority, status, is_demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      { replacements: [customer.id, caseId, assignee.id, user.id, values.title, values.notes || null, values.due, values.priority, isDemo ? 1 : 0, created, created], transaction }
    );
    return { id, assignee, caseId };
  });
  if (!at && out.assignee.id !== user.id) {
    await notify(out.assignee.id, {
      type: "follow_up", title: `A follow-up was assigned to you: ${values.title}`.slice(0, 150), message: `Due ${new Intl.DateTimeFormat("en-PH", { timeZone: config.timezone, dateStyle: "medium", timeStyle: "short" }).format(values.due)}`,
      link: `/crm/follow-ups/${out.id}`, relatedType: "follow_up", relatedId: out.id,
    });
  }
  return out;
};

const lockTask = async (id, user, transaction) => {
  const scope = followUpScope(user);
  const [row] = await select(`SELECT f.* FROM follow_up_tasks f JOIN crm_users a ON a.id = f.assigned_to WHERE f.id = :id AND ${scope.sql} FOR UPDATE`, { id, ...scope.params }, transaction);
  if (!row) throw new AppError("Follow-up not found.", 404);
  if (!canChange(row, user)) throw new AppError("This follow-up belongs to someone else.", 403);
  return row;
};

const requirePending = (task) => {
  if (task.status !== "pending") throw new AppError(`This follow-up is already ${task.status}.`, 422);
};

const stamp = () => new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export const completeFollowUp = ({ id, user, note }) =>
  sequelize.transaction(async (transaction) => {
    const task = await lockTask(id, user, transaction);
    requirePending(task);
    const line = `${stamp()} Done${note ? `: ${note}` : ""}`;
    await exec("UPDATE follow_up_tasks SET status = 'done', completed_at = NOW(), notes = CONCAT_WS('\n', notes, ?) WHERE id = ?", [line, id], transaction);
    return task;
  });

export const cancelFollowUp = ({ id, user, reason }) =>
  sequelize.transaction(async (transaction) => {
    const task = await lockTask(id, user, transaction);
    requirePending(task);
    if (String(reason || "").trim().length < MIN_REASON_LENGTH) throw new AppError(`Give a reason for cancelling (at least ${MIN_REASON_LENGTH} characters).`, 422);
    await exec("UPDATE follow_up_tasks SET status = 'cancelled', notes = CONCAT_WS('\n', notes, ?) WHERE id = ?", [`${stamp()} Cancelled: ${String(reason).trim()}`, id], transaction);
    return task;
  });

export const rescheduleFollowUp = ({ id, user, dueRaw }) =>
  sequelize.transaction(async (transaction) => {
    const task = await lockTask(id, user, transaction);
    requirePending(task);
    const due = parseLocal(dueRaw);
    if (!due) throw new AppError("Enter a valid due date and time.", 422);
    if (due.getTime() < Date.now() - 5 * 60 * 1000) throw new AppError("The new due date cannot be in the past.", 422);
    if (due.getTime() > Date.now() + 366 * 86400000) throw new AppError("The due date is more than a year away.", 422);
    await exec("UPDATE follow_up_tasks SET due_at = ?, notes = CONCAT_WS('\n', notes, ?) WHERE id = ?", [due, `${stamp()} Rescheduled`, id], transaction);
    return { task, due };
  });

export const reassignFollowUp = async ({ id, actor, assigneeId }) => {
  const out = await sequelize.transaction(async (transaction) => {
    if (!["team_leader", "crm_manager"].includes(actor.role)) throw new AppError("Only a Team Leader or the CRM Manager can reassign follow-ups.", 403);
    const task = await lockTask(id, actor, transaction);
    requirePending(task);
    const assignee = await requireAssignee(assigneeId, actor, transaction);
    if (Number(assignee.id) === Number(task.assigned_to)) throw new AppError(`This follow-up is already assigned to ${assignee.name}.`, 422);
    await exec("UPDATE follow_up_tasks SET assigned_to = ?, notes = CONCAT_WS('\n', notes, ?) WHERE id = ?", [assignee.id, `${stamp()} Reassigned to ${assignee.name}`, id], transaction);
    return { task, assignee };
  });
  await notify(out.assignee.id, { type: "follow_up", title: `A follow-up was assigned to you: ${out.task.title}`.slice(0, 150), link: `/crm/follow-ups/${id}`, relatedType: "follow_up", relatedId: id });
  return out;
};

// ---------------------------------------------------------------- background rule (jobs/scheduler.js)

// One reminder per task: the assignee is told once when a pending task becomes due. The notification itself is the marker.
export const notifyDueFollowUps = async () => {
  const rows = await select(
    `SELECT f.id, f.assigned_to, f.title FROM follow_up_tasks f
     WHERE f.status = 'pending' AND f.due_at <= NOW()
       AND NOT EXISTS (SELECT 1 FROM crm_notifications n WHERE n.related_type = 'follow_up' AND n.related_id = f.id AND n.type = 'follow_up' AND n.title LIKE 'Follow-up due:%')`
  );
  for (const f of rows) {
    await notify(f.assigned_to, { type: "follow_up", title: `Follow-up due: ${f.title}`.slice(0, 150), link: `/crm/follow-ups/${f.id}`, relatedType: "follow_up", relatedId: f.id });
  }
  return rows.length;
};
