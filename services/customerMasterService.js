/*
 * Customer master, P3 (blueprint §7): walk-in customer creation with a duplicate check (TC-07), profile,
 * contacts, addresses, contact preferences and marketing consent, the interaction timeline and the
 * agent-customer assignment. Record scope comes from customerService.directoryScope and is applied on
 * every read and write, not only in the screens.
 *
 * customers.email / customers.mobile (and their normalized copies used by the duplicate check) always mirror the
 * PRIMARY email / mobile row of customer_contacts. A primary email that is also a portal login is changed only
 * through the account, never here.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { AppError } from "../helpers/errors.js";
import { normalizeEmail, normalizeMobile, maskEmail, maskMobile } from "../helpers/mask.js";
import { isEmail } from "../helpers/validators.js";
import { config } from "../config/index.js";
import {
  createCustomerRecord, recordConsents, directoryScope, findCustomerForUser, PRIVACY_POLICY_VERSION,
} from "./customerService.js";
import { scopeFor, assignableAgents } from "./caseService.js";
import { notify } from "./notificationService.js";

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
const exec = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction });

export const MIN_REASON_LENGTH = 5;
export const SOURCES = [["walk_in", "Walk-in"], ["phone", "Phone"], ["social", "Social media"], ["referral", "Referral"], ["other", "Other"]];
export const CONSENT_CHANNELS = [["in_store", "In store"], ["phone", "By phone"], ["paper", "Paper form"]];
export const CONTACT_TYPES = [["mobile", "Mobile"], ["landline", "Landline"], ["email", "Email"], ["messenger", "Messenger"], ["other", "Other"]];
export const CUSTOMER_TYPES = [["individual", "Individual"], ["business", "Business"]];
export const INTERACTION_TYPES = [["call", "Phone call"], ["visit", "In-store visit"], ["sms", "SMS"], ["email", "Email"], ["chat", "Chat"], ["note", "Internal note"]];
export const INTERACTION_DIRECTIONS = [["inbound", "Customer contacted us"], ["outbound", "We contacted the customer"]];
export const TYPE_LABELS = { ...Object.fromEntries(INTERACTION_TYPES), portal: "Portal" };
export const PREFERENCES = {
  preferred_channel: { label: "Preferred way to reach me", options: [["sms", "SMS"], ["email", "Email"], ["call", "Phone call"], ["messenger", "Messenger"]] },
  preferred_language: { label: "Language", options: [["english", "English"], ["filipino", "Filipino"]] },
  preferred_contact_time: { label: "Best time to contact", options: [["morning", "Morning"], ["afternoon", "Afternoon"], ["evening", "Evening"], ["any", "Any time"]] },
  preferred_branch: { label: "Preferred branch", free: true, max: 80 },
};
const labelOf = (list, value) => (list.find(([v]) => v === value) || [])[1] || value;
export const sourceLabel = (v) => labelOf(SOURCES, v);

const isMobile = (m) => /^09\d{9}$/.test(m || "");

// ---------------------------------------------------------------- scope helpers

const inScope = async (customerId, user, transaction) => {
  const scope = directoryScope(user);
  const [row] = await select(`SELECT c.id FROM customers c WHERE c.id = :customerId AND c.status <> 'merged' AND ${scope.sql}`, { customerId, ...scope.params }, transaction);
  return Boolean(row);
};

const requireCustomer = async (customerId, user, transaction) => {
  if (!(await inScope(customerId, user, transaction))) throw new AppError("Customer not found.", 404);
  const [row] = await select("SELECT c.* FROM customers c WHERE c.id = :customerId FOR UPDATE", { customerId }, transaction);
  return row;
};

// ---------------------------------------------------------------- duplicate check (TC-07)

/*
 * Matches an existing customer on: normalized email, normalized mobile, or the same full name with a mobile that
 * ends in the same 7 digits (catches a mistyped prefix). Only masked data is returned, so a match outside the
 * viewer's scope is still safe to show; `inScope` says whether they may open it.
 */
export const findDuplicates = async ({ firstName, lastName, email, mobile, excludeId = null }, user, transaction) => {
  const ne = normalizeEmail(email);
  const nm = normalizeMobile(mobile);
  if (!ne && !nm) return [];
  const rows = await select(
    `SELECT c.id, c.customer_no, c.first_name, c.last_name, c.email, c.mobile, c.normalized_email, c.normalized_mobile, c.source, c.created_at
     FROM customers c
     WHERE c.status <> 'merged' AND (:ex IS NULL OR c.id <> :ex)
       AND ((:ne IS NOT NULL AND c.normalized_email = :ne)
         OR (:nm IS NOT NULL AND c.normalized_mobile = :nm)
         OR (:nm IS NOT NULL AND c.normalized_mobile IS NOT NULL AND LOWER(c.first_name) = :fn AND LOWER(c.last_name) = :ln
             AND RIGHT(c.normalized_mobile, 7) = RIGHT(:nm, 7)))
     ORDER BY c.id LIMIT 10`,
    { ex: excludeId, ne, nm, fn: String(firstName || "").trim().toLowerCase(), ln: String(lastName || "").trim().toLowerCase() }, transaction
  );
  if (!rows.length) return [];
  const scope = directoryScope(user);
  const visible = new Set((await select(`SELECT c.id FROM customers c WHERE c.id IN (:ids) AND ${scope.sql}`, { ids: rows.map((r) => r.id), ...scope.params }, transaction)).map((r) => r.id));
  return rows.map((r) => {
    const reasons = [];
    if (ne && r.normalized_email === ne) reasons.push("Same email");
    if (nm && r.normalized_mobile === nm) reasons.push("Same mobile number");
    if (!reasons.includes("Same mobile number") && nm && r.normalized_mobile && r.normalized_mobile.slice(-7) === nm.slice(-7)) reasons.push("Same name and similar mobile number");
    return {
      id: r.id, customer_no: r.customer_no, name: `${r.first_name} ${r.last_name}`, email_masked: maskEmail(r.email), mobile_masked: maskMobile(r.mobile),
      source: r.source, created_at: r.created_at, reasons, in_scope: visible.has(r.id),
    };
  });
};

// ---------------------------------------------------------------- validation

export const validateNewCustomer = (raw) => {
  const errors = [];
  const v = {
    first_name: raw.first_name, last_name: raw.last_name, email: raw.email, mobile: raw.mobile, source: raw.source,
    consent_channel: raw.consent_channel, address_line1: raw.address_line1, barangay: raw.barangay, city_municipality: raw.city_municipality,
    province: raw.province, customer_type: raw.customer_type || "individual", agent_id: raw.agent_id, consent: raw.consent, override_reason: raw.override_reason,
  };
  if (!v.first_name || v.first_name.length < 2) errors.push("Enter the first name (at least 2 characters).");
  if (!v.last_name || v.last_name.length < 2) errors.push("Enter the last name (at least 2 characters).");
  if (!v.email && !v.mobile) errors.push("Enter a mobile number or an email address.");
  if (v.email && !isEmail(v.email)) errors.push("Enter a valid email address.");
  if (v.mobile && !isMobile(normalizeMobile(v.mobile))) errors.push("Enter a valid Philippine mobile number (for example 0917 123 4567).");
  if (!SOURCES.some(([k]) => k === v.source)) errors.push("Choose how the customer reached us.");
  if (!CUSTOMER_TYPES.some(([k]) => k === v.customer_type)) errors.push("Choose the customer type.");
  if (!CONSENT_CHANNELS.some(([k]) => k === v.consent_channel)) errors.push("Choose how the privacy consent was given.");
  if (!v.consent) errors.push("Confirm that the customer agreed to the Data Privacy Notice.");
  if (v.address_line1 && v.address_line1.length < 5) errors.push("The address line is too short (at least 5 characters).");
  return { errors, values: v };
};

// ---------------------------------------------------------------- create (walk-in / phone customers)

/*
 * Returns { duplicates } when matches exist and no override reason was given (nothing is saved), otherwise
 * { customer, duplicates, overridden }. An Agent who creates a customer is assigned as its agent; a Team Leader or
 * the Manager may pick an agent.
 */
export const createStaffCustomer = async ({ user, values, overrideReason = "" }) => {
  const v = values;
  const email = v.email || null;
  const mobile = v.mobile ? normalizeMobile(v.mobile) : null;
  return sequelize.transaction(async (transaction) => {
    const duplicates = await findDuplicates({ firstName: v.first_name, lastName: v.last_name, email, mobile }, user, transaction);
    const reason = String(overrideReason || "").trim();
    if (duplicates.length && reason.length < MIN_REASON_LENGTH) return { duplicates, customer: null, overridden: false, reasonTooShort: reason.length > 0 };
    let agentId = null;
    if (user.role === "agent") agentId = user.id;
    else if (v.agent_id) {
      const [agent] = await select("SELECT id, team_id FROM crm_users WHERE id = :id AND role = 'agent' AND is_active = 1 AND access_revoked_at IS NULL", { id: v.agent_id }, transaction);
      if (!agent) throw new AppError("Choose an active agent.", 422);
      if (user.role === "team_leader" && Number(agent.team_id) !== Number(user.team_id)) throw new AppError("Team Leaders can assign only agents from their own team.", 403);
      agentId = agent.id;
    }
    const customer = await createCustomerRecord({
      firstName: v.first_name, lastName: v.last_name, email, mobile, customerType: v.customer_type, source: v.source, createdBy: user.id,
      address: v.address_line1 ? { line1: v.address_line1, barangay: v.barangay, city_municipality: v.city_municipality, province: v.province } : null,
    }, transaction);
    await recordConsents(customer.id, { channel: v.consent_channel, recordedBy: user.id, kinds: ["data_privacy"] }, transaction);
    if (agentId) await exec("INSERT INTO agent_assignments (customer_id, agent_id, assigned_by, assigned_at, note) VALUES (?, ?, ?, NOW(), ?)", [customer.id, agentId, user.id, "Assigned when the customer was created"], transaction);
    return { duplicates, customer, overridden: duplicates.length > 0, reason, agentId };
  });
};

// ---------------------------------------------------------------- profile

export const updateProfile = async ({ customerId, user, values }) =>
  sequelize.transaction(async (transaction) => {
    const before = await requireCustomer(customerId, user, transaction);
    const errors = [];
    if (!values.first_name || values.first_name.length < 2) errors.push("Enter the first name (at least 2 characters).");
    if (!values.last_name || values.last_name.length < 2) errors.push("Enter the last name (at least 2 characters).");
    if (!CUSTOMER_TYPES.some(([k]) => k === values.customer_type)) errors.push("Choose the customer type.");
    if (!["active", "inactive"].includes(values.status)) errors.push("Choose a valid status.");
    if (errors.length) throw new AppError(errors.join(" "), 422);
    await exec("UPDATE customers SET first_name = ?, last_name = ?, customer_type = ?, status = ?, notes = ? WHERE id = ?",
      [values.first_name, values.last_name, values.customer_type, values.status, values.notes || null, customerId], transaction);
    await exec("UPDATE crm_users u JOIN customer_accounts ca ON ca.user_id = u.id SET u.display_name = ? WHERE ca.customer_id = ?", [`${values.first_name} ${values.last_name}`, customerId], transaction);
    return {
      before: { first_name: before.first_name, last_name: before.last_name, customer_type: before.customer_type, status: before.status, notes: before.notes ? "(set)" : null },
      after: { first_name: values.first_name, last_name: values.last_name, customer_type: values.customer_type, status: values.status, notes: values.notes ? "(set)" : null },
    };
  });

// ---------------------------------------------------------------- contacts

const validateContact = (type, rawValue) => {
  const value = String(rawValue || "").trim();
  if (!CONTACT_TYPES.some(([k]) => k === type)) throw new AppError("Choose the contact type.", 422);
  if (type === "email") {
    if (!isEmail(value)) throw new AppError("Enter a valid email address.", 422);
    return value;
  }
  if (type === "mobile") {
    const n = normalizeMobile(value);
    if (!isMobile(n)) throw new AppError("Enter a valid Philippine mobile number (for example 0917 123 4567).", 422);
    return n;
  }
  if (type === "landline") {
    const digits = value.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 12) throw new AppError("Enter a valid landline number.", 422);
    return value.slice(0, 30);
  }
  if (value.length < 3 || value.length > 120) throw new AppError("The contact value must be 3 to 120 characters.", 422);
  return value;
};

// Makes `contact` the primary of its type; email and mobile also update the customer columns the duplicate check uses.
const promoteContact = async (customer, contact, user, overrideReason, transaction) => {
  const type = contact.contact_type;
  if (type === "email" || type === "mobile") {
    const [account] = await select("SELECT id FROM customer_accounts WHERE customer_id = :id", { id: customer.id }, transaction);
    if (type === "email" && account && normalizeEmail(contact.value) !== customer.normalized_email) {
      throw new AppError("This customer signs in with their primary email. The customer changes it from their own account.", 422);
    }
    const duplicates = await findDuplicates(
      { firstName: customer.first_name, lastName: customer.last_name, email: type === "email" ? contact.value : null, mobile: type === "mobile" ? contact.value : null, excludeId: customer.id },
      user, transaction
    );
    if (duplicates.length && String(overrideReason || "").trim().length < MIN_REASON_LENGTH) {
      const err = new AppError(`This ${type} already belongs to ${duplicates.map((d) => `${d.name} (${d.customer_no})`).join(", ")}. Give a reason (at least ${MIN_REASON_LENGTH} characters) to use it anyway.`, 422);
      err.duplicates = duplicates;
      throw err;
    }
    const col = type === "email" ? "email = ?, normalized_email = ?" : "mobile = ?, normalized_mobile = ?";
    await exec(`UPDATE customers SET ${col} WHERE id = ?`, [contact.value, type === "email" ? normalizeEmail(contact.value) : normalizeMobile(contact.value), customer.id], transaction);
    if (duplicates.length) return { duplicates };
  }
  await exec("UPDATE customer_contacts SET is_primary = 0 WHERE customer_id = ? AND contact_type = ?", [customer.id, type], transaction);
  await exec("UPDATE customer_contacts SET is_primary = 1 WHERE id = ?", [contact.id], transaction);
  return { duplicates: [] };
};

export const addContact = async ({ customerId, user, type, value, makePrimary = false, overrideReason = "" }) =>
  sequelize.transaction(async (transaction) => {
    const customer = await requireCustomer(customerId, user, transaction);
    const clean = validateContact(type, value);
    const same = (await select("SELECT id, value FROM customer_contacts WHERE customer_id = :id AND contact_type = :type", { id: customerId, type }, transaction))
      .some((c) => (type === "email" ? normalizeEmail(c.value) === normalizeEmail(clean) : c.value === clean));
    if (same) throw new AppError("This customer already has that contact.", 422);
    const [{ n }] = await select("SELECT COUNT(*) AS n FROM customer_contacts WHERE customer_id = :id", { id: customerId }, transaction);
    if (Number(n) >= 12) throw new AppError("A customer can have at most 12 contacts.", 422);
    const [hasPrimary] = await select("SELECT id FROM customer_contacts WHERE customer_id = :id AND contact_type = :type AND is_primary = 1", { id: customerId, type }, transaction);
    const primary = makePrimary || !hasPrimary; // the first email / mobile / ... of a customer is primary
    const [result] = await sequelize.query("INSERT INTO customer_contacts (customer_id, contact_type, value, is_primary) VALUES (?, ?, ?, 0)", { replacements: [customerId, type, clean], transaction });
    const contact = { id: result, contact_type: type, value: clean };
    const out = primary ? await promoteContact(customer, contact, user, overrideReason, transaction) : { duplicates: [] };
    return { type, primary, overridden: out.duplicates.length > 0, duplicates: out.duplicates };
  });

export const setPrimaryContact = async ({ customerId, contactId, user, overrideReason = "" }) =>
  sequelize.transaction(async (transaction) => {
    const customer = await requireCustomer(customerId, user, transaction);
    const [contact] = await select("SELECT id, contact_type, value, is_primary FROM customer_contacts WHERE id = :contactId AND customer_id = :customerId", { contactId, customerId }, transaction);
    if (!contact) throw new AppError("Contact not found.", 404);
    if (contact.is_primary) throw new AppError("This contact is already the primary one.", 422);
    const out = await promoteContact(customer, contact, user, overrideReason, transaction);
    return { type: contact.contact_type, overridden: out.duplicates.length > 0, duplicates: out.duplicates };
  });

export const removeContact = async ({ customerId, contactId, user }) =>
  sequelize.transaction(async (transaction) => {
    await requireCustomer(customerId, user, transaction);
    const [contact] = await select("SELECT id, contact_type, is_primary FROM customer_contacts WHERE id = :contactId AND customer_id = :customerId", { contactId, customerId }, transaction);
    if (!contact) throw new AppError("Contact not found.", 404);
    if (contact.is_primary) throw new AppError("A primary contact cannot be removed. Make another contact primary first.", 422);
    await exec("DELETE FROM customer_contacts WHERE id = ?", [contactId], transaction);
    return { type: contact.contact_type };
  });

// ---------------------------------------------------------------- addresses

const validateAddress = (a) => {
  const line1 = String(a.line1 || "").trim();
  if (line1.length < 5 || line1.length > 200) throw new AppError("The address line must be 5 to 200 characters.", 422);
  if (a.postal_code && !/^\d{4}$/.test(a.postal_code)) throw new AppError("The postal code has 4 digits.", 422);
  return { label: a.label || null, line1, barangay: a.barangay || null, city_municipality: a.city_municipality || null, province: a.province || null, postal_code: a.postal_code || null };
};

export const addAddress = async ({ customerId, user, data }) =>
  sequelize.transaction(async (transaction) => {
    await requireCustomer(customerId, user, transaction);
    const a = validateAddress(data);
    const [{ n }] = await select("SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = :id", { id: customerId }, transaction);
    if (Number(n) >= 10) throw new AppError("A customer can have at most 10 addresses.", 422);
    const makeDefault = data.is_default || Number(n) === 0;
    if (makeDefault) await exec("UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?", [customerId], transaction);
    await exec("INSERT INTO customer_addresses (customer_id, label, line1, barangay, city_municipality, province, postal_code, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [customerId, a.label, a.line1, a.barangay, a.city_municipality, a.province, a.postal_code, makeDefault ? 1 : 0], transaction);
    return { label: a.label, is_default: makeDefault };
  });

export const updateAddress = async ({ customerId, addressId, user, data }) =>
  sequelize.transaction(async (transaction) => {
    await requireCustomer(customerId, user, transaction);
    const [old] = await select("SELECT * FROM customer_addresses WHERE id = :addressId AND customer_id = :customerId", { addressId, customerId }, transaction);
    if (!old) throw new AppError("Address not found.", 404);
    const a = validateAddress(data);
    await exec("UPDATE customer_addresses SET label = ?, line1 = ?, barangay = ?, city_municipality = ?, province = ?, postal_code = ? WHERE id = ?",
      [a.label, a.line1, a.barangay, a.city_municipality, a.province, a.postal_code, addressId], transaction);
    return { before: { line1: old.line1 }, after: { line1: a.line1 } };
  });

export const setDefaultAddress = async ({ customerId, addressId, user }) =>
  sequelize.transaction(async (transaction) => {
    await requireCustomer(customerId, user, transaction);
    const [a] = await select("SELECT id FROM customer_addresses WHERE id = :addressId AND customer_id = :customerId", { addressId, customerId }, transaction);
    if (!a) throw new AppError("Address not found.", 404);
    await exec("UPDATE customer_addresses SET is_default = (id = ?) WHERE customer_id = ?", [addressId, customerId], transaction);
  });

export const removeAddress = async ({ customerId, addressId, user }) =>
  sequelize.transaction(async (transaction) => {
    await requireCustomer(customerId, user, transaction);
    const [a] = await select("SELECT id, is_default FROM customer_addresses WHERE id = :addressId AND customer_id = :customerId", { addressId, customerId }, transaction);
    if (!a) throw new AppError("Address not found.", 404);
    await exec("DELETE FROM customer_addresses WHERE id = ?", [addressId], transaction);
    if (a.is_default) await exec("UPDATE customer_addresses SET is_default = 1 WHERE customer_id = ? ORDER BY id LIMIT 1", [customerId], transaction);
  });

// ---------------------------------------------------------------- preferences and marketing consent

export const getPreferences = async (customerId) => {
  const rows = await select("SELECT preference_key, preference_value FROM customer_preferences WHERE customer_id = :customerId", { customerId });
  const values = Object.fromEntries(rows.map((r) => [r.preference_key, r.preference_value]));
  const consents = await select(
    `SELECT c.consent_type, c.granted, c.channel, c.granted_at, c.withdrawn_at FROM customer_consents c
     WHERE c.customer_id = :customerId AND c.consent_type IN ('marketing_sms','marketing_email')
       AND c.id = (SELECT MAX(x.id) FROM customer_consents x WHERE x.customer_id = c.customer_id AND x.consent_type = c.consent_type)`,
    { customerId }
  );
  const marketing = { marketing_sms: false, marketing_email: false };
  for (const c of consents) marketing[c.consent_type] = Boolean(c.granted);
  return { values, marketing, consents };
};

export const validatePreferences = (raw) => {
  const errors = [];
  const values = {};
  for (const [key, def] of Object.entries(PREFERENCES)) {
    const v = String(raw[key] || "").trim();
    if (!v) continue;
    if (def.free) {
      if (v.length > def.max) errors.push(`${def.label}: at most ${def.max} characters.`);
      else values[key] = v;
    } else if (def.options.some(([k]) => k === v)) values[key] = v;
    else errors.push(`${def.label}: choose one of the listed options.`);
  }
  return { errors, values };
};

// Applies preference values and marketing consent. `actor` is the customer (portal) or the staff member.
export const savePreferences = async ({ customerId, actor, values, marketing, channel }) =>
  sequelize.transaction(async (transaction) => {
    const current = await getPreferences(customerId);
    for (const key of Object.keys(PREFERENCES)) {
      const next = values[key];
      if (next) {
        await exec(`INSERT INTO customer_preferences (customer_id, preference_key, preference_value) VALUES (?, ?, ?)
                    ON DUPLICATE KEY UPDATE preference_value = VALUES(preference_value)`, [customerId, key, next], transaction);
      } else await exec("DELETE FROM customer_preferences WHERE customer_id = ? AND preference_key = ?", [customerId, key], transaction);
    }
    const changed = [];
    for (const type of ["marketing_sms", "marketing_email"]) {
      const want = Boolean(marketing[type]);
      if (want === current.marketing[type]) continue;
      await exec(
        `INSERT INTO customer_consents (customer_id, consent_type, granted, policy_version, channel, recorded_by, granted_at, withdrawn_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [customerId, type, want ? 1 : 0, PRIVACY_POLICY_VERSION, channel, actor.id, want ? new Date() : null, want ? null : new Date()], transaction
      );
      changed.push(`${type}: ${current.marketing[type] ? "on" : "off"} → ${want ? "on" : "off"}`);
    }
    return { before: { ...current.values, ...current.marketing }, after: { ...values, ...marketing }, consentChanges: changed };
  });

// ---------------------------------------------------------------- interactions

// "2026-11-13T14:30" (datetime-local, Asia/Manila) -> Date; empty means now.
const parseWhen = (raw) => {
  if (!raw) return new Date();
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(raw);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:00${config.db.timezone}`);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const validateInteraction = (raw) => {
  const errors = [];
  const v = { customer_id: raw.customer_id, type: raw.type, direction: raw.direction, subject: raw.subject, summary: raw.summary, occurred_at: raw.occurred_at, case_no: raw.case_no };
  if (!v.customer_id) errors.push("Choose the customer.");
  if (!INTERACTION_TYPES.some(([k]) => k === v.type)) errors.push("Choose the type of interaction.");
  if (v.type === "note") v.direction = "internal";
  else if (!INTERACTION_DIRECTIONS.some(([k]) => k === v.direction)) errors.push("Choose who contacted whom.");
  if (!v.subject || v.subject.length < 5) errors.push("Give the interaction a subject (at least 5 characters).");
  if (v.summary && v.summary.length > 2000) errors.push("The summary is too long (2000 characters at most).");
  const when = parseWhen(v.occurred_at);
  if (!when) errors.push("Enter a valid date and time.");
  else if (when.getTime() > Date.now() + 5 * 60 * 1000) errors.push("The interaction cannot be in the future.");
  else if (when.getTime() < Date.now() - 366 * 86400000) errors.push("The interaction is more than a year old.");
  v.when = when;
  return { errors, values: v };
};

export const logInteraction = async ({ user, values }) =>
  sequelize.transaction(async (transaction) => {
    if (!(await inScope(values.customer_id, user, transaction))) throw new AppError("Customer not found.", 404);
    let relatedType = null;
    let relatedId = null;
    if (values.case_no) { // optional link to one of THIS customer's cases that the user may see
      const scope = scopeFor(user);
      const [k] = await select(`SELECT k.id, k.customer_id FROM customer_cases k WHERE k.case_no = :no AND ${scope.sql}`, { no: values.case_no, ...scope.params }, transaction);
      if (!k || Number(k.customer_id) !== Number(values.customer_id)) throw new AppError("That case number was not found for this customer.", 422);
      relatedType = "case";
      relatedId = k.id;
    }
    const [id] = await sequelize.query(
      `INSERT INTO customer_interactions (customer_id, crm_user_id, interaction_type, direction, subject, summary, related_type, related_id, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      { replacements: [values.customer_id, user.id, values.type, values.direction, values.subject, values.summary || null, relatedType, relatedId, values.when], transaction }
    );
    return { id, relatedId };
  });

const INTERACTION_COLUMNS = `i.id, i.interaction_type, i.direction, i.subject, i.summary, i.related_type, i.related_id, i.occurred_at, i.is_demo,
  c.id AS customer_id, c.customer_no, CONCAT(c.first_name, ' ', c.last_name) AS customer_name,
  u.display_name AS logged_by, u.role AS logged_by_role, k.case_no`;
const INTERACTION_FROM = `FROM customer_interactions i
  JOIN customers c ON c.id = i.customer_id
  LEFT JOIN crm_users u ON u.id = i.crm_user_id
  LEFT JOIN customer_cases k ON i.related_type = 'case' AND k.id = i.related_id`;

export const listInteractions = async (user, { q, type, customerId, mine, limit, offset }) => {
  const scope = directoryScope(user);
  const where = [scope.sql, "c.status <> 'merged'"];
  const params = { ...scope.params };
  if (q) {
    where.push("(i.subject LIKE :q OR i.summary LIKE :q OR c.customer_no LIKE :q OR CONCAT(c.first_name, ' ', c.last_name) LIKE :q)");
    params.q = `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
  }
  if (type) { where.push("i.interaction_type = :type"); params.type = type; }
  if (customerId) { where.push("i.customer_id = :customerId"); params.customerId = customerId; }
  if (mine) { where.push("i.crm_user_id = :viewer"); params.viewer = user.id; }
  const [{ total }] = await select(`SELECT COUNT(*) AS total ${INTERACTION_FROM} WHERE ${where.join(" AND ")}`, params);
  const rows = await select(`SELECT ${INTERACTION_COLUMNS} ${INTERACTION_FROM} WHERE ${where.join(" AND ")} ORDER BY i.occurred_at DESC, i.id DESC LIMIT :limit OFFSET :offset`, { ...params, limit, offset });
  return { total: Number(total), rows };
};

export const findInteraction = async (id, user) => {
  const scope = directoryScope(user);
  const [row] = await select(`SELECT ${INTERACTION_COLUMNS} ${INTERACTION_FROM} WHERE i.id = :id AND ${scope.sql}`, { id, ...scope.params });
  return row || null;
};

export const countInteractions = async (user, { mine = false } = {}) => (await listInteractions(user, { mine, limit: 1, offset: 0 })).total;

// Interactions plus the customer's cases (submitted), newest first. Only what the viewer may see.
export const customerTimeline = async (customerId, user, limit = 30) => {
  const interactions = await select(
    `SELECT i.id, i.interaction_type, i.direction, i.subject, i.summary, i.occurred_at, u.display_name AS logged_by, k.case_no, k.id AS case_id
     FROM customer_interactions i LEFT JOIN crm_users u ON u.id = i.crm_user_id LEFT JOIN customer_cases k ON i.related_type = 'case' AND k.id = i.related_id
     WHERE i.customer_id = :customerId ORDER BY i.occurred_at DESC, i.id DESC LIMIT :limit`, { customerId, limit });
  const cases = await select(
    `SELECT k.id, k.case_no, k.subject, k.status, k.created_at FROM customer_cases k
     WHERE k.customer_id = :customerId ${user.role === "agent" ? "AND k.assigned_agent_id = :me" : user.role === "team_leader" ? "AND (k.team_id = :teamId OR (k.team_id IS NULL AND k.assigned_agent_id IS NULL))" : ""}
     ORDER BY k.created_at DESC LIMIT :limit`, { customerId, limit, me: user.id, teamId: user.team_id || 0 });
  const events = [
    ...interactions.map((i) => ({ kind: "interaction", at: i.occurred_at, type: i.interaction_type, direction: i.direction, title: i.subject, text: i.summary, by: i.logged_by, id: i.id, case_no: i.case_no, case_id: i.case_id })),
    ...cases.map((k) => ({ kind: "case", at: k.created_at, title: `Case ${k.case_no} submitted`, text: k.subject, id: k.id, case_no: k.case_no, case_id: k.id, status: k.status })),
  ];
  return events.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
};

// Customers the user may log an interaction for (a short list for the form's dropdown).
export const pickableCustomers = async (user, limit = 200) => {
  const scope = directoryScope(user);
  return select(`SELECT c.id, c.customer_no, CONCAT(c.first_name, ' ', c.last_name) AS name FROM customers c WHERE c.status <> 'merged' AND ${scope.sql} ORDER BY c.last_name, c.first_name LIMIT :limit`, { ...scope.params, limit });
};

// ---------------------------------------------------------------- agent-customer assignment

export const assignCustomer = async ({ customerId, actor, agentId, note = "" }) => {
  const result = await sequelize.transaction(async (transaction) => {
    if (!["team_leader", "crm_manager"].includes(actor.role)) throw new AppError("Only a Team Leader or the CRM Manager can assign customers.", 403);
    const customer = await requireCustomer(customerId, actor, transaction);
    const [agent] = await select(
      `SELECT u.id, u.display_name AS name, u.team_id FROM crm_users u
       JOIN employee_references e ON e.employee_id = u.employee_id AND e.employment_status IN ('active','on_leave')
       WHERE u.id = :agentId AND u.role = 'agent' AND u.is_active = 1 AND u.access_revoked_at IS NULL`, { agentId }, transaction);
    if (!agent) throw new AppError("Choose an active agent.", 422);
    if (actor.role === "team_leader" && Number(agent.team_id) !== Number(actor.team_id)) throw new AppError("Team Leaders can assign only agents from their own team.", 403);
    const [current] = await select("SELECT id, agent_id FROM agent_assignments WHERE customer_id = :customerId AND ended_at IS NULL ORDER BY id DESC LIMIT 1", { customerId }, transaction);
    if (current && Number(current.agent_id) === Number(agent.id)) throw new AppError(`This customer is already assigned to ${agent.name}.`, 422);
    if (current) await exec("UPDATE agent_assignments SET ended_at = NOW() WHERE customer_id = ? AND ended_at IS NULL", [customerId], transaction);
    await exec("INSERT INTO agent_assignments (customer_id, agent_id, assigned_by, assigned_at, note) VALUES (?, ?, ?, NOW(), ?)", [customerId, agent.id, actor.id, note || null], transaction);
    return { agent, customer, previousAgentId: current ? current.agent_id : null };
  });
  await notify(result.agent.id, {
    type: "assignment", title: `Customer ${result.customer.customer_no} was assigned to you`, message: `${result.customer.first_name} ${result.customer.last_name}`,
    link: `/crm/customers/${result.customer.id}`, relatedType: "customer", relatedId: result.customer.id,
  });
  return result;
};

export const unassignCustomer = async ({ customerId, actor }) =>
  sequelize.transaction(async (transaction) => {
    if (!["team_leader", "crm_manager"].includes(actor.role)) throw new AppError("Only a Team Leader or the CRM Manager can change customer assignments.", 403);
    await requireCustomer(customerId, actor, transaction);
    const [current] = await select(
      `SELECT aa.id, aa.agent_id, ag.team_id FROM agent_assignments aa JOIN crm_users ag ON ag.id = aa.agent_id
       WHERE aa.customer_id = :customerId AND aa.ended_at IS NULL ORDER BY aa.id DESC LIMIT 1`, { customerId }, transaction);
    if (!current) throw new AppError("This customer has no assigned agent.", 422);
    if (actor.role === "team_leader" && Number(current.team_id) !== Number(actor.team_id)) throw new AppError("Team Leaders can change only their own team's assignments.", 403);
    await exec("UPDATE agent_assignments SET ended_at = NOW() WHERE customer_id = ? AND ended_at IS NULL", [customerId], transaction);
    return { agentId: current.agent_id };
  });

export { findCustomerForUser, assignableAgents };
