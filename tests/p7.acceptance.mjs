/*
 * JOHNVIVZ CRM — Phase P7 (employee request approvals) acceptance tests.
 *   npm run test:p7        (npm test runs it last)
 * Throwaway database johnvivz_crm_p7_test; people beyond the 7 demo accounts come from tests/support/p1Fixtures.mjs or are created below.
 * The CRM runs in three shapes against the same database:
 *   main      HR MOCK, APPROVALS_ENABLED=true   requests come from the setup "Mock ESS" (same inbox and code as a signed request)
 *   disabled  HR LIVE (fake HR), APPROVALS_ENABLED=false   the feature is off: clear message, requests are kept as "ignored"
 *   live      HR LIVE (fake HR), APPROVALS_ENABLED=true    signed requests through the P6 inbox; decisions delivered to the fake HR
 * The fake HR (tests/support/fakeApps.mjs) is a CONTRACT test double, never the real HR/ESS: nothing here is "verified live".
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { check, startEnvironment, summarize, Client, root } from "./support/harness.mjs";
import { startFakeApps, offsetNow } from "./support/fakeApps.mjs";
import { checkEnvelope } from "./support/contractSchemas.mjs";
import { PAGES, widgetsFor } from "./support/noSamples.mjs";
import * as sampleData from "./support/noSamples.mjs";

const DB = process.env.TEST_P7_DB_NAME || "johnvivz_crm_p7_test";
const PORT = Number(process.env.TEST_P7_PORT || 3203);
const PORT_X = PORT + 100; // the extra server (disabled, then live)
const uuid = () => crypto.randomUUID();
const secret = () => crypto.randomBytes(16).toString("hex");
const secrets = { hr: { out: secret(), in: secret() }, inventory: { out: secret(), in: secret() }, accounting: { out: secret(), in: secret() } };
const fake = await startFakeApps({ secrets, crmBase: `http://127.0.0.1:${PORT_X}` });
const liveHr = {
  INTEGRATION_HR_MODE: "live", HR_API_BASE_URL: fake.hr.baseUrl, JVZ_SECRET_HR: secrets.hr.out, JVZ_CRM_INBOUND_SECRET_HR: secrets.hr.in,
  INTEGRATION_INVENTORY_MODE: "mock", INTEGRATION_ACCOUNTING_MODE: "mock",
};
const env = await startEnvironment({ dbName: DB, port: PORT, serverEnv: { APPROVALS_ENABLED: "true" } });
console.log(`\nJOHNVIVZ CRM P7 tests — database ${DB}\n`);
check("ENV-01", "Migrations (101–118), demo seed and fixtures load; the server starts with APPROVALS_ENABLED=true", env.steps.migrate.status === 0 && env.steps.seed.status === 0 && env.steps.fixtures.status === 0 && env.up,
  env.steps.migrate.stderr || env.steps.seed.stderr || env.steps.fixtures.stderr || env.serverLog());

const { all, one, db, as } = env;
const decode = (s) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const alerts = (html) => [...html.matchAll(/role="(?:alert|status)">.*?<span>([^<]*)<\/span>/gs)].map((m) => decode(m[1]));
const flashAfter = async (client, p) => alerts((await client.get(p)).body).join(" | ");
const auditRows = (action, extra = "", params = []) => all(`SELECT * FROM crm_audit_logs WHERE action = ? ${extra} ORDER BY id`, [action, ...params]);
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const reqRow = (requestId) => one("SELECT * FROM approval_requests WHERE request_id = ?", [requestId]);
const latestMock = () => one("SELECT * FROM approval_requests WHERE request_id LIKE 'MOCK-REQ-%' ORDER BY id DESC LIMIT 1");
const decisionEvents = (requestId) => all("SELECT * FROM integration_outbox WHERE event_type = 'EmployeeRequestDecided' AND entity_id = ? ORDER BY id", [requestId]);
const envelopeOf = (row) => (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload);

const startExtra = async (extraEnv) => {
  const e = { ...env.env, PORT: String(PORT_X), APP_URL: `http://127.0.0.1:${PORT_X}`, DISABLE_SCHEDULER: "1", ...liveHr, ...extraEnv };
  const server = spawn(process.execPath, ["index.js"], { cwd: root, env: e, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 120 && !log.includes("running at") && server.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250));
  const stop = () => new Promise((resolve) => { server.once("exit", resolve); server.kill(); setTimeout(resolve, 2000); });
  return { base: `http://127.0.0.1:${PORT_X}`, stop, up: log.includes("running at"), log: () => log };
};
const loginAt = async (base, email) => { const c = new Client(base); await c.login(email); return c; };
const sendHr = (type, data, { id = uuid(), idem = null } = {}) => {
  const envelope = { event_id: id, event_type: type, schema_version: 1, source: "johnvivz_hr", occurred_at: offsetNow(), entity_id: String(data.request_id || data.employee_id || "x"), correlation_id: uuid(), idempotency_key: idem || `${type}:${data.request_id || uuid()}`, data };
  return fake.hr.sendToCrm(envelope).then((r) => ({ ...r, envelope }));
};

let extra = null;
try {
  const u = (email) => one("SELECT id, team_id, employee_id, role FROM crm_users WHERE email = ?", [email]);
  const kristine = await u("kristine.bautista@johnvivz.test");
  const maria = await u("maria.santos@johnvivz.test");
  const manager = await u("manager@johnvivz.test");
  const joseph = await u("joseph.villanueva@johnvivz.test");
  const patricia = await u("patricia.lim@johnvivz.test");
  const ramon = await u("ramon.aquino@johnvivz.test");
  const agent = await as("kristine.bautista@johnvivz.test");
  let tl = await as("maria.santos@johnvivz.test");
  const tl2 = await as("joseph.villanueva@johnvivz.test");
  const mgr = await as("manager@johnvivz.test");
  const setup = await as("admin@johnvivz.test");
  const juanC = await as("juan.cruz@johnvivz.test");
  const hashOf = (await one("SELECT password_hash h FROM crm_users WHERE email = 'kristine.bautista@johnvivz.test'")).h;

  // ================================================================ migration, flag, seed, permissions
  const mig = fs.readFileSync(path.join(root, "migrations", "118_p7_approvals.js"), "utf8");
  const perm = await all("SELECT r.code FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id JOIN roles r ON r.id = rp.role_id WHERE p.code = 'approvals.exceptions'");
  const decideRoles = (await all("SELECT r.code FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id JOIN roles r ON r.id = rp.role_id WHERE p.code = 'approvals.decide' ORDER BY r.code")).map((r) => r.code).join(",");
  check("MIG-2", "Migration 118 only inserts one permission row (no CREATE or ALTER of any table); approvals.exceptions belongs to the CRM Manager only; approvals.decide to Team Leader and Manager",
    !/(CREATE|ALTER|DROP)\s+TABLE/i.test(mig) && perm.length === 1 && perm[0].code === "crm_manager" && decideRoles === "crm_manager,team_leader", `${perm.map((r) => r.code)} ${decideRoles}`);
  const envFile = fs.readFileSync(path.join(root, ".env"), "utf8");
  const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const probe = env.node(["--input-type=module", "-e", "const { config } = await import('./config/index.js'); console.log('FLAG ' + config.features.approvalsEnabled);"], { APPROVALS_ENABLED: "" });
  check("FLAG-1", "APPROVALS_ENABLED defaults to false: .env.example and the local .env say false, and an unset value is false", /^APPROVALS_ENABLED=false\s*$/m.test(example) && /^APPROVALS_ENABLED=false\s*$/m.test(envFile) && /FLAG false/.test(probe.stdout), probe.stdout + probe.stderr.slice(0, 200));
  const demo = await all("SELECT request_id, status, approver_role, is_mock FROM approval_requests WHERE request_id LIKE 'DEMO-REQ-%' ORDER BY request_id");
  const demoEvents = await all("SELECT status, is_mock, attempts FROM integration_outbox WHERE event_type = 'EmployeeRequestDecided'");
  check("SEED-7", "Demo seed: still exactly 7 accounts; 7 demo requests from the MOCK ESS (3 pending, 1 approved, 1 rejected, 2 exceptions), every one flagged mock, and their 2 decision events are mock and unsent",
    Number((await one("SELECT COUNT(*) n FROM crm_users WHERE is_demo = 1")).n) === 7 && demo.length === 7 && demo.filter((d) => d.status === "pending").length === 3 && demo.filter((d) => d.status === "approved").length === 1 && demo.filter((d) => d.status === "rejected").length === 1 &&
    demo.filter((d) => d.status === "exception").length === 2 && demo.every((d) => d.is_mock === 1) && demoEvents.length === 2 && demoEvents.every((e) => e.is_mock === 1 && e.status === "mock_delivered" && e.attempts === 0), JSON.stringify(demo));

  // ================================================================ the feature switch: OFF
  extra = await startExtra({ APPROVALS_ENABLED: "false" });
  const sendOff = await sendHr("EmployeeRequestSubmitted", { request_id: "HR-REQ-OFF-1", request_type: "leave", employee_id: kristine.employee_id, leave_type: "Vacation leave", start_date: day(14), end_date: day(15), days: 2, reason: "Family event" });
  const offInbox = await one("SELECT * FROM integration_inbox WHERE event_id = ?", [sendOff.envelope.event_id]);
  const mgrOff = await loginAt(extra.base, "manager@johnvivz.test");
  const tlOff = await loginAt(extra.base, "maria.santos@johnvivz.test");
  const agentOff = await loginAt(extra.base, "kristine.bautista@johnvivz.test");
  const pagesOff = [await mgrOff.get("/crm/approvals"), await tlOff.get("/crm/approvals"), await mgrOff.get("/crm/approvals/1"), await tlOff.get("/crm/approvals/1"), await mgrOff.get("/crm/approvals?view=exceptions")];
  const demoId = (await reqRow("DEMO-REQ-0001")).id;
  const postOff = await tlOff.post(`/crm/approvals/${demoId}/decide`, { decision: "approve", comment: "should not work" });
  const mgrDash = (await mgrOff.get("/crm/manager")).body;
  const tlDash = (await tlOff.get("/crm/team-leader")).body;
  const setupOff = await (await loginAt(extra.base, "admin@johnvivz.test")).get("/setup/approvals");
  check("OFF-1", "Feature OFF: the Approvals Queue says \"Approvals are not enabled yet\" (list, detail URL, every view) for the Manager and the Team Leader, shows NO requests and no sample data; a decision POST changes nothing; the Agent still gets 403",
    pagesOff.every((r) => r.status === 200 && r.body.includes("Approvals are not enabled yet") && r.body.includes('data-approvals-disabled="1"') && !r.body.includes("DEMO-REQ") && !r.body.includes("REQ-SAMPLE") && !r.body.includes("Sample data")) &&
    postOff.status === 302 && (await reqRow("DEMO-REQ-0001")).status === "pending" && (await agentOff.get("/crm/approvals")).status === 403, pagesOff.map((r) => r.status).join(","));
  check("OFF-2", "Feature OFF: a signed EmployeeRequestSubmitted from HR is accepted (202) and kept in the inbox as 'ignored' with a clear note; nothing is routed (no request row, no notification)",
    sendOff.status === 202 && offInbox.status === "ignored" && /not enabled/.test(offInbox.last_error) && !(await reqRow("HR-REQ-OFF-1")), `${sendOff.status} ${offInbox?.status} ${offInbox?.last_error}`);
  check("OFF-3", "Feature OFF: dashboards and the mock ESS say so instead of showing figures (Manager: 'Not enabled yet'; Team Leader: 'Approvals are not enabled yet'; setup: the mock ESS is unavailable)",
    mgrDash.includes("Not enabled yet") && tlDash.includes("Approvals are not enabled yet") && setupOff.status === 200 && setupOff.body.includes("available only while HR is in") && !setupOff.body.includes("Send the mock request"));
  await extra.stop();
  extra = null;

  // ================================================================ the feature switch: ON, signed request through the P6 inbox (live HR, fake HR server)
  extra = await startExtra({ APPROVALS_ENABLED: "true" });
  const mgrOn = await loginAt(extra.base, "manager@johnvivz.test");
  const tlOn = await loginAt(extra.base, "maria.santos@johnvivz.test");
  await mgrOn.get("/crm/settings/integration");
  const re = await mgrOn.post(`/crm/settings/integration/inbox/${offInbox.id}/reprocess`, {});
  const rerouted = await reqRow("HR-REQ-OFF-1");
  const offAfter = await one("SELECT * FROM integration_inbox WHERE id = ?", [offInbox.id]);
  check("ON-1", "Feature ON: the ignored request is reprocessed from Integration Health and routed to the Agent's Team Leader (pending, approver Maria, real not mock, source event recorded, request payload kept as sent)",
    re.status === 302 && offAfter.status === "processed" && rerouted && rerouted.status === "pending" && rerouted.approver_user_id === maria.id && rerouted.approver_role === "team_leader" && rerouted.is_mock === 0 && rerouted.requester_user_id === kristine.id &&
    rerouted.source_event_id === sendOff.envelope.event_id && rerouted.payload.days === 2 && rerouted.summary.includes("Vacation leave") && Number((await one("SELECT COUNT(*) n FROM crm_notifications WHERE related_type = 'approval' AND related_id = ? AND user_id = ?", [rerouted.id, maria.id])).n) === 1, JSON.stringify(rerouted));
  const live1 = await sendHr("EmployeeRequestSubmitted", { request_id: "HR-REQ-LIVE-1", request_type: "overtime", employee_id: kristine.employee_id, date: day(-1), start_time: "18:00", end_time: "20:00", hours: 2, reason: "Stock count" });
  const dupEvent = await fake.hr.sendToCrm(live1.envelope);
  const sameReq = await sendHr("EmployeeRequestSubmitted", { request_id: "HR-REQ-LIVE-1", request_type: "overtime", employee_id: kristine.employee_id, date: day(-1), start_time: "18:00", end_time: "20:00", hours: 2, reason: "Stock count" }, { idem: "EmployeeRequestSubmitted:HR-REQ-LIVE-1-resend" });
  const sameReqInbox = await one("SELECT * FROM integration_inbox WHERE event_id = ?", [sameReq.envelope.event_id]);
  check("ON-2", "Signed request: accepted and routed; the same event_id again is 200 duplicate and the same request_id in a NEW event changes nothing (one request row, note 'already received'): duplicate-safe at both levels",
    live1.status === 202 && dupEvent.status === 200 && dupEvent.json.status === "duplicate" && sameReq.status === 202 && /already received/.test(sameReqInbox.last_error) && Number((await one("SELECT COUNT(*) n FROM approval_requests WHERE request_id = 'HR-REQ-LIVE-1'")).n) === 1);
  const badEvents = [];
  for (const [name, data] of [
    ["end before start", { request_id: "HR-BAD-1", request_type: "leave", employee_id: kristine.employee_id, leave_type: "Vacation leave", start_date: day(5), end_date: day(2), days: 2 }],
    ["unknown type", { request_id: "HR-BAD-2", request_type: "sabbatical", employee_id: kristine.employee_id }],
    ["no times", { request_id: "HR-BAD-3", request_type: "attendance_correction", employee_id: kristine.employee_id, date: day(-1), reason: "x y z" }],
    ["overtime 30 hours", { request_id: "HR-BAD-4", request_type: "overtime", employee_id: kristine.employee_id, date: day(-1), start_time: "08:00", end_time: "20:00", hours: 30, reason: "too long" }],
    ["no request id", { request_type: "leave", employee_id: kristine.employee_id }],
  ]) {
    const r = await sendHr("EmployeeRequestSubmitted", data);
    const row = await one("SELECT status, last_error FROM integration_inbox WHERE event_id = ?", [r.envelope.event_id]);
    if (r.status !== 202 || row.status !== "dead" || !row.last_error) badEvents.push(`${name}: ${r.status} ${row?.status}`);
  }
  check("ON-3", "A malformed request (end before start, unknown type, no times, 30 hours, no id) is stored in the inbox as dead with the reason and creates no request: retrying cannot fix it", badEvents.length === 0 && Number((await one("SELECT COUNT(*) n FROM approval_requests WHERE request_id LIKE 'HR-BAD-%'")).n) === 0, badEvents.join("; "));
  const other = await sendHr("EmployeeRequestSubmitted", { request_id: "HR-REQ-LIVE-OTHER", request_type: "other", employee_id: kristine.employee_id, reason: "something else" });
  check("ON-3b", "Only three request types exist (Leave/PTO, attendance correction, overtime): 'other' is refused as dead", (await one("SELECT status FROM integration_inbox WHERE event_id = ?", [other.envelope.event_id])).status === "dead" && !(await reqRow("HR-REQ-LIVE-OTHER")));

  // a decision on a request from the REAL source goes out through the outbox and reaches HR (fake); a decision on a MOCK-source request never does
  await tlOn.get("/crm/approvals");
  const liveRow = await reqRow("HR-REQ-LIVE-1");
  await tlOn.get(`/crm/approvals/${liveRow.id}`);
  const liveApprove = await tlOn.post(`/crm/approvals/${liveRow.id}/decide`, { decision: "approve", comment: "OK for the stock count" });
  const liveEv = await decisionEvents("HR-REQ-LIVE-1");
  fake.hr.requests.length = 0;
  await mgrOn.get("/crm/settings/integration");
  await mgrOn.post("/crm/settings/integration/dispatch", {});
  const sentEv = await decisionEvents("HR-REQ-LIVE-1");
  const gotLive = fake.hr.eventsOf("EmployeeRequestDecided");
  check("DEC-LIVE", "Real-source decision: EmployeeRequestDecided is queued for HR (pending), delivered by the dispatcher as a signed POST, accepted by the fake HR, and its data passes the draft contract check",
    liveApprove.status === 302 && liveEv.length === 1 && liveEv[0].target === "johnvivz_hr" && liveEv[0].status === "pending" && liveEv[0].is_mock === 0 && sentEv[0].status === "sent" && gotLive.length === 1 && gotLive[0].data.decision === "approved" && gotLive[0].data.request_id === "HR-REQ-LIVE-1" &&
    gotLive[0].data.employee_id === kristine.employee_id && gotLive[0].data.decided_by_employee_id === maria.employee_id && gotLive[0].data.reason === "OK for the stock count" && fake.hr.rejected.length === 0 && checkEnvelope(gotLive[0]).length === 0, JSON.stringify(checkEnvelope(gotLive[0] || {})));
  const demo2 = await reqRow("DEMO-REQ-0002");
  await tlOn.get(`/crm/approvals/${demo2.id}`);
  fake.hr.requests.length = 0;
  fake.hr.events.length = 0;
  await tlOn.post(`/crm/approvals/${demo2.id}/decide`, { decision: "approve", comment: "Approved from the live-HR server" });
  await mgrOn.post("/crm/settings/integration/dispatch", {});
  const mockEv = await decisionEvents("DEMO-REQ-0002");
  check("DEC-MOCKSRC", "A request that came from the MOCK source is decided and audited, but its decision is stored as mock and NEVER sent, even when the HR adapter is live (the fake HR receives nothing)",
    (await reqRow("DEMO-REQ-0002")).status === "approved" && mockEv.length === 1 && mockEv[0].is_mock === 1 && mockEv[0].status === "mock_delivered" && mockEv[0].attempts === 0 && fake.hr.eventsOf("EmployeeRequestDecided").length === 0 && !fake.hr.requests.some((r) => /events/.test(r.path)));
  const unknownReq = await sendHr("EmployeeRequestSubmitted", { request_id: "HR-REQ-LIVE-9", request_type: "leave", employee_id: "HR-EMP-NOBODY", leave_type: "Vacation leave", start_date: day(30), end_date: day(30), days: 1 });
  const unknownRow = await reqRow("HR-REQ-LIVE-9");
  check("ON-4", "A signed request from someone who is not a CRM employee goes to the exception queue (no approver, reason given), never to a guess", unknownReq.status === 202 && unknownRow.status === "exception" && /not a CRM employee/.test(unknownRow.exception_reason) && unknownRow.requester_user_id === null && unknownRow.approver_user_id === null);
  await extra.stop();
  extra = null;

  // ================================================================ main server (HR mock, approvals on): the mock ESS and routing
  const setupGet = await setup.get("/setup/approvals");
  const noAccess = [await mgr.get("/setup/approvals"), await tl.get("/setup/approvals"), await agent.get("/setup/approvals")];
  check("ESS-1", "Setup > Mock ESS Requests opens for the setup administrator (labelled as a mock, with the employee list) and is refused (403) for everyone else",
    setupGet.status === 200 && setupGet.body.includes('data-mock-ess="1"') && setupGet.body.includes("Send the mock request") && setupGet.body.includes("Kristine Bautista") && noAccess.every((r) => r.status === 403), noAccess.map((r) => r.status).join(","));
  const sendMock = async (fields) => {
    await setup.get("/setup/approvals");
    const r = await setup.post("/setup/approvals", fields);
    const msg = await flashAfter(setup, "/setup/approvals");
    return { status: r.status, msg, row: await latestMock() };
  };
  const leaveFields = (employee_id, extraFields = {}) => ({ employee_id, request_type: "leave", leave_type: "Vacation leave", start_date: day(9), end_date: day(10), days: "2", reason: "Rest", ...extraFields });
  const r1 = await sendMock(leaveFields(kristine.employee_id));
  check("ROUTE-1", "Mock request from an AGENT goes to her Team Leader: pending, approver = the Team Leader of her team, role team_leader; stored as mock (inbox row is_mock = 1) with the request text kept; the Team Leader is notified; the receipt is audited",
    r1.row && r1.row.status === "pending" && r1.row.approver_user_id === maria.id && r1.row.approver_role === "team_leader" && r1.row.requester_user_id === kristine.id && r1.row.is_mock === 1 && r1.row.payload.leave_type === "Vacation leave" &&
    (await one("SELECT is_mock m, status s FROM integration_inbox WHERE event_id = ?", [r1.row.source_event_id])).m === 1 && Number((await one("SELECT COUNT(*) n FROM crm_notifications WHERE related_type = 'approval' AND related_id = ? AND user_id = ?", [r1.row.id, maria.id])).n) === 1 &&
    (await auditRows("approval_request_received", "AND record_id = ?", [r1.row.request_id])).length === 1 && /MOCK ESS/.test(r1.msg), JSON.stringify(r1.row) + r1.msg);
  const r2 = await sendMock({ employee_id: patricia.employee_id, request_type: "overtime", date: day(-1), start_time: "18:00", end_time: "20:30", hours: "2.5", reason: "Delivery backlog" });
  check("ROUTE-2", "An agent of ANOTHER team goes to that team's Team Leader (Joseph), not to Maria", r2.row.status === "pending" && r2.row.approver_user_id === joseph.id && r2.row.summary.includes("Overtime"));
  const r3 = await sendMock({ employee_id: maria.employee_id, request_type: "attendance_correction", date: day(-2), time_in: "08:10", reason: "Late log-in after a power cut" });
  check("ROUTE-3", "A TEAM LEADER's request goes to the CRM Manager (pending, role crm_manager, no single named approver)", r3.row.status === "pending" && r3.row.approver_role === "crm_manager" && r3.row.approver_user_id === null && r3.row.requester_user_id === maria.id);
  const r4 = await sendMock(leaveFields(manager.employee_id));
  check("ROUTE-4", "The CRM MANAGER's own request has nobody above in CRM: it goes to the exception queue with the reason (never approved, never self-approved)", r4.row.status === "exception" && /nobody above/.test(r4.row.exception_reason) && r4.row.approver_user_id === null);
  const r5 = await sendMock(leaveFields("__unknown"));
  check("ROUTE-5", "A request from an employee who is not a CRM employee goes to the exception queue", r5.row.status === "exception" && /not a CRM employee/.test(r5.row.exception_reason) && r5.row.requester_employee_id === "MOCK-EMP-9001");
  // an agent in a team without a Team Leader
  await db.query("INSERT INTO crm_teams (team_code, name, is_active) VALUES ('TEST-03', 'No leader team (test)', 1)");
  const team3 = (await one("SELECT id FROM crm_teams WHERE team_code = 'TEST-03'")).id;
  await db.query("INSERT INTO employee_references (employee_id, full_name, work_email, department_id, position_id, employment_status, supervisor_employee_id, source, source_version, is_mock, last_synced_at) VALUES ('MOCK-EMP-T006', 'Noel Reyes', 'noel.reyes@johnvivz.test', 'MOCK-DEP-CRM', 'MOCK-POS-CRM-AGT', 'active', NULL, 'johnvivz_hr (mock)', 'test', 1, NOW())");
  await db.query("INSERT INTO crm_users (user_type, role, employee_id, email, password_hash, display_name, team_id, is_active, is_demo) VALUES ('staff','agent','MOCK-EMP-T006','noel.reyes@johnvivz.test',?,'Noel Reyes',?,1,0)", [hashOf, team3]);
  const noel = await u("noel.reyes@johnvivz.test");
  const r6 = await sendMock({ employee_id: "MOCK-EMP-T006", request_type: "overtime", date: day(-1), start_time: "18:00", end_time: "19:00", hours: "1", reason: "Closing" });
  check("ROUTE-6", "An agent whose team has no Team Leader goes to the exception queue (reason: the team has no Team Leader)", r6.row.status === "exception" && /no Team Leader/.test(r6.row.exception_reason) && r6.row.requester_user_id === noel.id);
  // a team of its own (Tina = Team Leader, Ben = agent) so separating or switching her off does not disturb the other teams' pending requests
  await db.query("INSERT INTO crm_teams (team_code, name, is_active) VALUES ('TEST-04', 'Leader team (test)', 1)");
  const team4 = (await one("SELECT id FROM crm_teams WHERE team_code = 'TEST-04'")).id;
  for (const [id, name, email, pos] of [["MOCK-EMP-T007", "Tina Cruz", "tina.cruz@johnvivz.test", "MOCK-POS-CRM-TL"], ["MOCK-EMP-T008", "Ben Dizon", "ben.dizon@johnvivz.test", "MOCK-POS-CRM-AGT"]]) {
    await db.query("INSERT INTO employee_references (employee_id, full_name, work_email, department_id, position_id, employment_status, supervisor_employee_id, source, source_version, is_mock, last_synced_at) VALUES (?, ?, ?, 'MOCK-DEP-CRM', ?, 'active', NULL, 'johnvivz_hr (mock)', 'test', 1, NOW())", [id, name, email, pos]);
  }
  await db.query("INSERT INTO crm_users (user_type, role, employee_id, email, password_hash, display_name, team_id, is_active, is_demo) VALUES ('staff','team_leader','MOCK-EMP-T007','tina.cruz@johnvivz.test',?,'Tina Cruz',?,1,0), ('staff','agent','MOCK-EMP-T008','ben.dizon@johnvivz.test',?,'Ben Dizon',?,1,0)", [hashOf, team4, hashOf, team4]);
  const tina = await u("tina.cruz@johnvivz.test");
  await db.query("UPDATE crm_teams SET team_leader_id = ? WHERE id = ?", [tina.id, team4]);
  // approver separated in HR (HR status simulated through the mock HR, which also revalidates pending requests)
  await setup.get("/setup/staff");
  await setup.post("/setup/staff/hr-status", { employee_id: "MOCK-EMP-T007", status: "separated" });
  const r7 = await sendMock({ employee_id: "MOCK-EMP-T008", request_type: "leave", leave_type: "Sick leave", start_date: day(3), end_date: day(3), days: "1", reason: "Check-up" });
  await setup.post("/setup/staff/hr-status", { employee_id: "MOCK-EMP-T007", status: "active" });
  check("ROUTE-7", "When the Team Leader is SEPARATED in HR, an agent's request goes to the exception queue (reason names the Team Leader and 'separated'), not to a person who has left", r7.row.status === "exception" && /separated/.test(r7.row.exception_reason) && /Tina Cruz/.test(r7.row.exception_reason) && r7.row.approver_user_id === null, r7.row.exception_reason);
  const r8 = await sendMock({ employee_id: "MOCK-EMP-T008", request_type: "leave", leave_type: "Vacation leave", start_date: day(40), end_date: day(40), days: "1", reason: "Personal" });
  await db.query("UPDATE crm_users SET is_active = 0 WHERE id = ?", [tina.id]);
  await mgr.get("/crm/approvals");
  const r8b = await reqRow(r8.row.request_id);
  await db.query("UPDATE crm_users SET is_active = 1 WHERE id = ?", [tina.id]);
  check("ROUTE-8", "If the approver is switched off in CRM AFTER the request arrived, it moves to the exception queue the next time the queue is opened (nothing is approved or rejected by that)", r8.row.status === "pending" && r8.row.approver_user_id === tina.id && r8b.status === "exception" && /switched off/.test(r8b.exception_reason) && r8b.decided_by === null);
  const bad = [];
  for (const [name, fields, expected] of [
    ["leave without dates", { employee_id: kristine.employee_id, request_type: "leave", leave_type: "Vacation leave", days: "1" }, /dates/],
    ["overtime 30 hours", { employee_id: kristine.employee_id, request_type: "overtime", date: day(-1), start_time: "08:00", end_time: "20:00", hours: "30", reason: "x y z" }, /hours/],
    ["attendance without a time", { employee_id: kristine.employee_id, request_type: "attendance_correction", date: day(-1), reason: "forgot" }, /time_in or time_out/],
  ]) {
    const before = Number((await one("SELECT COUNT(*) n FROM approval_requests")).n);
    const r = await sendMock(fields);
    if (!expected.test(r.msg) || Number((await one("SELECT COUNT(*) n FROM approval_requests")).n) !== before) bad.push(`${name}: ${r.msg}`);
  }
  const typeBad = await setup.post("/setup/approvals", { employee_id: kristine.employee_id, request_type: "bonus" });
  check("ESS-2", "The mock ESS refuses bad requests with the reason and saves nothing (leave without dates, 30 hours of overtime, a correction without a time, an unknown type)", bad.length === 0 && typeBad.status === 302, bad.join("; "));

  // ================================================================ the queue and who sees what
  const mariaQ = (await tl.get("/crm/approvals")).body;
  const josephQ = (await tl2.get("/crm/approvals")).body;
  const mgrQ = (await mgr.get("/crm/approvals")).body;
  const mgrEx = (await mgr.get("/crm/approvals?view=exceptions")).body;
  check("QUEUE-1", "Each Team Leader's queue holds only requests routed to them (Maria: Kristine's and Ramon's team; Joseph: Patricia's); the Manager's queue holds the manager-level requests (Maria's own request), and the Exceptions view lists every exception",
    mariaQ.includes(`data-request="${r1.row.request_id}"`) && !mariaQ.includes(`data-request="${r2.row.request_id}"`) && !mariaQ.includes(`data-request="${r3.row.request_id}"`) && josephQ.includes(`data-request="${r2.row.request_id}"`) && !josephQ.includes(`data-request="${r1.row.request_id}"`) &&
    mgrQ.includes(`data-request="${r3.row.request_id}"`) && !mgrQ.includes(`data-request="${r1.row.request_id}"`) && [r4, r5, r6, r7].every((r) => mgrEx.includes(`data-request="${r.row.request_id}"`)) && mgrEx.includes("Exceptions"));
  const cross = [await tl2.get(`/crm/approvals/${r1.row.id}`), await tl.get(`/crm/approvals/${r2.row.id}`), await tl.get(`/crm/approvals/${r3.row.id}`)];
  const roles403 = [await agent.get("/crm/approvals"), await agent.get(`/crm/approvals/${r1.row.id}`), await juanC.get("/crm/approvals"), await setup.get("/crm/approvals")];
  check("QUEUE-2", "Scope: a Team Leader opening another approver's request gets 404 (and not their own request); Agent, Customer and the setup administrator get 403", cross.every((r) => r.status === 404) && roles403.every((r) => r.status === 403), `${cross.map((r) => r.status)} ${roles403.map((r) => r.status)}`);
  const detail = (await tl.get(`/crm/approvals/${r1.row.id}`)).body;
  const own4 = (await mgr.get(`/crm/approvals/${r4.row.id}`)).body;
  check("QUEUE-3", "The request page shows the type, the summary, every field HR sent, who it is routed to and the history, and the Approve / Reject box for the approver",
    detail.includes("Vacation leave") && detail.includes("Rest") && detail.includes("Maria Santos") && detail.includes("History") && detail.includes('data-decision="1"'));
  check("QUEUE-3b", "The Manager's own request: no decision box, the 'own request' notice and the exception box without 'decide yourself'", own4.includes("Nobody decides their own request") && !own4.includes('data-decision="1"') && own4.includes('data-exception="1"') && !own4.includes("approve or reject it yourself"));

  // ================================================================ deciding
  await tl.get(`/crm/approvals/${r1.row.id}`);
  const rejNone = await tl.post(`/crm/approvals/${r1.row.id}/decide`, { decision: "reject", comment: "" });
  const rejNoneMsg = await flashAfter(tl, `/crm/approvals/${r1.row.id}`);
  const rejShort = await tl.post(`/crm/approvals/${r1.row.id}/decide`, { decision: "reject", comment: "no" });
  const stillPending = (await reqRow(r1.row.request_id)).status === "pending" && (await decisionEvents(r1.row.request_id)).length === 0;
  check("DEC-1", "Rejecting needs a comment of at least 5 characters: with none or 'no' the request stays pending and nothing is sent", rejNone.status === 302 && rejShort.status === 302 && /at least 5/.test(rejNoneMsg) && stillPending);
  const approve1 = await tl.post(`/crm/approvals/${r1.row.id}/decide`, { decision: "approve", comment: "" });
  const a1 = await reqRow(r1.row.request_id);
  const ev1 = await decisionEvents(r1.row.request_id);
  check("DEC-2", "Approving (comment optional) records the decision: status approved, decided by the Team Leader, time, decision event id; EXACTLY ONE EmployeeRequestDecided for HR, stored as mock (never sent) with the draft-contract data; the requester is notified",
    approve1.status === 302 && a1.status === "approved" && a1.decided_by === maria.id && a1.decided_at && a1.decision_reason === null && ev1.length === 1 && ev1[0].is_mock === 1 && ev1[0].status === "mock_delivered" && ev1[0].attempts === 0 && ev1[0].event_id === a1.decision_event_id &&
    ev1[0].target === "johnvivz_hr" && checkEnvelope(envelopeOf(ev1[0])).length === 0 && envelopeOf(ev1[0]).data.decision === "approved" && envelopeOf(ev1[0]).data.decided_by_employee_id === maria.employee_id &&
    Number((await one("SELECT COUNT(*) n FROM crm_notifications WHERE related_type = 'approval' AND related_id = ? AND user_id = ?", [a1.id, kristine.id])).n) === 1, JSON.stringify(checkEnvelope(envelopeOf(ev1[0]))));
  const auditDecided = (await auditRows("approval_decided", "AND record_id = ?", [r1.row.request_id]))[0];
  check("DEC-3", "Every decision is audited with who, the before/after status and the comment", auditDecided && auditDecided.actor_user_id === maria.id && JSON.stringify(auditDecided.before_values).includes("pending") && JSON.stringify(auditDecided.after_values).includes("approved"));
  const twice = await tl.post(`/crm/approvals/${r1.row.id}/decide`, { decision: "reject", comment: "changing my mind" });
  const twiceMsg = await flashAfter(tl, `/crm/approvals/${r1.row.id}`);
  check("DEC-4", "A decided request cannot be decided again (refused with a message); still ONE decision event", twice.status === 302 && /already approved/.test(twiceMsg) && (await reqRow(r1.row.request_id)).status === "approved" && (await decisionEvents(r1.row.request_id)).length === 1);
  await tl2.get(`/crm/approvals/${r2.row.id}`);
  const reject2 = await tl2.post(`/crm/approvals/${r2.row.id}/decide`, { decision: "reject", comment: "No overtime was planned that day" });
  const a2 = await reqRow(r2.row.request_id);
  const ev2 = envelopeOf((await decisionEvents(r2.row.request_id))[0]);
  check("DEC-5", "Rejecting with a comment works: status rejected, the comment is saved and sent to HR in the event (reason), which passes the contract check (a rejection must carry its reason)", reject2.status === 302 && a2.status === "rejected" && a2.decision_reason === "No overtime was planned that day" && ev2.data.decision === "rejected" && ev2.data.reason === a2.decision_reason && checkEnvelope(ev2).length === 0);

  // nobody decides their own request
  const ownTry = await tl.post(`/crm/approvals/${r3.row.id}/decide`, { decision: "approve", comment: "approving myself" });
  let dbCheck = "no error";
  try { await db.query("UPDATE approval_requests SET decided_by = requester_user_id, status = 'approved' WHERE id = ?", [r3.row.id]); } catch (e) { dbCheck = e.code; }
  const mgrOwn = await mgr.post(`/crm/approvals/${r4.row.id}/decide`, { decision: "approve", comment: "approving myself" });
  check("OWN-1", "NOBODY APPROVES THEIR OWN REQUEST: a Team Leader and the Manager are refused (403, audited) on their own request, nothing changes, nothing is sent; the database CHECK refuses decided_by = requester too",
    ownTry.status === 403 && mgrOwn.status === 403 && (await auditRows("access_denied", "AND details LIKE '%own request%'")).length >= 2 && (await reqRow(r3.row.request_id)).status === "pending" && (await reqRow(r4.row.request_id)).status === "exception" && (await decisionEvents(r3.row.request_id)).length === 0 && /CHECK|ER_/i.test(dbCheck) && dbCheck !== "no error", `${ownTry.status} ${mgrOwn.status} ${dbCheck} ${dbCheck}`);
  const notMine = [await tl.post(`/crm/approvals/${r2.row.id}/decide`, { decision: "approve", comment: "not mine" }), await tl2.post(`/crm/approvals/${r1.row.id}/decide`, { decision: "approve", comment: "not mine" })];
  const forged = [await agent.post(`/crm/approvals/${r3.row.id}/decide`, { decision: "approve", comment: "forged" }), await juanC.post(`/crm/approvals/${r3.row.id}/decide`, { decision: "approve", comment: "forged" })];
  const tlException = [await tl.post(`/crm/approvals/${r4.row.id}/return`, { comment: "forged return" }), await tl.post(`/crm/approvals/${r4.row.id}/assign`, { approver: "manager" })];
  check("DEC-6", "Forged requests are refused: another Team Leader's request is 404, an Agent or Customer deciding is 403, a Team Leader working the exception queue is 403; nothing changes", notMine.every((r) => r.status === 404) && forged.every((r) => r.status === 403) && tlException.every((r) => r.status === 403) && (await reqRow(r4.row.request_id)).status === "exception");
  await mgr.get(`/crm/approvals/${r3.row.id}`);
  const mgrDecide = await mgr.post(`/crm/approvals/${r3.row.id}/decide`, { decision: "approve", comment: "Late log-in accepted" });
  check("DEC-7", "The Manager decides the Team Leader's request (manager-level); the decision event goes to HR (mock)", mgrDecide.status === 302 && (await reqRow(r3.row.request_id)).status === "approved" && (await reqRow(r3.row.request_id)).decided_by === manager.id && (await decisionEvents(r3.row.request_id)).length === 1);

  // ================================================================ the exception queue
  await mgr.get(`/crm/approvals/${r5.row.id}`);
  const retShort = await mgr.post(`/crm/approvals/${r5.row.id}/return`, { comment: "no" });
  const retStill = (await reqRow(r5.row.request_id)).status === "exception";
  const retOk = await mgr.post(`/crm/approvals/${r5.row.id}/return`, { comment: "Not a CRM employee: HR should route this to their own supervisor" });
  const r5b = await reqRow(r5.row.request_id);
  const r5Ev = envelopeOf((await decisionEvents(r5.row.request_id))[0]);
  check("EXC-1", "Exception: 'Return to HR' needs a comment; it sets the status to returned (no approval), records who and why, and sends EmployeeRequestDecided with decision 'returned' and the reason (mock)",
    retShort.status === 302 && retStill && retOk.status === 302 && r5b.status === "returned" && r5b.decided_by === manager.id && r5Ev.data.decision === "returned" && r5Ev.data.reason === r5b.decision_reason && checkEnvelope(r5Ev).length === 0 && (await auditRows("approval_returned_to_hr")).length === 1);
  const exPage = (await mgr.get(`/crm/approvals/${r6.row.id}`)).body;
  check("EXC-2", "The assign list offers valid Team Leaders and the Manager queue, never an Agent", exPage.includes("Team Leader: Joseph Villanueva") && exPage.includes("Team Leader: Maria Santos") && exPage.includes("The CRM Manager queue") && !exPage.includes("Team Leader: Noel") && !exPage.includes("Team Leader: Kristine"));
  await mgr.get(`/crm/approvals/${r6.row.id}`);
  const forgedAssign = [await mgr.post(`/crm/approvals/${r6.row.id}/assign`, { approver: String(kristine.id) }), await mgr.post(`/crm/approvals/${r6.row.id}/assign`, { approver: "" })];
  const assignOk = await mgr.post(`/crm/approvals/${r6.row.id}/assign`, { approver: String(joseph.id) });
  const r6b = await reqRow(r6.row.request_id);
  await tl2.get("/crm/approvals");
  const josephDecides = await tl2.post(`/crm/approvals/${r6.row.id}/decide`, { decision: "approve", comment: "Closing hour approved" });
  check("EXC-3", "Exception: the Manager assigns a valid Team Leader (a forged approver such as an Agent or an empty choice is refused); the request becomes pending for that leader, who is notified and then decides it",
    forgedAssign.every((r) => r.status === 302) && assignOk.status === 302 && r6b.status === "pending" && r6b.approver_user_id === joseph.id && r6b.exception_reason === null && josephDecides.status === 302 && (await reqRow(r6.row.request_id)).status === "approved" &&
    (await auditRows("approval_assigned", "AND record_id = ?", [r6.row.request_id])).length === 1);
  await mgr.get(`/crm/approvals/${r7.row.id}`);
  const toQueue = await mgr.post(`/crm/approvals/${r7.row.id}/assign`, { approver: "manager" });
  const r7b = await reqRow(r7.row.request_id);
  const mgrRej = await mgr.post(`/crm/approvals/${r7.row.id}/decide`, { decision: "reject", comment: "Please resubmit with a medical note" });
  check("EXC-4", "Exception: the Manager can send it to the Manager queue and decide it (reject with a comment); a Manager can also decide an exception directly", toQueue.status === 302 && r7b.status === "pending" && r7b.approver_role === "crm_manager" && mgrRej.status === 302 && (await reqRow(r7.row.request_id)).status === "rejected");
  const direct = await sendMock({ employee_id: "__unknown", request_type: "overtime", date: day(-1), start_time: "18:00", end_time: "19:00", hours: "1", reason: "Direct decision test" });
  await mgr.get(`/crm/approvals/${direct.row.id}`);
  await mgr.post(`/crm/approvals/${direct.row.id}/decide`, { decision: "approve", comment: "Decided directly" });
  check("EXC-5", "The Manager decides an exception request directly (approve), and the decision event is created once", (await reqRow(direct.row.request_id)).status === "approved" && (await decisionEvents(direct.row.request_id)).length === 1);

  // ================================================================ an approver who leaves; nothing is ever approved automatically
  const approvedBefore = Number((await one("SELECT COUNT(*) n FROM approval_requests WHERE status = 'approved'")).n);
  const pendingBefore = await all("SELECT request_id FROM approval_requests WHERE status = 'pending' AND approver_user_id = ?", [maria.id]);
  await setup.get("/setup/staff");
  await setup.post("/setup/staff/hr-status", { employee_id: maria.employee_id, status: "separated" });
  const movedRows = await all("SELECT request_id, status, exception_reason, decided_by FROM approval_requests WHERE request_id IN (?)", [pendingBefore.map((r) => r.request_id)]);
  const job = env.node(["--input-type=module", "-e", "const { runJobsOnce } = await import('./jobs/scheduler.js'); const { sequelize } = await import('./models/index.js'); await runJobsOnce(); await sequelize.close();"]);
  const approvedAfter = Number((await one("SELECT COUNT(*) n FROM approval_requests WHERE status = 'approved'")).n);
  await setup.post("/setup/staff/hr-status", { employee_id: maria.employee_id, status: "active" });
  tl = await as("maria.santos@johnvivz.test"); // her session ended when HR separated her; sign in again
  check("AUTO-1", "When the Team Leader is separated in HR, every request pending for her moves to the exception queue at once (reason 'separated'); the background job runs; NOTHING was approved or rejected automatically (approved count unchanged, no decider)",
    pendingBefore.length >= 2 && movedRows.length === pendingBefore.length && movedRows.every((r) => r.status === "exception" && /separated/.test(r.exception_reason) && r.decided_by === null) && job.status === 0 && approvedAfter === approvedBefore && (await auditRows("approval_moved_to_exception")).length >= pendingBefore.length, `${pendingBefore.length} ${JSON.stringify(movedRows.slice(0, 2))} ${job.stderr.slice(0, 200)}`);
  const bad2 = await one("SELECT (SELECT COUNT(*) FROM approval_requests WHERE status IN ('approved','rejected','returned') AND (decided_by IS NULL OR decided_at IS NULL OR decision_event_id IS NULL)) a, (SELECT COUNT(*) FROM approval_requests WHERE status = 'approved' AND decided_by = requester_user_id) b");
  check("AUTO-2", "Every approved, rejected or returned request has a human decider, a time and a decision event; none was decided by its own requester", Number(bad2.a) === 0 && Number(bad2.b) === 0, JSON.stringify(bad2));

  // ================================================================ HR stays the owner; events; samples; pages
  const hrTables = await all("SELECT table_name n FROM information_schema.tables WHERE table_schema = ? AND (table_name LIKE '%leave%' OR table_name LIKE '%overtime%' OR table_name LIKE '%attendance%' OR table_name LIKE '%timesheet%')", [DB]);
  const events = await all("SELECT idempotency_key, status, is_mock FROM integration_outbox WHERE event_type = 'EmployeeRequestDecided'");
  const decidedCount = Number((await one("SELECT COUNT(*) n FROM approval_requests WHERE decision_event_id IS NOT NULL")).n);
  const mockOnly = events.filter((e) => /MOCK-REQ|DEMO-REQ/.test(e.idempotency_key));
  check("HR-OWNS", "CRM creates no leave, overtime or attendance record: no such table exists, and the only things that leave CRM are decision events (one per decided request, unique idempotency key; every mock-source one is mock and unsent)",
    hrTables.length === 0 && events.length === decidedCount && new Set(events.map((e) => e.idempotency_key)).size === events.length && mockOnly.every((e) => e.is_mock === 1 && e.status === "mock_delivered"), `${hrTables.length} ${events.length} ${decidedCount}`);
  const mgrDashOn = (await mgr.get("/crm/manager")).body;
  const tlDashOn = (await tl.get("/crm/team-leader")).body;
  check("DASH-6", "Dashboards show the real counts when approvals are on: Manager 'Employee approvals' and 'Approval exceptions'; Team Leader 'Requests waiting for me'; the approvals sample widgets are gone",
    mgrDashOn.includes("Employee approvals") && mgrDashOn.includes("Approval exceptions") && !mgrDashOn.includes("Feature off until HR confirms") && tlDashOn.includes("Requests waiting for me") && !tlDashOn.includes("Feature off until HR confirms") && widgetsFor({ role: "crm_manager", platform: {} }).every((b) => !/Approvals queue/.test(JSON.stringify(b))));
  const BAD = /\[object Object\]|\bundefined\b|\bNaN\b|\{\{|\}\}/;
  const stray = [];
  const pages = [[mgr, "/crm/approvals"], [mgr, "/crm/approvals?view=exceptions"], [mgr, "/crm/approvals?view=decided"], [mgr, "/crm/approvals?view=all&status=pending&type=leave&q=Kristine"], [mgr, `/crm/approvals/${r4.row.id}`], [mgr, `/crm/approvals/${r1.row.id}`], [tl, "/crm/approvals?view=decided"], [tl, `/crm/approvals/${r1.row.id}`], [tl2, "/crm/approvals"], [setup, "/setup/approvals"], [setup, "/setup"], [mgr, "/crm/manager"], [tl, "/crm/team-leader"]];
  for (const [c, p] of pages) {
    const r = await c.get(p);
    if (r.status !== 200 || BAD.test(strip(r.body))) stray.push(`${p} ${r.status}`);
  }
  check("PAGES-P7", "Per-role page check: every approvals page (queue views, filters, detail, mock ESS, dashboards) opens for the right role with no stray template text", stray.length === 0, stray.join("; "));
  const removed = PAGES.filter((p) => /^approvals\./.test(p.key));
  check("SMP-6", "The two approvals sample pages (approvals.list, approvals.detail) and the APPROVALS sample data are gone, with the sample 'Approvals queue' dashboard tiles; later phases remove the other samples",
    removed.length === 0 && sampleData.APPROVALS === undefined, PAGES.map((p) => p.key).join(","));

  // ================================================================ seed:clear removes only the demo requests
  const mockBefore = Number((await one("SELECT COUNT(*) n FROM approval_requests WHERE request_id LIKE 'MOCK-REQ-%' OR request_id LIKE 'HR-REQ-%'")).n);
  const clear = env.node(["seeders/index.js", "--clear"]);
  const demoLeft = Number((await one("SELECT COUNT(*) n FROM approval_requests WHERE request_id LIKE 'DEMO-REQ-%'")).n);
  const mockAfter = Number((await one("SELECT COUNT(*) n FROM approval_requests WHERE request_id LIKE 'MOCK-REQ-%' OR request_id LIKE 'HR-REQ-%'")).n);
  const demoEv = Number((await one("SELECT COUNT(*) n FROM integration_outbox WHERE event_type = 'EmployeeRequestDecided' AND entity_id LIKE 'DEMO-REQ-%'")).n);
  check("CLEAR-2", "seed:clear removes only the demo requests (DEMO-REQ-*) and their mock decision events; requests made through the mock ESS or received from HR are kept", clear.status === 0 && demoLeft === 0 && demoEv === 0 && mockAfter === mockBefore && mockBefore > 5, `${clear.status} ${demoLeft} ${mockBefore}/${mockAfter} ${clear.stdout.slice(-300)} ${clear.stderr.slice(0, 300)}`);
} finally {
  if (extra) await extra.stop();
  await fake.stop();
  await env.stop();
}
summarize(DB);
