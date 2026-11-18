# JOHNVIVZ CRM — Blueprint Alignment Report and Updated Plan

Date: 2026-11-11 · Application: **JOHNVIVZ CRM** (this codebase, currently "JOHNVIVZ TECH Customer Support")
Status: **P0 approved 2026-11-11 (decisions in §8). P1 delivered 2026-11-12, see [phase-reports/P1.md](phase-reports/P1.md).**

Companion files:
- [`sql/crm_schema_proposal.sql`](sql/crm_schema_proposal.sql): proposed `johnvivz_crm_db` schema
- [`sql/migrate_johnvivz_tech_to_crm.sql`](sql/migrate_johnvivz_tech_to_crm.sql): data copy script. **Not used**: decision D3 was to reseed instead of copying.
- [`sql/johnvivz_crm_db_schema.sql`](sql/johnvivz_crm_db_schema.sql): the schema actually created by migrations 101–112.
- [`integration-contract.md`](integration-contract.md): draft contract for the HR, Accounting and Inventory teams

---

## 0. Sources and gaps

Order of authority: **blueprint > CRM master prompt > earlier specs**.

| Source | Status |
|---|---|
| Blueprint (main sections 1–14 and supplements A–I) | `docs/johnvivz-blueprint.pdf`. Read in full. |
| CRM master prompt | `docs/crm-master-prompt.md`. Read in full on 2026-11-12; the conflict list (§6) was re-checked against it. |
| Earlier specifications | The original phase prompt and "Section 15 Phase 2 decisions". The 17 diagrams were revised by the owner for the CRM logic, so they are no longer a conflict. |
| Alignment prompt placeholders | Resolved: customer portal YES; ESS approvals built behind `APPROVALS_ENABLED=false` until the team confirms. |

---

## 1. What is built vs. what the blueprint requires

| Area | Built today | Blueprint / alignment requirement | Gap |
|---|---|---|---|
| Database | `Johnvivz_Tech` (stored as `johnvivz_tech`) | `johnvivz_crm_db` | Move the data (§4). |
| Roles | admin, manager (view-only), agent, customer | CRM Manager → Team Leader → Agent; Customer Account | Add Team Leader. Manager gains configuration and assignment rights. The admin role goes away. |
| Staff identity | Local accounts created by the Admin | Identity comes from HR (`employee_id`, department, position, status) | Add `employee_references`, an HR consumer, and access revocation on `EmployeeStatusChanged`. |
| Teams / scope | None (agents see assigned tickets) | Team Leader sees own team; Agent sees assigned customers and cases | Add `crm_teams`, `agent_assignments`, team scope. |
| Customers | Name and email in `users`; `customers` is a profile table | CRM owns customer profiles; walk-in customers may have no login | `customers` becomes the master record, with contacts, addresses, preferences and consents. |
| Interactions | None | `customer_interactions` timeline | New. |
| Inquiries | A case type ("Inquiry") | Separate `inquiries` (Agent nav, Customer "Submit Inquiry") | New table; an inquiry can be converted into a case. |
| Cases | `support_tickets`, 6 statuses incl. Reopened | `customer_cases`; Open, Assigned, In Progress, Waiting for Customer, Escalated, Resolved, Closed; escalation Agent → Team Leader → Manager | Rename, remap statuses, add escalation records. |
| Sales | None | Orders, items, payment references, transactions, discounts, promotions, refunds, campaigns | New module. |
| Inventory | `erpService` reads tables in the same DB if they exist | REST API and events only; CRM never edits stock or prices | Replace with an Inventory adapter (disabled, mock or live) and product snapshots. |
| Events | None | Envelope, outbox and inbox, idempotency, retries with backoff, dead-letter queue, Integration Health page, reconciliation | New. |
| ESS approvals | None | Queue for leave, attendance correction and overtime; no self-approval; exception queue | New (pending team confirmation). |
| Dashboards / nav | 4 role dashboards with my own navigation | Exact supplement E navigation per role, own route per role | Rebuild the navigation; add the Team Leader dashboard. |
| Analytics | SLA, CSAT, agent performance, exports | Plus repeat customers, retention, sales trends, best sellers, basket value, forecasts labelled "Estimate" with stored metadata | Extend. Demo/test data is excluded by default. |
| Audit | `activity_logs` (action and details) | Actor, role, record, reason, before/after values; cannot be edited or deleted | Becomes `crm_audit_logs` with append-only triggers. |
| Privacy | Full contact data on staff lists | Mask customer personal data in general views; consent records | Add masking helper and consents. |
| Email | Not used | "Verified email" for accounts | Email verification for portal accounts, with a mail adapter whose mock mode logs the link. |
| Kept as-is | Case numbers `JVT-YYYYMMDD-0001`, SLA due dates, overdue flags, internal notes filtered in SQL, attachment security, CSRF, rate limits, bcrypt, session regeneration, migrations runner, reports/exports | — | Re-pointed to the new tables. |

---

## 2. Changes required (by layer)

1. **Data layer**
   - New migration set `migrations/1xx_*.js` that creates `johnvivz_crm_db` (§3 tables).
   - Models renamed to the blueprint names.
   - `services/erpService.js` removed. It is replaced by `services/integration/` (adapters, outbox, inbox, dispatcher).
2. **Auth and RBAC**
   - `crm_users` replaces `users`.
   - Roles become `crm_manager`, `team_leader`, `agent` and `customer`.
   - `middleware/permissions.js` holds a permission matrix: role → actions.
   - Record scopes:
     - Agent: assigned customers and cases.
     - Team Leader: their team.
     - Manager: all of CRM.
     - Customer: own records.
   - `managerReadOnly` is removed, because the Manager now configures and assigns.
3. **HR identity**
   - Staff can sign in only when their `employee_references` status is `active` (checked on every request).
   - In mock mode, seeded mock employees are labelled MOCK.
   - Account creation becomes "grant CRM access": the Manager links an HR employee to a CRM role and team. CRM never edits employee data.
4. **Customer master**
   - Duplicate check before create, matching on normalized email, mobile, and name plus mobile.
   - Interactions timeline, agent-customer assignment, consent capture at registration, masked views.
5. **Service**
   - Inquiries, with conversion to a case.
   - New case statuses with server-enforced transitions (§2.1).
   - Escalation records, follow-up tasks, `service_targets` SLA.
   - Team Leader assigns work; the Manager can also assign.
6. **Sales**
   - Order builder using Inventory products and availability.
   - Discounts and promotions; the approver must differ from the requester.
   - Reservation via Inventory, payment references, then complete sale.
   - `SaleCompleted` is published with a correlation ID and an idempotency key.
   - Cancel and refund flows, campaigns.
7. **Integration**
   - Outbox dispatcher job with retries and backoff, then a dead-letter queue.
   - Signed inbound endpoint `POST /api/v1/events`.
   - Inbox processor that drops duplicate `event_id`s.
   - Integration Health page (pending, success, failed, retried, dead).
   - Unmatched-sales reconciliation report.
   - Served APIs (customer, order, sale lookup).
8. **ESS approvals**
   - Approver resolution follows the routing matrix.
   - No self-approval.
   - Requests with no valid approver go to an exception queue.
   - The decision is sent back to HR as an event.
9. **Dashboards**
   - One route and one navigation per role, exactly as in supplement E (§2.2).
   - Actionable queues: pending approvals, overdue follow-ups, escalations, failed sync.
10. **Analytics**
    - CRM intelligence KPIs.
    - Statistical forecasts (7-day moving average, linear trend, seasonal-naive 7). The best method is picked by its backtest error.
    - Forecasts are stored in `forecast_runs` / `forecast_values`, labelled "Estimate", and shown beside actuals.
    - Cancelled, voided, demo and duplicate records are excluded by default.
11. **Audit and privacy**
    - `crm_audit_logs` stores before/after values for sensitive changes, with append-only triggers.
    - Masking helper, e.g. `j***@gmail.com`, `0917 *** 0101`.
12. **Docs**
    - `docs/integration-contract.md` (draft written), the README role matrix, and the diagram update list (§6, C11).

### 2.1 Case status flow (proposal)
| From | Allowed to | Who |
|---|---|---|
| Open | Assigned (automatic on assignment) | Team Leader / Manager |
| Assigned | In Progress, Escalated | Assigned agent |
| In Progress | Waiting for Customer, Escalated, Resolved | Assigned agent (or the TL/Manager handling an escalation) |
| Waiting for Customer | In Progress (automatic when the customer replies), Resolved, Escalated | Agent |
| Escalated | Assigned (returned with a note), In Progress (handler takes it), Resolved, Escalated again (TL → Manager) | Team Leader at level 1, Manager at level 2 |
| Resolved | Closed (customer confirms, or the auto-close job), In Progress (reopened within the window; `reopen_count`+1) | Customer / Agent / system |
| Closed | In Progress (reopen within the window, by Team Leader or Manager) | TL / Manager |

Every step writes `case_status_history`, and escalations also write `case_escalations` (actor, reason, timestamp, target).

### 2.2 Navigation (exactly as in supplement E)
- **CRM Manager** (`/crm/manager`): CRM Overview · Customer Directory · Sales & Orders · Customer Service · Campaigns / Promotions · Team Performance · Analytics · Escalations · Reports · Settings
- **Team Leader** (`/crm/team-leader`): Team Overview · Agent Assignments · Customer Queue · Cases & Complaints · Follow-ups · Orders · Team Reports
- **Agent** (`/crm/agent`): My Dashboard · Customers · Interactions · Inquiries · Cases · Orders / Sales · Follow-up Tasks · Notifications
- **Customer** (`/portal`): My Profile · My Orders · Order Tracking · Submit Inquiry · Complaint / Feedback · Notifications

Pages the alignment prompt requires but supplement E has no menu item for (proposal, decision D5):
- **Approvals queue:** a widget plus a page reached from Team Overview / CRM Overview.
- **Integration Health, Audit Logs, Teams & Access, Categories, Templates, SLA targets:** tabs inside the Manager's **Settings**.
- **Bell icon:** available to all roles.

---

## 3. Table names in `johnvivz_crm_db` (final, as built in P1)

The naming rule follows the order of authority:
1. Use the blueprint name where the blueprint names the entity (main §7 and supplement E).
2. Otherwise use the CRM master prompt name (§XI).
3. Only where neither source names a table is it [CRM-LOCAL], and each such table has a stated reason.

| Group | Tables | Name source |
|---|---|---|
| Customer master | `customers`, `customer_contacts`, `customer_addresses`, `customer_preferences`, `customer_consents` | Blueprint |
| | `customer_segments`, `customer_accounts` | Master prompt |
| Engagement | `customer_interactions`, `inquiries`, `customer_cases`, `case_categories`, `case_assignments`, `case_comments`, `attachments` | Blueprint (supplement E) |
| | `ticket_escalations`, `customer_feedback`, `customer_ratings` | Master prompt |
| | `case_status_history`, `case_reads`, `response_templates` | [CRM-LOCAL]: history, unread markers and templates kept from the earlier build |
| Sales | `sales_orders`, `sales_order_items`, `sales_transactions`, `discounts`, `promotions`, `refunds`, `payment_references`, `campaigns` | Blueprint |
| | `product_references`, `cart_records`, `cart_items`, `promotion_redemptions`, `loyalty_accounts`, `loyalty_transactions` | Master prompt |
| Work management | `crm_users`, `crm_teams`, `agent_assignments`, `follow_up_tasks`, `service_targets`, `crm_notifications`, `crm_audit_logs` | Blueprint |
| | `roles`, `permissions`, `approval_requests` | Master prompt |
| | `role_permissions` | [CRM-LOCAL]: join table for the role-permission matrix (supplement I) |
| HR references | `employee_references` (blueprint §7 "employee references"), `department_references`, `position_references` | [CRM-LOCAL] names for the HR snapshots |
| Integration | `integration_inbox`, `integration_outbox`, `integration_logs` | Master prompt |
| Infrastructure / analytics | `number_sequences`, `crm_settings`, `email_verification_tokens`, `forecast_runs`, `forecast_values` | [CRM-LOCAL] |

The master-prompt names `users`, `support_tickets`, `ticket_categories`, `ticket_assignments`, `ticket_responses`, `customer_inquiries`, `customer_orders`, `customer_order_items`, `notifications` and `audit_logs` are **not** used, because the blueprint names the same entities (C15).

---

## 4. Database plan (decision D3: fresh database plus reseed; executed in P1)

| Step | Action | Result |
|---|---|---|
| 1 | Back up the legacy database and the code | Done: `backups/johnvivz_tech_20261111_before_P1.sql` and `backups/code_before_P1_20261111.tar.gz` (git-ignored) |
| 2 | `DB_NAME=johnvivz_crm_db npm run migrate` | 12 migrations (101–112) applied; 56 tables plus `migrations` |
| 3 | `npm run seed` | Mock HR fixture (3 staff), 1 team, 7 logins (one per role), 5 customers (2 walk-ins without login), 40 cases (all `is_demo = 1`) |
| 4 | `.env`: `DB_NAME=johnvivz_crm_db` | Switched |
| 5 | Leave `johnvivz_tech` untouched | Same row counts and `CHECKSUM TABLE` values before and after. The runner refuses to migrate any database that holds the legacy 001–008 rows. |

**Rollback:** set `DB_NAME=Johnvivz_Tech` and restore the code archive. The current code targets the CRM schema only, so the legacy database is a data fallback, not a code fallback.

---

## 5. Updated phase plan (replaces the old 10 phases)

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0** ✅ | This report, schema and contract approved | Approved 2026-11-11 |
| **P1 Foundation** ✅ | Fresh `johnvivz_crm_db` (migrations 101–112, all 56 tables); seeders; `.env` switch; audit table with triggers; masking helper; adapter framework and mock HR fixture.<br>Brought forward so the app keeps working on the new tables:<br>• the four roles and the permission matrix;<br>• record scopes;<br>• HR access revocation (mock mode);<br>• the new case statuses and escalation chain;<br>• supplement E menus, with "Coming Soon" items | Done 2026-11-12. 67/67 automated checks pass (see [phase-reports/P1.md](phase-reports/P1.md)). |
| **UI completion pass** ✅ | Every supplement E menu page built for all roles: Live where the backend exists, labelled Sample where it belongs to P3–P9 (forms validate, nothing is saved) | Done 2026-11-13. 158 automated checks pass (see [phase-reports/UI-pass.md](phase-reports/UI-pass.md)). |
| **P2 Identity & roles** ✅ | • Teams & CRM Access screen for the Manager (teams, grant access, change role/team, switch access, invitations);<br>• email verification and password reset by email, with the mail transport and Mail Log;<br>• HR reference events (TC-06, mock mode);<br>• still for P6: the live HR consumer and TC-05 / TC-06 in live mode | Done 2026-11-13. P1 67/67 and P2 64/64 pass (see [phase-reports/P2.md](phase-reports/P2.md)). |
| **P3 Customer master** ✅ | Walk-in customer creation; duplicate check; contacts and addresses; preferences; interactions timeline; agent–customer assignment | Done 2026-11-13. TC-07 and TC-08 pass; P1 67, P2 64, UI 27, status 29, P3 42 (see [phase-reports/P3.md](phase-reports/P3.md)). |
| **P4 Customer service** ✅ | Inquiries workflow (answer or convert to a case); follow-up tasks; staff-created cases for phone and walk-in customers | Done 2026-11-13. Inquiry and follow-up tests pass; P1 67, P2 64, UI 26, status 29, P3 42, P4 41 (see [phase-reports/P4.md](phase-reports/P4.md)). |
| **P5 Sales** ✅ | Product snapshots, availability, orders, discounts/promotions, reservation, payments, complete/cancel, refunds, campaigns | Done 2026-11-13. TC-11..TC-15 and TC-18 pass in mock mode; P1 67, P2 64, UI 18, status 29, P3 43, P4 41, P5 55 (see [phase-reports/P5.md](phase-reports/P5.md)). SC/PWD discounts not built (no column for the ID number). |
| **P6 Integration** ✅ | Signed inbound API (HMAC, one secret per app, timestamp window, replay guard), inbox with duplicate protection, outbox dispatcher (retries +1 min, +5 min, +15 min, +1 h, +6 h, then dead letter), live HR / Inventory / Accounting adapters (off by default), reserve-first checkout with compensation, Integration Health, unmatched-sales reconciliation, served APIs, `integration-contract.md` v0.3 | Done 2026-11-13. All three integrations are **Contract-tested** against local fake servers, never "verified live" (see [phase-reports/P6.md](phase-reports/P6.md)). TC-05 and TC-06 pass in live HR mode against the fake HR server. |
| **P7 ESS approvals** ✅ | Approval queue behind `APPROVALS_ENABLED` (default false; the queue says "Approvals are not enabled yet"), requests through the P6 inbox from a mock ESS, routing Agent → Team Leader → Manager and Team Leader → Manager, exception queue for the Manager (assign, decide, return to HR), nobody approves their own request, never auto-approved, decision event back to HR (mock), contract v0.4 (DRAFT) | Done 2026-11-14. **Draft, mock source only**: the HR/ESS team has not confirmed the request format (see [phase-reports/P7.md](phase-reports/P7.md)). Also fixed the P6 phone-width tables. |
| **P8 My Requests, loyalty, campaigns, team targets** ✅ | Read-only My Requests for staff (own requests only, 404 for others, link from My Account and dashboards, notification on decision, respects `APPROVALS_ENABLED`); Superseded state; loyalty (D13 rules, `loyalty_redemptions`); campaign results from real orders; team targets from `service_targets` | Done 2026-11-14 (see [phase-reports/P8.md](phase-reports/P8.md)). |
| **P9 Dashboards and analytics** ✅ | Every role's dashboard from real data; analytics overview, sales, customers, forecasts; forecasts labelled "Estimate" with method, input period, horizon and back-test error; rule-based segments; cancelled, test and demo data excluded by default or labelled | Done 2026-11-14. TC-22 and TC-23 pass (see [phase-reports/P9.md](phase-reports/P9.md)). |
| **P10 Final testing and merge kit** ✅ | Sample pages and badges removed; phone layout for all 46 tables; merge guide, merge test scenarios, deployment guide; generate-secrets, check-connections, fake-teammates, backup / restore test, create-first-accounts; production start-up checks; generated ER diagram; all diagram differences in one file | Done 2026-11-14. All 12 suites pass; restore tested (see [phase-reports/P10.md](phase-reports/P10.md)). |

Each phase stops for your review, with files changed, migrations, test steps and anything unfinished.

---

## 6. Conflicts between sources (re-checked against the master prompt, 2026-11-12; higher source wins)

| # | Topic | Lower source says | Higher source says | Resolution |
|---|---|---|---|---|
| C1 | Database name | `Johnvivz_Tech` | `johnvivz_crm_db` (blueprint §2) | Done in P1. |
| C2 | Manager rights | Section 15: Manager is view-only | Manages configuration, assignments and escalations (blueprint supplement E; master prompt §II) | Done: the Manager is not view-only. |
| C3 | Roles | admin / manager / agent / customer | CRM Manager → Team Leader → Agent, plus Customer Account | Done. A **System Administrator (setup only)** is kept by your decision: outside the hierarchy, no customer data, every action audited. |
| C4 | Staff accounts | Admin creates staff locally | HR owns identity | Done: staff link to `employee_references`. In mock mode the setup admin creates logins for mock-fixture employees only. |
| C5 | Customer data location | Profile in `users` | CRM owns customer profiles; walk-ins may have no login | Done: `customers` is the master record; logins link through `customer_accounts`. |
| C6 | Case statuses | Open, In Progress, Pending, Resolved, Closed, Reopened | Open, Assigned, In Progress, Waiting for Customer, Escalated, Resolved, Closed (alignment prompt; master prompt §VI) | Done. Reopen is an action. |
| C7 | Who assigns | Admin | Team Leader (own team) and CRM Manager | Done. |
| C8 | ERP integration | Read other modules' tables | REST and events only | Done: `erpService` removed; adapter framework (disabled / mock / live) added. |
| C9 | Email verification | Email off | "Verified email" (blueprint §11) | Done in P2: a customer confirms the emailed link before the first sign-in; staff confirm the mailbox when they set their password from the invitation. |
| C10 | Analytics data | Demo data included | Exclude test, duplicate and cancelled records by default (blueprint §10) | Done in P9: analytics exclude cancelled, voided, test and demo records by default; an explicit switch includes demo data and labels the page "includes demo data". Operational dashboards count demo rows and label them. |
| ~~C11~~ | ~~Diagrams~~ | — | — | **Removed:** the owner revised the 17 diagrams for the CRM logic. Differences found while building are listed in each phase report. |
| C12 | No AI/ML vs. predictive analytics | No AI/ML | Forecasts (blueprint §10; master prompt §XIII) | Done in P9: statistical methods only (7-day moving average, 28-day linear trend, seasonal naive), chosen by back-test, labelled "Estimate" beside the actuals. |
| C13 | Menus vs. required pages | Approvals, Integration Health and Audit pages are needed | Supplement E menus are exact | Done: those pages are Settings tabs and dashboard queue cards. |
| C14 | Number prefixes | — | Unique, stable IDs | Kept `JVT-` for cases; `CUS-`, `INQ-`, `SO-`, `SALE-`, `RFD-` added. |
| C15 | Table names | Master prompt: `users`, `support_tickets`, `ticket_*`, `customer_orders`, `notifications`, `audit_logs` | Blueprint: `crm_users`, `customer_cases`, `case_*`, `sales_orders`, `crm_notifications`, `crm_audit_logs` | Blueprint names win; master-prompt-only tables are added under their master names (§3). |
| C16 | Event names | Master prompt: `RefundIssued`, `PaymentRecorded`, `StockUpdated`, `StockUnavailable`, `ProductPriceUpdated` | Blueprint: `RefundRecorded`, `StockReserved`, `StockIssued`, `LowStockDetected` | Blueprint names (your decision). Master-only events are open questions in the contract. |
| C17 | Inventory API paths | Earlier draft: `/api/v1/...` | Master prompt: `/api/integration/v1/products...` (the blueprint gives no paths) | Master prompt paths used in the contract. |
| C18 | "Ticket" vs. "case" wording | Master prompt says ticket | Blueprint and supplement E say case | Screens say "case" ("Cases & Complaints"). One exception: `ticket_escalations` keeps its master-prompt name, because the blueprint names no escalation table. |
| C19 | Customer catalog, cart and checkout | Master prompt §V: customers order through the portal | Blueprint §7: the portal shows own orders and inquiries "if enabled" | Portal is YES, so cart and checkout are in scope (P5, `cart_records` / `cart_items`). |
| C20 | Loyalty | Master prompt lists `loyalty_*` tables | Blueprint is silent | Scoped by D13 and built in P8 (earn, redeem, reversal; no tiers). |
| C21 | Customer self-service password reset | Earlier MVP: reset by the administrator | Blueprint §11: verified email | Done in P2: email-based reset for every role, one-time links, other sessions end. |
| C23 | Email delivery | Not specified | No paid APIs (standing rule) | `MAIL_TRANSPORT=log` (default, nothing sent, messages kept in `mail_outbox`) or `smtp` through any free SMTP server. The setup account reads the log under Setup › Mail Log. |
| C24 | Who creates staff logins | Setup account (decision 2026-11-11) | Blueprint: HR owns identity; the Manager decides role and team | Done in P2: the CRM Manager grants CRM access to HR employees (Settings › Teams & CRM Access) with a self-service invitation. The setup account keeps emergency local logins while HR is mock. |
| C22 | Inquiries | Master prompt: `customer_inquiries`; supplement E: Agent "Inquiries", Customer "Submit Inquiry" | Blueprint table `inquiries` | Table `inquiries` created. **Done in P4:** the customer's "Submit Inquiry" now creates a row in `inquiries` (answer, convert to a case, close); the interim case-of-type-Inquiry behaviour is gone. |

---

## 7. Acceptance test cases (blueprint §14, supplement G/H applied to CRM)

| ID | Blueprint source | Test | Expected |
|---|---|---|---|
| TC-01 | §11, G | Agent opens a case assigned to another agent (URL and API) | 404/403. Not visible in lists or search. |
| TC-02 | G | Team Leader opens a case or customer belonging to another team | Denied. Own-team records visible. |
| TC-03 | G | Customer requests another customer's case, order or attachment | Denied (404). |
| TC-04 | §11 | A hidden UI button is called directly with a forged POST (e.g. Agent → assign) | 403. The action is recorded in the audit log as denied. |
| TC-05 | §14, alignment | HR sends `EmployeeStatusChanged` = separated for an agent with an active session | The next request signs the agent out; login is refused. |
| TC-06 | §14 | HR sends `DepartmentUpdated` / `PositionUpdated` | References updated with `last_synced_at`; CRM cannot edit them. |
| TC-07 | §7 | Agent creates a customer whose mobile or email already exists | Duplicate warning listing the matches; the agent must pick the existing customer or confirm with a reason (audited). |
| TC-08 | §11 | Staff list / directory views | Email and mobile masked; full value only on the detail page for permitted roles. Consent recorded at portal registration. |
| TC-09 | alignment | Agent escalates, then the TL escalates to the Manager | Two `case_escalations` rows with actor, reason, timestamp and target; status Escalated; notifications sent. |
| TC-10 | alignment | Invalid status jump (e.g. Open → Resolved) | Rejected by the server. |
| TC-11 | §14 "CRM cannot directly edit stock" | Code/DB review plus a runtime attempt to change a quantity or price | No CRM endpoint or table changes stock or prices; `unit_price` comes only from the Inventory snapshot. |
| TC-12 | §7, 9.3 | Full sale: duplicate check → availability → order → `OrderConfirmed` → `StockReserved` → payment → complete | Status chain correct; the same `correlation_id` appears on the order, all events and `integration_logs`. |
| TC-13 | §14 "duplicated SaleCompleted" | Re-send the same `SaleCompleted` (same `idempotency_key`); re-deliver the same inbound `StockIssued` (`event_id`) | One outbox row per target; the inbound duplicate is answered `duplicate` and changes nothing. |
| TC-14 | §11 | Refund approved by the same user who requested it | Rejected by the app and by the DB CHECK. |
| TC-15 | §13 | Every outbound event | Has event_id, event_type, schema_version, source=`johnvivz_crm`, occurred_at, entity_id, correlation_id, idempotency_key, data. |
| TC-16 | §13 | Target system down | Retries with backoff; after 5 attempts status `dead`; visible on Integration Health with a manual "Retry". |
| TC-17 | §13 | Inbound event with a bad signature, an old timestamp or the wrong schema version | 401 / 400; logged; not processed. |
| TC-18 | §13, alignment | Mock mode | All mock records and events are labelled MOCK, `is_mock=1`, and never delivered to a live endpoint. |
| TC-19 | §6.3, §9 | Agent leave request; TL leave request; TL tries to approve own request | Routed to the TL; routed to the Manager; self-approval rejected. |
| TC-20 | §9 | Request whose approver doesn't exist or is inactive | Goes to the exception queue; never auto-approved. |
| TC-21 | §11 audit | Try to UPDATE/DELETE `crm_audit_logs` (via app and via SQL) | Blocked by the triggers; no UI to edit logs. Sensitive changes store before/after values. |
| TC-22 | §10 | Forecast page | Shows "Estimate", method/version, generation time, input period, horizon, error metric, and actuals beside the forecast. |
| TC-23 | §10 | Analytics with cancelled, voided and demo sales present | Excluded by default; included only with an explicit toggle; Asia/Manila dates; PHP amounts. |
| TC-24 | §14 | IDs | `customer_id`, `order_id`, `sale_id` are unique UUIDs that never change after creation; unique indexes enforced. |
| TC-25 | §4 | Reconciliation report | Lists completed sales without `StockIssued` / Accounting confirmation after 24 h. |

---

## 8. Decisions (recorded 2026-11-11)

| # | Decision | Answer |
|---|---|---|
| D1 | Customer portal | **YES**: own profile, orders, cases and feedback only |
| D2 | Schema | Recommended option: approved. Built as migrations 101–112, with the master-prompt tables added (§3). |
| D3 | Data | **Do not copy.** Fresh `johnvivz_crm_db` through migrations, then reseed. `johnvivz_tech` stays untouched as the fallback. |
| D4 | Status flow (§2.1), reopen as an action | Recommended option: approved |
| D5 | Pages missing from supplement E | Under Manager › Settings and as dashboard queue cards |
| D6 | ESS approvals | Data model now; service layer behind `APPROVALS_ENABLED=false`; UI only after the team confirms |
| D7 | Existing customers verified | Not applicable (fresh database) |
| D8 | Cart and loyalty | Cart in scope with the portal (P5); loyalty tables only (C20), later scoped by D13 and built in P8 |
| D9 | Service authentication | **HMAC**, one secret per connected app, stored in `.env` |
| D10 | Source files | Blueprint and master prompt saved in `docs/` |
| — | Roles | CRM Manager, Team Leader, Agent, Customer. The Manager is not view-only. One System Administrator, for setup only. |
| — | Staff logins | From HR records when `HR_MODE=live`; from the labelled mock HR fixture while HR is mock. Deactivated or separated employees lose access automatically. |
| — | Integration (interim) | Reserve stock by API call; Accounting computes VAT; blueprint event names |
| D11 | Unassigned customers (P3, 2026-11-13) | Visible to Team Leaders (not Agents), like the unrouted case queue, so a leader can assign them. Approved. |
| D12 | Customer merge (P3, 2026-11-13) | **Not now.** Recorded under Future enhancements (§9); no merge feature in P4–P10. |
| D13 | Loyalty (P5 review, 2026-11-13) | **Built in P8** with simple rules: 1 point per PHP 100 of a completed sale, net of refunds (a refund reverses the points); 100 points = PHP 10 discount on a later order; no expiry; one loyalty account per customer; every earn, redeem and reversal recorded in `loyalty_transactions`; clearly labelled in the customer portal. The Loyalty sample page is labelled P8 until then. |
| D14 | SC/PWD discounts (P5 review, 2026-11-13) | **Not in scope.** Recorded as F3 (§9): the legal rules and VAT are owned by Accounting. |
| D15 | Order statuses (P5 review, 2026-11-13) | **Keep the blueprint lifecycle** (confirmed, ready, completed, cancelled). The proposed ALTER for "Preparing" / "Out for delivery" was **declined and never run**. |
| D16 | Changed ESS requests (P7 review, 2026-11-14) | A changed request is a **new** `request_id`; the old pending one becomes **Superseded** (audited, not a decision, nothing sent). The ALTER adding `superseded` to `approval_requests.status` was shown and approved (migration 119). Open question 13 for HR in the contract. |
| D17 | Phone width of the older pages (P7 review, 2026-11-14) | Fixed in P10: every table becomes labelled cards on phones. |
| D18 | First logins on a production database (P10, 2026-11-14) | **My choice, for your review:** the seeder refuses production, and in live HR mode nothing could create the first setup administrator or CRM Manager. `scripts/create-first-accounts.mjs` creates them from the command line (the Manager from an HR employee), only when none is active, with one-time set-your-password links and audit rows. No schema change. |

---

## 9. Future enhancements (not part of P4–P10)

Ideas that were raised and deliberately left out. They are not scheduled; each needs a new decision before work starts.

| # | Enhancement | Notes |
|---|---|---|
| F1 | **Customer merge** | Combine two customer records into one (move cases, orders, interactions, contacts, addresses and consents to the surviving record; set the other to `merged` with `merged_into_id`; audit it). `customers.status = 'merged'` and `merged_into_id` already exist in the schema and the directory already hides merged rows, but no screen or service performs a merge. Until then a duplicate that was created on purpose (duplicate check override) stays as two active customers. Decision 2026-11-13: not now. |
| F2 | **Follow-up task type** | A "type" for each follow-up (call back, send information, check delivery, payment reminder, other) was in the UI-pass sample but `follow_up_tasks` has no column for it. Decision 2026-11-13: not now; the field was dropped. The change would be an `ALTER TABLE follow_up_tasks ADD COLUMN task_type ...` and needs its SQL shown and approved first. |
| F3 | **SC/PWD (senior citizen / person with disability) discounts** | Not in scope (decision 2026-11-13). The legal rules and the VAT treatment belong to Accounting, and CRM has no column for the ID number. Would need a new design with Accounting before any work starts. |
| F4 | **CRM-side first approval of employee requests** | Decision 2026-11-16: ESS (in JVzPay) handles leave, overtime and attendance correction; the first approval is given by the department supervisor / Team Leader and the final approval by Accounting/Payroll, both inside ESS. CRM does not approve requests for now (`APPROVALS_ENABLED=false`). The P7 queue, routing and `EmployeeRequestDecided` event stay in the code as the design for a later integration in which CRM gives the first approval (contract §5.1, §12.4). Needs JVzPay to send requests to CRM and accept the decision back. |
