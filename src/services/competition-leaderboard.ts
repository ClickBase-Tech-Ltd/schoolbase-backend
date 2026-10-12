export type CompetitionLeaderboardCandidate = {
  pupilId: string;
  firstName: string;
  lastName: string;
  score: number;
  accuracyPercent: number | null;
  elapsedMs: number | null;
  submittedAt: Date;
};

export type CompetitionLeaderboardEntry = {
  rank: number;
  displayName: string;
  score: number;
  accuracyPercent: number | null;
  elapsedMs: number | null;
};

export function chooseCompetitionMatchWinner(input: {
  senderPupilId: string;
  sender: { status: string; score: number; accuracyPercent: number | null; elapsedMs: number | null };
  recipientPupilId: string;
  recipient: { status: string; score: number; accuracyPercent: number | null; elapsedMs: number | null };
}): string | null {
  if (input.sender.status !== 'SUBMITTED' || input.recipient.status !== 'SUBMITTED') return null;
  if (input.sender.score !== input.recipient.score) return input.sender.score > input.recipient.score ? input.senderPupilId : input.recipientPupilId;
  const senderAccuracy = input.sender.accuracyPercent ?? 0;
  const recipientAccuracy = input.recipient.accuracyPercent ?? 0;
  if (senderAccuracy !== recipientAccuracy) return senderAccuracy > recipientAccuracy ? input.senderPupilId : input.recipientPupilId;
  const senderElapsed = input.sender.elapsedMs ?? Number.MAX_SAFE_INTEGER;
  const recipientElapsed = input.recipient.elapsedMs ?? Number.MAX_SAFE_INTEGER;
  if (senderElapsed !== recipientElapsed) return senderElapsed < recipientElapsed ? input.senderPupilId : input.recipientPupilId;
  return null;
}

function maskedName(candidate: CompetitionLeaderboardCandidate): string {
  const firstName = candidate.firstName.trim();
  const lastInitial = candidate.lastName.trim().charAt(0);
  return `${firstName || 'Student'}${lastInitial ? ` ${lastInitial}.` : ''}`;
}

export function buildCompetitionLeaderboard(candidates: CompetitionLeaderboardCandidate[]): CompetitionLeaderboardEntry[] {
  const bestByPupil = new Map<string, CompetitionLeaderboardCandidate>();
  for (const candidate of candidates) {
    const current = bestByPupil.get(candidate.pupilId);
    if (!current || compareCandidates(candidate, current) < 0) bestByPupil.set(candidate.pupilId, candidate);
  }

  return Array.from(bestByPupil.values())
    .sort(compareCandidates)
    .map((candidate, index) => ({
      rank: index + 1,
      displayName: maskedName(candidate),
      score: candidate.score,
      accuracyPercent: candidate.accuracyPercent,
      elapsedMs: candidate.elapsedMs,
    }));
}

function compareCandidates(left: CompetitionLeaderboardCandidate, right: CompetitionLeaderboardCandidate): number {
  return right.score - left.score ||
    (right.accuracyPercent ?? 0) - (left.accuracyPercent ?? 0) ||
    (left.elapsedMs ?? Number.MAX_SAFE_INTEGER) - (right.elapsedMs ?? Number.MAX_SAFE_INTEGER) ||
    left.submittedAt.getTime() - right.submittedAt.getTime() ||
    left.pupilId.localeCompare(right.pupilId);
}