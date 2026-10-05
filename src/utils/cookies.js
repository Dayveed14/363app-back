import { env } from "../config/env.js";
import { parseExpiryToMs } from "./time.js";

/**
 * Every token this API issues (access, refresh, and the short-lived
 * pending-2FA token) lives only in httpOnly cookies — never in a JSON
 * response body, never in localStorage, never readable by frontend JS.
 * This is the one place cookie flags are decided, so the security posture
 * can't drift between endpoints.
 */
function baseOptions() {
  const isProd = env.nodeEnv === "production";
  return {
    httpOnly: true,
    // HTTPS only in production (Render/Vercel both terminate TLS for us).
    // Plain http://localhost in dev can't set Secure cookies, so this must
    // stay false locally or the browser silently drops them.
    secure: isProd,
    // Frontend and backend are on different domains in production (e.g.
    // Vercel + Render), which is a cross-site request as far as cookies are
    // concerned — that requires SameSite=None (and therefore Secure=true).
    // In dev, frontend/backend are both on "localhost" (different ports),
    // which browsers treat as same-site, so Lax works fine over plain http.
    sameSite: isProd ? "none" : "lax",
    domain: env.cookies.domain,
  };
}

export function setAccessCookie(res, token) {
  res.cookie(env.cookies.accessName, token, {
    ...baseOptions(),
    path: "/",
    maxAge: parseExpiryToMs(env.jwt.accessExpiresIn),
  });
}

export function setRefreshCookie(res, token) {
  res.cookie(env.cookies.refreshName, token, {
    ...baseOptions(),
    // Scoped narrowly — this cookie only needs to be sent to the two
    // endpoints that use it, not every API call.
    path: "/api/auth",
    maxAge: parseExpiryToMs(env.jwt.refreshExpiresIn),
  });
}

export function setPending2faCookie(res, token) {
  res.cookie(env.cookies.pending2faName, token, {
    ...baseOptions(),
    path: "/api/auth",
    maxAge: parseExpiryToMs(env.jwt.pending2faExpiresIn),
  });
}

export function clearPending2faCookie(res) {
  res.clearCookie(env.cookies.pending2faName, { ...baseOptions(), path: "/api/auth" });
}

export function setPendingWithdrawalCookie(res, token) {
  res.cookie(env.cookies.pendingWithdrawalName, token, {
    ...baseOptions(),
    path: "/api/withdrawals",
    maxAge: parseExpiryToMs(env.jwt.pendingWithdrawalExpiresIn),
  });
}

export function clearPendingWithdrawalCookie(res) {
  res.clearCookie(env.cookies.pendingWithdrawalName, { ...baseOptions(), path: "/api/withdrawals" });
}

export function clearAuthCookies(res) {
  res.clearCookie(env.cookies.accessName, { ...baseOptions(), path: "/" });
  res.clearCookie(env.cookies.refreshName, { ...baseOptions(), path: "/api/auth" });
  res.clearCookie(env.cookies.pending2faName, { ...baseOptions(), path: "/api/auth" });
  res.clearCookie(env.cookies.pendingWithdrawalName, { ...baseOptions(), path: "/api/withdrawals" });
}
