import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// 1–5 rating for a resolved case (or, from P5, a completed order). One rating per case/order.
export const CustomerRating = sequelize.define("CustomerRating", {
  customer_id: { type: DataTypes.INTEGER, allowNull: false },
  subject_type: { type: DataTypes.ENUM("case", "order"), allowNull: false },
  case_id: { type: DataTypes.INTEGER, allowNull: true, unique: true },
  sales_order_id: { type: DataTypes.INTEGER, allowNull: true, unique: true },
  rating: { type: DataTypes.TINYINT, allowNull: false },
  is_demo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, { tableName: "customer_ratings", underscored: true, updatedAt: false });
