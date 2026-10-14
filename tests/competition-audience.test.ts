/// <reference types="node" />
import assert from 'node:assert/strict';
import { calculateAge, isSeniorSecondaryCompetitionGrade, matchesCompetitionAudience, parseCompetitionAudience } from '../src/services/competition-audience.js';
import { getCompetitionDailyLimitError } from '../src/services/competition-daily-limit.js';

const referenceDate = new Date('2026-10-09T12:00:00.000Z');

assert.deepEqual(parseCompetitionAudience('Ages 10-11 · Primary 5'), {
  classLabel: 'Primary 5',
});
assert.deepEqual(parseCompetitionAudience('Primary 5'), { classLabel: 'Primary 5' });
assert.equal(parseCompetitionAudience('Ages 10-'), null);
assert.equal(calculateAge(new Date('2015-10-10T00:00:00.000Z'), referenceDate), 10);
assert.equal(calculateAge(new Date('2015-10-09T00:00:00.000Z'), referenceDate), 11);

const pupil = { audienceLabel: 'Ages 10-11 · Primary 5', className: 'Primary 5' };
assert.equal(matchesCompetitionAudience(pupil), true);
assert.equal(matchesCompetitionAudience({ ...pupil, className: 'JSS3' }), false);
assert.equal(matchesCompetitionAudience({ ...pupil, audienceLabel: 'Primary 5' }), true);
assert.equal(matchesCompetitionAudience({ ...pupil, audienceLabel: 'Ages 8-9 · Primary 5' }), true);
assert.equal(matchesCompetitionAudience({ audienceLabel: 'Basic 1', className: 'Primary 1' }), true);
assert.equal(matchesCompetitionAudience({ audienceLabel: 'Pry 6', className: 'Basic 6' }), true);
assert.equal(matchesCompetitionAudience({ audienceLabel: 'Basic 7', className: 'JSS 1' }), true);
assert.equal(matchesCompetitionAudience({ audienceLabel: 'JS 3', className: 'Junior Secondary School 3' }), true);
assert.equal(matchesCompetitionAudience({ audienceLabel: 'SSS 2', className: 'Senior Secondary 2' }), true);
assert.equal(matchesCompetitionAudience({ audienceLabel: 'Basic 1', className: 'Primary 2' }), false);
assert.equal(matchesCompetitionAudience({ audienceLabel: 'JSS 1', className: 'SS 1' }), false);
assert.equal(matchesCompetitionAudience({ audienceLabel: 'JHS 1', className: 'JSS 1' }), true);
assert.equal(matchesCompetitionAudience({ audienceLabel: 'SHS 3', className: 'SSS 3' }), true);
assert.equal(matchesCompetitionAudience({ audienceLabel: 'Year 1', className: 'Basic 1' }), true);
assert.equal(matchesCompetitionAudience({ audienceLabel: 'JHS 1', className: 'Year 7' }), true);
assert.equal(matchesCompetitionAudience({ audienceLabel: 'SHS 2', className: 'Year 11' }), true);
assert.equal(isSeniorSecondaryCompetitionGrade('Ages 15-18 · SS 1'), true);
assert.equal(isSeniorSecondaryCompetitionGrade('Senior High School 3'), true);
assert.equal(isSeniorSecondaryCompetitionGrade('Year 10'), true);
assert.equal(isSeniorSecondaryCompetitionGrade('JSS 3'), false);
assert.equal(matchesCompetitionAudience({ ...pupil, className: null }), false);
assert.equal(matchesCompetitionAudience({ ...pupil, audienceLabel: null }), false);

const today = new Date('2026-10-13T12:00:00.000Z');
assert.equal(getCompetitionDailyLimitError([
  { startedAt: '2026-10-13T08:00:00.000Z', challenge: { examPractice: null } },
], today, 'DAILY'), 'DAILY_CHALLENGE_LIMIT_REACHED');
assert.equal(getCompetitionDailyLimitError([
  { startedAt: '2026-10-13T08:00:00.000Z', challenge: { examPractice: null } },
  { startedAt: '2026-10-13T09:00:00.000Z', challenge: { examPractice: null } },
], today, 'DAILY'), 'DAILY_CHALLENGE_LIMIT_REACHED');
assert.equal(getCompetitionDailyLimitError([
  { startedAt: '2026-10-13T08:00:00.000Z', challenge: { examPractice: { id: 'exam-1' } } },
], today, 'EXAM'), 'EXAM_PRACTICE_LIMIT_REACHED');
assert.equal(getCompetitionDailyLimitError([
  { startedAt: '2026-10-13T08:00:00.000Z', challenge: { examPractice: { id: 'exam-1' } } },
  { startedAt: '2026-10-13T09:00:00.000Z', challenge: { examPractice: { id: 'exam-2' } } },
], today, 'EXAM'), 'EXAM_PRACTICE_LIMIT_REACHED');
assert.equal(getCompetitionDailyLimitError([
  { startedAt: '2026-10-12T08:00:00.000Z', challenge: { examPractice: { id: 'exam-1' } } },
], today, 'EXAM'), null);
assert.equal(getCompetitionDailyLimitError([
  { startedAt: '2026-10-13T08:00:00.000Z', challenge: { examPractice: null } },
  { startedAt: '2026-10-13T09:00:00.000Z', challenge: { examPractice: { id: 'exam-1' } } },
], today, 'DAILY'), 'DAILY_CHALLENGE_LIMIT_REACHED');
assert.equal(getCompetitionDailyLimitError([
  { startedAt: '2026-10-13T08:00:00.000Z', challenge: { examPractice: { id: 'exam-1' } } },
  { startedAt: '2026-10-13T09:00:00.000Z', challenge: { examPractice: null } },
], today, 'EXAM'), 'EXAM_PRACTICE_LIMIT_REACHED');
assert.equal(getCompetitionDailyLimitError([
  { startedAt: '2026-10-13T08:00:00.000Z', challenge: { examPractice: null } },
], today, 'EXAM'), null);
assert.equal(getCompetitionDailyLimitError([
  { startedAt: '2026-10-13T08:00:00.000Z', challenge: { examPractice: { id: 'exam-1' } } },
], today, 'DAILY'), null);

console.log('Competition audience tests passed');