import assert from 'node:assert/strict';
import test from 'node:test';
import { signupRateLimitPolicy } from '../signup-rate-limit.js';

test('signup OTP limits enforce a one-minute cooldown and rolling email cap', () => {
  assert.equal(signupRateLimitPolicy.emailCooldownMs, 60_000);
  assert.equal(signupRateLimitPolicy.emailWindowMs, 15 * 60_000);
  assert.equal(signupRateLimitPolicy.emailWindowLimit, 5);
});