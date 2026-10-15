CREATE TABLE `AdmissionExportAudit` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `actorUserId` VARCHAR(191) NOT NULL,
  `rowCount` INTEGER NOT NULL,
  `filters` JSON NULL,
  `redacted` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `AdmissionExportAudit_school_created_idx` (`schoolId`, `createdAt`),
  INDEX `AdmissionExportAudit_actor_created_idx` (`actorUserId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `AdmissionExportAudit_school_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `AdmissionExportAudit_actor_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `User` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;