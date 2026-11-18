/*
 * JOHNVIVZ CRM — Phase P4 (customer service) acceptance tests.
 *   npm run test:p4        (npm test runs it after P1, P2, the UI pass, the status suite and P3)
 * Throwaway database johnvivz_crm_p4_test; people beyond the 7 demo accounts come from tests/support/p1Fixtures.mjs.
 * Covers: the inquiry workflow (customer portal and staff: answer, take, assign, convert to a case, close), follow-up
 * tasks (create, scope, complete, cancel, reschedule, reassign, overdue, the reminder job), staff-created cases for
 * phone / walk-in customers, record scope on every new page and action, audit entries, the demo seed, and the removal
 * of the P4 sample pages.
 */
import { check, startEnvironment, summarize } from "./support/harness.mjs";
import { PAGES } from "./support/noSamples.mjs";

const DB = process.env.TEST_P4_DB_NAME || "johnvivz_crm_p4_test";
const PORT = Number(process.env.TEST_P4_PORT || 3200);
const env = await startEnvironment({ dbName: DB, port: PORT });
console.log(`\nJOHNVIVZ CRM P4 tests — database ${DB}\n`);
check("ENV-01", "Migrations (101–115), demo seed and fixtures load; server starts", env.steps.migrate.status === 0 && env.steps.seed.status === 0 && env.steps.fixtures.status === 0 && env.up,
  env.steps.migrate.stderr || env.steps.seed.stderr || env.steps.fixtures.stderr || env.serverLog());

const { all, one, db, as, node } = env;
const decode = (s) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const alerts = (html) => [...html.matchAll(/role="(?:alert|status)">.*?<span>([^<]*)<\/span>/gs)].map((m) => decode(m[1]));
const errorList = (html) => [...(html.match(/role="alert">([\s\S]*?)<\/ul>/) || [, ""])[1].matchAll(/<li>([^<]*)<\/li>/g)].map((m) => decode(m[1]));
const flashAfter = async (client, path) => alerts((await client.get(path)).body).join(" | ");
const auditCount = async (action, extra = "", params = []) => Number((await one(`SELECT COUNT(*) n FROM crm_audit_logs WHERE action = ? ${extra}`, [action, ...params])).n);
const ymdhm = (date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date).replace(" ", "T");
const inHours = (h) => ymdhm(new Date(Date.now() + h * 3600 * 1000));
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "");

try {
  const u = (email) => one("SELECT id, team_id FROM crm_users WHERE email = ?", [email]);
  const kristine = await u("kristine.bautista@johnvivz.test");
  const ramon = await u("ramon.aquino@johnvivz.test");
  const maria = await u("maria.santos@johnvivz.test");
  const joseph = await u("joseph.villanueva@johnvivz.test");
  const patricia = await u("patricia.lim@johnvivz.test");
  const manager = await u("manager@johnvivz.test");
  const juan = await one("SELECT id, customer_no FROM customers WHERE email = 'juan.cruz@johnvivz.test'");
  const ana = await one("SELECT id FROM customers WHERE email = 'ana.delarosa@johnvivz.test'");
  const ernesto = await one("SELECT id FROM customers WHERE first_name = 'Ernesto'");
  const category = await one("SELECT id FROM case_categories WHERE is_active = 1 ORDER BY id LIMIT 1");
  const agent = await as("kristine.bautista@johnvivz.test");
  const ramonC = await as("ramon.aquino@johnvivz.test");
  const tl = await as("maria.santos@johnvivz.test");
  const josephC = await as("joseph.villanueva@johnvivz.test");
  const mgr = await as("manager@johnvivz.test");
  const juanC = await as("juan.cruz@johnvivz.test");
  const anaC = await as("ana.delarosa@johnvivz.test");
  const juanUserId = (await one("SELECT user_id FROM customer_accounts WHERE customer_id = ?", [juan.id])).user_id;
  const notes = async (userId, type, id) => Number((await one("SELECT COUNT(*) n FROM crm_notifications WHERE user_id = ? AND related_type = ? AND related_id = ?", [userId, type, id])).n);

  // ================================================================ seed and permissions
  const inqStatus = Object.fromEntries((await all("SELECT status, COUNT(*) n FROM inquiries WHERE is_demo = 1 GROUP BY status")).map((r) => [r.status, Number(r.n)]));
  const fuStatus = Object.fromEntries((await all("SELECT status, COUNT(*) n FROM follow_up_tasks WHERE is_demo = 1 GROUP BY status")).map((r) => [r.status, Number(r.n)]));
  const overdueDemo = Number((await one("SELECT COUNT(*) n FROM follow_up_tasks WHERE is_demo = 1 AND status = 'pending' AND due_at < NOW()")).n);
  const convertedDemo = await one("SELECT COUNT(*) n, SUM(k.is_demo = 1) demo, SUM(k.status = 'assigned') assigned, SUM(k.case_type = 'inquiry') typed FROM inquiries i JOIN customer_cases k ON k.id = i.converted_case_id WHERE i.is_demo = 1");
  const demoCases = await one("SELECT COUNT(*) n, SUM(case_type = 'inquiry') inq FROM customer_cases WHERE is_demo = 1");
  const demoUsers = Number((await one("SELECT COUNT(*) n FROM crm_users WHERE is_demo = 1")).n);
  check("SEED-4", "Demo seed: still exactly 7 accounts; demo inquiries in every status (open, answered, 3 converted and linked to their demo case, closed); no demo case of type Inquiry and still 40 demo cases; follow-ups pending / overdue / done / cancelled",
    demoUsers === 7 && inqStatus.open >= 4 && inqStatus.answered >= 3 && inqStatus.converted === 3 && inqStatus.closed === 1 && fuStatus.pending >= 5 && fuStatus.done === 2 && fuStatus.cancelled === 1 && overdueDemo >= 2 &&
    Number(convertedDemo.n) === 3 && Number(convertedDemo.demo) === 3 && Number(convertedDemo.assigned) === 3 && Number(convertedDemo.typed) === 0 && Number(demoCases.n) === 40 && Number(demoCases.inq) === 0, JSON.stringify({ demoUsers, inqStatus, fuStatus, overdueDemo, convertedDemo, demoCases }));
  const perms = Object.fromEntries((await all("SELECT p.code, GROUP_CONCAT(r.code ORDER BY r.code) roles FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id JOIN roles r ON r.id = rp.role_id WHERE p.code IN ('inquiries.view','inquiries.create','inquiries.answer','inquiries.assign','inquiries.submit_own','followups.view','followups.manage','followups.assign','cases.create_staff') GROUP BY p.code")).map((r) => [r.code, r.roles]));
  const three = "agent,crm_manager,team_leader";
  check("PERM-2", "Migration 115 added the nine permissions to the right roles (assign: Team Leader and Manager; submit_own: customer only)",
    ["inquiries.view", "inquiries.create", "inquiries.answer", "followups.view", "followups.manage", "cases.create_staff"].every((c) => perms[c] === three) &&
    perms["inquiries.assign"] === "crm_manager,team_leader" && perms["followups.assign"] === "crm_manager,team_leader" && perms["inquiries.submit_own"] === "customer", JSON.stringify(perms));

  // ================================================================ customer portal: submit an inquiry
  await juanC.get("/portal/inquiries");
  const portalPage = await juanC.get("/portal/inquiries");
  const nBefore = Number((await one("SELECT COUNT(*) n FROM inquiries")).n);
  const sent = await juanC.post("/portal/inquiries", { subject: "Do you sell frozen chicken?", question: "Do you sell frozen whole chicken at the Calapan branch and what is the price per kilo?" });
  const inq1 = await one("SELECT * FROM inquiries WHERE subject = 'Do you sell frozen chicken?'");
  check("INQ-1", "Customer submits an inquiry from the portal: INQ number, channel portal, status Open, no handler; the agent of the customer and the Team Leaders are notified; the old sample badge is gone",
    portalPage.status === 200 && !portalPage.body.includes("Sample data – not yet connected") && portalPage.body.includes("Ask a question") && sent.status === 302 && inq1 && /^INQ-\d{8}-\d{4}$/.test(inq1.inquiry_no) && inq1.channel === "portal" &&
    inq1.status === "open" && inq1.handled_by === null && inq1.customer_id === juan.id && (await notes(kristine.id, "inquiry", inq1.id)) === 1 && (await notes(maria.id, "inquiry", inq1.id)) === 1 && (await auditCount("inquiry_submitted")) >= 1, `${sent.status} ${JSON.stringify(inq1)}`);
  const bad1 = await juanC.post("/portal/inquiries", { subject: "Hi", question: "Short" });
  const bad2 = await juanC.post("/portal/inquiries", { subject: "A fine subject", question: "too short" });
  check("INQ-2", "Too-short subject or question is refused (422) and nothing is saved", bad1.status === 422 && bad2.status === 422 && errorList(bad1.body).length >= 2 && Number((await one("SELECT COUNT(*) n FROM inquiries")).n) === nBefore + 1);
  const mine = (await juanC.get("/portal/inquiries")).body;
  const anaSees = await anaC.get(`/portal/inquiries/${inq1.id}`);
  const juanOwn = await juanC.get(`/portal/inquiries/${inq1.id}`);
  check("INQ-3", "A customer sees only their own inquiries (another customer gets 404); staff pages are closed to customers (403) and the portal page to staff (403)",
    mine.includes("Do you sell frozen chicken?") && !mine.includes("Bulk price for 25kg rice") && anaSees.status === 404 && juanOwn.status === 200 && juanOwn.body.includes("Waiting for an answer") &&
    (await juanC.get("/crm/inquiries")).status === 403 && (await agent.get("/portal/inquiries")).status === 403);
  const oldLink = await juanC.get("/portal/cases/new?type=inquiry");
  const caseForm = (await juanC.get("/portal/cases/new")).body;
  await juanC.get("/portal/cases/new");
  const caseAsInquiry = await juanC.post("/portal/cases", { case_type: "inquiry", category_id: String(category.id), priority: "low", subject: "A question as a case", description: "This should not be accepted as a case of type inquiry." });
  check("INQ-4", "The interim behaviour is gone: the old \"Submit Inquiry\" link redirects to the inquiry page; the case form no longer offers type Inquiry and refuses it",
    oldLink.status === 302 && oldLink.location === "/portal/inquiries" && !caseForm.includes('value="inquiry"') && caseAsInquiry.status === 422 && !(await one("SELECT id FROM customer_cases WHERE subject = 'A question as a case'")));
  const nav = (await juanC.get("/portal")).body;
  check("INQ-5", "The customer menu item \"Submit Inquiry\" opens the inquiry page", nav.includes('href="/portal/inquiries"') && !nav.includes("cases/new?type=inquiry"));

  // ================================================================ staff: scope, answer, take, forged
  await agent.get("/crm/inquiries");
  const agentList = (await agent.get("/crm/inquiries")).body;
  check("STF-1", "Inquiry scope: Kristine sees the new inquiry (her customer); Ramon, the other team's Team Leader get 404 and do not list it; Maria and the Manager see it",
    agentList.includes("Do you sell frozen chicken?") && (await ramonC.get(`/crm/inquiries/${inq1.id}`)).status === 404 && !(await ramonC.get("/crm/inquiries")).body.includes("Do you sell frozen chicken?") &&
    (await josephC.get(`/crm/inquiries/${inq1.id}`)).status === 404 && (await tl.get(`/crm/inquiries/${inq1.id}`)).status === 200 && (await mgr.get(`/crm/inquiries/${inq1.id}`)).status === 200);
  const forgedRamon = [await ramonC.post(`/crm/inquiries/${inq1.id}/answer`, { answer: "Forged answer from the wrong team." }), await ramonC.post(`/crm/inquiries/${inq1.id}/convert`, { category_id: String(category.id), priority: "low", case_type: "inquiry" }),
    await ramonC.post(`/crm/inquiries/${inq1.id}/take`, {}), await juanC.post(`/crm/inquiries/${inq1.id}/answer`, { answer: "A customer cannot answer inquiries." })];
  check("STF-2", "Forged POSTs by an agent outside the scope are 404 and by a customer 403; nothing changes", [404, 404, 404, 403].every((s, i) => forgedRamon[i].status === s) && (await one("SELECT status FROM inquiries WHERE id = ?", [inq1.id])).status === "open", forgedRamon.map((r) => r.status).join(","));

  await agent.get(`/crm/inquiries/${inq1.id}`);
  await agent.post(`/crm/inquiries/${inq1.id}/answer`, { answer: "Too short" });
  const shortMsg = await flashAfter(agent, `/crm/inquiries/${inq1.id}`);
  await agent.post(`/crm/inquiries/${inq1.id}/answer`, { answer: "Yes, frozen whole chicken is available at 190 pesos per kilo at the Calapan branch." });
  const answered = await one("SELECT status, answer, handled_by, answered_at FROM inquiries WHERE id = ?", [inq1.id]);
  const juanAnswer = (await juanC.get(`/portal/inquiries/${inq1.id}`)).body;
  await agent.post(`/crm/inquiries/${inq1.id}/answer`, { answer: "A second answer should be refused." });
  const againMsg = await flashAfter(agent, `/crm/inquiries/${inq1.id}`);
  check("STF-3", "Answering: too short is refused; a valid answer sets Answered, the handler and the time, notifies the customer, and the customer reads it on the portal; a second answer is refused; audited",
    /at least 10 characters/.test(shortMsg) && answered.status === "answered" && answered.handled_by === kristine.id && answered.answered_at && answered.answer.startsWith("Yes, frozen whole chicken") &&
    (await notes(juanUserId, "inquiry", inq1.id)) === 1 && juanAnswer.includes("Our answer") && juanAnswer.includes("190 pesos") && /already answered/.test(againMsg) && (await auditCount("inquiry_answered")) >= 1, `${shortMsg} | ${againMsg} | ${JSON.stringify(answered)}`);

  // an inquiry handled by another agent can be read but not answered
  const anaInq = await one("SELECT id FROM inquiries WHERE subject = 'Bulk price for 25kg rice'");
  await db.query("UPDATE inquiries SET handled_by = ?, status = 'open', answer = NULL, answered_at = NULL WHERE id = ?", [ramon.id, anaInq.id]);
  const seen = await agent.get(`/crm/inquiries/${anaInq.id}`);
  const blocked = await agent.post(`/crm/inquiries/${anaInq.id}/answer`, { answer: "I should not be able to answer this one." });
  check("STF-4", "An inquiry handled by another agent: Kristine can read it (her customer) but not answer it (403, audited); the answer box is not shown",
    seen.status === 200 && seen.body.includes("handled by Ramon Aquino") && !seen.body.includes("Send answer") && blocked.status === 403 && (await auditCount("access_denied", "AND details LIKE 'answer:%'")) >= 1);
  await db.query("UPDATE inquiries SET handled_by = NULL WHERE id = ?", [anaInq.id]);
  await agent.get(`/crm/inquiries/${anaInq.id}`);
  await agent.post(`/crm/inquiries/${anaInq.id}/take`, {});
  const taken = await one("SELECT handled_by FROM inquiries WHERE id = ?", [anaInq.id]);
  await agent.post(`/crm/inquiries/${anaInq.id}/take`, {});
  const takeAgain = await flashAfter(agent, `/crm/inquiries/${anaInq.id}`);
  const tlTake = await tl.post(`/crm/inquiries/${anaInq.id}/take`, {});
  check("STF-5", "An agent takes an unclaimed inquiry (audited); taking it twice is refused; a Team Leader cannot \"take\" (403: she assigns)", taken.handled_by === kristine.id && /already has a handler/.test(takeAgain) && tlTake.status === 403 && (await auditCount("inquiry_assigned")) >= 1, `${JSON.stringify(taken)} ${takeAgain} ${tlTake.status}`);

  // ================================================================ staff: assign
  await mgr.post("/crm/customers/new", { first_name: "Loose", last_name: "Customer", mobile: "0917 880 1234", source: "phone", consent: "1", consent_channel: "phone" });
  const loose = await one("SELECT id FROM customers WHERE last_name = 'Customer' AND first_name = 'Loose'");
  await mgr.get("/crm/inquiries/new");
  await mgr.post("/crm/inquiries", { customer_id: String(loose.id), channel: "email", subject: "Question about delivery areas", question: "Which barangays of Calapan do you deliver to on weekdays?" });
  const looseInq = await one("SELECT id, handled_by FROM inquiries WHERE subject = 'Question about delivery areas'");
  const agentSeesLoose = (await agent.get(`/crm/inquiries/${looseInq.id}`)).status;
  await tl.get(`/crm/inquiries/${looseInq.id}`);
  const otherTeam = await tl.post(`/crm/inquiries/${looseInq.id}/assign`, { agent_id: String(patricia.id) });
  const assignMaria = await tl.post(`/crm/inquiries/${looseInq.id}/assign`, { agent_id: String(kristine.id) });
  const looseAfter = await one("SELECT handled_by FROM inquiries WHERE id = ?", [looseInq.id]);
  const looseCustomer = await one("SELECT agent_id FROM agent_assignments WHERE customer_id = ? AND ended_at IS NULL", [loose.id]);
  check("STF-6", "Assigning: a Team Leader can assign only her team's agents (403, audited); assigning also gives the customer an agent when they had none; the agent is notified and can then open the inquiry and the customer",
    looseInq.handled_by === manager.id && agentSeesLoose === 404 && otherTeam.status === 403 && assignMaria.status === 302 && looseAfter.handled_by === kristine.id && looseCustomer?.agent_id === kristine.id &&
    (await notes(kristine.id, "inquiry", looseInq.id)) === 1 && (await agent.get(`/crm/inquiries/${looseInq.id}`)).status === 200 && (await agent.get(`/crm/customers/${loose.id}`)).status === 200 && (await auditCount("access_denied", "AND details LIKE 'assign:%'")) >= 1);
  const mgrAssign = await mgr.post(`/crm/inquiries/${looseInq.id}/assign`, { agent_id: String(patricia.id) });
  const sameAgain = await mgr.post(`/crm/inquiries/${looseInq.id}/assign`, { agent_id: String(patricia.id) });
  const agentAssign = await agent.post(`/crm/inquiries/${anaInq.id}/assign`, { agent_id: String(kristine.id) });
  check("STF-7", "The Manager can assign any agent; assigning the same agent again is refused; an agent cannot assign (403)", mgrAssign.status === 302 && (await one("SELECT handled_by FROM inquiries WHERE id = ?", [looseInq.id])).handled_by === patricia.id && /already assigned/.test(await flashAfter(mgr, `/crm/inquiries/${looseInq.id}`)) && sameAgain.status === 302 && agentAssign.status === 403);

  // ================================================================ staff: record an inquiry (phone / walk-in)
  await agent.get("/crm/inquiries/new");
  const nI = Number((await one("SELECT COUNT(*) n FROM inquiries")).n);
  const recorded = await agent.post("/crm/inquiries", { customer_id: String(ernesto.id), channel: "phone", subject: "Is the Calapan branch open on Sunday?", question: "Customer phoned to ask whether the Calapan branch is open on Sundays." });
  const rec = await one("SELECT * FROM inquiries WHERE subject = 'Is the Calapan branch open on Sunday?'");
  const recInt = rec ? await one("SELECT interaction_type, direction, related_type, related_id, crm_user_id FROM customer_interactions WHERE related_type = 'inquiry' AND related_id = ?", [rec.id]) : null;
  const walkin = await agent.post("/crm/inquiries", { customer_id: String(ernesto.id), channel: "walk_in", subject: "Do you accept GCash at the counter?", question: "Asked at the counter whether GCash is accepted.", answer: "Yes, GCash is accepted at all counters." });
  const wal = await one("SELECT status, answer, handled_by, answered_at FROM inquiries WHERE subject = 'Do you accept GCash at the counter?'");
  check("REC-1", "Staff record inquiries: a phone inquiry is Open with the agent as handler and a timeline entry (call, linked to the inquiry); a walk-in inquiry answered on the spot is Answered; both audited",
    recorded.status === 302 && rec?.channel === "phone" && rec.status === "open" && rec.handled_by === kristine.id && rec.created_by === kristine.id && recInt?.interaction_type === "call" && recInt.direction === "inbound" && recInt.crm_user_id === kristine.id &&
    walkin.status === 302 && wal?.status === "answered" && wal.handled_by === kristine.id && wal.answered_at && (await auditCount("inquiry_created")) >= 2, JSON.stringify({ rec, recInt, wal }));
  const invalid = [
    ["short question", { question: "short" }, /question/i], ["bad channel", { channel: "portal" }, /reached us/], ["no customer", { customer_id: "" }, /Choose the customer/],
    ["short answer", { answer: "yes" }, /answer must be at least/], ["short subject", { subject: "Hi" }, /subject/i],
  ];
  const invProblems = [];
  for (const [name, tweak, expected] of invalid) {
    const r = await agent.post("/crm/inquiries", { customer_id: String(ernesto.id), channel: "phone", subject: "A valid subject", question: "A valid question text here.", ...tweak });
    if (r.status !== 422 || !errorList(r.body).some((e) => expected.test(e))) invProblems.push(`${name}: ${r.status} ${errorList(r.body).join("|")}`);
  }
  const outOfScope = await ramonC.post("/crm/inquiries", { customer_id: String(ernesto.id), channel: "phone", subject: "Not allowed here", question: "Ramon has no access to this customer." });
  const custPost = await juanC.post("/crm/inquiries", { customer_id: String(juan.id), channel: "phone", subject: "Forged by customer", question: "A customer cannot record staff inquiries." });
  check("REC-2", "Invalid staff inquiries are refused (short question, portal channel, no customer, short answer, short subject); a customer outside the agent's scope is refused (404); a customer account gets 403",
    invProblems.length === 0 && outOfScope.status === 404 && custPost.status === 403 && Number((await one("SELECT COUNT(*) n FROM inquiries")).n) === nI + 2 + 0, invProblems.join("; ") + ` ${outOfScope.status}/${custPost.status}`);

  // ================================================================ staff: convert to a case, close
  const caseCount = Number((await one("SELECT COUNT(*) n FROM customer_cases")).n);
  await agent.get(`/crm/inquiries/${inq1.id}`);
  const badCat = await agent.post(`/crm/inquiries/${inq1.id}/convert`, { category_id: "999999", priority: "high", case_type: "complaint" });
  const badCatMsg = await flashAfter(agent, `/crm/inquiries/${inq1.id}`);
  const converted = await agent.post(`/crm/inquiries/${inq1.id}/convert`, { category_id: String(category.id), priority: "high", case_type: "service_request" });
  const afterConv = await one("SELECT status, converted_case_id FROM inquiries WHERE id = ?", [inq1.id]);
  const newCase = afterConv.converted_case_id ? await one("SELECT * FROM customer_cases WHERE id = ?", [afterConv.converted_case_id]) : null;
  const caseHist = newCase ? await all("SELECT field, new_value FROM case_status_history WHERE case_id = ? ORDER BY id", [newCase.id]) : [];
  const caseAsg = newCase ? await one("SELECT agent_id FROM case_assignments WHERE case_id = ?", [newCase.id]) : null;
  check("CNV-1", "Convert to a case: the case keeps subject, question, channel, customer, chosen type/category/priority; the agent who converts becomes its agent (Assigned) with history; the inquiry becomes Converted with a link; only one case was created; a bad category was refused",
    badCat.status === 302 && /category/i.test(badCatMsg) && converted.status === 302 && afterConv.status === "converted" && newCase && newCase.customer_id === juan.id && newCase.subject === "Do you sell frozen chicken?" && newCase.description.includes("frozen whole chicken") &&
    newCase.description.includes("Answer already given") && newCase.channel === "portal" && newCase.case_type === "service_request" && newCase.category_id === category.id && newCase.priority === "high" && newCase.status === "assigned" && newCase.assigned_agent_id === kristine.id && newCase.is_demo === 0 &&
    caseAsg?.agent_id === kristine.id && caseHist.some((h) => h.new_value === "assigned") && Number((await one("SELECT COUNT(*) n FROM customer_cases")).n) === caseCount + 1 && (await auditCount("inquiry_converted")) >= 1, JSON.stringify({ afterConv, newCase: newCase && { status: newCase.status, type: newCase.case_type }, badCatMsg }));
  const juanCase = await juanC.get(`/portal/cases/${newCase.id}`);
  const juanInqPage = (await juanC.get(`/portal/inquiries/${inq1.id}`)).body;
  check("CNV-2", "After converting: the customer is notified and finds the case (portal case page opens, the inquiry page links to it); a converted inquiry cannot be answered, converted or closed again",
    (await notes(juanUserId, "case", newCase.id)) >= 1 && juanCase.status === 200 && juanInqPage.includes(newCase.case_no) && juanInqPage.includes(`/portal/cases/${newCase.id}`));
  await agent.post(`/crm/inquiries/${inq1.id}/convert`, { category_id: String(category.id), priority: "low", case_type: "complaint" });
  const convAgain = await flashAfter(agent, `/crm/inquiries/${inq1.id}`);
  await agent.post(`/crm/inquiries/${inq1.id}/close`, {});
  const closeConv = await flashAfter(agent, `/crm/inquiries/${inq1.id}`);
  check("CNV-3", "A converted inquiry cannot be converted or closed again", /already converted/.test(convAgain) && /Only an answered inquiry can be closed/.test(closeConv));

  // Team Leader converts: the case waits in the Customer Queue
  const tlInq = await one("SELECT id FROM inquiries WHERE subject = 'Bulk price for 25kg rice'");
  await tl.get(`/crm/inquiries/${tlInq.id}`);
  await tl.post(`/crm/inquiries/${tlInq.id}/convert`, { category_id: String(category.id), priority: "medium", case_type: "inquiry" });
  const tlCase = await one("SELECT k.status, k.assigned_agent_id, k.team_id, k.case_no FROM inquiries i JOIN customer_cases k ON k.id = i.converted_case_id WHERE i.id = ?", [tlInq.id]);
  check("CNV-4", "A Team Leader converts without an agent: the case stays Open, unrouted, in the Customer Queue", tlCase?.status === "open" && tlCase.assigned_agent_id === null && tlCase.team_id === null && (await tl.get("/crm/queue")).body.includes(tlCase.case_no));
  const walId = (await one("SELECT id FROM inquiries WHERE subject = 'Do you accept GCash at the counter?'")).id;
  await agent.post(`/crm/inquiries/${walId}/close`, {});
  const closed = await one("SELECT status FROM inquiries WHERE id = ?", [walId]);
  const openId = rec.id;
  await agent.get(`/crm/inquiries/${openId}`);
  await agent.post(`/crm/inquiries/${openId}/close`, {});
  const closeOpenMsg = await flashAfter(agent, `/crm/inquiries/${openId}`);
  check("CLS-1", "An answered inquiry can be closed (audited); an open one cannot (answer or convert it first)", closed.status === "closed" && /Only an answered inquiry/.test(closeOpenMsg) && (await auditCount("inquiry_closed")) >= 1);
  const byStatus = (await agent.get("/crm/inquiries?status=closed")).body;
  const byChannel = (await agent.get("/crm/inquiries?channel=phone")).body;
  const byQ = (await agent.get("/crm/inquiries?q=GCash")).body;
  const byMine = (await agent.get("/crm/inquiries?mine=1")).body;
  check("LST-1", "Inquiry list filters work: status, channel, search text, handled by me",
    byStatus.includes("Do you accept GCash") && !byStatus.includes("Is the Calapan branch open on Sunday?") && byChannel.includes("Is the Calapan branch open on Sunday?") && !byChannel.includes("Do you accept GCash") && byQ.includes("Do you accept GCash") && !byQ.includes("Is the Calapan branch open") && byMine.includes("Do you accept GCash") && !(await tl.get("/crm/inquiries?mine=1")).body.includes("Do you accept GCash"));

  // ================================================================ follow-up tasks
  const fuCount = async () => Number((await one("SELECT COUNT(*) n FROM follow_up_tasks")).n);
  const juanCase1 = await one("SELECT id, case_no FROM customer_cases WHERE customer_id = ? AND assigned_agent_id = ? ORDER BY id LIMIT 1", [juan.id, kristine.id]);
  const otherCase = await one("SELECT case_no FROM customer_cases WHERE customer_id <> ? AND assigned_agent_id = ? ORDER BY id LIMIT 1", [juan.id, kristine.id]);
  await agent.get(`/crm/follow-ups/new?customer_id=${juan.id}&case_no=${juanCase1.case_no}`);
  const fuPage = await agent.get(`/crm/follow-ups/new?customer_id=${juan.id}&case_no=${juanCase1.case_no}`);
  const due1 = inHours(26);
  const made = await agent.post("/crm/follow-ups", { customer_id: String(juan.id), title: "Call about the replacement delivery", notes: "Ask for the new address.", due_at: due1, priority: "high", case_no: juanCase1.case_no.toLowerCase() });
  const fu1 = await one("SELECT * FROM follow_up_tasks WHERE title = 'Call about the replacement delivery'");
  const fu1Due = fu1 ? await one("SELECT DATE_FORMAT(due_at, '%Y-%m-%dT%H:%i') t FROM follow_up_tasks WHERE id = ?", [fu1.id]) : null;
  check("FU-1", "Agent creates a follow-up for her customer: assigned to her, Pending, priority and notes saved, linked to the customer's case, due time kept as typed (Asia/Manila), audited; the form is prefilled from a customer / case link",
    fuPage.status === 200 && fuPage.body.includes(`<option value="${juan.id}" selected>`) && fuPage.body.includes(juanCase1.case_no) && made.status === 302 && fu1 && fu1.assigned_to === kristine.id && fu1.created_by === kristine.id && fu1.status === "pending" &&
    fu1.priority === "high" && fu1.case_id === juanCase1.id && fu1Due.t === due1 && fu1.is_demo === 0 && (await auditCount("follow_up_created")) >= 1, `${made.status} ${JSON.stringify(fu1Due)} ${due1}`);
  const n0 = await fuCount();
  const fuInvalid = [
    ["short title", { title: "Hi" }, /Describe the task/], ["past due", { due_at: inHours(-48) }, /cannot be in the past/], ["bad date", { due_at: "tomorrow" }, /valid due date/],
    ["too far", { due_at: inHours(24 * 400) }, /more than a year/], ["bad priority", { priority: "urgent" }, /priority/], ["no customer", { customer_id: "" }, /Choose the customer/],
    ["another customer's case", { case_no: otherCase.case_no }, /not found for this customer/],
  ];
  const fuProblems = [];
  for (const [name, tweak, expected] of fuInvalid) {
    const r = await agent.post("/crm/follow-ups", { customer_id: String(juan.id), title: "A valid task title", due_at: due1, priority: "medium", ...tweak });
    if (r.status !== 422 || !errorList(r.body).some((e) => expected.test(e))) fuProblems.push(`${name}: ${r.status} ${errorList(r.body).join("|")}`);
  }
  const forgedAssignee = await agent.post("/crm/follow-ups", { customer_id: String(juan.id), title: "Task for someone else", due_at: due1, priority: "low", assigned_to: String(ramon.id) });
  const outsideCustomer = await ramonC.post("/crm/follow-ups", { customer_id: String(juan.id), title: "Not my customer", due_at: due1, priority: "low" });
  const custForged = await juanC.post("/crm/follow-ups", { customer_id: String(juan.id), title: "Forged by customer", due_at: due1, priority: "low" });
  check("FU-2", "Invalid follow-ups are refused (short title, past, bad or distant date, bad priority, no customer, another customer's case); an agent cannot assign to someone else (403, audited); a customer outside the scope is refused (404); a customer account gets 403",
    fuProblems.length === 0 && forgedAssignee.status === 403 && outsideCustomer.status === 404 && custForged.status === 403 && (await fuCount()) === n0 && (await auditCount("access_denied", "AND details LIKE 'create:%' AND actor_role = 'agent'")) >= 1, fuProblems.join("; ") + ` ${forgedAssignee.status}/${outsideCustomer.status}/${custForged.status}`);

  await tl.get("/crm/follow-ups/new");
  const tlToAgent = await tl.post("/crm/follow-ups", { customer_id: String(juan.id), title: "Check satisfaction with the replacement", due_at: inHours(50), priority: "medium", assigned_to: String(kristine.id) });
  const fuTl = await one("SELECT id, assigned_to, created_by FROM follow_up_tasks WHERE title = 'Check satisfaction with the replacement'");
  const tlToOther = await tl.post("/crm/follow-ups", { customer_id: String(juan.id), title: "Task for the other team", due_at: inHours(50), priority: "medium", assigned_to: String(patricia.id) });
  const tlSelf = await tl.post("/crm/follow-ups", { customer_id: String(juan.id), title: "Team Leader own task", due_at: inHours(5), priority: "low" });
  const fuSelf = await one("SELECT id, assigned_to FROM follow_up_tasks WHERE title = 'Team Leader own task'");
  await mgr.get("/crm/follow-ups/new");
  const mgrToJoseph = await mgr.post("/crm/follow-ups", { customer_id: String(juan.id), title: "Manager task for Joseph", due_at: inHours(5), priority: "low", assigned_to: String(joseph.id) });
  const fuJoseph = await one("SELECT id, assigned_to FROM follow_up_tasks WHERE title = 'Manager task for Joseph'");
  check("FU-3", "Assignment rules: a Team Leader assigns to her team's agent (the agent is notified) or herself, never to another team's agent (403); the Manager can assign any staff member",
    tlToAgent.status === 302 && fuTl.assigned_to === kristine.id && (await notes(kristine.id, "follow_up", fuTl.id)) === 1 && tlToOther.status === 403 && tlSelf.status === 302 && fuSelf.assigned_to === maria.id &&
    mgrToJoseph.status === 302 && fuJoseph.assigned_to === joseph.id && (await notes(joseph.id, "follow_up", fuJoseph.id)) === 1);

  const seenBy = async (client, id) => (await client.get(`/crm/follow-ups/${id}`)).status;
  check("FU-4", "Follow-up scope: Kristine sees her tasks only; Ramon, Joseph and a customer are refused; Maria sees her own and Kristine's but not Joseph's; the Manager sees all",
    (await seenBy(agent, fu1.id)) === 200 && (await seenBy(agent, fuSelf.id)) === 404 && (await seenBy(ramonC, fu1.id)) === 404 && (await seenBy(josephC, fu1.id)) === 404 && (await seenBy(juanC, fu1.id)) === 403 &&
    (await seenBy(tl, fu1.id)) === 200 && (await seenBy(tl, fuSelf.id)) === 200 && (await seenBy(tl, fuJoseph.id)) === 404 && (await seenBy(mgr, fuJoseph.id)) === 200 && (await seenBy(josephC, fuJoseph.id)) === 200);
  const forgedFu = [await ramonC.post(`/crm/follow-ups/${fu1.id}/complete`, { note: "forged" }), await ramonC.post(`/crm/follow-ups/${fu1.id}/cancel`, { reason: "forged by Ramon" }), await ramonC.post(`/crm/follow-ups/${fu1.id}/reschedule`, { due_at: inHours(3) }),
    await agent.post(`/crm/follow-ups/${fuSelf.id}/complete`, { note: "not mine" }), await agent.post(`/crm/follow-ups/${fu1.id}/reassign`, { assigned_to: String(kristine.id) })];
  check("FU-5", "Forged actions: another team's agent and an agent on someone else's task get 404; an agent cannot reassign (403); nothing changes",
    [404, 404, 404, 404, 403].every((s, i) => forgedFu[i].status === s) && (await one("SELECT status FROM follow_up_tasks WHERE id = ?", [fu1.id])).status === "pending", forgedFu.map((r) => r.status).join(","));

  await agent.get(`/crm/follow-ups/${fu1.id}`);
  const resched = await agent.post(`/crm/follow-ups/${fu1.id}/reschedule`, { due_at: inHours(72) });
  const rescheduled = await one("SELECT due_at, notes FROM follow_up_tasks WHERE id = ?", [fu1.id]);
  await agent.post(`/crm/follow-ups/${fu1.id}/reschedule`, { due_at: inHours(-30) });
  const pastMsg = await flashAfter(agent, `/crm/follow-ups/${fu1.id}`);
  await agent.post(`/crm/follow-ups/${fu1.id}/reschedule`, { due_at: "soon" });
  const soonMsg = await flashAfter(agent, `/crm/follow-ups/${fu1.id}`);
  check("FU-6", "Reschedule: a new future time is saved and noted; a past or invalid time is refused; audited", resched.status === 302 && /Rescheduled/.test(rescheduled.notes) && Math.abs(new Date(rescheduled.due_at) - (Date.now() + 72 * 3600 * 1000)) < 3 * 3600 * 1000 && /in the past/.test(pastMsg) && /valid due date/.test(soonMsg) && (await auditCount("follow_up_rescheduled")) >= 1, `${pastMsg} | ${soonMsg}`);
  await agent.post(`/crm/follow-ups/${fu1.id}/cancel`, { reason: "no" });
  const shortCancel = await flashAfter(agent, `/crm/follow-ups/${fu1.id}`);
  await agent.post(`/crm/follow-ups/${fu1.id}/complete`, { note: "Spoke to the customer; the replacement arrives Friday." });
  const done = await one("SELECT status, completed_at, notes FROM follow_up_tasks WHERE id = ?", [fu1.id]);
  await agent.post(`/crm/follow-ups/${fu1.id}/complete`, {});
  const twice = await flashAfter(agent, `/crm/follow-ups/${fu1.id}`);
  await agent.post(`/crm/follow-ups/${fu1.id}/cancel`, { reason: "Changed my mind about it" });
  const afterDone = await flashAfter(agent, `/crm/follow-ups/${fu1.id}`);
  check("FU-7", "Complete: sets Done, the time and an outcome line in the notes (audited); a second completion or a later cancel is refused; a cancel needs a reason of 5+ characters",
    /at least 5 characters/.test(shortCancel) && done.status === "done" && done.completed_at && /Done: Spoke to the customer/.test(done.notes) && /already done/.test(twice) && /already done/.test(afterDone) && (await auditCount("follow_up_completed")) >= 1);
  await tl.get(`/crm/follow-ups/${fuTl.id}`);
  await tl.post(`/crm/follow-ups/${fuTl.id}/cancel`, { reason: "The customer already confirmed" });
  const cancelled = await one("SELECT status, notes FROM follow_up_tasks WHERE id = ?", [fuTl.id]);
  await tl.post(`/crm/follow-ups/${fuSelf.id}/complete`, { note: "Done by the leader" });
  check("FU-8", "A Team Leader can cancel (with a reason, kept in the notes, audited) and complete tasks in her scope", cancelled.status === "cancelled" && /Cancelled: The customer already confirmed/.test(cancelled.notes) && (await one("SELECT status FROM follow_up_tasks WHERE id = ?", [fuSelf.id])).status === "done" && (await auditCount("follow_up_cancelled")) >= 1);

  // reassign
  await agent.post("/crm/follow-ups", { customer_id: String(juan.id), title: "Task to be reassigned", due_at: inHours(10), priority: "medium" });
  const reTask = await one("SELECT id FROM follow_up_tasks WHERE title = 'Task to be reassigned'");
  await tl.get(`/crm/follow-ups/${reTask.id}`);
  const reOther = await tl.post(`/crm/follow-ups/${reTask.id}/reassign`, { assigned_to: String(patricia.id) });
  const reSelf = await tl.post(`/crm/follow-ups/${reTask.id}/reassign`, { assigned_to: String(maria.id) });
  const reNow = await one("SELECT assigned_to, notes FROM follow_up_tasks WHERE id = ?", [reTask.id]);
  await tl.post(`/crm/follow-ups/${reTask.id}/reassign`, { assigned_to: String(maria.id) });
  const reSameMsg = await flashAfter(tl, `/crm/follow-ups/${reTask.id}`);
  check("FU-9", "Reassign: a Team Leader cannot send a task to another team's agent (403, audited); she can take it herself (noted, notified, audited); the same assignee is refused; Kristine no longer sees it",
    reOther.status === 403 && reSelf.status === 302 && reNow.assigned_to === maria.id && /Reassigned to/.test(reNow.notes) && /already assigned/.test(reSameMsg) && (await seenBy(agent, reTask.id)) === 404 && (await auditCount("follow_up_reassigned")) >= 1);

  // overdue, lists and dashboards
  await agent.post("/crm/follow-ups", { customer_id: String(ana.id), title: "Overdue call to Ana", due_at: inHours(2), priority: "high" });
  const odTask = await one("SELECT id FROM follow_up_tasks WHERE title = 'Overdue call to Ana'");
  await db.query("UPDATE follow_up_tasks SET due_at = NOW() - INTERVAL 3 HOUR WHERE id = ?", [odTask.id]);
  const overdueList = (await agent.get("/crm/follow-ups?status=overdue")).body;
  const doneList = (await agent.get("/crm/follow-ups?status=done")).body;
  const agentHome = (await agent.get("/crm/agent")).body;
  const tlHome = (await tl.get("/crm/team-leader")).body;
  check("FU-10", "Overdue is a pending task past its time: the overdue filter lists it with an Overdue label and not the done tasks; the agent dashboard's \"Today's follow-ups\" shows it; the Team Leader's overdue count and the inquiry stat are live",
    overdueList.includes("Overdue call to Ana") && overdueList.includes(">Overdue<") && !overdueList.includes("Call about the replacement delivery") && doneList.includes("Call about the replacement delivery") && !doneList.includes("Overdue call to Ana") &&
    agentHome.includes("Today's follow-ups") && agentHome.includes("Overdue call to Ana") && agentHome.includes("Open inquiries") && tlHome.includes("Overdue follow-ups") && tlHome.includes("Open inquiries") && !/\bP4\b/.test(agentHome), "");
  const f1 = (await agent.get("/crm/follow-ups?q=Overdue&priority=high")).body;
  const f2 = (await agent.get("/crm/follow-ups?priority=low&status=pending")).body;
  const tlAssignee = (await tl.get(`/crm/follow-ups?assignee=${kristine.id}`)).body;
  check("FU-11", "Follow-up filters work: search + priority, priority + status, and the Team Leader's \"assigned to\" filter", f1.includes("Overdue call to Ana") && !f2.includes("Overdue call to Ana") && tlAssignee.includes("Overdue call to Ana") && !tlAssignee.includes("Team Leader own task"));

  // the reminder job: one notification per due task
  await agent.post("/crm/follow-ups", { customer_id: String(ana.id), title: "Due reminder test", due_at: inHours(1), priority: "low" });
  const remTask = await one("SELECT id FROM follow_up_tasks WHERE title = 'Due reminder test'");
  await db.query("UPDATE follow_up_tasks SET due_at = NOW() - INTERVAL 10 MINUTE WHERE id = ?", [remTask.id]);
  const runJob = () => node(["--input-type=module", "-e", "import('./services/followUpService.js').then(async (m) => { const { sequelize } = await import('./models/index.js'); console.log('JOBRESULT ' + await m.notifyDueFollowUps()); await sequelize.close(); })"]);
  const before = await notes(kristine.id, "follow_up", remTask.id);
  const j1 = runJob();
  const mid = await notes(kristine.id, "follow_up", remTask.id);
  const j2 = runJob();
  const after = await notes(kristine.id, "follow_up", remTask.id);
  const doneNoted = await notes(kristine.id, "follow_up", fu1.id);
  check("FU-12", "Reminder job: a due pending task notifies its assignee exactly once (a second run sends nothing); finished tasks are not reminded",
    before === 0 && /JOBRESULT [1-9]/.test(j1.stdout) && mid === 1 && /JOBRESULT 0/.test(j2.stdout) && after === 1 && doneNoted === 0, `${j1.stdout} ${j1.stderr?.slice(0, 200)} | ${j2.stdout}`);

  // ================================================================ staff-created cases (phone / walk-in)
  const nCases = Number((await one("SELECT COUNT(*) n FROM customer_cases")).n);
  await agent.get("/crm/cases");
  const listBtn = (await agent.get("/crm/cases")).body.includes('href="/crm/cases/new"');
  const newCaseForm = await agent.get(`/crm/cases/new?customer_id=${ana.id}`);
  const madeCase = await agent.post("/crm/cases", { customer_id: String(ana.id), channel: "phone", case_type: "complaint", category_id: String(category.id), priority: "urgent", subject: "Customer phoned about a double charge", description: "Ana phoned: she was charged twice for the same order and wants a refund.", order_reference: "ORD-20990" });
  const sc = await one("SELECT * FROM customer_cases WHERE subject = 'Customer phoned about a double charge'");
  const scHist = sc ? await all("SELECT field, old_value, new_value, note FROM case_status_history WHERE case_id = ? ORDER BY id", [sc.id]) : [];
  const scInt = sc ? await one("SELECT interaction_type, direction, crm_user_id, customer_id FROM customer_interactions WHERE related_type = 'case' AND related_id = ?", [sc.id]) : null;
  const scAsg = sc ? await one("SELECT agent_id, team_id, assigned_by FROM case_assignments WHERE case_id = ?", [sc.id]) : null;
  const anaUserId = (await one("SELECT user_id FROM customer_accounts WHERE customer_id = ?", [ana.id])).user_id;
  check("SC-1", "Agent opens a case for a phoning customer: JVT number, channel phone, urgent priority allowed, Assigned to her with her team, SLA dates set, history (created, assignment, status), an interaction (call) on the customer timeline, the customer notified, audited",
    listBtn && newCaseForm.status === 200 && newCaseForm.body.includes(`<option value="${ana.id}" selected>`) && madeCase.status === 302 && sc && /^JVT-\d{8}-\d{4}$/.test(sc.case_no) && sc.channel === "phone" && sc.priority === "urgent" && sc.status === "assigned" && sc.assigned_agent_id === kristine.id && sc.team_id === kristine.team_id &&
    sc.created_by === kristine.id && sc.resolution_due_at && sc.first_response_due_at && sc.order_reference === "ORD-20990" && scHist.some((h) => h.field === "created") && scHist.some((h) => h.field === "assignment") && scHist.some((h) => h.field === "status" && h.new_value === "assigned") &&
    scAsg?.agent_id === kristine.id && scAsg.assigned_by === kristine.id && scInt?.interaction_type === "call" && scInt.customer_id === ana.id && (await notes(anaUserId, "case", sc.id)) >= 1 && (await auditCount("case_created_by_staff")) >= 1, JSON.stringify({ sc: sc && [sc.status, sc.channel], scHist, scInt, scAsg }));
  const caseInvalid = [
    ["no customer", { customer_id: "" }, /Choose the customer/], ["portal channel", { channel: "portal" }, /contacted us/], ["short subject", { subject: "Hi" }, /Subject/], ["short description", { description: "too short" }, /Describe the concern/],
    ["no category", { category_id: "" }, /category/i], ["bad type", { case_type: "nonsense" }, /type of concern/], ["bad priority", { priority: "critical" }, /priority/i], ["bad order ref", { order_reference: "ORD<script>" }, /Order\/receipt reference/],
  ];
  const caseProblems = [];
  for (const [name, tweak, expected] of caseInvalid) {
    const r = await agent.post("/crm/cases", { customer_id: String(ana.id), channel: "phone", case_type: "complaint", category_id: String(category.id), priority: "medium", subject: "A valid subject here", description: "A valid description with enough characters.", ...tweak });
    if (r.status !== 422 || !errorList(r.body).some((e) => expected.test(e))) caseProblems.push(`${name}: ${r.status} ${errorList(r.body).join("|")}`);
  }
  const ramonCase = await ramonC.post("/crm/cases", { customer_id: String(ana.id), channel: "phone", case_type: "complaint", category_id: String(category.id), priority: "medium", subject: "Not my customer at all", description: "Ramon has no access to this customer." });
  const custCase = await anaC.post("/crm/cases", { customer_id: String(ana.id), channel: "phone", case_type: "complaint", category_id: String(category.id), priority: "medium", subject: "Forged by a customer", description: "A customer cannot use the staff form." });
  const custForm = await anaC.get("/crm/cases/new");
  check("SC-2", "Invalid staff cases are refused with a message (no customer, portal channel, short subject / description, no category, bad type, bad priority, bad order reference); another team's agent gets 404 for the customer; a customer account gets 403 (form and POST); nothing extra saved",
    caseProblems.length === 0 && ramonCase.status === 404 && custCase.status === 403 && custForm.status === 403 && Number((await one("SELECT COUNT(*) n FROM customer_cases")).n) === nCases + 1, caseProblems.join("; ") + ` ${ramonCase.status}/${custCase.status}/${custForm.status}`);

  await tl.get("/crm/cases/new");
  const tlQueue = await tl.post("/crm/cases", { customer_id: String(ana.id), channel: "walk_in", case_type: "service_request", category_id: String(category.id), priority: "low", subject: "Walk-in request for a receipt copy", description: "Customer came to the store and asked for a copy of the receipt." });
  const q1 = await one("SELECT case_no, status, assigned_agent_id, team_id FROM customer_cases WHERE subject = 'Walk-in request for a receipt copy'");
  const tlAgent = await tl.post("/crm/cases", { customer_id: String(ana.id), channel: "sms", case_type: "feedback", category_id: String(category.id), priority: "medium", subject: "Feedback received by SMS", description: "Customer sent an SMS praising the delivery rider.", agent_id: String(kristine.id) });
  const q2 = await one("SELECT status, assigned_agent_id FROM customer_cases WHERE subject = 'Feedback received by SMS'");
  const tlOther2 = await tl.post("/crm/cases", { customer_id: String(ana.id), channel: "sms", case_type: "feedback", category_id: String(category.id), priority: "medium", subject: "Case for another team agent", description: "Team Leaders cannot assign to another team.", agent_id: String(patricia.id) });
  await mgr.get("/crm/cases/new");
  const mgrAny = await mgr.post("/crm/cases", { customer_id: String(ana.id), channel: "email", case_type: "complaint", category_id: String(category.id), priority: "medium", subject: "Email complaint logged by the Manager", description: "Customer emailed a complaint about a late delivery.", agent_id: String(patricia.id) });
  const q3 = await one("SELECT status, assigned_agent_id, team_id FROM customer_cases WHERE subject = 'Email complaint logged by the Manager'");
  check("SC-3", "Team Leader: without an agent the case is Open and unrouted (in the Customer Queue); with her team's agent it is Assigned; another team's agent is refused (403, audited). The Manager may pick any agent (team follows the agent)",
    tlQueue.status === 302 && q1.status === "open" && q1.assigned_agent_id === null && q1.team_id === null && (await tl.get("/crm/queue")).body.includes(q1.case_no) && tlAgent.status === 302 && q2.status === "assigned" && q2.assigned_agent_id === kristine.id &&
    tlOther2.status === 403 && !(await one("SELECT id FROM customer_cases WHERE subject = 'Case for another team agent'")) && mgrAny.status === 302 && q3.assigned_agent_id === patricia.id && q3.team_id === (await one("SELECT team_id FROM crm_users WHERE id = ?", [patricia.id])).team_id && (await auditCount("access_denied", "AND details LIKE 'create:%'")) >= 2);

  // a whole walk-in flow
  await agent.get("/crm/customers/new");
  await agent.post("/crm/customers/new", { first_name: "Walter", last_name: "Flowers", mobile: "0917 990 4411", source: "walk_in", consent: "1", consent_channel: "in_store" });
  const walter = await one("SELECT id FROM customers WHERE last_name = 'Flowers'");
  await agent.post("/crm/cases", { customer_id: String(walter.id), channel: "walk_in", case_type: "complaint", category_id: String(category.id), priority: "medium", subject: "Walk-in: bruised fruit in the delivery", description: "Walter came to the store with bruised fruit from his last delivery." });
  await agent.post("/crm/inquiries", { customer_id: String(walter.id), channel: "walk_in", subject: "Do you deliver to Pinamalayan?", question: "Walter asked if deliveries go as far as Pinamalayan." });
  await agent.post("/crm/follow-ups", { customer_id: String(walter.id), title: "Call Walter about the fruit replacement", due_at: inHours(24), priority: "medium" });
  const timeline = (await agent.get(`/crm/customers/${walter.id}`)).body;
  check("SC-4", "A walk-in customer, end to end: created, a case opened, an inquiry recorded and a follow-up scheduled; the customer page shows the interactions (case and inquiry) and the buttons for the next steps",
    timeline.includes("Case JVT-") && timeline.includes("Inquiry INQ-") && timeline.includes(`/crm/cases/new?customer_id=${walter.id}`) && timeline.includes(`/crm/inquiries/new?customer_id=${walter.id}`) && timeline.includes(`/crm/follow-ups/new?customer_id=${walter.id}`));

  // ================================================================ sample pages removed, pages open
  const removedKeys = ["inquiries.list", "inquiries.detail", "followups.list", "followups.new", "followups.detail"];
  const stillThere = PAGES.filter((p) => removedKeys.includes(p.key)).map((p) => p.key);
  const BADGE = "Sample data – not yet connected";
  const livePaths = [[agent, "/crm/inquiries"], [agent, `/crm/inquiries/${inq1.id}`], [agent, "/crm/inquiries/new"], [agent, "/crm/follow-ups"], [agent, `/crm/follow-ups/${fu1.id}`], [agent, "/crm/follow-ups/new"], [agent, "/crm/cases/new"], [juanC, "/portal/inquiries"]];
  const badged = [];
  for (const [c, path] of livePaths) if ((await c.get(path)).body.includes(BADGE)) badged.push(path);
  check("SMP-3", "The five P4 sample pages are gone from services/samples and their routes are live pages without the sample badge; no sample screen is left for P3, P4 or P5; the agent dashboard has no sample block or P4 mention any more",
    stillThere.length === 0 && badged.length === 0 && PAGES.every((p) => !["P3", "P4", "P5"].includes(p.phase)) && !agentHome.includes("Sample data – not yet connected") && !/\bP4\b/.test(agentHome), `${stillThere} ${badged} ${PAGES.length}`);
  const BAD = /\[object Object\]|\bundefined\b|\bNaN\b|\{\{|\}\}/;
  const pageProblems = [];
  for (const [name, c] of [["agent", agent], ["tl", tl], ["mgr", mgr]]) {
    for (const p of ["/crm/inquiries", `/crm/inquiries/${inq1.id}`, "/crm/inquiries/new", "/crm/follow-ups", `/crm/follow-ups/${fu1.id}`, "/crm/follow-ups/new", "/crm/cases/new", "/crm/cases", "/crm/customers", "/crm/interactions"]) {
      const r = await c.get(p);
      if (r.status !== 200 && !(r.status === 404 && /\/(inquiries|follow-ups)\/\d+$/.test(p))) pageProblems.push(`${name} ${p} → ${r.status}`);
      else if (r.status === 200 && BAD.test(strip(r.body))) pageProblems.push(`${name} ${p} → stray text`);
    }
  }
  for (const p of ["/portal/inquiries", `/portal/inquiries/${inq1.id}`, "/portal", "/portal/cases/new"]) {
    const r = await juanC.get(p);
    if (r.status !== 200 || BAD.test(strip(r.body))) pageProblems.push(`customer ${p} → ${r.status}`);
  }
  check("PAGES-P4", "Inquiries, follow-ups, new case and the customer's inquiry pages open for every allowed role without stray template text", pageProblems.length === 0, pageProblems.join("; "));
} catch (err) {
  check("RUN", "Tests ran without an unexpected error", false, err.stack || String(err));
} finally {
  await env.stop();
  summarize(DB);
}
