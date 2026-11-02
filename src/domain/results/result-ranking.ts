import { isStudentCurrentlyEnrolled } from '../../services/student-lifecycle.js';

interface RankablePupil {
  id: string;
  firstName: string;
  lastName: string;
  isActive?: boolean | null;
  status?: string | null;
}

interface RankableResult {
  id: string;
  pupilId: string;
  totalScore: number | null;
  scores: string | null;
  pupil: RankablePupil;
}

export interface ResultPosition {
  resultId: string;
  position: number;
}

function getComponentScore(scores: string | null, componentId: string): number {
  if (!scores) return 0;
  try {
    const parsed: unknown = JSON.parse(scores);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
    const score = (parsed as Record<string, unknown>)[componentId];
    return typeof score === 'number' && Number.isFinite(score) ? score : 0;
  } catch {
    return 0;
  }
}

export function calculateSubjectPositions(
  results: RankableResult[],
  caComponentId: string,
): ResultPosition[] {
  const rankable = results
    .filter((result) => isStudentCurrentlyEnrolled(result.pupil))
    .filter((result): result is RankableResult & { totalScore: number } =>
      typeof result.totalScore === 'number' && Number.isFinite(result.totalScore),
    )
    .map((result) => ({
      result,
      caScore: getComponentScore(result.scores, caComponentId),
      pupilName: `${result.pupil.firstName} ${result.pupil.lastName}`,
    }))
    .sort((a, b) => {
      if (b.result.totalScore !== a.result.totalScore) {
        return b.result.totalScore - a.result.totalScore;
      }
      if (b.caScore !== a.caScore) return b.caScore - a.caScore;
      return a.pupilName.localeCompare(b.pupilName);
    });

  let position = 1;
  let lastScore = rankable[0]?.result.totalScore;
  let lastCaScore = rankable[0]?.caScore;

  return rankable.map(({ result, caScore }, index) => {
    if (result.totalScore !== lastScore || caScore !== lastCaScore) {
      position = index + 1;
      lastScore = result.totalScore;
      lastCaScore = caScore;
    }
    return { resultId: result.id, position };
  });
}

export function calculateClassPositions(results: RankableResult[]): ResultPosition[] {
  const activeResults = results
    .filter((result) => isStudentCurrentlyEnrolled(result.pupil))
    .filter((result): result is RankableResult & { totalScore: number } =>
      typeof result.totalScore === 'number' && Number.isFinite(result.totalScore),
    );
  const grouped = new Map<string, typeof activeResults>();

  for (const result of activeResults) {
    const pupilResults = grouped.get(result.pupilId) ?? [];
    pupilResults.push(result);
    grouped.set(result.pupilId, pupilResults);
  }

  const pupils = [...grouped.entries()]
    .map(([pupilId, pupilResults]) => ({
      pupilId,
      results: pupilResults,
      averageScore: pupilResults.reduce((sum, result) => sum + result.totalScore, 0) / pupilResults.length,
      pupilName: `${pupilResults[0].pupil.firstName} ${pupilResults[0].pupil.lastName}`,
    }))
    .sort((a, b) => {
      if (b.averageScore !== a.averageScore) return b.averageScore - a.averageScore;
      return a.pupilName.localeCompare(b.pupilName);
    });

  let position = 1;
  let lastAverage = pupils[0]?.averageScore;
  const positions: ResultPosition[] = [];

  pupils.forEach((pupil, index) => {
    if (pupil.averageScore !== lastAverage) {
      position = index + 1;
      lastAverage = pupil.averageScore;
    }
    for (const result of pupil.results) {
      positions.push({ resultId: result.id, position });
    }
  });

  return positions;
}
