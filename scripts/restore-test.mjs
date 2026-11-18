#!/usr/bin/env node
/*
 * Proves that a backup can be restored, WITHOUT touching the live database:
 *   node scripts/restore-test.mjs backups/johnvivz_crm_db-20261114-101500.sql
 * It restores the file into a NEW throwaway database (<DB_NAME>_restore_test), compares the row count of every table with the source
 * database, checks that the audit-log triggers came back, prints the result and drops the throwaway database. Exit code 1 on any difference.
 * To really restore after a failure, see docs/DEPLOYMENT.md §6 (it is a deliberate, manual step).
 */
import fs from "fs";
import { spawnSync } from "child_process";
import mysql from "mysql2/promise";
import { config } from "../config/index.js";
import { findMysqlTool } from "./mysqlTools.mjs";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error("Usage: node scripts/restore-test.mjs <backup .sql file>"); process.exit(1); }
const source = process.argv.includes("--source") ? process.argv[process.argv.indexOf("--source") + 1] : config.db.name;
const target = `${source}_restore_test`.slice(0, 60);
if (!/_test$/.test(target) || ["johnvivz_crm_db", "johnvivz_tech"].includes(target)) { console.error("Refusing: the throwaway database name must end with _test."); process.exit(1); }
const mysqlExe = findMysqlTool("mysql");
if (!mysqlExe) { console.error("The mysql client was not found (Laragon: C:\\laragon\\bin\\mysql\\<version>\\bin)."); process.exit(1); }

const conn = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password });
const counts = async (db) => {
  const [tables] = await conn.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", [db]);
  const out = {};
  for (const { t } of tables) out[t] = Number((await conn.query(`SELECT COUNT(*) AS n FROM \`${db}\`.\`${t}\``))[0][0].n);
  return out;
};
try {
  await conn.query(`DROP DATABASE IF EXISTS \`${target}\``);
  await conn.query(`CREATE DATABASE \`${target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const r = spawnSync(mysqlExe, ["-h", config.db.host, "-P", String(config.db.port), "-u", config.db.user, "--default-character-set=utf8mb4", target],
    { input: fs.readFileSync(file), env: { ...process.env, MYSQL_PWD: config.db.password }, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`restore failed: ${String(r.stderr || r.error?.message)}`);
  const [a, b] = [await counts(source), await counts(target)];
  const diffs = Object.keys({ ...a, ...b }).filter((t) => a[t] !== b[t]).map((t) => `${t}: source ${a[t] ?? "missing"}, restored ${b[t] ?? "missing"}`);
  const [triggers] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema = ? AND event_object_table = 'crm_audit_logs'", [target]);
  console.log(`Restored ${file} into ${target}: ${Object.keys(b).length} tables, ${Object.values(b).reduce((s, n) => s + n, 0)} rows, ${triggers[0].n} audit-log trigger(s).`);
  if (diffs.length) console.log(`Row counts differ from ${source} (expected if ${source} changed after the backup):\n  ${diffs.join("\n  ")}`);
  else console.log(`Every table has the same number of rows as ${source}.`);
  if (Number(triggers[0].n) < 2) { console.log("The audit-log triggers are missing in the restore."); process.exitCode = 1; }
  if (diffs.length && !process.argv.includes("--allow-changes")) process.exitCode = 1;
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await conn.query(`DROP DATABASE IF EXISTS \`${target}\``);
  await conn.end();
  console.log(`Dropped ${target}.`);
}
