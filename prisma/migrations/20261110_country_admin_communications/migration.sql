CREATE TABLE `CountryAdminConversation` (
  `id` VARCHAR(191) NOT NULL,
  `representativeUserId` VARCHAR(191) NOT NULL,
  `platformAdminOwnerId` VARCHAR(191) NULL,
  `createdByUserId` VARCHAR(191) NOT NULL,
  `subject` VARCHAR(160) NOT NULL,
  `status` ENUM('OPEN', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
  `dueAt` DATE NULL,
  `lastMessageAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `createdAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updatedAt` DATETIME(0) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `CAConv_rep_status_last_idx` (`representativeUserId`, `status`, `lastMessageAt`),
  INDEX `CAConv_owner_status_last_idx` (`platformAdminOwnerId`, `status`, `lastMessageAt`),
  INDEX `CAConv_status_due_idx` (`status`, `dueAt`),
  CONSTRAINT `CAConv_rep_fkey`
    FOREIGN KEY (`representativeUserId`) REFERENCES `User` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `CAConv_owner_fkey`
    FOREIGN KEY (`platformAdminOwnerId`) REFERENCES `User` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `CAConv_creator_fkey`
    FOREIGN KEY (`createdByUserId`) REFERENCES `User` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CountryAdminMessage` (
  `id` VARCHAR(191) NOT NULL,
  `conversationId` VARCHAR(191) NOT NULL,
  `senderUserId` VARCHAR(191) NOT NULL,
  `body` LONGTEXT NOT NULL,
  `createdAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`id`),
  INDEX `CAMsg_conversation_created_idx` (`conversationId`, `createdAt`),
  INDEX `CAMsg_sender_created_idx` (`senderUserId`, `createdAt`),
  CONSTRAINT `CAMsg_conv_fkey`
    FOREIGN KEY (`conversationId`) REFERENCES `CountryAdminConversation` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `CAMsg_sender_fkey`
    FOREIGN KEY (`senderUserId`) REFERENCES `User` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CountryAdminConversationRead` (
  `id` VARCHAR(191) NOT NULL,
  `conversationId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `lastReadAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `lastReadMessageId` VARCHAR(191) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `CARead_conversation_user_key` (`conversationId`, `userId`),
  INDEX `CARead_user_read_idx` (`userId`, `lastReadAt`),
  CONSTRAINT `CARead_conv_fkey`
    FOREIGN KEY (`conversationId`) REFERENCES `CountryAdminConversation` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `CARead_user_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CountryAdminAnnouncement` (
  `id` VARCHAR(191) NOT NULL,
  `createdByUserId` VARCHAR(191) NOT NULL,
  `countryCode` VARCHAR(2) NULL,
  `title` VARCHAR(160) NOT NULL,
  `body` LONGTEXT NOT NULL,
  `isImportant` BOOLEAN NOT NULL DEFAULT false,
  `publishedAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `createdAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updatedAt` DATETIME(0) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `CAAnn_country_pub_idx` (`countryCode`, `publishedAt`),
  INDEX `CAAnn_published_idx` (`publishedAt`),
  CONSTRAINT `CAAnn_creator_fkey`
    FOREIGN KEY (`createdByUserId`) REFERENCES `User` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CountryAdminAnnouncementAcknowledgement` (
  `id` VARCHAR(191) NOT NULL,
  `announcementId` VARCHAR(191) NOT NULL,
  `representativeUserId` VARCHAR(191) NOT NULL,
  `acknowledgedAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `CAAck_announcement_rep_key` (`announcementId`, `representativeUserId`),
  INDEX `CAAck_rep_ack_idx` (`representativeUserId`, `acknowledgedAt`),
  CONSTRAINT `CAAck_announcement_fkey`
    FOREIGN KEY (`announcementId`) REFERENCES `CountryAdminAnnouncement` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `CAAck_rep_fkey`
    FOREIGN KEY (`representativeUserId`) REFERENCES `User` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
