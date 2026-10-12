import assert from 'node:assert/strict';
import { parseCompetitionAchievementCriteria, shouldAwardCompetitionAchievement } from '../src/services/competition-achievements.js';

const firstCompletion = parseCompetitionAchievementCriteria('{"type":"FIRST_COMPLETION"}');
assert.equal(shouldAwardCompetitionAchievement({ criteria: firstCompletion, priorCompletedChallenges: 0, correctCount: 0, questionCount: 1 }), true);
assert.equal(shouldAwardCompetitionAchievement({ criteria: firstCompletion, priorCompletedChallenges: 1, correctCount: 1, questionCount: 1 }), false);

const perfectScore = parseCompetitionAchievementCriteria('{"type":"PERFECT_SCORE"}');
assert.equal(shouldAwardCompetitionAchievement({ criteria: perfectScore, priorCompletedChallenges: 0, correctCount: 2, questionCount: 2 }), true);
assert.equal(shouldAwardCompetitionAchievement({ criteria: perfectScore, priorCompletedChallenges: 0, correctCount: 1, questionCount: 2 }), false);
assert.equal(shouldAwardCompetitionAchievement({ criteria: perfectScore, priorCompletedChallenges: 0, correctCount: 0, questionCount: 0 }), false);

const fifthCompletion = parseCompetitionAchievementCriteria('{"type":"COMPLETION_COUNT","threshold":5}');
assert.equal(shouldAwardCompetitionAchievement({ criteria: fifthCompletion, priorCompletedChallenges: 3, correctCount: 0, questionCount: 5 }), false);
assert.equal(shouldAwardCompetitionAchievement({ criteria: fifthCompletion, priorCompletedChallenges: 4, correctCount: 0, questionCount: 5 }), true);
assert.throws(() => parseCompetitionAchievementCriteria('{"type":"COMPLETION_COUNT","threshold":0}'));
assert.throws(() => parseCompetitionAchievementCriteria('{"type":"UNKNOWN"}'));
assert.throws(() => parseCompetitionAchievementCriteria('{bad json'));

console.log('Competition achievement tests passed');