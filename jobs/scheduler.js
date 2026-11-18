/*
 * In-process background jobs (no external scheduler needed).
 *   every 5 minutes (and once at startup): auto-close Resolved cases with no customer reply, send SLA overdue alerts, remind assignees
 *   of due follow-ups, and re-process inbound integration events that failed.
 *   every 20 seconds: the integration dispatcher (services/integration/outboxDispatcher.js) sends due events to apps in LIVE mode,
 *   runs due compensations (give back reservations) and purges the replay guard. It does nothing while every app is mock or disabled.
 *   interim dialects (docs/integration-contract.md §12), each only when switched on:
 *     every 5 minutes  HR pull sync (INTEGRATION_HR_MODE=live + INTEGRATION_HR_SYNC=pull)
 *     every minute     read the Inventory outbox (INTEGRATION_INVENTORY_MODE=live + INTEGRATION_INVENTORY_DIALECT=johnvivz_inventory)
 */
import { autoCloseResolvedCases, notifyOverdueCases } from "../services/caseService.js";
import { notifyDueFollowUps } from "../services/followUpService.js";
import { loadSettings } from "../services/settingsService.js";
import { dispatchDue, purgeNonces } from "../services/integration/outboxDispatcher.js";
import { processInboxBacklog } from "../services/integration/inboxService.js";
import { config } from "../config/index.js";
import { revalidatePending } from "../services/approvalService.js";
import { recomputeSegments } from "../services/segmentService.js";
import { provisionStaffAccounts } from "../services/staffAccountService.js";
import { hrPullEnabled, runHrPullSync, HR_PULL_INTERVAL_MINUTES } from "../services/integration/hrPullSync.js";
import { isInventoryDialect, pollInventoryOutbox, OUTBOX_POLL_SECONDS } from "../services/integration/inventoryDialect.js";

const INTERVAL_MS = 5 * 60 * 1000;
const DISPATCH_INTERVAL_MS = 20 * 1000;
let running = false;

export const runJobsOnce = async () => {
  if (running) return;
  running = true;
  try {
    await loadSettings();
    const closed = await autoCloseResolvedCases();
    const overdue = await notifyOverdueCases();
    const due = await notifyDueFollowUps();
    const inbox = await processInboxBacklog();
    await recomputeSegments(); // rule-based customer segments (P9)
    await revalidatePending(); // pending approval requests whose approver left go to the exception queue (never approved automatically)
    const accounts = await provisionStaffAccounts({ source: "5-minute job" }); // employee account flow: CRM-department hires get a waiting account
    if (accounts.created.length) console.log("👤 Staff accounts created from HR: " + accounts.created.length + " (waiting for ESS registration)");
    if (closed || overdue || due || inbox.processed) console.log(`⏱️  Jobs: auto-closed ${closed} case(s), sent ${overdue} SLA overdue alert(s) and ${due} follow-up reminder(s), re-processed ${inbox.processed} inbound event(s)`);
  } catch (err) {
    console.error("⚠️  Background job failed:", err.message);
  } finally {
    running = false;
  }
};

export const runDispatcherOnce = async () => {
  try {
    const out = await dispatchDue();
    await purgeNonces(config.integration.maxClockSkewSeconds);
    if (out.sent || out.failed || out.dead) console.log(`📤 Integration: sent ${out.sent}, failed ${out.failed}, dead ${out.dead}`);
  } catch (err) {
    console.error("⚠️  Integration dispatcher failed:", err.message);
  }
};

// Separate from the jobs above: a teammate's app being down must never stop CRM's own jobs. Failures are logged in integration_logs.
export const runHrPullOnce = async () => {
  if (!hrPullEnabled()) return;
  try {
    const out = await runHrPullSync({ trigger: "job" });
    if (out.events) console.log(`👥 ${out.message}`);
  } catch (err) {
    console.error("⚠️  HR pull sync failed:", err.message);
  }
};

export const runInventoryPollOnce = async () => {
  if (!isInventoryDialect()) return;
  try {
    const out = await pollInventoryOutbox({ trigger: "job" });
    if (out.read) console.log(`📦 Inventory outbox: ${out.read} read, ${out.stored} new, ${out.acked} acknowledged`);
  } catch (err) {
    console.error("⚠️  Inventory outbox poll failed:", err.message);
  }
};

export const startScheduler = () => {
  setTimeout(runHrPullOnce, 8000).unref();
  setInterval(runHrPullOnce, HR_PULL_INTERVAL_MINUTES * 60 * 1000).unref();
  setInterval(runInventoryPollOnce, OUTBOX_POLL_SECONDS * 1000).unref();
  setTimeout(runJobsOnce, 5000).unref();
  setInterval(runJobsOnce, INTERVAL_MS).unref();
  setInterval(runDispatcherOnce, DISPATCH_INTERVAL_MS).unref();
};
