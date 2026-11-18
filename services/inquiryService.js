/*
 * Inquiries, P4 (blueprint: Agent "Inquiries", Customer "Submit Inquiry"). A customer asks a question
 * (portal) or staff record one received by phone, walk-in, SMS, social or email. Staff answer it, or convert it
 * into a case when it needs real handling. Status flow (enforced here):
 *   open -> answered            (answer given)
 *   open | answered -> converted (a case was opened from it; the inquiry keeps a link to the case)
 *   answered -> closed           (nothing more to do)
 * Record scope (applied in SQL on every read, and again on every action):
 *   customer      own inquiries only
 *   agent         inquiries handled by the agent, or from customers in the agent's customer scope
 *   team_leader   inquiries from customers in the team's scope (which includes unrouted customers), or handled by a team agent
 *   crm_manager   every inquiry
 * Only the handler (or a Team Leader / the Manager in scope) may answer; an unclaimed inquiry may be taken by any
 * agent who can see it.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { AppError } from "../helpers/errors.js";
import { directoryScope } from "./customerService.js";
import { buildStaffCase, afterStaffCase, STAFF_CASE_CHANNELS } from "./caseService.js";
import { nextDailyNumber } from "./numberService.js";
import { notify, userIdsByRole } from "./notificationService.js";

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
const exec = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction });

export const INQUIRY_STATUS_LABELS = { open: "Open", answered: "Answered", converted: "Converted to case", closed: "Closed" };
export const INQUIRY_CHANNEL_LABELS = { portal: "Customer portal", phone: "Phone", walk_in: "Walk-in", sms: "SMS", social: "Social media", email: "Email" };
export const STAFF_INQUIRY_CHANNELS = STAFF_CASE_CHANNELS; // same five channels as staff-created cases
export const MIN_ANSWER_LENGTH = 10;
const INTERACTION_FOR_CHANNEL = { phone: "call", walk_in: "visit", sms: "sms", email: "email", social: "chat", portal: "portal" };

// ---------------------------------------------------------------- scope

export const inquiryScope = (user) => {
  if (user.role === "customer") return { sql: "i.customer_id = :viewerCustomerId", params: { viewerCustomerId: user.customer_id || 0 } };
  if (user.role === "crm_manager") return { sql: "1=1", params: {} };
  const cs = directoryScope(user); // refers to the customers alias `c`
  if (user.role === "agent") return { sql: `(i.handled_by = :viewer OR ${cs.sql})`, params: { ...cs.params, viewer: user.id } };
  if (user.role === "team_leader") {
    return { sql: `(${cs.sql} OR EXISTS (SELECT 1 FROM crm_users h WHERE h.id = i.handled_by AND h.team_id = :inqTeamId))`, params: { ...cs.params, inqTeamId: user.team_id || 0 } };
  }
  return { sql: "1=0", params: {} };
};

// May this staff member work on (answer / convert / close) the inquiry?
export const canWork = (inq, user) => {
  if (user.role === "crm_manager" || user.role === "team_leader") return true; // already inside their scope
  if (user.role === "agent") return !inq.handled_by || Number(inq.handled_by) === Number(user.id);
  return false;
};

const COLUMNS = `i.id, i.inquiry_no, i.customer_id, i.channel, i.subject, i.question, i.answer, i.status, i.handled_by, i.converted_case_id,
  i.answered_at, i.created_by, i.is_demo, i.created_at,
  c.customer_no, CONCAT(c.first_name, ' ', c.last_name) AS customer_name,
  h.display_name AS handler_name, k.case_no AS converted_case_no, cb.display_name AS created_by_name`;
const FROM = `FROM inquiries i
  JOIN customers c ON c.id = i.customer_id
  LEFT JOIN crm_users h ON h.id = i.handled_by
  LEFT JOIN crm_users cb ON cb.id = i.created_by
  LEFT JOIN customer_cases k ON k.id = i.converted_case_id`;

export const listInquiries = async (user, { q, status, channel, mine, limit, offset }) => {
  const scope = inquiryScope(user);
  const where = [scope.sql];
  const params = { ...scope.params };
  if (q) {
    where.push("(i.inquiry_no LIKE :q OR i.subject LIKE :q OR i.question LIKE :q OR c.customer_no LIKE :q OR CONCAT(c.first_name, ' ', c.last_name) LIKE :q)");
    params.q = `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
  }
  if (status) { where.push("i.status = :status"); params.status = status; }
  if (channel) { where.push("i.channel = :channel"); params.channel = channel; }
  if (mine) { where.push("i.handled_by = :me"); params.me = user.id; }
  const [{ total }] = await select(`SELECT COUNT(*) AS total ${FROM} WHERE ${where.join(" AND ")}`, params);
  const rows = await select(
    `SELECT ${COLUMNS} ${FROM} WHERE ${where.join(" AND ")} ORDER BY FIELD(i.status,'open','answered','converted','closed'), i.created_at DESC, i.id DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset }
  );
  return { total: Number(total), rows };
};

export const findInquiry = async (id, user) => {
  const scope = inquiryScope(user);
  const [row] = await select(`SELECT ${COLUMNS} ${FROM} WHERE i.id = :id AND ${scope.sql}`, { id, ...scope.params });
  return row || null;
};

export const inquiryCounts = async (user) => {
  const scope = inquiryScope(user);
  const [row] = await select(
    `SELECT COALESCE(SUM(i.status = 'open'), 0) AS open_count, COALESCE(SUM(i.status = 'open' AND i.handled_by IS NULL), 0) AS unclaimed,
            COALESCE(SUM(i.status = 'answered'), 0) AS answered_count, COUNT(*) AS total
     ${FROM} WHERE ${scope.sql}`, scope.params);
  return { open: Number(row.open_count), unclaimed: Number(row.unclaimed), answered: Number(row.answered_count), total: Number(row.total) };
};

// ---------------------------------------------------------------- validation

export const validateInquiry = (raw, { staff }) => {
  const errors = [];
  const v = { subject: raw.subject, question: raw.question, channel: raw.channel, customer_id: raw.customer_id, answer: raw.answer };
  if (!v.subject || v.subject.length < 5) errors.push("Give the inquiry a subject (at least 5 characters).");
  if (!v.question || v.question.length < 10) errors.push("Write the question in at least 10 characters.");
  if (staff) {
    if (!v.customer_id) errors.push("Choose the customer.");
    if (!STAFF_INQUIRY_CHANNELS.includes(v.channel)) errors.push("Choose how the inquiry reached us.");
    if (v.answer && v.answer.length < MIN_ANSWER_LENGTH) errors.push(`The answer must be at least ${MIN_ANSWER_LENGTH} characters, or leave it empty to answer later.`);
  }
  return { errors, values: v };
};

// ---------------------------------------------------------------- create

const customerUserId = async (customerId, transaction) => {
  const [row] = await select("SELECT user_id FROM customer_accounts WHERE customer_id = :customerId AND status = 'active'", { customerId }, transaction);
  return row ? row.user_id : null;
};

// Who hears about a new inquiry: the customer's agent if there is one, otherwise the Team Leaders and Managers.
const recipientsForNew = async (customerId) => {
  const [a] = await select("SELECT agent_id FROM agent_assignments WHERE customer_id = :customerId AND ended_at IS NULL ORDER BY id DESC LIMIT 1", { customerId });
  return a ? [a.agent_id, ...(await userIdsByRole("team_leader"))] : await userIdsByRole("team_leader", "crm_manager");
};

export const submitPortalInquiry = async ({ user, values, createdAt = null, isDemo = false }) => {
  if (user.role !== "customer" || !user.customer_id) throw new AppError("Only customers can submit inquiries from the portal.", 403);
  const inq = await sequelize.transaction(async (transaction) => {
    const now = createdAt || new Date();
    const no = await nextDailyNumber("inquiry", now, transaction);
    const [id] = await sequelize.query(
      `INSERT INTO inquiries (inquiry_no, customer_id, channel, subject, question, status, created_by, is_demo, created_at, updated_at)
       VALUES (?, ?, 'portal', ?, ?, 'open', ?, ?, ?, ?)`,
      { replacements: [no, user.customer_id, values.subject, values.question, user.id, isDemo ? 1 : 0, now, now], transaction }
    );
    return { id, inquiry_no: no };
  });
  if (!createdAt) {
    await notify(await recipientsForNew(user.customer_id), {
      type: "new_case", title: `New inquiry ${inq.inquiry_no}`, message: `${user.name}: ${values.subject}`, link: `/crm/inquiries/${inq.id}`, relatedType: "inquiry", relatedId: inq.id,
    });
  }
  return inq;
};

// Staff record an inquiry received by phone, walk-in, SMS, social or email, optionally with the answer given on the spot.
export const createStaffInquiry = async ({ user, values, createdAt = null, isDemo = false }) => {
  const result = await sequelize.transaction(async (transaction) => {
    const scope = directoryScope(user);
    const [customer] = await select(`SELECT c.id, c.customer_no FROM customers c WHERE c.id = :id AND c.status <> 'merged' AND ${scope.sql}`, { id: values.customer_id, ...scope.params }, transaction);
    if (!customer) throw new AppError("Customer not found.", 404);
    const now = createdAt || new Date();
    const no = await nextDailyNumber("inquiry", now, transaction);
    const answered = Boolean(values.answer);
    const [id] = await sequelize.query(
      `INSERT INTO inquiries (inquiry_no, customer_id, channel, subject, question, answer, status, handled_by, answered_at, created_by, is_demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      { replacements: [no, customer.id, values.channel, values.subject, values.question, answered ? values.answer : null, answered ? "answered" : "open", user.id, answered ? now : null, user.id, isDemo ? 1 : 0, now, now], transaction }
    );
    await exec(
      `INSERT INTO customer_interactions (customer_id, crm_user_id, interaction_type, direction, subject, summary, related_type, related_id, occurred_at, is_demo)
       VALUES (?, ?, ?, 'inbound', ?, ?, 'inquiry', ?, ?, ?)`,
      [customer.id, user.id, INTERACTION_FOR_CHANNEL[values.channel], `Inquiry ${no}: ${values.subject}`.slice(0, 150), values.question.slice(0, 2000), id, now, isDemo ? 1 : 0], transaction
    );
    return { id, inquiry_no: no, customerId: customer.id, answered };
  });
  if (!createdAt && result.answered) await notifyAnswered(result.id, result.customerId, result.inquiry_no, values.subject);
  return result;
};

const notifyAnswered = async (id, customerId, no, subject) =>
  notify(await customerUserId(customerId), { type: "new_reply", title: `Your inquiry ${no} was answered`, message: subject, link: `/portal/inquiries/${id}`, relatedType: "inquiry", relatedId: id });

// ---------------------------------------------------------------- actions

const lockInquiry = async (id, user, transaction) => {
  const scope = inquiryScope(user);
  const [row] = await select(`SELECT i.* FROM inquiries i JOIN customers c ON c.id = i.customer_id WHERE i.id = :id AND ${scope.sql} FOR UPDATE`, { id, ...scope.params }, transaction);
  if (!row) throw new AppError("Inquiry not found.", 404);
  return row;
};

const requireWork = (inq, user) => {
  if (!canWork(inq, user)) throw new AppError("This inquiry is handled by another agent.", 403);
};

export const answerInquiry = async ({ id, user, answer }) => {
  const inq = await sequelize.transaction(async (transaction) => {
    const row = await lockInquiry(id, user, transaction);
    requireWork(row, user);
    if (row.status !== "open") throw new AppError(`This inquiry is already ${INQUIRY_STATUS_LABELS[row.status].toLowerCase()}.`, 422);
    if (String(answer || "").trim().length < MIN_ANSWER_LENGTH) throw new AppError(`Write the answer in at least ${MIN_ANSWER_LENGTH} characters.`, 422);
    await exec("UPDATE inquiries SET answer = ?, status = 'answered', answered_at = NOW(), handled_by = COALESCE(handled_by, ?) WHERE id = ?", [String(answer).trim(), user.id, id], transaction);
    return row;
  });
  await notifyAnswered(id, inq.customer_id, inq.inquiry_no, inq.subject);
  return inq;
};

// Opens a case from the inquiry (same transaction as the status change). The question becomes the case description.
export const convertInquiry = async ({ id, user, categoryId, priority, caseType }) => {
  const out = await sequelize.transaction(async (transaction) => {
    const row = await lockInquiry(id, user, transaction);
    requireWork(row, user);
    if (!["open", "answered"].includes(row.status)) throw new AppError(`This inquiry is already ${INQUIRY_STATUS_LABELS[row.status].toLowerCase()}.`, 422);
    const description = row.answer ? `${row.question}\n\nAnswer already given: ${row.answer}` : row.question;
    const built = await buildStaffCase({
      user, customerId: row.customer_id, scopeChecked: true, isDemo: Boolean(row.is_demo),
      data: { case_type: caseType, category_id: categoryId, subject: row.subject, description: description.slice(0, 5000), priority, channel: row.channel, order_reference: null },
    }, transaction);
    await exec("UPDATE inquiries SET status = 'converted', converted_case_id = ?, handled_by = COALESCE(handled_by, ?) WHERE id = ?", [built.k.id, user.id, id], transaction);
    return { inquiry: row, built };
  });
  const k = await afterStaffCase(user, out.built);
  await notify(await customerUserId(out.inquiry.customer_id), {
    type: "status_change", caseId: k.id, title: `Your inquiry ${out.inquiry.inquiry_no} became case ${k.case_no}`, message: "A member of our team will handle it. You can follow it under Complaint / Feedback.",
  });
  return { case: k, inquiry: out.inquiry };
};

export const closeInquiry = async ({ id, user }) =>
  sequelize.transaction(async (transaction) => {
    const row = await lockInquiry(id, user, transaction);
    requireWork(row, user);
    if (row.status !== "answered") throw new AppError("Only an answered inquiry can be closed. Answer it or convert it to a case first.", 422);
    await exec("UPDATE inquiries SET status = 'closed' WHERE id = ?", [id], transaction);
    return row;
  });

// An agent claims an unclaimed inquiry she can see.
export const takeInquiry = async ({ id, user }) =>
  sequelize.transaction(async (transaction) => {
    if (user.role !== "agent") throw new AppError("Only an agent can take an inquiry; Team Leaders assign them.", 403);
    const row = await lockInquiry(id, user, transaction);
    if (row.status !== "open") throw new AppError("Only an open inquiry can be taken.", 422);
    if (row.handled_by) throw new AppError("This inquiry already has a handler.", 422);
    await exec("UPDATE inquiries SET handled_by = ? WHERE id = ?", [user.id, id], transaction);
    return row;
  });

/*
 * Team Leaders (own team's agents) and the Manager (any agent) assign an inquiry. If the customer has no assigned
 * agent yet, the same agent also becomes the customer's agent, so the handler can open the customer.
 */
export const assignInquiry = async ({ id, actor, agentId }) => {
  const out = await sequelize.transaction(async (transaction) => {
    if (!["team_leader", "crm_manager"].includes(actor.role)) throw new AppError("Only a Team Leader or the CRM Manager can assign inquiries.", 403);
    const row = await lockInquiry(id, actor, transaction);
    if (!["open", "answered"].includes(row.status)) throw new AppError("This inquiry is finished and cannot be reassigned.", 422);
    const [agent] = await select(
      `SELECT u.id, u.display_name AS name, u.team_id FROM crm_users u
       JOIN employee_references e ON e.employee_id = u.employee_id AND e.employment_status IN ('active','on_leave')
       WHERE u.id = :agentId AND u.role = 'agent' AND u.is_active = 1 AND u.access_revoked_at IS NULL`, { agentId }, transaction);
    if (!agent) throw new AppError("Choose an active agent.", 422);
    if (actor.role === "team_leader" && Number(agent.team_id) !== Number(actor.team_id)) throw new AppError("Team Leaders can assign only agents from their own team.", 403);
    if (Number(row.handled_by) === Number(agent.id)) throw new AppError(`This inquiry is already assigned to ${agent.name}.`, 422);
    await exec("UPDATE inquiries SET handled_by = ? WHERE id = ?", [agent.id, id], transaction);
    const [assigned] = await select("SELECT id FROM agent_assignments WHERE customer_id = :customerId AND ended_at IS NULL", { customerId: row.customer_id }, transaction);
    if (!assigned) {
      await exec("INSERT INTO agent_assignments (customer_id, agent_id, assigned_by, assigned_at, note) VALUES (?, ?, ?, NOW(), ?)", [row.customer_id, agent.id, actor.id, `Assigned with inquiry ${row.inquiry_no}`], transaction);
    }
    return { row, agent, previous: row.handled_by, assignedCustomer: !assigned };
  });
  await notify(out.agent.id, {
    type: "assignment", title: `Inquiry ${out.row.inquiry_no} was assigned to you`, message: out.row.subject, link: `/crm/inquiries/${id}`, relatedType: "inquiry", relatedId: id,
  });
  return out;
};
