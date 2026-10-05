import * as authService from "../services/auth.service.js";
import * as userModel from "../models/user.model.js";
import { env } from "../config/env.js";
import {
  setAccessCookie,
  setRefreshCookie,
  setPending2faCookie,
  clearPending2faCookie,
  clearAuthCookies,
} from "../utils/cookies.js";

function requestMeta(req) {
  return { userAgent: req.headers["user-agent"], ip: req.ip };
}

function sendAuthError(res, err) {
  if (err instanceof authService.AuthError) {
    const body = { error: err.message, code: err.code };
    if (err.attemptsLeft !== undefined) body.attemptsLeft = err.attemptsLeft;
    return res.status(err.status).json(body);
  }
  throw err; // handled by the global error handler
}

export async function register(req, res) {
  try {
    const user = await authService.register(req.body);
    res.status(201).json({
      message: "Account created. Check your email for a verification code.",
      user,
    });
  } catch (err) {
    sendAuthError(res, err);
  }
}

export async function verifyEmail(req, res) {
  try {
    const user = await authService.verifyEmail(req.body);
    res.json({ message: "Email verified.", user });
  } catch (err) {
    sendAuthError(res, err);
  }
}

export async function resendOtp(req, res) {
  try {
    await authService.resendOtp(req.body);
    res.json({ message: "A new code has been sent if the account exists." });
  } catch (err) {
    sendAuthError(res, err);
  }
}

export async function login(req, res) {
  try {
    const { pendingTwoFactorToken } = await authService.login(req.body, requestMeta(req));
    // The pending-2FA token never reaches the response body or frontend JS —
    // it lives only in a short-lived httpOnly cookie, scoped to /api/auth.
    setPending2faCookie(res, pendingTwoFactorToken);
    res.json({
      message: "Password verified. Enter the code sent to your email to finish signing in.",
    });
  } catch (err) {
    sendAuthError(res, err);
  }
}

export async function verifyLoginOtp(req, res) {
  try {
    const pendingTwoFactorToken = req.cookies?.[env.cookies.pending2faName];
    if (!pendingTwoFactorToken) {
      return res.status(401).json({
        error: "Your login session expired. Please sign in again.",
        code: "invalid_pending_token",
      });
    }

    const { accessToken, refreshToken, user } = await authService.verifyLoginOtp(
      { pendingTwoFactorToken, code: req.body.code },
      requestMeta(req)
    );

    clearPending2faCookie(res);
    setAccessCookie(res, accessToken);
    setRefreshCookie(res, refreshToken);
    res.json({ message: "Signed in.", user });
  } catch (err) {
    sendAuthError(res, err);
  }
}

export async function refresh(req, res) {
  try {
    const oldToken = req.cookies?.[env.cookies.refreshName];
    if (!oldToken) {
      return res.status(401).json({ error: "Please sign in again.", code: "invalid_refresh_token" });
    }

    const { accessToken, refreshToken } = await authService.refresh(oldToken, requestMeta(req));
    setAccessCookie(res, accessToken);
    setRefreshCookie(res, refreshToken);
    res.json({ message: "Session refreshed." });
  } catch (err) {
    sendAuthError(res, err);
  }
}

export async function logout(req, res) {
  try {
    const refreshToken = req.cookies?.[env.cookies.refreshName];
    await authService.logout(refreshToken);
    clearAuthCookies(res);
    res.json({ message: "Logged out." });
  } catch (err) {
    sendAuthError(res, err);
  }
}

export async function me(req, res) {
  // Deliberately a fresh DB read, not just echoing the JWT's claims — those
  // are only as current as the last login/refresh (up to 15 min stale), so
  // status/role/balance changes (KYC approval, deposit confirmation, an
  // admin promotion) wouldn't show up here until the token happened to
  // rotate. This is the one call the frontend uses to paint the dashboard,
  // so it needs to be right now, not eventually.
  const user = await userModel.findUserById(req.user.id);
  if (!user) return res.status(401).json({ error: "Account no longer exists." });
  res.json({ user: userModel.toPublicUser(user) });
}
