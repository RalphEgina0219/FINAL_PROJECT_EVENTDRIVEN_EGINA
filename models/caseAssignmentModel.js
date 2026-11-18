import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const CaseAssignment = sequelize.define("CaseAssignment", {
  case_id: { type: DataTypes.INTEGER, allowNull: false },
  agent_id: { type: DataTypes.INTEGER, allowNull: false },
  team_id: { type: DataTypes.INTEGER, allowNull: true },
  assigned_by: { type: DataTypes.INTEGER, allowNull: true },
  assigned_at: { type: DataTypes.DATE, allowNull: false },
  unassigned_at: { type: DataTypes.DATE, allowNull: true },
  note: { type: DataTypes.STRING(255), allowNull: true },
}, { tableName: "case_assignments", timestamps: false });
