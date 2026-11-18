/*
 * Staff accounts from HR (team-agreed employee account flow, contract v0.5 §12.5).
 *
 *   1. HR encodes the new hire (Employee ID JV-YYYY-NNNNN, Employee Unique Code).
 *   2. CRM reads HR (pull or events). For every employee of the CRM department (crm_settings staff.department_code, fallback
 *      CRM_DEPARTMENT_CODE) who is active or on leave, has an email and has no CRM account, CRM creates a DEACTIVATED staff account:
 *      login_via 'ess', NO password (migration 121), "Waiting for ESS registration". The role comes from the position rules
 *      (Manager › Settings › Teams & CRM Access); the Manager can override it per person and assigns the team.
 *   3. The person registers in ESS (JVzPay) and sets a password there.
 *   4. Their first successful CRM sign-in with the ESS password activates the account (services/essLoginService.js).
 *   5. Resigned / Terminated in HR removes CRM access (services/integration/hrAdapter.js applyEmployeeStatus).
 * Customers and the setup System Administrator keep their own CRM password. Nothing here edits HR data.
 */
import { QueryTypes } from "sequelize";
import { sequelize, ACCESS_BLOCKING_STATUSES } from "../models/index.js";
import { config } from "../config/index.js";
import { AppError } from "../helpers/errors.js";
import { audit } from "./auditService.js";
import { modeOf } from "./integration/adapterBase.js";
import { ACTIVE_SQL } from "./caseService.js";

export const STAFF_ROLE_CHOICES = ["agent", "team_leader", "crm_manager"];
// Exact HR titles first (team decision 2026-11-16); "contains Manager" only as a fallback; anything else is Agent and flagged for review.
export const DEFAULT_ROLE_RULES = [
  { match: "exact", text: "CRM Manager", role: "crm_manager" },
  { match: "exact", text: "Team Leader", role: "team_leader" },
  { match: "exact", text: "Customer Service Agent", role: "agent" },
  { match: "contains", text: "Manager", role: "crm_manager" },
];
export const RULE_MATCHES = ["exact", "contains"];
// a rule saved before 2026-11-16 was { contains, role }
const normalizeRule = (r) => (r && typeof r === "object"
  ? { match: RULE_MATCHES.includes(r.match) ? r.match : "contains", text: String(r.text ?? r.contains ?? "").trim().slice(0, 60), role: r.role }
  : null);
export const FALLBACK_ROLE = "agent";
const KEY_DEPT = "staff.department_code";
const KEY_RULES = "staff.position_role_rules";

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
const getSetting = async (key) => (await select("SELECT setting_value FROM crm_settings WHERE setting_key = :key", { key }))[0]?.setting_value ?? null;
const putSetting = (key, value, description) => sequelize.query(
  "INSERT INTO crm_settings (setting_key, setting_value, description) VALUES (:key, :value, :description) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
  { replacements: { key, value, description } });

// ---------------------------------------------------------------- settings (CRM Manager)

export const getStaffSettings = async () => {
  const dept = String((await getSetting(KEY_DEPT)) || config.staff.departmentCode || "CRM").trim();
  let rules = DEFAULT_ROLE_RULES;
  try {
    const raw = await getSetting(KEY_RULES);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) rules = parsed.map(normalizeRule).filter((r) => r && r.text && STAFF_ROLE_CHOICES.includes(r.role));
  } catch { /* a damaged value falls back to the defaults */ }
  return { departmentCode: dept, rules };
};

export const saveStaffSettings = async ({ req, departmentCode, rules }) => {
  const dept = String(departmentCode || "").trim();
  if (!/^[A-Za-z0-9._-]{1,30}$/.test(dept)) throw new AppError("Enter the CRM department code exactly as HR shows it (letters, digits, dot, dash; up to 30).", 422);
  const clean = (rules || []).map(normalizeRule).filter((r) => r && r.text);
  if (clean.some((r) => !STAFF_ROLE_CHOICES.includes(r.role))) throw new AppError("Choose a CRM role for every position rule.", 422);
  const before = await getStaffSettings();
  await putSetting(KEY_DEPT, dept, "HR department whose employees get a CRM staff account (employee account flow)");
  await putSetting(KEY_RULES, JSON.stringify(clean), "Position text -> CRM role for new staff accounts; first match wins, otherwise Agent");
  await audit(req, "staff_account_rules_changed", { recordType: "crm_settings", recordId: KEY_RULES, before, after: { departmentCode: dept, rules: clean } });
  return { departmentCode: dept, rules: clean };
};

/*
 * Which rule gives this HR position its CRM role (case-insensitive, spaces trimmed): every EXACT title rule first, then the
 * "contains" rules in their order. No match -> Agent, and review = true so the Manager is shown the person to check.
 */
export const matchPosition = (title, rules) => {
  const t = String(title || "").trim().replace(/\s+/g, " ").toLowerCase();
  const exact = rules.find((r) => r.match === "exact" && t && t === r.text.trim().replace(/\s+/g, " ").toLowerCase());
  const hit = exact || rules.find((r) => r.match !== "exact" && r.text && t.includes(r.text.toLowerCase()));
  return hit ? { role: hit.role, rule: hit, review: false } : { role: FALLBACK_ROLE, rule: null, review: true };
};
export const roleForPosition = (title, rules) => matchPosition(title, rules).role;

// ---------------------------------------------------------------- account state (Teams & CRM Access)

export const STATE_LABELS = {
  waiting: "Waiting for ESS registration", active: "Active", removed: "Removed by HR", off: "Switched off in CRM", none: "No CRM account",
};
export const accountState = (r) => {
  if (!r.user_id) return "none";
  if (r.access_revoked_at || ACCESS_BLOCKING_STATUSES.includes(r.employment_status)) return "removed";
  if (r.login_via === "ess" && !r.ess_activated_at) return "waiting";
  return r.is_active ? "active" : "off";
};

// ---------------------------------------------------------------- creating accounts from HR

const hrRowsIsMock = () => (modeOf("hr") === "live" ? 0 : 1); // mock HR fills mock rows; live HR real rows

/*
 * Creates the missing deactivated staff accounts and refreshes the rule-based role of accounts nobody has overridden.
 * employeeId limits the run to one person (an HR event). Returns { created: [...], roleChanged: [...], skipped: [...] }.
 */
export const provisionStaffAccounts = async ({ source = "job", employeeId = null, req = null } = {}) => {
  if (modeOf("hr") === "disabled") return { created: [], roleChanged: [], skipped: [], off: true };
  const { departmentCode, rules } = await getStaffSettings();
  const rows = await select(
    `SELECT e.employee_id, e.full_name, e.work_email, e.employment_status, p.title AS position_title, d.code AS department_code,
            u.id AS user_id, u.role, u.role_source, u.team_id
     FROM employee_references e
     JOIN department_references d ON d.department_id = e.department_id
     LEFT JOIN position_references p ON p.position_id = e.position_id
     LEFT JOIN crm_users u ON u.employee_id = e.employee_id
     WHERE UPPER(d.code) = UPPER(:dept) AND e.is_mock = :mock ${employeeId ? "AND e.employee_id = :employeeId" : ""}`,
    { dept: departmentCode, mock: hrRowsIsMock(), employeeId });
  const out = { created: [], roleChanged: [], skipped: [] };
  for (const r of rows) {
    if (r.user_id) {
      // role from the position rules, unless the Manager set it by hand; never while the person holds active cases
      if (r.role_source !== "position_rule") continue;
      const role = roleForPosition(r.position_title, rules);
      if (role === r.role) continue;
      const [{ n }] = await select(`SELECT COUNT(*) n FROM customer_cases k WHERE k.assigned_agent_id = :id AND ${ACTIVE_SQL()}`, { id: r.user_id });
      if (Number(n) > 0) { out.skipped.push(`${r.employee_id}: role would become ${role}, but the person has active cases`); continue; }
      await sequelize.transaction(async (transaction) => {
        await sequelize.query("UPDATE crm_teams SET team_leader_id = NULL WHERE team_leader_id = :id", { replacements: { id: r.user_id }, transaction });
        await sequelize.query("UPDATE crm_users SET role = :role WHERE id = :id", { replacements: { role, id: r.user_id }, transaction });
      });
      await audit(req, "staff_role_from_position", { actor: req?.user || null, recordType: "crm_user", recordId: r.user_id, before: { role: r.role }, after: { role, position: r.position_title }, details: `position rule (source: ${source})` });
      out.roleChanged.push({ employee_id: r.employee_id, role });
      continue;
    }
    if (ACCESS_BLOCKING_STATUSES.includes(r.employment_status)) continue; // only active / on-leave people get an account
    const email = String(r.work_email || "").trim().toLowerCase();
    if (!email) { out.skipped.push(`${r.employee_id}: HR has no email`); continue; }
    const [taken] = await select("SELECT id FROM crm_users WHERE email = :email", { email });
    if (taken) { out.skipped.push(`${r.employee_id}: ${email} is already used by another CRM login`); continue; }
    const { role, rule, review } = matchPosition(r.position_title, rules);
    try {
      const [id] = await sequelize.query(
        `INSERT INTO crm_users (user_type, role, role_source, employee_id, email, password_hash, login_via, ess_activated_at, display_name, team_id, is_active, is_available, created_at, updated_at)
         VALUES ('staff', :role, 'position_rule', :employeeId, :email, NULL, 'ess', NULL, :name, NULL, 0, 1, NOW(), NOW())`,
        { replacements: { role, employeeId: r.employee_id, email, name: r.full_name } });
      await audit(req, "staff_account_created_from_hr", {
        actor: req?.user || null, recordType: "crm_user", recordId: id,
        after: { employee_id: r.employee_id, role, position: r.position_title, state: STATE_LABELS.waiting, role_rule: rule ? `${rule.match}: ${rule.text}` : "none (Agent by default, needs review)" },
        details: `source: ${source}; no CRM password (signs in with the ESS password)${review ? "; the position matched no rule: role Agent, flagged for the Manager's review" : ""}`,
      });
      out.created.push({ employee_id: r.employee_id, role, user_id: id, review });
    } catch (err) {
      if (err?.original?.code === "ER_DUP_ENTRY" || err?.parent?.code === "ER_DUP_ENTRY") { out.skipped.push(`${r.employee_id}: created at the same moment by another run`); continue; }
      throw err;
    }
  }
  return out;
};
