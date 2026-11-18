/*
 * 114 — P3 customer master: new permissions (data only, no table is changed).
 * Rows are added to `permissions` and `role_permissions` (tables created in 102). Record scope still decides
 * WHICH customers a role may touch; these codes decide WHETHER the role may do the action at all.
 */

// [code, module, description, roles]
const PERMISSIONS = [
  ["customers.create", "customers", "Create walk-in / phone customers (duplicate check first)", ["agent", "team_leader", "crm_manager"]],
  ["customers.edit", "customers", "Edit a customer's profile, contacts, addresses and preferences within my scope", ["agent", "team_leader", "crm_manager"]],
  ["customers.assign_agent", "customers", "Assign a customer to an agent (own team for Team Leaders)", ["team_leader", "crm_manager"]],
  ["interactions.log", "customers", "Log an interaction with a customer in my scope", ["agent", "team_leader", "crm_manager"]],
  ["interactions.view", "customers", "View the interaction timeline of customers in my scope", ["agent", "team_leader", "crm_manager"]],
  ["preferences.manage_own", "account", "Manage own contact preferences and marketing consent (customer)", ["customer"]],
];

export const up = async ({ sequelize }) => {
  for (const [code, module, description, roles] of PERMISSIONS) {
    await sequelize.query("INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)", { replacements: [code, module, description] });
    await sequelize.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = ? WHERE r.code IN (?)`,
      { replacements: [code, roles] }
    );
  }
};

export const down = async ({ sequelize }) => {
  await sequelize.query("DELETE FROM permissions WHERE code IN (?)", { replacements: [PERMISSIONS.map((p) => p[0])] });
};
