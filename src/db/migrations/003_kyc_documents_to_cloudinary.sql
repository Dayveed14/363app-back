-- KYC documents now live in Cloudinary instead of local disk. Local file
-- paths are replaced with a Cloudinary public_id + resource_type per
-- document — both are needed to regenerate a signed delivery URL later
-- (see src/services/storage.service.js).

ALTER TABLE kyc_submissions
  CHANGE COLUMN id_document_path id_document_public_id VARCHAR(255) NOT NULL,
  ADD COLUMN id_document_resource_type VARCHAR(20) NOT NULL DEFAULT 'image' AFTER id_document_public_id,
  CHANGE COLUMN proof_of_address_path proof_of_address_public_id VARCHAR(255) NOT NULL,
  ADD COLUMN proof_of_address_resource_type VARCHAR(20) NOT NULL DEFAULT 'image' AFTER proof_of_address_public_id;
