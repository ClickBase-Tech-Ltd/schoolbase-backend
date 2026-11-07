ALTER TABLE `SupportRequest`
  ADD COLUMN `assignedCountryRepId` VARCHAR(191) NULL,
  ADD INDEX `SupportRequest_assignedCountryRepId_status_idx` (`assignedCountryRepId`, `status`),
  ADD CONSTRAINT `SupportRequest_assignedCountryRepId_fkey`
    FOREIGN KEY (`assignedCountryRepId`) REFERENCES `User` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CountrySchoolFollowUpEvent`
  MODIFY COLUMN `actorUserId` VARCHAR(191) NULL;
