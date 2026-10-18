CREATE TABLE `SignupRateLimit` (
    `bucketKey` VARCHAR(64) NOT NULL,
    `windowStartedAt` DATETIME(3) NOT NULL,
    `requestCount` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`bucketKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;