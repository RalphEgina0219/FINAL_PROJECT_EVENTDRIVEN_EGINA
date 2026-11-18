import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const CaseCategory = sequelize.define("CaseCategory", {
  name: { type: DataTypes.STRING(80), allowNull: false, unique: true },
  description: { type: DataTypes.STRING(255), allowNull: true },
  default_priority: { type: DataTypes.ENUM("low", "medium", "high", "urgent"), allowNull: false, defaultValue: "medium" },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, { tableName: "case_categories", underscored: true });
