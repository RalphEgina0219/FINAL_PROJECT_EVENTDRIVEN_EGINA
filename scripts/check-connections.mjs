#!/usr/bin/env node
/*
 * JOHNVIVZ merge kit — check every connection CRM has, in both directions, and say in plain words what is wrong.
 *
 *   node scripts/check-connections.mjs                 uses CRM's .env (base URLs, secrets, API tokens, interim dialects)
 *   node scripts/check-connections.mjs --crm http://127.0.0.1:3000   CRM's own address for the "app -> CRM" checks (default APP_URL)
 *   node scripts/check-connections.mjs --only hr       check one app
 *
 * Each app is checked the way CRM is set to talk to it (INTEGRATION_<APP>_AUTH, INTEGRATION_HR_SYNC, INTEGRATION_INVENTORY_DIALECT):
 *   1. CRM -> app reachable     GET {base}/api/integration/v1/health without credentials (GET /ping when the app has no /health)
 *   2. clock difference         from the app's Date header (HMAC only: more than 5 minutes = every signed call is refused)
 *   3. CRM -> app authenticated GET /health (or /ping): signed with JVZ_SECRET_<APP> (hmac) or sent with <APP>_API_TOKEN (bearer)
 *   4. hmac:   CRM -> app signed POST /test/echo — the app must answer the SHA-256 of the body it received
 *      HR pull:            GET /employees?page_size=1 and GET /departments answer in JohnVivzHR's format
 *      Inventory dialect:  GET /products?limit=1 and GET /crm/outbox answer (read only: nothing is acknowledged)
 *   5. app -> CRM               CRM's own /health, signed as the app (JVZ_CRM_INBOUND_SECRET_<APP>) or with the app's API token (CRM must be running)
 * Each line says OK or FAILED with the reason: not running, wrong URL / IP / port, firewall, bad signature or token, clock difference, endpoint
 * missing, or CRM has that app in mock/disabled mode. Exit code 1 if anything failed. Secrets and tokens are never printed.
 */
import crypto from "crypto";
import { config, apiBase } from "../config/index.js";
import { signRequest, isoWithOffset } from "../services/integration/signing.js";
import { connectionStyle } from "../services/integration/adapterBase.js";

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const crmBase = arg("--crm", config.integration?.crmBaseUrl || process.env.APP_URL || `http://127.0.0.1:${config.port}`).replace(/\/+$/, "");
const only = arg("--only", null);
const APPS = [["hr", "HR", "johnvivz_hr"], ["inventory", "INVENTORY", "johnvivz_inventory"], ["accounting", "ACCOUNTING", "johnvivz_accounting"]].filter(([k]) => !only || only === k);
const API = "/api/integration/v1";
const results = [];
const say = (ok, app, what, why = "") => { results.push(ok); console.log(`${ok ? "  OK    " : "  FAILED"} ${app.padEnd(11)} ${what}${why ? ` — ${why}` : ""}`); };
const info = (app, what) => console.log(`  info   ${app.padEnd(11)} ${what}`);

const networkReason = (err, url) => {
  const code = err.cause?.code || err.cause?.errors?.[0]?.code || err.code || err.name;
  const u = new URL(url);
  if (err.cause?.message === "bad port") return `BLOCKED PORT: port ${u.port} is on the list that Node and browsers refuse to call; give the app another port (for example 4000, 5000 or 7000)`;
  if (code === "ECONNREFUSED") return `NOT RUNNING: nothing listens at ${u.host} (start the app, check the port number)`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `WRONG URL: the host "${u.hostname}" does not exist (check the IP address in the base URL)`;
  if (code === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return `NO ANSWER from ${u.host} within 5 s (wrong IP, other Wi-Fi network, or the Windows firewall blocks the port)`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `CANNOT REACH ${u.hostname} (not on the same network?)`;
  return `${code || err.message}`;
};

// auth: null (none) | { secret, client } (HMAC) | { token, client } (bearer)
const call = async (url, { method = "GET", body = "", auth = null, timestamp = isoWithOffset() } = {}) => {
  const u = new URL(url);
  const target = u.pathname + u.search;
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (auth?.secret) Object.assign(headers, { "X-JVZ-Client": auth.client, "X-JVZ-Timestamp": timestamp, "X-JVZ-Signature": signRequest({ secret: auth.secret, method, path: target, timestamp, body }) });
  if (auth?.token) Object.assign(headers, { Authorization: `Bearer ${auth.token}`, "X-JVZ-Client": auth.client });
  const res = await fetch(url, { method, headers, body: body || undefined, signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, date: res.headers.get("date") };
};

const authReason = (r, bearer) => {
  if (r.status === 200) return null;
  if (r.status === 401 && r.json?.error === "stale_timestamp") return "CLOCK DIFFERENCE: the other laptop's clock (or time zone) is more than 5 minutes off; set both to automatic time";
  if (r.status === 401 && bearer) return "BAD TOKEN: the API token was refused (the two .env files do not hold the same token, or the key was revoked)";
  if (r.status === 401) return "BAD SIGNATURE: the two .env files do not hold the same secret for this direction (or the app signs a different path / body)";
  if (r.status === 403) return "REFUSED (403): this endpoint is not allowed for that app";
  if (r.status === 404) return "ENDPOINT MISSING (404): the app does not offer it yet (docs/integration-contract.md), or the base URL has a wrong path";
  if (r.status === 503 && r.json?.error === "integration_not_live") return "CRM has this app in mock or disabled mode: set INTEGRATION_<APP>_MODE=live in CRM's .env and restart CRM";
  return `HTTP ${r.status}${r.json?.error ? ` (${r.json.error})` : r.json?.message ? ` (${r.json.message})` : ""}`;
};
const signedReason = (r) => authReason(r, false);

// GET /health, or /ping when the app answers 404 for /health (JohnVivzHR)
// (the Inventory app's dialect documents neither, so there one product read stands in for it)
const health = async (base, auth, key = null) => {
  if (key === "inventory" && config.integration.inventory.dialect === "johnvivz_inventory") {
    // Inventory's CRM token covers its CRM integration routes only: never probe /health or /ping there
    const q = await call(`${base}${API}/products?limit=1`, { auth });
    return { ...q, path: "/products?limit=1" };
  }
  const r = await call(`${base}${API}/health`, { auth });
  if (r.status !== 404) return { ...r, path: "/health" };
  const p = await call(`${base}${API}/ping`, { auth });
  if (p.status !== 404) return { ...p, path: "/ping" };
  return { ...p, path: "/health" };
};
const unwrap = (json) => (json && typeof json === "object" && !Array.isArray(json) && json.data !== undefined ? json.data : json);
const listIn = (data) => (Array.isArray(data) ? data : ["items", "products", "events"].map((k) => data?.[k]).find(Array.isArray) || null);

console.log(`JOHNVIVZ merge kit: connection check (CRM at ${crmBase}, max clock skew ${config.integration.maxClockSkewSeconds} s)\n`);
for (const [key, KEY, client] of APPS) {
  const cfg = config.integration[key];
  const name = key.toUpperCase();
  const bearer = cfg.auth === "bearer";
  info(name, `mode in CRM: ${cfg.mode}${cfg.mode !== "live" ? " (nothing is sent while it is not live; the checks still work)" : ""}`);
  info(name, `connects with: ${connectionStyle(key)}`);
  if (!cfg.baseUrl) { say(false, name, "CRM -> app", `no ${KEY}_API_BASE_URL in CRM's .env`); continue; }
  const base = apiBase(cfg.baseUrl);
  // 1. reachable (+ 2. clock)
  let reachable = false;
  try {
    const r = await health(base, null, key);
    reachable = true;
    say(true, name, `reachable at ${base}`, `answered HTTP ${r.status} at ${r.path}`);
    if (r.date) {
      const diff = Math.round((Date.parse(r.date) - Date.now()) / 1000);
      const okClock = Math.abs(diff) <= Math.min(60, config.integration.maxClockSkewSeconds);
      if (Math.abs(diff) > config.integration.maxClockSkewSeconds) {
        if (bearer) info(name, `clock differs by ${diff} s (API tokens do not depend on the clock, but set both laptops to automatic time)`);
        else say(false, name, "clock", `CLOCK DIFFERENCE of ${diff} s (more than ${config.integration.maxClockSkewSeconds} s: every signed call will be refused)`);
      } else if (!okClock) info(name, `clock differs by ${diff} s (allowed, but set both laptops to automatic time)`);
      else say(true, name, "clock", `${diff} s difference`);
    }
  } catch (err) {
    say(false, name, `CRM -> app at ${base}`, networkReason(err, `${base}${API}/health`));
  }
  if (!reachable) continue;
  // 3. authenticated GET
  const auth = bearer ? { token: cfg.token, client: config.appSource } : { secret: cfg.secret, client: config.appSource };
  if (bearer && !cfg.token) say(false, name, "CRM -> app GET with API token", `no ${KEY}_API_TOKEN in CRM's .env (INTEGRATION_${KEY}_AUTH=bearer)`);
  else if (!bearer && !cfg.secret) say(false, name, "signed GET /health", `no JVZ_SECRET_${KEY} in CRM's .env`);
  else {
    const r = await health(base, auth, key).catch((e) => ({ status: 0, error: e, path: "/health" }));
    const why = r.status === 0 ? networkReason(r.error, base) : authReason(r, bearer);
    say(!why, name, `CRM -> app ${bearer ? "GET with API token" : "signed GET"} ${r.path}`, why || (bearer ? "the app accepted CRM's API token" : "the app accepted CRM's signature"));
    // 4. a call that proves the rest of the dialect
    if (!bearer) {
      const body = JSON.stringify({ check: "JOHNVIVZ merge kit", at: new Date().toISOString(), nonce: crypto.randomUUID() });
      const e = await call(`${base}${API}/test/echo`, { method: "POST", body, auth }).catch((err) => ({ status: 0, error: err }));
      const expected = crypto.createHash("sha256").update(body).digest("hex");
      // the contract names the field received_sha256; JVzPay (Accounting) answers body_sha256 — both are accepted
      const got = e.json?.received_sha256 ?? e.json?.body_sha256 ?? e.json?.data?.received_sha256 ?? e.json?.data?.body_sha256;
      const eWhy = e.status === 0 ? networkReason(e.error, base) : signedReason(e) || (!got ? "the app answered 200, but without received_sha256 (or body_sha256) in its answer" : got !== expected ? "the app answered, but with a different SHA-256 of the body (it signs or reads the body differently)" : null);
      say(!eWhy, name, "CRM -> app signed POST /test/echo", eWhy || "the body arrived unchanged");
    } else info(name, "signed POST /test/echo skipped: the API-token dialect has no echo endpoint");
    // staff sign-in through ESS (JVzPay /auth/login): a made-up account must be refused with 401, which proves the endpoint and the signature
    if (key === "accounting" && config.integration.ess.login === "live") {
      const body = JSON.stringify({ email: `check-connections-${crypto.randomUUID().slice(0, 8)}@invalid.test`, password: crypto.randomBytes(12).toString("hex") });
      const r = await call(`${base}${API}/auth/login`, { method: "POST", body, auth }).catch((err) => ({ status: 0, error: err }));
      const why = r.status === 0 ? networkReason(r.error, base)
        : r.status === 401 && (r.json?.error === "invalid_credentials" || !r.json?.error) ? null
        : r.status === 401 ? authReason(r, bearer)
        : r.status === 404 ? "ENDPOINT MISSING (404): JVzPay does not offer POST /auth/login at this base URL"
        : `HTTP ${r.status} (expected 401 invalid_credentials for a made-up account)`;
      say(!why, name, "ESS login POST /auth/login (made-up account)", why || "answered 401 invalid_credentials, as expected: staff sign-in through ESS can work");
    } else if (key === "accounting") info(name, `ESS login: ${config.integration.ess.login} (staff sign-in through JVzPay is checked only when INTEGRATION_ESS_LOGIN=live)`);
    if (key === "hr" && cfg.sync === "pull") {
      const emp = await call(`${base}${API}/employees?page=1&page_size=1`, { auth }).catch((err) => ({ status: 0, error: err }));
      const items = emp.json?.success !== false ? listIn(unwrap(emp.json)) : null;
      const eWhy = emp.status === 0 ? networkReason(emp.error, base) : authReason(emp, bearer) || (!items ? "the answer is not {success, data:{items, page, total_pages}} (JohnVivzHR's format)" : null);
      say(!eWhy, name, "HR pull GET /employees", eWhy || `JohnVivzHR format, ${unwrap(emp.json)?.total ?? "?"} employee(s) in HR`);
      const dep = await call(`${base}${API}/departments`, { auth }).catch((err) => ({ status: 0, error: err }));
      const deps = dep.json?.success !== false ? listIn(unwrap(dep.json)) : null;
      const dWhy = dep.status === 0 ? networkReason(dep.error, base) : authReason(dep, bearer) || (!deps ? "the answer has no list of departments" : null);
      say(!dWhy, name, "HR pull GET /departments", dWhy || `${deps.length} department(s)`);
    }
    if (key === "inventory" && cfg.dialect === "johnvivz_inventory") {
      const pr = await call(`${base}${API}/products?limit=1&offset=0`, { auth }).catch((err) => ({ status: 0, error: err }));
      const list = pr.json?.success !== false ? listIn(unwrap(pr.json)) : null;
      const pWhy = pr.status === 0 ? networkReason(pr.error, base) : authReason(pr, bearer) || (!list ? "the answer has no list of products" : null);
      say(!pWhy, name, "Inventory dialect GET /products", pWhy || "products answer");
      const ob = await call(`${base}${API}/crm/outbox`, { auth }).catch((err) => ({ status: 0, error: err }));
      const evs = ob.json?.success !== false ? listIn(unwrap(ob.json)) : null;
      const oWhy = ob.status === 0 ? networkReason(ob.error, base) : authReason(ob, bearer) || (!evs ? "the answer has no list of events" : null);
      say(!oWhy, name, "Inventory dialect GET /crm/outbox", oWhy || `${evs.length} event(s) waiting for CRM (read only, nothing acknowledged)`);
    }
  }
  // 5. the other direction: app -> CRM
  const inbound = bearer ? (cfg.token ? { token: cfg.token, client } : null) : (config.integration.inboundSecrets[client] ? { secret: config.integration.inboundSecrets[client], client } : null);
  if (!inbound) { say(false, name, "app -> CRM", bearer ? `no ${KEY}_API_TOKEN in CRM's .env` : `no JVZ_CRM_INBOUND_SECRET_${KEY} in CRM's .env`); continue; }
  try {
    const r = await call(`${crmBase}${API}/health`, { auth: inbound });
    const why = authReason(r, bearer);
    say(!why, name, `app -> CRM ${bearer ? "GET with API token" : "signed GET"} ${crmBase}${API}/health`, why || (bearer ? "CRM accepts this app's API token" : "CRM accepts this app's signature"));
  } catch (err) {
    say(false, name, `app -> CRM at ${crmBase}`, `${networkReason(err, `${crmBase}${API}/health`)} (is CRM running? pass --crm http://<CRM IP>:<port>)`);
  }
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${failed ? `${failed} check(s) FAILED. Fix them from the top: an early failure causes the later ones.` : "Every check passed."}`);
process.exitCode = failed ? 1 : 0; // not process.exit(): on Windows that can abort while fetch sockets are still closing
