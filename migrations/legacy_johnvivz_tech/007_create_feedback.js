/*
 * 007 — feedback: one rating (1–5) per ticket, enforced by a UNIQUE index and a CHECK constraint.
 */
export const up = async ({ queryInterface, Sequelize, sequelize }) => {
  await queryInterface.createTable("feedback", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    ticket_id: {
      type: Sequelize.INTEGER, allowNull: false, unique: true,
      references: { model: "support_tickets", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE",
    },
    customer_id: {
      type: Sequelize.INTEGER, allowNull: false,
      references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
    },
    rating: { type: Sequelize.TINYINT, allowNull: false },
    comment: { type: Sequelize.TEXT, allowNull: true },
    is_demo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
    updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
  });
  await sequelize.query("ALTER TABLE feedback ADD CONSTRAINT feedback_rating_range CHECK (rating BETWEEN 1 AND 5)");
};

export const down = async ({ queryInterface }) => {
  await queryInterface.dropTable("feedback");
};
