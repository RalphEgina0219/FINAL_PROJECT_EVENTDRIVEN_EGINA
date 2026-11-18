/*
 * 110 — integration_outbox, integration_inbox, integration_logs (blueprint §13, master prompt §XI)
 * Outbox: events CRM publishes (blueprint names: OrderConfirmed, SaleCompleted, SaleCancelled,
 *         RefundRecorded), one row per target, delivered with retries and backoff; after the last
 *         attempt the row becomes 'dead' and shows on Integration Health for manual retry.
 * Inbox:  events CRM receives; event_id is UNIQUE so a duplicate delivery is never processed twice.
 */
import { run, dropTables } from "./_sql.js";

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE integration_outbox (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      event_id CHAR(36) NOT NULL UNIQUE,
      event_type VARCHAR(60) NOT NULL,
      schema_version INT NOT NULL DEFAULT 1,
      source VARCHAR(40) NOT NULL DEFAULT 'johnvivz_crm',
      target VARCHAR(40) NOT NULL COMMENT 'johnvivz_inventory | johnvivz_accounting | johnvivz_hr',
      occurred_at DATETIME(3) NOT NULL,
      entity_id VARCHAR(64) NOT NULL,
      correlation_id CHAR(36) NOT NULL,
      idempotency_key VARCHAR(160) NOT NULL,
      payload JSON NOT NULL COMMENT 'full envelope as sent',
      status ENUM('pending','sent','failed','dead','skipped_disabled','mock_delivered') NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at DATETIME NULL,
      last_error VARCHAR(500) NULL,
      sent_at DATETIME NULL,
      is_mock TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY integration_outbox_idem_unique (target, idempotency_key),
      INDEX integration_outbox_dispatch_idx (status, next_attempt_at),
      INDEX integration_outbox_corr_idx (correlation_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE integration_inbox (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      event_id CHAR(36) NOT NULL UNIQUE COMMENT 'duplicates are rejected here',
      event_type VARCHAR(60) NOT NULL,
      schema_version INT NOT NULL,
      source VARCHAR(40) NOT NULL,
      occurred_at DATETIME(3) NOT NULL,
      entity_id VARCHAR(64) NOT NULL,
      correlation_id CHAR(36) NULL,
      idempotency_key VARCHAR(160) NOT NULL,
      payload JSON NOT NULL,
      status ENUM('received','processed','failed','dead','ignored') NOT NULL DEFAULT 'received',
      attempts INT NOT NULL DEFAULT 0,
      last_error VARCHAR(500) NULL,
      is_mock TINYINT(1) NOT NULL DEFAULT 0,
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME NULL,
      UNIQUE KEY integration_inbox_idem_unique (source, idempotency_key),
      INDEX integration_inbox_status_idx (status, received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE integration_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      direction ENUM('outbound_event','inbound_event','api_call','api_served','sync') NOT NULL,
      \`system\` VARCHAR(40) NOT NULL COMMENT 'johnvivz_inventory, johnvivz_hr, johnvivz_accounting',
      endpoint VARCHAR(255) NULL,
      http_method VARCHAR(10) NULL,
      event_id CHAR(36) NULL,
      correlation_id CHAR(36) NULL,
      http_status SMALLINT NULL,
      duration_ms INT NULL,
      success TINYINT(1) NOT NULL,
      mode ENUM('disabled','mock','live') NOT NULL,
      message VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX integration_logs_created_idx (created_at),
      INDEX integration_logs_corr_idx (correlation_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]);
};

export const down = async ({ sequelize }) => dropTables(sequelize, ["integration_logs", "integration_inbox", "integration_outbox"]);
