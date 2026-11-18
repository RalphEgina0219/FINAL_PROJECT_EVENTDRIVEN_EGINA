import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// Written feedback from a customer, optionally attached to a rating, case or order.
export const CustomerFeedback = sequelize.define("CustomerFeedback", {
  customer_id: { type: DataTypes.INTEGER, allowNull: false },
  rating_id: { type: DataTypes.INTEGER, allowNull: true, unique: true },
  case_id: { type: DataTypes.INTEGER, allowNull: true },
  sales_order_id: { type: DataTypes.INTEGER, allowNull: true },
  feedback_type: { type: DataTypes.ENUM("service", "product", "store", "suggestion", "compliment", "other"), allowNull: false, defaultValue: "service" },
  comment: { type: DataTypes.TEXT, allowNull: false },
  status: { type: DataTypes.ENUM("new", "reviewed", "actioned"), allowNull: false, defaultValue: "new" },
  reviewed_by: { type: DataTypes.INTEGER, allowNull: true },
  reviewed_at: { type: DataTypes.DATE, allowNull: true },
  is_demo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, { tableName: "customer_feedback", underscored: true, updatedAt: false });
