/*
 * Dashboard figures. Every number is computed live with SQL and respects the viewer's record scope;
 * nothing is hard-coded. Each summary also reports how many counted records are demo records.
 * Sales, loyalty, approvals, team-target and retention widgets come from their own services (P5–P9).
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { OVERDUE_SQL, ACTIVE_SQL, CUSTOMER_NAME_SQL, scopeFor } from "./caseService.js";
import { config } from "../config/index.js";
import { modeOf } from "./integration/adapterBase.js";

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });

export const caseSummary = async (user) => {
  const scope = scopeFor(user);
  const [row] = await select(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(k.status = 'open'), 0) AS open_count,
            COALESCE(SUM(k.status = 'assigned'), 0) AS assigned_count,
            COALESCE(SUM(k.status = 'in_progress'), 0) AS in_progress_count,
            COALESCE(SUM(k.status = 'waiting_for_customer'), 0) AS waiting_count,
            COALESCE(SUM(k.status = 'escalated'), 0) AS escalated_count,
            COALESCE(SUM(k.status = 'resolved'), 0) AS resolved_count,
            COALESCE(SUM(k.status = 'closed'), 0) AS closed_count,
            COALESCE(SUM(${ACTIVE_SQL()}), 0) AS active_count,
            COALESCE(SUM(${OVERDUE_SQL}), 0) AS overdue_count,
            COALESCE(SUM(k.status = 'open' AND k.assigned_agent_id IS NULL), 0) AS unassigned_count,
            COALESCE(SUM(k.case_type = 'complaint' AND ${ACTIVE_SQL()}), 0) AS open_complaints,
            COALESCE(SUM(k.is_demo), 0) AS demo_count,
            COALESCE(SUM(k.created_at >= CURDATE()), 0) AS today_count,
            COALESCE(SUM(k.resolved_at >= NOW() - INTERVAL 7 DAY), 0) AS resolved_7d,
            COALESCE(SUM(k.status = 'in_progress' AND k.first_response_at IS NULL), 0) AS awaiting_first_response
     FROM customer_cases k WHERE ${scope.sql}`,
    scope.params
  );
  const n = Object.fromEntries(Object.entries(row).map(([key, v]) => [key, Number(v) || 0]));
  n.real_count = n.total - n.demo_count;
  n.done_count = n.resolved_count + n.closed_count;
  n.resolution_rate = n.total ? Math.round((n.done_count / n.total) * 100) : null;
  return n;
};

export const recentCases = (user, limit = 8, extraWhere = "") => {
  const scope = scopeFor(user);
  return select(
    `SELECT k.id, k.case_no, k.subject, k.status, k.priority, k.escalation_level, k.created_at, k.is_demo,
            c.name AS category_name, ${CUSTOMER_NAME_SQL} AS customer_name, ag.display_name AS agent_name, ${OVERDUE_SQL} AS is_overdue
     FROM customer_cases k
     JOIN customers cu ON cu.id = k.customer_id
     JOIN case_categories c ON c.id = k.category_id
     LEFT JOIN crm_users ag ON ag.id = k.assigned_agent_id
     WHERE ${scope.sql} ${extraWhere}
     ORDER BY k.created_at DESC, k.id DESC LIMIT :limit`,
    { ...scope.params, limit }
  );
};

// Active cases for an agent: overdue first, then by resolution due date.
export const agentQueue = (agentId, limit = 10) =>
  select(
    `SELECT k.id, k.case_no, k.subject, k.status, k.priority, k.escalation_level, k.created_at, k.resolution_due_at, k.is_demo,
            c.name AS category_name, ${CUSTOMER_NAME_SQL} AS customer_name, ${OVERDUE_SQL} AS is_overdue
     FROM customer_cases k
     JOIN customers cu ON cu.id = k.customer_id
     JOIN case_categories c ON c.id = k.category_id
     WHERE k.assigned_agent_id = :agentId AND ${ACTIVE_SQL()}
     ORDER BY is_overdue DESC, k.resolution_due_at ASC LIMIT :limit`,
    { agentId, limit }
  );

export const casesByCategory = async (user) => {
  const scope = scopeFor(user);
  const rows = await select(
    `SELECT c.id, c.name, COUNT(k.id) AS total, COALESCE(SUM(${ACTIVE_SQL()}), 0) AS active
     FROM case_categories c LEFT JOIN customer_cases k ON k.category_id = c.id AND ${scope.sql}
     GROUP BY c.id, c.name HAVING total > 0 ORDER BY total DESC, c.name`,
    scope.params
  );
  return { rows, max: rows.reduce((m, r) => Math.max(m, Number(r.total)), 0) };
};

export const activeByPriority = async (user) => {
  const scope = scopeFor(user);
  const rows = await select(
    `SELECT k.priority, COUNT(*) AS total FROM customer_cases k WHERE ${scope.sql} AND ${ACTIVE_SQL()}
     GROUP BY k.priority ORDER BY FIELD(k.priority,'urgent','high','medium','low')`,
    scope.params
  );
  return { rows, max: rows.reduce((m, r) => Math.max(m, Number(r.total)), 0) };
};

// Workload and performance per agent. Team Leader: own team only.
export const agentWorkload = (user) =>
  select(
    `SELECT u.id, u.display_name AS name, u.email, u.is_active, u.is_available, u.is_demo, u.access_revoked_at,
            t.name AS team_name, e.employment_status, e.is_mock,
            COALESCE(SUM(k.status IN ('open','assigned')), 0) AS new_count,
            COALESCE(SUM(k.status = 'in_progress'), 0) AS in_progress_count,
            COALESCE(SUM(k.status = 'waiting_for_customer'), 0) AS waiting_count,
            COALESCE(SUM(k.status = 'escalated'), 0) AS escalated_count,
            COALESCE(SUM(${OVERDUE_SQL}), 0) AS overdue_count,
            COALESCE(SUM(k.status IN ('resolved','closed')), 0) AS done_count,
            COUNT(k.id) AS handled_count,
            AVG(CASE WHEN k.first_response_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, k.created_at, k.first_response_at) END) AS avg_first_response,
            AVG(CASE WHEN k.resolved_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, k.created_at, k.resolved_at) END) AS avg_resolution_minutes,
            (SELECT AVG(r.rating) FROM customer_ratings r JOIN customer_cases rk ON rk.id = r.case_id WHERE rk.assigned_agent_id = u.id) AS avg_rating,
            (SELECT COUNT(*) FROM customer_ratings r JOIN customer_cases rk ON rk.id = r.case_id WHERE rk.assigned_agent_id = u.id) AS rating_count
     FROM crm_users u
     LEFT JOIN crm_teams t ON t.id = u.team_id
     LEFT JOIN employee_references e ON e.employee_id = u.employee_id
     LEFT JOIN customer_cases k ON k.assigned_agent_id = u.id
     WHERE u.role = 'agent' ${user.role === "team_leader" ? "AND u.team_id = :teamId" : ""}
     GROUP BY u.id, u.display_name, u.email, u.is_active, u.is_available, u.is_demo, u.access_revoked_at, t.name, e.employment_status, e.is_mock
     ORDER BY t.name, u.display_name`,
    { teamId: user.team_id || 0 }
  );

export const teamSummary = () =>
  select(
    `SELECT t.id, t.team_code, t.name, tl.display_name AS leader_name,
            (SELECT COUNT(*) FROM crm_users a WHERE a.team_id = t.id AND a.role = 'agent' AND a.is_active = 1 AND a.access_revoked_at IS NULL) AS agent_count,
            (SELECT COUNT(*) FROM customer_cases k WHERE k.team_id = t.id AND ${ACTIVE_SQL()}) AS active_cases,
            (SELECT COUNT(*) FROM customer_cases k WHERE k.team_id = t.id AND ${OVERDUE_SQL}) AS overdue_cases,
            (SELECT COUNT(*) FROM customer_cases k WHERE k.team_id = t.id AND k.status = 'escalated') AS escalated_cases
     FROM crm_teams t LEFT JOIN crm_users tl ON tl.id = t.team_leader_id WHERE t.is_active = 1 ORDER BY t.team_code`
  );

export const ratingSummary = async (user) => {
  const scope = scopeFor(user);
  const [row] = await select(
    `SELECT COUNT(r.id) AS total, AVG(r.rating) AS avg_rating, COALESCE(SUM(r.is_demo), 0) AS demo_count
     FROM customer_ratings r JOIN customer_cases k ON k.id = r.case_id WHERE ${scope.sql}`,
    scope.params
  );
  const dist = await select(
    `SELECT r.rating, COUNT(*) AS total FROM customer_ratings r JOIN customer_cases k ON k.id = r.case_id
     WHERE ${scope.sql} GROUP BY r.rating`,
    scope.params
  );
  const byRating = Object.fromEntries(dist.map((d) => [Number(d.rating), Number(d.total)]));
  const distribution = [5, 4, 3, 2, 1].map((rating) => ({ rating, total: byRating[rating] || 0 }));
  return {
    total: Number(row.total) || 0,
    avg: row.avg_rating === null ? null : Number(row.avg_rating),
    demo_count: Number(row.demo_count) || 0,
    distribution,
    max: distribution.reduce((m, d) => Math.max(m, d.total), 0),
  };
};

export const responseTimes = async (user) => {
  const scope = scopeFor(user);
  const [row] = await select(
    `SELECT AVG(CASE WHEN k.first_response_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, k.created_at, k.first_response_at) END) AS avg_first_response,
            AVG(CASE WHEN k.resolved_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, k.created_at, k.resolved_at) END) AS avg_resolution,
            COUNT(k.first_response_at) AS responded_count, COUNT(k.resolved_at) AS resolved_count
     FROM customer_cases k WHERE ${scope.sql}`,
    scope.params
  );
  return row;
};

export const customerStats = async () => {
  const [row] = await select(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(c.status = 'active'), 0) AS active,
            COALESCE(SUM(c.created_at >= NOW() - INTERVAL 30 DAY), 0) AS new_30d,
            COALESCE(SUM(EXISTS (SELECT 1 FROM customer_accounts ca WHERE ca.customer_id = c.id)), 0) AS with_portal,
            COALESCE(SUM(c.is_demo), 0) AS demo_count
     FROM customers c WHERE c.status <> 'merged'`
  );
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v) || 0]));
};

export const pendingEscalations = (user, limit = 8) => {
  const scope = scopeFor(user);
  return select(
    `SELECT k.id, k.case_no, k.subject, k.priority, k.escalation_level, k.updated_at, ${CUSTOMER_NAME_SQL} AS customer_name,
            e.reason, e.created_at AS escalated_at, eb.display_name AS escalated_by_name, tm.name AS team_name
     FROM customer_cases k JOIN customers cu ON cu.id = k.customer_id
     LEFT JOIN crm_teams tm ON tm.id = k.team_id
     LEFT JOIN ticket_escalations e ON e.case_id = k.id AND e.outcome = 'pending'
     LEFT JOIN crm_users eb ON eb.id = e.escalated_by
     WHERE ${scope.sql} AND k.status = 'escalated' ${user.role === "team_leader" ? "AND k.escalation_level = 1" : ""}
     ORDER BY k.escalation_level DESC, e.created_at ASC LIMIT :limit`,
    { ...scope.params, limit }
  );
};

// Feature/adapter states shown as dashboard queue cards (no invented numbers).
export const platformStatus = () => ({
  approvalsEnabled: config.features.approvalsEnabled,
  hrMode: modeOf("hr"),
  inventoryMode: modeOf("inventory"),
  accountingMode: modeOf("accounting"),
});

export const casesAwaitingRating = (customerId) =>
  select(
    `SELECT k.id, k.case_no, k.subject, k.status, k.resolved_at, k.closed_at
     FROM customer_cases k LEFT JOIN customer_ratings r ON r.case_id = k.id
     WHERE k.customer_id = :customerId AND k.status IN ('resolved','closed') AND r.id IS NULL
     ORDER BY COALESCE(k.resolved_at, k.closed_at) DESC LIMIT 5`,
    { customerId }
  );
