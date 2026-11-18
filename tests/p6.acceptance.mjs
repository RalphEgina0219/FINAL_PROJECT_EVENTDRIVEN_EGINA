/*
 * JOHNVIVZ CRM — Phase P6 (integration) acceptance tests.
 *   npm run test:p6        (npm test runs it last)
 * Throwaway database johnvivz_crm_p6_test. The CRM server runs with HR, Inventory and Accounting in LIVE mode, pointed at the local
 * FAKE servers in tests/support/fakeApps.mjs. The fakes follow docs/integration-contract.md (HMAC checked with their own code, every
 * event validated against tests/support/contractSchemas.mjs). A pass here means "Contract-tested", never "verified live": no real
 * HR, Inventory or Accounting application is involved.
 * Covers: the signed inbound endpoint (HMAC, one secret per app, timestamp window, replay protection), the inbox and its duplicate
 * protection, TC-05 / TC-06 in live HR mode, reserve-first checkout with compensation, the outbox dispatcher (retries, increasing
 * delays, dead letters, manual retry), the data CRM serves, the unmatched-sales reconciliation, Integration Health and permissions.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { check, startEnvironment, summarize, Client, root } from "./support/harness.mjs";
import { startFakeApps, offsetNow, INVENTORY_PRODUCTS, HR_FIXTURE } from "./support/fakeApps.mjs";
import { PAGES } from "./support/noSamples.mjs";
import * as sampleData from "./support/noSamples.mjs";
import { spawn } from "child_process";

const DB = process.env.TEST_P6_DB_NAME || "johnvivz_crm_p6_test";
const PORT = Number(process.env.TEST_P6_PORT || 3202);
const PORT2 = PORT + 100; // second server: mixed modes, for the "not live" checks
const uuid = () => crypto.randomUUID();
const secret = () => crypto.randomBytes(16).toString("hex");

const secrets = { hr: { out: secret(), in: secret() }, inventory: { out: secret(), in: secret() }, accounting: { out: secret(), in: secret() } };
const fake = await startFakeApps({ secrets, crmBase: `http://127.0.0.1:${PORT}` });
const liveEnv = {
  INTEGRATION_HR_MODE: "live", INTEGRATION_INVENTORY_MODE: "live", INTEGRATION_ACCOUNTING_MODE: "live",
  HR_API_BASE_URL: fake.hr.baseUrl, INVENTORY_API_BASE_URL: fake.inventory.baseUrl, ACCOUNTING_API_BASE_URL: fake.accounting.baseUrl,
  JVZ_SECRET_HR: secrets.hr.out, JVZ_SECRET_INVENTORY: secrets.inventory.out, JVZ_SECRET_ACCOUNTING: secrets.accounting.out,
  JVZ_CRM_INBOUND_SECRET_HR: secrets.hr.in, JVZ_CRM_INBOUND_SECRET_INVENTORY: secrets.inventory.in, JVZ_CRM_INBOUND_SECRET_ACCOUNTING: secrets.accounting.in,
};
// migrations, the demo seed and the fixtures run in MOCK mode (as on a real install); only the server runs live
const env = await startEnvironment({ dbName: DB, port: PORT, serverEnv: liveEnv });
console.log(`\nJOHNVIVZ CRM P6 tests — database ${DB} (HR, Inventory, Accounting: LIVE against local fake servers)\n`);
check("ENV-01", "Migrations (101–117), demo seed and fixtures load; the server starts with all three applications in live mode", env.steps.migrate.status === 0 && env.steps.seed.status === 0 && env.steps.fixtures.status === 0 && env.up,
  env.steps.migrate.stderr || env.steps.seed.stderr || env.steps.fixtures.stderr || env.serverLog());

const { all, one, db, as } = env;
// async on purpose: the fake servers live in THIS process, so a blocking spawnSync would stop them from answering
const nodeLive = (script, more = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env: { ...env.env, ...liveEnv, ...more } });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});
const decode = (s) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const alerts = (html) => [...html.matchAll(/role="(?:alert|status)">.*?<span>([^<]*)<\/span>/gs)].map((m) => decode(m[1]));
const flashAfter = async (client, p) => alerts((await client.get(p)).body).join(" | ");
const auditRows = async (action, extra = "", params = []) => all(`SELECT * FROM crm_audit_logs WHERE action = ? ${extra} ORDER BY id`, [action, ...params]);
const keyOf = (html) => (html.match(/name="request_key" value="([0-9a-f-]{36})"/) || [])[1];
const inboxRow = (eventId) => one("SELECT * FROM integration_inbox WHERE event_id = ?", [eventId]);
const outboxOf = (type, entityId) => all("SELECT * FROM integration_outbox WHERE event_type = ? AND entity_id = ? ORDER BY id", [type, entityId]);
const lastOrder = () => one("SELECT * FROM sales_orders WHERE is_demo = 0 ORDER BY id DESC LIMIT 1");
const orderCount = async () => Number((await one("SELECT COUNT(*) n FROM sales_orders")).n);
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "");
const runCompensations = () => nodeLive("const { processCompensations } = await import('./services/integration/compensationService.js'); const { sequelize } = await import('./models/index.js'); console.log('COMP ' + JSON.stringify(await processCompensations())); await sequelize.close();");
const ENV = (app) => ({ hr: fake.hr, inventory: fake.inventory, accounting: fake.accounting })[app];
const publish = (app, type, data, { entity = null, id = uuid(), idem = null, over = {}, opts = {} } = {}) => {
  const a = ENV(app);
  const envelope = { event_id: id, event_type: type, schema_version: 1, source: a.client, occurred_at: offsetNow(), entity_id: String(entity ?? data.product_id ?? data.employee_id ?? data.department_id ?? data.position_id ?? data.order_id ?? "x"), correlation_id: uuid(), idempotency_key: idem || `${type}:${uuid()}`, data, ...over };
  return a.sendToCrm(envelope, opts).then((r) => ({ ...r, envelope }));
};

try {
  const u = (email) => one("SELECT id, team_id FROM crm_users WHERE email = ?", [email]);
  const kristine = await u("kristine.bautista@johnvivz.test");
  const ernesto = await one("SELECT id, customer_id FROM customers WHERE first_name = 'Ernesto'");
  const juan = await one("SELECT id, customer_id FROM customers WHERE email = 'juan.cruz@johnvivz.test'");
  const agent = await as("kristine.bautista@johnvivz.test");
  const tl = await as("maria.santos@johnvivz.test");
  const mgr = await as("manager@johnvivz.test");
  const setup = await as("admin@johnvivz.test");
  const juanC = await as("juan.cruz@johnvivz.test");
  const ramonC = await as("ramon.aquino@johnvivz.test");

  // ================================================================ migration 117, defaults, permissions
  const mig = fs.readFileSync(path.join(root, "migrations", "117_p6_integration.js"), "utf8");
  const tables = (await all("SELECT table_name n FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('integration_request_nonces','integration_compensations')", [DB])).length;
  const perm = await all("SELECT r.code FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id JOIN roles r ON r.id = rp.role_id WHERE p.code = 'integration.manage' ORDER BY r.code");
  check("MIG-1", "Migration 117 only creates two tables and one permission (no ALTER of any existing table); integration.manage belongs to the CRM Manager and the setup System Administrator only",
    tables === 2 && !/ALTER\s+TABLE/i.test(mig) && perm.map((r) => r.code).join(",") === "crm_manager,system_admin", `${tables} ${perm.map((r) => r.code)}`);
  const exampleEnv = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const defaultModes = ["HR", "INVENTORY", "ACCOUNTING"].every((k) => new RegExp(`^INTEGRATION_${k}_MODE=mock\\s*$`, "m").test(exampleEnv) && new RegExp(`^JVZ_SECRET_${k}=\\s*$`, "m").test(exampleEnv));
  const cfgProbe = env.node(["--input-type=module", "-e", "const { config } = await import('./config/index.js'); console.log(JSON.stringify(Object.fromEntries(['hr','inventory','accounting'].map((k) => [k, config.integration[k].mode]))));"], { INTEGRATION_HR_MODE: "", INTEGRATION_INVENTORY_MODE: "", INTEGRATION_ACCOUNTING_MODE: "" });
  const envFileModes = fs.readFileSync(path.join(root, ".env"), "utf8").split("\n").filter((l) => /^INTEGRATION_.*_MODE=/.test(l)).map((l) => l.trim().split("=")[1]);
  check("MODE-1", "Every adapter is mock by default: .env.example and the local .env say mock, and an unset mode falls back to mock",
    defaultModes && envFileModes.length === 3 && envFileModes.every((m) => m === "mock") && cfgProbe.status === 0 && /"hr":"mock"/.test(cfgProbe.stdout) && /"inventory":"mock"/.test(cfgProbe.stdout) && /"accounting":"mock"/.test(cfgProbe.stdout), `${defaultModes} ${envFileModes} ${cfgProbe.stdout}`);
  check("SEED-6", "The demo seed is still exactly 7 accounts and every demo integration event is mock and unsent (test-only people are fixtures)",
    Number((await one("SELECT COUNT(*) n FROM crm_users WHERE is_demo = 1")).n) === 7 && Number((await one("SELECT COUNT(*) n FROM integration_outbox WHERE is_mock = 1 AND status <> 'mock_delivered'")).n) === 0);
  const mockBefore = await one("SELECT COUNT(*) n, MAX(id) mx FROM integration_outbox WHERE status = 'mock_delivered'");

  // ================================================================ signed inbound endpoint
  const p1 = { product_id: "LIVE-P-1", sku: "LIVE-RICE-5", name: "Live Rice 5kg", unit: "bag", category_name: "Rice & Grains", selling_price: "285.00", is_vatable: false, status: "active" };
  const ok = await publish("inventory", "ProductCreated", p1);
  check("SIG-1", "A correctly signed event is accepted (202) and stored in the inbox as processed", ok.status === 202 && ok.json?.status === "accepted" && (await inboxRow(ok.envelope.event_id))?.status === "processed", `${ok.status} ${ok.text}`);
  const unsigned = await fetch(`${env.base}/api/integration/v1/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event_id: uuid() }) });
  const noCsrf = unsigned.status; // no cookie, no CSRF token: the signature is the only credential
  const badSecret = await publish("inventory", "ProductUpdated", p1, { opts: { secret: "not-the-secret" } });
  const noSig = await publish("inventory", "ProductUpdated", p1, { opts: { signAs: "" } });
  check("SIG-2", "No signature, or a signature made with the wrong secret, is refused with 401 and stores nothing (no CSRF/session is involved)",
    noCsrf === 401 && badSecret.status === 401 && noSig.status === 401 && !(await inboxRow(badSecret.envelope.event_id)) && !(await inboxRow(noSig.envelope.event_id)), `${noCsrf} ${badSecret.status} ${noSig.status}`);
  const body1 = JSON.stringify({ event_id: uuid(), event_type: "StockUpdated", schema_version: 1, source: "johnvivz_inventory", occurred_at: offsetNow(), entity_id: "LIVE-P-1", correlation_id: uuid(), idempotency_key: `StockUpdated:${uuid()}`, data: { product_id: "LIVE-P-1", available_qty: 1 } });
  const ts1 = offsetNow();
  const signed1 = crypto.createHmac("sha256", secrets.inventory.in).update(["POST", "/api/integration/v1/events", ts1, crypto.createHash("sha256").update(body1).digest("hex")].join("\n")).digest("hex");
  const tamperedBody = body1.replace('"available_qty":1', '"available_qty":99999');
  const tamperRes = await fake.inventory.sendToCrm(null, { raw: tamperedBody, timestamp: ts1, signAs: signed1 });
  const tampered = await fake.inventory.sendToCrm(null, { raw: body1, timestamp: ts1, signAs: crypto.createHmac("sha256", secrets.inventory.in).update("something else").digest("hex") });
  check("SIG-3", "A body changed after signing is refused (401): the signature covers the exact bytes", tampered.status === 401 && tamperRes.status === 401 && (await one("SELECT available_qty FROM product_references WHERE product_id = 'LIVE-P-1'")).available_qty !== 99999, `${tampered.status} ${tamperRes.status}`);
  const old = await publish("inventory", "ProductUpdated", p1, { opts: { timestamp: new Date(Date.now() + 8 * 3600e3 - 10 * 60e3).toISOString().replace("Z", "+08:00") } });
  const future = await publish("inventory", "ProductUpdated", p1, { opts: { timestamp: new Date(Date.now() + 8 * 3600e3 + 10 * 60e3).toISOString().replace("Z", "+08:00") } });
  const fresh = await publish("inventory", "ProductUpdated", p1, { opts: { timestamp: new Date(Date.now() + 8 * 3600e3 - 4 * 60e3).toISOString().replace("Z", "+08:00") } });
  check("SIG-4", "Timestamp window: 10 minutes old or 10 minutes ahead is refused (401 stale_timestamp); 4 minutes old is accepted", old.status === 401 && old.json?.error === "stale_timestamp" && future.status === 401 && fresh.status === 202, `${old.status} ${future.status} ${fresh.status}`);
  const rbody = JSON.stringify({ event_id: uuid(), event_type: "ProductUpdated", schema_version: 1, source: "johnvivz_inventory", occurred_at: offsetNow(), entity_id: "LIVE-P-1", correlation_id: uuid(), idempotency_key: `ProductUpdated:${uuid()}`, data: p1 });
  const rts = offsetNow();
  const first = await fake.inventory.sendToCrm(null, { raw: rbody, timestamp: rts });
  const replay = await fake.inventory.sendToCrm(null, { raw: rbody, timestamp: rts });
  const nonces = Number((await one("SELECT COUNT(*) n FROM integration_request_nonces")).n);
  check("SIG-5", "Replay protection: the exact same signed request sent again is refused (401 replayed_request); the guard rows are stored", first.status === 202 && replay.status === 401 && replay.json?.error === "replayed_request" && nonces >= 3, `${first.status} ${replay.status} ${replay.text} ${nonces}`);
  const hrWithInvSecret = await publish("hr", "EmployeeStatusChanged", { employee_id: "MOCK-EMP-T003", employment_status: "separated" }, { opts: { secret: secrets.inventory.in } });
  const invAsHr = await publish("inventory", "ProductUpdated", p1, { opts: { client: "johnvivz_hr" } });
  const unknownClient = await publish("inventory", "ProductUpdated", p1, { opts: { client: "johnvivz_payroll" } });
  const invSendsHr = await publish("inventory", "EmployeeStatusChanged", { employee_id: "MOCK-EMP-T003", employment_status: "separated" });
  const acctSends = await publish("accounting", "SalePosted", { sale_id: uuid() });
  check("SIG-6", "One secret per app: another app's secret is refused, an unknown client is refused, and an app may send only its own event types (Inventory cannot revoke staff access; Accounting sends nothing yet)",
    hrWithInvSecret.status === 401 && invAsHr.status === 401 && unknownClient.status === 401 && invSendsHr.status === 400 && /may not send/.test(invSendsHr.text) && acctSends.status === 400 &&
    (await one("SELECT employment_status s FROM employee_references WHERE employee_id = 'MOCK-EMP-T003'")).s === "active", `${hrWithInvSecret.status} ${invAsHr.status} ${unknownClient.status} ${invSendsHr.status} ${acctSends.status}`);

  // schema errors
  const inboxBefore = Number((await one("SELECT COUNT(*) n FROM integration_inbox")).n);
  const bad = [];
  for (const [name, over] of [["no event_id", { event_id: undefined }], ["bad schema_version", { schema_version: 2 }], ["wrong source", { source: "johnvivz_hr" }], ["no idempotency_key", { idempotency_key: "" }], ["bad time", { occurred_at: "yesterday" }], ["data not an object", { data: "x" }]]) {
    const r = await publish("inventory", "ProductUpdated", p1, { over });
    if (r.status !== 400 || r.json?.error !== "invalid_envelope") bad.push(`${name}: ${r.status}`);
  }
  const notJson = await fake.inventory.sendToCrm(null, { raw: "{not json" });
  check("SIG-7", "Schema errors are answered 400 (invalid_envelope with details, invalid_json) and nothing reaches the inbox", bad.length === 0 && notJson.status === 400 && Number((await one("SELECT COUNT(*) n FROM integration_inbox")).n) === inboxBefore, bad.join("; "));

  // ================================================================ inbox: duplicates and processors
  const dupId = uuid();
  const d1 = await publish("inventory", "ProductPriceUpdated", { product_id: "LIVE-P-1", selling_price: "290.00" }, { id: dupId });
  const d2 = await publish("inventory", "ProductPriceUpdated", { product_id: "LIVE-P-1", selling_price: "777.00" }, { id: dupId });
  const idemKey = `ProductPriceUpdated:${uuid()}`;
  const d3 = await publish("inventory", "ProductPriceUpdated", { product_id: "LIVE-P-1", selling_price: "291.00" }, { idem: idemKey });
  const d4 = await publish("inventory", "ProductPriceUpdated", { product_id: "LIVE-P-1", selling_price: "888.00" }, { idem: idemKey });
  check("INB-1", "Duplicate protection: the same event_id, or the same sender + idempotency_key under a new event_id, is answered 200 duplicate and NOT processed again",
    d1.status === 202 && d2.status === 200 && d2.json?.status === "duplicate" && d3.status === 202 && d4.status === 200 && d4.json?.status === "duplicate" &&
    Number((await one("SELECT selling_price p FROM product_references WHERE product_id = 'LIVE-P-1'")).p) === 291 && Number((await one("SELECT COUNT(*) n FROM integration_inbox WHERE event_id = ?", [dupId])).n) === 1);
  await publish("inventory", "ProductCreated", { ...INVENTORY_PRODUCTS[1], selling_price: "98.00", stock: undefined });
  const low = await publish("inventory", "LowStockDetected", { product_id: "LIVE-P-2", available_qty: 4 });
  const upd = await publish("inventory", "StockUpdated", { product_id: "LIVE-P-2", available_qty: 12 });
  const gone = await publish("inventory", "StockUnavailable", { product_id: "LIVE-P-2" });
  const snap = await one("SELECT * FROM product_references WHERE product_id = 'LIVE-P-2'");
  const unknownProduct = await publish("inventory", "StockUpdated", { product_id: "NO-SUCH-PRODUCT", available_qty: 3 });
  const ign = await inboxRow(unknownProduct.envelope.event_id);
  check("INB-2", "Inventory events update the read-only snapshot (ProductCreated/Updated/PriceUpdated, LowStockDetected, StockUpdated, StockUnavailable); the rows are flagged real (not mock) and an event for an unknown product is stored as ignored with a note",
    low.status === 202 && upd.status === 202 && gone.status === 202 && snap.is_mock === 0 && snap.source === "johnvivz_inventory" && Number(snap.available_qty) === 0 && snap.low_stock === 0 && Number(snap.selling_price) === 98 && ign.status === "ignored" && /not in the snapshot/.test(ign.last_error), JSON.stringify([snap, ign?.status]));
  const lowRow = await inboxRow(low.envelope.event_id);
  check("INB-3", "Each processed event records its outcome and time in the inbox (status processed, attempts 1) and a line in the call log", lowRow.status === "processed" && lowRow.attempts === 1 && lowRow.processed_at && Number((await one("SELECT COUNT(*) n FROM integration_logs WHERE direction = 'inbound_event' AND event_id = ?", [low.envelope.event_id])).n) === 1);

  // ================================================================ HR: restricted data, TC-05, TC-06 in live mode
  const emp1 = HR_FIXTURE.employees[0];
  const created = await publish("hr", "EmployeeCreated", emp1);
  const stored = await one("SELECT * FROM employee_references WHERE employee_id = 'LIVE-EMP-1'");
  const leak = await one("SELECT (SELECT COUNT(*) FROM integration_inbox WHERE payload LIKE '%99999%' OR payload LIKE '%0123456789%' OR payload LIKE '%salary%' OR payload LIKE '%bank_account%') a, (SELECT COUNT(*) FROM integration_logs WHERE message LIKE '%99999%' OR message LIKE '%0123456789%') b");
  check("HRL-1", "EmployeeCreated from HR creates a real (not mock) employee reference; salary and bank fields in the payload are removed BEFORE storing (nothing restricted in the inbox, the references or the logs)",
    created.status === 202 && stored && stored.is_mock === 0 && stored.source === "johnvivz_hr" && stored.full_name === "Live Employee One" && Number(leak.a) === 0 && Number(leak.b) === 0 &&
    Number((await one("SELECT COUNT(*) n FROM integration_logs WHERE message LIKE 'Removed % restricted field(s)%'")).n) >= 1, JSON.stringify([stored, leak]));
  // a CRM login linked to a real HR employee
  const hash = (await one("SELECT password_hash h FROM crm_users WHERE email = 'kristine.bautista@johnvivz.test'")).h;
  await db.query("INSERT INTO crm_users (user_type, role, employee_id, email, password_hash, display_name, team_id, is_active, is_demo) VALUES ('staff','agent','LIVE-EMP-1','live.agent@johnvivz.test',?,'Live Agent',?,1,0)", [hash, kristine.team_id]);
  const liveAgent = await as("live.agent@johnvivz.test");
  const beforeSep = await liveAgent.get("/crm/agent");
  const sep = await publish("hr", "EmployeeStatusChanged", { employee_id: "LIVE-EMP-1", employment_status: "separated" });
  const afterSep = await liveAgent.get("/crm/agent");
  const relog = await new Client(env.base).login("live.agent@johnvivz.test");
  check("TC-05", "LIVE HR mode: a signed EmployeeStatusChanged 'separated' for a real HR employee ends the agent's open session on the next request and blocks sign-in",
    beforeSep.status === 200 && sep.status === 202 && afterSep.status === 302 && afterSep.location === "/login" && relog.status === 403 && /separated/i.test(relog.body), `${beforeSep.status} ${sep.status} ${afterSep.status} ${relog.status}`);
  const reactivate = await publish("hr", "EmployeeStatusChanged", { employee_id: "LIVE-EMP-1", employment_status: "active" });
  const relog2 = await new Client(env.base).login("live.agent@johnvivz.test");
  check("TC-05b", "LIVE HR mode: reactivation lifts the HR block (sign-in works again)", reactivate.status === 202 && relog2.status === 302, `${reactivate.status} ${relog2.status}`);
  const ramonBefore = await ramonC.get("/crm/agent");
  const sepMock = await publish("hr", "EmployeeStatusChanged", { employee_id: "MOCK-EMP-T003", employment_status: "inactive" });
  const ramonAfter = await ramonC.get("/crm/agent");
  await publish("hr", "EmployeeStatusChanged", { employee_id: "MOCK-EMP-T003", employment_status: "active" });
  const sepAudit = await auditRows("hr_employment_status_applied");
  check("TC-05c", "LIVE HR mode: the same endpoint also ends access of an employee already in the references (inactive); each applied change is audited with before/after values and the HR event id",
    ramonBefore.status === 200 && sepMock.status === 202 && ramonAfter.status === 302 && sepAudit.length >= 4 && sepAudit.every((r) => r.before_values && r.after_values) && sepAudit.some((r) => r.details.includes(sep.envelope.event_id)), `${ramonBefore.status} ${ramonAfter.status} ${sepAudit.length}`);
  fake.hr.extraEmployees.push({ employee_id: "LIVE-EMP-9", full_name: "Live Employee Nine", work_email: "live9@example.test", department_id: "LIVE-DEP-1", position_id: "LIVE-POS-1", employment_status: "active", supervisor_employee_id: null });
  const unknownEmp = await publish("hr", "EmployeeStatusChanged", { employee_id: "LIVE-EMP-9", employment_status: "inactive" });
  const nine = await one("SELECT employment_status s, is_mock m FROM employee_references WHERE employee_id = 'LIVE-EMP-9'");
  const ghost = await publish("hr", "EmployeeStatusChanged", { employee_id: "GHOST-EMP", employment_status: "inactive" });
  check("HRL-2", "An EmployeeStatusChanged for an employee CRM has not heard of triggers one GET /employees/{id} to HR and then applies the status; an employee HR does not know ends dead (no retry can fix it)",
    unknownEmp.status === 202 && nine?.s === "inactive" && nine.m === 0 && fake.hr.requests.some((r) => r.path === "/api/integration/v1/employees/LIVE-EMP-9" && r.authorized) && (await inboxRow(ghost.envelope.event_id)).status === "dead", JSON.stringify(nine));

  await db.query("UPDATE department_references SET last_synced_at = '2020-01-01 00:00:00'");
  const depNew = await publish("hr", "DepartmentCreated", HR_FIXTURE.departments[0]);
  await publish("hr", "PositionCreated", HR_FIXTURE.positions[0]);
  const depUpd = await publish("hr", "DepartmentUpdated", { department_id: "LIVE-DEP-1", name: "Customer Relations & Care" });
  const posUpd = await publish("hr", "PositionUpdated", { position_id: "LIVE-POS-1", title: "Customer Care Representative" });
  const dep = await one("SELECT * FROM department_references WHERE department_id = 'LIVE-DEP-1'");
  const pos = await one("SELECT * FROM position_references WHERE position_id = 'LIVE-POS-1'");
  const fresh5 = (d) => Date.now() - new Date(d).getTime() < 5 * 60000;
  const refAudit = await auditRows("hr_reference_updated");
  const depAudit = refAudit.find((r) => r.record_id === "LIVE-DEP-1" && JSON.stringify(r.before_values || "").includes("Customer Relations") && JSON.stringify(r.after_values || "").includes("Care"));
  check("TC-06", "LIVE HR mode: DepartmentUpdated / PositionUpdated through the signed endpoint update the CRM copy (real rows) and refresh last_synced_at; the change is audited with before/after",
    depNew.status === 202 && depUpd.status === 202 && posUpd.status === 202 && dep.name === "Customer Relations & Care" && dep.is_mock === 0 && pos.title === "Customer Care Representative" && fresh5(dep.last_synced_at) && fresh5(pos.last_synced_at) && depAudit, JSON.stringify([dep, pos]));
  const access = await mgr.get("/crm/settings/access");
  const editTry = await mgr.post("/crm/settings/access/employees/LIVE-EMP-1", { full_name: "Changed" });
  const sim = await mgr.post("/setup/staff/hr-reference", { reference_id: "department:LIVE-DEP-1", label: "Hijack" });
  const deact = await publish("hr", "DepartmentDeactivated", { department_id: "LIVE-DEP-2" });
  await publish("hr", "DepartmentCreated", HR_FIXTURE.departments[1]);
  const deact2 = await publish("hr", "DepartmentDeactivated", { department_id: "LIVE-DEP-2" });
  check("TC-06b", "The Manager's screen shows the updated HR name read-only; CRM users have no way to edit HR references (404 / 403); a deactivation event turns the copy inactive",
    access.body.includes("Customer Relations &amp; Care") && editTry.status === 404 && sim.status === 403 && (await one("SELECT name FROM department_references WHERE department_id = 'LIVE-DEP-1'")).name === "Customer Relations & Care" && deact2.status === 202 && (await one("SELECT is_active a FROM department_references WHERE department_id = 'LIVE-DEP-2'")).a === 0 && deact.status === 202);
  const reqSub = await publish("hr", "EmployeeRequestSubmitted", { request_id: "REQ-1", request_type: "leave", employee_id: "LIVE-EMP-1" });
  check("HRL-3", "EmployeeRequestSubmitted is stored and ignored with a note (APPROVALS_ENABLED is off, so nothing is routed; P7 can reprocess it later)", reqSub.status === 202 && (await inboxRow(reqSub.envelope.event_id)).status === "ignored" && /not enabled/.test((await inboxRow(reqSub.envelope.event_id)).last_error));

  // HR first load (live syncReferences) and lookup, run as a script with the live environment
  const syncRun = await nodeLive("const { syncReferences, lookupEmployee } = await import('./services/integration/hrAdapter.js'); const { sequelize } = await import('./models/index.js'); const r = await syncReferences(); const l = await lookupEmployee('LIVE-EMP-2'); const none = await lookupEmployee('NOPE'); console.log('RESULT ' + JSON.stringify({ r, l: l && l.employee_id, none })); await sequelize.close();");
  const emp2 = await one("SELECT is_mock m, source s FROM employee_references WHERE employee_id = 'LIVE-EMP-2'");
  check("HRL-4", "Live HR first load: syncReferences pages through /departments, /positions and /employees (signed GET calls, 2 per page) and stores real rows; lookupEmployee returns an employee, or null for an unknown id",
    syncRun.status === 0 && /RESULT \{"r":\{"departments":2,"positions":1,"employees":2\},"l":"LIVE-EMP-2","none":null\}/.test(syncRun.stdout) && emp2?.m === 0 && emp2.s === "johnvivz_hr" && fake.hr.requests.filter((r) => r.path.startsWith("/api/integration/v1/employees?page=")).length === 2, `${syncRun.stdout} ${syncRun.stderr.slice(0, 300)}`);

  // ================================================================ inbound retry and dead
  const lost = await publish("inventory", "StockIssued", { order_id: uuid() });
  const lostRow = await inboxRow(lost.envelope.event_id);
  let after5 = lostRow;
  for (let i = 0; i < 5; i++) {
    await nodeLive("const { processInboxBacklog } = await import('./services/integration/inboxService.js'); const { sequelize } = await import('./models/index.js'); await processInboxBacklog(); await sequelize.close();");
    after5 = await inboxRow(lost.envelope.event_id);
  }
  check("INB-4", "An event that cannot be processed yet (order not in CRM) is stored as failed and retried by the background job; after 5 attempts it is dead and stays visible for a manual reprocess",
    lostRow.status === "failed" && lostRow.attempts === 1 && after5.status === "dead" && after5.attempts === 5 && /not in CRM/.test(after5.last_error), `${lostRow.status}/${lostRow.attempts} -> ${after5.status}/${after5.attempts}`);

  // ================================================================ live Inventory: shop, snapshot, checkout
  const shop = await juanC.get("/portal/shop");
  const syncBtn = await mgr.get("/crm/sales");
  const syncRes = await mgr.post("/crm/sales/sync", {});
  const live = await all("SELECT product_id, is_mock FROM product_references WHERE product_id LIKE 'LIVE-P-%' ORDER BY product_id");
  check("INV-1", "Live Inventory: the shop lists the products, prices and stock from the Inventory server (no MOCK Inventory notice, inactive products hidden); 'Refresh product snapshot' pulls them through the signed product list",
    shop.status === 200 && shop.body.includes("Live Rice 5kg") && shop.body.includes("₱285.00") && !shop.body.includes('data-mock-inventory="1"') && !shop.body.includes("Live Discontinued Biscuits") && syncRes.status === 302 && live.length === 4 && live.every((r) => r.is_mock === 0), `${shop.status} ${live.length}`);
  const signedOk = fake.inventory.requests.filter((r) => r.path.startsWith("/api/integration/v1/products")).every((r) => r.authorized && r.headers["x-jvz-client"] === "johnvivz_crm");
  check("INV-2", "Every call to the fake Inventory carried a valid HMAC signature made with CRM's secret (the fake checks with its own code)", signedOk && fake.inventory.requests.length > 5 && fake.inventory.requests.every((r) => r.authorized), `${fake.inventory.requests.filter((r) => !r.authorized).length} unauthorized`);

  const addTo = (c, pid, qty) => c.post("/portal/cart/add", { product_id: pid, quantity: String(qty), back: "/portal/shop" });
  await juanC.get("/portal/shop");
  await addTo(juanC, "LIVE-P-1", 2);
  await addTo(juanC, "LIVE-P-2", 1);
  const cartPage = (await juanC.get("/portal/cart")).body;
  const key1 = keyOf(cartPage);
  fake.inventory.requests.length = 0;
  const placed = await juanC.post("/portal/cart/checkout", { request_key: key1, fulfillment: "pickup", payment_method: "cod" });
  const o1 = await lastOrder();
  const rsvCalls = fake.inventory.requests.filter((r) => r.method === "POST" && r.path === "/api/integration/v1/reservations");
  const rsvBody = rsvCalls[0] ? JSON.parse(rsvCalls[0].body) : {};
  const ev1 = o1 ? await outboxOf("OrderConfirmed", o1.order_id) : [];
  check("CHK-1", "Live checkout: Inventory is asked first (price, availability, then ONE reservation call with the order id, the order's correlation id and an Idempotency-Key), then the order is saved as Confirmed/Reserved with Inventory's reservation id; OrderConfirmed is queued as pending for Inventory",
    placed.status === 302 && o1 && o1.status === "confirmed" && o1.reservation_status === "reserved" && o1.inventory_reservation_ref === "RSV-0001" && Number(o1.grand_total) === 668 && rsvCalls.length === 1 && rsvBody.order_id === o1.order_id && rsvBody.correlation_id === o1.correlation_id &&
    rsvCalls[0].headers["idempotency-key"] === `reserve:${o1.order_id}` && fake.inventory.reservations.get(o1.order_id)?.reservation_id === "RSV-0001" && ev1.length === 1 && ev1[0].status === "pending" && ev1[0].is_mock === 0 && ev1[0].attempts === 0, `${placed.status} ${JSON.stringify(o1 && [o1.status, o1.inventory_reservation_ref, o1.grand_total])} ${rsvCalls.length}`);
  const order1Calls = fake.inventory.requests.map((r) => `${r.method} ${r.path.split("?")[0].replace("/api/integration/v1", "")}`);
  const lastPrice = Math.max(...order1Calls.map((c, i) => (/\/price$/.test(c) ? i : -1)));
  check("CHK-2", "Order of work: the price/availability checks come BEFORE the reservation call, and the reservation call comes before the order exists", lastPrice >= 0 && lastPrice < order1Calls.indexOf("POST /reservations"), order1Calls.join(" | "));
  const dupCheckout = await juanC.post("/portal/cart/checkout", { request_key: key1, fulfillment: "pickup", payment_method: "cod" });
  check("CHK-3", "A resubmitted checkout (same request key) returns the existing order: still ONE order, ONE reservation at Inventory, no second call", dupCheckout.status === 302 && (await all("SELECT id FROM sales_orders WHERE order_id = ?", [o1.order_id])).length === 1 && fake.inventory.reservations.size === 1 && fake.inventory.requests.filter((r) => r.method === "POST" && r.path.endsWith("/reservations")).length === 1);

  const ordersBeforeFail = await orderCount();
  const tryOrder = async (client, pid, qty, extra = {}) => {
    await client.get("/crm/sales/new?customer_id=" + ernesto.id);
    return client.post("/crm/sales", { customer_id: String(ernesto.id), request_key: uuid(), channel: "walk_in", fulfillment: "pickup", [`qty_${pid}`]: String(qty), payment_method: "cash", ...extra });
  };
  const tooMany = await tryOrder(agent, "LIVE-P-3", 5);
  const inactive = await tryOrder(agent, "LIVE-P-4", 1);
  INVENTORY_PRODUCTS[1].selling_price = "100.00"; // the price changes at Inventory after the form was shown
  await agent.get(`/crm/sales/new?customer_id=${ernesto.id}`);
  const priceKey = uuid();
  const priceChanged = await agent.post("/crm/sales", { customer_id: String(ernesto.id), request_key: priceKey, channel: "walk_in", fulfillment: "pickup", "qty_LIVE-P-2": "1", "price_LIVE-P-2": "98.00", payment_method: "cash" });
  INVENTORY_PRODUCTS[1].selling_price = "98.00";
  check("CHK-4", "Live checkout rejects the order (nothing saved, nothing left reserved at Inventory) when stock is not enough, the product is not sold any more, or the price changed",
    tooMany.status === 409 && /only 3/.test(decode(tooMany.body)) && [409, 422].includes(inactive.status) && priceChanged.status === 409 && /changed from/.test(decode(priceChanged.body)) && (await orderCount()) === ordersBeforeFail && fake.inventory.reservations.size === 1 && fake.inventory.reservedOf("LIVE-P-3") === 0, `${tooMany.status} ${inactive.status} ${priceChanged.status}`);

  // saving fails after the reservation: the reservation is released at once
  await db.query("CREATE TRIGGER p6_fail_save BEFORE INSERT ON sales_order_items FOR EACH ROW BEGIN IF NEW.product_id = 'LIVE-P-2' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test: saving fails'; END IF; END");
  const failKey = uuid();
  await agent.get(`/crm/sales/new?customer_id=${ernesto.id}`);
  const failSave = await agent.post("/crm/sales", { customer_id: String(ernesto.id), request_key: failKey, channel: "walk_in", fulfillment: "pickup", "qty_LIVE-P-2": "2", payment_method: "cash" });
  const failedRsv = fake.inventory.reservations.get(failKey);
  check("CHK-5", "If saving the order fails AFTER the reservation, the reservation is released at Inventory at once (DELETE), no order exists and no clean-up task is left",
    failSave.status >= 500 && (await orderCount()) === ordersBeforeFail && failedRsv && failedRsv.released === true && fake.inventory.reservedOf("LIVE-P-2") === 1 /* only order 1 */ && Number((await one("SELECT COUNT(*) n FROM integration_compensations")).n) === 0, `${failSave.status} ${JSON.stringify(failedRsv)}`);
  fake.inventory.failDeletes = 1;
  const failKey2 = uuid();
  await agent.get(`/crm/sales/new?customer_id=${ernesto.id}`);
  await agent.post("/crm/sales", { customer_id: String(ernesto.id), request_key: failKey2, channel: "walk_in", fulfillment: "pickup", "qty_LIVE-P-2": "3", payment_method: "cash" });
  const stuck = fake.inventory.reservations.get(failKey2);
  const comp1 = await one("SELECT * FROM integration_compensations WHERE order_id = ?", [failKey2]);
  await db.query("DROP TRIGGER p6_fail_save");
  check("CHK-6", "If the release call fails too, a clean-up task (release_reservation) is queued with the reservation id, the stock stays held for now, and Integration Health will show it",
    stuck && stuck.released === false && comp1 && comp1.kind === "release_reservation" && comp1.status === "pending" && comp1.reservation_ref === stuck.reservation_id && comp1.attempts === 0, JSON.stringify([stuck, comp1]));
  const adminList = await mgr.get("/crm/settings/integration");
  const run1 = await runCompensations();
  const comp1b = await one("SELECT * FROM integration_compensations WHERE order_id = ?", [failKey2]);
  check("CHK-7", "The dispatcher runs the clean-up task: the reservation is released at Inventory and the task is done", adminList.body.includes("Stock clean-up tasks") && run1.status === 0 && comp1b.status === "done" && fake.inventory.reservations.get(failKey2).released === true && fake.inventory.reservedOf("LIVE-P-2") === 1, JSON.stringify(comp1b));

  // an answer that never arrives
  fake.inventory.dropAnswers(1);
  const dropKey = uuid();
  await agent.get(`/crm/sales/new?customer_id=${ernesto.id}`);
  const dropped = await agent.post("/crm/sales", { customer_id: String(ernesto.id), request_key: dropKey, channel: "walk_in", fulfillment: "pickup", "qty_LIVE-P-1": "1", "price_LIVE-P-1": "285.00", payment_method: "cash" });
  const droppedOrder = await one("SELECT * FROM sales_orders WHERE order_id = ?", [dropKey]);
  check("CHK-8", "A lost reservation answer is repeated once (same order id, so Inventory returns the SAME reservation): the order is saved and Inventory holds exactly one reservation for it",
    dropped.status === 302 && droppedOrder && droppedOrder.inventory_reservation_ref === fake.inventory.reservations.get(dropKey).reservation_id && fake.inventory.requests.filter((r) => r.method === "POST" && r.path.endsWith("/reservations") && r.body.includes(dropKey)).length === 2 && [...fake.inventory.reservations.keys()].filter((k) => k === dropKey).length === 1, `${dropped.status} ${JSON.stringify(droppedOrder && droppedOrder.inventory_reservation_ref)}`);
  fake.inventory.dropAnswers(2);
  const unknownKey = uuid();
  const beforeUnknown = await orderCount();
  await agent.get(`/crm/sales/new?customer_id=${ernesto.id}`);
  const unknown = await agent.post("/crm/sales", { customer_id: String(ernesto.id), request_key: unknownKey, channel: "walk_in", fulfillment: "pickup", "qty_LIVE-P-1": "1", "price_LIVE-P-1": "285.00", payment_method: "cash" });
  const compU = await one("SELECT * FROM integration_compensations WHERE order_id = ?", [unknownKey]);
  const heldU = fake.inventory.reservations.get(unknownKey);
  check("CHK-9", "If no answer ever arrives, the order is NOT placed (503 with a clear message), and a resolve_reservation task is queued because Inventory may hold stock",
    unknown.status === 503 && /did not confirm/.test(decode(unknown.body)) && (await orderCount()) === beforeUnknown && compU?.kind === "resolve_reservation" && compU.status === "pending" && heldU && heldU.released === false, `${unknown.status} ${JSON.stringify(compU && compU.kind)}`);
  await runCompensations();
  const compU2 = await one("SELECT * FROM integration_compensations WHERE order_id = ?", [unknownKey]);
  check("CHK-10", "The task asks Inventory again with the same order id (idempotent), learns the reservation and releases it: no stock stays held for an order that was never saved", compU2.status === "done" && fake.inventory.reservations.get(unknownKey).released === true && /released/.test(compU2.last_error || ""), JSON.stringify(compU2));

  // ================================================================ dispatcher: OrderConfirmed
  fake.inventory.requests.length = 0;
  const evPending = await outboxOf("OrderConfirmed", o1.order_id);
  const disp1 = await mgr.post("/crm/settings/integration/dispatch", {});
  const evSent = await outboxOf("OrderConfirmed", o1.order_id);
  const received = fake.inventory.eventsOf("OrderConfirmed");
  const evReq = fake.inventory.requests.find((r) => r.path === "/api/integration/v1/events");
  check("DSP-1", "The dispatcher sends the pending OrderConfirmed as a signed POST /api/integration/v1/events; the fake Inventory accepted it (202) after checking the HMAC and validating the envelope and data against the contract; the outbox row becomes sent (attempts 1)",
    evPending[0].status === "pending" && disp1.status === 302 && evSent[0].status === "sent" && evSent[0].attempts === 1 && evSent[0].sent_at && received.filter((e) => e.entity_id === o1.order_id).length === 1 && received.find((e) => e.entity_id === o1.order_id).event_id === evSent[0].event_id && received.find((e) => e.entity_id === o1.order_id).data.reservation_id === "RSV-0001" &&
    evReq?.authorized && evReq.headers["idempotency-key"] === `OrderConfirmed:${o1.order_id}` && fake.inventory.rejected.length === 0, `${evSent[0].status} ${fake.inventory.rejected.length} ${JSON.stringify(fake.inventory.rejected[0]?.problems)}`);

  // ================================================================ sale, SaleCompleted to two targets, cancel, refund
  await agent.get(`/crm/sales/new?customer_id=${ernesto.id}`);
  const saleKey = uuid();
  await agent.post("/crm/sales", { customer_id: String(ernesto.id), request_key: saleKey, channel: "walk_in", fulfillment: "pickup", "qty_LIVE-P-1": "2", "price_LIVE-P-1": "285.00", "qty_LIVE-P-2": "1", "price_LIVE-P-2": "98.00", payment_method: "cash" });
  const so = await one("SELECT * FROM sales_orders WHERE order_id = ?", [saleKey]);
  await agent.get(`/crm/sales/orders/${so.id}`);
  const done = await agent.post(`/crm/sales/orders/${so.id}/complete`, {});
  const sale = await one("SELECT * FROM sales_transactions WHERE sales_order_id = ?", [so.id]);
  const soAfter = await one("SELECT reservation_status FROM sales_orders WHERE id = ?", [so.id]);
  const scOutbox = await outboxOf("SaleCompleted", sale.sale_id);
  check("SALE-1", "Completing a sale creates ONE sale and ONE SaleCompleted per target (Inventory and Accounting, both pending); in live mode the stock shows Reserved until Inventory confirms with StockIssued (no issue call exists in the contract)",
    done.status === 302 && sale && scOutbox.length === 2 && scOutbox.every((r) => r.status === "pending") && new Set(scOutbox.map((r) => r.target)).size === 2 && soAfter.reservation_status === "reserved");
  fake.inventory.requests.length = 0;
  fake.accounting.requests.length = 0;
  await mgr.post("/crm/settings/integration/dispatch", {});
  const invGot = fake.inventory.eventsOf("SaleCompleted");
  const accGot = fake.accounting.eventsOf("SaleCompleted");
  check("DSP-2", "SaleCompleted reaches BOTH Inventory and Accounting exactly once with the contract's fields (items with line totals, discounts, totals, payments with paid_at, money as decimal strings, no VAT split)",
    invGot.length === 1 && accGot.length === 1 && invGot[0].event_id !== accGot[0].event_id && invGot[0].correlation_id === so.correlation_id && accGot[0].correlation_id === so.correlation_id && accGot[0].data.totals.net === "668.00" && accGot[0].data.payments[0].method === "cash" && accGot[0].data.items.length === 2 && accGot[0].data.vat === undefined && accGot[0].data.tax_total === undefined &&
    fake.inventory.rejected.length === 0 && fake.accounting.rejected.length === 0 && (await outboxOf("SaleCompleted", sale.sale_id)).every((r) => r.status === "sent"), JSON.stringify([fake.inventory.rejected, fake.accounting.rejected]));
  const stockIssued = await publish("inventory", "StockIssued", { order_id: saleKey, reservation_id: "RSV-X" });
  check("DSP-3", "Inventory's StockIssued event moves the completed order to 'issued' (inbound processor)", stockIssued.status === 202 && (await one("SELECT reservation_status s FROM sales_orders WHERE id = ?", [so.id])).s === "issued");
  const stockReserved = await publish("inventory", "StockReserved", { order_id: o1.order_id, reservation_id: "RSV-0001" });
  check("DSP-3b", "StockReserved is applied idempotently to an order that is already reserved", stockReserved.status === 202 && (await inboxRow(stockReserved.envelope.event_id)).status === "processed" && (await one("SELECT inventory_reservation_ref r FROM sales_orders WHERE id = ?", [o1.id])).r === "RSV-0001");

  // cancel an order: stock released through Inventory AND SaleCancelled delivered
  await agent.get(`/crm/sales/orders/${o1.id}`);
  fake.inventory.requests.length = 0;
  const cancelled = await agent.post(`/crm/sales/orders/${o1.id}/cancel`, { reason: "Customer asked to cancel by phone" });
  const rel = fake.inventory.requests.filter((r) => r.method === "DELETE");
  await mgr.post("/crm/settings/integration/dispatch", {});
  const scc = fake.inventory.eventsOf("SaleCancelled");
  check("DSP-4", "Cancelling an order gives the stock back through Inventory (DELETE /reservations/RSV-0001, idempotent) and SaleCancelled (with release_items) is delivered to Inventory and Accounting",
    cancelled.status === 302 && rel.length === 1 && rel[0].path === "/api/integration/v1/reservations/RSV-0001" && fake.inventory.reservations.get(o1.order_id).released === true && scc.length === 1 && scc[0].data.release_items.length === 2 && scc[0].data.sale_id === null && fake.accounting.eventsOf("SaleCancelled").length === 1 &&
    fake.inventory.rejected.length === 0, `${cancelled.status} ${rel.length}`);

  // refund recorded
  await agent.get(`/crm/sales/orders/${so.id}`);
  await agent.post(`/crm/sales/orders/${so.id}/refund`, { amount: "98", reason: "One carton of milk was spoiled", "ret_qty_LIVE-P-2": "1", "ret_cond_LIVE-P-2": "expired" });
  const rf = await one("SELECT * FROM refunds ORDER BY id DESC LIMIT 1");
  await mgr.get(`/crm/sales/refunds/${rf.id}`);
  await mgr.post(`/crm/sales/refunds/${rf.id}/decide`, { decision: "approve" });
  await mgr.post(`/crm/sales/refunds/${rf.id}/record`, {});
  await mgr.post("/crm/settings/integration/dispatch", {});
  const rfInv = fake.inventory.eventsOf("RefundRecorded");
  const rfAcc = fake.accounting.eventsOf("RefundRecorded");
  check("DSP-5", "RefundRecorded (amount as a decimal string, return items with condition, approver's HR employee id) is delivered once to Inventory and once to Accounting and passes the contract checks",
    rfInv.length === 1 && rfAcc.length === 1 && rfInv[0].data.amount === "98.00" && rfInv[0].data.return_items[0].condition === "expired" && rfInv[0].data.approved_by_employee_id === (await one("SELECT employee_id e FROM crm_users WHERE email = 'manager@johnvivz.test'")).e && rfInv[0].data.refund_id === rf.refund_id && fake.inventory.rejected.length === 0 && fake.accounting.rejected.length === 0, JSON.stringify(rfInv[0]?.data));

  // ================================================================ retries, increasing delays, dead letters
  // a second completed sale whose Accounting delivery fails
  await agent.get(`/crm/sales/new?customer_id=${ernesto.id}`);
  const sale2Key = uuid();
  await agent.post("/crm/sales", { customer_id: String(ernesto.id), request_key: sale2Key, channel: "walk_in", fulfillment: "pickup", "qty_LIVE-P-2": "1", "price_LIVE-P-2": "98.00", payment_method: "cash" });
  const so2 = await one("SELECT * FROM sales_orders WHERE order_id = ?", [sale2Key]);
  await agent.get(`/crm/sales/orders/${so2.id}`);
  await agent.post(`/crm/sales/orders/${so2.id}/complete`, {});
  const sale2 = await one("SELECT * FROM sales_transactions WHERE sales_order_id = ?", [so2.id]);
  const accRow = async () => one("SELECT *, TIMESTAMPDIFF(SECOND, NOW(), next_attempt_at) AS wait FROM integration_outbox WHERE event_type = 'SaleCompleted' AND entity_id = ? AND target = 'johnvivz_accounting'", [sale2.sale_id]);
  fake.accounting.failNext(1, 503);
  await mgr.post("/crm/settings/integration/dispatch", {});
  const f1 = await accRow();
  const callsAfterFail = fake.accounting.requests.length;
  await mgr.post("/crm/settings/integration/dispatch", {});
  const notDue = await accRow();
  check("DSP-6", "A failed delivery (503) is kept as failed with attempts 1, the error text, and the next try about 1 minute away; running the dispatcher again before then does NOT call Accounting again",
    f1.status === "failed" && f1.attempts === 1 && /503/.test(f1.last_error) && f1.wait > 40 && f1.wait <= 61 && fake.accounting.requests.length === callsAfterFail && notDue.attempts === 1, JSON.stringify([f1.status, f1.attempts, f1.wait, f1.last_error]));
  fake.accounting.down(true);
  const waits = [f1.wait];
  for (let i = 2; i <= 6; i++) {
    await db.query("UPDATE integration_outbox SET next_attempt_at = NOW() WHERE id = ?", [f1.id]);
    await mgr.post("/crm/settings/integration/dispatch", {});
    const r = await accRow();
    waits.push(r.status === "dead" ? "dead" : Math.round(r.wait / 60));
  }
  fake.accounting.down(false);
  const dead1 = await accRow();
  check("DSP-7", "Retry delays increase: about 1, 5, 15, 60 and 360 minutes after the 1st..5th failure; the 6th failure moves the event to the dead-letter queue (attempts 6)",
    waits[0] > 40 && waits.slice(1).join(",") === "5,15,60,360,dead" && dead1.status === "dead" && dead1.attempts === 6, JSON.stringify(waits));
  const pageDead = await mgr.get("/crm/settings/integration");
  const setupPage = await setup.get("/setup/integration");
  check("DSP-8", "Integration Health lists the dead letter with its error and a Retry button (CRM Manager under Settings, setup System Administrator under /setup); the dead-letter count is shown", pageDead.status === 200 && pageDead.body.includes(`data-outbox="${dead1.id}"`) && pageDead.body.includes(`/outbox/${dead1.id}/retry`) && setupPage.status === 200 && setupPage.body.includes(`/setup/integration/outbox/${dead1.id}/retry`) && /Dead letters/.test(pageDead.body), JSON.stringify({ a: pageDead.status, b: pageDead.body.includes("data-outbox=\"" + dead1.id + "\""), c: pageDead.body.includes("/outbox/" + dead1.id + "/retry"), d: setupPage.status, e: setupPage.body.includes("/setup/integration/outbox/" + dead1.id + "/retry"), f: /Dead letters/.test(pageDead.body), id: dead1.id }));
  const accEventsBefore = fake.accounting.eventsOf("SaleCompleted").length;
  const retried = await mgr.post(`/crm/settings/integration/outbox/${dead1.id}/retry`, {});
  const afterRetry = await accRow();
  const retryAudit = await auditRows("integration_event_retried");
  check("DSP-9", "A manual Retry restarts the schedule and sends at once: the event is delivered (sent), the dead letter is gone, and the retry is audited", retried.status === 302 && afterRetry.status === "sent" && fake.accounting.eventsOf("SaleCompleted").length === accEventsBefore + 1 && retryAudit.length === 1 && retryAudit[0].outcome === "success" && String(retryAudit[0].record_id) === String(dead1.id));

  // a 400 from the receiver is permanent; a lost answer is repaired by the duplicate response
  await agent.get(`/crm/sales/new?customer_id=${ernesto.id}`);
  const sale3Key = uuid();
  await agent.post("/crm/sales", { customer_id: String(ernesto.id), request_key: sale3Key, channel: "walk_in", fulfillment: "pickup", "qty_LIVE-P-1": "1", "price_LIVE-P-1": "285.00", payment_method: "cash" });
  const so3 = await one("SELECT * FROM sales_orders WHERE order_id = ?", [sale3Key]);
  await mgr.post("/crm/settings/integration/dispatch", {}); // flush OrderConfirmed so the next dispatch carries only SaleCompleted
  await agent.get(`/crm/sales/orders/${so3.id}`);
  await agent.post(`/crm/sales/orders/${so3.id}/complete`, {});
  const sale3 = await one("SELECT * FROM sales_transactions WHERE sales_order_id = ?", [so3.id]);
  fake.accounting.failNext(1, 400);
  fake.inventory.dropEventAnswers = 1;
  await mgr.post("/crm/settings/integration/dispatch", {});
  const rej = await one("SELECT * FROM integration_outbox WHERE event_type = 'SaleCompleted' AND entity_id = ? AND target = 'johnvivz_accounting'", [sale3.sale_id]);
  const lostAns = await one("SELECT * FROM integration_outbox WHERE event_type = 'SaleCompleted' AND entity_id = ? AND target = 'johnvivz_inventory'", [sale3.sale_id]);
  check("DSP-10", "A 400 from the receiver (invalid envelope) goes dead at once (retrying the same bytes cannot help); a delivery whose answer was lost stays failed",
    rej.status === "dead" && rej.attempts === 1 && /Rejected/.test(rej.last_error) && lostAns.status === "failed" && lostAns.attempts === 1, JSON.stringify([rej.status, rej.attempts, lostAns.status]));
  await db.query("UPDATE integration_outbox SET next_attempt_at = NOW() WHERE id = ?", [lostAns.id]);
  const invCountBefore = fake.inventory.eventsOf("SaleCompleted").length;
  await mgr.post("/crm/settings/integration/dispatch", {});
  const healed = await one("SELECT * FROM integration_outbox WHERE id = ?", [lostAns.id]);
  check("DSP-11", "When the retry reaches a receiver that already has the event, its 200 'duplicate' answer counts as delivered (sent, with a note) and the receiver processed it only once", healed.status === "sent" && healed.attempts === 2 && /duplicate/.test(healed.last_error) && fake.inventory.eventsOf("SaleCompleted").length === invCountBefore, JSON.stringify([healed.status, healed.attempts, healed.last_error]));
  const noReason = await mgr.post("/crm/settings/integration/retry-dead", { reason: "no" });
  const stillDead = await one("SELECT status FROM integration_outbox WHERE id = ?", [rej.id]);
  const flashNo = await flashAfter(mgr, "/crm/settings/integration");
  const allRetry = await mgr.post("/crm/settings/integration/retry-dead", { reason: "Accounting fixed their parser" });
  const afterAll = await one("SELECT status, attempts FROM integration_outbox WHERE id = ?", [rej.id]);
  check("DSP-12", "Retry all dead letters needs a reason (at least 5 characters; nothing changes without it) and is audited with that reason", noReason.status === 302 && /reason/.test(flashNo) && stillDead.status === "dead" && allRetry.status === 302 && afterAll.status === "sent" && (await auditRows("integration_dead_letters_retried")).some((r) => r.reason === "Accounting fixed their parser"));

  // ================================================================ mock events are never touched by the dispatcher
  const mockAfter = await one("SELECT COUNT(*) n, MAX(id) mx FROM integration_outbox WHERE status = 'mock_delivered'");
  const demoSent = await one("SELECT COUNT(*) n FROM integration_outbox WHERE is_mock = 1 AND (status <> 'mock_delivered' OR attempts > 0 OR sent_at IS NOT NULL)");
  const demoLeak = [...fake.inventory.events, ...fake.accounting.events].filter((e) => /^SO-|MOCK/.test(e.entity_id) || !!e.data?.reservation_id?.startsWith?.("MOCK")).length;
  check("DSP-13", "Mock events are never sent: the demo events stay 'mock_delivered' with 0 attempts, and no fake server ever received a demo or mock record", Number(mockAfter.n) === Number(mockBefore.n) && Number(demoSent.n) === 0 && demoLeak === 0);
  check("DSP-14", "Every event any fake received passed the contract checks (envelope fields, money as strings, ISO times with offset): 0 rejected", fake.inventory.rejected.length === 0 && fake.accounting.rejected.length === 0 && fake.inventory.events.length >= 4 && fake.accounting.events.length >= 4);

  // ================================================================ reconciliation
  await db.query("UPDATE sales_transactions SET completed_at = DATE_SUB(NOW(), INTERVAL 30 HOUR) WHERE id = ?", [sale3.id]);
  await db.query("UPDATE integration_outbox SET status = 'dead', attempts = 6, sent_at = NULL, last_error = 'test: Accounting never confirmed' WHERE event_type = 'SaleCompleted' AND entity_id = ? AND target = 'johnvivz_accounting'", [sale3.sale_id]);
  await db.query("UPDATE sales_transactions SET completed_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE id = ?", [sale2.id]);
  await db.query("UPDATE integration_outbox SET status = 'pending', attempts = 0, sent_at = NULL WHERE event_type = 'SaleCompleted' AND entity_id = ? AND target = 'johnvivz_accounting'", [sale2.sale_id]);
  const rec = await mgr.get("/crm/settings/integration/reconciliation?from=2000-01-01");
  const row = (no) => (rec.body.match(new RegExp(`data-sale="${no}" data-status="([a-z_]+)"`)) || [])[1];
  const demoSale = await one("SELECT transaction_no FROM sales_transactions WHERE is_demo = 1 ORDER BY id LIMIT 1");
  check("REC-1", "Reconciliation report: a sale with a delivered SaleCompleted is 'confirmed', one not confirmed after 30 hours is 'unmatched', one still waiting after 2 hours is 'in progress', and demo sales that only exist as mock events are 'not sent'",
    rec.status === 200 && row(sale.transaction_no) === "confirmed" && row(sale3.transaction_no) === "unmatched" && row(sale2.transaction_no) === "in_progress" && row(demoSale.transaction_no) === "not_sent", `${[sale, sale3, sale2].map((s) => row(s.transaction_no))} demo ${row(demoSale.transaction_no)}`);
  const csv = await mgr.get("/crm/settings/integration/reconciliation?format=csv");
  const csvText = Buffer.isBuffer(csv.body) ? csv.body.toString("utf8") : csv.body;
  const problemsOnly = await mgr.get("/crm/settings/integration/reconciliation?problems=1");
  check("REC-2", "The report downloads as CSV (header + one line per sale, with the status) and can be limited to unmatched / in-progress sales",
    csv.status === 200 && csv.type.includes("text/csv") && csvText.split("\r\n")[0].startsWith("transaction_no,order_no") && csvText.includes(sale3.transaction_no) && csvText.includes("\"unmatched\"") && problemsOnly.body.includes(sale3.transaction_no) && !problemsOnly.body.includes(`data-sale="${sale.transaction_no}"`) && (await auditRows("integration_reconciliation_exported")).length === 1, JSON.stringify({ s: csv.status, t: csv.type, head: csvText.split("\r\n")[0], a: csvText.includes(sale3.transaction_no), b: csvText.includes("\"unmatched\""), c: problemsOnly.body.includes(sale3.transaction_no), d: !problemsOnly.body.includes("data-sale=\"" + sale.transaction_no + "\""), e: (await auditRows("integration_reconciliation_exported")).length }));
  const health = await mgr.get("/crm/settings/integration");
  check("REC-3", "Integration Health shows the sales with no confirmation after 24 hours and links to the report; the Manager dashboard shows the unmatched count", health.body.includes('data-unmatched="1"') && health.body.includes(sale3.transaction_no) && (await mgr.get("/crm/manager")).body.includes("Sales without confirmation (24 h)"));

  // ================================================================ data CRM serves
  const custApi = await fake.accounting.getFromCrm(`/api/integration/v1/customers/${juan.customer_id}`);
  const custInv = await fake.inventory.getFromCrm(`/api/integration/v1/customers/${juan.customer_id}`);
  const custHr = await fake.hr.getFromCrm(`/api/integration/v1/customers/${juan.customer_id}`);
  const custNone = await fake.accounting.getFromCrm(`/api/integration/v1/customers/${uuid()}`);
  check("API-1", "GET /customers/{id}: Accounting and Inventory get customer_id, customer_no, display_name and status only (no contact data); HR is refused (403); an unknown id is 404 JSON",
    custApi.status === 200 && Object.keys(custApi.json).sort().join(",") === "customer_id,customer_no,display_name,status" && custInv.status === 200 && custHr.status === 403 && custNone.status === 404 && custNone.json.error === "not_found" && !custApi.text.includes("@"), custApi.text);
  const ordApi = await fake.inventory.getFromCrm(`/api/integration/v1/orders/${saleKey}`);
  const saleApi = await fake.accounting.getFromCrm(`/api/integration/v1/sales/${sale.sale_id}`);
  const saleInv = await fake.inventory.getFromCrm(`/api/integration/v1/sales/${sale.sale_id}`);
  check("API-2", "GET /orders/{id} (Inventory, Accounting) returns header, items and correlation_id; GET /sales/{id} (Accounting only) returns totals, payments and refunds; Inventory is refused (403)",
    ordApi.status === 200 && ordApi.json.correlation_id === so.correlation_id && ordApi.json.items.length === 2 && ordApi.json.totals.grand_total === "668.00" && saleApi.status === 200 && saleApi.json.totals.net === "668.00" && saleApi.json.payments.length === 1 && saleApi.json.refunds[0].amount === "98.00" && saleInv.status === 403, `${ordApi.status} ${saleApi.status} ${saleInv.status}`);
  const recApi = await fake.accounting.getFromCrm("/api/integration/v1/reconciliation/sales");
  const recInv = await fake.inventory.getFromCrm("/api/integration/v1/reconciliation/sales");
  const apiRow = (s) => recApi.json?.sales?.find((x) => x.sale_id === s.sale_id);
  check("API-3", "GET /reconciliation/sales (Accounting only) returns the same statuses as the report", recApi.status === 200 && recInv.status === 403 && apiRow(sale3)?.status === "unmatched" && apiRow(sale2)?.status === "in_progress" && apiRow(sale)?.status === "confirmed" && recApi.json.summary.unmatched >= 1, recApi.text.slice(0, 300));
  const qPath = "/api/integration/v1/reconciliation/sales?from=2020-01-01&to=2020-01-02";
  const qts = offsetNow();
  const qsig = crypto.createHmac("sha256", secrets.accounting.in).update(["GET", qPath, qts, crypto.createHash("sha256").update("").digest("hex")].join("\n")).digest("hex");
  const qTamper = await fake.accounting.sendToCrm(null, { method: "GET", path: "/api/integration/v1/reconciliation/sales?from=2020-01-01&to=2030-01-02", timestamp: qts, signAs: qsig });
  const qGood = await fake.accounting.sendToCrm(null, { method: "GET", path: qPath, timestamp: qts, signAs: qsig });
  const health2 = await fake.accounting.getFromCrm("/api/integration/v1/health");
  check("API-4", "The query string is part of the signature (changing the dates after signing is refused); /health answers for a signed caller", qTamper.status === 401 && qGood.status === 200 && health2.status === 200 && health2.json.status === "ok");

  // ================================================================ connection test, second server with mixed modes
  fake.inventory.requests.length = 0;
  const testInv = await mgr.post("/crm/settings/integration/test/inventory", {});
  const testFlash = await flashAfter(mgr, "/crm/settings/integration");
  check("INT-1", "Test connection signs and sends GET /health to the application and reports the answer; it is audited", testInv.status === 302 && /answered 200/.test(testFlash) && fake.inventory.requests.some((r) => r.path === "/api/integration/v1/health" && r.authorized) && (await auditRows("integration_connection_tested")).length >= 1);

  const env2 = {
    ...env.env, PORT: String(PORT2), APP_URL: `http://127.0.0.1:${PORT2}`, DISABLE_SCHEDULER: "1",
    ...liveEnv, INTEGRATION_HR_MODE: "mock", INTEGRATION_ACCOUNTING_MODE: "disabled", JVZ_SECRET_INVENTORY: "wrong-secret-on-purpose",
  };
  const server2 = spawn(process.execPath, ["index.js"], { cwd: root, env: env2, stdio: ["ignore", "pipe", "pipe"] });
  let log2 = "";
  server2.stdout.on("data", (d) => { log2 += d; });
  server2.stderr.on("data", (d) => { log2 += d; });
  for (let i = 0; i < 120 && !log2.includes("running at") && server2.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250));
  try {
    const base2 = `http://127.0.0.1:${PORT2}`;
    const to2 = (app, type, data, id = uuid()) => {
      const a = ENV(app);
      const envelope = { event_id: id, event_type: type, schema_version: 1, source: a.client, occurred_at: offsetNow(), entity_id: "x", correlation_id: uuid(), idempotency_key: `${type}:${uuid()}`, data };
      const ts = offsetNow(); const raw = JSON.stringify(envelope);
      const sig = crypto.createHmac("sha256", a.secretToCrm).update(["POST", "/api/integration/v1/events", ts, crypto.createHash("sha256").update(raw).digest("hex")].join("\n")).digest("hex");
      return fetch(`${base2}/api/integration/v1/events`, { method: "POST", body: raw, headers: { "Content-Type": "application/json", "X-JVZ-Client": a.client, "X-JVZ-Timestamp": ts, "X-JVZ-Signature": sig } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null), envelope }));
    };
    const hrMock = await to2("hr", "EmployeeStatusChanged", { employee_id: "MOCK-EMP-T003", employment_status: "separated" });
    const acctOff = await to2("accounting", "SalePosted", { sale_id: uuid() });
    const invLive = await to2("inventory", "StockUpdated", { product_id: "NO-SUCH", available_qty: 1 });
    check("MODE-2", "An application whose adapter is mock or disabled is answered 503 integration_not_live and nothing is stored; a live one is accepted. (Mock mode never accepts real events.)",
      hrMock.status === 503 && hrMock.json?.error === "integration_not_live" && acctOff.status === 503 && invLive.status === 202 && !(await inboxRow(hrMock.envelope.event_id)) && (await one("SELECT employment_status s FROM employee_references WHERE employee_id = 'MOCK-EMP-T003'")).s === "active", `${hrMock.status} ${acctOff.status} ${invLive.status}`);
    const c2 = new Client(base2);
    await c2.login("manager@johnvivz.test");
    await c2.get("/crm/settings/integration");
    fake.hr.requests.length = 0;
    const tHr = await c2.post("/crm/settings/integration/test/hr", {});
    const hrFlash = await flashAfter(c2, "/crm/settings/integration");
    const tInv = await c2.post("/crm/settings/integration/test/inventory", {});
    const invFlash = await flashAfter(c2, "/crm/settings/integration");
    const tAcc = await c2.post("/crm/settings/integration/test/accounting", {});
    const accFlash = await flashAfter(c2, "/crm/settings/integration");
    const page2 = (await c2.get("/crm/settings/integration")).body;
    check("INT-2", "Test connection: a mock app makes NO call (fake HR saw nothing), a disabled app says so, and a wrong secret is reported as a rejected signature (401) in plain words",
      tHr.status === 302 && /Mock mode/.test(hrFlash) && fake.hr.requests.length === 0 && /Disabled/.test(accFlash) && /rejected our signature/.test(invFlash) && tInv.status === 302 && tAcc.status === 302 && page2.includes('data-integration-mock="1"') === false /* inventory is live here */, `${hrFlash} | ${invFlash} | ${accFlash}`);
    const reservationsBefore = fake.inventory.reservations.size;
    const callsBefore = fake.inventory.requests.length;
    const cc = new Client(base2);
    await cc.login("kristine.bautista@johnvivz.test");
    const wrongPage = await cc.get(`/crm/sales/new?customer_id=${ernesto.id}`);
    const newCalls = fake.inventory.requests.slice(callsBefore);
    check("INT-3", "With a wrong secret nothing is ordered: every Inventory call is refused (401) by the fake, no reservation is made, and the page says in plain words that Inventory rejected our signed request (503)",
      wrongPage.status === 503 && /Inventory rejected our signed request/.test(decode(wrongPage.body)) && newCalls.length > 0 && newCalls.every((r) => !r.authorized) && fake.inventory.reservations.size === reservationsBefore, `${wrongPage.status} ${newCalls.length}`);
  } finally {
    server2.kill();
  }

  // ================================================================ permissions, labels, secrets, samples
  const view = [await tl.get("/crm/settings/integration"), await agent.get("/crm/settings/integration"), await juanC.get("/crm/settings/integration"), await tl.get("/setup/integration"), await mgr.get("/setup/integration")];
  await tl.get("/crm/team-leader"); await agent.get("/crm/agent"); await juanC.get("/portal");
  const act = [await tl.post("/crm/settings/integration/dispatch", {}), await agent.post("/crm/settings/integration/retry-dead", { reason: "forged retry" }), await juanC.post("/crm/settings/integration/test/hr", {}), await tl.post(`/crm/settings/integration/outbox/${dead1.id}/retry`, {})];
  const denied = await auditRows("access_denied", "AND details LIKE '%integration%'");
  const anon = await new Client(env.base).get("/crm/settings/integration");
  check("PERM-4", "Only the CRM Manager (and the setup System Administrator on /setup) can open Integration Health or act on it; Team Leader, Agent and Customer get 403 on every page and action (denied attempts are audited); signed-out visitors are sent to login",
    view.slice(0, 4).every((r) => r.status === 403) && view[4].status === 403 && act.every((r) => r.status === 403) && denied.length >= 8 && anon.status === 302 && anon.location === "/login", `${view.map((r) => r.status)} ${act.map((r) => r.status)} ${denied.length}`);
  const html = (await mgr.get("/crm/settings/integration")).body;
  const html2 = (await setup.get("/setup/integration")).body;
  const allSecrets = Object.values(secrets).flatMap((s) => [s.out, s.in]);
  const logsText = JSON.stringify(await all("SELECT endpoint, message FROM integration_logs"));
  const auditText = JSON.stringify(await all("SELECT details, before_values, after_values FROM crm_audit_logs"));
  check("SEC-1", "No secret or signature ever appears on a page, in the call log or in the audit log; calls are logged with endpoint, status, duration and mode",
    allSecrets.every((s) => !html.includes(s) && !html2.includes(s) && !logsText.includes(s) && !auditText.includes(s)) && Number((await one("SELECT COUNT(*) n FROM integration_logs WHERE mode = 'live' AND http_status IS NOT NULL AND duration_ms IS NOT NULL")).n) > 20);
  check("PAGE-2", "Integration Health is real: three applications with their mode (Live), secrets shown only as Configured, outbox, inbox, clean-up tasks and recent calls from the database; the sample banner and sample figures are gone",
    html.includes('data-app="hr"') && html.includes('data-app="inventory"') && html.includes('data-app="accounting"') && /Live/.test(html) && html.includes("Outbox: events CRM sends") && html.includes("Inbox: events CRM receives") && !html.includes("(sample)") && !html.includes("Sample data – not yet connected") && !html.includes("SO-SAMPLE") && html2.includes("Integration Health"), JSON.stringify({ apps: ["hr", "inventory", "accounting"].map((k) => html.includes("data-app=\"" + k + "\"")), live: /Live/.test(html), ob: html.includes("Outbox: events CRM sends"), ib: html.includes("Inbox: events CRM receives"), samp: html.includes("(sample)"), banner: html.includes("Sample data – not yet connected"), so: html.includes("SO-SAMPLE"), h2: html2.includes("Integration Health") }));
  const BAD = /\[object Object\]|\bundefined\b|\bNaN\b|\{\{|\}\}/;
  const stray = [];
  for (const [c, p] of [[mgr, "/crm/settings/integration"], [mgr, "/crm/settings/integration?outbox=dead"], [mgr, "/crm/settings/integration?inbox=failed"], [mgr, "/crm/settings/integration/reconciliation"], [mgr, "/crm/settings/integration/reconciliation?problems=1"], [mgr, "/crm/manager"], [setup, "/setup/integration"], [setup, "/setup/integration/reconciliation"], [setup, "/setup"]]) {
    const r = await c.get(p);
    if (r.status !== 200 || BAD.test(strip(r.body))) stray.push(`${p} ${r.status}`);
  }
  check("PAGES-P6", "Per-role page check: every Integration Health and reconciliation page (with filters) opens for the Manager and the setup System Administrator with no stray template text", stray.length === 0, stray.join("; "));
  const removed = PAGES.filter((p) => /^integration\./.test(p.key));
  check("SMP-5", "The two sample pages that P6 connects (integration.manager, integration.setup) are gone, with their OUTBOX / INBOX / RECONCILIATION sample data; later phases remove the other samples",
    removed.length === 0 && sampleData.OUTBOX === undefined && sampleData.INBOX === undefined && sampleData.RECONCILIATION === undefined, `${PAGES.length} ${PAGES.map((p) => p.key)}`);
  const pageNames = PAGES.map((p) => p.key).sort().join(",");
  check("SMP-5b", "No integration sample page came back (later phases remove the others)", !pageNames.includes("integration"), pageNames);
  void strip; void juan;
} finally {
  await fake.stop();
  await env.stop();
}
summarize(DB);
