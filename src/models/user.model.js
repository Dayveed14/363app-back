import { pool } from "../config/db.js";

export async function createUser({ fullName, email, phone, passwordHash }) {
  const [result] = await pool.query(
    `INSERT INTO users (full_name, email, phone, password_hash, status)
     VALUES (:fullName, :email, :phone, :passwordHash, 'pending_verification')`,
    { fullName, email, phone, passwordHash }
  );

  // Human-friendly member ID derived from the auto-increment id, e.g. 363-CS-00042.
  const memberId = `363-CS-${String(result.insertId).padStart(5, "0")}`;
  await pool.query(`UPDATE users SET member_id = :memberId WHERE id = :id`, {
    memberId,
    id: result.insertId,
  });

  return findUserById(result.insertId);
}

export async function findUserByEmail(email) {
  const [rows] = await pool.query(`SELECT * FROM users WHERE email = :email LIMIT 1`, { email });
  return rows[0] || null;
}

export async function findUserByPhone(phone) {
  const [rows] = await pool.query(`SELECT * FROM users WHERE phone = :phone LIMIT 1`, { phone });
  return rows[0] || null;
}

export async function findUserById(id) {
  const [rows] = await pool.query(`SELECT * FROM users WHERE id = :id LIMIT 1`, { id });
  return rows[0] || null;
}

export async function markEmailVerified(userId) {
  await pool.query(
    `UPDATE users
        SET email_verified_at = NOW(),
            status = CASE WHEN status = 'pending_verification' THEN 'pending_kyc' ELSE status END
      WHERE id = :userId`,
    { userId }
  );
}

export async function findAdmins() {
  const [rows] = await pool.query(`SELECT id, email, full_name FROM users WHERE role = 'admin'`);
  return rows;
}

/**
 * There's no self-serve path to become an admin — promote via this
 * function from a one-off script/shell (see README). Keeping it out of any
 * HTTP route is deliberate: an admin-creation endpoint is a privilege-
 * escalation target, and this project doesn't need one yet.
 */
export async function promoteToAdmin(email) {
  await pool.query(`UPDATE users SET role = 'admin' WHERE email = :email`, { email });
}

export async function markActive(userId) {
  await pool.query(`UPDATE users SET status = 'active' WHERE id = :userId`, { userId });
}

/**
 * Credits book_balance only — called once Paystack confirms a charge.
 * Does NOT touch available_balance; that only happens when an admin
 * confirms the deposit (see moveBookToAvailable).
 */
export async function creditBookBalance(userId, amount) {
  await pool.query(
    `UPDATE users SET book_balance = book_balance + :amount WHERE id = :userId`,
    { userId, amount }
  );
}

/**
 * Admin-confirm step: moves an amount from book_balance to
 * available_balance atomically, so the two can never drift out of sync
 * with the sum of confirmed/pending deposits.
 */
export async function moveBookToAvailable(userId, amount) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE users SET book_balance = book_balance - :amount WHERE id = :userId`,
      { userId, amount }
    );
    await conn.query(
      `UPDATE users SET available_balance = available_balance + :amount WHERE id = :userId`,
      { userId, amount }
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Admin-decline step: reverses a book_balance credit without ever moving it
 * to available_balance (the deposit never gets "regularized").
 */
/**
 * Holds funds for a withdrawal. The WHERE clause makes this an atomic
 * check-and-deduct — if two requests raced to withdraw the same balance,
 * only one can succeed; the DB, not application logic, is what prevents
 * going negative. Returns false (not an exception) when funds are
 * insufficient, so the caller can give a normal validation-style error
 * rather than treating it as unexpected.
 */
export async function holdAvailableBalance(userId, amount) {
  const [result] = await pool.query(
    `UPDATE users
        SET available_balance = available_balance - :amount
      WHERE id = :userId AND available_balance >= :amount`,
    { userId, amount }
  );
  return result.affectedRows === 1;
}

/**
 * Declined-withdrawal step: returns held funds to available_balance.
 */
export async function refundAvailableBalance(userId, amount) {
  await pool.query(
    `UPDATE users SET available_balance = available_balance + :amount WHERE id = :userId`,
    { userId, amount }
  );
}

export async function reverseBookBalance(userId, amount) {
  await pool.query(
    `UPDATE users SET book_balance = book_balance - :amount WHERE id = :userId`,
    { userId, amount }
  );
}

export function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    memberId: user.member_id,
    fullName: user.full_name,
    email: user.email,
    phone: user.phone,
    status: user.status,
    role: user.role,
    emailVerified: Boolean(user.email_verified_at),
    bookBalance: Number(user.book_balance),
    availableBalance: Number(user.available_balance),
  };
}
