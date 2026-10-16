import { pool } from "../config/db.js";

export async function create({
  userId,
  amountRequested,
  purpose,
  purposeDescription,
  expectedBenefit,
  repaymentSource,
  expectedMonthlyIncome,
  expectedMonthlyExpenses,
  businessName,
  businessType,
  businessAddress,
  yearsInBusiness,
}) {
  const [result] = await pool.query(
    `INSERT INTO finance_facility_applications
       (user_id, amount_requested, purpose, purpose_description, expected_benefit, repayment_source,
        expected_monthly_income, expected_monthly_expenses, business_name, business_type,
        business_address, years_in_business, status)
     VALUES
       (:userId, :amountRequested, :purpose, :purposeDescription, :expectedBenefit, :repaymentSource,
        :expectedMonthlyIncome, :expectedMonthlyExpenses, :businessName, :businessType,
        :businessAddress, :yearsInBusiness, 'submitted')`,
    {
      userId,
      amountRequested,
      purpose,
      purposeDescription,
      expectedBenefit,
      repaymentSource,
      expectedMonthlyIncome,
      expectedMonthlyExpenses,
      businessName,
      businessType,
      businessAddress,
      yearsInBusiness,
    }
  );
  return findById(result.insertId);
}

export async function findById(id) {
  const [rows] = await pool.query(
    `SELECT a.*, u.full_name, u.email, u.member_id
       FROM finance_facility_applications a
       JOIN users u ON u.id = a.user_id
      WHERE a.id = :id
      LIMIT 1`,
    { id }
  );
  return rows[0] || null;
}

export async function listByUser(userId) {
  const [rows] = await pool.query(
    `SELECT * FROM finance_facility_applications WHERE user_id = :userId ORDER BY submitted_at DESC`,
    { userId }
  );
  return rows;
}

/**
 * An "active" application is one still in the review pipeline or already
 * approved — used to block a member from opening a second application
 * while one is already live. Declined/appealed-to-exhaustion applications
 * don't block (resubmission is allowed).
 */
export async function findActiveByUser(userId) {
  const [rows] = await pool.query(
    `SELECT * FROM finance_facility_applications
      WHERE user_id = :userId
        AND status IN ('submitted', 'under_review', 'additional_information_required', 'approved', 'offer_accepted', 'disbursed')
      ORDER BY submitted_at DESC
      LIMIT 1`,
    { userId }
  );
  return rows[0] || null;
}

export async function listByStatus(status) {
  const [rows] = await pool.query(
    `SELECT a.*, u.full_name, u.email, u.member_id
       FROM finance_facility_applications a
       JOIN users u ON u.id = a.user_id
      WHERE (:status IS NULL OR a.status = :status)
      ORDER BY a.submitted_at DESC`,
    { status: status || null }
  );
  return rows;
}

export async function markUnderReview(id) {
  await pool.query(
    `UPDATE finance_facility_applications
        SET status = 'under_review'
      WHERE id = :id AND status = 'submitted'`,
    { id }
  );
}

export async function requestMoreInfo({ id, officerId, request }) {
  await pool.query(
    `UPDATE finance_facility_applications
        SET status = 'additional_information_required',
            officer_id = :officerId,
            additional_information_request = :request
      WHERE id = :id`,
    { id, officerId, request }
  );
}

/**
 * Member responding to an info request moves the application back into
 * the review queue rather than resolving it themselves.
 */
export async function markResubmittedForReview(id) {
  await pool.query(
    `UPDATE finance_facility_applications
        SET status = 'under_review', additional_information_request = NULL
      WHERE id = :id`,
    { id }
  );
}

export async function approve({
  id,
  officerId,
  approvedAmount,
  interestRate,
  termMonths,
  repaymentFrequency,
  installmentAmount,
}) {
  await pool.query(
    `UPDATE finance_facility_applications
        SET status = 'approved',
            officer_id = :officerId,
            approved_amount = :approvedAmount,
            interest_rate = :interestRate,
            term_months = :termMonths,
            repayment_frequency = :repaymentFrequency,
            installment_amount = :installmentAmount,
            reviewed_at = NOW()
      WHERE id = :id`,
    { id, officerId, approvedAmount, interestRate, termMonths, repaymentFrequency, installmentAmount }
  );
}

export async function decline({ id, officerId, reason }) {
  await pool.query(
    `UPDATE finance_facility_applications
        SET status = 'declined', officer_id = :officerId, decline_reason = :reason, reviewed_at = NOW()
      WHERE id = :id`,
    { id, officerId, reason }
  );
}

export function toPublicApplication(row) {
  if (!row) return null;
  return {
    id: row.id,
    amountRequested: Number(row.amount_requested),
    purpose: row.purpose,
    purposeDescription: row.purpose_description,
    expectedBenefit: row.expected_benefit,
    repaymentSource: row.repayment_source,
    expectedMonthlyIncome: Number(row.expected_monthly_income),
    expectedMonthlyExpenses: Number(row.expected_monthly_expenses),
    businessName: row.business_name,
    businessType: row.business_type,
    businessAddress: row.business_address,
    yearsInBusiness: Number(row.years_in_business),
    status: row.status,
    approvedAmount: row.approved_amount !== null ? Number(row.approved_amount) : null,
    interestRate: row.interest_rate !== null ? Number(row.interest_rate) : null,
    termMonths: row.term_months,
    repaymentFrequency: row.repayment_frequency,
    installmentAmount: row.installment_amount !== null ? Number(row.installment_amount) : null,
    declineReason: row.decline_reason,
    additionalInformationRequest: row.additional_information_request,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    offerAcceptedAt: row.offer_accepted_at ?? null,
    offerDeclinedAt: row.offer_declined_at ?? null,
    disbursedAt: row.disbursed_at ?? null,
    disbursedBy: row.disbursed_by ?? null,
    disbursementReference: row.disbursement_reference ?? null,
    member: row.full_name
      ? { fullName: row.full_name, email: row.email, memberId: row.member_id }
      : undefined,
  };
}

export async function markDisbursed({
  id,
  officerId,
  disbursementReference = null,
}) {
  const [result] = await pool.query(
    `UPDATE finance_facility_applications
        SET status = 'disbursed',
            disbursed_at = NOW(),
            disbursed_by = :officerId,
            disbursement_reference = :disbursementReference
      WHERE id = :id
        AND status = 'offer_accepted'`,
    {
      id,
      officerId,
      disbursementReference,
    }
  );

  return result.affectedRows === 1;
}

export async function findApprovedForDisbursement(id) {
  const [rows] = await pool.query(
    `SELECT a.*, u.full_name, u.email, u.member_id
       FROM finance_facility_applications a
       JOIN users u ON u.id = a.user_id
      WHERE a.id = :id
        AND a.status = 'offer_accepted'
      LIMIT 1`,
    { id }
  );

  return rows[0] || null;
}


export async function markOfferAccepted({ id, userId }) {
  const [result] = await pool.query(
    `UPDATE finance_facility_applications
        SET status = 'offer_accepted', offer_accepted_at = NOW()
      WHERE id = :id AND user_id = :userId AND status = 'approved'`,
    { id, userId }
  );
  return result.affectedRows === 1;
}

export async function markOfferDeclined({ id, userId }) {
  const [result] = await pool.query(
    `UPDATE finance_facility_applications
        SET status = 'offer_declined', offer_declined_at = NOW()
      WHERE id = :id AND user_id = :userId AND status = 'approved'`,
    { id, userId }
  );
  return result.affectedRows === 1;
}
