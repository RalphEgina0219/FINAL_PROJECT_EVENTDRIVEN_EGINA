/*
 * In-system notifications (crm_notifications, bell icon). Email is not used for notifications.
 * Failures to notify never break the action that triggered them.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });

// link defaults to the case page of each recipient's role (customers: /portal/cases/:id).
export const notify = async (userIds, { type, title, message = null, caseId = null, link = null, relatedType = null, relatedId = null }) => {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(Number))];
  if (!ids.length) return;
  try {
    const roles = await select("SELECT id, role FROM crm_users WHERE id IN (:ids)", { ids });
    const roleOf = Object.fromEntries(roles.map((r) => [r.id, r.role]));
    const rows = ids.map(() => "(?, ?, ?, ?, ?, ?, ?, NOW())").join(", ");
    const params = ids.flatMap((id) => {
      const caseLink = caseId ? `${roleOf[id] === "customer" ? "/portal/cases" : "/crm/cases"}/${caseId}` : null;
      return [
        id, type, title.slice(0, 150), message ? String(message).slice(0, 255) : null, link || caseLink,
        caseId ? "case" : relatedType, caseId || relatedId,
      ];
    });
    await sequelize.query(
      `INSERT INTO crm_notifications (user_id, type, title, message, link, related_type, related_id, created_at) VALUES ${rows}`,
      { replacements: params }
    );
  } catch (err) {
    console.error("⚠️  Notification not saved:", err.message);
  }
};

export const userIdsByRole = async (...roles) =>
  (await select("SELECT id FROM crm_users WHERE role IN (:roles) AND is_active = 1", { roles })).map((r) => r.id);

export const unreadCount = async (userId) => {
  const [row] = await select("SELECT COUNT(*) AS n FROM crm_notifications WHERE user_id = :userId AND read_at IS NULL", { userId });
  return Number(row.n) || 0;
};

export const listNotifications = async (userId, { limit, offset }) => {
  const [{ total }] = await select("SELECT COUNT(*) AS total FROM crm_notifications WHERE user_id = :userId", { userId });
  const rows = await select(
    `SELECT id, type, title, message, link, read_at, created_at FROM crm_notifications
     WHERE user_id = :userId ORDER BY created_at DESC, id DESC LIMIT :limit OFFSET :offset`,
    { userId, limit, offset }
  );
  return { total: Number(total), rows };
};

// Marks one notification read (only if it belongs to the user) and returns its link.
export const markRead = async (userId, id) => {
  const [row] = await select("SELECT link FROM crm_notifications WHERE id = :id AND user_id = :userId", { id, userId });
  if (!row) return null;
  await sequelize.query("UPDATE crm_notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = :id AND user_id = :userId", { replacements: { id, userId } });
  return row.link || "/notifications";
};

export const markAllRead = (userId) =>
  sequelize.query("UPDATE crm_notifications SET read_at = NOW() WHERE user_id = :userId AND read_at IS NULL", { replacements: { userId } });

// Reading a case also clears that user's notifications for it.
export const markCaseNotificationsRead = (userId, caseId) =>
  sequelize.query(
    "UPDATE crm_notifications SET read_at = NOW() WHERE user_id = :userId AND related_type = 'case' AND related_id = :caseId AND read_at IS NULL",
    { replacements: { userId, caseId } }
  );
