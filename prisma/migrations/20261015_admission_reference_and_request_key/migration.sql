ALTER TABLE `AdmissionApplication`
  ADD COLUMN `requestKey` VARCHAR(255) NULL;

UPDATE `AdmissionApplication`
SET `requestKey` = `applicationNumber`,
    `applicationNumber` = CONCAT('ADM-', YEAR(`createdAt`), '-', UPPER(SUBSTRING(REPLACE(UUID(), '-', ''), 1, 8)))
WHERE `applicationNumber` IS NOT NULL;

DROP INDEX `AdmissionApplication_school_request_key` ON `AdmissionApplication`;

CREATE UNIQUE INDEX `AdmissionApplication_school_app_ref_key`
ON `AdmissionApplication` (`schoolId`, `applicationNumber`);

CREATE UNIQUE INDEX `AdmissionApplication_school_request_key`
ON `AdmissionApplication` (`schoolId`, `requestKey`);