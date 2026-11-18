import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// Links a customer master record to its portal login (crm_users row with role customer).
export const CustomerAccount = sequelize.define("CustomerAccount", {
  customer_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  user_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  status: { type: DataTypes.ENUM("pending_verification", "active", "suspended", "closed"), allowNull: false, defaultValue: "active" },
  registered_via: { type: DataTypes.ENUM("portal", "in_store", "staff"), allowNull: false, defaultValue: "portal" },
  terms_accepted_at: { type: DataTypes.DATE, allowNull: true },
}, { tableName: "customer_accounts", underscored: true });
