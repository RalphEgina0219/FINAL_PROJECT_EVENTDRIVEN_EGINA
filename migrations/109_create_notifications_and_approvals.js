/*
 * 109 — crm_notifications (blueprint name) and approval_requests (master prompt name)
 * approval_requests: leave / attendance correction / overtime requests routed from HR/ESS to CRM
 * approvers (Agent -> Team Leader -> CRM Manager; Team Leader -> CRM Manager). Data model only;
 * the queue is behind APPROVALS_ENABLED=false until the HR/ESS contract is confirmed.
 * HR stays the owner of leave and attendance records; CRM only records the decision and publishes it.
 */
import { run, dropTables } from "./_sql.js";

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE crm_notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      type ENUM('new_case','assignment','new_reply','status_change','resolved','sla_overdue','escalation',
                'feedback','order','follow_up','approval','integration','account') NOT NULL,
      title VARCHAR(150) NOT NULL,
      message VARCHAR(255) NULL,
      link VARCHAR(255) NULL,
      related_type VARCHAR(30) NULL,
      related_id INT NULL,
      read_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX crm_notifications_user_idx (user_id, read_at),
      INDEX crm_notifications_related_idx (related_type, related_id),
      CONSTRAINT crm_notifications_user_fk FOREIGN KEY (user_id) REFERENCES crm_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE approval_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      request_id VARCHAR(64) NOT NULL UNIQUE COMMENT 'HR/ESS request ID',
      request_type ENUM('leave','attendance_correction','overtime','other') NOT NULL,
      requester_employee_id VARCHAR(64) NOT NULL,
      requester_user_id INT NULL,
      approver_user_id INT NULL COMMENT 'resolved CRM approver; NULL with status exception',
      approver_role VARCHAR(30) NULL,
      status ENUM('pending','approved','rejected','returned','exception') NOT NULL DEFAULT 'pending',
      exception_reason VARCHAR(255) NULL,
      summary VARCHAR(255) NOT NULL,
      payload JSON NOT NULL COMMENT 'dates/hours/reason exactly as sent by HR/ESS',
      decided_by INT NULL,
      decided_at DATETIME NULL,
      decision_reason VARCHAR(255) NULL,
      source_event_id CHAR(36) NULL,
      decision_event_id CHAR(36) NULL COMMENT 'outbox event sent back to HR',
      is_mock TINYINT(1) NOT NULL DEFAULT 0,
      received_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX approval_requests_queue_idx (approver_user_id, status),
      CONSTRAINT approval_requests_no_self_chk CHECK (decided_by IS NULL OR requester_user_id IS NULL OR decided_by <> requester_user_id),
      CONSTRAINT approval_requests_requester_fk FOREIGN KEY (requester_user_id) REFERENCES crm_users(id),
      CONSTRAINT approval_requests_approver_fk FOREIGN KEY (approver_user_id) REFERENCES crm_users(id) ON DELETE SET NULL,
      CONSTRAINT approval_requests_decider_fk FOREIGN KEY (decided_by) REFERENCES crm_users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]);
};

export const down = async ({ sequelize }) => dropTables(sequelize, ["approval_requests", "crm_notifications"]);
