CREATE TABLE `FinancingInstitution` (
  `id` VARCHAR(191) NOT NULL,
  `code` VARCHAR(64) NOT NULL,
  `displayName` VARCHAR(191) NOT NULL,
  `integrationMode` ENUM('HOSTED', 'API', 'MANUAL') NOT NULL,
  `status` ENUM('ACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'SUSPENDED',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `FinancingInstitution_code_key` (`code`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `FinancingProviderEvent` (
  `id` VARCHAR(191) NOT NULL,
  `institutionId` VARCHAR(191) NOT NULL,
  `externalEventId` VARCHAR(191) NOT NULL,
  `eventType` VARCHAR(40) NOT NULL,
  `applicationReference` VARCHAR(191) NOT NULL,
  `occurredAt` DATETIME(3) NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `normalizedPayload` JSON NOT NULL,
  `status` ENUM('RECEIVED', 'PROCESSING', 'PROCESSED', 'REVIEW_REQUIRED', 'FAILED') NOT NULL DEFAULT 'RECEIVED',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `lastErrorCode` VARCHAR(80) NULL,
  `lockExpiresAt` DATETIME(3) NULL,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `processedAt` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `FinancingProviderEvent_institutionId_externalEventId_key` (`institutionId`, `externalEventId`),
  INDEX `FinancingProviderEvent_status_lockExpiresAt_receivedAt_idx` (`status`, `lockExpiresAt`, `receivedAt`),
  INDEX `fin_provider_event_institution_ref_received_idx` (`institutionId`, `applicationReference`, `receivedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `FinancingProviderEvent_institutionId_fkey`
    FOREIGN KEY (`institutionId`) REFERENCES `FinancingInstitution` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `FinancingApplication` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `pupilId` VARCHAR(191) NOT NULL,
  `guardianId` VARCHAR(191) NOT NULL,
  `invoiceId` VARCHAR(191) NOT NULL,
  `institutionId` VARCHAR(191) NOT NULL,
  `externalApplicationReference` VARCHAR(191) NULL,
  `status` ENUM('DRAFT', 'CONSENTED', 'SUBMITTED', 'UNDER_REVIEW', 'MORE_INFO_REQUIRED', 'OFFERED', 'OFFER_ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'DRAFT',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `fin_application_institution_external_ref_key` (`institutionId`, `externalApplicationReference`),
  INDEX `FinancingApplication_schoolId_status_createdAt_idx` (`schoolId`, `status`, `createdAt`),
  INDEX `FinancingApplication_guardianId_createdAt_idx` (`guardianId`, `createdAt`),
  INDEX `FinancingApplication_invoiceId_status_idx` (`invoiceId`, `status`),
  INDEX `FinancingApplication_institutionId_status_createdAt_idx` (`institutionId`, `status`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `FinancingApplication_schoolId_fkey`
    FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FinancingApplication_pupilId_fkey`
    FOREIGN KEY (`pupilId`) REFERENCES `Pupil` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FinancingApplication_guardianId_fkey`
    FOREIGN KEY (`guardianId`) REFERENCES `Guardian` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FinancingApplication_invoiceId_fkey`
    FOREIGN KEY (`invoiceId`) REFERENCES `Invoice` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FinancingApplication_institutionId_fkey`
    FOREIGN KEY (`institutionId`) REFERENCES `FinancingInstitution` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `FinancingApplicationEvent` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `applicationId` VARCHAR(191) NOT NULL,
  `providerEventId` VARCHAR(191) NULL,
  `actorType` ENUM('PARENT', 'SCHOOL', 'PLATFORM', 'LENDER', 'SYSTEM') NOT NULL,
  `eventType` VARCHAR(40) NOT NULL,
  `fromStatus` ENUM('DRAFT', 'CONSENTED', 'SUBMITTED', 'UNDER_REVIEW', 'MORE_INFO_REQUIRED', 'OFFERED', 'OFFER_ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED') NULL,
  `toStatus` ENUM('DRAFT', 'CONSENTED', 'SUBMITTED', 'UNDER_REVIEW', 'MORE_INFO_REQUIRED', 'OFFERED', 'OFFER_ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED') NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `FinancingApplicationEvent_providerEventId_key` (`providerEventId`),
  INDEX `FinancingApplicationEvent_schoolId_applicationId_createdAt_idx` (`schoolId`, `applicationId`, `createdAt`),
  INDEX `FinancingApplicationEvent_applicationId_createdAt_idx` (`applicationId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `FinancingApplicationEvent_schoolId_fkey`
    FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FinancingApplicationEvent_applicationId_fkey`
    FOREIGN KEY (`applicationId`) REFERENCES `FinancingApplication` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FinancingApplicationEvent_providerEventId_fkey`
    FOREIGN KEY (`providerEventId`) REFERENCES `FinancingProviderEvent` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
