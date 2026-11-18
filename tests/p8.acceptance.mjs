/*
 * JOHNVIVZ CRM — Phase P8 acceptance tests: My Requests (the P7 addition), superseded requests, loyalty points (D13), team targets
 * from service_targets, campaign results from real data, and the removal of the Loyalty and team-target samples.
 *   npm run test:p8
 * Throwaway database johnvivz_crm_p8_test. HR and Inventory are MOCK; approvals are ON for this server (a second server checks OFF).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { check, startEnvironment, summarize, Client, root } from "./support/harness.mjs";
import { PAGES } from "./support/noSamples.mjs";
import * as sampleData from "./support/noSamples.mjs";

const DB = process.env.TEST_P8_DB_NAME || "johnvivz_crm_p8_test";
const PORT = Number(process.env.TEST_P8_PORT || 3204);
const env = await startEnvironment({ dbName: DB, port: PORT, serverEnv: { APPROVALS_ENABLED: "true" } });
console.log(`\nJOHNVIVZ CRM P8 tests — database ${DB}\n`);
check("ENV-01", "Migrations (101–120), demo seed and fixtures load; the server starts", env.steps.migrate.status === 0 && env.steps.seed.status === 0 && env.steps.fixtures.status === 0 && env.up,
  env.steps.migrate.stderr || env.steps.seed.stderr || env.steps.fixtures.stderr || env.serverLog());

const { all, one, db, as } = env;
const uuid = () => crypto.randomUUID();
const decode = (s) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x3D;/g, "=");
const alerts = (html) => [...html.matchAll(/role="(?:alert|status)">.*?<span>([^<]*)<\/span>/gs)].map((m) => decode(m[1]));
const flashAfter = async (client, p) => alerts((await client.get(p)).body).join(" | ");
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
const main = (h) => (h.split("<main")[1] || h).split("</main>")[0];
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const balance = async (customerId) => Number((await one("SELECT COALESCE((SELECT points_balance FROM loyalty_accounts WHERE customer_id = ?), 0) b", [customerId])).b);
const txns = (customerId) => all("SELECT t.* FROM loyalty_transactions t JOIN loyalty_accounts a ON a.id = t.loyalty_account_id WHERE a.customer_id = ? ORDER BY t.id", [customerId]);
let extra = null;

try {
  const u = (email) => one("SELECT id, team_id, employee_id, role FROM crm_users WHERE email = ?", [email]);
  const kristine = await u("kristine.bautista@johnvivz.test");
  const maria = await u("maria.santos@johnvivz.test");
  const ernesto = await one("SELECT id FROM customers WHERE first_name = 'Ernesto'");
  const juan = await one("SELECT id FROM customers WHERE email = 'juan.cruz@johnvivz.test'");
  const agent = await as("kristine.bautista@johnvivz.test");
  const tl = await as("maria.santos@johnvivz.test");
  const mgr = await as("manager@johnvivz.test");
  const setup = await as("admin@johnvivz.test");
  const juanC = await as("juan.cruz@johnvivz.test");

  // ================================================================ migrations 119 and 120
  const m119 = fs.readFileSync(path.join(root, "migrations", "119_approval_superseded_and_my_requests.js"), "utf8");
  const m120 = fs.readFileSync(path.join(root, "migrations", "120_create_loyalty_redemptions.js"), "utf8");
  const statusCol = await one("SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'approval_requests' AND COLUMN_NAME = 'status'", [DB]);
  const roles = async (code) => (await all("SELECT r.code FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id JOIN roles r ON r.id = rp.role_id WHERE p.code = ? ORDER BY r.code", [code])).map((r) => r.code).join(",");
  check("MIG-4", "Migration 119 is the ONE approved ALTER (approval_requests.status gains 'superseded') plus the requests.view_own permission for Agent, Team Leader and Manager; 120 only CREATES loyalty_redemptions plus loyalty.view for the Manager",
    (m119.match(/ALTER TABLE/g) || []).length === 2 /* up and down */ && /ALTER TABLE approval_requests/.test(m119) && /'superseded'/.test(statusCol.t) && !/ALTER TABLE/i.test(m120) && /CREATE TABLE loyalty_redemptions/.test(m120) &&
    (await roles("requests.view_own")) === "agent,crm_manager,team_leader" && (await roles("loyalty.view")) === "crm_manager", `${statusCol.t} ${await roles("requests.view_own")} ${await roles("loyalty.view")}`);

  // ================================================================ My Requests
  const mine = (await agent.get("/crm/my-requests")).body;
  const kriIds = (await all("SELECT request_id FROM approval_requests WHERE requester_user_id = ?", [kristine.id])).map((r) => r.request_id);
  const others = (await all("SELECT request_id FROM approval_requests WHERE requester_user_id IS NULL OR requester_user_id <> ?", [kristine.id])).map((r) => r.request_id);
  check("MYR-1", "My Requests lists ONLY the signed-in person's own requests (Kristine: her 3 demo requests; nobody else's), with type, dates, status, who decided, when and the comment, and the note that ESS/HR owns them",
    kriIds.length === 3 && kriIds.every((id) => mine.includes(`data-request="${id}"`)) && others.every((id) => !mine.includes(`data-request="${id}"`)) && mine.includes("Requests are filed and owned in ESS/HR. This is a copy for your reference.") &&
    mine.includes("Attendance correction") && mine.includes("Approved") && mine.includes("Maria Santos") && mine.includes("Checked with the schedule") && mine.includes("Pending"), kriIds.join(","));
  const mariaReq = await one("SELECT id FROM approval_requests WHERE request_id = 'DEMO-REQ-0004'");
  const kriReq = await one("SELECT id FROM approval_requests WHERE request_id = 'DEMO-REQ-0001'");
  const access = [await agent.get(`/crm/my-requests/${mariaReq.id}`), await tl.get(`/crm/my-requests/${kriReq.id}`), await mgr.get(`/crm/my-requests/${kriReq.id}`)];
  const roles403 = [await juanC.get("/crm/my-requests"), await setup.get("/crm/my-requests")];
  check("MYR-2", "Record-level access: nobody opens another person's request in My Requests (404, even the Team Leader who decides it and the Manager); a customer and the setup administrator get 403", access.every((r) => r.status === 404) && roles403.every((r) => r.status === 403), `${access.map((r) => r.status)} ${roles403.map((r) => r.status)}`);
  const own = await agent.get(`/crm/my-requests/${kriReq.id}`);
  const postTry = await agent.post(`/crm/my-requests/${kriReq.id}`, { status: "approved" });
  check("MYR-3", "Read-only: the request page has no form, button or link to file, change or cancel anything (only the ESS/HR note); a POST to it does not exist (404)",
    own.status === 200 && !/<form[^>]*method="POST"/i.test(main(own.body).replace(/<form[^>]*action="\/logout"[\s\S]*?<\/form>/g, "")) && own.body.includes("Requests are filed and owned in ESS/HR") && postTry.status === 404);
  await tl.get(`/crm/approvals/${kriReq.id}`);
  await tl.post(`/crm/approvals/${kriReq.id}/decide`, { decision: "reject", comment: "Too many people on leave that week" });
  const note = await one("SELECT * FROM crm_notifications WHERE user_id = ? AND related_type = 'approval' AND related_id = ? ORDER BY id DESC LIMIT 1", [kristine.id, kriReq.id]);
  const after = (await agent.get(`/crm/my-requests/${kriReq.id}`)).body;
  check("MYR-4", "When a decision is made the requester gets an in-app notification that LINKS to the request in My Requests; the page then shows Rejected, who decided and the comment",
    note && note.link === `/crm/my-requests/${kriReq.id}` && /rejected/.test(note.title) && after.includes("Rejected") && after.includes("Maria Santos") && after.includes("Too many people on leave that week"), JSON.stringify(note));
  const prof = [(await agent.get("/profile")).body, (await tl.get("/profile")).body, (await mgr.get("/profile")).body];
  const dash = [(await agent.get("/crm/agent")).body, (await tl.get("/crm/team-leader")).body, (await mgr.get("/crm/manager")).body];
  const navs = [agent, tl, mgr];
  const navHasIt = (await Promise.all(navs.map(async (c) => (await c.get("/crm/my-requests")).body.split('aria-label="Main"')[1].split("</nav>")[0].includes("/crm/my-requests")))).some(Boolean);
  check("MYR-5", "Every staff role reaches My Requests from My Profile (My account) and from a dashboard card; the supplement E menus are unchanged (no new menu item)",
    prof.every((h) => h.includes('href="/crm/my-requests"') && h.includes('data-my-requests-card="1"')) && dash.every((h) => h.includes('data-my-requests-card="1"')) && !navHasIt && !(await setup.get("/profile")).body.includes('data-my-requests-card="1"'));

  // feature OFF on a second server
  const e2 = { ...env.env, PORT: String(PORT + 100), APP_URL: `http://127.0.0.1:${PORT + 100}`, DISABLE_SCHEDULER: "1", APPROVALS_ENABLED: "false" };
  const server2 = spawn(process.execPath, ["index.js"], { cwd: root, env: e2, stdio: ["ignore", "pipe", "pipe"] });
  let log2 = "";
  server2.stdout.on("data", (d) => { log2 += d; });
  for (let i = 0; i < 120 && !log2.includes("running at"); i++) await new Promise((r) => setTimeout(r, 250));
  extra = server2;
  const off = new Client(`http://127.0.0.1:${PORT + 100}`);
  await off.login("kristine.bautista@johnvivz.test");
  const offList = await off.get("/crm/my-requests");
  const offShow = await off.get(`/crm/my-requests/${kriReq.id}`);
  const offDash = (await off.get("/crm/agent")).body;
  server2.kill();
  extra = null;
  check("MYR-6", "APPROVALS_ENABLED=false: My Requests (list and a request URL) says \"Approvals are not enabled yet\" and shows no request; the dashboard card says 'Not enabled yet'",
    offList.status === 200 && offList.body.includes("Approvals are not enabled yet") && !offList.body.includes("DEMO-REQ") && offShow.body.includes("Approvals are not enabled yet") && offDash.includes("Not enabled yet"));

  // ================================================================ superseded (changed request)
  const sendMock = async (fields) => { await setup.get("/setup/approvals"); await setup.post("/setup/approvals", fields); return one("SELECT * FROM approval_requests WHERE request_id LIKE 'MOCK-REQ-%' ORDER BY id DESC LIMIT 1"); };
  const leave = (extraFields = {}) => ({ employee_id: kristine.employee_id, request_type: "leave", leave_type: "Vacation leave", start_date: day(20), end_date: day(21), days: "2", reason: "Trip", ...extraFields });
  const a = await sendMock(leave());
  const b = await sendMock(leave({ start_date: day(22), end_date: day(23), replaces_request_id: a.request_id }));
  const a2 = await one("SELECT * FROM approval_requests WHERE id = ?", [a.id]);
  const mariaQueue = (await tl.get("/crm/approvals")).body;
  const myView = (await agent.get("/crm/my-requests")).body;
  await tl.get(`/crm/approvals/${a.id}`);
  await tl.post(`/crm/approvals/${a.id}/decide`, { decision: "approve", comment: "" });
  check("SUP-1", "A changed request (new request_id naming the old one) marks the OLD pending request superseded: audited, not a decision (no decider, no event to HR), out of the approver's queue, shown as Superseded in My Requests; it can no longer be decided; the new one is pending",
    a.status === "pending" && b.status === "pending" && a2.status === "superseded" && a2.decided_by === null && /Replaced by/.test(a2.decision_reason) && Number((await one("SELECT COUNT(*) n FROM integration_outbox WHERE event_type = 'EmployeeRequestDecided' AND entity_id = ?", [a.request_id])).n) === 0 &&
    Number((await one("SELECT COUNT(*) n FROM crm_audit_logs WHERE action = 'approval_superseded' AND record_id = ?", [a.request_id])).n) === 1 && !mariaQueue.includes(`data-request="${a.request_id}"`) && mariaQueue.includes(`data-request="${b.request_id}"`) &&
    myView.includes(`data-request="${a.request_id}" data-status="superseded"`) && myView.includes("Superseded") && (await one("SELECT status FROM approval_requests WHERE id = ?", [a.id])).status === "superseded", JSON.stringify(a2));
  await tl.get(`/crm/approvals/${b.id}`);
  await tl.post(`/crm/approvals/${b.id}/decide`, { decision: "approve", comment: "OK" });
  const c = await sendMock(leave({ replaces_request_id: b.request_id }));
  const ernestoEmp = await sendMock({ employee_id: maria.employee_id, request_type: "overtime", date: day(-1), start_time: "18:00", end_time: "19:00", hours: "1", reason: "Close", replaces_request_id: c.request_id });
  check("SUP-2", "A decided request is never superseded (its decision stands), and a request of ANOTHER employee is never superseded by someone else's change",
    (await one("SELECT status FROM approval_requests WHERE id = ?", [b.id])).status === "approved" && (await one("SELECT status FROM approval_requests WHERE id = ?", [c.id])).status === "pending" && ernestoEmp.status === "pending");

  // ================================================================ loyalty
  const staffOrder = async (customerId, lines, extraFields = {}) => {
    await agent.get(`/crm/sales/new?customer_id=${customerId}`);
    const key = uuid();
    const body = { customer_id: String(customerId), request_key: key, channel: "walk_in", fulfillment: "pickup", payment_method: "cash", ...extraFields };
    for (const [pid, q] of lines) body[`qty_${pid}`] = String(q);
    const r = await agent.post("/crm/sales", body);
    return { r, order: await one("SELECT * FROM sales_orders WHERE order_id = ?", [key]) };
  };
  const complete = async (orderId) => { await agent.get(`/crm/sales/orders/${orderId}`); return agent.post(`/crm/sales/orders/${orderId}/complete`, {}); };
  const before1 = await balance(ernesto.id);
  const big = await staffOrder(ernesto.id, [["MOCK-P-1001", 40]]); // 40 x 285 = 11,400
  await complete(big.order.id);
  await complete(big.order.id); // twice: still one earn
  const sale = await one("SELECT * FROM sales_transactions WHERE sales_order_id = ?", [big.order.id]);
  const earnRows = await all("SELECT * FROM loyalty_transactions WHERE sales_transaction_id = ? AND txn_type = 'earn'", [sale.id]);
  check("LOY-1", "Completing a sale earns 1 point per PHP 100 of the net amount (₱11,400 = 114 points), ONCE even if completed twice; the account is created for the customer; the earn is recorded with the sale",
    Number(sale.net_amount) === 11400 && earnRows.length === 1 && earnRows[0].points === 114 && (await balance(ernesto.id)) === before1 + 114 && /SALE-/.test(earnRows[0].reason), `${sale.net_amount} ${earnRows.length} ${await balance(ernesto.id)} ${before1}`);
  // redeem on a later order
  const b2 = await balance(ernesto.id);
  const badPts = [];
  await db.query("INSERT INTO crm_settings (setting_key, setting_value, description) VALUES ('mock_inventory.MOCK-P-1013', '{\"price\":5}', 'test') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)");
  for (const [pts, expected] of [[150, /blocks of 100/], [b2 + 100 - (b2 % 100) + 100, /available/], [100, /more points than the order costs/]]) {
    const r = await staffOrder(ernesto.id, [["MOCK-P-1013", 1]], { loyalty_points: String(pts) }); // a ₱5 order (MOCK price override)
    if (r.order || !expected.test(decode(r.r.body))) badPts.push(`${pts}: ${r.r.status}`);
  }
  await db.query("DELETE FROM crm_settings WHERE setting_key = 'mock_inventory.MOCK-P-1013'");
  check("LOY-2", "Redeeming is checked: only blocks of 100, never more than the balance, never more than the order costs (nothing is saved)", badPts.length === 0, badPts.join("; "));
  const red = await staffOrder(ernesto.id, [["MOCK-P-1001", 2]], { loyalty_points: "100" }); // 570 - 10
  const redRow = await one("SELECT * FROM loyalty_redemptions WHERE sales_order_id = ?", [red.order.id]);
  const items = await all("SELECT discount_amount, line_total FROM sales_order_items WHERE sales_order_id = ?", [red.order.id]);
  check("LOY-3", "100 points = ₱10 off a later order: the order total drops by ₱10, the discount is on the order lines, a redemption and a 'redeem' transaction (−100) are recorded and the balance drops by 100",
    red.order && Number(red.order.grand_total) === 560 && Number(red.order.discount_total) === 10 && redRow && redRow.points === 100 && Number(redRow.amount) === 10 && redRow.status === "applied" &&
    items.reduce((s, i) => s + Number(i.discount_amount), 0) === 10 && (await balance(ernesto.id)) === b2 - 100, JSON.stringify([red.order?.grand_total, redRow]));
  await complete(red.order.id);
  const ev = await one("SELECT payload FROM integration_outbox WHERE event_type = 'SaleCompleted' AND correlation_id = ? AND target = 'johnvivz_accounting'", [red.order.correlation_id]);
  const evData = (typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload).data;
  check("LOY-4", "SaleCompleted tells Accounting about the loyalty discount (discounts: LOYALTY, loyalty_points, \"10.00\"); the completed ₱560 sale earns 5 points", evData.discounts.some((d) => d.code === "LOYALTY" && d.type === "loyalty_points" && d.amount === "10.00") && evData.totals.net === "560.00" && (await balance(ernesto.id)) === b2 - 100 + 5);
  // cancel returns redeemed points
  const b3 = await balance(ernesto.id);
  const toCancel = await staffOrder(ernesto.id, [["MOCK-P-1004", 2]], { loyalty_points: "0", payment_method: "" });
  check("LOY-5a", "An order without points has no redemption", !(await one("SELECT id FROM loyalty_redemptions WHERE sales_order_id = ?", [toCancel.order.id])));
  // give Ernesto enough points again for one more redemption, then cancel that order
  const big2 = await staffOrder(ernesto.id, [["MOCK-P-1002", 30]]); // 30 x 340 = 10,200 -> 102 points
  await complete(big2.order.id);
  const b4 = await balance(ernesto.id);
  const can = await staffOrder(ernesto.id, [["MOCK-P-1006", 2]], { loyalty_points: "100", payment_method: "" });
  await agent.get(`/crm/sales/orders/${can.order.id}`);
  await agent.post(`/crm/sales/orders/${can.order.id}/cancel`, { reason: "Customer changed their mind" });
  const canRow = await one("SELECT * FROM loyalty_redemptions WHERE sales_order_id = ?", [can.order.id]);
  check("LOY-5", "Cancelling an order gives its redeemed points back ONCE: redemption 'returned', an 'adjust' (+100) transaction, the balance is back where it was",
    b3 >= 0 && canRow.status === "returned" && canRow.return_transaction_id && (await balance(ernesto.id)) === b4 && (await one("SELECT points, txn_type FROM loyalty_transactions WHERE id = ?", [canRow.return_transaction_id])).points === 100, JSON.stringify(canRow));
  // refund reverses earned points (net of refunds), never below zero
  const refundOf = async (orderId, amount) => {
    await agent.get(`/crm/sales/orders/${orderId}`);
    await agent.post(`/crm/sales/orders/${orderId}/refund`, { amount: String(amount), reason: "Customer returned part of the goods" });
    const rf = await one("SELECT * FROM refunds ORDER BY id DESC LIMIT 1");
    await tl.get(`/crm/sales/refunds/${rf.id}`);
    await tl.post(`/crm/sales/refunds/${rf.id}/decide`, { decision: "approve" });
    await tl.post(`/crm/sales/refunds/${rf.id}/record`, {});
    return rf;
  };
  const b5 = await balance(ernesto.id);
  const rf1 = await refundOf(big.order.id, 1450); // net 11,400 -> 9,950 keeps 99 points: 15 taken back
  const rev1 = await one("SELECT * FROM loyalty_transactions WHERE refund_id = ? AND txn_type = 'reverse'", [rf1.id]);
  check("LOY-6", "A recorded refund takes back the points the refunded money earned (net of refunds): ₱11,400 sale, ₱1,450 refunded keeps floor(9,950/100) = 99 of 114 points, so 15 are reversed, linked to the refund",
    rev1 && rev1.points === -15 && (await balance(ernesto.id)) === b5 - 15, JSON.stringify(rev1));
  const b6 = await balance(ernesto.id);
  const rf2 = await refundOf(big.order.id, 9950); // full: the remaining 99 points are due
  const rev2 = await one("SELECT * FROM loyalty_transactions WHERE refund_id = ? AND txn_type = 'reverse'", [rf2.id]);
  check("LOY-7", "A refund never makes the balance negative: if part of the points were already spent, only what is left is taken back and the shortfall is written in the reason",
    rev2 && (await balance(ernesto.id)) === Math.max(0, b6 - 99) && -rev2.points === Math.min(99, b6) && (b6 >= 99 || /already spent/.test(rev2.reason)), JSON.stringify([b6, rev2]));
  // portal: card, history, checkout with points
  const juanBig = await staffOrder(juan.id, [["MOCK-P-1001", 36]]); // 10,260 -> 102
  await complete(juanBig.order.id);
  const home = (await juanC.get("/portal")).body;
  const hist = (await juanC.get("/portal/loyalty")).body;
  await juanC.get("/portal/shop");
  await juanC.post("/portal/cart/add", { product_id: "MOCK-P-1005", quantity: "10", back: "/portal/shop" });
  const cartPage = (await juanC.get("/portal/cart")).body;
  const key = (cartPage.match(/name="request_key" value="([0-9a-f-]{36})"/) || [])[1];
  const jb = await balance(juan.id);
  await juanC.post("/portal/cart/checkout", { request_key: key, fulfillment: "pickup", payment_method: "cod", loyalty_points: "100" });
  const jOrder = await one("SELECT * FROM sales_orders WHERE order_id = ?", [key]);
  const jShow = (await juanC.get(`/portal/orders/${jOrder?.id}`)).body;
  check("LOY-8", "Customer portal: My Profile shows the points card (balance, worth, the rules) linking to My Loyalty Points (history of every earn/redeem/reversal); the cart offers 'Use loyalty points'; checking out with 100 points takes ₱10 off and the order shows the loyalty line",
    home.includes('data-loyalty-card="1"') && decode(home).includes("100 points = ₱10") && home.includes('href="/portal/loyalty"') && hist.includes('data-txn="earn"') && hist.includes("Earned") && cartPage.includes('data-loyalty-redeem="1"') &&
    jOrder && Number(jOrder.grand_total) === 175 && (await balance(juan.id)) === jb - 100 && jShow.includes('data-loyalty-line="1"'), JSON.stringify({ card: home.includes('data-loyalty-card="1"'), rules: decode(home).includes("100 points = ₱10"), link: home.includes('href="/portal/loyalty"'), earn: hist.includes('data-txn="earn"'), cart: cartPage.includes('data-loyalty-redeem="1"'), total: jOrder?.grand_total, jb, now: await balance(juan.id), line: jShow.includes('data-loyalty-line="1"') }));
  const list = await mgr.get("/crm/loyalty");
  const det = await mgr.get(`/crm/loyalty/${ernesto.id}`);
  const denied = [await agent.get("/crm/loyalty"), await tl.get("/crm/loyalty"), await juanC.get("/crm/loyalty")];
  const sums = await one("SELECT COUNT(*) n, SUM(points_balance) s FROM loyalty_accounts");
  check("LOY-9", "Manager's Loyalty page is live (no sample badge): every account with balance, earned, redeemed, taken back and returned; the customer page lists every transaction; Agent, Team Leader and Customer get 403; no screen edits points",
    list.status === 200 && !list.body.includes("Sample data") && list.body.includes(`${sums.s}`) && det.body.includes('data-txn="reverse"') && det.body.includes('data-txn="adjust"') && det.body.includes('data-txn="redeem"') && denied.every((r) => r.status === 403) && (await mgr.post("/crm/loyalty/1/adjust", { points: "500" })).status === 404, `${list.status} ${denied.map((r) => r.status)}`);
  const ledger = await one("SELECT (SELECT COUNT(*) FROM loyalty_accounts a WHERE a.points_balance <> GREATEST(0, (SELECT COALESCE(SUM(points), 0) FROM loyalty_transactions t WHERE t.loyalty_account_id = a.id))) bad");
  check("LOY-10", "Every balance equals the sum of its recorded transactions (no point appears or disappears without a record); one account per customer", Number(ledger.bad) === 0 && Number((await one("SELECT COUNT(*) n FROM (SELECT customer_id FROM loyalty_accounts GROUP BY customer_id HAVING COUNT(*) > 1) x")).n) === 0);

  // ================================================================ team targets and campaigns
  const tlDash = (await tl.get("/crm/team-leader")).body;
  const t = await one(`SELECT SUM(k.first_response_due_at IS NOT NULL AND (k.first_response_at IS NOT NULL OR k.first_response_due_at < NOW())) fr_total, SUM(k.first_response_at IS NOT NULL AND k.first_response_at <= k.first_response_due_at) fr_met
                       FROM customer_cases k WHERE k.created_at >= NOW() - INTERVAL 30 DAY AND k.team_id = ?`, [maria.team_id]);
  check("TGT-1", "Team targets on the Team Leader dashboard are computed from real cases against service_targets (first response and resolution on time); no sample badge, no invented sales target; demo data is labelled",
    tlDash.includes('data-team-targets="1"') && tlDash.includes(`${t.fr_met} of ${t.fr_total} case(s)`) && !tlDash.includes("Monthly sales target") && !tlDash.includes("Sample data – not yet connected") && tlDash.includes('data-includes-demo="1"'), `${t.fr_met}/${t.fr_total}`);
  const camp = await one("SELECT p.campaign_id AS id FROM promotion_redemptions r JOIN promotions p ON p.id = r.promotion_id WHERE p.campaign_id IS NOT NULL GROUP BY p.campaign_id ORDER BY COUNT(*) DESC LIMIT 1");
  const campPage = (await mgr.get(`/crm/campaigns/${camp.id}`)).body;
  check("CMP-2", "Campaign results show only figures real orders can answer (uses, discount, orders, completed sales, customers reached, average completed order) and say when they include demo orders", campPage.includes("Customers reached") && campPage.includes("Average completed order") && campPage.includes('data-includes-demo="1"'));

  // ================================================================ samples and pages
  check("SMP-7", "The Loyalty sample page, its LOYALTY data and the Team Leader's sample team-target widget are gone; no loyalty sample came back",
    PAGES.every((p) => !p.key.startsWith("loyalty")) && sampleData.LOYALTY === undefined && !tlDash.includes("Sample data – not yet connected"));
  const BAD = /\[object Object\]|\bundefined\b|\bNaN\b|\{\{|\}\}/;
  const stray = [];
  for (const [c, p] of [[agent, "/crm/my-requests"], [agent, `/crm/my-requests/${kriReq.id}`], [tl, "/crm/my-requests"], [mgr, "/crm/my-requests"], [mgr, "/crm/loyalty"], [mgr, `/crm/loyalty/${ernesto.id}`], [mgr, "/crm/loyalty?q=Ernesto"], [juanC, "/portal/loyalty"], [juanC, "/portal"], [juanC, "/portal/cart"], [agent, `/crm/sales/new?customer_id=${ernesto.id}`], [agent, `/crm/sales/orders/${red.order.id}`], [agent, `/crm/customers/${ernesto.id}`], [tl, "/crm/team-leader"], [mgr, `/crm/campaigns/${camp.id}`], [agent, "/profile"], [setup, "/setup/approvals"]]) {
    const r = await c.get(p);
    if (r.status !== 200 || BAD.test(strip(r.body))) stray.push(`${p} ${r.status}`);
  }
  check("PAGES-P8", "Per-role page check: My Requests, loyalty (portal, Manager list and detail), cart and order pages with points, customer page, team targets, campaign results, profile and the mock ESS open with no stray template text", stray.length === 0, stray.join("; "));

  // ================================================================ seed:clear
  const realTxns = Number((await one(`SELECT COUNT(*) n FROM loyalty_transactions t LEFT JOIN sales_transactions s ON s.id = t.sales_transaction_id LEFT JOIN refunds rf ON rf.id = t.refund_id
     LEFT JOIN sales_transactions s2 ON s2.id = rf.sales_transaction_id LEFT JOIN loyalty_redemptions lr ON lr.redeem_transaction_id = t.id OR lr.return_transaction_id = t.id LEFT JOIN sales_orders o ON o.id = lr.sales_order_id
     WHERE NOT (COALESCE(s.is_demo, 0) = 1 OR COALESCE(s2.is_demo, 0) = 1 OR COALESCE(o.is_demo, 0) = 1)`)).n);
  const clear = env.node(["seeders/index.js", "--clear"]);
  const demoLeft = Number((await one("SELECT COUNT(*) n FROM loyalty_transactions t JOIN sales_transactions s ON s.id = t.sales_transaction_id WHERE s.is_demo = 1")).n);
  const realAfter = Number((await one("SELECT COUNT(*) n FROM loyalty_transactions")).n);
  check("CLEAR-3", "seed:clear removes the points of demo sales and keeps every real loyalty transaction (balances recomputed, never negative)", clear.status === 0 && demoLeft === 0 && realAfter === realTxns && Number((await one("SELECT COUNT(*) n FROM loyalty_accounts WHERE points_balance < 0")).n) === 0, `${clear.status} ${demoLeft} ${realTxns}/${realAfter} ${clear.stdout.slice(-200)}`);
} finally {
  if (extra) extra.kill();
  await env.stop();
}
summarize(DB);
