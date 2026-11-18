// Basic security headers (no external package).
export const securityHeaders = (req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  next();
};

// Signed-in pages must not be cached, so Back after logout does not show private data.
export const noStore = (req, res, next) => {
  if (req.user) res.set("Cache-Control", "no-store");
  next();
};
