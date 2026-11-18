/*
 * Shared test harness (used by tests/p2.acceptance.mjs): throwaway database, migrations, demo seed,
 * fixtures, a real server process and a small cookie + CSRF HTTP client.
 * The database name must end with _test and can never be johnvivz_crm_db or johnvivz_tech.
 */
import { spawn, spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
process.loadEnvFile?.(path.join(root, ".env"));

export const PASSWORD = "Demo@1234";
export const results = [];
export const check = (id, name, ok, detail = "") => {
  results.push({ id, name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✅" : "❌"} ${id.padEnd(8)} ${name}${!ok && detail ? `\n          → ${detail}` : ""}`);
};

export class Client {
  constructor(base) { this.base = base; this.cookies = {}; this.csrf = null; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; "); }
  store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      this.cookies[pair.slice(0, i)] = pair.slice(i + 1);
    }
  }
  async get(url) {
    const res = await fetch(this.base + url, { headers: { cookie: this.cookieHeader() }, redirect: "manual" });
    this.store(res);
    const isHtml = res.headers.get("content-type")?.includes("text/html");
    const body = isHtml ? await res.text() : Buffer.from(await res.arrayBuffer());
    if (typeof body === "string") {
      const m = body.match(/name="_csrf" value="([a-f0-9]+)"/);
      if (m) this.csrf = m[1];
    }
    return { status: res.status, body, location: res.headers.get("location"), type: res.headers.get("content-type") || "" };
  }
  async post(url, data = {}, { csrf = true } = {}) {
    const body = new URLSearchParams({ ...data, ...(csrf ? { _csrf: this.csrf } : {}) });
    const res = await fetch(this.base + url, { method: "POST", headers: { cookie: this.cookieHeader(), "content-type": "application/x-www-form-urlencoded" }, body, redirect: "manual" });
    this.store(res);
    return { status: res.status, location: res.headers.get("location"), body: await res.text() };
  }
  async login(email, password = PASSWORD) {
    await this.get("/login");
    return this.post("/login", { email, password });
  }
}

export const startEnvironment = async ({ dbName, port, extraEnv = {}, serverEnv = {}, fixtures = true }) => {
  if (!/^[a-z0-9_]+_test$/i.test(dbName) || ["johnvivz_crm_db", "johnvivz_tech"].includes(dbName.toLowerCase())) {
    throw new Error(`Refusing to use "${dbName}": the test database name must end with _test.`);
  }
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, DB_NAME: dbName, PORT: String(port), LOGIN_RATE_LIMIT_MAX: "1000", DISABLE_SCHEDULER: "1",
    INTEGRATION_HR_MODE: "mock", SHOW_DEMO_LOGINS: "true", MAIL_TRANSPORT: "log", APP_URL: base, NODE_ENV: "development",
    // the contract style unless a test asks for an interim dialect (the local .env may be set for the teammates' current apps)
    INTEGRATION_HR_AUTH: "hmac", INTEGRATION_INVENTORY_AUTH: "hmac", INTEGRATION_ACCOUNTING_AUTH: "hmac", INTEGRATION_HR_SYNC: "events", INTEGRATION_INVENTORY_DIALECT: "contract",
    HR_API_TOKEN: "", INVENTORY_API_TOKEN: "", ACCOUNTING_API_TOKEN: "", INTEGRATION_ESS_LOGIN: "mock", CRM_DEPARTMENT_CODE: "CRM", ...extraEnv,
  };
  const node = (args, more = {}) => spawnSync(process.execPath, args, { cwd: root, env: { ...env, ...more }, encoding: "utf8" });
  const admin = await mysql.createConnection({ host: process.env.DB_HOST || "localhost", port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || "root", password: process.env.DB_PASSWORD || "" });
  await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.changeUser({ database: dbName });

  const steps = {};
  steps.migrate = node(["migrate.js", "up", "--quiet"]);
  steps.seed = node(["seeders/index.js"]);
  let fix = {};
  if (fixtures) {
    steps.fixtures = node(["tests/support/p1Fixtures.mjs"]);
    if (steps.fixtures.status === 0) fix = JSON.parse(steps.fixtures.stdout.trim().split("\n").pop());
  }
  const server = spawn(process.execPath, ["index.js"], { cwd: root, env: { ...env, ...serverEnv }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 160 && !log.includes("running at") && server.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250));
  const up = log.includes("running at");
  const stop = async () => {
    server.kill();
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.end();
  };
  return {
    base, env, db: admin, node, steps, fix, up, serverLog: () => log, stop,
    one: async (sql, params = []) => (await admin.query(sql, params))[0][0],
    all: async (sql, params = []) => (await admin.query(sql, params))[0],
    client: () => new Client(base),
    as: async (email, password = PASSWORD) => { const c = new Client(base); c.lastLogin = await c.login(email, password); return c; },
  };
};

export const summarize = (dbName) => {
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Test database ${dbName} was dropped.`);
  if (failed.length) process.exitCode = 1;
  return failed.length === 0;
};
