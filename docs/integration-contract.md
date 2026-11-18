# JOHNVIVZ CRM — Integration Contract

**Status: Draft – not verified.** Version 0.5 (2026-11-16, with the team-agreed employee account flow). Owner: JOHNVIVZ CRM team. **The employee-request part (§4 EmployeeRequestDecided, §5 EmployeeRequestSubmitted, §5.1) is a DRAFT and on hold: ESS lives in the Accounting app (JVzPay), and approvals for all staff are done there for now (§12.4).**

**This document is still the long-term target.** The teammates' apps were inspected on 2026-11-16. HR and Inventory do not follow it yet, so CRM also speaks their current API as **interim dialects** (§12). These are switched on per app in CRM's `.env`. Mock stays the default for every app.

It follows blueprint §2, §4, §11 and §13, and the CRM master prompt §VIII–X. **Nothing here is agreed until the HR, Accounting and Inventory teams confirm it** (blueprint §13, §14 step 2). Items marked ❓ are open questions for the team.

**What "tested" means.** CRM's live adapters and its signed API are *contract-tested* against local fake HR, Inventory and Accounting servers that were written from this document (`tests/support/fakeApps.mjs`). That proves CRM does what this document says. It does **not** prove that the real applications do. Until a team confirms this contract and a call has been made against its real application, the integration is "contract-tested", never "verified live". Live mode is off by default (`INTEGRATION_*_MODE=mock`).

**Changes since v0.4:** see §13 (the list to send to the teams). Older lists: §10 (v0.4) and §11 (v0.3).

## 0. Interim decisions (until the teams answer)
Decided by the CRM owner on 2026-11-11 and 2026-11-13:

| Topic | Interim decision |
|---|---|
| Service authentication | Signed HMAC-SHA256 requests, one secret per connected app, stored in `.env` (§2). |
| Stock reservation | **By synchronous API call** to Inventory (§6), made *before* CRM saves the order. `OrderConfirmed` is still published, for information only. |
| VAT | **Accounting computes VAT.** CRM sends `is_vatable` per line and amounts without a VAT split. **Confirmed with Accounting (2026-11-16):** CRM's prices and amounts **include 12% VAT** on vatable lines. Accounting takes the VAT out of them; CRM never adds VAT on top. |
| Payment status | **Confirmed with Accounting (2026-11-16):** `payment_status` in `SaleCompleted` is `"paid"` or `"on_account"`. CRM sends only `"paid"`: a sale can be completed only after its payment is verified in full. **CRM never sends a part-paid sale**, and Accounting refuses one. |
| Service authentication per app (interim) | HMAC stays the target. Until HR and Inventory support it, CRM uses each app's own API token for that app (`INTEGRATION_<APP>_AUTH=bearer`, §12). Accounting uses HMAC. |
| HR data (interim) | JohnVivzHR sends no events. CRM **pulls** `/employees` and `/departments` every 5 minutes (§12.1). |
| Inventory (interim) | The Inventory app uses its own event names and a polled outbox (§12.2). **Checkout reserves stock with Inventory's `order.confirmed` event** (answers confirmed by the Inventory team on 2026-11-16). **Reservations there never expire**, so CRM always releases what it reserved (`order.cancelled`). |
| Employee requests (interim) | ESS is in JVzPay (Accounting). Leave, overtime and attendance correction are filed in ESS. **The first approval is given by the department supervisor or Team Leader, and the final approval by Accounting/Payroll, both inside ESS.** CRM does not approve requests for now and keeps `APPROVALS_ENABLED=false` (§12.4). A CRM-side first approval is a future enhancement (alignment report F4). |
| Staff accounts and sign-in (team-agreed) | CRM creates a **deactivated** staff account for each new CRM-department hire it reads from HR, with **no CRM password**. Staff sign in with their **ESS password**, checked by JVzPay's department login. The first success activates the account. Customers and the setup administrator keep their own CRM password (§12.5). |
| Event names | **Blueprint names** where the blueprint names the event. Master-prompt names only where the blueprint is silent (§4, §5). |
| API paths | The master prompt's `/api/integration/v1/...` form for every app, in both directions. |
| Discounts for senior citizens / PWD | Not in scope (CRM future enhancement F3). |

## 1. Principles
- **What CRM owns:** customers, customer interactions, inquiries, cases, sales orders, sales transactions, refunds, and campaigns/promotions/discounts.
- **No direct database access:** CRM never connects to `johnvivz_hr_db`, `johnvivz_accounting_db` or `johnvivz_inventory_db`. All exchange goes through the REST APIs and events below.
- **Stock and prices:** CRM never edits stock balances or product prices. It asks Inventory for availability, reservation and release.
- **Snapshots:** the copies CRM keeps (employees, departments, positions, products) carry `source`, the source ID and `last_synced_at`. They are never the source of truth.
- **No restricted HR data:** CRM stores no salary, bank, government ID or payroll data. If an HR payload contains such a field by mistake, CRM removes it *before* storing anything. HR should not send it.
- **Adapter modes** (`INTEGRATION_HR_MODE`, `INTEGRATION_INVENTORY_MODE`, `INTEGRATION_ACCOUNTING_MODE`), each one of:
  - `disabled`: no calls are made.
  - `mock`: local fixtures; records are flagged `is_mock`, and nothing is sent to a live system. **The default.**
  - `live`: signed calls. CRM answers `503 integration_not_live` to an app whose mode is not `live`, so real events are never accepted while mocked or disabled.

## 2. Service authentication (decided: HMAC)
Every request, in both directions, carries:
```
X-JVZ-Client: johnvivz_crm | johnvivz_hr | johnvivz_inventory | johnvivz_accounting   (the sender)
X-JVZ-Timestamp: 2026-11-13T09:30:00.000+08:00
X-JVZ-Signature: hex(HMAC_SHA256(secret, METHOD + "\n" + path + "\n" + timestamp + "\n" + sha256hex(body)))
```
- `METHOD` is upper case. **`path` is the request target exactly as sent: the URL path plus the query string** (`/api/integration/v1/reconciliation/sales?from=2026-11-01`). The query is therefore signed too.
- `body` is the raw request body bytes; for a request without a body it is the empty string (so `sha256hex("")`).
- `timestamp` is ISO-8601 with an offset (CRM sends `+08:00`; `Z` or any other offset is accepted).
- **Clock skew:** a request more than 5 minutes from the receiver's clock, in either direction, is refused (`JVZ_MAX_CLOCK_SKEW_SECONDS`).
- **Replay protection:** a receiver must refuse a signature it has already accepted inside the window (CRM does: `401 replayed_request`). A sender therefore signs *every attempt anew* (new timestamp), including retries. Duplicate *events* are handled separately by `event_id` (§3).
- Secrets live in `.env`, never in source code, and are never logged or shown:
  - CRM calling another app: `JVZ_SECRET_HR`, `JVZ_SECRET_INVENTORY`, `JVZ_SECRET_ACCOUNTING`.
  - Another app calling CRM: `JVZ_CRM_INBOUND_SECRET_HR`, `..._INVENTORY`, `..._ACCOUNTING`.
  - The two directions use different secrets for each app. A secret is valid only for its own app: CRM refuses a request whose `X-JVZ-Client` does not match the secret that signed it.
- Answers to a bad request: `401` with `{"error":"unauthorized" | "invalid_signature" | "stale_timestamp" | "replayed_request"}`. No detail about *why* a signature failed is given beyond that.
- Optional extra headers CRM sends: `Idempotency-Key` (on event posts and on reservation calls) and `X-Correlation-Id`.

## 3. Event envelope (all events, both directions)
```json
{
  "event_id": "8f0e8a54-2c3b-4d1e-9a5b-1c2d3e4f5a6b",
  "event_type": "SaleCompleted",
  "schema_version": 1,
  "source": "johnvivz_crm",
  "occurred_at": "2026-11-13T09:30:00.000+08:00",
  "entity_id": "<sale_id UUID>",
  "correlation_id": "<order correlation UUID>",
  "idempotency_key": "SaleCompleted:<sale_id>",
  "data": { }
}
```
- `source` must equal the sender (`X-JVZ-Client`). `schema_version` is `1`; CRM refuses any other value.
- Consumers store processed `event_id`s and ignore duplicates. CRM's `integration_inbox` enforces this twice: `event_id` is UNIQUE, and so is `(source, idempotency_key)`.
- `correlation_id` is created with the CRM order and reused by every related event, reservation and posting.
- Timestamps are ISO-8601 with an offset. **Money is a decimal string in PHP** (`"285.00"`). Quantities are JSON numbers (a kilogram product can be `1.5`).
- There is **no ordering guarantee** between events. Use `occurred_at`.

## 4. Events CRM publishes
Delivered by CRM's outbox dispatcher as `POST {target}/api/integration/v1/events`, signed (§2), with the envelope as the body. The dispatcher runs every 20 seconds and only sends to apps in `live` mode.
- Expected answer: `202 Accepted`, or `200` with `{"status":"duplicate"}` (both count as delivered).
- Retries after the 1st to 5th failure: **+1 min, +5 min, +15 min, +1 h, +6 h**. That is 6 attempts in total; **the 6th failure moves the event to `dead`** (the dead-letter queue), shown on Integration Health for a manual retry.
- `400` (the receiver says the envelope is invalid) moves the event to `dead` at once: sending the same bytes again cannot help. `401`, `403`, `5xx`, timeouts and refused connections are retried on the schedule above.

| Event (name source) | Target(s) | When | `data` |
|---|---|---|---|
| `OrderConfirmed` (blueprint) | Inventory | Order saved after a successful reservation call. Informational while reservation is by API. | `order_id, order_no, customer_id, channel, fulfillment, reservation_id, items[{line_no, product_id, sku, quantity, unit_price, is_vatable}], totals{subtotal, discount_total, grand_total}, currency` |
| `SaleCompleted` (blueprint) | Inventory, Accounting | Payment verified in full and sale completed. **Inventory consumes the reservation when it receives this event** (there is no separate "issue" call) and answers with `StockIssued` (§5). | `sale_id, order_id, transaction_no, customer_id, completed_at, items[{line_no, product_id, sku, quantity, unit_price, discount_amount, line_total, is_vatable}], discounts[{code, type, amount}], totals{gross, discount_total, net}, payments[{method, reference_no, amount, paid_at}], payment_status, currency`. No VAT split: amounts **include 12% VAT** on lines with `is_vatable: true`, and Accounting takes it out. `payment_status` is always `"paid"` (never part-paid). `reference_no` is `null` for cash. |
| `SaleCancelled` (blueprint) | Inventory, Accounting | Order cancelled before completion. CRM also calls the release API (§6) at once; the event repeats the instruction idempotently. | `order_id, sale_id (null), reason, cancelled_at, release_items[{product_id, quantity}]` |
| `RefundRecorded` (blueprint; the master prompt calls it `RefundIssued`) | Inventory, Accounting | Approved refund recorded | `refund_id, sale_id, order_id, amount, reason, return_items[{product_id, quantity, condition}], approved_by_employee_id, recorded_at`. `condition` is one of the values the CRM form offers (for example `good`, `expired`). `approved_by_employee_id` is the HR id of the approver, or `null`. |
| `PaymentRecorded` (master prompt only) ❓ | Accounting | **Not published.** Payments travel inside `SaleCompleted`. | Open question 3. |
| `EmployeeRequestDecided` (master prompt; **DRAFT**, P7, only while `APPROVALS_ENABLED=true`) | HR / ESS | A Team Leader or the CRM Manager approves or rejects a request, or the Manager returns it to HR from the exception queue. One event per request. CRM never changes the leave, attendance or overtime record: HR owns it. | `request_id, request_type, employee_id, decision, decided_by_employee_id, decided_at, reason`. `request_id`, `request_type` and `employee_id` are the ones HR sent. `decision` is `approved`, `rejected` or `returned` (`returned` = CRM could not route it and sends it back to HR without a decision). `decided_by_employee_id` is the HR id of the person who decided (or `null`). `decided_at` is ISO-8601 with an offset. `reason` is the approver's comment: **required for `rejected` and `returned`**, optional (or `null`) for `approved`. `idempotency_key` is `EmployeeRequestDecided:<request_id>`. |

## 5. Events CRM consumes
CRM endpoint: `POST /api/integration/v1/events`, signed (§2). Answers:
- `202 {"status":"accepted","event_id":...}`: stored (processing follows; a processing failure never changes this answer, see below).
- `200 {"status":"duplicate","event_id":...}`: the `event_id`, or the same sender + `idempotency_key`, is already in the inbox. It is **not** processed again.
- `400 {"error":"invalid_json" | "invalid_envelope","details":[...]}`: schema errors, a wrong `source`, an unknown `schema_version`, or an event type the sender may not send (below).
- `401` bad signature, old timestamp or replay. `403` the endpoint is not for that app. `503 {"error":"integration_not_live"}` the app's adapter is mock or disabled in CRM.

**Which app may send which event** (anything else is `400`):
- Inventory: `StockReserved`, `StockIssued`, `LowStockDetected`, `ProductCreated`, `ProductUpdated`, `ProductPriceUpdated`, `StockUpdated`, `StockUnavailable`.
- HR: `EmployeeCreated`, `EmployeeUpdated`, `EmployeeStatusChanged`, `DepartmentCreated`, `DepartmentUpdated`, `DepartmentDeactivated`, `PositionCreated`, `PositionUpdated`, `PositionDeactivated`, `EmployeeRequestSubmitted`.
- Accounting: none yet (❓ question 8).

CRM stores the event first (inbox: `received`) and processes it after: `processed`, `ignored` (valid, nothing to do, with a note), `failed` (retried by a background job every 5 minutes, up to 5 attempts) or `dead` (kept for a manual reprocess on Integration Health).

| Publisher | Event (name source) | `data` CRM expects | CRM action |
|---|---|---|---|
| Inventory | `StockReserved` | `order_id, reservation_id` | Mark the order's stock `reserved` |
| Inventory | `StockIssued` | `order_id, reservation_id?, issued_at?` | Mark a completed order's stock `issued` |
| Inventory | `LowStockDetected` | `product_id, available_qty?` | Flag `product_references.low_stock` |
| Inventory | `ProductCreated`, `ProductUpdated` (master prompt) | `product_id, sku, name, unit, category_name, selling_price, is_vatable, status` (`active`/`inactive`), `available_qty?` | Upsert `product_references` |
| Inventory | `ProductPriceUpdated` (master prompt) | `product_id, selling_price, effective_from?` | Update the snapshot price |
| Inventory | `StockUpdated`, `StockUnavailable` (master prompt) ❓ | `product_id, available_qty` (`StockUnavailable`: just `product_id`) | Refresh `available_qty` |
| HR | `EmployeeCreated` / `EmployeeUpdated` | `employee_id, full_name, work_email, department_id, position_id, employment_status` (`active`, `on_leave`, `inactive`, `separated`), `supervisor_employee_id` | Upsert `employee_references`; the CRM Manager grants the CRM role and team |
| HR | `EmployeeStatusChanged` | `employee_id, employment_status` | `inactive` or `separated` removes CRM access on the person's next request; `active` lifts the HR block. If CRM does not know the employee it asks HR once (`GET /employees/{id}`, §6). |
| HR | `DepartmentCreated/Updated/Deactivated`, `PositionCreated/Updated/Deactivated` ❓ | `department_id, name, code, is_active` / `position_id, title, department_id, is_active` | Upsert the reference; every change is audited with before/after values |
| HR/ESS | `EmployeeRequestSubmitted` (**DRAFT**, P7) | the request fields of §5.1 | While `APPROVALS_ENABLED=true`: CRM routes the request (§5.1) and puts it in the approver's queue. While it is `false`: the event is stored and kept as `ignored` (it can be reprocessed once the feature is on); nothing is routed. A malformed request is stored as `dead` with the reason. |

Any key in an HR payload that looks like salary, wage, payroll, bank, account number, tax ID, SSS, PhilHealth, Pag-IBIG, GSIS, passport, government or national ID is removed before the payload is stored.

### 5.1 Employee request approvals (DRAFT, P7; on hold, see §12.4)
**On hold (2026-11-16):** ESS is part of JVzPay (Accounting), and approvals for all staff are done in ESS for now. CRM keeps this feature off. Its Approvals page and My Requests say: "Leave, overtime and attendance requests are filed in ESS (Accounting app). Your Team Leader gives the first approval and Accounting/Payroll gives the final approval, both in ESS." The rest of this section stays as the design for a later integration.

CRM never creates, edits or deletes a leave, attendance or overtime record: **HR/ESS owns them.** CRM only receives the request, routes it to an approver, records the decision and sends it back (`EmployeeRequestDecided`, §4). Everything in this section is behind `APPROVALS_ENABLED` (default `false`) and is **not confirmed by the HR/ESS team**.

**Request** (`EmployeeRequestSubmitted`, sent by HR; `entity_id` = `request_id`; `idempotency_key` = `EmployeeRequestSubmitted:<request_id>`). `data`:

| Field | Needed for | Rule |
|---|---|---|
| `request_id` | all | HR/ESS's own id, up to 64 characters. The same `request_id` arriving again changes nothing. |
| `request_type` | all | `leave`, `attendance_correction` or `overtime`. Anything else is refused. |
| `employee_id` | all | HR id of the person the request is for (the requester). |
| `reason` | attendance_correction, overtime (required); leave (optional) | text, up to 255 characters |
| `leave_type` | leave | text (for example `Vacation leave`) |
| `start_date`, `end_date` | leave | `YYYY-MM-DD`; `end_date` not before `start_date` |
| `days` | leave | number above 0 |
| `date` | attendance_correction, overtime | `YYYY-MM-DD` |
| `time_in`, `time_out` | attendance_correction | `HH:MM`; at least one |
| `start_time`, `end_time` | overtime | `HH:MM` |
| `hours` | overtime | number above 0 and up to 24 |
| `replaces_request_id` | optional (a changed request) | the `request_id` of the request this one replaces. **Interim rule (until HR confirms):** a changed request is a NEW `request_id`; if the old one belongs to the same employee and is still pending (or in the exception queue), CRM marks it **superseded**: audited, not a decision, no `EmployeeRequestDecided` is sent for it. An old request that was already decided keeps its decision. |

**Routing** (decided when the request arrives; the first valid approver wins):
- **Agent** → the Team Leader of the agent's team.
- **Team Leader** → the CRM Manager.
- **CRM Manager** → nobody (there is nobody above in CRM) → exception.
- A requester who is not a CRM employee, an agent without a team or whose team has no Team Leader, or an approver who is **inactive, separated, without CRM access or not linked to HR** → **exception queue** for the CRM Manager. A pending request whose approver becomes invalid later moves to the exception queue too.
- **Nobody decides their own request** (checked in the service and by a database constraint).
- **Nothing is ever approved automatically.** No timer, job or default approves, rejects or returns a request.
- In the exception queue the Manager can assign a valid approver, decide it directly (not for the Manager's own request), or **return it to HR** with a comment (`decision: "returned"`).
- A rejection needs a comment of at least 5 characters.
- **Superseded** (a status, not a decision): see `replaces_request_id` above. The employee sees it as "Superseded" in CRM's read-only My Requests page.

## 6. Synchronous APIs CRM calls
All are signed (§2). A `401` means CRM's secret is wrong; CRM reports it as "rejected our signed request" and does nothing else. A timeout, refused connection or `5xx` makes the CRM action fail with "could not be reached"; **nothing is ever assumed**.

### Inventory
| Purpose | Call | Answer |
|---|---|---|
| Product list / search | `GET /api/integration/v1/products?query=&category=&page=` | `{items:[{product_id, sku, name, unit, category_name, selling_price, is_vatable, status, available_qty, low_stock?}], page, total_pages}` |
| Product detail | `GET /api/integration/v1/products/{id}` | the fields above without `available_qty`; `404` if unknown |
| Availability | `GET /api/integration/v1/products/{id}/availability` | `{product_id, available_qty, low_stock?, as_of}` |
| Current price | `GET /api/integration/v1/products/{id}/price` | `{product_id, selling_price, currency, effective_from}` |
| **Reserve stock** | `POST /api/integration/v1/reservations` with `Idempotency-Key: reserve:<order_id>` and body `{order_id, correlation_id, items:[{product_id, quantity}]}` | **Idempotent on `order_id`**: the first call answers `201`, a repeat answers `200` with the *same* `reservation_id` and reserves nothing more. Success: `{reservation_id, status:"reserved", items:[...]}`. Not enough stock / not sold: `409 {status:"rejected", items:[{product_id, quantity, available_qty, ok, reason}]}`. |
| Release reservation | `DELETE /api/integration/v1/reservations/{reservation_id}` | `200`/`202`/`204`, or `404` if it is already gone (CRM treats `404` as released). Idempotent. |
| Health | `GET /api/integration/v1/health` | `200 {"status":"ok"}` (used by "Test connection") |

At checkout CRM asks for detail + availability + price (three calls per product), then makes **one** reservation call, **then** saves the order. If saving fails, CRM releases the reservation. If the reservation answer never arrives, CRM repeats the call once (safe because it is idempotent); if it still has no answer it does not place the order and queues a clean-up that repeats the call later and releases whatever Inventory holds. ❓ Question 1 asks Inventory to **expire unconfirmed reservations** as a safety net.

### HR
| Purpose | Call | Answer |
|---|---|---|
| First load / backfill | `GET /api/integration/v1/departments?page=`, `/positions?page=`, `/employees?page=` | `{items:[...], page, total_pages}` with the fields of §5 |
| Employee lookup | `GET /api/integration/v1/employees/{employee_id}` | the employee fields of §5; `404` if unknown |
| Health | `GET /api/integration/v1/health` | `200` |

### Accounting
No synchronous call except `GET /api/integration/v1/health`. Accounting receives events (§4).

## 7. APIs CRM serves to other apps
Signed (§2). Only the listed apps may call each endpoint (`403` otherwise); the caller's CRM adapter must be `live` (`503` otherwise). Unknown ids are `404 {"error":"not_found"}`.

| Endpoint | Consumer | Returns |
|---|---|---|
| `GET /api/integration/v1/health` | any connected app | `{status:"ok", app, as_of, your_mode}` |
| `GET /api/integration/v1/customers/{customer_id}` | Accounting, Inventory | `customer_id, customer_no, display_name, status` (no contact data) |
| `GET /api/integration/v1/orders/{order_id}` | Inventory, Accounting | `order_id, order_no, customer_id, status, payment_status, channel, fulfillment, reservation_status, reservation_id, correlation_id, currency, totals{subtotal, discount_total, grand_total}, confirmed_at, completed_at, cancelled_at, items[{line_no, product_id, sku, quantity, unit_price, discount_amount, line_total, is_vatable}]` |
| `GET /api/integration/v1/sales/{sale_id}` | Accounting | `sale_id, transaction_no, order_id, customer_id, status, payment_status, completed_at, currency, totals{gross, discount_total, net}, correlation_id, payments[...], refunds[{refund_id, amount, status, recorded_at}]` |
| `GET /api/integration/v1/reconciliation/sales?from=&to=` | Accounting | `{summary, sales:[{sale_id, transaction_no, order_id, completed_at, net_amount, currency, sale_status, status, deliveries:{johnvivz_inventory, johnvivz_accounting}}], truncated}` (dates `YYYY-MM-DD`; default the last 30 days) |

## 8. Reconciliation
CRM's report (Integration Health › Sales reconciliation, CSV download, and the endpoint above) lists every completed sale with the `SaleCompleted` delivery state for each target: `confirmed` (the target accepted the event), `waiting`, `retrying`, `dead`, `mock`, `disabled` or `missing`. A sale is **unmatched** when a live target has not accepted the event 24 hours after the sale; **in progress** when it is younger than that; **not sent** when every target is mock or disabled (nothing was ever sent, so nothing can be matched).

"Confirmed" means *accepted*. CRM cannot see inside Accounting's ledger, so this is a delivery check, not proof of posting. ❓ Question 8.

## 9. Open questions for the team (please answer in writing)
**Status after the inspection on 2026-11-16:**

| Question | Answer so far |
|---|---|
| 1 Reservation | **Answered (Inventory, 2026-11-16):** for today, reservation is Inventory's own `order.confirmed` event: synchronous, all or nothing, safe to repeat, never expiring. The answers are in §12.2. Moving to the §6 `/reservations` API stays the target. |
| 2 VAT | **Answered (Accounting):** CRM prices include 12% VAT; Accounting computes it. Inventory still has to confirm where `is_vatable` comes from (I-4). |
| 3 Event names | Inventory uses its own names for now (§12.2). Accounting uses the blueprint names. |
| 4 HMAC | Accounting: yes, both ways. HR and Inventory: not yet. They use API tokens for now (§12). |
| 5 ESS approvals | **Answered:** ESS is in JVzPay (Accounting). Approvals are done there for now (§12.4). |
| 6 Identity | Open. |
| 7 HR | **Partly answered:** JohnVivzHR has a pull API (§12.1). It sends no events and has no positions endpoint (a position is text). |
| 8 Accounting posting | **Answered:** posting status can be read at `GET /api/integration/v1/crm/sales/{sale_id}` on JVzPay. CRM does not read it yet. |
| 9 Inventory → CRM events | **Answered:** Inventory never pushes. CRM polls its outbox (§12.2). |
| 10 Health | HR has `GET /ping`, not `/health`. Inventory: unknown, so CRM reads one product instead. Accounting: `GET /health`. |
| 11–13 | Open (on hold with §5.1). |

The original questions:
1. **Reservation:** is the synchronous API acceptable, and are the exact paths and answers in §6 right? Is `POST /reservations` idempotent on `order_id` as described? Can Inventory **expire** an unconfirmed reservation after (say) 30 minutes? Should `OrderConfirmed` still be sent?
2. **VAT:** confirm that Accounting computes VAT and that `is_vatable` per product comes from Inventory.
3. **Event names and data:** confirm the blueprint names and the `data` fields in §4 and §5, and decide on the master-prompt extras (`PaymentRecorded`, `StockUpdated`, `StockUnavailable`, `ProductPriceUpdated`).
4. **HMAC:** confirm the header format, that `path` includes the query string, the 5-minute window and the replay rule; who generates the secrets and how they are shared.
5. **ESS approvals (DRAFT, §5.1):** is the request format of §5.1 acceptable (field names, request types, date and time formats)? Will ESS/HR send `EmployeeRequestSubmitted` to CRM, and does it expect `EmployeeRequestDecided` back with `approved`, `rejected` and `returned`? Does HR want a `reason` on `approved` too? What should HR do with a `returned` request (route it to another approver)?
6. **Identity:** shared identity provider, or separate logins per app? CRM currently keeps its own logins linked to HR `employee_id`.
7. **HR:** names and fields of the department and position events; are the paged list endpoints in §6 (`/departments`, `/positions`, `/employees`) acceptable for the first load?
8. **Accounting:** will Accounting send an event when a sale is *posted* (for example `SalePosted {sale_id, journal_ref, posted_at}`) or expose a "posted sales" endpoint? Without it CRM can only show that the event was accepted.
9. **Inventory → CRM events:** will Inventory send `StockReserved` and `StockIssued`? CRM works without them (it shows "Reserved" until `StockIssued` arrives).
10. **Health:** is `GET /api/integration/v1/health` acceptable on every app?
11. **Requester id:** is `employee_id` the same HR id CRM already receives in `EmployeeCreated` (so CRM can match the requester to a CRM login)?
12. **Changed requests (interim rule in §5.1):** when an employee changes a request in ESS, will ESS send a NEW `request_id` with `replaces_request_id` naming the old one (CRM's interim rule), or change the old request in place? Should HR be told when CRM marks a request superseded (CRM sends nothing today)?
13. **Requesters outside CRM:** ESS covers every employee. Should HR send CRM only the requests of CRM staff, or all of them? (CRM sends the others to the Manager's exception queue.)

## 10. Changes since v0.3 (send this list to the teams)
1. **New DRAFT: employee request approvals** (§5.1). HR/ESS sends `EmployeeRequestSubmitted` (leave, attendance correction or overtime); CRM sends `EmployeeRequestDecided` back. HR keeps ownership of every leave, attendance and overtime record; CRM never creates one.
2. **`EmployeeRequestSubmitted` is now a defined inbound event** (§5): the data fields and formats are in §5.1. While `APPROVALS_ENABLED` is `false` CRM stores the event as `ignored` and routes nothing; a malformed request is `dead` with the reason.
3. **`EmployeeRequestDecided` is now published** (§4), one per request, with `decision` = `approved`, `rejected` or `returned` and a required `reason` for `rejected` and `returned`. Idempotency key `EmployeeRequestDecided:<request_id>`.
4. **Routing rules written down** (§5.1): Agent → Team Leader → CRM Manager; Team Leader → CRM Manager; nobody approves their own request; no valid approver → exception queue for the Manager; never auto-approved.
5. **Requests from the mock ESS are never sent:** a decision on a request that CRM received from its own mock source is stored as a mock event and not delivered, even if HR is later switched to live.
6. **New open questions** 5 (rewritten), 11, 12 and 13 (§9).
7. **Changed requests (added after the P7 review):** optional `replaces_request_id` in `EmployeeRequestSubmitted`; CRM marks the old pending request **superseded** (no decision, no event). Question 12 asks HR to confirm this.

## 11. Changes since v0.2 (the previous list, v0.3)
1. **Signature path includes the query string** (§2). Before, "path" was not defined.
2. **Replay protection** added: an accepted signature cannot be used twice; senders re-sign every attempt (§2).
3. **Error codes** for `401`, `400`, `403`, `503 integration_not_live` defined (§2, §5, §7).
4. **Retry wording fixed** (§4): 6 attempts, dead after the *6th* failure (v0.2 said "after the 5th failure" but listed five retries). `400` goes dead at once.
5. **Event data now follows the table in §4 exactly.** Money is a decimal string; times are ISO-8601 with `+08:00`; `SaleCompleted` carries `items`, `discounts`, `totals`, `payments[{reference_no, paid_at}]` and no VAT; `SaleCancelled` carries `release_items` and `sale_id: null`; `RefundRecorded` carries `approved_by_employee_id`.
6. **`SaleCompleted` is what makes Inventory consume the reservation.** No separate "issue" call; `StockIssued` is the optional answer (§4, §5).
7. **New: which app may send which event** (§5). Anything else is `400`.
8. **New: expected `data` of every inbound event** (§5) and what CRM does with it.
9. **New: response shapes** for the Inventory and HR calls (§6), including paging (`page`, `total_pages`), `409` on a refused reservation, and `404` on release meaning "already released".
10. **New: reservation is idempotent on `order_id`** with an `Idempotency-Key` header; CRM reserves *before* saving the order and releases on failure (§6).
11. **New endpoints proposed:** `GET /health` on every app; HR `GET /departments`, `/positions`, `/employees` (paged) for the first load.
12. **Served APIs defined** in detail (§7), with which app may call which.
13. **Reconciliation defined** (§8): confirmed / in progress / unmatched / not sent; "confirmed" means accepted.
14. **New open questions** 1 (reservation expiry), 8 (Accounting posting event), 9, 10.

## 12. Interim dialects (the teammates' apps as they are today)
The teammates' apps were inspected on 2026-11-16. So that live tests can start **now**, without waiting for anyone to rebuild, CRM also speaks each app's current API. These are **interim dialects**. Sections 1–8 stay the target. Every dialect is off by default, and it applies only while that app's mode is `live`:

| CRM `.env` | Values (default first) | Meaning |
|---|---|---|
| `INTEGRATION_<APP>_AUTH` | `hmac` \| `bearer` | `hmac` = signed requests (§2). `bearer` = CRM sends `Authorization: Bearer <APP>_API_TOKEN`, and accepts the same token from that app on CRM's own API (`Authorization: Bearer …` or `X-API-Key`). |
| `<APP>_API_TOKEN` | empty | The app's API token (bearer only). It is never logged or shown, and the token is compared in constant time. |
| `INTEGRATION_HR_SYNC` | `events` \| `pull` | `pull` = CRM reads HR every 5 minutes (§12.1). |
| `INTEGRATION_INVENTORY_DIALECT` | `contract` \| `johnvivz_inventory` | `johnvivz_inventory` = the Inventory app's events and outbox (§12.2). |
| `<APP>_API_BASE_URL` | | May be given with or without `/api/integration/v1` (JVzPay's guide includes it). CRM removes the suffix itself. |

**Bearer is weaker than HMAC:** the body is not signed, there is no timestamp, and there is no replay protection. Use it only on a trusted network, and move to HMAC (§2) when the app supports it. A production start with `bearer` prints a warning.

### 12.1 HR: JohnVivzHR (port 3001), pull only
* **Auth:** an API key made by HR with `npm run integration:key -- create crm "CRM"`. CRM: `INTEGRATION_HR_AUTH=bearer`, `HR_API_TOKEN=<key>`, `INTEGRATION_HR_SYNC=pull`.
* **What HR offers:**
  * `GET /api/integration/v1/employees`, paged with `status`, `department_id`, `q`, `page` and `page_size`. The answer is `{success, data:{items, page, page_size, total, total_pages}}`.
  * `GET /employees/:identifier`, which accepts the number, the `JV-YYYY-NNNNN` id or the code.
  * `GET /departments`, not paged, with positions nested.
  * `GET /departments/:id`.
  * `GET /health` is being added. Until then CRM falls back to `GET /ping`.
  * Errors are `404 {"success":false,…}`.
  * HR sends no events.
* **What CRM does:**
  * Every 5 minutes, and when the CRM Manager presses **Sync now** (Integration Health), CRM reads all of `/employees` (`page_size=100`) and `/departments`.
  * It compares the answer with its snapshot. Every difference becomes the event HR would have sent (`DepartmentCreated/Updated`, `PositionCreated/Updated`, `EmployeeCreated`, `EmployeeUpdated` or `EmployeeStatusChanged`).
  * Those events go through CRM's normal inbox and are applied by the **same code** as real HR events. So access revocation works, and pending approvals are re-checked.
  * Every change is audited with source `hr-sync`. Nothing is written when nothing changed. If HR cannot be read, nothing changes and the failure is in the call log.
  * Employee lookups use `GET /employees/:identifier`.
* **Field mapping:**

| JohnVivzHR | CRM | Rule |
|---|---|---|
| `permanent_employee_id`, else `employee_id` | `employee_id` (HR id) | If CRM imported someone before HR gave them a permanent id, CRM keeps its first id, so the CRM login stays linked. |
| `full_name` (or `first_name` + `last_name`) | `full_name` | |
| `email` | `work_email` | |
| `department.department_id` / `department_name` | `department_id`, department name | Departments come from `/departments` (also `department_code`, `status`). |
| `position` (text) | a `position_references` row per department + title, linked by `position_id` | HR has no `position_id`. CRM makes a stable one (`HR-POS-…`). No database change was needed. |
| `reporting_supervisor_id` | `supervisor_employee_id` | Translated to the supervisor's HR id (it may be given as the number, the JV id or the code). |
| `status` Active / On Leave / Resigned / Terminated | `active` / `on_leave` / `separated` / `separated` | `inactive` and `separated` remove CRM access on the person's next request. |
| `status` Onboarding / Rejected | not imported | If CRM already has that person, CRM sets them to `inactive` (no access stays open). |
| `phone_number`, `hire_date`, `employment_type`, anything else | **not stored** | Salary is never in these endpoints. Restricted keys are also removed (§5). |

* An employee CRM has but HR no longer lists is **reported** in the sync message and never changed automatically.

### 12.2 Inventory: the Inventory app (port 3000 on its own laptop)
* **Auth:** CRM sends `Authorization: Bearer <INVENTORY_API_TOKEN>`. CRM: `INTEGRATION_INVENTORY_AUTH=bearer`, `INTEGRATION_INVENTORY_DIALECT=johnvivz_inventory`.
  * Inventory issues CRM **its own token**, not shared with Accounting.
  * CRM calls only Inventory's CRM integration routes: `GET /products`, `/products/:id`, `/products/:id/availability`, `/products/:id/price`, `POST /events`, `GET /crm/outbox` and `POST /crm/outbox/:eventId/ack`.
  * Test connection and `check:connections` also use `GET /products?limit=1`, never `/health` or `/ping`.
  * The token is sent to Inventory only. It is checked by a test.
* **Products:**
  * `GET /api/integration/v1/products?search=&limit=100&offset=`, plus `/products/:id`, `/:id/availability` and `/:id/price` (the price is a string).
  * CRM reads the fields in camelCase or snake_case (`productId`/`product_id`, `sellingPrice`/`price`, `availableQty`, `isVatable`, `categoryName`, `status`), with or without a `{success, data}` wrapper.
  * If Inventory does not say whether a product is vatable, CRM assumes **vatable** (question I-4).
* **Events CRM sends** (`POST /api/integration/v1/events`):

| CRM event (§4) | Inventory event | Body |
|---|---|---|
| `OrderConfirmed` | `order.confirmed` | `{eventId, eventType, orderReference: <CRM order_id>, items:[{productId, quantity}]}` |
| `SaleCompleted` | `sale.completed` | `{eventId, eventType, orderReference, transactionReference: <CRM transaction number>}`. Inventory consumes the reservation and deducts the stock once. |
| `SaleCancelled` | `order.cancelled` | `{eventId, eventType, orderReference}`. Inventory releases the reservation. |
| `RefundRecorded` | `sale.refunded` | `{eventId, eventType, orderReference, transactionReference}`. Inventory does **not** restore stock. |

  * `eventId` is a UUID made from the event and the order (or the refund). Every retry carries the same `eventId`. So does the release CRM sends straight away when an order is cancelled, which is the same `order.cancelled` as the later `SaleCancelled` event. Inventory's duplicate check then applies it once.
  * Any `2xx` counts as accepted. `400`, `409` and `422` are dead letters at once. Anything else is retried (§4).
  * CRM does not send `return.received` yet (question I-7).
* **Events CRM receives:**
  * Inventory never pushes. CRM reads `GET /api/integration/v1/crm/outbox` **every minute**, and also when someone presses **Refresh product snapshot**.
  * Each event is stored in CRM's inbox first. Duplicate protection uses Inventory's `eventId`, so an event offered twice is applied once.
  * After that, CRM acknowledges it with `POST /api/integration/v1/crm/outbox/:eventId/ack`. An event is acknowledged once it is safely in CRM's inbox: processed, ignored, failed (CRM retries it itself) or dead (kept for a manual reprocess).
  * Name changes: `StockDeducted` → `StockIssued`, `ProductUnavailable` → `StockUnavailable`. `ProductCreated`, `ProductUpdated`, `ProductPriceUpdated`, `LowStockDetected` and `StockReserved` keep their names.
  * `StockReleased` and `StockAdjusted` are stored as **ignored** (CRM has no use for them yet) and acknowledged.
* **Stock reservation at checkout** (answers confirmed by the Inventory team on 2026-11-16, from their code and tests):
  * CRM sends `order.confirmed` **before** it saves the order: `{eventId, eventType, orderReference: <CRM order_id>, items:[{productId, quantity}]}`.
    * `eventId` is made from the order id, so every retry carries the same one.
    * A numeric product id goes back as a number.
    * The later `OrderConfirmed` outbox event sends exactly the same body, which Inventory answers as a duplicate.
  * Inventory checks the stock and commits **in one transaction, all or nothing, before it answers**. The outbox events (`StockReserved` per line, `ProductUnavailable` at 0) are extra notifications only.

| Inventory answers | Meaning | What CRM does |
|---|---|---|
| `202 {eventId, duplicate:false, result:{orderReference, reservations:[{productId, quantity, status:"reserved"}]}}` | reserved | Saves the order as Reserved (`inventory_reservation_ref = INV-ORDER:<order_id>`) and records the lines in the call log |
| `200 {eventId, duplicate:true, result:<original>}` | the same eventId again; or the same order reference with a new eventId and the same items | Treated as reserved: the same result. Nothing is reserved twice. |
| `409 code insufficient_stock`, `details.shortages[{productId, sku, requestedQuantity, availableStock}]` | at least one line is short; **nothing** reserved; the event is not recorded (the same eventId can be sent later) | No order. The customer sees each short product **by CRM's product name** with the quantity available. |
| `409 code product_unavailable` | unknown or archived product; nothing reserved | No order ("… is not sold any more"). CRM refreshes that product's snapshot (inactive if Inventory no longer knows it). |
| `409 code conflict` or `reservation_conflict` | the same eventId or order reference with **other** items | No order. Logged as CONFLICT and listed for staff on Integration Health. A clean-up task releases anything held under that order reference. |
| `5xx`, a timeout, or a `2xx` without a reservation result | unknown | Retried once with the same eventId, then no order, and a clean-up task: it asks again (same eventId) and releases with `order.cancelled` |

* **Reservations never expire** at Inventory. They change only with `order.cancelled` (released) or `sale.completed` (consumed; stock deducted once). So CRM always releases what it reserved:
  * when an order is cancelled;
  * when saving fails after reserving;
  * when a clean-up task finds a reservation with no saved order.

  Integration Health lists CRM orders still reserved at Inventory **24 hours** after confirmation that are neither completed nor cancelled, so staff can complete or cancel them.

### 12.3 Accounting: JVzPay (port 3002), follows the contract
* HMAC both ways (§2). JVzPay's `CRM_INBOUND_SECRET` is CRM's `JVZ_SECRET_ACCOUNTING`. Events: `POST /api/integration/v1/events` for `SaleCompleted`, `SaleCancelled` and `RefundRecorded`. Health: `GET /api/integration/v1/health`.
* JVzPay's guide puts `/api/integration/v1` in the base URL. CRM accepts the base URL with or without it.
* **Confirmed:**
  * CRM's prices include 12% VAT.
  * `payment_status` is `"paid"` or `"on_account"`. CRM sends only `"paid"`.
  * A part-paid sale is refused by Accounting, and CRM never sends one.
* Posting status can be read at `GET /api/integration/v1/crm/sales/{sale_id}` on JVzPay. CRM does not read it yet, so its reconciliation still means "accepted" (§8).

### 12.4 ESS and approvals
ESS lives in JVzPay (Accounting), not in HR. JVzPay sends requests to HR, and HR has no ESS features. **Decision (2026-11-16):** ESS handles leave, overtime and attendance correction for all staff, including CRM staff. The first approval is given by the department supervisor or Team Leader, and the final approval by Accounting/Payroll, **both inside ESS**. CRM does not approve requests for now, and keeps `APPROVALS_ENABLED=false`. A CRM-side first approval is recorded as future enhancement F4. Its Approvals page, My Requests and the Team Leader dashboard say: "Leave, overtime and attendance requests are filed in ESS (Accounting app). Your Team Leader gives the first approval and Accounting/Payroll gives the final approval, both in ESS." §5.1 stays as the design for later.

### 12.5 Employee accounts and staff sign-in through ESS (team-agreed flow)
1. **HR** encodes a new hire in onboarding and generates the Employee ID (`JV-YYYY-NNNNN`) and the Employee Unique Code.
2. **CRM** reads the new employees of the CRM department from HR (§12.1, or HR events). For each person who is active or on leave and has an email, it creates a **deactivated** staff account: "Waiting for ESS registration".
   * The account has no CRM password (`crm_users.password_hash` is NULL and `login_via` = `ess`; migration 121).
   * The CRM department is the HR department code in Manager › Settings › Teams & CRM Access (fallback `CRM_DEPARTMENT_CODE`, default `CRM`).
   * The role comes from position rules on the same page. **Exact titles are matched first; "contains" rules are only a fallback.** The defaults (team decision, 2026-11-16):
     * "CRM Manager" → CRM Manager;
     * "Team Leader" → Team Leader;
     * "Customer Service Agent" → Agent;
     * fallback: a title containing "Manager" → CRM Manager.
   * A title that matches nothing becomes **Agent and is flagged for the Manager's review** on the page.
   * The CRM Manager can override the role per person (`role_source` = `manager`; the rules never change that person again) and assigns the team.
   * Each account is audited `staff_account_created_from_hr`. Creation runs after every HR pull, after an `EmployeeCreated` event, every 5 minutes, and when the Manager presses "Create accounts from HR now".
3. The new hire **registers in ESS** (JVzPay) and creates a password there. ESS validates the person against HR.
4. Staff **sign in to CRM** with the onboarding email and the ESS password. CRM sends them to JVzPay's department login, `POST {JVzPay}/api/integration/v1/auth/login` with `{email, password}`, HMAC-signed like every call to JVzPay (§2, `JVZ_SECRET_ACCOUNTING`). JVzPay answers:
   * `200 {employee_id, employee_code, full_name, email, department_code, department_name, position, employment_status, ess_registered_at}`;
   * `401 {"error":"invalid_credentials"}`;
   * `403 {"error":"not_allowed"}`.

   CRM accepts a `200` only if:
   * the email matches the account;
   * the person is in the CRM department, in JVzPay's answer **and** in CRM's HR snapshot;
   * the HR snapshot says **Active or On Leave** (team decision, 2026-11-16), and HR has not removed the access.

   **The first success activates the account** (`ess_activated_at`, audited "activated via ESS"). Other rules:
   * Every failure shows one generic message.
   * When JVzPay cannot be reached, the message is "ESS is unavailable, try again later." There is no local fallback for staff.
   * CRM never stores, logs or shows the ESS password.
   * Sign-in attempts are rate-limited per address and per account, and every attempt is audited with its reason.
   * Staff "Forgot password" points to ESS.
5. **Resigned or Terminated in HR removes CRM access** (`separated`, §12.1). The open session ends on its next request, and a new ESS sign-in is refused. "Active" again in HR lifts the HR block.

* **Modes:** `INTEGRATION_ESS_LOGIN=live` sends every staff sign-in to JVzPay. `mock` (the default) works like this:
  * the 7 demo accounts keep `Demo@1234`;
  * accounts created from HR use a local **mock ESS registry**, filled by the setup administrator under Setup › Staff; passwords are stored hashed and only while in mock mode.
* **Customers** keep their own CRM login (they have no ESS account). **The setup System Administrator** keeps a local password as the emergency account.
* **Teams & CRM Access** shows each person's state: Waiting for ESS registration, Active, Removed by HR, or Switched off in CRM. The old P2 "Grant CRM access / invitation / set your password" flow for staff is gone.

### 12.6 Each team's current differences from the contract

| Team | Contract (target) | Today (interim dialect) |
|---|---|---|
| HR | HMAC; events pushed to CRM; `/health`; `/positions`; `employment_status` values | API key (bearer); no events, CRM pulls every 5 min; `/ping`; positions are text; `status` values Onboarding, Active, On Leave, Rejected, Resigned, Terminated; ids `employee_id` + `permanent_employee_id`; `{success, data}` wrapper |
| Inventory | HMAC; `/reservations` API (idempotent, `409` on short stock); blueprint event names with the §3 envelope; pushes events to CRM; `/health` | Bearer token; reservation by the `order.confirmed` event (202 reserved / 200 duplicate / 409 `insufficient_stock`, `product_unavailable`, `conflict`, `reservation_conflict`; all or nothing; never expires); own event names, `{eventId, eventType, …}` bodies; polled outbox with acknowledgement; no known `/health` |
| Accounting | as the contract | as the contract. Base URL given with `/api/integration/v1`. Also offers the ESS department login `POST /auth/login` (§12.5) |
| ESS | in HR, approvals routed to CRM (§5.1) | in JVzPay; first approval by the Team Leader and final approval by Accounting/Payroll, both in ESS; ESS also checks staff passwords for the CRM (§12.5) |

### 12.7 Questions for each team (please answer in writing)
**Inventory (I-1 and I-2 answered on 2026-11-16):**
1. **I-1 — ANSWERED.** `202` reserved; `200 duplicate:true` for the same eventId, or for the same order reference with the same items; `409` with `insufficient_stock` (all shortages listed), `product_unavailable`, `reservation_conflict` or `conflict`. All or nothing in one transaction. Stock is checked before the answer, so the outbox events are extra notifications only. Details in §12.2.
2. **I-2 — ANSWERED.** Reservations **never** expire. They change only with `order.cancelled` or `sale.completed`. CRM therefore always releases, and lists reservations older than 24 hours on Integration Health.
3. **I-3:** The exact field names of `/products`, `/products/:id`, `/availability` and `/price`, and the status values for a product that is no longer sold.
4. **I-4:** Which field says whether a product is subject to VAT? (CRM assumes vatable when it is missing.)
5. **I-5:** The format of one `crm/outbox` item, and the fields of each event type. Does `StockReserved` carry a reservation id?
6. **I-6:** For `transactionReference`, CRM sends its transaction number (for example `TXN-20261116-0001`). Is that what you want?
7. **I-7:** Should CRM send `return.received` when a refund returns items in good condition? With which `items` fields?
8. **I-8:** Do you reject unknown fields? (CRM sends only the fields listed in §12.2.)
9. **I-9:** Is there a health endpoint? And what does the acknowledgement answer for an unknown `eventId`?

**HR:**
1. **H-1:** What is the largest `page_size`?
2. **H-2:** Is `permanent_employee_id` given when a person becomes Active, and can it ever change?
3. **H-3:** Is `reporting_supervisor_id` the number, the JV id or the code?
4. **H-4:** The fields of a department, and how an inactive department is shown.
5. **H-5:** Are people ever removed from `/employees`? (CRM never deletes; it reports them.)
6. **H-6:** Do you plan to send events and support HMAC later?

**Accounting / ESS:**
1. **A-1:** Is `is_vatable: false` on a line respected (for example rice and eggs are VAT-exempt), or is every line treated as VAT-inclusive?
2. **A-2:** The answer format of `GET /crm/sales/{sale_id}` (posting status), so that CRM's reconciliation can show "posted" later.
3. **A-3:** In the `/auth/login` answer, is `employee_id` the HR Employee ID (`JV-YYYY-NNNNN`)? CRM matches the account by email, and records whether the ids also match.
4. **A-4:** Does `/auth/login` rate-limit or lock an account after failed attempts? (CRM also limits per account.)
5. **A-5:** Which `department_code` does ESS return for CRM staff? It must equal CRM's setting (default `CRM`).

## 13. Changes since v0.4 (send this list to the teams)
1. **Interim dialects (§12).** CRM can now talk to each app as it is today. This is switched on per app in CRM's `.env`, and the contract stays the target.
2. **Per-app authentication (§12):** `hmac` (contract) or `bearer` (the app's API token, accepted both ways). Tokens are never logged or shown.
3. **HR pull (§12.1):** CRM reads JohnVivzHR's `/employees` and `/departments` every 5 minutes and on "Sync now". The field mapping is in §12.1. Onboarding and Rejected people are not imported. Changes are applied as the usual HR events and audited as `hr-sync`.
4. **Inventory dialect (§12.2):** Inventory's event names and fields; stable `eventId`s; Inventory's outbox is polled every minute and acknowledged. Checkout reserves with `order.confirmed` (see item 9).
5. **Accounting (§12.3, §0, §4):** confirmed that prices include 12% VAT, that `payment_status` is `"paid"` (CRM never sends a part-paid sale), and that the base URL may include `/api/integration/v1`.
6. **ESS (§12.4, §5.1):** leave, overtime and attendance correction are filed in ESS. The first approval is given by the Team Leader and the final approval by Accounting/Payroll, both in ESS. CRM's approval feature stays off.
7. **Answers recorded** for questions 2, 5, 7, 8, 9 and 10 (§9). **New questions:** I-1 to I-9, H-1 to H-6, A-1 and A-2 (§12.7).
8. **Employee accounts and ESS sign-in (§12.5, team-agreed):**
   * CRM creates a deactivated staff account (no password) for each CRM-department hire from HR, with the role from position rules and the team set by the Manager.
   * Staff sign in with their ESS password, checked by JVzPay `POST /auth/login` (HMAC). The first success activates the account.
   * Resigned or Terminated in HR removes access.
   * Customers and the setup administrator keep their CRM password.
   * New questions A-3, A-4 and A-5.
9. **Inventory answered I-1 and I-2 (§12.2, §12.7), and checkout works in the Inventory dialect:**
   * CRM reserves with `order.confirmed` before saving the order. It reads `202` / `200 duplicate` / `409` (`insufficient_stock`, `product_unavailable`, `conflict`, `reservation_conflict`) and shows short products by name.
   * Because reservations never expire, CRM always sends `order.cancelled` when an order is cancelled, when saving fails, or when a clean-up task finds no saved order.
   * Integration Health lists reservations older than 24 hours and the recent conflicts.
