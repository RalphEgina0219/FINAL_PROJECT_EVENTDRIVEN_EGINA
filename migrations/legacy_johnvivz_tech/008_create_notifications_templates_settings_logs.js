/*
 * 008 — notifications, response_templates, settings, activity_logs, ticket_reads,
 *       and support_tickets.sla_breach_notified_at (so the overdue alert is sent once).
 */
import { config } from "../config/index.js";

// Initial values come from .env (config/index.js); afterwards the Admin edits them on the Settings page.
const DEFAULT_SETTINGS = [
  ["auto_close_days", String(config.tickets.autoCloseDays), "Days a Resolved ticket waits for a customer reply before it is closed automatically"],
  ["reopen_window_days", String(config.tickets.reopenWindowDays), "Days after resolution during which the customer can reopen a ticket"],
  ...["urgent", "high", "medium", "low"].flatMap((p) => [
    [`sla_first_response_hours_${p}`, String(config.sla.firstResponseHours[p]), `First-response target (hours) for ${p}`],
    [`sla_resolution_hours_${p}`, String(config.sla.resolutionHours[p]), `Resolution target (hours) for ${p}`],
  ]),
];

const TEMPLATES = [
  ["Acknowledge concern", null, "Hi {customer_name}, thank you for contacting JOHNVIVZ support. We received ticket {ticket_no} and {agent_name} is now looking into it. We'll update you soon."],
  ["Request photo and receipt", null, "Hi {customer_name}, to process ticket {ticket_no} faster, please reply with a photo of the item and a copy of your receipt. Thank you!"],
  ["Refund processed", "Returns & Refunds", "Hi {customer_name}, your refund for ticket {ticket_no} has been processed. It should reflect within 3–5 banking days. — {agent_name}"],
  ["Replacement scheduled", "Order Issue", "Hi {customer_name}, we've scheduled a replacement for the missing/wrong item(s) in ticket {ticket_no} at no extra cost."],
  ["Delivery rescheduled", "Delivery & Pickup", "Hi {customer_name}, your delivery for ticket {ticket_no} has been rescheduled as requested."],
];

export const up = async ({ queryInterface, Sequelize }) => {
  const ts = {
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
    updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
  };
  const userFk = (onDelete = "CASCADE", allowNull = false) => ({
    type: Sequelize.INTEGER, allowNull, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete,
  });

  await queryInterface.createTable("notifications", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: userFk(),
    type: { type: Sequelize.ENUM("new_ticket", "assignment", "new_reply", "status_change", "resolved", "sla_overdue", "feedback", "account"), allowNull: false },
    title: { type: Sequelize.STRING(150), allowNull: false },
    message: { type: Sequelize.STRING(255), allowNull: true },
    link: { type: Sequelize.STRING(255), allowNull: true },
    ticket_id: {
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: "support_tickets", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE",
    },
    read_at: { type: Sequelize.DATE, allowNull: true },
    created_at: ts.created_at,
  });
  await queryInterface.addIndex("notifications", ["user_id", "read_at"], { name: "notifications_user_read_idx" });

  await queryInterface.createTable("response_templates", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    title: { type: Sequelize.STRING(100), allowNull: false },
    category_id: {
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: "ticket_categories", key: "id" }, onUpdate: "CASCADE", onDelete: "SET NULL",
    },
    body: { type: Sequelize.TEXT, allowNull: false },
    is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
    created_by: userFk("SET NULL", true),
    ...ts,
  });

  await queryInterface.createTable("settings", {
    setting_key: { type: Sequelize.STRING(60), primaryKey: true },
    setting_value: { type: Sequelize.STRING(255), allowNull: false },
    description: { type: Sequelize.STRING(255), allowNull: true },
    updated_by: userFk("SET NULL", true),
    updated_at: ts.updated_at,
  });

  await queryInterface.createTable("activity_logs", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: userFk("SET NULL", true),
    action: { type: Sequelize.STRING(60), allowNull: false },
    entity_type: { type: Sequelize.STRING(40), allowNull: true },
    entity_id: { type: Sequelize.INTEGER, allowNull: true },
    details: { type: Sequelize.STRING(500), allowNull: true },
    ip_address: { type: Sequelize.STRING(45), allowNull: true },
    created_at: ts.created_at,
  });
  await queryInterface.addIndex("activity_logs", ["created_at"], { name: "activity_logs_created_idx" });

  await queryInterface.createTable("ticket_reads", {
    user_id: { ...userFk(), primaryKey: true },
    ticket_id: {
      type: Sequelize.INTEGER, allowNull: false, primaryKey: true,
      references: { model: "support_tickets", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE",
    },
    last_read_at: { type: Sequelize.DATE, allowNull: false },
  });

  await queryInterface.addColumn("support_tickets", "sla_breach_notified_at", { type: Sequelize.DATE, allowNull: true, after: "reopen_count" });

  const now = new Date();
  await queryInterface.bulkInsert("settings", DEFAULT_SETTINGS.map(([k, v, d]) => ({ setting_key: k, setting_value: v, description: d, updated_at: now })));
  const [cats] = await queryInterface.sequelize.query("SELECT id, name FROM ticket_categories");
  const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]));
  await queryInterface.bulkInsert("response_templates", TEMPLATES.map(([title, cat, body]) => ({
    title, category_id: cat ? catId[cat] || null : null, body, is_active: true, created_at: now, updated_at: now,
  })));
};

export const down = async ({ queryInterface }) => {
  await queryInterface.removeColumn("support_tickets", "sla_breach_notified_at");
  for (const t of ["ticket_reads", "activity_logs", "settings", "response_templates", "notifications"]) {
    await queryInterface.dropTable(t);
  }
};
