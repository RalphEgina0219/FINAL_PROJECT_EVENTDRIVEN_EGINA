/*
 * 103 — department_references, position_references, employee_references
 * Read-only snapshots of HR data (blueprint §5, §7: "CRM consumes HR employee/department references").
 * HR is the source of truth. CRM never edits these rows from its own screens; they are written only
 * by the HR adapter (mock fixture in mock mode, HR events/API in live mode).
 * No salary, bank, government ID or payroll data is stored (master prompt §VIII).
 */
import { run, dropTables } from "./_sql.js";

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE department_references (
      id INT AUTO_INCREMENT PRIMARY KEY,
      department_id VARCHAR(64) NOT NULL UNIQUE COMMENT 'HR stable ID',
      code VARCHAR(30) NULL,
      name VARCHAR(120) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      source VARCHAR(40) NOT NULL DEFAULT 'johnvivz_hr',
      source_version VARCHAR(40) NULL,
      is_mock TINYINT(1) NOT NULL DEFAULT 0,
      last_synced_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE position_references (
      id INT AUTO_INCREMENT PRIMARY KEY,
      position_id VARCHAR(64) NOT NULL UNIQUE COMMENT 'HR stable ID',
      department_id VARCHAR(64) NULL,
      title VARCHAR(120) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      source VARCHAR(40) NOT NULL DEFAULT 'johnvivz_hr',
      source_version VARCHAR(40) NULL,
      is_mock TINYINT(1) NOT NULL DEFAULT 0,
      last_synced_at DATETIME NOT NULL,
      INDEX position_references_department_idx (department_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE employee_references (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id VARCHAR(64) NOT NULL UNIQUE COMMENT 'HR stable ID',
      full_name VARCHAR(150) NOT NULL,
      work_email VARCHAR(254) NULL,
      department_id VARCHAR(64) NULL,
      position_id VARCHAR(64) NULL,
      employment_status ENUM('active','on_leave','inactive','separated') NOT NULL,
      supervisor_employee_id VARCHAR(64) NULL COMMENT 'immediate supervisor, used for ESS approval routing',
      source VARCHAR(40) NOT NULL DEFAULT 'johnvivz_hr',
      source_version VARCHAR(40) NULL,
      is_mock TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = record from the mock HR fixture, never real HR data',
      last_synced_at DATETIME NOT NULL,
      INDEX employee_references_status_idx (employment_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]);
};

export const down = async ({ sequelize }) =>
  dropTables(sequelize, ["employee_references", "position_references", "department_references"]);
