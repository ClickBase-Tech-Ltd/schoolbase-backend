-- TEMPLATE ONLY: review and replace every placeholder before execution.
-- Run in phpMyAdmin or mysql as a database administrator, after selecting the
-- intended local/test or production schema. Do not commit generated credentials.
--
-- Use the exact source host/IP of the SchoolBase backend for this MySQL user.
-- Do not use '%' unless your database administrator has explicitly approved it.
-- This grants column-level SELECT only for the current AI query allowlist.
-- It does not grant writes, schema changes, or access to other tables.
--
-- Replace:
--   REPLACE_WITH_BACKEND_DB_HOST
--   REPLACE_WITH_UNIQUE_RANDOM_PASSWORD
--   REPLACE_WITH_DATABASE_NAME
--
-- Use a newly generated password, not the application DATABASE_URL password.

CREATE USER 'schoolbase_ai_ro'@'REPLACE_WITH_BACKEND_DB_HOST'
  IDENTIFIED BY 'REPLACE_WITH_UNIQUE_RANDOM_PASSWORD';

GRANT SELECT (`id`, `name`, `country`, `currency`, `timezone`)
  ON `REPLACE_WITH_DATABASE_NAME`.`School`
  TO 'schoolbase_ai_ro'@'REPLACE_WITH_BACKEND_DB_HOST';

GRANT SELECT (`id`, `schoolId`, `firstName`, `lastName`, `admissionNo`, `classId`, `isActive`, `status`, `createdAt`)
  ON `REPLACE_WITH_DATABASE_NAME`.`Pupil`
  TO 'schoolbase_ai_ro'@'REPLACE_WITH_BACKEND_DB_HOST';

GRANT SELECT (`id`, `schoolId`, `name`, `phase`, `arm`, `createdAt`)
  ON `REPLACE_WITH_DATABASE_NAME`.`Class`
  TO 'schoolbase_ai_ro'@'REPLACE_WITH_BACKEND_DB_HOST';

GRANT SELECT (`id`, `schoolId`, `name`, `code`, `createdAt`)
  ON `REPLACE_WITH_DATABASE_NAME`.`Subject`
  TO 'schoolbase_ai_ro'@'REPLACE_WITH_BACKEND_DB_HOST';

GRANT SELECT (`id`, `schoolId`, `name`, `isCurrent`, `createdAt`)
  ON `REPLACE_WITH_DATABASE_NAME`.`AcademicYear`
  TO 'schoolbase_ai_ro'@'REPLACE_WITH_BACKEND_DB_HOST';

GRANT SELECT (`id`, `schoolId`, `firstName`, `lastName`, `jobTitle`, `department`, `classification`, `employmentType`, `employmentStatus`, `startDate`, `endDate`)
  ON `REPLACE_WITH_DATABASE_NAME`.`EmployeeProfile`
  TO 'schoolbase_ai_ro'@'REPLACE_WITH_BACKEND_DB_HOST';

SHOW GRANTS FOR 'schoolbase_ai_ro'@'REPLACE_WITH_BACKEND_DB_HOST';
