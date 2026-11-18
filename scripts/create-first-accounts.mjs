#!/usr/bin/env node
/*
 * Creates the first logins on a fresh (production) database, where the demo seeder refuses to run (P10, docs/DEPLOYMENT.md §4).
 *   node scripts/create-first-accounts.mjs --setup-admin it.admin@yourcompany.ph --name "IT Administrator"
 *   node scripts/create-first-accounts.mjs --manager EMP-00042            (an HR employee; load HR first with --sync-hr)
 *   node scripts/create-first-accounts.mjs --sync-hr --manager EMP-00042
 * Rules:
 *  - The setup administrator is created only when no active setup administrator exists.
 *  - The CRM Manager is an HR employee (blueprint: HR owns identity). It is created only when no active CRM Manager exists,
 *    the employee is active or on leave in HR, has a work email and no CRM login yet ("the CRM Manager login is set up by
 *    the setup administrator", services/accessService.js). Team Leaders and Agents are then granted by the Manager in the app.
 *  - No password is ever chosen, printed or stored in plain text: each new login gets an unusable random password and a
 *    one-time "set your password" link, printed once here. Hand it over in person (a newer link cancels the older one).
 *  - Every creation is written to the audit log. Nothing is changed when a rule is not met (exit code 1).
 */
import crypto from "crypto";
import bcrypt from "bcrypt";
import { QueryTypes } from "sequelize";
import { config } from "../config/index.js";
import { sequelize, CrmUser, ACCESS_BLOCKING_STATUSES } from "../models/index.js";
import { audit } from "../services/auditService.js";
import { issueInviteLink } from "../services/accountService.js";
import { syncReferences, hrMode } from "../services/integration/hrAdapter.js";

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const fail = (msg) => { console.error(`❌ ${msg}`); process.exitCode = 1; };
const unusable = () => bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
const SCRIPT = { id: null, role: null }; // no signed-in person: the audit row says "created from the command line"

const adminEmail = arg("--setup-admin");
const managerId = arg("--manager");
if (!adminEmail && !managerId && !args.includes("--sync-hr")) {
  console.log("Usage: node scripts/create-first-accounts.mjs [--sync-hr] [--setup-admin <email> --name \"<name>\"] [--manager <HR employee ID>]");
  process.exit(1);
}

const run = async () => {
  if (config.db.name === "johnvivz_tech") return fail("DB_NAME is johnvivz_tech (the old database). Refusing.");
  console.log(`Database: ${config.db.name}   Links will start with: ${config.appUrl}`);

  if (args.includes("--sync-hr")) {
    const r = await syncReferences();
    console.log(`✅ HR references loaded (${hrMode()} mode): ${JSON.stringify(r)}`);
  }

  if (adminEmail) {
    const email = String(adminEmail).trim().toLowerCase();
    const name = String(arg("--name") || "System Administrator").trim().slice(0, 150);
    const [{ n }] = await select("SELECT COUNT(*) AS n FROM crm_users WHERE role = 'system_admin' AND is_active = 1");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail("--setup-admin needs a valid email address.");
    else if (Number(n) > 0) fail("An active setup administrator already exists. Use its account (or its password-reset link) instead.");
    else if (await CrmUser.count({ where: { email } })) fail("Another login already uses this email.");
    else {
      const u = await CrmUser.create({ user_type: "system", role: "system_admin", email, display_name: name, password_hash: await unusable(), is_demo: false });
      await audit(null, "setup_admin_created", { actor: SCRIPT, recordType: "crm_user", recordId: u.id, after: { email, role: "system_admin" }, details: "first account, created from the command line" });
      console.log(`✅ Setup administrator created: ${email}\n   Open this one-time link to set the password (valid ${config.tokens.inviteHours} h, do not share it):\n   ${await issueInviteLink(u.id)}`);
    }
  }

  if (managerId) {
    const [emp] = await select("SELECT employee_id, full_name, work_email, employment_status, is_mock FROM employee_references WHERE employee_id = :id", { id: String(managerId) });
    const [{ n }] = await select("SELECT COUNT(*) AS n FROM crm_users WHERE role = 'crm_manager' AND is_active = 1 AND access_revoked_at IS NULL");
    if (!emp) return fail(`HR employee ${managerId} is not in employee_references. Switch HR to live and add --sync-hr, or check the ID with the HR team.`);
    if (Number(n) > 0) return fail("An active CRM Manager already exists. Only one CRM Manager login is set up this way.");
    if (ACCESS_BLOCKING_STATUSES.includes(emp.employment_status)) return fail(`HR lists ${emp.full_name} as ${emp.employment_status}. CRM access cannot be granted.`);
    if (!emp.work_email) return fail("HR has no work email for this employee.");
    if (await CrmUser.count({ where: { employee_id: emp.employee_id } })) return fail("This employee already has a CRM login.");
    const email = emp.work_email.trim().toLowerCase();
    if (await CrmUser.count({ where: { email } })) return fail("Another login already uses this work email.");
    if (emp.is_mock) console.warn("⚠️  This is a MOCK HR employee (HR adapter in mock mode). For production, switch HR to live first.");
    const u = await CrmUser.create({ user_type: "staff", role: "crm_manager", employee_id: emp.employee_id, email, display_name: emp.full_name, password_hash: await unusable(), is_demo: false });
    await audit(null, "crm_access_granted", { actor: SCRIPT, recordType: "crm_user", recordId: u.id, after: { employee_id: emp.employee_id, role: "crm_manager", is_mock: Boolean(emp.is_mock) }, details: "first CRM Manager, created from the command line" });
    console.log(`✅ CRM Manager login created for ${emp.full_name} (${email}).\n   One-time link to set the password (valid ${config.tokens.inviteHours} h; give it only to this person):\n   ${await issueInviteLink(u.id)}`);
  }
};

run().catch((err) => fail(err.message)).finally(() => sequelize.close());
