/*
 * 105 — crm_teams, crm_users, customer_accounts, email_verification_tokens, agent_assignments,
 *       customer_interactions; plus the FKs from earlier tables that point to crm_users.
 * crm_users holds every login. Staff logins must link to an HR employee (employee_id); access is
 * refused when that employee is inactive/separated. Customer logins link to customers through
 * customer_accounts (master prompt §XI). The setup System Administrator has no employee link.
 */
import { run, dropTables, dropForeignKeyIfExists, TS } from "./_sql.js";

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE crm_teams (
      id INT AUTO_INCREMENT PRIMARY KEY,
      team_code VARCHAR(20) NOT NULL UNIQUE,
      name VARCHAR(100) NOT NULL,
      team_leader_id INT NULL,
      manager_id INT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      ${TS}
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE crm_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_type ENUM('system','staff','customer') NOT NULL,
      role VARCHAR(30) NOT NULL,
      employee_id VARCHAR(64) NULL UNIQUE COMMENT 'staff: HR employee_id',
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(150) NOT NULL,
      team_id INT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'CRM access switch',
      is_available TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'agents: accepts new assignments',
      email_verified_at DATETIME NULL,
      last_login_at DATETIME NULL,
      access_revoked_at DATETIME NULL,
      access_revoked_reason VARCHAR(255) NULL,
      is_demo TINYINT(1) NOT NULL DEFAULT 0,
      ${TS},
      INDEX crm_users_role_idx (role, is_active),
      CONSTRAINT crm_users_type_chk CHECK (
        (user_type = 'system' AND role = 'system_admin' AND employee_id IS NULL) OR
        (user_type = 'staff' AND role IN ('crm_manager','team_leader','agent') AND employee_id IS NOT NULL) OR
        (user_type = 'customer' AND role = 'customer' AND employee_id IS NULL)),
      CONSTRAINT crm_users_role_fk FOREIGN KEY (role) REFERENCES roles(code),
      CONSTRAINT crm_users_employee_fk FOREIGN KEY (employee_id) REFERENCES employee_references(employee_id),
      CONSTRAINT crm_users_team_fk FOREIGN KEY (team_id) REFERENCES crm_teams(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `ALTER TABLE crm_teams
      ADD CONSTRAINT crm_teams_leader_fk FOREIGN KEY (team_leader_id) REFERENCES crm_users(id) ON DELETE SET NULL,
      ADD CONSTRAINT crm_teams_manager_fk FOREIGN KEY (manager_id) REFERENCES crm_users(id) ON DELETE SET NULL`,
    `CREATE TABLE customer_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL UNIQUE,
      user_id INT NOT NULL UNIQUE,
      status ENUM('pending_verification','active','suspended','closed') NOT NULL DEFAULT 'active',
      registered_via ENUM('portal','in_store','staff') NOT NULL DEFAULT 'portal',
      terms_accepted_at DATETIME NULL,
      ${TS},
      CONSTRAINT customer_accounts_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
      CONSTRAINT customer_accounts_user_fk FOREIGN KEY (user_id) REFERENCES crm_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE email_verification_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE COMMENT 'SHA-256 of the token; the raw token is never stored',
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT email_tokens_user_fk FOREIGN KEY (user_id) REFERENCES crm_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE agent_assignments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      agent_id INT NOT NULL,
      assigned_by INT NULL,
      assigned_at DATETIME NOT NULL,
      ended_at DATETIME NULL,
      note VARCHAR(255) NULL,
      INDEX agent_assignments_active_idx (agent_id, ended_at),
      INDEX agent_assignments_customer_idx (customer_id, ended_at),
      CONSTRAINT agent_assignments_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
      CONSTRAINT agent_assignments_agent_fk FOREIGN KEY (agent_id) REFERENCES crm_users(id),
      CONSTRAINT agent_assignments_by_fk FOREIGN KEY (assigned_by) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE customer_interactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      crm_user_id INT NULL,
      interaction_type ENUM('call','visit','sms','email','chat','portal','note') NOT NULL,
      direction ENUM('inbound','outbound','internal') NOT NULL,
      subject VARCHAR(150) NOT NULL,
      summary TEXT NULL,
      related_type ENUM('case','inquiry','order','sale','follow_up','campaign') NULL,
      related_id INT NULL,
      occurred_at DATETIME NOT NULL,
      is_demo TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX customer_interactions_customer_idx (customer_id, occurred_at),
      CONSTRAINT customer_interactions_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
      CONSTRAINT customer_interactions_user_fk FOREIGN KEY (crm_user_id) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `ALTER TABLE crm_settings ADD CONSTRAINT crm_settings_user_fk FOREIGN KEY (updated_by) REFERENCES crm_users(id) ON DELETE SET NULL`,
    `ALTER TABLE customers ADD CONSTRAINT customers_created_by_fk FOREIGN KEY (created_by) REFERENCES crm_users(id) ON DELETE SET NULL`,
    `ALTER TABLE customer_consents ADD CONSTRAINT customer_consents_user_fk FOREIGN KEY (recorded_by) REFERENCES crm_users(id) ON DELETE SET NULL`,
  ]);
};

export const down = async ({ sequelize }) => {
  await dropForeignKeyIfExists(sequelize, "customer_consents", "customer_consents_user_fk");
  await dropForeignKeyIfExists(sequelize, "customers", "customers_created_by_fk");
  await dropForeignKeyIfExists(sequelize, "crm_settings", "crm_settings_user_fk");
  await dropTables(sequelize, [
    "customer_interactions", "agent_assignments", "email_verification_tokens", "customer_accounts", "crm_users", "crm_teams",
  ]);
};
