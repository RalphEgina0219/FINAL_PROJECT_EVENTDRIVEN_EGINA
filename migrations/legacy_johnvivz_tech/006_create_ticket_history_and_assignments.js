/*
 * 006 — ticket_status_history (audit trail) and ticket_assignments (assignment history).
 */
export const up = async ({ queryInterface, Sequelize }) => {
  await queryInterface.createTable("ticket_status_history", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    ticket_id: {
      type: Sequelize.INTEGER, allowNull: false,
      references: { model: "support_tickets", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE",
    },
    changed_by: {
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "SET NULL",
    },
    field: { type: Sequelize.ENUM("created", "status", "priority", "category", "assignment"), allowNull: false },
    old_value: { type: Sequelize.STRING(120), allowNull: true },
    new_value: { type: Sequelize.STRING(120), allowNull: true },
    note: { type: Sequelize.STRING(255), allowNull: true },
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
  });
  await queryInterface.addIndex("ticket_status_history", ["ticket_id", "created_at"], { name: "ticket_status_history_ticket_idx" });

  await queryInterface.createTable("ticket_assignments", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    ticket_id: {
      type: Sequelize.INTEGER, allowNull: false,
      references: { model: "support_tickets", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE",
    },
    agent_id: {
      type: Sequelize.INTEGER, allowNull: false,
      references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
    },
    assigned_by: {
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "SET NULL",
    },
    assigned_at: { type: Sequelize.DATE, allowNull: false },
    unassigned_at: { type: Sequelize.DATE, allowNull: true },
    note: { type: Sequelize.STRING(255), allowNull: true },
  });
  await queryInterface.addIndex("ticket_assignments", ["ticket_id"], { name: "ticket_assignments_ticket_idx" });
  await queryInterface.addIndex("ticket_assignments", ["agent_id"], { name: "ticket_assignments_agent_idx" });
};

export const down = async ({ queryInterface }) => {
  await queryInterface.dropTable("ticket_assignments");
  await queryInterface.dropTable("ticket_status_history");
};
