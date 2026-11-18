/*
 * 111 — forecast_runs, forecast_values  [CRM-LOCAL] (blueprint §10, master prompt §XIII)
 * Statistical forecasts only (moving average, linear trend, seasonal-naive; no AI/ML). Every run
 * stores its method, version, input period, horizon and backtest error so the screen can show the
 * basis of each "Estimate" next to the actual figures.
 */
import { run, dropTables } from "./_sql.js";

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE forecast_runs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      metric ENUM('daily_sales_amount','daily_order_count','daily_case_count','product_demand') NOT NULL,
      subject_key VARCHAR(64) NULL COMMENT 'product_id or category for product_demand',
      method VARCHAR(60) NOT NULL COMMENT 'moving_average_7, linear_trend, seasonal_naive_7',
      method_version VARCHAR(20) NOT NULL,
      input_from DATE NOT NULL,
      input_to DATE NOT NULL,
      horizon_days INT NOT NULL,
      error_metric VARCHAR(20) NOT NULL COMMENT 'MAPE or MAE',
      error_value DECIMAL(12,4) NULL,
      excluded_note VARCHAR(255) NOT NULL COMMENT 'what was excluded: cancelled, voided, demo, duplicates',
      generated_by INT NULL,
      generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT forecast_runs_period_chk CHECK (input_to >= input_from AND horizon_days > 0),
      CONSTRAINT forecast_runs_user_fk FOREIGN KEY (generated_by) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE forecast_values (
      forecast_run_id INT NOT NULL,
      period_date DATE NOT NULL,
      estimate DECIMAL(14,2) NOT NULL,
      lower_bound DECIMAL(14,2) NULL,
      upper_bound DECIMAL(14,2) NULL,
      PRIMARY KEY (forecast_run_id, period_date),
      CONSTRAINT forecast_values_run_fk FOREIGN KEY (forecast_run_id) REFERENCES forecast_runs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]);
};

export const down = async ({ sequelize }) => dropTables(sequelize, ["forecast_values", "forecast_runs"]);
