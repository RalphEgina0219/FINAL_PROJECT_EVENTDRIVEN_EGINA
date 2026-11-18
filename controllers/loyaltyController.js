// Loyalty points (P8, decision D13). Rules and every write live in services/loyaltyService.js; these pages only read.
//   /portal/loyalty      the customer's own points and history (linked from My Profile; the supplement E menu is unchanged)
//   /crm/loyalty         the CRM Manager's list of loyalty accounts (Campaigns / Promotions area, Loyalty tab)
//   /crm/loyalty/:id     one customer's account and history (Manager)
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { buildPagination } from "../helpers/pagination.js";
import { clean, toId, toPage } from "../helpers/validators.js";
import { CAMPAIGN_TABS } from "../helpers/navigation.js";
import { customerLoyalty, listAccounts, RULES_TEXT } from "../services/loyaltyService.js";

const tabs = (active) => CAMPAIGN_TABS.map(([label, href]) => ({ label, href, active: label === active }));

export const portal = async (req, res) => {
  const loyalty = await customerLoyalty(req.user.customer_id, { limit: 100 });
  res.render("loyalty/portal", { title: "My Loyalty Points", loyalty, rules: RULES_TEXT });
};

export const index = async (req, res) => {
  const q = clean(req.query.q, 80);
  const first = await listAccounts({ q, limit: 1, offset: 0 });
  const pagination = buildPagination({ total: first.total, page: toPage(req.query.page), perPage: 20, basePath: "/crm/loyalty", query: { q } });
  const { rows, summary } = await listAccounts({ q, limit: pagination.limit, offset: pagination.offset });
  res.render("loyalty/index", { title: "Loyalty", areaTabs: tabs("Loyalty"), rows, summary, q, pagination, rules: RULES_TEXT });
};

export const show = async (req, res) => {
  const id = toId(req.params.id);
  const [customer] = id ? await sequelize.query("SELECT id, customer_no, first_name, last_name, is_demo FROM customers WHERE id = :id", { type: QueryTypes.SELECT, replacements: { id } }) : [];
  if (!customer) return res.status(404).render("error", { title: "Not found", status: 404, message: "This customer does not exist." });
  const loyalty = await customerLoyalty(customer.id, { limit: 200 });
  res.render("loyalty/show", { title: `Loyalty · ${customer.customer_no}`, areaTabs: tabs("Loyalty"), customer, loyalty, rules: RULES_TEXT });
};
