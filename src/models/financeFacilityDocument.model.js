import { pool } from "../config/db.js";

export async function create({
  applicationId,
  documentType,
  cloudinaryPublicId,
  resourceType,
  fileName,
  mimeType,
}) {
  const [result] = await pool.query(
    `INSERT INTO finance_facility_documents
       (application_id, document_type, cloudinary_public_id, resource_type, file_name, mime_type)
     VALUES (:applicationId, :documentType, :cloudinaryPublicId, :resourceType, :fileName, :mimeType)`,
    { applicationId, documentType, cloudinaryPublicId, resourceType, fileName, mimeType }
  );
  return findById(result.insertId);
}

export async function findById(id) {
  const [rows] = await pool.query(`SELECT * FROM finance_facility_documents WHERE id = :id LIMIT 1`, {
    id,
  });
  return rows[0] || null;
}

export async function listByApplication(applicationId) {
  const [rows] = await pool.query(
    `SELECT * FROM finance_facility_documents WHERE application_id = :applicationId ORDER BY uploaded_at ASC`,
    { applicationId }
  );
  return rows;
}

export function toPublicDocument(row) {
  if (!row) return null;
  return {
    id: row.id,
    applicationId: row.application_id,
    documentType: row.document_type,
    fileName: row.file_name,
    mimeType: row.mime_type,
    uploadedAt: row.uploaded_at,
  };
}
