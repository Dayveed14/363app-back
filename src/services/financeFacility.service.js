import * as applicationModel from "../models/financeFacility.model.js";
import * as documentModel from "../models/financeFacilityDocument.model.js";
import * as userModel from "../models/user.model.js";
import * as kycModel from "../models/kyc.model.js";
import * as depositModel from "../models/deposit.model.js";
import * as withdrawalModel from "../models/withdrawal.model.js";
import { uploadFacilityDocument, getSignedUrl } from "./storage.service.js";
import { notify } from "./notification.service.js";
import { HttpError } from "../utils/errors.js";

/**
 * Thresholds below encode real lending-risk judgment this codebase isn't
 * qualified to make on the cooperative's behalf — they're deliberately
 * named constants in one place, not buried in logic, so whoever owns this
 * product can tune them without hunting through the service. Treat the
 * current values as reasonable placeholders, not settled policy.
 */
const ELIGIBILITY_RULES = {
  MIN_MEMBERSHIP_MONTHS: 3,
  MIN_CONFIRMED_DEPOSITS: 3,
  MIN_AVERAGE_MONTHLY_DEPOSIT: 5000,
};

function monthsBetween(start, end) {
  const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  return Math.max(months, 0.1); // avoid divide-by-zero for brand-new accounts
}

async function computeMetrics(userId, user) {
  const [deposits, withdrawals] = await Promise.all([
    depositModel.listByUser(userId),
    withdrawalModel.listByUser(userId),
  ]);

  const confirmedDeposits = deposits.filter((d) => d.status === "confirmed");
  const processedWithdrawals = withdrawals.filter((w) => w.status === "processed");

  const membershipMonths = monthsBetween(new Date(user.created_at), new Date());

  const totalDeposits = confirmedDeposits.reduce((sum, d) => sum + Number(d.amount), 0);
  const totalWithdrawals = processedWithdrawals.reduce((sum, w) => sum + Number(w.amount), 0);

  return {
    membershipMonths: Math.round(membershipMonths * 10) / 10,
    totalDeposits,
    depositCount: confirmedDeposits.length,
    averageDeposit: confirmedDeposits.length ? totalDeposits / confirmedDeposits.length : 0,
    averageMonthlyDeposits: Math.round((totalDeposits / membershipMonths) * 100) / 100,
    depositFrequency: Math.round((confirmedDeposits.length / membershipMonths) * 100) / 100,
    totalWithdrawals,
    withdrawalCount: processedWithdrawals.length,
    averageWithdrawal: processedWithdrawals.length ? totalWithdrawals / processedWithdrawals.length : 0,
    averageMonthlyWithdrawals: Math.round((totalWithdrawals / membershipMonths) * 100) / 100,
  };
}

/**
 * "Preliminary" by design (per the product spec) — business purpose can't
 * be assessed until an application exists, so this never returns a final
 * yes/no, only whether the member's standing clears the checks that CAN
 * be evaluated from account data alone.
 */
export async function getEligibility(userId) {
  const user = await userModel.findUserById(userId);
  const kyc = await kycModel.findByUserId(userId);
  const activeApplication = await applicationModel.findActiveByUser(userId);
  const metrics = await computeMetrics(userId, user);

  const checks = {
    kyc: kyc?.status === "approved",
    membership: metrics.membershipMonths >= ELIGIBILITY_RULES.MIN_MEMBERSHIP_MONTHS,
    depositActivity: metrics.depositCount >= ELIGIBILITY_RULES.MIN_CONFIRMED_DEPOSITS,
    withdrawalActivity: true, // no withdrawal-based disqualifier defined yet — placeholder for future policy
    financialCapacity: metrics.averageMonthlyDeposits >= ELIGIBILITY_RULES.MIN_AVERAGE_MONTHLY_DEPOSIT,
    existingFacility: !activeApplication,
  };

  const eligible = Object.values(checks).every(Boolean);

  return {
    eligible,
    note: eligible
      ? "Preliminarily eligible based on account activity. Final eligibility depends on the business purpose and officer review of your application."
      : "Does not currently meet the minimum account-activity requirements to apply.",
    checks,
    metrics,
  };
}

export async function submit({ userId, form }) {
  const kyc = await kycModel.findByUserId(userId);
  if (kyc?.status !== "approved") {
    throw new HttpError(403, "kyc_not_approved", "An approved KYC submission is required before applying.");
  }

  const active = await applicationModel.findActiveByUser(userId);
  if (active) {
    throw new HttpError(409, "application_in_progress", "You already have an application in progress.");
  }

  if (!form.amountRequested || Number(form.amountRequested) <= 0) {
    throw new HttpError(422, "invalid_amount", "Enter a valid amount.");
  }

  const application = await applicationModel.create({
    userId,
    amountRequested: Number(form.amountRequested),
    purpose: form.purpose,
    purposeDescription: form.purposeDescription,
    expectedBenefit: form.expectedBenefit,
    repaymentSource: form.repaymentSource,
    expectedMonthlyIncome: Number(form.expectedMonthlyIncome),
    expectedMonthlyExpenses: Number(form.expectedMonthlyExpenses),
    businessName: form.businessName,
    businessType: form.businessType,
    businessAddress: form.businessAddress,
    yearsInBusiness: Number(form.yearsInBusiness),
  });

  // Documents are attached afterward via addDocument() (one call per file,
  // matching the per-item upload checklist in the UI) rather than bundled
  // into this request — keeps this a plain JSON submission, not multipart.
  const user = await userModel.findUserById(userId);
  notify
    .financeFacilitySubmitted({
      memberName: user.full_name,
      memberEmail: user.email,
      amount: application.amount_requested,
    })
    .catch((err) => console.error("[finance-facility] admin notification failed:", err.message));

  return getOne({ applicationId: application.id, requester: { id: userId, role: "member" } });
}

export async function listMine(userId) {
  const rows = await applicationModel.listByUser(userId);
  return rows.map(applicationModel.toPublicApplication);
}

export async function listForAdmin(status) {
  const rows = await applicationModel.listByStatus(status);
  return rows.map(applicationModel.toPublicApplication);
}

/**
 * Shared by both the member's own detail view and the admin review page —
 * the admin additionally gets account-analysis metrics and the KYC
 * summary (not member-visible, since showing someone their own "risk
 * profile" numbers invites disputing them rather than just applying).
 */
export async function getOne({ applicationId, requester }) {
  const row = await applicationModel.findById(applicationId);
  if (!row) throw new HttpError(404, "not_found", "Application not found.");

  const isOwner = row.user_id === requester.id;
  const isAdmin = requester.role === "admin";
  if (!isOwner && !isAdmin) throw new HttpError(403, "forbidden", "You don't have access to this application.");

  const documents = (await documentModel.listByApplication(applicationId)).map(
    documentModel.toPublicDocument
  );

  const result = { ...applicationModel.toPublicApplication(row), documents };

  if (isAdmin) {
    // First admin look at a fresh submission quietly starts the clock —
    // mirrors a human reviewer picking it up, no separate click needed.
    if (row.status === "submitted") {
      await applicationModel.markUnderReview(applicationId);
      result.status = "under_review";
    }

    const [user, kyc, metrics] = await Promise.all([
      userModel.findUserById(row.user_id),
      kycModel.findByUserId(row.user_id),
      computeMetrics(row.user_id, await userModel.findUserById(row.user_id)),
    ]);

    result.accountAnalysis = metrics;
    result.kyc = kyc
      ? {
          status: kyc.status,
          bankName: kyc.bank_name,
          accountNumber: kyc.account_number,
          houseAddress: kyc.house_address,
          submissionId: kyc.id, // admin can fetch documents via the existing /api/admin/kyc/:id/documents/:docType route
        }
      : null;
    result.currentBalances = { bookBalance: Number(user.book_balance), availableBalance: Number(user.available_balance) };
  }

  return result;
}

export async function addDocument({ applicationId, requester, documentType, file }) {
  const row = await applicationModel.findById(applicationId);
  if (!row) throw new HttpError(404, "not_found", "Application not found.");
  if (row.user_id !== requester.id) throw new HttpError(403, "forbidden", "This isn't your application.");
  if (!["submitted", "under_review", "additional_information_required"].includes(row.status)) {
    throw new HttpError(409, "invalid_state", "This application is no longer accepting documents.");
  }
  if (!file) throw new HttpError(422, "missing_file", "No file was attached.");

  const upload = await uploadFacilityDocument(file.buffer, {
    userId: requester.id,
    applicationId,
    documentType,
    originalName: file.originalname,
  });

  const doc = await documentModel.create({
    applicationId,
    documentType,
    cloudinaryPublicId: upload.public_id,
    resourceType: upload.resource_type,
    fileName: file.originalname,
    mimeType: file.mimetype,
  });

  // If this was uploaded in response to an info request, send the member
  // back into the review queue rather than leaving them to re-submit
  // separately.
  if (row.status === "additional_information_required") {
    await applicationModel.markResubmittedForReview(applicationId);
  }

  return documentModel.toPublicDocument(doc);
}

export async function getDocumentUrl({ applicationId, documentId, requester }) {
  const application = await applicationModel.findById(applicationId);
  if (!application) throw new HttpError(404, "not_found", "Application not found.");

  const isOwner = application.user_id === requester.id;
  const isAdmin = requester.role === "admin";
  if (!isOwner && !isAdmin) throw new HttpError(403, "forbidden", "You don't have access to this document.");

  const doc = await documentModel.findById(documentId);
  if (!doc || doc.application_id !== applicationId) throw new HttpError(404, "not_found", "Document not found.");

  return getSignedUrl({ publicId: doc.cloudinary_public_id, resourceType: doc.resource_type });
}

export async function requestMoreInfo({ applicationId, officerId, request }) {
  if (!request) throw new HttpError(422, "request_required", "Describe what additional information is needed.");

  const application = await applicationModel.findById(applicationId);
  if (!application) throw new HttpError(404, "not_found", "Application not found.");
  if (!["submitted", "under_review"].includes(application.status)) {
    throw new HttpError(409, "invalid_state", "This application isn't awaiting initial review.");
  }

  await applicationModel.requestMoreInfo({ id: applicationId, officerId, request });

  const user = await userModel.findUserById(application.user_id);
  notify
    .financeFacilityInfoRequested(user.email, { fullName: user.full_name, request })
    .catch((err) => console.error("[finance-facility] member notification failed:", err.message));

  return getOne({ applicationId, requester: { id: officerId, role: "admin" } });
}

export async function approve({
  applicationId,
  officerId,
  approvedAmount,
  interestRate,
  termMonths,
  repaymentFrequency,
  installmentAmount,
}) {
  const application = await applicationModel.findById(applicationId);
  if (!application) throw new HttpError(404, "not_found", "Application not found.");
  if (!["submitted", "under_review", "additional_information_required"].includes(application.status)) {
    throw new HttpError(409, "invalid_state", "This application has already been decided.");
  }
  if (!approvedAmount || approvedAmount <= 0) {
    throw new HttpError(422, "invalid_amount", "Enter a valid approved amount.");
  }

  await applicationModel.approve({
    id: applicationId,
    officerId,
    approvedAmount,
    interestRate,
    termMonths,
    repaymentFrequency,
    installmentAmount,
  });

  const user = await userModel.findUserById(application.user_id);
  notify
    .financeFacilityApproved(user.email, {
      fullName: user.full_name,
      requestedAmount: application.amount_requested,
      approvedAmount,
      termMonths,
      installmentAmount,
    })
    .catch((err) => console.error("[finance-facility] member notification failed:", err.message));

  return getOne({ applicationId, requester: { id: officerId, role: "admin" } });
}

export async function decline({ applicationId, officerId, reason }) {
  if (!reason) throw new HttpError(422, "reason_required", "A decline reason is required.");

  const application = await applicationModel.findById(applicationId);
  if (!application) throw new HttpError(404, "not_found", "Application not found.");
  if (!["submitted", "under_review", "additional_information_required"].includes(application.status)) {
    throw new HttpError(409, "invalid_state", "This application has already been decided.");
  }

  await applicationModel.decline({ id: applicationId, officerId, reason });

  const user = await userModel.findUserById(application.user_id);
  notify
    .financeFacilityDeclined(user.email, { fullName: user.full_name, reason })
    .catch((err) => console.error("[finance-facility] member notification failed:", err.message));

  return getOne({ applicationId, requester: { id: officerId, role: "admin" } });
}
