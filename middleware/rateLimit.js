/*
 * Simple in-memory rate limiter (no external package). Counts requests per key in a fixed window.
 * Limits reset when the server restarts; fine for a single-server deployment.
 */
export const rateLimit = ({ windowMs, max, key = (req) => req.ip, onLimit }) => {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of hits) if (entry.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 10 * 60 * 1000));
  timer.unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const minutes = Math.ceil((entry.reset - now) / 60000);
      res.status(429);
      if (onLimit) return onLimit(req, res, minutes);
      return res.render("error", { title: "Too many requests", status: 429, message: `Too many attempts. Try again in ${minutes} minute(s).` });
    }
    next();
  };
};

// LOGIN_RATE_LIMIT_MAX can be raised for automated test runs; the default is 10 per 15 minutes.
const loginMax = Number.parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) > 0 ? Number.parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) : 10;

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: loginMax,
  key: (req) => `login:${req.ip}`,
  onLimit: (req, res, minutes) =>
    res.render("login", { title: "Sign in", error: `Too many sign-in attempts. Try again in ${minutes} minute(s).`, email: "" }),
});

// Per email as well as per address, so one account cannot be guessed at from many addresses (staff ESS sign-ins included).
const loginEmailMax = Number.parseInt(process.env.LOGIN_EMAIL_RATE_LIMIT_MAX, 10) > 0 ? Number.parseInt(process.env.LOGIN_EMAIL_RATE_LIMIT_MAX, 10) : Math.max(10, loginMax);
export const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: loginEmailMax,
  key: (req) => `login-email:${String(req.body?.email || "").trim().toLowerCase().slice(0, 254)}`,
  onLimit: (req, res, minutes) =>
    res.render("login", { title: "Sign in", error: `Too many sign-in attempts for this account. Try again in ${minutes} minute(s).`, email: "" }),
});

// Forgot-password and resend-verification requests: 5 per 15 minutes per address (raise for automated tests).
const accountMax = Number.parseInt(process.env.ACCOUNT_RATE_LIMIT_MAX, 10) > 0 ? Number.parseInt(process.env.ACCOUNT_RATE_LIMIT_MAX, 10) : 5;
export const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: accountMax,
  key: (req) => `account:${req.ip}`,
});

export const caseSubmitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  key: (req) => `case:${req.user ? req.user.id : req.ip}`,
});
