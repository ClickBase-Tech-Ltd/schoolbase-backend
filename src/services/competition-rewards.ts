export type CompetitionXpPolicy = {
  completionXp: number;
};

export function parseCompetitionXpPolicy(value: string | null | undefined): CompetitionXpPolicy {
  if (!value) return { completionXp: 0 };

  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Competition XP policy');
  }

  const completionXp = (parsed as Record<string, unknown>).completionXp;
  if (!Number.isInteger(completionXp) || Number(completionXp) < 0 || Number(completionXp) > 100_000) {
    throw new Error('Invalid Competition completion XP');
  }

  return { completionXp: Number(completionXp) };
}