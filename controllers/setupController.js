// Setup System Administrator: local staff accounts while HR is in mock mode (decision 2026-11-11).
// Staff must be linked to an HR employee reference (here: the MOCK fixture). In live HR mode this page
// is read-only: CRM access is granted from HR employee records by the CRM Manager (P2).
import bcrypt from "bcrypt";
import { QueryTypes } from "sequelize";
import { sequelize, CrmUser, STAFF_ROLES } from "../models/index.js";
import { hrMode, applyEmployeeStatus, applyDepartmentUpdate, applyPositionUpdate } from "../services/integration/hrAdapter.js";
import { revalidatePending } from "../services/approvalService.js";
import { listMail, isDevMailbox } from "../services/mailService.js";
import { config } from "../config/index.js";
import { audit } from "../services/auditService.js";
import { clean, toId, oneOf } from "../helpers/validators.js";
import { ROLE_LABELS } from "../helpers/labels.js";

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });

const staffRows = () =>
  select(
    `SELECT e.employee_id, e.full_name, e.work_email, e.employment_status, e.is_mock, e.last_synced_at, p.title AS position_title,
            u.id AS user_id, u.role, u.email, u.is_active, u.access_revoked_at, u.access_revoked_reason, u.last_login_at, t.name AS team_name
     FROM employee_references e
     LEFT JOIN position_references p ON p.position_id = e.position_id
     LEFT JOIN crm_users u ON u.employee_id = e.employee_id
     LEFT JOIN crm_teams t ON t.id = u.team_id
     ORDER BY e.employee_id`
  );

export const staff = async (req, res) => {
  const mode = hrMode();
  const { essLoginMode, listMockEss } = await import("../services/essLoginService.js");
  const mockEss = essLoginMode() === "mock" ? await listMockEss() : [];
  const [rows, teams, departments, positions] = await Promise.all([
    staffRows(), select("SELECT id, team_code, name FROM crm_teams WHERE is_active = 1 ORDER BY team_code"),
    select("SELECT department_id AS id, name AS label, last_synced_at FROM department_references ORDER BY department_id"),
    select("SELECT position_id AS id, title AS label, last_synced_at FROM position_references ORDER BY position_id"),
  ]);
  res.render("setup/staff", {
    title: "Staff Accounts (mock HR)",
    rows: rows.map((r) => ({ ...r, roleLabel: r.role ? ROLE_LABELS[r.role] : null })),
    teams, departments, positions,
    roleOptions: STAFF_ROLES.map((value) => ({ value, label: ROLE_LABELS[value] })),
    hrMode: mode,
    canEdit: mode === "mock",
    statusOptions: ["active", "on_leave", "inactive", "separated"],
    essMock: essLoginMode() === "mock", mockEss,
  });
};

// MOCK ESS registry (INTEGRATION_ESS_LOGIN=mock only): stands in for a new hire registering in JVzPay ESS, so the employee account flow
// can be shown without the Accounting app. The password is hashed and never shown again.
export const mockEssRegistration = async (req, res) => {
  const { mockEssRegister } = await import("../services/essLoginService.js");
  try {
    const emp = await mockEssRegister({ req, email: clean(req.body.email, 254), password: String(req.body.password || "") });
    req.flash("success_msg", `MOCK ESS registration saved for ${emp.full_name}. They can now sign in to the CRM with that email and password.`);
  } catch (err) {
    if (!err.expose && !err.status) throw err;
    req.flash("error_msg", err.message);
  }
  res.redirect("/setup/staff");
};

const guardMock = (req, res) => {
  if (hrMode() === "mock") return true;
  req.flash("error_msg", "Local staff accounts can only be changed while INTEGRATION_HR_MODE=mock. In live mode, access comes from HR records.");
  res.redirect("/setup/staff");
  return false;
};

// Creates the CRM login for a mock HR employee (no login yet).
export const createStaffLogin = async (req, res) => {
  if (!guardMock(req, res)) return;
  const employeeId = clean(req.body.employee_id, 64);
  const role = oneOf(req.body.role, STAFF_ROLES);
  const teamId = toId(req.body.team_id);
  const password = String(req.body.password || "");
  const [emp] = await select("SELECT employee_id, full_name, work_email, employment_status, is_mock FROM employee_references WHERE employee_id = :employeeId", { employeeId });
  const errors = [];
  if (!emp) errors.push("Choose an employee from the HR references.");
  else if (!emp.is_mock) errors.push("Only mock HR employees can get local logins.");
  else if (["inactive", "separated"].includes(emp.employment_status)) errors.push("This employee is not active in HR.");
  if (!role) errors.push("Choose a CRM role.");
  if (role && role !== "crm_manager" && !teamId) errors.push("Team Leaders and Agents need a team.");
  if (password.length < 8 || password.length > 72) errors.push("Temporary password must be 8–72 characters.");
  if (emp && (await CrmUser.count({ where: { employee_id: employeeId } }))) errors.push("This employee already has a CRM login.");
  if (emp && emp.work_email && (await CrmUser.count({ where: { email: emp.work_email.toLowerCase() } }))) errors.push("Another login already uses this work email.");
  if (errors.length) {
    errors.forEach((e) => req.flash("error_msg", e));
    return res.redirect("/setup/staff");
  }
  const user = await CrmUser.create({
    user_type: "staff", role, employee_id: emp.employee_id, email: emp.work_email.toLowerCase(),
    password_hash: await bcrypt.hash(password, 10), display_name: emp.full_name, team_id: role === "crm_manager" ? null : teamId,
  });
  if (role === "team_leader") await sequelize.query("UPDATE crm_teams SET team_leader_id = :id WHERE id = :teamId AND team_leader_id IS NULL", { replacements: { id: user.id, teamId } });
  await audit(req, "staff_login_created", { recordType: "crm_user", recordId: user.id, after: { employee_id: emp.employee_id, role, team_id: teamId } });
  req.flash("success_msg", `CRM login created for ${emp.full_name} (${ROLE_LABELS[role]}). Share the temporary password securely.`);
  res.redirect("/setup/staff");
};

// Emergency access recovery: reset a staff password or switch CRM access on/off.
export const resetStaffPassword = async (req, res) => {
  const id = toId(req.params.id);
  const user = id ? await CrmUser.findOne({ where: { id, user_type: "staff" } }) : null;
  const password = String(req.body.password || "");
  if (!user) req.flash("error_msg", "Staff login not found.");
  else if (password.length < 8 || password.length > 72) req.flash("error_msg", "Password must be 8–72 characters.");
  else {
    await user.update({ password_hash: await bcrypt.hash(password, 10) });
    await audit(req, "staff_password_reset", { recordType: "crm_user", recordId: user.id, reason: "Setup emergency access" });
    req.flash("success_msg", `Password reset for ${user.display_name}.`);
  }
  res.redirect("/setup/staff");
};

export const toggleStaffAccess = async (req, res) => {
  const id = toId(req.params.id);
  const user = id ? await CrmUser.findOne({ where: { id, user_type: "staff" } }) : null;
  if (!user) req.flash("error_msg", "Staff login not found.");
  else {
    await user.update({ is_active: !user.is_active });
    await audit(req, user.is_active ? "staff_access_enabled" : "staff_access_disabled", {
      recordType: "crm_user", recordId: user.id, before: { is_active: !user.is_active }, after: { is_active: user.is_active },
    });
    req.flash("success_msg", `${user.display_name}: CRM access ${user.is_active ? "enabled" : "disabled"}.`);
  }
  res.redirect("/setup/staff");
};

// Mock HR only: simulate the EmployeeStatusChanged event so the automatic access removal can be tested.
export const simulateHrStatus = async (req, res) => {
  if (!guardMock(req, res)) return;
  const employeeId = clean(req.body.employee_id, 64);
  const status = oneOf(req.body.status, ["active", "on_leave", "inactive", "separated"]);
  if (!status) {
    req.flash("error_msg", "Choose an employment status.");
    return res.redirect("/setup/staff");
  }
  try {
    const result = await applyEmployeeStatus({ employeeId, status, source: "setup-simulation", req });
    if (result.changed) await revalidatePending(); // a pending approval request whose approver just left goes to the exception queue
    req.flash("success_msg", result.changed
      ? `MOCK HR: ${employeeId} is now ${status}.${result.revoked ? " CRM access was removed automatically." : ""}${result.restored ? " The HR block on CRM access was lifted." : ""}`
      : `${employeeId} already has status ${status}.`);
  } catch (err) {
    req.flash("error_msg", err.message);
  }
  res.redirect("/setup/staff");
};

// Mock HR only: simulate the DepartmentUpdated / PositionUpdated events (TC-06). CRM has no screen that
// edits these references; this is the same write path the live HR event handler will use in P6.
export const simulateHrReference = async (req, res) => {
  if (!guardMock(req, res)) return;
  const [rawKind, ...rest] = clean(req.body.reference_id, 80).split(":");
  const kind = oneOf(rawKind, ["department", "position"]);
  const id = rest.join(":");
  const label = clean(req.body.label, 120);
  if (!kind || !id || label.length < 2) {
    req.flash("error_msg", "Choose a department or position and enter the new name.");
    return res.redirect("/setup/staff");
  }
  try {
    const result = kind === "department"
      ? await applyDepartmentUpdate({ departmentId: id, name: label, source: "setup-simulation", req })
      : await applyPositionUpdate({ positionId: id, title: label, source: "setup-simulation", req });
    req.flash("success_msg", `MOCK HR: ${kind === "department" ? "DepartmentUpdated" : "PositionUpdated"} applied to ${id}${result.changed ? "" : " (no field changed; last_synced_at refreshed)"}.`);
  } catch (err) {
    req.flash("error_msg", err.message);
  }
  res.redirect("/setup/staff");
};

// Development mailbox: every email the CRM would send while MAIL_TRANSPORT=log.
export const mailLog = async (req, res) => {
  const rows = await listMail(50);
  res.render("setup/mail_log", { title: "Mail Log", rows, transport: config.mail.transport, devMode: isDevMailbox() });
};
