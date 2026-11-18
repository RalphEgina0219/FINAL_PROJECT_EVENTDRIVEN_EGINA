/*
 * 120 — P8 loyalty (decision D13). One NEW table, no existing table is changed. loyalty_accounts and loyalty_transactions exist since 107.
 *   loyalty_redemptions   which order used which points: 100 points = PHP 10 off a later order. It lets a cancelled order give the
 *                         points back exactly once, and it is how SaleCompleted reports the loyalty discount to Accounting.
 * Plus one permission row: loyalty.view (the CRM Manager's Loyalty page; staff see a customer's points through orders.view).
 */
import { run, dropTables } from "./_sql.js";

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE loyalty_redemptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      loyalty_account_id INT NOT NULL,
      sales_order_id INT NOT NULL UNIQUE COMMENT 'one redemption per order',
      redeem_transaction_id INT NOT NULL,
      points INT NOT NULL,
      amount DECIMAL(12,2) NOT NULL COMMENT 'PHP off the order: points / 100 * 10',
      status ENUM('applied','returned') NOT NULL DEFAULT 'applied' COMMENT 'returned = the order was cancelled and the points went back',
      return_transaction_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT loyalty_redemptions_points_chk CHECK (points > 0 AND MOD(points, 100) = 0 AND amount > 0),
      CONSTRAINT loyalty_redemptions_account_fk FOREIGN KEY (loyalty_account_id) REFERENCES loyalty_accounts(id),
      CONSTRAINT loyalty_redemptions_order_fk FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id),
      CONSTRAINT loyalty_redemptions_redeem_fk FOREIGN KEY (redeem_transaction_id) REFERENCES loyalty_transactions(id),
      CONSTRAINT loyalty_redemptions_return_fk FOREIGN KEY (return_transaction_id) REFERENCES loyalty_transactions(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]);
  await sequelize.query("INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)", {
    replacements: ["loyalty.view", "sales", "View loyalty accounts and their earn / redeem / reversal history"],
  });
  await sequelize.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'loyalty.view' WHERE r.code = 'crm_manager'`
  );
};

export const down = async ({ sequelize }) => {
  await sequelize.query("DELETE FROM permissions WHERE code = 'loyalty.view'");
  await dropTables(sequelize, ["loyalty_redemptions"]);
};
