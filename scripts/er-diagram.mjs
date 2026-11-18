#!/usr/bin/env node
/*
 * Writes the ER diagram source of the CRM database from the database itself (so it can never drift from the migrations):
 *   node scripts/er-diagram.mjs            reads DB_NAME (read-only) and writes docs/er-diagram.mmd and docs/ER-DIAGRAM.md
 * Mermaid "erDiagram" syntax: GitHub, VS Code (Markdown Preview Mermaid) and https://mermaid.live render it.
 * Columns: type, PK / FK / UK markers. Lines: one per foreign key ("many to one").
 */
import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";
import { config } from "../config/index.js";

const conn = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, database: config.db.name });
const db = config.db.name;
const [cols] = await conn.query(
  `SELECT table_name AS t, column_name AS c, data_type AS type, column_key AS k FROM information_schema.columns
   WHERE table_schema = ? AND table_name <> 'migrations' ORDER BY table_name, ordinal_position`, [db]);
const [fks] = await conn.query(
  `SELECT table_name AS t, column_name AS c, referenced_table_name AS rt FROM information_schema.key_column_usage
   WHERE table_schema = ? AND referenced_table_name IS NOT NULL ORDER BY table_name, column_name`, [db]);
await conn.end();

const fkSet = new Set(fks.map((f) => `${f.t}.${f.c}`));
const tables = {};
for (const c of cols) (tables[c.t] ||= []).push(c);
const lines = ["erDiagram"];
for (const f of fks) lines.push(`  ${f.rt} ||--o{ ${f.t} : "${f.c}"`);
for (const [t, list] of Object.entries(tables)) {
  lines.push(`  ${t} {`);
  for (const c of list) {
    const marks = [c.k === "PRI" ? "PK" : null, fkSet.has(`${t}.${c.c}`) ? "FK" : null, c.k === "UNI" ? "UK" : null].filter(Boolean).join(",");
    lines.push(`    ${c.type.replace(/[^a-z0-9_]/gi, "_")} ${c.c}${marks ? ` ${marks}` : ""}`);
  }
  lines.push("  }");
}
const root = config.projectRoot;
fs.writeFileSync(path.join(root, "docs", "er-diagram.mmd"), `${lines.join("\n")}\n`);
fs.writeFileSync(path.join(root, "docs", "ER-DIAGRAM.md"), `# JOHNVIVZ CRM — ER diagram (\`${db}\`)

Generated on ${new Date().toISOString().slice(0, 10)} from the database itself by \`node scripts/er-diagram.mjs\` (migrations 101–120): ${Object.keys(tables).length} tables, ${fks.length} foreign keys. The \`migrations\` bookkeeping table is left out. Source only: \`docs/er-diagram.mmd\` (Mermaid). GitHub and VS Code render the block below; https://mermaid.live can export it as an image.

Tables that are NOT in the CRM database on purpose (owned by the other apps, reached only through the integration API): employees, payroll, leave and attendance records (HR); products, prices and stock (Inventory); journal entries, VAT and the ledger (Accounting). CRM keeps read-only snapshots: \`employee_references\`, \`department_references\`, \`position_references\`, \`product_references\`.

\`\`\`mermaid
${lines.join("\n")}
\`\`\`
`);
console.log(`Wrote docs/er-diagram.mmd and docs/ER-DIAGRAM.md: ${Object.keys(tables).length} tables, ${fks.length} foreign keys.`);
