import { pool } from "../config/db.js";

export async function create({ userId, amount, bankName, accountNumber, accountName }) {
  const [result] = await pool.query(
    `INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name, status)
     VALUES (:userId, :amount, :bankName, :accountNumber, :accountName, 'pending')`,
    { userId, amount, bankName, accountNumber, accountName }
  );
  return findById(result.insertId);
}

export async function findById(id) {
  const [rows] = await pool.query(`SELECT * FROM withdrawals WHERE id = :id LIMIT 1`, { id });
  return rows[0] || null;
}

export async function listByUser(userId) {
  const [rows] = await pool.query(
    `SELECT * FROM withdrawals WHERE user_id = :userId ORDER BY created_at DESC`,
    { userId }
  );
  return rows;
}

export async function listByStatus(status) {
  const [rows] = await pool.query(
    `SELECT w.*, u.full_name, u.email, u.member_id
       FROM withdrawals w
       JOIN users u ON u.id = w.user_id
      WHERE (:status IS NULL OR w.status = :status)
      ORDER BY w.created_at DESC`,
    { status: status || null }
  );
  return rows;
}

export async function markApproved({ id, reviewerId }) {
  await pool.query(
    `UPDATE withdrawals
        SET status = 'approved', reviewed_by = :reviewerId, reviewed_at = NOW()
      WHERE id = :id`,
    { id, reviewerId }
  );
}

export async function markDeclined({ id, reviewerId, reason }) {
  await pool.query(
    `UPDATE withdrawals
        SET status = 'declined', reviewed_by = :reviewerId, reviewed_at = NOW(), decline_reason = :reason
      WHERE id = :id`,
    { id, reviewerId, reason }
  );
}

export async function markProcessed({ id, processorId }) {
  await pool.query(
    `UPDATE withdrawals
        SET status = 'processed', processed_by = :processorId, processed_at = NOW()
      WHERE id = :id`,
    { id, processorId }
  );
}

export function toPublicWithdrawal(row) {
  if (!row) return null;
  return {
    id: row.id,
    amount: Number(row.amount),
    bankName: row.bank_name,
    accountNumber: row.account_number,
    accountName: row.account_name,
    status: row.status,
    declineReason: row.decline_reason,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    processedAt: row.processed_at,
    member: row.full_name
      ? { fullName: row.full_name, email: row.email, memberId: row.member_id }
      : undefined,
  };
}
