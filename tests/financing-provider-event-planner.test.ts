import assert from 'node:assert/strict';
import {
  InvalidFinancingApplicationTransitionError,
} from '../src/services/financing-application-lifecycle.js';
import {
  planFinancingProviderEvent,
} from '../src/services/financing-provider-event-planner.js';
import {
  parseNormalizedFinancingProviderEvent,
} from '../src/services/financing-provider-contract.js';

const eventBase = {
  eventId: 'event-1',
  applicationReference: 'provider-app-1',
  occurredAt: '2026-11-04T00:00:00Z',
};

assert.deepEqual(
  planFinancingProviderEvent('SUBMITTED', parseNormalizedFinancingProviderEvent({
    ...eventBase,
    type: 'APPLICATION_STATUS',
    status: 'UNDER_REVIEW',
  })),
  { action: 'APPLICATION_STATUS_CHANGED', nextStatus: 'UNDER_REVIEW' },
);

assert.deepEqual(
  planFinancingProviderEvent('UNDER_REVIEW', parseNormalizedFinancingProviderEvent({
    ...eventBase,
    type: 'OFFER_ISSUED',
    offerReference: 'offer-1',
  })),
  { action: 'OFFER_RECORDED', nextStatus: 'OFFERED', offerReference: 'offer-1' },
);

assert.deepEqual(
  planFinancingProviderEvent('OFFERED', parseNormalizedFinancingProviderEvent({
    ...eventBase,
    type: 'APPLICATION_STATUS',
    status: 'OFFERED',
  })),
  { action: 'APPLICATION_STATUS_UNCHANGED', currentStatus: 'OFFERED' },
);

const disbursementEvent = parseNormalizedFinancingProviderEvent({
  ...eventBase,
  type: 'DISBURSEMENT_REPORTED',
  amountMinor: 12500,
  currency: 'NGN',
  settlementReference: 'settlement-1',
});

assert.deepEqual(
  planFinancingProviderEvent('OFFER_ACCEPTED', disbursementEvent),
  {
    action: 'DISBURSEMENT_PENDING_RECONCILIATION',
    amountMinor: 12500,
    currency: 'NGN',
    settlementReference: 'settlement-1',
  },
);
assert.deepEqual(
  planFinancingProviderEvent('UNDER_REVIEW', disbursementEvent),
  {
    action: 'DISBURSEMENT_REQUIRES_REVIEW',
    reason: 'APPLICATION_OFFER_NOT_ACCEPTED',
    amountMinor: 12500,
    currency: 'NGN',
    settlementReference: 'settlement-1',
  },
);

assert.throws(
  () => planFinancingProviderEvent('REJECTED', parseNormalizedFinancingProviderEvent({
    ...eventBase,
    type: 'APPLICATION_STATUS',
    status: 'OFFERED',
  })),
  InvalidFinancingApplicationTransitionError,
);
assert.throws(
  () => planFinancingProviderEvent('DRAFT', parseNormalizedFinancingProviderEvent({
    ...eventBase,
    type: 'OFFER_ISSUED',
    offerReference: 'offer-2',
  })),
  InvalidFinancingApplicationTransitionError,
);

console.log('Financing provider event planner tests passed');
