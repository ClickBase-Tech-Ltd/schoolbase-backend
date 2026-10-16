CREATE TABLE `CashbookExportAudit` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `actorId` VARCHAR(191) NOT NULL,
  `filters` LONGTEXT NOT NULL,
  `rowCount` INTEGER NOT NULL,
  `exportedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `CashbookExportAudit_schoolId_exportedAt_idx` (`schoolId`, `exportedAt`),
  INDEX `CashbookExportAudit_actorId_exportedAt_idx` (`actorId`, `exportedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `CashbookExportAudit_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `CashbookExportAudit_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;