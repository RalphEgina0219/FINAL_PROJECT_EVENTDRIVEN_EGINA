/*
 * 112 — crm_audit_logs (blueprint §11, supplement E) — append-only
 * Records actor, role, action, record, reason and before/after values. Two triggers reject every
 * UPDATE and DELETE, so rows cannot be changed from the app or from SQL.
 * Production hardening (run by the DBA): give the app account only SELECT, INSERT on this table:
 *   GRANT SELECT, INSERT ON johnvivz_crm_db.crm_audit_logs TO 'crm_app'@'%';
 */
import { run, dropTables } from "./_sql.js";

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE crm_audit_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      actor_user_id INT NULL COMMENT 'NULL = system job or integration',
      actor_role VARCHAR(30) NULL,
      action VARCHAR(60) NOT NULL,
      outcome ENUM('success','denied','failed') NOT NULL DEFAULT 'success',
      record_type VARCHAR(40) NULL,
      record_id VARCHAR(64) NULL,
      reason VARCHAR(255) NULL,
      details VARCHAR(500) NULL,
      before_values JSON NULL,
      after_values JSON NULL,
      ip_address VARCHAR(45) NULL,
      correlation_id CHAR(36) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX crm_audit_logs_created_idx (created_at),
      INDEX crm_audit_logs_record_idx (record_type, record_id),
      INDEX crm_audit_logs_actor_idx (actor_user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TRIGGER crm_audit_logs_block_update BEFORE UPDATE ON crm_audit_logs
     FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_audit_logs is append-only'`,
    `CREATE TRIGGER crm_audit_logs_block_delete BEFORE DELETE ON crm_audit_logs
     FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_audit_logs is append-only'`,
  ]);
};

// Dropping the table also drops its triggers (rollback only; never done in normal operation).
export const down = async ({ sequelize }) => dropTables(sequelize, ["crm_audit_logs"]);
