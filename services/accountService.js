/*
 * One-time email links (email verification, password reset, staff "set your password" invitations)
 * and the session stamp that ends other sessions after a password change.
 *
 * A raw token appears only in the email link. The database keeps its SHA-256 and the expiry, a link
 * works once, and asking for a new link cancels the older ones.
 */
import crypto from "crypto";
import { QueryTypes } from "sequelize";
import { sequelize, ACCESS_BLOCKING_STATUSES } from "../models/index.js";
import { config } from "../config/index.js";
import { sendMail, verifyEmailMessage, resetPasswordMessage, staffInviteMessage } from "./mailService.js";
import { ROLE_LABELS } from "../helpers/labels.js";

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");
const later = (ms) => new Date(Date.now() + ms);

// Compared with LEFT(SHA2(password_hash, 256), 16) from loadAccount: a changed password ends old sessions.
export const sessionStamp = (passwordHash) => sha256(passwordHash).slice(0, 16);

// ---------------------------------------------------------------- who may receive a link
// Active accounts, plus customers still waiting for email verification (a reset link also proves the mailbox).
export const canReceiveLink = (a) => {
  if (!a || !a.is_active) return false;
  if (a.user_type === "customer") return ["active", "pending_verification"].includes(a.account_status);
  // Staff who sign in through ESS have no CRM password: they reset it in ESS (employee account flow). Only local staff logins (the demo
  // accounts while ESS login is mock) still get a CRM link.
  if (a.user_type === "staff") return a.login_via !== "ess" && config.integration.ess.login !== "live" && Boolean(a.employment_status) && !ACCESS_BLOCKING_STATUSES.includes(a.employment_status) && !a.access_revoked_at;
  return a.user_type === "system";
};

const accountByEmail = async (email) => {
  const [row] = await select(
    `SELECT u.id, u.display_name, u.email, u.role, u.user_type, u.is_active, u.access_revoked_at, u.email_verified_at, u.login_via,
            e.employment_status, ca.status AS account_status
     FROM crm_users u
     LEFT JOIN employee_references e ON e.employee_id = u.employee_id
     LEFT JOIN customer_accounts ca ON ca.user_id = u.id
     WHERE u.email = :email`,
    { email }
  );
  return row || null;
};

// ---------------------------------------------------------------- issuing links
const issueVerificationToken = async (userId) => {
  const raw = newToken();
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("UPDATE email_verification_tokens SET used_at = NOW() WHERE user_id = :userId AND used_at IS NULL", { replacements: { userId }, transaction });
    await sequelize.query(
      "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (:userId, :hash, :expires)",
      { replacements: { userId, hash: sha256(raw), expires: later(config.tokens.verifyHours * 3600 * 1000) }, transaction }
    );
  });
  return raw;
};

const issuePasswordToken = async (userId, purpose) => {
  const raw = newToken();
  const ttl = purpose === "invite" ? config.tokens.inviteHours * 3600 * 1000 : config.tokens.resetMinutes * 60 * 1000;
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = :userId AND used_at IS NULL", { replacements: { userId }, transaction });
    await sequelize.query(
      "INSERT INTO password_reset_tokens (user_id, purpose, token_hash, expires_at) VALUES (:userId, :purpose, :hash, :expires)",
      { replacements: { userId, purpose, hash: sha256(raw), expires: later(ttl) }, transaction }
    );
  });
  return raw;
};

// Sends the verification email for a customer. Returns the link (shown only in the development mailbox).
export const sendVerification = async (user) => {
  const url = `${config.appUrl}/verify-email/${await issueVerificationToken(user.id)}`;
  await sendMail({ to: user.email, userId: user.id, ...verifyEmailMessage({ name: user.display_name, url, hours: config.tokens.verifyHours }) });
  return url;
};

// "Forgot password": the caller must answer the same way whether or not a message was queued.
export const requestPasswordReset = async (email) => {
  const account = await accountByEmail(email);
  if (!canReceiveLink(account)) return { sent: false, account };
  const url = `${config.appUrl}/reset-password/${await issuePasswordToken(account.id, "reset")}`;
  await sendMail({ to: account.email, userId: account.id, ...resetPasswordMessage({ name: account.display_name, url, minutes: config.tokens.resetMinutes }) });
  return { sent: true, account };
};

// "Resend verification" for a customer who has not confirmed the email yet.
export const resendVerification = async (email) => {
  const account = await accountByEmail(email);
  if (!account || account.user_type !== "customer" || account.account_status !== "pending_verification" || !account.is_active) return { sent: false, account };
  await sendVerification(account);
  return { sent: true, account };
};

// Invitation (first password) or reset link for a staff login, sent by the CRM Manager.
export const sendStaffInvite = async (user) => {
  const purpose = user.email_verified_at ? "reset" : "invite";
  const url = `${config.appUrl}/reset-password/${await issuePasswordToken(user.id, purpose)}`;
  const message = purpose === "invite"
    ? staffInviteMessage({ name: user.display_name, role: ROLE_LABELS[user.role] || user.role, url, hours: config.tokens.inviteHours })
    : resetPasswordMessage({ name: user.display_name, url, minutes: config.tokens.resetMinutes });
  await sendMail({ to: user.email, userId: user.id, ...message });
  return { purpose };
};

// One-time "set your password" link for a brand-new login (scripts/create-first-accounts.mjs prints it once in the deployer's terminal).
export const issueInviteLink = async (userId) => `${config.appUrl}/reset-password/${await issuePasswordToken(userId, "invite")}`;

// ---------------------------------------------------------------- using links
const findToken = async (table, raw, transaction) => {
  if (typeof raw !== "string" || raw.length < 20 || raw.length > 100) return null;
  const purposeColumn = table === "password_reset_tokens" ? "t.purpose" : "'verify' AS purpose";
  const [row] = await select(
    `SELECT t.id, t.user_id, t.expires_at, t.used_at, ${purposeColumn}, u.display_name, u.email
     FROM ${table} t JOIN crm_users u ON u.id = t.user_id WHERE t.token_hash = :hash`,
    { hash: sha256(raw) }, transaction
  );
  if (!row || row.used_at || new Date(row.expires_at) <= new Date()) return null;
  return row;
};

export const checkVerificationToken = (raw) => findToken("email_verification_tokens", raw);
export const checkPasswordToken = (raw) => findToken("password_reset_tokens", raw);

const confirmEmail = async (userId, transaction) => {
  await sequelize.query("UPDATE crm_users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = :userId", { replacements: { userId }, transaction });
  await sequelize.query("UPDATE customer_accounts SET status = 'active' WHERE user_id = :userId AND status = 'pending_verification'", { replacements: { userId }, transaction });
};

export const consumeVerificationToken = async (raw) =>
  sequelize.transaction(async (transaction) => {
    const token = await findToken("email_verification_tokens", raw, transaction);
    if (!token) return null;
    const [, meta] = await sequelize.query("UPDATE email_verification_tokens SET used_at = NOW() WHERE id = :id AND used_at IS NULL", { replacements: { id: token.id }, transaction });
    if (!meta?.affectedRows) return null; // used by a parallel request
    await confirmEmail(token.user_id, transaction);
    return token;
  });

// Sets the new password. Opening the link proves the mailbox, so the email counts as verified.
export const consumePasswordToken = async (raw, passwordHash) =>
  sequelize.transaction(async (transaction) => {
    const token = await findToken("password_reset_tokens", raw, transaction);
    if (!token) return null;
    const [, meta] = await sequelize.query("UPDATE password_reset_tokens SET used_at = NOW() WHERE id = :id AND used_at IS NULL", { replacements: { id: token.id }, transaction });
    if (!meta?.affectedRows) return null;
    await sequelize.query("UPDATE crm_users SET password_hash = :passwordHash WHERE id = :userId", { replacements: { passwordHash, userId: token.user_id }, transaction });
    await sequelize.query("UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = :userId AND used_at IS NULL", { replacements: { userId: token.user_id }, transaction });
    await confirmEmail(token.user_id, transaction);
    return token;
  });
