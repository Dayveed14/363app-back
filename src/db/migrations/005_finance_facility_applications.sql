-- 363 Resources Business Finance Facility — phase 1: eligibility,
-- application submission, and officer review through approve/decline/
-- request-more-info. Deliberately stops short of offer-acceptance,
-- agreements, disbursement, and repayment tracking — those get their own
-- migration once this slice is in and working, per the application vs.
-- facility distinction in the spec (an application that's declined never
-- becomes a facility; only an accepted, disbursed one does).

CREATE TABLE IF NOT EXISTS finance_facility_applications (
  id                              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id                         BIGINT UNSIGNED NOT NULL,

  amount_requested                DECIMAL(14,2) NOT NULL,
  purpose                         ENUM('working_capital', 'inventory', 'equipment', 'expansion', 'other') NOT NULL,
  purpose_description             TEXT NOT NULL,
  expected_benefit                TEXT NOT NULL,
  repayment_source                TEXT NOT NULL,
  expected_monthly_income         DECIMAL(14,2) NOT NULL,
  expected_monthly_expenses       DECIMAL(14,2) NOT NULL,

  business_name                   VARCHAR(150) NOT NULL,
  business_type                   VARCHAR(100) NOT NULL,
  business_address                VARCHAR(255) NOT NULL,
  years_in_business               DECIMAL(4,1) NOT NULL,

  status                          ENUM(
                                     'submitted',
                                     'under_review',
                                     'additional_information_required',
                                     'approved',
                                     'declined'
                                   ) NOT NULL DEFAULT 'submitted',

  -- Set only once an officer approves — may differ from amount_requested
  -- (the officer can counter-offer a smaller amount/different terms).
  approved_amount                 DECIMAL(14,2) NULL,
  interest_rate                   DECIMAL(5,2) NULL,
  term_months                     SMALLINT UNSIGNED NULL,
  repayment_frequency             ENUM('weekly', 'biweekly', 'monthly') NULL,
  installment_amount              DECIMAL(14,2) NULL,

  officer_id                      BIGINT UNSIGNED NULL,
  decline_reason                  VARCHAR(500) NULL,
  additional_information_request  VARCHAR(500) NULL,

  submitted_at                    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at                     DATETIME NULL,
  created_at                      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_ffa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ffa_officer FOREIGN KEY (officer_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_ffa_user (user_id),
  INDEX idx_ffa_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Facility-specific documents only (business registration, bank statement,
-- etc). Identity/address proof is deliberately NOT duplicated here when
-- the member already has approved KYC — see finance_facility.service.js.
CREATE TABLE IF NOT EXISTS finance_facility_documents (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  application_id       BIGINT UNSIGNED NOT NULL,
  document_type        VARCHAR(50) NOT NULL,
  cloudinary_public_id VARCHAR(255) NOT NULL,
  resource_type        VARCHAR(20) NOT NULL,
  file_name            VARCHAR(255) NOT NULL,
  mime_type            VARCHAR(100) NOT NULL,
  uploaded_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_ffd_application FOREIGN KEY (application_id) REFERENCES finance_facility_applications(id) ON DELETE CASCADE,
  INDEX idx_ffd_application (application_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
