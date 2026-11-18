/*
 * 106 — product_references (Inventory snapshot), campaigns, promotions, discounts
 * Inventory owns products, prices and stock (blueprint §8, master prompt §IV). product_references
 * is a read-only cache written only by the Inventory adapter; CRM screens never edit price or stock.
 */
import { run, dropTables, TS } from "./_sql.js";

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE product_references (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id VARCHAR(64) NOT NULL UNIQUE COMMENT 'Inventory stable ID',
      sku VARCHAR(64) NOT NULL UNIQUE,
      barcode VARCHAR(64) NULL,
      name VARCHAR(200) NOT NULL,
      description TEXT NULL,
      category_name VARCHAR(120) NULL,
      unit VARCHAR(30) NULL,
      image_url VARCHAR(500) NULL,
      selling_price DECIMAL(12,2) NOT NULL COMMENT 'owned by Inventory; CRM never edits it',
      is_vatable TINYINT(1) NOT NULL DEFAULT 1,
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      available_qty DECIMAL(12,3) NULL COMMENT 'last availability answer from Inventory',
      availability_checked_at DATETIME NULL,
      low_stock TINYINT(1) NOT NULL DEFAULT 0,
      source VARCHAR(40) NOT NULL DEFAULT 'johnvivz_inventory',
      source_version VARCHAR(40) NULL,
      is_mock TINYINT(1) NOT NULL DEFAULT 0,
      last_synced_at DATETIME NOT NULL,
      INDEX product_references_name_idx (name),
      INDEX product_references_category_idx (category_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE campaigns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      campaign_code VARCHAR(20) NOT NULL UNIQUE,
      name VARCHAR(120) NOT NULL,
      description TEXT NULL,
      channel ENUM('in_store','sms','email','social','portal','mixed') NOT NULL,
      target_segment_id INT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status ENUM('draft','active','ended','cancelled') NOT NULL DEFAULT 'draft',
      created_by INT NULL,
      is_demo TINYINT(1) NOT NULL DEFAULT 0,
      ${TS},
      CONSTRAINT campaigns_dates_chk CHECK (end_date >= start_date),
      CONSTRAINT campaigns_segment_fk FOREIGN KEY (target_segment_id) REFERENCES customer_segments(id) ON DELETE SET NULL,
      CONSTRAINT campaigns_user_fk FOREIGN KEY (created_by) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE promotions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      promo_code VARCHAR(30) NOT NULL UNIQUE,
      campaign_id INT NULL,
      name VARCHAR(120) NOT NULL,
      promo_type ENUM('percent','fixed_amount') NOT NULL,
      value DECIMAL(12,2) NOT NULL,
      min_order_amount DECIMAL(12,2) NULL,
      applies_to ENUM('order','product','category') NOT NULL DEFAULT 'order',
      product_id VARCHAR(64) NULL,
      category_name VARCHAR(120) NULL,
      start_at DATETIME NOT NULL,
      end_at DATETIME NOT NULL,
      usage_limit INT NULL,
      status ENUM('draft','pending_approval','active','expired','cancelled') NOT NULL DEFAULT 'draft',
      created_by INT NULL,
      approved_by INT NULL COMMENT 'must differ from created_by',
      approved_at DATETIME NULL,
      is_demo TINYINT(1) NOT NULL DEFAULT 0,
      ${TS},
      CONSTRAINT promotions_value_chk CHECK (value > 0),
      CONSTRAINT promotions_dates_chk CHECK (end_at > start_at),
      CONSTRAINT promotions_self_approval_chk CHECK (approved_by IS NULL OR approved_by <> created_by),
      CONSTRAINT promotions_campaign_fk FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
      CONSTRAINT promotions_created_by_fk FOREIGN KEY (created_by) REFERENCES crm_users(id),
      CONSTRAINT promotions_approved_by_fk FOREIGN KEY (approved_by) REFERENCES crm_users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE discounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      discount_code VARCHAR(30) NOT NULL UNIQUE,
      name VARCHAR(120) NOT NULL,
      discount_type ENUM('senior_citizen','pwd','loyalty','manual') NOT NULL,
      percent DECIMAL(5,2) NULL,
      amount DECIMAL(12,2) NULL,
      requires_approval TINYINT(1) NOT NULL DEFAULT 0,
      requires_id_reference TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'SC/PWD ID number captured on the order',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      ${TS},
      CONSTRAINT discounts_value_chk CHECK ((percent IS NOT NULL) <> (amount IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]);
};

export const down = async ({ sequelize }) => dropTables(sequelize, ["discounts", "promotions", "campaigns", "product_references"]);
