import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const CrmTeam = sequelize.define("CrmTeam", {
  team_code: { type: DataTypes.STRING(20), allowNull: false, unique: true },
  name: { type: DataTypes.STRING(100), allowNull: false },
  team_leader_id: { type: DataTypes.INTEGER, allowNull: true },
  manager_id: { type: DataTypes.INTEGER, allowNull: true },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, { tableName: "crm_teams", underscored: true });
