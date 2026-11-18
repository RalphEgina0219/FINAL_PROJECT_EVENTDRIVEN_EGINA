// Integration Health (P6): connection status, outbox / dead-letter queue, inbox, compensations, recent calls and the unmatched-sales
// reconciliation report. CRM Manager at /crm/settings/integration, setup System Administrator at /setup/integration.
// Viewing needs integration.view, every action needs integration.manage; every action is written to the audit log.
import { audit } from "../services/auditService.js";
import { platformStatus } from "../services/dashboardService.js";
import { paths } from "./configController.js";
import { clean, toId, oneOf } from "../helpers/validators.js";
import { SYSTEMS, checkConnection } from "../services/integration/adapterBase.js";
import { dispatchDue, retryEvent, retryAllDead, RETRY_DELAYS_MINUTES } from "../services/integration/outboxDispatcher.js";
import { retryCompensation } from "../services/integration/compensationService.js";
import { reprocessInboxEvent } from "../services/integration/inboxService.js";
import { hrPullEnabled, runHrPullSync } from "../services/integration/hrPullSync.js";
import { connectedApps, healthOverview, listOutbox, listInbox, listCompensations, recentLogs, outboxStatuses, inboxStatuses, staleReservations, reservationConflicts, STALE_RESERVATION_HOURS } from "../services/integration/healthService.js";
import { salesReconciliation, parseRange, STALE_HOURS } from "../services/integration/reconciliationService.js";

const baseOf = (req) => (req.user.role === "system_admin" ? "/setup/integration" : "/crm/settings/integration");
const back = (req, res) => res.redirect(baseOf(req));
const MIN_REASON = 5;

export const page = async (req, res) => {
  const outboxStatus = oneOf(req.query.outbox, outboxStatuses);
  const inboxStatus = oneOf(req.query.inbox, inboxStatuses);
  const [apps, overview, outbox, inbox, compensations, logs, stale, conflicts] = await Promise.all([
    connectedApps(), healthOverview(), listOutbox({ status: outboxStatus }), listInbox({ status: inboxStatus }), listCompensations(), recentLogs(),
    staleReservations(), reservationConflicts(),
  ]);
  const unmatched = (await salesReconciliation({ onlyProblems: true, limit: 8 })).rows.filter((r) => r.status === "unmatched");
  res.render("settings/integration", {
    title: req.user.role === "system_admin" ? "Integration Health" : "Settings", tab: "integration", cfg: paths(req), platform: platformStatus(),
    base: baseOf(req), apps, overview, outbox, inbox, compensations, logs, unmatched, outboxStatus, inboxStatus,
    outboxStatuses: outboxStatuses.map((s) => ({ value: s, label: s.replace(/_/g, " ") })), inboxStatuses: inboxStatuses.map((s) => ({ value: s, label: s })),
    anyLive: apps.some((a) => a.live), retrySchedule: RETRY_DELAYS_MINUTES.map((m) => (m >= 60 ? `${m / 60} h` : `${m} min`)).join(", "), reconHours: STALE_HOURS,
    canManage: true, stale, conflicts, staleHours: STALE_RESERVATION_HOURS, orderBase: req.user.role === "system_admin" ? null : "/crm/sales/orders",
  });
};

export const dispatchNow = async (req, res) => {
  const apps = await connectedApps();
  if (!apps.some((a) => a.live)) {
    req.flash("info_msg", "No application is in live mode, so nothing was sent. Mock and disabled events are never sent.");
    return back(req, res);
  }
  const out = await dispatchDue();
  await audit(req, "integration_dispatch_run", { recordType: "integration_outbox", details: out.skipped ? "already running" : `attempted ${out.attempted}, sent ${out.sent}, failed ${out.failed}, dead ${out.dead}` });
  req.flash("success_msg", out.skipped ? "A send is already running. Try again in a moment." : `Tried ${out.attempted} event(s): ${out.sent} sent, ${out.failed} will be retried, ${out.dead} moved to the dead-letter queue.`);
  back(req, res);
};

export const retryOne = async (req, res) => {
  const id = toId(req.params.id);
  const ok = id ? await retryEvent(id) : false;
  await audit(req, "integration_event_retried", { outcome: ok ? "success" : "failed", recordType: "integration_outbox", recordId: id, reason: clean(req.body.reason, 200) || null, details: ok ? "retry scheduled now" : "not retryable (not dead or failed, or a mock event)" });
  if (ok) { await dispatchDue(); req.flash("success_msg", "The event was queued for another try and sent now if the application answers."); }
  else req.flash("error_msg", "That event cannot be retried (only dead or failed live events can).");
  back(req, res);
};

export const retryDead = async (req, res) => {
  const reason = clean(req.body.reason, 200);
  if (reason.length < MIN_REASON) { req.flash("error_msg", `Give a reason for retrying all dead letters (at least ${MIN_REASON} characters).`); return back(req, res); }
  const n = await retryAllDead();
  await audit(req, "integration_dead_letters_retried", { recordType: "integration_outbox", reason, details: `${n} event(s) re-queued` });
  if (n) await dispatchDue();
  req.flash(n ? "success_msg" : "info_msg", n ? `${n} dead event(s) were queued for another try.` : "There are no dead letters to retry.");
  back(req, res);
};

export const retryCompensationAction = async (req, res) => {
  const id = toId(req.params.id);
  const ok = id ? await retryCompensation(id) : false;
  await audit(req, "integration_compensation_retried", { outcome: ok ? "success" : "failed", recordType: "integration_compensations", recordId: id });
  req.flash(ok ? "success_msg" : "error_msg", ok ? "The clean-up task was queued again." : "Only a dead clean-up task can be retried.");
  back(req, res);
};

export const reprocessInbox = async (req, res) => {
  const id = toId(req.params.id);
  const result = id ? await reprocessInboxEvent(id) : null;
  await audit(req, "integration_inbox_reprocessed", { outcome: result ? "success" : "failed", recordType: "integration_inbox", recordId: id, details: result ? `${result.status}: ${result.note}` : "not failed or dead" });
  req.flash(result ? (result.status === "processed" ? "success_msg" : "info_msg") : "error_msg", result ? `Result: ${result.status}${result.note ? ` (${result.note})` : ""}` : "Only a failed or dead inbound event can be reprocessed.");
  back(req, res);
};

export const testConnection = async (req, res) => {
  const key = oneOf(req.params.system, Object.keys(SYSTEMS));
  if (!key) { req.flash("error_msg", "Unknown application."); return back(req, res); }
  const out = await checkConnection(key);
  await audit(req, "integration_connection_tested", { outcome: out.ok || out.skipped ? "success" : "failed", recordType: "integration", recordId: SYSTEMS[key], details: out.message });
  req.flash(out.ok ? "success_msg" : out.skipped ? "info_msg" : "error_msg", out.message);
  back(req, res);
};

// HR pull sync (interim dialect, contract §12.1): the CRM Manager's "Sync now". The same run as the 5-minute job.
export const hrSyncNow = async (req, res) => {
  if (!hrPullEnabled()) { req.flash("info_msg", "HR pull sync is off. It runs only with INTEGRATION_HR_MODE=live and INTEGRATION_HR_SYNC=pull."); return back(req, res); }
  try {
    const out = await runHrPullSync({ trigger: `Sync now by ${req.user.email}` });
    if (out.skipped_run) { req.flash("info_msg", "An HR sync is already running. Try again in a moment."); return back(req, res); }
    const failed = out.results.filter((r) => r.status === "dead" || r.status === "failed").length;
    await audit(req, "hr_pull_sync_run", { outcome: failed ? "failed" : "success", recordType: "integration", recordId: "johnvivz_hr", details: out.message });
    req.flash(failed ? "error_msg" : "success_msg", out.message.replace(/^HR pull \([^)]*\): /, "HR sync: "));
  } catch (err) {
    await audit(req, "hr_pull_sync_run", { outcome: "failed", recordType: "integration", recordId: "johnvivz_hr", details: err.message });
    req.flash("error_msg", `HR sync failed, nothing was changed: ${err.message}`);
  }
  back(req, res);
};

// ---------------------------------------------------------------- unmatched-sales reconciliation report

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export const reconciliation = async (req, res) => {
  const range = parseRange({ from: clean(req.query.from, 10), to: clean(req.query.to, 10) });
  const onlyProblems = req.query.problems === "1";
  const report = await salesReconciliation({ ...range, onlyProblems, limit: 500 });
  if (req.query.format === "csv") {
    await audit(req, "integration_reconciliation_exported", { recordType: "sales_transactions", details: `${report.rows.length} row(s), ${report.summary.from} to ${report.summary.to}` });
    const head = ["transaction_no", "order_no", "completed_at", "net_amount", "currency", "status", "inventory", "accounting", "age_hours", "demo"];
    const lines = [head.join(",")].concat(report.rows.map((r) => [r.transaction_no, r.order_no, new Date(r.completed_at).toISOString(), r.net_amount, r.currency, r.status, r.deliveries[SYSTEMS.inventory].state, r.deliveries[SYSTEMS.accounting].state, r.age_hours, r.is_demo ? "demo" : ""].map(csvCell).join(",")));
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="unmatched-sales-${report.summary.from}-to-${report.summary.to}.csv"` });
    return res.send(`${lines.join("\r\n")}\r\n`);
  }
  res.render("settings/reconciliation", {
    title: req.user.role === "system_admin" ? "Sales reconciliation" : "Settings", tab: "integration", cfg: paths(req), platform: platformStatus(), base: baseOf(req),
    summary: report.summary, rows: report.rows, truncated: report.truncated, from: range.from, to: range.to, onlyProblems, staleHours: STALE_HOURS,
  });
};
