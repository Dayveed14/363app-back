import { env } from "../config/env.js";
import { generateOtp, hashOtp, verifyOtpHash } from "../utils/otpCrypto.js";
import * as otpModel from "../models/otp.model.js";

export const OTP_PURPOSE = {
  EMAIL_VERIFICATION: "email_verification",
  LOGIN_2FA: "login_2fa",
  WITHDRAWAL: "withdrawal",
};

/**
 * Issues a new OTP for a user+purpose. Any previously active OTP for the same
 * user+purpose is invalidated first (createOtp does this atomically), so only
 * ever one active code exists at a time — requesting a new one always
 * supersedes the last.
 *
 * Returns the plaintext code ONLY so the caller can email it immediately.
 * Never log, return in an API response, or persist this value anywhere else.
 */
export async function issueOtp({ userId, purpose }) {
  const code = generateOtp(env.otp.length);
  const otpHash = hashOtp(code);
  await otpModel.createOtp({ userId, purpose, otpHash });
  return code;
}

/**
 * Verifies a submitted code against the active OTP for this user+purpose.
 * Enforces: existence, expiry, single-use, and max-attempt lockout.
 * Returns { ok: true } or { ok: false, reason } — reason is safe to surface
 * to the client (it never includes the code or hash).
 */
export async function verifyOtp({ userId, purpose, code }) {
  const otp = await otpModel.findActiveOtp({ userId, purpose });

  if (!otp) {
    return { ok: false, reason: "no_active_otp" };
  }

  if (new Date(otp.expires_at).getTime() < Date.now()) {
    await otpModel.invalidateOtp(otp.id);
    return { ok: false, reason: "expired" };
  }

  if (otp.attempts >= otp.max_attempts) {
    await otpModel.invalidateOtp(otp.id);
    return { ok: false, reason: "too_many_attempts" };
  }

  // Reserve an attempt BEFORE comparing, atomically. (Check-then-increment lets
  // a burst of parallel guesses all slip past the cap.)
  const claimed = await otpModel.claimAttempt(otp.id);
  if (!claimed) {
    await otpModel.invalidateOtp(otp.id);
    return { ok: false, reason: "too_many_attempts" };
  }
  const attemptsUsed = otp.attempts + 1;

  const matches = verifyOtpHash(code, otp.otp_hash);

  if (!matches) {
    const attemptsLeft = otp.max_attempts - attemptsUsed;
    if (attemptsLeft <= 0) {
      await otpModel.invalidateOtp(otp.id);
      return { ok: false, reason: "too_many_attempts" };
    }
    return { ok: false, reason: "incorrect", attemptsLeft };
  }

  // Single-use, enforced by the database: only the request whose UPDATE
  // actually flips consumed_at succeeds. A concurrent duplicate with the same
  // correct code loses here.
  const consumed = await otpModel.consumeOtp(otp.id);
  if (!consumed) return { ok: false, reason: "no_active_otp" };
  return { ok: true };
}
