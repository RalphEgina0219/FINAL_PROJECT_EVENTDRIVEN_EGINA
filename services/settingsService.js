/*
 * CRM rules (crm_settings) and SLA targets (service_targets), cached in memory so business rules
 * can read them synchronously. Falls back to .env values (config/index.js) if a row is missing.
 * SLA changes insert a new service_targets row (effective now), so earlier targets stay on record.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { config } from "../config/index.js";

export const PRIORITIES = ["urgent", "high", "medium", "low"];

const fromConfig = () => ({
  autoCloseDays: config.cases.autoCloseDays,
  reopenWindowDays: config.cases.reopenWindowDays,
  firstResponseHours: { ...config.sla.firstResponseHours },
  resolutionHours: { ...config.sla.resolutionHours },
});

let cache = fromConfig();

export const getSettings = () => cache;

export const loadSettings = async () => {
  const base = fromConfig();
  try {
    const rows = await sequelize.query("SELECT setting_key, setting_value FROM crm_settings", { type: QueryTypes.SELECT });
    const map = Object.fromEntries(rows.map((r) => [r.setting_key, Number.parseInt(r.setting_value, 10)]));
    const pick = (key, fallback) => (Number.isFinite(map[key]) && map[key] >= 0 ? map[key] : fallback);
    // Latest default (team_id NULL) target per priority that is already effective.
    const targets = await sequelize.query(
      `SELECT st.priority, st.first_response_minutes, st.resolution_minutes FROM service_targets st
       JOIN (SELECT priority, MAX(effective_from) AS ef FROM service_targets
             WHERE team_id IS NULL AND effective_from <= NOW() GROUP BY priority) latest
         ON latest.priority = st.priority AND latest.ef = st.effective_from
       WHERE st.team_id IS NULL`,
      { type: QueryTypes.SELECT }
    );
    const byPriority = Object.fromEntries(targets.map((t) => [t.priority, t]));
    cache = {
      autoCloseDays: pick("auto_close_days", base.autoCloseDays),
      reopenWindowDays: pick("reopen_window_days", base.reopenWindowDays),
      firstResponseHours: Object.fromEntries(PRIORITIES.map((p) => [p, byPriority[p] ? byPriority[p].first_response_minutes / 60 : base.firstResponseHours[p]])),
      resolutionHours: Object.fromEntries(PRIORITIES.map((p) => [p, byPriority[p] ? byPriority[p].resolution_minutes / 60 : base.resolutionHours[p]])),
    };
  } catch {
    cache = base; // tables not migrated yet
  }
  return cache;
};

export const SETTING_FIELDS = [
  { key: "auto_close_days", label: "Auto-close Resolved cases after (days)", min: 1, max: 60 },
  { key: "reopen_window_days", label: "A case can be reopened within (days)", min: 1, max: 90 },
  ...PRIORITIES.flatMap((p) => [
    { key: `sla_first_response_hours_${p}`, label: `First response target — ${p} (hours)`, min: 1, max: 720, priority: p },
    { key: `sla_resolution_hours_${p}`, label: `Resolution target — ${p} (hours)`, min: 1, max: 2160, priority: p },
  ]),
];

export const currentValue = (key) => {
  const s = cache;
  if (key === "auto_close_days") return s.autoCloseDays;
  if (key === "reopen_window_days") return s.reopenWindowDays;
  const m = key.match(/^sla_(first_response|resolution)_hours_(\w+)$/);
  if (!m) return null;
  return m[1] === "first_response" ? s.firstResponseHours[m[2]] : s.resolutionHours[m[2]];
};

// Saves validated integer values (keys from SETTING_FIELDS) and refreshes the cache.
export const saveSettings = async (values, userId) => {
  await sequelize.transaction(async (transaction) => {
    for (const key of ["auto_close_days", "reopen_window_days"]) {
      await sequelize.query(
        "UPDATE crm_settings SET setting_value = :value, updated_by = :userId WHERE setting_key = :key",
        { replacements: { key, value: String(values[key]), userId }, transaction }
      );
    }
    for (const p of PRIORITIES) {
      const first = values[`sla_first_response_hours_${p}`] * 60;
      const resolution = values[`sla_resolution_hours_${p}`] * 60;
      const current = cache;
      if (current.firstResponseHours[p] * 60 === first && current.resolutionHours[p] * 60 === resolution) continue;
      await sequelize.query(
        `INSERT INTO service_targets (priority, team_id, first_response_minutes, resolution_minutes, effective_from, updated_by)
         VALUES (:p, NULL, :first, :resolution, NOW(), :userId)`,
        { replacements: { p, first, resolution, userId }, transaction }
      );
    }
  });
  return loadSettings();
};
