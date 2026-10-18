ALTER TABLE `School`
  ADD COLUMN `archivedAt` DATETIME(3) NULL,
  ADD COLUMN `archivedBy` VARCHAR(191) NULL,
  ADD COLUMN `archiveReason` VARCHAR(500) NULL,
  ADD COLUMN `archivedPreviousStatus` ENUM('PENDING', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED') NULL;

CREATE INDEX `School_archivedAt_idx` ON `School`(`archivedAt`);