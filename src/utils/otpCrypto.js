import crypto from "node:crypto";
import { env } from "../config/env.js";

/**
 * Generates a cryptographically secure numeric OTP of the configured length
 * (default 6 digits) using Node's CSPRNG (crypto.randomInt), not Math.random().
 * Zero-padded so every code is exactly `length` digits, including leading zeros.
 */
export function generateOtp(length = env.otp.length) {
  const max = 10 ** length;
  const code = crypto.randomInt(0, max); // uniform, cryptographically secure
  return String(code).padStart(length, "0");
}

/**
 * OTPs are never stored in plaintext. We store HMAC-SHA256(code, pepper) instead
 * of a bare SHA-256 hash, so a database-only leak still can't be brute-forced
 * offline without the pepper (kept only in server env, never in the DB).
 */
export function hashOtp(code) {
  return crypto.createHmac("sha256", env.otp.hashPepper).update(code).digest("hex");
}

/**
 * Constant-time comparison to avoid leaking hash equality via timing.
 */
export function verifyOtpHash(candidateCode, storedHash) {
  const candidateHash = Buffer.from(hashOtp(candidateCode), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (candidateHash.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidateHash, stored);
}
