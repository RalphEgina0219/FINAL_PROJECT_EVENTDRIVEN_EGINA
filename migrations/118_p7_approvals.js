/*
 * 118 — P7 employee request approvals: ONE permission row (data only). No table is created or altered.
 * approval_requests (migration 109) already has every column P7 needs: requester, resolved approver and role, status
 * (pending / approved / rejected / returned / exception), exception reason, payload, decision, source and decision event ids, is_mock,
 * and the CHECK that nobody decides their own request. approvals.decide (migration 102, Team Leader and CRM Manager) is reused.
 *   approvals.exceptions   the CRM Manager works the exception queue: assign an approver, decide directly, or return a request to HR.
 */
export const up = async ({ sequelize }) => {
  await sequelize.query("INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)", {
    replacements: ["approvals.exceptions", "approvals", "Work the approvals exception queue: assign an approver, decide directly or return a request to HR"],
  });
  await sequelize.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'approvals.exceptions' WHERE r.code = 'crm_manager'`
  );
};

export const down = async ({ sequelize }) => {
  await sequelize.query("DELETE FROM permissions WHERE code = 'approvals.exceptions'");
};
