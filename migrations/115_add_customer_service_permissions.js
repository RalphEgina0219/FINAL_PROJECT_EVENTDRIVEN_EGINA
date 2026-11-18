/*
 * 115 — P4 customer service: new permissions (data only, no table is changed).
 * Rows are added to `permissions` and `role_permissions` (tables created in 102). The tables P4 uses
 * (inquiries, follow_up_tasks, customer_cases, customer_interactions) already exist from 105 and 108.
 * Record scope still decides WHICH inquiries, follow-ups and customers a role may touch.
 */

// [code, module, description, roles]
const PERMISSIONS = [
  ["inquiries.view", "inquiries", "View inquiries of customers in my scope, and inquiries handled by me", ["agent", "team_leader", "crm_manager"]],
  ["inquiries.create", "inquiries", "Record an inquiry received by phone, walk-in, SMS, social or email", ["agent", "team_leader", "crm_manager"]],
  ["inquiries.answer", "inquiries", "Answer, convert to a case or close an inquiry I may handle", ["agent", "team_leader", "crm_manager"]],
  ["inquiries.assign", "inquiries", "Assign an inquiry to an agent (own team for Team Leaders)", ["team_leader", "crm_manager"]],
  ["inquiries.submit_own", "inquiries", "Submit and read own inquiries (customer portal)", ["customer"]],
  ["followups.view", "followups", "View follow-up tasks in my scope", ["agent", "team_leader", "crm_manager"]],
  ["followups.manage", "followups", "Create, complete, cancel and reschedule follow-up tasks in my scope", ["agent", "team_leader", "crm_manager"]],
  ["followups.assign", "followups", "Assign follow-up tasks to other staff (own team for Team Leaders)", ["team_leader", "crm_manager"]],
  ["cases.create_staff", "cases", "Create a case for a customer who phoned or walked in", ["agent", "team_leader", "crm_manager"]],
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
