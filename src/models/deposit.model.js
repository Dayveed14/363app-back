import { pool } from "../config/db.js";

export async function createInitialized({ userId, reference, amount }) {
  const [result] = await pool.query(
    `INSERT INTO deposits (user_id, reference, amount, status)
     VALUES (:userId, :reference, :amount, 'initialized')`,
    { userId, reference, amount }
  );
  return findById(result.insertId);
}

export async function findByReference(reference) {
  const [rows] = await pool.query(`SELECT * FROM deposits WHERE reference = :reference LIMIT 1`, {
    reference,
  });
  return rows[0] || null;
}

export async function findById(id) {
  const [rows] = await pool.query(`SELECT * FROM deposits WHERE id = :id LIMIT 1`, { id });
  return rows[0] || null;
}

export async function markFailed({ reference, reason, paystackRefId }) {
  await pool.query(
    `UPDATE deposits
        SET status = 'failed', failure_reason = :reason, paystack_ref_id = :paystackRefId
      WHERE reference = :reference`,
    { reference, reason, paystackRefId }
  );
}

export async function markPendingConfirmation({ reference, paystackRefId }) {
  await pool.query(
    `UPDATE deposits
        SET status = 'pending_confirmation', paystack_ref_id = :paystackRefId
      WHERE reference = :reference`,
    { reference, paystackRefId }
  );
}

export async function markConfirmed({ id, reviewerId }) {
  await pool.query(
    `UPDATE deposits
        SET status = 'confirmed', reviewed_by = :reviewerId, reviewed_at = NOW()
      WHERE id = :id`,
    { id, reviewerId }
  );
}

export async function markDeclined({ id, reviewerId, reason }) {
  await pool.query(
    `UPDATE deposits
        SET status = 'declined', reviewed_by = :reviewerId, reviewed_at = NOW(), decline_reason = :reason
      WHERE id = :id`,
    { id, reviewerId, reason }
  );
}

export async function listByUser(userId) {
  const [rows] = await pool.query(
    `SELECT * FROM deposits WHERE user_id = :userId ORDER BY created_at DESC`,
    { userId }
  );
  return rows;
}

export async function listByStatus(status) {
  const [rows] = await pool.query(
    `SELECT d.*, u.full_name, u.email, u.member_id
       FROM deposits d
       JOIN users u ON u.id = d.user_id
      WHERE (:status IS NULL OR d.status = :status)
      ORDER BY d.created_at DESC`,
    { status: status || null }
  );
  return rows;
}

export function toPublicDeposit(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    amount: Number(row.amount),
    status: row.status,
    failureReason: row.failure_reason,
    declineReason: row.decline_reason,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    member: row.full_name
      ? { fullName: row.full_name, email: row.email, memberId: row.member_id }
      : undefined,
  };
}
