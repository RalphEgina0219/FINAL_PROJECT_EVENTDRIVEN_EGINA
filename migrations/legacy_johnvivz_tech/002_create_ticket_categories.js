/*
 * 002 — ticket_categories, plus the default categories.
 * The defaults are reference data for a grocery store (not demo data). They are placeholders
 * until the module specification's final category list is confirmed; Admin can edit them.
 */
const DEFAULT_CATEGORIES = [
  ["Order Issue", "Missing, wrong or incomplete items in an order"],
  ["Product Quality", "Expired, spoiled or damaged products"],
  ["Billing & Payment", "Overcharges, double charges, receipts and payment concerns"],
  ["Delivery & Pickup", "Delivery schedule, late delivery and pickup concerns"],
  ["Returns & Refunds", "Product returns, exchanges and refund requests"],
  ["Product Inquiry", "Availability, prices and product information"],
  ["Account & Loyalty", "Customer account, loyalty points and discounts"],
  ["Store Service", "Staff conduct, store cleanliness and in-store experience"],
  ["General Inquiry", "Other questions and concerns"],
];

export const up = async ({ queryInterface, Sequelize }) => {
  await queryInterface.createTable("ticket_categories", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: Sequelize.STRING(80), allowNull: false, unique: true },
    description: { type: Sequelize.STRING(255), allowNull: true },
    is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
    updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP") },
  });
  const now = new Date();
  await queryInterface.bulkInsert(
    "ticket_categories",
    DEFAULT_CATEGORIES.map(([name, description]) => ({ name, description, is_active: true, created_at: now, updated_at: now }))
  );
};

export const down = async ({ queryInterface }) => {
  await queryInterface.dropTable("ticket_categories");
};
