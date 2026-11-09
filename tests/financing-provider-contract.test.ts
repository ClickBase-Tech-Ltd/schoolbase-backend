import assert from 'node:assert/strict';
import {
  type FinancingProviderAdapter,
  FinancingProviderEventValidationError,
  parseNormalizedFinancingProviderEvent,
} from '../src/services/financing-provider-contract.js';

const apiAdapter: FinancingProviderAdapter<{ applicationToken: string }, 'API'> = {
  institutionCode: 'test-bank',
  mode: 'API',
  async startApplication() {
    return { mode: 'API', applicationReference: 'provider-app-1' };
  },
};

assert.deepEqual(await apiAdapter.startApplication({
  applicationId: 'local-app-1',
  idempotencyKey: 'submit-1',
  payload: { applicationToken: 'consented-payload-reference' },
}), {
  mode: 'API',
  applicationReference: 'provider-app-1',
});

const normalizedStatus = parseNormalizedFinancingProviderEvent({
  eventId: ' event-1 ',
  applicationReference: ' app-1 ',
  occurredAt: '2026-11-03T10:00:00Z',
  type: 'APPLICATION_STATUS',
  status: 'UNDER_REVIEW',
  rawKycPayload: { mustNotBeRetained: true },
});
assert.deepEqual(normalizedStatus, {
  eventId: 'event-1',
  applicationReference: 'app-1',
  occurredAt: '2026-11-03T10:00:00.000Z',
  type: 'APPLICATION_STATUS',
  status: 'UNDER_REVIEW',
});

assert.deepEqual(parseNormalizedFinancingProviderEvent({
  eventId: 'event-2',
  applicationReference: 'app-1',
  occurredAt: '2026-11-03T10:00:00Z',
  type: 'DISBURSEMENT_REPORTED',
  amountMinor: 12550,
  currency: 'ngn',
  settlementReference: 'settlement-1',
}), {
  eventId: 'event-2',
  applicationReference: 'app-1',
  occurredAt: '2026-11-03T10:00:00.000Z',
  type: 'DISBURSEMENT_REPORTED',
  amountMinor: 12550,
  currency: 'NGN',
  settlementReference: 'settlement-1',
});

assert.deepEqual(parseNormalizedFinancingProviderEvent({
  eventId: 'event-3',
  applicationReference: 'app-1',
  occurredAt: '2026-11-03T10:00:00+01:00',
  type: 'OFFER_ISSUED',
  offerReference: 'offer-1',
}), {
  eventId: 'event-3',
  applicationReference: 'app-1',
  occurredAt: '2026-11-03T09:00:00.000Z',
  type: 'OFFER_ISSUED',
  offerReference: 'offer-1',
});

function assertInvalid(value: unknown, code: FinancingProviderEventValidationError['code']) {
  assert.throws(
    () => parseNormalizedFinancingProviderEvent(value),
    (error: unknown) => error instanceof FinancingProviderEventValidationError && error.code === code,
  );
}

const baseEvent = {
  eventId: 'event-3',
  applicationReference: 'app-1',
  occurredAt: '2026-11-03T10:00:00Z',
};
assertInvalid(null, 'INVALID_EVENT');
assertInvalid({ ...baseEvent, type: 'APPLICATION_STATUS', status: 'APPROVED' }, 'INVALID_APPLICATION_STATUS');
assertInvalid({ ...baseEvent, type: 'APPLICATION_STATUS', status: 'DRAFT' }, 'INVALID_APPLICATION_STATUS');
assertInvalid({ ...baseEvent, occurredAt: 'not-a-date', type: 'APPLICATION_STATUS', status: 'SUBMITTED' }, 'INVALID_OCCURRED_AT');
assertInvalid({ ...baseEvent, occurredAt: '2026', type: 'APPLICATION_STATUS', status: 'SUBMITTED' }, 'INVALID_OCCURRED_AT');
assertInvalid({ ...baseEvent, eventId: ' ', type: 'APPLICATION_STATUS', status: 'SUBMITTED' }, 'INVALID_EVENT_ID');
assertInvalid({
  ...baseEvent,
  type: 'DISBURSEMENT_REPORTED',
  amountMinor: 0,
  currency: 'NGN',
  settlementReference: 'settlement-2',
}, 'INVALID_DISBURSEMENT_AMOUNT');
assertInvalid({
  ...baseEvent,
  type: 'DISBURSEMENT_REPORTED',
  amountMinor: Number.MAX_SAFE_INTEGER + 1,
  currency: 'NGN',
  settlementReference: 'settlement-2',
}, 'INVALID_DISBURSEMENT_AMOUNT');
assertInvalid({
  ...baseEvent,
  type: 'DISBURSEMENT_REPORTED',
  amountMinor: 100,
  currency: 'NG',
  settlementReference: 'settlement-2',
}, 'INVALID_DISBURSEMENT_CURRENCY');
assertInvalid({
  ...baseEvent,
  type: 'DISBURSEMENT_REPORTED',
  amountMinor: 100,
  currency: 'NGN',
  settlementReference: ' ',
}, 'INVALID_SETTLEMENT_REFERENCE');

console.log('Financing provider contract tests passed');
