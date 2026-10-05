import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import * as userModel from "../models/user.model.js";
import * as refreshTokenModel from "../models/refreshToken.model.js";
import * as otpService from "./otp.service.js";
import * as tokenService from "./token.service.js";
import { sendOtpEmail } from "./mailer.service.js";

const BCRYPT_COST = 12;

class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export { AuthError };

export async function register({ fullName, email, phone, password }) {
  email = email.trim().toLowerCase();

  if (await userModel.findUserByEmail(email)) {
    throw new AuthError(409, "email_taken", "An account with this email already exists.");
  }
  if (await userModel.findUserByPhone(phone)) {
    throw new AuthError(409, "phone_taken", "An account with this phone number already exists.");
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const user = await userModel.createUser({ fullName, email, phone, passwordHash });

  await issueAndSendOtp(user, otpService.OTP_PURPOSE.EMAIL_VERIFICATION);

  return userModel.toPublicUser(user);
}

export async function verifyEmail({ email, code }) {
  const user = await requireUserByEmail(email);

  const result = await otpService.verifyOtp({
    userId: user.id,
    purpose: otpService.OTP_PURPOSE.EMAIL_VERIFICATION,
    code,
  });

  if (!result.ok) throw otpFailure(result);

  await userModel.markEmailVerified(user.id);
  return userModel.toPublicUser(await userModel.findUserById(user.id));
}

export async function resendOtp({ email, purpose }) {
  const user = await requireUserByEmail(email);

  if (purpose === otpService.OTP_PURPOSE.EMAIL_VERIFICATION && user.email_verified_at) {
    throw new AuthError(400, "already_verified", "This email is already verified.");
  }

  await issueAndSendOtp(user, purpose);
}

/**
 * Step 1 of login: verify the password, then issue (and email) a 2FA OTP.
 * Returns a short-lived pending-2FA token — NOT an access token — that only
 * authorizes calling verifyLoginOtp for this same user.
 */
export async function login({ email, password }, meta) {
  const user = await userModel.findUserByEmail(email.trim().toLowerCase());

  // Generic message on both "no such user" and "wrong password" to avoid
  // revealing which emails are registered.
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new AuthError(401, "invalid_credentials", "Incorrect email or password.");
  }

  if (!user.email_verified_at) {
    throw new AuthError(403, "email_not_verified", "Please verify your email before signing in.");
  }

  if (user.status === "suspended") {
    throw new AuthError(403, "account_suspended", "This account has been suspended.");
  }

  await issueAndSendOtp(user, otpService.OTP_PURPOSE.LOGIN_2FA);

  return { pendingTwoFactorToken: tokenService.signPendingTwoFactorToken(user) };
}

/**
 * Step 2 of login: verify the OTP tied to the pending-2FA token, then issue
 * real access + refresh tokens.
 */
export async function verifyLoginOtp({ pendingTwoFactorToken, code }, meta) {
  let payload;
  try {
    payload = tokenService.verifyPendingTwoFactorToken(pendingTwoFactorToken);
  } catch {
    throw new AuthError(401, "invalid_pending_token", "Your login session expired. Please sign in again.");
  }

  const user = await userModel.findUserById(payload.sub);
  if (!user) throw new AuthError(401, "invalid_pending_token", "Please sign in again.");

  const result = await otpService.verifyOtp({
    userId: user.id,
    purpose: otpService.OTP_PURPOSE.LOGIN_2FA,
    code,
  });

  if (!result.ok) throw otpFailure(result);

  const accessToken = tokenService.signAccessToken(user);
  const refreshToken = await tokenService.issueRefreshToken(user, meta);

  return { accessToken, refreshToken, user: userModel.toPublicUser(user) };
}

export async function refresh(oldToken, meta) {
  const stored = await refreshTokenModel.findActiveRefreshToken(oldToken);
  if (!stored) throw new AuthError(401, "invalid_refresh_token", "Please sign in again.");

  const user = await userModel.findUserById(stored.user_id);
  if (!user) throw new AuthError(401, "invalid_refresh_token", "Please sign in again.");

  const refreshToken = await tokenService.rotateRefreshToken(oldToken, user, meta);
  const accessToken = tokenService.signAccessToken(user);

  return { accessToken, refreshToken };
}

export async function logout(refreshTokenValue) {
  if (refreshTokenValue) await refreshTokenModel.revokeRefreshToken(refreshTokenValue);
}

// --- helpers ---

async function requireUserByEmail(email) {
  const user = await userModel.findUserByEmail(email.trim().toLowerCase());
  if (!user) throw new AuthError(404, "user_not_found", "No account found for this email.");
  return user;
}

async function issueAndSendOtp(user, purpose) {
  const code = await otpService.issueOtp({ userId: user.id, purpose });
  // `code` lives only in this call stack, passed straight to the mailer — it
  // is never logged, stored, or returned to the client from here.
  await sendOtpEmail({
    to: user.email,
    fullName: user.full_name,
    purpose,
    code,
    expiresMinutes: env.otp.expiresMinutes,
  });
}

function otpFailure(result) {
  const messages = {
    no_active_otp: "No active code found. Please request a new one.",
    expired: "This code has expired. Please request a new one.",
    too_many_attempts: "Too many incorrect attempts. Please request a new code.",
    incorrect: "Incorrect code.",
  };
  const err = new AuthError(400, result.reason, messages[result.reason] || "Invalid code.");
  err.attemptsLeft = result.attemptsLeft;
  return err;
}
