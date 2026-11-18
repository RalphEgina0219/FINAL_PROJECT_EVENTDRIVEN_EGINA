/*
 * JOHNVIVZ CRM — migration runner (replaces sequelize.sync()).
 *
 *   npm run migrate            run all pending migrations (xian migrate does the same)
 *   npm run migrate:status     list applied and pending migrations
 *   npm run migrate:rollback   undo the most recent batch
 *
 * Migrations live in migrations/NNN_name.js and export up() and down().
 * Applied migrations are recorded in the `migrations` table. This script never calls
 * sequelize.sync() and never drops the database.
 *
 * migrations/legacy_johnvivz_tech/ holds the old 001–008 set of the retired JOHNVIVZ TECH
 * database. They are not run any more. The runner refuses to touch a database that still has
 * those rows in its `migrations` table, so the fallback copy johnvivz_tech is never modified.
 */
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { Sequelize } from "sequelize";
import inquirer from "inquirer";
import { config } from "./config/index.js";

const command = (process.argv.slice(2).find((a) => !a.startsWith("--")) || "up").toLowerCase();
const quiet = process.argv.includes("--quiet");
const migrationsDir = path.join(config.projectRoot, "migrations");
const dbName = config.db.name;

if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
  console.error(`❌ Invalid DB_NAME "${dbName}". Use letters, numbers and underscores only.`);
  process.exit(1);
}

const connectionOptions = {
  host: config.db.host,
  port: config.db.port,
  dialect: "mysql",
  timezone: config.db.timezone,
  dialectOptions: { decimalNumbers: true },
};

const ensureDatabase = async () => {
  const root = new Sequelize("", config.db.user, config.db.password, { ...connectionOptions, logging: false });
  try {
    const [rows] = await root.query(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
      { replacements: [dbName] }
    );
    if (rows.length) return true;
    if (command !== "up") {
      console.log(`ℹ️  Database '${dbName}' does not exist yet. Run: npm run migrate`);
      return false;
    }
    let create = true;
    if (process.stdin.isTTY) {
      ({ create } = await inquirer.prompt([{
        type: "confirm", name: "create", default: true,
        message: `Database '${dbName}' does not exist. Create it?`,
      }]));
    }
    if (!create) return false;
    await root.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`✅ Database '${dbName}' created`);
    return true;
  } finally {
    await root.close();
  }
};

const listMigrationFiles = () =>
  fs.readdirSync(migrationsDir).filter((f) => /^\d+_[\w-]+\.js$/.test(f)).sort();

const main = async () => {
  if (!["up", "status", "rollback"].includes(command)) {
    console.log("Usage: node migrate.js [up|status|rollback] [--quiet]");
    return 1;
  }
  if (!(await ensureDatabase())) return command === "up" ? 1 : 0;

  const sequelize = new Sequelize(dbName, config.db.user, config.db.password, {
    ...connectionOptions,
    logging: quiet ? false : (sql) => console.log("   SQL>", sql.replace(/^Executing \([^)]*\):\s*/, "")),
  });
  const silent = { logging: false };

  try {
    await sequelize.authenticate({ logging: false });
    await sequelize.query(
      `CREATE TABLE IF NOT EXISTS migrations (
         id INT AUTO_INCREMENT PRIMARY KEY,
         name VARCHAR(255) NOT NULL UNIQUE,
         batch INT NOT NULL,
         run_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      silent
    );

    const [appliedRows] = await sequelize.query("SELECT name, batch, run_at FROM migrations ORDER BY id", silent);
    const legacy = appliedRows.filter((r) => /^00\d_/.test(r.name));
    if (legacy.length && command !== "status") {
      console.error(`\n❌ '${dbName}' is the legacy JOHNVIVZ TECH database (${legacy.length} legacy migrations applied).`);
      console.error("   It is kept untouched as the fallback copy. Set DB_NAME=johnvivz_crm_db in .env and run again.");
      return 1;
    }
    const applied = new Map(appliedRows.map((r) => [r.name, r]));
    const files = listMigrationFiles();
    const context = {
      sequelize,
      queryInterface: sequelize.getQueryInterface(),
      Sequelize,
      log: (msg) => console.log(`   ${msg}`),
    };

    if (command === "status") {
      console.log(`\nMigrations for database '${dbName}':\n`);
      for (const f of files) {
        const row = applied.get(f);
        console.log(`  ${row ? `✅ applied (batch ${row.batch})` : "⏳ pending           "}  ${f}`);
      }
      console.log("");
      return 0;
    }

    if (command === "rollback") {
      const lastBatch = appliedRows.reduce((m, r) => Math.max(m, r.batch), 0);
      if (!lastBatch) {
        console.log("ℹ️  Nothing to roll back.");
        return 0;
      }
      const toUndo = appliedRows.filter((r) => r.batch === lastBatch).map((r) => r.name).reverse();
      for (const name of toUndo) {
        console.log(`↩️  Rolling back ${name}`);
        const mod = await import(pathToFileURL(path.join(migrationsDir, name)).href);
        await mod.down(context);
        await sequelize.query("DELETE FROM migrations WHERE name = ?", { replacements: [name], ...silent });
      }
      console.log(`✅ Rolled back batch ${lastBatch}`);
      return 0;
    }

    const pending = files.filter((f) => !applied.has(f));
    if (!pending.length) {
      console.log("✅ Database is up to date. No pending migrations.");
      return 0;
    }
    const batch = appliedRows.reduce((m, r) => Math.max(m, r.batch), 0) + 1;
    for (const name of pending) {
      console.log(`\n▶️  Migrating ${name}`);
      const mod = await import(pathToFileURL(path.join(migrationsDir, name)).href);
      await mod.up(context);
      await sequelize.query("INSERT INTO migrations (name, batch) VALUES (?, ?)", { replacements: [name, batch], ...silent });
      console.log(`✅ ${name}`);
    }
    console.log(`\n✅ Applied ${pending.length} migration(s) in batch ${batch}.`);
    return 0;
  } catch (err) {
    console.error("\n❌ Migration failed:", err.message);
    console.error("   The failed migration was not recorded. Fix the problem and run the command again.");
    return 1;
  } finally {
    await sequelize.close();
  }
};

process.exit(await main());
