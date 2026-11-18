# JOHNVIVZ merge test scenarios

For: all four teams, during the merge session. Run these together after every app passes `npm run check:connections` (see [`MERGE-GUIDE.md`](MERGE-GUIDE.md)).

**How to use this sheet**
* One person reads the steps out loud. Each team watches **its own screen** and calls out what it sees.
* Tick a scenario only when **every** "Expected" line is true. If one is not, write down what you saw and the time. Then check Integration Health → Recent calls and the app's own log.
* In CRM, keep **Settings → Integration Health** open on a second screen (Manager: `/crm/settings/integration`). It shows the Outbox (what CRM sent), the Inbox (what CRM received), Dead letters and Recent calls.
* Switch apps to `live` one at a time (MERGE-GUIDE step 6). Each scenario says which adapters must be live.
* Before scenario 1, the CRM team runs `npm run db:backup` so the session can be undone.

CRM accounts used below (demo seed, password `Demo@1234`): Manager `manager@johnvivz.test`, Team Leader `maria.santos@johnvivz.test`, Agent `kristine.bautista@johnvivz.test`, Customer `juan.cruz@johnvivz.test`.

| # | Scenario | Live adapters needed |
|---|---|---|
| 1 | HR onboards a CRM new hire → deactivated CRM account → ESS registration → CRM sign-in with the ESS password → account active → HR terminates → access removed | HR, Accounting/ESS (`INTEGRATION_ESS_LOGIN=live`) |
| 2 | Customer orders → Inventory reserves and issues → Accounting receives SaleCompleted | Inventory, Accounting |
| 3 | Refund → RefundRecorded | Inventory, Accounting |
| 4 | Leave request: filed, first-approved and final-approved **in ESS only**; CRM shows where to go | Accounting/ESS (CRM: `APPROVALS_ENABLED=false`) |
| 5 | Duplicate event | any one |
| 6 | System down: retry then succeed | any one |
| 7 | System down for long: dead letter, then retry | any one |

---

## Scenario 1: HR onboards a CRM new hire → ESS registration → CRM sign-in → HR terminates

**Adapters:** HR live with today's settings (`INTEGRATION_HR_AUTH=bearer`, `INTEGRATION_HR_SYNC=pull`), Accounting live, and `INTEGRATION_ESS_LOGIN=live` (MERGE-GUIDE step 4A). **People:** HR team, Accounting/ESS team, CRM Manager, the "new hire".

| Step | Who / screen | Do |
|---|---|---|
| 1 | HR app → Onboarding | Encode a new hire in the **CRM department**, for example "Test Agent One", position "Customer Service Representative". HR generates the Employee ID (`JV-YYYY-NNNNN`) and the Employee Unique Code. Set the status to **Active**. |
| 2 | CRM Manager → Settings → Integration Health | Press **Sync now** next to JOHNVIVZ HR (or wait up to 5 minutes). |
| 3 | CRM Manager → Settings → Teams & CRM Access | Find the new hire. Choose a team with **Set role / team** (reason "merge test"). |
| 4 | New hire → CRM login page | Try to sign in with the onboarding email and any password. |
| 5 | New hire → ESS (JVzPay) | **Register** in ESS with the onboarding email, and create a password. |
| 6 | New hire → CRM login page | Sign in with the onboarding email and the **ESS password**. |
| 7 | HR app | Change the employee's status to **Terminated** (or Resigned). |
| 8 | CRM Manager → Integration Health | **Sync now**. Then, in the new hire's browser, refresh any CRM page. |
| 9 | New hire → CRM login page | Try to sign in again with the ESS password. |
| 10 | CRM → Settings → Audit Logs | Filter by the employee. |

**Expected**
* Step 2: the message says "1 created …; 1 CRM staff account(s) created (waiting for ESS registration)". The Inbox shows `EmployeeCreated` from `johnvivz_hr` (source **hr-sync**), **processed**. No salary, bank, government ID, phone or hire date is stored.
* Step 3: the new hire is listed with HR's name, Employee ID, department and position, the state **Waiting for ESS registration**, and the role from the position rules (Agent). There is **no password field and no invitation**. The Manager cannot switch the account on by hand.
* Step 4: "We could not sign you in…" (one generic message). The audit log has `login_failed` with the reason `invalid_credentials`.
* Step 6: the new hire reaches the Agent dashboard. The page now shows **Active**. The audit log has **"activated via ESS"**. CRM never stored the password: Integration Health › Recent calls shows `POST /api/integration/v1/auth/login` with its HTTP status only.
* Step 8: the new hire is signed out ("Your CRM access was removed because your HR employment status is Separated"). The page shows **Removed by HR**.
* Step 9: refused with the generic message, even with the right ESS password.
* Step 10: the audit log shows the account created from HR, the activation via ESS, the team set by the Manager, and the HR status change (source **hr-sync**).
* Variants:
  * JVzPay stopped during step 6: "ESS is unavailable, try again later.", and no local fallback.
  * A hire in **another** department gets no CRM account.
  * An **Onboarding** or **Rejected** person is not imported until HR sets them Active.

## Scenario 2: Customer orders → Inventory reserves and issues → Accounting receives SaleCompleted

**Adapters:** Inventory and Accounting live. **People:** Inventory team, Accounting team, CRM Agent, Customer.

> **With today's Inventory app** (`INTEGRATION_INVENTORY_DIALECT=johnvivz_inventory`), the reservation is Inventory's `order.confirmed` (contract §12.2).
> * Step 4: Inventory shows the order reference reserved.
> * A second checkout for more than the remaining stock is refused with the product's name.
> * Cancelling an unpaid order releases the stock (`order.cancelled`).
> * An event Inventory raises (for example `StockReserved`) shows in CRM's Inbox within a minute and is acknowledged.
> * Integration Health lists any order that has held stock for more than 24 hours.

| Step | Who / screen | Do |
|---|---|---|
| 1 | CRM Manager → Sales & Orders | Press **Refresh product snapshot from Inventory**. |
| 2 | Inventory app | Note the on-hand and reserved quantity of one product (for example 10 on hand, 0 reserved). |
| 3 | CRM Customer `juan.cruz` → Portal → Shop | Add 2 of that product to the cart and check out (payment: GCash, with a reference number). |
| 4 | Inventory app | Refresh the product. |
| 5 | CRM Agent → Sales & Orders → Payments | Verify the GCash payment (the Team Leader verifies if the Agent recorded it). |
| 6 | CRM → the order | Mark it **Ready**, then **Complete**. |
| 7 | Inventory app; Accounting app | Refresh. |
| 8 | CRM Manager → Integration Health → Reconciliation | Choose today. |

**Expected**
* Step 1: CRM shows Inventory's real products and prices (no "Mock" label).
* Step 3: the order is **Confirmed** with a reservation ID. If the stock was too low, CRM says so and **no order is created**.
* Step 4: Inventory shows 2 reserved for the CRM order ID (one reservation, even if the checkout was pressed twice). Inventory received `OrderConfirmed`.
* Step 6: the Outbox shows `SaleCompleted` to Inventory and to Accounting, both **sent** (answer 202).
* Step 7: Inventory consumed the reservation (on hand 8, reserved 0) and may have answered `StockIssued`; CRM then shows stock **Issued** on the order. Accounting has the sale: same order ID, same total as a decimal string, items, payment method. VAT is computed by Accounting.
* Step 8: the sale is listed as **Confirmed** by Accounting (accepted, not yet "posted"; see contract question 8).

## Scenario 3: Refund → RefundRecorded

**Adapters:** Inventory and Accounting live. Use the completed order from scenario 2.

| Step | Who / screen | Do |
|---|---|---|
| 1 | CRM Agent → the order | **Request refund**: 1 item, reason "damaged", amount ₱ for one item. |
| 2 | CRM Team Leader `maria.santos` → Sales & Orders → Refunds | Open the request and **Approve** it with a comment. |
| 3 | CRM Team Leader | **Record** the refund (method, reference). |
| 4 | Accounting app; Inventory app | Refresh. |
| 5 | CRM Customer → Portal → Loyalty | Look at the points. |

**Expected**
* Step 1: the Agent cannot approve their own request (no button).
* Step 3: the order shows the refund; the Outbox shows `RefundRecorded` to Accounting and Inventory, **sent**.
* Step 4: Accounting has the refund linked to the original sale ID with the same amount. Inventory has the returned item (whether it goes back to stock is Inventory's rule).
* Step 5: the points earned on the refunded amount are taken back (1 point per ₱100, net of refunds); the reversal is listed.
* Pressing **Record** twice does not create a second refund or a second event.

## Scenario 4: Leave request: only in ESS

**Adapters:** Accounting/ESS live. CRM keeps `APPROVALS_ENABLED=false`. **People:** Accounting/ESS team, the CRM agent and their Team Leader (both with ESS accounts).

| Step | Who / screen | Do |
|---|---|---|
| 1 | Agent → ESS (JVzPay) | File a **leave request**: two days next week, reason "family". |
| 2 | Team Leader → ESS | Give the **first approval**. |
| 3 | Accounting/Payroll → ESS | Give the **final approval**. |
| 4 | Agent → CRM → My Account → **My Requests**; Team Leader → CRM → Approvals | Open the pages. |

**Expected**
* Steps 1–3 happen in ESS only. CRM receives nothing and decides nothing (the Integration Health inbox has no `EmployeeRequestSubmitted`).
* Step 4: both CRM pages say: "Leave, overtime and attendance requests are filed in ESS (Accounting app). Your Team Leader gives the first approval and Accounting/Payroll gives the final approval, both in ESS." No request is shown in CRM.
* A CRM-side first approval is a future enhancement (alignment report F4).

## Scenario 5: Duplicate event

**Adapters:** any one live (HR is easiest).

| Step | Who / screen | Do |
|---|---|---|
| 1 | HR app (or the fake teammate: `send hr EmployeeUpdated employee_id=…`) | Send an event and note its `event_id`. |
| 2 | HR app | Send **exactly the same** event again (same `event_id`). |
| 3 | CRM → Integration Health → Inbox | Look for the `event_id`. |

**Expected**
* The first send gets `202`; the second gets `200 {"status":"duplicate"}`.
* The Inbox has the event **once**; the change is applied once (no double audit entry).
* The other way round: when CRM's dispatcher resends an event after a timeout, Inventory and Accounting must answer `200 duplicate` and **not** book it twice (for example two sales or two stock movements).

## Scenario 6: System down → retry, then succeed

**Adapters:** Accounting live (any app works).

| Step | Who / screen | Do |
|---|---|---|
| 1 | Accounting team | **Stop** the Accounting app. |
| 2 | CRM | Complete an order (as in scenario 2). |
| 3 | CRM → Integration Health → Outbox | Look at `SaleCompleted` to Accounting. |
| 4 | Accounting team | **Start** the Accounting app again. |
| 5 | CRM → Integration Health | Wait for the next retry, or press **Send pending events**. |

**Expected**
* Step 2: the order is completed in CRM anyway; the customer and the agent see no error.
* Step 3: the event is **pending**, with attempts 1, the last error ("not running" / connection refused) and the next try in 1 minute (then 5, 15, 60, 360 minutes).
* Step 5: the event becomes **sent**. Accounting has the sale **once**.
* `npm run check:connections` shows `NOT RUNNING` during step 1 and OK after step 4.

## Scenario 7: System down for long → dead letter, then retry

**Adapters:** Accounting live. To avoid waiting about 8 hours, the Accounting team answers with an error on purpose (for example HTTP `500`), or you use the fake teammate.

| Step | Who / screen | Do |
|---|---|---|
| 1 | Accounting | Make the events endpoint answer `500` (or stop it), then CRM completes an order. |
| 2 | CRM → Integration Health | Press **Send pending events** after each retry time. Each press counts as an attempt only when the event is due. |
| 3 | CRM → Integration Health → Dead letters | After the 6th failed attempt. |
| 4 | Accounting | Fix the endpoint / start the app. |
| 5 | CRM → Integration Health | Press **Retry** on the event, or **Retry all** under "Retry all dead letters" (a reason is required). |

**Expected**
* Step 3: the event is a **dead letter** (status dead, attempts 6, the last error), counted under Dead letters on Integration Health. Nothing is lost.
* An answer `400` (the event broke the contract) is dead at once: fix the cause, do not just retry.
* Step 5: the event is **sent**; Accounting has the sale **once**. The retry is in the audit log with the Manager's name.

---

## Sign-off

| Scenario | CRM | HR | Inventory | Accounting | Date / notes |
|---|---|---|---|---|---|
| 1 New hire → ESS → CRM → terminated | ☐ | ☐ | — | ☐ | |
| 2 Order → reserve/issue → SaleCompleted | ☐ | — | ☐ | ☐ | |
| 3 Refund → RefundRecorded | ☐ | — | ☐ | ☐ | |
| 4 Leave request in ESS only | ☐ | — | — | ☐ | |
| 5 Duplicate event | ☐ | ☐ | ☐ | ☐ | |
| 6 Retry then succeed | ☐ | — | — | ☐ | |
| 7 Dead letter then retry | ☐ | — | — | ☐ | |

Only after every box is ticked: mark the contract version as agreed. In the CRM reports, change "Mock only" / "Contract-tested" to "Verified live" **only** for the scenarios that passed with the real apps.
