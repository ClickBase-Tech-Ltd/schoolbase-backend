export type CompetitionDailyLimitAttempt = {
  startedAt: Date | string | null;
  challenge?: {
    examPractice?: { id: string } | null;
  } | null;
};

export type CompetitionDailyLimitKind = 'DAILY' | 'EXAM';

export function getCompetitionDailyLimitError(
  attempts: CompetitionDailyLimitAttempt[],
  now: Date,
  kind: CompetitionDailyLimitKind,
): 'DAILY_CHALLENGE_LIMIT_REACHED' | 'EXAM_PRACTICE_LIMIT_REACHED' | null {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const startOfNextDay = new Date(startOfDay);
  startOfNextDay.setDate(startOfNextDay.getDate() + 1);

  const todayAttempts = attempts.filter((attempt) => {
    if (!attempt.startedAt) return false;
    const startedAt = new Date(attempt.startedAt);
    return startedAt >= startOfDay && startedAt < startOfNextDay;
  });

  const hasDailyAttemptToday = todayAttempts.some((attempt) => !attempt.challenge?.examPractice);
  const hasExamAttemptToday = todayAttempts.some((attempt) => Boolean(attempt.challenge?.examPractice));

  if (kind === 'DAILY' && hasDailyAttemptToday) return 'DAILY_CHALLENGE_LIMIT_REACHED';
  if (kind === 'EXAM' && hasExamAttemptToday) return 'EXAM_PRACTICE_LIMIT_REACHED';
  return null;
}
