/*
 * Audit log (crm_audit_logs, append-only; blueprint §11). Records actor, role, action, outcome,
 * record, reason and before/after values. Writing an audit row never breaks the action itself,
 * but failures are printed so they are noticed.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

export const audit = async (req, action, {
  outcome = "success", recordType = null, recordId = null, reason = null, details = null,
  before = null, after = null, actor = undefined, correlationId = null, transaction = undefined,
} = {}) => {
  const user = actor !== undefined ? actor : req?.user || null;
  try {
    await sequelize.query(
      `INSERT INTO crm_audit_logs (actor_user_id, actor_role, action, outcome, record_type, record_id, reason, details,
                                   before_values, after_values, ip_address, correlation_id, created_at)
       VALUES (:actorId, :role, :action, :outcome, :recordType, :recordId, :reason, :details, :before, :after, :ip, :corr, NOW())`,
      {
        replacements: {
          actorId: user?.id ?? null,
          role: user?.role ?? null,
          action: String(action).slice(0, 60),
          outcome,
          recordType,
          recordId: recordId === null || recordId === undefined ? null : String(recordId).slice(0, 64),
          reason: reason ? String(reason).slice(0, 255) : null,
          details: details ? String(details).slice(0, 500) : null,
          before: json(before),
          after: json(after),
          ip: req?.ip ? String(req.ip).slice(0, 45) : null,
          corr: correlationId,
        },
        transaction,
      }
    );
  } catch (err) {
    console.error("⚠️  Audit row not written:", err.message);
  }
};

export const listAudit = async ({ q, action, outcome, limit, offset }) => {
  const where = ["1=1"];
  const params = {};
  if (action) { where.push("l.action = :action"); params.action = action; }
  if (outcome) { where.push("l.outcome = :outcome"); params.outcome = outcome; }
  if (q) {
    where.push("(u.display_name LIKE :q OR u.email LIKE :q OR l.details LIKE :q OR l.record_id LIKE :q)");
    params.q = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  }
  const from = `FROM crm_audit_logs l LEFT JOIN crm_users u ON u.id = l.actor_user_id WHERE ${where.join(" AND ")}`;
  const [{ total }] = await sequelize.query(`SELECT COUNT(*) AS total ${from}`, { type: QueryTypes.SELECT, replacements: params });
  const rows = await sequelize.query(
    `SELECT l.id, l.actor_role, l.action, l.outcome, l.record_type, l.record_id, l.reason, l.details,
            l.before_values, l.after_values, l.ip_address, l.created_at, u.display_name AS actor_name
     ${from} ORDER BY l.created_at DESC, l.id DESC LIMIT :limit OFFSET :offset`,
    { type: QueryTypes.SELECT, replacements: { ...params, limit, offset } }
  );
  const actions = await sequelize.query("SELECT DISTINCT action FROM crm_audit_logs ORDER BY action", { type: QueryTypes.SELECT });
  return {
    total: Number(total),
    rows: rows.map((r) => ({
      ...r,
      before_text: r.before_values ? JSON.stringify(r.before_values) : null,
      after_text: r.after_values ? JSON.stringify(r.after_values) : null,
    })),
    actions: actions.map((a) => a.action),
  };
};
