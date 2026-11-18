// Interactions: the log of calls, visits, messages and notes with a customer. Scope follows the Customer Directory
// (Agent: own customers, Team Leader: team, Manager: all); a customer outside the scope cannot be chosen or opened.
import {
  listInteractions, findInteraction, validateInteraction, logInteraction, pickableCustomers, findCustomerForUser,
  INTERACTION_TYPES, INTERACTION_DIRECTIONS, TYPE_LABELS,
} from "../services/customerMasterService.js";
import { audit } from "../services/auditService.js";
import { buildPagination } from "../helpers/pagination.js";
import { clean, cleanText, toId, toPage, oneOf } from "../helpers/validators.js";
import { AppError } from "../helpers/errors.js";
import { config } from "../config/index.js";
import { CUSTOMER_AREA_TABS } from "../helpers/navigation.js";

const areaTabs = CUSTOMER_AREA_TABS.map(([label, href]) => ({ label, href, active: label === "Interactions" }));

const pairs = (list) => list.map(([value, label]) => ({ value, label }));
const notFound = (res) => res.status(404).render("error", { title: "Not found", status: 404, message: "This interaction does not exist or is not in your scope." });

// "2026-11-13T14:30" in Asia/Manila, for <input type="datetime-local">.
const nowLocal = () => new Intl.DateTimeFormat("sv-SE", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date()).replace(" ", "T");

export const index = async (req, res) => {
  const filters = {
    q: clean(req.query.q, 80), type: oneOf(req.query.type, INTERACTION_TYPES.map(([k]) => k)) || "", mine: req.query.mine === "1",
    customerId: toId(req.query.customer_id),
  };
  const first = await listInteractions(req.user, { ...filters, limit: 1, offset: 0 });
  const pagination = buildPagination({
    total: first.total, page: toPage(req.query.page), perPage: 15, basePath: "/crm/interactions",
    query: { q: filters.q, type: filters.type, mine: filters.mine ? "1" : "", customer_id: filters.customerId || "" },
  });
  const { rows } = await listInteractions(req.user, { ...filters, limit: pagination.limit, offset: pagination.offset });
  res.render("interactions/index", {
    title: "Interactions", areaTabs, rows: rows.map((r) => ({ ...r, type_label: TYPE_LABELS[r.interaction_type] })), filters, pagination,
    typeOptions: pairs(INTERACTION_TYPES).map((o) => ({ ...o, sel: o.value === filters.type })), hasFilters: Boolean(filters.q || filters.type || filters.mine || filters.customerId),
  });
};

const formModel = async (user, form, errors = []) => {
  const customerId = toId(form.customer_id);
  const customers = await pickableCustomers(user);
  if (customerId && !customers.some((c) => c.id === customerId)) { // a customer beyond the first 200 of a long list
    const c = await findCustomerForUser(customerId, user);
    if (c) customers.unshift({ id: c.id, customer_no: c.customer_no, name: `${c.first_name} ${c.last_name}` });
  }
  return {
    title: "Log interaction", areaTabs, form, errors,
    customers: customers.map((c) => ({ ...c, sel: c.id === customerId })),
    typeOptions: pairs(INTERACTION_TYPES).map((o) => ({ ...o, sel: o.value === form.type })),
    directionOptions: pairs(INTERACTION_DIRECTIONS).map((o) => ({ ...o, sel: o.value === form.direction })),
  };
};

export const newForm = async (req, res) =>
  res.render("interactions/new", await formModel(req.user, { customer_id: toId(req.query.customer_id) ? String(toId(req.query.customer_id)) : "", direction: "inbound", type: "call", occurred_at: nowLocal() }));

export const create = async (req, res) => {
  const raw = {
    customer_id: toId(req.body.customer_id), type: oneOf(req.body.type, INTERACTION_TYPES.map(([k]) => k)), direction: oneOf(req.body.direction, INTERACTION_DIRECTIONS.map(([k]) => k)),
    subject: clean(req.body.subject, 150), summary: cleanText(req.body.summary, 2000), occurred_at: clean(req.body.occurred_at, 25), case_no: clean(req.body.case_no, 30).toUpperCase(),
  };
  const { errors, values } = validateInteraction(raw);
  const form = { ...req.body, customer_id: raw.customer_id ? String(raw.customer_id) : "", subject: raw.subject, summary: raw.summary, case_no: raw.case_no };
  if (errors.length) { res.status(422); return res.render("interactions/new", await formModel(req.user, form, errors)); }
  let saved;
  try {
    saved = await logInteraction({ user: req.user, values });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.status === 404) { res.status(404); return res.render("interactions/new", await formModel(req.user, { ...form, customer_id: "" }, ["Choose a customer from the list."])); }
    res.status(err.status === 403 ? 403 : 422);
    return res.render("interactions/new", await formModel(req.user, form, [err.message]));
  }
  await audit(req, "interaction_logged", { recordType: "customer", recordId: values.customer_id, after: { interaction_id: saved.id, type: values.type, related_case_id: saved.relatedId } });
  req.flash("success_msg", "Interaction saved.");
  res.redirect(`/crm/interactions/${saved.id}`);
};

export const show = async (req, res) => {
  const id = toId(req.params.id);
  const row = id ? await findInteraction(id, req.user) : null;
  if (!row) return notFound(res);
  res.render("interactions/show", { areaTabs, title: `Interaction ${row.id}`, i: { ...row, type_label: TYPE_LABELS[row.interaction_type] } });
};
