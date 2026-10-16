CREATE TABLE `AttendanceStation` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `locationLabel` VARCHAR(191) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `tokenVersion` INTEGER NOT NULL DEFAULT 1,
  `lastCodeIssuedAt` DATETIME(3) NULL,
  `scanWindowStartedAt` DATETIME(3) NULL,
  `scanWindowCount` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `attendance_station_school_name_key` (`schoolId`, `name`),
  INDEX `attendance_station_school_active_idx` (`schoolId`, `isActive`),
  CONSTRAINT `AttendanceStation_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AttendanceStationEvent` (
  `id` VARCHAR(191) NOT NULL,
  `schoolId` VARCHAR(191) NOT NULL,
  `stationId` VARCHAR(191) NOT NULL,
  `actorUserId` VARCHAR(191) NULL,
  `eventType` VARCHAR(191) NOT NULL,
  `reason` TEXT NULL,
  `details` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `attendance_station_event_history_idx` (`schoolId`, `stationId`, `createdAt`),
  INDEX `attendance_station_event_actor_idx` (`actorUserId`, `createdAt`),
  CONSTRAINT `AttendanceStationEvent_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `AttendanceStationEvent_stationId_fkey` FOREIGN KEY (`stationId`) REFERENCES `AttendanceStation` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `AttendanceStationEvent_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `User` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `StaffAttendanceEvent`
  ADD COLUMN `stationId` VARCHAR(191) NULL,
  ADD INDEX `staff_att_event_station_date_idx` (`schoolId`, `stationId`, `createdAt`),
  ADD CONSTRAINT `StaffAttendanceEvent_stationId_fkey` FOREIGN KEY (`stationId`) REFERENCES `AttendanceStation` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
