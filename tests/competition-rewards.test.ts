import assert from 'node:assert/strict';
import { parseCompetitionXpPolicy } from '../src/services/competition-rewards.js';

assert.deepEqual(parseCompetitionXpPolicy(null), { completionXp: 0 });
assert.deepEqual(parseCompetitionXpPolicy(undefined), { completionXp: 0 });
assert.deepEqual(parseCompetitionXpPolicy('{"completionXp":25}'), { completionXp: 25 });
assert.deepEqual(parseCompetitionXpPolicy('{"completionXp":0}'), { completionXp: 0 });
assert.throws(() => parseCompetitionXpPolicy('{bad json'));
assert.throws(() => parseCompetitionXpPolicy('[]'));
assert.throws(() => parseCompetitionXpPolicy('{"completionXp":-1}'));
assert.throws(() => parseCompetitionXpPolicy('{"completionXp":100001}'));
assert.throws(() => parseCompetitionXpPolicy('{"completionXp":1.5}'));

console.log('Competition reward tests passed');