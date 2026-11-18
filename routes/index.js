/*
    MIT License — Copyright (c) 2025 Christian I. Cabrera || XianFire Framework, Mindoro State University
*/
// JOHNVIVZ CRM routes. Each role has its own dashboard route (blueprint supplement E):
//   /crm/manager, /crm/team-leader, /crm/agent, /portal (customer), /setup (setup System Administrator).
// Every route checks the role/permission on the server; record scope is applied again in the services.
import express from "express";
import { homePage } from "../controllers/homeController.js";
import { loginPage, registerPage, dashboardPage, loginUser, registerUser, logoutUser } from "../controllers/authController.js";
import * as account from "../controllers/accountController.js";
import * as dash from "../controllers/dashboardController.js";
import * as cases from "../controllers/caseController.js";
import * as customers from "../controllers/customerController.js";
import * as interactions from "../controllers/interactionController.js";
import * as inquiries from "../controllers/inquiryController.js";
import * as followUps from "../controllers/followUpController.js";
import * as sales from "../controllers/salesController.js";
import * as marketing from "../controllers/marketingController.js";
import * as team from "../controllers/teamController.js";
import * as cfg from "../controllers/configController.js";
import * as setup from "../controllers/setupController.js";
import * as access from "../controllers/accessController.js";
import * as integration from "../controllers/integrationController.js";
import * as approvals from "../controllers/approvalController.js";
import * as loyalty from "../controllers/loyaltyController.js";
import * as analytics from "../controllers/analyticsController.js";
import * as users from "../controllers/userController.js";
import * as reports from "../controllers/reportController.js";
import * as notifications from "../controllers/notificationController.js";
import { requireAuth, requireRole, requirePermission, guestOnly } from "../middleware/auth.js";
import { verifyCsrf } from "../middleware/csrf.js";
import { loginLimiter, loginEmailLimiter, accountLimiter, caseSubmitLimiter } from "../middleware/rateLimit.js";
import { uploadAttachments } from "../middleware/upload.js";
import { asyncHandler as ah } from "../helpers/errors.js";

const router = express.Router();
const STAFF = requireRole("crm_manager", "team_leader", "agent");
const SUPERVISOR = requireRole("crm_manager", "team_leader");
const MANAGER = requireRole("crm_manager");
const TEAMS = requirePermission("teams.manage");
const CUSTOMER = requireRole("customer");
const SETUP = requireRole("system_admin");
const CASE_USERS = requireRole("customer", "agent", "team_leader", "crm_manager");

router.get("/", homePage);

// Auth
router.get("/login", guestOnly, ah(loginPage));
router.post("/login", guestOnly, loginLimiter, loginEmailLimiter, ah(loginUser));
router.get("/register", guestOnly, registerPage);
router.post("/register", guestOnly, ah(registerUser));
router.get("/forgot-password", guestOnly, account.forgotPasswordPage);
router.post("/forgot-password", guestOnly, accountLimiter, ah(account.forgotPassword));
router.get("/reset-password/:token", ah(account.resetPasswordPage));
router.post("/reset-password/:token", ah(account.resetPassword));
router.post("/verify-email/resend", guestOnly, accountLimiter, ah(account.resendVerificationEmail));
router.get("/verify-email/:token", ah(account.verifyEmailPage));
router.post("/verify-email/:token", ah(account.verifyEmail));
router.get("/dashboard", dashboardPage);
router.post("/logout", ah(logoutUser));

// Dashboards (one per role)
router.get("/crm/manager", MANAGER, ah(dash.managerDashboard));
router.get("/crm/team-leader", requireRole("team_leader"), ah(dash.teamLeaderDashboard));
router.get("/crm/agent", requireRole("agent"), ah(dash.agentDashboard));
router.get("/portal", CUSTOMER, ah(dash.portalHome));
router.get("/setup", SETUP, ah(dash.setupDashboard));

// Customer portal: own profile and own cases only
router.post("/portal/profile", CUSTOMER, ah(users.updatePortal));
router.post("/portal/password", CUSTOMER, ah(users.changePassword));
// Shop (P5): products, prices and stock come from Inventory; the customer keeps a cart, places and pays for own orders
router.get("/portal/shop", requirePermission("shop.use"), ah(sales.shop));
router.get("/portal/cart", requirePermission("shop.use"), ah(sales.cart));
router.post("/portal/cart/add", requirePermission("shop.use"), ah(sales.cartAdd));
router.post("/portal/cart/update", requirePermission("shop.use"), ah(sales.cartUpdate));
router.post("/portal/cart/remove", requirePermission("shop.use"), ah(sales.cartRemove));
router.post("/portal/cart/checkout", requirePermission("shop.use"), ah(sales.checkout));
router.get("/portal/orders", requirePermission("orders.view_own"), ah(sales.portalOrders));
router.get("/portal/orders/:id", requirePermission("orders.view_own"), ah(sales.portalOrder));
router.post("/portal/orders/:id/pay", requirePermission("shop.use"), ah(sales.portalPay));
router.post("/portal/orders/:id/cancel", requirePermission("shop.use"), ah(sales.portalCancel));
router.get("/portal/tracking", requirePermission("orders.view_own"), ah(sales.tracking));
// Inquiries (P4): the customer asks, staff answer or convert to a case
router.get("/portal/inquiries", requirePermission("inquiries.submit_own"), ah(inquiries.portalIndex));
router.post("/portal/inquiries", requirePermission("inquiries.submit_own"), caseSubmitLimiter, ah(inquiries.portalCreate));
router.get("/portal/inquiries/:id", requirePermission("inquiries.submit_own"), ah(inquiries.portalShow));
router.get("/portal/preferences", requirePermission("preferences.manage_own"), ah(customers.portalPreferences));
router.post("/portal/preferences", requirePermission("preferences.manage_own"), ah(customers.portalPreferencesSave));
router.get("/portal/cases", CUSTOMER, ah(cases.index));
router.get("/portal/cases/new", CUSTOMER, ah(cases.newForm));
router.post("/portal/cases", CUSTOMER, caseSubmitLimiter, uploadAttachments, verifyCsrf, ah(cases.create));
router.get("/portal/cases/:id", CUSTOMER, ah(cases.show));
router.post("/portal/cases/:id/comments", CUSTOMER, uploadAttachments, verifyCsrf, ah(cases.comment));
router.post("/portal/cases/:id/status", CUSTOMER, ah(cases.updateStatus));
router.post("/portal/cases/:id/rating", CUSTOMER, ah(cases.rate));

// Staff case work (scope: agent = assigned, team leader = team, manager = all)
router.get("/crm/cases", STAFF, ah(cases.index));
router.get("/crm/cases/new", requirePermission("cases.create_staff"), ah(cases.staffNewForm)); // before /:id
router.post("/crm/cases", requirePermission("cases.create_staff"), ah(cases.staffCreate));
router.get("/crm/cases/:id", STAFF, ah(cases.show));
router.post("/crm/cases/:id/comments", STAFF, uploadAttachments, verifyCsrf, ah(cases.comment));
router.post("/crm/cases/:id/status", requirePermission("cases.update_status"), ah(cases.updateStatus));
router.post("/crm/cases/:id/priority", requirePermission("cases.update_priority"), ah(cases.updatePriority));
router.post("/crm/cases/:id/category", requirePermission("cases.update_priority"), ah(cases.updateCategory));
router.post("/crm/cases/:id/assign", requirePermission("cases.assign_team", "cases.assign_any"), ah(cases.assign));
router.post("/crm/cases/:id/escalate", requirePermission("cases.escalate"), ah(cases.escalate));
router.post("/crm/cases/:id/escalation", requirePermission("cases.handle_escalation_l1", "cases.handle_escalation_l2"), ah(cases.escalationAction));
router.get("/crm/queue", requireRole("team_leader"), ah(cases.queue));
router.get("/crm/escalations", SUPERVISOR, ah(cases.escalations));
router.get("/attachments/:id", CASE_USERS, ah(cases.downloadAttachment));

// Customers, team, reports
const CUSTOMER_VIEW = requirePermission("customers.view_all", "customers.view_team", "customers.view_assigned");
const CUSTOMER_EDIT = requirePermission("customers.edit");
router.get("/crm/customers", CUSTOMER_VIEW, ah(customers.index));
router.get("/crm/customers/new", requirePermission("customers.create"), ah(customers.newForm)); // before /:id
router.post("/crm/customers/new", requirePermission("customers.create"), ah(customers.create));
router.get("/crm/customers/:id", CUSTOMER_VIEW, ah(customers.show));
router.post("/crm/customers/:id/profile", CUSTOMER_EDIT, ah(customers.saveProfile));
router.post("/crm/customers/:id/contacts", CUSTOMER_EDIT, ah(customers.contactAdd));
router.post("/crm/customers/:id/contacts/:contactId/primary", CUSTOMER_EDIT, ah(customers.contactPrimary));
router.post("/crm/customers/:id/contacts/:contactId/delete", CUSTOMER_EDIT, ah(customers.contactRemove));
router.post("/crm/customers/:id/addresses", CUSTOMER_EDIT, ah(customers.addressAdd));
router.post("/crm/customers/:id/addresses/:addressId", CUSTOMER_EDIT, ah(customers.addressUpdate));
router.post("/crm/customers/:id/addresses/:addressId/default", CUSTOMER_EDIT, ah(customers.addressDefault));
router.post("/crm/customers/:id/addresses/:addressId/delete", CUSTOMER_EDIT, ah(customers.addressRemove));
router.post("/crm/customers/:id/preferences", CUSTOMER_EDIT, ah(customers.preferencesSave));
router.post("/crm/customers/:id/assign", requirePermission("customers.assign_agent"), ah(customers.assign));
router.post("/crm/customers/:id/unassign", requirePermission("customers.assign_agent"), ah(customers.unassign));
// Sales (P5): scope = the order's customer scope; every price and quantity is checked against Inventory again on the server
router.get("/crm/sales", requirePermission("orders.view"), ah(sales.index));
router.get("/crm/sales/new", requirePermission("orders.create"), ah(sales.newForm)); // before /orders/:id
router.post("/crm/sales", requirePermission("orders.create"), ah(sales.create));
router.post("/crm/sales/sync", requirePermission("inventory.sync"), ah(sales.syncCatalog));
router.get("/crm/sales/payments", requirePermission("orders.view"), ah(sales.payments));
router.get("/crm/sales/refunds", requirePermission("refunds.view"), ah(sales.refunds));
router.get("/crm/sales/refunds/:id", requirePermission("refunds.view"), ah(sales.refundShow));
router.post("/crm/sales/refunds/:id/decide", requirePermission("refunds.approve"), ah(sales.refundDecide));
router.post("/crm/sales/refunds/:id/record", requirePermission("refunds.approve"), ah(sales.refundRecord));
router.get("/crm/sales/orders/:id", requirePermission("orders.view"), ah(sales.show));
router.post("/crm/sales/orders/:id/payments", requirePermission("orders.create"), ah(sales.pay));
router.post("/crm/sales/orders/:id/payments/:paymentId/verify", requirePermission("payments.verify"), ah(sales.verify));
router.post("/crm/sales/orders/:id/payments/:paymentId/void", requirePermission("orders.create"), ah(sales.voidIt));
router.post("/crm/sales/orders/:id/ready", requirePermission("orders.create"), ah(sales.ready));
router.post("/crm/sales/orders/:id/complete", requirePermission("orders.create"), ah(sales.complete));
router.post("/crm/sales/orders/:id/cancel", requirePermission("orders.create"), ah(sales.cancel));
router.post("/crm/sales/orders/:id/refund", requirePermission("refunds.request"), ah(sales.requestRefundAction));
// Campaigns (Manager) and promotions (Manager creates; a Team Leader or the Manager who is not the creator approves)
router.get("/crm/campaigns", requirePermission("campaigns.manage"), ah(marketing.campaignIndex));
router.get("/crm/campaigns/new", requirePermission("campaigns.manage"), marketing.campaignNew); // before /:id
router.post("/crm/campaigns", requirePermission("campaigns.manage"), ah(marketing.campaignCreate));
router.get("/crm/campaigns/:id", requirePermission("campaigns.manage"), ah(marketing.campaignShow));
router.post("/crm/campaigns/:id/activate", requirePermission("campaigns.manage"), ah(marketing.campaignAction("activate")));
router.post("/crm/campaigns/:id/end", requirePermission("campaigns.manage"), ah(marketing.campaignAction("end")));
router.post("/crm/campaigns/:id/cancel", requirePermission("campaigns.manage"), ah(marketing.campaignAction("cancel")));
router.get("/crm/promotions", requirePermission("promotions.view"), ah(marketing.promotionIndex));
router.get("/crm/promotions/new", requirePermission("campaigns.manage"), ah(marketing.promotionNew)); // before /:id
router.post("/crm/promotions", requirePermission("campaigns.manage"), ah(marketing.promotionCreate));
router.post("/crm/promotions/:id/approve", requirePermission("promotions.approve"), ah(marketing.promotionApprove));
router.post("/crm/promotions/:id/reject", requirePermission("promotions.approve"), ah(marketing.promotionReject));
router.post("/crm/promotions/:id/cancel", requirePermission("campaigns.manage"), ah(marketing.promotionCancel));
// Inquiries (staff): scope = customer scope or handled by me; Team Leaders / Manager assign
router.get("/crm/inquiries", requirePermission("inquiries.view"), ah(inquiries.index));
router.get("/crm/inquiries/new", requirePermission("inquiries.create"), ah(inquiries.newForm)); // before /:id
router.post("/crm/inquiries", requirePermission("inquiries.create"), ah(inquiries.create));
router.get("/crm/inquiries/:id", requirePermission("inquiries.view"), ah(inquiries.show));
router.post("/crm/inquiries/:id/answer", requirePermission("inquiries.answer"), ah(inquiries.answer));
router.post("/crm/inquiries/:id/convert", requirePermission("inquiries.answer"), ah(inquiries.convert));
router.post("/crm/inquiries/:id/close", requirePermission("inquiries.answer"), ah(inquiries.close));
router.post("/crm/inquiries/:id/take", requirePermission("inquiries.answer"), ah(inquiries.take));
router.post("/crm/inquiries/:id/assign", requirePermission("inquiries.assign"), ah(inquiries.assign));
// Follow-up tasks: agent = own, Team Leader = team, Manager = all
router.get("/crm/follow-ups", requirePermission("followups.view"), ah(followUps.index));
router.get("/crm/follow-ups/new", requirePermission("followups.manage"), ah(followUps.newForm)); // before /:id
router.post("/crm/follow-ups", requirePermission("followups.manage"), ah(followUps.create));
router.get("/crm/follow-ups/:id", requirePermission("followups.view"), ah(followUps.show));
router.post("/crm/follow-ups/:id/complete", requirePermission("followups.manage"), ah(followUps.complete));
router.post("/crm/follow-ups/:id/cancel", requirePermission("followups.manage"), ah(followUps.cancel));
router.post("/crm/follow-ups/:id/reschedule", requirePermission("followups.manage"), ah(followUps.reschedule));
router.post("/crm/follow-ups/:id/reassign", requirePermission("followups.assign"), ah(followUps.reassign));
// Interactions (scope = the customer's scope)
router.get("/crm/interactions", requirePermission("interactions.view"), ah(interactions.index));
router.get("/crm/interactions/new", requirePermission("interactions.log"), ah(interactions.newForm)); // before /:id
router.post("/crm/interactions", requirePermission("interactions.log"), ah(interactions.create));
router.get("/crm/interactions/:id", requirePermission("interactions.view"), ah(interactions.show));
router.get("/crm/team-performance", requirePermission("team.performance"), ah(team.performance));
router.get("/crm/reports", requirePermission("reports.view_all", "reports.view_team"), ah(reports.show));
router.get("/crm/reports/export/:format", requirePermission("reports.export"), ah(reports.exportReport));

// CRM Manager > Settings (tabs)
router.get("/crm/settings", MANAGER, cfg.rules);
router.post("/crm/settings", MANAGER, ah(cfg.saveRules));
router.get("/crm/settings/categories", MANAGER, ah(cfg.categories));
router.post("/crm/settings/categories", MANAGER, ah(cfg.createCategory));
router.post("/crm/settings/categories/:id", MANAGER, ah(cfg.updateCategory));
router.post("/crm/settings/categories/:id/toggle", MANAGER, ah(cfg.toggleCategory));
router.post("/crm/settings/categories/:id/delete", MANAGER, ah(cfg.deleteCategory));
router.get("/crm/settings/templates", MANAGER, ah(cfg.templates));
router.post("/crm/settings/templates", MANAGER, ah(cfg.saveTemplate));
router.post("/crm/settings/templates/:id", MANAGER, ah(cfg.saveTemplate));
router.post("/crm/settings/templates/:id/toggle", MANAGER, ah(cfg.toggleTemplate));
router.post("/crm/settings/templates/:id/delete", MANAGER, ah(cfg.deleteTemplate));
router.get("/crm/settings/audit-logs", MANAGER, ah(cfg.auditLog));
router.get("/crm/settings/permissions", MANAGER, ah(cfg.permissions));
// Teams & CRM Access (permission teams.manage; every POST is audited by the service)
router.get("/crm/settings/access", TEAMS, ah(access.page));
router.post("/crm/settings/access/teams", TEAMS, ah(access.teamCreate));
router.post("/crm/settings/access/teams/:id", TEAMS, ah(access.teamUpdate));
router.post("/crm/settings/access/teams/:id/toggle", TEAMS, ah(access.teamToggle));
router.post("/crm/settings/access/provision", TEAMS, ah(access.provision));
router.post("/crm/settings/access/rules", TEAMS, ah(access.rules));
router.post("/crm/settings/access/users/:id/assignment", TEAMS, ah(access.assignment));
router.post("/crm/settings/access/users/:id/access", TEAMS, ah(access.access));

// Setup System Administrator (setup only; every POST is audited by auditSetupAdmin)
router.get("/setup/settings", SETUP, cfg.rules);
router.post("/setup/settings", SETUP, ah(cfg.saveRules));
router.get("/setup/categories", SETUP, ah(cfg.categories));
router.post("/setup/categories", SETUP, ah(cfg.createCategory));
router.post("/setup/categories/:id", SETUP, ah(cfg.updateCategory));
router.post("/setup/categories/:id/toggle", SETUP, ah(cfg.toggleCategory));
router.post("/setup/categories/:id/delete", SETUP, ah(cfg.deleteCategory));
router.get("/setup/templates", SETUP, ah(cfg.templates));
router.post("/setup/templates", SETUP, ah(cfg.saveTemplate));
router.post("/setup/templates/:id", SETUP, ah(cfg.saveTemplate));
router.post("/setup/templates/:id/toggle", SETUP, ah(cfg.toggleTemplate));
router.post("/setup/templates/:id/delete", SETUP, ah(cfg.deleteTemplate));
router.get("/setup/audit-logs", SETUP, ah(cfg.auditLog));
router.get("/setup/staff", SETUP, ah(setup.staff));
router.post("/setup/staff", SETUP, ah(setup.createStaffLogin));
router.post("/setup/staff/hr-status", SETUP, ah(setup.simulateHrStatus));
router.post("/setup/staff/hr-reference", SETUP, ah(setup.simulateHrReference));
router.post("/setup/staff/mock-ess", SETUP, ah(setup.mockEssRegistration));
router.get("/setup/mail-log", SETUP, ah(setup.mailLog));
router.post("/setup/staff/:id/password", SETUP, ah(setup.resetStaffPassword));
router.post("/setup/staff/:id/toggle", SETUP, ah(setup.toggleStaffAccess));

// Integration Health (P6): the CRM Manager under Settings, the setup System Administrator under /setup. Viewing needs integration.view,
// every action needs integration.manage and is written to the audit log.
for (const base of ["/crm/settings/integration", "/setup/integration"]) {
  const ROLE = base.startsWith("/setup") ? SETUP : MANAGER; // each URL belongs to one role; the permission is checked as well
  const VIEW = [ROLE, requirePermission("integration.view")];
  const ACT = [ROLE, requirePermission("integration.manage")];
  router.get(base, VIEW, ah(integration.page));
  router.get(`${base}/reconciliation`, VIEW, ah(integration.reconciliation));
  router.post(`${base}/dispatch`, ACT, ah(integration.dispatchNow));
  router.post(`${base}/outbox/:id/retry`, ACT, ah(integration.retryOne));
  router.post(`${base}/retry-dead`, ACT, ah(integration.retryDead));
  router.post(`${base}/compensations/:id/retry`, ACT, ah(integration.retryCompensationAction));
  router.post(`${base}/inbox/:id/reprocess`, ACT, ah(integration.reprocessInbox));
  router.post(`${base}/test/:system`, ACT, ah(integration.testConnection));
  router.post(`${base}/hr-sync`, ACT, ah(integration.hrSyncNow));
}

// Employee request approvals (P7, behind APPROVALS_ENABLED): Team Leader and CRM Manager decide; only the Manager works the exception queue.
const APPROVER = requirePermission("approvals.decide");
const EXCEPTIONS = requirePermission("approvals.exceptions");
router.get("/crm/approvals", APPROVER, ah(approvals.index));
router.get("/crm/approvals/:id", APPROVER, ah(approvals.show));
router.post("/crm/approvals/:id/decide", APPROVER, ah(approvals.decide));
router.post("/crm/approvals/:id/assign", EXCEPTIONS, ah(approvals.assign));
router.post("/crm/approvals/:id/return", EXCEPTIONS, ah(approvals.sendBack));
// Analytics (P9): real data only; forecasts are statistical estimates (CRM Manager)
const ANALYTICS = requirePermission("reports.view_all");
router.get("/crm/analytics", ANALYTICS, ah(analytics.index));
router.get("/crm/analytics/sales", ANALYTICS, ah(analytics.sales));
router.get("/crm/analytics/customers", ANALYTICS, ah(analytics.customers));
router.get("/crm/analytics/forecasts", ANALYTICS, ah(analytics.forecasts));
router.post("/crm/analytics/forecasts/generate", ANALYTICS, ah(analytics.generate));
router.post("/crm/analytics/customers/segments", ANALYTICS, ah(analytics.segments));
// Loyalty (P8): the customer's own points; the Manager's accounts list (no edit screen: points change only by earn, redeem, refund and cancel)
router.get("/portal/loyalty", requirePermission("shop.use"), ah(loyalty.portal));
router.get("/crm/loyalty", requirePermission("loyalty.view"), ah(loyalty.index));
router.get("/crm/loyalty/:id", requirePermission("loyalty.view"), ah(loyalty.show));
// My Requests: a read-only copy of the signed-in staff member's OWN requests (Agent, Team Leader, CRM Manager)
router.get("/crm/my-requests", requirePermission("requests.view_own"), ah(approvals.mine));
router.get("/crm/my-requests/:id", requirePermission("requests.view_own"), ah(approvals.mineShow));
// Setup only: the MOCK ESS that sends requests while HR is in mock mode (every POST is audited by auditSetupAdmin)
router.get("/setup/approvals", SETUP, ah(approvals.mockPage));
router.post("/setup/approvals", SETUP, ah(approvals.mockCreate));

// Every signed-in user
router.get("/notifications", requireAuth, ah(notifications.index));
router.get("/notifications/:id/open", requireAuth, ah(notifications.open));
router.post("/notifications/read-all", requireAuth, ah(notifications.readAll));
router.get("/profile", requireRole("system_admin", "crm_manager", "team_leader", "agent"), ah(users.profile));
router.post("/profile/password", requireRole("system_admin", "crm_manager", "team_leader", "agent"), ah(users.changePassword));

export default router;
