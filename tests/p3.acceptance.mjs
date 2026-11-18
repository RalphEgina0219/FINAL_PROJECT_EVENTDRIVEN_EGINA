/*
 * JOHNVIVZ CRM — Phase P3 (customer master) acceptance tests.
 *   npm run test:p3        (npm test runs it after P1, P2, the UI pass and the status suite)
 * Throwaway database johnvivz_crm_p3_test; people beyond the 7 demo accounts come from tests/support/p1Fixtures.mjs.
 * Covers: walk-in creation and the duplicate check (TC-07), masking (TC-08), record scope on every new page and
 * action, contacts, addresses, preferences and marketing consent, interactions, agent-customer assignment, audit
 * entries, the demo seed, and the removal of the P3 sample pages.
 */
import { check, startEnvironment, summarize } from "./support/harness.mjs";
import { PAGES } from "./support/noSamples.mjs";

const DB = process.env.TEST_P3_DB_NAME || "johnvivz_crm_p3_test";
const PORT = Number(process.env.TEST_P3_PORT || 3197);
const env = await startEnvironment({ dbName: DB, port: PORT });
console.log(`\nJOHNVIVZ CRM P3 tests — database ${DB}\n`);
check("ENV-01", "Migrations (101–114), demo seed and fixtures load; server starts", env.steps.migrate.status === 0 && env.steps.seed.status === 0 && env.steps.fixtures.status === 0 && env.up,
  env.steps.migrate.stderr || env.steps.seed.stderr || env.steps.fixtures.stderr || env.serverLog());

const { all, one, db, as, fix } = env;
const decode = (s) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const alerts = (html) => [...html.matchAll(/role="(?:alert|status)">.*?<span>([^<]*)<\/span>/gs)].map((m) => decode(m[1]));
const errorList = (html) => [...(html.match(/role="alert"><ul[^>]*>([\s\S]*?)<\/ul>/) || [, ""])[1].matchAll(/<li>([^<]*)<\/li>/g)].map((m) => decode(m[1]));
const flashAfter = async (client, path) => alerts((await client.get(path)).body).join(" | ");
const auditCount = async (action, extra = "", params = []) => Number((await one(`SELECT COUNT(*) n FROM crm_audit_logs WHERE action = ? ${extra}`, [action, ...params])).n);
const countCustomers = async () => Number((await one("SELECT COUNT(*) n FROM customers")).n);
const ymdhm = (date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date).replace(" ", "T");

try {
  const u = async (email) => one("SELECT id, team_id FROM crm_users WHERE email = ?", [email]);
  const kristine = await u("kristine.bautista@johnvivz.test");
  const ramon = await u("ramon.aquino@johnvivz.test");
  const maria = await u("maria.santos@johnvivz.test");
  const patricia = await u("patricia.lim@johnvivz.test");
  const juan = await one("SELECT id, customer_no FROM customers WHERE email = 'juan.cruz@johnvivz.test'");
  const ernesto = await one("SELECT id FROM customers WHERE first_name = 'Ernesto'");
  const fixtureCustomer = await one("SELECT id FROM customers WHERE email = 'fixture.customer@example.test'");
  const agent = await as("kristine.bautista@johnvivz.test");
  const ramonC = await as("ramon.aquino@johnvivz.test");
  const tl = await as("maria.santos@johnvivz.test");
  const joseph = await as("joseph.villanueva@johnvivz.test");
  const mgr = await as("manager@johnvivz.test");
  const juanC = await as("juan.cruz@johnvivz.test");

  // ================================================================ seed and permissions
  const demoUsers = await one("SELECT COUNT(*) n FROM crm_users WHERE is_demo = 1");
  const demoInteractions = await one("SELECT COUNT(*) n, COUNT(DISTINCT customer_id) c FROM customer_interactions WHERE is_demo = 1");
  const ernestoAssigned = await one("SELECT COUNT(*) n FROM agent_assignments WHERE customer_id = ? AND agent_id = ? AND ended_at IS NULL", [ernesto.id, kristine.id]);
  check("SEED-3", "Demo seed: still exactly 7 login accounts; demo interactions, assignments, preferences and a marketing consent exist",
    Number(demoUsers.n) === 7 && Number(demoInteractions.n) >= 10 && Number(demoInteractions.c) >= 4 && Number(ernestoAssigned.n) === 1 &&
    Number((await one("SELECT COUNT(*) n FROM customer_preferences")).n) >= 6 && Number((await one("SELECT COUNT(*) n FROM customer_consents WHERE consent_type = 'marketing_sms'")).n) === 1,
    JSON.stringify({ demoUsers, demoInteractions, ernestoAssigned }));
  const perms = await all("SELECT p.code, GROUP_CONCAT(r.code ORDER BY r.code) roles FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id JOIN roles r ON r.id = rp.role_id WHERE p.code IN ('customers.create','customers.edit','customers.assign_agent','interactions.log','interactions.view','preferences.manage_own') GROUP BY p.code");
  const permMap = Object.fromEntries(perms.map((p) => [p.code, p.roles]));
  check("PERM-1", "Migration 114 added the six permissions to the right roles (assignment: Team Leader and Manager only; preferences: customer only)",
    permMap["customers.create"] === "agent,crm_manager,team_leader" && permMap["customers.edit"] === "agent,crm_manager,team_leader" && permMap["customers.assign_agent"] === "crm_manager,team_leader" &&
    permMap["interactions.log"] === "agent,crm_manager,team_leader" && permMap["interactions.view"] === "agent,crm_manager,team_leader" && permMap["preferences.manage_own"] === "customer", JSON.stringify(permMap));

  // ================================================================ TC-07 duplicate check
  const before = await countCustomers();
  await agent.get("/crm/customers/new");
  const dupMobile = await agent.post("/crm/customers/new", { first_name: "Jun", last_name: "Cruz", mobile: "+63 917-555-0101", source: "walk_in", consent: "1", consent_channel: "in_store" });
  const warn = decode(dupMobile.body);
  check("TC-07", "Duplicate mobile (typed in another format): warning lists the match with masked data; nothing saved; the warning is audited",
    dupMobile.status === 409 && warn.includes('id="duplicate-warning"') && warn.includes(juan.customer_no) && warn.includes("Same mobile number") && !warn.includes("juan.cruz@johnvivz.test") &&
    warn.includes("0917 *** 0101") && (await countCustomers()) === before && (await auditCount("customer_duplicate_warning")) === 1, `${dupMobile.status}`);
  const dupEmail = await agent.post("/crm/customers/new", { first_name: "Someone", last_name: "Else", email: "  JUAN.CRUZ@johnvivz.test ", source: "phone", consent: "1", consent_channel: "phone" });
  check("DUP-2", "Duplicate email (different case and spaces) is found", dupEmail.status === 409 && decode(dupEmail.body).includes("Same email") && (await countCustomers()) === before);
  const dupName = await agent.post("/crm/customers/new", { first_name: "juan", last_name: "CRUZ", mobile: "0927 555 0101", source: "walk_in", consent: "1", consent_channel: "in_store" });
  check("DUP-3", "Same name plus a similar mobile number (different prefix) is found", dupName.status === 409 && decode(dupName.body).includes("Same name and similar mobile number"));
  const shortReason = await agent.post("/crm/customers/new", { first_name: "Jun", last_name: "Cruz", mobile: "0917 555 0101", source: "walk_in", consent: "1", consent_channel: "in_store", override_reason: "no" });
  check("DUP-4", "Confirming with a too-short reason is refused (nothing saved)", shortReason.status === 409 && (await countCustomers()) === before && errorList(shortReason.body).some((e) => /reason/i.test(e)), errorList(shortReason.body).join("|"));
  const override = await agent.post("/crm/customers/new", { first_name: "Jun", last_name: "Cruz", mobile: "0917 555 0101", source: "walk_in", consent: "1", consent_channel: "in_store", override_reason: "Juan's brother; they share one phone" });
  const overridden = await one("SELECT id, customer_no FROM customers WHERE first_name = 'Jun' AND last_name = 'Cruz'");
  const ovAudit = await one("SELECT reason, details FROM crm_audit_logs WHERE action = 'customer_duplicate_override' ORDER BY id DESC LIMIT 1");
  check("DUP-5", "Confirming with a reason creates the customer; the override, the reason and the matched customer are in the audit log",
    override.status === 302 && overridden && ovAudit?.reason === "Juan's brother; they share one phone" && ovAudit.details.includes(juan.customer_no), `${override.status} ${JSON.stringify(ovAudit)}`);

  // a customer nobody in the agent's scope owns: the warning still appears but offers no link
  await mgr.get("/crm/customers/new");
  const hidden = await mgr.post("/crm/customers/new", { first_name: "Hidden", last_name: "Person", mobile: "0917 777 1234", source: "phone", consent: "1", consent_channel: "phone" });
  const hiddenRow = await one("SELECT id, customer_no FROM customers WHERE last_name = 'Person'");
  const dupHidden = await agent.post("/crm/customers/new", { first_name: "Hh", last_name: "Pp", mobile: "09177771234", source: "phone", consent: "1", consent_channel: "phone" });
  check("DUP-6", "A match outside the agent's scope is shown masked without a link (\"not in your scope\"), and its page stays closed (404)",
    hidden.status === 302 && dupHidden.status === 409 && decode(dupHidden.body).includes("not in your scope") && !decode(dupHidden.body).includes(`/crm/customers/${hiddenRow.id}"`) && (await agent.get(`/crm/customers/${hiddenRow.id}`)).status === 404);

  // ================================================================ create (happy path, validation, roles)
  const created = await agent.post("/crm/customers/new", {
    first_name: "Test", last_name: "Walkin", mobile: "0917 555 0199", email: "test.walkin@example.test", source: "walk_in", consent: "1", consent_channel: "in_store",
    address_line1: "12 Rizal Street", barangay: "Sta. Isabel", city_municipality: "Calapan City", province: "Oriental Mindoro", customer_type: "individual",
  });
  const walkin = await one("SELECT * FROM customers WHERE last_name = 'Walkin'");
  const walkContacts = walkin ? await all("SELECT contact_type, value, is_primary FROM customer_contacts WHERE customer_id = ? ORDER BY contact_type", [walkin.id]) : [];
  const walkAddr = walkin ? await one("SELECT line1, barangay, city_municipality, is_default FROM customer_addresses WHERE customer_id = ?", [walkin.id]) : null;
  const walkConsent = walkin ? await all("SELECT consent_type, channel, recorded_by, granted FROM customer_consents WHERE customer_id = ?", [walkin.id]) : [];
  const walkAssign = walkin ? await one("SELECT agent_id, assigned_by FROM agent_assignments WHERE customer_id = ? AND ended_at IS NULL", [walkin.id]) : null;
  check("NEW-1", "Agent creates a walk-in: CUS number and UUID, normalized mobile/email, primary contacts, default address, privacy consent (in store, by the agent), assigned to the agent",
    created.status === 302 && walkin && /^CUS-\d{6}$/.test(walkin.customer_no) && /^[0-9a-f-]{36}$/.test(walkin.customer_id) && walkin.normalized_mobile === "09175550199" && walkin.normalized_email === "test.walkin@example.test" &&
    walkin.source === "walk_in" && walkin.created_by === kristine.id && walkContacts.length === 2 && walkContacts.every((c) => c.is_primary === 1) && walkAddr?.is_default === 1 && walkAddr.line1 === "12 Rizal Street" &&
    walkConsent.length === 1 && walkConsent[0].consent_type === "data_privacy" && walkConsent[0].channel === "in_store" && walkConsent[0].recorded_by === kristine.id &&
    walkAssign?.agent_id === kristine.id && (await auditCount("customer_created")) >= 1, JSON.stringify({ walkin: walkin?.customer_no, walkContacts, walkConsent, walkAssign }));
  check("NEW-2", "The agent can open the customer she just created; another team's agent (Ramon) and the other team's Team Leader (Joseph) cannot (404)",
    (await agent.get(`/crm/customers/${walkin.id}`)).status === 200 && (await ramonC.get(`/crm/customers/${walkin.id}`)).status === 404 && (await joseph.get(`/crm/customers/${walkin.id}`)).status === 404);

  const n0 = await countCustomers();
  const invalid = [
    ["no consent", { first_name: "Aa", last_name: "Bb", mobile: "0917 111 2222", source: "walk_in", consent_channel: "in_store" }, /Data Privacy/],
    ["no contact", { first_name: "Aa", last_name: "Bb", source: "walk_in", consent: "1", consent_channel: "in_store" }, /mobile number or an email/],
    ["bad mobile", { first_name: "Aa", last_name: "Bb", mobile: "12345", source: "walk_in", consent: "1", consent_channel: "in_store" }, /Philippine mobile/],
    ["bad email", { first_name: "Aa", last_name: "Bb", email: "not-an-email", source: "walk_in", consent: "1", consent_channel: "in_store" }, /valid email/],
    ["bad source", { first_name: "Aa", last_name: "Bb", mobile: "0917 111 2222", source: "hacker", consent: "1", consent_channel: "in_store" }, /reached us/],
    ["short name", { first_name: "A", last_name: "B", mobile: "0917 111 2222", source: "walk_in", consent: "1", consent_channel: "in_store" }, /first name/],
  ];
  const invalidProblems = [];
  for (const [name, data, expected] of invalid) {
    const r = await agent.post("/crm/customers/new", data);
    if (r.status !== 422 || !errorList(r.body).some((e) => expected.test(e))) invalidProblems.push(`${name}: ${r.status} ${errorList(r.body).join("|")}`);
  }
  check("NEW-3", "Invalid forms are refused with a message and nothing is saved (no consent, no contact, bad mobile, bad email, bad source, short name)", invalidProblems.length === 0 && (await countCustomers()) === n0, invalidProblems.join("; "));

  // Team Leader: may pick an agent of her own team, not another team's
  await tl.get("/crm/customers/new");
  const tlOwn = await tl.post("/crm/customers/new", { first_name: "Leader", last_name: "Made", mobile: "0918 222 3333", source: "phone", consent: "1", consent_channel: "phone", agent_id: String(kristine.id) });
  const tlMade = await one("SELECT id FROM customers WHERE last_name = 'Made'");
  const tlAssigned = tlMade ? await one("SELECT agent_id FROM agent_assignments WHERE customer_id = ? AND ended_at IS NULL", [tlMade.id]) : null;
  const tlOther = await tl.post("/crm/customers/new", { first_name: "Leader", last_name: "Other", mobile: "0918 222 4444", source: "phone", consent: "1", consent_channel: "phone", agent_id: String(patricia.id) });
  await juanC.get("/portal");
  const customerCreate = await juanC.post("/crm/customers/new", { first_name: "Hack", last_name: "Er", mobile: "0917 999 8888", source: "walk_in", consent: "1", consent_channel: "in_store" });
  check("NEW-4", "Team Leader can create and assign to her own team's agent; another team's agent is refused (403, audited); a customer account cannot create customers (403)",
    tlOwn.status === 302 && tlAssigned?.agent_id === kristine.id && tlOther.status === 403 && (await auditCount("access_denied", "AND details LIKE 'create:%'")) >= 1 && customerCreate.status === 403 &&
    !(await one("SELECT id FROM customers WHERE last_name IN ('Other','Er')")), JSON.stringify({ own: [tlOwn.status, tlAssigned], other: tlOther.status, cust: customerCreate.status, errs: errorList(tlOwn.body) }));

  // ================================================================ scope and masking (TC-02 style, TC-08)
  const juanFromRamon = await ramonC.get(`/crm/customers/${juan.id}`);
  const juanFromJoseph = await joseph.get(`/crm/customers/${juan.id}`);
  const fixFromJoseph = await joseph.get(`/crm/customers/${fixtureCustomer.id}`);
  check("SCOPE-1", "Record scope on the customer page: Kristine and Maria see Juan; another team's agent and Team Leader get 404; the other team's Team Leader sees the customer that has a case in her team",
    (await agent.get(`/crm/customers/${juan.id}`)).status === 200 && (await tl.get(`/crm/customers/${juan.id}`)).status === 200 && juanFromRamon.status === 404 && juanFromJoseph.status === 404 && fixFromJoseph.status === 200);
  const forged = [
    await ramonC.post(`/crm/customers/${juan.id}/contacts`, { contact_type: "mobile", value: "0917 123 4567" }),
    await ramonC.post(`/crm/customers/${juan.id}/profile`, { first_name: "X", last_name: "Y", customer_type: "individual", status: "active" }),
    await ramonC.post(`/crm/customers/${juan.id}/addresses`, { line1: "Somewhere 123" }),
    await ramonC.post(`/crm/customers/${juan.id}/preferences`, { preferred_channel: "sms", consent_channel: "phone" }),
    await joseph.post(`/crm/customers/${juan.id}/contacts`, { contact_type: "mobile", value: "0917 123 4567" }),
  ];
  const juanAfter = await one("SELECT first_name, mobile FROM customers WHERE id = ?", [juan.id]);
  check("SCOPE-2", "Forged POSTs on a customer outside the scope (contact, profile, address, preferences) get 404 and change nothing",
    forged.every((r) => r.status === 404) && juanAfter.first_name === "Juan" && juanAfter.mobile === "0917 555 0101", forged.map((r) => r.status).join(","));
  const agentAssign = await agent.post(`/crm/customers/${juan.id}/assign`, { agent_id: String(kristine.id) });
  const custForged = await juanC.post(`/crm/customers/${juan.id}/contacts`, { contact_type: "mobile", value: "0917 123 4567" });
  check("SCOPE-3", "An agent cannot assign customers (403, audited) and a customer account cannot call staff customer actions (403)",
    agentAssign.status === 403 && custForged.status === 403 && (await auditCount("access_denied", "AND actor_role = 'agent'")) >= 1);

  const list = (await agent.get("/crm/customers")).body;
  const detail = (await agent.get(`/crm/customers/${juan.id}`)).body;
  check("TC-08", "Directory list masks email and mobile; the detail page shows them in full and the view is audited (customer_viewed)",
    list.includes("j***@johnvivz.test") && list.includes("0917 *** 0101") && !list.includes("juan.cruz@johnvivz.test") && detail.includes("juan.cruz@johnvivz.test") && detail.includes("0917 555 0101") && (await auditCount("customer_viewed")) >= 1);
  const directory = {
    agent: (await agent.get("/crm/customers?q=Walkin")).body.includes("Test Walkin"),
    ramon: !(await ramonC.get("/crm/customers?q=Walkin")).body.includes("Test Walkin"),
    mgr: (await mgr.get("/crm/customers?q=Walkin")).body.includes("Test Walkin"),
  };
  check("SCOPE-4", "Directory lists follow the scope (agent sees her walk-in, Ramon does not, the Manager sees all)", directory.agent && directory.ramon && directory.mgr, JSON.stringify(directory));

  // ================================================================ contacts
  const cid = walkin.id;
  const page = (c) => c.get(`/crm/customers/${cid}`);
  await page(agent);
  await agent.post(`/crm/customers/${cid}/contacts`, { contact_type: "mobile", value: "0929 444 5555" });
  await agent.post(`/crm/customers/${cid}/contacts`, { contact_type: "landline", value: "(043) 288 1234" });
  const badMobile = await agent.post(`/crm/customers/${cid}/contacts`, { contact_type: "mobile", value: "123" });
  const badMobileMsg = await flashAfter(agent, `/crm/customers/${cid}`);
  const sameContact = await agent.post(`/crm/customers/${cid}/contacts`, { contact_type: "mobile", value: "09294445555" });
  const sameMsg = await flashAfter(agent, `/crm/customers/${cid}`);
  const contacts1 = await all("SELECT id, contact_type, value, is_primary FROM customer_contacts WHERE customer_id = ? ORDER BY id", [cid]);
  check("CON-1", "Add contacts: a second mobile and a landline are saved as non-primary; a bad mobile and a repeated contact are refused with a message",
    contacts1.length === 4 && contacts1[2].is_primary === 0 && contacts1[2].value === "09294445555" && contacts1[3].contact_type === "landline" && badMobile.status === 302 && /Philippine mobile/.test(badMobileMsg) && /already has that contact/.test(sameMsg), JSON.stringify(contacts1));
  const secondMobile = contacts1[2];
  await agent.post(`/crm/customers/${cid}/contacts/${secondMobile.id}/primary`, {});
  const afterPrimary = await one("SELECT mobile, normalized_mobile FROM customers WHERE id = ?", [cid]);
  const primaries = await all("SELECT id FROM customer_contacts WHERE customer_id = ? AND contact_type = 'mobile' AND is_primary = 1", [cid]);
  check("CON-2", "Make primary: customers.mobile / normalized_mobile follow the new primary and the old one is demoted (exactly one primary mobile)",
    afterPrimary.mobile === "09294445555" && afterPrimary.normalized_mobile === "09294445555" && primaries.length === 1 && primaries[0].id === secondMobile.id && (await auditCount("customer_contact_primary_changed")) >= 1);
  await agent.post(`/crm/customers/${cid}/contacts`, { contact_type: "mobile", value: "0918 555 0102", make_primary: "1" });
  const taken = await flashAfter(agent, `/crm/customers/${cid}`);
  const stillSame = await one("SELECT mobile FROM customers WHERE id = ?", [cid]);
  await agent.post(`/crm/customers/${cid}/contacts`, { contact_type: "mobile", value: "0918 555 0102", make_primary: "1", override_reason: "ab" });
  const overrideCount = await auditCount("customer_duplicate_override");
  const neighbour = await one("SELECT customer_no FROM customers WHERE normalized_mobile = '09185550102'");
  await agent.post(`/crm/customers/${cid}/contacts`, { contact_type: "mobile", value: "0918 555 0102", make_primary: "1", override_reason: "Shared family phone, confirmed with the customer" });
  const moved = await one("SELECT mobile FROM customers WHERE id = ?", [cid]);
  check("CON-3", "A new primary mobile that belongs to another customer is refused (message lists the owner) until a reason is given; then it is saved and audited",
    /already belongs to/.test(taken) && stillSame.mobile === "09294445555" && moved.mobile === "09185550102" && (await auditCount("customer_duplicate_override")) === overrideCount + 1 && Boolean(neighbour), `${taken} / ${JSON.stringify(moved)}`);
  const primaryContact = (await all("SELECT id FROM customer_contacts WHERE customer_id = ? AND contact_type = 'mobile' AND is_primary = 1", [cid]))[0];
  await agent.post(`/crm/customers/${cid}/contacts/${primaryContact.id}/delete`, {});
  const noRemove = await flashAfter(agent, `/crm/customers/${cid}`);
  await agent.post(`/crm/customers/${cid}/contacts`, { contact_type: "landline", value: "(043) 288 9999" }); // the first landline is primary; this one is secondary
  const landline = await one("SELECT id, is_primary FROM customer_contacts WHERE customer_id = ? AND value = ?", [cid, "(043) 288 9999"]);
  await agent.post(`/crm/customers/${cid}/contacts/${landline.id}/delete`, {});
  check("CON-4", "A primary contact cannot be removed; a secondary one can", /primary contact cannot be removed/.test(noRemove) && !(await one("SELECT id FROM customer_contacts WHERE id = ?", [landline.id])) && Boolean(await one("SELECT id FROM customer_contacts WHERE id = ?", [primaryContact.id])), JSON.stringify({ noRemove, landline, landlineGone: !(await one("SELECT id FROM customer_contacts WHERE id = ?", [landline.id])), primaryContact }));
  const juanEmailBefore = await one("SELECT email FROM customers WHERE id = ?", [juan.id]);
  await agent.post(`/crm/customers/${juan.id}/contacts`, { contact_type: "email", value: "juan.second@example.test", make_primary: "1" });
  const portalMsg = await flashAfter(agent, `/crm/customers/${juan.id}`);
  const juanEmailAfter = await one("SELECT email FROM customers WHERE id = ?", [juan.id]);
  check("CON-5", "A customer with a portal login: staff cannot replace the primary email (the customer changes it in their account)", /signs in with their primary email/.test(portalMsg) && juanEmailAfter.email === juanEmailBefore.email && !(await one("SELECT id FROM customer_contacts WHERE value = 'juan.second@example.test'")));

  // ================================================================ addresses
  await agent.post(`/crm/customers/${cid}/addresses`, { label: "Work", line1: "Gov. Infantado St", city_municipality: "Calapan City", postal_code: "5200", is_default: "1" });
  const addrs = await all("SELECT id, label, is_default FROM customer_addresses WHERE customer_id = ? ORDER BY id", [cid]);
  const badPostal = await agent.post(`/crm/customers/${cid}/addresses`, { line1: "Another street 5", postal_code: "52" });
  const postalMsg = await flashAfter(agent, `/crm/customers/${cid}`);
  const shortLine = await agent.post(`/crm/customers/${cid}/addresses`, { line1: "ab" });
  await agent.post(`/crm/customers/${cid}/addresses/${addrs[0].id}`, { label: "Home", line1: "14 Rizal Street", city_municipality: "Calapan City" });
  await agent.post(`/crm/customers/${cid}/addresses/${addrs[0].id}/default`, {});
  const afterDefault = await all("SELECT id, is_default, line1 FROM customer_addresses WHERE customer_id = ? ORDER BY id", [cid]);
  await agent.post(`/crm/customers/${cid}/addresses/${addrs[0].id}/delete`, {});
  const afterDelete = await all("SELECT id, is_default FROM customer_addresses WHERE customer_id = ?", [cid]);
  check("ADR-1", "Addresses: a new default demotes the old one; edit, make default and delete work; deleting the default promotes the remaining address; a bad postal code and a too-short line are refused",
    addrs.length === 2 && addrs[1].is_default === 1 && addrs[0].is_default === 0 && /4 digits/.test(postalMsg) && shortLine.status === 302 && afterDefault.length === 2 &&
    afterDefault[0].line1 === "14 Rizal Street" && afterDefault[0].is_default === 1 && afterDefault[1].is_default === 0 && afterDelete.length === 1 && afterDelete[0].is_default === 1 && afterDelete[0].id === addrs[1].id,
    JSON.stringify({ addrs, afterDefault, afterDelete }));

  // ================================================================ profile
  await agent.post(`/crm/customers/${cid}/profile`, { first_name: "Testy", last_name: "Walkin-Reyes", customer_type: "business", status: "active", notes: "Buys for a small canteen." });
  const prof = await one("SELECT first_name, last_name, customer_type, notes FROM customers WHERE id = ?", [cid]);
  const profAudit = await one("SELECT before_values, after_values FROM crm_audit_logs WHERE action = 'customer_updated' ORDER BY id DESC LIMIT 1");
  await agent.post(`/crm/customers/${cid}/profile`, { first_name: "T", last_name: "W", customer_type: "individual", status: "active" });
  const profBad = await one("SELECT first_name FROM customers WHERE id = ?", [cid]);
  await agent.post(`/crm/customers/${juan.id}/profile`, { first_name: "Juan Carlo", last_name: "Cruz", customer_type: "individual", status: "active" });
  const juanUser = await one("SELECT u.display_name FROM crm_users u JOIN customer_accounts ca ON ca.user_id = u.id WHERE ca.customer_id = ?", [juan.id]);
  await agent.post(`/crm/customers/${juan.id}/profile`, { first_name: "Juan", last_name: "Cruz", customer_type: "individual", status: "active" });
  check("PRO-1", "Profile edit saves name, type and staff notes and audits before/after; a too-short name is refused; a portal customer's login display name follows",
    prof.first_name === "Testy" && prof.customer_type === "business" && prof.notes === "Buys for a small canteen." && JSON.stringify(profAudit.before_values).includes("Test") && JSON.stringify(profAudit.after_values).includes("business") &&
    profBad.first_name === "Testy" && juanUser.display_name === "Juan Carlo Cruz");

  // ================================================================ preferences and consent
  await agent.post(`/crm/customers/${cid}/preferences`, { preferred_channel: "sms", preferred_language: "filipino", preferred_branch: "Calapan", marketing_sms: "1", consent_channel: "in_store" });
  const prefs = Object.fromEntries((await all("SELECT preference_key k, preference_value v FROM customer_preferences WHERE customer_id = ?", [cid])).map((r) => [r.k, r.v]));
  const mk1 = await all("SELECT consent_type, granted, channel, recorded_by FROM customer_consents WHERE customer_id = ? AND consent_type LIKE 'marketing%'", [cid]);
  await agent.post(`/crm/customers/${cid}/preferences`, { preferred_channel: "sms", preferred_language: "filipino", marketing_sms: "1", consent_channel: "in_store" });
  const mk2 = await all("SELECT id FROM customer_consents WHERE customer_id = ? AND consent_type LIKE 'marketing%'", [cid]);
  const prefsAfter = Object.fromEntries((await all("SELECT preference_key k, preference_value v FROM customer_preferences WHERE customer_id = ?", [cid])).map((r) => [r.k, r.v]));
  await agent.post(`/crm/customers/${cid}/preferences`, { preferred_channel: "sms", consent_channel: "phone" });
  const mk3 = await all("SELECT granted, channel, withdrawn_at FROM customer_consents WHERE customer_id = ? AND consent_type = 'marketing_sms' ORDER BY id", [cid]);
  const prefAudit = await auditCount("customer_preferences_updated");
  check("PRF-1", "Staff save preferences and marketing consent: values stored; consent is a history (granted row, no new row when unchanged, a withdrawn row with the channel); removed preferences are deleted; audited",
    prefs.preferred_channel === "sms" && prefs.preferred_language === "filipino" && prefs.preferred_branch === "Calapan" && mk1.length === 1 && mk1[0].granted === 1 && mk1[0].channel === "in_store" && mk1[0].recorded_by === kristine.id &&
    mk2.length === 1 && !prefsAfter.preferred_branch && mk3.length === 2 && mk3[1].granted === 0 && mk3[1].channel === "phone" && mk3[1].withdrawn_at && prefAudit >= 3, JSON.stringify({ prefs, mk1, mk3 }));
  await agent.post(`/crm/customers/${cid}/preferences`, { preferred_channel: "pigeon", consent_channel: "in_store" });
  const badPref = await flashAfter(agent, `/crm/customers/${cid}`);
  await agent.post(`/crm/customers/${cid}/preferences`, { preferred_channel: "sms" });
  const noChannel = await flashAfter(agent, `/crm/customers/${cid}`);
  check("PRF-2", "An invalid preference option, or a missing consent channel, is refused", /choose one of the listed/.test(badPref) && /how the customer gave or withdrew consent/.test(noChannel), `${badPref} / ${noChannel}`);

  await juanC.get("/portal/preferences");
  const portalPage = await juanC.get("/portal/preferences");
  const juanPrefBefore = await all("SELECT consent_type FROM customer_consents WHERE customer_id = ? AND consent_type = 'marketing_email'", [juan.id]);
  const savedPortal = await juanC.post("/portal/preferences", { preferred_channel: "email", preferred_language: "english", preferred_contact_time: "evening", marketing_email: "1" });
  const portalConsent = await all("SELECT granted, channel, recorded_by FROM customer_consents WHERE customer_id = ? AND consent_type = 'marketing_email'", [juan.id]);
  const portalPref = await one("SELECT preference_value v FROM customer_preferences WHERE customer_id = ? AND preference_key = 'preferred_contact_time'", [juan.id]);
  const portalBad = await juanC.post("/portal/preferences", { preferred_channel: "pigeon" });
  const smsKept = await one("SELECT granted FROM customer_consents WHERE customer_id = ? AND consent_type = 'marketing_sms' ORDER BY id DESC LIMIT 1", [juan.id]);
  check("PRF-3", "Customer portal: the customer opens and saves their own preferences and marketing consent (channel portal); an invalid option is refused (422); an unchanged consent is not touched; the old sample page is gone",
    portalPage.status === 200 && !portalPage.body.includes("Sample data – not yet connected") && savedPortal.status === 302 && juanPrefBefore.length === 0 && portalConsent.length === 1 && portalConsent[0].channel === "portal" && portalConsent[0].granted === 1 &&
    portalPref?.v === "evening" && portalBad.status === 422 && smsKept.granted === 0, JSON.stringify({ portalConsent, smsKept }));
  const profileHtml = (await juanC.get("/portal")).body;
  const prefHtml = (await juanC.get("/portal/preferences")).body;
  check("PRF-5", "My Profile has a clear \"Preferences & consent\" card with a link to /portal/preferences (the menu is unchanged, supplement E), and the preferences page links back to My Profile",
    profileHtml.includes('id="preferences-card"') && profileHtml.includes('href="/portal/preferences"') && profileHtml.includes("Preferences &amp; consent") && prefHtml.includes('href="/portal"') && prefHtml.includes("Back to my profile") && !profileHtml.includes('<a href="/portal/preferences" class="flex'));
  const staffPortal = await agent.get("/portal/preferences");
  check("PRF-4", "Staff cannot open the customer's own preferences page (403); a customer's preferences change touches only their own record",
    staffPortal.status === 403 && (await one("SELECT COUNT(*) n FROM customer_preferences WHERE customer_id = ? AND preference_key = 'preferred_contact_time'", [cid])).n === 0);

  // ================================================================ interactions
  const caseOfJuan = await one("SELECT id, case_no FROM customer_cases WHERE customer_id = ? AND assigned_agent_id = ? ORDER BY id LIMIT 1", [juan.id, kristine.id]);
  const caseOfOther = await one("SELECT id, case_no FROM customer_cases WHERE customer_id <> ? AND assigned_agent_id = ? ORDER BY id LIMIT 1", [juan.id, kristine.id]);
  const yesterday = ymdhm(new Date(Date.now() - 26 * 3600 * 1000));
  const newPage = await agent.get(`/crm/interactions/new?customer_id=${juan.id}`);
  const logged = await agent.post("/crm/interactions", { customer_id: String(juan.id), type: "call", direction: "inbound", subject: "Asked about the replacement", summary: "Customer called to ask when the replacement arrives.", occurred_at: yesterday, case_no: caseOfJuan.case_no.toLowerCase() });
  const row = await one("SELECT * FROM customer_interactions WHERE subject = 'Asked about the replacement'");
  const stored = row ? await one("SELECT DATE_FORMAT(occurred_at, '%Y-%m-%dT%H:%i') t FROM customer_interactions WHERE id = ?", [row.id]) : null;
  check("INT-1", "Agent logs a call for her customer: saved with her as author, linked to the customer's case (case number accepted in lower case), the time kept as typed (Asia/Manila), audited",
    newPage.status === 200 && newPage.body.includes(`<option value="${juan.id}" selected>`) && logged.status === 302 && row && row.crm_user_id === kristine.id && row.related_type === "case" && row.related_id === caseOfJuan.id &&
    row.is_demo === 0 && stored.t === yesterday && (await auditCount("interaction_logged")) >= 1, `${logged.status} ${JSON.stringify(stored)} ${yesterday} ${errorList(logged.body).join("|")}`);
  const showRow = await agent.get(`/crm/interactions/${row.id}`);
  const listPage = (await agent.get("/crm/interactions")).body;
  const timelineHtml = (await agent.get(`/crm/customers/${juan.id}`)).body;
  check("INT-2", "The interaction shows on its own page, in the Interactions list and in the customer's timeline (with the case link)",
    showRow.status === 200 && showRow.body.includes("Asked about the replacement") && listPage.includes("Asked about the replacement") && timelineHtml.includes("Asked about the replacement") && timelineHtml.includes(caseOfJuan.case_no));
  const intBad = [];
  const tryLog = async (name, data, expected) => {
    const r = await agent.post("/crm/interactions", { customer_id: String(juan.id), type: "call", direction: "inbound", subject: "A valid subject", occurred_at: yesterday, ...data });
    if (r.status !== 422 || !errorList(r.body).some((e) => expected.test(e))) intBad.push(`${name}: ${r.status} ${errorList(r.body).join("|")}`);
  };
  const nInt = Number((await one("SELECT COUNT(*) n FROM customer_interactions")).n);
  await tryLog("short subject", { subject: "Hi" }, /subject/i);
  await tryLog("future", { occurred_at: ymdhm(new Date(Date.now() + 3 * 86400000)) }, /future/);
  await tryLog("bad date", { occurred_at: "yesterday" }, /valid date/);
  await tryLog("bad type", { type: "telepathy" }, /type of interaction/);
  await tryLog("bad direction", { direction: "sideways" }, /contacted whom/);
  await tryLog("other customer's case", { case_no: caseOfOther.case_no }, /not found for this customer/);
  await tryLog("no customer", { customer_id: "" }, /Choose the customer/);
  check("INT-3", "Invalid interactions are refused with a message (short subject, future time, bad date, bad type, bad direction, a case of another customer, no customer) and nothing is saved",
    intBad.length === 0 && Number((await one("SELECT COUNT(*) n FROM customer_interactions")).n) === nInt, intBad.join("; "));
  await agent.post("/crm/interactions", { customer_id: String(juan.id), type: "note", direction: "inbound", subject: "Internal reminder note", occurred_at: yesterday });
  const noteRow = await one("SELECT direction FROM customer_interactions WHERE subject = 'Internal reminder note'");
  const ramonLog = await ramonC.post("/crm/interactions", { customer_id: String(juan.id), type: "call", direction: "inbound", subject: "Should not be saved", occurred_at: yesterday });
  const ramonShow = await ramonC.get(`/crm/interactions/${row.id}`);
  const ramonList = (await ramonC.get("/crm/interactions")).body;
  const josephShow = await joseph.get(`/crm/interactions/${row.id}`);
  check("INT-4", "A note is always internal; Ramon (another team's agent) cannot log for, open or list Juan's interactions; the other team's Team Leader cannot open them either; staff pages are closed to customers",
    noteRow?.direction === "internal" && ramonLog.status === 404 && !(await one("SELECT id FROM customer_interactions WHERE subject = 'Should not be saved'")) && ramonShow.status === 404 && !ramonList.includes("Asked about the replacement") && josephShow.status === 404 &&
    (await juanC.get("/crm/interactions")).status === 403 && (await juanC.post("/crm/interactions", { customer_id: String(juan.id), type: "note", subject: "Forged note here" })).status === 403);
  const byType = (await agent.get("/crm/interactions?type=call")).body;
  const byQ = (await agent.get("/crm/interactions?q=replacement")).body;
  const mine = (await agent.get("/crm/interactions?mine=1")).body;
  const mgrMine = (await mgr.get("/crm/interactions?mine=1")).body;
  check("INT-5", "Interaction filters work: type, text search, \"logged by me\" (the Manager has logged none)",
    byType.includes("Asked about the replacement") && !byType.includes("Internal reminder note") && byQ.includes("Asked about the replacement") && !byQ.includes("Internal reminder note") && mine.includes("Internal reminder note") && !mgrMine.includes("Internal reminder note"));

  // ================================================================ agent-customer assignment
  const target = tlMade.id; // created by Maria with Kristine assigned; reassign it
  const asgBefore = await one("SELECT COUNT(*) n FROM agent_assignments WHERE customer_id = ?", [target]);
  await tl.get(`/crm/customers/${target}`);
  const same = await tl.post(`/crm/customers/${target}/assign`, { agent_id: String(kristine.id) });
  const sameMsg2 = await flashAfter(tl, `/crm/customers/${target}`);
  const ramonId = ramon.id;
  const reassign = await tl.post(`/crm/customers/${target}/assign`, { agent_id: String(ramonId), note: "Ramon takes over this customer" });
  const rows = await all("SELECT agent_id, ended_at, note FROM agent_assignments WHERE customer_id = ? ORDER BY id", [target]);
  const note = await one("SELECT COUNT(*) n FROM crm_notifications WHERE user_id = ? AND related_type = 'customer' AND related_id = ?", [ramonId, target]);
  check("ASG-1", "Team Leader reassigns a customer: the old assignment is ended, a new one with the note starts, the new agent is notified; assigning the same agent again is refused",
    same.status === 302 && /already assigned/.test(sameMsg2) && reassign.status === 302 && rows.length === Number(asgBefore.n) + 1 && rows.at(-2).ended_at && !rows.at(-1).ended_at && rows.at(-1).agent_id === ramonId && rows.at(-1).note === "Ramon takes over this customer" && Number(note.n) === 1 && (await auditCount("customer_assigned")) >= 1, JSON.stringify(rows));
  check("ASG-2", "After the reassignment Ramon can open the customer and Kristine can no longer (404)", (await ramonC.get(`/crm/customers/${target}`)).status === 200 && (await agent.get(`/crm/customers/${target}`)).status === 404);
  const otherTeam = await tl.post(`/crm/customers/${target}/assign`, { agent_id: String(patricia.id) });
  const mgrAssign = await mgr.post(`/crm/customers/${target}/assign`, { agent_id: String(patricia.id) });
  const jospehAfter = await joseph.get(`/crm/customers/${target}`);
  check("ASG-3", "A Team Leader cannot assign another team's agent (403, audited); the Manager can; the customer then belongs to the other team (its Team Leader sees it, Maria no longer does)",
    otherTeam.status === 403 && mgrAssign.status === 302 && jospehAfter.status === 200 && (await tl.get(`/crm/customers/${target}`)).status === 404 && (await auditCount("access_denied", "AND details LIKE 'assign:%'")) >= 1);
  await mgr.post(`/crm/customers/${target}/unassign`, {});
  const ended = await one("SELECT COUNT(*) n FROM agent_assignments WHERE customer_id = ? AND ended_at IS NULL", [target]);
  const noAgentMsg = (await mgr.post(`/crm/customers/${target}/unassign`, {}), await flashAfter(mgr, `/crm/customers/${target}`));
  check("ASG-4", "Ending an assignment leaves the customer unassigned (and shows up under \"No agent assigned\"); ending it again is refused",
    Number(ended.n) === 0 && /no assigned agent/.test(noAgentMsg) && (await tl.get("/crm/customers?assignment=unassigned")).body.includes("Leader Made") && (await auditCount("customer_unassigned")) >= 1);
  const unrouted = await joseph.get(`/crm/customers/${target}`);
  const assignBack = await tl.post(`/crm/customers/${target}/assign`, { agent_id: String(kristine.id) });
  check("ASG-5", "An unassigned customer is visible to every Team Leader (like the unrouted case queue) so one can assign it; once assigned to team 1 the other team's Team Leader loses access",
    unrouted.status === 200 && assignBack.status === 302 && (await joseph.get(`/crm/customers/${target}`)).status === 404);

  // ================================================================ sample pages removed
  const removedKeys = ["customers.new", "interactions.list", "interactions.new", "interactions.detail", "portal.preferences"];
  const stillThere = PAGES.filter((p) => removedKeys.includes(p.key)).map((p) => p.key);
  const sampleBadge = "Sample data – not yet connected";
  const livePages = [[agent, "/crm/customers/new"], [agent, "/crm/interactions"], [agent, "/crm/interactions/new"], [agent, `/crm/interactions/${row.id}`], [juanC, "/portal/preferences"]];
  const withBadge = [];
  for (const [c, path] of livePages) if ((await c.get(path)).body.includes(sampleBadge)) withBadge.push(path);
  const custPage = (await agent.get(`/crm/customers/${juan.id}`)).body;
  const agentHome = (await agent.get("/crm/agent")).body;
  const portalHome = (await juanC.get("/portal")).body;
  check("SMP-1", "The five P3 sample pages are removed from services/samples and their routes are live pages without the sample badge; the customer page has no sample panel left (purchase history is live since P5); dashboards no longer mention P3",
    stillThere.length === 0 && withBadge.length === 0 && custPage.includes("Purchase history") && !custPage.includes("Sample data – not yet connected") && !/\bP3\b/.test(custPage) && !/\bP3\b/.test(agentHome) && !/\bP3\b/.test(portalHome) && !custPage.includes("Interaction timeline (sample)") &&
    agentHome.includes("Recent interactions") && portalHome.includes("/portal/preferences"), `${stillThere} ${withBadge}`);
  const mgrHome = (await mgr.get("/crm/customers/new")).body.includes("Check for duplicates and save");
  check("SMP-2", "Interactions tabs (Interactions / Inquiries / Follow-up tasks) are shared by the live page and the P4 sample pages", (await agent.get("/crm/interactions")).body.includes('href="/crm/inquiries"') && (await agent.get("/crm/inquiries")).body.includes('href="/crm/interactions"') && mgrHome);

  // ================================================================ no stray text on the new pages
  const BAD = /\[object Object\]|\bundefined\b|\bNaN\b|\{\{|\}\}/;
  const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "");
  const pages = [];
  for (const [name, c] of [["agent", agent], ["tl", tl], ["mgr", mgr]]) {
    for (const p of ["/crm/customers", `/crm/customers/${juan.id}`, "/crm/customers/new", "/crm/interactions", "/crm/interactions/new", "/crm/interactions/1"]) {
      const r = await c.get(p);
      if (r.status !== 200 && !(r.status === 404 && p === "/crm/interactions/1")) pages.push(`${name} ${p} → ${r.status}`);
      else if (r.status === 200 && BAD.test(strip(r.body))) pages.push(`${name} ${p} → stray text`);
    }
  }
  check("PAGES-P3", "Customers, customer detail, new customer, interactions, new interaction open for agent, Team Leader and Manager without stray template text", pages.length === 0, pages.join("; "));
} catch (err) {
  check("RUN", "Tests ran without an unexpected error", false, err.stack || String(err));
} finally {
  await env.stop();
  summarize(DB);
}
