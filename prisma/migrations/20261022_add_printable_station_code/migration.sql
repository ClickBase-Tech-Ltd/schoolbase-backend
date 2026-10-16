ALTER TABLE `AttendanceStation`
  ADD COLUMN `publicCode` VARCHAR(191) NULL;

UPDATE `AttendanceStation`
SET `publicCode` = REPLACE(UUID(), '-', '')
WHERE `publicCode` IS NULL;

ALTER TABLE `AttendanceStation`
  MODIFY `publicCode` VARCHAR(191) NOT NULL,
  ADD UNIQUE INDEX `attendance_station_public_code_key` (`publicCode`);
