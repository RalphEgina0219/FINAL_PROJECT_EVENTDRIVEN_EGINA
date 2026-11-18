/*
 * Accounting adapter. Accounting & Payroll owns the ledger, VAT and journal entries (blueprint §4). CRM never posts to the ledger:
 * it publishes SaleCompleted, SaleCancelled and RefundRecorded (services/eventService.js) and Accounting books them.
 *
 * The contract defines no synchronous call to Accounting, so this adapter only reports the mode and checks the connection:
 *   disabled  events are recorded as skipped_disabled and nothing is sent
 *   mock      events are recorded as mock_delivered (is_mock = 1) and NEVER sent
 *   live      events are delivered by the outbox dispatcher (services/integration/outboxDispatcher.js) as signed
 *             POST /api/integration/v1/events calls, with retries, backoff and a dead-letter queue
 */
import { modeOf, checkConnection } from "./adapterBase.js";

export const accountingMode = () => modeOf("accounting");
export const isMockAccounting = () => accountingMode() === "mock";
export const accountingHealth = () => checkConnection("accounting");
