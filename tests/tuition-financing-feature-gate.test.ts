import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import {
  isTuitionFinancingEnabled,
  requireTuitionFinancing,
} from '../src/services/tuition-financing-feature-gate.js';

function prismaWithSetting(value?: string, shouldThrow = false) {
  return {
    platformSetting: {
      findUnique: async () => {
        if (shouldThrow) throw new Error('settings unavailable');
        return value === undefined ? null : { key: 'tuitionFinancingEnabled', value };
      },
    },
  } as unknown as PrismaClient;
}

assert.equal(await isTuitionFinancingEnabled(prismaWithSetting()), false);
assert.equal(await isTuitionFinancingEnabled(prismaWithSetting('false')), false);
assert.equal(await isTuitionFinancingEnabled(prismaWithSetting('true')), true);
assert.equal(await isTuitionFinancingEnabled(prismaWithSetting('"true"')), false);
assert.equal(await isTuitionFinancingEnabled(prismaWithSetting(undefined, true)), false);

let deniedStatus = 0;
let deniedBody: unknown;
let deniedNextCalled = false;
await requireTuitionFinancing(prismaWithSetting())(
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
assert.deepEqual(deniedBody, { message: 'Tuition financing is not available.' });
assert.equal(deniedNextCalled, false);

let enabledNextCalled = false;
await requireTuitionFinancing(prismaWithSetting('true'))(
  {} as never,
  { status() { return this; }, json() { return this; } } as never,
  () => { enabledNextCalled = true; },
);
assert.equal(enabledNextCalled, true);

console.log('Tuition financing feature gate tests passed');
