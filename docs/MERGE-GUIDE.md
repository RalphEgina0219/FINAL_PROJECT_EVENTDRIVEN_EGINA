# JOHNVIVZ merge guide: connecting CRM, HR, Inventory and Accounting

For: every JOHNVIVZ team (HR, Inventory, Accounting & Payroll, CRM), including people who have never connected two systems before.
Read it from top to bottom once, then follow the steps in order. Each step ends with a check, so you know it worked before you go on.

The rules for what is sent between the apps are in [`docs/integration-contract.md`](integration-contract.md) (the "contract"). This guide is the *how*; the contract is the *what*.

---

## 0. What you are connecting (in plain words)

```
                 signed HTTP calls and events (HMAC), no shared database
   ┌────────────┐  EmployeeCreated / StatusChanged ...   ┌────────────┐
   │ JOHNVIVZ HR │ ─────────────────────────────────────► │            │
   │   (+ ESS)   │ ◄── EmployeeRequestDecided ─────────── │            │
   └────────────┘                                         │            │
   ┌────────────┐  products, prices, stock, reserve/release│ JOHNVIVZ   │
   │ Inventory   │ ◄─────────────────────────────────────  │    CRM     │
   │             │ ── StockReserved / LowStock ... ──────► │            │
   └────────────┘  ◄── OrderConfirmed / SaleCompleted ...  │            │
   ┌────────────┐                                         │            │
   │ Accounting  │ ◄── SaleCompleted / RefundRecorded ...  │            │
   └────────────┘                                         └────────────┘
```

* **Nobody opens another team's database.** Every exchange is an HTTP call to `/api/integration/v1/...`.
* **Every call is signed** with a secret only the two apps know (HMAC, contract §2). A call with a wrong secret, or from a laptop whose clock is more than 5 minutes off, is refused.
* **Today (2026-11-16) HR and Inventory are not on the contract yet.** CRM speaks their current API instead: an API token instead of HMAC, an HR pull instead of HR events, and Inventory's own events and outbox. See **step 4A** and contract §12. Accounting (JVzPay) follows the contract.
* **Staff accounts come from HR, and staff sign in with their ESS password** (contract §12.5):
  1. HR onboards a CRM hire, and CRM creates a switched-off account for them.
  2. The person registers in ESS (JVzPay).
  3. Their first sign-in to CRM with the ESS password activates the account.
  4. Resigned or Terminated in HR removes access.

  Customers and the setup administrator keep their CRM password.
* **CRM starts in "mock" mode for every app**: it pretends the other apps exist and never sends anything. You switch **one** app at a time to "live" (step 6), test it, and only then do the next one.

---

## 1. Requirements on each laptop

| What | CRM laptop | Every other team's laptop |
|---|---|---|
| **Node.js** | 18 or newer (tested on 24). Check: `node -v` | whatever your app needs |
| **MySQL 8** | Laragon (recommended) or **XAMPP** (MySQL/MariaDB). Check: Laragon "Start All", or XAMPP Control Panel → MySQL **Start** | your own database; never shared |
| **A port for the app** | CRM uses **3000** (`PORT` in `.env`) | pick one and tell the others (for example HR 4000, Inventory 5000, Accounting 7000). **Avoid 6000, 6665–6669, 5060/5061 and 10080**: Node and browsers refuse to call them ("BLOCKED PORT") |
| **Clock** | Windows: Settings → Time & language → **Set time automatically: On**, time zone **(UTC+08:00) Manila** | the same |
| **Network** | for several laptops: all on the **same Wi-Fi** (or the same phone hotspot) | the same |

**XAMPP users:** start MySQL in the XAMPP Control Panel, then use `DB_HOST=localhost`, `DB_PORT=3306`, `DB_USER=root` and an empty `DB_PASSWORD` (XAMPP's default) in CRM's `.env`. Laragon users: the same values work.

## 2. Run each app on its own first

Before connecting anything, each team makes sure its own app works alone.

CRM team:
```powershell
npm install
copy .env.example .env          # then edit DB_* if needed
npm run migrate                 # creates johnvivz_crm_db (never touches johnvivz_tech)
npm run seed                    # 7 demo accounts, demo data (labelled)
npm start                       # http://localhost:3000
```
**Check:** open http://localhost:3000/login and sign in as `manager@johnvivz.test` / `Demo@1234`.

## 3. Choose your setup

### A. All four apps on ONE laptop
Give every app its own port. The base URLs are then `http://127.0.0.1:<port>`, for example:
`HR_API_BASE_URL=http://127.0.0.1:4000`, `INVENTORY_API_BASE_URL=http://127.0.0.1:5000`, `ACCOUNTING_API_BASE_URL=http://127.0.0.1:7000`, and CRM is `http://127.0.0.1:3000`.
No firewall changes are needed.

### B. Several laptops on the same Wi-Fi
1. **Find each laptop's IP address.** On each laptop, open PowerShell and run `ipconfig`. Look under **Wireless LAN adapter Wi-Fi** for **IPv4 Address**, for example `192.168.1.10`. Write it down with the app's port: the CRM base URL is then `http://192.168.1.10:3000`.
2. **Make the Wi-Fi network "Private"** on every laptop: Settings → Network & internet → Wi-Fi → (your network) → Network profile type: **Private**.
3. **Open the app's port in the Windows firewall.** On each laptop, open **PowerShell as Administrator** and run it once for that laptop's port:
   ```powershell
   New-NetFirewallRule -DisplayName "JOHNVIVZ CRM 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
   ```
   (HR laptop: change the name and `3000` to HR's port, and so on.) To remove it after the merge: `Remove-NetFirewallRule -DisplayName "JOHNVIVZ CRM 3000"`.
4. **The app must listen on all addresses**, not only `localhost`. CRM already does. If your framework has a "host" setting, set it to `0.0.0.0`.
5. **Check from another laptop:** `Test-NetConnection 192.168.1.10 -Port 3000` must say `TcpTestSucceeded : True`. You can also open `http://192.168.1.10:3000/login` in that laptop's browser.

> School or café Wi-Fi often blocks laptops from talking to each other ("client isolation"). If the check fails even with the firewall open, use a **phone hotspot** that every laptop joins.
> An IP address can change when a laptop reconnects. Check with `ipconfig` at the start of every session and update the base URLs.

## 4. Exchange the values (once per merge)

Each pair "CRM ↔ app" needs a **base URL in each direction** and **two secrets**, one per direction:

| Value | Who creates it | Where it goes |
|---|---|---|
| CRM's base URL (`http://<CRM IP>:3000`) | CRM team | in HR's, Inventory's and Accounting's configuration |
| Each app's base URL | that app's team | CRM's `.env`: `HR_API_BASE_URL`, `INVENTORY_API_BASE_URL`, `ACCOUNTING_API_BASE_URL` |
| Secret **CRM → app** (CRM signs, the app checks) | `generate-secrets` | CRM: `JVZ_SECRET_<APP>`; the app: "secret from CRM" |
| Secret **app → CRM** (the app signs, CRM checks) | `generate-secrets` | CRM: `JVZ_CRM_INBOUND_SECRET_<APP>`; the app: "secret to CRM" |

**Generate the secrets safely (the CRM team, once)** with `scripts/generate-secrets.mjs`:
```powershell
npm run secrets -- --crm-url http://192.168.1.10:3000 --hr-url http://192.168.1.11:4000 --inventory-url http://192.168.1.12:5000 --accounting-url http://192.168.1.13:7000
```
It prints one block per team, with 64-character random secrets from the computer's secure random generator. Add `--write` to save one file per team in `merge-kit-secrets/`; that folder is added to `.gitignore`.
* Give each team **only its own block**, privately: in person, or a direct message to that team only.
* **Never** put a secret in Git, a group chat, a screenshot, a document or a slide. If one leaks, run the command again and replace all of them.
* Each team copies its two secrets and CRM's base URL into its own configuration. CRM pastes the CRM block into its `.env` and restarts.

## 4A. Today's setup: the teammates' apps as they are (interim dialects)

Use this instead of step 4 for HR and Inventory until they support the contract. Accounting still uses step 4, but only for its own two secrets. The full rules are in contract §12.

**HR (JohnVivzHR, port 3001): API key, CRM pulls.**
1. The HR team makes a key for CRM on the HR laptop: `npm run integration:key -- create crm "CRM"`. They give the key to the CRM team **privately**.
2. In CRM's `.env`:
   ```
   INTEGRATION_HR_MODE=live
   INTEGRATION_HR_AUTH=bearer
   INTEGRATION_HR_SYNC=pull
   HR_API_BASE_URL=http://<HR IP>:3001
   HR_API_TOKEN=<the key>
   CRM_DEPARTMENT_CODE=<HR's department code for CRM, e.g. CRM>
   ```
3. Restart CRM. Within a minute CRM reads `/employees` and `/departments` (then every 5 minutes). The Manager can press **Settings → Integration Health → Sync now** at any time.
4. **Check:**
   * The Sync now message says how many employees were read, created, updated or changed status. Onboarding and Rejected people are not imported.
   * Each new CRM-department hire appears under **Settings → Teams & CRM Access** as "Waiting for ESS registration". There the Manager sets the team, and can change the role that the position rules gave.

**Inventory (the Inventory app, port 3000 on its own laptop): token, its own events, polled outbox.**
1. The Inventory team gives the CRM team the value of `INVENTORY_INTEGRATION_TOKEN` from the Inventory `.env`, **privately**.
2. In CRM's `.env`:
   ```
   INTEGRATION_INVENTORY_MODE=live
   INTEGRATION_INVENTORY_AUTH=bearer
   INTEGRATION_INVENTORY_DIALECT=johnvivz_inventory
   INVENTORY_API_BASE_URL=http://<Inventory IP>:3000
   INVENTORY_API_TOKEN=<the token>
   ```
   CRM and Inventory both use port 3000. On **one** laptop, give CRM another port (`PORT=3003` in CRM's `.env`).
3. Restart CRM, then go to **Sales & Orders → Refresh product snapshot**. This loads Inventory's products and reads its outbox. The outbox is also read every minute.
4. **Checkout reserves with Inventory's `order.confirmed`.**
   * An order is created only after Inventory answers "reserved".
   * Short stock is shown by product name.
   * Inventory's reservations never expire, so cancel orders you will not complete. Integration Health lists orders that have held stock for more than 24 hours.

**Accounting and ESS (JVzPay, port 3002): the contract (HMAC).**
1. Exchange the two secrets as in step 4. JVzPay's `CRM_INBOUND_SECRET` is CRM's `JVZ_SECRET_ACCOUNTING`.
2. In CRM's `.env`:
   ```
   INTEGRATION_ACCOUNTING_MODE=live
   INTEGRATION_ACCOUNTING_AUTH=hmac
   ACCOUNTING_API_BASE_URL=http://<Accounting IP>:3002/api/integration/v1
   INTEGRATION_ESS_LOGIN=live
   ```
   CRM accepts the base URL with or without `/api/integration/v1`.
3. With `INTEGRATION_ESS_LOGIN=live`, **every staff sign-in** goes to JVzPay's `POST /auth/login`, demo staff included. Customers and the setup administrator are unaffected.
   * Before switching it on, make sure the staff who will test are registered in ESS.
   * If JVzPay is down, staff see "ESS is unavailable, try again later." There is no local fallback.
4. **Leave, overtime and attendance correction** are filed in ESS. The first approval is given by the Team Leader and the final approval by Accounting/Payroll, both in ESS. Keep `APPROVALS_ENABLED=false` in CRM.

**Without JVzPay** (`INTEGRATION_ESS_LOGIN=mock`, the default): the setup administrator can register a hire in the **mock ESS** under **Setup → Staff → Mock ESS registration**. This lets you show the whole account flow on one laptop.

**Tokens are secrets too.** Never put one in Git, a group chat or a screenshot. CRM never prints or logs them.

## 5. Check the connections

On the CRM laptop, with CRM running, run `scripts/check-connections.mjs`:
```powershell
npm run check:connections -- --crm http://192.168.1.10:3000
```
It checks each app **the way CRM is set to talk to it** (the first lines for each app say which: `connects with: …`). For each app, in this order:

1. Can CRM reach the app? (`/health`, or `/ping` for JohnVivzHR, or one product for the Inventory app)
2. Do the clocks agree? (HMAC only. API tokens do not depend on the clock.)
3. Does the app accept CRM's signature (signed `GET /health`) or CRM's API token?
4. HMAC: does a signed `POST` with a body arrive unchanged (`/test/echo`)?
   HR pull: do `/employees` and `/departments` answer in JohnVivzHR's format?
   Inventory dialect: do `/products` and `/crm/outbox` answer? (This is read only. Nothing is acknowledged.)
   ESS login (`INTEGRATION_ESS_LOGIN=live`): does JVzPay's `POST /auth/login` refuse a made-up account with `401`?
5. Does CRM accept the app's signature or token?

Each line is **OK** or **FAILED** with the reason:

| It says | What to do |
|---|---|
| `NOT RUNNING` | start the app; check the port in the base URL |
| `BLOCKED PORT` | the app uses a port Node refuses to call (such as 6000); move it to another port |
| `WRONG URL` | the IP or host name in the base URL is wrong; run `ipconfig` again |
| `NO ANSWER` | firewall (step 3B.3), Network profile not Private, different Wi-Fi, or client isolation (use a hotspot) |
| `CLOCK DIFFERENCE` | set **both** laptops to automatic time and the Manila time zone |
| `BAD SIGNATURE` | the two sides do not hold the same secret for that direction, or the app signs a different path or body than contract §2 says |
| `BAD TOKEN` | the API token in CRM's `.env` (`HR_API_TOKEN`, `INVENTORY_API_TOKEN`) is not the one the app expects, or HR revoked the key; copy it again |
| `no HR_API_TOKEN …` | `INTEGRATION_HR_AUTH=bearer` but the token is empty in CRM's `.env` |
| `ENDPOINT MISSING (404)` | the app does not offer that endpoint yet (contract §6), or the base URL contains an extra path |
| `CRM has this app in mock or disabled mode` | set `INTEGRATION_<APP>_MODE=live` in CRM's `.env` and restart CRM (step 6) |

Fix the first FAILED line first: an early failure causes the later ones. `--only hr` checks one app.

## 6. Switch ONE adapter from mock to live (and back)

Recommended order: **HR → Inventory → Accounting**, one at a time, with its scenario from `MERGE-TEST-SCENARIOS.md` in between.

**To switch HR on:**
1. In CRM's `.env`: `INTEGRATION_HR_MODE=live` (and the HR base URL and secrets from step 4). Leave the other two on `mock`.
2. Restart CRM (`Ctrl+C`, then `npm start`).
3. Run `npm run check:connections -- --only hr`: everything OK.
4. In CRM, sign in as the Manager → **Settings → Integration Health** → **Test connection** next to JOHNVIVZ HR: "answered 200".
5. Run scenario 1 of the test scenarios.

**Inventory:** `INTEGRATION_INVENTORY_MODE=live`, then **Sales & Orders → Refresh product snapshot** to load the real products. **Accounting:** `INTEGRATION_ACCOUNTING_MODE=live`.

**Today's apps:** use the `.env` lines in step 4A for HR and Inventory (auth, sync and dialect). With HR in pull mode, step 4 of the HR check is **Sync now** instead of waiting for an event. Switch `INTEGRATION_ESS_LOGIN=live` last, after the testers are registered in ESS.

**To switch back to mock** (if something is wrong and you need the demo again): set the mode back to `mock` and restart CRM. Events that were waiting stay in the outbox; nothing is sent while the app is mock, and they go out when you switch to live again. Mock and live data stay apart: mock rows are flagged `is_mock` and shown as "Mock".

What changes in live mode:
* CRM sends real signed calls to that app and accepts its events. Events from an app that is still mock are refused (`503`).
* Failed sends are retried after 1 min, 5 min, 15 min, 1 h and 6 h. After that they are a **dead letter**, which you can retry on Integration Health.
* **Employee requests** (leave, attendance, overtime) are handled in ESS for now. Keep `APPROVALS_ENABLED=false`.

## 7. Practise before the real merge: fake teammates

If another team is not ready yet, run **fake** versions of the apps with `scripts/fake-teammates.mjs`. They are what CRM's own tests use. They are not the real apps.

**Each fake imitates the app the way CRM's `.env` is set:**
* **HR:** JohnVivzHR's pull API (API key, `/ping`) when `INTEGRATION_HR_AUTH=bearer` and `INTEGRATION_HR_SYNC=pull`.
* **Inventory:** the Inventory app's own events and outbox when `INTEGRATION_INVENTORY_DIALECT=johnvivz_inventory`.
* **Accounting:** always JVzPay as the contract describes it, including the ESS login `POST /auth/login`.
* In every other case, the fake follows the contract.

`--current` forces today's styles and `--contract` forces the contract.
```powershell
npm run fake:teammates                       # fake HR :4101, Inventory :4102, Accounting :4103 on this laptop
npm run fake:teammates -- --host 0.0.0.0     # reachable from other laptops (open the ports in the firewall)
```
It prints the base URLs to put in CRM's `.env`. Type commands into it:
* `send hr EmployeeStatusChanged employee_id=MOCK-EMP-1003 employment_status=inactive` sends a signed event to CRM, as HR would (contract-style HR only).
* `hr status JV-2026-00002 Resigned` changes an employee in the fake JohnVivzHR. CRM sees it at its next pull or on **Sync now**.
* `inv emit LowStockDetected productId=INV-1002 availableQty=3` puts an event in the fake Inventory outbox.
* `ess register rico.dimaano@hr.example.test Secret#123 JV-2026-00002 CRM` registers a new hire in the fake ESS.
* `events` shows what CRM sent.
* `stock` shows the fake stock.
* `quit` stops it.

**Teammates can use it too.** For example, the HR team can run CRM plus fake Inventory and Accounting while it connects its real HR. The fake servers also show what a correct answer looks like (`tests/support/fakeApps.mjs`), and they reject any event CRM sends that does not follow the contract (`400`).

## 8. Checklist per team

Tick each line before the merge test. The section numbers are in `integration-contract.md`.

### Today's interim checklists (contract §12)
* **HR (JohnVivzHR):**
  - [ ] An API key for CRM was made and given privately.
  - [ ] `/employees` and `/departments` answer with it.
  - [ ] Each employee has `department.department_code`.
  - [ ] The CRM department code is agreed (default `CRM`).
  - [ ] `/health` is added (CRM falls back to `/ping`).
* **Inventory:**
  - [ ] The token was given privately.
  - [ ] `/products` and `/crm/outbox` answer.
  - [x] Questions **I-1** and **I-2** are answered (2026-11-16): `order.confirmed` answers 202 / 200 duplicate / 409, and reservations never expire. Contract §12.2.
* **Accounting / ESS (JVzPay):**
  - [ ] HMAC both ways works.
  - [ ] `POST /auth/login` answers `200` with `department_code`, `401 invalid_credentials` or `403 not_allowed`.
  - [ ] The testers are registered in ESS.
  - [ ] Questions A-3 to A-5 are answered.

### HR team checklist (contract target)
- [ ] Base URL given to CRM; port open in the firewall; clock automatic.
- [ ] Checks the CRM → HR signature (§2): `X-JVZ-Client`, `X-JVZ-Timestamp` (5 minutes), `X-JVZ-Signature` over `METHOD\npath(+query)\ntimestamp\nsha256(body)`.
- [ ] `GET /api/integration/v1/health` (signed) answers 200; `POST /api/integration/v1/test/echo` answers the body's SHA-256 (§6).
- [ ] `GET /api/integration/v1/employees/{id}`, and for the first load `GET /employees?page=`, `/departments?page=`, `/positions?page=` (§6, proposed).
- [ ] Sends signed events to `POST {CRM}/api/integration/v1/events` (§5): `EmployeeCreated`, `EmployeeUpdated`, `EmployeeStatusChanged`, `DepartmentCreated/Updated/Deactivated`, `PositionCreated/Updated/Deactivated`. Every event has a unique `event_id`, `source: "johnvivz_hr"`, `schema_version: 1`, and a time with an offset.
- [ ] Never sends salary, bank, government ID or payroll fields (CRM removes them anyway).
- [ ] ESS (only with `APPROVALS_ENABLED=true` in CRM): sends `EmployeeRequestSubmitted` (§5.1) and accepts `EmployeeRequestDecided` (§4) with `approved`, `rejected` or `returned`; a changed request sends `replaces_request_id`.
- [ ] Answers CRM's events with `202`, or `200 {"status":"duplicate"}` for an `event_id` it already has.

### Inventory team checklist
- [ ] Base URL given to CRM; port open; clock automatic.
- [ ] Checks CRM's signature (§2); `/health` and `/test/echo` work (§6).
- [ ] `GET /products?query=&category=&page=` (with `available_qty`), `GET /products/{id}`, `/products/{id}/availability`, `/products/{id}/price` (§6). Money as decimal strings.
- [ ] `POST /reservations` **idempotent on `order_id`**: `201` the first time, `200` with the same `reservation_id` after that, `409` when stock is not enough. `DELETE /reservations/{reservation_id}`: `200`, or `404` if already released.
- [ ] Accepts `OrderConfirmed`, `SaleCompleted` (consume the reservation), `SaleCancelled` (release) and `RefundRecorded` (returned items) at `POST /api/integration/v1/events` (§4), with duplicate protection by `event_id`.
- [ ] Sends `StockReserved`, `StockIssued`, `LowStockDetected`, `ProductCreated/Updated/PriceUpdated`, `StockUpdated`, `StockUnavailable` to CRM (§5), with `source: "johnvivz_inventory"`.

### Accounting team checklist
- [ ] Base URL given to CRM; port open; clock automatic.
- [ ] Checks CRM's signature (§2); `/health` and `/test/echo` work.
- [ ] Accepts `SaleCompleted`, `SaleCancelled` and `RefundRecorded` at `POST /api/integration/v1/events` (§4): money as decimal strings, VAT computed by Accounting, duplicate protection by `event_id` (`200 {"status":"duplicate"}`).
- [ ] Optional: reads `GET {CRM}/api/integration/v1/sales/{sale_id}`, `/customers/{id}` and `/reconciliation/sales?from=&to=` (§7), signed with its own secret.
- [ ] Answers open question 8 (a "sale posted" event or endpoint), so the reconciliation can show real postings.

### CRM team checklist
- [ ] `.env`: the three base URLs, six secrets, `JVZ_MAX_CLOCK_SKEW_SECONDS=300`; modes still `mock`.
- [ ] `npm run check:connections` all OK for the app being switched on.
- [ ] Integration Health open on a second screen during the tests (outbox, inbox, dead letters, recent calls).
- [ ] `npm run db:backup` before the first live test; `npm run db:restore-test <file>` proves the backup works.

## 9. Common mistakes
* **"It works on my laptop but not from yours."** Firewall, a Public network profile, client isolation, or a changed IP (step 3B).
* **Everything is `BAD SIGNATURE`.** The secrets were swapped (CRM → app vs. app → CRM), or a team copied a secret with a space or a missing character. Run `generate-secrets` again and paste carefully.
* **Signed only the path, not the query string.** The contract signs path **plus** query string.
* **The body changed between signing and sending** (pretty-printed again, or different key order). Sign the exact bytes you send.
* **Time zone.** A laptop on UTC or without automatic time gets `CLOCK DIFFERENCE`.
* **Sharing a database.** Not allowed: each app keeps its own; data goes through the API only.
