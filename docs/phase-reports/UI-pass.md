# UI Completion Pass Report

Date: 2026-11-13. Status: **complete, waiting for your review**. P3 has not been started. Order of authority: blueprint > CRM master prompt > earlier specs.

## 1. Result in one paragraph
Every page in the supplement E menus now opens for all four CRM roles and for the setup administrator. No menu item is disabled and the text "Coming Soon" no longer appears anywhere. Pages whose data and logic already exist (cases, customers, teams, access, identity, reports, settings) are **Live**. Pages whose backend belongs to a later phase are **Sample**: complete screens with filters, tables, forms and detail views, a "Sample data – not yet connected" banner, forms that validate but never save, and record-level scope applied to the sample rows. The whole pass writes nothing to the database.

## 2. How the sample screens work
- **One place for everything sample:** `services/samples/` holds the data (`data.js`), the screen definitions (`pages.js`) and the helpers (`engine.js`). Templates are `views/samples/page.xian` and the `sample_*` partials. Routes are generated from the definitions by `routes/samples.js`.
- **Removing a sample:** when a phase builds the real module, delete its definitions from `pages.js` and its datasets from `data.js`, then add the real controller and route. No other file refers to the sample data except the dashboards' widgets (`widgetsFor` in `pages.js`) and the customer-detail panel (`customerPanel`).
- **Badge:** every sample page and every sample dashboard widget group shows "Sample data – not yet connected" and the phase that connects it. All sample IDs contain `SAMPLE` (for example `SO-SAMPLE-0001`), so they cannot be mistaken for real numbers.
- **Forms:** input is validated on the server (required, length, number range, date, email, phone, allowed options, and business rules such as "delivery needs an address" or "out-of-stock products are refused"). An invalid form is shown again (422) with the errors. A valid form answers **"This action will be enabled in P<n>. Nothing was saved."** The same applies to inline buttons (record payment, cancel, approve refund, answer inquiry, add to cart, checkout, retry dead letter, complete follow-up).
- **No writes, no events:** the sample code has no database writes and no adapter calls. The test compares the row count of all 59 tables before and after the whole pass: nothing changed, and the sales, payment, approval and integration tables stay empty.
- **Record-level scope on samples:** every sample row says whose it is (own, same team, other team). Agent sees own, Team Leader own team, Manager all, Customer only their own orders. Opening a record outside your scope is a 404, and the same check applies to inline actions.
- **Roles:** the same role checks as the live pages (403 for other roles). The demo seed is unchanged at 7 accounts.

## 3. Page inventory by role

### CRM Manager (`/crm/manager`)
| Menu item | Route | Live / Sample | Connects in |
|---|---|---|---|
| CRM Overview | `/crm/manager` | **Live** (case, customer, escalation and team figures); the "Sales, campaigns & analytics" widgets are **Sample** | P5, P6, P7, P9 |
| Customer Directory | `/crm/customers`, `/crm/customers/:id` | **Live**; "Add customer" → `/crm/customers/new` is **Sample**; the purchase history and interaction panel on the detail page is **Sample** | P3, P5 |
| Sales & Orders | `/crm/sales` (+ payments, refunds, new order, order and refund detail) | **Sample** | P5 |
| Customer Service | `/crm/cases`, `/crm/cases/:id` | **Live** | — |
| Campaigns / Promotions | `/crm/campaigns` (+ new, detail), `/crm/promotions` (+ new), `/crm/loyalty` | **Sample** | P5 |
| Team Performance | `/crm/team-performance` | **Live** | — |
| Analytics | `/crm/analytics` (+ sales, customers, forecasts) | **Sample** | P9 |
| Escalations | `/crm/escalations` | **Live** | — |
| Reports | `/crm/reports` (+ PDF, Excel, CSV export) | **Live** | — |
| Settings | `/crm/settings` (Rules & SLA), `/categories`, `/templates`, `/audit-logs`, `/permissions`, `/access` | **Live** | — |
| Settings › Integration Health | `/crm/settings/integration` | **Sample** (the adapter modes shown are the real `.env` settings) | P6 |
| Settings › Approvals Queue | `/crm/approvals` (+ `/crm/approvals/:id`) | **Sample** (feature flag off) | P7 |

### Team Leader (`/crm/team-leader`)
| Menu item | Route | Live / Sample | Connects in |
|---|---|---|---|
| Team Overview | `/crm/team-leader` | **Live** figures; the "Team sales, follow-ups and approvals" widgets are **Sample** | P4, P5, P7, P8 |
| Agent Assignments | `/crm/team-performance` | **Live** | — |
| Customer Queue | `/crm/queue` | **Live** | — |
| Cases & Complaints | `/crm/cases`, `/crm/cases/:id` | **Live** | — |
| Follow-ups | `/crm/follow-ups` (+ new, detail) | **Sample** (own team) | P4 |
| Orders | `/crm/sales` (+ payments, refunds, order and refund detail) | **Sample** (own team) | P5 |
| Team Reports | `/crm/reports` | **Live** | — |
| (from the dashboard card) Approvals | `/crm/approvals` | **Sample** (own team, feature off) | P7 |

### Agent (`/crm/agent`)
| Menu item | Route | Live / Sample | Connects in |
|---|---|---|---|
| My Dashboard | `/crm/agent` | **Live** figures; the "Follow-ups, inquiries and orders" widgets are **Sample** | P3, P4, P5 |
| Customers | `/crm/customers` (+ detail) | **Live**; "Add customer" → `/crm/customers/new` is **Sample** | P3 |
| Interactions | `/crm/interactions` (+ new, detail) | **Sample** (own) | P3 |
| Inquiries | `/crm/inquiries` (+ detail) | **Sample** (own) | P4 |
| Cases | `/crm/cases`, `/crm/cases/:id` | **Live** | — |
| Orders / Sales | `/crm/sales` (+ payments, refunds, new order, detail) | **Sample** (own) | P5 |
| Follow-up Tasks | `/crm/follow-ups` (+ new, detail) | **Sample** (own) | P4 |
| Notifications | `/notifications` | **Live** | — |

### Customer portal (`/portal`)
| Menu item | Route | Live / Sample | Connects in |
|---|---|---|---|
| My Profile | `/portal` | **Live** (profile, cases, ratings); "My orders and shop" widgets **Sample**; "Contact Preferences" → `/portal/preferences` is **Sample** | P3, P5 |
| My Orders | `/portal/orders`, `/portal/orders/:id`, `/portal/shop`, `/portal/cart` | **Sample** (own orders only) | P5 |
| Order Tracking | `/portal/tracking` | **Sample** | P5 |
| Submit Inquiry | `/portal/cases/new?type=inquiry` | **Live, interim**: creates a case of type Inquiry (see §6) | P4 |
| Complaint / Feedback | `/portal/cases`, `/portal/cases/new`, `/portal/cases/:id` | **Live** | — |
| Notifications | `/notifications` | **Live** | — |

### Setup System Administrator (`/setup`)
| Menu item | Route | Live / Sample | Connects in |
|---|---|---|---|
| Setup Overview | `/setup` | **Live** | — |
| Case Categories | `/setup/categories` | **Live** | — |
| Response Templates | `/setup/templates` | **Live** | — |
| CRM Rules & SLA | `/setup/settings` | **Live** | — |
| Staff Accounts (mock HR) | `/setup/staff` | **Live** (mock HR) | — |
| Integration Health (new menu item) | `/setup/integration` | **Sample** (adapter modes are real) | P6 |
| Mail Log | `/setup/mail-log` | **Live** | — |
| Audit Log | `/setup/audit-logs` | **Live** | — |

### Pages outside the menus (all roles)
`/login`, `/register`, `/forgot-password`, `/reset-password/:token`, `/verify-email/:token`, `/profile` (staff account), `/notifications`: all **Live**.

## 4. All sample screens (generated from `services/samples/pages.js`)
Regenerate with `node tests/support/page-inventory.mjs`.

| Route | Page | Kind | Roles | Connects in |
|---|---|---|---|---|
| `/crm/sales` | Sales & Orders (Orders) | list | Manager, Team Leader, Agent | P5 |
| `/crm/sales/new` | New order | form (validates, not saved) | Manager, Team Leader, Agent | P5 |
| `/crm/sales/orders/:id` | Order | detail | Manager, Team Leader, Agent | P5 |
| `/crm/sales/payments` | Payments | list | Manager, Team Leader, Agent | P5 |
| `/crm/sales/refunds` | Refunds | list | Manager, Team Leader, Agent | P5 |
| `/crm/sales/refunds/:id` | Refund | detail | Manager, Team Leader, Agent | P5 |
| `/crm/campaigns` | Campaigns / Promotions | list | Manager | P5 |
| `/crm/campaigns/new` | New campaign | form | Manager | P5 |
| `/crm/campaigns/:id` | Campaign | detail | Manager | P5 |
| `/crm/promotions` | Promotions | list | Manager | P5 |
| `/crm/promotions/new` | New promotion | form | Manager | P5 |
| `/crm/loyalty` | Loyalty | list | Manager | P5 |
| `/crm/analytics` | Analytics (Overview) | dashboard | Manager | P9 |
| `/crm/analytics/sales` | Sales intelligence | dashboard | Manager | P9 |
| `/crm/analytics/customers` | Customers & retention | dashboard | Manager | P9 |
| `/crm/analytics/forecasts` | Forecasts (Estimate) | dashboard | Manager | P9 |
| `/crm/customers/new` | New customer | form | Manager, Team Leader, Agent | P3 |
| `/crm/interactions` | Interactions | list | Manager, Team Leader, Agent | P3 |
| `/crm/interactions/new` | Log interaction | form | Manager, Team Leader, Agent | P3 |
| `/crm/interactions/:id` | Interaction | detail | Manager, Team Leader, Agent | P3 |
| `/crm/inquiries` | Inquiries | list | Manager, Team Leader, Agent | P4 |
| `/crm/inquiries/:id` | Inquiry | detail | Manager, Team Leader, Agent | P4 |
| `/crm/follow-ups` | Follow-up tasks | list | Manager, Team Leader, Agent | P4 |
| `/crm/follow-ups/new` | New follow-up | form | Manager, Team Leader, Agent | P4 |
| `/crm/follow-ups/:id` | Follow-up | detail | Manager, Team Leader, Agent | P4 |
| `/crm/approvals` | Approvals Queue | list | Manager, Team Leader | P7 |
| `/crm/approvals/:id` | Request | detail | Manager, Team Leader | P7 |
| `/crm/settings/integration` | Integration Health | dashboard | Manager | P6 |
| `/setup/integration` | Integration Health | dashboard | Setup admin | P6 |
| `/portal/orders` | My Orders | list | Customer | P5 |
| `/portal/orders/:id` | Order | detail | Customer | P5 |
| `/portal/tracking` | Order Tracking | dashboard | Customer | P5 |
| `/portal/shop` | Shop (catalog with Add to cart) | dashboard | Customer | P5 |
| `/portal/cart` | Cart and checkout | dashboard | Customer | P5 |
| `/portal/preferences` | Contact Preferences | form | Customer | P3 |

Plus the sample widget groups on the four dashboards and the sample panel on the customer detail page.

## 5. Changes to existing (live) pages
- **Menus:** the 11 "Coming Soon" items became links (Manager 3, Team Leader 2, Agent 4, Customer 2). The setup menu gained "Integration Health". The sidebar markup for disabled items was removed.
- **Settings tabs:** Integration Health and Approvals Queue are now tabs that open.
- **Dashboards:** the grey "Coming Soon" panels were replaced by labelled sample widgets, placed full width below the live figures. The Manager's "Action queues" card now links to Approvals and Integration Health.
- **Customer Directory:** an "Add customer" button; the customer detail page has the sample purchase and interaction panel.
- **Info messages:** a blue "info" flash (used for "This action will be enabled in P<n>") was added next to the success and error flashes.
- **Phone layout:** several existing single-column grids could grow wider than a phone screen because of wide tables. They now use `grid-cols-1`; the screenshot run checks for horizontal overflow at 390 px and finds none.
- **No database change:** no migration was added and no table was touched.

## 6. Notes and open points for your review
1. **Submit Inquiry (customer) stays live and interim.** It creates a case of type Inquiry, as in P1. The Agent's **Inquiries** page is a sample of the P4 workflow (answer or convert to a case), so inquiries submitted today appear under Cases, not under Inquiries. The Inquiries page says so.
2. **Walk-in "New customer"** is a sample form: the `customers` table and creation code exist, but the duplicate check (TC-07) is P3, so the form does not save.
3. **Sample screens that do not match the current schema (to settle in the named phase; nothing was changed now):**
   - **P5, order statuses:** the sample uses delivery steps (Preparing, Out for delivery, Ready for pickup, Pending payment). `sales_orders.status` has `draft, submitted, pending_stock, confirmed, ready, completed, cancelled`. P5 must either map the steps or add delivery tracking, which would need a new column or table.
   - **P5, campaigns:** the sample shows Scheduled / Running / Completed and sent / opened / orders / revenue. `campaigns.status` has `draft, active, ended, cancelled` and the table has no counters or recipients. P5 needs a recipients/results table (for example `campaign_recipients`) or the metrics are dropped.
   - **P5, order channel and fulfilment:** the sample uses Customer portal / Phone / Walk-in and Pickup / Delivery; the schema also has `delivery` as a channel and `in_store` as a fulfilment. Align in P5.
   - **P8, team targets:** the Team Leader widget "Team target progress" needs a targets table that does not exist yet (for example `team_targets`).
   - **P6:** the Integration Health sample shows an outbox, inbox, dead letters and reconciliation. The `integration_outbox`, `integration_inbox` and `integration_logs` tables exist and fit it.
   - **P3, preferences:** `customer_preferences` exists (key/value) and fits the preferences form.
   - **P5, loyalty rules:** earning and redemption rules are not decided, so the sample shows balances only.
4. **Screens I could not build:** none. Every menu item and every page named in your list (inquiries, interactions/follow-ups, catalog, cart, orders, payments, refunds, promotions, campaigns, loyalty, approvals, Integration Health, analytics and forecasts) has a screen.
5. **Differences from your diagrams (please check):** the use cases "Create Order", "Record Payment", "Request / Approve Refund", "Manage Campaign / Promotion", "Log Interaction", "Create Follow-up", "Answer / Convert Inquiry", "View Analytics" and the customer's "Browse products / Cart / Track order" exist as screens now, but only as samples. The CRM Manager gets **Settings › Integration Health** and **Approvals Queue** as tabs, and the Team Leader reaches Approvals from the Team Overview card (no menu item added). Routes are new: `/crm/sales/*`, `/crm/campaigns/*`, `/crm/promotions/*`, `/crm/loyalty`, `/crm/analytics/*`, `/crm/interactions/*`, `/crm/inquiries/*`, `/crm/follow-ups/*`, `/crm/approvals/*`, `/portal/orders/*`, `/portal/tracking`, `/portal/shop`, `/portal/cart`, `/portal/preferences`, `/setup/integration`.

## 7. Tests
`npm test` runs three suites on separate throwaway databases: **P1 67/67, P2 64/64, UI pass 27/27**.

The UI-pass suite (`tests/ui.acceptance.mjs`) checks:
- **Menus:** all menu links open for every role (10, 7, 8, 6 and 8 links) and none is disabled; no page says "Coming Soon".
- **Sample pages:** all 35 sample screens open for every allowed role (67 role/page checks), carry the badge, have no stray text (`undefined`, `NaN`, `[object Object]`), scroll tables on phones, and return 403 to other roles.
- **Live pages:** the live pages are not marked as sample.
- **Dashboards:** the four dashboards show the sample widgets with the badge.
- **Record-level scope:** orders, follow-ups, refunds, approvals and the customer's own orders, and forged actions.
- **Forms and actions:** 7 form pages plus 13 inline actions, refused when invalid and answered with "enabled in P<n>" when valid; a form without a CSRF token is refused.
- **No writes:** the row counts of all 59 tables do not change during the pass.
- **Seed and settings:** the demo seed is still 7 accounts, and the Settings tabs and the real adapter modes work.

**Bugs the pass found and fixed:** a leftover `$1` in the sidebar template (caught by the menu test), bars drawn at 0% because a Handlebars helper named `pct` shadowed the field, a collapsed search box on phones, and the dashboard overflow on phones.

## 8. Screenshots
79 screenshots are in `docs/phase-reports/ui-screenshots/` (named `<role>-<page>.jpg`): every menu page for every role at 1366 px, extra detail and form pages, and 18 phone-width (390 px) pages. Regenerate with `node tests/support/screenshots.mjs` (needs Chrome or Edge and internet access, because Tailwind loads from its CDN).

## 9. Known issues
- Tailwind still loads from its CDN (unchanged), so offline demos are unstyled.
- The page shows a sample "Handled by" name from the real team agents (read-only lookup); with one demo agent the second name is a placeholder ("Sample Agent B").
- `route-cache.js` syntax error and the `url.parse()` deprecation warning are unchanged.
