/*
 * 119 — approved by the owner on 2026-11-14 (P7 review). One change to an EXISTING table, shown and approved before it ran:
 *   approval_requests.status gains the value 'superseded'. A changed request arrives from HR/ESS as a NEW request_id that names the
 *   one it replaces (data.replaces_request_id, DRAFT contract §5.1); the old one, if still pending or in the exception queue, becomes
 *   'superseded': audited, NOT a decision, no event to HR, out of every queue.
 * Plus one permission row (data only):
 *   requests.view_own   staff see the result of their OWN employee requests in "My Requests" (read-only copy; ESS/HR owns them).
 */
export const up = async ({ sequelize }) => {
  await sequelize.query(
    `ALTER TABLE approval_requests
       MODIFY status ENUM('pending','approved','rejected','returned','exception','superseded') NOT NULL DEFAULT 'pending'`
  );
  await sequelize.query("INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)", {
    replacements: ["requests.view_own", "approvals", "See the status and result of my own employee requests (read-only; filed and owned in ESS/HR)"],
  });
  await sequelize.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'requests.view_own' WHERE r.code IN ('agent', 'team_leader', 'crm_manager')`
  );
};

export const down = async ({ sequelize }) => {
  await sequelize.query("DELETE FROM permissions WHERE code = 'requests.view_own'");
  const [[{ n }]] = await sequelize.query("SELECT COUNT(*) AS n FROM approval_requests WHERE status = 'superseded'");
  if (Number(n) > 0) throw new Error(`Cannot roll back 119: ${n} request(s) are superseded. Leave them or change them first.`);
  await sequelize.query(
    `ALTER TABLE approval_requests
       MODIFY status ENUM('pending','approved','rejected','returned','exception') NOT NULL DEFAULT 'pending'`
  );
};
