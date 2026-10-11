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

/**
 * Placing the hold and recording the withdrawal are ONE transaction: either
 * the funds are held AND a withdrawal row exists, or neither happened. (As two
 * separate statements, a failure between them leaves money held against a
 * withdrawal that was never recorded.) The balance check is inside the UPDATE,
 * so concurrent requests can't both spend the same funds. Returns the new
 * withdrawal row, or null if the balance was insufficient.
 */
export async function createWithHold({ userId, amount, bankName, accountNumber, accountName }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [held] = await conn.query(
      `UPDATE users
          SET available_balance = available_balance - :amount
        WHERE id = :userId AND available_balance >= :amount`,
      { userId, amount }
    );
    if (held.affectedRows !== 1) {
      await conn.rollback();
      return null;
    }
    const [inserted] = await conn.query(
      `INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name, status)
       VALUES (:userId, :amount, :bankName, :accountNumber, :accountName, 'pending')`,
      { userId, amount, bankName, accountNumber, accountName }
    );
    await conn.commit();
    return findById(inserted.insertId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Status changes are conditional on the expected current status and report whether THIS call made the change. */
export async function markApproved({ id, reviewerId }) {
  const [result] = await pool.query(
    `UPDATE withdrawals
        SET status = 'approved', reviewed_by = :reviewerId, reviewed_at = NOW()
      WHERE id = :id AND status = 'pending'`,
    { id, reviewerId }
  );
  return result.affectedRows === 1;
}

/** Decline + refund the held funds in one transaction, only if still pending. */
export async function declineAndRefund({ id, reviewerId, reason }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [claimed] = await conn.query(
      `UPDATE withdrawals
          SET status = 'declined', reviewed_by = :reviewerId, reviewed_at = NOW(), decline_reason = :reason
        WHERE id = :id AND status = 'pending'`,
      { id, reviewerId, reason }
    );
    if (claimed.affectedRows !== 1) {
      await conn.rollback();
      return false;
    }
    const [[w]] = await conn.query(`SELECT user_id, amount FROM withdrawals WHERE id = :id`, { id });
    await conn.query(
      `UPDATE users SET available_balance = available_balance + :amount WHERE id = :userId`,
      { amount: w.amount, userId: w.user_id }
    );
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function markProcessed({ id, processorId }) {
  const [result] = await pool.query(
    `UPDATE withdrawals
        SET status = 'processed', processed_by = :processorId, processed_at = NOW()
      WHERE id = :id AND status = 'approved'`,
    { id, processorId }
  );
  return result.affectedRows === 1;
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
