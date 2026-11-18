/*
 * Team targets (P8). The targets are the blueprint's service_targets (first-response and resolution minutes per priority, per team or
 * the default for every team); each case gets its due times from them when it is created. This only measures how often those due times
 * were met, from real case rows. There is no sales target table, so there is no sales target (the UI-pass mock-up showed one; it was removed).
 *   first response met   first_response_at <= first_response_due_at, counted over cases whose first response is done or already due
 *   resolution met       resolved_at <= resolution_due_at, counted over cases that are resolved or already due
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const pct = (met, total) => (total ? Math.round((met / total) * 100) : null);

export const teamTargets = async ({ teamId = null, days = 30 } = {}) => {
  const team = teamId ? "AND k.team_id = :teamId" : "";
  const [row] = await select(
    `SELECT
       SUM(k.first_response_due_at IS NOT NULL AND (k.first_response_at IS NOT NULL OR k.first_response_due_at < NOW())) AS fr_total,
       SUM(k.first_response_at IS NOT NULL AND k.first_response_at <= k.first_response_due_at) AS fr_met,
       SUM(k.resolution_due_at IS NOT NULL AND (k.resolved_at IS NOT NULL OR k.resolution_due_at < NOW())) AS res_total,
       SUM(k.resolved_at IS NOT NULL AND k.resolved_at <= k.resolution_due_at) AS res_met,
       SUM(k.is_demo = 1) AS demo
     FROM customer_cases k WHERE k.created_at >= NOW() - INTERVAL :days DAY ${team}`, { teamId, days });
  const targets = await select(
    `SELECT s.priority, s.first_response_minutes, s.resolution_minutes, s.team_id FROM service_targets s
     WHERE (s.team_id IS NULL OR s.team_id = :teamId) AND s.effective_from <= NOW()
     ORDER BY FIELD(s.priority, 'urgent', 'high', 'medium', 'low'), s.team_id IS NULL, s.effective_from DESC`, { teamId: teamId || 0 });
  const byPriority = [];
  for (const t of targets) if (!byPriority.some((b) => b.priority === t.priority)) byPriority.push(t);
  const n = (v) => Number(v || 0);
  return {
    days, firstResponse: { met: n(row.fr_met), total: n(row.fr_total), pct: pct(n(row.fr_met), n(row.fr_total)) },
    resolution: { met: n(row.res_met), total: n(row.res_total), pct: pct(n(row.res_met), n(row.res_total)) },
    includesDemo: n(row.demo) > 0,
    targets: byPriority.map((t) => ({ priority: t.priority, firstResponseHours: Math.round((t.first_response_minutes / 60) * 10) / 10, resolutionHours: Math.round((t.resolution_minutes / 60) * 10) / 10, teamSpecific: t.team_id !== null })),
  };
};
