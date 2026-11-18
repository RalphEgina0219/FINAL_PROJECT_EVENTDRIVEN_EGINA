// JOHNVIVZ CRM: sign in, customer self-registration (portal), sign out and the role dashboard redirect.
// The schema is managed by migrations (npm run migrate); this file never calls sequelize.sync().
import bcrypt from "bcrypt";
import { QueryTypes } from "sequelize";
import { sequelize, CrmUser } from "../models/index.js";
import { clean, isEmail, isPhone } from "../helpers/validators.js";
import { DASHBOARD_PATHS } from "../helpers/navigation.js";
import { ROLE_LABELS } from "../helpers/labels.js";
import { config } from "../config/index.js";
import { DEMO_PASSWORD } from "../seeders/demoAccounts.js";
import { sessionStamp, sendVerification } from "../services/accountService.js";
import { isDevMailbox } from "../services/mailService.js";
import { audit } from "../services/auditService.js";
import { registerPortalCustomer } from "../services/customerService.js";
import { loadAccount, accessProblem } from "../middleware/auth.js";
import { AppError } from "../helpers/errors.js";
import { essLoginMode, askEss, checkEssAnswer, activateViaEss, ESS_UNAVAILABLE, ESS_GENERIC_ERROR } from "../services/essLoginService.js";

const BCRYPT_ROUNDS = 10;
// Used when the email is unknown so the response time does not reveal whether an account exists.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_ROUNDS);
const ROLE_ORDER = ["system_admin", "crm_manager", "team_leader", "agent", "customer"];

const demoAccounts = async () => {
  if (!config.showDemoLogins) return [];
  const rows = await sequelize.query(
    `SELECT u.display_name AS name, u.email, u.role, t.name AS team_name, e.employment_status, e.is_mock
     FROM crm_users u LEFT JOIN crm_teams t ON t.id = u.team_id LEFT JOIN employee_references e ON e.employee_id = u.employee_id
     WHERE u.is_demo = 1 AND u.is_active = 1 ORDER BY u.id`,
    { type: QueryTypes.SELECT }
  );
  return rows
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
    .slice(0, 12)
    .map((r) => ({ ...r, roleLabel: ROLE_LABELS[r.role], blocked: ["inactive", "separated"].includes(r.employment_status) }));
};

const renderLogin = async (res, extra = {}) =>
  res.render("login", { title: "Sign in", demoAccounts: await demoAccounts(), demoPassword: DEMO_PASSWORD, ...extra });

export const loginPage = async (req, res) => renderLogin(res, { loggedOut: req.query.logged_out === "1" });

export const registerPage = (req, res) => res.render("register", { title: "Create a customer account", form: {} });


// /dashboard keeps working: it sends each role to its own dashboard.
export const dashboardPage = (req, res) => {
  if (!req.user) return res.redirect("/login");
  res.redirect(DASHBOARD_PATHS[req.user.role] || "/");
};

const startSession = (req, user) =>
  new Promise((resolve, reject) => {
    // New session id on login prevents session fixation.
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.role = user.role;
      req.session.pwv = user.password_hash ? sessionStamp(user.password_hash) : null; // ESS staff have no CRM password
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });

export const loginUser = async (req, res) => {
  const email = clean(req.body.email, 254).toLowerCase();
  const password = String(req.body.password || "");
  if (!email || !password) {
    res.status(422);
    return renderLogin(res, { error: "Enter your email and password.", email });
  }

  const user = await CrmUser.findOne({ where: { email }, attributes: ["id", "role", "user_type", "email", "employee_id", "password_hash", "login_via", "ess_activated_at", "is_active", "access_revoked_at", "display_name"], raw: true });
  // Staff sign in with their ESS password: always when ESS login is live, and in mock mode for accounts created from HR (login_via 'ess').
  // Customers and the setup administrator keep their CRM password.
  if (user && user.user_type === "staff" && (essLoginMode() === "live" || user.login_via === "ess")) return loginThroughEss(req, res, user, email, password);
  const match = user && user.password_hash ? await bcrypt.compare(password, user.password_hash) : await bcrypt.compare(password, DUMMY_HASH) && false;
  if (!user || !match) {
    await audit(req, "login_failed", { actor: null, outcome: "denied", details: email });
    res.status(401);
    return renderLogin(res, { error: "Invalid email or password.", email });
  }
  const account = await loadAccount(user.id);
  const problem = accessProblem(account);
  if (problem) {
    await audit(req, "login_refused", { actor: account, outcome: "denied", recordType: "crm_user", recordId: user.id, details: problem });
    res.status(403);
    return renderLogin(res, { error: problem, email, unverified: account.account_status === "pending_verification" });
  }

  await startSession(req, user);
  await CrmUser.update({ last_login_at: new Date() }, { where: { id: user.id } });
  await audit(req, "login", { actor: account, recordType: "crm_user", recordId: user.id });
  req.flash("success_msg", `Welcome back, ${user.display_name}.`);
  res.redirect(DASHBOARD_PATHS[user.role] || "/");
};

// One generic message for every ESS failure; only "ESS is unavailable" is different. The real reason goes to the audit log.
const loginThroughEss = async (req, res, user, email, password) => {
  const answer = await askEss({ email, password });
  if (!answer.ok) {
    await audit(req, "login_failed", { actor: null, outcome: "denied", recordType: "crm_user", recordId: user.id, details: `${email} via ESS (${essLoginMode()}): ${answer.reason}` });
    res.status(answer.reason === "unavailable" ? 503 : 401);
    return renderLogin(res, { error: answer.reason === "unavailable" ? ESS_UNAVAILABLE : ESS_GENERIC_ERROR, email });
  }
  const why = await checkEssAnswer(user, answer.profile);
  if (why) {
    await audit(req, "login_refused", { actor: null, outcome: "denied", recordType: "crm_user", recordId: user.id, details: `${email} via ESS (${essLoginMode()}): ${why}` });
    res.status(401);
    return renderLogin(res, { error: ESS_GENERIC_ERROR, email });
  }
  await activateViaEss(req, user, answer.profile);
  const account = await loadAccount(user.id);
  const problem = accessProblem(account);
  if (problem) {
    await audit(req, "login_refused", { actor: account, outcome: "denied", recordType: "crm_user", recordId: user.id, details: `via ESS: ${problem}` });
    res.status(401);
    return renderLogin(res, { error: ESS_GENERIC_ERROR, email });
  }
  await startSession(req, { ...user, role: account.role });
  await CrmUser.update({ last_login_at: new Date() }, { where: { id: user.id } });
  await audit(req, "login", { actor: account, recordType: "crm_user", recordId: user.id, details: `via ESS (${essLoginMode()})` });
  req.flash("success_msg", `Welcome back, ${account.display_name}.`);
  return res.redirect(DASHBOARD_PATHS[account.role] || "/");
};

export const registerUser = async (req, res) => {
  const form = {
    first_name: clean(req.body.first_name, 80),
    last_name: clean(req.body.last_name, 80),
    email: clean(req.body.email, 254).toLowerCase(),
    mobile: clean(req.body.mobile, 20),
    address: clean(req.body.address, 200),
    consent: req.body.consent === "1",
  };
  const password = String(req.body.password || "");
  const confirm = String(req.body.confirm_password || "");
  const errors = [];
  if (form.first_name.length < 1 || form.last_name.length < 2) errors.push("Enter your first and last name.");
  if (!isEmail(form.email)) errors.push("Enter a valid email address.");
  if (password.length < 8) errors.push("Password must be at least 8 characters.");
  if (password.length > 72) errors.push("Password must be 72 characters or fewer.");
  if (password !== confirm) errors.push("Passwords do not match.");
  if (form.mobile && !isPhone(form.mobile)) errors.push("Enter a valid mobile number.");
  if (!form.consent) errors.push("Please agree to the Data Privacy Notice and Terms to create an account.");
  if (errors.length) {
    res.status(422);
    return res.render("register", { title: "Create a customer account", errors, form });
  }

  let created;
  try {
    created = await registerPortalCustomer({
      firstName: form.first_name, lastName: form.last_name, email: form.email, mobile: form.mobile, address: form.address,
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS), emailVerified: false,
    });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    res.status(422);
    return res.render("register", { title: "Create a customer account", errors: [err.message], form });
  }
  // No session yet: the customer signs in after confirming the email address.
  await audit(req, "customer_registered", {
    actor: created.user, recordType: "customer", recordId: created.customer.customer_no,
    after: { customer_no: created.customer.customer_no, consents: ["data_privacy", "terms"], email_verified: false },
  });
  const link = await sendVerification(created.user);
  await audit(req, "verification_email_queued", { actor: created.user, recordType: "crm_user", recordId: created.user.id });
  res.render("verify_sent", { title: "Check your email", email: form.email, customerNo: created.customer.customer_no, devLink: isDevMailbox() ? link : null });
};

export const logoutUser = async (req, res, next) => {
  if (req.user) await audit(req, "logout", { recordType: "crm_user", recordId: req.user.id });
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("jvt.sid");
    res.redirect("/login?logged_out=1");
  });
};
