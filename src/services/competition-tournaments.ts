export type CompetitionTournamentStatus = 'DRAFT' | 'UPCOMING' | 'REGISTRATION_OPEN' | 'REGISTRATION_CLOSED' | 'LIVE' | 'COMPLETED' | 'CANCELLED';

const allowedTransitions: Record<CompetitionTournamentStatus, CompetitionTournamentStatus[]> = {
  DRAFT: ['UPCOMING', 'CANCELLED'],
  UPCOMING: ['REGISTRATION_OPEN', 'CANCELLED'],
  REGISTRATION_OPEN: ['REGISTRATION_CLOSED', 'CANCELLED'],
  REGISTRATION_CLOSED: ['LIVE', 'CANCELLED'],
  LIVE: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransitionCompetitionTournament(from: CompetitionTournamentStatus, to: CompetitionTournamentStatus): boolean {
  return allowedTransitions[from]?.includes(to) ?? false;
}

export function parseCompetitionTournamentDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && !(value instanceof Date)) throw new Error('Invalid tournament date');
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid tournament date');
  return date;
}