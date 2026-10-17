import * as kycModel from "../models/kyc.model.js";
import * as userModel from "../models/user.model.js";
import { notify } from "./notification.service.js";
import { uploadKycDocument, getSignedUrl } from "./storage.service.js";
import { HttpError } from "../utils/errors.js";

export async function submit({ userId, accountNumber, bankName, houseAddress, files }) {
  if (!files?.idDocument?.[0] || !files?.proofOfAddress?.[0]) {
    throw new HttpError(422, "missing_documents", "Both an ID document and a proof of address are required.");
  }

  // Uploaded in parallel, straight from multer's in-memory buffers — no
  // local disk involved at any point.
  const [idUpload, addressUpload] = await Promise.all([
    uploadKycDocument(files.idDocument[0].buffer, { userId, docType: "idDocument" }),
    uploadKycDocument(files.proofOfAddress[0].buffer, { userId, docType: "proofOfAddress" }),
  ]);

  const submission = await kycModel.upsertSubmission({
    userId,
    accountNumber,
    bankName,
    houseAddress,
    idDocumentPublicId: idUpload.public_id,
    idDocumentResourceType: idUpload.resource_type,
    proofOfAddressPublicId: addressUpload.public_id,
    proofOfAddressResourceType: addressUpload.resource_type,
  });

  const user = await userModel.findUserById(userId);
  // Best-effort — a failed admin alert shouldn't fail the member's submission.
  notify.kycSubmitted({ memberName: user.full_name, memberEmail: user.email }).catch((err) =>
    console.error("[kyc] admin notification failed:", err.message)
  );

  return kycModel.toPublicSubmission(submission);
}

export async function getMine(userId) {
  const submission = await kycModel.findByUserId(userId);
  return kycModel.toPublicSubmission(submission);
}

export async function listForAdmin(status) {
  const rows = await kycModel.listByStatus(status);
  return rows.map(kycModel.toPublicSubmission);
}

export async function approve({ submissionId, reviewerId }) {
  const submission = await kycModel.findById(submissionId);
  if (!submission) throw new HttpError(404, "not_found", "Submission not found.");
  if (Number(submission.user_id) === Number(reviewerId)) {
    throw new HttpError(403, "self_review", "You can't review your own KYC submission.");
  }

  const approved = await kycModel.approve({ id: submissionId, reviewerId });
  if (!approved) {
    throw new HttpError(409, "invalid_state", "This submission isn't pending review (it may already have been handled).");
  }
  await userModel.markActive(submission.user_id);

  const user = await userModel.findUserById(submission.user_id);
  notify.kycApproved(user.email, { fullName: user.full_name }).catch((err) =>
    console.error("[kyc] member notification failed:", err.message)
  );

  return kycModel.toPublicSubmission(await kycModel.findById(submissionId));
}

export async function decline({ submissionId, reviewerId, reason }) {
  if (!reason) throw new HttpError(422, "reason_required", "A decline reason is required.");

  const submission = await kycModel.findById(submissionId);
  if (!submission) throw new HttpError(404, "not_found", "Submission not found.");
  if (Number(submission.user_id) === Number(reviewerId)) {
    throw new HttpError(403, "self_review", "You can't review your own KYC submission.");
  }

  const declined = await kycModel.decline({ id: submissionId, reviewerId, reason });
  if (!declined) {
    throw new HttpError(409, "invalid_state", "This submission isn't pending review (it may already have been handled).");
  }

  const user = await userModel.findUserById(submission.user_id);
  notify.kycDeclined(user.email, { fullName: user.full_name, reason }).catch((err) =>
    console.error("[kyc] member notification failed:", err.message)
  );

  return kycModel.toPublicSubmission(await kycModel.findById(submissionId));
}

export async function getDocumentUrl({ submissionId, docType, requester }) {
  const submission = await kycModel.findById(submissionId);
  if (!submission) throw new HttpError(404, "not_found", "Submission not found.");

  const isOwner = submission.user_id === requester.id;
  const isAdmin = requester.role === "admin";
  if (!isOwner && !isAdmin) {
    throw new HttpError(403, "forbidden", "You don't have access to this document.");
  }

  const publicId =
    docType === "idDocument" ? submission.id_document_public_id : submission.proof_of_address_public_id;
  const resourceType =
    docType === "idDocument" ? submission.id_document_resource_type : submission.proof_of_address_resource_type;
  if (!publicId) throw new HttpError(404, "not_found", "Document not found.");

  // Signed, not public — see storage.service.js for why this alone isn't
  // handed back to the browser.
  return getSignedUrl({ publicId, resourceType });
}
