CREATE TABLE `AccountingAccount` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `code` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `type` ENUM('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE') NOT NULL,
  `description` VARCHAR(191) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `parentAccountId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `AccountingAccount_schoolId_code_key` (`schoolId`, `code`),
  INDEX `AccountingAccount_schoolId_type_idx` (`schoolId`, `type`),
  PRIMARY KEY (`id`),
  CONSTRAINT `AccountingAccount_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `AccountingAccount_parentAccountId_fkey` FOREIGN KEY (`parentAccountId`) REFERENCES `AccountingAccount` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AccountingJournalEntry` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `reference` VARCHAR(191) NOT NULL,
  `description` VARCHAR(191) NULL,
  `entryDate` DATETIME(3) NOT NULL,
  `status` ENUM('DRAFT', 'POSTED', 'VOIDED') NOT NULL DEFAULT 'DRAFT',
  `sourceType` VARCHAR(191) NULL,
  `sourceId` VARCHAR(191) NULL,
  `idempotencyKey` VARCHAR(191) NULL,
  `createdBy` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `postedAt` DATETIME(3) NULL,
  UNIQUE INDEX `AccountingJournalEntry_schoolId_idempotencyKey_key` (`schoolId`, `idempotencyKey`),
  INDEX `AccountingJournalEntry_schoolId_entryDate_idx` (`schoolId`, `entryDate`),
  PRIMARY KEY (`id`),
  CONSTRAINT `AccountingJournalEntry_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AccountingPeriod` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `startDate` DATETIME(3) NOT NULL,
  `endDate` DATETIME(3) NOT NULL,
  `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
  `ledgerBalanceMinor` INTEGER NOT NULL DEFAULT 0,
  `bankStatementMinor` INTEGER NOT NULL DEFAULT 0,
  `differenceMinor` INTEGER NOT NULL DEFAULT 0,
  `totalDebitMinor` INTEGER NOT NULL DEFAULT 0,
  `totalCreditMinor` INTEGER NOT NULL DEFAULT 0,
  `isBankReconciled` BOOLEAN NOT NULL DEFAULT false,
  `hasOpenEntries` BOOLEAN NOT NULL DEFAULT false,
  `closedAt` DATETIME(3) NULL,
  `closedBy` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `AccountingPeriod_schoolId_name_key` (`schoolId`, `name`),
  INDEX `AccountingPeriod_schoolId_status_idx` (`schoolId`, `status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `AccountingPeriod_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AccountingJournalLine` (
  `id` VARCHAR(191) NOT NULL,
  `journalEntryId` VARCHAR(191) NOT NULL,
  `accountId` VARCHAR(191) NOT NULL,
  `side` ENUM('DEBIT', 'CREDIT') NOT NULL,
  `amount` INTEGER NOT NULL,
  `description` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `AccountingJournalLine_journalEntryId_idx` (`journalEntryId`),
  INDEX `AccountingJournalLine_accountId_idx` (`accountId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `AccountingJournalLine_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `AccountingJournalEntry` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `AccountingJournalLine_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `AccountingAccount` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `BankStatementImport` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `accountingAccountId` VARCHAR(191) NOT NULL,
  `periodStart` DATETIME(3) NOT NULL,
  `periodEnd` DATETIME(3) NOT NULL,
  `openingBalanceMinor` INTEGER NOT NULL,
  `closingBalanceMinor` INTEGER NOT NULL,
  `fileName` VARCHAR(191) NOT NULL,
  `checksum` CHAR(64) NOT NULL,
  `status` ENUM('IMPORTED', 'RECONCILED') NOT NULL DEFAULT 'IMPORTED',
  `importedBy` VARCHAR(191) NOT NULL,
  `importedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `reconciledBy` VARCHAR(191) NULL,
  `reconciledAt` DATETIME(3) NULL,
  UNIQUE INDEX `BankStatementImport_schoolId_accountingAccountId_checksum_key` (`schoolId`, `accountingAccountId`, `checksum`),
  INDEX `BankStatementImport_schoolId_periodStart_periodEnd_idx` (`schoolId`, `periodStart`, `periodEnd`),
  INDEX `BankStatementImport_accountingAccountId_status_idx` (`accountingAccountId`, `status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `BankStatementImport_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `BankStatementImport_accountingAccountId_fkey` FOREIGN KEY (`accountingAccountId`) REFERENCES `AccountingAccount` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `BankStatementLine` (
  `id` VARCHAR(191) NOT NULL,
  `importId` VARCHAR(191) NOT NULL,
  `transactionDate` DATETIME(3) NOT NULL,
  `description` VARCHAR(191) NOT NULL,
  `reference` VARCHAR(191) NULL,
  `direction` ENUM('DEBIT', 'CREDIT') NOT NULL,
  `amountMinor` INTEGER NOT NULL,
  `matchedJournalLineId` VARCHAR(191) NULL,
  `matchedBy` VARCHAR(191) NULL,
  `matchedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `BankStatementLine_matchedJournalLineId_key` (`matchedJournalLineId`),
  INDEX `BankStatementLine_importId_transactionDate_idx` (`importId`, `transactionDate`),
  PRIMARY KEY (`id`),
  CONSTRAINT `BankStatementLine_importId_fkey` FOREIGN KEY (`importId`) REFERENCES `BankStatementImport` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `BankStatementLine_matchedJournalLineId_fkey` FOREIGN KEY (`matchedJournalLineId`) REFERENCES `AccountingJournalLine` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;