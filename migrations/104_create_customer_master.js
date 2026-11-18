/*
 * 104 — customer master (CRM is the owner; blueprint §7, supplement E "Customer master")
 * customer_segments (master prompt §XI), customers, customer_contacts, customer_addresses,
 * customer_preferences, customer_consents.
 * customers.customer_id is the shared UUID used by Inventory and Accounting; it never changes.
 * Walk-in customers can exist without a portal login (see customer_accounts in 105).
 */
import { run, dropTables, TS } from "./_sql.js";

const SEGMENTS = [
  ["new", "New", "First purchase or registration in the last 30 days"],
  ["regular", "Regular", "Purchased in at least 2 of the last 3 months"],
  ["loyal", "Loyal", "Repeat customer with 6 or more completed sales in 6 months"],
  ["at_risk", "At risk", "Regular customer with no purchase in the last 60 days"],
  ["inactive", "Inactive", "No purchase or interaction in the last 180 days"],
];

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE customer_segments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(30) NOT NULL UNIQUE,
      name VARCHAR(60) NOT NULL,
      rule_description VARCHAR(255) NOT NULL COMMENT 'rule-based segmentation (no AI/ML)',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      ${TS}
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id CHAR(36) NOT NULL UNIQUE COMMENT 'shared UUID (Inventory, Accounting); never changes',
      customer_no VARCHAR(20) NOT NULL UNIQUE COMMENT 'CUS-000001',
      first_name VARCHAR(80) NOT NULL,
      last_name VARCHAR(80) NOT NULL,
      email VARCHAR(254) NULL,
      mobile VARCHAR(30) NULL,
      normalized_email VARCHAR(254) NULL COMMENT 'lower(trim(email)) for duplicate checks',
      normalized_mobile VARCHAR(20) NULL COMMENT 'digits only, 09XXXXXXXXX',
      customer_type ENUM('individual','business') NOT NULL DEFAULT 'individual',
      source ENUM('walk_in','portal','phone','social','referral','other') NOT NULL DEFAULT 'walk_in',
      segment_id INT NULL,
      status ENUM('active','inactive','merged') NOT NULL DEFAULT 'active',
      merged_into_id INT NULL,
      notes TEXT NULL,
      created_by INT NULL,
      is_demo TINYINT(1) NOT NULL DEFAULT 0,
      ${TS},
      INDEX customers_email_idx (normalized_email),
      INDEX customers_mobile_idx (normalized_mobile),
      INDEX customers_name_idx (last_name, first_name),
      CONSTRAINT customers_segment_fk FOREIGN KEY (segment_id) REFERENCES customer_segments(id) ON DELETE SET NULL,
      CONSTRAINT customers_merged_fk FOREIGN KEY (merged_into_id) REFERENCES customers(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE customer_contacts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      contact_type ENUM('mobile','landline','email','messenger','other') NOT NULL,
      value VARCHAR(254) NOT NULL,
      is_primary TINYINT(1) NOT NULL DEFAULT 0,
      verified_at DATETIME NULL,
      ${TS},
      INDEX customer_contacts_customer_idx (customer_id),
      CONSTRAINT customer_contacts_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE customer_addresses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      label VARCHAR(40) NULL,
      line1 VARCHAR(200) NOT NULL,
      barangay VARCHAR(100) NULL,
      city_municipality VARCHAR(100) NULL,
      province VARCHAR(100) NULL,
      postal_code VARCHAR(10) NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      ${TS},
      INDEX customer_addresses_customer_idx (customer_id),
      CONSTRAINT customer_addresses_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE customer_preferences (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      preference_key VARCHAR(60) NOT NULL COMMENT 'preferred_channel, preferred_branch, language, ...',
      preference_value VARCHAR(255) NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY customer_preferences_unique (customer_id, preference_key),
      CONSTRAINT customer_preferences_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE customer_consents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      consent_type ENUM('data_privacy','terms','marketing_sms','marketing_email') NOT NULL,
      granted TINYINT(1) NOT NULL,
      policy_version VARCHAR(20) NOT NULL,
      channel ENUM('portal','in_store','phone','paper') NOT NULL,
      recorded_by INT NULL,
      granted_at DATETIME NULL,
      withdrawn_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX customer_consents_idx (customer_id, consent_type),
      CONSTRAINT customer_consents_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]);
  for (const [code, name, rule] of SEGMENTS) {
    await sequelize.query("INSERT INTO customer_segments (code, name, rule_description) VALUES (?, ?, ?)", { replacements: [code, name, rule] });
  }
};

export const down = async ({ sequelize }) =>
  dropTables(sequelize, ["customer_consents", "customer_preferences", "customer_addresses", "customer_contacts", "customers", "customer_segments"]);
