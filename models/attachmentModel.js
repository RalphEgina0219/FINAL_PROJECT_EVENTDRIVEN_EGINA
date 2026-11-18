import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// Uploaded file metadata. Files are stored outside public/ and served through an authorized route.
export const Attachment = sequelize.define("Attachment", {
  entity_type: { type: DataTypes.ENUM("case", "case_comment", "inquiry", "customer", "sales_order", "refund"), allowNull: false },
  entity_id: { type: DataTypes.INTEGER, allowNull: false },
  case_id: { type: DataTypes.INTEGER, allowNull: true },
  uploaded_by: { type: DataTypes.INTEGER, allowNull: false },
  original_name: { type: DataTypes.STRING(200), allowNull: false },
  stored_name: { type: DataTypes.STRING(80), allowNull: false, unique: true },
  mime_type: { type: DataTypes.STRING(120), allowNull: false },
  size_bytes: { type: DataTypes.INTEGER, allowNull: false },
  visibility: { type: DataTypes.ENUM("public", "internal"), allowNull: false, defaultValue: "public" },
}, { tableName: "attachments", underscored: true, updatedAt: false });
