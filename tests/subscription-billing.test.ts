import assert from 'node:assert/strict';
import {
  getRenewedExpiry,
  getSubscriptionQuote,
  SUBSCRIPTION_TERM_DAYS,
} from '../src/services/subscription-billing.js';

const now = new Date('2026-01-01T00:00:00.000Z');
const planPrices = { STARTER: 60000, GROWTH: 85000, ENTERPRISE: 0 };

assert.equal(SUBSCRIPTION_TERM_DAYS, 90);

assert.deepEqual(
  getSubscriptionQuote({
    intent: 'RENEWAL',
    currentPlan: 'STARTER',
    currentExpiry: new Date('2026-01-20T00:00:00.000Z'),
    targetPlan: 'STARTER',
    planPrices,
    now,
  }),
  {
    intent: 'RENEWAL',
    amountMinor: 60000,
    termDays: 90,
    remainingDays: null,
    currentPlan: 'STARTER',
    targetPlan: 'STARTER',
  },
);

const upgradeQuote = getSubscriptionQuote({
  intent: 'UPGRADE',
  currentPlan: 'STARTER',
  currentExpiry: new Date('2026-01-31T00:00:00.000Z'),
  targetPlan: 'GROWTH',
  planPrices,
  now,
});
assert.equal(upgradeQuote.remainingDays, 30);
assert.equal(upgradeQuote.amountMinor, 8334);

assert.throws(
  () => getSubscriptionQuote({
    intent: 'UPGRADE',
    currentPlan: 'GROWTH',
    currentExpiry: new Date('2026-01-31T00:00:00.000Z'),
    targetPlan: 'STARTER',
    planPrices,
    now,
  }),
  /Choose a higher plan/,
);
assert.throws(
  () => getSubscriptionQuote({
    intent: 'NEW',
    currentPlan: 'STARTER',
    currentExpiry: new Date('2026-01-20T00:00:00.000Z'),
    targetPlan: 'STARTER',
    planPrices,
    now,
  }),
  /Choose to renew the current plan or upgrade/,
);
assert.throws(
  () => getSubscriptionQuote({
    intent: 'RENEWAL',
    currentPlan: 'STARTER',
    currentExpiry: new Date('2026-01-20T00:00:00.000Z'),
    targetPlan: 'GROWTH',
    planPrices,
    now,
  }),
  /Renewal must use the current plan/,
);
assert.throws(
  () => getSubscriptionQuote({
    intent: 'RENEWAL',
    currentPlan: 'STARTER',
    currentExpiry: new Date('2025-12-01T00:00:00.000Z'),
    targetPlan: 'GROWTH',
    planPrices,
    now,
  }),
  /Renewal must use the current plan/,
);
assert.throws(
  () => getSubscriptionQuote({
    intent: 'UPGRADE',
    currentPlan: 'GROWTH',
    currentExpiry: new Date('2026-01-31T00:00:00.000Z'),
    targetPlan: 'ENTERPRISE',
    planPrices,
    now,
  }),
  /configured online price/,
);

assert.equal(
  getRenewedExpiry(new Date('2026-01-10T00:00:00.000Z'), new Date('2026-01-05T00:00:00.000Z')).toISOString(),
  '2026-04-10T00:00:00.000Z',
);
assert.equal(
  getRenewedExpiry(new Date('2025-12-31T00:00:00.000Z'), new Date('2026-01-05T00:00:00.000Z')).toISOString(),
  '2026-04-05T00:00:00.000Z',
);

console.log('subscription billing tests passed');
