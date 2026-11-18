/*
 * Staff sign-in through ESS (employee account flow, contract v0.5 §12.5). CRM never stores a staff member's ESS password.
 *
 *   INTEGRATION_ESS_LOGIN=live   POST {ACCOUNTING_API_BASE_URL}/api/integration/v1/auth/login {email, password}, signed like every call
 *                                to JVzPay (HMAC, JVZ_SECRET_ACCOUNTING). 200 {employee_id, employee_code, full_name, email, department_code,
 *                                department_name, position, employment_status, ess_registered_at}; 401 invalid_credentials; 403 not_allowed.
 *                                No answer / 5xx = "ESS is unavailable" (no local fallback for staff).
 *   INTEGRATION_ESS_LOGIN=mock   a local MOCK ESS registry (crm_settings mock_ess.<email>, password hashed with bcrypt) that the setup
 *                                administrator fills under Setup › Staff (mock only). The demo accounts keep their CRM password.
 * Neither the password nor the answer body is ever logged (integration_logs keep the endpoint and the HTTP status only).
 *
 * checkEssAnswer() decides whether a successful ESS answer may open THIS CRM account:
 *   the email matches, the person is in the CRM department (in ESS's answer AND in CRM's HR snapshot), the HR snapshot says active or
 *   on leave, and HR has not removed the access. The first success activates a "Waiting for ESS registration" account.
 */
import bcrypt from "bcrypt";
import { QueryTypes } from "sequelize";
import { sequelize, ACCESS_BLOCKING_STATUSES } from "../models/index.js";
import { config } from "../config/index.js";
import { AppError } from "../helpers/errors.js";
import { API, signedRequest, modeOf } from "./integration/adapterBase.js";
import { getStaffSettings } from "./staffAccountService.js";
import { audit } from "./auditService.js";

export const essLoginMode = () => config.integration.ess.login;
export const ESS_UNAVAILABLE = "ESS is unavailable, try again later.";
export const ESS_GENERIC_ERROR = "We could not sign you in. Use your work email and your ESS password. If you have not registered in ESS yet, register there first.";
const MOCK_KEY = (email) => `mock_ess.${String(email).trim().toLowerCase()}`;
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10); // same time for unknown emails
const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });

/*
 * Asks ESS. Returns { ok: true, profile } | { ok: false, reason: 'invalid_credentials' | 'not_allowed' | 'unavailable' | 'bad_answer' | 'not_registered' }.
 */
export const askEss = async ({ email, password }) => {
  if (essLoginMode() === "live") {
    let res;
    try {
      res = await signedRequest("accounting", { method: "POST", path: `${API}/auth/login`, body: { email, password }, timeoutMs: 8000, direction: "api_call", logMessage: "ESS staff sign-in" });
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (res.status >= 500) return { ok: false, reason: "unavailable" };
    if (res.status === 401) return { ok: false, reason: res.json?.error === "invalid_credentials" || !res.json?.error ? "invalid_credentials" : `refused_${String(res.json.error).slice(0, 30)}` };
    if (res.status === 403) return { ok: false, reason: "not_allowed" };
    if (res.status !== 200 || !res.json || typeof res.json !== "object") return { ok: false, reason: `bad_answer_${res.status}` };
    return { ok: true, profile: res.json.data && typeof res.json.data === "object" ? res.json.data : res.json };
  }
  // mock: the local registry
  const [row] = await select("SELECT setting_value FROM crm_settings WHERE setting_key = :key", { key: MOCK_KEY(email) });
  if (!row) { await bcrypt.compare(password, DUMMY_HASH); return { ok: false, reason: "not_registered" }; }
  let reg;
  try { reg = JSON.parse(row.setting_value); } catch { return { ok: false, reason: "bad_answer" }; }
  if (!(await bcrypt.compare(password, reg.password_hash))) return { ok: false, reason: "invalid_credentials" };
  const [emp] = await select(
    `SELECT e.employee_id, e.full_name, e.work_email, e.employment_status, d.code AS department_code, d.name AS department_name
     FROM employee_references e LEFT JOIN department_references d ON d.department_id = e.department_id WHERE e.employee_id = :id`, { id: reg.employee_id });
  if (!emp) return { ok: false, reason: "not_allowed" };
  return { ok: true, profile: { employee_id: emp.employee_id, employee_code: null, full_name: emp.full_name, email: emp.work_email, department_code: emp.department_code, department_name: emp.department_name, employment_status: emp.employment_status, ess_registered_at: reg.registered_at, mock: true } };
};

// Does a successful ESS answer open this CRM account? Returns null (yes) or the reason (kept in the audit log only).
export const checkEssAnswer = async (user, profile) => {
  const { departmentCode } = await getStaffSettings();
  const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  if (!same(profile.email, user.email)) return "email_mismatch";
  if (!same(profile.department_code, departmentCode)) return "ess_not_crm_department";
  const [snap] = await select(
    `SELECT e.employment_status, d.code AS department_code FROM employee_references e LEFT JOIN department_references d ON d.department_id = e.department_id WHERE e.employee_id = :id`,
    { id: user.employee_id });
  if (!snap) return "no_hr_snapshot";
  if (!same(snap.department_code, departmentCode)) return "hr_not_crm_department";
  if (ACCESS_BLOCKING_STATUSES.includes(snap.employment_status) || user.access_revoked_at) return "removed_by_hr";
  if (user.ess_activated_at && !user.is_active) return "switched_off_in_crm";
  if (user.login_via !== "ess" && !user.is_active) return "switched_off_in_crm";
  return null;
};

// First successful ESS sign-in: "Waiting for ESS registration" -> Active.
export const activateViaEss = async (req, user, profile) => {
  if (user.login_via !== "ess" || user.ess_activated_at) return false;
  const [, meta] = await sequelize.query("UPDATE crm_users SET is_active = 1, ess_activated_at = NOW() WHERE id = :id AND ess_activated_at IS NULL", { replacements: { id: user.id } });
  if (!Number(meta?.affectedRows ?? meta)) return false;
  await audit(req, "staff_activated_via_ess", {
    actor: { id: user.id, role: user.role, email: user.email }, recordType: "crm_user", recordId: user.id,
    before: { state: "Waiting for ESS registration", is_active: false }, after: { state: "Active", is_active: true },
    details: `activated via ESS (${essLoginMode()}${profile?.ess_registered_at ? `, registered in ESS ${String(profile.ess_registered_at).slice(0, 25)}` : ""})`,
  });
  return true;
};

// ---------------------------------------------------------------- mock ESS registry (setup administrator, mock only)

export const mockEssRegister = async ({ req, email, password }) => {
  if (essLoginMode() !== "mock") throw new AppError("The mock ESS registry is used only while INTEGRATION_ESS_LOGIN=mock. Live staff register in JVzPay ESS.", 409);
  const mail = String(email || "").trim().toLowerCase();
  if (String(password || "").length < 8 || String(password).length > 72) throw new AppError("The ESS password must be 8–72 characters.", 422);
  const [emp] = await select("SELECT employee_id, full_name FROM employee_references WHERE LOWER(work_email) = :mail AND is_mock = :mock", { mail, mock: modeOf("hr") === "live" ? 0 : 1 });
  if (!emp) throw new AppError("No HR employee has this email, so ESS would refuse the registration (ESS validates against HR).", 422);
  const value = JSON.stringify({ employee_id: emp.employee_id, password_hash: await bcrypt.hash(password, 10), registered_at: new Date().toISOString() });
  await sequelize.query(
    "INSERT INTO crm_settings (setting_key, setting_value, description) VALUES (:key, :value, 'MOCK ESS registration (mock only, never a real ESS account)') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
    { replacements: { key: MOCK_KEY(mail), value } });
  await audit(req, "mock_ess_registered", { recordType: "employee_reference", recordId: emp.employee_id, details: `MOCK ESS registration for ${mail} (password not recorded)` });
  return emp;
};

export const listMockEss = async () => (await select("SELECT setting_key, setting_value FROM crm_settings WHERE setting_key LIKE 'mock_ess.%' ORDER BY setting_key"))
  .map((r) => { try { const v = JSON.parse(r.setting_value); return { email: r.setting_key.slice("mock_ess.".length), employee_id: v.employee_id, registered_at: v.registered_at }; } catch { return null; } })
  .filter(Boolean);
