// Public account pages: forgot password, set/reset password from an emailed link, confirm email address.
// The forgot-password and resend pages answer the same way for every email, so they cannot be used to
// find out which addresses have an account.
import bcrypt from "bcrypt";
import { clean, isEmail } from "../helpers/validators.js";
import { audit } from "../services/auditService.js";
import {
  requestPasswordReset, resendVerification, checkPasswordToken, consumePasswordToken,
  checkVerificationToken, consumeVerificationToken,
} from "../services/accountService.js";
import { isDevMailbox } from "../services/mailService.js";

const dev = () => isDevMailbox();

export const forgotPasswordPage = (req, res) => res.render("forgotpassword", { title: "Forgot password", devMode: dev() });

export const forgotPassword = async (req, res) => {
  const email = clean(req.body.email, 254).toLowerCase();
  if (!isEmail(email)) {
    res.status(422);
    return res.render("forgotpassword", { title: "Forgot password", error: "Enter a valid email address.", email, devMode: dev() });
  }
  const { sent, account } = await requestPasswordReset(email);
  await audit(req, "password_reset_requested", {
    actor: null, recordType: account ? "crm_user" : null, recordId: account?.id ?? null,
    details: sent ? "reset link queued" : "no link sent (unknown, inactive or blocked account)",
  });
  res.render("forgotpassword", { title: "Check your email", done: true, email, devMode: dev() });
};

export const resetPasswordPage = async (req, res) => {
  const token = await checkPasswordToken(req.params.token);
  if (!token) {
    res.status(410);
    return res.render("reset_password", { title: "Link not valid", invalid: true });
  }
  res.render("reset_password", { title: token.purpose === "invite" ? "Set your password" : "Choose a new password", token: req.params.token, invite: token.purpose === "invite", name: token.display_name });
};

export const resetPassword = async (req, res) => {
  const raw = req.params.token;
  const token = await checkPasswordToken(raw);
  if (!token) {
    res.status(410);
    return res.render("reset_password", { title: "Link not valid", invalid: true });
  }
  const password = String(req.body.password || "");
  const confirm = String(req.body.confirm_password || "");
  const errors = [];
  if (password.length < 8) errors.push("Password must be at least 8 characters.");
  if (password.length > 72) errors.push("Password must be 72 characters or fewer.");
  if (password !== confirm) errors.push("Passwords do not match.");
  if (errors.length) {
    res.status(422);
    return res.render("reset_password", { title: "Choose a new password", token: raw, invite: token.purpose === "invite", name: token.display_name, errors });
  }
  const used = await consumePasswordToken(raw, await bcrypt.hash(password, 10));
  if (!used) {
    res.status(410);
    return res.render("reset_password", { title: "Link not valid", invalid: true });
  }
  await audit(req, used.purpose === "invite" ? "staff_password_set" : "password_reset_completed", {
    actor: { id: used.user_id }, recordType: "crm_user", recordId: used.user_id, details: "via emailed link; other sessions ended",
  });
  req.flash("success_msg", used.purpose === "invite" ? "Your password is set. You can sign in now." : "Your password was changed. Sign in with the new password.");
  res.redirect("/login");
};

export const verifyEmailPage = async (req, res) => {
  const token = await checkVerificationToken(req.params.token);
  if (!token) {
    res.status(410);
    return res.render("verify_email", { title: "Link not valid", state: "invalid" });
  }
  res.render("verify_email", { title: "Confirm your email", state: "confirm", token: req.params.token, email: token.email });
};

export const verifyEmail = async (req, res) => {
  const used = await consumeVerificationToken(req.params.token);
  if (!used) {
    res.status(410);
    return res.render("verify_email", { title: "Link not valid", state: "invalid" });
  }
  await audit(req, "email_verified", { actor: { id: used.user_id }, recordType: "crm_user", recordId: used.user_id });
  res.render("verify_email", { title: "Email confirmed", state: "done" });
};

export const resendVerificationEmail = async (req, res) => {
  const email = clean(req.body.email, 254).toLowerCase();
  if (isEmail(email)) {
    const { sent, account } = await resendVerification(email);
    await audit(req, "verification_email_requested", {
      actor: null, recordType: account ? "crm_user" : null, recordId: account?.id ?? null, details: sent ? "link queued" : "no link sent",
    });
  }
  res.render("verify_sent", { title: "Check your email", email, resent: true, devMode: dev() });
};
