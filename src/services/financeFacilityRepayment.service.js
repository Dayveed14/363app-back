import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import * as repaymentModel from "../models/financeFacilityRepayment.model.js";

const PAYSTACK_BASE_URL = "https://api.paystack.co";
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

export class FinanceFacilityRepaymentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "FinanceFacilityRepaymentError";
    this.statusCode = statusCode;
  }
}

function assertPaystackConfigured() {
  if (!PAYSTACK_SECRET_KEY) {
    throw new FinanceFacilityRepaymentError(
      "Paystack is not configured on the server.",
      500
    );
  }
}

/**
 * Convert a monetary amount in naira to integer kobo.
 * Zero is allowed for balance and allocation calculations.
 */
function toKobo(value, { allowZero = false } = {}) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount < 0) {
    throw new FinanceFacilityRepaymentError(
      "Invalid monetary amount."
    );
  }

  if (!allowZero && amount === 0) {
    throw new FinanceFacilityRepaymentError(
      "Payment amount must be greater than zero."
    );
  }

  const kobo = Math.round(amount * 100);

  if (Math.abs(amount * 100 - kobo) > 0.000001) {
    throw new FinanceFacilityRepaymentError(
      "Payment amount cannot contain fractions of a kobo."
    );
  }

  return kobo;
}

function fromKobo(kobo) {
  return (Number(kobo) / 100).toFixed(2);
}

function moneyNumber(value) {
  return Number(Number(value ?? 0).toFixed(2));
}

async function paystackRequest(path, options = {}) {
  assertPaystackConfigured();

  let response;

  try {
    response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } catch {
    throw new FinanceFacilityRepaymentError(
      "Unable to connect to Paystack. Please try again.",
      502
    );
  }

  let result;

  try {
    result = await response.json();
  } catch {
    throw new FinanceFacilityRepaymentError(
      "Unable to read the Paystack response.",
      502
    );
  }

  if (!response.ok || !result.status) {
    throw new FinanceFacilityRepaymentError(
      result.message || "Paystack request failed.",
      502
    );
  }

  return result.data;
}

function addMonths(date, months) {
  const result = new Date(date);
  const originalDay = result.getDate();

  result.setDate(1);
  result.setMonth(result.getMonth() + months);

  const lastDay = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0
  ).getDate();

  result.setDate(Math.min(originalDay, lastDay));

  return result;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getMonthlyDueDate(disbursedAt, installmentNumber) {
  const start = new Date(disbursedAt);

  if (Number.isNaN(start.getTime())) {
    throw new FinanceFacilityRepaymentError(
      "The facility has an invalid disbursement date."
    );
  }

  return formatDate(addMonths(start, installmentNumber));
}

/**
 * Generate exactly term_months monthly installments.
 *
 * Total payable = installment_amount * term_months.
 *
 * Generation is idempotent. Existing schedules are returned unchanged.
 */
export async function generateRepaymentSchedule(facilityId) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(
      `SELECT *
       FROM finance_facility_applications
       WHERE id = :facilityId
       FOR UPDATE`,
      { facilityId }
    );

    const facility = rows[0];

    if (!facility) {
      throw new FinanceFacilityRepaymentError(
        "Finance facility not found.",
        404
      );
    }

    if (facility.status !== "disbursed") {
      throw new FinanceFacilityRepaymentError(
        "Repayment schedules can only be generated after disbursement."
      );
    }

    if (
      !facility.disbursed_at ||
      !facility.approved_amount ||
      !facility.installment_amount ||
      !facility.term_months ||
      facility.repayment_frequency !== "monthly"
    ) {
      throw new FinanceFacilityRepaymentError(
        "The disbursed facility is missing valid monthly repayment information."
      );
    }

    const termMonths = Number(facility.term_months);
    const installmentKobo = toKobo(facility.installment_amount);

    if (!Number.isInteger(termMonths) || termMonths < 1) {
      throw new FinanceFacilityRepaymentError(
        "The approved repayment term is invalid."
      );
    }

    if (installmentKobo <= 0) {
      throw new FinanceFacilityRepaymentError(
        "The monthly repayment amount must be greater than zero."
      );
    }

    const existing = await repaymentModel.listScheduleByFacility(
      facilityId,
      null,
      connection
    );

    if (existing.length > 0) {
      if (existing.length !== termMonths) {
        throw new FinanceFacilityRepaymentError(
          "An incomplete repayment schedule already exists. It requires administrative reconciliation.",
          409
        );
      }

      await connection.commit();
      return existing;
    }

    for (let installmentNumber = 1;
      installmentNumber <= termMonths;
      installmentNumber += 1) {
      await repaymentModel.createScheduleInstallment(
        {
          facilityId: Number(facility.id),
          userId: Number(facility.user_id),
          installmentNumber,
          dueDate: getMonthlyDueDate(
            facility.disbursed_at,
            installmentNumber
          ),
          amountDue: fromKobo(installmentKobo),
        },
        connection
      );
    }

    await connection.commit();

    return repaymentModel.listScheduleByFacility(facilityId);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getOutstandingBalance(facilityId, userId = null) {
  const facility = await repaymentModel.findFacilityById(
    facilityId,
    userId
  );

  if (!facility) {
    throw new FinanceFacilityRepaymentError(
      "Disbursed finance facility not found.",
      404
    );
  }

  const totals = await repaymentModel.getFacilityRepaymentTotals(
    facilityId,
    userId
  );

  const outstandingKobo = toKobo(
    totals.outstandingBalance,
    { allowZero: true }
  );

  return {
    facilityId: Number(facility.id),
    approvedAmount: moneyNumber(facility.approved_amount),
    totalRepayable: moneyNumber(totals.totalDue),
    totalPaid: moneyNumber(totals.totalPaid),
    outstandingBalance: moneyNumber(totals.outstandingBalance),
    installmentCount: totals.installmentCount,
    paidInstallmentCount: totals.paidInstallmentCount,
    completed:
      totals.installmentCount > 0 && outstandingKobo === 0,
  };
}

export async function getNextRepaymentDue(facilityId, userId) {
  const facility = await repaymentModel.findFacilityById(
    facilityId,
    userId
  );

  if (!facility) {
    throw new FinanceFacilityRepaymentError(
      "Disbursed finance facility not found.",
      404
    );
  }

  const installment = await repaymentModel.findNextRepaymentDue(
    facilityId,
    userId
  );

  if (!installment) {
    return null;
  }

  const amountDueKobo = toKobo(installment.amount_due);
  const amountPaidKobo = toKobo(
    installment.amount_paid,
    { allowZero: true }
  );

  const dueDate = new Date(
    `${String(installment.due_date).slice(0, 10)}T00:00:00`
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return {
    installmentId: Number(installment.id),
    facilityId: Number(facilityId),
    installmentNumber: Number(installment.installment_number),
    dueDate: installment.due_date,
    amountDue: moneyNumber(installment.amount_due),
    amountPaid: moneyNumber(installment.amount_paid),
    remainingAmount: moneyNumber(
      fromKobo(amountDueKobo - amountPaidKobo)
    ),
    overdue: dueDate < today,
    status: installment.status,
  };
}

export async function getMemberRepaymentHistory(userId) {
  return repaymentModel.listSuccessfulRepaymentsByUser(userId);
}

export async function getRepaymentSchedule(facilityId, userId = null) {
  const facility = await repaymentModel.findFacilityById(
    facilityId,
    userId
  );

  if (!facility) {
    throw new FinanceFacilityRepaymentError(
      "Disbursed finance facility not found.",
      404
    );
  }

  return repaymentModel.listScheduleByFacility(facilityId, userId);
}

/**
 * Initialize a Paystack transaction.
 *
 * A server-configured callback URL is preferred over accepting arbitrary
 * URLs from the browser. Configure FRONTEND_URL in the server environment.
 */
export async function initializeRepayment({
  facilityId,
  userId,
  email,
  amount,
  callbackUrl,
}) {
  assertPaystackConfigured();

  if (!email || typeof email !== "string") {
    throw new FinanceFacilityRepaymentError(
      "A valid member email is required."
    );
  }

  const configuredFrontendUrl = process.env.CLIENT_ORIGIN;

  if (!configuredFrontendUrl) {
    throw new FinanceFacilityRepaymentError(
      "The payment frontend URL is not configured on the server.",
      500
    );
  }

  let trustedCallbackUrl;

  try {
    const frontend = new URL(configuredFrontendUrl);
    trustedCallbackUrl = new URL("/repayment/callback", frontend.origin);

    if (
      frontend.protocol !== "https:" &&
      frontend.hostname !== "localhost"
    ) {
      throw new Error("HTTPS required");
    }
  } catch {
    throw new FinanceFacilityRepaymentError(
      "The configured payment frontend URL is invalid.",
      500
    );
  }

  // The browser callback parameter is intentionally not trusted.
  void callbackUrl;

  const facility = await repaymentModel.findFacilityById(
    facilityId,
    userId
  );

  if (!facility) {
    throw new FinanceFacilityRepaymentError(
      "Disbursed finance facility not found.",
      404
    );
  }

  const amountKobo = toKobo(amount);

  const totals = await repaymentModel.getFacilityRepaymentTotals(
    facilityId,
    userId
  );

  if (totals.installmentCount === 0) {
    throw new FinanceFacilityRepaymentError(
      "The repayment schedule has not been generated."
    );
  }

  const outstandingKobo = toKobo(
    totals.outstandingBalance,
    { allowZero: true }
  );

  if (outstandingKobo === 0) {
    throw new FinanceFacilityRepaymentError(
      "This facility has already been fully repaid."
    );
  }

  if (amountKobo > outstandingKobo) {
    throw new FinanceFacilityRepaymentError(
      "Payment amount exceeds the outstanding balance."
    );
  }

  const initialization = await paystackRequest(
    "/transaction/initialize",
    {
      method: "POST",
      body: JSON.stringify({
        email,
        amount: amountKobo,
        currency: "NGN",
        callback_url: trustedCallbackUrl.toString(),
        metadata: {
          payment_type: "finance_facility_repayment",
          facility_id: String(facilityId),
          user_id: String(userId),
        },
      }),
    }
  );

  if (
    !initialization.reference ||
    !initialization.authorization_url
  ) {
    throw new FinanceFacilityRepaymentError(
      "Paystack did not return the required payment details.",
      502
    );
  }

  try {
    await repaymentModel.createRepayment({
      facilityId,
      userId,
      paystackReference: initialization.reference,
      amount: fromKobo(amountKobo),
      currency: "NGN",
      status: "pending",
    });
  } catch (error) {
    const existing =
      await repaymentModel.findRepaymentByPaystackReference(
        initialization.reference
      ).catch(() => null);

    if (
      !existing ||
      String(existing.facility_id) !== String(facilityId) ||
      String(existing.user_id) !== String(userId) ||
      toKobo(existing.amount) !== amountKobo
    ) {
      throw error;
    }
  }

  return {
    reference: initialization.reference,
    authorizationUrl: initialization.authorization_url,
    accessCode: initialization.access_code,
  };
}

/**
 * Verify and apply a Paystack payment.
 *
 * Paystack verification occurs before the database transaction.
 * The database then locks the repayment record, facility, and outstanding
 * installments before applying any balance changes.
 */
export async function verifyAndProcessRepayment({
  paystackReference,
  userId = null,
}) {
  assertPaystackConfigured();

  if (
    typeof paystackReference !== "string" ||
    !paystackReference.trim()
  ) {
    throw new FinanceFacilityRepaymentError(
      "Paystack transaction reference is required."
    );
  }

  const reference = paystackReference.trim();

  const payment = await paystackRequest(
    `/transaction/verify/${encodeURIComponent(reference)}`
  );

  if (payment.reference !== reference) {
    throw new FinanceFacilityRepaymentError(
      "The verified Paystack reference does not match the requested reference.",
      409
    );
  }

  if (payment.status !== "success") {
    throw new FinanceFacilityRepaymentError(
      "Paystack has not confirmed a successful payment."
    );
  }

  if (payment.currency !== "NGN") {
    throw new FinanceFacilityRepaymentError(
      "The payment currency does not match NGN."
    );
  }

  if (
    payment.metadata?.payment_type !== "finance_facility_repayment"
  ) {
    throw new FinanceFacilityRepaymentError(
      "This Paystack transaction is not a finance facility repayment.",
      409
    );
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const repayment =
      await repaymentModel.findRepaymentByPaystackReference(
        reference,
        connection
      );

    if (!repayment) {
      throw new FinanceFacilityRepaymentError(
        "Repayment transaction not found.",
        404
      );
    }

    // Lock the transaction record to serialize concurrent verification.
    const lockedRepayment =
      await repaymentModel.findRepaymentByIdForUpdate(
        repayment.id,
        connection
      );

    if (!lockedRepayment) {
      throw new FinanceFacilityRepaymentError(
        "Repayment transaction not found.",
        404
      );
    }

    if (
      userId !== null &&
      String(lockedRepayment.user_id) !== String(userId)
    ) {
      throw new FinanceFacilityRepaymentError(
        "You are not authorized to verify this repayment.",
        403
      );
    }

    if (
      String(payment.metadata?.facility_id) !==
        String(lockedRepayment.facility_id) ||
      String(payment.metadata?.user_id) !==
        String(lockedRepayment.user_id)
    ) {
      throw new FinanceFacilityRepaymentError(
        "The Paystack transaction metadata does not match the repayment record.",
        409
      );
    }

    if (lockedRepayment.status === "success") {
      await connection.commit();

      return {
        success: true,
        alreadyProcessed: true,
        repaymentId: Number(lockedRepayment.id),
        facilityId: Number(lockedRepayment.facility_id),
        amount: moneyNumber(lockedRepayment.amount),
        reference: lockedRepayment.paystack_reference,
      };
    }

    if (lockedRepayment.status !== "pending") {
      throw new FinanceFacilityRepaymentError(
        "This repayment transaction cannot be processed."
      );
    }

    const paymentKobo = toKobo(payment.amount / 100);
    const recordedKobo = toKobo(lockedRepayment.amount);

    if (paymentKobo !== recordedKobo) {
      throw new FinanceFacilityRepaymentError(
        "The verified Paystack amount does not match the repayment record.",
        409
      );
    }

    const [facilities] = await connection.query(
      `SELECT *
       FROM finance_facility_applications
       WHERE id = :facilityId
       FOR UPDATE`,
      { facilityId: lockedRepayment.facility_id }
    );

    const facility = facilities[0];

    if (!facility || facility.status !== "disbursed") {
      throw new FinanceFacilityRepaymentError(
        "The facility is not eligible for repayment processing."
      );
    }

    const [schedules] = await connection.query(
      `SELECT *
       FROM finance_facility_repayment_schedules
       WHERE facility_id = :facilityId
         AND amount_paid < amount_due
       ORDER BY installment_number ASC
       FOR UPDATE`,
      { facilityId: lockedRepayment.facility_id }
    );

    const [totalsRows] = await connection.query(
      `SELECT
         COALESCE(SUM(amount_due - amount_paid), 0.00) AS outstanding
       FROM finance_facility_repayment_schedules
       WHERE facility_id = :facilityId`,
      { facilityId: lockedRepayment.facility_id }
    );

    const outstandingKobo = toKobo(
      totalsRows[0]?.outstanding ?? 0,
      { allowZero: true }
    );

    if (paymentKobo > outstandingKobo) {
      throw new FinanceFacilityRepaymentError(
        "The verified payment exceeds the outstanding facility balance.",
        409
      );
    }

    if (paymentKobo > 0 && schedules.length === 0) {
      throw new FinanceFacilityRepaymentError(
        "No outstanding installments were found.",
        409
      );
    }

    let remainingKobo = paymentKobo;

    for (const schedule of schedules) {
      if (remainingKobo === 0) break;

      const dueKobo = toKobo(schedule.amount_due);
      const paidKobo = toKobo(
        schedule.amount_paid,
        { allowZero: true }
      );

      const installmentOutstandingKobo = dueKobo - paidKobo;

      if (installmentOutstandingKobo <= 0) continue;

      const allocationKobo = Math.min(
        remainingKobo,
        installmentOutstandingKobo
      );

      const updatedPaidKobo = paidKobo + allocationKobo;

      const status =
        updatedPaidKobo === dueKobo ? "paid" : "partial";

      await repaymentModel.updateScheduleInstallmentPayment(
        {
          id: schedule.id,
          amountPaid: fromKobo(updatedPaidKobo),
          status,
        },
        connection
      );

      remainingKobo -= allocationKobo;
    }

    if (remainingKobo !== 0) {
      throw new FinanceFacilityRepaymentError(
        "Unable to allocate the full repayment amount.",
        409
      );
    }

    await repaymentModel.markRepaymentSuccessful(
      {
        id: lockedRepayment.id,
        paidAt: new Date(),
      },
      connection
    );

    await connection.commit();

    return {
      success: true,
      alreadyProcessed: false,
      repaymentId: Number(lockedRepayment.id),
      facilityId: Number(lockedRepayment.facility_id),
      amount: moneyNumber(lockedRepayment.amount),
      reference: lockedRepayment.paystack_reference,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getAdminRepaymentHistory({ status = null } = {}) {
  return repaymentModel.listRepaymentsForAdmin({ status });
}