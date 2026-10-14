ALTER TABLE `PlatformAuditLog`
  ADD COLUMN `category` VARCHAR(64) NULL,
  ADD COLUMN `action` VARCHAR(120) NULL,
  ADD COLUMN `outcome` VARCHAR(24) NULL,
  ADD COLUMN `resourceType` VARCHAR(80) NULL,
  ADD COLUMN `resourceId` VARCHAR(191) NULL,
  ADD COLUMN `summary` VARCHAR(500) NULL,
  ADD COLUMN `actorRole` VARCHAR(40) NULL,
  ADD COLUMN `requestId` VARCHAR(191) NULL,
  ADD INDEX `PlatformAuditLog_createdAt_category_idx` (`createdAt`, `category`),
  ADD INDEX `PlatformAuditLog_createdAt_action_idx` (`createdAt`, `action`),
  ADD INDEX `PlatformAuditLog_schoolId_createdAt_idx` (`schoolId`, `createdAt`);

UPDATE `PlatformAuditLog`
SET
  `category` = CASE
    WHEN UPPER(`event`) LIKE '%LOGIN%' OR UPPER(`event`) LIKE '%IMPERSONATE%' THEN 'ACCESS'
    WHEN UPPER(`event`) LIKE '%COMPETITION%' OR UPPER(`event`) LIKE '%TOURNAMENT%' THEN 'COMPETITION'
    WHEN UPPER(`event`) LIKE '%STUDENT%' OR UPPER(`event`) LIKE '%PUPIL%' THEN 'STUDENT'
    WHEN UPPER(`event`) LIKE '%ATTENDANCE%' OR UPPER(`event`) LIKE '%RESULT%' OR UPPER(`event`) LIKE '%ASSESSMENT%' OR UPPER(`event`) LIKE '%SUBJECT%' OR UPPER(`event`) LIKE '%CLASS%' OR UPPER(`event`) LIKE '%TEACHER%' THEN 'ACADEMICS'
    WHEN UPPER(`event`) LIKE '%PAYMENT%' OR UPPER(`event`) LIKE '%INVOICE%' OR UPPER(`event`) LIKE '%FEE%' OR UPPER(`event`) LIKE '%CASHBOOK%' THEN 'FINANCE'
    WHEN UPPER(`event`) LIKE '%WHATSAPP%' OR UPPER(`event`) LIKE '%EMAIL%' OR UPPER(`event`) LIKE '%MESSAGE%' OR UPPER(`event`) LIKE '%ANNOUNCEMENT%' THEN 'COMMUNICATIONS'
    WHEN UPPER(`event`) LIKE '%ADVERTIS%' OR UPPER(`event`) LIKE '%CAMPAIGN%' OR UPPER(`event`) LIKE '%ADS%' THEN 'MARKETING'
    WHEN UPPER(`event`) LIKE '%SETTING%' OR UPPER(`event`) LIKE '%PLAN%' OR UPPER(`event`) LIKE '%SUBSCRIPTION%' OR UPPER(`event`) LIKE '%TRIAL%' THEN 'CONFIGURATION'
    WHEN UPPER(`event`) LIKE '%SCHOOL%' OR UPPER(`event`) LIKE '%SIGNUP%' OR UPPER(`event`) LIKE '%VERIFY%' OR UPPER(`event`) LIKE '%ACTIVATE%' OR UPPER(`event`) LIKE '%SUSPEND%' THEN 'SCHOOL'
    ELSE 'OPERATIONS'
  END,
  `action` = CASE
    WHEN UPPER(`event`) IN ('LOGIN_SUCCESS', 'PARENT_LOGIN_SUCCESS') THEN 'session.login_succeeded'
    WHEN UPPER(`event`) IN ('LOGIN_FAILED', 'PARENT_LOGIN_FAILED') THEN 'session.login_failed'
    WHEN UPPER(`event`) = 'SCHOOL_SIGNUP_COMPLETED' THEN 'school.signup.completed'
    WHEN UPPER(`event`) = 'STUDENT_REGISTERED' THEN 'student.registered'
    WHEN UPPER(`event`) = 'STUDENTS_IMPORTED' THEN 'student.imported'
    WHEN UPPER(`event`) = 'PAYMENT_RECORDED' THEN 'payment.recorded'
    WHEN UPPER(`event`) = 'RESULTS_PUBLISHED' THEN 'results.published'
    WHEN UPPER(`event`) = 'ATTENDANCE_RECORDED' THEN 'attendance.recorded'
    WHEN `event` LIKE '%signups_approve%' THEN 'school.signup.approved'
    WHEN `event` LIKE '%signups_remind%' THEN 'school.signup.reminder_sent'
    WHEN `event` LIKE '%students_import%' THEN 'student.imported'
    WHEN `event` LIKE '%whatsapp_send-message%' THEN 'message.sent'
    ELSE NULL
  END,
  `summary` = CASE
    WHEN UPPER(`event`) IN ('LOGIN_SUCCESS', 'PARENT_LOGIN_SUCCESS') THEN 'Signed in successfully'
    WHEN UPPER(`event`) IN ('LOGIN_FAILED', 'PARENT_LOGIN_FAILED') THEN 'Failed sign-in attempt'
    WHEN UPPER(`event`) = 'SCHOOL_SIGNUP_COMPLETED' THEN 'Completed a school signup'
    WHEN UPPER(`event`) = 'STUDENT_REGISTERED' THEN 'Registered a student'
    WHEN UPPER(`event`) = 'STUDENTS_IMPORTED' OR `event` LIKE '%students_import%' THEN 'Imported student records'
    WHEN UPPER(`event`) = 'PAYMENT_RECORDED' THEN 'Recorded a payment'
    WHEN UPPER(`event`) = 'RESULTS_PUBLISHED' THEN 'Published school results'
    WHEN UPPER(`event`) = 'ATTENDANCE_RECORDED' THEN 'Recorded attendance'
    WHEN `event` LIKE '%signups_approve%' THEN 'Approved a school signup'
    WHEN `event` LIKE '%signups_remind%' THEN 'Sent a school signup reminder'
    WHEN `event` LIKE '%whatsapp_send-message%' THEN 'Sent a WhatsApp message'
    ELSE NULL
  END,
  `resourceType` = CASE
    WHEN UPPER(`event`) LIKE '%LOGIN%' THEN 'Session'
    WHEN UPPER(`event`) LIKE '%SCHOOL%' OR UPPER(`event`) LIKE '%SIGNUP%' THEN 'School'
    WHEN UPPER(`event`) LIKE '%STUDENT%' OR UPPER(`event`) LIKE '%PUPIL%' THEN 'Student'
    WHEN UPPER(`event`) LIKE '%PAYMENT%' THEN 'Payment'
    WHEN UPPER(`event`) LIKE '%RESULT%' THEN 'Results'
    WHEN UPPER(`event`) LIKE '%ATTENDANCE%' THEN 'Attendance'
    ELSE NULL
  END,
  `outcome` = CASE
    WHEN `details` LIKE '%status: 2%' THEN 'SUCCESS'
    WHEN `details` LIKE '%status: 3%' THEN 'REDIRECTED'
    WHEN `details` LIKE '%status: 4%' THEN 'REJECTED'
    WHEN `details` LIKE '%status: 5%' THEN 'FAILED'
    ELSE 'UNKNOWN'
  END,
  `actorRole` = CASE
    WHEN `details` LIKE '%role: %' THEN SUBSTRING_INDEX(SUBSTRING_INDEX(`details`, 'role: ', -1), ' |', 1)
    ELSE NULL
  END;