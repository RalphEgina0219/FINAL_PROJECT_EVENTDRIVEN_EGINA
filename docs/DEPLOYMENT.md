# Deploying JOHNVIVZ CRM

For: the CRM team, after every scenario in [`MERGE-TEST-SCENARIOS.md`](MERGE-TEST-SCENARIOS.md) has passed with the real HR, Inventory and Accounting apps.

The demo you used so far (7 demo accounts, demo orders, mock adapters) is **not** what you deploy. A production CRM starts with an **empty** database, real HR employees, live adapters, and HTTPS.

---

## 1. The server (once)

* Node.js 18 or newer, MySQL 8, and a fixed address that the other apps can reach (a fixed IP on the LAN, or a host name).
* For HTTPS, put a reverse proxy in front (IIS with URL Rewrite, nginx or Caddy). The proxy holds the certificate and forwards to CRM on `http://127.0.0.1:3000`. Then CRM needs `TRUST_PROXY=true` and `COOKIE_SECURE=true`.
* Keep the app running after a restart: for example `npm install -g pm2`, then `pm2 start index.js --name johnvivz-crm` and `pm2 save`, or a Windows service (NSSM).
* Open only the HTTPS port to the network (443). Port 3000 and MySQL (3306) stay closed to everyone except the server itself.

## 2. The database

Create a **new** database and a **dedicated MySQL user**. Never use `root`, and never use `johnvivz_tech` (the old database; the server refuses it):
```sql
CREATE DATABASE johnvivz_crm_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'jvz_crm'@'localhost' IDENTIFIED BY '<a long random password>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, DROP, TRIGGER, LOCK TABLES, SHOW VIEW ON johnvivz_crm_db.* TO 'jvz_crm'@'localhost';
```
Then create the tables with the migrations (the only way the schema is ever changed; the app never runs `sync`):
```powershell
npm run migrate
npm run migrate:status      # every migration "up"
```

## 3. The production `.env`

Start from `.env.example`. These values differ from the demo:

```ini
NODE_ENV=production
PORT=3000
APP_URL=https://crm.johnvivz.example          # the address people type; used in emailed links

DB_HOST=localhost
DB_PORT=3306
DB_NAME=johnvivz_crm_db
DB_USER=jvz_crm
DB_PASSWORD=<the MySQL password from step 2>

SESSION_SECRET=<64 random characters: npm run secrets prints good ones>
COOKIE_SECURE=true                          # cookies only over HTTPS
TRUST_PROXY=true                            # behind IIS / nginx / Caddy
SHOW_DEMO_LOGINS=false                      # never list demo accounts on the login page

MAIL_TRANSPORT=smtp                         # log = emails are NOT delivered
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
MAIL_FROM="JOHNVIVZ CRM <no-reply@johnvivz.example>"

INTEGRATION_HR_MODE=live
INTEGRATION_INVENTORY_MODE=live
INTEGRATION_ACCOUNTING_MODE=live
HR_API_BASE_URL=https://hr.johnvivz.example
INVENTORY_API_BASE_URL=https://inventory.johnvivz.example
ACCOUNTING_API_BASE_URL=https://accounting.johnvivz.example
JVZ_SECRET_HR=...                 JVZ_CRM_INBOUND_SECRET_HR=...
JVZ_SECRET_INVENTORY=...          JVZ_CRM_INBOUND_SECRET_INVENTORY=...
JVZ_SECRET_ACCOUNTING=...         JVZ_CRM_INBOUND_SECRET_ACCOUNTING=...

APPROVALS_ENABLED=true            # only when ESS/HR sends employee requests (contract §5.1 agreed)
```

* **New secrets for production.** Do not reuse the ones from the merge session: run `npm run secrets -- --crm-url https://crm.johnvivz.example ...` again and give each team its block privately.
* The `.env` file stays on the server only: never in Git, never in a chat or a screenshot. Only the server's administrator account can read it.

**What the server checks when `NODE_ENV=production`** (it prints the reasons and exits with code 1 instead of starting):

| Refuses to start | Fix |
|---|---|
| `SESSION_SECRET` missing, the default `xianfire-secret-key`, or shorter than 32 characters | a random value from `npm run secrets` |
| `SHOW_DEMO_LOGINS` true | `SHOW_DEMO_LOGINS=false` (in production it is false unless you set it) |
| `DB_NAME=johnvivz_tech` | the CRM database |
| an adapter `live` without its base URL or secret | fill in both |

It starts but **warns** about `MAIL_TRANSPORT=log` (emails not delivered), `COOKIE_SECURE` false (plain HTTP), and any adapter still on `mock`.

## 4. No demo data, and the first logins

* **The demo seeder refuses to run in production:** `npm run seed` with `NODE_ENV=production` stops with "Refusing to run: NODE_ENV=production" and changes nothing. `seed:clear` and `seed:reset` are refused in the same way. The 7 demo accounts, demo customers, orders and DEMO requests never reach a production database.
* If you first tried the CRM on the same database **before** setting `NODE_ENV=production`, start again: drop the database, create it again and run the migrations (step 2). Do not try to clean it by hand. In development, `npm run seed:clear` removes demo rows. Reports exclude demo data by default and label it when it is included.
* **The first logins** are created from the command line, because the seeder does not run:
  ```powershell
  # 1. The setup administrator (outside the CRM hierarchy: settings, categories, Integration Health, emergency access)
  node scripts/create-first-accounts.mjs --setup-admin it.admin@johnvivz.example --name "IT Administrator"

  # 2. The CRM Manager: a real HR employee. --sync-hr first loads employees, departments and positions from HR (live)
  node scripts/create-first-accounts.mjs --sync-hr --manager <the Manager's HR employee ID>
  ```
  Each command prints a **one-time "set your password" link** (valid for the invitation time, 72 hours by default). No password is chosen or printed. Give each link to its owner in person. The script refuses when an active setup administrator or CRM Manager already exists, or when HR lists the employee as inactive or separated. Every creation is in the audit log.
* After that, everything happens in the app: the Manager creates teams and grants CRM access to Team Leaders and Agents (Settings → Teams & CRM Access). Customers register themselves in the portal.
* Check: open `APP_URL/login`; there is **no** "Demo accounts" list. Dashboards and reports show no "Demo" labels.

## 5. Backups

The CRM database holds customer data (names, contacts, addresses) and the audit log. Back it up **every day** and before every update.

```powershell
npm run db:backup                   # writes backups/johnvivz_crm_db-YYYYMMDD-HHMMSS.sql (mysqldump --single-transaction, triggers included)
```
* `backup-db` finds `mysqldump` on the PATH, in Laragon or in XAMPP. The password goes through an environment variable, never on the command line.
* Schedule it: Windows Task Scheduler → Create Basic Task → Daily → Start a program `npm`, arguments `run db:backup`, start in the CRM folder.
* Copy each backup **off the server** (an encrypted USB drive, or a private cloud folder only the administrators can open). Keep at least 14 daily and 6 monthly copies. Backups are as sensitive as the database: never email them.

## 6. Test the restore (every month)

A backup counts only once it has been restored. Test it:
```powershell
npm run db:restore-test -- backups/johnvivz_crm_db-20261114-020000.sql
```
`restore-test` loads the file into a **new throwaway database** (`<DB_NAME>_restore_test`). It compares the row count of every table with the live database, checks that the two audit-log triggers came back, prints the result and drops the throwaway database. **The live database is never touched.** Exit code 1 means a difference (rows written since the backup are reported; `--allow-changes` accepts them).

**A real restore after a failure** is a deliberate, manual step:
1. Stop the CRM (`pm2 stop johnvivz-crm`).
2. Run `npm run db:backup` once more, so the broken state is kept too.
3. `mysql -u root -p -e "DROP DATABASE johnvivz_crm_db; CREATE DATABASE johnvivz_crm_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"`
4. `mysql -u root -p johnvivz_crm_db < backups/<the file>.sql`
5. `npm run migrate:status`: everything up. Start CRM. On Integration Health, use **Send pending events**: the other apps ignore what they already have (duplicate protection by `event_id`).

## 7. Updating a running CRM

1. `npm run db:backup`.
2. Copy the new code, then `npm install --omit=dev`.
3. `npm run migrate`. Migrations only add or change what the new phase needs; a change to an existing table is always listed in that phase's report.
4. Restart (`pm2 restart johnvivz-crm`). Check the start-up output for warnings, then open Integration Health: all adapters live and no new dead letters.

## 8. Before you go live: checklist

- [ ] Every scenario in `MERGE-TEST-SCENARIOS.md` signed off by all four teams.
- [ ] `NODE_ENV=production`, new `SESSION_SECRET`, `SHOW_DEMO_LOGINS=false`, `COOKIE_SECURE=true`, `TRUST_PROXY=true` behind the proxy.
- [ ] HTTPS works; plain HTTP redirects to HTTPS.
- [ ] Dedicated MySQL user; MySQL and port 3000 closed to the network.
- [ ] `MAIL_TRANSPORT=smtp`; a password-reset email arrives.
- [ ] New production integration secrets, given privately to each team; `npm run check:connections` all OK.
- [ ] Empty database, no demo data; first setup administrator and CRM Manager created with `create-first-accounts`.
- [ ] Daily backup scheduled and copied off the server; `db:restore-test` passed once.
- [ ] The phase reports' "Mock only" / "Contract-tested" labels changed to "Verified live" only for what was really tested with the real apps.
