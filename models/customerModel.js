import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// Customer master record (CRM owns it). customer_id is the shared UUID; customer_no is CUS-000001.
export const Customer = sequelize.define("Customer", {
  customer_id: { type: DataTypes.CHAR(36), allowNull: false, unique: true },
  customer_no: { type: DataTypes.STRING(20), allowNull: false, unique: true },
  first_name: { type: DataTypes.STRING(80), allowNull: false },
  last_name: { type: DataTypes.STRING(80), allowNull: false },
  email: { type: DataTypes.STRING(254), allowNull: true },
  mobile: { type: DataTypes.STRING(30), allowNull: true },
  normalized_email: { type: DataTypes.STRING(254), allowNull: true },
  normalized_mobile: { type: DataTypes.STRING(20), allowNull: true },
  customer_type: { type: DataTypes.ENUM("individual", "business"), allowNull: false, defaultValue: "individual" },
  source: { type: DataTypes.ENUM("walk_in", "portal", "phone", "social", "referral", "other"), allowNull: false, defaultValue: "walk_in" },
  segment_id: { type: DataTypes.INTEGER, allowNull: true },
  status: { type: DataTypes.ENUM("active", "inactive", "merged"), allowNull: false, defaultValue: "active" },
  merged_into_id: { type: DataTypes.INTEGER, allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  created_by: { type: DataTypes.INTEGER, allowNull: true },
  is_demo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, { tableName: "customers", underscored: true });
