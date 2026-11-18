// Small input helpers. All user input is trimmed, length-limited and checked against allow-lists.

export const clean = (value, max = 255) =>
  String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);

export const cleanText = (value, max = 5000) =>
  String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);

export const isEmail = (value) =>
  typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

export const toId = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 && String(n) === String(value).trim() ? n : null;
};

export const toPage = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 10000) : 1;
};

export const oneOf = (value, allowed) => (allowed.includes(value) ? value : null);

export const isPhone = (value) => /^[0-9+()\-\s]{7,20}$/.test(value);
