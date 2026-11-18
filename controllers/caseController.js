// Case pages and actions (customers: /portal/cases, staff: /crm/cases). Access rules live in
// services/caseService.js and are checked on every request, not only by hiding buttons.
import fs from "fs";
import { QueryTypes } from "sequelize";
import { sequelize, CaseCategory, CASE_STATUSES, CASE_PRIORITIES, CASE_TYPES } from "../models/index.js";
import {
  listCases, findCaseForUser, getThread, getAttachments, getHistory, getEscalations, getRating, findAttachmentForUser,
  assignableAgents, allowedTransitions, canReply, canInternalNote, canRate, canHandle, canAssign, canEscalate,
  canHandleEscalation, reopenDeadline, suggestAgent, createCase, addComment, changeStatus, changePriority, changeCategory,
  assignCase, escalateCase, handleEscalation, submitRating, markCaseRead, CUSTOMER_PRIORITIES, statusChoices, invalidTransition,
  MIN_NOTE_LENGTH, createStaffCase, STAFF_CASE_CHANNELS,
} from "../services/caseService.js";
import { pickableCustomers, findCustomerForUser } from "../services/customerMasterService.js";
import { pendingEscalations } from "../services/dashboardService.js";
import { markCaseNotificationsRead } from "../services/notificationService.js";
import { getSettings } from "../services/settingsService.js";
import { validateFiles, storedPath } from "../services/storageService.js";
import { audit } from "../services/auditService.js";
import { buildPagination } from "../helpers/pagination.js";
import { clean, cleanText, toId, toPage, oneOf } from "../helpers/validators.js";
import { AppError } from "../helpers/errors.js";
import { STATUS_LABELS, PRIORITY_LABELS, CASE_TYPE_LABELS } from "../helpers/labels.js";
import { CASES_PATH } from "../helpers/navigation.js";
import { config } from "../config/index.js";

const PER_PAGE = 10;
const options = (values, labels) => values.map((value) => ({ value, label: labels[value] }));
const basePath = (user) => CASES_PATH[user.role] || "/crm/cases";
// Customers ask questions through Inquiries (P4); a case is for a complaint, a request or feedback.
const CUSTOMER_CASE_TYPES = ["complaint", "service_request", "feedback"];
const CHANNEL_LABELS = { phone: "Phone call", walk_in: "Walk-in", sms: "SMS", social: "Social media", email: "Email" };

const fillTemplate = (body, data) =>
  body.replace(/\{(customer_name|case_no|agent_name|subject|category)\}/g, (_, key) => data[key] ?? "");

const activeCategories = () =>
  CaseCategory.findAll({ where: { is_active: true }, attributes: ["id", "name", "description", "default_priority"], order: [["name", "ASC"]], raw: true });

const notFound = (res) =>
  res.status(404).render("error", { title: "Case not found", status: 404, message: "This case does not exist or you do not have access to it." });

// ---------------------------------------------------------------- list

const LIST_TITLES = { customer: "Complaint / Feedback", agent: "My Cases", team_leader: "Cases & Complaints", crm_manager: "Customer Service" };

export const index = async (req, res) => {
  const user = req.user;
  const isSupervisor = ["team_leader", "crm_manager"].includes(user.role);
  const filters = {
    q: clean(req.query.q, 80),
    status: req.query.status === "active" ? "active" : oneOf(req.query.status, CASE_STATUSES),
    priority: oneOf(req.query.priority, CASE_PRIORITIES),
    category_id: toId(req.query.category_id),
    case_type: oneOf(req.query.case_type, CASE_TYPES),
    agent: isSupervisor ? (req.query.agent === "unassigned" ? "unassigned" : toId(req.query.agent)) : null,
    team: user.role === "crm_manager" ? toId(req.query.team) : null,
    overdue: req.query.overdue === "1",
    unread: req.query.unread === "1",
    escalated: req.query.escalated === "1",
    demo: user.role === "customer" ? null : oneOf(req.query.demo, ["demo", "real"]),
    sort: oneOf(req.query.sort, ["newest", "oldest", "due", "priority", "updated"]) || "newest",
  };
  const base = basePath(user);
  const page = toPage(req.query.page);
  const first = await listCases(user, filters, { limit: 1, offset: 0 });
  const pagination = buildPagination({
    total: first.total, page, perPage: PER_PAGE, basePath: base,
    query: { ...filters, overdue: filters.overdue ? "1" : "", unread: filters.unread ? "1" : "", escalated: filters.escalated ? "1" : "" },
  });
  const { rows } = await listCases(user, filters, { limit: pagination.limit, offset: pagination.offset });
  const [categories, agents, teams] = await Promise.all([
    activeCategories(),
    isSupervisor ? assignableAgents(user) : Promise.resolve([]),
    user.role === "crm_manager"
      ? sequelize.query("SELECT id, name FROM crm_teams WHERE is_active = 1 ORDER BY team_code", { type: QueryTypes.SELECT })
      : Promise.resolve([]),
  ]);
  const hasFilters = Boolean(filters.q || filters.status || filters.priority || filters.category_id || filters.case_type ||
    filters.agent || filters.team || filters.overdue || filters.unread || filters.escalated || filters.demo);

  res.render("cases/index", {
    title: LIST_TITLES[user.role],
    cases: rows,
    pagination,
    filters,
    hasFilters,
    base,
    categories,
    agents,
    teams,
    isSupervisor,
    canCreateStaff: ["agent", "team_leader", "crm_manager"].includes(user.role),
    isManager: user.role === "crm_manager",
    isCustomer: user.role === "customer",
    statusOptions: options(CASE_STATUSES, STATUS_LABELS),
    priorityOptions: options(CASE_PRIORITIES, PRIORITY_LABELS),
    typeOptions: options(CASE_TYPES, CASE_TYPE_LABELS),
  });
};

// Team Leader "Customer Queue": unassigned Open cases of the team plus unrouted new cases.
export const queue = async (req, res) => {
  const { rows } = await listCases(req.user, { queue: true, sort: "oldest" }, { limit: 100, offset: 0 });
  const [agents] = await Promise.all([assignableAgents(req.user)]);
  res.render("cases/queue", { title: "Customer Queue", cases: rows, agents, base: "/crm/cases" });
};

export const escalations = async (req, res) => {
  res.render("cases/escalations", {
    title: "Escalations",
    rows: await pendingEscalations(req.user, 100),
    isManager: req.user.role === "crm_manager",
  });
};

// ---------------------------------------------------------------- create (customer portal)

const renderNewForm = async (res, form = {}, errors = []) =>
  res.render("cases/new", {
    title: "Submit a Complaint or Request",
    form: { priority: "medium", case_type: "complaint", ...form },
    errors,
    categories: await activeCategories(),
    typeOptions: options(CUSTOMER_CASE_TYPES, CASE_TYPE_LABELS),
    priorityOptions: options(CUSTOMER_PRIORITIES, PRIORITY_LABELS),
    maxFiles: config.uploads.maxFiles,
  });

export const newForm = (req, res) => {
  if (req.query.type === "inquiry") return res.redirect("/portal/inquiries"); // old links: questions are inquiries now
  return renderNewForm(res, { case_type: oneOf(req.query.type, CUSTOMER_CASE_TYPES) || "complaint" });
};

// ---------------------------------------------------------------- create (staff, for a customer who phoned or walked in)

const staffFormModel = async (user, form, errors = []) => {
  const customerId = toId(form.customer_id);
  const customers = await pickableCustomers(user);
  if (customerId && !customers.some((c) => c.id === customerId)) {
    const c = await findCustomerForUser(customerId, user);
    if (c) customers.unshift({ id: c.id, customer_no: c.customer_no, name: `${c.first_name} ${c.last_name}` });
  }
  const agents = user.role === "agent" ? [] : await assignableAgents(user);
  return {
    title: "Open a case for a customer", form, errors, canPickAgent: user.role !== "agent",
    customers: customers.map((c) => ({ ...c, sel: c.id === customerId })),
    categories: (await activeCategories()).map((c) => ({ ...c, sel: String(c.id) === String(form.category_id) })),
    channelOptions: STAFF_CASE_CHANNELS.map((value) => ({ value, label: CHANNEL_LABELS[value], sel: value === form.channel })),
    typeOptions: options(CASE_TYPES, CASE_TYPE_LABELS).map((o) => ({ ...o, sel: o.value === form.case_type })),
    priorityOptions: options(CASE_PRIORITIES, PRIORITY_LABELS).map((o) => ({ ...o, sel: o.value === form.priority })),
    agents: agents.map((a) => ({ ...a, sel: String(a.id) === String(form.agent_id) })),
  };
};

export const staffNewForm = async (req, res) =>
  res.render("cases/new_staff", await staffFormModel(req.user, { channel: "phone", case_type: "complaint", priority: "medium", customer_id: toId(req.query.customer_id) ? String(toId(req.query.customer_id)) : "" }));

export const staffCreate = async (req, res) => {
  const user = req.user;
  const form = {
    customer_id: toId(req.body.customer_id) ? String(toId(req.body.customer_id)) : "", channel: oneOf(req.body.channel, STAFF_CASE_CHANNELS) || "",
    case_type: oneOf(req.body.case_type, CASE_TYPES) || "", category_id: toId(req.body.category_id) ? String(toId(req.body.category_id)) : "",
    priority: oneOf(req.body.priority, CASE_PRIORITIES) || "", subject: clean(req.body.subject, 150), description: cleanText(req.body.description, 5000),
    order_reference: clean(req.body.order_reference, 60), agent_id: toId(req.body.agent_id) ? String(toId(req.body.agent_id)) : "",
  };
  const errors = [];
  if (!form.customer_id) errors.push("Choose the customer.");
  if (!form.channel) errors.push("Choose how the customer contacted us.");
  if (!form.case_type) errors.push("Choose the type of concern.");
  if (!form.priority) errors.push("Choose a priority.");
  if (form.subject.length < 5) errors.push("Subject must be at least 5 characters.");
  if (form.description.length < 15) errors.push("Describe the concern in at least 15 characters.");
  if (form.order_reference && !/^[A-Za-z0-9#\-\/ ]{2,60}$/.test(form.order_reference)) errors.push("Order/receipt reference may only contain letters, numbers, #, - and /.");
  if (!form.category_id || !(await activeCategories()).some((c) => c.id === Number(form.category_id))) errors.push("Choose a category.");
  if (errors.length) { res.status(422); return res.render("cases/new_staff", await staffFormModel(user, form, errors)); }
  let k;
  try {
    k = await createStaffCase({
      user, customerId: Number(form.customer_id), agentId: toId(form.agent_id),
      data: { case_type: form.case_type, category_id: Number(form.category_id), subject: form.subject, description: form.description, priority: form.priority, channel: form.channel, order_reference: form.order_reference },
    });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.status === 403) {
      await audit(req, "access_denied", { outcome: "denied", recordType: "case", details: `create: ${err.message}` });
      return res.status(403).render("error", { title: "Access denied", status: 403, message: err.message });
    }
    res.status(err.status === 404 ? 404 : 422);
    return res.render("cases/new_staff", await staffFormModel(user, err.status === 404 ? { ...form, customer_id: "" } : form, [err.status === 404 ? "Choose a customer from the list." : err.message]));
  }
  await audit(req, "case_created_by_staff", { recordType: "case", recordId: k.case_no, after: { customer_id: k.customer_id, channel: form.channel, assigned_agent_id: k.assigned_agent_id, priority: k.priority } });
  req.flash("success_msg", `Case ${k.case_no} was opened${k.assigned_agent_id ? " and assigned" : " and is waiting in the Customer Queue"}.`);
  res.redirect(`/crm/cases/${k.id}`);
};

export const create = async (req, res) => {
  const form = {
    case_type: oneOf(req.body.case_type, CUSTOMER_CASE_TYPES),
    category_id: toId(req.body.category_id),
    priority: oneOf(req.body.priority, CUSTOMER_PRIORITIES),
    subject: clean(req.body.subject, 150),
    description: cleanText(req.body.description, 5000),
    order_reference: clean(req.body.order_reference, 60),
  };
  const errors = [];
  if (req.uploadError) errors.push(req.uploadError);
  if (!form.case_type) errors.push("Choose the type of concern.");
  if (!form.priority) errors.push("Choose a priority (Low, Medium or High).");
  if (form.subject.length < 5) errors.push("Subject must be at least 5 characters.");
  if (form.description.length < 15) errors.push("Describe your concern in at least 15 characters.");
  if (form.order_reference && !/^[A-Za-z0-9#\-\/ ]{2,60}$/.test(form.order_reference)) {
    errors.push("Order/receipt reference may only contain letters, numbers, #, - and /.");
  }
  const categories = await activeCategories();
  if (!form.category_id || !categories.some((c) => c.id === form.category_id)) errors.push("Choose a category.");
  let validatedFiles = [];
  if (!errors.length) {
    try {
      validatedFiles = validateFiles(req.files || []);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      errors.push(err.message);
    }
  }
  if (errors.length) {
    res.status(422);
    return renderNewForm(res, form, errors);
  }
  const k = await createCase({ user: req.user, data: form, validatedFiles });
  req.flash("success_msg", `Case ${k.case_no} was submitted. Our customer service team will get back to you.`);
  res.redirect(`/portal/cases/${k.id}`);
};

// ---------------------------------------------------------------- details

export const show = async (req, res) => {
  const user = req.user;
  const id = toId(req.params.id);
  const k = id ? await findCaseForUser(id, user) : null;
  if (!k) return notFound(res);

  const isStaff = user.role !== "customer";
  const handles = canHandle(k, user);
  const assignAllowed = canAssign(k, user);
  const [thread, attachments, history, escalationRows, rating, agents, suggested, templateRows, categories] = await Promise.all([
    getThread(k.id, user),
    getAttachments(k.id, user),
    isStaff ? getHistory(k.id) : Promise.resolve([]),
    isStaff ? getEscalations(k.id) : Promise.resolve([]),
    getRating(k.id),
    assignAllowed ? assignableAgents(user) : Promise.resolve([]),
    assignAllowed ? suggestAgent(k, user) : Promise.resolve(null),
    handles
      ? sequelize.query(
          `SELECT id, title, body FROM response_templates WHERE is_active = 1 AND (category_id IS NULL OR category_id = :cat)
           ORDER BY category_id IS NULL, title`,
          { type: QueryTypes.SELECT, replacements: { cat: k.category_id } }
        )
      : Promise.resolve([]),
    handles ? activeCategories() : Promise.resolve([]),
  ]);
  await markCaseRead(user.id, k.id);
  await markCaseNotificationsRead(user.id, k.id);

  const transitions = allowedTransitions(k, user).map((value) => ({
    value, label: ["resolved", "closed"].includes(k.status) && value === "in_progress" ? "Reopen (In Progress)" : STATUS_LABELS[value],
  }));
  const { choices: statusChoiceList, explanation: statusExplanation, hint: statusHint } = statusChoices(k, user);
  const deadline = reopenDeadline(k);
  const placeholderData = { customer_name: k.customer_name, case_no: k.case_no, agent_name: user.name, subject: k.subject, category: k.category_name };
  const base = basePath(user);

  res.render("cases/show", {
    title: k.case_no,
    k,
    base,
    thread: thread.map((m) => ({ ...m, mine: m.author_id === user.id, isStaffAuthor: m.author_role !== "customer" })),
    attachments,
    history,
    escalations: escalationRows,
    rating,
    agents: agents.map((a) => ({ ...a, current: a.id === k.assigned_agent_id })),
    suggested,
    transitions,
    statusChoices: statusChoiceList,
    statusExplanation,
    escalationPanelHint: statusHint,
    minNoteLength: MIN_NOTE_LENGTH,
    currentStatusLabel: STATUS_LABELS[k.status],
    isStaff,
    isCustomer: user.role === "customer",
    canReply: canReply(k, user),
    canInternalNote: canInternalNote(k, user),
    canChangeStatus: isStaff,
    canReopen: user.role === "customer" && transitions.some((t) => t.value === "in_progress"),
    canConfirmClose: user.role === "customer" && transitions.some((t) => t.value === "closed"),
    reopenDeadline: ["resolved", "closed"].includes(k.status) ? deadline : null,
    canAssign: assignAllowed,
    canEscalate: canEscalate(k, user),
    escalateTarget: user.role === "agent" ? "your Team Leader" : "the CRM Manager",
    canHandleEscalation: canHandleEscalation(k, user),
    canChangePriority: handles && k.status !== "closed",
    canChangeCategory: handles && k.status !== "closed",
    categories: categories.map((c) => ({ ...c, current: c.id === k.category_id })),
    templates: templateRows.map((t) => ({ ...t, filled: fillTemplate(t.body, placeholderData) })),
    canRate: canRate(k, user, rating),
    priorityOptions: options(CASE_PRIORITIES, PRIORITY_LABELS),
    reopenWindowDays: getSettings().reopenWindowDays,
    autoCloseDays: getSettings().autoCloseDays,
    readOnlyForAgent: user.role === "agent" && !handles,
    maxFiles: config.uploads.maxFiles,
  });
};

// ---------------------------------------------------------------- actions

// Runs an action; known problems become a flash message on the case page. Forbidden actions are audited.
const action = (name, fn) => async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return notFound(res);
  try {
    const message = await fn(req, id);
    if (message) req.flash("success_msg", message);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.status === 404) return notFound(res);
    if (err.status === 403) {
      await audit(req, "access_denied", { outcome: "denied", recordType: "case", recordId: id, details: `${name}: ${err.message}` });
      return res.status(403).render("error", { title: "Access denied", status: 403, message: err.message });
    }
    req.flash("error_msg", err.message);
  }
  res.redirect(`${basePath(req.user)}/${id}`);
};

export const comment = action("comment", async (req, id) => {
  if (req.uploadError) throw new AppError(req.uploadError);
  const body = cleanText(req.body.message, 5000);
  if (!body) throw new AppError("Write a message before sending.");
  const validatedFiles = validateFiles(req.files || []);
  const visibility = await addComment({ caseId: id, user: req.user, body, internal: req.body.internal === "1", validatedFiles });
  return visibility === "internal" ? "Internal note added (visible to staff only)." : "Reply sent.";
});

// Shared by the Escalate button and the "Escalated" choice of the status dropdown: one service, one audit row.
const runEscalate = async (req, id, reason) => {
  if (reason.length < MIN_NOTE_LENGTH) throw new AppError(`Give a reason for the escalation (at least ${MIN_NOTE_LENGTH} characters).`);
  const { toLevel, target } = await escalateCase({ caseId: id, user: req.user, reason });
  await audit(req, "case_escalated", { recordType: "case", recordId: id, after: { escalation_level: toLevel, escalated_to: target?.id ?? null }, reason });
  return `Case escalated to ${toLevel === 1 ? "the Team Leader" : "the CRM Manager"}${target ? ` (${target.display_name})` : ""}.`;
};

// Shared by the "Handle escalation" panel and the supervisor choices of the status dropdown.
const runEscalationAction = async (req, id, act, note) => {
  if (act === "resolve" && note.length < MIN_NOTE_LENGTH) throw new AppError(`Describe the resolution (at least ${MIN_NOTE_LENGTH} characters).`);
  await handleEscalation({ caseId: id, user: req.user, action: act, note });
  await audit(req, "escalation_handled", { recordType: "case", recordId: id, after: { action: act }, reason: note || null });
  return { take_over: "You took over the case (In Progress).", return: "Case returned to the assigned agent.", resolve: "Case resolved." }[act];
};

// The status dropdown is only a convenience: a staff choice is looked up in statusChoices (the same rules the
// services enforce again under a row lock), and any jump the rules don't allow is refused and audited.
// Supervisor actions on an Escalated case (take over / return / resolve) are not status choices: they go through
// the "Handle escalation" panel (escalationAction) only.
export const updateStatus = action("status", async (req, id) => {
  const status = oneOf(req.body.status, CASE_STATUSES);
  const k = await findCaseForUser(id, req.user);
  if (!k) throw new AppError("Case not found.", 404);
  if (!status) { // e.g. a forged "unsolved": there is no such status
    await audit(req, "case_status_rejected", {
      outcome: "denied", recordType: "case", recordId: id, before: { status: k.status }, after: { attempted_status: clean(req.body.status, 40) }, details: "Unknown status",
    });
    throw new AppError("Choose a valid status.");
  }
  const note = clean(req.body.note, 255);
  const reopening = ["resolved", "closed"].includes(k.status) && status === "in_progress";
  try {
    if (req.user.role !== "customer") {
      const choice = statusChoices(k, req.user).choices.find((c) => c.value === status);
      if (!choice) throw invalidTransition(k, status);
      if (choice.action === "escalate") return await runEscalate(req, id, note);
    }
    if (req.user.role === "customer" && reopening && note.length < 5) throw new AppError("Tell us briefly why you are reopening the case.");
    await changeStatus({ caseId: id, user: req.user, newStatus: status, note });
  } catch (err) {
    if (err instanceof AppError && err.code === "invalid_transition") {
      await audit(req, "case_status_rejected", {
        outcome: "denied", recordType: "case", recordId: id, before: { status: k.status }, after: { attempted_status: status }, details: err.message,
      });
    }
    throw err;
  }
  await audit(req, reopening ? "case_reopened" : "case_status_changed", {
    recordType: "case", recordId: id, before: { status: k.status }, after: { status }, reason: note || null,
  });
  if (req.user.role === "customer" && status === "closed") return "Thanks for confirming! The case is now closed.";
  if (reopening) return "The case was reopened.";
  return `Status changed to ${STATUS_LABELS[status]}.`;
});

export const updatePriority = action("priority", async (req, id) => {
  const priority = oneOf(req.body.priority, CASE_PRIORITIES);
  if (!priority) throw new AppError("Choose a valid priority.");
  const change = await changePriority({ caseId: id, user: req.user, priority });
  await audit(req, "case_priority_changed", { recordType: "case", recordId: id, before: { priority: change.before }, after: { priority } });
  return `Priority changed to ${PRIORITY_LABELS[priority]}. SLA due dates were recalculated.`;
});

export const updateCategory = action("category", async (req, id) => {
  const categoryId = toId(req.body.category_id);
  const category = (await activeCategories()).find((c) => c.id === categoryId);
  if (!category) throw new AppError("Choose a valid category.");
  await changeCategory({ caseId: id, user: req.user, categoryId, categoryName: category.name });
  return `Category changed to ${category.name}.`;
});

export const assign = action("assign", async (req, id) => {
  const agentId = toId(req.body.agent_id);
  if (!agentId) throw new AppError("Choose an agent.");
  const k = await findCaseForUser(id, req.user);
  const agent = await assignCase({ caseId: id, actor: req.user, agentId, note: clean(req.body.note, 255) });
  await audit(req, "case_assigned", {
    recordType: "case", recordId: id, before: { assigned_agent_id: k?.assigned_agent_id ?? null }, after: { assigned_agent_id: agent.id, team_id: agent.team_id },
  });
  return `Case assigned to ${agent.name}.`;
});

export const escalate = action("escalate", (req, id) => runEscalate(req, id, clean(req.body.reason, 255)));

export const escalationAction = action("escalation", async (req, id) => {
  const act = oneOf(req.body.action, ["take_over", "return", "resolve"]);
  if (!act) throw new AppError("Choose an action.");
  return runEscalationAction(req, id, act, clean(req.body.note, 255));
});

export const rate = action("rate", async (req, id) => {
  const rating = Number.parseInt(req.body.rating, 10);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new AppError("Choose a rating from 1 to 5 stars.");
  await submitRating({ caseId: id, user: req.user, rating, comment: cleanText(req.body.comment, 1000) });
  return "Thank you for your feedback!";
});

// ---------------------------------------------------------------- attachments

export const downloadAttachment = async (req, res) => {
  const id = toId(req.params.id);
  const attachment = id ? await findAttachmentForUser(id, req.user) : null;
  const filePath = attachment ? storedPath(attachment.stored_name) : null;
  if (!attachment || !fs.existsSync(filePath)) {
    return res.status(404).render("error", { title: "File not found", status: 404, message: "This file does not exist or you do not have access to it." });
  }
  res.set("Cache-Control", "private, no-store");
  if (attachment.mime_type.startsWith("image/")) {
    res.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  }
  if (attachment.mime_type.startsWith("image/") || attachment.mime_type === "application/pdf") {
    res.type(attachment.mime_type);
    res.set("Content-Disposition", `inline; filename="${attachment.original_name.replace(/[^\w.\- ]/g, "_")}"`);
    return res.sendFile(filePath);
  }
  return res.download(filePath, attachment.original_name);
};
