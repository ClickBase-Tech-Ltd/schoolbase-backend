import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { ResultsDomainService } from '../src/domain/results/ResultsDomainService.ts';
import {
  calculateClassPositions,
  calculateSubjectPositions,
} from '../src/domain/results/result-ranking.ts';
import {
  isPassingGrade,
  resolveGradeForScore,
} from '../src/services/result-score-calculation.ts';
import {
  BulkReportCardGenerationError,
  generateCompleteBulkReportCards,
} from '../src/services/report-card-bulk.ts';

const activePupil = {
  id: 'active',
  firstName: 'Ada',
  lastName: 'One',
  isActive: true,
  status: 'ACTIVE',
};
const inactivePupil = {
  id: 'inactive',
  firstName: 'Cal',
  lastName: 'Three',
  isActive: false,
  status: 'INACTIVE',
};

describe('results reliability helpers', () => {
  it('excludes inactive pupils from subject and class positions', () => {
    const results = [
      { id: 'active-result', pupilId: activePupil.id, pupil: activePupil, totalScore: 80, scores: '{"ca":15}' },
      { id: 'inactive-result', pupilId: inactivePupil.id, pupil: inactivePupil, totalScore: 100, scores: '{"ca":20}' },
      { id: 'incomplete-result', pupilId: 'other', pupil: { ...activePupil, id: 'other' }, totalScore: null, scores: null },
    ];

    assert.deepEqual(calculateSubjectPositions(results, 'ca'), [
      { resultId: 'active-result', position: 1 },
    ]);
    assert.deepEqual(calculateClassPositions(results), [
      { resultId: 'active-result', position: 1 },
    ]);
  });

  it('clears stale positions and persists only active-pupil rankings', async () => {
    const results = [
      { id: 'active-result', pupilId: activePupil.id, pupil: activePupil, totalScore: 80, scores: '{"ca":15}' },
      { id: 'inactive-result', pupilId: inactivePupil.id, pupil: inactivePupil, totalScore: 100, scores: '{"ca":20}' },
    ];
    const clears: Array<Record<string, unknown>> = [];
    const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
    const tx = {
      assessment: {
        findFirst: async () => ({
          componentData: JSON.stringify({
            components: [{ id: 'ca', name: 'Continuous Assessment', maxScore: 20, weight: 20 }],
          }),
        }),
      },
      result: {
        findMany: async () => results,
        updateMany: async (args: { data: Record<string, unknown> }) => {
          clears.push(args.data);
          return { count: results.length };
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push(args);
          return {};
        },
      },
    };
    const prisma = {
      $transaction: async (operation: (transaction: typeof tx) => Promise<void>) => operation(tx),
    };
    const service = new ResultsDomainService(prisma as unknown as PrismaClient);

    await service.calculateSubjectPositioning('assessment-1', 'subject-1', 'school-1');
    await service.calculateClassPositioning('assessment-1', 'school-1');

    assert.deepEqual(clears, [{ subjectPosition: null }, { classPosition: null }]);
    assert.deepEqual(
      updates.map((update) => [update.where.id, update.data]),
      [
        ['active-result', { subjectPosition: 1 }],
        ['active-result', { classPosition: 1 }],
      ],
    );
  });

  it('uses custom grade bands and one grade-based pass rule', () => {
    const customScale = [
      { grade: 'F', minScore: 0, maxScore: 59 },
      { grade: 'P', minScore: 60, maxScore: 100 },
    ];

    assert.equal(resolveGradeForScore(59, customScale), 'F');
    assert.equal(resolveGradeForScore(60, customScale), 'P');
    assert.equal(isPassingGrade(resolveGradeForScore(59, customScale)), false);
    assert.equal(isPassingGrade(resolveGradeForScore(60, customScale)), true);
    assert.equal(isPassingGrade(' f '), false);
    assert.equal(isPassingGrade(null), false);
  });

  it('does not return a partial bulk report-card set on pupil failure', async () => {
    const error = new Error('render failed');
    await assert.rejects(
      generateCompleteBulkReportCards(['pupil-1', 'pupil-2'], async (pupilId) => {
        if (pupilId === 'pupil-2') throw error;
        return { pupilId };
      }),
      (caught: unknown) => {
        assert.ok(caught instanceof BulkReportCardGenerationError);
        assert.equal(caught.failures.length, 1);
        assert.equal(caught.failures[0].pupilId, 'pupil-2');
        assert.equal(caught.failures[0].error, error);
        return true;
      },
    );
  });

  it('keeps publication status, timestamps, and audit writes inside one transaction', async () => {
    const auditFailure = new Error('audit insert failed');
    const assessment = {
      id: 'assessment-1',
      schoolId: 'school-1',
      phase: 'PRIMARY',
      classId: null,
      class: null,
      componentData: JSON.stringify({
        components: [
          { id: 'ca', name: 'Continuous Assessment', maxScore: 20, weight: 20 },
          { id: 'test', name: 'Test', maxScore: 20, weight: 20 },
          { id: 'exam', name: 'Examination', maxScore: 60, weight: 60 },
        ],
      }),
      results: [{
        id: 'result-1',
        pupilId: 'pupil-1',
        pupil: { firstName: 'Ada', lastName: 'One' },
        subjectId: 'subject-1',
        subjectRef: null,
        totalScore: 80,
        grade: 'A',
        classPosition: 1,
        subjectPosition: 1,
        caScore: 16,
        testScore: 16,
        examScore: 48,
        scores: JSON.stringify({ ca: 16, test: 16, exam: 48 }),
      }],
    };
    const writes: string[] = [];
    const tx = {
      assessment: {
        findFirst: async () => assessment,
        updateMany: async () => {
          writes.push('assessment.status');
          return { count: 1 };
        },
      },
      result: {
        findMany: async () => [{ id: 'result-1', pupilId: 'pupil-1' }],
        updateMany: async () => {
          writes.push('result.publishedAt');
          return { count: 1 };
        },
      },
      resultAudit: {
        createMany: async () => {
          writes.push('resultAudit');
          throw auditFailure;
        },
      },
      gradingScale: { findMany: async () => [] },
      class: { findMany: async () => [{
        pupils: [{ ...activePupil, id: 'pupil-1' }],
        subjectClasses: [],
      }] },
    };
    const prisma = {
      result: { findMany: async () => [] },
      $transaction: async (operation: (transaction: typeof tx) => Promise<void>) =>
        operation(tx),
    };
    const service = new ResultsDomainService(prisma as unknown as PrismaClient);

    await assert.rejects(service.publishResults('assessment-1', 'admin-1', 'school-1'), auditFailure);
    assert.deepEqual(writes, ['assessment.status', 'result.publishedAt', 'resultAudit']);
  });
});
