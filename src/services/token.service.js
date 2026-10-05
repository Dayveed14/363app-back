import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../config/env.js";
import * as refreshTokenModel from "../models/refreshToken.model.js";
import { parseExpiryToMs } from "../utils/time.js";

export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      memberId: user.member_id,
      status: user.status,
      role: user.role,
      type: "access",
    },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessExpiresIn }
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret);
}

/**
 * Refresh tokens are random opaque strings (not JWTs) so they carry no
 * decodable claims. We store only a SHA-256 hash of the token server-side,
 * which is what makes revocation (logout, rotation) possible.
 */
export async function issueRefreshToken(user, { userAgent, ip } = {}) {
  const token = crypto.randomBytes(48).toString("hex");
  const expiresAt = new Date(Date.now() + parseExpiryToMs(env.jwt.refreshExpiresIn));
  await refreshTokenModel.storeRefreshToken({ userId: user.id, token, expiresAt, userAgent, ip });
  return token;
}

export async function rotateRefreshToken(oldToken, user, meta) {
  await refreshTokenModel.revokeRefreshToken(oldToken);
  return issueRefreshToken(user, meta);
}

/**
 * Short-lived JWT issued after password verification, before 2FA is complete.
 * It only ever authorizes a call to /auth/login/verify-otp for this one user —
 * it is not an access token and carries no account access on its own.
 */
export function signPendingTwoFactorToken(user) {
  return jwt.sign({ sub: user.id, type: "pending_2fa" }, env.jwt.pending2faSecret, {
    expiresIn: env.jwt.pending2faExpiresIn,
  });
}

export function verifyPendingTwoFactorToken(token) {
  const payload = jwt.verify(token, env.jwt.pending2faSecret);
  if (payload.type !== "pending_2fa") throw new Error("Invalid token type");
  return payload;
}

/**
 * Short-lived JWT issued after a withdrawal request's amount/bank details
 * pass validation, before OTP confirmation. The amount and bank details
 * are baked into the signed payload (not just the user id) so the OTP step
 * can't be tricked into confirming different numbers than what was
 * actually validated and OTP'd for — the confirm step re-reads them from
 * here, never from the client's second request.
 */
export function signPendingWithdrawalToken(user, { amount, bankName, accountNumber, accountName }) {
  return jwt.sign(
    { sub: user.id, amount, bankName, accountNumber, accountName, type: "pending_withdrawal" },
    env.jwt.pendingWithdrawalSecret,
    { expiresIn: env.jwt.pendingWithdrawalExpiresIn }
  );
}

export function verifyPendingWithdrawalToken(token) {
  const payload = jwt.verify(token, env.jwt.pendingWithdrawalSecret);
  if (payload.type !== "pending_withdrawal") throw new Error("Invalid token type");
  return payload;
}
