/*
 * 005 — ticket_responses (public replies and internal notes) and ticket_attachments.
 */
export const up = async ({ queryInterface, Sequelize }) => {
  await queryInterface.createTable("ticket_responses", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    ticket_id: {
      type: Sequelize.INTEGER, allowNull: false,
      references: { model: "support_tickets", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE",
    },
    user_id: {
      type: Sequelize.INTEGER, allowNull: false,
      references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
    },
    visibility: { type: Sequelize.ENUM("public", "internal"), allowNull: false, defaultValue: "public" },
    message: { type: Sequelize.TEXT, allowNull: false },
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
    updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
  });
  await queryInterface.addIndex("ticket_responses", ["ticket_id", "created_at"], { name: "ticket_responses_ticket_idx" });

  await queryInterface.createTable("ticket_attachments", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    ticket_id: {
      type: Sequelize.INTEGER, allowNull: false,
      references: { model: "support_tickets", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE",
    },
    response_id: {
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: "ticket_responses", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE",
    },
    uploaded_by: {
      type: Sequelize.INTEGER, allowNull: false,
      references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
    },
    original_name: { type: Sequelize.STRING(200), allowNull: false },
    stored_name: { type: Sequelize.STRING(80), allowNull: false, unique: true },
    mime_type: { type: Sequelize.STRING(120), allowNull: false },
    size_bytes: { type: Sequelize.INTEGER, allowNull: false },
    visibility: { type: Sequelize.ENUM("public", "internal"), allowNull: false, defaultValue: "public" },
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
    updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
  });
  await queryInterface.addIndex("ticket_attachments", ["ticket_id"], { name: "ticket_attachments_ticket_idx" });
};

export const down = async ({ queryInterface }) => {
  await queryInterface.dropTable("ticket_attachments");
  await queryInterface.dropTable("ticket_responses");
};
