/*
 * Customer service reports (CRM Manager: all teams; Team Leader: own team). Plain SQL aggregates
 * and basic statistics only (no AI/ML). The same filters drive the screen and the PDF/Excel/CSV
 * exports. Sales analytics and forecasts are added in P9 once sales data exists (P5).
 */
import { QueryTypes } from "sequelize";
import { sequelize, CASE_STATUSES, CASE_PRIORITIES } from "../models/index.js";
import { OVERDUE_SQL, ACTIVE_SQL, CUSTOMER_NAME_SQL } from "./caseService.js";
import { isoDay } from "../helpers/dates.js";
import { toId, oneOf } from "../helpers/validators.js";

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const num = (v) => (v === null || v === undefined ? null : Number(v));
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

export const parseReportFilters = (query, user) => {
  const today = isoDay(new Date());
  const monthAgo = isoDay(new Date(Date.now() - 29 * 86400000));
  let from = isDay(query.from) ? query.from : monthAgo;
  let to = isDay(query.to) ? query.to : today;
  if (from > to) [from, to] = [to, from];
  return {
    from,
    to,
    category_id: toId(query.category_id),
    priority: oneOf(query.priority, CASE_PRIORITIES),
    agent: toId(query.agent),
    status: oneOf(query.status, CASE_STATUSES),
    // Team Leaders always see their own team; the CRM Manager may pick a team.
    team: user.role === "team_leader" ? user.team_id || 0 : toId(query.team),
    period: oneOf(query.period, ["daily", "weekly", "monthly"]) || "daily",
  };
};

const whereFor = (f) => {
  const where = ["k.created_at >= :from", "k.created_at < DATE_ADD(:to, INTERVAL 1 DAY)"];
  const params = { from: f.from, to: f.to };
  if (f.category_id) { where.push("k.category_id = :categoryId"); params.categoryId = f.category_id; }
  if (f.priority) { where.push("k.priority = :priority"); params.priority = f.priority; }
  if (f.agent) { where.push("k.assigned_agent_id = :agent"); params.agent = f.agent; }
  if (f.status) { where.push("k.status = :status"); params.status = f.status; }
  if (f.team !== null && f.team !== undefined) { where.push("k.team_id = :team"); params.team = f.team; }
  return { sql: where.join(" AND "), params };
};

const PERIOD_SQL = {
  daily: (col) => `DATE_FORMAT(${col}, '%Y-%m-%d')`,
  weekly: (col) => `DATE_FORMAT(DATE_SUB(DATE(${col}), INTERVAL WEEKDAY(${col}) DAY), '%Y-%m-%d')`,
  monthly: (col) => `DATE_FORMAT(${col}, '%Y-%m')`,
};

export const buildReport = async (filters) => {
  const w = whereFor(filters);

  const [k] = await select(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(${ACTIVE_SQL()}), 0) AS active,
            COALESCE(SUM(k.status IN ('resolved','closed')), 0) AS resolved,
            COALESCE(SUM(${OVERDUE_SQL}), 0) AS overdue,
            COALESCE(SUM(k.reopen_count > 0), 0) AS reopened_cases,
            COALESCE(SUM(EXISTS (SELECT 1 FROM ticket_escalations e WHERE e.case_id = k.id)), 0) AS escalated_cases,
            COALESCE(SUM(k.is_demo), 0) AS demo_count,
            AVG(CASE WHEN k.first_response_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, k.created_at, k.first_response_at) END) AS avg_first_response,
            AVG(CASE WHEN k.resolved_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, k.created_at, k.resolved_at) END) AS avg_resolution,
            COUNT(k.resolved_at) AS resolved_measured,
            COALESCE(SUM(k.resolved_at IS NOT NULL AND k.resolved_at <= k.resolution_due_at), 0) AS resolved_within_sla,
            COUNT(k.first_response_at) AS responded,
            COALESCE(SUM(k.first_response_at IS NOT NULL AND k.first_response_at <= k.first_response_due_at), 0) AS responded_within_sla
     FROM customer_cases k WHERE ${w.sql}`,
    w.params
  );
  const kpi = Object.fromEntries(Object.entries(k).map(([key, v]) => [key, num(v)]));
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  kpi.sla_resolution_pct = pct(kpi.resolved_within_sla, kpi.resolved_measured);
  kpi.sla_first_response_pct = pct(kpi.responded_within_sla, kpi.responded);
  kpi.reopen_rate = pct(kpi.reopened_cases, kpi.total);
  kpi.resolution_rate = pct(kpi.resolved, kpi.total);
  kpi.escalation_rate = pct(kpi.escalated_cases, kpi.total);

  const byCategory = await select(
    `SELECT c.name, COUNT(*) AS total, COALESCE(SUM(k.status IN ('resolved','closed')), 0) AS resolved
     FROM customer_cases k JOIN case_categories c ON c.id = k.category_id WHERE ${w.sql}
     GROUP BY c.id, c.name ORDER BY total DESC, c.name`, w.params);
  const byPriority = await select(
    `SELECT k.priority, COUNT(*) AS total FROM customer_cases k WHERE ${w.sql}
     GROUP BY k.priority ORDER BY FIELD(k.priority,'urgent','high','medium','low')`, w.params);
  const byStatus = await select(
    `SELECT k.status, COUNT(*) AS total FROM customer_cases k WHERE ${w.sql}
     GROUP BY k.status ORDER BY FIELD(k.status,'open','assigned','in_progress','waiting_for_customer','escalated','resolved','closed')`, w.params);
  const byType = await select(
    `SELECT k.case_type, COUNT(*) AS total FROM customer_cases k WHERE ${w.sql} GROUP BY k.case_type ORDER BY total DESC`, w.params);
  const topComplaints = await select(
    `SELECT c.name, COUNT(*) AS total FROM customer_cases k JOIN case_categories c ON c.id = k.category_id
     WHERE ${w.sql} AND k.case_type = 'complaint' GROUP BY c.id, c.name ORDER BY total DESC, c.name LIMIT 5`, w.params);

  const agents = await select(
    `SELECT u.display_name AS name, t.name AS team_name, COUNT(k.id) AS handled,
            COALESCE(SUM(k.status IN ('resolved','closed')), 0) AS resolved,
            COALESCE(SUM(${OVERDUE_SQL}), 0) AS overdue,
            AVG(CASE WHEN k.first_response_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, k.created_at, k.first_response_at) END) AS avg_first_response,
            AVG(CASE WHEN k.resolved_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, k.created_at, k.resolved_at) END) AS avg_resolution,
            AVG(r.rating) AS avg_rating, COUNT(r.id) AS ratings
     FROM customer_cases k JOIN crm_users u ON u.id = k.assigned_agent_id
     LEFT JOIN crm_teams t ON t.id = u.team_id
     LEFT JOIN customer_ratings r ON r.case_id = k.id
     WHERE ${w.sql} GROUP BY u.id, u.display_name, t.name ORDER BY handled DESC, u.display_name`, w.params);

  const [csat] = await select(
    `SELECT COUNT(r.id) AS total, AVG(r.rating) AS avg, COALESCE(SUM(r.rating >= 4), 0) AS satisfied
     FROM customer_ratings r JOIN customer_cases k ON k.id = r.case_id WHERE ${w.sql}`, w.params);
  const dist = await select(
    `SELECT r.rating, COUNT(*) AS total FROM customer_ratings r JOIN customer_cases k ON k.id = r.case_id
     WHERE ${w.sql} GROUP BY r.rating`, w.params);
  const byRating = Object.fromEntries(dist.map((d) => [Number(d.rating), Number(d.total)]));
  const csatInfo = {
    total: num(csat.total),
    avg: num(csat.avg),
    satisfied_pct: Number(csat.total) ? Math.round((Number(csat.satisfied) / Number(csat.total)) * 1000) / 10 : null,
    distribution: [5, 4, 3, 2, 1].map((rating) => ({ rating, total: byRating[rating] || 0 })),
  };

  const periodCreated = PERIOD_SQL[filters.period]("k.created_at");
  const periodResolved = PERIOD_SQL[filters.period]("k.resolved_at");
  const created = await select(
    `SELECT ${periodCreated} AS period, COUNT(*) AS total FROM customer_cases k WHERE ${w.sql} GROUP BY period ORDER BY period`, w.params);
  const resolved = await select(
    `SELECT ${periodResolved} AS period, COUNT(*) AS total FROM customer_cases k WHERE ${w.sql} AND k.resolved_at IS NOT NULL
     GROUP BY period ORDER BY period`, w.params);
  const periods = [...new Set([...created.map((r) => r.period), ...resolved.map((r) => r.period)])].sort();
  const lookup = (rows) => Object.fromEntries(rows.map((r) => [r.period, Number(r.total)]));
  const c = lookup(created);
  const r = lookup(resolved);
  const trend = periods.map((p) => ({ period: p, created: c[p] || 0, resolved: r[p] || 0 }));

  return { filters, kpi, byCategory, byPriority, byStatus, byType, topComplaints, agents, csat: csatInfo, trend };
};

export const reportCases = (filters, limit = 5000) => {
  const w = whereFor(filters);
  return select(
    `SELECT k.case_no, k.created_at, k.subject, k.case_type, c.name AS category, k.priority, k.status,
            ${CUSTOMER_NAME_SQL} AS customer, ag.display_name AS agent, k.first_response_at, k.resolved_at, k.closed_at,
            k.resolution_due_at, k.reopen_count, ${OVERDUE_SQL} AS is_overdue,
            TIMESTAMPDIFF(MINUTE, k.created_at, k.first_response_at) AS first_response_minutes,
            TIMESTAMPDIFF(MINUTE, k.created_at, k.resolved_at) AS resolution_minutes,
            r.rating, k.is_demo
     FROM customer_cases k JOIN case_categories c ON c.id = k.category_id JOIN customers cu ON cu.id = k.customer_id
     LEFT JOIN crm_users ag ON ag.id = k.assigned_agent_id LEFT JOIN customer_ratings r ON r.case_id = k.id
     WHERE ${w.sql} ORDER BY k.created_at DESC LIMIT :limit`,
    { ...w.params, limit }
  );
};
