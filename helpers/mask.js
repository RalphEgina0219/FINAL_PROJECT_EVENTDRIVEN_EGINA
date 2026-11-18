// Masking of customer personal data in general (list) views (blueprint §11). Full values are shown
// only on detail pages to roles with customers.view_full_contact.

export const maskEmail = (email) => {
  if (!email) return "—";
  const [local, domain] = String(email).split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
};

export const maskMobile = (mobile) => {
  if (!mobile) return "—";
  const digits = String(mobile).replace(/\D/g, "");
  if (digits.length < 7) return "***";
  return `${digits.slice(0, 4)} *** ${digits.slice(-4)}`;
};

// "09171234567" from "+63 917 123 4567", "0917-123-4567", ...
export const normalizeMobile = (mobile) => {
  if (!mobile) return null;
  let d = String(mobile).replace(/\D/g, "");
  if (d.startsWith("63") && d.length === 12) d = "0" + d.slice(2);
  if (d.length === 10 && d.startsWith("9")) d = "0" + d;
  return d || null;
};

export const normalizeEmail = (email) => (email ? String(email).trim().toLowerCase() : null);
