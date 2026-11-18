# JOHNVIVZ CRM — Customer Relationship Management

JOHNVIVZ CRM is one of the four JOHNVIVZ applications: HR, Accounting & Payroll, CRM and Inventory. It is built on the XianFire Framework (Express, `.xian` Handlebars views, Sequelize with MySQL) and uses its own database, **`johnvivz_crm_db`**.

It talks to the other applications only through REST APIs and events; see [docs/integration-contract.md](docs/integration-contract.md).

Developer: Ralph Kenneth Egina, BSIT 3-F1.

**Sources, in order of authority:**
1. [docs/johnvivz-blueprint.pdf](docs/johnvivz-blueprint.pdf)
2. [docs/crm-master-prompt.md](docs/crm-master-prompt.md)
3. The earlier specifications

The plan, conflicts and decisions are in [docs/crm-alignment-report.md](docs/crm-alignment-report.md). Phase reports are in [docs/phase-reports/](docs/phase-reports/).

## 1. Setup (Laragon)
```
npm install
copy .env.example .env      # then set SESSION_SECRET; DB defaults match Laragon
npm run migrate             # creates johnvivz_crm_db (if missing) and applies migrations 101–120
npm run seed                # 7 demo logins + MOCK HR fixture (every row is_demo = 1)
npm start                   # http://localhost:3000
```
XAMPP works too (start MySQL in the XAMPP Control Panel; `DB_USER=root`, empty `DB_PASSWORD`).

**Merging with HR, Inventory and Accounting:** follow [docs/MERGE-GUIDE.md](docs/MERGE-GUIDE.md), then run [docs/MERGE-TEST-SCENARIOS.md](docs/MERGE-TEST-SCENARIOS.md) together. **Deploying:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

| Command | What it does |
|---|---|
| `npm run migrate:status` | List applied and pending migrations |
| `npm run migrate:rollback` | Undo the last batch |
| `npm run seed:clear` | Remove demo rows only (`is_demo = 1`, the demo team and unused mock HR references) |
| `npm run seed:reset` | `seed:clear`, then seed again. Every seed command refuses to run when `NODE_ENV=production` |
| `npm test` | All 12 acceptance suites (P1 to P10, the UI pass and the status check), each on its own throwaway `_test` database. P6, P7 and P10 run against local fake HR / Inventory / Accounting servers. |
| `npm run test:p1` … `test:p10` / `test:ui` / `test:status` | One suite only |
| `node tests/support/screenshots.mjs` | Screenshots of every menu page at desktop and phone width (needs Chrome or Edge) |
| `npm run secrets` | Merge kit: prints the `.env` lines for every team (6 random secrets, one per direction per app pair); `--write` saves one file per team in the git-ignored `merge-kit-secrets/` |
| `npm run check:connections` | Merge kit: checks every connection in both directions and says OK or FAILED with the reason (not running, wrong URL, blocked port, no answer, clock difference, bad signature, endpoint missing, mock mode) |
| `npm run fake:teammates` | Merge kit: fake HR, Inventory and Accounting servers that follow the contract, with a small command prompt (`send`, `events`, `stock`) |
| `npm run db:backup` / `npm run db:restore-test -- <file>` | mysqldump backup into `backups/`; restore test into a throwaway database (the live database is never touched) |
| `npm run first-accounts -- --setup-admin <email> --manager <HR ID>` | Production only: the first setup administrator and CRM Manager, with one-time set-your-password links (the seeder refuses to run in production) |
| `npm run docs:er` | Regenerates the ER diagram ([docs/ER-DIAGRAM.md](docs/ER-DIAGRAM.md)) from the database |

**Database rules:**
- The schema is created only by migrations. The app never calls `sequelize.sync()`.
- `migrations/legacy_johnvivz_tech/` holds the retired JOHNVIVZ TECH migrations. The runner refuses to touch that old database, which is kept as a fallback.

## 2. Demo accounts (password `Demo@1234`)
`npm run seed` creates exactly **one demo account per role** (three customers). These 7 are the only accounts the login page lists:

| Account | Role | Home page |
|---|---|---|
| `admin@johnvivz.test` | System Administrator, setup only (no customer data; every action audited) | `/setup` |
| `manager@johnvivz.test` | CRM Manager | `/crm/manager` |
| `maria.santos@johnvivz.test` | Team Leader, Customer Care Team | `/crm/team-leader` |
| `kristine.bautista@johnvivz.test` | Agent, Customer Care Team | `/crm/agent` |
| `juan.cruz@johnvivz.test` | Customer | `/portal` |
| `ana.delarosa@johnvivz.test` | Customer | `/portal` |
| `liza.fernandez@johnvivz.test` | Customer | `/portal` |

**Also in the demo seed (not accounts):**
- 2 walk-in customer records without a login. They never appear on the login page.
- 40 demo cases spread over the 3 customers and the 1 agent. They cover all 7 statuses, both escalation levels, ratings and one reopened case.

**Staff come from a clearly labelled MOCK HR fixture** (`services/integration/fixtures/mockHr.js`, `is_mock = 1`): only the manager, the team leader and the agent. This stays until JOHNVIVZ HR is connected (`INTEGRATION_HR_MODE=live`, phase P6).

The automated tests do not rely on the demo seed for extra people. They create a second team, a second agent and a separated HR employee in their own throwaway database (`tests/support/p1Fixtures.mjs`).

## 3. Roles and access
- **CRM Manager:**
  - sees all of CRM;
  - assigns cases to any agent and handles level-2 escalations;
  - manages Settings: rules and SLA, categories, templates, audit log, and the read-only roles & permissions matrix;
  - runs reports and exports.
- **Team Leader:**
  - sees the own team's cases and the Customer Queue of new cases;
  - assigns cases to agents of the own team;
  - handles level-1 escalations and escalates to the Manager;
  - runs team reports.
- **Agent:**
  - works on assigned cases (reply, status, priority, category, internal notes);
  - escalates to the Team Leader;
  - sees own customers.
- **Customer:**
  - manages own profile;
  - submits complaints and inquiries;
  - replies, confirms or reopens a case, and rates the service.
- **System Administrator:** setup only (see `/setup`).

**Identity (P2):**
- The CRM Manager grants CRM access to HR employees under Settings › Teams & CRM Access. The person receives a one-time link and sets their own password.
- Customers confirm their email before the first sign-in. Password reset works by email for every role.
- Email: `MAIL_TRANSPORT=log` (default) sends nothing; the setup administrator reads the messages under Setup › Mail Log. Set `MAIL_TRANSPORT=smtp` and the `SMTP_*` values in `.env` to send real email.

The full matrix is in the `roles` / `permissions` / `role_permissions` tables, shown under Manager › Settings › Roles & Permissions.

**Further rules:**
- Record scope is enforced in every query, so a hidden button is never the only protection.
- Denied attempts are written to the append-only `crm_audit_logs`.
- A staff member whose HR status becomes *inactive* or *separated* loses access on their next request.

## 4. Case lifecycle
- **Main flow:** Open → Assigned → In Progress ⇄ Waiting for Customer → Resolved → Closed.
- **"Update status" dropdown (case page):** lists only the valid next statuses for the case and role, after a disabled "Current: …" option.
  - Agent: Assigned → In Progress / Waiting for Customer / Escalated; In Progress → Waiting for Customer / Resolved / Escalated; Waiting for Customer → In Progress / Escalated.
  - Escalated shows no dropdown for the agent (internal notes only); Resolved and Closed show no dropdown for the agent (the customer, a Team Leader or the Manager reopen).
  - Team Leader / Manager: the same plus Close and Reopen, and on an Escalated case the "Handle escalation" panel is the only place for take over, return to agent and resolve (the dropdown points to it). "Escalated" appears only where the Escalate button does and uses the same service.
  - Escalated needs a reason and Resolved needs a resolution note (5+ characters), which is posted to the customer as a public "Resolution: …" comment. The server checks every change again; refused jumps are audited as `case_status_rejected`. There is no "Unsolved" status: use Waiting for Customer (needs info) or Escalated (needs a supervisor).
- **Escalation:** Escalated, from Agent → Team Leader (level 1) → CRM Manager (level 2), each step with a reason.
- **Reopen:** an action within 7 days that sends the case back to In Progress.
- **Auto-close:** a Resolved case closes after 3 days with no customer reply.
- **SLA targets:** stored per priority in `service_targets`; overdue alerts are sent once per case.
- **Numbering:** `JVT-YYYYMMDD-0001` for cases, `CUS-000001` for customers.

## 5. Built so far and coming next
| Phase | Status |
|---|---|
| P0 Alignment | ✅ approved |
| P1 Foundation (new DB, migrations, seeders, roles, scopes, case flow and escalation, portal, audit, adapter framework) | ✅ see [docs/phase-reports/P1.md](docs/phase-reports/P1.md) |
| P2 Identity (Teams & CRM Access, email verification, password reset) | ✅ see [docs/phase-reports/P2.md](docs/phase-reports/P2.md) |
| UI completion pass (every menu page for every role; Live or labelled Sample) | ✅ see [docs/phase-reports/UI-pass.md](docs/phase-reports/UI-pass.md) |
| P3 Customer master (walk-in creation with duplicate check, contacts, addresses, preferences and consent, interactions timeline, agent assignment) | ✅ see [docs/phase-reports/P3.md](docs/phase-reports/P3.md) |
| P4 Customer service (inquiries: answer / convert to case; follow-up tasks with reminders; staff-created cases for phone and walk-in customers) | ✅ see [docs/phase-reports/P4.md](docs/phase-reports/P4.md) |
| P5 Sales (mock Inventory adapter, checkout with price/stock re-check, reservation, payments with a second-person check, sales, refunds, promotions, campaigns, customer shop/cart/tracking) | ✅ see [docs/phase-reports/P5.md](docs/phase-reports/P5.md) |
| P6 Integration (signed inbound API with replay guard, inbox, outbox dispatcher with retries and dead letters, live HR / Inventory / Accounting adapters that stay **off (mock) by default**, reserve-first checkout, Integration Health, sales reconciliation) | ✅ **Contract-tested only** against local fake servers; not verified with the real apps. See [docs/phase-reports/P6.md](docs/phase-reports/P6.md) and [docs/integration-contract.md](docs/integration-contract.md) |
| P7 ESS approvals (Approvals Queue behind `APPROVALS_ENABLED=false`, requests through the P6 inbox from a **mock ESS**, routing with an exception queue, nobody approves their own request, decisions sent back to HR through the outbox, mock only) | ✅ **Draft, mock source only**: the HR/ESS team has not confirmed the request format. See [docs/phase-reports/P7.md](docs/phase-reports/P7.md) |
| P8 My Requests (read-only copy of own ESS requests), loyalty (1 point per ₱100, 100 points = ₱10, reversed on refund), campaign results from real orders, team targets from `service_targets` | ✅ see [docs/phase-reports/P8.md](docs/phase-reports/P8.md) |
| P9 Dashboards and analytics for every role from real data; statistical forecasts labelled **Estimate** (method, input period, horizon and error stored); rule-based segments; demo data excluded or labelled | ✅ see [docs/phase-reports/P9.md](docs/phase-reports/P9.md) |
| P10 Final testing and merge kit (sample pages removed, phone layout for every table, merge guide and test scenarios, secrets / connection check / fake-teammate scripts, production start-up checks, first-accounts script, backup and restore test, deployment guide, ER diagram, all diagram differences) | ✅ see [docs/phase-reports/P10.md](docs/phase-reports/P10.md) and [docs/phase-reports/DIAGRAM-DIFFERENCES.md](docs/phase-reports/DIAGRAM-DIFFERENCES.md) |

Every menu item opens a live page; the sample pages of the UI pass are gone. Integration with the real HR, Inventory and Accounting apps is **contract-tested or mock only** until the merge scenarios pass with the real apps.

## 6. Project layout
| Folder | Contents |
|---|---|
| `config/` | `.env` loading and defaults |
| `migrations/` | `1xx_*.js` CRM schema (plain MySQL DDL) |
| `models/` | Sequelize models for the tables used by the current screens |
| `services/` | Business rules: `caseService`, `customerService`, `auditService`, `permissionService`, ... |
| `services/integration/` | Adapters (disabled / mock / live), HMAC signing, outbox dispatcher, inbox, compensations, reconciliation, and the mock HR / Inventory fixtures |
| `routes/integrationApi.js` | The signed machine-to-machine API under `/api/integration/v1` (mounted before the session and CSRF middleware) |
| `tests/support/fakeApps.mjs` | Local fake HR, Inventory and Accounting servers written from the contract (used by the tests and `npm run fake:teammates`) |
| `scripts/` | Merge kit and operations: generate-secrets, check-connections, fake-teammates, backup-db, restore-test, create-first-accounts, er-diagram |
| `controllers/`, `routes/`, `middleware/` | Request handling and access checks |
| `views/` | `.xian` templates |
| `seeders/` | Demo data |
| `tests/` | Automated acceptance tests |
| `docs/` | Blueprint, master prompt, alignment report, integration contract, SQL, phase reports |
