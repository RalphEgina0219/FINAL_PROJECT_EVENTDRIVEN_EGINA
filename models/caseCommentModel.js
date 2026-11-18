import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// Reply on a case. "internal" comments are staff-only notes and are never returned to customers.
export const CaseComment = sequelize.define("CaseComment", {
  case_id: { type: DataTypes.INTEGER, allowNull: false },
  author_id: { type: DataTypes.INTEGER, allowNull: false },
  visibility: { type: DataTypes.ENUM("public", "internal"), allowNull: false, defaultValue: "public" },
  body: { type: DataTypes.TEXT, allowNull: false },
}, { tableName: "case_comments", underscored: true });
