/*
 * JOHNVIVZ CRM — Phase P10 acceptance tests: the merge kit (secrets, connection check with every failure reason, fake-teammate mode,
 * the signed test endpoint), production safety, the first logins on a fresh database, no sample left anywhere, phone layout of every table,
 * and the delivered documents.
 *   npm run test:p10
 * Throwaway database johnvivz_crm_p10_test; CRM runs with HR, Inventory and Accounting LIVE against the local fake servers.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { check, startEnvironment, summarize, root } from "./support/harness.mjs";
import { startFakeApps } from "./support/fakeApps.mjs";

const DB = process.env.TEST_P10_DB_NAME || "johnvivz_crm_p10_test";
const PORT = Number(process.env.TEST_P10_PORT || 3206);
const secret = () => crypto.randomBytes(32).toString("hex");
const secrets = { hr: { out: secret(), in: secret() }, inventory: { out: secret(), in: secret() }, accounting: { out: secret(), in: secret() } };
const crmBase = `http://127.0.0.1:${PORT}`;
const fake = await startFakeApps({ secrets, crmBase });
const liveEnv = {
  INTEGRATION_HR_MODE: "live", INTEGRATION_INVENTORY_MODE: "live", INTEGRATION_ACCOUNTING_MODE: "live",
  HR_API_BASE_URL: fake.hr.baseUrl, INVENTORY_API_BASE_URL: fake.inventory.baseUrl, ACCOUNTING_API_BASE_URL: fake.accounting.baseUrl,
  JVZ_SECRET_HR: secrets.hr.out, JVZ_SECRET_INVENTORY: secrets.inventory.out, JVZ_SECRET_ACCOUNTING: secrets.accounting.out,
  JVZ_CRM_INBOUND_SECRET_HR: secrets.hr.in, JVZ_CRM_INBOUND_SECRET_INVENTORY: secrets.inventory.in, JVZ_CRM_INBOUND_SECRET_ACCOUNTING: secrets.accounting.in,
};
const env = await startEnvironment({ dbName: DB, port: PORT, serverEnv: liveEnv });
console.log(`\nJOHNVIVZ CRM P10 tests — database ${DB}\n`);
check("ENV-01", "Migrations (101–120), demo seed and fixtures load; the server starts in live mode against the fake teammates", env.steps.migrate.status === 0 && env.steps.seed.status === 0 && env.up, env.steps.migrate.stderr || env.steps.seed.stderr || env.serverLog());

const run = (script, args = [], extra = {}) => spawnSync(process.execPath, [script, ...args], { cwd: root, env: { ...env.env, ...liveEnv, ...extra }, encoding: "utf8", timeout: 60000 });
const runAsync = (script, args = [], extra = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...env.env, ...liveEnv, ...extra } });
  let out = "";
  c.stdout.on("data", (d) => { out += d; });
  c.stderr.on("data", (d) => { out += d; });
  c.on("close", (status) => resolve({ status, out }));
});
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

try {
  // ================================================================ merge kit: secrets
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jvz-secrets-"));
  const gen = spawnSync(process.execPath, [path.join(root, "scripts", "generate-secrets.mjs"), "--crm-url", "http://192.168.1.10:3000", "--write"], { cwd: tmp, encoding: "utf8" });
  const hexes = [...new Set(gen.stdout.match(/\b[0-9a-f]{64}\b/g) || [])];
  const files = fs.existsSync(path.join(tmp, "merge-kit-secrets")) ? fs.readdirSync(path.join(tmp, "merge-kit-secrets")).sort() : [];
  check("KIT-1", "generate-secrets creates 6 different 64-hex secrets (one per direction per app pair), prints one block per team with the base URL filled in, and --write saves one file per team in a git-ignored folder",
    gen.status === 0 && hexes.length === 6 && gen.stdout.includes("CRM_BASE_URL=http://192.168.1.10:3000") && gen.stdout.includes("JVZ_SECRET_INVENTORY=") && gen.stdout.includes("JVZ_SECRET_TO_CRM=") &&
    files.join(",") === "README.txt,accounting.env.txt,crm.env.txt,hr.env.txt,inventory.env.txt" && fs.readFileSync(path.join(tmp, ".gitignore"), "utf8").includes("merge-kit-secrets/"), `${gen.status} ${hexes.length} ${files}`);
  fs.rmSync(tmp, { recursive: true, force: true });

  // ================================================================ merge kit: check-connections
  const good = await runAsync("scripts/check-connections.mjs", ["--crm", crmBase]);
  const okLines = (good.out.match(/^ {2}OK /gm) || []).length;
  check("KIT-2", "check-connections: with everything right, every check is OK in both directions (reachable, clock, signed GET /health, signed POST /test/echo with the body's SHA-256, app -> CRM signed GET) and the exit code is 0",
    good.status === 0 && okLines >= 15 && !good.out.includes("FAILED") && good.out.includes("Every check passed"), good.out.slice(-1200));
  fake.accounting.clockOffsetMs = 10 * 60 * 1000;
  const wrong = await runAsync("scripts/check-connections.mjs", ["--crm", crmBase], { JVZ_SECRET_INVENTORY: secret(), JVZ_CRM_INBOUND_SECRET_HR: secret() });
  fake.accounting.clockOffsetMs = 0;
  check("KIT-3", "check-connections names the cause: a wrong secret (CRM -> Inventory) is BAD SIGNATURE, a wrong inbound secret (HR -> CRM) is BAD SIGNATURE, a 10-minute clock difference at Accounting is CLOCK DIFFERENCE; exit code 1",
    wrong.status === 1 && /FAILED INVENTORY\s+CRM -> app signed GET \/health — BAD SIGNATURE/.test(wrong.out) && /FAILED HR\s+app -> CRM signed GET .* — BAD SIGNATURE/.test(wrong.out) && /FAILED ACCOUNTING\s+CRM -> app signed GET \/health — CLOCK DIFFERENCE/.test(wrong.out), wrong.out.slice(-1500));
  const CLOSED = "http://127.0.0.1:39999"; // nothing listens there
  const down = await runAsync("scripts/check-connections.mjs", ["--crm", crmBase, "--only", "hr"], { HR_API_BASE_URL: CLOSED });
  const badHost = await runAsync("scripts/check-connections.mjs", ["--crm", crmBase, "--only", "accounting"], { ACCOUNTING_API_BASE_URL: "http://no-such-laptop.invalid:4103" });
  const noCrm = await runAsync("scripts/check-connections.mjs", ["--crm", CLOSED, "--only", "inventory"]);
  const blocked = await runAsync("scripts/check-connections.mjs", ["--crm", crmBase, "--only", "hr"], { HR_API_BASE_URL: "http://127.0.0.1:6000" });
  check("KIT-4", "check-connections: an app that is not running is NOT RUNNING, a host that does not exist is WRONG URL, CRM itself unreachable for the app -> CRM check says so, and a port that Node refuses to call (6000) is BLOCKED PORT; each exits with code 1",
    /FAILED HR\s+CRM -> app at .*NOT RUNNING/.test(down.out) && /WRONG URL|NO ANSWER/.test(badHost.out) && /FAILED INVENTORY\s+app -> CRM at .*NOT RUNNING.*is CRM running/.test(noCrm.out) &&
    /BLOCKED PORT: port 6000/.test(blocked.out) && [down, badHost, noCrm, blocked].every((r) => r.status === 1),
    `${down.status} ${down.out.slice(-300)} | ${badHost.out.slice(-300)} | ${noCrm.out.slice(-300)} | ${blocked.out.slice(-200)}`);
  const echo = await fake.hr.sendToCrm(null, { path: "/api/integration/v1/test/echo", raw: '{"hello":"crm"}' });
  check("KIT-5", "CRM's signed test endpoint POST /api/integration/v1/test/echo answers the SHA-256 of the exact body (and refuses an unsigned call)",
    echo.status === 200 && echo.json.received_sha256 === crypto.createHash("sha256").update('{"hello":"crm"}').digest("hex") && echo.json.your_client === "johnvivz_hr" && (await fetch(`${crmBase}/api/integration/v1/test/echo`, { method: "POST" })).status === 401);

  // ================================================================ merge kit: fake-teammate mode
  const ft = spawn(process.execPath, ["scripts/fake-teammates.mjs", "--crm", crmBase, "--ports", "4711,4712,4713"], { cwd: root, env: { ...env.env, ...liveEnv } });
  let ftOut = "";
  ft.stdout.on("data", (d) => { ftOut += d; });
  ft.stderr.on("data", (d) => { ftOut += d; });
  for (let i = 0; i < 40 && !ftOut.includes("Type help"); i++) await new Promise((r) => setTimeout(r, 250));
  ft.stdin.write("send hr EmployeeStatusChanged employee_id=MOCK-EMP-1003 employment_status=active\n");
  for (let i = 0; i < 40 && !ftOut.includes("CRM answered"); i++) await new Promise((r) => setTimeout(r, 250));
  const fakeHealth = await fetch("http://127.0.0.1:4712/api/integration/v1/health").then((r) => r.status).catch(() => 0);
  ft.stdin.write("quit\n");
  await new Promise((r) => { ft.once("close", r); setTimeout(r, 3000); });
  check("KIT-6", "Fake-teammate mode starts the contract fakes on fixed ports, prints the .env lines for CRM, and its 'send' command delivers a signed event that CRM accepts (202)",
    ftOut.includes("fake HR") && ftOut.includes("INVENTORY_API_BASE_URL=http://127.0.0.1:4712") && /CRM answered 202/.test(ftOut) && fakeHealth === 401 /* unsigned call refused by the fake */, ftOut.slice(-800));

  // ================================================================ production safety
  const prod = spawnSync(process.execPath, ["index.js"], { cwd: root, env: { ...env.env, NODE_ENV: "production", PORT: String(PORT + 50), SESSION_SECRET: "xianfire-secret-key", SHOW_DEMO_LOGINS: "true" }, encoding: "utf8", timeout: 30000 });
  const seedProd = spawnSync(process.execPath, ["seeders/index.js"], { cwd: root, env: { ...env.env, NODE_ENV: "production" }, encoding: "utf8" });
  check("DEPLOY-1", "In production the server REFUSES to start with the default or a short SESSION_SECRET or with demo logins on the login page (exit code 1, the reasons printed), and the demo seeder refuses to run",
    prod.status === 1 && /SESSION_SECRET must be/.test(prod.stderr + prod.stdout) && /SHOW_DEMO_LOGINS must be false/.test(prod.stderr + prod.stdout) && seedProd.status !== 0 && /Refusing to run: NODE_ENV=production/.test(seedProd.stderr + seedProd.stdout), (prod.stderr + prod.stdout).slice(0, 400));
  const okProd = spawn(process.execPath, ["index.js"], { cwd: root, env: { ...env.env, ...liveEnv, NODE_ENV: "production", PORT: String(PORT + 51), SESSION_SECRET: secret(), SHOW_DEMO_LOGINS: "", DISABLE_SCHEDULER: "1" } });
  let okLog = "";
  okProd.stdout.on("data", (d) => { okLog += d; });
  okProd.stderr.on("data", (d) => { okLog += d; });
  for (let i = 0; i < 60 && !okLog.includes("running at"); i++) await new Promise((r) => setTimeout(r, 250));
  const login = await fetch(`http://127.0.0.1:${PORT + 51}/login`).then((r) => r.text()).catch(() => "");
  okProd.kill();
  check("DEPLOY-2", "With a proper secret the production server starts, warns about what is still not production-ready (mail log transport, plain-HTTP cookie), and the login page shows NO demo account list",
    okLog.includes("running at") && /MAIL_TRANSPORT=log/.test(okLog) && /COOKIE_SECURE/.test(okLog) && login.includes("Sign in") && !login.includes("Demo accounts"), okLog.slice(0, 500));
  const bk = run("scripts/backup-db.mjs", [], { DB_NAME: DB });
  const file = (bk.stdout.match(/Backup written: (.+\.sql)/) || [])[1];
  const rt = file ? run("scripts/restore-test.mjs", [file], { DB_NAME: DB }) : { status: 1, stdout: "", stderr: bk.stderr };
  if (file) fs.rmSync(file, { force: true });
  check("DEPLOY-3", "Backup and restore are tested: backup-db writes a mysqldump file; restore-test restores it into a throwaway database, finds every table with the same row count and the audit-log triggers, then drops it",
    bk.status === 0 && rt.status === 0 && /Every table has the same number of rows/.test(rt.stdout) && /2 audit-log trigger/.test(rt.stdout) && /Dropped/.test(rt.stdout), `${bk.stdout} ${bk.stderr} ${rt.stdout} ${rt.stderr}`.slice(0, 800));

  // ================================================================ no sample anywhere; phone layout
  const gone = ["services/samples", "views/samples", "routes/samples.js", "controllers/sampleController.js", "views/partials/sample_banner.xian", "views/partials/sample_blocks.xian"].filter((f) => fs.existsSync(path.join(root, f)));
  const textHits = walk(path.join(root, "views")).concat(walk(path.join(root, "controllers")), walk(path.join(root, "services")), walk(path.join(root, "routes")))
    .filter((f) => /\.(xian|js)$/.test(f) && /Sample data|not yet connected|Coming Soon|services\/samples/i.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(root, f));
  check("NOSAMPLE-1", "Every sample screen and the sample machinery are deleted; no view, controller, service or route contains \"Sample data\", \"not yet connected\" or \"Coming Soon\"", gone.length === 0 && textHits.length === 0, `${gone} ${textHits}`);
  const roles = [["manager@johnvivz.test", "/crm/manager"], ["maria.santos@johnvivz.test", "/crm/team-leader"], ["kristine.bautista@johnvivz.test", "/crm/agent"], ["juan.cruz@johnvivz.test", "/portal"], ["admin@johnvivz.test", "/setup"]];
  const bad = [];
  const BAD = /\[object Object\]|\bundefined\b|\bNaN\b|\{\{|\}\}/;
  let pages = 0;
  for (const [email, home] of roles) {
    const c = await env.as(email);
    const h = (await c.get(home)).body;
    const links = [...new Set([home, ...[...(h.split('aria-label="Main"')[1] || "").split("</nav>")[0].matchAll(/<a href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"))])];
    for (const l of links) {
      const r = await c.get(l);
      pages += 1;
      const body = String(r.body);
      if (r.status !== 200 || body.includes("Sample data") || BAD.test(strip(body))) bad.push(`${email.split("@")[0]} ${l} ${r.status}`);
      if (body.includes("<table") && !/<table class="stack /.test(body)) bad.push(`${l}: a table without the phone layout`);
    }
  }
  check("PAGES-P10", `Per-role page check: every menu page of every role (${pages} pages) opens (200), shows no sample badge and no stray template text, and every table on them uses the phone layout (labelled cards)`, bad.length === 0, bad.join("; "));
  const tables = walk(path.join(root, "views")).filter((f) => f.endsWith(".xian")).flatMap((f) => fs.readFileSync(f, "utf8").match(/<table[^>]*>/g) || []);
  const layout = fs.readFileSync(path.join(root, "views", "partials", "layout_bottom.xian"), "utf8");
  check("PHONE-1", "Every table in every view (all 46) turns into labelled cards on phones: they all carry the stack class and the shared layout loads the stack style once", tables.length >= 40 && tables.every((t) => t.includes('class="stack ')) && layout.includes("{{> stack_table}}"), `${tables.length} ${tables.filter((t) => !t.includes("stack")).slice(0, 3)}`);

  // ================================================================ documents
  const doc = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : "");
  const guide = doc("docs/MERGE-GUIDE.md");
  const scen = doc("docs/MERGE-TEST-SCENARIOS.md");
  const dep = doc("docs/DEPLOYMENT.md");
  const diff = doc("docs/phase-reports/DIAGRAM-DIFFERENCES.md");
  const er = doc("docs/er-diagram.mmd");
  check("DOC-1", "MERGE-GUIDE.md is step by step: requirements (Node, MySQL/XAMPP, ports), one laptop and several laptops on one Wi-Fi (ipconfig, Windows firewall rule), the secrets to exchange, switching one adapter at a time and back, the three scripts, and a checklist per team",
    /ipconfig/i.test(guide) && /New-NetFirewallRule|firewall/i.test(guide) && /generate-secrets/.test(guide) && /check-connections/.test(guide) && /fake-teammates/.test(guide) && /INTEGRATION_HR_MODE=live/.test(guide) && /switch back|back to mock/i.test(guide) && /HR team checklist/i.test(guide) && /Inventory team checklist/i.test(guide) && /Accounting team checklist/i.test(guide) && /XAMPP/i.test(guide));
  check("DOC-2", "MERGE-TEST-SCENARIOS.md has the five end-to-end scenarios with steps, the screen in each system and the expected result",
    ["HR onboards", "Customer orders", "Refund", "leave request", "Duplicate event", "system down", "dead letter"].every((s) => scen.toLowerCase().includes(s.toLowerCase())) && (scen.match(/Expected/g) || []).length >= 5);
  check("DOC-3", "DEPLOYMENT.md covers the production .env, the refused seeder, no demo data, HTTPS cookies, backups and the restore test", /NODE_ENV=production/.test(dep) && /seed/.test(dep) && /SHOW_DEMO_LOGINS=false/.test(dep) && /COOKIE_SECURE=true/.test(dep) && /db:backup|backup-db/.test(dep) && /restore-test/.test(dep));
  check("DOC-4", "The ER diagram source is generated from the database (61 tables, foreign keys) and DIAGRAM-DIFFERENCES.md lists the differences from P2 to P10 in one place",
    er.startsWith("erDiagram") && (er.match(/ \{$/gm) || []).length >= 60 && /loyalty_redemptions/.test(er) && ["P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"].every((p) => diff.includes(`## ${p}`)), `${(er.match(/ \{$/gm) || []).length}`);
  check("DOC-5", "DEPLOYMENT.md explains how the first logins are created on a production database (create-first-accounts)", /create-first-accounts/.test(dep));

  // ================================================================ first logins on a fresh production database (runs last: it switches the demo admin and Manager off)
  const FIRST = "scripts/create-first-accounts.mjs";
  const refused = run(FIRST, ["--setup-admin", "it.admin@first.test", "--name", "IT Admin", "--manager", "MOCK-EMP-1001"]);
  await env.db.query("UPDATE crm_users SET is_active = 0 WHERE role IN ('system_admin', 'crm_manager')");
  // a test-only HR employee without a CRM login (as if loaded from live HR); it exists only in this throwaway database
  await env.db.query("INSERT INTO employee_references (employee_id, full_name, work_email, employment_status, source, is_mock, last_synced_at) VALUES ('TEST-P10-MGR', 'First Manager (test)', 'first.manager@first.test', 'active', 'johnvivz_hr', 0, NOW())");
  const emp = await env.one("SELECT employee_id, work_email FROM employee_references WHERE employee_id = 'TEST-P10-MGR'");
  const made = emp ? run(FIRST, ["--setup-admin", "it.admin@first.test", "--name", "IT Admin", "--manager", emp.employee_id]) : { status: 1, stdout: "no free employee", stderr: "" };
  const links = [...(made.stdout || "").matchAll(/https?:\/\/\S+\/reset-password\/\S+/g)].map((m) => m[0]);
  const rows = await env.all("SELECT role, user_type, is_demo, employee_id, password_hash FROM crm_users WHERE email IN ('it.admin@first.test', ?) ORDER BY role", [emp ? emp.work_email.toLowerCase() : ""]);
  const auditRows = await env.all("SELECT action, actor_user_id FROM crm_audit_logs WHERE action IN ('setup_admin_created', 'crm_access_granted') AND details LIKE '%command line%'");
  const linkPage = links[0] ? await (await env.client()).get(links[0].replace(/^https?:\/\/[^/]+/, "")) : { status: 0, body: "" };
  const again = run(FIRST, ["--setup-admin", "other@first.test"]);
  check("FIRST-1", "create-first-accounts makes the first setup administrator and the first CRM Manager (from an HR employee) only when none is active: no password is printed, each gets an unusable password and a one-time set-your-password link that opens, both are audited, and a second run is refused",
    refused.status === 1 && /already exists/.test(refused.stderr) && made.status === 0 && links.length === 2 && !/password:\s*\S/i.test(made.stdout) &&
    rows.length === 2 && rows.map((r) => r.role).join(",") === "crm_manager,system_admin" && rows.every((r) => Number(r.is_demo) === 0 && r.password_hash.startsWith("$2")) &&
    rows.find((r) => r.role === "crm_manager").employee_id === emp.employee_id && auditRows.length === 2 && auditRows.every((a) => a.actor_user_id === null) &&
    linkPage.status === 200 && again.status === 1 && /already exists/.test(again.stderr),
    `${refused.status} ${refused.stderr} | ${made.status} ${made.stdout} ${made.stderr} | ${rows.length} ${auditRows.length} ${linkPage.status} | ${again.stderr}`.slice(0, 900));
} finally {
  await fake.stop();
  await env.stop();
}
summarize(DB);
