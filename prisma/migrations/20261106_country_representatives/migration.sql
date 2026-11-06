ALTER TABLE `User`
  MODIFY `role` ENUM('PLATFORM_ADMIN', 'COUNTRY_REP', 'PARTNER_ADMIN', 'SCHOOL_ADMIN', 'BURSAR', 'TEACHER', 'PARENT', 'STUDENT', 'STAFF') NOT NULL,
  ADD COLUMN `countryCode` VARCHAR(2) NULL,
  ADD INDEX `User_countryCode_role_isActive_idx` (`countryCode`, `role`, `isActive`);
