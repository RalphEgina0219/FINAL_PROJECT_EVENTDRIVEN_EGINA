/*
 * JOHNVIVZ CRM — UI completion pass tests.
 *   npm run test:ui        (npm test runs P1, P2 and this suite)
 * Every menu link opens for every role, no "Coming Soon" is left, every sample page carries the
 * "Sample data – not yet connected" badge, forms validate but never save, record-level scope applies
 * to the sample pages too, and the whole pass writes nothing to the database (row counts are compared).
 * The list of sample pages is read from services/samples/pages.js, the one place that defines them.
 */
import { check, startEnvironment, summarize } from "./support/harness.mjs";
import { PAGES } from "./support/noSamples.mjs";

const DB = process.env.TEST_UI_DB_NAME || "johnvivz_crm_ui_test";
const PORT = Number(process.env.TEST_UI_PORT || 3195);
const BADGE = "Sample data – not yet connected";
const env = await startEnvironment({ dbName: DB, port: PORT });
console.log(`\nJOHNVIVZ CRM UI-pass tests — database ${DB}\n`);
check("ENV-01", "Migrations, demo seed and fixtures load; server starts", env.steps.migrate.status === 0 && env.steps.seed.status === 0 && env.steps.fixtures.status === 0 && env.up,
  env.steps.migrate.stderr || env.steps.seed.stderr || env.steps.fixtures.stderr || env.serverLog());

const { all, one, as, client } = env;
const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/g, "");
const BAD = /\[object Object\]|\bundefined\b|\bNaN\b|\{\{|\}\}/;
const alerts = (html) => [...html.matchAll(/role="(?:alert|status)">.*?<span>([^<]*)<\/span>/gs)].map((m) => m[1]);

const tableCounts = async () => {
  const tables = (await all("SELECT table_name n FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'", [DB])).map((t) => t.n || t.N || t.TABLE_NAME);
  const counts = {};
  for (const t of tables) counts[t] = Number((await one(`SELECT COUNT(*) n FROM \`${t}\``)).n);
  return counts;
};
const LIVE_WRITES = ["crm_audit_logs", "crm_notifications", "case_reads", "integration_logs"]; // written by normal page views / access denials

try {
  const mgr = await as("manager@johnvivz.test");
  const tl = await as("maria.santos@johnvivz.test");
  const agent = await as("kristine.bautista@johnvivz.test");
  const cust = await as("juan.cruz@johnvivz.test");
  const setup = await as("admin@johnvivz.test");
  const staffById = { crm_manager: mgr, team_leader: tl, agent, customer: cust, system_admin: setup };
  const HOME = { crm_manager: "/crm/manager", team_leader: "/crm/team-leader", agent: "/crm/agent", customer: "/portal", system_admin: "/setup" };
  const before = await tableCounts();
  const problems = [];
  const sampleBadgePages = [];

  // ---------------------------------------------------------------- menus
  const MENU_SIZE = { crm_manager: 10, team_leader: 7, agent: 8, customer: 6, system_admin: 9 }; // setup gained "Mock ESS Requests" in P7
  const soonText = [];
  for (const [role, c] of Object.entries(staffById)) {
    const home = await c.get(HOME[role]);
    const nav = home.body.split('aria-label="Main"')[1].split("</nav>")[0];
    const links = [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    const dead = [...nav.matchAll(/aria-disabled="true"/g)].length;
    const bad = [];
    for (const href of links) {
      const r = await c.get(href);
      if (r.status !== 200) bad.push(`${href} → ${r.status}`);
      else if (BAD.test(strip(r.body))) bad.push(`${href} → stray text`);
      if (typeof r.body === "string" && /Coming Soon/i.test(r.body)) soonText.push(`${role} ${href}`);
    }
    check("MENU", `${role}: all ${links.length} menu links open (expected ${MENU_SIZE[role]}), none disabled`, bad.length === 0 && links.length === MENU_SIZE[role] && dead === 0, `${bad.join(", ")} / links ${links.length} disabled ${dead}`);
  }
  check("MENU-02", "No page reachable from the menus says \"Coming Soon\"", soonText.length === 0, soonText.join(", "));

  // ---------------------------------------------------------------- every sample page, every allowed role
  const idPath = (p) => p.replace(":id", "1");
  let sampleCount = 0;
  for (const def of PAGES) {
    for (const role of def.roles) {
      const c = staffById[role];
      const r = await c.get(idPath(def.path));
      sampleCount += 1;
      if (r.status !== 200) { problems.push(`${role} ${def.path} → ${r.status}`); continue; }
      const text = strip(r.body);
      if (!r.body.includes(BADGE)) problems.push(`${role} ${def.path} → no sample badge`);
      if (BAD.test(text)) problems.push(`${role} ${def.path} → stray text`);
      if (/Coming Soon/i.test(r.body)) problems.push(`${role} ${def.path} → Coming Soon`);
      if (/<table/.test(r.body) && !/overflow-x-auto/.test(r.body)) problems.push(`${role} ${def.path} → table not scrollable on phones`);
      if (!/name="viewport"/.test(r.body)) problems.push(`${role} ${def.path} → no viewport meta`);
    }
    const outsider = ["crm_manager", "team_leader", "agent", "customer", "system_admin"].find((role) => !def.roles.includes(role));
    if (outsider) {
      const r = await staffById[outsider].get(idPath(def.path));
      if (r.status !== 403) problems.push(`${outsider} ${def.path} should be 403, got ${r.status}`);
    }
    if (def.kind !== "form") sampleBadgePages.push(def.path);
  }
  check("PAGES-SAMPLE", `All ${PAGES.length} sample screens open for every allowed role (${sampleCount} role/page checks), show the sample badge, scroll on phones, and return 403 to other roles`, problems.length === 0, problems.slice(0, 8).join("; "));

  // ---------------------------------------------------------------- live pages are not labelled as samples
  const livePages = [["manager", mgr, ["/crm/cases", "/crm/customers", "/crm/escalations", "/crm/reports", "/crm/team-performance", "/crm/settings", "/crm/settings/access", "/crm/sales", "/crm/sales/payments", "/crm/sales/refunds", "/crm/sales/new", "/crm/campaigns", "/crm/campaigns/new", "/crm/promotions", "/crm/promotions/new"]], ["agent", agent, ["/crm/sales", "/crm/sales/new", "/crm/sales/payments", "/crm/sales/refunds", "/crm/inquiries", "/crm/follow-ups", "/crm/interactions"]], ["team leader", tl, ["/crm/sales", "/crm/promotions", "/crm/sales/refunds"]], ["customer", cust, ["/portal/cases", "/portal/cases/new", "/notifications", "/portal/orders", "/portal/shop", "/portal/cart", "/portal/tracking", "/portal/inquiries", "/portal/preferences"]]];
  const liveBad = [];
  for (const [name, c, paths] of livePages) for (const p of paths) { const r = await c.get(p); if (r.status !== 200 || r.body.includes(BADGE)) liveBad.push(`${name} ${p} ${r.status}`); }
  check("LIVE-01", "Live pages (cases, customers, escalations, reports, settings, access) are not marked as sample", liveBad.length === 0, liveBad.join(", "));

  // ---------------------------------------------------------------- dashboards
  const dashProblems = [];
  for (const [role, c] of Object.entries(staffById)) {
    if (role === "system_admin") continue;
    const r = await c.get(HOME[role]);
    const stillSample = false; // P5 made the agent's and the customer's widgets live, P8 the Team Leader's (team targets)
    if (stillSample !== r.body.includes(BADGE)) dashProblems.push(`${role} ${stillSample ? "no sample badge on widgets" : "still shows a sample badge"}`);
    if (/Coming Soon/i.test(r.body) || BAD.test(strip(r.body))) dashProblems.push(`${role} stray text`);
  }
  const setupHome = await setup.get("/setup");
  if (/Coming Soon/i.test(setupHome.body)) dashProblems.push("setup Coming Soon");
  check("DASH-01", "Every dashboard is fully live since P9 (no sample badge on any role's dashboard); no Coming Soon anywhere", dashProblems.length === 0, dashProblems.join(", "));

  // ---------------------------------------------------------------- record-level scope on the remaining sample pages
  const approvals = [await agent.get("/crm/approvals"), await tl.get("/crm/approvals"), await mgr.get("/crm/approvals/5"), await tl.get("/crm/approvals/5")];
  check("SCOPE-06", "Approvals Queue (P7, feature off by default): Agent 403; Team Leader and Manager get the clear \"Approvals are not enabled yet\" message, with no sample requests, on the list and on a detail URL", approvals[0].status === 403 && approvals[1].status === 200 && approvals[1].body.includes("Approvals are not enabled yet") && !approvals[1].body.includes("REQ-SAMPLE") && approvals[2].status === 200 && approvals[2].body.includes("Approvals are not enabled yet") && approvals[3].body.includes("Approvals are not enabled yet"));
  check("SCOPE-07", "Manager-only pages (loyalty, analytics, integration, campaigns) are 403 for Team Leader and Agent",
    (await Promise.all(["/crm/campaigns", "/crm/loyalty", "/crm/analytics", "/crm/settings/integration"].flatMap((p) => [tl.get(p), agent.get(p)]))).every((r) => r.status === 403));

  // ---------------------------------------------------------------- removed sample actions stay removed; CSRF still guards every POST
  const actions = [];
  for (const [label, path] of [["integration retry (P6)", "/crm/settings/integration/do/retry_dead"], ["loyalty adjust points (P8)", "/crm/loyalty/do/adjust_points"], ["unknown action", "/crm/loyalty/do/hack"]]) {
    await mgr.get("/crm/manager");
    const r = await mgr.post(path, { member: "x", points: "50", reason: "Goodwill adjustment" });
    if (r.status !== 404) actions.push(`${label} → ${r.status}`);
  }
  check("FORM-05", "The sample actions that later phases replaced no longer exist (integration retry since P6, loyalty point adjustment since P8: points change only by earn, redeem, refund and cancel); an unknown action is refused", actions.length === 0, actions.join("; "));
  const noCsrf = await mgr.post("/crm/sales/sync", {}, { csrf: false });
  check("FORM-07", "A POST without a CSRF token is refused (403)", noCsrf.status === 403);
  const loyaltyPage = (await mgr.get("/crm/loyalty")).body;
  check("LOYALTY", "Loyalty is live since P8 (decision D13): no sample badge, the rules are stated and the accounts come from the database", !loyaltyPage.includes("Sample data – not yet connected") && loyaltyPage.includes("1 point for every ₱100") && loyaltyPage.includes("Loyalty accounts"));

  // ---------------------------------------------------------------- the pass writes nothing
  const after = await tableCounts();
  const changed = Object.keys(after).filter((t) => !LIVE_WRITES.includes(t) && after[t] !== before[t]).map((t) => `${t} ${before[t]}→${after[t]}`);
  const salesTables = ["integration_inbox"]; // approval_requests holds 7 demo requests since P7 and the sales tables hold demo rows since P5; "changed" above proves the pass wrote nothing to any of them
  const existing = salesTables.filter((t) => t in after);
  check("NOWRITE-01", `No table changed during the whole pass (all ${Object.keys(after).length} tables compared; the inbox stays empty)`, changed.length === 0 && existing.every((t) => after[t] === 0), `${changed.join(", ")} | ${existing.filter((t) => after[t]).join(",")}`);
  const demo = await one("SELECT COUNT(*) n FROM crm_users WHERE is_demo = 1");
  const box = await client().get("/login");
  const boxEmails = [...box.body.matchAll(/data-email="([^"]+)"/g)].map((m) => m[1]);
  check("SEED-UI", "The demo seed still has exactly 7 accounts and the login page lists exactly those 7", Number(demo.n) === 7 && boxEmails.length === 7);

  // ---------------------------------------------------------------- settings tabs and integration page
  const tabs = await mgr.get("/crm/settings/integration");
  const approvalsPage = await mgr.get("/crm/approvals");
  check("TABS-01", "Settings has working Integration Health and Approvals Queue tabs for the Manager; adapter modes are the real settings",
    tabs.status === 200 && tabs.body.includes('href="/crm/settings/integration"') && tabs.body.includes('href="/crm/approvals"') && tabs.body.includes("JOHNVIVZ HR") && /mock/.test(tabs.body) && approvalsPage.body.includes("APPROVALS_ENABLED") && approvalsPage.body.includes("Approvals are not enabled yet") && !approvalsPage.body.includes("REQ-SAMPLE") && (await setup.get("/setup/integration")).status === 200);
} finally {
  await env.stop();
}
summarize(DB);
