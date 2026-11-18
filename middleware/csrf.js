/*
 * Built-in CSRF protection (synchronizer token stored in the session).
 * Every form includes <input type="hidden" name="_csrf" value="{{csrfToken}}">.
 * Multipart forms are checked by verifyCsrf after the upload middleware has parsed the body.
 */
import crypto from "crypto";

export const csrfToken = (req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  res.locals.csrfToken = req.session.csrfToken;
  next();
};

const tokensMatch = (expected, sent) => {
  if (typeof expected !== "string" || typeof sent !== "string" || expected.length !== sent.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sent));
};

export const verifyCsrf = (req, res, next) => {
  const sent = (req.body && req.body._csrf) || req.get("x-csrf-token");
  if (tokensMatch(req.session.csrfToken, sent)) return next();
  return res.status(403).render("error", {
    title: "Form expired",
    status: 403,
    message: "This form has expired or is invalid. Go back, refresh the page and try again.",
  });
};

export const csrfProtection = (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.is("multipart/form-data")) return next(); // verified by verifyCsrf on the upload route
  return verifyCsrf(req, res, next);
};
