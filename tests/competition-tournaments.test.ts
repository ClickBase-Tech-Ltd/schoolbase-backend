import assert from 'node:assert/strict';
import { canTransitionCompetitionTournament, parseCompetitionTournamentDate } from '../src/services/competition-tournaments.js';

assert.equal(canTransitionCompetitionTournament('DRAFT', 'UPCOMING'), true);
assert.equal(canTransitionCompetitionTournament('UPCOMING', 'REGISTRATION_OPEN'), true);
assert.equal(canTransitionCompetitionTournament('REGISTRATION_OPEN', 'REGISTRATION_CLOSED'), true);
assert.equal(canTransitionCompetitionTournament('REGISTRATION_CLOSED', 'LIVE'), true);
assert.equal(canTransitionCompetitionTournament('LIVE', 'COMPLETED'), true);
assert.equal(canTransitionCompetitionTournament('COMPLETED', 'LIVE'), false);
assert.equal(canTransitionCompetitionTournament('CANCELLED', 'UPCOMING'), false);
assert.equal(canTransitionCompetitionTournament('DRAFT', 'LIVE'), false);
assert.equal(parseCompetitionTournamentDate('2026-11-01T10:00:00.000Z')?.toISOString(), '2026-11-01T10:00:00.000Z');
assert.equal(parseCompetitionTournamentDate(null), null);
assert.throws(() => parseCompetitionTournamentDate('not-a-date'));

console.log('Competition tournament tests passed');