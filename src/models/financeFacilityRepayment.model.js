import { pool } from "../config/db.js";

/**
 * Finance facility repayment model.
 *
 * Responsibilities:
 * - Retrieve disbursed finance facilities.
 * - Manage repayment schedules.
 * - Manage Paystack repayment records.
 * - Retrieve outstanding balances and repayment history.
 *
 * Transaction-sensitive operations accept an optional database connection.
 * Pass the same connection to every query in a financial transaction.
 */

const getExecutor = (connection) => connection || pool;

/**
 * Retrieve a disbursed finance facility.
 *
 * When userId is supplied, the facility must belong to that member.
 */
export async function findFacilityById(id, userId = null, connection = null) {
  const executor = getExecutor(connection);

  const [rows] = await executor.query(
    `SELECT
       a.*,
       u.full_name,
       u.email,
       u.member_id
     FROM finance_facility_applications a
     JOIN users u ON u.id = a.user_id
     WHERE a.id = :id
       AND a.status = 'disbursed'
       AND (:userId IS NULL OR a.user_id = :userId)
     LIMIT 1`,
    { id, userId }
  );

  return rows[0] || null;
}

/**
 * Retrieve all disbursed facilities belonging to a member.
 */
export async function listDisbursedFacilitiesByUser(
  userId,
  connection = null
) {
  const executor = getExecutor(connection);

  const [rows] = await executor.query(
    `SELECT
       a.*,
       u.full_name,
       u.email,
       u.member_id
     FROM finance_facility_applications a
     JOIN users u ON u.id = a.user_id
     WHERE a.user_id = :userId
       AND a.status = 'disbursed'
     ORDER BY a.disbursed_at DESC, a.id DESC`,
    { userId }
  );

  return rows;
}

/**
 * Find a schedule installment by facility and installment number.
 */
export async function findScheduleInstallment(
  facilityId,
  installmentNumber,
  connection = null
) {
  const executor = getExecutor(connection);

  const [rows] = await executor.query(
    `SELECT *
     FROM finance_facility_repayment_schedules
     WHERE facility_id = :facilityId
       AND installment_number = :installmentNumber
     LIMIT 1`,
    { facilityId, installmentNumber }
  );

  return rows[0] || null;
}

/**
 * Create one installment.
 *
 * The database unique constraint on
 * (facility_id, installment_number) prevents duplicates.
 */
export async function createScheduleInstallment(
  {
    facilityId,
    userId,
    installmentNumber,
    dueDate,
    amountDue,
  },
  connection = null
) {
  const executor = getExecutor(connection);

  const [result] = await executor.query(
    `INSERT INTO finance_facility_repayment_schedules (
       facility_id,
       user_id,
       installment_number,
       due_date,
       amount_due,
       amount_paid,
       status
     )
     VALUES (
       :facilityId,
       :userId,
       :installmentNumber,
       :dueDate,
       :amountDue,
       0.00,
       'pending'
     )`,
    {
      facilityId,
      userId,
      installmentNumber,
      dueDate,
      amountDue,
    }
  );

  return findScheduleInstallmentById(result.insertId, connection);
}

/**
 * Retrieve a schedule installment by primary key.
 */
export async function findScheduleInstallmentById(
  id,
  connection = null
) {
  const executor = getExecutor(connection);

  const [rows] = await executor.query(
    `SELECT *
     FROM finance_facility_repayment_schedules
     WHERE id = :id
     LIMIT 1`,
    { id }
  );

  return rows[0] || null;
}

/**
 * Retrieve a facility's complete repayment schedule.
 */
export async function listScheduleByFacility(
  facilityId,
  userId = null,
  connection = null
) {
  const executor = getExecutor(connection);

  const [rows] = await executor.query(
    `SELECT s.*
     FROM finance_facility_repayment_schedules s
     WHERE s.facility_id = :facilityId
       AND (:userId IS NULL OR s.user_id = :userId)
     ORDER BY s.installment_number ASC`,
    { facilityId, userId }
  );

  return rows;
}

/**
 * Retrieve the earliest installment with an outstanding amount.
 *
 * Partially paid installments remain outstanding.
 */
export async function findNextRepaymentDue(
  facilityId,
  userId = null,
  connection = null
) {
  const executor = getExecutor(connection);

  const [rows] = await executor.query(
    `SELECT s.*
     FROM finance_facility_repayment_schedules s
     WHERE s.facility_id = :facilityId
       AND (:userId IS NULL OR s.user_id = :userId)
       AND s.amount_paid < s.amount_due
     ORDER BY s.installment_number ASC
     LIMIT 1`,
    { facilityId, userId }
  );

  return rows[0] || null;
}

/**
 * Retrieve outstanding installments across a member's facilities.
 */
export async function listOutstandingSchedulesByUser(
  userId,
  connection = null
) {
  const executor = getExecutor(connection);

  const [rows] = await executor.query(
    `SELECT
       s.*,
       a.business_name,
       a.disbursed_at
     FROM finance_facility_repayment_schedules s
     JOIN finance_facility_applications a
       ON a.id = s.facility_id
     WHERE s.user_id = :userId
       AND a.status = 'disbursed'
       AND s.amount_paid < s.amount_due
     ORDER BY s.due_date ASC, s.id ASC`,
    { userId }
  );

  return rows;
}

/**
 * Retrieve repayment totals for a facility.
 *
 * DECIMAL values are returned by MySQL drivers as strings in many
 * configurations. Preserve the raw values here; convert to integer kobo
 * in the service layer when doing monetary calculations.
 */
export async function getFacilityRepaymentTotals(
  facilityId,
  userId = null,
  connection = null
) {
  const executor = getExecutor(connection);

  const [rows] = await executor.query(
    `SELECT
       COALESCE(SUM(s.amount_due), 0.00) AS total_due,
       COALESCE(SUM(s.amount_paid), 0.00) AS total_paid,
       COALESCE(
         SUM(s.amount_due - s.amount_paid),
         0.00
       ) AS outstanding_balance,
       COUNT(*) AS installment_count,
       COALESCE(
         SUM(CASE WHEN s.status = 'paid' THEN 1 ELSE 0 END),
         0
       ) AS paid_installment_count
     FROM finance_facility_repayment_schedules s
     WHERE s.facility_id = :facilityId
       AND (:userId IS NULL OR s.user_id = :userId)`,
    { facilityId, userId }
  );

  const row = rows[0] || {};

  return {
    totalDue: row.total_due ?? "0.00",
    totalPaid: row.total_paid ?? "0.00",
    outstandingBalance: row.outstanding_balance ?? "0.00",
    installmentCount: Number(row.installment_count ?? 0),
    paidInstallmentCount: Number(row.paid_installment_count ?? 0),
  };
}

/**
 * Find a repayment by its unique Paystack reference.
 */
export async function findRepaymentByPaystackReference(
  paystackReference,
  connection = null
) {
  const executor = getExecutor(connection);

  const [rows] = await executor.query(
    `SELECT *
     FROM finance_facility_repayments
     WHERE paystack_reference = :paystackReference
     LIMIT 1`,
    { paystackReference }
  );

  return rows[0] || null;
}

/**
 * Retrieve a repayment record by ID.
 */
export async function findRepaymentById(id, connection = null) {
  const executor = getExecutor(connection);

  const [rows] = await executor.query(
    `SELECT *
     FROM finance_facility_repayments
     WHERE id = :id
     LIMIT 1`,
    { id }
  );

  return rows[0] || null;
}

/**
 * Create a pending Paystack repayment record.
 */
export async function createRepayment(
  {
    facilityId,
    userId,
    paystackReference,
    amount,
    currency = "NGN",
    status = "pending",
  },
  connection = null
) {
  const executor = getExecutor(connection);

  const [result] = await executor.query(
    `INSERT INTO finance_facility_repayments (
       facility_id,
       user_id,
       paystack_reference,
       amount,
       currency,
       status
     )
     VALUES (
       :facilityId,
       :userId,
       :paystackReference,
       :amount,
       :currency,
       :status
     )`,
    {
      facilityId,
      userId,
      paystackReference,
      amount,
      currency,
      status,
    }
  );

  return findRepaymentById(result.insertId, connection);
}

/**
 * Lock a repayment row inside a transaction.
 *
 * Must be called with a transaction connection.
 */
export async function findRepaymentByIdForUpdate(id, connection) {
  if (!connection) {
    throw new Error(
      "A transaction connection is required to lock a repayment."
    );
  }

  const [rows] = await connection.query(
    `SELECT *
     FROM finance_facility_repayments
     WHERE id = :id
     LIMIT 1
     FOR UPDATE`,
    { id }
  );

  return rows[0] || null;
}

/**
 * Lock a schedule installment inside a transaction.
 */
export async function findScheduleInstallmentForUpdate(
  facilityId,
  installmentNumber,
  connection
) {
  if (!connection) {
    throw new Error(
      "A transaction connection is required to lock a schedule installment."
    );
  }

  const [rows] = await connection.query(
    `SELECT *
     FROM finance_facility_repayment_schedules
     WHERE facility_id = :facilityId
       AND installment_number = :installmentNumber
     LIMIT 1
     FOR UPDATE`,
    { facilityId, installmentNumber }
  );

  return rows[0] || null;
}

/**
 * Update a schedule installment's paid amount and status.
 *
 * Call inside the same transaction that marks the repayment successful.
 */
export async function updateScheduleInstallmentPayment(
  {
    id,
    amountPaid,
    status,
  },
  connection
) {
  if (!connection) {
    throw new Error(
      "A transaction connection is required to update a schedule installment."
    );
  }

  const [result] = await connection.query(
    `UPDATE finance_facility_repayment_schedules
     SET amount_paid = :amountPaid,
         status = :status
     WHERE id = :id`,
    { id, amountPaid, status }
  );

  if (result.affectedRows !== 1) {
    throw new Error("Failed to update the repayment schedule installment.");
  }

  return findScheduleInstallmentById(id, connection);
}

/**
 * Mark a repayment successful after Paystack verification.
 *
 * This is a database update, not payment verification.
 * Only call it after the service verifies the transaction with Paystack.
 */
export async function markRepaymentSuccessful(
  {
    id,
    paidAt = new Date(),
  },
  connection
) {
  if (!connection) {
    throw new Error(
      "A transaction connection is required to finalize a repayment."
    );
  }

  const [result] = await connection.query(
    `UPDATE finance_facility_repayments
     SET status = 'success',
         paid_at = :paidAt
     WHERE id = :id
       AND status = 'pending'`,
    { id, paidAt }
  );

  if (result.affectedRows !== 1) {
    throw new Error(
      "The repayment is not pending or has already been processed."
    );
  }

  return findRepaymentById(id, connection);
}

/**
 * Retrieve repayment history for a facility.
 */
export async function listRepaymentsByFacility(
  facilityId,
  userId = null,
  connection = null
) {
  const executor = getExecutor(connection);

  const [rows] = await executor.query(
    `SELECT *
     FROM finance_facility_repayments
     WHERE facility_id = :facilityId
       AND (:userId IS NULL OR user_id = :userId)
     ORDER BY created_at DESC, id DESC`,
    { facilityId, userId }
  );

  return rows;
}

/**
 * Retrieve successful repayments for a member.
 */
export async function listSuccessfulRepaymentsByUser(
  userId,
  connection = null
) {
  const executor = getExecutor(connection);

  const [rows] = await executor.query(
    `SELECT
       r.*,
       a.business_name,
       a.disbursement_reference
     FROM finance_facility_repayments r
     JOIN finance_facility_applications a
       ON a.id = r.facility_id
     WHERE r.user_id = :userId
       AND r.status = 'success'
     ORDER BY r.paid_at DESC, r.id DESC`,
    { userId }
  );

  return rows;
}

/**
 * Retrieve repayment records for admin reporting.
 */
export async function listRepaymentsForAdmin(
  { status = null } = {},
  connection = null
) {
  const executor = getExecutor(connection);

  const [rows] = await executor.query(
    `SELECT
       r.*,
       a.business_name,
       u.full_name,
       u.email,
       u.member_id
     FROM finance_facility_repayments r
     JOIN finance_facility_applications a
       ON a.id = r.facility_id
     JOIN users u
       ON u.id = r.user_id
     WHERE (:status IS NULL OR r.status = :status)
     ORDER BY r.created_at DESC, r.id DESC`,
    { status }
  );

  return rows;
}