ALTER TABLE `AdmissionApplication`
  ADD COLUMN `publicStatusTokenHash` VARCHAR(64) NULL,
  ADD UNIQUE INDEX `AdmissionApplication_status_token_key` (`publicStatusTokenHash`);