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