// Campaigns and promotions. The CRM Manager creates and manages them; a Team Leader or the Manager (never the creator)
// approves a promotion. Rules live in services/marketingService.js.
import {
  listCampaigns, findCampaign, validateCampaign, createCampaign, changeCampaignStatus, listPromotions, validatePromotion, createPromotion, decidePromotion, cancelPromotion,
  PROMO_TYPES, PROMO_APPLIES, PROMO_STATUS_LABELS, CAMPAIGN_CHANNELS, CAMPAIGN_STATUS_LABELS,
} from "../services/marketingService.js";
import { listCatalog } from "../services/orderService.js";
import { parseLocal } from "../services/followUpService.js";
import { audit } from "../services/auditService.js";
import { can } from "../services/permissionService.js";
import { buildPagination } from "../helpers/pagination.js";
import { clean, cleanText, toId, toPage, oneOf } from "../helpers/validators.js";
import { AppError } from "../helpers/errors.js";
import { CAMPAIGN_TABS } from "../helpers/navigation.js";
import { config } from "../config/index.js";

const tabs = (active, role) => CAMPAIGN_TABS.filter(([label]) => role === "crm_manager" || label === "Promotions").map(([label, href]) => ({ label, href, active: label === active }));
const notFound = (res, what) => res.status(404).render("error", { title: `${what} not found`, status: 404, message: `This ${what.toLowerCase()} does not exist.` });
const pairs = (list, selected) => list.map(([value, label]) => ({ value, label, sel: value === selected }));
const labelOpts = (labels, selected) => Object.entries(labels).map(([value, label]) => ({ value, label, sel: value === selected }));
const toLocal = (date) => new Intl.DateTimeFormat("sv-SE", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(date)).replace(" ", "T");

const action = (name, fn, back) => async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return notFound(res, "Record");
  let target = back(id);
  try {
    const out = await fn(req, id);
    if (out && typeof out === "object") { target = out.redirect || target; if (out.text) req.flash("success_msg", out.text); } else if (out) req.flash("success_msg", out);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.status === 404) return notFound(res, "Record");
    if (err.status === 403) {
      await audit(req, "access_denied", { outcome: "denied", recordType: "promotion", recordId: id, details: `${name}: ${err.message}` });
      return res.status(403).render("error", { title: "Access denied", status: 403, message: err.message });
    }
    req.flash("error_msg", err.message);
  }
  res.redirect(target);
};

// ---------------------------------------------------------------- campaigns

export const campaignIndex = async (req, res) => {
  const filters = { q: clean(req.query.q, 80), status: oneOf(req.query.status, Object.keys(CAMPAIGN_STATUS_LABELS)) || "" };
  const first = await listCampaigns({ ...filters, limit: 1, offset: 0 });
  const pagination = buildPagination({ total: first.total, page: toPage(req.query.page), perPage: 15, basePath: "/crm/campaigns", query: filters });
  const { rows } = await listCampaigns({ ...filters, limit: pagination.limit, offset: pagination.offset });
  res.render("marketing/campaigns", { title: "Campaigns / Promotions", areaTabs: tabs("Campaigns", req.user.role), rows: rows.map((r) => ({ ...r, status_label: CAMPAIGN_STATUS_LABELS[r.status], channel_label: (CAMPAIGN_CHANNELS.find(([k]) => k === r.channel) || [])[1] })), filters, pagination, statusOptions: labelOpts(CAMPAIGN_STATUS_LABELS, filters.status) });
};

const campaignForm = (form = {}, errors = []) => ({ title: "New campaign", areaTabs: tabs("Campaigns", "crm_manager"), form, errors, channelOptions: pairs(CAMPAIGN_CHANNELS, form.channel) });
export const campaignNew = (req, res) => res.render("marketing/campaign_new", campaignForm({ channel: "in_store" }));
export const campaignCreate = async (req, res) => {
  const raw = { name: clean(req.body.name, 120), channel: oneOf(req.body.channel, CAMPAIGN_CHANNELS.map(([k]) => k)) || "", start_date: clean(req.body.start_date, 10), end_date: clean(req.body.end_date, 10), description: cleanText(req.body.description, 1000) };
  const { errors, values } = validateCampaign(raw);
  if (errors.length) { res.status(422); return res.render("marketing/campaign_new", campaignForm(raw, errors)); }
  const out = await createCampaign({ user: req.user, values });
  await audit(req, "campaign_created", { recordType: "campaign", recordId: out.id, after: { name: values.name, channel: values.channel } });
  req.flash("success_msg", "Campaign created as a draft.");
  res.redirect(`/crm/campaigns/${out.id}`);
};

export const campaignShow = async (req, res) => {
  const id = toId(req.params.id);
  const c = id ? await findCampaign(id) : null;
  if (!c) return notFound(res, "Campaign");
  res.render("marketing/campaign_show", {
    title: c.name, areaTabs: tabs("Campaigns", "crm_manager"), c: { ...c, status_label: CAMPAIGN_STATUS_LABELS[c.status], channel_label: (CAMPAIGN_CHANNELS.find(([k]) => k === c.channel) || [])[1] },
    promotions: c.promotions.map((p) => ({ ...p, status_label: PROMO_STATUS_LABELS[p.status] })),
    canActivate: c.status === "draft", canEnd: c.status === "active", canCancel: ["draft", "active"].includes(c.status),
  });
};

export const campaignAction = (kind) => action(`campaign ${kind}`, async (req, id) => {
  const out = await changeCampaignStatus({ id, user: req.user, action: kind });
  await audit(req, `campaign_${kind === "activate" ? "activated" : kind === "end" ? "ended" : "cancelled"}`, { recordType: "campaign", recordId: id, before: { status: out.campaign.status }, after: { status: out.to } });
  return `Campaign ${out.to === "active" ? "activated" : out.to === "ended" ? "ended" : "cancelled"}.`;
}, (id) => `/crm/campaigns/${id}`);

// ---------------------------------------------------------------- promotions

export const promotionIndex = async (req, res) => {
  const filters = { q: clean(req.query.q, 80), status: oneOf(req.query.status, Object.keys(PROMO_STATUS_LABELS)) || "" };
  const first = await listPromotions({ ...filters, limit: 1, offset: 0 });
  const pagination = buildPagination({ total: first.total, page: toPage(req.query.page), perPage: 15, basePath: "/crm/promotions", query: filters });
  const { rows } = await listPromotions({ ...filters, limit: pagination.limit, offset: pagination.offset });
  res.render("marketing/promotions", {
    title: "Promotions", areaTabs: tabs("Promotions", req.user.role), filters, pagination, statusOptions: labelOpts(PROMO_STATUS_LABELS, filters.status), canCreate: can(req.user, "campaigns.manage"),
    rows: rows.map((p) => ({ ...p, status_label: PROMO_STATUS_LABELS[p.status], type_label: p.promo_type === "percent" ? `${p.value}% off` : `₱${p.value.toFixed(2)} off`,
      canDecide: p.status === "pending_approval" && can(req.user, "promotions.approve") && Number(p.created_by) !== req.user.id, ownPending: p.status === "pending_approval" && Number(p.created_by) === req.user.id,
      canCancel: ["pending_approval", "active"].includes(p.status) && can(req.user, "campaigns.manage") })),
  });
};

const promotionForm = async (form = {}, errors = []) => {
  const { products, categories } = await listCatalog();
  const campaigns = (await listCampaigns({ limit: 100, offset: 0 })).rows.filter((c) => ["draft", "active"].includes(c.status));
  return {
    title: "New promotion", areaTabs: tabs("Promotions", "crm_manager"), form, errors, typeOptions: pairs(PROMO_TYPES, form.promo_type), appliesOptions: pairs(PROMO_APPLIES, form.applies_to),
    products: products.map((p) => ({ ...p, sel: p.product_id === form.product_id })), categories: categories.map((c) => ({ name: c, sel: c === form.category_name })), campaigns: campaigns.map((c) => ({ ...c, sel: String(c.id) === String(form.campaign_id) })),
  };
};
export const promotionNew = async (req, res) => {
  const start = new Date();
  const end = new Date(Date.now() + 14 * 86400000);
  res.render("marketing/promotion_new", await promotionForm({ promo_type: "percent", applies_to: "order", start_at: toLocal(start), end_at: toLocal(end), campaign_id: toId(req.query.campaign_id) ? String(toId(req.query.campaign_id)) : "" }));
};
export const promotionCreate = async (req, res) => {
  const raw = {
    promo_code: clean(req.body.promo_code, 30).toUpperCase(), name: clean(req.body.name, 120), promo_type: oneOf(req.body.promo_type, PROMO_TYPES.map(([k]) => k)) || "", value: clean(req.body.value, 12),
    min_order_amount: clean(req.body.min_order_amount, 12), applies_to: oneOf(req.body.applies_to, PROMO_APPLIES.map(([k]) => k)) || "", product_id: clean(req.body.product_id, 64), category_name: clean(req.body.category_name, 120),
    start_at: clean(req.body.start_at, 25), end_at: clean(req.body.end_at, 25), usage_limit: clean(req.body.usage_limit, 10), campaign_id: toId(req.body.campaign_id) ? String(toId(req.body.campaign_id)) : "",
  };
  const { errors, values } = await validatePromotion({ ...raw, start: parseLocal(raw.start_at), end: parseLocal(raw.end_at), campaign_id: raw.campaign_id ? Number(raw.campaign_id) : null });
  if (errors.length) { res.status(422); return res.render("marketing/promotion_new", await promotionForm(raw, errors)); }
  try {
    const out = await createPromotion({ user: req.user, values });
    await audit(req, "promotion_created", { recordType: "promotion", recordId: out.id, after: { code: values.promo_code, type: values.promo_type, value: values.value } });
    req.flash("success_msg", `Promotion ${values.promo_code} was created. A Team Leader (not you) must approve it before it can be used.`);
    return res.redirect("/crm/promotions");
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    res.status(err.status === 403 ? 403 : 422);
    return res.render("marketing/promotion_new", await promotionForm(raw, [err.message]));
  }
};

const BACK_PROMOS = () => "/crm/promotions";
export const promotionApprove = action("approve", async (req, id) => {
  const out = await decidePromotion({ id, user: req.user, decision: "approve" });
  await audit(req, "promotion_approved", { recordType: "promotion", recordId: id, after: { created_by: out.promotion.created_by } });
  return `Promotion ${out.promotion.promo_code} approved and active.`;
}, BACK_PROMOS);
export const promotionReject = action("reject", async (req, id) => {
  const reason = clean(req.body.reason, 200);
  const out = await decidePromotion({ id, user: req.user, decision: "reject", reason });
  await audit(req, "promotion_rejected", { recordType: "promotion", recordId: id, reason });
  return `Promotion ${out.promotion.promo_code} was rejected.`;
}, BACK_PROMOS);
export const promotionCancel = action("cancel", async (req, id) => {
  const p = await cancelPromotion({ id, user: req.user });
  await audit(req, "promotion_cancelled", { recordType: "promotion", recordId: id, before: { status: p.status } });
  return `Promotion ${p.promo_code} was cancelled.`;
}, BACK_PROMOS);
