#!/usr/bin/env node
/*
 * JOHNVIVZ merge kit — FAKE-TEAMMATE MODE. Starts fake HR, Inventory and Accounting servers so anyone can try the integration before (or
 * without) the real apps. They are test doubles, NOT the real apps.
 *
 * Each fake imitates the app the way CRM is set to talk to it in .env (docs/integration-contract.md §12):
 *   HR          INTEGRATION_HR_AUTH=bearer + INTEGRATION_HR_SYNC=pull  -> fake JohnVivzHR: pull-only API, API key, GET /ping, no events
 *               otherwise                                               -> contract fake (HMAC, /health, events)
 *   Inventory   INTEGRATION_INVENTORY_DIALECT=johnvivz_inventory      -> fake Inventory app: Bearer token, its own events, polled outbox
 *               otherwise                                               -> contract fake (HMAC, reservations API)
 *   Accounting  always the contract fake (JVzPay follows the contract: HMAC both ways)
 *   --current   use the teammates' current style for HR and Inventory whatever .env says;   --contract   use the contract fakes for all three
 *
 *   node scripts/fake-teammates.mjs                         ports 4101 (HR), 4102 (Inventory), 4103 (Accounting) on 127.0.0.1
 *   node scripts/fake-teammates.mjs --host 0.0.0.0         reachable from other laptops on the same Wi-Fi
 *   node scripts/fake-teammates.mjs --crm http://192.168.1.10:3000 --ports 5101,5102,5103
 * Secrets and tokens come from CRM's .env (JVZ_SECRET_*, JVZ_CRM_INBOUND_SECRET_*, HR_API_TOKEN, INVENTORY_API_TOKEN); missing ones are
 * generated and printed once so they can be put in CRM's .env.
 *
 * Type a command and press Enter:
 *   send hr EmployeeStatusChanged employee_id=MOCK-EMP-1003 employment_status=inactive      (contract HR fake only)
 *   send inventory LowStockDetected product_id=MOCK-P-1001 available_qty=3                  (contract Inventory fake only)
 *   hr status JV-2026-00002 Resigned      change an employee in the fake JohnVivzHR (CRM sees it at its next pull or "Sync now")
 *   inv emit LowStockDetected productId=INV-1002 availableQty=3   put an event in the fake Inventory outbox (CRM reads it within a minute)
 *   ess register rico@hr.example.test Secret#123 JV-2026-00002 CRM   a new hire registers in the fake JVzPay ESS (for INTEGRATION_ESS_LOGIN=live)
 *   events   what CRM sent        calls   the last 20 calls CRM made        stock   the fake Inventory's stock        help        quit
 */
import crypto from "crypto";
import readline from "readline";
import { config } from "../config/index.js";
import { startFakeApps, offsetNow } from "../tests/support/fakeApps.mjs";
import { startFakeHrPull, startFakeInventoryDialect } from "../tests/support/fakeDialects.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const host = arg("--host", "127.0.0.1");
const crmBase = arg("--crm", process.env.APP_URL || `http://127.0.0.1:${config.port}`).replace(/\/+$/, "");
const [hrPort, invPort, accPort] = arg("--ports", "4101,4102,4103").split(",").map(Number);
const I = config.integration;
const forced = args.includes("--current") ? "current" : args.includes("--contract") ? "contract" : null;
const hrStyle = forced === "current" ? "pull" : forced === "contract" ? "contract" : (I.hr.auth === "bearer" && I.hr.sync === "pull" ? "pull" : "contract");
const invStyle = forced === "current" ? "dialect" : forced === "contract" ? "contract" : (I.inventory.dialect === "johnvivz_inventory" ? "dialect" : "contract");

const gen = () => crypto.randomBytes(32).toString("hex");
const generated = [];
const pick = (value, name) => { if (value) return value; const v = gen(); generated.push(`${name}=${v}`); return v; };
const secrets = {
  hr: { out: hrStyle === "contract" ? pick(I.hr.secret, "JVZ_SECRET_HR") : gen(), in: hrStyle === "contract" ? pick(I.inboundSecrets.johnvivz_hr, "JVZ_CRM_INBOUND_SECRET_HR") : gen() },
  inventory: { out: invStyle === "contract" ? pick(I.inventory.secret, "JVZ_SECRET_INVENTORY") : gen(), in: invStyle === "contract" ? pick(I.inboundSecrets.johnvivz_inventory, "JVZ_CRM_INBOUND_SECRET_INVENTORY") : gen() },
  accounting: { out: pick(I.accounting.secret, "JVZ_SECRET_ACCOUNTING"), in: pick(I.inboundSecrets.johnvivz_accounting, "JVZ_CRM_INBOUND_SECRET_ACCOUNTING") },
};
const hrToken = hrStyle === "pull" ? pick(I.hr.token, "HR_API_TOKEN") : null;
const invToken = invStyle === "dialect" ? pick(I.inventory.token, "INVENTORY_API_TOKEN") : null;

// The contract fakes are started for all three (the unused ones on a free port); the dialect fakes replace HR / Inventory when chosen.
const contract = await startFakeApps({ secrets, crmBase, ports: { hr: hrStyle === "contract" ? hrPort : 0, inventory: invStyle === "contract" ? invPort : 0, accounting: accPort }, host });
const hrPull = hrStyle === "pull" ? await startFakeHrPull({ token: hrToken, port: hrPort, host }) : null;
const invDialect = invStyle === "dialect" ? await startFakeInventoryDialect({ token: invToken, port: invPort, host }) : null;
const fake = { hr: hrPull || contract.hr, inventory: invDialect || contract.inventory, accounting: contract.accounting };
const stopAll = () => Promise.all([contract.stop(), hrPull?.stop(), invDialect?.stop()]);

const shown = (port) => `http://${host === "0.0.0.0" ? "<this laptop's IP>" : host}:${port}`;
console.log("JOHNVIVZ FAKE TEAMMATES (test doubles, NOT the real apps)\n");
console.log(`  fake HR          ${shown(fake.hr.port)}   ${hrStyle === "pull" ? "JohnVivzHR style: pull API, API key, GET /ping" : "contract style (HMAC, events)"}`);
console.log(`  fake Inventory   ${shown(fake.inventory.port)}   ${invStyle === "dialect" ? "Inventory-app style: Bearer token, own events, polled outbox (products INV-1001..1003)" : "contract style (HMAC, products LIVE-P-1..4)"}`);
console.log(`  fake Accounting  ${shown(fake.accounting.port)}   contract style (HMAC both ways, like JVzPay), with the ESS login POST /auth/login`);
console.log(`  events go to CRM at ${crmBase}\n`);
console.log("CRM .env lines for these fakes (switch the modes to live one at a time):");
console.log(`  HR_API_BASE_URL=${shown(fake.hr.port)}\n  INVENTORY_API_BASE_URL=${shown(fake.inventory.port)}\n  ACCOUNTING_API_BASE_URL=${shown(fake.accounting.port)}/api/integration/v1`);
if (hrStyle === "pull") console.log("  INTEGRATION_HR_AUTH=bearer\n  INTEGRATION_HR_SYNC=pull");
if (invStyle === "dialect") console.log("  INTEGRATION_INVENTORY_AUTH=bearer\n  INTEGRATION_INVENTORY_DIALECT=johnvivz_inventory");
if (generated.length) console.log(`\nThese values were missing from CRM's .env; add them there too, then restart CRM:\n  ${generated.join("\n  ")}`);
console.log("\nType help for commands.\n");

// live log of what CRM calls
const seen = { hr: 0, inventory: 0, accounting: 0 };
setInterval(() => {
  for (const [name, app] of Object.entries(fake)) {
    for (const r of app.requests.slice(seen[name])) console.log(`  [${name}] ${r.method} ${r.path} -> ${r.status}${r.authorized ? "" : " (credentials refused)"}`);
    seen[name] = app.requests.length;
    for (const rej of app.rejected?.splice(0) || []) console.log(`  [${name}] REJECTED ${rej.envelope?.event_type || rej.body?.eventType}: ${rej.problems.join("; ")}`);
  }
}, 700).unref();

const pairsOf = (pairs) => Object.fromEntries(pairs.map((p) => { const i = p.indexOf("="); const k = p.slice(0, i); const v = p.slice(i + 1); return [k, /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]; }));
const send = async (appName, type, pairs) => {
  const app = fake[appName];
  if (!app?.sendToCrm) return console.log(`  the fake ${appName} does not push events in this style${appName === "inventory" ? " (use: inv emit ...)" : appName === "hr" ? " (use: hr status ...)" : ""}`);
  const data = pairsOf(pairs);
  const envelope = { event_id: crypto.randomUUID(), event_type: type, schema_version: 1, source: app.client, occurred_at: offsetNow(), entity_id: String(data.request_id || data.employee_id || data.product_id || data.order_id || data.department_id || "x"), correlation_id: crypto.randomUUID(), idempotency_key: `${type}:${crypto.randomUUID()}`, data };
  try {
    const r = await app.sendToCrm(envelope);
    console.log(`  CRM answered ${r.status} ${r.text}`);
  } catch (err) { console.log(`  could not reach CRM at ${crmBase}: ${err.cause?.code || err.message}`); }
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "fake> " });
rl.prompt();
rl.on("line", async (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (cmd === "send" && rest.length >= 2) await send(rest[0], rest[1], rest.slice(2));
  else if (cmd === "hr" && rest[0] === "status" && rest.length >= 3 && hrPull) {
    const e = hrPull.employee(rest[1]);
    if (!e) console.log("  no such employee in the fake HR"); else { e.status = rest.slice(2).join(" "); console.log(`  ${e.permanent_employee_id || e.employee_id} is now ${e.status} in the fake HR`); }
  } else if (cmd === "ess" && rest[0] === "register" && rest.length >= 3) {
    contract.accounting.registerEss(rest[1], rest[2], { employee_id: rest[3] || null, department_code: rest[4] || "CRM", full_name: rest[1] });
    console.log(`  ${rest[1]} is registered in the fake ESS (department ${rest[4] || "CRM"})`);
  } else if (cmd === "inv" && rest[0] === "emit" && rest[1] && invDialect) { const e = invDialect.emit(rest[1], pairsOf(rest.slice(2))); console.log(`  ${e.eventId} ${e.eventType} waits in the fake Inventory outbox`); }
  else if (cmd === "events") {
    for (const a of [contract.inventory, contract.accounting, contract.hr]) for (const e of a.events) console.log(`  [${a.name}] ${e.event_type} ${e.entity_id} ${JSON.stringify(e.data).slice(0, 160)}`);
    for (const e of invDialect?.events || []) console.log(`  [inventory] ${e.eventType} ${e.orderReference || ""} ${JSON.stringify(e).slice(0, 160)}`);
  } else if (cmd === "calls") for (const a of Object.values(fake)) for (const r of a.requests.slice(-20)) console.log(`  [${a.name}] ${r.method} ${r.path} -> ${r.status}`);
  else if (cmd === "stock") {
    if (invDialect) for (const [pid, qty] of Object.entries(invDialect.stock)) console.log(`  ${pid}: ${qty} on hand, ${invDialect.reserved(pid)} reserved`);
    else for (const [pid, qty] of Object.entries(contract.inventory.stock)) console.log(`  ${pid}: ${qty} on hand, ${contract.inventory.reservedOf(pid)} reserved`);
  } else if (cmd === "quit" || cmd === "exit") { await stopAll(); process.exit(0); }
  else if (cmd) console.log("  commands: send <hr|inventory|accounting> <EventType> key=value ... | hr status <id> <HR status> | inv emit <EventType> key=value ... | ess register <email> <password> [employee_id] [dept] | events | calls | stock | quit");
  rl.prompt();
});
rl.on("close", async () => { await stopAll(); process.exit(0); });
