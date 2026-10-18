ALTER TABLE `SignupOtp`
  ADD COLUMN `recoveryKeyHash` CHAR(64) NULL,
  ADD COLUMN `recoveryExpiresAt` DATETIME(3) NULL;

CREATE INDEX `SignupOtp_recoveryExpiresAt_idx` ON `SignupOtp`(`recoveryExpiresAt`);