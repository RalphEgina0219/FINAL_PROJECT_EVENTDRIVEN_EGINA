/*
 * Adapter framework for the three connected JOHNVIVZ applications (blueprint §13).
 * Each adapter runs in one mode, set in .env:
 *   disabled — the feature is off; no calls are made and nothing is pretended.
 *   mock     — answers come from local fixtures; every stored record is flagged is_mock = 1 and
 *              nothing is ever sent to a live system.
 *   live     — real HTTP calls, authenticated per app (INTEGRATION_<APP>_AUTH): hmac = signed requests (contract §2), bearer =
 *              the app's own API token (interim dialect, contract §12). Switch a mode to live only after the other team agrees.
 * Every call (including mock and disabled) is written to integration_logs.
 */
import { sequelize } from "../../models/index.js";
import { config } from "../../config/index.js";
import crypto from "crypto";
import { signRequest, isoWithOffset } from "./signing.js";
import { AppError } from "../../helpers/errors.js";

export const SYSTEMS = {
  hr: "johnvivz_hr",
  inventory: "johnvivz_inventory",
  accounting: "johnvivz_accounting",
};

export const modeOf = (key) => config.integration[key]?.mode || "disabled";

export class IntegrationDisabledError extends Error {
  constructor(key) {
    super(`The ${SYSTEMS[key]} integration is disabled (INTEGRATION_${key.toUpperCase()}_MODE=disabled).`);
    this.status = 503;
    this.expose = true;
  }
}

// The other application did not answer in time, refused the connection or answered 5xx.
export class IntegrationUnavailableError extends AppError {
  constructor(key, detail) {
    super(`The ${SYSTEMS[key]} application could not be reached${detail ? ` (${detail})` : ""}. Please try again in a moment.`, 503);
    this.unreachable = true;
  }
}

// Live mode is switched on but the base URL or the service secret is missing from .env.
export class IntegrationNotConfiguredError extends AppError {
  constructor(key) {
    super(`The ${SYSTEMS[key]} integration is in live mode but its base URL or ${authOf(key) === "bearer" ? `API token (${key.toUpperCase()}_API_TOKEN)` : "service secret"} is not set in .env.`, 503);
  }
}

export const keyOfTarget = (target) => Object.keys(SYSTEMS).find((k) => SYSTEMS[k] === target) || null;

export const logIntegration = async ({
  direction, system, endpoint = null, method = null, eventId = null, correlationId = null,
  httpStatus = null, durationMs = null, success, mode, message = null,
}) => {
  try {
    await sequelize.query(
      `INSERT INTO integration_logs (direction, \`system\`, endpoint, http_method, event_id, correlation_id, http_status,
                                     duration_ms, success, mode, message, created_at)
       VALUES (:direction, :system, :endpoint, :method, :eventId, :correlationId, :httpStatus, :durationMs, :success, :mode, :message, NOW())`,
      {
        replacements: {
          direction, system, endpoint, method, eventId, correlationId, httpStatus, durationMs,
          success: success ? 1 : 0, mode, message: message ? String(message).slice(0, 500) : null,
        },
      }
    );
  } catch (err) {
    console.error("⚠️  Integration log not written:", err.message);
  }
};

// ---------------------------------------------------------------- authentication per app (contract §2 and the interim dialects, §12)

export const API = "/api/integration/v1";
export const authOf = (key) => (config.integration[key]?.auth === "bearer" ? "bearer" : "hmac");
export const AUTH_LABELS = { hmac: "HMAC signature", bearer: "API token (Bearer)" };
// Is the credential CRM needs to call this app set? (never returns the value itself)
export const hasCredential = (key) => Boolean(authOf(key) === "bearer" ? config.integration[key]?.token : config.integration[key]?.secret);
// What the person should check when the app refuses our call.
const TEAM = { hr: "HR", inventory: "Inventory", accounting: "Accounting" };
export const credentialHint = (key) => (authOf(key) === "bearer"
  ? `Check ${key.toUpperCase()}_API_TOKEN with the ${TEAM[key]} team.`
  : `Check the shared secret (JVZ_SECRET_${key.toUpperCase()}) with the ${TEAM[key]} team.`);
export const refusedMessage = (key, what = "") => `${TEAM[key]} rejected our ${authOf(key) === "bearer" ? "API token" : "signed request"}${what ? ` (${what})` : ""}. ${credentialHint(key)}`;

// A stable UUID made from a text (same text, same UUID): used where an app's event id must be the same on every attempt.
export const uuidFrom = (text) => {
  const h = crypto.createHash("sha256").update(String(text)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/*
 * HTTP call to another JOHNVIVZ application (live mode only). Returns { status, ok, json, text, durationMs }.
 *   hmac    X-JVZ-Client / X-JVZ-Timestamp / X-JVZ-Signature (contract §2)
 *   bearer  Authorization: Bearer <APP>_API_TOKEN (the app's own API key; interim dialect)
 * A network error or timeout throws IntegrationUnavailableError; any HTTP answer (even 4xx/5xx) is returned for the caller to judge.
 * Every call is written to integration_logs (never the secret, the token or the signature).
 */
export const signedRequest = async (key, { method = "GET", path, query = null, body = undefined, timeoutMs = 8000, headers = {}, direction = "api_call", eventId = null, correlationId = null, logMessage = null }) => {
  const cfg = config.integration[key];
  const auth = authOf(key);
  if (!cfg?.baseUrl || !hasCredential(key)) throw new IntegrationNotConfiguredError(key);
  const url = new URL(cfg.baseUrl.replace(/\/+$/, "") + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const target = url.pathname + url.search; // signed exactly as the receiver will see it
  const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = isoWithOffset();
  const credentials = auth === "bearer"
    ? { Authorization: `Bearer ${cfg.token}`, "X-JVZ-Client": config.appSource }
    : { "X-JVZ-Client": config.appSource, "X-JVZ-Timestamp": timestamp, "X-JVZ-Signature": signRequest({ secret: cfg.secret, method, path: target, timestamp, body: payload }) };
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json" } : {}),
        ...credentials,
        ...(correlationId ? { "X-Correlation-Id": correlationId } : {}),
        ...headers,
      },
      body: payload || undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000}s` : (err.cause?.code || err.message);
    await logIntegration({ direction, system: SYSTEMS[key], endpoint: target.slice(0, 250), method, eventId, correlationId, durationMs: Date.now() - started, success: false, mode: "live", message: `Not reached: ${reason}` });
    throw new IntegrationUnavailableError(key, reason);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  const durationMs = Date.now() - started;
  const why = json?.error || json?.message;
  await logIntegration({
    direction, system: SYSTEMS[key], endpoint: target.slice(0, 250), method, eventId, correlationId, httpStatus: res.status, durationMs,
    success: res.status >= 200 && res.status < 300, mode: "live", message: logMessage || (res.ok ? null : `HTTP ${res.status}${why && typeof why === "string" ? ` ${why.slice(0, 120)}` : ""}`),
  });
  return { status: res.status, ok: res.ok, json, text, durationMs };
};

// How CRM is set up to talk to an app, in words (Test connection, check:connections, Integration Health).
export const connectionStyle = (key) => {
  const cfg = config.integration[key] || {};
  const parts = [AUTH_LABELS[authOf(key)]];
  if (key === "hr") parts.push(cfg.sync === "pull" ? "pull sync every 5 minutes" : "events from HR");
  if (key === "inventory") parts.push(cfg.dialect === "johnvivz_inventory" ? "Inventory dialect (polled outbox)" : "contract");
  if (key === "accounting") parts.push(config.integration.ess?.login === "live" ? "staff sign-in through ESS (live)" : "staff sign-in: mock ESS");
  return parts.join(", ");
};

// "GET /health" on the other application (the Test connection button). An app without /health (JohnVivzHR) is asked GET /ping instead.
export const checkConnection = async (key) => {
  const mode = modeOf(key);
  const style = connectionStyle(key);
  if (mode !== "live") return { ok: false, skipped: true, mode, style, message: mode === "mock" ? "Mock mode: nothing to connect to." : "Disabled: no calls are made." };
  try {
    // The Inventory app (interim dialect) gives CRM its own token for its CRM routes only and documents no /health or /ping:
    // one product read proves the address and the token, and CRM never calls a route outside the CRM integration.
    const inventoryDialect = key === "inventory" && config.integration.inventory.dialect === "johnvivz_inventory";
    let path = inventoryDialect ? `${API}/products?limit=1` : `${API}/health`;
    let res = await signedRequest(key, { method: "GET", path, timeoutMs: 5000 });
    if (res.status === 404 && !inventoryDialect) { path = `${API}/ping`; res = await signedRequest(key, { method: "GET", path, timeoutMs: 5000 }); }
    const refused = res.status === 401 || res.status === 403;
    return {
      ok: res.status === 200, mode, style, status: res.status,
      message: res.status === 200
        ? `${SYSTEMS[key]} answered ${res.status} at ${path.replace(API, "")} in ${res.durationMs} ms (${style})`
        : `${SYSTEMS[key]} answered ${res.status} at ${path.replace(API, "")} (${style})${refused ? `: it rejected our ${authOf(key) === "bearer" ? "API token" : "signature"}. ${credentialHint(key)}` : ""}`,
    };
  } catch (err) {
    return { ok: false, mode, style, message: `${err.message} (${style})` };
  }
};
