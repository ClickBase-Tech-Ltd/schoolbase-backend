import assert from 'node:assert/strict';
import { buildCompetitionLeaderboard, chooseCompetitionMatchWinner } from '../src/services/competition-leaderboard.js';

const entries = buildCompetitionLeaderboard([
  { pupilId: 'pupil-b', firstName: 'Bola', lastName: 'Adebayo', score: 100, accuracyPercent: 100, elapsedMs: 30000, submittedAt: new Date('2026-10-10T10:00:00Z') },
  { pupilId: 'pupil-a', firstName: 'Ada', lastName: 'One', score: 100, accuracyPercent: 100, elapsedMs: 20000, submittedAt: new Date('2026-10-10T10:01:00Z') },
  { pupilId: 'pupil-a', firstName: 'Ada', lastName: 'One', score: 80, accuracyPercent: 80, elapsedMs: 10000, submittedAt: new Date('2026-10-10T09:00:00Z') },
  { pupilId: 'pupil-c', firstName: 'Chika', lastName: 'Two', score: 80, accuracyPercent: 80, elapsedMs: 10000, submittedAt: new Date('2026-10-10T09:00:00Z') },
]);

assert.deepEqual(entries, [
  { rank: 1, displayName: 'Ada O.', score: 100, accuracyPercent: 100, elapsedMs: 20000 },
  { rank: 2, displayName: 'Bola A.', score: 100, accuracyPercent: 100, elapsedMs: 30000 },
  { rank: 3, displayName: 'Chika T.', score: 80, accuracyPercent: 80, elapsedMs: 10000 },
]);
assert.equal(buildCompetitionLeaderboard([]).length, 0);
assert.equal(chooseCompetitionMatchWinner({ senderPupilId: 'sender', sender: { status: 'SUBMITTED', score: 90, accuracyPercent: 90, elapsedMs: 30000 }, recipientPupilId: 'recipient', recipient: { status: 'SUBMITTED', score: 80, accuracyPercent: 100, elapsedMs: 10000 } }), 'sender');
assert.equal(chooseCompetitionMatchWinner({ senderPupilId: 'sender', sender: { status: 'SUBMITTED', score: 90, accuracyPercent: 90, elapsedMs: 30000 }, recipientPupilId: 'recipient', recipient: { status: 'SUBMITTED', score: 90, accuracyPercent: 95, elapsedMs: 50000 } }), 'recipient');
assert.equal(chooseCompetitionMatchWinner({ senderPupilId: 'sender', sender: { status: 'SUBMITTED', score: 90, accuracyPercent: 95, elapsedMs: 30000 }, recipientPupilId: 'recipient', recipient: { status: 'SUBMITTED', score: 90, accuracyPercent: 95, elapsedMs: 20000 } }), 'recipient');
assert.equal(chooseCompetitionMatchWinner({ senderPupilId: 'sender', sender: { status: 'SUBMITTED', score: 90, accuracyPercent: 95, elapsedMs: 20000 }, recipientPupilId: 'recipient', recipient: { status: 'SUBMITTED', score: 90, accuracyPercent: 95, elapsedMs: 20000 } }), null);
assert.equal(chooseCompetitionMatchWinner({ senderPupilId: 'sender', sender: { status: 'EXPIRED', score: 90, accuracyPercent: 95, elapsedMs: 20000 }, recipientPupilId: 'recipient', recipient: { status: 'SUBMITTED', score: 0, accuracyPercent: 0, elapsedMs: 50000 } }), null);

console.log('Competition leaderboard tests passed');