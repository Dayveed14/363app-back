import { pool } from "../config/db.js";
import { env } from "../config/env.js";

/**
 * Invalidates any still-active OTPs for this user+purpose, then inserts a new
 * one. Both happen in a single transaction so a request that races with
 * another can't leave two "active" OTPs for the same purpose.
 */
export async function createOtp({ userId, purpose, otpHash }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `UPDATE otps
          SET invalidated_at = NOW()
        WHERE user_id = :userId
          AND purpose = :purpose
          AND consumed_at IS NULL
          AND invalidated_at IS NULL`,
      { userId, purpose }
    );

    const [result] = await conn.query(
      `INSERT INTO otps (user_id, purpose, otp_hash, expires_at, max_attempts)
       VALUES (:userId, :purpose, :otpHash, DATE_ADD(NOW(), INTERVAL :minutes MINUTE), :maxAttempts)`,
      {
        userId,
        purpose,
        otpHash,
        minutes: env.otp.expiresMinutes,
        maxAttempts: env.otp.maxAttempts,
      }
    );

    await conn.commit();
    return { id: result.insertId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function findActiveOtp({ userId, purpose }) {
  const [rows] = await pool.query(
    `SELECT id, otp_hash, expires_at, attempts, max_attempts
       FROM otps
      WHERE user_id = :userId
        AND purpose = :purpose
        AND consumed_at IS NULL
        AND invalidated_at IS NULL
      ORDER BY id DESC
      LIMIT 1`,
    { userId, purpose }
  );
  return rows[0] || null;
}

export async function incrementAttempts(otpId) {
  await pool.query(`UPDATE otps SET attempts = attempts + 1 WHERE id = :otpId`, { otpId });
}

export async function consumeOtp(otpId) {
  await pool.query(`UPDATE otps SET consumed_at = NOW() WHERE id = :otpId`, { otpId });
}

export async function invalidateOtp(otpId) {
  await pool.query(`UPDATE otps SET invalidated_at = NOW() WHERE id = :otpId`, { otpId });
}
