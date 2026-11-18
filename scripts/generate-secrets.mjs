#!/usr/bin/env node
/*
 * JOHNVIVZ merge kit — generate the HMAC secrets for connecting CRM with HR, Inventory and Accounting.
 *
 *   node scripts/generate-secrets.mjs                      print the .env lines for every team (nothing is saved)
 *   node scripts/generate-secrets.mjs --crm-url http://192.168.1.10:3000 --hr-url http://192.168.1.11:4000 ...
 *                                                          also fill in the base URLs
 *   node scripts/generate-secrets.mjs --write              also save one file per team in ./merge-kit-secrets/ (git-ignored)
 *
 * There are TWO secrets per app pair, one for each direction (docs/integration-contract.md §2):
 *   CRM -> app   CRM signs with it, the app checks with it          CRM: JVZ_SECRET_<APP>
 *   app -> CRM   the app signs with it, CRM checks with it          CRM: JVZ_CRM_INBOUND_SECRET_<APP>
 * Each secret is 32 random bytes from the operating system's secure generator (crypto.randomBytes), written as 64 hex characters.
 * Share each team's block privately (in person, or a private message to that team only). Never put a secret in Git, a screenshot,
 * a group chat or a document. Run this ONCE for the merge and give every team the same run's values.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const secret = () => crypto.randomBytes(32).toString("hex");

const urls = {
  crm: arg("--crm-url", "http://<CRM laptop IP>:3000"),
  hr: arg("--hr-url", "http://<HR laptop IP>:<HR port>"),
  inventory: arg("--inventory-url", "http://<Inventory laptop IP>:<Inventory port>"),
  accounting: arg("--accounting-url", "http://<Accounting laptop IP>:<Accounting port>"),
};
const APPS = [["hr", "HR", "johnvivz_hr"], ["inventory", "INVENTORY", "johnvivz_inventory"], ["accounting", "ACCOUNTING", "johnvivz_accounting"]];
const pairs = Object.fromEntries(APPS.map(([key]) => [key, { crmToApp: secret(), appToCrm: secret() }]));

const blocks = {};
blocks.crm = [
  "# ---- JOHNVIVZ CRM .env (CRM team only) ----",
  ...APPS.flatMap(([key, KEY]) => [
    `${KEY}_API_BASE_URL=${urls[key]}`,
    `JVZ_SECRET_${KEY}=${pairs[key].crmToApp}`,
    `JVZ_CRM_INBOUND_SECRET_${KEY}=${pairs[key].appToCrm}`,
  ]),
  "JVZ_MAX_CLOCK_SKEW_SECONDS=300",
  "# keep INTEGRATION_HR_MODE / INVENTORY_MODE / ACCOUNTING_MODE = mock until you switch ONE of them on (docs/MERGE-GUIDE.md, step 6)",
].join("\n");
for (const [key, KEY, client] of APPS) {
  blocks[key] = [
    `# ---- for the JOHNVIVZ ${KEY} team only (put these in YOUR app's configuration; the names on the left are suggestions) ----`,
    `CRM_BASE_URL=${urls.crm}`,
    `# your app's client name in the X-JVZ-Client header when it calls CRM:`,
    `JVZ_CLIENT_NAME=${client}`,
    `# check requests FROM CRM with this secret (CRM sends X-JVZ-Client: johnvivz_crm):`,
    `JVZ_SECRET_FROM_CRM=${pairs[key].crmToApp}`,
    `# sign requests TO CRM with this secret:`,
    `JVZ_SECRET_TO_CRM=${pairs[key].appToCrm}`,
  ].join("\n");
}

console.log("JOHNVIVZ merge kit: new HMAC secrets (64 hex characters each, two per app pair).");
console.log("Give each block ONLY to its team, privately. Never commit them or post them in a group chat.\n");
for (const b of Object.values(blocks)) console.log(`${b}\n`);

if (args.includes("--write")) {
  const dir = path.resolve("merge-kit-secrets");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.txt"), "Secrets for one merge. Delete this folder after every team has copied its file. It is listed in .gitignore.\n");
  for (const [team, b] of Object.entries(blocks)) fs.writeFileSync(path.join(dir, `${team}.env.txt`), `${b}\n`, { mode: 0o600 });
  const gi = path.resolve(".gitignore");
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  if (!cur.split(/\r?\n/).includes("merge-kit-secrets/")) fs.appendFileSync(gi, `${cur.endsWith("\n") || !cur ? "" : "\n"}merge-kit-secrets/\n`);
  console.log(`Saved one file per team in ${dir} (git-ignored). Delete the folder once every team has its file.`);
}
