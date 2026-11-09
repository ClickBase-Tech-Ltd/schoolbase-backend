import assert from 'node:assert/strict';
import {
  getPublicPaymentPlans,
  isValidPaymentPlans,
  normalizeEmailList,
  platformSettingDefaults,
} from '../src/services/platform-settings.js';

const plans = {
  STARTER: { label: 'Starter', priceLabel: 'Starter price', amountMinor: 3500000, studentLimit: 150 },
  GROWTH: { label: 'Growth', priceLabel: 'Growth price', amountMinor: 5500000, studentLimit: 600 },
  ENTERPRISE: { label: 'Enterprise', priceLabel: 'Enterprise price', amountMinor: 5000000, studentLimit: null },
};

assert.deepEqual(normalizeEmailList(' Team@Example.com, team@example.com, invalid '), ['team@example.com']);
assert.equal(platformSettingDefaults.tuitionFinancingEnabled, false);
assert.equal(isValidPaymentPlans(plans), true);
assert.equal(isValidPaymentPlans({ ...plans, GROWTH: { ...plans.GROWTH, studentLimit: 0 } }), false);

const publicPlans = getPublicPaymentPlans(plans);
assert.equal(publicPlans.starter.priceLabel, '₦35,000 / term');
assert.equal(publicPlans.standard.priceLabel, '₦55,000 / term');
assert.equal(publicPlans.group.priceLabel, '₦50,000 / term');
assert.equal(publicPlans.group.amountMinor, 5000000);

const quota = plans.GROWTH.studentLimit;
assert.equal(599 + 1 <= quota, true);
assert.equal(600 + 1 > quota, true);

console.log('✓ Platform settings smoke tests passed');
