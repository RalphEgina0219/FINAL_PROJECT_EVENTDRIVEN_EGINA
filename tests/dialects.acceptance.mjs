/*
 * JOHNVIVZ CRM — interim dialects acceptance tests (docs/integration-contract.md §12, docs/phase-reports/INTERIM-DIALECTS.md).
 *   npm run test:dialects        (npm test runs it last)
 * Throwaway database johnvivz_crm_dialects_test. CRM runs LIVE against local fakes of the teammates' apps AS THEY ARE TODAY:
 *   HR          fake JohnVivzHR (tests/support/fakeDialects.mjs): pull-only API, API key (Bearer), GET /ping, no events
 *   Inventory   fake Inventory app (fakeDialects.mjs): Bearer token, its own event names, polled outbox
 *   Accounting  the contract fake (tests/support/fakeApps.mjs): HMAC both ways, base URL given WITH /api/integration/v1 (as JVzPay's guide says),
 *               and its ESS department login POST /auth/login: every STAFF sign-in goes there (INTEGRATION_ESS_LOGIN=live)
 * Employee account flow: HR pull -> deactivated staff account (no password) -> ESS registration -> first sign-in activates -> HR removes.
 * A second server on the same database runs everything in MOCK mode, only to place orders (in the Inventory dialect checkout is refused).
 * A pass means "contract-tested against the interim dialect", never "verified live": no real teammate app is involved.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { check, startEnvironment, summarize, Client, root } from "./support/harness.mjs";
import { startFakeApps } from "./support/fakeApps.mjs";
import { startFakeHrPull, startFakeInventoryDialect } from "./support/fakeDialects.mjs";

const DB = process.env.TEST_DIALECTS_DB_NAME || "johnvivz_crm_dialects_test";
const PORT = Number(process.env.TEST_DIALECTS_PORT || 3211);
const PORT_M = PORT + 1; // mock server on the same database (places orders)
const uuid = () => crypto.randomUUID();
const secret = () => crypto.randomBytes(16).toString("hex");
const hrToken = `hrkey_${secret()}`;
const invToken = `invtok_${secret()}`;
const secrets = { hr: { out: secret(), in: secret() }, inventory: { out: secret(), in: secret() }, accounting: { out: secret(), in: secret() } };
const crmBase = `http://127.0.0.1:${PORT}`;

const contract = await startFakeApps({ secrets, crmBase }); // only its Accounting is used
const hrFake = await startFakeHrPull({ token: hrToken });
const invFake = await startFakeInventoryDialect({ token: invToken });
const liveEnv = {
  INTEGRATION_HR_MODE: "live", INTEGRATION_INVENTORY_MODE: "live", INTEGRATION_ACCOUNTING_MODE: "live",
  INTEGRATION_HR_AUTH: "bearer", INTEGRATION_HR_SYNC: "pull", HR_API_TOKEN: hrToken, HR_API_BASE_URL: hrFake.baseUrl,
  INTEGRATION_INVENTORY_AUTH: "bearer", INTEGRATION_INVENTORY_DIALECT: "johnvivz_inventory", INVENTORY_API_TOKEN: invToken, INVENTORY_API_BASE_URL: invFake.baseUrl,
  INTEGRATION_ACCOUNTING_AUTH: "hmac", ACCOUNTING_API_BASE_URL: `${contract.accounting.baseUrl}/api/integration/v1/`,
  JVZ_SECRET_ACCOUNTING: secrets.accounting.out, JVZ_CRM_INBOUND_SECRET_ACCOUNTING: secrets.accounting.in,
  INTEGRATION_ESS_LOGIN: "live", LOGIN_EMAIL_RATE_LIMIT_MAX: "15", // every staff sign-in goes to the fake JVzPay /auth/login
};
const env = await startEnvironment({ dbName: DB, port: PORT, serverEnv: liveEnv });
console.log(`\nJOHNVIVZ CRM interim-dialect tests — database ${DB} (HR pull + Bearer, Inventory dialect + Bearer, Accounting HMAC; all fakes)\n`);
check("ENV-01", "Migrations, demo seed and fixtures load; the server starts with HR (pull, API token), Inventory (dialect, API token) and Accounting (HMAC) live",
  env.steps.migrate.status === 0 && env.steps.seed.status === 0 && env.steps.fixtures.status === 0 && env.up, env.steps.migrate.stderr || env.steps.seed.stderr || env.serverLog());

const { all, one, db, as } = env;
const nodeLive = (script, more = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env: { ...env.env, ...liveEnv, ...more } });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});
const runScript = (script, args = [], extra = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...env.env, ...liveEnv, ...extra } });
  let out = "";
  c.stdout.on("data", (d) => { out += d; });
  c.stderr.on("data", (d) => { out += d; });
  c.on("close", (status) => resolve({ status, out }));
});
const decode = (s) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x3D;/g, "=").replace(/&#x60;/g, "`");
const alerts = (html) => [...html.matchAll(/role="(?:alert|status)">.*?<span>([^<]*)<\/span>/gs)].map((m) => decode(m[1]));
const flashAfter = async (client, p) => alerts((await client.get(p)).body).join(" | ");
const INT = "/crm/settings/integration";
const emp = (id) => one("SELECT * FROM employee_references WHERE employee_id = ?", [id]);
const inboxCount = async (source) => Number((await one("SELECT COUNT(*) n FROM integration_inbox WHERE source = ?", [source])).n);
const bearerGet = (p, token, headers = {}) => fetch(`${crmBase}${p}`, { headers: { Authorization: `Bearer ${token}`, ...headers } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

let serverM = null;
try {
  // the demo staff are registered in the fake ESS (same email, password Demo@1234), so they can sign in while ESS login is live
  for (const [email, id] of [["manager@johnvivz.test", "MOCK-EMP-1001"], ["maria.santos@johnvivz.test", "MOCK-EMP-1002"], ["kristine.bautista@johnvivz.test", "MOCK-EMP-1003"]]) contract.accounting.registerEss(email, "Demo@1234", { employee_id: id, department_code: "CRM" });
  const mgr = await as("manager@johnvivz.test");
  const tl = await as("maria.santos@johnvivz.test");
  const agent = await as("kristine.bautista@johnvivz.test");
  const juanC = await as("juan.cruz@johnvivz.test");

  // ================================================================ configuration
  const cfg = env.node(["--input-type=module", "-e", "const { config, apiBase } = await import('./config/index.js'); const i = config.integration; console.log('CFG ' + JSON.stringify({ modes: [i.hr.mode, i.inventory.mode, i.accounting.mode], auth: [i.hr.auth, i.inventory.auth, i.accounting.auth], sync: i.hr.sync, dialect: i.inventory.dialect, a: apiBase('http://10.0.0.5:3002/api/integration/v1/'), b: apiBase('http://10.0.0.5:3002/'), c: apiBase('http://10.0.0.5:3002/API/Integration/v1') }));"],
    { INTEGRATION_HR_MODE: "", INTEGRATION_INVENTORY_MODE: "", INTEGRATION_ACCOUNTING_MODE: "", INTEGRATION_HR_AUTH: "", INTEGRATION_INVENTORY_AUTH: "", INTEGRATION_ACCOUNTING_AUTH: "", INTEGRATION_HR_SYNC: "", INTEGRATION_INVENTORY_DIALECT: "" });
  const c = JSON.parse((cfg.stdout.match(/CFG (.*)/) || [])[1] || "{}");
  check("CFG-1", "Defaults are the contract and mock: unset modes are mock, auth hmac, HR sync events, Inventory dialect contract; a base URL with or without /api/integration/v1 (any case, trailing slash) is the same address",
    JSON.stringify(c.modes) === '["mock","mock","mock"]' && JSON.stringify(c.auth) === '["hmac","hmac","hmac"]' && c.sync === "events" && c.dialect === "contract" && c.a === "http://10.0.0.5:3002" && c.b === c.a && c.c === c.a, cfg.stdout + cfg.stderr);
  const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const localEnv = fs.readFileSync(path.join(root, ".env"), "utf8");
  check("CFG-2", ".env.example documents the new keys with contract defaults and empty tokens; the local .env keeps every mode on mock",
    /^INTEGRATION_HR_AUTH=hmac\s*$/m.test(example) && /^INTEGRATION_HR_SYNC=events\s*$/m.test(example) && /^INTEGRATION_INVENTORY_DIALECT=contract\s*$/m.test(example) && /^HR_API_TOKEN=\s*$/m.test(example) && /^INVENTORY_API_TOKEN=\s*$/m.test(example)
    && ["HR", "INVENTORY", "ACCOUNTING"].every((k) => new RegExp(`^INTEGRATION_${k}_MODE=mock\\s*$`, "m").test(localEnv)));
  const prod = env.node(["--input-type=module", "-e", "const { productionProblems } = await import('./config/productionCheck.js'); const base = { env: 'production', session: { secret: 'x'.repeat(40), secureCookie: true }, showDemoLogins: false, db: { name: 'johnvivz_crm_db' }, mail: { transport: 'smtp' } }; const app = (o) => ({ mode: 'live', baseUrl: 'http://h', secret: '', token: '', auth: 'hmac', ...o }); const a = productionProblems({ ...base, integration: { hr: app({ auth: 'bearer' }), inventory: app({ auth: 'bearer', token: 't' }), accounting: app({ secret: 's' }) } }); console.log('PROD ' + JSON.stringify(a));"]);
  const p = JSON.parse((prod.stdout.match(/PROD (.*)/) || [])[1] || "{}");
  check("CFG-3", "Production start check: live + bearer without <APP>_API_TOKEN is an error naming the token; live + bearer with a token is allowed with a warning (interim, no replay protection); HMAC rules unchanged",
    p.errors?.length === 1 && /HR_API_TOKEN/.test(p.errors[0]) && p.warnings?.some((w) => /INTEGRATION_INVENTORY_AUTH=bearer/.test(w)) && !p.errors.some((e) => /ACCOUNTING|INVENTORY/.test(e)), prod.stdout + prod.stderr);

  // ================================================================ inbound authentication (CRM's own API)
  const h1 = await bearerGet("/api/integration/v1/health", hrToken);
  const h2 = await fetch(`${crmBase}/api/integration/v1/health`, { headers: { "X-API-Key": invToken } }).then((r) => r.status);
  const h3 = await bearerGet("/api/integration/v1/health", "wrong-token");
  const h4 = await bearerGet("/api/integration/v1/health", hrToken, { "X-JVZ-Client": "johnvivz_accounting" });
  const ts = new Date(Date.now() + 8 * 3600e3).toISOString().replace("Z", "+08:00");
  const fakeSig = crypto.createHmac("sha256", "any").update(["GET", "/api/integration/v1/health", ts, crypto.createHash("sha256").update("").digest("hex")].join("\n")).digest("hex");
  const h5 = await fetch(`${crmBase}/api/integration/v1/health`, { headers: { "X-JVZ-Client": "johnvivz_hr", "X-JVZ-Timestamp": ts, "X-JVZ-Signature": fakeSig } }).then((r) => r.status);
  const h6 = await contract.accounting.getFromCrm("/api/integration/v1/health");
  const h7 = await bearerGet("/api/integration/v1/sales/00000000-0000-4000-8000-000000000000", hrToken);
  check("AUTH-1", "Inbound: an app set to bearer is accepted with its API token (Authorization: Bearer or X-API-Key); a wrong token, a token sent under another app's name, or an HMAC signature from a bearer app is 401; Accounting's HMAC still works; per-app endpoint rules still apply (HR may not read sales: 403)",
    h1.status === 200 && h1.json?.your_mode === "live" && h2 === 200 && h3.status === 401 && h4.status === 401 && h5 === 401 && h6.status === 200 && h7.status === 403, JSON.stringify([h1, h2, h3.status, h4.status, h5, h6.status, h7.status]));

  // ================================================================ Integration Health and Test connection
  const page = (await mgr.get(INT)).body;
  check("PAGE-1", "Integration Health shows how CRM connects to each app (API token + pull sync for HR, API token + Inventory dialect, HMAC for Accounting), credentials only as Configured, and the HR Sync now button",
    /data-auth="bearer">API token \(Bearer\), pull sync every 5 minutes/.test(page) && /data-auth="bearer">API token \(Bearer\), Inventory dialect \(polled outbox\)/.test(page) && /data-auth="hmac">HMAC signature/.test(page) && page.includes('data-hr-sync="1"') && !page.includes(hrToken) && !page.includes(invToken), page.match(/data-auth="[^"]*">[^<]*/g)?.join(" | "));
  await mgr.post(`${INT}/test/hr`, {});
  const tHr = await flashAfter(mgr, INT);
  await mgr.post(`${INT}/test/accounting`, {});
  const tAcc = await flashAfter(mgr, INT);
  await mgr.post(`${INT}/test/inventory`, {});
  const tInv = await flashAfter(mgr, INT);
  const hrAuthHeaders = hrFake.requests.filter((r) => r.path.includes("/ping"));
  check("TEST-1", "Test connection: HR has no /health, so CRM asks GET /ping (200) with its API token; Accounting answers /health with the base URL given WITH /api/integration/v1 (no doubled path); Inventory falls back to a one-product read; each message names the connection style",
    /answered 200 at \/ping .*API token \(Bearer\), pull sync/.test(tHr) && /answered 200 at \/health .*HMAC signature/.test(tAcc) && /answered 200 at \/products\?limit=1 .*Inventory dialect/.test(tInv)
    && hrAuthHeaders.length >= 1 && hrAuthHeaders.every((r) => r.headers.authorization === `Bearer ${hrToken}` && !r.headers["x-jvz-signature"]) && contract.accounting.requests.some((r) => r.path === "/api/integration/v1/health" && r.authorized) && !contract.accounting.requests.some((r) => r.path.includes("/api/integration/v1/api/")),
    `${tHr} || ${tAcc} || ${tInv}`);

  // ================================================================ HR pull sync
  const inboxBefore = await inboxCount("johnvivz_hr");
  await mgr.post(`${INT}/hr-sync`, {});
  const s1 = await flashAfter(mgr, INT);
  const ids = (await all("SELECT employee_id FROM employee_references WHERE is_mock = 0 ORDER BY employee_id")).map((r) => r.employee_id);
  check("HR-1", "Sync now imports HR's employees: Active, On Leave and Resigned people are created (5); Onboarding and Rejected people are not imported; the flash gives the counts",
    JSON.stringify(ids) === JSON.stringify(["107", "JV-2026-00001", "JV-2026-00002", "JV-2026-00005", "JV-2026-00006"]) && /HR sync: 7 employee\(s\) read; 5 created, 0 updated, 0 status change\(s\), 2 not imported/.test(s1), `${ids} | ${s1}`);
  const rico = await one("SELECT e.*, p.title AS position_title, d.name AS department_name FROM employee_references e LEFT JOIN position_references p ON p.position_id = e.position_id LEFT JOIN department_references d ON d.department_id = e.department_id WHERE e.employee_id = 'JV-2026-00002'");
  const tess = await emp("107");
  const lea = await emp("JV-2026-00005");
  const ramil = await emp("JV-2026-00006");
  check("HR-2", "Field mapping: permanent_employee_id is the HR id (else employee_id), email -> work_email, the position text becomes a position row shown as the title, the department is HR's, reporting_supervisor_id (given as a number, a JV id or a code) -> the supervisor's HR id; On Leave -> on_leave, Resigned -> separated",
    rico.work_email === "rico.dimaano@hr.example.test" && rico.position_title === "Customer Service Representative" && rico.department_name === "Customer Relations" && rico.department_id === "1" && rico.supervisor_employee_id === "JV-2026-00001"
    && tess.supervisor_employee_id === "JV-2026-00001" && lea.employment_status === "on_leave" && lea.supervisor_employee_id === "JV-2026-00001" && ramil.employment_status === "separated" && rico.is_mock === 0 && rico.source === "johnvivz_hr", JSON.stringify({ rico, tess: tess.supervisor_employee_id }));
  const hrPayloads = JSON.stringify(await all("SELECT payload FROM integration_inbox WHERE source = 'johnvivz_hr'")) + JSON.stringify(await all("SELECT * FROM employee_references")) + JSON.stringify(await all("SELECT message FROM integration_logs"));
  check("HR-3", "No personal or pay data is stored: phone numbers, hire dates and employment types from HR are nowhere in CRM (inbox payloads, snapshots, logs)",
    !/0917000010|hire_date|phone_number|employment_type|Probationary|Contractual|2024-01-15/.test(hrPayloads));
  const empReqs = hrFake.requests.filter((r) => r.path.startsWith("/api/integration/v1/employees?"));
  check("HR-4", "CRM reads HR with the API token only (no HMAC headers) and pages through /employees (page + page_size) until total_pages; /departments is read once",
    empReqs.length === 4 && empReqs.every((r) => /page=\d&page_size=100/.test(r.path) && r.headers.authorization === `Bearer ${hrToken}` && !r.headers["x-jvz-signature"]) && hrFake.requests.filter((r) => r.path === "/api/integration/v1/departments").length === 1, empReqs.map((r) => r.path).join(" "));
  const audits1 = await all("SELECT details FROM crm_audit_logs WHERE action IN ('hr_employee_reference_created','hr_reference_updated') ORDER BY id");
  check("HR-5", "Every change came through the inbox as the event HR would have sent (DepartmentCreated, PositionCreated, EmployeeCreated) and is audited with source hr-sync",
    (await inboxCount("johnvivz_hr")) - inboxBefore === 2 + 3 + 5 && Number((await one("SELECT COUNT(*) n FROM integration_inbox WHERE source = 'johnvivz_hr' AND idempotency_key LIKE 'hr-sync:%' AND status = 'processed'")).n) === 10
    && audits1.length >= 10 && audits1.every((a) => /source: hr-sync /.test(a.details)), `${(await inboxCount("johnvivz_hr")) - inboxBefore} ${audits1.slice(0, 3).map((a) => a.details)}`);
  const beforeAgain = await inboxCount("johnvivz_hr");
  await mgr.post(`${INT}/hr-sync`, {});
  const s2 = await flashAfter(mgr, INT);
  check("HR-6", "A second sync with nothing changed in HR writes nothing (no inbox events) and says 5 unchanged", (await inboxCount("johnvivz_hr")) === beforeAgain && /0 created, 0 updated, 0 status change\(s\), 2 not imported \(Onboarding\/Rejected\), 5 unchanged/.test(s2), s2);

  // ================================================================ employee account flow (contract §12.5): HR -> waiting account -> ESS -> active
  const acct = (id) => one("SELECT * FROM crm_users WHERE employee_id = ?", [id]);
  const pia = await acct("JV-2026-00001");
  const ricoU = await acct("JV-2026-00002");
  const leaU = await acct("JV-2026-00005");
  const accessPage = (await mgr.get("/crm/settings/access")).body;
  check("ACC-1", "After the HR pull, every CRM-department hire who is active or on leave has a SWITCHED-OFF staff account with no CRM password, waiting for ESS registration; the role comes from the position (Team Leader -> Team Leader, others -> Agent); other departments, Resigned, Onboarding and Rejected people get none",
    [pia, ricoU, leaU].every((u) => u && u.login_via === "ess" && u.password_hash === null && u.is_active === 0 && u.ess_activated_at === null && u.role_source === "position_rule" && u.team_id === null)
    && pia.role === "team_leader" && ricoU.role === "agent" && leaU.role === "agent" && ricoU.email === "rico.dimaano@hr.example.test"
    && !(await acct("107")) && !(await acct("JV-2026-00006")) && Number((await one("SELECT COUNT(*) n FROM crm_users WHERE employee_id IN ('103','104')")).n) === 0
    && /HR sync: .*3 CRM staff account\(s\) created \(waiting for ESS registration\)/.test(s1) && Number((await one("SELECT COUNT(*) n FROM crm_audit_logs WHERE action = 'staff_account_created_from_hr' AND details LIKE 'source: hr-sync%'")).n) === 3
    && /data-employee="JV-2026-00002" data-state="waiting"/.test(accessPage) && !accessPage.includes("Tess Temporary"), `${s1} ${JSON.stringify([pia?.role, ricoU?.role, leaU?.role])}`);
  const rowOf = (html, id) => (html.split(`data-employee="${id}"`)[1] || "").split("</tr>")[0];
  check("ACC-1b", "Position rules on real HR titles: 'Team Leader' is an exact title (Team Leader, not flagged); 'Customer Service Representative' matches no rule, so it is Agent and flagged for the Manager's review",
    !rowOf(accessPage, "JV-2026-00001").includes("data-needs-review") && rowOf(accessPage, "JV-2026-00002").includes("data-needs-review=\"1\"") && /data-review-count="2"/.test(accessPage), (accessPage.match(/data-review-count="\d+"/) || ["none"])[0]);
  const RICO = "rico.dimaano@hr.example.test";
  const loginAs = async (email, password) => { const c = new Client(crmBase); const r = await c.login(email, password); return { c, r, text: decode(r.body || "") }; };
  const pre = await loginAs(RICO, "Rico#2026pw");
  check("ACC-2", "Before ESS registration the new hire cannot sign in (ESS answers 401): one generic message, audited with the real reason",
    pre.r.status === 401 && pre.text.includes("We could not sign you in") && (await one("SELECT details FROM crm_audit_logs WHERE action = 'login_failed' ORDER BY id DESC LIMIT 1")).details.includes("invalid_credentials"));
  contract.accounting.registerEss(RICO, "Rico#2026pw", { employee_id: "JV-2026-00002", employee_code: "EMP-102", full_name: "Rico Dimaano", department_code: "CRM", position: "Customer Service Representative" });
  const loginsBeforeEss = contract.accounting.requests.filter((r) => r.path === "/api/integration/v1/auth/login").length;
  const ok1 = await loginAs(RICO, "Rico#2026pw");
  const ricoNow = await acct("JV-2026-00002");
  const essCall = contract.accounting.requests.filter((r) => r.path === "/api/integration/v1/auth/login").slice(-1)[0];
  const actAudit = await one("SELECT * FROM crm_audit_logs WHERE action = 'staff_activated_via_ess' ORDER BY id DESC LIMIT 1");
  const logs = JSON.stringify(await all("SELECT endpoint, message FROM integration_logs"));
  check("ACC-3", "The new hire registers in ESS (JVzPay) and signs in to CRM with the ESS password: CRM asks JVzPay /auth/login (HMAC-signed), the first success ACTIVATES the account (audited 'activated via ESS'), and CRM stores no password; the password is in no log",
    ok1.r.status === 302 && ok1.r.location === "/crm/agent" && (await ok1.c.get("/crm/agent")).status === 200 && ricoNow.is_active === 1 && ricoNow.ess_activated_at !== null && ricoNow.password_hash === null
    && contract.accounting.requests.filter((r) => r.path === "/api/integration/v1/auth/login").length === loginsBeforeEss + 1 && essCall.authorized && actAudit && /activated via ESS \(live/.test(actAudit.details) && !logs.includes("Rico#2026pw"), `${ok1.r.status} ${ok1.r.location} ${JSON.stringify(ricoNow)}`);
  const wrong = await loginAs(RICO, "Wrong#2026pw");
  contract.accounting.registerEss("lea.leave@hr.example.test", "Lea#2026pw", { employee_id: "JV-2026-00005", department_code: "CRM" }, { allowed: false });
  const notAllowed = await loginAs("lea.leave@hr.example.test", "Lea#2026pw");
  contract.accounting.registerEss("pia.lagman@hr.example.test", "Pia#2026pw", { employee_id: "JV-2026-00001", department_code: "OPS" });
  const otherDept = await loginAs("pia.lagman@hr.example.test", "Pia#2026pw");
  contract.accounting.essDown = true;
  const down = await loginAs(RICO, "Rico#2026pw");
  contract.accounting.essDown = false;
  const reasons = (await all("SELECT details FROM crm_audit_logs WHERE action IN ('login_failed','login_refused') ORDER BY id DESC LIMIT 4")).map((r) => r.details).join(" | ");
  check("ACC-4", "Every ESS failure shows the same generic message (wrong password, ESS 403 not_allowed, ESS says another department), except 'ESS is unavailable, try again later.' when JVzPay does not answer; no local fallback; each attempt is audited with its reason",
    [wrong, notAllowed, otherDept].every((x) => x.r.status === 401 && x.text.includes("We could not sign you in")) && down.r.status === 503 && down.text.includes("ESS is unavailable, try again later.")
    && /unavailable/.test(reasons) && /ess_not_crm_department/.test(reasons) && /not_allowed/.test(reasons) && /invalid_credentials/.test(reasons) && (await acct("JV-2026-00005")).is_active === 0, reasons);
  const juanOk = await loginAs("juan.cruz@johnvivz.test", "Demo@1234");
  const adminOk = await loginAs("admin@johnvivz.test", "Demo@1234");
  const localStaff = await loginAs("ramon.aquino@johnvivz.test", "Ramon#12345");
  check("ACC-5", "With ESS login live, customers and the setup administrator keep their CRM password, while EVERY staff sign-in goes to ESS: a staff login that ESS does not know is refused even with its old CRM password",
    juanOk.r.status === 302 && adminOk.r.status === 302 && localStaff.r.status === 401, `${juanOk.r.status} ${adminOk.r.status} ${localStaff.r.status}`);
  const fpPage = (await new Client(crmBase).get("/forgot-password")).body;
  let limited = null;
  for (let i = 0; i < 16; i++) limited = await loginAs("ghost.staff@nowhere.test", `Guess#${i}xyz`);
  check("ACC-6", "Staff 'Forgot password' points to ESS; sign-in attempts are rate-limited per account (here 15 per 15 minutes)", decode(fpPage).includes("To change or reset it, use ESS") && limited.r.status === 429, `${limited.r.status}`);

  // HR removes access through the same code as EmployeeStatusChanged (the new hire's own ESS account)
  const okBefore = await ok1.c.get("/crm/agent");
  hrFake.setStatus(102, "Terminated");
  await mgr.post(`${INT}/hr-sync`, {});
  const s3 = await flashAfter(mgr, INT);
  const kris = await one("SELECT access_revoked_at, access_revoked_reason FROM crm_users WHERE employee_id = 'JV-2026-00002'");
  const blocked = await ok1.c.get("/crm/agent");
  const again = await loginAs(RICO, "Rico#2026pw");
  const statusAudit = await one("SELECT * FROM crm_audit_logs WHERE action = 'hr_employment_status_applied' AND record_id = 'JV-2026-00002' ORDER BY id DESC LIMIT 1");
  const removedPage = (await mgr.get("/crm/settings/access")).body;
  check("HR-7", "HR marks the employee Terminated: the next pull applies it as EmployeeStatusChanged (separated), the open CRM session ends, a new ESS sign-in is refused, the page says 'Removed by HR', and the change is audited with source hr-sync",
    okBefore.status === 200 && /1 status change/.test(s3) && (await emp("JV-2026-00002")).employment_status === "separated" && kris.access_revoked_at && /separated/.test(kris.access_revoked_reason || "") && blocked.status !== 200 && again.r.status === 401
    && /data-employee="JV-2026-00002" data-state="removed"/.test(removedPage) && statusAudit && /source: hr-sync/.test(statusAudit.details) && /CRM access revoked/.test(statusAudit.details), `${s3} ${blocked.status} ${again.r.status} ${JSON.stringify(kris)} ${statusAudit?.details}`);
  hrFake.setStatus(102, "Active");
  await mgr.post(`${INT}/hr-sync`, {});
  await flashAfter(mgr, INT);
  const kris2 = await one("SELECT access_revoked_at FROM crm_users WHERE employee_id = 'JV-2026-00002'");
  const restoredAudit = await one("SELECT details FROM crm_audit_logs WHERE action = 'hr_employment_status_applied' AND record_id = 'JV-2026-00002' ORDER BY id DESC LIMIT 1");
  const back = await loginAs(RICO, "Rico#2026pw");
  check("HR-8", "HR sets the employee Active again: the HR block is lifted (audited 'HR block lifted') and the ESS sign-in works again", !kris2.access_revoked_at && /HR block lifted/.test(restoredAudit.details) && (await emp("JV-2026-00002")).employment_status === "active" && back.r.status === 302);
  hrFake.patch(105, { email: "lea.new@hr.example.test" });
  hrFake.setStatus(107, "Rejected");
  hrFake.add({ employee_id: 108, permanent_employee_id: null, employee_code: "EMP-108", first_name: "New", last_name: "Hire", full_name: "New Hire", email: "new@hr.example.test", department: { department_id: 2, department_name: "Operations" }, position: "Store Clerk", status: "Onboarding" });
  await mgr.post(`${INT}/hr-sync`, {});
  const s4 = await flashAfter(mgr, INT);
  const upd = await one("SELECT * FROM crm_audit_logs WHERE action = 'hr_employee_reference_updated' AND record_id = 'JV-2026-00005' ORDER BY id DESC LIMIT 1");
  check("HR-9", "A changed field (email) is applied as EmployeeUpdated and audited with before/after; an imported employee who becomes Rejected is set to inactive; a new Onboarding hire is not imported",
    (await emp("JV-2026-00005")).work_email === "lea.new@hr.example.test" && upd && /lea\.leave@/.test(JSON.stringify(upd.before_values)) && /lea\.new@/.test(JSON.stringify(upd.after_values)) && /hr-sync/.test(upd.details)
    && (await emp("107")).employment_status === "inactive" && !(await emp("108")) && /3 not imported/.test(s4), `${s4} ${upd?.before_values} ${upd?.after_values}`);
  const job = await nodeLive("const { runHrPullOnce } = await import('./jobs/scheduler.js'); const { lookupEmployee } = await import('./services/integration/hrAdapter.js'); const { sequelize } = await import('./models/index.js'); await runHrPullOnce(); const l = await lookupEmployee('EMP-102'); const none = await lookupEmployee('NOPE'); console.log('LOOK ' + JSON.stringify({ l, none })); await sequelize.close();");
  const look = JSON.parse((job.stdout.match(/LOOK (.*)/) || [])[1] || "{}");
  const jobLog = await one("SELECT * FROM integration_logs WHERE `system` = 'johnvivz_hr' AND direction = 'sync' AND message LIKE 'HR pull (job)%' ORDER BY id DESC LIMIT 1");
  check("HR-10", "The 5-minute job runs the same pull (logged as 'HR pull (job)'); an employee lookup uses GET /employees/:identifier (a code works) and returns CRM fields only; unknown = null",
    job.status === 0 && jobLog && look.l?.employee_id === "JV-2026-00002" && look.l?.work_email === "rico.dimaano@hr.example.test" && !("phone_number" in (look.l || {})) && look.none === null, `${job.stdout} ${job.stderr.slice(0, 400)}`);
  hrFake.down(true);
  const snap = JSON.stringify(await all("SELECT employee_id, employment_status, work_email FROM employee_references ORDER BY employee_id"));
  await mgr.post(`${INT}/hr-sync`, {});
  const s5 = await flashAfter(mgr, INT);
  hrFake.down(false);
  check("HR-11", "HR unreachable: Sync now says it failed and nothing was changed; the failure is in the call log", /HR sync failed, nothing was changed: .*could not be reached/.test(s5) && JSON.stringify(await all("SELECT employee_id, employment_status, work_email FROM employee_references ORDER BY employee_id")) === snap
    && (await one("SELECT COUNT(*) n FROM integration_logs WHERE `system` = 'johnvivz_hr' AND success = 0 AND message LIKE 'HR pull%failed%'")).n > 0, s5);
  const denied = await agent.post(`${INT}/hr-sync`, {});
  const tlDenied = await tl.post(`${INT}/hr-sync`, {});
  check("HR-12", "Only the CRM Manager (integration.manage) can press Sync now: Agent and Team Leader get 403", denied.status === 403 && tlDenied.status === 403, `${denied.status} ${tlDenied.status}`);

  // ================================================================ Inventory dialect: products, checkout, outbox
  await mgr.post("/crm/sales/sync", {});
  const sy = await flashAfter(mgr, "/crm/sales");
  const prods = await all("SELECT product_id, selling_price, is_vatable, status, available_qty, is_mock FROM product_references WHERE product_id LIKE 'INV-%' ORDER BY product_id");
  const listReqs = invFake.requests.filter((r) => r.path.startsWith("/api/integration/v1/products?") && r.path.includes("limit=100")); // not the Test connection read (limit=1)
  check("INV-1", "Refresh product snapshot reads Inventory's product list (search/limit/offset, Bearer token) and stores real rows: string prices become numbers, VAT flag and inactive status are kept; it also reads Inventory's outbox",
    prods.length === 3 && Number(prods[0].selling_price) === 1250 && prods[0].is_vatable === 0 && Number(prods[1].selling_price) === 115.5 && prods[1].is_vatable === 1 && prods[2].status === "inactive" && prods.every((x) => x.is_mock === 0)
    && listReqs.length >= 1 && listReqs.every((r) => /limit=100&offset=0/.test(r.path) && r.headers.authorization === `Bearer ${invToken}` && !r.headers["x-jvz-signature"]) && /Inventory events: 0 read/.test(sy), `${JSON.stringify(prods)} ${sy}`);
  const shop = (await juanC.get("/portal/shop")).body;
  check("INV-2", "The customer shop shows the live Inventory products with Inventory's price, and hides the inactive one", shop.includes("Dialect Rice 25kg") && /1,250\.00/.test(shop) && !shop.includes("Dialect Old Soap"));
  const ernesto = await one("SELECT id FROM customers WHERE first_name = 'Ernesto'");

  invFake.emit("LowStockDetected", { productId: "INV-1002", availableQty: 3 });
  invFake.emit("ProductPriceUpdated", { productId: "INV-1002", price: "120.00" });
  invFake.emit("ProductUnavailable", { productId: "INV-1001" });
  invFake.emit("StockAdjusted", { productId: "INV-1001", newQuantity: 0 });
  const poll = await nodeLive("const { pollInventoryOutbox } = await import('./services/integration/inventoryDialect.js'); const { sequelize } = await import('./models/index.js'); console.log('POLL ' + JSON.stringify(await pollInventoryOutbox({ trigger: 'test' }))); await sequelize.close();");
  const pr = JSON.parse((poll.stdout.match(/POLL (.*)/) || [])[1] || "{}");
  const p2 = await one("SELECT * FROM product_references WHERE product_id = 'INV-1002'");
  const p1 = await one("SELECT * FROM product_references WHERE product_id = 'INV-1001'");
  const invInbox = await all("SELECT event_type, status, idempotency_key, payload FROM integration_inbox WHERE source = 'johnvivz_inventory' ORDER BY id");
  check("INV-4", "Inventory's outbox is read, each event stored in CRM's inbox, processed and then acknowledged: LowStockDetected flags low stock, ProductPriceUpdated changes the price, ProductUnavailable is applied as StockUnavailable; an event CRM has no use for (StockAdjusted) is kept as ignored and acknowledged too",
    poll.status === 0 && pr.read === 4 && pr.stored === 4 && pr.acked === 4 && p2.low_stock === 1 && Number(p2.available_qty) === 3 && Number(p2.selling_price) === 120 && Number(p1.available_qty) === 0
    && invInbox.map((r) => `${r.event_type}:${r.status}`).join(",") === "LowStockDetected:processed,ProductPriceUpdated:processed,StockUnavailable:processed,StockAdjusted:ignored" && invFake.outbox.every((e) => e.acked)
    && invInbox.every((r) => r.idempotency_key.startsWith("inventory-outbox:INV-EVT-")), `${poll.stdout} ${poll.stderr.slice(0, 300)} ${JSON.stringify(invInbox.map((r) => [r.event_type, r.status]))}`);
  invFake.outbox[0].acked = false; // Inventory offers it again (e.g. our acknowledgement was lost)
  const poll2 = await nodeLive("const { runInventoryPollOnce } = await import('./jobs/scheduler.js'); const { pollInventoryOutbox } = await import('./services/integration/inventoryDialect.js'); const { sequelize } = await import('./models/index.js'); await runInventoryPollOnce(); console.log('POLL ' + JSON.stringify(await pollInventoryOutbox({ trigger: 'test' }))); await sequelize.close();");
  check("INV-5", "Duplicate protection: an event Inventory offers again is answered 'already in CRM', not processed twice, and acknowledged (the one-minute job runs the same poll)",
    poll2.status === 0 && invInbox.length === Number((await one("SELECT COUNT(*) n FROM integration_inbox WHERE source = 'johnvivz_inventory'")).n) && invFake.outbox.every((e) => e.acked)
    && (await one("SELECT COUNT(*) n FROM integration_logs WHERE message LIKE 'Inventory outbox (job): 1 read, 0 new, 1 already in CRM, 1 acknowledged%'")).n > 0, poll2.stdout + poll2.stderr.slice(0, 300));

  // ================================================================ events CRM sends: Inventory dialect + Accounting (contract)
  // orders are placed on a second server in MOCK mode (same database): the dialect refuses checkout on purpose
  const envM = { ...env.env, PORT: String(PORT_M), APP_URL: `http://127.0.0.1:${PORT_M}`, DISABLE_SCHEDULER: "1", INTEGRATION_HR_MODE: "mock", INTEGRATION_INVENTORY_MODE: "mock", INTEGRATION_ACCOUNTING_MODE: "mock" };
  serverM = spawn(process.execPath, ["index.js"], { cwd: root, env: envM, stdio: ["ignore", "pipe", "pipe"] });
  let logM = "";
  serverM.stdout.on("data", (d) => { logM += d; });
  serverM.stderr.on("data", (d) => { logM += d; });
  for (let i = 0; i < 120 && !logM.includes("running at") && serverM.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250));
  const agentM = new Client(`http://127.0.0.1:${PORT_M}`);
  await agentM.login("kristine.bautista@johnvivz.test");
  const place = async (pay) => {
    const key = uuid();
    await agentM.get("/crm/sales/new");
    await agentM.post("/crm/sales", { customer_id: String(ernesto.id), request_key: key, channel: "walk_in", fulfillment: "pickup", "qty_MOCK-P-1001": "2", "price_MOCK-P-1001": "285.00", ...(pay ? { payment_method: "cash" } : {}) });
    return one("SELECT * FROM sales_orders WHERE order_id = ?", [key]);
  };
  const o1 = await place(true);
  const o2 = await place(false);
  check("EVT-0", "Two orders were placed on the mock server (one paid in cash, one unpaid)", logM.includes("running at") && o1 && o2 && o1.payment_status === "paid", logM.slice(-400));
  const agentD = await as("kristine.bautista@johnvivz.test");
  await agentD.get(`/crm/sales/orders/${o1.id}`);
  await agentD.post(`/crm/sales/orders/${o1.id}/complete`, {});
  await agentD.get(`/crm/sales/orders/${o2.id}`);
  await agentD.post(`/crm/sales/orders/${o2.id}/cancel`, { reason: "Customer changed their mind" });
  const sale = await one("SELECT * FROM sales_transactions WHERE sales_order_id = ?", [o1.id]);
  await agentD.get(`/crm/sales/orders/${o1.id}`);
  await agentD.post(`/crm/sales/orders/${o1.id}/refund`, { amount: "285", reason: "One sack was damaged in transit", "ret_qty_MOCK-P-1001": "1", "ret_cond_MOCK-P-1001": "damaged" });
  const rf = await one("SELECT * FROM refunds WHERE sales_transaction_id = ? ORDER BY id DESC LIMIT 1", [sale?.id || 0]);
  if (rf) { await mgr.get(`/crm/sales/refunds/${rf.id}`); await mgr.post(`/crm/sales/refunds/${rf.id}/decide`, { decision: "approve" }); await mgr.post(`/crm/sales/refunds/${rf.id}/record`, {}); }
  const releaseNow = invFake.requests.filter((r) => r.path === "/api/integration/v1/events" && /order\.cancelled/.test(r.body));
  await mgr.post(`${INT}/dispatch`, {});
  await flashAfter(mgr, INT);
  const ev = (t) => invFake.eventsOf(t);
  const completed = ev("sale.completed")[0];
  const cancelled = ev("order.cancelled");
  const refundedEv = ev("sale.refunded")[0];
  const cancelPosts = invFake.requests.filter((r) => r.path === "/api/integration/v1/events" && /order\.cancelled/.test(r.body));
  const outInv = await all("SELECT event_type, status, last_error FROM integration_outbox WHERE target = 'johnvivz_inventory' AND is_mock = 0 ORDER BY id");
  check("EVT-1", "Events to Inventory use its dialect: SaleCompleted -> sale.completed {orderReference = our order_id, transactionReference = our transaction number}, RefundRecorded -> sale.refunded {orderReference, transactionReference}; each is accepted (2xx) and the outbox row is sent",
    sale && rf && completed?.orderReference === o1.order_id && completed?.transactionReference === sale.transaction_no && refundedEv?.orderReference === o1.order_id && refundedEv?.transactionReference === sale.transaction_no
    && invFake.rejected.length === 0 && outInv.length === 3 && outInv.every((r) => r.status === "sent"), JSON.stringify({ outInv, rejected: invFake.rejected, events: invFake.events.map((e) => e.eventType) }));
  check("EVT-2", "Cancel: CRM releases at once with order.cancelled, and the SaleCancelled event later carries the SAME eventId, so Inventory applies it once (2 posts, 1 event, the second answered as a duplicate)",
    releaseNow.length === 1 && cancelPosts.length === 2 && cancelled.length === 1 && cancelled[0].orderReference === o2.order_id && JSON.parse(cancelPosts[0].body).eventId === JSON.parse(cancelPosts[1].body).eventId && UUIDok(cancelled[0].eventId), JSON.stringify(cancelPosts.map((r) => r.body)));
  const eventIds = invFake.events.map((e) => e.eventId);
  check("EVT-3", "Every event to Inventory has a UUID eventId that is stable (made from the event and the order or refund), and only the fields Inventory documents", eventIds.every(UUIDok) && new Set(eventIds).size === eventIds.length
    && invFake.events.every((e) => Object.keys(e).every((k) => ["eventId", "eventType", "orderReference", "transactionReference", "items"].includes(k))), JSON.stringify(invFake.events));
  const acc = contract.accounting;
  const accSale = acc.eventsOf("SaleCompleted")[0];
  check("EVT-4", "Accounting keeps the contract: SaleCompleted, SaleCancelled and RefundRecorded arrive as HMAC-signed envelopes at /api/integration/v1/events (base URL given with the suffix, path not doubled), every envelope passes the contract checks, and payment_status is \"paid\"",
    accSale && accSale.data.payment_status === "paid" && acc.eventsOf("SaleCancelled").length === 1 && acc.eventsOf("RefundRecorded").length === 1 && acc.rejected.length === 0
    && acc.requests.filter((r) => r.method === "POST" && r.path.endsWith("/events")).every((r) => r.path === "/api/integration/v1/events" && r.authorized) && !acc.requests.some((r) => r.path.includes("/api/integration/v1/api/")), JSON.stringify({ rejected: acc.rejected, paths: acc.requests.map((r) => r.path) }));
  invFake.emit("StockDeducted", { orderReference: o1.order_id, transactionReference: sale?.transaction_no });
  await mgr.post("/crm/sales/sync", {});
  await flashAfter(mgr, "/crm/sales");
  check("EVT-5", "Inventory's StockDeducted (read from its outbox on Refresh) is applied as StockIssued: the completed order's stock shows as issued",
    (await one("SELECT reservation_status FROM sales_orders WHERE id = ?", [o1.id])).reservation_status === "issued" && (await one("SELECT status FROM integration_inbox WHERE event_type = 'StockIssued' ORDER BY id DESC LIMIT 1"))?.status === "processed");

  // ================================================================ checkout reservation in the Inventory dialect (order.confirmed, answers per the Inventory team)
  const orderOf = (key) => one("SELECT * FROM sales_orders WHERE order_id = ?", [key]);
  const orderTotal = async () => Number((await one("SELECT COUNT(*) n FROM sales_orders")).n);
  const form = (key, qty, pay) => ({ customer_id: String(ernesto.id), request_key: key, channel: "walk_in", fulfillment: "pickup", ...Object.fromEntries(Object.entries(qty).map(([p, q]) => [`qty_${p}`, String(q)])), ...(pay ? { payment_method: "cash" } : {}) });
  const checkout = async (client, qty, { key = uuid(), pay = true } = {}) => {
    await client.get("/crm/sales/new");
    const r = await client.post("/crm/sales", form(key, qty, pay));
    const msg = r.status === 302 ? await flashAfter(client, r.location) : decode(r.body);
    return { r, key, msg, o: await orderOf(key) };
  };
  const posted = (type, key) => invFake.postsFor(type, key);
  const runComp = () => nodeLive("const { processCompensations } = await import('./services/integration/compensationService.js'); const { sequelize } = await import('./models/index.js'); console.log('COMP ' + JSON.stringify(await processCompensations())); await sequelize.close();");

  const rsv1 = await checkout(agent, { "INV-1001": 2 });
  const held1 = invFake.reservations.get(rsv1.key);
  const rsvLog = await one("SELECT message FROM integration_logs WHERE endpoint = 'order.confirmed' AND message LIKE ? ORDER BY id DESC LIMIT 1", [`RESERVED order ${rsv1.key}%`]);
  const body1 = posted("order.confirmed", rsv1.key)[0] && JSON.parse(posted("order.confirmed", rsv1.key)[0].body);
  check("RSV-1", "Checkout works again in the Inventory dialect: CRM sends order.confirmed (our order id as orderReference, items productId/quantity), Inventory answers 202 with the reservation lines, the order is saved as Reserved and the lines are recorded",
    rsv1.r.status === 302 && rsv1.o?.reservation_status === "reserved" && rsv1.o.inventory_reservation_ref === `INV-ORDER:${rsv1.key}` && held1?.state === "reserved" && held1.items[0].productId === "INV-1001" && held1.items[0].quantity === 2
    && posted("order.confirmed", rsv1.key).length === 1 && body1.orderReference === rsv1.key && UUIDok(body1.eventId) && posted("order.confirmed", rsv1.key)[0].status === 202 && /RESERVED order .*INV-1001 x2/.test(rsvLog?.message || ""), `${rsv1.r.status} ${rsv1.msg.slice(0, 300)}`);

  invFake.dropAnswers(1); // Inventory reserves, but its answer is lost: CRM repeats the call with the SAME eventId
  const rsv2 = await checkout(agent, { "INV-1001": 1 });
  const posts2 = posted("order.confirmed", rsv2.key);
  const again2 = await agent.post("/crm/sales", form(rsv2.key, { "INV-1001": 1 }, true)); // the person presses Place order again
  check("RSV-2", "Retried checkout: when Inventory's answer is lost CRM repeats order.confirmed with the same eventId, Inventory answers 200 duplicate (nothing reserved twice) and ONE order is saved; submitting the same form again makes no new call and no new order",
    rsv2.o?.reservation_status === "reserved" && posts2.length === 2 && posts2[0].status === "dropped" && posts2[1].status === 200 && JSON.parse(posts2[0].body).eventId === JSON.parse(posts2[1].body).eventId
    && invFake.eventsOf("order.confirmed").filter((e) => e.orderReference === rsv2.key).length === 1 && invFake.reserved("INV-1001") === 3 && again2.status === 302 && posted("order.confirmed", rsv2.key).length === 2
    && Number((await one("SELECT COUNT(*) n FROM sales_orders WHERE order_id = ?", [rsv2.key])).n) === 1, `${posts2.map((p) => p.status)} ${invFake.reserved("INV-1001")} ${rsv2.msg.slice(0, 200)}`);

  invFake.availabilityOverride["12"] = 10; // the read API claims 10, so CRM's own pre-check passes and Inventory's 409 decides
  const before3 = await orderTotal();
  const rsv3 = await checkout(agent, { "12": 5, "INV-1001": 1 });
  delete invFake.availabilityOverride["12"];
  check("RSV-3", "409 insufficient_stock: no order; the customer is told which product is short by OUR product name (never the bare SKU) with what is available; all or nothing: the other line is not reserved either",
    rsv3.r.status === 409 && rsv3.msg.includes("The order was not placed: Dialect Scarce Item: only 3 available (you asked for 5)") && !(rsv3.msg.match(/The order was not placed[^<]*/) || ["SKU-SCARCE"])[0].includes("SKU-SCARCE") && !rsv3.o && (await orderTotal()) === before3
    && invFake.reserved("12") === 0 && invFake.reserved("INV-1001") === 3 && !invFake.reservations.has(rsv3.key)
    && (await one("SELECT COUNT(*) n FROM integration_logs WHERE endpoint = 'order.confirmed' AND message LIKE ?", [`SHORT order ${rsv3.key}%`])).n > 0, `${rsv3.r.status} ${(rsv3.msg.match(/(The order was not placed|role="alert")[^<]*(<[^>]*>[^<]*){0,3}/) || [rsv3.msg.slice(-300)])[0]} reserved12=${invFake.reserved("12")} inv1001=${invFake.reserved("INV-1001")} has=${invFake.reservations.has(rsv3.key)}`);

  const agent2 = await as("kristine.bautista@johnvivz.test");
  await agent.get("/crm/sales/new");
  await agent2.get("/crm/sales/new");
  const [k1, k2] = [uuid(), uuid()];
  const before4 = await orderTotal();
  const [x1, x2] = await Promise.all([agent.post("/crm/sales", form(k1, { "12": 2 }, true)), agent2.post("/crm/sales", form(k2, { "12": 2 }, true))]);
  const winners = [await orderOf(k1), await orderOf(k2)].filter(Boolean);
  const loser = [x1, x2].find((x) => x.status !== 302);
  check("RSV-4", "Two checkouts race for the last 3 units (2 each): exactly one order is saved and Inventory holds 2; the other is refused with the product's name, and nothing is reserved for it",
    winners.length === 1 && (await orderTotal()) === before4 + 1 && invFake.reserved("12") === 2 && loser && /Dialect Scarce Item/.test(decode(loser.body)) && /available/.test(decode(loser.body)), `${x1.status} ${x2.status} ${invFake.reserved("12")} ${loser ? decode(loser.body).match(/The order was not placed[^<]*/)?.[0] : "no loser"}`);

  invFake.archiveOnReserve("INV-1002");
  const rsv5 = await checkout(agent, { "INV-1002": 1 });
  const snap5 = await one("SELECT status, available_qty FROM product_references WHERE product_id = 'INV-1002'");
  check("RSV-5", "409 product_unavailable (archived at Inventory): no order, the customer is told the product is not sold any more, and CRM refreshes that product's snapshot (now inactive)",
    rsv5.r.status === 409 && rsv5.msg.includes("Dialect Cooking Oil 1L is not sold any more") && !rsv5.o && snap5.status === "inactive"
    && (await one("SELECT COUNT(*) n FROM integration_logs WHERE endpoint = 'order.confirmed' AND message LIKE ?", [`UNAVAILABLE order ${rsv5.key}%`])).n > 0, `${rsv5.msg.slice(0, 300)} ${JSON.stringify(snap5)}`);

  invFake.conflictNext("reservation_conflict");
  const rsv6 = await checkout(agent, { "INV-1001": 1 });
  const comp6 = await one("SELECT * FROM integration_compensations WHERE order_id = ?", [rsv6.key]);
  const health6 = decode((await mgr.get(INT)).body);
  invFake.failNext(2, 503); // no answer at all: nothing reserved
  const rsv7 = await checkout(agent, { "INV-1001": 1 });
  invFake.dropAnswers(2); // Inventory DID reserve, but both answers are lost
  const rsv8 = await checkout(agent, { "INV-1001": 1 });
  const held8before = invFake.reservations.get(rsv8.key)?.state;
  const comps = await all("SELECT order_id, kind FROM integration_compensations WHERE order_id IN (?, ?) ORDER BY id", [rsv7.key, rsv8.key]);
  check("RSV-6", "409 reservation_conflict: no order, the person is told the reservation was refused, the conflict is logged and listed for staff on Integration Health, and a clean-up task is queued to release anything held under that order reference",
    rsv6.r.status === 409 && /stock reservation for this order was refused by Inventory/.test(rsv6.msg) && !rsv6.o && comp6?.kind === "release_reservation" && comp6.status === "pending"
    && /data-reservation-conflicts="\d+"/.test(health6) && health6.includes(`CONFLICT reservation_conflict for order ${rsv6.key}`), `${rsv6.msg.slice(0, 200)} ${JSON.stringify(comp6)}`);
  check("RSV-7", "No answer (5xx twice, or answers lost twice): no order, the person is told Inventory did not confirm, and a clean-up task (resolve_reservation) is queued for each case; in the lost-answer case Inventory really holds the stock for now",
    rsv7.r.status === 503 && /did not confirm the stock reservation/.test(rsv7.msg) && !rsv7.o && rsv8.r.status === 503 && !rsv8.o && held8before === "reserved" && !invFake.reservations.has(rsv7.key)
    && comps.map((c) => c.kind).join(",") === "resolve_reservation,resolve_reservation", `${rsv7.r.status} ${rsv8.r.status} ${held8before} ${JSON.stringify(comps)}`);
  const compRun = await runComp();
  const done = await all("SELECT order_id, status FROM integration_compensations WHERE order_id IN (?, ?, ?)", [rsv6.key, rsv7.key, rsv8.key]);
  check("RSV-8", "The clean-up tasks always release what Inventory holds for an order CRM never saved (reservations never expire): the conflict case sends order.cancelled; the no-answer case asks again (same eventId, so it can only reserve once) and releases; the lost-answer case gets 200 duplicate and releases",
    compRun.status === 0 && done.length === 3 && done.every((d) => d.status === "done") && posted("order.cancelled", rsv6.key).length === 1
    && invFake.reservations.get(rsv7.key)?.state === "released" && invFake.reservations.get(rsv8.key)?.state === "released" && posted("order.cancelled", rsv8.key).length === 1
    && invFake.reserved("INV-1001") === 3, `${compRun.stdout} ${compRun.stderr.slice(0, 300)} ${JSON.stringify(done)} ${invFake.reserved("INV-1001")}`);

  await db.query("CREATE TRIGGER dia_fail_save BEFORE INSERT ON sales_order_items FOR EACH ROW BEGIN IF NEW.product_id = 'INV-1001' AND NEW.quantity = 4 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test: saving fails'; END IF; END");
  const rsv9 = await checkout(agent, { "INV-1001": 4 });
  await db.query("DROP TRIGGER dia_fail_save");
  check("RSV-9", "Saving fails AFTER Inventory reserved: no order, and CRM releases at once with order.cancelled (no clean-up task needed)",
    rsv9.r.status >= 500 && !rsv9.o && invFake.reservations.get(rsv9.key)?.state === "released" && posted("order.cancelled", rsv9.key).length === 1 && !(await one("SELECT id FROM integration_compensations WHERE order_id = ?", [rsv9.key])), `${rsv9.r.status} ${invFake.reservations.get(rsv9.key)?.state}`);

  const stockBefore = invFake.stock["INV-1001"];
  await agent.get(`/crm/sales/orders/${rsv1.o.id}`);
  await agent.post(`/crm/sales/orders/${rsv1.o.id}/complete`, {});
  const rsvC = await checkout(agent, { "INV-1001": 1 }, { pay: false });
  await agent.get(`/crm/sales/orders/${rsvC.o.id}`);
  await agent.post(`/crm/sales/orders/${rsvC.o.id}/cancel`, { reason: "Customer changed their mind" });
  await mgr.post(`${INT}/dispatch`, {});
  await flashAfter(mgr, INT);
  const oc1 = await all("SELECT status, last_error FROM integration_outbox WHERE event_type = 'OrderConfirmed' AND entity_id = ? AND target = 'johnvivz_inventory'", [rsv1.key]);
  check("RSV-10", "Completing a reserved order consumes the reservation and deducts the stock once (sale.completed); cancelling one releases it (order.cancelled); the OrderConfirmed outbox event carries the same eventId and body, so Inventory answers duplicate and it counts as sent",
    invFake.reservations.get(rsv1.key)?.state === "consumed" && invFake.stock["INV-1001"] === stockBefore - 2 && invFake.reservations.get(rsvC.key)?.state === "released"
    && oc1.length === 1 && oc1[0].status === "sent" && invFake.eventsOf("order.confirmed").filter((e) => e.orderReference === rsv1.key).length === 1 && invFake.rejected.length === 0, JSON.stringify({ oc1, rsv1: invFake.reservations.get(rsv1.key)?.state, stock: invFake.stock["INV-1001"], stockBefore, c: invFake.reservations.get(rsvC.key)?.state }));

  await db.query("UPDATE sales_orders SET confirmed_at = DATE_SUB(NOW(), INTERVAL 2 DAY) WHERE order_id = ?", [rsv2.key]);
  const health11 = (await mgr.get(INT)).body;
  check("RSV-11", "Integration Health lists CRM orders still reserved at Inventory after 24 hours that are neither completed nor cancelled (reservations never expire), and only those",
    health11.includes(`data-stale-order="${rsv2.o.order_no}"`) && !health11.includes(`data-stale-order="${rsv1.o.order_no}"`) && !health11.includes(`data-stale-order="${rsvC.o.order_no}"`) && /data-stale-reservations="1"/.test(health11), (health11.match(/data-stale-[a-z]+="[^"]*"/g) || []).join(" "));

  const unit = await nodeLive(`const { readReservationAnswer: r } = await import('./services/integration/inventoryDialect.js');
    const out = {
      a: r({ status: 202, json: { eventId: 'e', duplicate: false, result: { orderReference: 'o', reservations: [{ productId: 12, quantity: 2, status: 'reserved' }] } } }),
      b: r({ status: 409, json: { error: 'Insufficient available stock for SKU-SCARCE', code: 'insufficient_stock', details: { orderReference: 'o', reserved: false, shortages: [{ productId: 2, sku: 'SKU-SCARCE', requestedQuantity: 3, availableStock: 1 }, { productId: 5, sku: 'X', requestedQuantity: 1, availableStock: 0 }] } } }),
      c: r({ status: 200, json: { eventId: 'e', duplicate: true, result: { orderReference: 'o', reservations: [] } } }),
      cDiff: r({ status: 409, json: { error: 'x', code: 'conflict' } }),
      rc: r({ status: 409, json: { error: 'x', code: 'reservation_conflict' } }),
      pu: r({ status: 409, json: { error: 'x', code: 'product_unavailable', details: { productId: 7 } } }),
      other: r({ status: 409, json: { error: 'x', code: 'something_new' } }),
      s500: r({ status: 500, json: null }),
      ok200: r({ status: 200, json: { ok: true } }),
      bad400: r({ status: 400, json: { error: 'Invalid event' } }),
    };
    console.log('UNIT ' + JSON.stringify(out));`);
  const u = JSON.parse((unit.stdout.match(/UNIT (.*)/) || [])[1] || "{}");
  check("RSV-12", "The answer reader follows the Inventory team's description exactly: 202 reserved (with the lines), 200 duplicate = already reserved, 409 insufficient_stock lists every shortage, product_unavailable names the product, conflict and reservation_conflict are conflicts, an unknown 409 code or 400 is a refusal, and a 5xx or a 2xx without a reservation result is UNKNOWN (never assumed)",
    u.a?.outcome === "reserved" && u.a.duplicate === false && u.a.reservations[0].product_id === "12" && u.b?.outcome === "short" && u.b.shortages.length === 2 && u.b.shortages[0].available === 1 && u.b.shortages[0].requested === 3
    && u.c?.outcome === "reserved" && u.c.duplicate === true && u.cDiff?.outcome === "conflict" && u.rc?.outcome === "conflict" && u.pu?.outcome === "unavailable" && u.pu.productIds[0] === "7"
    && u.other?.outcome === "refused" && u.s500?.outcome === "unknown" && u.ok200?.outcome === "unknown" && u.bad400?.outcome === "refused", unit.stdout + unit.stderr.slice(0, 300));

  const direct = (body) => fetch(`${invFake.baseUrl}/api/integration/v1/events`, { method: "POST", headers: { Authorization: `Bearer ${invToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const ev2 = JSON.parse(posts2[0].body);
  const sameItemsNewId = await direct({ ...ev2, eventId: uuid() });
  const otherItemsNewId = await direct({ ...ev2, eventId: uuid(), items: [{ productId: "INV-1001", quantity: 9 }] });
  const sameIdOtherBody = await direct({ ...ev2, items: [{ productId: "INV-1001", quantity: 9 }] });
  check("RSV-13", "The fake Inventory imitates the documented rules CRM relies on: same order reference + new eventId + same items = 200 duplicate with the original result; other items = 409 conflict; same eventId + other body = 409 conflict; nothing is reserved twice",
    sameItemsNewId.status === 200 && sameItemsNewId.json.duplicate === true && sameItemsNewId.json.result?.orderReference === rsv2.key && otherItemsNewId.status === 409 && otherItemsNewId.json.code === "conflict"
    && sameIdOtherBody.status === 409 && sameIdOtherBody.json.code === "conflict" && invFake.reservations.get(rsv2.key).items[0].quantity === 1, JSON.stringify([sameItemsNewId, otherItemsNewId, sameIdOtherBody]));

  // ================================================================ approvals are in ESS (Accounting app)
  const ESS = "Leave, overtime and attendance requests are filed in ESS (Accounting app). Your Team Leader gives the first approval and Accounting/Payroll gives the final approval, both in ESS.";
  const pages = [await mgr.get("/crm/approvals"), await tl.get("/crm/approvals"), await agent.get("/crm/my-requests"), await mgr.get("/crm/my-requests"), await tl.get("/crm/team-leader")];
  check("ESS-1", "APPROVALS_ENABLED=false (default): the Approvals page and My Requests say that leave, overtime and attendance requests are filed and approved in ESS (Accounting app); the Team Leader dashboard card too",
    pages.every((r) => r.status === 200 && decode(r.body).includes(ESS)), pages.map((r) => `${r.status}:${decode(r.body).includes(ESS)}`).join(" "));

  // ================================================================ merge kit
  const good = await runScript("scripts/check-connections.mjs", ["--crm", crmBase]);
  check("KIT-1", "check-connections tests each app in its own mode and everything passes: HR with the API token (/ping, HR pull /employees and /departments), Inventory with the API token (/products, /crm/outbox read only), Accounting with HMAC (/health, /test/echo, base URL with the suffix), and app -> CRM with a token or a signature",
    good.status === 0 && /OK +HR +CRM -> app GET with API token \/ping/.test(good.out) && /OK +HR +HR pull GET \/employees — JohnVivzHR format, \d+ employee/.test(good.out) && /OK +HR +HR pull GET \/departments/.test(good.out)
    && /OK +INVENTORY +Inventory dialect GET \/crm\/outbox/.test(good.out) && /OK +INVENTORY +app -> CRM GET with API token/.test(good.out) && /OK +ACCOUNTING +CRM -> app signed POST \/test\/echo/.test(good.out)
    && /connects with: API token \(Bearer\), pull sync/.test(good.out) && /OK +ACCOUNTING +ESS login POST \/auth\/login \(made-up account\)/.test(good.out) && !good.out.includes("FAILED") && !good.out.includes(hrToken) && !good.out.includes(invToken), good.out.slice(-2000));
  const bad = await runScript("scripts/check-connections.mjs", ["--crm", crmBase], { HR_API_TOKEN: "not-the-key", INVENTORY_API_TOKEN: "" });
  check("KIT-2", "check-connections names the cause in bearer mode: a wrong HR key is BAD TOKEN (both directions), a missing Inventory token says which .env value is missing; exit code 1",
    bad.status === 1 && /FAILED HR +CRM -> app GET with API token \/(ping|health) — BAD TOKEN/.test(bad.out) && /FAILED HR +app -> CRM GET with API token .* — BAD TOKEN/.test(bad.out) && /FAILED INVENTORY .*no INVENTORY_API_TOKEN/.test(bad.out), bad.out.slice(-1500));
  const ft = spawn(process.execPath, ["scripts/fake-teammates.mjs", "--crm", crmBase, "--ports", "4721,4722,4723"], { cwd: root, env: { ...env.env, ...liveEnv } });
  let ftOut = "";
  ft.stdout.on("data", (d) => { ftOut += d; });
  ft.stderr.on("data", (d) => { ftOut += d; });
  for (let i = 0; i < 40 && !ftOut.includes("Type help"); i++) await new Promise((r) => setTimeout(r, 250));
  const ping = await fetch("http://127.0.0.1:4721/api/integration/v1/ping", { headers: { Authorization: `Bearer ${hrToken}` } }).then((r) => r.status).catch(() => 0);
  const pingNo = await fetch("http://127.0.0.1:4721/api/integration/v1/ping").then((r) => r.status).catch(() => 0);
  const invList = await fetch("http://127.0.0.1:4722/api/integration/v1/products?limit=2", { headers: { Authorization: `Bearer ${invToken}` } }).then((r) => r.json()).catch(() => null);
  ft.stdin.write("inv emit LowStockDetected productId=INV-1002 availableQty=2\n");
  ft.stdin.write("hr status JV-2026-00002 Resigned\n");
  for (let i = 0; i < 40 && !(ftOut.includes("waits in the fake Inventory outbox") && ftOut.includes("is now Resigned")); i++) await new Promise((r) => setTimeout(r, 250));
  ft.stdin.write("quit\n");
  await new Promise((r) => { ft.once("close", r); setTimeout(r, 3000); });
  check("KIT-3", "fake-teammates follows CRM's settings: a JohnVivzHR-style HR (API key, /ping, 401 without it), an Inventory-app-style Inventory (Bearer, its own product fields) and a contract Accounting; its commands change HR data and put events in the Inventory outbox",
    ftOut.includes("JohnVivzHR style") && ftOut.includes("Inventory-app style") && ftOut.includes("contract style (HMAC both ways, like JVzPay)") && ping === 200 && pingNo === 401 && Array.isArray(invList?.data) && invList.data[0]?.productId
    && ftOut.includes("waits in the fake Inventory outbox") && ftOut.includes("is now Resigned") && !ftOut.includes(hrToken) && !ftOut.includes(invToken), ftOut.slice(-1200));

  // ================================================================ Inventory's own CRM token: only Inventory's CRM routes, only with that token
  const CRM_ROUTES = [["GET", /^\/api\/integration\/v1\/products(\?.*)?$/], ["GET", /^\/api\/integration\/v1\/products\/[^/?]+(\/availability|\/price)?$/], ["POST", /^\/api\/integration\/v1\/events$/],
    ["GET", /^\/api\/integration\/v1\/crm\/outbox$/], ["POST", /^\/api\/integration\/v1\/crm\/outbox\/[^/]+\/ack$/]];
  const fromCrm = invFake.requests.filter((r) => r.headers["x-jvz-client"] === "johnvivz_crm" || !r.headers.authorization); // the test's own direct calls (RSV-13) carry neither
  const outside = fromCrm.filter((r) => !CRM_ROUTES.some(([m, re]) => m === r.method && re.test(r.path)));
  const tokenLeak = [...contract.accounting.requests, ...hrFake.requests].filter((r) => String(r.headers.authorization || "").includes(invToken));
  check("INV-ROUTES", "With Inventory's own CRM token, CRM calls only Inventory's CRM integration routes (products, events, crm/outbox and its ack); even Test connection and check-connections use a product read, never /health or /ping; the token is sent only to Inventory, and nothing else is sent there",
    fromCrm.length > 20 && outside.length === 0 && tokenLeak.length === 0 && fromCrm.filter((r) => r.headers.authorization).every((r) => r.headers.authorization === `Bearer ${invToken}`), `${outside.map((r) => `${r.method} ${r.path}`).slice(0, 8).join(" | ")} leaks=${tokenLeak.length}`);

  // ================================================================ secrets
  const logsText = JSON.stringify(await all("SELECT endpoint, message FROM integration_logs"));
  const auditText = JSON.stringify(await all("SELECT details, before_values, after_values FROM crm_audit_logs"));
  const inboxText = JSON.stringify(await all("SELECT payload FROM integration_inbox"));
  const pagesText = (await mgr.get(INT)).body + (await (await as("admin@johnvivz.test")).get("/setup/integration")).body;
  check("SEC-1", "No API token appears on a page, in the call log, the audit log, the inbox or the merge-kit output",
    [hrToken, invToken].every((t) => !logsText.includes(t) && !auditText.includes(t) && !inboxText.includes(t) && !pagesText.includes(t) && !good.out.includes(t)));
} finally {
  serverM?.kill();
  await Promise.all([contract.stop(), hrFake.stop(), invFake.stop()]);
  await env.stop();
}
function UUIDok(v) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)); }
summarize(DB);
