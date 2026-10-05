-- A withdrawal is confirmed with an OTP, same as login's 2FA step — add
-- it as a valid `purpose` on the existing otps table rather than building
-- a parallel confirmation mechanism.
ALTER TABLE otps MODIFY COLUMN purpose
  ENUM('email_verification', 'login_2fa', 'withdrawal') NOT NULL;

-- Withdrawals. Funds are deducted from available_balance the moment the
-- member confirms with OTP (not at admin approval) — that's what stops a
-- member submitting two withdrawals against the same money while one is
-- still pending review. 'approved' and 'processed' are both post-hold
-- states and never touch the balance again; 'declined' refunds it.

CREATE TABLE IF NOT EXISTS withdrawals (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT UNSIGNED NOT NULL,
  amount          DECIMAL(14,2) NOT NULL,
  bank_name       VARCHAR(100) NOT NULL,
  account_number  VARCHAR(20)  NOT NULL,
  account_name    VARCHAR(150) NOT NULL,
  status          ENUM('pending', 'approved', 'processed', 'declined')
                  NOT NULL DEFAULT 'pending',
  decline_reason  VARCHAR(500) NULL,
  reviewed_by     BIGINT UNSIGNED NULL,
  reviewed_at     DATETIME NULL,
  processed_by    BIGINT UNSIGNED NULL,
  processed_at    DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_withdrawals_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_withdrawals_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_withdrawals_processor FOREIGN KEY (processed_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_withdrawals_user (user_id),
  INDEX idx_withdrawals_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
