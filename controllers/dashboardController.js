// The four CRM dashboards (blueprint supplement E) plus the setup overview. All figures come from
// services/dashboardService.js and the sales, loyalty, approvals, targets and analytics services (live SQL, scoped to the viewer).
// No figure is invented: every widget is computed from real rows, and demo rows are labelled.
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import {
  caseSummary, recentCases, agentQueue, casesByCategory, activeByPriority, agentWorkload, ratingSummary, responseTimes,
  customerStats, pendingEscalations, teamSummary, platformStatus, casesAwaitingRating,
} from "../services/dashboardService.js";
import { getPortalProfile, listCustomers } from "../services/customerService.js";
import { listInteractions, TYPE_LABELS } from "../services/customerMasterService.js";
import { followUpSummary, dueFollowUps } from "../services/followUpService.js";
import { inquiryCounts } from "../services/inquiryService.js";
import { salesSummary, salesTrend, topProducts, listOrders, ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from "../services/orderService.js";
import { refundCounts } from "../services/refundService.js";
import { activePromotions, campaignPerformance } from "../services/marketingService.js";
import { barsBlock, columnsBlock } from "../helpers/charts.js";
import { healthOverview } from "../services/integration/healthService.js";
import { approvalCounts, myRequestCounts } from "../services/approvalService.js";
import { customerLoyalty, RULES_TEXT } from "../services/loyaltyService.js";
import { teamTargets } from "../services/targetService.js";
import { retentionTile } from "../services/analyticsService.js";
import { latestRun, METHOD_LABELS, manilaDay } from "../services/forecastService.js";

const pendingPromotions = async (user) => {
  const [row] = await sequelize.query("SELECT COUNT(*) AS n FROM promotions WHERE status = 'pending_approval' AND created_by <> :me", { type: QueryTypes.SELECT, replacements: { me: user.id } });
  return Number(row.n);
};

// 14-day sales trend, campaign performance and best sellers, built from real order rows (rendered by views/partials/charts.xian).
const salesBlocks = async (user) => {
  const trend = await salesTrend(user, 14);
  const byDay = Object.fromEntries(trend.map((r) => [new Date(r.d).toISOString().slice(0, 10), Number(r.total)]));
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() - (13 - i) * 86400000));
  const keys = days.map((d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(d));
  const [best, campaigns] = await Promise.all([topProducts(user, 5), campaignPerformance(5)]);
  return [
    columnsBlock("Completed sales per day (14 days)", keys.map((k) => ({ label: k.slice(8), value: byDay[k] || 0 })), { format: (v) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v))), width: "half" }),
    barsBlock("Best-selling products (units)", best.map((b) => ({ label: b.label, value: Number(b.value) })), { width: "half" }),
    ...(campaigns.length ? [barsBlock("Promotion uses per campaign", campaigns.map((c) => ({ label: c.label, value: Number(c.value) })), { width: "half" })] : []),
  ];
};

export const managerDashboard = async (req, res) => {
  const [summary, customers, byCategory, byPriority, teams, ratings, times, escalations, recent, followUps, inquiries] = await Promise.all([
    caseSummary(req.user), customerStats(), casesByCategory(req.user), activeByPriority(req.user), teamSummary(),
    ratingSummary(req.user), responseTimes(req.user), pendingEscalations(req.user, 5), recentCases(req.user, 6),
    followUpSummary(req.user), inquiryCounts(req.user),
  ]);
  const [sales, refunds, promoPending, salesBlocksList, integration] = await Promise.all([salesSummary(req.user), refundCounts(req.user), pendingPromotions(req.user), salesBlocks(req.user), healthOverview()]);
  const approvals = await approvalCounts(req.user);
  const myReq = await myRequestCounts(req.user);
  const retention = await retentionTile();
  const run = await latestRun("daily_sales_amount");
  const next7 = run ? run.values.filter((v) => v.day >= manilaDay()).slice(0, 7) : [];
  const forecast = run ? { total: next7.reduce((s, v) => s + v.estimate, 0), method: METHOD_LABELS[run.method], includesDemo: run.includesDemo } : null;
  res.render("dashboards/manager", { myReq, retention, forecast, sales, refunds, promoPending, salesBlocks: salesBlocksList, integration, approvals,
    title: "CRM Overview", followUps, inquiries, summary, customers, byCategory, byPriority, teams, ratings, times, escalations, recent, platform: platformStatus(),
  });
};

export const teamLeaderDashboard = async (req, res) => {
  const [summary, workload, escalations, queue, times, ratings, followUps, inquiries] = await Promise.all([
    caseSummary(req.user), agentWorkload(req.user), pendingEscalations(req.user, 5),
    recentCases(req.user, 8, "AND k.status = 'open' AND k.assigned_agent_id IS NULL"), responseTimes(req.user), ratingSummary(req.user),
    followUpSummary(req.user), inquiryCounts(req.user),
  ]);
  const activeAgents = workload.filter((a) => a.is_active && !a.access_revoked_at && a.employment_status !== "separated" && a.employment_status !== "inactive");
  const [sales, refunds, promoPending] = await Promise.all([salesSummary(req.user), refundCounts(req.user), pendingPromotions(req.user)]);
  const approvals = await approvalCounts(req.user);
  const myReq = await myRequestCounts(req.user);
  const targets = await teamTargets({ teamId: req.user.team_id || 0 });
  res.render("dashboards/team_leader", { myReq, targets, sales, refunds, promoPending, approvals,
    title: "Team Overview", followUps, inquiries, summary, workload, escalations, queue, times, ratings, agentCount: activeAgents.length, platform: platformStatus(),
  });
};

export const agentDashboard = async (req, res) => {
  const [summary, queue, ratings, times, customers, interactions, followUps, inquiries, dueTasks] = await Promise.all([
    caseSummary(req.user), agentQueue(req.user.id, 10), ratingSummary(req.user), responseTimes(req.user),
    listCustomers(req.user, { limit: 1, offset: 0 }), // same scope as the Customers page: assigned or with my cases
    listInteractions(req.user, { limit: 5, offset: 0 }),
    followUpSummary(req.user), inquiryCounts(req.user), dueFollowUps(req.user, 5),
  ]);
  const sales = await salesSummary(req.user);
  const myReq = await myRequestCounts(req.user);
  res.render("dashboards/agent", { myReq, sales, title: "My Dashboard", followUps, inquiries, dueTasks: dueTasks.map((t) => ({ ...t, overdue: Boolean(t.is_overdue) })), summary, queue, ratings, times, myCustomers: customers.total, recentInteractions: interactions.rows.map((r) => ({ ...r, type_label: TYPE_LABELS[r.interaction_type] })) });
};

// Customer "My Profile" (portal home): account, case summary, cases to rate.
export const portalHome = async (req, res) => {
  const [profile, summary, recent, awaitingRating] = await Promise.all([
    getPortalProfile(req.user.customer_id), caseSummary(req.user), recentCases(req.user, 5), casesAwaitingRating(req.user.customer_id),
  ]);
  const [{ rows: orderRows }, promos] = await Promise.all([listOrders(req.user, { limit: 4, offset: 0 }), activePromotions()]);
  const orders = orderRows.map((o) => ({ ...o, status_label: ORDER_STATUS_LABELS[o.status], payment_label: PAYMENT_STATUS_LABELS[o.payment_status] }));
  const loyalty = await customerLoyalty(req.user.customer_id, { limit: 0 });
  res.render("dashboards/portal", { orders, promos, title: "My Profile", profile, summary, recent, awaitingRating, loyalty, loyaltyRules: RULES_TEXT });
};

export const setupDashboard = async (req, res) => {
  const [counts] = await sequelize.query(
    `SELECT (SELECT COUNT(*) FROM case_categories WHERE is_active = 1) AS categories,
            (SELECT COUNT(*) FROM response_templates WHERE is_active = 1) AS templates,
            (SELECT COUNT(*) FROM crm_users WHERE user_type = 'staff') AS staff,
            (SELECT COUNT(*) FROM crm_teams WHERE is_active = 1) AS teams,
            (SELECT COUNT(*) FROM employee_references) AS employees,
            (SELECT COUNT(*) FROM employee_references WHERE is_mock = 1) AS mock_employees,
            (SELECT COUNT(*) FROM crm_audit_logs WHERE outcome = 'denied' AND created_at >= NOW() - INTERVAL 7 DAY) AS denied_7d`,
    { type: QueryTypes.SELECT }
  );
  res.render("dashboards/setup", { title: "Setup Overview", counts, platform: platformStatus() });
};
