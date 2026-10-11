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

/**
 * Every status change below is a conditional UPDATE (... AND status = <the
 * state we expect>) that reports whether THIS call made the change. The
 * database arbitrates concurrent requests — a read-then-write check in
 * application code lets two simultaneous requests both see the old status and
 * both proceed (that's how a double-clicked button or a double-fired callback
 * ends up crediting twice). Balance moves share a transaction with the status
 * change so one can never happen without the other.
 */

export async function markFailed({ reference, reason, paystackRefId }) {
  const [result] = await pool.query(
    `UPDATE deposits
        SET status = 'failed', failure_reason = :reason, paystack_ref_id = :paystackRefId
      WHERE reference = :reference AND status = 'initialized'`,
    { reference, reason, paystackRefId }
  );
  return result.affectedRows === 1;
}

/**
 * Paystack-verified success: claim the deposit (initialized -> pending_confirmation)
 * and credit book_balance in ONE transaction. Returns { userId, amount } if this
 * call won, or null if another request already handled it.
 */
export async function creditVerifiedDeposit({ reference, paystackRefId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [claimed] = await conn.query(
      `UPDATE deposits
          SET status = 'pending_confirmation', paystack_ref_id = :paystackRefId
        WHERE reference = :reference AND status = 'initialized'`,
      { reference, paystackRefId }
    );
    if (claimed.affectedRows !== 1) {
      await conn.rollback();
      return null;
    }
    const [[deposit]] = await conn.query(
      `SELECT user_id, amount FROM deposits WHERE reference = :reference`,
      { reference }
    );
    await conn.query(
      `UPDATE users SET book_balance = book_balance + :amount WHERE id = :userId`,
      { amount: deposit.amount, userId: deposit.user_id }
    );
    await conn.commit();
    return { userId: deposit.user_id, amount: Number(deposit.amount) };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Admin confirm: pending_confirmation -> confirmed, book -> available, atomically. */
export async function confirmDeposit({ id, reviewerId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [claimed] = await conn.query(
      `UPDATE deposits
          SET status = 'confirmed', reviewed_by = :reviewerId, reviewed_at = NOW()
        WHERE id = :id AND status = 'pending_confirmation'`,
      { id, reviewerId }
    );
    if (claimed.affectedRows !== 1) {
      await conn.rollback();
      return false;
    }
    const [[deposit]] = await conn.query(`SELECT user_id, amount FROM deposits WHERE id = :id`, { id });
    await conn.query(
      `UPDATE users
          SET book_balance = book_balance - :amount,
              available_balance = available_balance + :amount
        WHERE id = :userId`,
      { amount: deposit.amount, userId: deposit.user_id }
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

/** Admin decline: pending_confirmation -> declined, reverse the book credit, atomically. */
export async function declineDeposit({ id, reviewerId, reason }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [claimed] = await conn.query(
      `UPDATE deposits
          SET status = 'declined', reviewed_by = :reviewerId, reviewed_at = NOW(), decline_reason = :reason
        WHERE id = :id AND status = 'pending_confirmation'`,
      { id, reviewerId, reason }
    );
    if (claimed.affectedRows !== 1) {
      await conn.rollback();
      return false;
    }
    const [[deposit]] = await conn.query(`SELECT user_id, amount FROM deposits WHERE id = :id`, { id });
    await conn.query(
      `UPDATE users SET book_balance = book_balance - :amount WHERE id = :userId`,
      { amount: deposit.amount, userId: deposit.user_id }
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
