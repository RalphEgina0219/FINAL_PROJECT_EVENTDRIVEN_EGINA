/*
 * HMAC request signing (docs/integration-contract.md §2). One implementation is used both to sign what CRM sends and to
 * verify what other apps send, so the two directions can never drift apart.
 *
 *   X-JVZ-Client:    johnvivz_crm | johnvivz_hr | johnvivz_inventory | johnvivz_accounting
 *   X-JVZ-Timestamp: ISO-8601 with offset, e.g. 2026-11-11T09:30:00.000+08:00
 *   X-JVZ-Signature: hex(HMAC_SHA256(secret, METHOD + "\n" + path + "\n" + timestamp + "\n" + sha256hex(body)))
 *
 * `path` is the request target exactly as sent: the URL path PLUS the query string (so the query is signed too).
 * `body` is the raw request body bytes ("" when there is none).
 */
import crypto from "crypto";

export const sha256Hex = (data) => crypto.createHash("sha256").update(data ?? "").digest("hex");

export const canonicalString = ({ method, path, timestamp, body }) => [String(method).toUpperCase(), path, timestamp, sha256Hex(body ?? "")].join("\n");

export const signRequest = ({ secret, method, path, timestamp, body }) =>
  crypto.createHmac("sha256", secret).update(canonicalString({ method, path, timestamp, body })).digest("hex");

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

// ISO-8601 with the +08:00 offset the whole JOHNVIVZ system uses (Asia/Manila has no daylight saving time).
export const isoWithOffset = (date = new Date()) => new Date(date.getTime() + 8 * 3600 * 1000).toISOString().replace("Z", "+08:00");

/*
 * Returns { ok: true } or { ok: false, reason } where reason is one of
 * missing_headers | bad_timestamp | stale_timestamp | bad_signature.
 */
export const verifyRequest = ({ secret, method, path, timestamp, body, signature, now = Date.now(), maxSkewSeconds = 300 }) => {
  if (!secret || !timestamp || !signature) return { ok: false, reason: "missing_headers" };
  if (!ISO_WITH_OFFSET.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  const sent = Date.parse(timestamp);
  if (!Number.isFinite(sent)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(now - sent) > maxSkewSeconds * 1000) return { ok: false, reason: "stale_timestamp" };
  const expected = Buffer.from(signRequest({ secret, method, path, timestamp, body }), "hex");
  let given;
  try { given = Buffer.from(String(signature), "hex"); } catch { return { ok: false, reason: "bad_signature" }; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
};
