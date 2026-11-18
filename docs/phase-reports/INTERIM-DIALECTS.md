# Interim dialects and the employee account flow (2026-11-16)

**What this is:** CRM can now run its first live tests with the teammates' apps **as they are today**, without anyone rebuilding. It also follows the team-agreed employee account flow. The contract (`docs/integration-contract.md` §1–§8) stays the long-term target. Every app is still **mock by default**.

**Status:** contract-tested against local fakes that imitate the apps as described on 2026-11-16 (`tests/support/fakeDialects.mjs`, `tests/support/fakeApps.mjs`). **Not verified live.** No real teammate app was called.

## 1. What changed, by request

| # | Request | Done | Where |
|---|---|---|---|
| 1 | Per-app auth mode | `INTEGRATION_<APP>_AUTH = hmac | bearer` (default hmac). Bearer sends `<APP>_API_TOKEN` and accepts the same token inbound (Bearer or X-API-Key). Tokens are never logged or shown. Test connection, Integration Health and `check:connections` show the mode. | `services/integration/adapterBase.js`, `routes/integrationApi.js`, `scripts/check-connections.mjs` |
| 2 | HR pull sync | `INTEGRATION_HR_SYNC=pull`: every 5 minutes plus **Sync now**. Reads `/employees` (paged) and `/departments`. Changes become the events HR would send and go through the same inbox code, audited `hr-sync`. Field mapping is in contract §12.1. `/health` falls back to `/ping`. | `services/integration/hrPullSync.js` |
| 3 | Staff accounts from HR | CRM-department hires (active or on leave, with an email) get a **deactivated** account: "Waiting for ESS registration", no password. The role comes from position rules (Manager › Settings › Teams & CRM Access); the Manager can override it and sets the team. The page shows Waiting / Active / Removed by HR / Switched off. The old grant / invitation / set-password flow for staff is removed. | `services/staffAccountService.js`, `services/accessService.js`, `views/settings/access.xian` |
| 4 | Staff login through ESS | `INTEGRATION_ESS_LOGIN = mock | live`. Live: JVzPay `POST /auth/login` (HMAC); the password is never stored or logged; one generic error; "ESS is unavailable, try again later." when JVzPay cannot be reached (no fallback); the first success activates the account. Mock: the demo accounts keep `Demo@1234`, and accounts created from HR use a mock ESS registry (Setup › Staff). Staff Forgot password points to ESS. Sign-in is rate-limited per address and per account; every attempt is audited. Customers and the setup admin are unchanged. | `services/essLoginService.js`, `controllers/authController.js`, `middleware/rateLimit.js` |
| 5 | Inventory dialect | Event names and fields translated, stable `eventId`s, outbox polled every minute and on Refresh, acknowledged after storing, `StockDeducted→StockIssued`, `ProductUnavailable→StockUnavailable`, release with `order.cancelled`. **Checkout reserves with `order.confirmed` (§4).** | `services/integration/inventoryDialect.js`, `outboxDispatcher.js` |
| 6 | Accounting | Base URL accepted with or without `/api/integration/v1`. VAT (12% included) and `payment_status` (`paid`; never part-paid) written into the contract. | `config/index.js` (`apiBase`), contract §0, §4, §12.3 |
| 7 | Approvals | `APPROVALS_ENABLED=false` stays. The Approvals page, My Requests and the Team Leader dashboard show the new ESS text. CRM-side first approval is recorded as **F4** in the alignment report. | `views/approvals/disabled.xian`, `docs/crm-alignment-report.md` |
| 8 | Docs and fakes | Contract **v0.5** (§12 dialects, §12.5 account flow and ESS login, §12.7 questions, §13 change list). MERGE-GUIDE step 4A and checklists. MERGE-TEST-SCENARIOS: scenario 1 is the new-hire flow, scenario 4 happens only in ESS. `fake-teammates` imitates JohnVivzHR, the Inventory app and JVzPay `/auth/login`. | `docs/`, `scripts/fake-teammates.mjs` |

## 2. Database change (approved before it ran)
**Migration 121** changes `crm_users` only, with the SQL exactly as approved on 2026-11-16:
* `password_hash` may be NULL;
* new columns `login_via` (`local`/`ess`), `ess_activated_at` and `role_source` (`position_rule`/`manager`);
* a CHECK that only an ESS staff account may have no password.

Existing rows keep `login_via = 'local'`. The rollback refuses to run while any ESS account has no password. No other table changed:
* HR position text goes into `position_references` (a stable `HR-POS-…` id per department + title);
* the department code and position rules go into `crm_settings`;
* the mock ESS registry also goes into `crm_settings` (`mock_ess.<email>`, bcrypt).

## 3. Settings in `.env` (all only matter when the app is live)
`INTEGRATION_HR_AUTH`, `INTEGRATION_INVENTORY_AUTH`, `INTEGRATION_ACCOUNTING_AUTH`, `HR_API_TOKEN`, `INVENTORY_API_TOKEN`, `ACCOUNTING_API_TOKEN`, `INTEGRATION_HR_SYNC`, `INTEGRATION_INVENTORY_DIALECT`, `INTEGRATION_ESS_LOGIN`, `CRM_DEPARTMENT_CODE`, `LOGIN_EMAIL_RATE_LIMIT_MAX` (optional).
* `.env.example` has the contract defaults.
* The local `.env` is preset for today's teammates (HR bearer + pull, Inventory bearer + dialect), with **every mode still `mock`** and ESS login `mock`.

## 4. Inventory reservation (question I-1 answered 2026-11-16; checkout re-enabled)
The Inventory team described the `order.confirmed` answers from their code and tests. CRM now follows them (contract §12.2):

| Inventory answers | CRM does |
|---|---|
| `202` reserved | Saves the order as Reserved (`INV-ORDER:<order_id>`); the lines are recorded in the call log |
| `200 duplicate:true` (the same eventId, or the same order reference with the same items) | Treats it as already reserved (same result) |
| `409 insufficient_stock` | No order. Each short product is shown **by CRM's product name** with what is available. |
| `409 product_unavailable` | No order ("… is not sold any more"). CRM refreshes that product's snapshot. |
| `409 conflict` / `reservation_conflict` | No order. Logged as CONFLICT, listed on Integration Health, and a clean-up task releases anything held. |
| `5xx` / no answer / `2xx` without a result | Retried once (same eventId), then no order and a clean-up task: ask again, then `order.cancelled` |

* **Reservations never expire,** so CRM always releases: on cancel, when saving fails after reserving, and from the clean-up task when no order was saved.
* **Integration Health** has a new section, "Stock held at Inventory for more than 24 hours", which lists orders neither completed nor cancelled, plus the recent conflicts.
* **Code:**
  * `readReservationAnswer` and `reserveViaOrderConfirmed` in `services/integration/inventoryDialect.js`;
  * `refreshSnapshotFor` in `inventoryAdapter.js`;
  * the conflict handling in `orderService.placeOrder`;
  * `staleReservations` and `reservationConflicts` in `healthService.js`.
* **No database change:** the reference fits `sales_orders.inventory_reservation_ref`.

* **Still open for Inventory:** I-3 to I-9 in contract §12.7. These are field names, the VAT flag, the outbox format, `transactionReference`, `return.received`, unknown fields and health.
* **One assumption:** CRM sends numeric product ids back as numbers (`"12"` → `12`), because Inventory's answers use numbers.

## 5. Choices I made (please check)
* **ESS sign-in match.** CRM matches the account by **email**. It also requires the CRM department in both JVzPay's answer and CRM's HR snapshot, and a non-blocked HR status. Whether JVzPay's `employee_id` equals CRM's `JV-…` id is recorded but not required, because the format is unconfirmed (question A-3).
* **Active and On Leave may sign in.** This is now a **team decision (2026-11-16)**. Only inactive or separated block.
* **Live ESS covers every staff login**, including the demo and fixture staff. To use the demo staff with live ESS, register them in ESS. Customers and the setup admin are never affected.
* **Mock ESS.** Accounts created from HR sign in through a mock ESS registry that the setup admin fills. Without it, the account flow could not be shown offline. A production start with ESS mock prints a warning; ESS live without the Accounting URL or secret is an error.
* **Position → role defaults (team decision, 2026-11-16).**
  * Exact titles first: "CRM Manager" → CRM Manager, "Team Leader" → Team Leader, "Customer Service Agent" → Agent.
  * "contains Manager" → CRM Manager, only as a fallback.
  * Anything else → Agent, flagged "Role needs review" on Teams & CRM Access (with a count at the top).
  * Example: "CRM Team Leader" is not an exact title, so it becomes Agent and is flagged. Add it as an exact rule if HR uses it.
  * Rules saved before this change are still read as "contains" rules.
* **Inventory's own CRM token.** No change was needed for the token itself. CRM calls only Inventory's CRM integration routes, and since this change Test connection and `check:connections` use `GET /products?limit=1` instead of `/health` and `/ping` there. A test (INV-ROUTES) proves CRM made no other call, and that the token went nowhere else.
* **Role overrides.** The Manager can change a waiting CRM Manager account (to correct a position rule); after activation, the setup admin manages it. A waiting account cannot be switched on by hand: only the first ESS sign-in activates it.
* **Re-applying rules.** A changed position rule re-applies to accounts whose role was not set by hand, and only when they have no active cases.
* **Things CRM only reports.** It does not act on HR employees missing from HR's answer, and does not change an account's email when HR changes the email.
* **Not built.** CRM does not send `return.received`. It also does not read JVzPay's posting status endpoint yet.

## 6. Tests
`npm test` now also runs `tests/dialects.acceptance.mjs`. P2's grant and invitation checks were rewritten for the new account flow.

**Results (2026-11-17, after the role-rule and token follow-up; all 13 suites pass, 555 checks):** p1 67, p2 68, ui 18, status 29, p3 43, p4 41, p5 55, p6 69, p7 48, p8 26, p9 17, p10 19, dialects 55.

The dialects suite runs CRM live against the fake JohnVivzHR, the fake Inventory app and the contract Accounting fake (with ESS login). It covers:
* per-app auth in both directions, and Test connection per style;
* the HR pull: mapping, no personal data, paging, changes, removal and restore of access, the job, and failures;
* the account flow: waiting accounts, ESS registration, activation, generic errors, "ESS unavailable", customers and the setup admin unaffected, rate limit, Forgot password;
* the Inventory dialect: products, checkout refused, outbox poll with ack, duplicates, translated events with stable eventIds, StockDeducted → StockIssued;
* Accounting with the suffixed base URL;
* the ESS approvals text;
* `check:connections` and `fake-teammates` in these modes;
* no token anywhere.

**Two existing checks were updated** for the new requirements, not to hide failures:
* P10 DOC-2 now looks for "HR onboards" (scenario 1 was renamed as requested).
* P2 ACCESS-02 forges a POST to `/provision` instead of the removed `/grant` route.

**Database:** migration 121 was applied to `johnvivz_crm_db` (batch 9) after all suites passed. A backup was taken first: `backups/johnvivz_crm_db-20261116-223719.sql`. All 7 existing logins kept `login_via = local` and their passwords. The ER diagram files were regenerated (61 tables).

## 7. Diagram differences
The ER diagram changes for `crm_users`: the new columns and a nullable `password_hash`. The activity, sequence and use-case diagrams for "grant CRM access / invitation" are replaced by "account from HR → ESS registration → first ESS sign-in". See `docs/phase-reports/DIAGRAM-DIFFERENCES.md`.
