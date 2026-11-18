/*
 * Promotions and campaigns, P5.
 * Promotions (promotions table): a code that takes a percent or a fixed amount off an order, a product or a category.
 *   Created by the CRM Manager as pending_approval; approved (-> active) by a Team Leader or Manager who is NOT the creator
 *   (checked here and by the CHECK constraint promotions_self_approval_chk). It can be used between its start and end,
 *   up to its usage limit, above its minimum order. Applying it at checkout is in orderService.
 * Campaigns (campaigns table): a named period that groups promotions. Status draft -> active -> ended, or cancelled.
 *   Results shown are only what real data can answer: redemptions, discount given, orders and sales of the linked promotions.
 *   The CRM does not send SMS or email in this phase, so there are no "sent" or "opened" figures.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { AppError } from "../helpers/errors.js";
import { getProducts, productCategories } from "./integration/inventoryAdapter.js";

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
const exec = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction });

export const PROMO_TYPES = [["percent", "Percent off"], ["fixed_amount", "Fixed amount off"]];
export const PROMO_APPLIES = [["order", "The whole order"], ["product", "One product"], ["category", "A product category"]];
export const PROMO_STATUS_LABELS = { draft: "Draft", pending_approval: "Waiting for approval", active: "Active", expired: "Expired", cancelled: "Cancelled" };
export const CAMPAIGN_CHANNELS = [["in_store", "In store"], ["sms", "SMS"], ["email", "Email"], ["social", "Social media"], ["portal", "Customer portal"], ["mixed", "Mixed"]];
export const CAMPAIGN_STATUS_LABELS = { draft: "Draft", active: "Active", ended: "Ended", cancelled: "Cancelled" };
export const MIN_REASON_LENGTH = 5;

// ---------------------------------------------------------------- housekeeping (also run by the scheduler)

export const expireMarketing = async () => {
  const [, p] = await sequelize.query("UPDATE promotions SET status = 'expired' WHERE status = 'active' AND end_at < NOW()");
  const [, c] = await sequelize.query("UPDATE campaigns SET status = 'ended' WHERE status = 'active' AND end_date < CURDATE()");
  return (p?.affectedRows || 0) + (c?.affectedRows || 0);
};

// ---------------------------------------------------------------- promotions

const PROMO_COLUMNS = `p.id, p.promo_code, p.campaign_id, p.name, p.promo_type, p.value, p.min_order_amount, p.applies_to, p.product_id, p.category_name, p.start_at, p.end_at,
  p.usage_limit, p.status, p.created_by, p.approved_by, p.approved_at, p.is_demo, p.created_at, cb.display_name AS created_by_name, ab.display_name AS approved_by_name,
  cm.name AS campaign_name, (SELECT COUNT(*) FROM promotion_redemptions r WHERE r.promotion_id = p.id) AS used_count`;
const PROMO_FROM = "FROM promotions p LEFT JOIN crm_users cb ON cb.id = p.created_by LEFT JOIN crm_users ab ON ab.id = p.approved_by LEFT JOIN campaigns cm ON cm.id = p.campaign_id";
const promoShape = (r) => ({ ...r, value: Number(r.value), min_order_amount: r.min_order_amount === null ? null : Number(r.min_order_amount), used_count: Number(r.used_count) });

export const listPromotions = async ({ q = "", status = "", limit = 50, offset = 0 } = {}) => {
  await expireMarketing();
  const where = ["1=1"];
  const params = {};
  if (q) { where.push("(p.promo_code LIKE :q OR p.name LIKE :q)"); params.q = `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`; }
  if (status) { where.push("p.status = :status"); params.status = status; }
  const [{ total }] = await select(`SELECT COUNT(*) AS total ${PROMO_FROM} WHERE ${where.join(" AND ")}`, params);
  const rows = await select(`SELECT ${PROMO_COLUMNS} ${PROMO_FROM} WHERE ${where.join(" AND ")} ORDER BY FIELD(p.status,'pending_approval','active','draft','expired','cancelled'), p.end_at DESC LIMIT :limit OFFSET :offset`, { ...params, limit, offset });
  return { total: Number(total), rows: rows.map(promoShape) };
};

export const findPromotion = async (id) => {
  const [row] = await select(`SELECT ${PROMO_COLUMNS} ${PROMO_FROM} WHERE p.id = :id`, { id });
  return row ? promoShape(row) : null;
};

export const activePromotions = async () => {
  await expireMarketing();
  const rows = await select(`SELECT ${PROMO_COLUMNS} ${PROMO_FROM} WHERE p.status = 'active' AND p.start_at <= NOW() AND p.end_at >= NOW() ORDER BY p.end_at`);
  return rows.map(promoShape);
};

export const validatePromotion = async (raw) => {
  const errors = [];
  const v = { ...raw };
  if (!/^[A-Z0-9]{4,20}$/.test(v.promo_code || "")) errors.push("The code must be 4 to 20 capital letters or numbers.");
  if (!v.name || v.name.length < 3) errors.push("Give the promotion a name (at least 3 characters).");
  if (!PROMO_TYPES.some(([k]) => k === v.promo_type)) errors.push("Choose the type of discount.");
  const value = Number(v.value);
  if (!(value > 0)) errors.push("The discount value must be more than zero.");
  else if (v.promo_type === "percent" && value > 100) errors.push("A percent discount cannot be more than 100.");
  else if (v.promo_type === "fixed_amount" && value > 100000) errors.push("The fixed amount is too large.");
  v.value = value;
  if (v.min_order_amount !== "" && v.min_order_amount !== null && v.min_order_amount !== undefined) {
    const m = Number(v.min_order_amount);
    if (!(m >= 0)) errors.push("The minimum order must be zero or more."); else v.min_order_amount = m;
  } else v.min_order_amount = null;
  if (!PROMO_APPLIES.some(([k]) => k === v.applies_to)) errors.push("Choose what the discount applies to.");
  if (v.applies_to === "product") {
    const found = v.product_id ? await getProducts({ ids: [v.product_id] }) : [];
    if (!found.length) errors.push("Choose a product that Inventory sells.");
  } else v.product_id = null;
  if (v.applies_to === "category") { if (!(await productCategories()).includes(v.category_name)) errors.push("Choose a product category."); } else v.category_name = null;
  if (!v.start || !v.end) errors.push("Enter the start and end date and time.");
  else if (v.end <= v.start) errors.push("The end must be after the start.");
  else if (v.end.getTime() < Date.now()) errors.push("The promotion would already be over.");
  if (v.usage_limit !== "" && v.usage_limit !== null && v.usage_limit !== undefined) {
    const u = Number(v.usage_limit);
    if (!Number.isInteger(u) || u < 1 || u > 1000000) errors.push("The usage limit must be a whole number from 1 to 1,000,000."); else v.usage_limit = u;
  } else v.usage_limit = null;
  return { errors, values: v };
};

export const createPromotion = async ({ user, values, at = null, isDemo = false, status = "pending_approval", approvedBy = null }) => {
  if (user.role !== "crm_manager") throw new AppError("Only the CRM Manager creates promotions.", 403);
  const [dup] = await select("SELECT id FROM promotions WHERE promo_code = :code", { code: values.promo_code });
  if (dup) throw new AppError("That promo code is already used.", 422);
  if (values.campaign_id) {
    const [c] = await select("SELECT id, status FROM campaigns WHERE id = :id", { id: values.campaign_id });
    if (!c || c.status === "cancelled") throw new AppError("Choose a campaign that is not cancelled.", 422);
  }
  const now = at || new Date();
  const [id] = await sequelize.query(
    `INSERT INTO promotions (promo_code, campaign_id, name, promo_type, value, min_order_amount, applies_to, product_id, category_name, start_at, end_at, usage_limit, status,
                             created_by, approved_by, approved_at, is_demo, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { replacements: [values.promo_code, values.campaign_id || null, values.name, values.promo_type, values.value, values.min_order_amount, values.applies_to, values.product_id, values.category_name, values.start, values.end, values.usage_limit, status, user.id, approvedBy, approvedBy ? now : null, isDemo ? 1 : 0, now, now] }
  );
  return { id };
};

// Approve or reject: never the creator (TC-14 for promotions).
export const decidePromotion = async ({ id, user, decision, reason = "" }) =>
  sequelize.transaction(async (transaction) => {
    if (!["team_leader", "crm_manager"].includes(user.role)) throw new AppError("Only a Team Leader or the CRM Manager can decide a promotion.", 403);
    const [p] = await select("SELECT * FROM promotions WHERE id = :id FOR UPDATE", { id }, transaction);
    if (!p) throw new AppError("Promotion not found.", 404);
    if (p.status !== "pending_approval") throw new AppError(`This promotion is already ${PROMO_STATUS_LABELS[p.status].toLowerCase()}.`, 422);
    if (Number(p.created_by) === Number(user.id)) throw new AppError("You created this promotion, so someone else must decide it.", 403);
    if (!["approve", "reject"].includes(decision)) throw new AppError("Choose approve or reject.", 422);
    if (decision === "reject" && String(reason).trim().length < MIN_REASON_LENGTH) throw new AppError(`Give a reason for rejecting (at least ${MIN_REASON_LENGTH} characters).`, 422);
    if (decision === "approve") await exec("UPDATE promotions SET status = 'active', approved_by = ?, approved_at = NOW() WHERE id = ?", [user.id, id], transaction);
    else await exec("UPDATE promotions SET status = 'cancelled' WHERE id = ?", [id], transaction);
    return { promotion: p, decision };
  });

export const cancelPromotion = async ({ id, user }) => {
  if (user.role !== "crm_manager") throw new AppError("Only the CRM Manager can cancel a promotion.", 403);
  const [p] = await select("SELECT * FROM promotions WHERE id = :id", { id });
  if (!p) throw new AppError("Promotion not found.", 404);
  if (!["pending_approval", "active"].includes(p.status)) throw new AppError(`A ${PROMO_STATUS_LABELS[p.status].toLowerCase()} promotion cannot be cancelled.`, 422);
  await exec("UPDATE promotions SET status = 'cancelled' WHERE id = ?", [id]);
  return p;
};

// ---------------------------------------------------------------- campaigns

const CAMPAIGN_COLUMNS = `c.id, c.campaign_code, c.name, c.description, c.channel, c.start_date, c.end_date, c.status, c.created_by, c.is_demo, c.created_at, u.display_name AS created_by_name,
  (SELECT COUNT(*) FROM promotions p WHERE p.campaign_id = c.id) AS promotion_count,
  (SELECT COUNT(*) FROM promotion_redemptions r JOIN promotions p ON p.id = r.promotion_id WHERE p.campaign_id = c.id) AS redemption_count`;

export const listCampaigns = async ({ q = "", status = "", limit = 50, offset = 0 } = {}) => {
  await expireMarketing();
  const where = ["1=1"];
  const params = {};
  if (q) { where.push("(c.campaign_code LIKE :q OR c.name LIKE :q)"); params.q = `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`; }
  if (status) { where.push("c.status = :status"); params.status = status; }
  const [{ total }] = await select(`SELECT COUNT(*) AS total FROM campaigns c WHERE ${where.join(" AND ")}`, params);
  const rows = await select(`SELECT ${CAMPAIGN_COLUMNS} FROM campaigns c LEFT JOIN crm_users u ON u.id = c.created_by WHERE ${where.join(" AND ")} ORDER BY FIELD(c.status,'active','draft','ended','cancelled'), c.start_date DESC LIMIT :limit OFFSET :offset`, { ...params, limit, offset });
  return { total: Number(total), rows: rows.map((r) => ({ ...r, promotion_count: Number(r.promotion_count), redemption_count: Number(r.redemption_count) })) };
};

export const findCampaign = async (id) => {
  const [row] = await select(`SELECT ${CAMPAIGN_COLUMNS} FROM campaigns c LEFT JOIN crm_users u ON u.id = c.created_by WHERE c.id = :id`, { id });
  if (!row) return null;
  const [results] = await select(
    `SELECT COUNT(r.id) AS redemptions, COALESCE(SUM(r.discount_amount), 0) AS discount_given, COUNT(DISTINCT r.sales_order_id) AS orders,
            COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.grand_total ELSE 0 END), 0) AS sales, COALESCE(SUM(o.status = 'completed'), 0) AS completed_orders,
            COUNT(DISTINCT r.customer_id) AS customers, COALESCE(SUM(o.is_demo = 1), 0) AS demo_orders
     FROM promotion_redemptions r JOIN promotions p ON p.id = r.promotion_id JOIN sales_orders o ON o.id = r.sales_order_id WHERE p.campaign_id = :id`, { id });
  const promotions = (await select(`SELECT ${PROMO_COLUMNS} ${PROMO_FROM} WHERE p.campaign_id = :id ORDER BY p.end_at DESC`, { id })).map(promoShape);
  return {
    ...row, promotion_count: Number(row.promotion_count), redemption_count: Number(row.redemption_count), promotions,
    results: { redemptions: Number(results.redemptions), discount_given: Number(results.discount_given), orders: Number(results.orders), sales: Number(results.sales), completed_orders: Number(results.completed_orders),
      customers: Number(results.customers), avg_order: Number(results.completed_orders) ? Math.round((Number(results.sales) / Number(results.completed_orders)) * 100) / 100 : 0, includes_demo: Number(results.demo_orders) > 0 },
  };
};

export const validateCampaign = (raw) => {
  const errors = [];
  const v = { ...raw };
  if (!v.name || v.name.length < 3) errors.push("Give the campaign a name (at least 3 characters).");
  if (!CAMPAIGN_CHANNELS.some(([k]) => k === v.channel)) errors.push("Choose the channel.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.start_date || "") || !/^\d{4}-\d{2}-\d{2}$/.test(v.end_date || "")) errors.push("Enter the start and end date.");
  else if (v.end_date < v.start_date) errors.push("The end date cannot be before the start date.");
  if (v.description && v.description.length > 1000) errors.push("The description is too long (1000 characters at most).");
  return { errors, values: v };
};

export const createCampaign = async ({ user, values, at = null, isDemo = false, status = "draft" }) => {
  if (user.role !== "crm_manager") throw new AppError("Only the CRM Manager creates campaigns.", 403);
  const now = at || new Date();
  const [id] = await sequelize.query(
    `INSERT INTO campaigns (campaign_code, name, description, channel, start_date, end_date, status, created_by, is_demo, created_at, updated_at)
     VALUES (CONCAT('TMP-', LEFT(REPLACE(UUID(), '-', ''), 16)), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { replacements: [values.name, values.description || null, values.channel, values.start_date, values.end_date, status, user.id, isDemo ? 1 : 0, now, now] }
  );
  await exec("UPDATE campaigns SET campaign_code = CONCAT('CMP-', LPAD(id, 4, '0')) WHERE id = ?", [id]);
  return { id };
};

const NEXT = { activate: ["draft", "active"], end: ["active", "ended"], cancel: ["draft", "cancelled"] };
export const changeCampaignStatus = async ({ id, user, action }) => {
  if (user.role !== "crm_manager") throw new AppError("Only the CRM Manager manages campaigns.", 403);
  const [c] = await select("SELECT * FROM campaigns WHERE id = :id", { id });
  if (!c) throw new AppError("Campaign not found.", 404);
  let from = NEXT[action]?.[0];
  let to = NEXT[action]?.[1];
  if (action === "cancel" && c.status === "active") { from = "active"; to = "cancelled"; }
  if (!to || c.status !== from) throw new AppError(`A ${CAMPAIGN_STATUS_LABELS[c.status].toLowerCase()} campaign cannot be ${action === "activate" ? "activated" : action === "end" ? "ended" : "cancelled"}.`, 422);
  await exec("UPDATE campaigns SET status = ? WHERE id = ?", [to, id]);
  return { campaign: c, to };
};

// Active-campaign figures for the Manager dashboard: redemptions per campaign (real data only).
export const campaignPerformance = async (limit = 5) =>
  select(
    `SELECT c.name AS label, COUNT(r.id) AS value FROM campaigns c JOIN promotions p ON p.campaign_id = c.id JOIN promotion_redemptions r ON r.promotion_id = p.id
     GROUP BY c.id, c.name ORDER BY value DESC LIMIT :limit`, { limit });
