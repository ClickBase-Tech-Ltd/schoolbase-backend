import assert from 'node:assert/strict';
import {
  getAllowedFinancingApplicationTransitions,
  InvalidFinancingApplicationTransitionError,
  transitionFinancingApplication,
} from '../src/services/financing-application-lifecycle.js';

const validPath = [
  'DRAFT',
  'CONSENTED',
  'SUBMITTED',
  'UNDER_REVIEW',
  'MORE_INFO_REQUIRED',
  'SUBMITTED',
  'OFFERED',
  'OFFER_ACCEPTED',
] as const;

for (let index = 1; index < validPath.length; index += 1) {
  assert.equal(transitionFinancingApplication(validPath[index - 1], validPath[index]), validPath[index]);
}

assert.deepEqual(getAllowedFinancingApplicationTransitions('REJECTED'), []);
assert.deepEqual(getAllowedFinancingApplicationTransitions('CANCELLED'), []);
assert.equal(transitionFinancingApplication('DRAFT', 'SUBMITTED'), 'SUBMITTED');
assert.throws(
  () => transitionFinancingApplication('DRAFT', 'UNDER_REVIEW'),
  (error: unknown) => error instanceof InvalidFinancingApplicationTransitionError &&
    error.currentStatus === 'DRAFT' &&
    error.requestedStatus === 'UNDER_REVIEW',
);
assert.throws(
  () => transitionFinancingApplication('OFFER_ACCEPTED', 'UNDER_REVIEW'),
  InvalidFinancingApplicationTransitionError,
);
assert.throws(
  () => transitionFinancingApplication('EXPIRED', 'OFFERED'),
  InvalidFinancingApplicationTransitionError,
);

console.log('Financing application lifecycle tests passed');
