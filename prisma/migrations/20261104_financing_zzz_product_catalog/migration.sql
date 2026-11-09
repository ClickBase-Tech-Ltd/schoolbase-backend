CREATE TABLE `FinancingProduct` (
  `id` VARCHAR(191) NOT NULL,
  `institutionId` VARCHAR(191) NOT NULL,
  `code` VARCHAR(64) NOT NULL,
  `displayName` VARCHAR(191) NOT NULL,
  `summary` VARCHAR(500) NOT NULL,
  `eligibilitySummary` TEXT NOT NULL,
  `termsSummary` TEXT NOT NULL,
  `termsUrl` VARCHAR(2048) NULL,
  `termsVersion` VARCHAR(80) NOT NULL,
  `currency` VARCHAR(3) NOT NULL,
  `applicationMode` ENUM('HOSTED', 'SCHOOL_CONTACT', 'API') NOT NULL,
  `applicationUrl` VARCHAR(2048) NULL,
  `approvalEvidenceReference` VARCHAR(191) NULL,
  `createdBy` VARCHAR(191) NOT NULL,
  `effectiveAt` DATETIME(3) NOT NULL,
  `expiresAt` DATETIME(3) NULL,
  `status` ENUM('DRAFT', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
  `approvedAt` DATETIME(3) NULL,
  `approvedBy` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `fin_product_institution_code_key` (`institutionId`, `code`),
  INDEX `FinancingProduct_status_effectiveAt_expiresAt_idx` (`status`, `effectiveAt`, `expiresAt`),
  INDEX `FinancingProduct_institutionId_status_idx` (`institutionId`, `status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `FinancingProduct_institutionId_fkey`
    FOREIGN KEY (`institutionId`) REFERENCES `FinancingInstitution` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SchoolFinancingProduct` (
  `schoolId` VARCHAR(191) NOT NULL,
  `productId` VARCHAR(191) NOT NULL,
  `enabledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `enabledBy` VARCHAR(191) NOT NULL,
  INDEX `SchoolFinancingProduct_productId_enabledAt_idx` (`productId`, `enabledAt`),
  PRIMARY KEY (`schoolId`, `productId`),
  CONSTRAINT `SchoolFinancingProduct_schoolId_fkey`
    FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `SchoolFinancingProduct_productId_fkey`
    FOREIGN KEY (`productId`) REFERENCES `FinancingProduct` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `FinancingApplication`
  ADD COLUMN `productId` VARCHAR(191) NULL,
  ADD INDEX `FinancingApplication_productId_status_createdAt_idx` (`productId`, `status`, `createdAt`),
  ADD CONSTRAINT `FinancingApplication_productId_fkey`
    FOREIGN KEY (`productId`) REFERENCES `FinancingProduct` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
