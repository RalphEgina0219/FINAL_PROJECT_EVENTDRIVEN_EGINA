/*
 * Authentication, role/permission checks and record of denied attempts.
 * Roles: system_admin (setup only), crm_manager, team_leader, agent, customer.
 *
 * On every request the signed-in account is re-checked:
 *   - crm_users.is_active (CRM access switch)
 *   - staff: the linked HR employee must not be inactive/separated, and no HR revocation may be set
 *     (so an HR status change ends open sessions on their next request)
 *   - customers: customer_accounts.status must be active
 * Hidden buttons are never the only protection: every route checks roles/permissions on the server,
 * and denied attempts are written to the audit log (blueprint §11, TC-04).
 */
import { QueryTypes } from "sequelize";
import { sequelize, ACCESS_BLOCKING_STATUSES } from "../models/index.js";
import { buildNav, DASHBOARD_PATHS } from "../helpers/navigation.js";
import { ROLE_LABELS, EMPLOYMENT_STATUS_LABELS } from "../helpers/labels.js";
import { unreadCount } from "../services/notificationService.js";
import { unreadCaseCount, queueCount, pendingEscalationCount } from "../services/caseService.js";
import { can } from "../services/permissionService.js";
import { audit } from "../services/auditService.js";

export const loadAccount = async (userId) => {
  const [row] = await sequelize.query(
    `SELECT u.id, u.display_name, u.email, u.role, u.user_type, u.team_id, u.is_active, u.is_demo, u.access_revoked_at,
            u.employee_id, u.email_verified_at, LEFT(SHA2(u.password_hash, 256), 16) AS pwv,
            e.employment_status, e.is_mock, ca.customer_id, ca.status AS account_status, t.name AS team_name
     FROM crm_users u
     LEFT JOIN employee_references e ON e.employee_id = u.employee_id
     LEFT JOIN customer_accounts ca ON ca.user_id = u.id
     LEFT JOIN crm_teams t ON t.id = u.team_id
     WHERE u.id = :userId`,
    { type: QueryTypes.SELECT, replacements: { userId } }
  );
  return row || null;
};

// Returns a message when the account may not use the CRM right now, else null.
export const accessProblem = (a) => {
  if (!a) return "Please sign in again.";
  if (!a.is_active) return "Your CRM access has been deactivated. Please contact the CRM Manager.";
  if (a.user_type === "staff") {
    if (!a.employment_status) return "Your account is not linked to an HR employee record. Please contact the CRM Manager.";
    if (ACCESS_BLOCKING_STATUSES.includes(a.employment_status) || a.access_revoked_at) {
      return `Your CRM access was removed because your HR employment status is "${EMPLOYMENT_STATUS_LABELS[a.employment_status] || a.employment_status}".`;
    }
  }
  if (a.user_type === "customer" && a.account_status === "pending_verification") {
    return "Please confirm your email address first. Open the link we sent you, or request a new one below.";
  }
  if (a.user_type === "customer" && a.account_status !== "active") return "Your customer account is not active. Please contact JOHNVIVZ customer service.";
  return null;
};

const SKIP_COUNTS = ["/attachments/", "/crm/reports/export", "/setup/audit-logs"];

export const loadUser = async (req, res, next) => {
  try {
    if (!req.session.userId) return next();
    const account = await loadAccount(req.session.userId);
    const problem = accessProblem(account)
      || (req.session.pwv && account.pwv !== req.session.pwv ? "Your password was changed. Please sign in again." : null);
    if (problem) {
      if (account) await audit(req, "session_ended", { actor: account, outcome: "denied", recordType: "crm_user", recordId: account.id, details: problem });
      delete req.session.userId;
      delete req.session.role;
      delete req.session.pwv;
      req.flash("error_msg", problem);
      return next();
    }
    const user = {
      id: account.id,
      name: account.display_name,
      email: account.email,
      role: account.role,
      user_type: account.user_type,
      team_id: account.team_id,
      team_name: account.team_name,
      customer_id: account.customer_id,
      employee_id: account.employee_id,
      is_mock: Boolean(account.is_mock),
      is_demo: Boolean(account.is_demo),
    };
    req.user = user;
    res.locals.currentUser = { ...user, roleLabel: ROLE_LABELS[user.role], isSetup: user.role === "system_admin" };
    res.locals.dashboardPath = DASHBOARD_PATHS[user.role];
    res.locals.nav = buildNav(user.role, req.path);
    if (req.method === "GET" && !SKIP_COUNTS.some((p) => req.path.startsWith(p))) {
      const isCaseRole = ["customer", "agent", "team_leader", "crm_manager"].includes(user.role);
      const [unreadNotifications, unreadCases, queue, escalations] = await Promise.all([
        unreadCount(user.id),
        isCaseRole ? unreadCaseCount(user) : 0,
        user.role === "team_leader" ? queueCount(user) : 0,
        user.role === "crm_manager" ? pendingEscalationCount(user) : 0,
      ]);
      res.locals.unreadNotifications = unreadNotifications;
      res.locals.nav = buildNav(user.role, req.path, { unreadNotifications, unreadCases, queueCount: queue, pendingEscalations: escalations });
    }
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAuth = (req, res, next) => {
  if (req.user) return next();
  req.flash("error_msg", "Please sign in to continue.");
  return res.redirect("/login");
};

export const deny = async (req, res, message = "Your role does not have access to this page.") => {
  await audit(req, "access_denied", { outcome: "denied", details: `${req.method} ${req.originalUrl}`.slice(0, 500) });
  return res.status(403).render("error", { title: "Access denied", status: 403, message });
};

export const requireRole = (...roles) => [
  requireAuth,
  (req, res, next) => (roles.includes(req.user.role) ? next() : deny(req, res)),
];

// Passes when the user's role has at least one of the permissions (role_permissions table).
export const requirePermission = (...permissions) => [
  requireAuth,
  (req, res, next) => (permissions.some((p) => can(req.user, p)) ? next() : deny(req, res)),
];

export const guestOnly = (req, res, next) => {
  if (req.user) return res.redirect(DASHBOARD_PATHS[req.user.role] || "/");
  next();
};

// The setup System Administrator is outside the CRM hierarchy: every change it makes is audited.
export const auditSetupAdmin = (req, res, next) => {
  if (req.user?.role === "system_admin" && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    res.on("finish", () => {
      audit(req, "setup_admin_request", {
        outcome: res.statusCode < 400 ? "success" : "failed",
        details: `${req.method} ${req.originalUrl} -> ${res.statusCode}`,
      });
    });
  }
  next();
};
