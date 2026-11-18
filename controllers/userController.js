// "My account" pages. Staff names, positions and status come from HR (read-only here); staff can
// change only their password. Customers edit their own profile on the portal.
import { myRequestCounts } from "../services/approvalService.js";
import bcrypt from "bcrypt";
import { QueryTypes } from "sequelize";
import { sequelize, CrmUser } from "../models/index.js";
import { updatePortalProfile } from "../services/customerService.js";
import { audit } from "../services/auditService.js";
import { sessionStamp } from "../services/accountService.js";
import { clean, isPhone } from "../helpers/validators.js";

const passwordProblem = (password, confirm) => {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 72) return "Password must be 72 characters or fewer.";
  if (confirm !== undefined && password !== confirm) return "Passwords do not match.";
  return null;
};

export const profile = async (req, res) => {
  const [me] = await sequelize.query(
    `SELECT u.display_name, u.email, u.role, u.last_login_at, u.created_at, u.employee_id, t.name AS team_name,
            e.full_name, e.employment_status, e.is_mock, e.last_synced_at, p.title AS position_title, d.name AS department_name
     FROM crm_users u LEFT JOIN crm_teams t ON t.id = u.team_id
     LEFT JOIN employee_references e ON e.employee_id = u.employee_id
     LEFT JOIN position_references p ON p.position_id = e.position_id
     LEFT JOIN department_references d ON d.department_id = e.department_id
     WHERE u.id = :id`,
    { type: QueryTypes.SELECT, replacements: { id: req.user.id } }
  );
  const showMyRequests = ["agent", "team_leader", "crm_manager"].includes(req.user.role);
  res.render("users/profile", { title: "My Account", me, showMyRequests, myReq: showMyRequests ? await myRequestCounts(req.user) : null });
};

export const updatePortal = async (req, res) => {
  const firstName = clean(req.body.first_name, 80);
  const lastName = clean(req.body.last_name, 80);
  const mobile = clean(req.body.mobile, 20);
  const address = clean(req.body.address, 200);
  if (!firstName || lastName.length < 2) req.flash("error_msg", "Enter your first and last name.");
  else if (mobile && !isPhone(mobile)) req.flash("error_msg", "Enter a valid mobile number.");
  else {
    const { before, after } = await updatePortalProfile({ customerId: req.user.customer_id, userId: req.user.id, firstName, lastName, mobile, address });
    await audit(req, "customer_profile_updated", { recordType: "customer", recordId: req.user.customer_id, before, after });
    req.flash("success_msg", "Profile updated.");
  }
  res.redirect("/portal");
};

export const changePassword = async (req, res) => {
  const back = req.user.role === "customer" ? "/portal" : "/profile";
  const current = String(req.body.current_password || "");
  const password = String(req.body.password || "");
  const user = await CrmUser.findByPk(req.user.id);
  if (!(await bcrypt.compare(current, user.password_hash))) req.flash("error_msg", "Your current password is incorrect.");
  else {
    const problem = passwordProblem(password, String(req.body.confirm_password || ""));
    if (problem) req.flash("error_msg", problem);
    else {
      await user.update({ password_hash: await bcrypt.hash(password, 10) });
      req.session.pwv = sessionStamp(user.password_hash); // this session stays signed in; all others end
      await audit(req, "password_changed", { recordType: "crm_user", recordId: user.id });
      req.flash("success_msg", "Password changed.");
    }
  }
  res.redirect(back);
};
