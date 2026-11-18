/*
 * Customer master (CRM owns customers; blueprint §7). Portal registration creates, in ONE transaction:
 * customers (UUID + CUS- number), customer_contacts, customer_addresses, crm_users (role customer),
 * customer_accounts (link + status) and customer_consents (data privacy + terms).
 * Directory reads are scoped per role and mask email/mobile in list views.
 */
import crypto from "crypto";
import { QueryTypes } from "sequelize";
import { sequelize, Customer, CustomerAccount, CrmUser } from "../models/index.js";
import { nextCustomerNumber } from "./numberService.js";
import { normalizeEmail, normalizeMobile, maskEmail, maskMobile } from "../helpers/mask.js";
import { AppError } from "../helpers/errors.js";

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });

export const PRIVACY_POLICY_VERSION = "2026-11";

export const createCustomerRecord = async ({ customerType = "individual", notes = null, firstName, lastName, email = null, mobile = null, address = null, source = "walk_in", createdBy = null, isDemo = false, createdAt = null }, transaction) => {
  const customer = await Customer.create({
    customer_id: crypto.randomUUID(),
    customer_no: await nextCustomerNumber(transaction),
    first_name: firstName,
    last_name: lastName,
    email: email || null,
    mobile: mobile || null,
    normalized_email: normalizeEmail(email),
    normalized_mobile: normalizeMobile(mobile),
    source,
    customer_type: customerType,
    notes,
    created_by: createdBy,
    is_demo: isDemo,
    ...(createdAt ? { createdAt, updatedAt: createdAt } : {}),
  }, { transaction, silent: Boolean(createdAt) });
  const c = customer.get({ plain: true });
  if (email) await sequelize.query("INSERT INTO customer_contacts (customer_id, contact_type, value, is_primary) VALUES (?, 'email', ?, 1)", { replacements: [c.id, email], transaction });
  if (mobile) await sequelize.query("INSERT INTO customer_contacts (customer_id, contact_type, value, is_primary) VALUES (?, 'mobile', ?, 1)", { replacements: [c.id, mobile], transaction });
  if (address) {
    const a = typeof address === "string" ? { line1: address } : address; // { line1, barangay, city_municipality, province, postal_code }
    await sequelize.query(
      "INSERT INTO customer_addresses (customer_id, label, line1, barangay, city_municipality, province, postal_code, is_default) VALUES (?, 'Home', ?, ?, ?, ?, ?, 1)",
      { replacements: [c.id, a.line1, a.barangay || null, a.city_municipality || null, a.province || null, a.postal_code || null], transaction }
    );
  }
  return c;
};

export const recordConsents = async (customerId, { channel, recordedBy = null, at = new Date(), kinds = ["data_privacy", "terms"] }, transaction) => {
  for (const type of kinds) {
    await sequelize.query(
      `INSERT INTO customer_consents (customer_id, consent_type, granted, policy_version, channel, recorded_by, granted_at, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      { replacements: [customerId, type, PRIVACY_POLICY_VERSION, channel, recordedBy, at, at], transaction }
    );
  }
};

// Portal self-registration. Throws AppError(422) if the login email is already used.
export const registerPortalCustomer = async ({ firstName, lastName, email, mobile, address, passwordHash, isDemo = false, createdAt = null, emailVerified = true }) =>
  sequelize.transaction(async (transaction) => {
    if (await CrmUser.count({ where: { email }, transaction })) throw new AppError("An account with this email already exists. Sign in instead.", 422);
    const now = createdAt || new Date();
    const customer = await createCustomerRecord({ firstName, lastName, email, mobile, address, source: "portal", isDemo, createdAt }, transaction);
    const user = await CrmUser.create({
      user_type: "customer", role: "customer", email, password_hash: passwordHash,
      display_name: `${firstName} ${lastName}`, is_demo: isDemo, email_verified_at: emailVerified ? now : null,
      ...(createdAt ? { createdAt, updatedAt: createdAt } : {}),
    }, { transaction, silent: Boolean(createdAt) });
    await CustomerAccount.create({
      customer_id: customer.id, user_id: user.id, status: emailVerified ? "active" : "pending_verification", registered_via: "portal", terms_accepted_at: now,
    }, { transaction });
    await recordConsents(customer.id, { channel: "portal", at: now }, transaction);
    return { customer, user: user.get({ plain: true }) };
  });

export const customerIdForUser = async (userId) => {
  const [row] = await select("SELECT customer_id FROM customer_accounts WHERE user_id = :userId", { userId });
  return row ? row.customer_id : null;
};

export const getPortalProfile = async (customerId) => {
  const [c] = await select(
    `SELECT c.id, c.customer_no, c.customer_id, c.first_name, c.last_name, c.email, c.mobile, c.status, c.created_at,
            ca.status AS account_status, u.email AS login_email, u.last_login_at, u.email_verified_at,
            (SELECT a.line1 FROM customer_addresses a WHERE a.customer_id = c.id AND a.is_default = 1 ORDER BY a.id LIMIT 1) AS address
     FROM customers c JOIN customer_accounts ca ON ca.customer_id = c.id JOIN crm_users u ON u.id = ca.user_id
     WHERE c.id = :customerId`,
    { customerId }
  );
  const consents = await select(
    "SELECT consent_type, granted, policy_version, channel, granted_at FROM customer_consents WHERE customer_id = :customerId ORDER BY id",
    { customerId }
  );
  return c ? { ...c, consents } : null;
};

export const updatePortalProfile = async ({ customerId, userId, firstName, lastName, mobile, address }) =>
  sequelize.transaction(async (transaction) => {
    const [before] = await select("SELECT first_name, last_name, mobile FROM customers WHERE id = :customerId", { customerId }, transaction);
    await sequelize.query(
      "UPDATE customers SET first_name = :firstName, last_name = :lastName, mobile = :mobile, normalized_mobile = :nm WHERE id = :customerId",
      { replacements: { firstName, lastName, mobile: mobile || null, nm: normalizeMobile(mobile), customerId }, transaction }
    );
    await sequelize.query("UPDATE crm_users SET display_name = :name WHERE id = :userId", { replacements: { name: `${firstName} ${lastName}`, userId }, transaction });
    await sequelize.query("DELETE FROM customer_contacts WHERE customer_id = :customerId AND contact_type = 'mobile' AND is_primary = 1", { replacements: { customerId }, transaction });
    if (mobile) await sequelize.query("INSERT INTO customer_contacts (customer_id, contact_type, value, is_primary) VALUES (?, 'mobile', ?, 1)", { replacements: [customerId, mobile], transaction });
    const [addr] = await select("SELECT id FROM customer_addresses WHERE customer_id = :customerId AND is_default = 1 ORDER BY id LIMIT 1", { customerId }, transaction);
    if (address && addr) await sequelize.query("UPDATE customer_addresses SET line1 = :address WHERE id = :id", { replacements: { address, id: addr.id }, transaction });
    else if (address) await sequelize.query("INSERT INTO customer_addresses (customer_id, label, line1, is_default) VALUES (?, 'Home', ?, 1)", { replacements: [customerId, address], transaction });
    return { before, after: { first_name: firstName, last_name: lastName, mobile: mobile || null } };
  });

/*
 * Customer directory scope (record-level access, blueprint supplement G):
 *   crm_manager: every customer
 *   team_leader: customers with a case in the team, an active assignment to a team member, or still unrouted
 *                (no active assignment and no case with an agent, so any leader can assign them, like the
 *                unrouted case queue)
 *   agent:       customers with a case assigned to the agent, or an active agent assignment to the agent
 * Everything that hangs off a customer (contacts, addresses, preferences, interactions) uses this same scope.
 */
export const directoryScope = (user) => {
  if (user.role === "crm_manager") return { sql: "1=1", params: {} };
  if (user.role === "team_leader") {
    return {
      sql: `(EXISTS (SELECT 1 FROM customer_cases k WHERE k.customer_id = c.id AND k.team_id = :teamId)
             OR EXISTS (SELECT 1 FROM agent_assignments aa JOIN crm_users ag ON ag.id = aa.agent_id
                        WHERE aa.customer_id = c.id AND aa.ended_at IS NULL AND ag.team_id = :teamId)
             OR (NOT EXISTS (SELECT 1 FROM agent_assignments aa WHERE aa.customer_id = c.id AND aa.ended_at IS NULL)
                 AND NOT EXISTS (SELECT 1 FROM customer_cases k WHERE k.customer_id = c.id AND k.assigned_agent_id IS NOT NULL)))`,
      params: { teamId: user.team_id || 0 },
    };
  }
  if (user.role === "agent") {
    return {
      sql: `(EXISTS (SELECT 1 FROM customer_cases k WHERE k.customer_id = c.id AND k.assigned_agent_id = :me)
             OR EXISTS (SELECT 1 FROM agent_assignments aa WHERE aa.customer_id = c.id AND aa.agent_id = :me AND aa.ended_at IS NULL))`,
      params: { me: user.id },
    };
  }
  return { sql: "1=0", params: {} };
};

export const listCustomers = async (user, { q, assignment = "", limit, offset }) => {
  const scope = directoryScope(user);
  const where = [scope.sql, "c.status <> 'merged'"];
  const params = { ...scope.params };
  if (q) {
    where.push("(c.customer_no LIKE :q OR c.first_name LIKE :q OR c.last_name LIKE :q OR CONCAT(c.first_name,' ',c.last_name) LIKE :q OR c.normalized_email LIKE :q OR c.normalized_mobile LIKE :qd)");
    params.q = `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
    params.qd = `%${q.replace(/\D/g, "") || "~"}%`;
  }
  if (assignment === "unassigned") where.push("NOT EXISTS (SELECT 1 FROM agent_assignments aa WHERE aa.customer_id = c.id AND aa.ended_at IS NULL)");
  if (assignment === "mine") { where.push("EXISTS (SELECT 1 FROM agent_assignments aa WHERE aa.customer_id = c.id AND aa.agent_id = :viewer AND aa.ended_at IS NULL)"); params.viewer = user.id; }
  const from = `FROM customers c LEFT JOIN customer_accounts ca ON ca.customer_id = c.id WHERE ${where.join(" AND ")}`;
  const [{ total }] = await select(`SELECT COUNT(*) AS total ${from}`, params);
  const rows = await select(
    `SELECT c.id, c.customer_no, c.first_name, c.last_name, c.email, c.mobile, c.source, c.status, c.is_demo, c.created_at,
            ca.status AS account_status,
            (SELECT ag.display_name FROM agent_assignments aa JOIN crm_users ag ON ag.id = aa.agent_id
              WHERE aa.customer_id = c.id AND aa.ended_at IS NULL ORDER BY aa.id DESC LIMIT 1) AS assigned_agent,
            (SELECT COUNT(*) FROM customer_cases k WHERE k.customer_id = c.id) AS case_count,
            (SELECT COUNT(*) FROM customer_cases k WHERE k.customer_id = c.id
               AND k.status IN ('open','assigned','in_progress','waiting_for_customer','escalated')) AS active_count
     ${from} ORDER BY c.last_name, c.first_name LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset }
  );
  return {
    total: Number(total),
    rows: rows.map((r) => ({ ...r, email_masked: maskEmail(r.email), mobile_masked: maskMobile(r.mobile), email: undefined, mobile: undefined })),
  };
};

// Detail view (full contact data for permitted roles, still scoped).
export const findCustomerForUser = async (customerId, user) => {
  const scope = directoryScope(user);
  const [row] = await select(
    `SELECT c.*, ca.status AS account_status, s.name AS segment_name
     FROM customers c LEFT JOIN customer_accounts ca ON ca.customer_id = c.id LEFT JOIN customer_segments s ON s.id = c.segment_id
     WHERE c.id = :customerId AND ${scope.sql}`,
    { customerId, ...scope.params }
  );
  if (!row) return null;
  const [addresses, contacts, consents, assignment, assignmentHistory] = await Promise.all([
    select("SELECT id, label, line1, barangay, city_municipality, province, postal_code, is_default FROM customer_addresses WHERE customer_id = :customerId ORDER BY is_default DESC, id", { customerId }),
    select("SELECT id, contact_type, value, is_primary, verified_at FROM customer_contacts WHERE customer_id = :customerId ORDER BY is_primary DESC, contact_type, id", { customerId }),
    select("SELECT consent_type, granted, policy_version, channel, granted_at, withdrawn_at FROM customer_consents WHERE customer_id = :customerId ORDER BY id", { customerId }),
    select(`SELECT aa.id, aa.agent_id, ag.display_name AS agent_name, ag.team_id, aa.assigned_at, aa.note, ab.display_name AS assigned_by_name
            FROM agent_assignments aa JOIN crm_users ag ON ag.id = aa.agent_id LEFT JOIN crm_users ab ON ab.id = aa.assigned_by
            WHERE aa.customer_id = :customerId AND aa.ended_at IS NULL ORDER BY aa.id DESC LIMIT 1`, { customerId }),
    select(`SELECT ag.display_name AS agent_name, aa.assigned_at, aa.ended_at, aa.note, ab.display_name AS assigned_by_name
            FROM agent_assignments aa JOIN crm_users ag ON ag.id = aa.agent_id LEFT JOIN crm_users ab ON ab.id = aa.assigned_by
            WHERE aa.customer_id = :customerId ORDER BY aa.id DESC LIMIT 10`, { customerId }),
  ]);
  return { ...row, addresses, contacts, consents, assignment: assignment[0] || null, assignmentHistory };
};
