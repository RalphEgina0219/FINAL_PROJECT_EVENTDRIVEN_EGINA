// Follow-up tasks (Agent: own; Team Leader: team; Manager: all). Rules and scope live in services/followUpService.js.
import {
  listFollowUps, findFollowUp, followUpSummary, assignableStaff, validateFollowUp, createFollowUp, completeFollowUp, cancelFollowUp,
  rescheduleFollowUp, reassignFollowUp, FOLLOWUP_PRIORITIES, FOLLOWUP_STATUS_LABELS, MIN_REASON_LENGTH,
} from "../services/followUpService.js";
import { pickableCustomers, findCustomerForUser } from "../services/customerMasterService.js";
import { audit } from "../services/auditService.js";
import { can } from "../services/permissionService.js";
import { buildPagination } from "../helpers/pagination.js";
import { clean, cleanText, toId, toPage, oneOf } from "../helpers/validators.js";
import { AppError } from "../helpers/errors.js";
import { CUSTOMER_AREA_TABS } from "../helpers/navigation.js";
import { config } from "../config/index.js";

const areaTabs = CUSTOMER_AREA_TABS.map(([label, href]) => ({ label, href, active: label === "Follow-up tasks" }));
const notFound = (res) => res.status(404).render("error", { title: "Follow-up not found", status: 404, message: "This follow-up does not exist or is not in your scope." });
const label = (r) => ({ ...r, state: r.status === "pending" && r.is_overdue ? "overdue" : r.status });
const withLabels = (r) => ({ ...label(r), state_label: FOLLOWUP_STATUS_LABELS[label(r).state] });

// "2026-11-13T14:30" in Asia/Manila, for <input type="datetime-local">.
const toLocal = (date) => new Intl.DateTimeFormat("sv-SE", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(date)).replace(" ", "T");
const tomorrow9 = () => {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  return `${toLocal(d).slice(0, 10)}T09:00`;
};

export const index = async (req, res) => {
  const isSupervisor = ["team_leader", "crm_manager"].includes(req.user.role);
  const filters = {
    q: clean(req.query.q, 80), status: oneOf(req.query.status, ["pending", "overdue", "today", "upcoming", "done", "cancelled"]) || "",
    priority: oneOf(req.query.priority, FOLLOWUP_PRIORITIES.map(([k]) => k)) || "", assignee: isSupervisor ? toId(req.query.assignee) : null,
  };
  const first = await listFollowUps(req.user, { ...filters, limit: 1, offset: 0 });
  const pagination = buildPagination({
    total: first.total, page: toPage(req.query.page), perPage: 15, basePath: "/crm/follow-ups",
    query: { q: filters.q, status: filters.status, priority: filters.priority, assignee: filters.assignee || "" },
  });
  const [{ rows }, summary, staff] = await Promise.all([
    listFollowUps(req.user, { ...filters, limit: pagination.limit, offset: pagination.offset }), followUpSummary(req.user), isSupervisor ? assignableStaff(req.user) : [],
  ]);
  res.render("follow_ups/index", {
    title: req.user.role === "agent" ? "Follow-up Tasks" : req.user.role === "team_leader" ? "Follow-ups" : "Follow-up tasks", areaTabs,
    rows: rows.map(withLabels), filters, pagination, summary, isSupervisor, canCreate: can(req.user, "followups.manage"),
    statusOptions: [["pending", "Pending"], ["overdue", "Overdue"], ["today", "Due today or earlier"], ["upcoming", "Upcoming"], ["done", "Done"], ["cancelled", "Cancelled"]].map(([value, text]) => ({ value, label: text, sel: value === filters.status })),
    priorityOptions: FOLLOWUP_PRIORITIES.map(([value, text]) => ({ value, label: text, sel: value === filters.priority })),
    staff: staff.map((s) => ({ ...s, sel: s.id === filters.assignee })),
    hasFilters: Boolean(filters.q || filters.status || filters.priority || filters.assignee),
    scopeNote: req.user.role === "agent" ? "You see only your own tasks." : req.user.role === "team_leader" ? "You see your own tasks and your team's, including overdue ones." : "You see every follow-up.",
  });
};

const newModel = async (user, form, errors = []) => {
  const customerId = toId(form.customer_id);
  const customers = await pickableCustomers(user);
  if (customerId && !customers.some((c) => c.id === customerId)) {
    const c = await findCustomerForUser(customerId, user);
    if (c) customers.unshift({ id: c.id, customer_no: c.customer_no, name: `${c.first_name} ${c.last_name}` });
  }
  const staff = await assignableStaff(user);
  return {
    title: "New follow-up", areaTabs, form, errors,
    customers: customers.map((c) => ({ ...c, sel: c.id === customerId })),
    staff: staff.map((s) => ({ ...s, sel: String(s.id) === String(form.assigned_to || user.id) })),
    canPickAssignee: user.role !== "agent",
    priorityOptions: FOLLOWUP_PRIORITIES.map(([value, text]) => ({ value, label: text, sel: value === form.priority })),
  };
};

export const newForm = async (req, res) =>
  res.render("follow_ups/new", await newModel(req.user, {
    customer_id: toId(req.query.customer_id) ? String(toId(req.query.customer_id)) : "", case_no: clean(req.query.case_no, 30).toUpperCase(),
    priority: "medium", due_at: tomorrow9(), assigned_to: String(req.user.id), title: clean(req.query.title, 150),
  }));

export const create = async (req, res) => {
  const raw = {
    customer_id: toId(req.body.customer_id), title: clean(req.body.title, 150), notes: cleanText(req.body.notes, 1000), due_at: clean(req.body.due_at, 25),
    priority: oneOf(req.body.priority, FOLLOWUP_PRIORITIES.map(([k]) => k)) || "", assigned_to: toId(req.body.assigned_to) || req.user.id, case_no: clean(req.body.case_no, 30).toUpperCase(),
  };
  const { errors, values } = validateFollowUp(raw);
  const form = { ...raw, customer_id: raw.customer_id ? String(raw.customer_id) : "", assigned_to: String(raw.assigned_to) };
  if (errors.length) { res.status(422); return res.render("follow_ups/new", await newModel(req.user, form, errors)); }
  let out;
  try {
    out = await createFollowUp({ user: req.user, values });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.status === 403) {
      await audit(req, "access_denied", { outcome: "denied", recordType: "follow_up", details: `create: ${err.message}` });
      return res.status(403).render("error", { title: "Access denied", status: 403, message: err.message });
    }
    res.status(err.status === 404 ? 404 : 422);
    return res.render("follow_ups/new", await newModel(req.user, err.status === 404 ? { ...form, customer_id: "" } : form, [err.status === 404 ? "Choose a customer from the list." : err.message]));
  }
  await audit(req, "follow_up_created", { recordType: "follow_up", recordId: out.id, after: { customer_id: values.customer_id, assigned_to: out.assignee.id, priority: values.priority, case_id: out.caseId } });
  req.flash("success_msg", `Follow-up created${out.assignee.id !== req.user.id ? ` and assigned to ${out.assignee.name}` : ""}.`);
  res.redirect(`/crm/follow-ups/${out.id}`);
};

export const show = async (req, res) => {
  const id = toId(req.params.id);
  const task = id ? await findFollowUp(id, req.user) : null;
  if (!task) return notFound(res);
  const pending = task.status === "pending";
  const mine = req.user.role !== "agent" || Number(task.assigned_to) === req.user.id;
  const canAssign = can(req.user, "followups.assign") && pending;
  res.render("follow_ups/show", {
    title: task.title, areaTabs, t: withLabels(task), notesLines: task.notes ? String(task.notes).split("\n") : [],
    canChange: can(req.user, "followups.manage") && pending && mine, canAssign, minReason: MIN_REASON_LENGTH,
    dueLocal: toLocal(task.due_at), staff: canAssign ? (await assignableStaff(req.user)).map((s) => ({ ...s, current: s.id === task.assigned_to })) : [],
  });
};

// ---------------------------------------------------------------- actions

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
      await audit(req, "access_denied", { outcome: "denied", recordType: "follow_up", recordId: id, details: `${name}: ${err.message}` });
      return res.status(403).render("error", { title: "Access denied", status: 403, message: err.message });
    }
    req.flash("error_msg", err.message);
  }
  res.redirect(`/crm/follow-ups/${id}`);
};

export const complete = action("complete", async (req, id) => {
  const task = await completeFollowUp({ id, user: req.user, note: clean(req.body.note, 200) });
  await audit(req, "follow_up_completed", { recordType: "follow_up", recordId: id, before: { status: task.status }, after: { status: "done" } });
  return "Follow-up marked as done.";
});

export const cancel = action("cancel", async (req, id) => {
  const reason = clean(req.body.reason, 200);
  const task = await cancelFollowUp({ id, user: req.user, reason });
  await audit(req, "follow_up_cancelled", { recordType: "follow_up", recordId: id, before: { status: task.status }, after: { status: "cancelled" }, reason });
  return "Follow-up cancelled.";
});

export const reschedule = action("reschedule", async (req, id) => {
  const out = await rescheduleFollowUp({ id, user: req.user, dueRaw: clean(req.body.due_at, 25) });
  await audit(req, "follow_up_rescheduled", { recordType: "follow_up", recordId: id, before: { due_at: out.task.due_at }, after: { due_at: out.due } });
  return "Follow-up rescheduled.";
});

export const reassign = action("reassign", async (req, id) => {
  const assigneeId = toId(req.body.assigned_to);
  if (!assigneeId) throw new AppError("Choose who should do it.");
  const out = await reassignFollowUp({ id, actor: req.user, assigneeId });
  await audit(req, "follow_up_reassigned", { recordType: "follow_up", recordId: id, before: { assigned_to: out.task.assigned_to }, after: { assigned_to: out.assignee.id } });
  return `Follow-up reassigned to ${out.assignee.name}.`;
});
