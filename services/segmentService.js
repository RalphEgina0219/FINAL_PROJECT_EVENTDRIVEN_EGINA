/*
 * Customer segments (P9): rule-based, no AI/ML. The segments and their rules are the five rows migration 104 created from the master
 * prompt; this file applies those rules to each customer's own completed (non-voided) sales and interactions:
 *   loyal     "Repeat customer with 6 or more completed sales in 6 months"
 *   regular   "Purchased in at least 2 of the last 3 months"            (2 different calendar months among this month and the 2 before)
 *   at_risk   "Regular customer with no purchase in the last 60 days"     (2 or more purchases in all, the last one 60–180 days ago)
 *   new       "First purchase or registration in the last 30 days"
 *   inactive  "No purchase or interaction in the last 180 days"
 * Checked in that order; a customer who matches none has no segment. Recomputed by the 5-minute job, after the demo seed and by the
 * Manager's button; a customer row changes only when the result changes. Merged customers are left alone.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const DAY_MS = 86400e3;

// Pure rule function (unit-tested). stats: { sales6m, monthsWithPurchase3m, totalSales, daysSinceLastPurchase, daysSinceFirstPurchase,
// daysSinceRegistration, daysSinceLastActivity } (null when there was none).
export const segmentFor = (s) => {
  if (s.sales6m >= 6) return "loyal";
  if (s.monthsWithPurchase3m >= 2) return "regular";
  if (s.totalSales >= 2 && s.daysSinceLastPurchase !== null && s.daysSinceLastPurchase > 60 && s.daysSinceLastPurchase <= 180) return "at_risk";
  if ((s.daysSinceFirstPurchase !== null && s.daysSinceFirstPurchase <= 30) || (s.totalSales === 0 && s.daysSinceRegistration <= 30)) return "new";
  if (s.daysSinceLastActivity === null || s.daysSinceLastActivity > 180) return "inactive";
  return null;
};

export const customerStats = async () => {
  const rows = await select(
    `SELECT c.id, c.segment_id, c.created_at,
            (SELECT COUNT(*) FROM sales_transactions s WHERE s.customer_id = c.id AND s.status <> 'voided' AND s.completed_at >= NOW() - INTERVAL 6 MONTH) AS sales6m,
            (SELECT COUNT(DISTINCT DATE_FORMAT(s.completed_at, '%Y-%m')) FROM sales_transactions s WHERE s.customer_id = c.id AND s.status <> 'voided'
               AND s.completed_at >= DATE_FORMAT(NOW() - INTERVAL 2 MONTH, '%Y-%m-01')) AS months3,
            (SELECT COUNT(*) FROM sales_transactions s WHERE s.customer_id = c.id AND s.status <> 'voided') AS total,
            (SELECT MAX(s.completed_at) FROM sales_transactions s WHERE s.customer_id = c.id AND s.status <> 'voided') AS last_purchase,
            (SELECT MIN(s.completed_at) FROM sales_transactions s WHERE s.customer_id = c.id AND s.status <> 'voided') AS first_purchase,
            GREATEST(COALESCE((SELECT MAX(i.occurred_at) FROM customer_interactions i WHERE i.customer_id = c.id), '1970-01-01'),
                     COALESCE((SELECT MAX(k.created_at) FROM customer_cases k WHERE k.customer_id = c.id), '1970-01-01'),
                     COALESCE((SELECT MAX(s.completed_at) FROM sales_transactions s WHERE s.customer_id = c.id AND s.status <> 'voided'), '1970-01-01')) AS last_activity
     FROM customers c WHERE c.status <> 'merged'`);
  const now = Date.now();
  const days = (d) => (d ? Math.floor((now - new Date(d).getTime()) / DAY_MS) : null);
  return rows.map((r) => {
    const lastActivity = new Date(r.last_activity).getFullYear() > 1970 ? r.last_activity : null;
    return {
      id: r.id, segment_id: r.segment_id,
      stats: {
        sales6m: Number(r.sales6m), monthsWithPurchase3m: Number(r.months3), totalSales: Number(r.total), daysSinceLastPurchase: days(r.last_purchase),
        daysSinceFirstPurchase: days(r.first_purchase), daysSinceRegistration: days(r.created_at), daysSinceLastActivity: days(lastActivity),
      },
    };
  });
};

export const recomputeSegments = async () => {
  const ids = Object.fromEntries((await select("SELECT id, code FROM customer_segments WHERE is_active = 1")).map((s) => [s.code, s.id]));
  if (!Object.keys(ids).length) return 0;
  let changed = 0;
  for (const c of await customerStats()) {
    const code = segmentFor(c.stats);
    const target = code && ids[code] ? ids[code] : null;
    if ((c.segment_id ?? null) === target) continue;
    await sequelize.query("UPDATE customers SET segment_id = :target WHERE id = :id", { replacements: { target, id: c.id } });
    changed += 1;
  }
  return changed;
};

export const segmentCounts = (includeDemo = false) =>
  select(
    `SELECT g.code, g.name, g.rule_description, COUNT(c.id) AS customers FROM customer_segments g
     LEFT JOIN customers c ON c.segment_id = g.id AND c.status <> 'merged' ${includeDemo ? "" : "AND c.is_demo = 0"}
     WHERE g.is_active = 1 GROUP BY g.id ORDER BY FIELD(g.code, 'new', 'regular', 'loyal', 'at_risk', 'inactive')`);
