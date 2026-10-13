ALTER TABLE `CompetitionTournamentParticipant`
  MODIFY COLUMN `status` ENUM('INVITED', 'PENDING', 'APPROVED', 'WITHDRAWN', 'DISQUALIFIED') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN `nominatedAt` DATETIME(3) NULL,
  ADD COLUMN `nominatedByUserId` VARCHAR(191) NULL,
  ADD COLUMN `guardianConsentStatus` ENUM('ACCEPTED', 'DECLINED') NULL,
  ADD COLUMN `guardianConsentAt` DATETIME(3) NULL,
  ADD COLUMN `guardianConsentGuardianId` VARCHAR(191) NULL,
  ADD INDEX `CompetitionTournamentParticipant_tournament_school_nom_idx` (`tournamentId`, `schoolId`, `nominatedAt`),
  ADD INDEX `CompetitionTournamentParticipant_guardianConsentStatus_idx` (`guardianConsentStatus`);

UPDATE `CompetitionTournamentParticipant`
SET `guardianConsentStatus` = 'ACCEPTED',
    `guardianConsentAt` = `registeredAt`
WHERE `nominatedAt` IS NULL;

CREATE TABLE `CompetitionExamPractice` (
  `id` VARCHAR(191) NOT NULL,
  `challengeId` VARCHAR(191) NOT NULL,
  `examCode` VARCHAR(40) NOT NULL,
  `countryCode` VARCHAR(2) NOT NULL,
  `gradeLabel` VARCHAR(80) NOT NULL,
  `subjectCategoryId` VARCHAR(191) NOT NULL,
  `format` ENUM('PRACTICE', 'MOCK_EXAM') NOT NULL DEFAULT 'PRACTICE',
  `syllabusVersion` VARCHAR(80) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT false,
  `reviewedByUserId` VARCHAR(191) NULL,
  `reviewedAt` DATETIME(3) NULL,
  `createdByUserId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `CompetitionExamPractice_challengeId_key` (`challengeId`),
  INDEX `CompetitionExamPractice_countryCode_gradeLabel_isActive_idx` (`countryCode`, `gradeLabel`, `isActive`),
  INDEX `CompetitionExamPractice_examCode_countryCode_isActive_idx` (`examCode`, `countryCode`, `isActive`),
  INDEX `CompetitionExamPractice_subjectCategoryId_idx` (`subjectCategoryId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CompetitionExamPractice`
  ADD CONSTRAINT `CompetitionExamPractice_challengeId_fkey`
    FOREIGN KEY (`challengeId`) REFERENCES `CompetitionChallenge` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `CompetitionExamPractice_subjectCategoryId_fkey`
    FOREIGN KEY (`subjectCategoryId`) REFERENCES `CompetitionCategory` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;