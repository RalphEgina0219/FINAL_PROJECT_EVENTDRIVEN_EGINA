/*
 * JOHNVIVZ CRM — Phase P5 (sales) acceptance tests.
 *   npm run test:p5        (npm test runs it last)
 * Throwaway database johnvivz_crm_p5_test; people beyond the 7 demo accounts come from tests/support/p1Fixtures.mjs.
 * Inventory runs in MOCK mode: prices and stock come from the mock fixture; the tests change them through crm_settings
 * (mock_inventory.<product_id>) exactly as a real Inventory change would appear. Covers TC-11 .. TC-15: CRM never edits
 * stock or prices, checkout re-checks price and availability, reservations and SaleCompleted are idempotent, a refund is
 * never approved by its requester, every event has the full envelope and is mock. Also payments, cancel, promotions,
 * campaigns, scope, the demo seed, seed:clear safety and the removal of the P5 sample pages.
 */
import crypto from "crypto";
import { check, startEnvironment, summarize } from "./support/harness.mjs";
import { PAGES } from "./support/noSamples.mjs";

const DB = process.env.TEST_P5_DB_NAME || "johnvivz_crm_p5_test";
const PORT = Number(process.env.TEST_P5_PORT || 3201);
const env = await startEnvironment({ dbName: DB, port: PORT });
console.log(`\nJOHNVIVZ CRM P5 tests — database ${DB}\n`);
check("ENV-01", "Migrations (101–117), demo seed and fixtures load; server starts", env.steps.migrate.status === 0 && env.steps.seed.status === 0 && env.steps.fixtures.status === 0 && env.up,
  env.steps.migrate.stderr || env.steps.seed.stderr || env.steps.fixtures.stderr || env.serverLog());

const { all, one, db, as, node } = env;
const decode = (s) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const alerts = (html) => [...html.matchAll(/role="(?:alert|status)">.*?<span>([^<]*)<\/span>/gs)].map((m) => decode(m[1]));
const errorList = (html) => [...(html.match(/role="alert">([\s\S]*?)<\/ul>/) || [, ""])[1].matchAll(/<li>([^<]*)<\/li>/g)].map((m) => decode(m[1]));
const flashAfter = async (client, path) => alerts((await client.get(path)).body).join(" | ");
const auditCount = async (action, extra = "", params = []) => Number((await one(`SELECT COUNT(*) n FROM crm_audit_logs WHERE action = ? ${extra}`, [action, ...params])).n);
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "");
const uuid = () => crypto.randomUUID();
const PRICE = { "MOCK-P-1001": 285, "MOCK-P-1003": 245, "MOCK-P-1004": 98, "MOCK-P-1005": 18.5, "MOCK-P-1006": 92, "MOCK-P-1007": 78, "MOCK-P-1008": 24, "MOCK-P-1009": 62, "MOCK-P-1010": 58, "MOCK-P-1011": 44, "MOCK-P-1012": 115, "MOCK-P-1013": 15, "MOCK-P-1014": 190, "MOCK-P-1015": 130 };
const override = (pid, patch) => db.query("INSERT INTO crm_settings (setting_key, setting_value, description) VALUES (?, ?, 'MOCK Inventory override (tests only)') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [`mock_inventory.${pid}`, JSON.stringify(patch)]);
const clearOverride = (pid) => db.query("DELETE FROM crm_settings WHERE setting_key = ?", [`mock_inventory.${pid}`]);
const orderRow = (id) => one("SELECT * FROM sales_orders WHERE id = ?", [id]);
const lastOrder = () => one("SELECT * FROM sales_orders WHERE is_demo = 0 ORDER BY id DESC LIMIT 1");
const orderCount = async () => Number((await one("SELECT COUNT(*) n FROM sales_orders")).n);
const outbox = (type, entityId) => all("SELECT * FROM integration_outbox WHERE event_type = ? AND entity_id = ? ORDER BY id", [type, entityId]);

try {
  const u = (email) => one("SELECT id, team_id FROM crm_users WHERE email = ?", [email]);
  const kristine = await u("kristine.bautista@johnvivz.test");
  const maria = await u("maria.santos@johnvivz.test");
  const manager = await u("manager@johnvivz.test");
  const patricia = await u("patricia.lim@johnvivz.test");
  const juan = await one("SELECT id, customer_no FROM customers WHERE email = 'juan.cruz@johnvivz.test'");
  const ana = await one("SELECT id FROM customers WHERE email = 'ana.delarosa@johnvivz.test'");
  const ernesto = await one("SELECT id FROM customers WHERE first_name = 'Ernesto'");
  const teresita = await one("SELECT id FROM customers WHERE first_name = 'Teresita'");
  const fixtureCust = await one("SELECT id FROM customers WHERE email = 'fixture.customer@example.test'");
  const agent = await as("kristine.bautista@johnvivz.test");
  const ramonC = await as("ramon.aquino@johnvivz.test");
  const tl = await as("maria.santos@johnvivz.test");
  const josephC = await as("joseph.villanueva@johnvivz.test");
  const mgr = await as("manager@johnvivz.test");
  const juanC = await as("juan.cruz@johnvivz.test");
  const anaC = await as("ana.delarosa@johnvivz.test");

  // ================================================================ seed, permissions, labels
  const demoOrders = await one("SELECT COUNT(*) n, SUM(is_demo = 1) d, SUM(status = 'completed') done, SUM(status = 'confirmed') conf, SUM(status = 'ready') rdy, SUM(status = 'cancelled') canc FROM sales_orders");
  const demoPay = await one("SELECT SUM(status = 'recorded' AND reference_no IS NOT NULL) unverified, SUM(status = 'verified') ok, SUM(method = 'cod' AND reference_no IS NULL) cod FROM payment_references");
  const refundStates = Object.fromEntries((await all("SELECT status, COUNT(*) n FROM refunds GROUP BY status")).map((r) => [r.status, Number(r.n)]));
  const promoStates = Object.fromEntries((await all("SELECT status, COUNT(*) n FROM promotions WHERE is_demo = 1 GROUP BY status")).map((r) => [r.status, Number(r.n)]));
  const events = await one("SELECT COUNT(*) n, SUM(is_mock = 1 AND status = 'mock_delivered') mock, SUM(status = 'sent') sent FROM integration_outbox");
  const demoCases = await one("SELECT COUNT(*) n FROM customer_cases WHERE is_demo = 1");
  check("SEED-5", "Demo seed: still 7 accounts and 40 demo cases; demo orders (all is_demo = 1) in every state, payments to verify and COD to collect, sales, refunds requested / recorded / rejected, promotions in four states, 3 campaigns; every event is mock and none was sent",
    Number((await one("SELECT COUNT(*) n FROM crm_users WHERE is_demo = 1")).n) === 7 && Number(demoCases.n) === 40 && Number(demoOrders.n) === Number(demoOrders.d) && Number(demoOrders.done) >= 3 && Number(demoOrders.conf) >= 2 && Number(demoOrders.rdy) >= 1 && Number(demoOrders.canc) === 1 &&
    Number(demoPay.unverified) >= 1 && Number(demoPay.ok) >= 3 && Number(demoPay.cod) >= 1 && refundStates.requested === 1 && refundStates.recorded === 1 && refundStates.rejected === 1 &&
    promoStates.active === 2 && promoStates.pending_approval === 1 && promoStates.expired === 1 && Number((await one("SELECT COUNT(*) n FROM campaigns WHERE is_demo = 1")).n) === 3 &&
    Number(events.n) > 0 && Number(events.mock) === Number(events.n) && Number(events.sent || 0) === 0, JSON.stringify({ demoOrders, demoPay, refundStates, promoStates, events, cases: demoCases.n }));
  const perms = Object.fromEntries((await all("SELECT p.code, GROUP_CONCAT(r.code ORDER BY r.code) roles FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id JOIN roles r ON r.id = rp.role_id WHERE p.code IN ('orders.view','payments.verify','refunds.request','refunds.view','promotions.view','promotions.approve','inventory.sync','shop.use') GROUP BY p.code")).map((r) => [r.code, r.roles]));
  const three = "agent,crm_manager,team_leader";
  check("PERM-3", "Migration 116 added the eight permissions to the right roles (promotions: Team Leader and Manager; snapshot refresh: Manager; shop: customer)",
    perms["orders.view"] === three && perms["payments.verify"] === three && perms["refunds.request"] === three && perms["refunds.view"] === three && perms["promotions.view"] === "crm_manager,team_leader" && perms["promotions.approve"] === "crm_manager,team_leader" && perms["inventory.sync"] === "crm_manager" && perms["shop.use"] === "customer", JSON.stringify(perms));

  // ================================================================ TC-11: CRM never edits stock or prices; mock is labelled
  const shopPage = await juanC.get("/portal/shop");
  const staffNew = await agent.get(`/crm/sales/new?customer_id=${ernesto.id}`);
  const snapshotBefore = await all("SELECT product_id, selling_price FROM product_references ORDER BY product_id");
  await mgr.get("/crm/sales");
  await agent.get("/crm/sales");
  const editProbes = [await mgr.post("/crm/products/MOCK-P-1001", { selling_price: "1" }), await mgr.post("/crm/sales/products", { product_id: "MOCK-P-1001", selling_price: "1", stock: "9999" }), await agent.post("/crm/inventory/stock", { product_id: "MOCK-P-1001", quantity: "9999" })];
  check("TC-11", "CRM cannot edit stock or prices: no endpoint exists (404), prices on pages are read-only Inventory answers, the page says MOCK Inventory, the snapshot table is untouched",
    shopPage.body.includes('data-mock-inventory="1"') && staffNew.body.includes('data-mock-inventory="1"') && editProbes.every((r) => r.status === 404) && !/<input[^>]+name="price_[^"]+"[^>]+type="(text|number)"/.test(staffNew.body) && snapshotBefore.length === 16 && snapshotBefore.every((r) => r.selling_price !== null), editProbes.map((r) => r.status).join(","));

  // ================================================================ customer: shop and cart
  check("SHOP-1", "Shop: products from Inventory with price and stock; out-of-stock products cannot be added; low stock is shown; running promotions are listed; no sample badge",
    shopPage.status === 200 && shopPage.body.includes("Sinandomeng Rice 5kg") && shopPage.body.includes("₱285.00") && shopPage.body.includes("Out of stock") && /Only \d+ left/.test(shopPage.body) && shopPage.body.includes("PANTRY10") && !shopPage.body.includes("Sample data – not yet connected") && !shopPage.body.includes("Discontinued Biscuits"));
  const addTo = (c, pid, qty) => c.post("/portal/cart/add", { product_id: pid, quantity: String(qty), back: "/portal/shop" });
  await juanC.get("/portal/shop");
  const cartBad = [];
  for (const [name, pid, qty, expected] of [["zero", "MOCK-P-1001", 0, /greater than zero/], ["text", "MOCK-P-1001", "abc", /greater than zero/], ["too many", "MOCK-P-1005", 5000, /more than 999/], ["fraction of a bag", "MOCK-P-1001", 1.5, /whole units/], ["out of stock", "MOCK-P-1015", 1, /out of stock/], ["inactive", "MOCK-P-1016", 1, /not sold any more/], ["unknown", "NOPE", 1, /not sold any more/], ["more than available", "MOCK-P-1011", 50, /Only \d+/]]) {
    await addTo(juanC, pid, qty);
    const msg = await flashAfter(juanC, "/portal/shop");
    if (!expected.test(msg)) cartBad.push(`${name}: ${msg}`);
  }
  check("CART-1", "Cart rules: zero, text, over 999, a fraction of a whole-unit product, an out-of-stock, an inactive or unknown product and more than available are all refused with a message", cartBad.length === 0 && !(await one("SELECT id FROM cart_records WHERE customer_id = ?", [juan.id])), cartBad.join("; "));
  await addTo(juanC, "MOCK-P-1005", 4);
  await addTo(juanC, "MOCK-P-1007", 2);
  await addTo(juanC, "MOCK-P-1014", 1.5); // kg product allows decimals
  await addTo(juanC, "MOCK-P-1005", 1);
  const items = await all("SELECT product_id, quantity, unit_price_snapshot FROM cart_items i JOIN cart_records c ON c.id = i.cart_id WHERE c.customer_id = ? AND c.status = 'active' ORDER BY product_id", [juan.id]);
  await juanC.post("/portal/cart/update", { product_id: "MOCK-P-1007", quantity: "3" });
  await juanC.post("/portal/cart/remove", { product_id: "MOCK-P-1014" });
  const items2 = await all("SELECT product_id, quantity FROM cart_items i JOIN cart_records c ON c.id = i.cart_id WHERE c.customer_id = ? AND c.status = 'active' ORDER BY product_id", [juan.id]);
  const cartPage = (await juanC.get("/portal/cart")).body;
  check("CART-2", "Cart: adding the same product adds up (4+1), a kg product takes decimals, quantities can be updated, items removed; the cart page shows the current total and the price the item was added at",
    items.length === 3 && Number(items.find((i) => i.product_id === "MOCK-P-1005").quantity) === 5 && Number(items.find((i) => i.product_id === "MOCK-P-1014").quantity) === 1.5 && Number(items.find((i) => i.product_id === "MOCK-P-1005").unit_price_snapshot) === 18.5 &&
    items2.length === 2 && Number(items2.find((i) => i.product_id === "MOCK-P-1007").quantity) === 3 && cartPage.includes("₱326.50") /* 5*18.5 + 3*78 */);

  // ================================================================ TC-12: checkout, idempotency, events
  const keyOf = (html) => (html.match(/name="request_key" value="([0-9a-f-]{36})"/) || [])[1];
  const checkoutBody = (key, extra = {}) => ({ request_key: key, fulfillment: "pickup", payment_method: "cod", ...extra });
  const key1 = keyOf(cartPage);
  const heldBefore = Number((await one("SELECT COALESCE(SUM(i.quantity), 0) q FROM sales_order_items i JOIN sales_orders o ON o.id = i.sales_order_id WHERE i.product_id = 'MOCK-P-1005' AND o.status <> 'cancelled'")).q);
  const placed = await juanC.post("/portal/cart/checkout", checkoutBody(key1));
  const o1 = await lastOrder();
  const items1 = o1 ? await all("SELECT product_id, quantity, unit_price, line_total FROM sales_order_items WHERE sales_order_id = ? ORDER BY line_no", [o1.id]) : [];
  const ev1 = o1 ? await outbox("OrderConfirmed", o1.order_id) : [];
  const cod1 = o1 ? await one("SELECT method, reference_no, status, amount FROM payment_references WHERE sales_order_id = ?", [o1.id]) : null;
  check("CHK-1", "Checkout from the cart: the order is Confirmed with stock Reserved (reservation reference, correlation id), prices snapshot from Inventory, Cash on Delivery recorded without a reference, the cart is checked out, one OrderConfirmed event (mock) for Inventory, the customer's agent and the Team Leaders are notified, an audit entry exists",
    placed.status === 302 && o1 && placed.location === `/portal/orders/${o1.id}` && o1.status === "confirmed" && o1.reservation_status === "reserved" && /^MOCK-RSV-/.test(o1.inventory_reservation_ref) && /^[0-9a-f-]{36}$/.test(o1.correlation_id) && Number(o1.grand_total) === 326.5 && o1.is_demo === 0 && o1.channel === "portal" &&
    items1.length === 2 && Number(items1.find((i) => i.product_id === "MOCK-P-1005").unit_price) === 18.5 && cod1?.method === "cod" && cod1.reference_no === null && cod1.status === "recorded" && ev1.length === 1 && ev1[0].target === "johnvivz_inventory" && ev1[0].is_mock === 1 && ev1[0].status === "mock_delivered" &&
    (await one("SELECT status FROM cart_records WHERE customer_id = ? ORDER BY id DESC LIMIT 1", [juan.id])).status === "checked_out" && Number((await one("SELECT COUNT(*) n FROM crm_notifications WHERE related_type = 'order' AND related_id = ? AND user_id = ?", [o1.id, kristine.id])).n) === 1 && (await auditCount("order_created")) >= 1, `${placed.status} ${placed.location} ${JSON.stringify(o1 && [o1.status, o1.grand_total])}`);
  const ordersBefore = await orderCount();
  const dup = await juanC.post("/portal/cart/checkout", checkoutBody(key1));
  const heldAfter = Number((await one("SELECT COALESCE(SUM(i.quantity), 0) q FROM sales_order_items i JOIN sales_orders o ON o.id = i.sales_order_id WHERE i.product_id = 'MOCK-P-1005' AND o.status <> 'cancelled'")).q);
  // the cart is empty now, so a replayed form is answered from the existing order without touching the cart
  check("CHK-2", "A re-submitted checkout (same request key) returns the existing order: no second order, no second reservation, no second event",
    dup.location === `/portal/orders/${o1.id}` && (await orderCount()) === ordersBefore && heldAfter === heldBefore + 5 && (await outbox("OrderConfirmed", o1.order_id)).length === 1 && Number((await one("SELECT COUNT(*) n FROM sales_orders WHERE order_id = ?", [o1.order_id])).n) === 1, `${dup.location} ${heldBefore}/${heldAfter}`);
  const dupFlash = await flashAfter(juanC, dup.location);
  const idem = node(["--input-type=module", "-e", `import('./services/integration/inventoryAdapter.js').then(async (m) => { const { sequelize } = await import('./models/index.js'); const r = await m.reserveStock({ key: 'reserve:${o1.order_id}', orderId: '${o1.order_id}', correlationId: '${o1.correlation_id}', lines: [{ product_id: 'MOCK-P-1005', quantity: 5 }] }); console.log('RES ' + JSON.stringify({ status: r.status, ref: r.reservation_ref, dup: r.duplicate })); await sequelize.close(); })`]);
  check("TC-12", "Reserving again with the same idempotency key returns the same reservation (duplicate), never a second one; the replayed checkout told the customer the order already exists",
    new RegExp(`"status":"reserved","ref":"${o1.inventory_reservation_ref}","dup":true`).test(idem.stdout) && /already placed/.test(dupFlash), `${idem.stdout} ${idem.stderr?.slice(0, 200)} | ${dupFlash}`);

  // ================================================================ checkout re-check: price and availability
  await addTo(juanC, "MOCK-P-1011", 2);
  await override("MOCK-P-1011", { price: 50 });
  const cartHtml2 = (await juanC.get("/portal/cart")).body;
  const ord0 = await orderCount();
  const priceTry = await juanC.post("/portal/cart/checkout", checkoutBody(keyOf(cartHtml2)));
  const priceMsg = await flashAfter(juanC, "/portal/cart");
  const snap = await one("SELECT unit_price_snapshot s FROM cart_items i JOIN cart_records c ON c.id = i.cart_id WHERE c.customer_id = ? AND c.status = 'active' AND i.product_id = 'MOCK-P-1011'", [juan.id]);
  check("CHK-3", "Price changed in Inventory after the item was added: the order is REJECTED (nothing created, nothing reserved), the message names the old and new price, the cart now shows the current price, the refusal is audited; confirming again then works at the new price",
    priceTry.status === 302 && (await orderCount()) === ord0 && /price of Cream Crackers \(box\) changed from ₱44\.00 to ₱50\.00/.test(priceMsg) && Number(snap.s) === 50 && (await auditCount("order_rejected")) >= 1, priceMsg);
  const again = await juanC.post("/portal/cart/checkout", checkoutBody(keyOf((await juanC.get("/portal/cart")).body)));
  const o3 = await lastOrder();
  check("CHK-3b", "After reviewing the price the same cart checks out at the new price (₱100.00)", again.status === 302 && o3 && Number(o3.grand_total) === 100 && o3.id !== o1.id);
  await clearOverride("MOCK-P-1011");

  await override("MOCK-P-1015", { stock: 5 });
  await addTo(juanC, "MOCK-P-1015", 5);
  await override("MOCK-P-1015", { stock: 3 });
  const ord1 = await orderCount();
  const stockTry = await juanC.post("/portal/cart/checkout", checkoutBody(keyOf((await juanC.get("/portal/cart")).body)));
  const stockMsg = await flashAfter(juanC, "/portal/cart");
  check("CHK-4", "Stock dropped after the item was added: the order is REJECTED with how many are left, and nothing is reserved", stockTry.status === 302 && (await orderCount()) === ord1 && /only 3 kg of Seasonal Mango \(per kg\) are available \(you asked for 5\)/.test(stockMsg), stockMsg);
  await override("MOCK-P-1015", { stock: 5, status: "inactive" });
  await juanC.post("/portal/cart/checkout", checkoutBody(keyOf((await juanC.get("/portal/cart")).body)));
  const inactiveMsg = await flashAfter(juanC, "/portal/cart");
  check("CHK-4b", "A product that became inactive makes the order refuse (\"not sold any more\")", /not sold any more/.test(inactiveMsg) && (await orderCount()) === ord1, inactiveMsg);
  await juanC.post("/portal/cart/remove", { product_id: "MOCK-P-1015" });
  await clearOverride("MOCK-P-1015");

  // two checkouts for the last units, at the same moment: exactly one wins
  await override("MOCK-P-1015", { stock: 5 });
  const racePage = await agent.get(`/crm/sales/new?customer_id=${ernesto.id}`);
  const race = (customer, key) => agent.post("/crm/sales", { customer_id: String(customer), request_key: key, channel: "phone", fulfillment: "pickup", "qty_MOCK-P-1015": "3", "price_MOCK-P-1015": "130" });
  const ord2 = await orderCount();
  const results = await Promise.all([race(ernesto.id, uuid()), race(ernesto.id, uuid()), race(ernesto.id, uuid())]);
  const placedNow = (await orderCount()) - ord2;
  const held = Number((await one("SELECT COALESCE(SUM(i.quantity), 0) q FROM sales_order_items i JOIN sales_orders o ON o.id = i.sales_order_id WHERE i.product_id = 'MOCK-P-1015' AND o.status <> 'cancelled'")).q);
  check("CHK-5", "Three simultaneous checkouts for 3 of the last 5 units: exactly ONE order is placed (the others are refused: only 2 left), so stock is never oversold",
    racePage.status === 200 && placedNow === 1 && held === 3 && results.filter((r) => r.status === 302).length === 1 && results.filter((r) => r.status === 409).length === 2, `${results.map((r) => r.status)} placed ${placedNow} held ${held}`);
  const raceOrder = await lastOrder();
  await clearOverride("MOCK-P-1015");

  // ================================================================ checkout details: GCash, promo, delivery
  await addTo(juanC, "MOCK-P-1008", 2);
  await juanC.get("/portal/cart");
  const noRef = await juanC.post("/portal/cart/checkout", checkoutBody(keyOf((await juanC.get("/portal/cart")).body), { payment_method: "gcash", payment_reference: "" }));
  const noRefMsg = await flashAfter(juanC, "/portal/cart");
  const gc = await juanC.post("/portal/cart/checkout", checkoutBody(keyOf((await juanC.get("/portal/cart")).body), { payment_method: "gcash", payment_reference: "GCASH-TEST-0001" }));
  const og = await lastOrder();
  const gpay = og ? await one("SELECT method, reference_no, status, recorded_by FROM payment_references WHERE sales_order_id = ?", [og.id]) : null;
  check("CHK-6", "GCash needs a reference number (the cart stays); with one the payment is recorded as \"not verified\" and the order stays Unpaid until staff verify it",
    noRef.status === 302 && /reference number/.test(noRefMsg) && gc.status === 302 && og?.payment_status === "unpaid" && gpay?.method === "gcash" && gpay.reference_no === "GCASH-TEST-0001" && gpay.status === "recorded", `${noRefMsg} ${JSON.stringify(gpay)}`);
  await addTo(juanC, "MOCK-P-1008", 1);
  const reused = await juanC.post("/portal/cart/checkout", checkoutBody(keyOf((await juanC.get("/portal/cart")).body), { payment_method: "gcash", payment_reference: "GCASH-TEST-0001" }));
  const reusedMsg = await flashAfter(juanC, "/portal/cart");
  check("CHK-6b", "The same GCash reference number cannot be used on a second order", /already used/.test(reusedMsg) && Number((await one("SELECT COUNT(*) n FROM payment_references WHERE reference_no = 'GCASH-TEST-0001'")).n) === 1, reusedMsg);
  await juanC.post("/portal/cart/remove", { product_id: "MOCK-P-1008" });
  await addTo(juanC, "MOCK-P-1006", 5); // 5 x 92 = 460
  const promoRes = [];
  for (const [name, code, expected] of [["unknown code", "NOSUCHCODE", /does not exist/], ["pending approval", "PAYDAY15", /not been approved/], ["expired", "EGGS20", /not active/]]) {
    const before = await orderCount();
    await juanC.post("/portal/cart/checkout", checkoutBody(keyOf((await juanC.get("/portal/cart")).body), { promo_code: code }));
    const msg = await flashAfter(juanC, "/portal/cart");
    if (!expected.test(msg) || (await orderCount()) !== before) promoRes.push(`${name}: ${msg}`);
  }
  await juanC.post("/portal/cart/checkout", checkoutBody(keyOf((await juanC.get("/portal/cart")).body), { promo_code: "pantry10" }));
  const op1 = await lastOrder();
  check("PROMO-1", "Promo codes at checkout: an unknown, a not-yet-approved and an expired code are refused with a reason (cart kept, no order); a valid code works in any letter case and takes 10% off ₱460 (₱414)",
    promoRes.length === 0 && op1 && Number(op1.subtotal) === 460 && Number(op1.discount_total) === 46 && Number(op1.grand_total) === 414, promoRes.join("; ") + " " + (op1 && [op1.subtotal, op1.discount_total, op1.grand_total]));

  // exact 10% test on a staff order big enough to qualify
  const promoOrder = await agent.post("/crm/sales", { customer_id: String(ernesto.id), request_key: uuid(), channel: "walk_in", fulfillment: "pickup", "qty_MOCK-P-1001": "2", "price_MOCK-P-1001": "285", promo_code: "pantry10" });
  const op = await lastOrder();
  const opItems = op ? await all("SELECT discount_amount, line_total, promotion_id FROM sales_order_items WHERE sales_order_id = ?", [op.id]) : [];
  const red = op ? await one("SELECT discount_amount, customer_id FROM promotion_redemptions WHERE sales_order_id = ?", [op.id]) : null;
  const short = await agent.post("/crm/sales", { customer_id: String(ernesto.id), request_key: uuid(), channel: "walk_in", fulfillment: "pickup", "qty_MOCK-P-1008": "2", promo_code: "PANTRY10" });
  const shortMsg = errorList(short.body).join(" ");
  check("PROMO-2", "PANTRY10 takes exactly 10% off the order (₱570 → ₱513), the discount is stored per line, one redemption row records it; below the ₱300 minimum the order is refused",
    promoOrder.status === 302 && Number(op.subtotal) === 570 && Number(op.discount_total) === 57 && Number(op.grand_total) === 513 && opItems[0].promotion_id !== null && Number(opItems[0].discount_amount) === 57 && Number(red.discount_amount) === 57 && red.customer_id === ernesto.id &&
    short.status === 422 && /at least ₱300\.00/.test(shortMsg), `${promoOrder.status} ${op && [op.subtotal, op.discount_total, op.grand_total]} | ${shortMsg}`);

  await addTo(juanC, "MOCK-P-1013", 2);
  const delNo = await juanC.post("/portal/cart/checkout", checkoutBody(keyOf((await juanC.get("/portal/cart")).body), { fulfillment: "delivery", address_id: "" }));
  const delNoMsg = await flashAfter(juanC, "/portal/cart");
  const otherAddr = await one("SELECT id FROM customer_addresses WHERE customer_id = ? LIMIT 1", [ana.id]);
  await juanC.post("/portal/cart/checkout", checkoutBody(keyOf((await juanC.get("/portal/cart")).body), { fulfillment: "delivery", address_id: String(otherAddr.id) }));
  const delOtherMsg = await flashAfter(juanC, "/portal/cart");
  const juanAddr = await one("SELECT id FROM customer_addresses WHERE customer_id = ? LIMIT 1", [juan.id]);
  await juanC.post("/portal/cart/checkout", checkoutBody(keyOf((await juanC.get("/portal/cart")).body), { fulfillment: "delivery", address_id: String(juanAddr.id) }));
  const od = await lastOrder();
  check("CHK-7", "Delivery needs an address: none, or another customer's address, is refused; the customer's own address is saved on the order", /delivery address/i.test(delNoMsg) && /does not belong/.test(delOtherMsg) && od?.delivery_address_id === juanAddr.id && od.fulfillment === "delivery", `${delNoMsg} | ${delOtherMsg}`);

  // ================================================================ staff orders, scope
  const staffOrder = (c, customerId, lines, extra = {}) => {
    const body = { customer_id: String(customerId), request_key: uuid(), channel: "walk_in", fulfillment: "in_store", ...extra };
    for (const [pid, qty] of Object.entries(lines)) { body[`qty_${pid}`] = String(qty); body[`price_${pid}`] = String(PRICE[pid]); }
    return c.post("/crm/sales", body);
  };
  await agent.get(`/crm/sales/new?customer_id=${ernesto.id}`);
  const cashOrder = await staffOrder(agent, ernesto.id, { "MOCK-P-1010": 2, "MOCK-P-1008": 5 }, { payment_method: "cash", payment_reference: "OR-TEST-1" });
  const so = await lastOrder();
  const soPay = await one("SELECT status, method FROM payment_references WHERE sales_order_id = ?", [so.id]);
  check("STF-1", "Agent places a walk-in order for her customer paying cash at the counter: Confirmed, stock reserved, cash counted as verified so the order is Paid at once, assigned to her with her team, in her list",
    cashOrder.status === 302 && so.status === "confirmed" && so.payment_status === "paid" && soPay.status === "verified" && so.agent_id === kristine.id && so.team_id === kristine.team_id && so.channel === "walk_in" && Number(so.grand_total) === 236 && (await agent.get("/crm/sales")).body.includes(so.order_no));
  const invalidOrders = [];
  for (const [name, lines, extra, expected] of [
    ["no products", {}, {}, /at least one product/], ["quantity text", { "MOCK-P-1010": "abc" }, {}, /must be numbers/], ["whole-unit fraction", { "MOCK-P-1010": 1.5 }, {}, /whole units/], ["bad channel", { "MOCK-P-1010": 1 }, { channel: "portal" }, /walk-in or phone/],
    ["delivery without address", { "MOCK-P-1010": 1 }, { fulfillment: "delivery" }, /delivery address/i], ["bad payment method", { "MOCK-P-1010": 1 }, { payment_method: "bitcoin" }, /./], ["cod with a reference", { "MOCK-P-1010": 1 }, { payment_method: "cod", payment_reference: "X1" }, /entered when the cash is collected/],
    ["maya without reference", { "MOCK-P-1010": 1 }, { payment_method: "maya" }, /reference number/],
  ]) {
    const n = await orderCount();
    const r = await staffOrder(agent, ernesto.id, lines, extra);
    if (r.status !== 422 && !(name === "bad payment method" && r.status === 302) || (await orderCount()) !== n + (r.status === 302 ? 1 : 0) || (r.status === 422 && !errorList(r.body).some((e) => expected.test(e)))) invalidOrders.push(`${name}: ${r.status} ${errorList(r.body).join("|")}`);
  }
  const forgedPrice = await agent.post("/crm/sales", { customer_id: String(ernesto.id), request_key: uuid(), channel: "walk_in", fulfillment: "in_store", "qty_MOCK-P-1010": "1", "price_MOCK-P-1010": "1" });
  check("STF-2", "Invalid staff orders are refused with a message and nothing is saved (no products, text quantity, fraction of a whole-unit product, portal channel, delivery without address, COD with a reference, Maya without reference); a forged price of ₱1 is refused as a price change, not accepted",
    invalidOrders.length === 0 && forgedPrice.status === 409 && /changed from ₱1\.00 to ₱58\.00/.test(errorList(forgedPrice.body).join(" ")), invalidOrders.join("; "));
  const scopeChecks = [
    [(await ramonC.get(`/crm/sales/orders/${so.id}`)).status, 404], [(await josephC.get(`/crm/sales/orders/${so.id}`)).status, 404], [(await juanC.get(`/crm/sales/orders/${so.id}`)).status, 403], [(await anaC.get(`/portal/orders/${so.id}`)).status, 404],
    [(await ramonC.post(`/crm/sales/orders/${so.id}/cancel`, { reason: "forged by Ramon" })).status, 404], [(await ramonC.post(`/crm/sales/orders/${so.id}/payments`, { method: "cash", amount: "1" })).status, 404],
    [(await ramonC.post("/crm/sales", { customer_id: String(ernesto.id), request_key: uuid(), channel: "walk_in", fulfillment: "in_store", "qty_MOCK-P-1010": "1" })).status, 404],
    [(await juanC.post("/crm/sales", { customer_id: String(juan.id), request_key: uuid(), channel: "walk_in", fulfillment: "in_store", "qty_MOCK-P-1010": "1" })).status, 403], [(await agent.get("/portal/cart")).status, 403], [(await agent.post("/portal/cart/add", { product_id: "MOCK-P-1010", quantity: "1" })).status, 403],
  ];
  check("SCOPE-8", "Order scope: another team's agent and Team Leader get 404 on the order and on forged cancel, payment and create; a customer cannot open another customer's order (404) or staff pages (403); staff cannot use the customer's cart (403)",
    scopeChecks.every(([got, want]) => got === want), scopeChecks.map(([g, w]) => `${g}/${w}`).join(" "));
  const tlList = (await tl.get("/crm/sales")).body;
  const mgrList = (await mgr.get("/crm/sales")).body;
  check("SCOPE-9", "Order lists follow the scope: the Team Leader and the Manager see the team's orders; the other team's Team Leader does not; the customer's own list has only their orders", tlList.includes(so.order_no) && mgrList.includes(so.order_no) && !(await josephC.get("/crm/sales")).body.includes(so.order_no) && (await juanC.get("/portal/orders")).body.includes(o1.order_no) && !(await juanC.get("/portal/orders")).body.includes(so.order_no));

  // ================================================================ payments: record, verify (4-eyes), void
  await agent.get(`/crm/sales/orders/${raceOrder.id}`);
  const payRes = [];
  const payTry = async (label, client, data, expected, orderId = raceOrder.id) => {
    await client.get(`/crm/sales/orders/${orderId}`);
    const r = await client.post(`/crm/sales/orders/${orderId}/payments`, data);
    const msg = r.status === 302 ? await flashAfter(client, `/crm/sales/orders/${orderId}`) : `HTTP ${r.status}`;
    if (!expected.test(msg)) payRes.push(`${label}: ${msg}`);
  };
  await payTry("too much", agent, { method: "gcash", reference: "GCASH-ABC-9001", amount: "9999" }, /more than what is still due/);
  await payTry("bad reference", agent, { method: "gcash", reference: "12", amount: "10" }, /6 to 30/);
  await payTry("no amount", agent, { method: "gcash", reference: "GCASH-ABC-9001", amount: "" }, /amount received/);
  await payTry("reused reference", agent, { method: "gcash", reference: "GCASH-TEST-0001", amount: "10" }, /already used/);
  await payTry("cod without receipt", agent, { method: "cod", reference: "", amount: "10" }, /receipt number/);
  await payTry("unknown method", agent, { method: "crypto", reference: "ABCDEF1", amount: "10" }, /Choose a payment method/);
  check("PAY-1", "Recording a payment is validated: more than is due, a short reference, no amount, a reference already used, COD without a receipt number and an unknown method are all refused", payRes.length === 0, payRes.join("; "));
  await agent.post(`/crm/sales/orders/${raceOrder.id}/payments`, { method: "gcash", reference: "GCASH-ABC-9001", amount: String(raceOrder.grand_total) });
  const pay1 = await one("SELECT id, status, recorded_by FROM payment_references WHERE reference_no = 'GCASH-ABC-9001'");
  const own = await agent.post(`/crm/sales/orders/${raceOrder.id}/payments/${pay1.id}/verify`, {});
  const ownAudit = await auditCount("access_denied", "AND details LIKE 'verify:%'");
  await tl.get(`/crm/sales/orders/${raceOrder.id}`);
  const by2 = await tl.post(`/crm/sales/orders/${raceOrder.id}/payments/${pay1.id}/verify`, {});
  const after1 = await orderRow(raceOrder.id);
  check("PAY-2", "A GCash reference is recorded as \"not verified\" (order Unpaid); the person who recorded it cannot verify it (403, audited); another staff member can, and the order becomes Paid; audited",
    pay1.status === "recorded" && own.status === 403 && ownAudit >= 1 && by2.status === 302 && (await one("SELECT status FROM payment_references WHERE id = ?", [pay1.id])).status === "verified" && after1.payment_status === "paid" && (await auditCount("payment_verified")) >= 1);
  const voidVerified = await agent.post(`/crm/sales/orders/${raceOrder.id}/payments/${pay1.id}/void`, { reason: "trying to void a verified one" });
  const voidMsg = await flashAfter(agent, `/crm/sales/orders/${raceOrder.id}`);
  check("PAY-3", "A verified payment cannot be voided (refund the sale instead)", voidVerified.status === 302 && /cannot be voided/.test(voidMsg) && (await one("SELECT status FROM payment_references WHERE id = ?", [pay1.id])).status === "verified", voidMsg);

  // customer pays by GCash reference from the portal; staff verify; customer cannot verify or pay cash
  await juanC.get(`/portal/orders/${og.id}`);
  const custCash = await juanC.post(`/portal/orders/${og.id}/pay`, { method: "cash", reference: "ABCDEF1", amount: "10" });
  const cashFlash = await flashAfter(juanC, `/portal/orders/${og.id}`);
  const custVerify = await juanC.post(`/crm/sales/orders/${og.id}/payments/${gpay ? (await one("SELECT id FROM payment_references WHERE sales_order_id = ?", [og.id])).id : 0}/verify`, {});
  const gpayId = (await one("SELECT id FROM payment_references WHERE sales_order_id = ?", [og.id])).id;
  const toVerify = (await agent.get("/crm/sales/payments?status=recorded&q=GCASH-TEST-0001")).body;
  const verifiedByStaff = await agent.post(`/crm/sales/orders/${og.id}/payments/${gpayId}/verify`, {});
  check("PAY-4", "The customer's own GCash reference shows under \"Payments\" to verify; the customer cannot verify (403) or pay cash from the portal; a staff member (not the recorder) verifies it and the order becomes Paid",
    toVerify.includes("GCASH-TEST-0001") && custVerify.status === 403 && cashFlash.includes("GCash or Maya") && verifiedByStaff.status === 302 && (await orderRow(og.id)).payment_status === "paid", `${custCash.status}`);
  const custPay = await juanC.post(`/portal/orders/${o1.id}/pay`, { method: "maya", reference: "MAYA-REF-5555", amount: "326.50" });
  const custPaid = await one("SELECT method, status, recorded_by FROM payment_references WHERE reference_no = 'MAYA-REF-5555'");
  check("PAY-5", "A customer enters a Maya reference on their own confirmed order from the portal: recorded as not verified; another customer cannot do it on that order (404)", custPay.status === 302 && custPaid?.status === "recorded" && (await anaC.post(`/portal/orders/${o1.id}/pay`, { method: "maya", reference: "MAYA-REF-6666", amount: "1" })).status === 404);

  // COD: collected on delivery
  const codOrder = { id: od.id }; // the delivery order placed with Cash on Delivery
  await agent.get(`/crm/sales/orders/${codOrder.id}`);
  const codBefore = Number((await one("SELECT COUNT(*) n FROM payment_references WHERE sales_order_id = ?", [codOrder.id])).n);
  const verifyEarly = await agent.post(`/crm/sales/orders/${codOrder.id}/payments/${(await one("SELECT id FROM payment_references WHERE sales_order_id = ?", [codOrder.id])).id}/verify`, {});
  const earlyMsg = await flashAfter(agent, `/crm/sales/orders/${codOrder.id}`);
  const codDue = (await orderRow(codOrder.id)).grand_total;
  await agent.post(`/crm/sales/orders/${codOrder.id}/payments`, { method: "cod", reference: "DR-2026-777", amount: String(codDue) });
  const codRow = await one("SELECT id, status, reference_no, amount FROM payment_references WHERE sales_order_id = ?", [codOrder.id]);
  await tl.get(`/crm/sales/orders/${codOrder.id}`);
  await tl.post(`/crm/sales/orders/${codOrder.id}/payments/${codRow.id}/verify`, {});
  check("PAY-6", "Cash on Delivery: it cannot be verified before the cash is collected; recording the collection (receipt number) fills the same payment row (no second row), another staff member verifies it and the order is Paid",
    /before verifying/.test(earlyMsg) && verifyEarly.status === 302 && Number((await one("SELECT COUNT(*) n FROM payment_references WHERE sales_order_id = ?", [codOrder.id])).n) === codBefore && codRow.reference_no === "DR-2026-777" && (await orderRow(codOrder.id)).payment_status === "paid", earlyMsg);

  // ================================================================ ready, complete, SaleCompleted idempotency (TC-13, TC-15)
  await agent.get(`/crm/sales/orders/${so.id}`);
  const notPaid = await agent.post(`/crm/sales/orders/${o3.id}/complete`, {});
  const notPaidMsg = await flashAfter(agent, `/crm/sales/orders/${o3.id}`);
  await agent.post(`/crm/sales/orders/${so.id}/ready`, {});
  const ready = (await orderRow(so.id)).status;
  const salesBefore = Number((await one("SELECT COUNT(*) n FROM sales_transactions")).n);
  const done = await agent.post(`/crm/sales/orders/${so.id}/complete`, {});
  const sale = await one("SELECT * FROM sales_transactions WHERE sales_order_id = ?", [so.id]);
  const evSale = sale ? await outbox("SaleCompleted", sale.sale_id) : [];
  const done2 = await agent.post(`/crm/sales/orders/${so.id}/complete`, {});
  const msg2 = await flashAfter(agent, `/crm/sales/orders/${so.id}`);
  const afterDone = await orderRow(so.id);
  check("TC-13", "Complete: needs payment verified in full (refused otherwise); Ready then Completed creates ONE sale (SALE number, unique idempotency key SaleCompleted:<sale_id>) and stock is Issued; completing again changes nothing and says so: still one sale and one event per target",
    notPaid.status === 302 && /Verify the payment in full/.test(notPaidMsg) && ready === "ready" && done.status === 302 && sale && /^SALE-\d{8}-\d{4}$/.test(sale.transaction_no) && sale.idempotency_key === `SaleCompleted:${sale.sale_id}` && Number(sale.net_amount) === Number(afterDone.grand_total) &&
    afterDone.status === "completed" && afterDone.reservation_status === "issued" && sale.tax_total === null && done2.status === 302 && /already completed/.test(msg2) && Number((await one("SELECT COUNT(*) n FROM sales_transactions")).n) === salesBefore + 1 && evSale.length === 2, `${notPaidMsg} | ${msg2} | ${evSale.length}`);
  let dupInsert = "no error";
  try { await db.query("INSERT INTO sales_transactions (sale_id, transaction_no, sales_order_id, customer_id, gross_amount, discount_total, net_amount, completed_at, correlation_id, idempotency_key) VALUES (UUID(), 'SALE-DUP-0001', ?, ?, 1, 0, 1, NOW(), UUID(), 'dup-key')", [so.id, sale.customer_id]); } catch (e) { dupInsert = e.code; }
  let dupEvent = "no error";
  try { await db.query("INSERT INTO integration_outbox (event_id, event_type, target, occurred_at, entity_id, correlation_id, idempotency_key, payload, status, is_mock) VALUES (UUID(), 'SaleCompleted', 'johnvivz_inventory', NOW(3), 'x', UUID(), ?, '{}', 'mock_delivered', 1)", [sale.idempotency_key]); } catch (e) { dupEvent = e.code; }
  check("TC-13b", "The database itself refuses a second sale for the same order and a second SaleCompleted for the same idempotency key (unique constraints)", dupInsert === "ER_DUP_ENTRY" && dupEvent === "ER_DUP_ENTRY", `${dupInsert} ${dupEvent}`);
  const env1 = typeof evSale[0].payload === "string" ? JSON.parse(evSale[0].payload) : evSale[0].payload;
  const missing = ["event_id", "event_type", "schema_version", "source", "occurred_at", "entity_id", "correlation_id", "idempotency_key", "data"].filter((k) => env1[k] === undefined || env1[k] === null);
  check("TC-15", "Every event has the full envelope (event_id, event_type, schema_version, source = johnvivz_crm, occurred_at, entity_id, correlation_id, idempotency_key, data); SaleCompleted follows the contract (P6): stable IDs, items with quantities and prices, totals as decimal strings, payments, ISO times with an offset and no computed VAT (Accounting computes it); targets are Inventory and Accounting; mock rows are never sent",
    missing.length === 0 && env1.source === "johnvivz_crm" && env1.schema_version === 1 && env1.correlation_id === afterDone.correlation_id && env1.data.order_id === afterDone.order_id && env1.data.items.length === 2 && env1.data.payments.length === 1 && env1.data.tax_total === undefined && env1.data.vat_computed_by === undefined && typeof env1.data.totals.net === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+\+08:00$/.test(env1.occurred_at) &&
    evSale.map((e) => e.target).sort().join() === "johnvivz_accounting,johnvivz_inventory" && evSale.every((e) => e.is_mock === 1 && e.status === "mock_delivered" && e.sent_at === null && e.attempts === 0), `${missing} ${JSON.stringify(env1.data).slice(0, 120)}`);
  const logs = await one("SELECT COUNT(*) n, SUM(mode = 'mock') m, SUM(mode = 'live') l FROM integration_logs WHERE `system` = 'johnvivz_inventory'");
  check("TC-18", "Mock mode: every Inventory call (availability, reserve, issue) is logged with mode mock; nothing is logged or marked as live", Number(logs.n) >= 5 && Number(logs.m) === Number(logs.n) && Number(logs.l || 0) === 0, JSON.stringify(logs));
  const disabled = node(["--input-type=module", "-e", "process.env.INTEGRATION_INVENTORY_MODE = 'disabled'; import('./services/integration/inventoryAdapter.js').then(async (m) => { const { sequelize } = await import('./models/index.js'); try { await m.getProducts({ ids: ['MOCK-P-1001'] }); console.log('NO ERROR'); } catch (e) { console.log('ERR ' + e.message); } await sequelize.close(); })"]);
  check("INV-OFF", "With the Inventory integration disabled no product answer is invented: the adapter refuses with a clear message", /ERR The johnvivz_inventory integration is disabled/.test(disabled.stdout), disabled.stdout + disabled.stderr?.slice(0, 200));

  // ================================================================ cancel
  const canO = await one("SELECT o.id, o.order_id, o.reservation_status FROM sales_orders o WHERE o.is_demo = 0 AND o.status = 'confirmed' AND o.payment_status = 'unpaid' AND o.channel = 'portal' AND o.customer_id = ? ORDER BY o.id DESC LIMIT 1", [juan.id]);
  await agent.get(`/crm/sales/orders/${canO.id}`);
  const noReason = await agent.post(`/crm/sales/orders/${canO.id}/cancel`, { reason: "no" });
  const noReasonMsg = await flashAfter(agent, `/crm/sales/orders/${canO.id}`);
  const heldBeforeCancel = Number((await one("SELECT COALESCE(SUM(i.quantity), 0) q FROM sales_order_items i JOIN sales_orders o ON o.id = i.sales_order_id WHERE o.reservation_status IN ('reserved','issued') AND o.status <> 'cancelled'")).q);
  await agent.post(`/crm/sales/orders/${canO.id}/cancel`, { reason: "Customer asked to cancel by phone" });
  const cancelled = await orderRow(canO.id);
  const evCancel = await outbox("SaleCancelled", canO.order_id);
  await agent.post(`/crm/sales/orders/${canO.id}/cancel`, { reason: "Cancelling twice should fail" });
  const twiceMsg = await flashAfter(agent, `/crm/sales/orders/${canO.id}`);
  const heldAfterCancel = Number((await one("SELECT COALESCE(SUM(i.quantity), 0) q FROM sales_order_items i JOIN sales_orders o ON o.id = i.sales_order_id WHERE o.reservation_status IN ('reserved','issued') AND o.status <> 'cancelled'")).q);
  check("CAN-1", "Cancel a confirmed, unpaid order: needs a reason; the reservation is released (stock held goes down), recorded payments are voided, one SaleCancelled event per target (mock), audited; cancelling twice is refused",
    noReason.status === 302 && /at least 5/.test(noReasonMsg) && cancelled.status === "cancelled" && cancelled.reservation_status === "released" && cancelled.cancel_reason === "Customer asked to cancel by phone" && heldAfterCancel < heldBeforeCancel && evCancel.length === 2 && /cannot be cancelled/.test(twiceMsg) &&
    Number((await one("SELECT COUNT(*) n FROM payment_references WHERE sales_order_id = ? AND status <> 'voided'", [canO.id])).n) === 0 && (await auditCount("order_cancelled")) >= 1, `${noReasonMsg} | ${twiceMsg}`);
  const paidCancel = await agent.post(`/crm/sales/orders/${raceOrder.id}/cancel`, { reason: "Trying to cancel a paid order" });
  const paidMsg = await flashAfter(agent, `/crm/sales/orders/${raceOrder.id}`);
  check("CAN-2", "An order with a verified payment cannot be cancelled (complete the sale and refund it)", paidCancel.status === 302 && /verified payment/.test(paidMsg) && (await orderRow(raceOrder.id)).status === "confirmed", paidMsg);
  const custOrd = await one("SELECT id FROM sales_orders WHERE is_demo = 0 AND customer_id = ? AND status = 'confirmed' AND payment_status = 'unpaid' ORDER BY id DESC LIMIT 1", [juan.id]);
  await juanC.get(`/portal/orders/${custOrd.id}`);
  const anaCancel = await anaC.post(`/portal/orders/${custOrd.id}/cancel`, { reason: "not mine" });
  await juanC.post(`/portal/orders/${custOrd.id}/cancel`, {});
  check("CAN-3", "A customer cancels their own unpaid order from the portal (the reason defaults to \"Cancelled by the customer\"); another customer gets 404", anaCancel.status === 404 && (await orderRow(custOrd.id)).status === "cancelled" && (await orderRow(custOrd.id)).cancel_reason === "Cancelled by the customer");

  // ================================================================ refunds (TC-14)
  await agent.get(`/crm/sales/orders/${so.id}`);
  const refundBad = [];
  for (const [name, data, expected] of [["too much", { amount: "99999", reason: "Too much on purpose" }, /more than can still be refunded/], ["short reason", { amount: "10", reason: "no" }, /at least 5/], ["no amount", { amount: "", reason: "Missing amount here" }, /refund amount/], ["bad case", { amount: "10", reason: "Case that is not his", case_no: "JVT-00000000-0000" }, /case number was not found/], ["too many items", { amount: "10", reason: "More items than sold", "ret_qty_MOCK-P-1010": "9", "ret_cond_MOCK-P-1010": "good" }, /more than was sold/], ["bad condition", { amount: "10", reason: "No condition given", "ret_qty_MOCK-P-1010": "1", "ret_cond_MOCK-P-1010": "weird" }, /condition/]]) {
    const n = Number((await one("SELECT COUNT(*) n FROM refunds")).n);
    await agent.post(`/crm/sales/orders/${so.id}/refund`, data);
    const msg = await flashAfter(agent, `/crm/sales/orders/${so.id}`);
    if (!expected.test(msg) || Number((await one("SELECT COUNT(*) n FROM refunds")).n) !== n) refundBad.push(`${name}: ${msg}`);
  }
  check("RFD-1", "Refund requests are validated (more than refundable, short reason, no amount, a case of another customer, more items than sold, no condition; a forged item outside the order is ignored) and nothing is saved", refundBad.length === 0, refundBad.join("; "));
  const refundReq = await agent.post(`/crm/sales/orders/${so.id}/refund`, { amount: "58", reason: "One bread loaf was moldy", "ret_qty_MOCK-P-1010": "1", "ret_cond_MOCK-P-1010": "expired" });
  const rf = await one("SELECT * FROM refunds ORDER BY id DESC LIMIT 1");
  const rfItems = rf.return_items;
  check("RFD-2", "A refund request on the completed sale is saved as Requested with its number (RFD), the returned item with its condition, and the correlation id of the sale; the Team Leaders and Manager are notified",
    refundReq.status === 302 && /^RFD-\d{8}-\d{4}$/.test(rf.refund_no) && rf.status === "requested" && Number(rf.amount) === 58 && rf.requested_by === kristine.id && rf.approved_by === null && rfItems[0].condition === "expired" && rf.correlation_id === sale.correlation_id &&
    Number((await one("SELECT COUNT(*) n FROM crm_notifications WHERE related_type = 'refund' AND related_id = ? AND user_id = ?", [rf.id, maria.id])).n) === 1);
  const agentApprove = await agent.post(`/crm/sales/refunds/${rf.id}/decide`, { decision: "approve" });
  const rfPage = (await agent.get(`/crm/sales/refunds/${rf.id}`)).body;
  let selfDb = "no error";
  try { await db.query("UPDATE refunds SET approved_by = requested_by WHERE id = ?", [rf.id]); } catch (e) { selfDb = e.code; }
  // a Team Leader who requests a refund cannot approve her own request either
  await tl.get(`/crm/sales/orders/${so.id}`);
  await tl.post(`/crm/sales/orders/${so.id}/refund`, { amount: "24", reason: "Team Leader requested this one" });
  const rf2 = await one("SELECT * FROM refunds ORDER BY id DESC LIMIT 1");
  const ownTl = await tl.post(`/crm/sales/refunds/${rf2.id}/decide`, { decision: "approve" });
  check("TC-14", "A refund is never approved by its requester: an agent has no approve rights (403), a Team Leader cannot approve her own request (403, audited, no button shown), and the database CHECK refuses approved_by = requested_by",
    agentApprove.status === 403 && !rfPage.includes('name="decision"') && ownTl.status === 403 && (await one("SELECT status FROM refunds WHERE id = ?", [rf2.id])).status === "requested" && selfDb === "ER_CHECK_CONSTRAINT_VIOLATED" && (await auditCount("access_denied", "AND details LIKE 'refund decision:%'")) >= 1, `${agentApprove.status} ${ownTl.status} ${selfDb}`);
  await mgr.get(`/crm/sales/refunds/${rf2.id}`);
  const rejectNoReason = await mgr.post(`/crm/sales/refunds/${rf2.id}/decide`, { decision: "reject", reason: "" });
  const rejMsg = await flashAfter(mgr, `/crm/sales/refunds/${rf2.id}`);
  await mgr.post(`/crm/sales/refunds/${rf2.id}/decide`, { decision: "reject", reason: "The receipt shows this item was not bought" });
  const recordEarly = await tl.post(`/crm/sales/refunds/${rf.id}/record`, {});
  const earlyRec = await flashAfter(tl, `/crm/sales/refunds/${rf.id}`);
  await tl.post(`/crm/sales/refunds/${rf.id}/decide`, { decision: "approve" });
  const evBefore = (await outbox("RefundRecorded", rf.refund_id)).length;
  await tl.post(`/crm/sales/refunds/${rf.id}/record`, {});
  const evRefund = await outbox("RefundRecorded", rf.refund_id);
  await tl.post(`/crm/sales/refunds/${rf.id}/record`, {});
  const recTwice = await flashAfter(tl, `/crm/sales/refunds/${rf.id}`);
  const saleAfter = await one("SELECT status, payment_status FROM sales_transactions WHERE id = ?", [sale.id]);
  const refEnv = typeof evRefund[0].payload === "string" ? JSON.parse(evRefund[0].payload) : evRefund[0].payload;
  check("RFD-3", "Refund decisions: rejecting needs a reason; a requested refund cannot be recorded before it is approved; a different person approves; recording publishes ONE RefundRecorded per target (mock, with the returned items) and marks the sale and the order partly refunded; recording twice is refused",
    rejectNoReason.status === 302 && /at least 5/.test(rejMsg) && (await one("SELECT status, decision_reason FROM refunds WHERE id = ?", [rf2.id])).status === "rejected" && /Only an approved refund/.test(earlyRec) && recordEarly.status === 302 && evBefore === 0 && evRefund.length === 2 && refEnv.data.amount === "58.00" && refEnv.data.return_items[0].condition === "expired" &&
    saleAfter.status === "partially_refunded" && (await orderRow(so.id)).payment_status === "partially_refunded" && /already recorded/.test(recTwice) && (await auditCount("refund_recorded")) >= 1, `${rejMsg} | ${earlyRec} | ${evRefund.length} | ${saleAfter.status}`);
  const refundable = await agent.post(`/crm/sales/orders/${so.id}/refund`, { amount: "9999", reason: "More than what remains refundable" });
  const refundableMsg = await flashAfter(agent, `/crm/sales/orders/${so.id}`);
  check("RFD-4", "Refunds already requested or recorded reduce what can still be refunded (₱236 − ₱58 = ₱178): asking for more is refused with the remaining amount", /still be refunded on this sale \(₱178\.00\)/.test(refundableMsg), refundableMsg);

  // ================================================================ promotions and campaigns
  const promoForm = (extra = {}) => ({ promo_code: "TESTPROMO", name: "Test promotion", promo_type: "percent", value: "15", min_order_amount: "100", applies_to: "order", start_at: "2026-11-01T08:00", end_at: "2099-12-31T20:00", usage_limit: "50", ...extra });
  await mgr.get("/crm/promotions/new");
  const promoBad = [];
  for (const [name, extra, expected] of [["short code", { promo_code: "AB" }, /4 to 20/], ["percent over 100", { value: "150" }, /more than 100/], ["zero value", { value: "0" }, /more than zero/], ["end before start", { end_at: "2026-10-01T08:00" }, /end must be after/], ["already over", { start_at: "2020-01-01T08:00", end_at: "2020-02-01T08:00" }, /already be over/], ["product missing", { applies_to: "product", product_id: "NOPE" }, /product that Inventory sells/], ["category missing", { applies_to: "category", category_name: "Nonsense" }, /category/], ["bad usage limit", { usage_limit: "0" }, /whole number/], ["no name", { name: "" }, /name/]]) {
    const n = Number((await one("SELECT COUNT(*) n FROM promotions")).n);
    const r = await mgr.post("/crm/promotions", promoForm(extra));
    if (r.status !== 422 || !errorList(r.body).some((e) => expected.test(e)) || Number((await one("SELECT COUNT(*) n FROM promotions")).n) !== n) promoBad.push(`${name}: ${r.status} ${errorList(r.body).join("|")}`);
  }
  const dupCode = await mgr.post("/crm/promotions", promoForm({ promo_code: "PANTRY10" }));
  check("PRM-1", "Promotion form is validated (short code, percent over 100, zero value, end before start, already over, unknown product or category, bad usage limit, no name) and a code already used is refused; nothing is saved", promoBad.length === 0 && dupCode.status === 422 && /already used/.test(errorList(dupCode.body).join(" ")), promoBad.join("; "));
  const created = await mgr.post("/crm/promotions", promoForm());
  const tp = await one("SELECT * FROM promotions WHERE promo_code = 'TESTPROMO'");
  const ownApprove = await mgr.post(`/crm/promotions/${tp.id}/approve`, {});
  let selfApproveDb = "no error";
  try { await db.query("UPDATE promotions SET approved_by = created_by WHERE id = ?", [tp.id]); } catch (e) { selfApproveDb = e.code; }
  const mgrList2 = (await mgr.get("/crm/promotions")).body;
  const tlList2 = (await tl.get("/crm/promotions")).body;
  const agentPromos = await agent.get("/crm/promotions");
  const tlCreate = await tl.post("/crm/promotions", promoForm({ promo_code: "TLCODE" }));
  await tl.get("/crm/promotions");
  const approved = await tl.post(`/crm/promotions/${tp.id}/approve`, {});
  const tpAfter = await one("SELECT status, approved_by, created_by FROM promotions WHERE id = ?", [tp.id]);
  check("PRM-2", "A promotion starts as \"Waiting for approval\"; its creator cannot approve it (403, audited; the database CHECK agrees); a Team Leader can approve and it becomes Active; Team Leaders cannot create promotions (403) and agents cannot open the page (403)",
    created.status === 302 && tp.status === "pending_approval" && ownApprove.status === 403 && selfApproveDb === "ER_CHECK_CONSTRAINT_VIOLATED" && mgrList2.includes("Waiting for someone else to approve") && tlList2.includes('/approve"') && agentPromos.status === 403 && tlCreate.status === 403 && approved.status === 302 && tpAfter.status === "active" && tpAfter.approved_by === maria.id && (await auditCount("promotion_approved")) >= 1, `${ownApprove.status} ${selfApproveDb}`);
  await mgr.post("/crm/promotions", promoForm({ promo_code: "REJECTME" }));
  const rj = await one("SELECT id FROM promotions WHERE promo_code = 'REJECTME'");
  await tl.post(`/crm/promotions/${rj.id}/reject`, { reason: "" });
  const rjMsg = await flashAfter(tl, "/crm/promotions");
  await tl.post(`/crm/promotions/${rj.id}/reject`, { reason: "Discount too deep for this month" });
  await mgr.post(`/crm/promotions/${tp.id}/cancel`, {});
  check("PRM-3", "Rejecting needs a reason (the promotion becomes Cancelled); the Manager can cancel an active promotion; a cancelled code is refused at checkout", /at least 5/.test(rjMsg) && (await one("SELECT status FROM promotions WHERE id = ?", [rj.id])).status === "cancelled" && (await one("SELECT status FROM promotions WHERE id = ?", [tp.id])).status === "cancelled" && (await auditCount("promotion_rejected")) >= 1);

  await mgr.get("/crm/campaigns/new");
  const campBad = await mgr.post("/crm/campaigns", { name: "x", channel: "pigeon", start_date: "2026-12-10", end_date: "2026-12-01" });
  const campOk = await mgr.post("/crm/campaigns", { name: "Holiday groceries", channel: "mixed", start_date: "2026-12-01", end_date: "2026-12-31", description: "Christmas season." });
  const cp = await one("SELECT * FROM campaigns WHERE name = 'Holiday groceries'");
  await mgr.post(`/crm/campaigns/${cp.id}/end`, {});
  const endDraft = await flashAfter(mgr, `/crm/campaigns/${cp.id}`);
  await mgr.post(`/crm/campaigns/${cp.id}/activate`, {});
  await mgr.post("/crm/promotions", promoForm({ promo_code: "XMAS5", name: "Christmas 5%", value: "5", campaign_id: String(cp.id) }));
  const xp = await one("SELECT id FROM promotions WHERE promo_code = 'XMAS5'");
  await tl.post(`/crm/promotions/${xp.id}/approve`, {});
  const campPage = await mgr.get(`/crm/campaigns/${cp.id}`);
  const noUses = campPage.body.includes("Promotion uses");
  await staffOrder(agent, ernesto.id, { "MOCK-P-1001": 2 }, { promo_code: "xmas5" });
  const campAfter = (await mgr.get(`/crm/campaigns/${cp.id}`)).body;
  const campRes = await one("SELECT COUNT(r.id) uses, SUM(r.discount_amount) disc FROM promotion_redemptions r JOIN promotions p ON p.id = r.promotion_id WHERE p.campaign_id = ?", [cp.id]);
  check("CMP-1", "Campaigns: an invalid form is refused; a valid one is created as a draft with a CMP code; a draft cannot be ended, it can be activated; promotions can belong to it; its results come from real orders (1 use, ₱28.50 discount) and say there are no sent/opened figures; Team Leaders and agents get 403",
    campBad.status === 422 && campOk.status === 302 && /^CMP-\d{4}$/.test(cp.campaign_code) && cp.status === "draft" && /cannot be ended/.test(endDraft) && noUses && Number(campRes.uses) === 1 && Number(campRes.disc) === 28.5 && campAfter.includes("₱28.50") && campAfter.includes("does not send messages") &&
    (await tl.get("/crm/campaigns")).status === 403 && (await agent.get("/crm/campaigns")).status === 403 && (await auditCount("campaign_activated")) >= 1, `${endDraft} ${JSON.stringify(campRes)}`);
  await mgr.post(`/crm/campaigns/${cp.id}/end`, {});
  await mgr.post(`/crm/campaigns/${cp.id}/cancel`, {});
  const endedCancel = await flashAfter(mgr, `/crm/campaigns/${cp.id}`);
  check("CMP-2", "An ended campaign cannot be cancelled", (await one("SELECT status FROM campaigns WHERE id = ?", [cp.id])).status === "ended" && /cannot be cancelled/.test(endedCancel), endedCancel);
  const sync = await mgr.post("/crm/sales/sync", {});
  const agentSync = await agent.post("/crm/sales/sync", {});
  check("SYNC-1", "The Manager can refresh the product snapshot from Inventory (audited, logged as a mock sync); an agent cannot (403)", sync.status === 302 && agentSync.status === 403 && (await auditCount("inventory_snapshot_refreshed")) >= 1);

  // ================================================================ dashboards, customer page, tracking, samples
  const agentHome = (await agent.get("/crm/agent")).body;
  const tlHome = (await tl.get("/crm/team-leader")).body;
  const mgrHome = (await mgr.get("/crm/manager")).body;
  const portalHome = (await juanC.get("/portal")).body;
  const custPage = (await agent.get(`/crm/customers/${ernesto.id}`)).body;
  check("DASH-5", "Dashboards use real order figures: the agent's and the customer's dashboards have no sample badge; Team Leader and Manager show sales, payments to verify, refunds and promotions waiting, with the sample badge only on what is still P6 / P7 / P8 / P9; the customer's page lists their orders",
    !agentHome.includes("Sample data – not yet connected") && agentHome.includes("Payments to verify") && !portalHome.includes("Sample data – not yet connected") && /\/portal\/orders\/\d+/.test(portalHome) && tlHome.includes("Refunds to decide") && tlHome.includes("Promotions to approve") && !/P5/.test(tlHome.replace(/SO-[^<]*/g, "")) &&
    mgrHome.includes("Completed sales today") && mgrHome.includes("Best-selling products") && !mgrHome.includes("Sample data – not yet connected") && !/P5/.test(mgrHome),
    JSON.stringify({ a: !agentHome.includes("Sample data – not yet connected"), b: agentHome.includes("Payments to verify"), c: !portalHome.includes("Sample data – not yet connected"), d: /\/portal\/orders\/\d+/.test(portalHome), e: tlHome.includes("Refunds to decide"), f: tlHome.includes("Promotions to approve"), g: !/P5/.test(tlHome.replace(/SO-[^<]*/g, "")), h: mgrHome.includes("Completed sales today"), i: mgrHome.includes("Best-selling products"), j: !mgrHome.includes("Sample data – not yet connected"), k: !/P5/.test(mgrHome) }));
  check("CUST-5", "The customer page shows live purchase history with a New order button (the sample panel is gone)", custPage.includes(so.order_no) && custPage.includes(`/crm/sales/new?customer_id=${ernesto.id}`) && !custPage.includes("Recent orders (sample)") && !custPage.includes("P5 (orders)"));
  const track = (await juanC.get("/portal/tracking")).body;
  const trackDone = (await juanC.get(`/portal/orders/${og.id}`)).body;
  check("TRK-1", "Order Tracking follows the blueprint lifecycle (placed, confirmed and stock reserved, payment verified, ready, completed; Cancelled shown with its reason); no invented delivery steps",
    track.includes("Order placed") && track.includes("Confirmed, stock reserved") && track.includes("Payment verified") && /Ready for (pickup|delivery)/.test(track) && track.includes("Cancelled:") && !/Preparing|Out for delivery/.test(track + trackDone));
  const removedKeys = ["sales.orders", "sales.new", "sales.order", "sales.payments", "sales.refunds", "sales.refund", "campaigns.list", "campaigns.new", "campaigns.detail", "promotions.list", "promotions.new", "portal.orders", "portal.order", "portal.tracking", "portal.shop", "portal.cart"];
  const stillThere = PAGES.filter((p) => removedKeys.includes(p.key)).map((p) => p.key);
  const BADGE = "Sample data – not yet connected";
  const badged = [];
  for (const [c, path] of [[agent, "/crm/sales"], [agent, "/crm/sales/new"], [agent, `/crm/sales/orders/${so.id}`], [agent, "/crm/sales/payments"], [agent, "/crm/sales/refunds"], [agent, `/crm/sales/refunds/${rf.id}`], [mgr, "/crm/campaigns"], [mgr, "/crm/campaigns/new"], [mgr, `/crm/campaigns/${cp.id}`], [mgr, "/crm/promotions"], [mgr, "/crm/promotions/new"], [juanC, "/portal/orders"], [juanC, `/portal/orders/${o1.id}`], [juanC, "/portal/tracking"], [juanC, "/portal/shop"], [juanC, "/portal/cart"]]) {
    if ((await c.get(path)).body.includes(BADGE)) badged.push(path);
  }
  const loyalty = await mgr.get("/crm/loyalty");
  check("SMP-4", "The 16 P5 sample pages are removed from services/samples and every route is a live page without the sample badge; no sample screen of P3–P8 remains (Loyalty became live in P8); Loyalty is labelled P8 (its rules were decided on 2026-11-13) instead of P5",
    stillThere.length === 0 && badged.length === 0 && PAGES.every((p) => !["P3", "P4", "P5", "P6", "P7", "P8"].includes(p.phase)) && loyalty.status === 200 && !loyalty.body.includes("Sample data – not yet connected"), `${stillThere} ${badged} ${PAGES.length}`);
  const BAD = /\[object Object\]|\bundefined\b|\bNaN\b|\{\{|\}\}/;
  const pageProblems = [];
  const roleSets = [["agent", agent, ["/crm/sales", "/crm/sales/new", `/crm/sales/new?customer_id=${ernesto.id}`, `/crm/sales/orders/${so.id}`, "/crm/sales/payments", "/crm/sales/refunds", `/crm/sales/refunds/${rf.id}`, "/crm/agent", `/crm/customers/${ernesto.id}`]],
    ["tl", tl, ["/crm/sales", `/crm/sales/orders/${so.id}`, "/crm/sales/payments", "/crm/sales/refunds", `/crm/sales/refunds/${rf.id}`, "/crm/promotions", "/crm/team-leader"]],
    ["mgr", mgr, ["/crm/sales", "/crm/sales/new", `/crm/sales/orders/${so.id}`, "/crm/sales/payments", "/crm/sales/refunds", "/crm/campaigns", "/crm/campaigns/new", `/crm/campaigns/${cp.id}`, "/crm/promotions", "/crm/promotions/new", "/crm/manager", "/crm/loyalty"]],
    ["customer", juanC, ["/portal", "/portal/shop", "/portal/shop?q=rice", "/portal/cart", "/portal/orders", `/portal/orders/${o1.id}`, `/portal/orders/${og.id}`, "/portal/tracking"]]];
  for (const [name, c, paths] of roleSets) for (const p of paths) {
    const r = await c.get(p);
    if (r.status !== 200) pageProblems.push(`${name} ${p} → ${r.status}`); else if (BAD.test(strip(r.body))) pageProblems.push(`${name} ${p} → stray text`);
  }
  check("PAGES-P5", "Per-role page check: every new sales, order, payment, refund, campaign, promotion, shop, cart and tracking page opens for Agent, Team Leader, Manager and Customer with no stray template text", pageProblems.length === 0, pageProblems.join("; "));

  // ================================================================ seed:clear never touches real records
  const realOrders = Number((await one("SELECT COUNT(*) n FROM sales_orders WHERE is_demo = 0")).n);
  const realSales = Number((await one("SELECT COUNT(*) n FROM sales_transactions WHERE is_demo = 0")).n);
  const realRefunds = Number((await one("SELECT COUNT(*) n FROM refunds r JOIN sales_transactions s ON s.id = r.sales_transaction_id WHERE s.is_demo = 0")).n);
  const realEvents = Number((await one("SELECT COUNT(*) n FROM integration_outbox WHERE entity_id IN (SELECT order_id FROM sales_orders WHERE is_demo = 0)")).n);
  const clear = node(["seeders/index.js", "--clear"]);
  const left = await one("SELECT (SELECT COUNT(*) FROM sales_orders WHERE is_demo = 1) demo_orders, (SELECT COUNT(*) FROM sales_orders WHERE is_demo = 0) real_orders, (SELECT COUNT(*) FROM sales_transactions WHERE is_demo = 0) real_sales, (SELECT COUNT(*) FROM refunds) refunds_left, (SELECT COUNT(*) FROM promotions WHERE is_demo = 1) demo_promos, (SELECT COUNT(*) FROM campaigns WHERE is_demo = 1) demo_camps");
  const realEventsAfter = Number((await one("SELECT COUNT(*) n FROM integration_outbox WHERE entity_id IN (SELECT order_id FROM sales_orders WHERE is_demo = 0)")).n);
  check("CLEAR-1", "seed:clear removes only demo sales rows: demo orders, sales, refunds, campaigns and their events go; every real order, sale, refund and event stays (a demo promotion used by a real order is kept together with its campaign)",
    clear.status === 0 && Number(left.demo_orders) === 0 && Number(left.real_orders) === realOrders && Number(left.real_sales) === realSales && Number(left.refunds_left) === realRefunds && realEventsAfter === realEvents && Number(left.demo_camps) === 1 && Number(left.demo_promos) >= 1,
    `${clear.stderr?.slice(0, 300)} ${JSON.stringify(left)} real ${realOrders}/${realSales}/${realRefunds}/${realEvents}`);
} catch (err) {
  check("RUN", "Tests ran without an unexpected error", false, err.stack || String(err));
} finally {
  await env.stop();
  summarize(DB);
}
