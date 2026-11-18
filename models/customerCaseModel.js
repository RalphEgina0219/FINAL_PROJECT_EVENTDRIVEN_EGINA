import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// Customer service case (blueprint: customer_cases). Status flow is enforced in services/caseService.js.
export const CASE_STATUSES = ["open", "assigned", "in_progress", "waiting_for_customer", "escalated", "resolved", "closed"];
export const ACTIVE_CASE_STATUSES = ["open", "assigned", "in_progress", "waiting_for_customer", "escalated"];
export const CASE_PRIORITIES = ["low", "medium", "high", "urgent"];
export const CASE_TYPES = ["complaint", "service_request", "inquiry", "feedback"];
export const CASE_CHANNELS = ["portal", "phone", "walk_in", "sms", "social", "email"];

export const CustomerCase = sequelize.define("CustomerCase", {
  case_no: { type: DataTypes.STRING(24), allowNull: false, unique: true },
  customer_id: { type: DataTypes.INTEGER, allowNull: false },
  case_type: { type: DataTypes.ENUM(...CASE_TYPES), allowNull: false },
  category_id: { type: DataTypes.INTEGER, allowNull: false },
  subject: { type: DataTypes.STRING(150), allowNull: false },
  description: { type: DataTypes.TEXT, allowNull: false },
  priority: { type: DataTypes.ENUM(...CASE_PRIORITIES), allowNull: false, defaultValue: "medium" },
  status: { type: DataTypes.ENUM(...CASE_STATUSES), allowNull: false, defaultValue: "open" },
  escalation_level: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
  channel: { type: DataTypes.ENUM(...CASE_CHANNELS), allowNull: false, defaultValue: "portal" },
  team_id: { type: DataTypes.INTEGER, allowNull: true },
  assigned_agent_id: { type: DataTypes.INTEGER, allowNull: true },
  sales_order_id: { type: DataTypes.INTEGER, allowNull: true },
  order_reference: { type: DataTypes.STRING(60), allowNull: true },
  inquiry_id: { type: DataTypes.INTEGER, allowNull: true },
  first_response_due_at: { type: DataTypes.DATE, allowNull: true },
  resolution_due_at: { type: DataTypes.DATE, allowNull: true },
  first_response_at: { type: DataTypes.DATE, allowNull: true },
  resolved_at: { type: DataTypes.DATE, allowNull: true },
  closed_at: { type: DataTypes.DATE, allowNull: true },
  reopen_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  sla_breach_notified_at: { type: DataTypes.DATE, allowNull: true },
  created_by: { type: DataTypes.INTEGER, allowNull: true },
  is_demo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, { tableName: "customer_cases", underscored: true });
