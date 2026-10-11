import * as withdrawalModel from "../models/withdrawal.model.js";
import * as userModel from "../models/user.model.js";
import * as kycModel from "../models/kyc.model.js";
import * as otpService from "./otp.service.js";
import { notify } from "./notification.service.js";
import { sendOtpEmail } from "./mailer.service.js";
import {
  signPendingWithdrawalToken,
  verifyPendingWithdrawalToken,
} from "./token.service.js";
import { env } from "../config/env.js";
import { HttpError } from "../utils/errors.js";

/**
 * Step 1: validate the request and the member's standing, then OTP them.
 * Nothing is held or persisted yet — that only happens once the OTP is
 * confirmed (see confirm() below), so an abandoned request leaves no trace
 * and ties up no funds.
 */
const MIN_WITHDRAWAL = 100; // naira — matches the UI's minimum

export async function initiate({ userId, amount }) {
  amount = Math.round(Number(amount) * 100) / 100; // never store sub-kobo fractions
  if (!Number.isFinite(amount) || amount < MIN_WITHDRAWAL) {
    throw new HttpError(422, "invalid_amount", `The minimum withdrawal is ₦${MIN_WITHDRAWAL}.`);
  }

  const user = await userModel.findUserById(userId);

  const kyc = await kycModel.findByUserId(userId);
  if (!kyc || kyc.status !== "approved") {
    throw new HttpError(
      403,
      "kyc_not_approved",
      "You need an approved KYC submission on file before you can withdraw."
    );
  }

  if (amount > Number(user.available_balance)) {
    throw new HttpError(422, "insufficient_balance", "That's more than your available balance.");
  }

  const pendingToken = signPendingWithdrawalToken(user, {
    amount,
    bankName: kyc.bank_name,
    accountNumber: kyc.account_number,
    // Withdrawals only ever go to the member's own KYC-verified account —
    // not an arbitrary third party — so the account name is their own.
    accountName: user.full_name,
  });

  const code = await otpService.issueOtp({ userId, purpose: otpService.OTP_PURPOSE.WITHDRAWAL });
  await sendOtpEmail({
    to: user.email,
    fullName: user.full_name,
    purpose: otpService.OTP_PURPOSE.WITHDRAWAL,
    code,
    expiresMinutes: env.otp.expiresMinutes,
  });

  return {
    pendingToken,
    bankName: kyc.bank_name,
    accountNumber: kyc.account_number,
  };
}

/**
 * Step 2: verify the OTP, then — and only then — hold the funds and create
 * the withdrawal row. The amount/bank details come from the signed pending
 * token (set in step 1), never from this request's body, so there's no
 * window where a client could confirm different numbers than what was
 * actually OTP'd for.
 */
export async function confirm({ pendingToken, code }) {
  let payload;
  try {
    payload = verifyPendingWithdrawalToken(pendingToken);
  } catch {
    throw new HttpError(401, "invalid_pending_token", "This request expired. Please start again.");
  }

  const user = await userModel.findUserById(payload.sub);
  if (!user) throw new HttpError(401, "invalid_pending_token", "Please start again.");

  const result = await otpService.verifyOtp({
    userId: user.id,
    purpose: otpService.OTP_PURPOSE.WITHDRAWAL,
    code,
  });
  if (!result.ok) throw otpFailure(result);

  // Hold + record in one transaction (see createWithHold): no window where
  // funds are held but no withdrawal exists, and the balance check is atomic.
  const withdrawal = await withdrawalModel.createWithHold({
    userId: user.id,
    amount: payload.amount,
    bankName: payload.bankName,
    accountNumber: payload.accountNumber,
    accountName: payload.accountName,
  });
  if (!withdrawal) {
    // Balance moved between initiate and confirm (e.g. another withdrawal
    // beat this one to it) — fail cleanly rather than going negative.
    throw new HttpError(422, "insufficient_balance", "That's more than your available balance.");
  }

  notify
    .withdrawalSubmitted({
      memberName: user.full_name,
      memberEmail: user.email,
      amount: payload.amount,
      bankName: payload.bankName,
      accountNumber: payload.accountNumber,
    })
    .catch((err) => console.error("[withdrawal] admin notification failed:", err.message));

  return withdrawalModel.toPublicWithdrawal(withdrawal);
}

export async function listMine(userId) {
  const rows = await withdrawalModel.listByUser(userId);
  return rows.map(withdrawalModel.toPublicWithdrawal);
}

export async function listForAdmin(status) {
  const rows = await withdrawalModel.listByStatus(status);
  return rows.map(withdrawalModel.toPublicWithdrawal);
}

export async function approve({ withdrawalId, reviewerId }) {
  const withdrawal = await withdrawalModel.findById(withdrawalId);
  if (!withdrawal) throw new HttpError(404, "not_found", "Withdrawal not found.");
  if (withdrawal.status !== "pending") {
    throw new HttpError(409, "invalid_state", "Only pending withdrawals can be approved.");
  }

  if (withdrawal.user_id === reviewerId) {
    throw new HttpError(403, "self_review", "You can't review your own withdrawal.");
  }
  const approved = await withdrawalModel.markApproved({ id: withdrawalId, reviewerId });
  if (!approved) {
    throw new HttpError(409, "invalid_state", "This withdrawal was already actioned.");
  }

  const user = await userModel.findUserById(withdrawal.user_id);
  notify
    .withdrawalApproved(user.email, { fullName: user.full_name, amount: withdrawal.amount })
    .catch((err) => console.error("[withdrawal] member notification failed:", err.message));

  return withdrawalModel.toPublicWithdrawal(await withdrawalModel.findById(withdrawalId));
}

export async function decline({ withdrawalId, reviewerId, reason }) {
  if (!reason) throw new HttpError(422, "reason_required", "A decline reason is required.");

  const withdrawal = await withdrawalModel.findById(withdrawalId);
  if (!withdrawal) throw new HttpError(404, "not_found", "Withdrawal not found.");
  if (withdrawal.status !== "pending") {
    throw new HttpError(409, "invalid_state", "Only pending withdrawals can be declined.");
  }

  // Refund the hold — this is the only point a withdrawal's amount ever
  // moves a second time; approve/process never touch the balance again.
  if (withdrawal.user_id === reviewerId) {
    throw new HttpError(403, "self_review", "You can't review your own withdrawal.");
  }
  // Status change and refund are one atomic, conditional transaction — a
  // double-click can't refund twice.
  const declined = await withdrawalModel.declineAndRefund({ id: withdrawalId, reviewerId, reason });
  if (!declined) {
    throw new HttpError(409, "invalid_state", "This withdrawal was already actioned.");
  }

  const user = await userModel.findUserById(withdrawal.user_id);
  notify
    .withdrawalDeclined(user.email, { fullName: user.full_name, amount: withdrawal.amount, reason })
    .catch((err) => console.error("[withdrawal] member notification failed:", err.message));

  return withdrawalModel.toPublicWithdrawal(await withdrawalModel.findById(withdrawalId));
}

export async function process({ withdrawalId, processorId }) {
  const withdrawal = await withdrawalModel.findById(withdrawalId);
  if (!withdrawal) throw new HttpError(404, "not_found", "Withdrawal not found.");
  if (withdrawal.status !== "approved") {
    throw new HttpError(409, "invalid_state", "Only approved withdrawals can be marked processed.");
  }

  if (withdrawal.user_id === processorId) {
    throw new HttpError(403, "self_review", "You can't process your own withdrawal.");
  }
  const processed = await withdrawalModel.markProcessed({ id: withdrawalId, processorId });
  if (!processed) {
    throw new HttpError(409, "invalid_state", "This withdrawal was already actioned.");
  }

  const user = await userModel.findUserById(withdrawal.user_id);
  notify
    .withdrawalProcessed(user.email, {
      fullName: user.full_name,
      amount: withdrawal.amount,
      bankName: withdrawal.bank_name,
      accountNumber: withdrawal.account_number,
    })
    .catch((err) => console.error("[withdrawal] member notification failed:", err.message));

  return withdrawalModel.toPublicWithdrawal(await withdrawalModel.findById(withdrawalId));
}

function otpFailure(result) {
  const messages = {
    no_active_otp: "No active code found. Please request a new withdrawal.",
    expired: "This code has expired. Please request a new withdrawal.",
    too_many_attempts: "Too many incorrect attempts. Please request a new withdrawal.",
    incorrect: "Incorrect code.",
  };
  const err = new HttpError(400, result.reason, messages[result.reason] || "Invalid code.");
  err.attemptsLeft = result.attemptsLeft;
  return err;
}
