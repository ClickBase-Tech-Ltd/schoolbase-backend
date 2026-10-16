ALTER TABLE `BankStatementImport`
  MODIFY `status` ENUM('IMPORTED', 'PREPARED', 'RECONCILED', 'VOIDED') NOT NULL DEFAULT 'IMPORTED',
  ADD COLUMN `preparedBy` VARCHAR(191) NULL,
  ADD COLUMN `preparedAt` DATETIME(3) NULL;

ALTER TABLE `BankStatementImport`
  DROP INDEX `BankStatementImport_schoolId_accountingAccountId_checksum_key`,
  ADD INDEX `BankStatementImport_schoolId_accountingAccountId_checksum_idx` (`schoolId`, `accountingAccountId`, `checksum`);

CREATE TABLE `BankStatementReconciliationEvent` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `importId` VARCHAR(191) NOT NULL,
  `actorId` VARCHAR(191) NOT NULL,
  `action` ENUM('PREPARED', 'APPROVED', 'REOPENED', 'VOIDED') NOT NULL,
  `reason` LONGTEXT NULL,
  `metadata` LONGTEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `BankStatementReconciliationEvent_schoolId_importId_createdAt_idx` (`schoolId`, `importId`, `createdAt`),
  INDEX `BankStatementReconciliationEvent_actorId_createdAt_idx` (`actorId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `BankStatementReconciliationEvent_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `BankStatementReconciliationEvent_importId_fkey` FOREIGN KEY (`importId`) REFERENCES `BankStatementImport` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;