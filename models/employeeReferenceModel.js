import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// Read-only snapshot of an HR employee. Written only by the HR adapter (mock fixture or HR events).
export const EMPLOYMENT_STATUSES = ["active", "on_leave", "inactive", "separated"];
export const ACCESS_BLOCKING_STATUSES = ["inactive", "separated"];

export const EmployeeReference = sequelize.define("EmployeeReference", {
  employee_id: { type: DataTypes.STRING(64), allowNull: false, unique: true },
  full_name: { type: DataTypes.STRING(150), allowNull: false },
  work_email: { type: DataTypes.STRING(254), allowNull: true },
  department_id: { type: DataTypes.STRING(64), allowNull: true },
  position_id: { type: DataTypes.STRING(64), allowNull: true },
  employment_status: { type: DataTypes.ENUM(...EMPLOYMENT_STATUSES), allowNull: false },
  supervisor_employee_id: { type: DataTypes.STRING(64), allowNull: true },
  source: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "johnvivz_hr" },
  source_version: { type: DataTypes.STRING(40), allowNull: true },
  is_mock: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  last_synced_at: { type: DataTypes.DATE, allowNull: false },
}, { tableName: "employee_references", timestamps: false });
