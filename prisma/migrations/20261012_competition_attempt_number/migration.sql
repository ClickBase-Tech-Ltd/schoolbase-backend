ALTER TABLE `CompetitionChallengeAttempt`
  ADD COLUMN `attemptNumber` INT NULL;

UPDATE `CompetitionChallengeAttempt` AS attempt
JOIN (
  SELECT
    `id`,
    ROW_NUMBER() OVER (
      PARTITION BY `pupilId`, `challengeId`
      ORDER BY `createdAt`, `id`
    ) AS `attemptNumber`
  FROM `CompetitionChallengeAttempt`
) AS ranked ON ranked.`id` = attempt.`id`
SET attempt.`attemptNumber` = ranked.`attemptNumber`;

ALTER TABLE `CompetitionChallengeAttempt`
  MODIFY COLUMN `attemptNumber` INT NOT NULL,
  ADD UNIQUE INDEX `CompetitionChallengeAttempt_pupil_challenge_attemptNumber_key` (`pupilId`, `challengeId`, `attemptNumber`);