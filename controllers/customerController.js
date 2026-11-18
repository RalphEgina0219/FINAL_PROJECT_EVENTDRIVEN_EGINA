// Customer Directory and customer master (Manager: all; Team Leader: team; Agent: own customers).
// Contact data is masked in the list and shown in full only on the detail page (blueprint §11).
// Access rules live in services/customerService.js (directoryScope) and are applied on every request.
import { customerLoyalty } from "../services/loyaltyService.js";
import { listCustomers, findCustomerForUser } from "../services/customerService.js";
import {
  findDuplicates, validateNewCustomer, createStaffCustomer, updateProfile, addContact, setPrimaryContact, removeContact,
  addAddress, updateAddress, setDefaultAddress, removeAddress, getPreferences, validatePreferences, savePreferences,
  customerTimeline, assignCustomer, unassignCustomer, assignableAgents, SOURCES, CONSENT_CHANNELS, CONTACT_TYPES, CUSTOMER_TYPES,
  PREFERENCES, MIN_REASON_LENGTH, sourceLabel,
} from "../services/customerMasterService.js";
import { listCases } from "../services/caseService.js";
import { audit } from "../services/auditService.js";
import { can } from "../services/permissionService.js";
import { buildPagination } from "../helpers/pagination.js";
import { clean, cleanText, toId, toPage, oneOf } from "../helpers/validators.js";
import { maskEmail, maskMobile } from "../helpers/mask.js";
import { AppError } from "../helpers/errors.js";
import { recentOrdersForCustomer, ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from "../services/orderService.js";

const TITLES = { crm_manager: "Customer Directory", team_leader: "Team Customers", agent: "My Customers" };
const pairs = (list) => list.map(([value, label]) => ({ value, label }));

const notFound = (res) =>
  res.status(404).render("error", { title: "Customer not found", status: 404, message: "This customer does not exist or is not in your scope." });

// ---------------------------------------------------------------- directory

export const index = async (req, res) => {
  const q = clean(req.query.q, 80);
  const assignment = oneOf(req.query.assignment, ["unassigned", "mine"]) || "";
  const page = toPage(req.query.page);
  const first = await listCustomers(req.user, { q, assignment, limit: 1, offset: 0 });
  const pagination = buildPagination({ total: first.total, page, perPage: 15, basePath: "/crm/customers", query: { q, assignment } });
  const { rows } = await listCustomers(req.user, { q, assignment, limit: pagination.limit, offset: pagination.offset });
  res.render("customers/index", {
    title: TITLES[req.user.role], rows: rows.map((r) => ({ ...r, source_label: sourceLabel(r.source) })), q, assignment, pagination,
    isManager: req.user.role === "crm_manager", isSupervisor: req.user.role !== "agent", canCreate: can(req.user, "customers.create"),
  });
};

// ---------------------------------------------------------------- new walk-in / phone customer

const blankForm = (user) => ({ source: "walk_in", consent_channel: "in_store", customer_type: "individual", agent_id: user.role === "agent" ? String(user.id) : "" });

const newFormModel = async (user, form, errors = [], duplicates = null, reasonTooShort = false) => ({
  title: "New customer", form, errors, duplicates, reasonTooShort, minReason: MIN_REASON_LENGTH,
  sourceOptions: pairs(SOURCES), consentOptions: pairs(CONSENT_CHANNELS), typeOptions: pairs(CUSTOMER_TYPES),
  agents: user.role === "agent" ? [] : (await assignableAgents(user)).map((g) => ({ ...g, sel: String(g.id) === String(form.agent_id) })), canPickAgent: user.role !== "agent",
});

export const newForm = async (req, res) => res.render("customers/new", await newFormModel(req.user, blankForm(req.user)));

const readNewForm = (body) => ({
  first_name: clean(body.first_name, 80), last_name: clean(body.last_name, 80), email: clean(body.email, 254), mobile: clean(body.mobile, 30),
  source: oneOf(body.source, SOURCES.map(([k]) => k)) || "", consent_channel: oneOf(body.consent_channel, CONSENT_CHANNELS.map(([k]) => k)) || "",
  customer_type: oneOf(body.customer_type, CUSTOMER_TYPES.map(([k]) => k)) || "", address_line1: clean(body.address_line1, 200), barangay: clean(body.barangay, 100),
  city_municipality: clean(body.city_municipality, 100), province: clean(body.province, 100), agent_id: toId(body.agent_id) ? String(toId(body.agent_id)) : "",
  consent: body.consent === "1", override_reason: clean(body.override_reason, 255),
});

export const create = async (req, res) => {
  const { errors, values } = validateNewCustomer(readNewForm(req.body));
  if (errors.length) { res.status(422); return res.render("customers/new", await newFormModel(req.user, values, errors)); }
  let result;
  try {
    result = await createStaffCustomer({ user: req.user, values: { ...values, agent_id: toId(values.agent_id) }, overrideReason: values.override_reason });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.status === 403) {
      await audit(req, "access_denied", { outcome: "denied", recordType: "customer", details: `create: ${err.message}` });
      return res.status(403).render("error", { title: "Access denied", status: 403, message: err.message });
    }
    res.status(422);
    return res.render("customers/new", await newFormModel(req.user, values, [err.message]));
  }
  if (!result.customer) {
    // TC-07: matches exist. Nothing is saved until the user opens an existing customer or confirms with a reason.
    await audit(req, "customer_duplicate_warning", {
      recordType: "customer", details: `Possible duplicate of ${result.duplicates.map((d) => d.customer_no).join(", ")}`,
      after: { mobile_masked: maskMobile(values.mobile), email_masked: maskEmail(values.email) },
    });
    res.status(409);
    return res.render("customers/new", await newFormModel(req.user, values, result.reasonTooShort ? [`Give a reason of at least ${MIN_REASON_LENGTH} characters to create the customer anyway.`] : [], result.duplicates, result.reasonTooShort));
  }
  const c = result.customer;
  await audit(req, "customer_created", { recordType: "customer", recordId: c.customer_no, after: { source: c.source, assigned_agent_id: result.agentId || null, customer_type: c.customer_type } });
  if (result.overridden) {
    await audit(req, "customer_duplicate_override", {
      recordType: "customer", recordId: c.customer_no, reason: result.reason, details: `Created although possible duplicates exist: ${result.duplicates.map((d) => d.customer_no).join(", ")}`,
    });
  }
  req.flash("success_msg", `Customer ${c.customer_no} was created${result.agentId ? " and assigned" : ""}.${result.overridden ? " The duplicate warning and your reason were recorded." : ""}`);
  res.redirect(`/crm/customers/${c.id}`);
};

// ---------------------------------------------------------------- detail

export const show = async (req, res) => {
  const id = toId(req.params.id);
  const customer = id ? await findCustomerForUser(id, req.user) : null;
  if (!customer) return notFound(res);
  const fullContact = can(req.user, "customers.view_full_contact");
  if (fullContact) {
    // Viewing personal data is recorded (who looked at which customer, and when).
    await audit(req, "customer_viewed", { recordType: "customer", recordId: customer.customer_no });
  }
  const canEdit = can(req.user, "customers.edit");
  const canAssign = can(req.user, "customers.assign_agent");
  const [{ rows: cases }, timeline, prefs, agents] = await Promise.all([
    listCases(req.user, { q: customer.customer_no, sort: "newest" }, { limit: 20, offset: 0 }),
    can(req.user, "interactions.view") ? customerTimeline(id, req.user) : Promise.resolve([]),
    getPreferences(id),
    canAssign ? assignableAgents(req.user) : Promise.resolve([]),
  ]);
  const show_ = (v, mask) => (fullContact ? v : mask(v));
  const loyalty = await customerLoyalty(customer.id, { limit: 0 });
  res.render("customers/show", { loyalty, canSeeLoyalty: can(req.user, "loyalty.view"),
    title: `${customer.first_name} ${customer.last_name}`,
    c: {
      ...customer,
      source_label: sourceLabel(customer.source),
      email_shown: show_(customer.email, maskEmail),
      mobile_shown: show_(customer.mobile, maskMobile),
      contacts: customer.contacts.map((k) => ({ ...k, value_shown: k.contact_type === "email" ? show_(k.value, maskEmail) : k.contact_type === "mobile" ? show_(k.value, maskMobile) : k.value, type_label: CONTACT_TYPES.find(([t]) => t === k.contact_type)?.[1] })),
    },
    cases, timeline, fullContact, canEdit, canAssign, canLog: can(req.user, "interactions.log"), canService: can(req.user, "cases.create_staff") && can(req.user, "followups.manage"),
    hasAccount: Boolean(customer.account_status),
    prefs: { marketing: prefs.marketing, fields: Object.entries(PREFERENCES).map(([key, def]) => ({ key, label: def.label, free: Boolean(def.free), max: def.max, value: prefs.values[key] || "", options: def.options ? def.options.map(([value, label]) => ({ value, label, sel: prefs.values[key] === value })) : null })) },
    contactTypes: pairs(CONTACT_TYPES), typeOptions: pairs(CUSTOMER_TYPES).map((o) => ({ ...o, sel: o.value === customer.customer_type })), consentOptions: pairs(CONSENT_CHANNELS),
    agents: agents.map((a) => ({ ...a, current: customer.assignment && a.id === customer.assignment.agent_id })),
    minReason: MIN_REASON_LENGTH,
    orders: (await recentOrdersForCustomer(id, req.user, 8)).map((o) => ({ ...o, status_label: ORDER_STATUS_LABELS[o.status], payment_label: PAYMENT_STATUS_LABELS[o.payment_status] })),
    canOrder: can(req.user, "orders.create"),
  });
};

// ---------------------------------------------------------------- actions on a customer (POST, then back to the detail page)

// Runs an action; known problems become a flash message on the customer page. Forbidden actions are audited.
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
      await audit(req, "access_denied", { outcome: "denied", recordType: "customer", recordId: id, details: `${name}: ${err.message}` });
      return res.status(403).render("error", { title: "Access denied", status: 403, message: err.message });
    }
    req.flash("error_msg", err.message);
  }
  res.redirect(`/crm/customers/${id}`);
};

const note = (req, field = "override_reason") => clean(req.body[field], 255);

export const saveProfile = action("profile", async (req, id) => {
  const change = await updateProfile({
    customerId: id, user: req.user,
    values: {
      first_name: clean(req.body.first_name, 80), last_name: clean(req.body.last_name, 80), customer_type: oneOf(req.body.customer_type, CUSTOMER_TYPES.map(([k]) => k)),
      status: oneOf(req.body.status, ["active", "inactive"]), notes: cleanText(req.body.notes, 2000),
    },
  });
  await audit(req, "customer_updated", { recordType: "customer", recordId: id, before: change.before, after: change.after });
  return "Profile saved.";
});

const duplicateAudit = (req, id, out, what) =>
  out.overridden && audit(req, "customer_duplicate_override", {
    recordType: "customer", recordId: id, reason: note(req), details: `${what} already used by: ${out.duplicates.map((d) => d.customer_no).join(", ")}`,
  });

export const contactAdd = action("contact", async (req, id) => {
  const out = await addContact({
    customerId: id, user: req.user, type: oneOf(req.body.contact_type, CONTACT_TYPES.map(([k]) => k)), value: clean(req.body.value, 254),
    makePrimary: req.body.make_primary === "1", overrideReason: note(req),
  });
  await audit(req, "customer_contact_added", { recordType: "customer", recordId: id, after: { type: out.type, primary: out.primary } });
  await duplicateAudit(req, id, out, `The ${out.type}`);
  return `Contact added${out.primary ? " as the primary " + out.type : ""}.`;
});

export const contactPrimary = action("contact", async (req, id) => {
  const contactId = toId(req.params.contactId);
  if (!contactId) throw new AppError("Contact not found.", 404);
  const out = await setPrimaryContact({ customerId: id, contactId, user: req.user, overrideReason: note(req) });
  await audit(req, "customer_contact_primary_changed", { recordType: "customer", recordId: id, after: { type: out.type } });
  await duplicateAudit(req, id, out, `The ${out.type}`);
  return `The primary ${out.type} was changed.`;
});

export const contactRemove = action("contact", async (req, id) => {
  const contactId = toId(req.params.contactId);
  if (!contactId) throw new AppError("Contact not found.", 404);
  const out = await removeContact({ customerId: id, contactId, user: req.user });
  await audit(req, "customer_contact_removed", { recordType: "customer", recordId: id, after: { type: out.type } });
  return "Contact removed.";
});

const readAddress = (b) => ({
  label: clean(b.label, 40), line1: clean(b.line1, 200), barangay: clean(b.barangay, 100), city_municipality: clean(b.city_municipality, 100),
  province: clean(b.province, 100), postal_code: clean(b.postal_code, 10), is_default: b.is_default === "1",
});

export const addressAdd = action("address", async (req, id) => {
  const out = await addAddress({ customerId: id, user: req.user, data: readAddress(req.body) });
  await audit(req, "customer_address_added", { recordType: "customer", recordId: id, after: { label: out.label, is_default: out.is_default } });
  return "Address added.";
});

export const addressUpdate = action("address", async (req, id) => {
  const addressId = toId(req.params.addressId);
  if (!addressId) throw new AppError("Address not found.", 404);
  const out = await updateAddress({ customerId: id, addressId, user: req.user, data: readAddress(req.body) });
  await audit(req, "customer_address_updated", { recordType: "customer", recordId: id, before: out.before, after: out.after });
  return "Address saved.";
});

export const addressDefault = action("address", async (req, id) => {
  const addressId = toId(req.params.addressId);
  if (!addressId) throw new AppError("Address not found.", 404);
  await setDefaultAddress({ customerId: id, addressId, user: req.user });
  return "Default address changed.";
});

export const addressRemove = action("address", async (req, id) => {
  const addressId = toId(req.params.addressId);
  if (!addressId) throw new AppError("Address not found.", 404);
  await removeAddress({ customerId: id, addressId, user: req.user });
  await audit(req, "customer_address_removed", { recordType: "customer", recordId: id });
  return "Address removed.";
});

export const preferencesSave = action("preferences", async (req, id) => {
  const { errors, values } = validatePreferences(req.body);
  const channel = oneOf(req.body.consent_channel, CONSENT_CHANNELS.map(([k]) => k));
  const marketing = { marketing_sms: req.body.marketing_sms === "1", marketing_email: req.body.marketing_email === "1" };
  if (errors.length) throw new AppError(errors.join(" "), 422);
  if (!channel) throw new AppError("Choose how the customer gave or withdrew consent.", 422);
  if (!(await findCustomerForUser(id, req.user))) throw new AppError("Customer not found.", 404);
  const out = await savePreferences({ customerId: id, actor: req.user, values, marketing, channel });
  await audit(req, "customer_preferences_updated", { recordType: "customer", recordId: id, before: out.before, after: out.after, details: out.consentChanges.join("; ") || null });
  return out.consentChanges.length ? "Preferences and marketing consent saved." : "Preferences saved.";
});

export const assign = action("assign", async (req, id) => {
  const agentId = toId(req.body.agent_id);
  if (!agentId) throw new AppError("Choose an agent.");
  const out = await assignCustomer({ customerId: id, actor: req.user, agentId, note: clean(req.body.note, 255) });
  await audit(req, "customer_assigned", { recordType: "customer", recordId: id, before: { agent_id: out.previousAgentId }, after: { agent_id: out.agent.id, team_id: out.agent.team_id } });
  return `Customer assigned to ${out.agent.name}.`;
});

export const unassign = action("assign", async (req, id) => {
  const out = await unassignCustomer({ customerId: id, actor: req.user });
  await audit(req, "customer_unassigned", { recordType: "customer", recordId: id, before: { agent_id: out.agentId } });
  return "The assignment was ended.";
});

// ---------------------------------------------------------------- customer's own contact preferences (portal)

const portalModel = async (user, extra = {}) => {
  const prefs = await getPreferences(user.customer_id);
  return {
    title: "Contact Preferences",
    marketing: prefs.marketing,
    fields: Object.entries(PREFERENCES).map(([key, def]) => ({ key, label: def.label, free: Boolean(def.free), max: def.max, value: prefs.values[key] || "", options: def.options ? def.options.map(([value, label]) => ({ value, label, sel: prefs.values[key] === value })) : null })),
    consents: prefs.consents,
    ...extra,
  };
};

export const portalPreferences = async (req, res) => res.render("customers/portal_preferences", await portalModel(req.user));

export const portalPreferencesSave = async (req, res) => {
  const { errors, values } = validatePreferences(req.body);
  const marketing = { marketing_sms: req.body.marketing_sms === "1", marketing_email: req.body.marketing_email === "1" };
  if (errors.length) { res.status(422); return res.render("customers/portal_preferences", await portalModel(req.user, { errors })); }
  const out = await savePreferences({ customerId: req.user.customer_id, actor: req.user, values, marketing, channel: "portal" });
  await audit(req, "customer_preferences_updated", { recordType: "customer", recordId: req.user.customer_id, before: out.before, after: out.after, details: out.consentChanges.join("; ") || null });
  req.flash("success_msg", "Your contact preferences were saved.");
  res.redirect("/portal/preferences");
};
