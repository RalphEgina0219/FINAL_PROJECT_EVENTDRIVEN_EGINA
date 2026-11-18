// CRM configuration pages, shared by the CRM Manager (Settings tabs under /crm/settings) and the setup
// System Administrator (/setup). Every change is written to the audit log with before/after values.
import { QueryTypes } from "sequelize";
import { sequelize, CaseCategory, CASE_PRIORITIES } from "../models/index.js";
import { getSettings, saveSettings, SETTING_FIELDS, currentValue, PRIORITIES } from "../services/settingsService.js";
import { audit, listAudit } from "../services/auditService.js";
import { permissionMatrix } from "../services/permissionService.js";
import { platformStatus } from "../services/dashboardService.js";
import { buildPagination } from "../helpers/pagination.js";
import { clean, cleanText, toId, toPage, oneOf } from "../helpers/validators.js";

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const notFound = (res, what = "Record") => res.status(404).render("error", { title: "Not found", status: 404, message: `${what} not found.` });

// Manager: /crm/settings/...; setup admin: /setup/...
const baseOf = (req) => (req.user.role === "system_admin" ? "/setup" : "/crm/settings");
export const paths = (req) => {
  const b = baseOf(req);
  return {
    base: b,
    rules: b === "/setup" ? "/setup/settings" : "/crm/settings",
    categories: `${b}/categories`,
    templates: `${b}/templates`,
    audit: `${b}/audit-logs`,
    permissions: b === "/setup" ? null : "/crm/settings/permissions",
    access: b === "/setup" ? null : "/crm/settings/access",
    isManager: req.user.role === "crm_manager",
  };
};
const render = (req, res, view, data) => res.render(view, { ...data, cfg: paths(req), platform: platformStatus() });

// ------------------------------------------------------------------ rules & SLA

export const rules = (req, res) => {
  const fields = SETTING_FIELDS.map((f) => ({ ...f, value: currentValue(f.key) }));
  render(req, res, "settings/rules", {
    title: req.user.role === "system_admin" ? "CRM Rules & SLA" : "Settings",
    tab: "rules",
    general: fields.filter((f) => !f.priority),
    sla: PRIORITIES.map((p) => ({
      priority: p,
      first: fields.find((f) => f.key === `sla_first_response_hours_${p}`),
      resolution: fields.find((f) => f.key === `sla_resolution_hours_${p}`),
    })),
    rulesNow: getSettings(), // "settings" is a reserved render key in Express
  });
};

export const saveRules = async (req, res) => {
  const values = {};
  const errors = [];
  for (const f of SETTING_FIELDS) {
    const v = Number.parseInt(req.body[f.key], 10);
    if (!Number.isInteger(v) || v < f.min || v > f.max) errors.push(`${f.label}: enter a whole number from ${f.min} to ${f.max}.`);
    else values[f.key] = v;
  }
  for (const p of PRIORITIES) {
    if (values[`sla_first_response_hours_${p}`] > values[`sla_resolution_hours_${p}`]) {
      errors.push(`For ${p} priority, the first-response target cannot be longer than the resolution target.`);
    }
  }
  const back = paths(req).rules;
  if (errors.length) {
    errors.forEach((e) => req.flash("error_msg", e));
    return res.redirect(back);
  }
  const before = Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, currentValue(f.key)]));
  await saveSettings(values, req.user.id);
  const changedKeys = Object.keys(values).filter((k) => before[k] !== values[k]);
  if (changedKeys.length) {
    await audit(req, "settings_updated", {
      recordType: "crm_settings",
      before: Object.fromEntries(changedKeys.map((k) => [k, before[k]])),
      after: Object.fromEntries(changedKeys.map((k) => [k, values[k]])),
    });
  }
  req.flash("success_msg", changedKeys.length ? "Settings saved. New cases use the new SLA targets." : "No changes to save.");
  res.redirect(back);
};

// ------------------------------------------------------------------ categories

export const categories = async (req, res) => {
  const rows = await select(
    `SELECT c.id, c.name, c.description, c.default_priority, c.is_active, COUNT(k.id) AS case_count
     FROM case_categories c LEFT JOIN customer_cases k ON k.category_id = c.id
     GROUP BY c.id, c.name, c.description, c.default_priority, c.is_active ORDER BY c.name`
  );
  const editing = toId(req.query.edit);
  render(req, res, "settings/categories", {
    title: "Case Categories", tab: "categories",
    rows: rows.map((r) => ({ ...r, editing: r.id === editing })),
    priorities: CASE_PRIORITIES,
  });
};

const readCategory = (body) => ({
  name: clean(body.name, 80),
  description: clean(body.description, 255) || null,
  default_priority: oneOf(body.default_priority, CASE_PRIORITIES) || "medium",
});

export const createCategory = async (req, res) => {
  const data = readCategory(req.body);
  if (data.name.length < 3) req.flash("error_msg", "Category name must be at least 3 characters.");
  else if (await CaseCategory.count({ where: { name: data.name } })) req.flash("error_msg", "That category already exists.");
  else {
    const cat = await CaseCategory.create(data);
    await audit(req, "category_created", { recordType: "case_category", recordId: cat.id, after: data });
    req.flash("success_msg", `Category "${data.name}" added.`);
  }
  res.redirect(paths(req).categories);
};

export const updateCategory = async (req, res) => {
  const id = toId(req.params.id);
  const cat = id ? await CaseCategory.findByPk(id) : null;
  if (!cat) return notFound(res, "Category");
  const data = readCategory(req.body);
  const [dup] = await select("SELECT id FROM case_categories WHERE name = :name AND id <> :id", { name: data.name, id: cat.id });
  if (data.name.length < 3) req.flash("error_msg", "Category name must be at least 3 characters.");
  else if (dup) req.flash("error_msg", "Another category already uses that name.");
  else {
    const before = { name: cat.name, description: cat.description, default_priority: cat.default_priority };
    await cat.update(data);
    await audit(req, "category_updated", { recordType: "case_category", recordId: cat.id, before, after: data });
    req.flash("success_msg", `Category "${data.name}" saved.`);
  }
  res.redirect(paths(req).categories);
};

export const toggleCategory = async (req, res) => {
  const id = toId(req.params.id);
  const cat = id ? await CaseCategory.findByPk(id) : null;
  if (!cat) return notFound(res, "Category");
  await cat.update({ is_active: !cat.is_active });
  await audit(req, "category_toggled", { recordType: "case_category", recordId: cat.id, before: { is_active: !cat.is_active }, after: { is_active: cat.is_active } });
  req.flash("success_msg", `"${cat.name}" is now ${cat.is_active ? "active" : "inactive"}.`);
  res.redirect(paths(req).categories);
};

export const deleteCategory = async (req, res) => {
  const id = toId(req.params.id);
  const cat = id ? await CaseCategory.findByPk(id) : null;
  if (!cat) return notFound(res, "Category");
  const [{ n }] = await select("SELECT COUNT(*) AS n FROM customer_cases WHERE category_id = :id", { id: cat.id });
  if (Number(n) > 0) req.flash("error_msg", `"${cat.name}" is used by ${n} case(s). Deactivate it instead.`);
  else {
    await cat.destroy();
    await audit(req, "category_deleted", { recordType: "case_category", recordId: id, before: { name: cat.name } });
    req.flash("success_msg", `Category "${cat.name}" deleted.`);
  }
  res.redirect(paths(req).categories);
};

// ------------------------------------------------------------------ response templates

export const templates = async (req, res) => {
  const rows = await select(
    `SELECT r.id, r.title, r.body, r.is_active, r.category_id, c.name AS category_name, u.display_name AS created_by_name, r.updated_at
     FROM response_templates r LEFT JOIN case_categories c ON c.id = r.category_id LEFT JOIN crm_users u ON u.id = r.created_by
     ORDER BY r.is_active DESC, r.title`
  );
  const editId = toId(req.query.edit);
  const cats = await CaseCategory.findAll({ attributes: ["id", "name"], order: [["name", "ASC"]], raw: true });
  render(req, res, "settings/templates", {
    title: "Response Templates", tab: "templates", rows, editing: editId ? rows.find((r) => r.id === editId) || null : null, categories: cats,
  });
};

export const saveTemplate = async (req, res) => {
  const id = toId(req.params.id);
  const t = { title: clean(req.body.title, 100), body: cleanText(req.body.body, 3000), category_id: toId(req.body.category_id) };
  const p = paths(req);
  if (t.title.length < 3 || t.body.length < 10) {
    req.flash("error_msg", "Template needs a title (3+ characters) and a message (10+ characters).");
    return res.redirect(id ? `${p.templates}?edit=${id}` : p.templates);
  }
  if (id) {
    const [before] = await select("SELECT title, body, category_id FROM response_templates WHERE id = :id", { id });
    if (!before) return notFound(res, "Template");
    await sequelize.query("UPDATE response_templates SET title = :title, body = :body, category_id = :category_id WHERE id = :id", { replacements: { ...t, id } });
    await audit(req, "template_updated", { recordType: "response_template", recordId: id, before, after: t });
    req.flash("success_msg", `Template "${t.title}" saved.`);
  } else {
    const [newId] = await sequelize.query(
      "INSERT INTO response_templates (title, body, category_id, is_active, created_by) VALUES (:title, :body, :category_id, 1, :userId)",
      { replacements: { ...t, userId: req.user.id }, type: QueryTypes.INSERT }
    );
    await audit(req, "template_created", { recordType: "response_template", recordId: newId, after: t });
    req.flash("success_msg", `Template "${t.title}" created.`);
  }
  res.redirect(p.templates);
};

export const toggleTemplate = async (req, res) => {
  const id = toId(req.params.id);
  if (id) {
    await sequelize.query("UPDATE response_templates SET is_active = 1 - is_active WHERE id = :id", { replacements: { id } });
    await audit(req, "template_toggled", { recordType: "response_template", recordId: id });
    req.flash("success_msg", "Template status changed.");
  }
  res.redirect(paths(req).templates);
};

export const deleteTemplate = async (req, res) => {
  const id = toId(req.params.id);
  if (id) {
    const [before] = await select("SELECT title, body FROM response_templates WHERE id = :id", { id });
    await sequelize.query("DELETE FROM response_templates WHERE id = :id", { replacements: { id } });
    await audit(req, "template_deleted", { recordType: "response_template", recordId: id, before: before || null });
    req.flash("success_msg", "Template deleted.");
  }
  res.redirect(paths(req).templates);
};

// ------------------------------------------------------------------ audit log (read-only; no edit or delete UI exists)

export const auditLog = async (req, res) => {
  const q = clean(req.query.q, 80);
  const action = clean(req.query.action, 60);
  const outcome = oneOf(req.query.outcome, ["success", "denied", "failed"]);
  const page = toPage(req.query.page);
  const first = await listAudit({ q, action, outcome, limit: 1, offset: 0 });
  const pagination = buildPagination({ total: first.total, page, perPage: 20, basePath: paths(req).audit, query: { q, action, outcome } });
  const { rows, actions } = await listAudit({ q, action, outcome, limit: pagination.limit, offset: pagination.offset });
  render(req, res, "settings/audit", { title: "Audit Log", tab: "audit", rows, actions, q, action, outcome, pagination });
};

// ------------------------------------------------------------------ role-permission matrix (read-only)

export const permissions = async (req, res) => {
  const rows = await permissionMatrix();
  const roles = ["crm_manager", "team_leader", "agent", "customer", "system_admin"];
  render(req, res, "settings/permissions", {
    title: "Roles & Permissions", tab: "permissions", roles,
    rows: rows.map((r) => {
      const has = (r.roles || "").split(",");
      return { ...r, cells: roles.map((role) => has.includes(role)) };
    }),
  });
};
