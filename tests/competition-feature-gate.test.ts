import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import {
  isCompetitionFeatureEnabled,
  normalizeCompetitionFeatures,
  requireCompetitionFeature,
  resolveCompetitionFeature,
} from '../src/services/competition-feature-gate.js';
import { competitionFeatureDefaults } from '../src/services/platform-settings.js';

function prismaWithSetting(value?: string, shouldThrow = false) {
  return {
    platformSetting: {
      findUnique: async () => {
        if (shouldThrow) throw new Error('settings unavailable');
        return value === undefined ? null : { key: 'competitionFeatures', value };
      },
    },
  } as unknown as PrismaClient;
}

const defaultFeatures = normalizeCompetitionFeatures(undefined);
assert.deepEqual(defaultFeatures, competitionFeatureDefaults);
assert.equal(isCompetitionFeatureEnabled(defaultFeatures, 'competition.enabled'), false);
assert.equal(isCompetitionFeatureEnabled(defaultFeatures, 'competition.dailyChallenge.enabled'), false);
assert.equal(isCompetitionFeatureEnabled(defaultFeatures, 'competition.examPractice.enabled'), false);

const childEnabledOnly = normalizeCompetitionFeatures({ 'competition.dailyChallenge.enabled': true });
assert.equal(isCompetitionFeatureEnabled(childEnabledOnly, 'competition.dailyChallenge.enabled'), false);

const enabledFeatures = normalizeCompetitionFeatures({
  'competition.enabled': true,
  'competition.dailyChallenge.enabled': true,
});
assert.equal(isCompetitionFeatureEnabled(enabledFeatures, 'competition.dailyChallenge.enabled'), true);
assert.equal(isCompetitionFeatureEnabled(normalizeCompetitionFeatures({ 'competition.enabled': true, 'competition.examPractice.enabled': true }), 'competition.examPractice.enabled'), true);
assert.equal(isCompetitionFeatureEnabled(normalizeCompetitionFeatures({ 'competition.enabled': true, 'competition.dailyChallenge.enabled': true }), 'competition.examPractice.enabled'), false);
assert.equal(isCompetitionFeatureEnabled(enabledFeatures, 'competition.studentVsStudent.enabled'), false);

assert.equal(await resolveCompetitionFeature(prismaWithSetting(), 'competition.enabled'), false);
assert.equal(await resolveCompetitionFeature(prismaWithSetting('{"competition.enabled":true,"competition.dailyChallenge.enabled":true}'), 'competition.dailyChallenge.enabled'), true);
assert.equal(await resolveCompetitionFeature(prismaWithSetting('{bad json'), 'competition.enabled'), false);
assert.equal(await resolveCompetitionFeature(prismaWithSetting(undefined, true), 'competition.enabled'), false);

let deniedStatus = 0;
let deniedBody: unknown;
let deniedNextCalled = false;
await requireCompetitionFeature(prismaWithSetting(), 'competition.enabled')(
  {} as never,
  {
    status(code: number) {
      deniedStatus = code;
      return this;
    },
    json(body: unknown) {
      deniedBody = body;
      return this;
    },
  } as never,
  () => { deniedNextCalled = true; },
);
assert.equal(deniedStatus, 404);
assert.deepEqual(deniedBody, { message: 'This Competition feature is not available.' });
assert.equal(deniedNextCalled, false);

let enabledNextCalled = false;
await requireCompetitionFeature(
  prismaWithSetting('{"competition.enabled":true,"competition.dailyChallenge.enabled":true}'),
  'competition.dailyChallenge.enabled',
)(
  {} as never,
  { status() { return this; }, json() { return this; } } as never,
  () => { enabledNextCalled = true; },
);
assert.equal(enabledNextCalled, true);

console.log('Competition feature gate tests passed');