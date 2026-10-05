-- 363 Cooperative Society — core auth schema
-- Run against an empty database, e.g.:
--   mysql -u root -p cooperative_363 < src/db/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  member_id           VARCHAR(20)  NULL UNIQUE,
  full_name           VARCHAR(150) NOT NULL,
  email               VARCHAR(190) NOT NULL UNIQUE,
  phone               VARCHAR(20)  NOT NULL UNIQUE,
  password_hash       VARCHAR(255) NOT NULL,
  email_verified_at   DATETIME     NULL,
  status              ENUM('pending_verification', 'pending_kyc', 'pending_officer_review', 'active', 'suspended')
                       NOT NULL DEFAULT 'pending_verification',
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One-time codes for email verification and login 2FA.
-- Only a salted hash of the code is ever stored — never the plaintext code.
CREATE TABLE IF NOT EXISTS otps (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NOT NULL,
  purpose       ENUM('email_verification', 'login_2fa') NOT NULL,
  otp_hash      CHAR(64) NOT NULL,          -- HMAC-SHA256(code, pepper), hex-encoded
  expires_at    DATETIME NOT NULL,
  attempts      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts  TINYINT UNSIGNED NOT NULL DEFAULT 5,
  consumed_at   DATETIME NULL,
  invalidated_at DATETIME NULL,             -- set when superseded by a newer OTP
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_otps_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_otps_user_purpose_active (user_id, purpose, consumed_at, invalidated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Refresh tokens, stored hashed so a DB leak doesn't hand out live sessions.
-- Enables server-side revocation (logout, rotation on refresh).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT UNSIGNED NOT NULL,
  token_hash   CHAR(64) NOT NULL UNIQUE,
  user_agent   VARCHAR(255) NULL,
  ip_address   VARCHAR(45) NULL,
  expires_at   DATETIME NOT NULL,
  revoked_at   DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_refresh_tokens_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
