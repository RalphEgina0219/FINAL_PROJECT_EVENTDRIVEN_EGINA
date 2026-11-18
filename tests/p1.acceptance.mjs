/*
 * JOHNVIVZ CRM — Phase P1 acceptance tests (automated).
 *   npm test
 * Uses a throwaway database (TEST_DB_NAME, default johnvivz_crm_test) that is created, migrated,
 * rolled back, migrated again, seeded, tested over HTTP and then DROPPED. It refuses to run against
 * johnvivz_crm_db or johnvivz_tech. Test ids (TC-xx) refer to docs/crm-alignment-report.md §7.
 */
import { spawn, spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile?.(path.join(root, ".env"));
const TEST_DB = process.env.TEST_DB_NAME || "johnvivz_crm_test";
if (!/^[a-z0-9_]+_test$/i.test(TEST_DB) || ["johnvivz_crm_db", "johnvivz_tech"].includes(TEST_DB.toLowerCase())) {
  console.error(`Refusing to use "${TEST_DB}": the test database name must end with _test.`);
  process.exit(1);
}
const PORT = Number(process.env.TEST_PORT || 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "Demo@1234";
const conn = { host: process.env.DB_HOST || "localhost", port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || "root", password: process.env.DB_PASSWORD || "" };
const childEnv = { ...process.env, DB_NAME: TEST_DB, PORT: String(PORT), LOGIN_RATE_LIMIT_MAX: "1000", DISABLE_SCHEDULER: "1", INTEGRATION_HR_MODE: "mock", SHOW_DEMO_LOGINS: "true" };

const results = [];
const check = (id, name, ok, detail = "") => {
  results.push({ id, name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✅" : "❌"} ${id.padEnd(7)} ${name}${!ok && detail ? `\n          → ${detail}` : ""}`);
};
const node = (args) => spawnSync(process.execPath, args, { cwd: root, env: childEnv, encoding: "utf8" });

// ---------------------------------------------------------------- tiny HTTP client with cookies + CSRF
class Client {
  constructor() { this.cookies = {}; this.csrf = null; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; "); }
  store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      this.cookies[pair.slice(0, i)] = pair.slice(i + 1);
    }
  }
  async get(url) {
    const res = await fetch(BASE + url, { headers: { cookie: this.cookieHeader() }, redirect: "manual" });
    this.store(res);
    const body = res.headers.get("content-type")?.includes("text/html") ? await res.text() : Buffer.from(await res.arrayBuffer());
    if (typeof body === "string") {
      const m = body.match(/name="_csrf" value="([a-f0-9]+)"/);
      if (m) this.csrf = m[1];
    }
    return { status: res.status, body, location: res.headers.get("location"), type: res.headers.get("content-type") || "" };
  }
  async post(url, data = {}, { csrf = true, multipart = null } = {}) {
    let body;
    const headers = { cookie: this.cookieHeader() };
    if (multipart) {
      body = new FormData();
      for (const [k, v] of Object.entries(data)) body.append(k, v);
      if (csrf) body.append("_csrf", this.csrf);
      for (const f of multipart) body.append("attachments", new Blob([f.bytes], { type: f.type }), f.name);
    } else {
      body = new URLSearchParams({ ...data, ...(csrf ? { _csrf: this.csrf } : {}) });
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetch(BASE + url, { method: "POST", headers, body, redirect: "manual" });
    this.store(res);
    return { status: res.status, location: res.headers.get("location"), body: await res.text() };
  }
  async login(email, password = PASSWORD) {
    await this.get("/login");
    return this.post("/login", { email, password });
  }
  async follow(r) { return r.location ? this.get(r.location) : r; }
}
const as = async (email) => { const c = new Client(); const r = await c.login(email); c.lastLogin = r; return c; };

// ---------------------------------------------------------------- setup
const db = await mysql.createConnection({ ...conn, multipleStatements: false });
await db.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
await db.query(`CREATE DATABASE \`${TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
console.log(`\nJOHNVIVZ CRM P1 acceptance tests — database ${TEST_DB}\n`);

let r = node(["migrate.js", "up", "--quiet"]);
const [[{ applied }]] = await db.query(`SELECT COUNT(*) AS applied FROM \`${TEST_DB}\`.migrations`);
check("MIG-01", "All CRM migrations apply on an empty database", r.status === 0 && Number(applied) >= 16, r.stderr || r.stdout);
r = node(["migrate.js", "rollback", "--quiet"]);
const [[{ left }]] = await db.query(`SELECT COUNT(*) AS \`left\` FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [TEST_DB]);
check("MIG-02", "Rollback removes every CRM table (only `migrations` remains)", r.status === 0 && Number(left) === 1, `${left} table(s) left`);
r = node(["migrate.js", "up", "--quiet"]);
const [[{ tables }]] = await db.query(`SELECT COUNT(*) AS tables FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [TEST_DB]);
check("MIG-03", "Migrations re-apply after rollback (59 tables + migrations, plus the 2 P6 tables and loyalty_redemptions (P8) = 62)", r.status === 0 && Number(tables) === 62, `${tables} tables`);

// Legacy guard: a database with the old 001–008 rows is never migrated.
const legacyDb = `${TEST_DB.replace(/_test$/, "")}_legacy_test`;
await db.query(`DROP DATABASE IF EXISTS \`${legacyDb}\``);
await db.query(`CREATE DATABASE \`${legacyDb}\``);
await db.query(`CREATE TABLE \`${legacyDb}\`.migrations (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) UNIQUE, batch INT, run_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
await db.query(`INSERT INTO \`${legacyDb}\`.migrations (name, batch) VALUES ('001_update_users_roles_and_status.js', 1)`);
r = spawnSync(process.execPath, ["migrate.js", "up", "--quiet"], { cwd: root, env: { ...childEnv, DB_NAME: legacyDb }, encoding: "utf8" });
const [[{ legacyTables }]] = await db.query(`SELECT COUNT(*) AS legacyTables FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [legacyDb]);
check("MIG-04", "Runner refuses a legacy JOHNVIVZ TECH database and changes nothing", r.status === 1 && Number(legacyTables) === 1, r.stderr);
await db.query(`DROP DATABASE IF EXISTS \`${legacyDb}\``);

await db.changeUser({ database: TEST_DB });
const one = async (sql, params = []) => (await db.query(sql, params))[0][0];
const all = async (sql, params = []) => (await db.query(sql, params))[0];

// ---------------------------------------------------------------- demo seed: exactly one account per role
const prod = spawnSync(process.execPath, ["seeders/index.js"], { cwd: root, env: { ...childEnv, NODE_ENV: "production" }, encoding: "utf8" });
const afterProd = await one("SELECT (SELECT COUNT(*) FROM crm_users) u, (SELECT COUNT(*) FROM crm_teams) t");
check("SEED-00", "Seeder refuses to run when NODE_ENV=production and writes nothing", prod.status === 1 && /production/.test(prod.stderr) && Number(afterProd.u) === 0 && Number(afterProd.t) === 0, prod.stderr);

r = node(["seeders/index.js"]);
check("SEED-01", "Seeder loads the mock HR fixture, logins, customers and cases", r.status === 0 && /Seeded/.test(r.stdout), r.stderr || r.stdout);

const DEMO_EMAILS = [
  "admin@johnvivz.test", "manager@johnvivz.test", "maria.santos@johnvivz.test", "kristine.bautista@johnvivz.test",
  "juan.cruz@johnvivz.test", "ana.delarosa@johnvivz.test", "liza.fernandez@johnvivz.test",
];
const roleCountsOf = (rows) => rows.reduce((m, x) => ({ ...m, [x.role]: (m[x.role] || 0) + 1 }), {});
const verifyDemoSeed = async (prefix) => {
  const logins = await all("SELECT email, role, is_demo FROM crm_users ORDER BY id");
  check(`${prefix}-02`, "Demo seed has exactly 7 logins (1 admin, 1 manager, 1 team leader, 1 agent, 3 customers), all is_demo = 1",
    JSON.stringify(logins.map((x) => x.email)) === JSON.stringify(DEMO_EMAILS) && logins.every((x) => x.is_demo === 1) &&
    JSON.stringify(roleCountsOf(logins)) === JSON.stringify({ system_admin: 1, crm_manager: 1, team_leader: 1, agent: 1, customer: 3 }),
    logins.map((x) => x.email).join(", "));
  const teams = await all("SELECT team_code, name FROM crm_teams");
  const emps = await all("SELECT employee_id, employment_status, is_mock FROM employee_references ORDER BY employee_id");
  check(`${prefix}-03`, "One team (Customer Care Team) and a mock HR fixture with only the 3 staff, flagged is_mock = 1",
    teams.length === 1 && teams[0].name === "Customer Care Team" && emps.length === 3 && emps.every((e) => e.is_mock === 1 && e.employment_status === "active"), JSON.stringify({ teams, emps }));
  const walkIns = await one("SELECT COUNT(*) n FROM customers c WHERE c.is_demo = 1 AND NOT EXISTS (SELECT 1 FROM customer_accounts ca WHERE ca.customer_id = c.id)");
  const custs = await one("SELECT COUNT(*) n FROM customers WHERE is_demo = 1");
  check(`${prefix}-04`, "2 walk-in customers exist as records WITHOUT logins (5 demo customers in total)", Number(walkIns.n) === 2 && Number(custs.n) === 5);
  const byStatus = await all("SELECT status, COUNT(*) n FROM customer_cases GROUP BY status ORDER BY status");
  const total = byStatus.reduce((s, x) => s + Number(x.n), 0);
  const levels = (await all("SELECT DISTINCT to_level FROM ticket_escalations ORDER BY to_level")).map((x) => x.to_level).join(",");
  const esc = (await all("SELECT DISTINCT escalation_level FROM customer_cases WHERE status = 'escalated' ORDER BY escalation_level")).map((x) => x.escalation_level).join(",");
  const rated = await one("SELECT COUNT(*) n FROM customer_ratings");
  const reopened = await one("SELECT COUNT(*) n FROM customer_cases WHERE reopen_count > 0");
  const spread = await one("SELECT COUNT(DISTINCT customer_id) cu, COUNT(DISTINCT assigned_agent_id) ag, SUM(is_demo = 0) nondemo FROM customer_cases");
  check(`${prefix}-05`, "Demo cases: 40, all 7 statuses, both escalation levels, ratings, a reopened case, 3 customers, 1 agent, all is_demo = 1",
    total === 40 && byStatus.length === 7 && levels === "1,2" && esc === "1,2" && Number(rated.n) > 0 && Number(reopened.n) >= 1 &&
    Number(spread.cu) === 3 && Number(spread.ag) === 1 && Number(spread.nondemo) === 0, JSON.stringify({ byStatus, levels, esc, spread }));
  return byStatus;
};
const seededStatuses = await verifyDemoSeed("SEED");
console.log("          cases per status: " + seededStatuses.map((x) => `${x.status}=${x.n}`).join(", "));

// Re-seeding: `--reset` removes ONLY demo rows (a real, non-demo customer survives) and loads the same data again.
await db.query("INSERT INTO customers (customer_id, customer_no, first_name, last_name, source, is_demo) VALUES (UUID(), 'CUS-009999', 'Real', 'Customer', 'walk_in', 0)");
r = node(["seeders/index.js", "--reset"]);
const realLeft = await one("SELECT COUNT(*) n FROM customers WHERE customer_no = 'CUS-009999' AND is_demo = 0");
check("RESET-01", "seed --reset removes and reloads only demo rows (the real customer is untouched)", r.status === 0 && Number(realLeft.n) === 1, r.stderr || r.stdout);
await verifyDemoSeed("RESET");
await db.query("DELETE FROM customers WHERE customer_no = 'CUS-009999'");

// Extra people for the access tests are created here, not by the demo seed.
r = node(["tests/support/p1Fixtures.mjs"]);
check("FIX-01", "Test fixtures created (second team, second agent, separated HR employee, two routed cases)", r.status === 0, r.stderr || r.stdout);
const fix = JSON.parse(r.stdout.trim().split("\n").pop());

const server = spawn(process.execPath, ["index.js"], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
for (let i = 0; i < 160 && !serverLog.includes("running at") && server.exitCode === null; i++) await new Promise((res) => setTimeout(res, 250));
if (!serverLog.includes("running at")) { console.error("SERVER LOG >>>", serverLog, "<<< exit", server.exitCode); await db.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``); throw new Error("Server did not start"); }

try {
  // ---------------------------------------------------------------- data facts used below
  const users = Object.fromEntries((await all("SELECT id, email, role, team_id FROM crm_users")).map((u) => [u.email, u]));
  const caseOf = (where, params = []) => one(`SELECT * FROM customer_cases WHERE ${where} ORDER BY id LIMIT 1`, params);
  const kristine = users["kristine.bautista@johnvivz.test"];
  const patricia = users["patricia.lim@johnvivz.test"];
  const team2CaseRow = await caseOf("id = ?", [fix.team2Case]);
  const team1 = kristine.team_id;

  // ---------------------------------------------------------------- data rules
  const counts = await one(`SELECT (SELECT COUNT(*) FROM employee_references) e, (SELECT COUNT(*) FROM employee_references WHERE is_mock = 1) m,
    (SELECT COUNT(*) FROM customers) c, (SELECT COUNT(DISTINCT customer_id) FROM customers) cu,
    (SELECT COUNT(*) FROM customers WHERE customer_id NOT REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') bad`);
  check("TC-18", "Every HR reference from the fixture is flagged is_mock = 1", counts.e > 0 && counts.e === counts.m);
  check("TC-24", "customer_id is a unique UUID v4 for every customer", counts.c === counts.cu && Number(counts.bad) === 0);
  const statuses = (await all("SELECT DISTINCT status FROM customer_cases")).map((s) => s.status).sort().join(",");
  check("DATA-01", "Seed covers all 7 case statuses", statuses === "assigned,closed,escalated,in_progress,open,resolved,waiting_for_customer", statuses);
  const caseNo = await one("SELECT COUNT(*) n FROM customer_cases WHERE case_no NOT REGEXP '^JVT-[0-9]{8}-[0-9]{4}$'");
  check("DATA-02", "Case numbers follow JVT-YYYYMMDD-0001", Number(caseNo.n) === 0);

  let auditBlocked = 0;
  await db.query("INSERT INTO crm_audit_logs (action, details) VALUES ('test_probe', 'original')");
  try { await db.query("UPDATE crm_audit_logs SET details = 'tampered' WHERE action = 'test_probe'"); } catch (e) { if (/append-only/.test(e.message)) auditBlocked++; }
  try { await db.query("DELETE FROM crm_audit_logs WHERE action = 'test_probe'"); } catch (e) { if (/append-only/.test(e.message)) auditBlocked++; }
  const probe = await one("SELECT details FROM crm_audit_logs WHERE action = 'test_probe'");
  check("TC-21", "crm_audit_logs rejects UPDATE and DELETE (triggers); the row is unchanged", auditBlocked === 2 && probe?.details === "original", `${auditBlocked}/2 blocked`);
  let checkBlocked = false;
  try { await db.query("INSERT INTO crm_users (user_type, role, email, password_hash, display_name) VALUES ('staff','agent','nohr@x.test','x','No HR')"); } catch { checkBlocked = true; }
  check("DATA-03", "A staff login without an HR employee_id is rejected by the database", checkBlocked);

  // ---------------------------------------------------------------- login + dashboards
  const roleHome = {
    "admin@johnvivz.test": "/setup", "manager@johnvivz.test": "/crm/manager", "maria.santos@johnvivz.test": "/crm/team-leader",
    "kristine.bautista@johnvivz.test": "/crm/agent", "juan.cruz@johnvivz.test": "/portal",
  };
  const clients = {};
  for (const [email, home] of Object.entries(roleHome)) {
    const c = await as(email);
    clients[email] = c;
    const page = await c.get(home);
    check("AUTH-01", `${email} signs in and lands on ${home}`, c.lastLogin.status === 302 && c.lastLogin.location === home && page.status === 200, `${c.lastLogin.status} → ${c.lastLogin.location}, page ${page.status}`);
  }
  const mgr = clients["manager@johnvivz.test"];
  const tl = clients["maria.santos@johnvivz.test"];
  const agent = clients["kristine.bautista@johnvivz.test"];
  const juan = clients["juan.cruz@johnvivz.test"];
  const setup = clients["admin@johnvivz.test"];

  const loginPage = await new Client().get("/login");
  const boxEmails = [...loginPage.body.matchAll(/data-email="([^"]+)"/g)].map((m) => m[1]);
  check("LOGIN-01", "Login page \"Demo accounts\" box shows exactly the 7 demo accounts (no fixtures, no walk-ins)",
    JSON.stringify(boxEmails) === JSON.stringify(DEMO_EMAILS) && !loginPage.body.includes("joseph.villanueva") && !loginPage.body.includes("edwin.sarmiento"), boxEmails.join(", "));

  // Supplement E menus, exact order; every enabled item opens a working page; "Soon" items are not links.
  const NAV = {
    "manager@johnvivz.test": ["CRM Overview", "Customer Directory", "Sales &amp; Orders", "Customer Service", "Campaigns / Promotions", "Team Performance", "Analytics", "Escalations", "Reports", "Settings"],
    "maria.santos@johnvivz.test": ["Team Overview", "Agent Assignments", "Customer Queue", "Cases &amp; Complaints", "Follow-ups", "Orders", "Team Reports"],
    "kristine.bautista@johnvivz.test": ["My Dashboard", "Customers", "Interactions", "Inquiries", "Cases", "Orders / Sales", "Follow-up Tasks", "Notifications"],
    "juan.cruz@johnvivz.test": ["My Profile", "My Orders", "Order Tracking", "Submit Inquiry", "Complaint / Feedback", "Notifications"],
  };
  for (const [email, expected] of Object.entries(NAV)) {
    const c = clients[email];
    const page = await c.get(roleHome[email]);
    const nav = page.body.split('aria-label="Main"')[1].split("</nav>")[0];
    const labels = [...nav.matchAll(/<span class="flex-1">([^<]+)<\/span>/g)].map((m) => m[1]);
    check("TC-NAV", `Menu for ${email} matches supplement E exactly`, JSON.stringify(labels) === JSON.stringify(expected), labels.join(" | "));
    const links = [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    const bad = [];
    for (const href of links) { const p = await c.get(href); if (p.status !== 200) bad.push(`${href} → ${p.status}`); }
    const soonLinks = [...nav.matchAll(/aria-disabled="true"/g)].length;
    check("TC-NAV", `Every menu link for ${email} opens (${links.length} links, ${soonLinks} Coming Soon items are not links)`, bad.length === 0, bad.join(", "));
  }

  // ---------------------------------------------------------------- record-level access
  const patriciaCase = team2CaseRow;
  let p = await agent.get(`/crm/cases/${patriciaCase.id}`);
  const agentList = await agent.get(`/crm/cases?q=${patriciaCase.case_no}`);
  check("TC-01", "Agent cannot open or list a case assigned to another agent", p.status === 404 && !agentList.body.includes(`>${patriciaCase.case_no}<`), `status ${p.status}`);
  const team2Case = await caseOf("id = ?", [fix.team2Case]);
  const team1Case = await caseOf("id = ?", [fix.team1Case]);
  const a = await tl.get(`/crm/cases/${team2Case.id}`);
  const b = await tl.get(`/crm/cases/${team1Case.id}`);
  check("TC-02", "Team Leader sees own-team cases but not another team's", a.status === 404 && b.status === 200, `other team ${a.status}, own team ${b.status}`);

  // Customer upload, then another customer tries to read it.
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  await juan.get("/portal/cases/new");
  const cat = await one("SELECT id FROM case_categories WHERE is_active = 1 ORDER BY id LIMIT 1");
  const created = await juan.post("/portal/cases", {
    case_type: "complaint", category_id: String(cat.id), priority: "high", subject: "Test: crushed bread in delivery",
    description: "The bread was crushed when the rider delivered it this morning.", order_reference: "ORD-TEST-1",
  }, { multipart: [{ name: "photo.png", type: "image/png", bytes: png }] });
  const newCase = await one("SELECT * FROM customer_cases WHERE subject = 'Test: crushed bread in delivery'");
  const att = newCase ? await one("SELECT id FROM attachments WHERE case_id = ?", [newCase.id]) : null;
  check("CASE-01", "Customer submits a case with an attachment (JVT number, status Open, unrouted)",
    created.status === 302 && newCase && /^JVT-\d{8}-\d{4}$/.test(newCase.case_no) && newCase.status === "open" && newCase.team_id === null && att, `status ${created.status}`);
  const ana = await as("ana.delarosa@johnvivz.test");
  const x1 = await ana.get(`/portal/cases/${newCase.id}`);
  const x2 = await ana.get(`/attachments/${att.id}`);
  const x3 = await juan.get(`/attachments/${att.id}`);
  check("TC-03", "Customer cannot open another customer's case or attachment (owner can)", x1.status === 404 && x2.status === 404 && x3.status === 200, `case ${x1.status}, file ${x2.status}, owner ${x3.status}`);

  // ---------------------------------------------------------------- forged requests are refused and audited
  await agent.get(`/crm/cases/${team1Case.id}`);
  const forged = await agent.post(`/crm/cases/${team1Case.id}/assign`, { agent_id: String(kristine.id) });
  const denied = await one("SELECT COUNT(*) n FROM crm_audit_logs WHERE action = 'access_denied' AND outcome = 'denied' AND actor_user_id = ?", [kristine.id]);
  check("TC-04", "Agent's forged POST to assign is refused (403) and written to the audit log", forged.status === 403 && Number(denied.n) >= 1, `status ${forged.status}`);
  const cust403 = await juan.get("/crm/manager");
  const setup403 = await setup.get("/crm/cases");
  check("TC-04b", "Customer cannot open a staff dashboard; setup admin cannot open cases", cust403.status === 403 && setup403.status === 403, `${cust403.status}/${setup403.status}`);
  const otherTeamAgent = patricia;
  await tl.get(`/crm/cases/${team1Case.id}`);
  const tlAssign = await tl.post(`/crm/cases/${team1Case.id}/assign`, { agent_id: String(otherTeamAgent.id) });
  check("TC-04c", "Team Leader cannot assign an agent from another team", tlAssign.status === 403, `status ${tlAssign.status}`);
  const noCsrf = await mgr.post("/crm/settings", { auto_close_days: "3" }, { csrf: false });
  check("SEC-01", "POST without a CSRF token is refused", noCsrf.status === 403);

  // ---------------------------------------------------------------- queue and assignment
  const q = await tl.get("/crm/queue");
  check("CASE-02", "New portal case appears in the Team Leader's Customer Queue", q.body.includes(newCase.case_no));
  await tl.get(`/crm/cases/${newCase.id}`);
  await tl.post(`/crm/cases/${newCase.id}/assign`, { agent_id: String(kristine.id), note: "Test assignment" });
  const afterAssign = await one("SELECT status, team_id, assigned_agent_id FROM customer_cases WHERE id = ?", [newCase.id]);
  check("CASE-03", "Assignment by the Team Leader sets agent, team and status Assigned", afterAssign.status === "assigned" && afterAssign.assigned_agent_id === kristine.id && afterAssign.team_id === team1, JSON.stringify(afterAssign));

  // ---------------------------------------------------------------- status flow
  await agent.get(`/crm/cases/${newCase.id}`);
  await agent.post(`/crm/cases/${newCase.id}/status`, { status: "resolved" });
  const stillAssigned = await one("SELECT status FROM customer_cases WHERE id = ?", [newCase.id]);
  check("TC-10", "Invalid jump (Assigned → Resolved) is rejected by the server", stillAssigned.status === "assigned", stillAssigned.status);
  await agent.post(`/crm/cases/${newCase.id}/status`, { status: "in_progress" });
  await agent.post(`/crm/cases/${newCase.id}/comments`, { message: "Hello Juan, please send a photo of the receipt." }, { multipart: [] });
  await agent.post(`/crm/cases/${newCase.id}/status`, { status: "waiting_for_customer" });
  await juan.get(`/portal/cases/${newCase.id}`);
  await juan.post(`/portal/cases/${newCase.id}/comments`, { message: "Here is the receipt number OR-12345." }, { multipart: [] });
  const backInProgress = await one("SELECT status, first_response_at FROM customer_cases WHERE id = ?", [newCase.id]);
  check("CASE-04", "Agent reply sets first response; customer reply moves Waiting for Customer → In Progress", backInProgress.status === "in_progress" && backInProgress.first_response_at, backInProgress.status);

  // ---------------------------------------------------------------- escalation chain
  await agent.get(`/crm/cases/${newCase.id}`);
  await agent.post(`/crm/cases/${newCase.id}/escalate`, { reason: "Refund above my limit" });
  await tl.get(`/crm/cases/${newCase.id}`);
  await tl.post(`/crm/cases/${newCase.id}/escalate`, { reason: "Needs CRM Manager approval" });
  const esc = await all("SELECT from_level, to_level, escalated_by, escalated_to, reason, outcome FROM ticket_escalations WHERE case_id = ? ORDER BY id", [newCase.id]);
  const escCase = await one("SELECT status, escalation_level FROM customer_cases WHERE id = ?", [newCase.id]);
  check("TC-09", "Agent → Team Leader → CRM Manager: two escalation rows with actor, reason, target",
    esc.length === 2 && esc[0].to_level === 1 && esc[0].escalated_to === users["maria.santos@johnvivz.test"].id && esc[1].to_level === 2 &&
    esc[1].escalated_to === users["manager@johnvivz.test"].id && escCase.status === "escalated" && escCase.escalation_level === 2, JSON.stringify(esc));
  await agent.get(`/crm/cases/${newCase.id}`);
  const agentReply = await agent.post(`/crm/cases/${newCase.id}/comments`, { message: "Public reply while escalated" }, { multipart: [] });
  const agentNote = await agent.post(`/crm/cases/${newCase.id}/comments`, { message: "Internal note while escalated", internal: "1" }, { multipart: [] });
  check("TC-09b", "While escalated, the agent cannot reply publicly but can add an internal note", agentReply.status === 403 && agentNote.status === 302, `${agentReply.status}/${agentNote.status}`);
  const tlAct = await tl.post(`/crm/cases/${newCase.id}/escalation`, { action: "take_over" });
  check("TC-09c", "Team Leader cannot act on a level-2 escalation", tlAct.status === 403, `status ${tlAct.status}`);
  await mgr.get(`/crm/cases/${newCase.id}`);
  await mgr.post(`/crm/cases/${newCase.id}/escalation`, { action: "resolve", note: "Refund approved by the CRM Manager" });
  const resolved = await one("SELECT status, resolved_at FROM customer_cases WHERE id = ?", [newCase.id]);
  check("CASE-05", "CRM Manager resolves the level-2 escalation", resolved.status === "resolved" && resolved.resolved_at);

  // ---------------------------------------------------------------- customer confirm + rating
  await juan.get(`/portal/cases/${newCase.id}`);
  await juan.post(`/portal/cases/${newCase.id}/rating`, { rating: "5", comment: "Thank you!" });
  const dup = await juan.post(`/portal/cases/${newCase.id}/rating`, { rating: "1" });
  const ratings = await one("SELECT COUNT(*) n FROM customer_ratings WHERE case_id = ?", [newCase.id]);
  const fb = await one("SELECT COUNT(*) n FROM customer_feedback WHERE case_id = ?", [newCase.id]);
  check("CASE-06", "Customer rates a resolved case once (rating + feedback rows)", Number(ratings.n) === 1 && Number(fb.n) === 1 && dup.status === 302);
  await juan.post(`/portal/cases/${newCase.id}/status`, { status: "closed", note: "Customer confirmed the solution" });
  check("CASE-07", "Customer confirms and closes the case", (await one("SELECT status FROM customer_cases WHERE id = ?", [newCase.id])).status === "closed");

  // ---------------------------------------------------------------- HR access removal (mock mode)
  const ramon = await as("ramon.aquino@johnvivz.test");
  const before = await ramon.get("/crm/agent");
  await setup.get("/setup/staff");
  await setup.post("/setup/staff/hr-status", { employee_id: "MOCK-EMP-T003", status: "separated" });
  const afterHr = await ramon.get("/crm/agent");
  const relog = await new Client().login("ramon.aquino@johnvivz.test");
  check("TC-05", "HR status 'separated' ends the agent's open session and blocks sign-in (mock mode)",
    before.status === 200 && afterHr.status === 302 && afterHr.location === "/login" && relog.status === 403 && /separated/i.test(relog.body),
    `before ${before.status}, after ${afterHr.status}, relogin ${relog.status}`);
  await setup.post("/setup/staff/hr-status", { employee_id: "MOCK-EMP-T003", status: "active" });
  const back = await new Client().login("ramon.aquino@johnvivz.test");
  check("TC-05b", "HR reactivation lifts the HR block (sign-in works again)", back.status === 302, `status ${back.status}`);
  const edwin = await new Client().login("edwin.sarmiento@johnvivz.test");
  check("TC-05c", "A separated HR employee (fixture) cannot sign in", edwin.status === 403);
  const hrAudit = await one("SELECT COUNT(*) n FROM crm_audit_logs WHERE action = 'hr_employment_status_applied'");
  check("TC-06*", "HR status changes are recorded with before/after values (mock-mode part of TC-05/06)", Number(hrAudit.n) === 2);

  // ---------------------------------------------------------------- registration, consent, masking
  const reg = new Client();
  await reg.get("/register");
  const noConsent = await reg.post("/register", { first_name: "Test", last_name: "Customer", email: "new.customer@example.test", mobile: "0917 000 1111", password: "Secret@123", confirm_password: "Secret@123" });
  const regOk = await reg.post("/register", { first_name: "Test", last_name: "Customer", email: "new.customer@example.test", mobile: "0917 000 1111", address: "Calapan", password: "Secret@123", confirm_password: "Secret@123", consent: "1" });
  const regRows = await one(`SELECT c.customer_no, c.customer_id, ca.status, u.role,
      (SELECT COUNT(*) FROM customer_consents cc WHERE cc.customer_id = c.id) consents
    FROM customers c JOIN customer_accounts ca ON ca.customer_id = c.id JOIN crm_users u ON u.id = ca.user_id WHERE u.email = 'new.customer@example.test'`);
  check("TC-08a", "Registration needs consent; then creates customer + login + account + 2 consents in one go",
    noConsent.status === 422 && regOk.status === 200 && regRows && regRows.role === "customer" && Number(regRows.consents) === 2 && /^CUS-\d{6}$/.test(regRows.customer_no), JSON.stringify(regRows));
  const dir = await mgr.get("/crm/customers?q=juan");
  check("TC-08b", "Customer Directory masks email and mobile", dir.body.includes("j***@johnvivz.test") && !dir.body.includes("juan.cruz@johnvivz.test") && dir.body.includes("0917 *** 0101"));
  const agentDir = await agent.get("/crm/customers");
  const mgrDir = await mgr.get("/crm/customers");
  const totalOf = (h) => Number((h.match(/of (\d+)<\/span>/) || h.match(/(\d+) of/) || [0, 0])[1]);
  const agentCount = (agentDir.body.match(/href="\/crm\/customers\/\d+"/g) || []).length;
  const mgrCount = (mgrDir.body.match(/href="\/crm\/customers\/\d+"/g) || []).length;
  check("TC-08c", "Agent's customer list is limited to own customers", agentCount > 0 && agentCount < mgrCount, `agent ${agentCount}, manager ${mgrCount} (${totalOf(mgrDir.body)})`);

  // ---------------------------------------------------------------- manager is not view-only; setup admin audited
  await mgr.get("/crm/settings");
  const save = await mgr.post("/crm/settings", {
    auto_close_days: "4", reopen_window_days: "7",
    sla_first_response_hours_urgent: "1", sla_resolution_hours_urgent: "4", sla_first_response_hours_high: "4", sla_resolution_hours_high: "24",
    sla_first_response_hours_medium: "8", sla_resolution_hours_medium: "48", sla_first_response_hours_low: "24", sla_resolution_hours_low: "72",
  });
  const setAudit = await one("SELECT before_values, after_values FROM crm_audit_logs WHERE action = 'settings_updated' ORDER BY id DESC LIMIT 1");
  check("ROLE-01", "CRM Manager can change settings (not view-only); before/after are audited",
    save.status === 302 && setAudit && setAudit.before_values?.auto_close_days === 3 && setAudit.after_values?.auto_close_days === 4, JSON.stringify(setAudit));
  await setup.get("/setup/categories");
  await setup.post("/setup/categories", { name: "Test Setup Category", description: "added by test", default_priority: "low" });
  const setupAudit = await one("SELECT COUNT(*) n FROM crm_audit_logs WHERE action = 'setup_admin_request' AND actor_user_id = ?", [users["admin@johnvivz.test"].id]);
  const catAudit = await one("SELECT COUNT(*) n FROM crm_audit_logs WHERE action = 'category_created'");
  check("ROLE-02", "Every setup System Administrator change is audited", Number(setupAudit.n) >= 2 && Number(catAudit.n) === 1, `${setupAudit.n} request rows`);
  const auditPage = await mgr.get("/crm/settings/audit-logs?outcome=denied");
  check("ROLE-03", "Audit Log page (Manager › Settings) lists denied attempts", auditPage.status === 200 && auditPage.body.includes("access_denied"));

  // ---------------------------------------------------------------- reports and exports
  const pdf = await mgr.get("/crm/reports/export/pdf");
  const xlsx = await mgr.get("/crm/reports/export/xlsx");
  const csv = await tl.get("/crm/reports/export/csv");
  check("REP-01", "Exports: PDF, Excel (Manager) and CSV (Team Leader)",
    pdf.status === 200 && pdf.type.includes("pdf") && xlsx.status === 200 && xlsx.type.includes("spreadsheet") && csv.status === 200 && csv.type.includes("csv"),
    `${pdf.status} ${pdf.type} / ${xlsx.status} / ${csv.status}`);
  const csvText = csv.body.toString("utf8");
  const team2Agent = await one("SELECT display_name FROM crm_users WHERE id = ?", [patricia.id]);
  check("REP-02", "Team Leader's export contains only the own team's agents", !csvText.includes(team2Agent.display_name));
  const agentReport = await agent.get("/crm/reports");
  check("REP-03", "Agents cannot open reports", agentReport.status === 403);
} finally {
  server.kill();
  await db.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await db.end();
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Test database ${TEST_DB} was dropped.`);
if (failed.length) {
  console.log("Server log tail:\n" + serverLog.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
}
