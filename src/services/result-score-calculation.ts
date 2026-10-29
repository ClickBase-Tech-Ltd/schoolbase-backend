export interface AssessmentScoreComponent {
  id: string;
  name?: string;
  maxScore: number;
  weight: number;
  sortOrder?: number;
}

export interface RawAssessmentScores {
  caScore?: number | null;
  testScore?: number | null;
  examScore?: number | null;
  totalScore?: number | null;
}

export interface StoredAssessmentResult extends RawAssessmentScores {
  scores?: string | null;
}

export const DEFAULT_ASSESSMENT_COMPONENTS: AssessmentScoreComponent[] = [
  { id: 'ca', name: 'Continuous Assessment', maxScore: 20, weight: 20, sortOrder: 1 },
  { id: 'test', name: 'Test', maxScore: 20, weight: 20, sortOrder: 2 },
  { id: 'exam', name: 'Examination', maxScore: 60, weight: 60, sortOrder: 3 },
];

export function parseAssessmentScoreComponents(componentData: string): AssessmentScoreComponent[] | null {
  try {
    const parsed: unknown = JSON.parse(componentData);
    if (!parsed || typeof parsed !== 'object' || !('components' in parsed)) {
      return null;
    }

    const components = (parsed as { components?: unknown }).components;
    if (!Array.isArray(components) || components.length === 0) {
      return null;
    }

    return [...components].sort(
      (a, b) => ((a as AssessmentScoreComponent).sortOrder ?? 0) - ((b as AssessmentScoreComponent).sortOrder ?? 0)
    ) as AssessmentScoreComponent[];
  } catch {
    return null;
  }
}

export function getAssessmentScoreComponents(componentData?: string | null): AssessmentScoreComponent[] {
  if (!componentData) return DEFAULT_ASSESSMENT_COMPONENTS;
  return parseAssessmentScoreComponents(componentData) ?? DEFAULT_ASSESSMENT_COMPONENTS;
}

function mapRawScoresToComponents(
  components: AssessmentScoreComponent[],
  scores: RawAssessmentScores
): Record<string, number | null> {
  const rawScores = [scores.caScore ?? null, scores.testScore ?? null, scores.examScore ?? null];

  return Object.fromEntries(
    components.map((component, index) => {
      const id = component.id.toLowerCase();
      const name = (component.name ?? '').toLowerCase();
      const rawIndex =
        id.includes('ca') || name.includes('ca') || name.includes('continuous')
          ? 0
          : id.includes('test') || name.includes('test')
            ? 1
            : id.includes('exam') || name.includes('exam') || name.includes('examination')
              ? 2
              : index;

      return [component.id, rawScores[rawIndex] ?? null];
    })
  );
}

export function calculateWeightedTotalScore(
  components: AssessmentScoreComponent[],
  componentScores: Record<string, number | null | undefined>
): number | null {
  if (components.length === 0) return null;

  let total = 0;
  let hasMissingScore = false;
  for (const component of components) {
    const score = componentScores[component.id];
    if (score === null || score === undefined) {
      hasMissingScore = true;
      continue;
    }
    if (
      !Number.isFinite(score) ||
      !Number.isFinite(component.maxScore) ||
      component.maxScore <= 0 ||
      !Number.isFinite(component.weight) ||
      component.weight < 0 ||
      score < 0 ||
      score > component.maxScore
    ) {
      throw new Error(`Invalid score for ${component.name || component.id}; expected 0-${component.maxScore}`);
    }

    total += (score / component.maxScore) * component.weight;
  }

  return hasMissingScore ? null : Number(total.toFixed(1));
}

export function normalizeTeacherAssessmentScores(
  componentData: string | null,
  scores: RawAssessmentScores
): { totalScore: number | null; scoresJson: Record<string, number> } {
  const components = componentData
    ? parseAssessmentScoreComponents(componentData)
    : DEFAULT_ASSESSMENT_COMPONENTS;
  if (!components) throw new Error('Assessment has invalid score component configuration');
  const mappedScores = mapRawScoresToComponents(components, scores);
  const totalScore = calculateWeightedTotalScore(components, mappedScores);
  const scoresJson = Object.fromEntries(
    Object.entries(mappedScores).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
  );

  return { totalScore, scoresJson };
}

export function resolveStoredAssessmentTotal(
  componentData: string | null,
  result: StoredAssessmentResult
): number | null {
  if (typeof result.totalScore === 'number' && Number.isFinite(result.totalScore)) {
    return result.totalScore;
  }

  const components = componentData
    ? parseAssessmentScoreComponents(componentData)
    : DEFAULT_ASSESSMENT_COMPONENTS;
  if (!components) return null;
  if (result.scores) {
    try {
      const parsed: unknown = JSON.parse(result.scores);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const total = calculateWeightedTotalScore(
          components,
          parsed as Record<string, number | null | undefined>
        );
        if (total !== null) return total;
      }
    } catch {
      return null;
    }
  }

  try {
    return calculateWeightedTotalScore(components, mapRawScoresToComponents(components, result));
  } catch {
    return null;
  }
}
