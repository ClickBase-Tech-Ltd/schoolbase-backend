CREATE TABLE `StaffNumberCounter` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `year` INTEGER NOT NULL,
  `lastSeq` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `StaffNumberCounter_schoolId_year_key` (`schoolId`, `year`),
  CONSTRAINT `StaffNumberCounter_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `StaffEmploymentEvent`
  ADD COLUMN `previousStaffNumber` VARCHAR(191) NULL,
  ADD COLUMN `nextStaffNumber` VARCHAR(191) NULL;