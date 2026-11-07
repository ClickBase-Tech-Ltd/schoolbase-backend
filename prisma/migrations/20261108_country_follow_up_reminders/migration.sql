ALTER TABLE `User`
  ADD COLUMN `countryFollowUpRemindersEnabled` BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE `CountryFollowUpDigest` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `digestDate` DATE NOT NULL,
  `status` ENUM('PROCESSING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PROCESSING',
  `claimedAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `sentAt` DATETIME(0) NULL,
  `error` TEXT NULL,
  UNIQUE INDEX `CountryFollowUpDigest_userId_digestDate_key` (`userId`, `digestDate`),
  INDEX `CountryFollowUpDigest_status_claimedAt_idx` (`status`, `claimedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `CountryFollowUpDigest_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
