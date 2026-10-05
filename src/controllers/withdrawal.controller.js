import * as withdrawalService from "../services/withdrawal.service.js";
import { env } from "../config/env.js";
import { setPendingWithdrawalCookie, clearPendingWithdrawalCookie } from "../utils/cookies.js";
import { HttpError } from "../utils/errors.js";

function sendError(res, err) {
  if (err instanceof HttpError) {
    const body = { error: err.message, code: err.code };
    if (err.attemptsLeft !== undefined) body.attemptsLeft = err.attemptsLeft;
    return res.status(err.status).json(body);
  }
  throw err;
}

// --- Member ---

export async function initiate(req, res) {
  try {
    const { pendingToken, bankName, accountNumber } = await withdrawalService.initiate({
      userId: req.user.id,
      amount: Number(req.body.amount),
    });
    // Same pattern as login's 2FA step — the pending token lives only in a
    // short-lived httpOnly cookie, never in the response body.
    setPendingWithdrawalCookie(res, pendingToken);
    res.status(201).json({
      message: "Enter the code sent to your email to confirm this withdrawal.",
      bankName,
      accountNumber,
    });
  } catch (err) {
    sendError(res, err);
  }
}

export async function confirm(req, res) {
  try {
    const pendingToken = req.cookies?.[env.cookies.pendingWithdrawalName];
    if (!pendingToken) {
      return res
        .status(401)
        .json({ error: "This request expired. Please start again.", code: "invalid_pending_token" });
    }

    const withdrawal = await withdrawalService.confirm({ pendingToken, code: req.body.code });
    clearPendingWithdrawalCookie(res);
    res.status(201).json({ message: "Withdrawal submitted for review.", withdrawal });
  } catch (err) {
    sendError(res, err);
  }
}

export async function listMine(req, res) {
  try {
    const withdrawals = await withdrawalService.listMine(req.user.id);
    res.json({ withdrawals });
  } catch (err) {
    sendError(res, err);
  }
}

// --- Admin ---

export async function list(req, res) {
  try {
    const withdrawals = await withdrawalService.listForAdmin(req.query.status);
    res.json({ withdrawals });
  } catch (err) {
    sendError(res, err);
  }
}

export async function approve(req, res) {
  try {
    const withdrawal = await withdrawalService.approve({
      withdrawalId: Number(req.params.id),
      reviewerId: req.user.id,
    });
    res.json({ message: "Withdrawal approved.", withdrawal });
  } catch (err) {
    sendError(res, err);
  }
}

export async function decline(req, res) {
  try {
    const withdrawal = await withdrawalService.decline({
      withdrawalId: Number(req.params.id),
      reviewerId: req.user.id,
      reason: req.body.reason,
    });
    res.json({ message: "Withdrawal declined.", withdrawal });
  } catch (err) {
    sendError(res, err);
  }
}

export async function process(req, res) {
  try {
    const withdrawal = await withdrawalService.process({
      withdrawalId: Number(req.params.id),
      processorId: req.user.id,
    });
    res.json({ message: "Withdrawal marked as processed.", withdrawal });
  } catch (err) {
    sendError(res, err);
  }
}
