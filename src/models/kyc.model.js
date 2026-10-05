import { pool } from "../config/db.js";

export async function findByUserId(userId) {
  const [rows] = await pool.query(
    `SELECT * FROM kyc_submissions WHERE user_id = :userId LIMIT 1`,
    { userId }
  );
  return rows[0] || null;
}

export async function findById(id) {
  const [rows] = await pool.query(`SELECT * FROM kyc_submissions WHERE id = :id LIMIT 1`, { id });
  return rows[0] || null;
}

/**
 * Member submits (or resubmits after a decline) — one row per user,
 * upserted so a resubmission doesn't leave stale declined rows behind.
 */
export async function upsertSubmission({
  userId,
  accountNumber,
  bankName,
  houseAddress,
  idDocumentPublicId,
  idDocumentResourceType,
  proofOfAddressPublicId,
  proofOfAddressResourceType,
}) {
  await pool.query(
    `INSERT INTO kyc_submissions
       (user_id, account_number, bank_name, house_address,
        id_document_public_id, id_document_resource_type,
        proof_of_address_public_id, proof_of_address_resource_type, status)
     VALUES
       (:userId, :accountNumber, :bankName, :houseAddress,
        :idDocumentPublicId, :idDocumentResourceType,
        :proofOfAddressPublicId, :proofOfAddressResourceType, 'pending')
     ON DUPLICATE KEY UPDATE
       account_number = VALUES(account_number),
       bank_name = VALUES(bank_name),
       house_address = VALUES(house_address),
       id_document_public_id = VALUES(id_document_public_id),
       id_document_resource_type = VALUES(id_document_resource_type),
       proof_of_address_public_id = VALUES(proof_of_address_public_id),
       proof_of_address_resource_type = VALUES(proof_of_address_resource_type),
       status = 'pending',
       decline_reason = NULL,
       reviewed_by = NULL,
       reviewed_at = NULL`,
    {
      userId,
      accountNumber,
      bankName,
      houseAddress,
      idDocumentPublicId,
      idDocumentResourceType,
      proofOfAddressPublicId,
      proofOfAddressResourceType,
    }
  );
  return findByUserId(userId);
}

export async function listByStatus(status) {
  const [rows] = await pool.query(
    `SELECT k.*, u.full_name, u.email, u.member_id
       FROM kyc_submissions k
       JOIN users u ON u.id = k.user_id
      WHERE (:status IS NULL OR k.status = :status)
      ORDER BY k.submitted_at DESC`,
    { status: status || null }
  );
  return rows;
}

export async function approve({ id, reviewerId }) {
  await pool.query(
    `UPDATE kyc_submissions
        SET status = 'approved', reviewed_by = :reviewerId, reviewed_at = NOW(), decline_reason = NULL
      WHERE id = :id`,
    { id, reviewerId }
  );
}

export async function decline({ id, reviewerId, reason }) {
  await pool.query(
    `UPDATE kyc_submissions
        SET status = 'declined', reviewed_by = :reviewerId, reviewed_at = NOW(), decline_reason = :reason
      WHERE id = :id`,
    { id, reviewerId, reason }
  );
}

export function toPublicSubmission(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountNumber: row.account_number,
    bankName: row.bank_name,
    houseAddress: row.house_address,
    status: row.status,
    declineReason: row.decline_reason,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    // Member/admin's own name/email/memberId show up only on the admin
    // listing join — present them when available.
    member: row.full_name
      ? { fullName: row.full_name, email: row.email, memberId: row.member_id }
      : undefined,
  };
}
