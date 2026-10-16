CREATE TABLE `BankStatementMatch` (
  `id` VARCHAR(191) NOT NULL,
  `statementLineId` VARCHAR(191) NOT NULL,
  `journalLineId` VARCHAR(191) NOT NULL,
  `amountMinor` INTEGER NOT NULL,
  `matchedBy` VARCHAR(191) NOT NULL,
  `matchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `BankStatementMatch_statementLineId_journalLineId_key` (`statementLineId`, `journalLineId`),
  INDEX `BankStatementMatch_journalLineId_idx` (`journalLineId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `BankStatementMatch_statementLineId_fkey` FOREIGN KEY (`statementLineId`) REFERENCES `BankStatementLine` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `BankStatementMatch_journalLineId_fkey` FOREIGN KEY (`journalLineId`) REFERENCES `AccountingJournalLine` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `BankStatementMatch` (`id`, `statementLineId`, `journalLineId`, `amountMinor`, `matchedBy`, `matchedAt`)
SELECT CONCAT('legacy-', `id`), `id`, `matchedJournalLineId`, `amountMinor`, COALESCE(`matchedBy`, 'migration'), COALESCE(`matchedAt`, `createdAt`)
FROM `BankStatementLine`
WHERE `matchedJournalLineId` IS NOT NULL;

ALTER TABLE `BankStatementLine`
  DROP FOREIGN KEY `BankStatementLine_matchedJournalLineId_fkey`,
  DROP INDEX `BankStatementLine_matchedJournalLineId_key`,
  DROP COLUMN `matchedJournalLineId`,
  DROP COLUMN `matchedBy`,
  DROP COLUMN `matchedAt`;