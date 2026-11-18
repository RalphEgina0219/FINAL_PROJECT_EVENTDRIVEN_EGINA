/*
 * 101 — number_sequences and crm_settings  [CRM-LOCAL]
 * number_sequences: counters for human-readable numbers (JVT- cases, INQ-, SO-, SALE-, RFD- daily;
 *                   CUS- customers running). period = 'YYYYMMDD' for daily, 'ALL' for running numbers.
 * crm_settings:     CRM rules edited by the CRM Manager (auto-close days, reopen window).
 */
import { run, dropTables } from "./_sql.js";
import { config } from "../config/index.js";

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE number_sequences (
      scope VARCHAR(20) NOT NULL,
      period VARCHAR(8) NOT NULL,
      last_no INT NOT NULL DEFAULT 0,
      PRIMARY KEY (scope, period)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE crm_settings (
      setting_key VARCHAR(60) NOT NULL PRIMARY KEY,
      setting_value VARCHAR(255) NOT NULL,
      description VARCHAR(255) NULL,
      updated_by INT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]);
  await sequelize.query(
    `INSERT INTO crm_settings (setting_key, setting_value, description) VALUES
      ('auto_close_days', ?, 'Days a Resolved case waits for the customer before it is closed automatically'),
      ('reopen_window_days', ?, 'Days after resolution during which a case can be reopened')`,
    { replacements: [String(config.cases.autoCloseDays), String(config.cases.reopenWindowDays)] }
  );
};

export const down = async ({ sequelize }) => dropTables(sequelize, ["crm_settings", "number_sequences"]);
