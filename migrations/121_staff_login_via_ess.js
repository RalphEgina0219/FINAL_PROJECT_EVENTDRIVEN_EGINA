/*
 * 121 — approved by the owner on 2026-11-16 (team-agreed employee account flow, contract v0.5 §12.5). One change to an EXISTING table,
 * shown and approved before it ran:
 *   crm_users.password_hash may be NULL — HR staff accounts sign in through ESS (JVzPay /auth/login); CRM never stores their password
 *   crm_users.login_via         'local' (CRM password: customers, the setup admin, the demo accounts) | 'ess' (staff created from HR)
 *   crm_users.ess_activated_at  first successful ESS sign-in (the account was "Waiting for ESS registration" until then)
 *   crm_users.role_source       'position_rule' (role from Manager › Settings position rules) | 'manager' (set by hand for this person)
 *   CHECK: only an ESS staff account may have no password.
 * Existing rows all keep login_via = 'local' (the 7 demo accounts keep Demo@1234).
 */
export const up = async ({ sequelize }) => {
  await sequelize.query(
    `ALTER TABLE crm_users
       MODIFY password_hash VARCHAR(255) NULL COMMENT 'NULL for HR staff who sign in through ESS',
       ADD COLUMN login_via ENUM('local','ess') NOT NULL DEFAULT 'local' AFTER password_hash,
       ADD COLUMN ess_activated_at DATETIME NULL AFTER login_via,
       ADD COLUMN role_source ENUM('position_rule','manager') NULL AFTER role,
       ADD CONSTRAINT crm_users_password_chk CHECK (password_hash IS NOT NULL OR (user_type = 'staff' AND login_via = 'ess'))`
  );
};

export const down = async ({ sequelize }) => {
  const [[{ n }]] = await sequelize.query("SELECT COUNT(*) AS n FROM crm_users WHERE password_hash IS NULL");
  if (Number(n) > 0) throw new Error(`Cannot roll back 121: ${n} ESS staff account(s) have no CRM password. Remove or change them first.`);
  await sequelize.query(
    `ALTER TABLE crm_users
       DROP CHECK crm_users_password_chk,
       DROP COLUMN role_source,
       DROP COLUMN ess_activated_at,
       DROP COLUMN login_via,
       MODIFY password_hash VARCHAR(255) NOT NULL`
  );
};
