// Analytics (P9), CRM Manager. Every figure is computed from real rows (services/analyticsService.js); forecasts are statistical
// estimates (services/forecastService.js) shown next to the actual figures and always labelled "Estimate".
import { audit } from "../services/auditService.js";
import { overview, salesIntelligence, customersAndRetention, periodOf } from "../services/analyticsService.js";
import { METRICS, METHOD_LABELS, HORIZON_DAYS, INPUT_DAYS, actualSeries, generateForecast, latestRun, manilaDay } from "../services/forecastService.js";
import { barsBlock, columnsBlock, peso, shortPeso } from "../helpers/charts.js";
import { clean } from "../helpers/validators.js";
import { recomputeSegments, segmentCounts } from "../services/segmentService.js";

export const ANALYTICS_TABS = [["Overview", "/crm/analytics"], ["Sales intelligence", "/crm/analytics/sales"], ["Customers & retention", "/crm/analytics/customers"], ["Forecasts", "/crm/analytics/forecasts"]];
const tabs = (active) => ANALYTICS_TABS.map(([label, href]) => ({ label, href, active: label === active }));
const CHANNELS = { walk_in: "Walk-in", phone: "Phone", portal: "Customer portal", delivery: "Delivery" };
const addDays = (day, k) => new Date(Date.parse(`${day}T00:00:00Z`) + k * 86400e3).toISOString().slice(0, 10);

const filtersOf = (req, basePath) => {
  const period = periodOf({ from: clean(req.query.from, 10), to: clean(req.query.to, 10) });
  const includeDemo = req.query.demo === "1";
  return { ...period, includeDemo, basePath, demoHref: `${basePath}?from=${period.from}&to=${period.to}${includeDemo ? "" : "&demo=1"}` };
};

const salesColumns = async (from, to, includeDemo, title = "Net sales per day (actual)") => {
  const series = await actualSeries("daily_sales_amount", from, to, { includeDemo });
  const shown = series.length > 45 ? series.slice(-45) : series;
  return columnsBlock(title, shown.map((p) => ({ label: p.day.slice(8), value: p.value, tip: `${p.day}: ${peso(p.value)}` })), { format: shortPeso, note: series.length > 45 ? "The last 45 days of the period are shown." : null });
};

export const index = async (req, res) => {
  const f = filtersOf(req, "/crm/analytics");
  const k = await overview(f);
  const run = await latestRun("daily_sales_amount");
  const next7 = run ? run.values.filter((v) => v.day >= manilaDay()).slice(0, 7) : [];
  res.render("analytics/overview", {
    title: "Analytics", areaTabs: tabs("Overview"), f, k, blocks: [await salesColumns(f.from, f.to, f.includeDemo)],
    forecast: run ? { total: next7.reduce((s, v) => s + v.estimate, 0), lower: next7.reduce((s, v) => s + v.lower, 0), upper: next7.reduce((s, v) => s + v.upper, 0), method: METHOD_LABELS[run.method], run } : null,
  });
};

export const sales = async (req, res) => {
  const f = filtersOf(req, "/crm/analytics/sales");
  const d = await salesIntelligence(f);
  const blocks = [
    await salesColumns(f.from, f.to, f.includeDemo),
    barsBlock("Sales by channel", d.byChannel.map((c) => ({ label: CHANNELS[c.label] || c.label, value: c.value })), { format: peso, width: "half" }),
    barsBlock("Top products by revenue", d.products.map((p) => ({ label: `${p.label} (${p.units} sold)`, value: p.revenue })), { format: peso, width: "half" }),
    barsBlock("Revenue by category", d.categories.map((c) => ({ label: c.label, value: c.revenue })), { format: peso, width: "half" }),
    barsBlock("Promotion codes used", d.promos.map((p) => ({ label: `${p.label} (${peso(p.discount)} off)`, value: p.uses })), { unit: " use(s)", width: "half" }),
  ];
  res.render("analytics/sales", { title: "Analytics: sales intelligence", areaTabs: tabs("Sales intelligence"), f, d, blocks });
};

export const customers = async (req, res) => {
  const f = filtersOf(req, "/crm/analytics/customers");
  const d = await customersAndRetention(f);
  const segments = await segmentCounts(f.includeDemo);
  const blocks = [
    barsBlock("Customer segments (rule-based, all customers)", segments.map((s) => ({ label: `${s.name}: ${s.rule_description}`, value: Number(s.customers) })), { unit: " customer(s)" }),
    barsBlock("Buyers in the period, by number of purchases so far", d.segments, { unit: " customer(s)", width: "half" }),
    columnsBlock("New customers per month", d.newCustomers.map((m) => ({ label: m.label.slice(2), value: m.value })), { width: "half" }),
  ];
  res.render("analytics/customers", { title: "Analytics: customers & retention", areaTabs: tabs("Customers & retention"), f, d, blocks });
};

export const forecasts = async (req, res) => {
  const today = manilaDay();
  const sections = [];
  for (const [metric, meta] of Object.entries(METRICS)) {
    const run = await latestRun(metric);
    const actual = await actualSeries(metric, addDays(today, -27), addDays(today, -1), { includeDemo: run ? run.includesDemo : false });
    const fmt = meta.money ? shortPeso : (v) => String(Math.round(v * 10) / 10);
    const points = [
      ...actual.map((p) => ({ label: p.day.slice(8), value: p.value, tip: `${p.day}: ${meta.money ? peso(p.value) : p.value} (actual)` })),
      ...(run ? run.values.filter((v) => v.day >= today).map((v) => ({ label: v.day.slice(8), value: v.estimate, estimate: true, tip: `${v.day}: Estimate ${meta.money ? peso(v.estimate) : v.estimate} (range ${meta.money ? peso(v.lower) : v.lower}–${meta.money ? peso(v.upper) : v.upper})` })) : []),
    ];
    sections.push({
      metric, label: meta.label, money: meta.money, run: run ? { ...run, method_label: METHOD_LABELS[run.method] } : null,
      blocks: [columnsBlock(`${meta.label}: last 28 days actual, then the Estimate`, points, { format: fmt, legend: true, phoneKeep: (i) => i >= actual.length - 7 && i < actual.length + 7 })],
      values: run ? run.values.filter((v) => v.day >= today).map((v) => ({ ...v, estimateText: meta.money ? peso(v.estimate) : v.estimate, range: meta.money ? `${peso(v.lower)} – ${peso(v.upper)}` : `${v.lower} – ${v.upper}` })) : [],
    });
  }
  res.render("analytics/forecasts", { title: "Analytics: forecasts (Estimate)", areaTabs: tabs("Forecasts"), sections, horizon: HORIZON_DAYS, inputDays: INPUT_DAYS });
};

export const segments = async (req, res) => {
  const changed = await recomputeSegments();
  await audit(req, "segments_recomputed", { details: `${changed} customer(s) changed segment` });
  req.flash("success_msg", `Segments recomputed: ${changed} customer(s) changed segment.`);
  res.redirect("/crm/analytics/customers");
};

export const generate = async (req, res) => {
  const includeDemo = req.body.include_demo === "1";
  const out = [];
  for (const metric of Object.keys(METRICS)) out.push(await generateForecast({ metric, user: req.user, req, includeDemo }));
  await audit(req, "forecasts_generated", { details: `${out.length} forecast run(s)${includeDemo ? " including demo data" : ""}` });
  req.flash("success_msg", `New forecasts were computed (${out.map((o) => METHOD_LABELS[o.method]).join(", ")}).${includeDemo ? " They include demo data and are labelled so." : ""}`);
  res.redirect("/crm/analytics/forecasts");
};
