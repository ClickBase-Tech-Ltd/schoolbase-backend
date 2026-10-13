import assert from 'node:assert/strict';
import {
  getCompetitionExamPracticeGrades,
  isEligibleForCompetitionExamPractice,
  normalizeCompetitionExamPracticeGrade,
} from '../src/services/competition-exam-practice.js';

const practice = {
  examCode: 'WAEC',
  countryCode: 'GH',
  gradeLabel: 'SHS 2',
};
assert.deepEqual(getCompetitionExamPracticeGrades('GH', 'WAEC'), ['SHS 1', 'SHS 2', 'SHS 3']);
assert.deepEqual(getCompetitionExamPracticeGrades('GH', 'BECE'), ['JHS 1', 'JHS 2', 'JHS 3']);
assert.deepEqual(getCompetitionExamPracticeGrades('NG', 'JUNIOR_WAEC'), ['JSS 1', 'JSS 2', 'JSS 3']);
assert.deepEqual(getCompetitionExamPracticeGrades('NG', 'BECE'), []);
assert.equal(normalizeCompetitionExamPracticeGrade('GH', 'WAEC', 'Senior High School 2'), 'SHS 2');
assert.equal(normalizeCompetitionExamPracticeGrade('NG', 'WAEC', 'SSS 3'), 'SS 3');
assert.equal(normalizeCompetitionExamPracticeGrade('NG', 'JUNIOR_WAEC', 'Primary 4'), null);
assert.equal(isEligibleForCompetitionExamPractice({ practice, schoolCountry: 'GH', className: 'SHS 2', challengeStatus: 'ACTIVE', questionSetStatus: 'APPROVED' }), true);
assert.equal(isEligibleForCompetitionExamPractice({ practice, schoolCountry: 'gh', className: ' Senior High 2 ', challengeStatus: 'ACTIVE', questionSetStatus: 'APPROVED' }), true);
assert.equal(isEligibleForCompetitionExamPractice({ practice, schoolCountry: 'GH', className: 'SHS 2', challengeStatus: 'ACTIVE', questionSetStatus: 'APPROVED', isActive: true }), true);
assert.equal(isEligibleForCompetitionExamPractice({ practice, schoolCountry: 'NG', className: 'SHS 2', challengeStatus: 'ACTIVE', questionSetStatus: 'APPROVED' }), false);
assert.equal(isEligibleForCompetitionExamPractice({ practice, schoolCountry: 'GH', className: 'SHS 3', challengeStatus: 'ACTIVE', questionSetStatus: 'APPROVED' }), false);
assert.equal(isEligibleForCompetitionExamPractice({ practice, schoolCountry: 'GH', className: 'Primary 4', challengeStatus: 'ACTIVE', questionSetStatus: 'APPROVED' }), false);
assert.equal(isEligibleForCompetitionExamPractice({ practice: { ...practice, examCode: 'BECE', gradeLabel: 'JHS 3' }, schoolCountry: 'GH', className: 'JHS 3', challengeStatus: 'ACTIVE', questionSetStatus: 'APPROVED' }), true);
assert.equal(isEligibleForCompetitionExamPractice({ practice: { ...practice, countryCode: 'NG', examCode: 'JUNIOR_WAEC', gradeLabel: 'JSS 3' }, schoolCountry: 'NG', className: 'JSS 3', challengeStatus: 'ACTIVE', questionSetStatus: 'APPROVED' }), true);
assert.equal(isEligibleForCompetitionExamPractice({ practice: { ...practice, examCode: 'BECE', gradeLabel: 'JHS 3' }, schoolCountry: 'NG', className: 'JHS 3', challengeStatus: 'ACTIVE', questionSetStatus: 'APPROVED' }), false);
assert.equal(isEligibleForCompetitionExamPractice({ practice, schoolCountry: 'GH', className: 'SHS 2', challengeStatus: 'DRAFT', questionSetStatus: 'APPROVED' }), false);
assert.equal(isEligibleForCompetitionExamPractice({ practice, schoolCountry: 'GH', className: 'SHS 2', challengeStatus: 'ACTIVE', questionSetStatus: 'DRAFT' }), false);
assert.equal(isEligibleForCompetitionExamPractice({ practice: { ...practice, isActive: false }, schoolCountry: 'GH', className: 'SHS 2', challengeStatus: 'ACTIVE', questionSetStatus: 'APPROVED', isActive: true }), false);
assert.equal(isEligibleForCompetitionExamPractice({ practice: { ...practice, isActive: true }, schoolCountry: 'GH', className: 'SHS 2', challengeStatus: 'ACTIVE', questionSetStatus: 'APPROVED', isActive: false }), false);
assert.equal(isEligibleForCompetitionExamPractice({ practice, schoolCountry: null, className: 'SHS 2', challengeStatus: 'ACTIVE', questionSetStatus: 'APPROVED' }), false);
assert.equal(isEligibleForCompetitionExamPractice({ practice, schoolCountry: 'GH', className: null, challengeStatus: 'ACTIVE', questionSetStatus: 'APPROVED' }), false);

console.log('Competition exam-practice eligibility tests passed');
