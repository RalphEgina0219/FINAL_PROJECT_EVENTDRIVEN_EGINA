/*
 * 004 — support_tickets and ticket_daily_sequences.
 * ticket_no format JVT-YYYYMMDD-0001: the daily counter row is locked inside the same
 * transaction as the ticket insert, and ticket_no has a UNIQUE index as a final guard.
 */
export const up = async ({ queryInterface, Sequelize }) => {
  await queryInterface.createTable("ticket_daily_sequences", {
    seq_date: { type: Sequelize.DATEONLY, primaryKey: true },
    last_no: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
  });

  await queryInterface.createTable("support_tickets", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    ticket_no: { type: Sequelize.STRING(20), allowNull: false },
    customer_id: {
      type: Sequelize.INTEGER, allowNull: false,
      references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
    },
    category_id: {
      type: Sequelize.INTEGER, allowNull: false,
      references: { model: "ticket_categories", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
    },
    concern_type: { type: Sequelize.ENUM("inquiry", "complaint", "service_request"), allowNull: false },
    subject: { type: Sequelize.STRING(150), allowNull: false },
    description: { type: Sequelize.TEXT, allowNull: false },
    priority: { type: Sequelize.ENUM("low", "medium", "high", "urgent"), allowNull: false, defaultValue: "medium" },
    status: {
      type: Sequelize.ENUM("open", "in_progress", "pending", "resolved", "closed", "reopened"),
      allowNull: false, defaultValue: "open",
    },
    assigned_agent_id: {
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "SET NULL",
    },
    order_reference: { type: Sequelize.STRING(60), allowNull: true },
    first_response_due_at: { type: Sequelize.DATE, allowNull: true },
    resolution_due_at: { type: Sequelize.DATE, allowNull: true },
    first_response_at: { type: Sequelize.DATE, allowNull: true },
    resolved_at: { type: Sequelize.DATE, allowNull: true },
    closed_at: { type: Sequelize.DATE, allowNull: true },
    reopen_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    is_demo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
    updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
  });

  await queryInterface.addIndex("support_tickets", ["ticket_no"], { unique: true, name: "support_tickets_ticket_no_unique" });
  await queryInterface.addIndex("support_tickets", ["status"], { name: "support_tickets_status_idx" });
  await queryInterface.addIndex("support_tickets", ["assigned_agent_id"], { name: "support_tickets_agent_idx" });
  await queryInterface.addIndex("support_tickets", ["customer_id"], { name: "support_tickets_customer_idx" });
  await queryInterface.addIndex("support_tickets", ["created_at"], { name: "support_tickets_created_at_idx" });
  await queryInterface.addIndex("support_tickets", ["category_id"], { name: "support_tickets_category_idx" });
  await queryInterface.addIndex("support_tickets", ["priority"], { name: "support_tickets_priority_idx" });
};

export const down = async ({ queryInterface }) => {
  await queryInterface.dropTable("support_tickets");
  await queryInterface.dropTable("ticket_daily_sequences");
};
