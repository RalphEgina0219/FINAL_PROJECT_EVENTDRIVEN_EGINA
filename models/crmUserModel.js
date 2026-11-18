import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// Every login: setup System Administrator, CRM staff (linked to an HR employee) and customers.
// Table crm_users (blueprint supplement E). Schema changes go through migrations only.
export const ROLES = ["system_admin", "crm_manager", "team_leader", "agent", "customer"];
export const STAFF_ROLES = ["crm_manager", "team_leader", "agent"];

export const CrmUser = sequelize.define("CrmUser", {
  user_type: { type: DataTypes.ENUM("system", "staff", "customer"), allowNull: false },
  role: { type: DataTypes.STRING(30), allowNull: false },
  role_source: { type: DataTypes.ENUM("position_rule", "manager"), allowNull: true },
  employee_id: { type: DataTypes.STRING(64), allowNull: true, unique: true },
  email: { type: DataTypes.STRING(254), allowNull: false, unique: true },
  password_hash: { type: DataTypes.STRING(255), allowNull: true }, // NULL: HR staff who sign in through ESS (migration 121)
  login_via: { type: DataTypes.ENUM("local", "ess"), allowNull: false, defaultValue: "local" },
  ess_activated_at: { type: DataTypes.DATE, allowNull: true },
  display_name: { type: DataTypes.STRING(150), allowNull: false },
  team_id: { type: DataTypes.INTEGER, allowNull: true },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  is_available: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  email_verified_at: { type: DataTypes.DATE, allowNull: true },
  last_login_at: { type: DataTypes.DATE, allowNull: true },
  access_revoked_at: { type: DataTypes.DATE, allowNull: true },
  access_revoked_reason: { type: DataTypes.STRING(255), allowNull: true },
  is_demo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, { tableName: "crm_users", underscored: true });
