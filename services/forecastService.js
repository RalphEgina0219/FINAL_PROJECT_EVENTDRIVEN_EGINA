/*
 * Forecasts, P9 (blueprint §10, master prompt §XIII). STATISTICAL METHODS ONLY: no AI or machine learning.
 *   moving_average_7   the average of the last 7 days, carried forward
 *   linear_trend_28    a straight line fitted by least squares to the last 28 days
 *   seasonal_naive_7   the same weekday one week earlier
 * Each run back-tests every method on the last 7 days of its input (fit on the days before, predict those 7, compare) and keeps the
 * method with the lowest MAE (mean absolute error). The range shown is the estimate ± 1.96 × the back-test RMSE, never below zero.
 * Every run stores what it used (forecast_runs): metric, method, method version, input period, horizon, error metric and value, and
 * what was excluded. Values are stored per day (forecast_values). Screens label them "Estimate" next to the actual figures.
 * Official runs exclude demo data, cancelled orders and voided sales; a run that includes demo data says so in excluded_note.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { audit } from "./auditService.js";

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });

export const METRICS = {
  daily_sales_amount: { label: "Net sales per day", money: true },
  daily_order_count: { label: "Orders per day", money: false },
  daily_case_count: { label: "New cases per day", money: false },
};
export const METHOD_VERSION = "1.0";
export const INPUT_DAYS = 56;
export const HORIZON_DAYS = 14;
const BACKTEST_DAYS = 7;

// Asia/Manila calendar day (the database stores Manila local time, DB_TIMEZONE=+08:00)
export const manilaDay = (d = new Date()) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const daysBetween = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };

// Actual values per day for a metric. includeDemo = false excludes every is_demo row (the official figures).
export const actualSeries = async (metric, from, to, { includeDemo = false } = {}) => {
  const demo = (alias) => (includeDemo ? "" : `AND ${alias}.is_demo = 0`);
  let rows;
  if (metric === "daily_sales_amount") {
    // completed sales by completion day, minus refunds recorded that day (net of refunds); voided sales never count
    rows = await select(
      `SELECT d, SUM(v) AS v FROM (
         SELECT DATE(s.completed_at) AS d, s.net_amount AS v FROM sales_transactions s WHERE s.status <> 'voided' AND DATE(s.completed_at) BETWEEN :from AND :to ${demo("s")}
         UNION ALL
         SELECT DATE(r.recorded_at) AS d, -r.amount AS v FROM refunds r JOIN sales_transactions s ON s.id = r.sales_transaction_id WHERE r.status = 'recorded' AND DATE(r.recorded_at) BETWEEN :from AND :to ${demo("s")}
       ) x GROUP BY d`, { from, to });
  } else if (metric === "daily_order_count") {
    rows = await select(`SELECT DATE(o.created_at) AS d, COUNT(*) AS v FROM sales_orders o WHERE o.status <> 'cancelled' AND DATE(o.created_at) BETWEEN :from AND :to ${demo("o")} GROUP BY DATE(o.created_at)`, { from, to });
  } else if (metric === "daily_case_count") {
    rows = await select(`SELECT DATE(k.created_at) AS d, COUNT(*) AS v FROM customer_cases k WHERE DATE(k.created_at) BETWEEN :from AND :to ${demo("k")} GROUP BY DATE(k.created_at)`, { from, to });
  } else throw new Error(`Unknown metric ${metric}`);
  const byDay = Object.fromEntries(rows.map((r) => [typeof r.d === "string" ? r.d.slice(0, 10) : manilaDay(new Date(r.d)), Number(r.v)]));
  return daysBetween(from, to).map((day) => ({ day, value: Math.max(0, Math.round((byDay[day] || 0) * 100) / 100) }));
};

// ---------------------------------------------------------------- the three methods (pure functions, unit-testable)
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
export const METHODS = {
  moving_average_7: (history, horizon) => Array(horizon).fill(mean(history.slice(-7))),
  linear_trend_28: (history, horizon) => {
    const y = history.slice(-28);
    const n = y.length;
    if (n < 2) return Array(horizon).fill(y[0] || 0);
    const xs = y.map((_, i) => i);
    const mx = mean(xs);
    const my = mean(y);
    const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    const b = sxx ? xs.reduce((s, x, i) => s + (x - mx) * (y[i] - my), 0) / sxx : 0;
    const a = my - b * mx;
    return Array.from({ length: horizon }, (_, h) => a + b * (n + h));
  },
  seasonal_naive_7: (history, horizon) => Array.from({ length: horizon }, (_, h) => history[history.length - 7 + (h % 7)] ?? 0),
};

export const backtest = (values, method) => {
  const train = values.slice(0, -BACKTEST_DAYS);
  const test = values.slice(-BACKTEST_DAYS);
  const pred = METHODS[method](train, test.length).map((v) => Math.max(0, v));
  const errors = test.map((v, i) => v - pred[i]);
  const mae = mean(errors.map(Math.abs));
  const rmse = Math.sqrt(mean(errors.map((e) => e * e)));
  return { mae, rmse };
};

// Runs, stores and returns one forecast. includeDemo is for demonstrations only: such a run is labelled as including demo data.
export const generateForecast = async ({ metric, user = null, req = null, includeDemo = false, today = manilaDay() }) => {
  if (!METRICS[metric]) throw new Error(`Unknown metric ${metric}`);
  const inputTo = addDays(today, -1); // complete days only
  const inputFrom = addDays(inputTo, -(INPUT_DAYS - 1));
  const series = await actualSeries(metric, inputFrom, inputTo, { includeDemo });
  const values = series.map((p) => p.value);
  const scored = Object.keys(METHODS).map((m) => ({ method: m, ...backtest(values, m) })).sort((a, b) => a.mae - b.mae || a.method.localeCompare(b.method));
  const best = scored[0];
  const estimates = METHODS[best.method](values, HORIZON_DAYS).map((v) => Math.max(0, Math.round(v * 100) / 100));
  const band = 1.96 * best.rmse;
  const excluded = includeDemo ? "INCLUDES DEMO DATA (not official). Cancelled orders and voided sales excluded." : "Demo data, cancelled orders and voided sales excluded; refunds subtracted on the day they were recorded.";
  const [runId] = await sequelize.query(
    `INSERT INTO forecast_runs (metric, subject_key, method, method_version, input_from, input_to, horizon_days, error_metric, error_value, excluded_note, generated_by, generated_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, 'MAE', ?, ?, ?, NOW())`,
    { replacements: [metric, best.method, METHOD_VERSION, inputFrom, inputTo, HORIZON_DAYS, Math.round(best.mae * 10000) / 10000, excluded, user?.id || null] });
  for (let h = 0; h < HORIZON_DAYS; h++) {
    await sequelize.query("INSERT INTO forecast_values (forecast_run_id, period_date, estimate, lower_bound, upper_bound) VALUES (?, ?, ?, ?, ?)",
      { replacements: [runId, addDays(today, h), estimates[h], Math.max(0, Math.round((estimates[h] - band) * 100) / 100), Math.round((estimates[h] + band) * 100) / 100] });
  }
  if (req || user) await audit(req, "forecast_generated", { actor: user, recordType: "forecast_run", recordId: runId, details: `${metric}: ${best.method} (MAE ${best.mae.toFixed(2)}), input ${inputFrom} to ${inputTo}, horizon ${HORIZON_DAYS} days${includeDemo ? ", includes demo data" : ""}` });
  return { runId, method: best.method, scored, inputFrom, inputTo };
};

export const latestRun = async (metric) => {
  const [run] = await select(
    `SELECT r.*, u.display_name AS generated_by_name FROM forecast_runs r LEFT JOIN crm_users u ON u.id = r.generated_by WHERE r.metric = :metric ORDER BY r.generated_at DESC, r.id DESC LIMIT 1`, { metric });
  if (!run) return null;
  const values = await select("SELECT period_date, estimate, lower_bound, upper_bound FROM forecast_values WHERE forecast_run_id = :id ORDER BY period_date", { id: run.id });
  return {
    ...run, error_value: run.error_value === null ? null : Number(run.error_value), includesDemo: /INCLUDES DEMO/.test(run.excluded_note),
    values: values.map((v) => ({ day: typeof v.period_date === "string" ? v.period_date.slice(0, 10) : manilaDay(new Date(v.period_date)), estimate: Number(v.estimate), lower: Number(v.lower_bound), upper: Number(v.upper_bound) })),
  };
};

export const METHOD_LABELS = { moving_average_7: "7-day moving average", linear_trend_28: "Linear trend (28 days, least squares)", seasonal_naive_7: "Same weekday last week (seasonal naive)" };
