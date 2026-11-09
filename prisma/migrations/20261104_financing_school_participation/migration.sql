ALTER TABLE `School`
  ADD COLUMN `tuitionFinancingParticipationEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `tuitionFinancingParticipationUpdatedAt` DATETIME(3) NULL,
  ADD COLUMN `tuitionFinancingParticipationUpdatedBy` VARCHAR(191) NULL;
