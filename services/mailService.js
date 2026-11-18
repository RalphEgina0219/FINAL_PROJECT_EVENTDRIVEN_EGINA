/*
 * Email for account messages (verification, password reset, staff invitations).
 * Every message is recorded in mail_outbox. MAIL_TRANSPORT=log (default) sends nothing; "smtp" sends
 * through the configured SMTP server. A delivery failure is stored on the row and never thrown, so the
 * requesting page can answer with the same neutral message either way.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { config } from "../config/index.js";

// True while messages are only logged and the app is not in production (shows the development hints).
export const isDevMailbox = () => config.mail.transport === "log" && config.env !== "production";

let smtp = null;
const smtpTransport = async () => {
  if (smtp) return smtp;
  const { default: nodemailer } = await import("nodemailer");
  const { host, port, secure, user, password } = config.mail.smtp;
  smtp = nodemailer.createTransport({ host, port, secure, ...(user ? { auth: { user, pass: password } } : {}) });
  return smtp;
};

export const sendMail = async ({ to, subject, text, template, userId = null }) => {
  const transport = config.mail.transport;
  let status = "logged";
  let error = null;
  if (transport === "smtp") {
    try {
      if (!config.mail.smtp.host) throw new Error("SMTP_HOST is not set");
      await (await smtpTransport()).sendMail({ from: config.mail.from, to, subject, text });
      status = "sent";
    } catch (err) {
      status = "failed";
      error = String(err.message).slice(0, 250);
      console.error("⚠️  Email not sent:", error);
    }
  }
  await sequelize.query(
    `INSERT INTO mail_outbox (user_id, to_email, subject, body_text, template, transport, status, error)
     VALUES (:userId, :to, :subject, :text, :template, :transport, :status, :error)`,
    { replacements: { userId, to, subject: subject.slice(0, 200), text: transport === "log" ? text : "(body not stored: delivered by SMTP)", template, transport, status, error } }
  );
  return { status, error };
};

const footer = "\n\nIf you did not expect this email, you can ignore it. No one can use this link without access to your mailbox.\n— JOHNVIVZ CRM";

export const verifyEmailMessage = ({ name, url, hours }) => ({
  template: "verify_email",
  subject: "Confirm your email address — JOHNVIVZ",
  text: `Hello ${name},\n\nThank you for creating a JOHNVIVZ customer account. Please confirm your email address to start using it:\n\n${url}\n\nThis link works once and expires in ${hours} hours.${footer}`,
});

export const resetPasswordMessage = ({ name, url, minutes }) => ({
  template: "reset_password",
  subject: "Reset your JOHNVIVZ password",
  text: `Hello ${name},\n\nWe received a request to reset your password. Choose a new one here:\n\n${url}\n\nThis link works once and expires in ${minutes} minutes. Your current password stays valid until you use it.${footer}`,
});

export const staffInviteMessage = ({ name, role, url, hours }) => ({
  template: "staff_invite",
  subject: "Your JOHNVIVZ CRM access — set your password",
  text: `Hello ${name},\n\nYou have been given CRM access as ${role}. Set your password here to sign in:\n\n${url}\n\nThis link works once and expires in ${hours} hours.${footer}`,
});

export const listMail = (limit = 50) =>
  sequelize.query(
    "SELECT id, to_email, subject, body_text, template, transport, status, error, created_at FROM mail_outbox ORDER BY id DESC LIMIT :limit",
    { type: QueryTypes.SELECT, replacements: { limit } }
  );
