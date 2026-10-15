SET @request_key_column_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'AdmissionApplication'
    AND COLUMN_NAME = 'requestKey'
);
SET @add_request_key_column_sql = IF(
  @request_key_column_exists > 0,
  'SELECT 1',
  'ALTER TABLE `AdmissionApplication` ADD COLUMN `requestKey` VARCHAR(255) NULL'
);
PREPARE add_request_key_column_stmt FROM @add_request_key_column_sql;
EXECUTE add_request_key_column_stmt;
DEALLOCATE PREPARE add_request_key_column_stmt;

UPDATE `AdmissionApplication`
SET `requestKey` = `applicationNumber`,
    `applicationNumber` = CONCAT('ADM-', YEAR(`createdAt`), '-', UPPER(SUBSTRING(REPLACE(UUID(), '-', ''), 1, 8)))
WHERE `requestKey` IS NULL
  AND `applicationNumber` IS NOT NULL;

SET @app_ref_index_exists = (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'AdmissionApplication'
    AND INDEX_NAME = 'AdmissionApplication_school_app_ref_key'
);
SET @create_app_ref_index_sql = IF(
  @app_ref_index_exists > 0,
  'SELECT 1',
  'CREATE UNIQUE INDEX `AdmissionApplication_school_app_ref_key` ON `AdmissionApplication` (`schoolId`, `applicationNumber`)'
);
PREPARE create_app_ref_index_stmt FROM @create_app_ref_index_sql;
EXECUTE create_app_ref_index_stmt;
DEALLOCATE PREPARE create_app_ref_index_stmt;

SET @request_key_index_exists = (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'AdmissionApplication'
    AND INDEX_NAME = 'AdmissionApplication_school_request_key'
);
SET @create_request_key_index_sql = IF(
  @request_key_index_exists > 0,
  'SELECT 1',
  'CREATE UNIQUE INDEX `AdmissionApplication_school_request_key` ON `AdmissionApplication` (`schoolId`, `requestKey`)'
);
PREPARE create_request_key_index_stmt FROM @create_request_key_index_sql;
EXECUTE create_request_key_index_stmt;
DEALLOCATE PREPARE create_request_key_index_stmt;