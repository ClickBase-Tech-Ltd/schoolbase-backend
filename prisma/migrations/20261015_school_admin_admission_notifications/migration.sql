CREATE TABLE `SchoolAdminNotification` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `recipientUserId` VARCHAR(191) NOT NULL,
  `admissionApplicationId` VARCHAR(255) NOT NULL,
  `type` VARCHAR(64) NOT NULL DEFAULT 'ADMISSION_APPLICATION',
  `title` VARCHAR(180) NOT NULL,
  `body` VARCHAR(500) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `readAt` DATETIME(3) NULL,
  UNIQUE INDEX `SchoolAdminNotification_recipient_application_type_key` (`recipientUserId`, `admissionApplicationId`, `type`),
  INDEX `SchoolAdminNotification_recipientUserId_readAt_createdAt_idx` (`recipientUserId`, `readAt`, `createdAt`),
  INDEX `SchoolAdminNotification_schoolId_createdAt_idx` (`schoolId`, `createdAt`),
  INDEX `SchoolAdminNotification_admissionApplicationId_idx` (`admissionApplicationId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `SchoolAdminNotification_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `SchoolAdminNotification_recipientUserId_fkey` FOREIGN KEY (`recipientUserId`) REFERENCES `User` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `SchoolAdminNotification_admissionApplicationId_fkey` FOREIGN KEY (`admissionApplicationId`) REFERENCES `AdmissionApplication` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;