/*
 * 003 — customers and support_agents profile tables, linked 1:1 to users.
 * Name, email and password stay in users only (no duplicate customer data).
 */
export const up = async ({ queryInterface, Sequelize }) => {
  const timestamps = {
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
    updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
  };

  await queryInterface.createTable("customers", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: {
      type: Sequelize.INTEGER, allowNull: false, unique: true,
      references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE",
    },
    phone: { type: Sequelize.STRING(30), allowNull: true },
    address: { type: Sequelize.STRING(255), allowNull: true },
    erp_customer_ref: { type: Sequelize.STRING(60), allowNull: true },
    ...timestamps,
  });

  await queryInterface.createTable("support_agents", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: {
      type: Sequelize.INTEGER, allowNull: false, unique: true,
      references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE",
    },
    specialization_category_id: {
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: "ticket_categories", key: "id" }, onUpdate: "CASCADE", onDelete: "SET NULL",
    },
    is_available: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
    ...timestamps,
  });
};

export const down = async ({ queryInterface }) => {
  await queryInterface.dropTable("support_agents");
  await queryInterface.dropTable("customers");
};
