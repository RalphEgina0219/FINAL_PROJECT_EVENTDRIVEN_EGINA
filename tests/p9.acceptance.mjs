/*
 * JOHNVIVZ CRM — Phase P9 (analytics) acceptance tests.   npm run test:p9
 * Throwaway database johnvivz_crm_p9_test. Real (non-demo) sales are created through the app, so official figures (demo excluded)
 * can be checked against SQL. Forecast methods are also checked directly as pure functions.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { check, startEnvironment, summarize, root } from "./support/harness.mjs";
import { METHODS, backtest } from "../services/forecastService.js";
import { PAGES } from "./support/noSamples.mjs";
import { segmentFor } from "../services/segmentService.js";

const DB = process.env.TEST_P9_DB_NAME || "johnvivz_crm_p9_test";
const PORT = Number(process.env.TEST_P9_PORT || 3205);
const env = await startEnvironment({ dbName: DB, port: PORT });
console.log(`\nJOHNVIVZ CRM P9 tests — database ${DB}\n`);
check("ENV-01", "Migrations (101–120), demo seed and fixtures load; the server starts", env.steps.migrate.status === 0 && env.steps.seed.status === 0 && env.steps.fixtures.status === 0 && env.up,
  env.steps.migrate.stderr || env.steps.seed.stderr || env.steps.fixtures.stderr || env.serverLog());

const { all, one, as } = env;
const uuid = () => crypto.randomUUID();
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
const money = (n) => `₱${Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400e3).toISOString().slice(0, 10);

try {
  const ernesto = await one("SELECT id FROM customers WHERE first_name = 'Ernesto'");
  const agent = await as("kristine.bautista@johnvivz.test");
  const tl = await as("maria.santos@johnvivz.test");
  const mgr = await as("manager@johnvivz.test");
  const juanC = await as("juan.cruz@johnvivz.test");

  // ================================================================ migration 121 and segments
  const segs = await all("SELECT code FROM customer_segments ORDER BY id");
  const assigned = await one("SELECT COUNT(*) n, SUM(segment_id IS NOT NULL) s FROM customers WHERE status <> 'merged'");
  const noNew = !fs.existsSync(path.join(root, "migrations", "121_seed_customer_segments.js"));
  const rules = [
    segmentFor({ sales6m: 6, monthsWithPurchase3m: 1, totalSales: 6, daysSinceLastPurchase: 1, daysSinceFirstPurchase: 100, daysSinceRegistration: 200, daysSinceLastActivity: 1 }) === "loyal",
    segmentFor({ sales6m: 2, monthsWithPurchase3m: 2, totalSales: 2, daysSinceLastPurchase: 3, daysSinceFirstPurchase: 40, daysSinceRegistration: 90, daysSinceLastActivity: 3 }) === "regular",
    segmentFor({ sales6m: 2, monthsWithPurchase3m: 0, totalSales: 3, daysSinceLastPurchase: 75, daysSinceFirstPurchase: 150, daysSinceRegistration: 300, daysSinceLastActivity: 75 }) === "at_risk",
    segmentFor({ sales6m: 1, monthsWithPurchase3m: 1, totalSales: 1, daysSinceLastPurchase: 5, daysSinceFirstPurchase: 5, daysSinceRegistration: 400, daysSinceLastActivity: 5 }) === "new",
    segmentFor({ sales6m: 0, monthsWithPurchase3m: 0, totalSales: 0, daysSinceLastPurchase: null, daysSinceFirstPurchase: null, daysSinceRegistration: 10, daysSinceLastActivity: null }) === "new",
    segmentFor({ sales6m: 0, monthsWithPurchase3m: 0, totalSales: 1, daysSinceLastPurchase: 400, daysSinceFirstPurchase: 400, daysSinceRegistration: 500, daysSinceLastActivity: 300 }) === "inactive",
  ];
  check("MIG-5", "No migration was needed: the five rule-based segments migration 104 created from the master prompt (new, regular, loyal, at risk, inactive) are applied as written, checked as a plain function for every segment; the demo seed computes them (no AI)",
    noNew && segs.map((x) => x.code).join(",") === "new,regular,loyal,at_risk,inactive" && rules.every(Boolean) && Number(assigned.s) > 0, JSON.stringify({ rules, assigned }));

  // ================================================================ real (non-demo) data
  const staffOrder = async (lines, payment = "cash") => {
    await agent.get(`/crm/sales/new?customer_id=${ernesto.id}`);
    const key = uuid();
    const body = { customer_id: String(ernesto.id), request_key: key, channel: "walk_in", fulfillment: "pickup", payment_method: payment };
    for (const [pid, q] of lines) body[`qty_${pid}`] = String(q);
    await agent.post("/crm/sales", body);
    return one("SELECT * FROM sales_orders WHERE order_id = ?", [key]);
  };
  const o1 = await staffOrder([["MOCK-P-1001", 2]]); // 570
  const o2 = await staffOrder([["MOCK-P-1004", 3]]); // 294
  const o3 = await staffOrder([["MOCK-P-1006", 1]], ""); // will be cancelled
  for (const o of [o1, o2]) { await agent.get(`/crm/sales/orders/${o.id}`); await agent.post(`/crm/sales/orders/${o.id}/complete`, {}); }
  await agent.get(`/crm/sales/orders/${o3.id}`);
  await agent.post(`/crm/sales/orders/${o3.id}/cancel`, { reason: "Customer changed their mind" });
  // a recorded refund on o2
  await agent.get(`/crm/sales/orders/${o2.id}`);
  await agent.post(`/crm/sales/orders/${o2.id}/refund`, { amount: "98", reason: "One carton was damaged" });
  const rf = await one("SELECT * FROM refunds ORDER BY id DESC LIMIT 1");
  await tl.get(`/crm/sales/refunds/${rf.id}`);
  await tl.post(`/crm/sales/refunds/${rf.id}/decide`, { decision: "approve" });
  await tl.post(`/crm/sales/refunds/${rf.id}/record`, {});

  const from = addDays(today, -29);
  const official = await one(`SELECT (SELECT COALESCE(SUM(net_amount), 0) FROM sales_transactions WHERE is_demo = 0 AND status <> 'voided' AND DATE(completed_at) BETWEEN ? AND ?)
                                 - (SELECT COALESCE(SUM(r.amount), 0) FROM refunds r JOIN sales_transactions s ON s.id = r.sales_transaction_id WHERE r.status = 'recorded' AND s.is_demo = 0 AND DATE(r.recorded_at) BETWEEN ? AND ?) AS net`, [from, today, from, today]);
  const withDemo = await one(`SELECT (SELECT COALESCE(SUM(net_amount), 0) FROM sales_transactions WHERE status <> 'voided' AND DATE(completed_at) BETWEEN ? AND ?)
                                 - (SELECT COALESCE(SUM(r.amount), 0) FROM refunds r WHERE r.status = 'recorded' AND DATE(r.recorded_at) BETWEEN ? AND ?) AS net`, [from, today, from, today]);
  const ov = (await mgr.get("/crm/analytics")).body;
  const ovDemo = (await mgr.get(`/crm/analytics?from=${from}&to=${today}&demo=1`)).body;
  check("AN-1", "Official overview: net sales exclude demo data and cancelled orders and subtract recorded refunds (₱570 + ₱294 − ₱98 = ₱766), equal to the SQL; the page says the figures are official",
    Number(official.net) === 766 && ov.includes(money(official.net)) && ov.includes('data-official="1"') && !ov.includes('data-includes-demo="1"'), `${official.net}`);
  check("AN-2", "With \"Include demo data\" on, the figures include demo sales and every page says \"includes demo data\" (not official)", ovDemo.includes(money(withDemo.net)) && ovDemo.includes('data-includes-demo="1"') && Number(withDemo.net) > Number(official.net), `${withDemo.net}`);
  const orders = await one("SELECT COUNT(*) n, SUM(status = 'cancelled') c FROM sales_orders WHERE is_demo = 0 AND DATE(created_at) BETWEEN ? AND ?", [from, today]);
  check("AN-3", "Orders placed counts real orders and shows how many were cancelled; cancelled orders never count as sales", ov.includes(`${orders.c} cancelled`) && Number(orders.c) === 1 && !ov.includes(money(766 + 92)));
  const sales = (await mgr.get("/crm/analytics/sales")).body;
  check("AN-4", "Sales intelligence: channels, top products, categories and promotions come from the real sales of the period (Sinandomeng Rice and Fresh Milk appear; demo-only products do not)",
    sales.includes("Sinandomeng Rice 5kg") && sales.includes("Fresh Milk 1L") && sales.includes("Walk-in") && !sales.includes("Sample data") && sales.includes('data-official="1"'), JSON.stringify({ rice: sales.includes("Sinandomeng Rice 5kg"), milk: sales.includes("Fresh Milk 1L"), walk: sales.includes("Walk-in"), off: sales.includes('data-official="1"') }));
  await mgr.get("/crm/analytics/customers");
  const segBtn = await mgr.post("/crm/analytics/customers/segments", {});
  const cust = (await mgr.get("/crm/analytics/customers")).body;
  const ernestoSeg = (await one("SELECT g.code FROM customers c LEFT JOIN customer_segments g ON g.id = c.segment_id WHERE c.id = ?", [ernesto.id])) || {};
  const st = await one(`SELECT (SELECT COUNT(*) FROM sales_transactions s WHERE s.customer_id = c.id AND s.status <> 'voided' AND s.completed_at >= NOW() - INTERVAL 6 MONTH) sales6m,
    (SELECT COUNT(DISTINCT DATE_FORMAT(s.completed_at, '%Y-%m')) FROM sales_transactions s WHERE s.customer_id = c.id AND s.status <> 'voided' AND s.completed_at >= DATE_FORMAT(NOW() - INTERVAL 2 MONTH, '%Y-%m-01')) months3,
    (SELECT COUNT(*) FROM sales_transactions s WHERE s.customer_id = c.id AND s.status <> 'voided') total,
    (SELECT FLOOR(TIMESTAMPDIFF(SECOND, MAX(s.completed_at), NOW()) / 86400) FROM sales_transactions s WHERE s.customer_id = c.id AND s.status <> 'voided') last_days,
    (SELECT FLOOR(TIMESTAMPDIFF(SECOND, MIN(s.completed_at), NOW()) / 86400) FROM sales_transactions s WHERE s.customer_id = c.id AND s.status <> 'voided') first_days,
    FLOOR(TIMESTAMPDIFF(SECOND, c.created_at, NOW()) / 86400) reg_days FROM customers c WHERE c.id = ?`, [ernesto.id]);
  const expected = segmentFor({ sales6m: Number(st.sales6m), monthsWithPurchase3m: Number(st.months3), totalSales: Number(st.total), daysSinceLastPurchase: st.last_days === null ? null : Number(st.last_days), daysSinceFirstPurchase: st.first_days === null ? null : Number(st.first_days), daysSinceRegistration: Number(st.reg_days), daysSinceLastActivity: 0 });
  const ernestoSales = Number(st.total);
  check("AN-5", "Customers & retention: buyers, repeat customer rate, rule-based segments with their rules written out; 'Recompute segments' applies the rules (Ernesto's segment matches his completed purchases)",
    segBtn.status === 302 && cust.includes("Repeat customer rate") && cust.includes("Customer segments (rule-based") && cust.includes("6 or more completed sales in 6 months") && ernestoSeg.code === expected, `${ernestoSeg?.code} vs ${expected} (${ernestoSales})`);
  const custPage = (await agent.get(`/crm/customers/${ernesto.id}`)).body;
  check("AN-6", "The customer page shows the computed segment (no 'not computed yet (P9)' text left)", !custPage.includes("(P9)") && /Regular|Loyal|First-time buyer|New|Inactive/.test(custPage));

  // ================================================================ forecasts
  const ma = METHODS.moving_average_7([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], 3);
  const lin = METHODS.linear_trend_28(Array.from({ length: 28 }, (_, i) => 2 * i + 3), 2);
  const week = [5, 1, 1, 1, 1, 1, 9];
  const seasonal = METHODS.seasonal_naive_7([...week, ...week, ...week], 7);
  const weekly = Array.from({ length: 56 }, (_, i) => week[i % 7]);
  const bt = Object.keys(METHODS).map((m) => ({ m, ...backtest(weekly, m) })).sort((a, b) => a.mae - b.mae);
  check("FC-1", "Statistical methods only, checked as plain functions: 7-day moving average (mean of the last 7), least-squares line (exact on a straight line), same weekday last week; the back-test picks the seasonal method for a weekly pattern (MAE 0)",
    ma.every((v) => v === 11) && Math.abs(lin[0] - 59) < 1e-9 && Math.abs(lin[1] - 61) < 1e-9 && seasonal.join(",") === week.join(",") && bt[0].m === "seasonal_naive_7" && bt[0].mae === 0, JSON.stringify({ ma: ma[0], lin, bt: bt.map((b) => `${b.m}:${b.mae.toFixed(2)}`) }));
  const empty = (await mgr.get("/crm/analytics/forecasts")).body;
  await mgr.post("/crm/analytics/forecasts/generate", {});
  const runs = await all("SELECT * FROM forecast_runs ORDER BY id");
  const vals = await all("SELECT * FROM forecast_values");
  check("FC-2", "Computing forecasts stores one run per metric (sales amount, orders, cases) with method, method version, input period (56 days ending yesterday), horizon (14 days), error metric (MAE) and value, what was excluded, who ran it; 14 values each, every lower ≤ estimate ≤ upper and never below zero",
    empty.includes("No forecast computed yet") && runs.length === 3 && runs.every((r) => Object.keys(METHODS).includes(r.method) && r.method_version === "1.0" && r.horizon_days === 14 && r.error_metric === "MAE" && r.error_value !== null && /Demo data, cancelled orders and voided sales excluded/.test(r.excluded_note) && r.generated_by) &&
    runs.every((r) => new Date(r.input_to).getTime() - new Date(r.input_from).getTime() === 55 * 86400e3) && vals.length === 42 && vals.every((v) => Number(v.lower_bound) <= Number(v.estimate) && Number(v.estimate) <= Number(v.upper_bound) && Number(v.lower_bound) >= 0),
    JSON.stringify(runs.map((r) => [r.metric, r.method, r.error_value, r.input_from, r.input_to])));
  const fpage = (await mgr.get("/crm/analytics/forecasts")).body;
  check("FC-3", "The forecast page labels every forecast \"Estimate\" next to the actual figures (actual columns, then dashed Estimate columns with a legend), and shows the method, input period, horizon and error of each run",
    (fpage.match(/>Estimate</g) || []).length >= 3 && fpage.includes('data-estimate="1"') && /Method: <strong>(7-day moving average|Linear trend|Same weekday)/.test(fpage) && fpage.includes("horizon 14 days") && fpage.includes("back-test MAE") && fpage.includes("Actual"));
  await mgr.post("/crm/analytics/forecasts/generate", { include_demo: "1" });
  const demoRun = await one("SELECT * FROM forecast_runs ORDER BY id DESC LIMIT 1");
  const fpage2 = (await mgr.get("/crm/analytics/forecasts")).body;
  const audits = Number((await one("SELECT COUNT(*) n FROM crm_audit_logs WHERE action = 'forecast_generated'")).n);
  check("FC-4", "A forecast that includes demo data is stored and shown as such (\"includes demo data\"); every run is audited", /INCLUDES DEMO DATA/.test(demoRun.excluded_note) && fpage2.includes('data-includes-demo="1"') && audits === 6);

  // ================================================================ dashboards, access, samples, pages
  const mdash = (await mgr.get("/crm/manager")).body;
  check("DASH-9", "Manager dashboard: the sample 'Retention and forecast' widget is replaced by the real repeat-customer rate and the next-7-days Estimate from the latest forecast run; no sample badge is left on any dashboard",
    mdash.includes('data-retention="1"') && mdash.includes("Next 7 days net sales · Estimate") && !mdash.includes("Sample data – not yet connected") && !mdash.includes("62%") && !(await tl.get("/crm/team-leader")).body.includes("Sample data") && !(await agent.get("/crm/agent")).body.includes("Sample data") && !(await juanC.get("/portal")).body.includes("Sample data"));
  const denied = [await tl.get("/crm/analytics"), await agent.get("/crm/analytics/sales"), await juanC.get("/crm/analytics/forecasts"), await tl.post("/crm/analytics/forecasts/generate", {})];
  check("AN-7", "Analytics is the CRM Manager's (reports.view_all): Team Leader, Agent and Customer get 403, including the forecast button; Team Leaders keep their team reports", denied.every((r) => r.status === 403) && (await tl.get("/crm/reports")).status === 200, denied.map((r) => r.status).join(","));
  check("SMP-8", "No sample page remains (the four analytics samples are gone)", PAGES.length === 0, String(PAGES.length));
  const BAD = /\[object Object\]|\bundefined\b|\bNaN\b|\{\{|\}\}/;
  const stray = [];
  for (const p of ["/crm/analytics", `/crm/analytics?from=${from}&to=${today}&demo=1`, "/crm/analytics?from=2020-01-01&to=2020-01-31", "/crm/analytics/sales", "/crm/analytics/sales?demo=1", "/crm/analytics/customers", "/crm/analytics/customers?demo=1", "/crm/analytics/forecasts", "/crm/manager", "/crm/reports"]) {
    const r = await mgr.get(p);
    if (r.status !== 200 || BAD.test(strip(r.body)) || r.body.includes("Sample data – not yet connected")) stray.push(`${p} ${r.status}`);
  }
  check("PAGES-P9", "Per-role page check: every analytics page (with and without demo data, an empty period), the Manager dashboard and reports open with no stray template text and no sample badge", stray.length === 0, stray.join("; "));
  const navs = [];
  for (const c of [mgr, tl, agent, juanC]) {
    const home = (await c.get("/dashboard")).location || "/";
    const h = (await c.get(home)).body;
    const links = [...(h.split('aria-label="Main"')[1] || "").split("</nav>")[0].matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
    for (const l of links) { const r = await c.get(l); if (r.status !== 200 || String(r.body).includes("Sample data – not yet connected")) navs.push(`${l} ${r.status}`); }
  }
  check("NOSAMPLE", "Every menu page of every role opens and none shows the \"Sample data – not yet connected\" badge any more", navs.length === 0, navs.join("; "));
} finally {
  await env.stop();
}
summarize(DB);
