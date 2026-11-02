ALTER TABLE `School`
  ADD COLUMN `reportCardSectionDefaults` LONGTEXT NULL;

CREATE TABLE `TermReportCardConfig` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `termId` VARCHAR(191) NOT NULL,
  `configData` LONGTEXT NOT NULL,
  `publishedAt` DATETIME(3) NULL,
  `publishedBy` VARCHAR(191) NULL,
  `reopenedAt` DATETIME(3) NULL,
  `reopenedBy` VARCHAR(191) NULL,
  `updatedBy` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `TermReportCardConfig_termId_key` (`termId`),
  INDEX `TermReportCardConfig_schoolId_idx` (`schoolId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `TermReportCardConfig_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `TermReportCardConfig_termId_fkey` FOREIGN KEY (`termId`) REFERENCES `Term` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TermReportCardComment` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `classId` VARCHAR(191) NOT NULL,
  `pupilId` VARCHAR(191) NOT NULL,
  `termId` VARCHAR(191) NOT NULL,
  `teacherRemark` LONGTEXT NULL,
  `principalRemark` LONGTEXT NULL,
  `updatedBy` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `TermReportCardComment_pupilId_termId_key` (`pupilId`, `termId`),
  INDEX `TermReportCardComment_schoolId_termId_idx` (`schoolId`, `termId`),
  INDEX `TermReportCardComment_classId_termId_idx` (`classId`, `termId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `TermReportCardComment_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `TermReportCardComment_classId_fkey` FOREIGN KEY (`classId`) REFERENCES `Class` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `TermReportCardComment_pupilId_fkey` FOREIGN KEY (`pupilId`) REFERENCES `Pupil` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `TermReportCardComment_termId_fkey` FOREIGN KEY (`termId`) REFERENCES `Term` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
