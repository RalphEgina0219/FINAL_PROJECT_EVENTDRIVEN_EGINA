/*
 * 117 — P6 integration. NO existing table is changed; two tables are created and one permission is added.
 *
 *   integration_request_nonces   replay guard for the signed inbound API. The signature of every accepted request is stored; the same
 *                                signature inside the 5-minute window is refused (401). Rows older than twice the window are purged.
 *   integration_compensations    work that must still happen after a checkout step failed: give a stock reservation back to Inventory
 *                                (kind release_reservation) or find out what happened to a reservation whose answer never arrived
 *                                (kind resolve_reservation). Retried with the same increasing delays as the outbox, then `dead`.
 *   permission integration.manage  retry/dispatch actions on Integration Health (CRM Manager and the setup System Administrator).
 *                                integration.view already exists (migration 102).
 */
import { run, dropTables } from "./_sql.js";

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE integration_request_nonces (
      signature CHAR(64) NOT NULL PRIMARY KEY COMMENT 'hex HMAC of an accepted request',
      client VARCHAR(40) NOT NULL,
      received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX integration_nonces_received_idx (received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE integration_compensations (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      kind ENUM('release_reservation','resolve_reservation') NOT NULL,
      \`system\` VARCHAR(40) NOT NULL DEFAULT 'johnvivz_inventory',
      order_id CHAR(36) NOT NULL,
      reservation_ref VARCHAR(64) NULL,
      correlation_id CHAR(36) NULL,
      lines_json JSON NULL COMMENT 'order lines, kept for resolve_reservation',
      reason VARCHAR(200) NULL,
      status ENUM('pending','done','dead') NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at DATETIME NULL,
      last_error VARCHAR(500) NULL,
      is_mock TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      done_at DATETIME NULL,
      UNIQUE KEY integration_compensations_uq (kind, order_id),
      INDEX integration_compensations_due_idx (status, next_attempt_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]);
  await sequelize.query("INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)", {
    replacements: ["integration.manage", "settings", "Integration Health actions: send pending events, retry dead letters, test a connection"],
  });
  await sequelize.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'integration.manage' WHERE r.code IN ('crm_manager', 'system_admin')`
  );
};

export const down = async ({ sequelize }) => {
  await sequelize.query("DELETE FROM permissions WHERE code = 'integration.manage'");
  await dropTables(sequelize, ["integration_compensations", "integration_request_nonces"]);
};
