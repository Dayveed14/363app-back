import { verifyAccessToken } from "../services/token.service.js";
import { env } from "../config/env.js";

export function requireAuth(req, res, next) {
  const token = req.cookies?.[env.cookies.accessName];

  if (!token) {
    return res.status(401).json({ error: "Not signed in." });
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      memberId: payload.memberId,
      status: payload.status,
      role: payload.role,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
}

/**
 * Must run after requireAuth. Kept as a separate middleware (rather than a
 * flag on requireAuth) so route files read as explicit about which
 * endpoints are admin-only. Role comes from the JWT, which is only as
 * fresh as the last login/refresh (up to 15 min) — an acceptable tradeoff
 * here since it means a demoted admin keeps old (not new) access briefly,
 * never the other way around.
 */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}
