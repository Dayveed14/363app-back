import { env } from "../config/env.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF protection for cookie-authenticated, state-changing requests.
 *
 * Auth rides on httpOnly cookies (SameSite=None in production, because the
 * frontend and API sit on different domains), so a malicious page could make
 * the browser send an authenticated cross-site POST. Two independent checks
 * must BOTH pass for every unsafe request:
 *
 *  1. Custom header. The frontend sends `X-Requested-With: 363app` on every
 *     request. A cross-site page can't add a custom header without a CORS
 *     preflight, and our CORS policy only approves our own origins.
 *  2. Origin. When the browser sends an Origin header (it always does for
 *     cross-origin POSTs), it must be one of our allowed origins.
 *
 * Non-browser callers (curl, server-to-server) send no Origin; they still
 * need the custom header. The Paystack webhook is exempt — it carries no
 * cookies and authenticates with an HMAC signature instead.
 */
export const CSRF_HEADER = "x-requested-with";
export const CSRF_HEADER_VALUE = "363app";

const EXEMPT_PATHS = new Set(["/api/webhooks/paystack"]);

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method) || EXEMPT_PATHS.has(req.path)) return next();

  const origin = req.get("origin");
  if (origin && !env.allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: "Request blocked: untrusted origin.", code: "csrf_origin" });
  }

  if (req.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    return res.status(403).json({ error: "Request blocked: missing security header.", code: "csrf_header" });
  }

  next();
}
