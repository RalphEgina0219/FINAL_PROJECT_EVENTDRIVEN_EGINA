/*
 * 102 — roles, permissions, role_permissions  (master prompt §XI: roles, permissions)
 * The role-permission matrix (blueprint supplement I) is data, read by middleware/permissions.js.
 * Hierarchy (master prompt §II): CRM Manager > Team Leader > Agent. Customer is external.
 * system_admin is the setup-only account (decision 2026-11-11): outside the CRM hierarchy,
 * no case/customer/sales access, every action audit-logged.
 */
import { run, dropTables } from "./_sql.js";

const ROLES = [
  ["system_admin", "System Administrator (setup only)", "system", null, "Initial setup: categories, settings, local staff accounts while HR is in mock mode, emergency access recovery"],
  ["crm_manager", "CRM Manager", "staff", 1, "Manages CRM operations, configuration, assignments, escalations (level 2) and reports"],
  ["team_leader", "Team Leader", "staff", 2, "Manages a team of agents, assigns cases, handles escalations (level 1)"],
  ["agent", "Agent", "staff", 3, "Handles assigned customers, inquiries, cases and orders"],
  ["customer", "Customer Account", "customer", null, "External customer portal account: own profile, orders, cases and feedback only"],
];

// [code, module, description, roles]
const PERMISSIONS = [
  ["cases.view_own", "cases", "View own cases (customer)", ["customer"]],
  ["cases.create_own", "cases", "Submit a complaint or inquiry (customer)", ["customer"]],
  ["cases.view_assigned", "cases", "View cases assigned to me", ["agent"]],
  ["cases.view_team", "cases", "View my team's cases and the unrouted queue", ["team_leader"]],
  ["cases.view_all", "cases", "View every case", ["crm_manager"]],
  ["cases.reply", "cases", "Reply on a case I may handle", ["customer", "agent", "team_leader", "crm_manager"]],
  ["cases.internal_note", "cases", "Add internal notes", ["agent", "team_leader", "crm_manager"]],
  ["cases.update_status", "cases", "Change case status within the allowed flow", ["agent", "team_leader", "crm_manager"]],
  ["cases.update_priority", "cases", "Change priority and category", ["agent", "team_leader", "crm_manager"]],
  ["cases.assign_team", "cases", "Assign cases to agents in my team", ["team_leader"]],
  ["cases.assign_any", "cases", "Assign cases to any agent", ["crm_manager"]],
  ["cases.escalate", "cases", "Escalate a case to the next level", ["agent", "team_leader"]],
  ["cases.handle_escalation_l1", "cases", "Handle level-1 escalations (team)", ["team_leader", "crm_manager"]],
  ["cases.handle_escalation_l2", "cases", "Handle level-2 escalations", ["crm_manager"]],
  ["cases.rate_own", "cases", "Rate a resolved case and leave feedback", ["customer"]],
  ["customers.view_assigned", "customers", "View customers I handle", ["agent"]],
  ["customers.view_team", "customers", "View my team's customers", ["team_leader"]],
  ["customers.view_all", "customers", "View the customer directory", ["crm_manager"]],
  ["customers.view_full_contact", "customers", "See unmasked email/mobile on the detail page", ["agent", "team_leader", "crm_manager"]],
  ["feedback.view", "feedback", "View customer feedback and ratings", ["team_leader", "crm_manager"]],
  ["reports.view_team", "reports", "Team reports", ["team_leader"]],
  ["reports.view_all", "reports", "CRM reports and analytics", ["crm_manager"]],
  ["reports.export", "reports", "Export reports (PDF, Excel, CSV)", ["team_leader", "crm_manager"]],
  ["team.performance", "team", "Agent and team performance", ["team_leader", "crm_manager"]],
  ["settings.manage", "settings", "CRM rules, SLA targets", ["crm_manager", "system_admin"]],
  ["categories.manage", "settings", "Case categories", ["crm_manager", "system_admin"]],
  ["templates.manage", "settings", "Response templates", ["crm_manager", "system_admin"]],
  ["audit.view", "settings", "View the audit log", ["crm_manager", "system_admin"]],
  ["teams.manage", "settings", "Teams and CRM access for HR employees", ["crm_manager"]],
  ["staff.manage_local", "setup", "Local staff accounts (only while HR is in mock mode)", ["system_admin"]],
  ["integration.view", "settings", "Integration Health page", ["crm_manager", "system_admin"]],
  ["approvals.decide", "approvals", "Decide employee requests routed to me (feature flag)", ["team_leader", "crm_manager"]],
  ["orders.create", "sales", "Create orders and sales for customers", ["agent", "team_leader", "crm_manager"]],
  ["orders.view_own", "sales", "View own orders (customer)", ["customer"]],
  ["refunds.approve", "sales", "Approve refunds (never own requests)", ["team_leader", "crm_manager"]],
  ["campaigns.manage", "sales", "Campaigns, promotions and discounts", ["crm_manager"]],
  ["profile.manage", "account", "Own profile and password", ["system_admin", "crm_manager", "team_leader", "agent", "customer"]],
];

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(30) NOT NULL UNIQUE,
      name VARCHAR(60) NOT NULL,
      user_type ENUM('system','staff','customer') NOT NULL,
      hierarchy_level TINYINT NULL COMMENT '1 CRM Manager, 2 Team Leader, 3 Agent; NULL outside the CRM hierarchy',
      description VARCHAR(255) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE permissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(60) NOT NULL UNIQUE,
      module VARCHAR(30) NOT NULL,
      description VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE role_permissions (
      role_id INT NOT NULL,
      permission_id INT NOT NULL,
      PRIMARY KEY (role_id, permission_id),
      CONSTRAINT role_permissions_role_fk FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
      CONSTRAINT role_permissions_permission_fk FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]);
  for (const [code, name, userType, level, description] of ROLES) {
    await sequelize.query(
      "INSERT INTO roles (code, name, user_type, hierarchy_level, description) VALUES (?, ?, ?, ?, ?)",
      { replacements: [code, name, userType, level, description] }
    );
  }
  for (const [code, module, description, roles] of PERMISSIONS) {
    await sequelize.query("INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)", { replacements: [code, module, description] });
    await sequelize.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = ? WHERE r.code IN (?)`,
      { replacements: [code, roles] }
    );
  }
};

export const down = async ({ sequelize }) => dropTables(sequelize, ["role_permissions", "permissions", "roles"]);
