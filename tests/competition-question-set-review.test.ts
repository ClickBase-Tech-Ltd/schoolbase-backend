import assert from 'node:assert/strict';
import { canApproveCompetitionQuestionSet } from '../src/services/competition-question-set-review.js';

assert.equal(canApproveCompetitionQuestionSet([]), false);
assert.equal(canApproveCompetitionQuestionSet(['REJECTED', 'REJECTED']), false);
assert.equal(canApproveCompetitionQuestionSet(['APPROVED']), true);
assert.equal(canApproveCompetitionQuestionSet(['APPROVED', 'REJECTED']), true);
assert.equal(canApproveCompetitionQuestionSet(['APPROVED', 'DRAFT']), false);
assert.equal(canApproveCompetitionQuestionSet(['APPROVED', 'IN_REVIEW']), false);

console.log('Competition question-set review tests passed');