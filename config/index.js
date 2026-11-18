/*
 * JOHNVIVZ CRM — application configuration.
 * Values come from .env (loaded with Node's built-in loader); shell variables win over the file.
 * Every value has a fallback so the app still starts on a fresh Laragon install.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(projectRoot, ".env");

if (fs.existsSync(envFile) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envFile);
}

const str = (name, fallback) => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
};

const int = (name, fallback) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const bool = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

// Adapter mode for each connected application: disabled (no calls), mock (local fixture,
// records flagged is_mock, never sent to a live system) or live (real signed API calls).
const MODES = ["disabled", "mock", "live"];
const mode = (name, fallback) => {
  const value = str(name, fallback).toLowerCase();
  return MODES.includes(value) ? value : fallback;
};

// Interim dialects (docs/integration-contract.md §12): how CRM talks to each app until it follows the contract.
const choice = (name, allowed, fallback) => {
  const value = str(name, fallback).toLowerCase();
  return allowed.includes(value) ? value : fallback;
};
// A base URL may be given with or without the /api/integration/v1 suffix (the Accounting guide says to include it).
export const apiBase = (url) => String(url || "").trim().replace(/\/+$/, "").replace(/\/api\/integration\/v1$/i, "").replace(/\/+$/, "");
const app = (KEY, extra = {}) => ({
  mode: mode(`INTEGRATION_${KEY}_MODE`, "mock"),
  auth: choice(`INTEGRATION_${KEY}_AUTH`, ["hmac", "bearer"], "hmac"), // hmac = contract §2; bearer = the app's API token
  baseUrl: apiBase(str(`${KEY}_API_BASE_URL`, "")),
  secret: str(`JVZ_SECRET_${KEY}`, ""),
  token: str(`${KEY}_API_TOKEN`, ""), // bearer only; never logged or shown
  ...extra,
});

export const config = {
  projectRoot,
  env: str("NODE_ENV", "development"),
  port: int("PORT", 3000),
  appName: "JOHNVIVZ CRM",
  appSource: "johnvivz_crm", // `source` value in every event envelope
  timezone: str("APP_TIMEZONE", "Asia/Manila"),

  db: {
    host: str("DB_HOST", "localhost"),
    port: int("DB_PORT", 3306),
    name: str("DB_NAME", "johnvivz_crm_db"),
    user: str("DB_USER", "root"),
    password: process.env.DB_PASSWORD ?? "",
    timezone: str("DB_TIMEZONE", "+08:00"),
    logging: bool("DB_LOGGING", false),
  },

  session: {
    secureCookie: bool("COOKIE_SECURE", false), // true once the site runs over HTTPS (P10, docs/DEPLOYMENT.md)
    trustProxy: bool("TRUST_PROXY", false), // true behind a reverse proxy (nginx, IIS, Caddy) that terminates HTTPS
    secret: str("SESSION_SECRET", "xianfire-secret-key"),
    maxAgeHours: int("SESSION_MAX_AGE_HOURS", 8),
  },

  // Fallbacks only. The live values are stored in crm_settings / service_targets and are
  // edited by the CRM Manager (Settings) or the setup System Administrator.
  cases: {
    autoCloseDays: int("AUTO_CLOSE_DAYS", 3),
    reopenWindowDays: int("REOPEN_WINDOW_DAYS", 7),
  },
  sla: {
    firstResponseHours: {
      urgent: int("SLA_FIRST_RESPONSE_HOURS_URGENT", 1),
      high: int("SLA_FIRST_RESPONSE_HOURS_HIGH", 4),
      medium: int("SLA_FIRST_RESPONSE_HOURS_MEDIUM", 8),
      low: int("SLA_FIRST_RESPONSE_HOURS_LOW", 24),
    },
    resolutionHours: {
      urgent: int("SLA_RESOLUTION_HOURS_URGENT", 4),
      high: int("SLA_RESOLUTION_HOURS_HIGH", 24),
      medium: int("SLA_RESOLUTION_HOURS_MEDIUM", 48),
      low: int("SLA_RESOLUTION_HOURS_LOW", 72),
    },
  },

  integration: {
    // sync: events = HR pushes events (contract); pull = CRM reads HR's /employees and /departments every 5 minutes (JohnVivzHR today)
    hr: app("HR", { sync: choice("INTEGRATION_HR_SYNC", ["events", "pull"], "events") }),
    // dialect: contract (§4–§6) or johnvivz_inventory (the Inventory app's own event names, fields and polled outbox)
    inventory: app("INVENTORY", { dialect: choice("INTEGRATION_INVENTORY_DIALECT", ["contract", "johnvivz_inventory"], "contract") }),
    accounting: app("ACCOUNTING"),
    // Staff sign-in through ESS (JVzPay POST /auth/login, signed with the Accounting HMAC secret). mock = the local mock ESS registry
    // (setup page) plus the demo accounts' CRM passwords; live = every staff sign-in goes to JVzPay (contract §12.5).
    ess: { login: choice("INTEGRATION_ESS_LOGIN", ["mock", "live"], "mock") },
    // Secrets other apps use to sign events they send to CRM (one per app).
    inboundSecrets: {
      johnvivz_hr: str("JVZ_CRM_INBOUND_SECRET_HR", ""),
      johnvivz_inventory: str("JVZ_CRM_INBOUND_SECRET_INVENTORY", ""),
      johnvivz_accounting: str("JVZ_CRM_INBOUND_SECRET_ACCOUNTING", ""),
    },
    maxClockSkewSeconds: int("JVZ_MAX_CLOCK_SKEW_SECONDS", 300),
  },

  // Staff accounts are created from HR for employees of this department (fallback; the CRM Manager can change it in Settings).
  staff: { departmentCode: str("CRM_DEPARTMENT_CODE", "CRM") },

  features: {
    // ESS approval queue (leave, attendance correction, overtime). Data model exists; the queue
    // stays off until the HR/ESS contract is confirmed by the teams.
    approvalsEnabled: bool("APPROVALS_ENABLED", false),
  },

  uploads: {
    dir: path.resolve(projectRoot, str("ATTACHMENTS_DIR", "storage/attachments")),
    maxFileSizeBytes: 5 * 1024 * 1024,
    maxFiles: 3,
  },

  showDemoLogins: bool("SHOW_DEMO_LOGINS", str("NODE_ENV", "development") !== "production"), // never on by default in production

  // Public address used in email links. Set APP_URL when the CRM is not served on localhost.
  appUrl: str("APP_URL", `http://localhost:${int("PORT", 3000)}`).replace(/\/+$/, ""),

  // Email: "log" keeps every message in the mail_outbox table and sends nothing (development, tests).
  // "smtp" sends through the SMTP server named below (any free provider or a local relay). No paid API is required.
  mail: {
    transport: str("MAIL_TRANSPORT", "log").toLowerCase() === "smtp" ? "smtp" : "log",
    from: str("MAIL_FROM", "JOHNVIVZ CRM <no-reply@johnvivz.test>"),
    smtp: {
      host: str("SMTP_HOST", ""),
      port: int("SMTP_PORT", 587),
      secure: bool("SMTP_SECURE", false),
      user: str("SMTP_USER", ""),
      password: process.env.SMTP_PASSWORD ?? "",
    },
  },

  // Lifetime of one-time email links.
  tokens: {
    verifyHours: int("VERIFY_TOKEN_HOURS", 48),
    resetMinutes: int("RESET_TOKEN_MINUTES", 60),
    inviteHours: int("INVITE_TOKEN_HOURS", 72),
  },

};

// Production checks (session secret, demo logins, mail, integration settings) run when the server starts: config/productionCheck.js
