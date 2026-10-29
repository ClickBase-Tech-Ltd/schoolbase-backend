import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_ASSESSMENT_COMPONENTS,
  normalizeTeacherAssessmentScores,
  resolveStoredAssessmentTotal,
} from '../src/services/result-score-calculation.ts';

describe('assessment result score calculations', () => {
  it('calculates weighted totals on the server and accepts legitimate zero scores', () => {
    const result = normalizeTeacherAssessmentScores(
      JSON.stringify({ components: DEFAULT_ASSESSMENT_COMPONENTS }),
      { caScore: 0, testScore: 0, examScore: 0, totalScore: 95 }
    );

    assert.equal(result.totalScore, 0);
    assert.deepEqual(result.scoresJson, { ca: 0, test: 0, exam: 0 });
  });

  it('does not create totals when a required component is missing', () => {
    const result = normalizeTeacherAssessmentScores(
      JSON.stringify({ components: DEFAULT_ASSESSMENT_COMPONENTS }),
      { caScore: 10, testScore: null, examScore: 30 }
    );

    assert.equal(result.totalScore, null);
    assert.deepEqual(result.scoresJson, { ca: 10, exam: 30 });
  });

  it('rejects component scores outside the configured range', () => {
    assert.throws(
      () =>
        normalizeTeacherAssessmentScores(
          JSON.stringify({ components: DEFAULT_ASSESSMENT_COMPONENTS }),
          { caScore: 21, testScore: 10, examScore: 30 }
        ),
      /Invalid score/
    );
  });

  it('recomputes legacy weighted totals but does not invent a total from partial values', () => {
    const componentData = JSON.stringify({ components: DEFAULT_ASSESSMENT_COMPONENTS });

    assert.equal(
      resolveStoredAssessmentTotal(componentData, {
        totalScore: null,
        caScore: 10,
        testScore: 10,
        examScore: 30,
      }),
      50
    );
    assert.equal(
      resolveStoredAssessmentTotal(componentData, {
        totalScore: null,
        caScore: 10,
        testScore: null,
        examScore: 30,
      }),
      null
    );
  });

  it('includes an explicit stored zero total', () => {
    assert.equal(
      resolveStoredAssessmentTotal(JSON.stringify({ components: DEFAULT_ASSESSMENT_COMPONENTS }), {
        totalScore: 0,
        caScore: 0,
        testScore: 0,
        examScore: 0,
      }),
      0
    );
  });

  it('uses the assessment component weights when recovering a legacy stored-score total', () => {
    const components = [
      { id: 'classwork', name: 'Classwork', maxScore: 10, weight: 40 },
      { id: 'exam', name: 'Exam', maxScore: 50, weight: 60 },
    ];

    assert.equal(
      resolveStoredAssessmentTotal(
        JSON.stringify({ components }),
        { totalScore: null, scores: JSON.stringify({ classwork: 8, exam: 25 }) }
      ),
      62
    );
  });
});
