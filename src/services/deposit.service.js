import crypto from "node:crypto";
import * as depositModel from "../models/deposit.model.js";
import * as userModel from "../models/user.model.js";
import * as paystack from "./paystack.service.js";
import { notify } from "./notification.service.js";
import { HttpError } from "../utils/errors.js";

const MIN_DEPOSIT = 100; // naira — matches the UI's minimum and Paystack's practical floor
const CURRENCY = "NGN";

export async function initialize({ userId, amount }) {
  amount = Math.round(Number(amount) * 100) / 100; // never store sub-kobo fractions
  if (!Number.isFinite(amount) || amount < MIN_DEPOSIT) {
    throw new HttpError(422, "invalid_amount", `The minimum deposit is ₦${MIN_DEPOSIT}.`);
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
 * Called after Paystack redirects the member back. Never trusts the client:
 * asks Paystack directly, then checks what Paystack says was ACTUALLY paid
 * against OUR record of what this deposit was for.
 *
 *   success + amount/currency match -> credited ONCE (atomic claim, see
 *       creditVerifiedDeposit): book_balance up, status pending_confirmation,
 *       admins emailed.
 *   success + mismatch              -> NOT credited; marked failed with a loud
 *       server log so someone can reconcile it by hand.
 *   failed / reversed               -> final: marked failed.
 *   abandoned / pending / ongoing   -> NOT final. The payment may still
 *       complete, so the deposit stays 'initialized' and can be re-checked.
 *       (Marking it failed here would make a late-settling payment
 *       impossible to credit.)
 */
export async function verify({ reference, requester }) {
  const deposit = await depositModel.findByReference(reference);
  if (!deposit) throw new HttpError(404, "not_found", "Deposit not found.");

  if (deposit.user_id !== requester.id && requester.role !== "admin") {
    throw new HttpError(403, "forbidden", "This isn't your deposit.");
  }

  // Cheap short-circuit for the common repeat call. NOT the safety mechanism —
  // two simultaneous calls both get past this; the atomic claim below is what
  // actually prevents a double credit.
  if (deposit.status !== "initialized") {
    return depositModel.toPublicDeposit(deposit);
  }

  const result = await paystack.verifyTransaction(reference);

  if (result.status === "success") {
    const expectedKobo = Math.round(Number(deposit.amount) * 100);
    if (result.currency !== CURRENCY || result.amountKobo !== expectedKobo) {
      console.error(
        `[deposit] AMOUNT/CURRENCY MISMATCH ref=${reference} expected=${expectedKobo} kobo ${CURRENCY}, ` +
          `Paystack reports ${result.amountKobo} kobo ${result.currency} (paystack id ${result.paystackId}) — NOT credited, reconcile manually`
      );
      await depositModel.markFailed({
        reference,
        reason: "The amount received did not match this deposit, so it was not credited. Please contact the cooperative office.",
        paystackRefId: result.paystackId,
      });
      return depositModel.toPublicDeposit(await depositModel.findByReference(reference));
    }

    const credited = await depositModel.creditVerifiedDeposit({ reference, paystackRefId: result.paystackId });
    if (credited) {
      const user = await userModel.findUserById(credited.userId);
      notify
        .depositPendingConfirmation({
          memberName: user.full_name,
          memberEmail: user.email,
          amount: credited.amount,
          reference,
        })
        .catch((err) => console.error("[deposit] admin notification failed:", err.message));
    }
    // credited === null means a concurrent request already handled it — fine.
    return depositModel.toPublicDeposit(await depositModel.findByReference(reference));
  }

  if (result.status === "failed" || result.status === "reversed") {
    await depositModel.markFailed({
      reference,
      reason: result.gatewayResponse || "Payment was not successful.",
      paystackRefId: result.paystackId,
    });
  }
  // anything else: not finished (yet) — leave it 'initialized'.
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
  if (deposit.user_id === reviewerId) {
    throw new HttpError(403, "self_review", "You can't confirm your own deposit.");
  }

  // The status + balance change happen in one atomic, conditional transaction
  // (see depositModel.confirmDeposit) — a double-click can't credit twice.
  const done = await depositModel.confirmDeposit({ id: depositId, reviewerId });
  if (!done) {
    throw new HttpError(409, "invalid_state", "This deposit isn't awaiting confirmation (it may already have been handled).");
  }

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
  if (deposit.user_id === reviewerId) {
    throw new HttpError(403, "self_review", "You can't decline your own deposit.");
  }

  const done = await depositModel.declineDeposit({ id: depositId, reviewerId, reason });
  if (!done) {
    throw new HttpError(409, "invalid_state", "This deposit isn't awaiting confirmation (it may already have been handled).");
  }

  const user = await userModel.findUserById(deposit.user_id);
  notify
    .depositDeclined(user.email, { fullName: user.full_name, amount: deposit.amount, reason })
    .catch((err) => console.error("[deposit] member notification failed:", err.message));

  return depositModel.toPublicDeposit(await depositModel.findById(depositId));
}
