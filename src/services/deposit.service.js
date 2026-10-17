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

  let authorizationUrl;
  try {
    ({ authorizationUrl } = await paystack.initializeTransaction({
      email: user.email,
      amountNaira: amount,
      reference,
    }));
  } catch (err) {
    // Checkout never started, so nothing can be paid against this reference.
    // Close the row instead of leaving a permanent 'initialized' orphan.
    console.error(`[deposit] Paystack initialize failed ref=${reference}:`, err.message);
    await depositModel.markFailed({
      reference,
      reason: "Could not start the payment. Please try again.",
      paystackRefId: null,
    });
    throw new HttpError(502, "payment_provider_unavailable", "We couldn't start the payment. Please try again.");
  }

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

  return verifyReference(reference);
}

/**
 * The verification itself, with no caller identity attached. Used by the
 * member's callback page, the Paystack webhook, and the reconciliation
 * sweep — all of them funnel into the same atomic claim, so a payment can be
 * reported by all three at once and is still credited exactly once.
 */
export async function verifyReference(reference) {
  const deposit = await depositModel.findByReference(reference);
  if (!deposit) throw new HttpError(404, "not_found", "Deposit not found.");

  // Cheap short-circuit for the common repeat call. NOT the safety mechanism —
  // two simultaneous calls both get past this; the atomic claim below is what
  // actually prevents a double credit.
  if (deposit.status !== "initialized") {
    return depositModel.toPublicDeposit(deposit);
  }

  let result;
  try {
    result = await paystack.verifyTransaction(reference);
  } catch (err) {
    // Provider unreachable: nothing was changed, the deposit stays
    // 'initialized' and can simply be verified again (or picked up by the
    // webhook / reconciliation sweep).
    console.error(`[deposit] Paystack verify failed ref=${reference}:`, err.message);
    throw new HttpError(502, "payment_provider_unavailable", "We couldn't reach the payment provider. Please try again shortly.");
  }

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

    let credited;
    try {
      credited = await depositModel.creditVerifiedDeposit({ reference, paystackRefId: result.paystackId });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        // The same Paystack transaction is already attached to another
        // deposit. Never credit it twice.
        console.error(
          `[deposit] DUPLICATE PAYSTACK TRANSACTION ref=${reference} paystack id ${result.paystackId} — NOT credited, reconcile manually`
        );
        await depositModel.markFailed({
          reference,
          reason: "This payment was already used for another deposit, so it was not credited. Please contact the cooperative office.",
          paystackRefId: null,
        });
        return depositModel.toPublicDeposit(await depositModel.findByReference(reference));
      }
      throw err;
    }
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

/**
 * Sweep for deposits that are still 'initialized' after the member should
 * have come back (closed the tab, lost connection, callback page failed).
 * Re-verifies each with Paystack. Safe to run repeatedly and concurrently with
 * member callbacks and webhooks.
 */
export async function reconcileStale({ olderThanMinutes = 5, limit = 50 } = {}) {
  const stale = await depositModel.listStaleInitialized({ olderThanMinutes, limit });
  const summary = { checked: stale.length, credited: 0, failed: 0, stillPending: 0, errors: 0 };

  for (const deposit of stale) {
    try {
      const result = await verifyReference(deposit.reference);
      if (result.status === "pending_confirmation") summary.credited += 1;
      else if (result.status === "failed") summary.failed += 1;
      else summary.stillPending += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(`[deposit] reconcile failed ref=${deposit.reference}:`, err.message);
    }
  }
  return summary;
}
