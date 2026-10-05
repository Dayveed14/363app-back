import crypto from "node:crypto";
import * as depositModel from "../models/deposit.model.js";
import * as userModel from "../models/user.model.js";
import * as paystack from "./paystack.service.js";
import { notify } from "./notification.service.js";
import { HttpError } from "../utils/errors.js";

export async function initialize({ userId, amount }) {
  if (!amount || amount <= 0) {
    throw new HttpError(422, "invalid_amount", "Enter a valid deposit amount.");
  }

  const user = await userModel.findUserById(userId);
  const reference = `363-DEP-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  await depositModel.createInitialized({ userId, reference, amount });

  const { authorizationUrl } = await paystack.initializeTransaction({
    email: user.email,
    amountNaira: amount,
    reference,
  });

  return { reference, authorizationUrl };
}

/**
 * Called after Paystack redirects the member back. Verifies directly with
 * Paystack (never trusts the client) and applies exactly one of three
 * outcomes:
 *   - Paystack says failed  -> deposit marked 'failed', member notified in-app.
 *   - Paystack says success -> book_balance credited immediately, deposit
 *     moves to 'pending_confirmation', and an admin is emailed. This is the
 *     "book balance now, available balance after confirmation" split —
 *     the money is confirmed paid, but not yet reconciled by the cooperative.
 */
export async function verify(reference) {
  const deposit = await depositModel.findByReference(reference);
  if (!deposit) throw new HttpError(404, "not_found", "Deposit not found.");

  // Idempotent — Paystack's redirect and a page refresh can both call this.
  if (deposit.status !== "initialized") {
    return depositModel.toPublicDeposit(deposit);
  }

  const result = await paystack.verifyTransaction(reference);

  if (!result.success) {
    await depositModel.markFailed({
      reference,
      reason: result.gatewayResponse || "Payment was not successful.",
      paystackRefId: result.paystackId,
    });
    return depositModel.toPublicDeposit(await depositModel.findByReference(reference));
  }

  await depositModel.markPendingConfirmation({ reference, paystackRefId: result.paystackId });
  await userModel.creditBookBalance(deposit.user_id, deposit.amount);

  const user = await userModel.findUserById(deposit.user_id);
  notify
    .depositPendingConfirmation({
      memberName: user.full_name,
      memberEmail: user.email,
      amount: deposit.amount,
      reference,
    })
    .catch((err) => console.error("[deposit] admin notification failed:", err.message));

  return depositModel.toPublicDeposit(await depositModel.findByReference(reference));
}

export async function listMine(userId) {
  const rows = await depositModel.listByUser(userId);
  return rows.map(depositModel.toPublicDeposit);
}

export async function listForAdmin(status) {
  const rows = await depositModel.listByStatus(status);
  return rows.map(depositModel.toPublicDeposit);
}

export async function confirm({ depositId, reviewerId }) {
  const deposit = await depositModel.findById(depositId);
  if (!deposit) throw new HttpError(404, "not_found", "Deposit not found.");
  if (deposit.status !== "pending_confirmation") {
    throw new HttpError(409, "invalid_state", "Only deposits awaiting confirmation can be confirmed.");
  }

  await userModel.moveBookToAvailable(deposit.user_id, deposit.amount);
  await depositModel.markConfirmed({ id: depositId, reviewerId });

  const user = await userModel.findUserById(deposit.user_id);
  notify
    .depositConfirmed(user.email, { fullName: user.full_name, amount: deposit.amount })
    .catch((err) => console.error("[deposit] member notification failed:", err.message));

  return depositModel.toPublicDeposit(await depositModel.findById(depositId));
}

export async function decline({ depositId, reviewerId, reason }) {
  if (!reason) throw new HttpError(422, "reason_required", "A decline reason is required.");

  const deposit = await depositModel.findById(depositId);
  if (!deposit) throw new HttpError(404, "not_found", "Deposit not found.");
  if (deposit.status !== "pending_confirmation") {
    throw new HttpError(409, "invalid_state", "Only deposits awaiting confirmation can be declined.");
  }

  // Reverses the book_balance credit — it never reaches available_balance.
  await userModel.reverseBookBalance(deposit.user_id, deposit.amount);
  await depositModel.markDeclined({ id: depositId, reviewerId, reason });

  const user = await userModel.findUserById(deposit.user_id);
  notify
    .depositDeclined(user.email, { fullName: user.full_name, amount: deposit.amount, reason })
    .catch((err) => console.error("[deposit] member notification failed:", err.message));

  return depositModel.toPublicDeposit(await depositModel.findById(depositId));
}
