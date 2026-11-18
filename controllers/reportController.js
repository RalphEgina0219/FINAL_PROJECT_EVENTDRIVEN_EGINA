// Customer service reports with PDF / Excel / CSV export (CRM Manager: all teams; Team Leader: own team).
import { QueryTypes } from "sequelize";
import { sequelize, CaseCategory, CASE_STATUSES, CASE_PRIORITIES } from "../models/index.js";
import { parseReportFilters, buildReport, reportCases } from "../services/reportService.js";
import { assignableAgents } from "../services/caseService.js";
import { toCsv, toExcel, toPdf } from "../services/exportService.js";
import { audit } from "../services/auditService.js";
import { STATUS_LABELS, PRIORITY_LABELS, CASE_TYPE_LABELS } from "../helpers/labels.js";

const filterNames = async (f) => {
  const [team] = f.team ? await sequelize.query("SELECT name FROM crm_teams WHERE id = :id", { type: QueryTypes.SELECT, replacements: { id: f.team } }) : [];
  const [agent] = f.agent ? await sequelize.query("SELECT display_name AS name FROM crm_users WHERE id = :id", { type: QueryTypes.SELECT, replacements: { id: f.agent } }) : [];
  return {
    category: f.category_id ? (await CaseCategory.findByPk(f.category_id, { raw: true }))?.name : null,
    agent: agent?.name || null,
    team: team?.name || null,
  };
};

const queryString = (f) =>
  new URLSearchParams(Object.entries(f).filter(([k, v]) => v !== null && v !== undefined && v !== "" && k !== "team_fixed")).toString();

export const show = async (req, res) => {
  const filters = parseReportFilters(req.query, req.user);
  const isManager = req.user.role === "crm_manager";
  const [report, categories, agents, teams, names] = await Promise.all([
    buildReport(filters),
    CaseCategory.findAll({ attributes: ["id", "name"], order: [["name", "ASC"]], raw: true }),
    assignableAgents(req.user),
    isManager ? sequelize.query("SELECT id, name FROM crm_teams ORDER BY team_code", { type: QueryTypes.SELECT }) : Promise.resolve([]),
    filterNames(filters),
  ]);
  const max = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.total)), 0);
  const chartData = {
    trend: { labels: report.trend.map((t) => t.period), created: report.trend.map((t) => t.created), resolved: report.trend.map((t) => t.resolved) },
    category: { labels: report.byCategory.map((c) => c.name), values: report.byCategory.map((c) => Number(c.total)) },
  };
  res.render("reports/index", {
    title: isManager ? "Reports" : "Team Reports",
    report, filters, categories, agents, teams, isManager, teamName: names.team,
    qs: queryString(filters),
    chartJson: JSON.stringify(chartData).replace(/</g, "\\u003c"),
    statusOptions: CASE_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
    priorityOptions: CASE_PRIORITIES.map((value) => ({ value, label: PRIORITY_LABELS[value] })),
    byPriority: report.byPriority.map((p) => ({ ...p, label: PRIORITY_LABELS[p.priority] })),
    byStatus: report.byStatus.map((s) => ({ ...s, label: STATUS_LABELS[s.status] })),
    byType: report.byType.map((c) => ({ ...c, label: CASE_TYPE_LABELS[c.case_type] })),
    maxPriority: max(report.byPriority),
    maxStatus: max(report.byStatus),
    maxType: max(report.byType),
    maxComplaints: max(report.topComplaints),
    maxCsat: report.csat.distribution.reduce((m, d) => Math.max(m, d.total), 0),
  });
};

export const exportReport = async (req, res) => {
  const format = req.params.format;
  if (!["csv", "xlsx", "pdf"].includes(format)) {
    return res.status(404).render("error", { title: "Not found", status: 404, message: "Unknown export format." });
  }
  const filters = parseReportFilters(req.query, req.user);
  const [report, names] = await Promise.all([buildReport(filters), filterNames(filters)]);
  const base = `johnvivz-crm-service-report_${filters.from}_to_${filters.to}`;
  await audit(req, "report_exported", { details: `${format.toUpperCase()} ${filters.from} to ${filters.to}${names.team ? ` · ${names.team}` : ""}` });

  if (format === "csv") {
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.attachment(`${base}.csv`);
    return res.send(toCsv(report, await reportCases(filters), names));
  }
  if (format === "xlsx") {
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.attachment(`${base}.xlsx`);
    return res.send(Buffer.from(await toExcel(report, await reportCases(filters), names)));
  }
  res.set("Content-Type", "application/pdf");
  res.attachment(`${base}.pdf`);
  return res.send(await toPdf(report, names));
};
