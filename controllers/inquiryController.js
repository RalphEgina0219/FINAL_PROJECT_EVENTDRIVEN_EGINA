// Inquiries: staff pages (/crm/inquiries, scoped) and the customer's own pages (/portal/inquiries).
// Rules and record scope live in services/inquiryService.js and are checked on every request.
import {
  listInquiries, findInquiry, inquiryCounts, validateInquiry, submitPortalInquiry, createStaffInquiry, answerInquiry, convertInquiry,
  closeInquiry, takeInquiry, assignInquiry, canWork, INQUIRY_STATUS_LABELS, INQUIRY_CHANNEL_LABELS, STAFF_INQUIRY_CHANNELS, MIN_ANSWER_LENGTH,
} from "../services/inquiryService.js";
import { pickableCustomers, findCustomerForUser } from "../services/customerMasterService.js";
import { assignableAgents } from "../services/caseService.js";
import { CaseCategory, CASE_PRIORITIES, CASE_TYPES } from "../models/index.js";
import { audit } from "../services/auditService.js";
import { can } from "../services/permissionService.js";
import { buildPagination } from "../helpers/pagination.js";
import { clean, cleanText, toId, toPage, oneOf } from "../helpers/validators.js";
import { PRIORITY_LABELS, CASE_TYPE_LABELS } from "../helpers/labels.js";
import { AppError } from "../helpers/errors.js";
import { CUSTOMER_AREA_TABS } from "../helpers/navigation.js";

const areaTabs = CUSTOMER_AREA_TABS.map(([label, href]) => ({ label, href, active: label === "Inquiries" }));
const pairs = (obj, keys) => keys.map((value) => ({ value, label: obj[value] }));
const notFound = (res) => res.status(404).render("error", { title: "Inquiry not found", status: 404, message: "This inquiry does not exist or is not in your scope." });
const view = (r) => ({ ...r, status_label: INQUIRY_STATUS_LABELS[r.status], channel_label: INQUIRY_CHANNEL_LABELS[r.channel] });
const activeCategories = () => CaseCategory.findAll({ where: { is_active: true }, attributes: ["id", "name", "default_priority"], order: [["name", "ASC"]], raw: true });

// ---------------------------------------------------------------- staff: list, new, show

export const index = async (req, res) => {
  const filters = {
    q: clean(req.query.q, 80), status: oneOf(req.query.status, Object.keys(INQUIRY_STATUS_LABELS)) || "",
    channel: oneOf(req.query.channel, Object.keys(INQUIRY_CHANNEL_LABELS)) || "", mine: req.query.mine === "1",
  };
  const first = await listInquiries(req.user, { ...filters, limit: 1, offset: 0 });
  const pagination = buildPagination({
    total: first.total, page: toPage(req.query.page), perPage: 15, basePath: "/crm/inquiries",
    query: { q: filters.q, status: filters.status, channel: filters.channel, mine: filters.mine ? "1" : "" },
  });
  const [{ rows }, counts] = await Promise.all([listInquiries(req.user, { ...filters, limit: pagination.limit, offset: pagination.offset }), inquiryCounts(req.user)]);
  res.render("inquiries/index", {
    title: "Inquiries", areaTabs, rows: rows.map(view), filters, pagination, counts, canCreate: can(req.user, "inquiries.create"),
    statusOptions: Object.entries(INQUIRY_STATUS_LABELS).map(([value, label]) => ({ value, label, sel: value === filters.status })),
    channelOptions: Object.entries(INQUIRY_CHANNEL_LABELS).map(([value, label]) => ({ value, label, sel: value === filters.channel })),
    hasFilters: Boolean(filters.q || filters.status || filters.channel || filters.mine),
  });
};

const newModel = async (user, form, errors = []) => {
  const customerId = toId(form.customer_id);
  const customers = await pickableCustomers(user);
  if (customerId && !customers.some((c) => c.id === customerId)) {
    const c = await findCustomerForUser(customerId, user);
    if (c) customers.unshift({ id: c.id, customer_no: c.customer_no, name: `${c.first_name} ${c.last_name}` });
  }
  return {
    title: "Record an inquiry", areaTabs, form, errors, minAnswer: MIN_ANSWER_LENGTH,
    customers: customers.map((c) => ({ ...c, sel: c.id === customerId })),
    channelOptions: STAFF_INQUIRY_CHANNELS.map((value) => ({ value, label: INQUIRY_CHANNEL_LABELS[value], sel: value === form.channel })),
  };
};

export const newForm = async (req, res) => res.render("inquiries/new", await newModel(req.user, { channel: "phone", customer_id: toId(req.query.customer_id) ? String(toId(req.query.customer_id)) : "" }));

export const create = async (req, res) => {
  const raw = {
    customer_id: toId(req.body.customer_id), channel: oneOf(req.body.channel, STAFF_INQUIRY_CHANNELS) || "", subject: clean(req.body.subject, 150),
    question: cleanText(req.body.question, 3000), answer: cleanText(req.body.answer, 2000),
  };
  const { errors, values } = validateInquiry(raw, { staff: true });
  const form = { ...raw, customer_id: raw.customer_id ? String(raw.customer_id) : "" };
  if (errors.length) { res.status(422); return res.render("inquiries/new", await newModel(req.user, form, errors)); }
  let out;
  try {
    out = await createStaffInquiry({ user: req.user, values });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    res.status(err.status === 404 ? 404 : 422);
    return res.render("inquiries/new", await newModel(req.user, err.status === 404 ? { ...form, customer_id: "" } : form, [err.status === 404 ? "Choose a customer from the list." : err.message]));
  }
  await audit(req, "inquiry_created", { recordType: "inquiry", recordId: out.inquiry_no, after: { channel: values.channel, answered: out.answered, customer_id: values.customer_id } });
  req.flash("success_msg", `Inquiry ${out.inquiry_no} was recorded${out.answered ? " and answered" : ""}.`);
  res.redirect(`/crm/inquiries/${out.id}`);
};

export const show = async (req, res) => {
  const id = toId(req.params.id);
  const inq = id ? await findInquiry(id, req.user) : null;
  if (!inq) return notFound(res);
  const open = ["open", "answered"].includes(inq.status);
  const work = canWork(inq, req.user);
  const canAnswer = can(req.user, "inquiries.answer") && work && inq.status === "open";
  const canConvert = can(req.user, "inquiries.answer") && work && open;
  const canClose = can(req.user, "inquiries.answer") && work && inq.status === "answered";
  const canAssign = can(req.user, "inquiries.assign") && open;
  const canTake = req.user.role === "agent" && inq.status === "open" && !inq.handled_by;
  const [categories, agents] = await Promise.all([canConvert ? activeCategories() : [], canAssign ? assignableAgents(req.user) : []]);
  res.render("inquiries/show", {
    title: inq.inquiry_no, areaTabs, i: view(inq), canAnswer, canConvert, canClose, canAssign, canTake, minAnswer: MIN_ANSWER_LENGTH,
    canFollowUp: can(req.user, "followups.manage"),
    handledByOther: inq.handled_by && Number(inq.handled_by) !== req.user.id && req.user.role === "agent",
    categories: categories.map((c) => ({ ...c, sel: false })),
    priorityOptions: CASE_PRIORITIES.map((value) => ({ value, label: PRIORITY_LABELS[value], sel: value === "medium" })),
    typeOptions: CASE_TYPES.map((value) => ({ value, label: CASE_TYPE_LABELS[value], sel: value === "inquiry" })),
    agents: agents.map((a) => ({ ...a, current: Number(a.id) === Number(inq.handled_by) })),
  });
};

// ---------------------------------------------------------------- staff actions (POST, then back to the inquiry)

const action = (name, fn) => async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return notFound(res);
  let target = `/crm/inquiries/${id}`;
  try {
    const message = await fn(req, id);
    if (message && typeof message === "object") { target = message.redirect || target; if (message.text) req.flash("success_msg", message.text); }
    else if (message) req.flash("success_msg", message);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.status === 404) return notFound(res);
    if (err.status === 403) {
      await audit(req, "access_denied", { outcome: "denied", recordType: "inquiry", recordId: id, details: `${name}: ${err.message}` });
      return res.status(403).render("error", { title: "Access denied", status: 403, message: err.message });
    }
    req.flash("error_msg", err.message);
  }
  res.redirect(target);
};

export const answer = action("answer", async (req, id) => {
  const text = cleanText(req.body.answer, 2000);
  const inq = await answerInquiry({ id, user: req.user, answer: text });
  await audit(req, "inquiry_answered", { recordType: "inquiry", recordId: inq.inquiry_no, after: { status: "answered" } });
  return "Answer sent. The customer was notified.";
});

export const convert = action("convert", async (req, id) => {
  const categoryId = toId(req.body.category_id);
  const priority = oneOf(req.body.priority, CASE_PRIORITIES);
  const caseType = oneOf(req.body.case_type, CASE_TYPES);
  if (!categoryId || !(await activeCategories()).some((c) => c.id === categoryId)) throw new AppError("Choose a category for the case.");
  if (!priority) throw new AppError("Choose a priority for the case.");
  if (!caseType) throw new AppError("Choose the type of case.");
  const out = await convertInquiry({ id, user: req.user, categoryId, priority, caseType });
  await audit(req, "inquiry_converted", { recordType: "inquiry", recordId: out.inquiry.inquiry_no, before: { status: out.inquiry.status }, after: { status: "converted", case_no: out.case.case_no } });
  return { text: `Inquiry converted to case ${out.case.case_no}.`, redirect: `/crm/inquiries/${id}` };
});

export const close = action("close", async (req, id) => {
  const inq = await closeInquiry({ id, user: req.user });
  await audit(req, "inquiry_closed", { recordType: "inquiry", recordId: inq.inquiry_no, before: { status: inq.status }, after: { status: "closed" } });
  return "Inquiry closed.";
});

export const take = action("take", async (req, id) => {
  const inq = await takeInquiry({ id, user: req.user });
  await audit(req, "inquiry_assigned", { recordType: "inquiry", recordId: inq.inquiry_no, before: { handled_by: null }, after: { handled_by: req.user.id } });
  return "You are now handling this inquiry.";
});

export const assign = action("assign", async (req, id) => {
  const agentId = toId(req.body.agent_id);
  if (!agentId) throw new AppError("Choose an agent.");
  const out = await assignInquiry({ id, actor: req.user, agentId });
  await audit(req, "inquiry_assigned", {
    recordType: "inquiry", recordId: out.row.inquiry_no, before: { handled_by: out.previous }, after: { handled_by: out.agent.id, customer_assigned_too: out.assignedCustomer },
  });
  return `Inquiry assigned to ${out.agent.name}${out.assignedCustomer ? " (and the customer, who had no agent)" : ""}.`;
});

// ---------------------------------------------------------------- customer portal

const portalModel = async (user, form = {}, errors = []) => {
  const { rows } = await listInquiries(user, { limit: 50, offset: 0 });
  return { title: "Submit Inquiry", form, errors, inquiries: rows.map(view) };
};

export const portalIndex = async (req, res) => res.render("inquiries/portal_index", await portalModel(req.user));

export const portalCreate = async (req, res) => {
  const raw = { subject: clean(req.body.subject, 150), question: cleanText(req.body.question, 3000) };
  const { errors, values } = validateInquiry(raw, { staff: false });
  if (errors.length) { res.status(422); return res.render("inquiries/portal_index", await portalModel(req.user, raw, errors)); }
  const inq = await submitPortalInquiry({ user: req.user, values });
  await audit(req, "inquiry_submitted", { recordType: "inquiry", recordId: inq.inquiry_no });
  req.flash("success_msg", `Your inquiry ${inq.inquiry_no} was sent. We will answer it here and notify you.`);
  res.redirect(`/portal/inquiries/${inq.id}`);
};

export const portalShow = async (req, res) => {
  const id = toId(req.params.id);
  const inq = id ? await findInquiry(id, req.user) : null;
  if (!inq) return notFound(res);
  res.render("inquiries/portal_show", { title: inq.inquiry_no, i: view(inq) });
};
