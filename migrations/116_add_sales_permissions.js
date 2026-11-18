/*
 * 116 — P5 sales: new permissions (data only, no table is changed).
 * Rows are added to `permissions` and `role_permissions` (tables created in 102). The tables P5 uses
 * (product_references, sales_orders, sales_order_items, payment_references, sales_transactions, refunds, promotions,
 * promotion_redemptions, campaigns, cart_records, cart_items, integration_outbox, integration_logs) already exist
 * from migrations 106, 107, 110. Existing permissions reused: orders.create, orders.view_own, refunds.approve, campaigns.manage.
 * Record scope still decides WHICH orders, payments and refunds a role may touch.
 */

// [code, module, description, roles]
const PERMISSIONS = [
  ["orders.view", "sales", "View orders, payments and refunds of customers in my scope", ["agent", "team_leader", "crm_manager"]],
  ["payments.verify", "sales", "Verify a recorded payment reference (never one I recorded myself)", ["agent", "team_leader", "crm_manager"]],
  ["refunds.request", "sales", "Request a refund for a completed sale in my scope", ["agent", "team_leader", "crm_manager"]],
  ["refunds.view", "sales", "View refund requests in my scope", ["agent", "team_leader", "crm_manager"]],
  ["promotions.view", "sales", "View promotions and campaign results", ["team_leader", "crm_manager"]],
  ["promotions.approve", "sales", "Approve or reject a promotion created by someone else", ["team_leader", "crm_manager"]],
  ["inventory.sync", "sales", "Refresh the product snapshot from Inventory", ["crm_manager"]],
  ["shop.use", "sales", "Browse products, use the cart, place, pay for and cancel own orders (customer portal)", ["customer"]],
];

export const up = async ({ sequelize }) => {
  for (const [code, module, description, roles] of PERMISSIONS) {
    await sequelize.query("INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)", { replacements: [code, module, description] });
    await sequelize.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = ? WHERE r.code IN (?)`,
      { replacements: [code, roles] }
    );
  }
};

export const down = async ({ sequelize }) => {
  await sequelize.query("DELETE FROM permissions WHERE code IN (?)", { replacements: [PERMISSIONS.map((p) => p[0])] });
};
