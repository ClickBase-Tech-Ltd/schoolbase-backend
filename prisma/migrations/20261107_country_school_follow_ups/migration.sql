CREATE TABLE `CountrySchoolFollowUp` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `stage` ENUM('NEW', 'CONTACTED', 'ONBOARDING', 'BLOCKED', 'OPERATIONAL') NOT NULL DEFAULT 'NEW',
  `ownerUserId` VARCHAR(191) NULL,
  `nextContactAt` DATE NULL,
  `createdAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updatedAt` DATETIME(0) NOT NULL,
  UNIQUE INDEX `CountrySchoolFollowUp_schoolId_key` (`schoolId`),
  INDEX `CountrySchoolFollowUp_stage_nextContactAt_idx` (`stage`, `nextContactAt`),
  INDEX `CountrySchoolFollowUp_ownerUserId_idx` (`ownerUserId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `CountrySchoolFollowUp_schoolId_fkey`
    FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `CountrySchoolFollowUp_ownerUserId_fkey`
    FOREIGN KEY (`ownerUserId`) REFERENCES `User` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CountrySchoolFollowUpEvent` (
  `id` VARCHAR(191) NOT NULL,
  `followUpId` VARCHAR(191) NOT NULL,
  `actorUserId` VARCHAR(191) NOT NULL,
  `actorName` VARCHAR(191) NOT NULL,
  `changes` JSON NULL,
  `note` TEXT NULL,
  `createdAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  INDEX `CountrySchoolFollowUpEvent_followUpId_createdAt_idx` (`followUpId`, `createdAt`),
  INDEX `CountrySchoolFollowUpEvent_actorUserId_createdAt_idx` (`actorUserId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `CountrySchoolFollowUpEvent_followUpId_fkey`
    FOREIGN KEY (`followUpId`) REFERENCES `CountrySchoolFollowUp` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
