# JOHNVIVZ CRM — Every difference from your diagrams (P2–P10), in one place

Date: 2026-11-14. This collects the "differences from your diagrams" sections of every phase report, so the diagrams can be updated from one list. **"Now"** notes say where a later phase or one of your decisions changed an item. The database diagram itself is generated from the database: [`docs/ER-DIAGRAM.md`](../ER-DIAGRAM.md) (source `docs/er-diagram.mmd`, 61 tables).

How to use it: go through each diagram you have (use case, activity, sequence, state machine, class/ER, object) and check the items that touch it. The tag at the end of each item says which diagram types it affects most: **[UC]** use case, **[ACT]** activity, **[SEQ]** sequence, **[STATE]** state machine, **[ER]** ER / class, **[OBJ]** object.

## P2 — Identity and roles
1. Customer registration does not sign the customer in: the account starts `pending_verification`, and the emailed link activates it. Setting a password from a reset link also confirms the email. [ACT][SEQ][STATE]
2. New tables `password_reset_tokens` (purpose `reset` or `invite`) and `mail_outbox`; `email_verification_tokens` is used. [ER]
3. "Grant CRM access" (CRM Manager) creates the login from an HR employee reference with an unusable password and sends an invitation. The setup account keeps an emergency "temporary password" function, in mock HR only. [UC][ACT]
4. Password reset is a flow for every role (request, one-time link, new password; other sessions end). [UC][ACT]
5. The setup administrator has a read-only Mail Log page. [UC]
6. `DepartmentUpdated` / `PositionUpdated` are applied only by the HR adapter; no CRM user edits HR references. **Now (P6):** in live mode they arrive as signed events through the inbox. [SEQ]
7. Team rules: one active Team Leader per team; role or team changes need zero active cases; reasons are required; the Manager cannot switch off or demote themselves. [ACT]
8. Mock employee IDs for the object diagram: Angela Reyes `MOCK-EMP-1001` (Manager), Maria Santos `MOCK-EMP-1002` (Team Leader), Kristine Bautista `MOCK-EMP-1003` (Agent). [OBJ]
9. No menu item was added: Teams & CRM Access is a Settings tab; Mail Log is a setup menu item. [UC]

## P3 — Customer master
1. Agent assignment is per customer (`agent_assignments`, one active agent) and separate from case assignment. [ER][ACT]
2. An agent who creates a customer is assigned to them. [ACT]
3. Team Leaders also see unassigned customers (decision D11). [UC]
4. The duplicate check also runs when a primary email or mobile changes; using a contact that belongs to someone else needs a reason. [ACT]
5. "Name plus mobile" match: same first and last name, and a mobile ending in the same 7 digits. [ACT]
6. Walk-in customers record only the Data Privacy consent; Terms is for portal accounts. [ACT]
7. Interactions follow the customer scope; "Logged by me" is a filter. [UC]
8. Staff interaction types: call, visit, SMS, email, chat, internal note. No "outcome" field. [ER]
9. A portal customer's login email is changed by the customer, not by staff. [UC]
10. Marketing consent is an append-only history (`customer_consents`). [ER]
11. No screen edits or deletes a saved interaction. [UC]
12. **Now (P9):** customer segments are computed by rules (the five segments of the master prompt), not "not computed yet". [ACT]
13. Customer merge is not built (decision D12, Future enhancement F1). [UC]

## P4 — Customer service
1. Inquiry statuses are Open, Answered, Converted to case and Closed; only an answered inquiry can be closed. [STATE]
2. One question, one answer (no reply thread). [ACT]
3. "Convert to case" creates a new case and keeps the inquiry (Converted, linked both ways). [ACT][ER]
4. Assigning an inquiry can also assign the customer (when the customer has no agent). [ACT]
5. Staff-recorded inquiries and staff-created cases make the recorder the handler and add a timeline interaction. [ACT]
6. An Agent who creates a case is its agent; a Team Leader or Manager may leave it in the Customer Queue. [ACT]
7. No follow-up "Type" (decision: Future enhancement F2) and no inquiry "Topic". [ER]
8. "Overdue" is derived, not stored; the stored statuses are Pending, Done and Cancelled. [STATE]
9. A follow-up can be linked to a case (`sales_order_id` exists but no screen links an order). [ER]
10. Staff-recorded inquiries and cases appear on the interaction timeline; portal inquiries are their own list. [ACT]

## P5 — Sales
1. An order exists only after the stock reservation succeeded (no draft order); its status starts at Confirmed. [STATE][SEQ]
2. No "Preparing" / "Out for delivery": blueprint steps only (decision D15; the proposed ALTER was declined and never run). [STATE]
3. Payments typed by hand (GCash, Maya, COD receipt) are verified by a second staff member; counter cash counts at once. [ACT][SEQ]
4. COD is a "to be collected" payment row, filled in when the cash is collected. [ACT]
5. One promotion per order (whole order, one product or one category). **Now (P8):** loyalty points can be used together with it. [ACT]
6. SC / PWD discounts are not built (decision D14, Future enhancement F3: legal rules and VAT belong to Accounting). [UC]
7. No delivery fee and no VAT in the CRM total; Accounting computes VAT. [ER]
8. Refunds have three steps (approve or reject, then record), decided only by a Team Leader or the Manager, never by the requester. [STATE][ACT]
9. Cancelling only before a payment is verified; after that, complete and refund. [STATE]
10. In mock mode, held stock = the CRM order rows (plus short-lived mock reservations since P6). [SEQ]
11. Campaign results show only figures real orders can answer. **Now (P8):** plus customers reached and average order. [UC]

## P6 — Integration
1. **Checkout sequence: reserve first, then save, then compensate.** If saving fails, the reservation is released; if no answer arrives, a clean-up task finds and releases what Inventory holds. [SEQ][ACT]
2. New tables `integration_request_nonces` (replay guard) and `integration_compensations` (clean-up tasks). [ER]
3. Mock reservations are short-lived `crm_settings` rows (mock mode only). [ER]
4. No separate "issue stock" call: Inventory consumes the reservation when it receives `SaleCompleted` and may answer `StockIssued`; until then a completed order shows stock Reserved (live mode). [SEQ][STATE]
5. Event data follows the contract (money as decimal strings, `items`, `totals`, ISO times with `+08:00`, no VAT fields). [SEQ]
6. Retries: 6 attempts (+1 min, +5 min, +15 min, +1 h, +6 h), dead after the 6th failure; a `400` answer is dead at once. [STATE]
7. "Confirmed" in reconciliation means accepted by the target, not posted in the ledger. [ACT]
8. Each Integration Health URL belongs to one role (Manager: Settings tab; setup admin: `/setup/integration`). [UC]
9. Inbound events from an app whose adapter is mock or disabled are refused (`503`). [SEQ]

## P7 — Employee request approvals
1. Path: ESS/HR → signed P6 inbox → routing → queue → decision → outbox → HR. CRM never writes leave, attendance or overtime records. [SEQ]
2. "Agent → Team Leader → Manager" is the escalation chain: an invalid approver sends the request to the Manager's **exception queue** (not silently to the Manager). The Manager's own request and an agent without a Team Leader also go there. [ACT][STATE]
3. The exception queue has three outcomes: assign an approver, decide directly, **return to HR** (`returned`). [STATE][ACT]
4. A pending request moves to the exception queue when its approver becomes invalid (separated, inactive, no access). [STATE]
5. Mock source: the setup-only Mock ESS page; mock-source decisions are never sent, even with HR live. [UC][SEQ]
6. Feature off: inbound requests are kept as `ignored` and can be reprocessed later. [ACT]
7. The requester gets a CRM notification when decided. **Now (P8):** it links to My Requests. [SEQ]
8. No new tables; only three request types (the ENUM still has `other`, which CRM refuses). [ER]

## P8 — My Requests, campaigns, promotions, loyalty
1. Loyalty has no tiers (`loyalty_accounts.tier` stays empty). [ER][UC]
2. New table `loyalty_redemptions` (order ↔ points used). [ER]
3. Points: earned when the sale is completed, taken back when a refund is recorded, redeemed at checkout (100 = ₱10), returned when the order is cancelled. [ACT][SEQ]
4. Approval request state **Superseded** (pending or exception → superseded when a changed request with `replaces_request_id` arrives); not a decision, nothing sent. [STATE]
5. **My Requests**: a new read-only staff view, reached from My Account and the dashboards (not a menu item). [UC]
6. Team targets are SLA compliance from `service_targets`; there is no sales target. [UC][ACT]

## P9 — Analytics
1. Forecasts are computed when the Manager presses "Compute new forecasts" (no automatic schedule), each run choosing one of three statistical methods by back-test. [ACT][SEQ]
2. Segments are assigned by rules (the master prompt's five), not by staff. [ACT]
3. Analytics exclude demo data by default (switchable, labelled); dashboards are operational and include demo orders (labelled). [UC]

## P10 — Final testing and merge kit
1. The UI-pass sample screens are gone; every menu page is live. Any diagram that still shows "sample" pages or "Coming Soon" is out of date. [UC]
2. On phones every table becomes labelled cards (layout only). [—]
3. New signed test endpoint `POST /api/integration/v1/test/echo`, used by `scripts/check-connections.mjs`, and the merge-kit scripts (generate secrets, check connections, fake teammates, backup, restore test). These are tools, not use cases of the CRM. [SEQ] (deployment diagram, if you have one)
4. In production the server refuses to start with an unsafe `.env` (default or short session secret, demo logins shown). [ACT] (deployment)
5. On a production database the first setup administrator and the first CRM Manager are created from the command line (`scripts/create-first-accounts.mjs`, one-time set-your-password links), because the demo seeder refuses to run there. After that, the Manager grants all other staff access in the app as before. [ACT][UC] (deployment)

## Interim dialects and employee account flow (2026-11-16)
1. **Staff accounts are created from HR, not granted by the Manager.** A CRM-department hire gets a deactivated account ("Waiting for ESS registration", no password). The diagrams that show "Manager grants CRM access → invitation email → set your password" are out of date. Replace them with "HR onboards → CRM creates the account → the person registers in ESS → their first CRM sign-in with the ESS password activates it". [UC][ACT][SEQ]
2. **Staff sign-in goes to ESS** (JVzPay `POST /auth/login`) when `INTEGRATION_ESS_LOGIN=live`. Customers and the setup administrator still sign in with a CRM password. [SEQ][ACT]
3. Account states shown to the Manager: Waiting for ESS registration → Active → Removed by HR (or Switched off in CRM). [STATE]
4. `crm_users`: `password_hash` may be NULL, plus the new columns `login_via`, `ess_activated_at` and `role_source` (migration 121). [ER]
5. HR data can arrive by **pull** (every 5 minutes, Sync now) instead of events. Inventory events go to its own format, and CRM polls its outbox. [SEQ]
6. Employee requests: filed, first-approved (Team Leader) and final-approved (Accounting/Payroll) **in ESS**. The CRM approval queue stays off; any CRM approval use case is a future enhancement (F4). [UC]
7. With today's Inventory app the reservation is its `order.confirmed` event, answered at once (reserved / duplicate / short / unavailable / conflict). Reservations never expire, so CRM releases with `order.cancelled` on cancel, on a failed save, and from the clean-up task. Integration Health lists reservations older than 24 hours. [ACT][SEQ]
