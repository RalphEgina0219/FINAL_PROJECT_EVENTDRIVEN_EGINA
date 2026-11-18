/*
 * Helper for the JOHNVIVZ CRM migrations (101+). Each migration is plain MySQL DDL so the SQL
 * that runs is exactly the SQL that is reviewed (the runner prints every statement).
 * Not a migration itself: the runner only picks files named NNN_name.js.
 */
export const run = async (sequelize, statements) => {
  for (const sql of statements) {
    await sequelize.query(sql.trim());
  }
};

// Drops tables in the given order with FK checks off (used only by down()).
export const dropTables = async (sequelize, tables) => {
  await sequelize.query("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const t of tables) await sequelize.query(`DROP TABLE IF EXISTS \`${t}\``);
  } finally {
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 1");
  }
};

// Drops a foreign key only if it exists (down() of migrations that ALTER earlier tables).
export const dropForeignKeyIfExists = async (sequelize, table, constraint) => {
  const [rows] = await sequelize.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    { replacements: [table, constraint] }
  );
  if (rows.length) await sequelize.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${constraint}\``);
};

export const TS = `created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;
