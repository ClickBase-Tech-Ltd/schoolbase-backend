export type CompetitionAchievementCriteria =
  | { type: 'FIRST_COMPLETION' }
  | { type: 'PERFECT_SCORE' }
  | { type: 'COMPLETION_COUNT'; threshold: number };

export function parseCompetitionAchievementCriteria(value: string): CompetitionAchievementCriteria {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Competition achievement criteria');
  }

  const criteria = parsed as Record<string, unknown>;
  if (criteria.type === 'FIRST_COMPLETION' || criteria.type === 'PERFECT_SCORE') {
    return { type: criteria.type };
  }
  if (criteria.type === 'COMPLETION_COUNT' && Number.isInteger(criteria.threshold) && Number(criteria.threshold) >= 1 && Number(criteria.threshold) <= 100_000) {
    return { type: 'COMPLETION_COUNT', threshold: Number(criteria.threshold) };
  }
  throw new Error('Invalid Competition achievement criteria');
}

export function shouldAwardCompetitionAchievement(input: {
  criteria: CompetitionAchievementCriteria;
  priorCompletedChallenges: number;
  correctCount: number;
  questionCount: number;
}): boolean {
  switch (input.criteria.type) {
    case 'FIRST_COMPLETION':
      return input.priorCompletedChallenges === 0;
    case 'PERFECT_SCORE':
      return input.questionCount > 0 && input.correctCount === input.questionCount;
    case 'COMPLETION_COUNT':
      return input.priorCompletedChallenges + 1 >= input.criteria.threshold;
  }
}