/*
 * Takes screenshots of every menu page for every role (desktop 1366 px) and a few at phone width (390 px).
 *   node tests/support/screenshots.mjs
 * Uses a throwaway database (johnvivz_crm_shot_test) with the 7 demo accounts and headless Chrome/Edge driven
 * over the DevTools protocol. Output: docs/phase-reports/ui-screenshots/<role>-<page>.jpg
 * Tailwind loads from its CDN, so the machine needs internet access for styled screenshots.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { startEnvironment, root } from "./harness.mjs";

const OUT = path.join(root, "docs", "phase-reports", "ui-screenshots");
const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];
const browserPath = BROWSERS.find((p) => fs.existsSync(p));
if (!browserPath) { console.error("No Chrome or Edge found."); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith(".jpg")) fs.unlinkSync(path.join(OUT, f));

const env = await startEnvironment({ dbName: "johnvivz_crm_shot_test", port: 3194, fixtures: false, serverEnv: { APPROVALS_ENABLED: "true" } }); // approvals ON here so the P7 pages show the demo requests; the "not enabled" state is shot at the end
if (!env.up) { console.error(env.serverLog()); await env.stop(); process.exit(1); }

const PORT = 9334;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "jvt-shot-"));
const chrome = spawn(browserPath, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--hide-scrollbars", "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 60 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(250); }
}
if (!targets) { console.error("Browser did not start."); chrome.kill(); await env.stop(); process.exit(1); }
const pageTarget = targets.find((t) => t.type === "page");
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((res) => { ws.onopen = res; });
let nextId = 0;
const waiting = new Map();
const listeners = [];
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  else listeners.forEach((l) => l(msg));
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const loaded = () => new Promise((res) => { const l = (m) => { if (m.method === "Page.loadEventFired") { listeners.splice(listeners.indexOf(l), 1); res(); } }; listeners.push(l); setTimeout(res, 15000); });

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

const shot = async (client, urlPath, name, { width = 1366, mobile = false, run = null } = {}) => {
  await send("Emulation.setDeviceMetricsOverride", { width, height: mobile ? 844 : 900, deviceScaleFactor: 1, mobile });
  const done = loaded();
  await send("Page.navigate", { url: env.base + urlPath });
  await done;
  await sleep(1400); // Tailwind CDN + fonts
  if (run) { // e.g. pick an option in a dropdown, then capture what the page shows
    const out = await send("Runtime.evaluate", { expression: run, returnByValue: true });
    if (out.result.value) console.log(`  ${name}: ${out.result.value}`);
    await sleep(300);
  }
  const overflow = await send("Runtime.evaluate", { expression: "document.documentElement.scrollWidth", returnByValue: true });
  if (overflow.result.value > width + 1) console.log(`  ⚠ horizontal overflow on ${urlPath}: page is ${overflow.result.value}px wide at ${width}px`);
  if (overflow.result.value > width + 1) {
    const who = await send("Runtime.evaluate", { returnByValue: true, expression: "[...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > " + width + " + 1 && !e.closest('.overflow-x-auto') && ![...e.children].some((c) => c.getBoundingClientRect().right > " + width + " + 1)).slice(0, 5).map((e) => e.tagName + '.' + String(e.className).slice(0, 70) + ' \"' + (e.textContent || '').trim().slice(0, 40) + '\"').join(' | ')" });
    console.log(`     widest: ${who.result.value}`);
  }
  if (mobile) { // a table that scrolls sideways inside its card hides columns: report it
    const clipped = await send("Runtime.evaluate", { returnByValue: true, expression: "[...document.querySelectorAll('main .overflow-x-auto')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => (e.closest('section')?.querySelector('h2')?.textContent || 'table').trim().slice(0, 40)).join(', ')" });
    if (clipped.result.value) console.log(`  ⚠ phone: sideways-scrolling table(s) on ${urlPath}: ${clipped.result.value}`);
  }
  const m = await send("Page.getLayoutMetrics");
  const height = Math.min(Math.ceil(m.cssContentSize.height), 2600);
  const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 72, captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
  fs.writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(data, "base64"));
};

const slug = (p) => p.replace(/^\//, "").replace(/[/?=&]/g, "-") || "home";
const ROLES = [
  ["manager", "manager@johnvivz.test", "/crm/manager"],
  ["team-leader", "maria.santos@johnvivz.test", "/crm/team-leader"],
  ["agent", "kristine.bautista@johnvivz.test", "/crm/agent"],
  ["customer", "juan.cruz@johnvivz.test", "/portal"],
  ["setup", "admin@johnvivz.test", "/setup"],
];
const EXTRA = {
  manager: ["/crm/loyalty/1", "/crm/my-requests", "/crm/approvals?view=exceptions", "/crm/approvals?view=all", "/crm/approvals/1", "/crm/approvals/6", "/crm/approvals/4", "/crm/customers/1", "/crm/sales/orders/1", "/crm/sales/orders/2", "/crm/sales/new?customer_id=1", "/crm/sales/refunds/1", "/crm/campaigns/1", "/crm/campaigns/new", "/crm/promotions", "/crm/promotions/new", "/crm/loyalty", "/crm/analytics/forecasts", "/crm/analytics/customers", "/crm/settings/integration", "/crm/approvals", "/crm/settings/access"],
  "team-leader": ["/crm/approvals/1", "/crm/approvals?view=decided", "/crm/sales/refunds/1", "/crm/sales/orders/1", "/crm/promotions", "/crm/approvals", "/crm/inquiries/1", "/crm/follow-ups/1", "/crm/customers/1", "/crm/customers/new", "/crm/interactions/new"],
  agent: ["/crm/my-requests", "/crm/my-requests/1", "/profile", "/crm/sales/orders/3", "/crm/sales/payments", "/crm/sales/new?customer_id=1", "/crm/inquiries/1", "/crm/inquiries/new", "/crm/follow-ups/new", "/crm/follow-ups/1", "/crm/cases/new", "/crm/customers/1", "/crm/customers/new", "/crm/interactions/new", "/crm/interactions/1"],
  customer: ["/portal/loyalty", "/portal/shop", "/portal/cart", "/portal/orders", "/portal/orders/1", "/portal/tracking", "/portal/preferences", "/portal/inquiries", "/portal/inquiries/1"],
  setup: [],
};
// Case detail pages with the "Update status" box: one case per status the agent / supervisors see differently.
const caseIdFor = async (status, level = null) => (await env.one(
  `SELECT k.id FROM customer_cases k JOIN crm_users u ON u.id = k.assigned_agent_id
   WHERE k.status = ? ${level === null ? "" : "AND k.escalation_level = ?"} AND u.email = 'kristine.bautista@johnvivz.test' ORDER BY k.id LIMIT 1`,
  level === null ? [status] : [status, level]))?.id;
const inProgress = await caseIdFor("in_progress");
const escalated1 = await caseIdFor("escalated", 1);
const resolvedCase = await caseIdFor("resolved");
if (inProgress) { EXTRA.agent.push(`/crm/cases/${inProgress}`); EXTRA["team-leader"].push(`/crm/cases/${inProgress}`); }
if (escalated1) { EXTRA.agent.push(`/crm/cases/${escalated1}`); EXTRA["team-leader"].push(`/crm/cases/${escalated1}`); EXTRA.manager.push(`/crm/cases/${escalated1}`); }
if (resolvedCase) EXTRA.agent.push(`/crm/cases/${resolvedCase}`);
// Opens the dropdown choice and reports what the note field turned into (proves the page script works in a real browser).
const pick = (value) => `(() => { const s = document.getElementById('status-select'); if (!s) return 'no status dropdown'; s.value = '${value}'; s.dispatchEvent(new Event('change'));
  const n = document.getElementById('status-note'); return 'options: ' + [...s.options].map((o) => o.value + (o.disabled ? '(disabled)' : '')).join(', ') + ' | note: "' + n.placeholder + '" required=' + n.required; })()`;
const INTERACT = inProgress ? { agent: [[`/crm/cases/${inProgress}`, "escalated"], [`/crm/cases/${inProgress}`, "resolved"]] } : {};

const PHONE = {
  manager: ["/crm/manager", "/crm/sales", "/crm/sales/orders/1", "/crm/analytics", "/crm/campaigns", "/crm/settings/integration", "/crm/settings/integration/reconciliation", "/crm/settings/access", "/crm/approvals", "/crm/approvals/6", "/crm/loyalty", "/crm/analytics/forecasts", "/crm/analytics/sales"],
  "team-leader": ["/crm/team-leader", "/crm/approvals", "/crm/approvals/1"],
  agent: ["/crm/my-requests", "/crm/my-requests/1", "/crm/agent", "/crm/follow-ups", "/crm/sales/new", "/crm/inquiries/1"],
  customer: ["/portal/loyalty", "/portal", "/portal/shop", "/portal/tracking", "/portal/cart"],
  setup: ["/setup/integration", "/setup/integration/reconciliation", "/setup/approvals"],
};

let count = 0;
for (const [role, email, home] of ROLES) {
  const client = await env.as(email);
  const cookies = Object.entries(client.cookies).map(([name, value]) => ({ name, value, url: env.base }));
  await send("Network.clearBrowserCookies");
  for (const c of cookies) await send("Network.setCookie", c);
  const nav = (await client.get(home)).body.split('aria-label="Main"')[1].split("</nav>")[0];
  const links = [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  const pages = [...new Set([...links, ...(EXTRA[role] || [])])];
  for (const p of pages) { await shot(client, p, `${role}-${slug(p)}`); count++; }
  for (const [p, value] of INTERACT[role] || []) { await shot(client, p, `${role}-${slug(p)}-choose-${value}`, { run: pick(value) }); count++; }
  for (const p of PHONE[role] || []) { await shot(client, p, `${role}-${slug(p)}-phone`, { width: 390, mobile: true }); count++; }
  console.log(`${role}: ${pages.length} desktop page(s)`);
}
// The "Approvals are not enabled yet" state (APPROVALS_ENABLED=false, the default): a second server on the same database, two roles, desktop and phone.
{
  const offPort = 3195;
  const off = spawn(process.execPath, ["index.js"], { cwd: root, env: { ...env.env, PORT: String(offPort), APPROVALS_ENABLED: "false", DISABLE_SCHEDULER: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let offLog = "";
  off.stdout.on("data", (d) => { offLog += d; });
  for (let i = 0; i < 120 && !offLog.includes("running at"); i++) await sleep(250);
  const offBase = `http://127.0.0.1:${offPort}`;
  const { Client } = await import("./harness.mjs");
  for (const [role, email, home] of [["manager", "manager@johnvivz.test", "/crm/manager"], ["team-leader", "maria.santos@johnvivz.test", "/crm/team-leader"]]) {
    const c = new Client(offBase);
    await c.login(email);
    await send("Network.clearBrowserCookies");
    for (const [name, value] of Object.entries(c.cookies)) await send("Network.setCookie", { name, value, url: offBase });
    const saved = env.base;
    env.base = offBase;
    await shot(c, "/crm/approvals", `${role}-crm-approvals-not-enabled`); count++;
    await shot(c, "/crm/approvals", `${role}-crm-approvals-not-enabled-phone`, { width: 390, mobile: true }); count++;
    env.base = saved;
  }
  off.kill();
}
console.log(`Saved ${count} screenshot(s) to ${OUT}`);
ws.close();
chrome.kill();
await env.stop();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold the folder */ }
process.exit(0);
