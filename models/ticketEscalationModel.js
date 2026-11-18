import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// One step of the escalation chain: Agent (0) -> Team Leader (1) -> CRM Manager (2).
// Table name follows the CRM master prompt (ticket_escalations); it belongs to customer_cases.
export const TicketEscalation = sequelize.define("TicketEscalation", {
  case_id: { type: DataTypes.INTEGER, allowNull: false },
  from_level: { type: DataTypes.TINYINT, allowNull: false },
  to_level: { type: DataTypes.TINYINT, allowNull: false },
  escalated_by: { type: DataTypes.INTEGER, allowNull: false },
  escalated_to: { type: DataTypes.INTEGER, allowNull: true },
  reason: { type: DataTypes.STRING(255), allowNull: false },
  outcome: { type: DataTypes.ENUM("pending", "handled", "returned", "escalated"), allowNull: false, defaultValue: "pending" },
  handled_by: { type: DataTypes.INTEGER, allowNull: true },
  handled_at: { type: DataTypes.DATE, allowNull: true },
  handling_note: { type: DataTypes.STRING(255), allowNull: true },
}, { tableName: "ticket_escalations", underscored: true, updatedAt: false });
