/*
 * Demo data seeder for johnvivz_crm_db.
 *   npm run seed        load the MOCK HR fixture (manager, team leader, agent), 1 team, 7 demo logins,
 *                       5 customers (2 walk-ins without a login) and 40 demo cases. Skipped if demo data exists.
 *   npm run seed:clear  remove ONLY demo rows (is_demo = 1, plus the demo team and unused mock HR references)
 *   npm run seed:reset  seed:clear, then seed again
 * Refuses to run when NODE_ENV=production. Never touches johnvivz_tech (it uses DB_NAME from .env).
 * Cases are created through services/caseService.js so numbering, history, escalation and rules match
 * real use. Every timestamp is in the past so the figures look like normal activity.
 */
import bcrypt from "bcrypt";
import { QueryTypes } from "sequelize";
import { sequelize, CrmUser, CrmTeam, CaseCategory, CustomerCase } from "../models/index.js";
import {
  createCase, assignCase, addComment, changeStatus, escalateCase, handleEscalation, submitRating,
} from "../services/caseService.js";
import { registerPortalCustomer, createCustomerRecord, recordConsents } from "../services/customerService.js";
import { submitPortalInquiry, createStaffInquiry, convertInquiry } from "../services/inquiryService.js";
import { createFollowUp } from "../services/followUpService.js";
import { placeOrder, recordPayment, verifyPayment, markReady, completeOrder, cancelOrder } from "../services/orderService.js";
import { requestRefund, decideRefund, recordRefund } from "../services/refundService.js";
import { createPromotion, createCampaign } from "../services/marketingService.js";
import { syncProducts, isMockInventory } from "../services/integration/inventoryAdapter.js";
import { audit } from "../services/auditService.js";
import { receiveRequest, decideRequest } from "../services/approvalService.js";
import { recomputeSegments } from "../services/segmentService.js";
import { syncReferences, hrMode } from "../services/integration/hrAdapter.js";
import { MOCK_EMPLOYEES } from "../services/integration/fixtures/mockHr.js";
import { loadSettings } from "../services/settingsService.js";
import { DEMO_PASSWORD, DEMO_TEAMS, DEMO_TEAM_CODES, DEMO_SETUP_ADMIN, DEMO_CUSTOMERS } from "./demoAccounts.js";

// Deterministic pseudo-random numbers so every seed run produces the same data.
let state = 20261111;
const rand = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (list) => list[Math.floor(rand() * list.length)];
const H = 3600 * 1000;
const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });

const CASES = [
  ["complaint", "Order Issue", "Missing items in my online order", "I received my grocery delivery but 2 packs of pancit canton and 1 tray of eggs were missing. The receipt shows they were charged.", "high", "ORD-10452"],
  ["complaint", "Product Quality", "Expired fresh milk bought at Calapan branch", "The 1L fresh milk I bought yesterday expired 3 days ago according to the label. I still have the receipt.", "high", "OR-00871"],
  ["complaint", "Billing & Payment", "Double charge on GCash payment", "My GCash was charged twice for the same order. Please refund the duplicate payment.", "high", "ORD-10467"],
  ["service_request", "Delivery & Pickup", "Request to reschedule delivery", "Can you move my delivery from Friday morning to Saturday afternoon? Nobody will be home on Friday.", "medium", "ORD-10471"],
  ["service_request", "Account & Loyalty", "Senior citizen discount not applied", "My mother's senior citizen discount was not applied at the counter. How can we get it adjusted?", "medium", "OR-00902"],
  ["complaint", "Account & Loyalty", "Loyalty points not credited", "I bought groceries worth ₱2,450 last week but my loyalty points were not credited to my card.", "low", "OR-00915"],
  ["complaint", "Product Quality", "Damaged eggs in delivery", "6 out of 30 eggs in the tray were cracked when the delivery arrived.", "medium", "ORD-10480"],
  ["complaint", "Order Issue", "Wrong item delivered", "I ordered 5kg Sinandomeng rice but received 5kg Dinorado. I want the correct item.", "medium", "ORD-10488"],
  ["service_request", "Returns & Refunds", "Refund for spoiled vegetables", "The lettuce and tomatoes in my order were spoiled. I would like a refund instead of a replacement.", "high", "ORD-10493"],
  ["service_request", "Billing & Payment", "Request for official receipt reprint", "I lost the official receipt for my purchase on the 3rd. I need a reprint for reimbursement.", "low", "OR-00933"],
  ["complaint", "Store Service", "Long queue at the cashier", "Only one cashier was open last Sunday afternoon and the line took 40 minutes.", "medium", ""],
  ["complaint", "Delivery & Pickup", "Late delivery for the second time", "My delivery arrived 3 hours late again. The rider did not answer calls.", "high", "ORD-10502"],
  ["service_request", "Returns & Refunds", "Exchange a wrong-size diaper pack", "I bought size M diapers but need size L. The pack is unopened.", "medium", "OR-00951"],
  ["complaint", "Billing & Payment", "Price on shelf different from receipt", "The shelf tag said ₱89 for the coffee but I was charged ₱105.", "medium", "OR-00958"],
  ["complaint", "Order Issue", "Incomplete grocery pickup order", "My pickup order was missing the cooking oil and sugar.", "high", "ORD-10515"],
  ["service_request", "Delivery & Pickup", "Change delivery address", "Please deliver my order to my office address instead of home.", "medium", "ORD-10520"],
  ["complaint", "Product Quality", "Moldy bread", "The loaf of bread I bought had mold even though it was not yet expired.", "high", "OR-00977"],
];

const AGENT_REPLIES = [
  "Hi {name}, thank you for reaching out. I'm checking this with the branch now and will update you shortly.",
  "Hello {name}, we're sorry for the inconvenience. Could you send a photo of the item and your receipt so we can process this faster?",
  "Good day {name}! We have verified your concern and coordinated with the store team.",
];
const CUSTOMER_REPLIES = ["Thank you, I attached the photo.", "Okay, I'll wait for your update.", "Here are the details you asked for. Thanks!"];
const RESOLUTIONS = [
  "We have processed the refund. It should reflect within 3–5 banking days.",
  "A replacement has been scheduled with your next delivery at no extra cost.",
  "The adjustment has been applied to your account. Thank you for your patience.",
];
const INTERNAL_NOTES = ["Checked with branch supervisor, stock count confirms the shortage.", "Asked billing to verify the duplicate payment.", "Rider logs show delay due to traffic in Calapan."];
const ESCALATION_REASONS = ["Refund above my approval limit", "Customer requests a supervisor", "Repeated complaint from the same customer", "Needs coordination with another branch"];
const COMMENTS = ["Very helpful support!", "Fast response, thank you.", "Issue was solved but took a while.", "Okay naman, pero sana mas mabilis.", "Excellent service!", ""];

const asCustomer = (c) => ({ id: c.user.id, role: "customer", customer_id: c.customer.id, name: `${c.customer.first_name} ${c.customer.last_name}` });
const asStaff = (u) => ({ id: u.id, role: u.role, team_id: u.team_id, name: u.display_name });

const seed = async () => {
  if (await CustomerCase.count({ where: { is_demo: true } })) {
    console.log("ℹ️  Demo data already exists. Run `npm run seed:clear` first if you want to re-seed.");
    return;
  }
  if (hrMode() !== "mock") {
    console.log("ℹ️  INTEGRATION_HR_MODE is not 'mock'. Demo staff come from the mock HR fixture, so seeding is skipped.");
    return;
  }
  await loadSettings();
  const hr = await syncReferences();
  console.log(`🧪 MOCK HR fixture loaded: ${hr.employees} employee reference(s) (is_mock = 1).`);

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const teams = {};
  const staff = {};
  await sequelize.transaction(async (transaction) => {
    for (const t of DEMO_TEAMS) {
      const [row] = await CrmTeam.findOrCreate({ where: { team_code: t.team_code }, defaults: t, transaction });
      teams[t.team_code] = row.get({ plain: true });
    }
    await CrmUser.create({
      user_type: "system", role: "system_admin", email: DEMO_SETUP_ADMIN.email, password_hash: hash,
      display_name: DEMO_SETUP_ADMIN.name, is_demo: true, email_verified_at: new Date(),
    }, { transaction });
    for (const e of MOCK_EMPLOYEES) {
      // A demo login kept by `seed:clear` (linked to a real record) is reused, not duplicated.
      const kept = await CrmUser.findOne({ where: { email: e.work_email }, transaction });
      if (kept) {
        await kept.update({ is_active: true, employee_id: e.employee_id, team_id: e.team ? teams[e.team].id : null }, { transaction });
        staff[e.employee_id] = kept.get({ plain: true });
        continue;
      }
      const u = await CrmUser.create({
        user_type: "staff", role: e.crm_role, employee_id: e.employee_id, email: e.work_email, password_hash: hash,
        display_name: e.full_name, team_id: e.team ? teams[e.team].id : null, is_demo: true, email_verified_at: new Date(),
        ...(e.employment_status === "separated" ? { access_revoked_at: new Date(), access_revoked_reason: "HR employment status: separated" } : {}),
      }, { transaction });
      staff[e.employee_id] = u.get({ plain: true });
    }
    const manager = Object.values(staff).find((u) => u.role === "crm_manager");
    for (const t of Object.values(teams)) {
      const leader = Object.values(staff).find((u) => u.role === "team_leader" && u.team_id === t.id);
      await sequelize.query("UPDATE crm_teams SET team_leader_id = :leader, manager_id = :manager WHERE id = :id",
        { replacements: { leader: leader ? leader.id : null, manager: manager.id, id: t.id }, transaction });
    }
  });

  const customers = [];
  const walkIns = [];
  for (const [i, c] of DEMO_CUSTOMERS.entries()) {
    const joined = new Date(Date.now() - (75 - i * 4) * 24 * H);
    const keptLogin = c.portal ? await CrmUser.findOne({ where: { email: c.email }, raw: true }) : null;
    if (keptLogin) {
      const [row] = await select("SELECT c.* FROM customers c JOIN customer_accounts ca ON ca.customer_id = c.id WHERE ca.user_id = :id", { id: keptLogin.id });
      customers.push({ customer: row, user: keptLogin });
    } else if (c.portal) {
      customers.push(await registerPortalCustomer({
        firstName: c.first, lastName: c.last, email: c.email, mobile: c.mobile, address: c.address, passwordHash: hash, isDemo: true, createdAt: joined,
      }));
    } else {
      await sequelize.transaction(async (transaction) => {
        const rec = await createCustomerRecord({ firstName: c.first, lastName: c.last, mobile: c.mobile, address: c.address, source: "walk_in", isDemo: true, createdAt: joined }, transaction);
        await recordConsents(rec.id, { channel: "in_store", at: joined, kinds: ["data_privacy"] }, transaction);
        walkIns.push(rec.id);
      });
    }
  }

  const categories = Object.fromEntries((await CaseCategory.findAll({ raw: true })).map((c) => [c.name, c.id]));
  const staffList = Object.values(staff).filter((u) => !u.access_revoked_at);
  const agentRow = staffList.find((u) => u.role === "agent");
  const leaderRow = staffList.find((u) => u.role === "team_leader");
  const manager = asStaff(staffList.find((u) => u.role === "crm_manager"));
  const agent = asStaff(agentRow);
  const leader = asStaff(leaderRow);

  // Planned final state for 37 cases (3 customers, 1 agent, 1 team leader); the other 3, Assigned cases, come from converting three demo inquiries below (P4), so the demo total stays 40.
  // No demo case has type Inquiry: questions are inquiry records now. Every status and both escalation levels are represented.
  const plan = [
    ...Array(5).fill("open"), ...Array(1).fill("assigned"), ...Array(7).fill("in_progress"), ...Array(4).fill("waiting"),
    ...Array(3).fill("escalated_l1"), ...Array(2).fill("escalated_l2"), ...Array(5).fill("resolved"), ...Array(9).fill("closed"),
    "reopened",
  ];
  const now = Date.now();
  let count = 0;
  for (let i = 0; i < plan.length; i++) {
    const final = plan[i];
    const [caseType, category, subject, description, priority, orderRef] = CASES[i % CASES.length];
    const cust = customers[i % customers.length];
    const customer = asCustomer(cust);
    const ageHours = ["open", "assigned", "in_progress", "waiting", "escalated_l1", "escalated_l2", "reopened"].includes(final) ? 3 + rand() * 110
      : final === "resolved" ? 8 + rand() * 40
      : 96 + rand() * 1300;
    let t = now - ageHours * H;
    const step = (minH, maxH) => { t = Math.min(t + (minH + rand() * (maxH - minH)) * H, now - 5 * 60 * 1000); return new Date(t); };

    const k = await createCase({
      user: customer,
      data: { case_type: caseType, category_id: categories[category], subject, description, priority, order_reference: orderRef || null },
      createdAt: new Date(t), isDemo: true,
    });
    count++;
    if (final === "open") continue;

    await assignCase({ caseId: k.id, actor: rand() < 0.8 ? leader : manager, agentId: agent.id, at: step(0.2, 3) });
    if (final === "assigned") continue;

    const first = customer.name.split(" ")[0];
    await addComment({ caseId: k.id, user: agent, body: pick(AGENT_REPLIES).replace("{name}", first), at: step(0.3, 8) });
    await changeStatus({ caseId: k.id, user: agent, newStatus: "in_progress", at: step(0.1, 1) });
    if (rand() < 0.5) await addComment({ caseId: k.id, user: agent, body: pick(INTERNAL_NOTES), internal: true, at: step(0.5, 4) });
    if (final === "in_progress") continue;
    if (final === "waiting") {
      await changeStatus({ caseId: k.id, user: agent, newStatus: "waiting_for_customer", note: "Waiting for the customer's photo/receipt", at: step(0.5, 6) });
      continue;
    }
    if (final === "escalated_l1" || final === "escalated_l2") {
      await escalateCase({ caseId: k.id, user: agent, reason: pick(ESCALATION_REASONS), at: step(0.5, 6) });
      if (final === "escalated_l2") await escalateCase({ caseId: k.id, user: leader, reason: "Needs CRM Manager approval", at: step(0.5, 6) });
      continue;
    }

    await addComment({ caseId: k.id, user: customer, body: pick(CUSTOMER_REPLIES), at: step(1, 12) });
    // Some finished cases went through the escalation chain: the Team Leader took over and resolved them.
    const resolver = i % 4 === 0 ? leader : agent;
    if (resolver === leader) {
      await escalateCase({ caseId: k.id, user: agent, reason: pick(ESCALATION_REASONS), at: step(0.5, 4) });
      await handleEscalation({ caseId: k.id, user: leader, action: "take_over", note: "Handling directly", at: step(0.5, 4) });
    }
    step(1, 24); // time passes while the agent works; resolving posts the public "Resolution: …" comment itself
    await changeStatus({ caseId: k.id, user: resolver, newStatus: "resolved", note: pick(RESOLUTIONS).slice(0, 255), at: step(0.1, 1) });
    if (final === "reopened") {
      await changeStatus({ caseId: k.id, user: customer, newStatus: "in_progress", note: "The problem happened again on my next order.", at: step(2, 20) });
      continue;
    }
    if (final === "closed") {
      if (rand() < 0.6) await changeStatus({ caseId: k.id, user: customer, newStatus: "closed", note: "Customer confirmed the solution", at: step(4, 48) });
      else await changeStatus({ caseId: k.id, user: leader, newStatus: "closed", note: "Customer confirmed by phone", at: step(24, 60) }); // agents can't change Resolved cases
    }
    if (rand() < 0.75) {
      await submitRating({ caseId: k.id, user: customer, rating: pick([5, 5, 5, 4, 4, 4, 3, 2, 5, 4]), comment: pick(COMMENTS), at: step(0.5, 24), isDemo: true });
    }
  }

  // Customer master (P3): the agent handles the walk-ins and the first portal customer; interactions, preferences, marketing consent.
  const portalIds = customers.map((c) => c.customer.id);
  for (const customerId of [...walkIns, portalIds[0]].filter(Boolean)) {
    const [has] = await select("SELECT id FROM agent_assignments WHERE customer_id = :customerId AND ended_at IS NULL", { customerId });
    if (!has) {
      await sequelize.query("INSERT INTO agent_assignments (customer_id, agent_id, assigned_by, assigned_at, note) VALUES (?, ?, ?, ?, ?)",
        { replacements: [customerId, agent.id, leader.id, new Date(Date.now() - 20 * 24 * H), "Regular customer of the Customer Care Team"] });
    }
  }
  const INTERACTIONS = [
    ["call", "inbound", "Asked about the delayed delivery", "Customer called about the delayed delivery; the rider was contacted and the customer was told the new time."],
    ["visit", "inbound", "Walk-in: registered for the portal", "Customer visited the store, was shown how to register for the portal and agreed to the Data Privacy Notice."],
    ["sms", "outbound", "Reminder to send the receipt photo", "Sent an SMS asking for a photo of the receipt for the open case."],
    ["email", "outbound", "Sent the refund confirmation", "Emailed the refund confirmation and the expected 3–5 day timeline."],
    ["chat", "inbound", "Question about bulk pricing", "Asked about bulk pricing for rice; shared the current price list."],
    ["note", "internal", "Prefers to be contacted in the afternoon", "Customer prefers afternoon calls and speaks Filipino. Updated the contact preferences."],
    ["call", "outbound", "Follow-up on the replacement order", "Called to confirm the replacement was received; the customer was satisfied."],
    ["visit", "inbound", "Complaint about the cashier queue", "Spoke to the supervisor about the long queue on Sunday; apologised and noted the feedback."],
  ];
  const allCustomerIds = [...portalIds, ...walkIns];
  const firstCaseOf = Object.fromEntries((await select("SELECT customer_id, MIN(id) AS id FROM customer_cases WHERE is_demo = 1 GROUP BY customer_id")).map((r) => [r.customer_id, r.id]));
  for (let i = 0; i < 16; i++) {
    const [type, direction, subject, summary] = INTERACTIONS[i % INTERACTIONS.length];
    const customerId = allCustomerIds[i % allCustomerIds.length];
    const related = firstCaseOf[customerId] && i % 3 === 0 ? firstCaseOf[customerId] : null;
    const by = i % 5 === 4 ? leader.id : agent.id;
    await sequelize.query(
      `INSERT INTO customer_interactions (customer_id, crm_user_id, interaction_type, direction, subject, summary, related_type, related_id, occurred_at, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      { replacements: [customerId, by, type, direction, subject, summary, related ? "case" : null, related, new Date(Date.now() - (1 + i * 1.7 + rand()) * 24 * H)] }
    );
  }
  const PREFS = [
    { preferred_channel: "sms", preferred_language: "filipino", preferred_contact_time: "afternoon" },
    { preferred_channel: "email", preferred_language: "english", preferred_branch: "Calapan" },
    { preferred_channel: "call", preferred_language: "filipino" },
  ];
  for (const [i, prefs] of PREFS.entries()) {
    const customerId = portalIds[i];
    if (!customerId) continue;
    for (const [key, value] of Object.entries(prefs)) {
      await sequelize.query("INSERT IGNORE INTO customer_preferences (customer_id, preference_key, preference_value) VALUES (?, ?, ?)", { replacements: [customerId, key, value] });
    }
  }
  if (portalIds[0]) {
    await sequelize.query(
      `INSERT INTO customer_consents (customer_id, consent_type, granted, policy_version, channel, granted_at, created_at) VALUES (?, 'marketing_sms', 1, '2026-11', 'portal', ?, ?)`,
      { replacements: [portalIds[0], new Date(Date.now() - 30 * 24 * H), new Date(Date.now() - 30 * 24 * H)] }
    );
  }

  // Customer service (P4): inquiries (open, answered, converted, closed) and follow-up tasks (pending, due today, overdue, done).
  const portalUsers = customers.map((c) => asCustomer(c));
  const ago = (hours) => new Date(Date.now() - hours * H);
  const [juanU, anaU, lizaU] = portalUsers;
  const inq = (user, subject, question, hoursAgo) => submitPortalInquiry({ user, values: { subject, question }, createdAt: ago(hoursAgo), isDemo: true });
  const open1 = await inq(juanU, "Do you deliver to Naujan on Sundays?", "Do you deliver to Naujan on Sundays, and is there a delivery fee for orders below 1000 pesos?", 5);
  await inq(anaU, "Bulk price for 25kg rice", "How much is a 25kg sack of Sinandomeng rice if I buy three sacks at once?", 20);
  await inq(lizaU, "Is organic brown rice available?", "Do you have organic brown rice in stock at the Naujan branch? How much per kilo?", 12);
  const ans1 = await inq(lizaU, "How do I check my loyalty points?", "Where can I see my loyalty points and what can I use them for?", 70);
  const ans2 = await inq(juanU, "Store hours during the holidays", "What are your store hours on November 30 and December 24?", 50);
  const conv1 = await inq(anaU, "My card payment was declined twice", "My card was declined twice at checkout but the money left my account. Can you check what happened?", 40);
  const conv2 = await inq(juanU, "Bulk order for a school event", "Can I place a bulk order of 200 snack packs for a school event next month?", 36);
  const conv3 = await inq(lizaU, "How long does a refund for a damaged item take?", "One item in my last order was damaged. How long does a refund take and what do I need to send?", 30);
  const cls = await inq(lizaU, "Do you sell gift cards?", "Do you sell gift cards for the Calapan branch?", 110);
  const answerSql = "UPDATE inquiries SET answer = ?, status = 'answered', answered_at = ?, handled_by = ? WHERE id = ?";
  await sequelize.query(answerSql, { replacements: ["Your points show on your profile. Ask the cashier about current rewards; points can be used as a discount on your next purchase.", ago(66), agent.id, ans1.id] });
  await sequelize.query(answerSql, { replacements: ["We are open on November 30 from 8 AM to 6 PM and on December 24 from 8 AM to 5 PM.", ago(48), agent.id, ans2.id] });
  await sequelize.query(answerSql, { replacements: ["Yes, gift cards of 500 and 1000 pesos are available at the Calapan branch counter.", ago(100), agent.id, cls.id] });
  await sequelize.query("UPDATE inquiries SET status = 'closed' WHERE id = ?", { replacements: [cls.id] });
  await sequelize.query("UPDATE inquiries SET handled_by = ? WHERE id IN (?, ?, ?, ?)", { replacements: [agent.id, open1.id, conv1.id, conv2.id, conv3.id] });
  // Three inquiries became cases (Converted, linked to their case); the cases are demo cases and count toward the 40.
  await convertInquiry({ id: conv1.id, user: agent, categoryId: categories["Billing & Payment"], priority: "high", caseType: "complaint" });
  await convertInquiry({ id: conv2.id, user: agent, categoryId: categories["Product Inquiry"], priority: "medium", caseType: "service_request" });
  await convertInquiry({ id: conv3.id, user: agent, categoryId: categories["Returns & Refunds"], priority: "medium", caseType: "service_request" });
  if (walkIns[0]) {
    await createStaffInquiry({ user: agent, createdAt: ago(30), isDemo: true, values: { customer_id: walkIns[0], channel: "walk_in", subject: "Can I order by phone?", question: "Asked at the counter if orders can be placed by phone and paid on delivery.", answer: "Yes, call the store and give your name; payment on delivery is accepted for Calapan." } });
  }
  if (walkIns[1]) {
    await createStaffInquiry({ user: agent, createdAt: ago(8), isDemo: true, values: { customer_id: walkIns[1], channel: "phone", subject: "Is the Naujan branch open on holidays?", question: "Phoned to ask whether the Naujan branch opens on public holidays." } });
  }
  const due = (hours) => new Date(Date.now() + hours * H);
  const fu = (user, customerId, title, hours, priority, assignedTo, notes = null) =>
    createFollowUp({ user, at: ago(60), isDemo: true, values: { customer_id: customerId, title, notes, due: due(hours), priority, assigned_to: assignedTo, case_no: "" } });
  await fu(agent, juanU.customer_id, "Call back about the replacement order", -26, "high", agent.id, "Customer asked for a call before noon.");
  await fu(agent, anaU.customer_id, "Confirm the refund reached the card", -3, "medium", agent.id);
  await fu(agent, lizaU.customer_id, "Send the bulk price list", 2, "medium", agent.id);
  await fu(agent, walkIns[0], "Invite to register for the portal", 30, "low", agent.id);
  await fu(leader, juanU.customer_id, "Check satisfaction after the escalation", 52, "medium", agent.id, "Assigned by the Team Leader.");
  await fu(leader, anaU.customer_id, "Review the card payment case with the agent", -8, "high", leader.id);
  const doneA = await fu(agent, lizaU.customer_id, "Call about the missing eggs", -70, "high", agent.id);
  const doneB = await fu(agent, juanU.customer_id, "Ask if the milk replacement arrived", -50, "low", agent.id);
  const cancelled = await fu(agent, anaU.customer_id, "Send an old brochure", -40, "low", agent.id);
  await sequelize.query("UPDATE follow_up_tasks SET status = 'done', completed_at = ?, notes = ? WHERE id = ?", { replacements: [ago(60), "Done: spoke to the customer, replacement confirmed.", doneA.id] });
  await sequelize.query("UPDATE follow_up_tasks SET status = 'done', completed_at = ?, notes = ? WHERE id = ?", { replacements: [ago(45), "Done: it arrived.", doneB.id] });
  await sequelize.query("UPDATE follow_up_tasks SET status = 'cancelled', notes = ? WHERE id = ?", { replacements: ["Cancelled: the brochure is outdated.", cancelled.id] });

  // Sales (P5): demo promotions, campaigns and orders. Products, prices and stock come from the MOCK Inventory (never real);
  // every order, sale and refund is is_demo = 1 and its events are stored as mock (nothing is sent anywhere).
  if (isMockInventory()) {
    await syncProducts();
    const manager_ = manager; // CRM Manager creates promotions; the Team Leader approves (never the creator)
    const dt = (days) => new Date(Date.now() + days * 24 * H);
    const camp1 = await createCampaign({ user: manager_, isDemo: true, status: "active", at: ago(24 * 6), values: { name: "Rainy-season pantry stock-up", channel: "in_store", start_date: new Date(Date.now() - 6 * 24 * H).toISOString().slice(0, 10), end_date: dt(20).toISOString().slice(0, 10), description: "Pantry basics at a discount while the rainy season lasts." } });
    await createCampaign({ user: manager_, isDemo: true, status: "draft", at: ago(24), values: { name: "Payday weekend sale", channel: "mixed", start_date: dt(5).toISOString().slice(0, 10), end_date: dt(8).toISOString().slice(0, 10), description: "Planned for the next payday." } });
    const camp3 = await createCampaign({ user: manager_, isDemo: true, status: "ended", at: ago(24 * 40), values: { name: "New portal customers welcome", channel: "portal", start_date: new Date(Date.now() - 40 * 24 * H).toISOString().slice(0, 10), end_date: new Date(Date.now() - 10 * 24 * H).toISOString().slice(0, 10), description: "A welcome discount for the first order." } });
    const promo = (code, name, type, value, min, from, to, campaign, status, approved) =>
      createPromotion({ user: manager_, isDemo: true, status, approvedBy: approved ? leader.id : null, at: ago(24 * 7),
        values: { promo_code: code, name, promo_type: type, value, min_order_amount: min, applies_to: "order", product_id: null, category_name: null, start: from, end: to, usage_limit: null, campaign_id: campaign } });
    await promo("PANTRY10", "10% off pantry basics", "percent", 10, 300, dt(-6), dt(20), camp1.id, "active", true);
    await promo("WELCOME50", "PHP 50 off your first order", "fixed_amount", 50, 200, dt(-40), dt(60), camp3.id, "active", true);
    await promo("PAYDAY15", "Payday weekend 15%", "percent", 15, 1000, dt(5), dt(8), null, "pending_approval", false);
    await promo("EGGS20", "PHP 20 off egg trays", "fixed_amount", 20, 0, dt(-40), dt(-10), null, "expired", true);

    const line = (productId, qty) => ({ product_id: productId, quantity: qty });
    const addr = async (customerId) => (await select("SELECT id FROM customer_addresses WHERE customer_id = :customerId ORDER BY is_default DESC, id LIMIT 1", { customerId }))[0]?.id || null;
    const verify = async (paymentId, user) => { await verifyPayment({ paymentId, user }); await audit(null, "payment_verified", { actor: user, recordType: "payment", recordId: paymentId }); };
    const paymentOf = async (orderId) => (await select("SELECT id FROM payment_references WHERE sales_order_id = :orderId ORDER BY id LIMIT 1", { orderId }))[0].id;
    const saleOf = async (orderId) => (await select("SELECT id FROM sales_transactions WHERE sales_order_id = :orderId", { orderId }))[0].id;
    const days = (n) => new Date(Date.now() - n * 24 * H);

    // 1. Juan, portal, pickup, GCash reference verified by the agent -> ready -> completed (3 days ago); later partly refunded
    const o1 = await placeOrder({ user: juanU, fulfillment: "pickup", lines: [line("MOCK-P-1001", 2), line("MOCK-P-1003", 1), line("MOCK-P-1004", 3)], payment: { method: "gcash", reference: "GC1000456789" }, at: days(3), isDemo: true });
    await verify(await paymentOf(o1.id), agent);
    await markReady({ orderId: o1.id, user: agent });
    await completeOrder({ orderId: o1.id, user: agent, at: new Date(days(3).getTime() + 5 * H) });
    // 2. Ana, portal, delivery, Cash on Delivery: confirmed and ready, to be collected on delivery
    const o2 = await placeOrder({ user: anaU, fulfillment: "delivery", addressId: await addr(anaU.customer_id), lines: [line("MOCK-P-1002", 1), line("MOCK-P-1006", 2), line("MOCK-P-1007", 2)], payment: { method: "cod" }, at: days(1), isDemo: true });
    await markReady({ orderId: o2.id, user: agent });
    // 3. Liza, portal, delivery, Maya reference NOT verified yet (shows under "Payments to verify")
    await placeOrder({ user: lizaU, fulfillment: "delivery", addressId: await addr(lizaU.customer_id), lines: [line("MOCK-P-1005", 10), line("MOCK-P-1009", 2), line("MOCK-P-1013", 12)], payment: { method: "maya", reference: "MY8800123456" }, at: days(0.2), isDemo: true });
    // 4. Ernesto, walk-in, pickup, cash at the counter: paid and completed 2 days ago; refund requested (waiting for a decision)
    const o4 = await placeOrder({ user: agent, customerId: walkIns[0], channel: "walk_in", fulfillment: "pickup", lines: [line("MOCK-P-1010", 2), line("MOCK-P-1008", 6)], payment: { method: "cash", reference: "OR-00991" }, at: days(2), isDemo: true });
    await completeOrder({ orderId: o4.id, user: agent, at: new Date(days(2).getTime() + 0.5 * H) });
    await requestRefund({ saleRowId: await saleOf(o4.id), user: agent, amount: 58, reason: "One bread loaf was moldy", at: days(1), isDemo: true });
    // 5. Teresita, phone, delivery, Cash on Delivery, just placed
    await placeOrder({ user: agent, customerId: walkIns[1], channel: "phone", fulfillment: "delivery", addressId: await addr(walkIns[1]), lines: [line("MOCK-P-1012", 1), line("MOCK-P-1004", 2)], payment: { method: "cod" }, at: days(0.1), isDemo: true });
    // 6. Juan, phone order by the Team Leader with the PANTRY10 promo: GCash verified by the Manager, completed (4 days ago), refund approved and recorded
    const o6 = await placeOrder({ user: leader, customerId: juanU.customer_id, channel: "phone", fulfillment: "pickup", lines: [line("MOCK-P-1006", 3), line("MOCK-P-1007", 4), line("MOCK-P-1009", 2)], promoCode: "PANTRY10", payment: { method: "gcash", reference: "GC5550001122" }, at: days(4), isDemo: true });
    await verify(await paymentOf(o6.id), manager);
    await completeOrder({ orderId: o6.id, user: leader, at: new Date(days(4).getTime() + 2 * H) });
    const r6 = await requestRefund({ saleRowId: await saleOf(o6.id), user: agent, amount: 92, reason: "A bottle of cooking oil arrived leaking", returnItems: [{ product_id: "MOCK-P-1006", quantity: 1, condition: "damaged" }], at: days(3), isDemo: true });
    await decideRefund({ id: r6.id, user: leader, decision: "approve", at: days(3) });
    await recordRefund({ id: r6.id, user: leader, at: days(2.5) });
    // 7. Ana, portal: cancelled by the customer before payment
    const o7 = await placeOrder({ user: anaU, fulfillment: "pickup", lines: [line("MOCK-P-1011", 2)], payment: { method: "cod" }, at: days(2), isDemo: true });
    await cancelOrder({ orderId: o7.id, user: anaU, reason: "Changed my mind", at: days(2) });
    // 8. Liza, portal, pickup, WELCOME50: completed (5 days ago); refund rejected
    const o8 = await placeOrder({ user: lizaU, fulfillment: "pickup", lines: [line("MOCK-P-1014", 1.5), line("MOCK-P-1010", 1)], promoCode: "WELCOME50", payment: { method: "gcash", reference: "GC7770099887" }, at: days(5), isDemo: true });
    await verify(await paymentOf(o8.id), agent);
    await completeOrder({ orderId: o8.id, user: agent, at: new Date(days(5).getTime() + 4 * H) });
    const r8 = await requestRefund({ saleRowId: await saleOf(o8.id), user: agent, amount: 60, reason: "Customer says the chicken was smaller than expected", at: days(4), isDemo: true });
    await decideRefund({ id: r8.id, user: leader, decision: "reject", reason: "The weight matches the receipt", at: days(4) });
  }

  // Employee requests (P7): demo requests from the MOCK ESS (is_mock = 1, request ids DEMO-REQ-*). They exist even while APPROVALS_ENABLED=false (the queue
  // then shows its "not enabled" message). Decisions are recorded as mock events and never sent. Pending, approved, rejected and two exception cases.
  {
    const day = (n) => new Date(Date.now() + n * 24 * H).toISOString().slice(0, 10);
    const mgrEmployee = staffList.find((u) => u.role === "crm_manager").employee_id;
    const req = (n, employee, type, fields, hoursAgo) => receiveRequest({ data: { request_id: `DEMO-REQ-${String(n).padStart(4, "0")}`, request_type: type, employee_id: employee, ...fields }, isMock: true, silent: true, at: ago(hoursAgo) });
    await req(1, agentRow.employee_id, "leave", { leave_type: "Vacation leave", start_date: day(10), end_date: day(12), days: 3, reason: "Family trip" }, 20);
    await req(2, agentRow.employee_id, "overtime", { date: day(-1), start_time: "18:00", end_time: "20:30", hours: 2.5, reason: "Month-end order backlog" }, 8);
    const done = await req(3, agentRow.employee_id, "attendance_correction", { date: day(-4), time_out: "17:05", reason: "Forgot to time out" }, 90);
    await decideRequest({ id: done.id, user: leader, decision: "approve", comment: "Checked with the schedule", at: ago(80), silent: true });
    await req(4, leaderRow.employee_id, "leave", { leave_type: "Sick leave", start_date: day(-2), end_date: day(-2), days: 1, reason: "Fever" }, 30);
    const rej = await req(5, leaderRow.employee_id, "overtime", { date: day(-6), start_time: "18:00", end_time: "21:00", hours: 3, reason: "Extra cleaning" }, 130);
    await decideRequest({ id: rej.id, user: manager, decision: "reject", comment: "Overtime was not pre-approved", at: ago(120), silent: true });
    await req(6, mgrEmployee, "leave", { leave_type: "Vacation leave", start_date: day(20), end_date: day(24), days: 5, reason: "Annual vacation" }, 12);
    await req(7, "MOCK-EMP-9001", "leave", { leave_type: "Vacation leave", start_date: day(7), end_date: day(7), days: 1, reason: "From an employee who is not in CRM" }, 5);
  }

  await recomputeSegments(); // rule-based customer segments (P9)
  // updated_at = latest activity (seeded events carry past timestamps).
  await sequelize.query(
    `UPDATE customer_cases k SET k.updated_at = GREATEST(k.created_at,
        COALESCE((SELECT MAX(h.created_at) FROM case_status_history h WHERE h.case_id = k.id), k.created_at),
        COALESCE((SELECT MAX(r.created_at) FROM case_comments r WHERE r.case_id = k.id), k.created_at))
     WHERE k.is_demo = 1`
  );
  // Finished cases count as already read, so only active conversations show as "new".
  await sequelize.query(
    `INSERT IGNORE INTO case_reads (user_id, case_id, last_read_at)
     SELECT u.id, k.id, k.updated_at FROM customer_cases k JOIN crm_users u ON u.is_demo = 1 AND u.user_type = 'staff'
     WHERE k.is_demo = 1 AND k.status IN ('resolved','closed')
     UNION ALL
     SELECT ca.user_id, k.id, k.updated_at FROM customer_cases k JOIN customer_accounts ca ON ca.customer_id = k.customer_id
     WHERE k.is_demo = 1 AND k.status = 'closed'`
  );
  const [{ n: userCount }] = await select("SELECT COUNT(*) AS n FROM crm_users WHERE is_demo = 1");
  console.log(`✅ Seeded ${userCount} demo logins, ${DEMO_CUSTOMERS.length} demo customers and ${count} demo cases. Password for all demo accounts: ${DEMO_PASSWORD}`);
};

// Removes ONLY demo rows: is_demo = 1 records, then the demo team and MOCK HR references that nothing real uses.
const clear = async () => {
  await sequelize.transaction(async (transaction) => {
    const q = (sql, replacements = {}) => sequelize.query(sql, { transaction, replacements });
    // Employee requests (P7): only the demo ones (DEMO-REQ-*) and their mock decision events; requests made through the setup mock ESS are never touched.
    await q("DELETE FROM crm_notifications WHERE related_type = 'approval' AND related_id IN (SELECT id FROM approval_requests WHERE request_id LIKE 'DEMO-REQ-%')");
    await q("DELETE FROM integration_outbox WHERE event_type = 'EmployeeRequestDecided' AND entity_id LIKE 'DEMO-REQ-%'");
    await q("DELETE FROM approval_requests WHERE request_id LIKE 'DEMO-REQ-%'");
    // Loyalty (P8): the points that demo sales earned, demo refunds took back and demo orders redeemed. Real points are never touched;
    // balances are recomputed from what is left, and an account goes only if it has no real activity left.
    const [demoRedemptions] = await q("SELECT lr.id, lr.redeem_transaction_id, lr.return_transaction_id FROM loyalty_redemptions lr JOIN sales_orders o ON o.id = lr.sales_order_id WHERE o.is_demo = 1");
    if (demoRedemptions.length) {
      await q("DELETE FROM loyalty_redemptions WHERE id IN (:ids)", { ids: demoRedemptions.map((r) => r.id) });
      const txnIds = demoRedemptions.flatMap((r) => [r.redeem_transaction_id, r.return_transaction_id]).filter(Boolean);
      if (txnIds.length) await q("DELETE FROM loyalty_transactions WHERE id IN (:ids)", { ids: txnIds });
    }
    await q(`DELETE t FROM loyalty_transactions t LEFT JOIN sales_transactions s ON s.id = t.sales_transaction_id LEFT JOIN refunds rf ON rf.id = t.refund_id
             LEFT JOIN sales_transactions s2 ON s2.id = rf.sales_transaction_id WHERE s.is_demo = 1 OR s2.is_demo = 1`);
    await q("UPDATE loyalty_accounts a SET points_balance = GREATEST(0, (SELECT COALESCE(SUM(t.points), 0) FROM loyalty_transactions t WHERE t.loyalty_account_id = a.id))");
    await q("DELETE a FROM loyalty_accounts a JOIN customers c ON c.id = a.customer_id WHERE c.is_demo = 1 AND NOT EXISTS (SELECT 1 FROM loyalty_transactions t WHERE t.loyalty_account_id = a.id)");
    // Sales (P5): demo events, refunds, payments, sales, orders, promotions and campaigns. Non-demo orders and promotions are never touched.
    await q(`DELETE FROM integration_outbox WHERE entity_id IN (
               SELECT order_id FROM sales_orders WHERE is_demo = 1
               UNION SELECT sale_id FROM sales_transactions WHERE is_demo = 1
               UNION SELECT r.refund_id FROM refunds r JOIN sales_transactions st ON st.id = r.sales_transaction_id WHERE st.is_demo = 1)`);
    await q("DELETE r FROM refunds r JOIN sales_transactions st ON st.id = r.sales_transaction_id WHERE st.is_demo = 1");
    await q("DELETE p FROM payment_references p JOIN sales_orders o ON o.id = p.sales_order_id WHERE o.is_demo = 1");
    await q("DELETE FROM sales_transactions WHERE is_demo = 1");
    await q("DELETE FROM sales_orders WHERE is_demo = 1");
    await q("DELETE FROM promotions WHERE is_demo = 1 AND NOT EXISTS (SELECT 1 FROM promotion_redemptions r WHERE r.promotion_id = promotions.id)");
    await q("DELETE FROM campaigns WHERE is_demo = 1 AND NOT EXISTS (SELECT 1 FROM promotions p WHERE p.campaign_id = campaigns.id)");
    await q("DELETE FROM follow_up_tasks WHERE is_demo = 1");
    await q("DELETE FROM customer_interactions WHERE is_demo = 1");
    await q("DELETE aa FROM agent_assignments aa JOIN customers c ON c.id = aa.customer_id WHERE c.is_demo = 1");
    await q("DELETE FROM customer_feedback WHERE is_demo = 1");
    await q("DELETE FROM customer_ratings WHERE is_demo = 1");
    await q("UPDATE inquiries SET converted_case_id = NULL WHERE converted_case_id IN (SELECT id FROM customer_cases WHERE is_demo = 1)");
    await q("DELETE FROM inquiries WHERE is_demo = 1");
    const [, casesMeta] = await q("DELETE FROM customer_cases WHERE is_demo = 1");
    // Demo customers and logins are removed only if nothing real points at them.
    await q(`DELETE ca FROM customer_accounts ca JOIN customers c ON c.id = ca.customer_id
             WHERE c.is_demo = 1 AND NOT EXISTS (SELECT 1 FROM customer_cases k WHERE k.customer_id = c.id)
               AND NOT EXISTS (SELECT 1 FROM sales_orders o WHERE o.customer_id = c.id)`);
    await q(`DELETE c FROM customers c WHERE c.is_demo = 1
             AND NOT EXISTS (SELECT 1 FROM customer_cases k WHERE k.customer_id = c.id)
             AND NOT EXISTS (SELECT 1 FROM sales_orders o WHERE o.customer_id = c.id)
             AND NOT EXISTS (SELECT 1 FROM customer_accounts ca WHERE ca.customer_id = c.id)`);
    await q(`DELETE u FROM crm_users u WHERE u.is_demo = 1
             AND NOT EXISTS (SELECT 1 FROM case_comments r WHERE r.author_id = u.id)
             AND NOT EXISTS (SELECT 1 FROM case_assignments a WHERE a.agent_id = u.id)
             AND NOT EXISTS (SELECT 1 FROM ticket_escalations e WHERE e.escalated_by = u.id)
             AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.uploaded_by = u.id)
             AND NOT EXISTS (SELECT 1 FROM customer_accounts ca WHERE ca.user_id = u.id)
             AND NOT EXISTS (SELECT 1 FROM refunds rf WHERE rf.requested_by = u.id OR rf.approved_by = u.id)
             AND NOT EXISTS (SELECT 1 FROM promotions pr WHERE pr.created_by = u.id OR pr.approved_by = u.id)
             AND NOT EXISTS (SELECT 1 FROM approval_requests ar WHERE ar.requester_user_id = u.id OR ar.approver_user_id = u.id OR ar.decided_by = u.id)`);
    // Demo staff logins that cannot be deleted (history points at them) are deactivated so they no longer sign in or show on the login page.
    const [, deactivated] = await q("UPDATE crm_users SET is_active = 0 WHERE is_demo = 1 AND user_type = 'staff' AND is_active = 1");
    if (deactivated?.affectedRows) console.log(`ℹ️  Deactivated ${deactivated.affectedRows} demo staff login(s) that real records still refer to.`);
    // The demo team and the MOCK HR references go once no login or case uses them (teams/references have no is_demo flag).
    await q(`DELETE t FROM crm_teams t WHERE t.team_code IN (:codes)
             AND NOT EXISTS (SELECT 1 FROM crm_users u WHERE u.team_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM customer_cases k WHERE k.team_id = t.id)`, { codes: DEMO_TEAM_CODES });
    await q(`DELETE e FROM employee_references e WHERE e.is_mock = 1
             AND NOT EXISTS (SELECT 1 FROM crm_users u WHERE u.employee_id = e.employee_id)`);
    // Numbering starts again from 1 only when no record of that kind is left.
    await q(`DELETE FROM number_sequences WHERE scope = 'case' AND NOT EXISTS (SELECT 1 FROM customer_cases)`);
    await q(`DELETE FROM number_sequences WHERE scope = 'customer' AND NOT EXISTS (SELECT 1 FROM customers)`);
    const [[{ n: kept }]] = await sequelize.query("SELECT COUNT(*) AS n FROM crm_users WHERE is_demo = 1", { transaction });
    console.log(`🧹 Removed ${casesMeta?.affectedRows ?? "the"} demo case(s), the demo customers/logins not linked to real records, and unused demo team / MOCK HR references.`);
    if (Number(kept)) console.log(`ℹ️  Kept ${kept} demo login(s) that are linked to real records.`);
  });
};

try {
  if (process.env.NODE_ENV === "production") {
    console.error("❌ Refusing to run: NODE_ENV=production. The demo seeder never runs against a production environment.");
    process.exitCode = 1;
  } else if (process.argv.includes("--clear")) {
    await clear();
  } else {
    if (process.argv.includes("--reset")) await clear();
    await seed();
  }
} catch (err) {
  console.error("❌ Seeding failed:", err.message);
  if (process.env.DEBUG_SEED) console.error(err);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
