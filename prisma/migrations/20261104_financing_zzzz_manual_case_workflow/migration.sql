ALTER TABLE `FinancingInstitution`
  ADD COLUMN `isDemo` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `FinancingApplicationEvent`
  ADD COLUMN `actorId` VARCHAR(191) NULL;

CREATE TABLE `FinancingApplicationPayment` (
  `id` VARCHAR(191) NOT NULL,
  `applicationId` VARCHAR(191) NOT NULL,
  `paymentId` VARCHAR(191) NOT NULL,
  `bankReference` VARCHAR(191) NOT NULL,
  `recordedBy` VARCHAR(191) NOT NULL,
  `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `FinancingApplicationPayment_paymentId_key` (`paymentId`),
  INDEX `FinancingApplicationPayment_applicationId_recordedAt_idx` (`applicationId`, `recordedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `FinancingApplicationPayment_applicationId_fkey`
    FOREIGN KEY (`applicationId`) REFERENCES `FinancingApplication` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FinancingApplicationPayment_paymentId_fkey`
    FOREIGN KEY (`paymentId`) REFERENCES `Payment` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
