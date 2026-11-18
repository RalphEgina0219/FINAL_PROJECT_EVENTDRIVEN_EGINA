import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const CaseStatusHistory = sequelize.define("CaseStatusHistory", {
  case_id: { type: DataTypes.INTEGER, allowNull: false },
  changed_by: { type: DataTypes.INTEGER, allowNull: true },
  field: { type: DataTypes.ENUM("created", "status", "priority", "category", "assignment", "escalation"), allowNull: false },
  old_value: { type: DataTypes.STRING(120), allowNull: true },
  new_value: { type: DataTypes.STRING(120), allowNull: true },
  note: { type: DataTypes.STRING(255), allowNull: true },
}, { tableName: "case_status_history", underscored: true, updatedAt: false });
