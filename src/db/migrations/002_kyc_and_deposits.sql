-- Phase 2: member KYC submissions, deposits (Paystack), book/available
-- balances, and the admin role needed to review both.

ALTER TABLE users
  ADD COLUMN role ENUM('member', 'admin') NOT NULL DEFAULT 'member' AFTER status,
  ADD COLUMN book_balance DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER role,
  ADD COLUMN available_balance DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER book_balance;

-- One row per member, holding their latest/current KYC submission. A
-- declined member can resubmit, which overwrites the previous attempt's
-- fields but keeps the row (and its id) so document file paths stay tidy.
CREATE TABLE IF NOT EXISTS kyc_submissions (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id             BIGINT UNSIGNED NOT NULL,
  account_number      VARCHAR(20)  NOT NULL,
  bank_name            VARCHAR(100) NOT NULL,
  house_address       VARCHAR(255) NOT NULL,
  id_document_path    VARCHAR(255) NOT NULL,
  proof_of_address_path VARCHAR(255) NOT NULL,
  status              ENUM('pending', 'approved', 'declined') NOT NULL DEFAULT 'pending',
  decline_reason      VARCHAR(500) NULL,
  reviewed_by         BIGINT UNSIGNED NULL,
  reviewed_at         DATETIME NULL,
  submitted_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_kyc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_kyc_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_kyc_user (user_id),
  INDEX idx_kyc_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A member can only have one KYC submission row — resubmission updates it.
ALTER TABLE kyc_submissions ADD UNIQUE INDEX uq_kyc_user (user_id);

-- Every deposit attempt, from Paystack initialization through to the
-- admin's final confirm/decline. `book_balance` is credited the moment
-- Paystack confirms the charge; `available_balance` only moves once an
-- admin confirms the deposit (see src/services/deposit.service.js).
CREATE TABLE IF NOT EXISTS deposits (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id           BIGINT UNSIGNED NOT NULL,
  reference         VARCHAR(100) NOT NULL UNIQUE,
  amount            DECIMAL(14,2) NOT NULL,
  status            ENUM('initialized', 'failed', 'pending_confirmation', 'confirmed', 'declined')
                    NOT NULL DEFAULT 'initialized',
  failure_reason    VARCHAR(255) NULL,
  decline_reason    VARCHAR(500) NULL,
  paystack_ref_id   VARCHAR(100) NULL,
  reviewed_by       BIGINT UNSIGNED NULL,
  reviewed_at       DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_deposits_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_deposits_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_deposits_user (user_id),
  INDEX idx_deposits_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
