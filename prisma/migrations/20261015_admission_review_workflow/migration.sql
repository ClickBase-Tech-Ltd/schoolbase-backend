ALTER TABLE `AdmissionApplication`
  ADD COLUMN `assignedReviewerId` VARCHAR(191) NULL,
  ADD COLUMN `internalReviewNotes` LONGTEXT NULL,
  ADD COLUMN `followUpAt` DATETIME(0) NULL,
  ADD COLUMN `decisionReason` LONGTEXT NULL,
  ADD INDEX `AdmissionApplication_queue_idx` (`schoolId`, `assignedReviewerId`, `status`, `createdAt`),
  ADD CONSTRAINT `AdmissionApplication_assignedReviewerId_fkey` FOREIGN KEY (`assignedReviewerId`) REFERENCES `User` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `AdmissionApplicationEvent` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `admissionApplicationId` VARCHAR(255) NOT NULL,
  `actorUserId` VARCHAR(191) NULL,
  `actorName` VARCHAR(191) NOT NULL,
  `type` VARCHAR(64) NOT NULL,
  `fromStatus` VARCHAR(64) NULL,
  `toStatus` VARCHAR(64) NULL,
  `reason` LONGTEXT NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `AdmissionApplicationEvent_scope_created_idx` (`schoolId`, `admissionApplicationId`, `createdAt`),
  INDEX `AdmissionApplicationEvent_actor_created_idx` (`actorUserId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `AdmissionApplicationEvent_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `AdmissionApplicationEvent_applicationId_fkey` FOREIGN KEY (`admissionApplicationId`) REFERENCES `AdmissionApplication` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `AdmissionApplicationEvent_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `User` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;