ALTER TABLE `CompetitionStudentChallenge`
  ADD COLUMN `senderAttemptId` VARCHAR(191) NULL,
  ADD COLUMN `recipientAttemptId` VARCHAR(191) NULL,
  ADD COLUMN `winnerPupilId` VARCHAR(191) NULL,
  ADD UNIQUE INDEX `CompetitionStudentChallenge_senderAttemptId_key`(`senderAttemptId`),
  ADD UNIQUE INDEX `CompetitionStudentChallenge_recipientAttemptId_key`(`recipientAttemptId`),
  ADD INDEX `CompetitionStudentChallenge_winnerPupilId_idx`(`winnerPupilId`),
  ADD CONSTRAINT `CompetitionStudentChallenge_senderAttemptId_fkey`
    FOREIGN KEY (`senderAttemptId`) REFERENCES `CompetitionChallengeAttempt`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `CompetitionStudentChallenge_recipientAttemptId_fkey`
    FOREIGN KEY (`recipientAttemptId`) REFERENCES `CompetitionChallengeAttempt`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `CompetitionStudentChallenge_winnerPupilId_fkey`
    FOREIGN KEY (`winnerPupilId`) REFERENCES `Pupil`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
