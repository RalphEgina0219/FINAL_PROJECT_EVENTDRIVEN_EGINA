/*
 * 113 — password_reset_tokens, mail_outbox  [CRM-LOCAL] (phase P2: email verification and password reset)
 * Two NEW tables; no existing table is changed.
 *   password_reset_tokens  one-time links to set or reset a password (also used for "set your password"
 *                          invitations to newly granted staff). Only the SHA-256 of the token is stored.
 *   mail_outbox            every email the CRM sends or would send. With MAIL_TRANSPORT=log (the default
 *                          for development) nothing leaves the computer; the message stays here and is
 *                          shown to the setup administrator under Setup › Mail Log.
 * Email verification keeps using email_verification_tokens (migration 105).
 */
import { run, dropTables } from "./_sql.js";

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE password_reset_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      purpose ENUM('reset','invite') NOT NULL DEFAULT 'reset',
      token_hash CHAR(64) NOT NULL COMMENT 'SHA-256 of the token; the raw token is never stored',
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY password_reset_tokens_hash_uq (token_hash),
      INDEX password_reset_tokens_user_idx (user_id, used_at),
      CONSTRAINT password_reset_tokens_user_fk FOREIGN KEY (user_id) REFERENCES crm_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE mail_outbox (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      to_email VARCHAR(254) NOT NULL,
      subject VARCHAR(200) NOT NULL,
      body_text TEXT NOT NULL,
      template VARCHAR(40) NOT NULL COMMENT 'verify_email, reset_password, staff_invite',
      transport ENUM('log','smtp') NOT NULL,
      status ENUM('logged','sent','failed') NOT NULL,
      error VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX mail_outbox_created_idx (created_at),
      INDEX mail_outbox_to_idx (to_email, created_at),
      CONSTRAINT mail_outbox_user_fk FOREIGN KEY (user_id) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]);
};

export const down = async ({ sequelize }) => {
  await dropTables(sequelize, ["mail_outbox", "password_reset_tokens"]);
};
