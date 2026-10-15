CREATE TABLE `AdmissionDeliveryAttempt` (
  `id` VARCHAR(191) NOT NULL,
  `admissionApplicationId` VARCHAR(255) NOT NULL,
  `audience` VARCHAR(32) NOT NULL,
  `channel` VARCHAR(32) NOT NULL,
  `attemptNumber` INTEGER NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `provider` VARCHAR(128) NULL,
  `providerMessageId` VARCHAR(255) NULL,
  `error` TEXT NULL,
  `attemptedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `AdmissionDeliveryAttempt_once_idx` (`admissionApplicationId`, `audience`, `channel`, `attemptNumber`),
  INDEX `AdmissionDeliveryAttempt_application_attemptedAt_idx` (`admissionApplicationId`, `attemptedAt`),
  INDEX `AdmissionDeliveryAttempt_status_attemptedAt_idx` (`status`, `attemptedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `AdmissionDeliveryAttempt_admissionApplicationId_fkey` FOREIGN KEY (`admissionApplicationId`) REFERENCES `AdmissionApplication` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;