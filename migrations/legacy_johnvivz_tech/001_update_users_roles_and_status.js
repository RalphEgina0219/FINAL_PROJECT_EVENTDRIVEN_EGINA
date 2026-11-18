/*
 * 001 — users: roles admin/agent/manager/customer, is_active, last_login_at, is_demo, UNIQUE email.
 *
 * If `users` already exists (created by the old sync()), the role change runs in safe steps:
 *   1. expand the ENUM to old + new values
 *   2. UPDATE staff -> agent, visitors -> customer (admin stays admin)
 *   3. remove the old values  4. set the default to customer
 * Before any change it reports rows per role and stops if duplicate emails exist.
 * If the table has rows with old roles, it asks for confirmation (or CONFIRM_ROLE_MIGRATION=yes).
 * If `users` does not exist, it is created with the new schema.
 */
import inquirer from "inquirer";

const NEW_ROLES = "'admin','agent','manager','customer'";

export const SQL = {
  expandEnum: "ALTER TABLE users MODIFY role ENUM('admin','staff','visitors','agent','manager','customer') NOT NULL DEFAULT 'visitors'",
  staffToAgent: "UPDATE users SET role = 'agent' WHERE role = 'staff'",
  visitorsToCustomer: "UPDATE users SET role = 'customer' WHERE role = 'visitors'",
  finalEnum: `ALTER TABLE users MODIFY role ENUM(${NEW_ROLES}) NOT NULL DEFAULT 'customer'`,
  addIsActive: "ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER role",
  addLastLogin: "ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL AFTER is_active",
  addIsDemo: "ALTER TABLE users ADD COLUMN is_demo TINYINT(1) NOT NULL DEFAULT 0 AFTER last_login_at",
  addUniqueEmail: "ALTER TABLE users ADD UNIQUE INDEX users_email_unique (email)",
};

const tableExists = async (sequelize, table) => {
  const [rows] = await sequelize.query(
    "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    { replacements: [table], logging: false }
  );
  return rows.length > 0;
};

const indexExists = async (sequelize, table, index) => {
  const [rows] = await sequelize.query(
    "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
    { replacements: [table, index], logging: false }
  );
  return rows.length > 0;
};

export const up = async ({ sequelize, queryInterface, Sequelize, log }) => {
  if (!(await tableExists(sequelize, "users"))) {
    log("users table not found: creating it with the new schema.");
    await queryInterface.createTable("users", {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: Sequelize.STRING, allowNull: false },
      email: { type: Sequelize.STRING, allowNull: false },
      password: { type: Sequelize.STRING, allowNull: false },
      role: { type: Sequelize.ENUM("admin", "agent", "manager", "customer"), allowNull: false, defaultValue: "customer" },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      last_login_at: { type: Sequelize.DATE, allowNull: true },
      is_demo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await sequelize.query(SQL.addUniqueEmail);
    return;
  }

  // --- Report before changing anything ---
  const [counts] = await sequelize.query("SELECT role, COUNT(*) AS n FROM users GROUP BY role", { logging: false });
  const total = counts.reduce((s, r) => s + Number(r.n), 0);
  log(`users rows: ${total}${counts.length ? " (" + counts.map((r) => `${r.role}: ${r.n}`).join(", ") + ")" : ""}`);

  const [dups] = await sequelize.query(
    "SELECT email, COUNT(*) AS n FROM users GROUP BY email HAVING COUNT(*) > 1",
    { logging: false }
  );
  if (dups.length) {
    throw new Error(
      "Duplicate emails found, nothing was changed:\n" +
      dups.map((d) => `     ${d.email} (${d.n} rows)`).join("\n") +
      "\n   Resolve these rows manually, then run npm run migrate again."
    );
  }

  const columns = await queryInterface.describeTable("users");
  const roleType = String(columns.role?.type || "");
  const hasOldValues = /'staff'|'visitors'/.test(roleType);
  const oldRoleRows = counts.filter((r) => ["staff", "visitors"].includes(r.role)).reduce((s, r) => s + Number(r.n), 0);

  if (hasOldValues && oldRoleRows > 0 && process.env.CONFIRM_ROLE_MIGRATION !== "yes") {
    let proceed = false;
    if (process.stdin.isTTY) {
      ({ proceed } = await inquirer.prompt([{
        type: "confirm", name: "proceed", default: false,
        message: `${oldRoleRows} user(s) will change role (staff -> agent, visitors -> customer). Continue?`,
      }]));
    }
    if (!proceed) {
      throw new Error("Role change not confirmed. Re-run interactively, or set CONFIRM_ROLE_MIGRATION=yes.");
    }
  }

  if (hasOldValues) {
    await sequelize.query(SQL.expandEnum);        // step 1
    await sequelize.query(SQL.staffToAgent);      // step 2
    await sequelize.query(SQL.visitorsToCustomer);
    await sequelize.query(SQL.finalEnum);         // steps 3 + 4
  } else if (!/'agent'/.test(roleType)) {
    await sequelize.query(SQL.finalEnum);
  }

  if (!columns.is_active) await sequelize.query(SQL.addIsActive);
  if (!columns.last_login_at) await sequelize.query(SQL.addLastLogin);
  if (!columns.is_demo) await sequelize.query(SQL.addIsDemo);
  if (!(await indexExists(sequelize, "users", "users_email_unique"))) await sequelize.query(SQL.addUniqueEmail);
};

// Reverses the column/role changes. It never drops the users table, to protect account data.
export const down = async ({ sequelize, queryInterface }) => {
  const columns = await queryInterface.describeTable("users");
  if (await indexExists(sequelize, "users", "users_email_unique")) {
    await sequelize.query("ALTER TABLE users DROP INDEX users_email_unique");
  }
  for (const col of ["is_demo", "last_login_at", "is_active"]) {
    if (columns[col]) await sequelize.query(`ALTER TABLE users DROP COLUMN ${col}`);
  }
  await sequelize.query("ALTER TABLE users MODIFY role ENUM('admin','staff','visitors','agent','manager','customer') NOT NULL DEFAULT 'customer'");
  await sequelize.query("UPDATE users SET role = 'staff' WHERE role IN ('agent','manager')");
  await sequelize.query("UPDATE users SET role = 'visitors' WHERE role = 'customer'");
  await sequelize.query("ALTER TABLE users MODIFY role ENUM('admin','staff','visitors') NOT NULL DEFAULT 'visitors'");
};
