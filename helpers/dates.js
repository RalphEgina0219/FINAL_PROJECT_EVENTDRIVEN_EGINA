import { config } from "../config/index.js";

const tz = config.timezone;

const partsFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });

// "20261106" for the local (Asia/Manila) calendar day of the given date.
export const dateKey = (date = new Date()) => partsFormatter.format(date).replaceAll("-", "");

// "2026-11-06" for the local calendar day.
export const isoDay = (date = new Date()) => partsFormatter.format(date);

export const addHours = (date, hours) => new Date(new Date(date).getTime() + hours * 3600 * 1000);

const dateTimeFormatter = new Intl.DateTimeFormat("en-PH", {
  timeZone: tz, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});
const dateFormatter = new Intl.DateTimeFormat("en-PH", { timeZone: tz, year: "numeric", month: "short", day: "numeric" });

export const formatDateTime = (value) => (value ? dateTimeFormatter.format(new Date(value)) : "—");
export const formatDate = (value) => (value ? dateFormatter.format(new Date(value)) : "—");

export const timeAgo = (value) => {
  if (!value) return "—";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  const future = seconds < 0;
  const s = Math.abs(seconds);
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      const label = `${n} ${unit}${n === 1 ? "" : "s"}`;
      return future ? `in ${label}` : `${label} ago`;
    }
  }
  return future ? "in a moment" : "just now";
};

// "3h 20m" style duration from minutes.
export const formatDuration = (minutes) => {
  if (minutes === null || minutes === undefined || Number.isNaN(Number(minutes))) return "—";
  const m = Math.round(Number(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};
