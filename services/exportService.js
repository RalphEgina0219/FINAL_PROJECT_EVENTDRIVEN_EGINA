/*
 * Report exports. Each export uses exactly the filters shown on screen.
 *   CSV   — hand-written (summary + case rows)
 *   Excel — exceljs (Summary, Categories, Agents, Trend, Cases sheets)
 *   PDF   — pdfkit (summary, breakdowns, agent performance)
 */
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { STATUS_LABELS, PRIORITY_LABELS, CASE_TYPE_LABELS } from "../helpers/labels.js";
import { formatDateTime, formatDuration } from "../helpers/dates.js";

const pctText = (v) => (v === null || v === undefined ? "—" : `${v}%`);
const fixed = (v, d = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));

const summaryRows = (report) => {
  const { kpi, csat } = report;
  return [
    ["Total cases", kpi.total],
    ["Active (not resolved)", kpi.active],
    ["Resolved / Closed", kpi.resolved],
    ["Resolution rate", pctText(kpi.resolution_rate)],
    ["Overdue now", kpi.overdue],
    ["Average first response", formatDuration(kpi.avg_first_response)],
    ["Average resolution time", formatDuration(kpi.avg_resolution)],
    ["SLA compliance — first response", pctText(kpi.sla_first_response_pct)],
    ["SLA compliance — resolution", pctText(kpi.sla_resolution_pct)],
    ["Reopen rate", pctText(kpi.reopen_rate)],
    ["CSAT average (1–5)", fixed(csat.avg)],
    ["Satisfied customers (4–5 stars)", pctText(csat.satisfied_pct)],
    ["Ratings received", csat.total],
    ["Demo records included", kpi.demo_count],
  ];
};

const filterText = (f, names) =>
  [
    `Date: ${f.from} to ${f.to}`,
    f.category_id ? `Category: ${names.category || f.category_id}` : null,
    f.priority ? `Priority: ${PRIORITY_LABELS[f.priority]}` : null,
    f.agent ? `Agent: ${names.agent || f.agent}` : null,
    f.status ? `Status: ${STATUS_LABELS[f.status]}` : null,
    f.team ? `Team: ${names.team || f.team}` : null,
  ].filter(Boolean).join(" · ");

const caseRow = (t) => [
  t.case_no, formatDateTime(t.created_at), t.subject, CASE_TYPE_LABELS[t.case_type], t.category,
  PRIORITY_LABELS[t.priority], STATUS_LABELS[t.status], t.customer, t.agent || "Unassigned",
  t.first_response_minutes ?? "", t.resolution_minutes ?? "", t.is_overdue ? "Yes" : "No", t.reopen_count, t.rating ?? "", t.is_demo ? "Demo" : "Real",
];
const CASE_HEADERS = ["Case No", "Created", "Subject", "Type", "Category", "Priority", "Status", "Customer", "Agent",
  "First response (min)", "Resolution (min)", "Overdue", "Reopened", "Rating", "Record"];

// ------------------------------------------------------------------ CSV

const csvCell = (v) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // block spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (report, cases, names) => {
  const lines = [
    ["JOHNVIVZ CRM Customer Service Report"], [filterText(report.filters, names)], [],
    ["Metric", "Value"], ...summaryRows(report), [],
    ["Category", "Cases", "Resolved"], ...report.byCategory.map((c) => [c.name, c.total, c.resolved]), [],
    ["Agent", "Handled", "Resolved", "Avg first response (min)", "Avg resolution (min)", "Avg rating"],
    ...report.agents.map((a) => [a.name, a.handled, a.resolved, fixed(a.avg_first_response, 0), fixed(a.avg_resolution, 0), fixed(a.avg_rating)]),
    [], CASE_HEADERS, ...cases.map(caseRow),
  ];
  return "﻿" + lines.map((row) => row.map(csvCell).join(",")).join("\r\n");
};

// ------------------------------------------------------------------ Excel

export const toExcel = async (report, cases, names) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = "JOHNVIVZ CRM";
  wb.created = new Date();
  const bold = { bold: true };
  const addSheet = (name, headers, rows, widths = []) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(headers).font = bold;
    rows.forEach((r) => ws.addRow(r));
    headers.forEach((_, i) => { ws.getColumn(i + 1).width = widths[i] || 18; });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    return ws;
  };

  const summary = wb.addWorksheet("Summary");
  summary.addRow(["JOHNVIVZ CRM Customer Service Report"]).font = { bold: true, size: 14 };
  summary.addRow([filterText(report.filters, names)]);
  summary.addRow([]);
  summary.addRow(["Metric", "Value"]).font = bold;
  summaryRows(report).forEach((r) => summary.addRow(r));
  summary.getColumn(1).width = 36;
  summary.getColumn(2).width = 20;

  addSheet("By Category", ["Category", "Cases", "Resolved"], report.byCategory.map((c) => [c.name, c.total, c.resolved]), [30]);
  addSheet("By Priority & Status",
    ["Priority", "Cases", "", "Status", "Cases"],
    Array.from({ length: Math.max(report.byPriority.length, report.byStatus.length) }, (_, i) => [
      report.byPriority[i] ? PRIORITY_LABELS[report.byPriority[i].priority] : "", report.byPriority[i]?.total ?? "", "",
      report.byStatus[i] ? STATUS_LABELS[report.byStatus[i].status] : "", report.byStatus[i]?.total ?? "",
    ]));
  addSheet("Agents", ["Agent", "Handled", "Resolved", "Overdue", "Avg first response (min)", "Avg resolution (min)", "Avg rating", "Ratings"],
    report.agents.map((a) => [a.name, a.handled, a.resolved, a.overdue, a.avg_first_response === null ? null : Math.round(a.avg_first_response),
      a.avg_resolution === null ? null : Math.round(a.avg_resolution), a.avg_rating === null ? null : Number(Number(a.avg_rating).toFixed(2)), a.ratings]), [24]);
  addSheet("Trend", ["Period", "Created", "Resolved"], report.trend.map((t) => [t.period, t.created, t.resolved]));
  addSheet("CSAT", ["Stars", "Ratings"], report.csat.distribution.map((d) => [d.rating, d.total]));
  addSheet("Cases", CASE_HEADERS, cases.map(caseRow), [20, 20, 40, 16, 20, 10, 12, 22, 22]);

  return wb.xlsx.writeBuffer();
};

// ------------------------------------------------------------------ PDF

export const toPdf = (report, names) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const ensureSpace = (h) => { if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage(); };

    const table = (title, headers, rows, colWidths) => {
      ensureSpace(60);
      doc.moveDown(0.8).font("Helvetica-Bold").fontSize(12).fillColor("#0f172a").text(title, left);
      doc.moveDown(0.3);
      const drawRow = (cells, isHeader) => {
        ensureSpace(18);
        const y = doc.y;
        let x = left;
        doc.font(isHeader ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(isHeader ? "#334155" : "#0f172a");
        cells.forEach((cell, i) => {
          doc.text(String(cell ?? "—"), x + 2, y + 3, { width: colWidths[i] - 4, height: 12, ellipsis: true });
          x += colWidths[i];
        });
        doc.moveTo(left, y + 16).lineTo(left + width, y + 16).strokeColor("#e2e8f0").lineWidth(0.5).stroke();
        doc.y = y + 17;
      };
      drawRow(headers, true);
      if (!rows.length) drawRow(["No data", ...headers.slice(1).map(() => "")], false);
      rows.forEach((r) => drawRow(r, false));
    };

    doc.font("Helvetica-Bold").fontSize(18).fillColor("#6d28d9").text("JOHNVIVZ CRM");
    doc.font("Helvetica").fontSize(12).fillColor("#0f172a").text("Customer Service Report");
    doc.fontSize(9).fillColor("#475569").text(filterText(report.filters, names));
    doc.text(`Generated ${formatDateTime(new Date())}`);
    if (report.kpi.demo_count) doc.fillColor("#6d28d9").text(`Includes ${report.kpi.demo_count} demo record(s) created by the seeder.`);

    const half = width / 2;
    table("Summary", ["Metric", "Value"], summaryRows(report), [half + 60, half - 60]);
    table("Cases by category", ["Category", "Cases", "Resolved"], report.byCategory.map((c) => [c.name, c.total, c.resolved]), [width - 160, 80, 80]);
    table("Top 5 complaint categories", ["Category", "Complaints"], report.topComplaints.map((c) => [c.name, c.total]), [width - 100, 100]);
    table("Cases by priority", ["Priority", "Cases"], report.byPriority.map((p) => [PRIORITY_LABELS[p.priority], p.total]), [width - 100, 100]);
    table("Cases by status", ["Status", "Cases"], report.byStatus.map((s) => [STATUS_LABELS[s.status], s.total]), [width - 100, 100]);
    table("Agent performance", ["Agent", "Handled", "Resolved", "Avg 1st resp.", "Avg resolution", "Avg rating"],
      report.agents.map((a) => [a.name, a.handled, a.resolved, formatDuration(a.avg_first_response), formatDuration(a.avg_resolution), a.ratings ? fixed(a.avg_rating, 1) : "—"]),
      [width - 340, 55, 60, 75, 80, 70]);
    table("Customer satisfaction (CSAT)", ["Stars", "Ratings"], report.csat.distribution.map((d) => [`${d.rating} star`, d.total]), [width - 100, 100]);
    table(`Trend (${report.filters.period})`, ["Period", "Created", "Resolved"], report.trend.map((t) => [t.period, t.created, t.resolved]), [width - 160, 80, 80]);
    doc.end();
  });
