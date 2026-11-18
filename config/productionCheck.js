// Checks run when the server starts with NODE_ENV=production (P10). Errors stop the start; warnings are printed.
// docs/DEPLOYMENT.md lists the matching .env values.
export const productionProblems = (config) => {
  const errors = [];
  const warnings = [];
  if (config.env !== "production") return { errors, warnings };
  if (!config.session.secret || config.session.secret === "xianfire-secret-key" || config.session.secret.length < 32) {
    errors.push("SESSION_SECRET must be a random value of at least 32 characters (node scripts/generate-secrets.mjs prints good ones).");
  }
  if (config.showDemoLogins) errors.push("SHOW_DEMO_LOGINS must be false in production (the login page would list the demo accounts and their password).");
  if (config.db.name === "johnvivz_tech") errors.push("DB_NAME must not be johnvivz_tech (the old database).");
  if (config.mail.transport === "log") warnings.push("MAIL_TRANSPORT=log: verification and password-reset emails are NOT delivered. Set MAIL_TRANSPORT=smtp and the SMTP_* values.");
  if (!config.session.secureCookie) warnings.push("COOKIE_SECURE is false: set it to true once the site is served over HTTPS.");
  for (const key of ["hr", "inventory", "accounting"]) {
    const i = config.integration[key];
    const K = key.toUpperCase();
    const credential = i.auth === "bearer" ? i.token : i.secret;
    if (i.mode === "live" && (!i.baseUrl || !credential)) errors.push(`INTEGRATION_${K}_MODE=live needs ${K}_API_BASE_URL and ${i.auth === "bearer" ? `${K}_API_TOKEN (INTEGRATION_${K}_AUTH=bearer)` : `JVZ_SECRET_${K}`}.`);
    if (i.mode === "live" && i.auth === "bearer") warnings.push(`INTEGRATION_${K}_AUTH=bearer: an interim API token, not the signed requests of the contract (no replay protection). Use HTTPS between the apps.`);
    if (i.mode === "mock") warnings.push(`INTEGRATION_${key.toUpperCase()}_MODE=mock: ${key} data is MOCK (fine for a demo, not for real operations).`);
  }
  // employee account flow: staff sign in through JVzPay ESS
  if (config.integration.ess?.login === "live" && (!config.integration.accounting.baseUrl || !(config.integration.accounting.auth === "bearer" ? config.integration.accounting.token : config.integration.accounting.secret))) {
    errors.push("INTEGRATION_ESS_LOGIN=live needs ACCOUNTING_API_BASE_URL and the Accounting credential (JVZ_SECRET_ACCOUNTING): staff sign in through JVzPay.");
  }
  if (config.integration.ess?.login === "mock") warnings.push("INTEGRATION_ESS_LOGIN=mock: staff created from HR sign in with the MOCK ESS registry, not real ESS passwords.");
  return { errors, warnings };
};
