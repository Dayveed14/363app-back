-- ============================================================
-- 363 Cooperative Society
-- Finance Facility Repayment Migration
-- Date: 2026-10-11
--
-- Rules:
-- 1. Repayment begins after facility disbursement.
-- 2. Number of installments = term_months.
-- 3. Monthly installment = installment_amount.
-- 4. Total payable = installment_amount * term_months.
-- 5. Payments must be verified through Paystack.
-- ============================================================

-- ============================================================
-- TABLE 1: Monthly repayment schedule
-- ============================================================

CREATE TABLE IF NOT EXISTS finance_facility_repayment_schedules (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

    facility_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,

    installment_number SMALLINT UNSIGNED NOT NULL,
    due_date DATE NOT NULL,

    amount_due DECIMAL(14,2) NOT NULL,
    amount_paid DECIMAL(14,2) NOT NULL DEFAULT 0.00,

    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),

    -- One installment number per facility.
    UNIQUE KEY uq_ffs_facility_installment (
        facility_id,
        installment_number
    ),

    KEY idx_ffs_user (user_id),
    KEY idx_ffs_facility (facility_id),
    KEY idx_ffs_user_status (user_id, status),
    KEY idx_ffs_due_date_status (due_date, status),

    CONSTRAINT fk_ffs_facility
        FOREIGN KEY (facility_id)
        REFERENCES finance_facility_applications (id)
        ON DELETE CASCADE,

    CONSTRAINT fk_ffs_user
        FOREIGN KEY (user_id)
        REFERENCES users (id)
        ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci;


-- ============================================================
-- TABLE 2: Paystack repayment transactions
-- ============================================================

CREATE TABLE IF NOT EXISTS finance_facility_repayments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

    facility_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,

    -- Unique reference generated for the Paystack transaction.
    paystack_reference VARCHAR(100) NOT NULL,

    amount DECIMAL(14,2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'NGN',

    -- pending: initialized but not yet verified
    -- success: verified successfully with Paystack
    -- failed: Paystack verification confirms failure
    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    paid_at DATETIME DEFAULT NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),

    -- A Paystack reference can only belong to one transaction record.
    UNIQUE KEY uq_ffr_paystack_reference (paystack_reference),

    KEY idx_ffr_facility (facility_id),
    KEY idx_ffr_user (user_id),
    KEY idx_ffr_facility_status (facility_id, status),
    KEY idx_ffr_user_status (user_id, status),
    KEY idx_ffr_created_at (created_at),

    CONSTRAINT fk_ffr_facility
        FOREIGN KEY (facility_id)
        REFERENCES finance_facility_applications (id)
        ON DELETE CASCADE,

    CONSTRAINT fk_ffr_user
        FOREIGN KEY (user_id)
        REFERENCES users (id)
        ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci;