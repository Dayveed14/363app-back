import crypto from "node:crypto";
import { pool } from "../config/db.js";

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function storeRefreshToken({ userId, token, expiresAt, userAgent, ip }) {
  const tokenHash = hashToken(token);
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES (:userId, :tokenHash, :expiresAt, :userAgent, :ip)`,
    { userId, tokenHash, expiresAt, userAgent: userAgent || null, ip: ip || null }
  );
}

export async function findActiveRefreshToken(token) {
  const tokenHash = hashToken(token);
  const [rows] = await pool.query(
    `SELECT * FROM refresh_tokens
      WHERE token_hash = :tokenHash
        AND revoked_at IS NULL
        AND expires_at > NOW()
      LIMIT 1`,
    { tokenHash }
  );
  return rows[0] || null;
}

export async function revokeRefreshToken(token) {
  const tokenHash = hashToken(token);
  await pool.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = :tokenHash`, {
    tokenHash,
  });
}

export async function revokeAllForUser(userId) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = :userId AND revoked_at IS NULL`,
    { userId }
  );
}
