import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { ResultsValidator } from '../src/domain/results/ResultsValidator.ts';
import { DEFAULT_ASSESSMENT_COMPONENTS } from '../src/services/result-score-calculation.ts';

const activePupils = [
  { id: 'active-1', firstName: 'Ada', lastName: 'One', isActive: true, status: 'ACTIVE' },
  { id: 'active-2', firstName: 'Ben', lastName: 'Two', isActive: true, status: 'ACTIVE' },
];
const inactivePupil = {
  id: 'inactive-1',
  firstName: 'Cal',
  lastName: 'Three',
  isActive: false,
  status: 'INACTIVE',
};

function makeResult(pupil: typeof activePupils[number] | typeof inactivePupil, totalScore: number | null) {
  const isComplete = totalScore !== null;
  const scoreRatio = (totalScore ?? 0) / 100;
  return {
    pupilId: pupil.id,
    pupil,
    subjectId: null,
    totalScore,
    grade: isComplete ? 'F' : null,
    classPosition: isComplete ? 1 : null,
    subjectPosition: isComplete ? 1 : null,
    caScore: isComplete ? 20 * scoreRatio : null,
    testScore: isComplete ? 20 * scoreRatio : null,
    examScore: isComplete ? 60 * scoreRatio : null,
    scores: null,
  };
}

function makeValidator(results: ReturnType<typeof makeResult>[]) {
  const assessment = {
    id: 'assessment-1',
    schoolId: 'school-1',
    phase: 'PRIMARY',
    classId: null,
    class: null,
    componentData: JSON.stringify({ components: DEFAULT_ASSESSMENT_COMPONENTS }),
    results,
  };
  const classRows = [
    {
      pupils: [...activePupils, inactivePupil],
      subjectClasses: [],
    },
  ];
  const prisma = {
    assessment: { findFirst: async () => assessment },
    gradingScale: { findMany: async () => [] },
    class: { findMany: async () => classRows },
  } as unknown as PrismaClient;

  return new ResultsValidator(prisma);
}

describe('ResultsValidator active roster coverage', () => {
  it('does not let an inactive pupil result cover a missing active pupil', async () => {
    const validator = makeValidator([
      makeResult(activePupils[0], 0),
      makeResult(inactivePupil, 70),
    ]);

    const validation = await validator.validateAssessmentResults('assessment-1', 'school-1');
    const coverageBlocker = validation.blockers.find((blocker) => blocker.field === 'studentCoverage');

    assert.ok(coverageBlocker);
    assert.deepEqual(coverageBlocker.details, { expected: 2, recorded: 1, missing: 1 });
  });

  it('retains but does not require incomplete saved rows for inactive pupils', async () => {
    const validator = makeValidator([
      makeResult(activePupils[0], 0),
      makeResult(activePupils[1], 80),
      makeResult(inactivePupil, null),
    ]);

    const validation = await validator.validateAssessmentResults('assessment-1', 'school-1');

    assert.equal(validation.isValid, true);
    assert.deepEqual(validation.blockers, []);
  });
});
