#!/usr/bin/env node
/*
 * Backs up the CRM database (DB_NAME from .env) with mysqldump into backups/<db>-<YYYYMMDD-HHMMSS>.sql.
 *   node scripts/backup-db.mjs                 back up DB_NAME
 *   node scripts/backup-db.mjs --db other_db   back up another database (never johnvivz_tech by mistake: it is refused unless --allow-legacy)
 * --single-transaction gives a consistent copy without locking the tables; triggers (the append-only audit log) are included.
 * mysqldump is looked up on PATH, then in Laragon (C:\laragon\bin\mysql\*\bin) and XAMPP (C:\xampp\mysql\bin).
 * The password is passed through the MYSQL_PWD environment variable, never on the command line.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { config } from "../config/index.js";
import { findMysqlTool } from "./mysqlTools.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const db = arg("--db", config.db.name);
if (db.toLowerCase() === "johnvivz_tech" && !args.includes("--allow-legacy")) { console.error("Refusing to back up johnvivz_tech without --allow-legacy (it is the old database)."); process.exit(1); }

const dump = findMysqlTool("mysqldump");
if (!dump) { console.error("mysqldump was not found. Add MySQL's bin folder to PATH (Laragon: C:\\laragon\\bin\\mysql\\<version>\\bin)."); process.exit(1); }
const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const dir = path.join(config.projectRoot, "backups");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${db}-${stamp}.sql`);
const r = spawnSync(dump, ["-h", config.db.host, "-P", String(config.db.port), "-u", config.db.user, "--single-transaction", "--routines", "--triggers", "--default-character-set=utf8mb4", "--result-file", file, db],
  { env: { ...process.env, MYSQL_PWD: config.db.password }, encoding: "utf8" });
if (r.status !== 0) { console.error(`Backup failed: ${r.stderr || r.error?.message}`); process.exit(1); }
console.log(`Backup written: ${file} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
console.log("Keep backups outside the laptop too (a USB drive or a private cloud folder). They contain customer data: treat them like the database.");
