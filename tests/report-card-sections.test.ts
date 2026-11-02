import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReportCardAttendanceSummary,
  DEFAULT_REPORT_CARD_SECTIONS,
  normalizeReportCardSectionsConfig,
  readReportCardSectionsConfig,
} from '../src/services/report-card-sections.ts';

describe('report-card section configuration', () => {
  it('keeps every optional section disabled by default', () => {
    assert.equal(DEFAULT_REPORT_CARD_SECTIONS.affectiveEnabled, false);
    assert.equal(DEFAULT_REPORT_CARD_SECTIONS.psychomotorEnabled, false);
    assert.equal(DEFAULT_REPORT_CARD_SECTIONS.attendanceEnabled, false);
    assert.equal(DEFAULT_REPORT_CARD_SECTIONS.teacherCommentsEnabled, false);
    assert.equal(DEFAULT_REPORT_CARD_SECTIONS.principalCommentsEnabled, false);
  });

  it('uses defaults only when no saved configuration exists', () => {
    assert.deepEqual(readReportCardSectionsConfig(null), DEFAULT_REPORT_CARD_SECTIONS);
    assert.throws(() => readReportCardSectionsConfig('{invalid'));
  });

  it('rejects invalid flags, duplicate indicators, and excessive indicator lists', () => {
    assert.throws(() => normalizeReportCardSectionsConfig({ ...DEFAULT_REPORT_CARD_SECTIONS, attendanceEnabled: 'yes' }));
    assert.throws(() => normalizeReportCardSectionsConfig({ ...DEFAULT_REPORT_CARD_SECTIONS, affectiveIndicators: ['Focus', 'focus'] }));
    assert.throws(() => normalizeReportCardSectionsConfig({
      ...DEFAULT_REPORT_CARD_SECTIONS,
      psychomotorIndicators: Array.from({ length: 13 }, (_, index) => `Skill ${index}`),
    }));
  });
});

describe('report-card attendance summary', () => {
  it('calculates attendance only when each class attendance day is recorded for the pupil', () => {
    const summary = buildReportCardAttendanceSummary([
      { status: 'PRESENT' },
      { status: 'LATE' },
      { status: 'ABSENT' },
      { status: 'EXCUSED' },
    ], 4);

    assert.equal(summary.percentage, 66.67);
    assert.equal(summary.coverageComplete, true);
    assert.equal(summary.excused, 1);
    assert.equal(summary.unavailableReason, null);
  });

  it('withholds a percentage when pupil attendance records are incomplete', () => {
    const summary = buildReportCardAttendanceSummary([
      { status: 'PRESENT' },
      { status: 'ABSENT' },
    ], 3);

    assert.equal(summary.percentage, null);
    assert.equal(summary.coverageComplete, false);
    assert.equal(summary.unavailableReason, 'Attendance records are incomplete for this pupil');
  });

  it('does not report a percentage when there are no class attendance records', () => {
    const summary = buildReportCardAttendanceSummary([], 0);

    assert.equal(summary.percentage, null);
    assert.equal(summary.unavailableReason, 'No attendance has been recorded for this class during the term');
  });
});
