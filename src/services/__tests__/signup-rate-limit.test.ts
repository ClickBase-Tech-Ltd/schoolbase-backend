import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { signupRateLimitPolicy, verifyClientIpAssertion } from '../signup-rate-limit.js';

test('signup OTP limits enforce a one-minute cooldown and rolling email cap', () => {
  assert.equal(signupRateLimitPolicy.emailCooldownMs, 60_000);
  assert.equal(signupRateLimitPolicy.emailWindowMs, 15 * 60_000);
  assert.equal(signupRateLimitPolicy.emailWindowLimit, 5);
  assert.equal(signupRateLimitPolicy.reminderCooldownMs, 10 * 60_000);
});

test('client IP assertions require a valid, fresh HMAC signature', () => {
  const now = Date.now();
  const originalSessionSecret = process.env.SESSION_SECRET;
  const originalAssertionSecret = process.env.SIGNUP_IP_ASSERTION_SECRET;
  const secret = 'dedicated-signup-assertion-secret-for-test';
  process.env.SESSION_SECRET = 'different-session-secret-for-test';
  process.env.SIGNUP_IP_ASSERTION_SECRET = secret;
  const payload = Buffer.from(JSON.stringify({ ip: '203.0.113.7', timestamp: now })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  try {
    assert.equal(verifyClientIpAssertion(`${payload}.${signature}`, now), '203.0.113.7');
    assert.equal(verifyClientIpAssertion(`${payload}.${signature}`, now + 121_000), null);

    const tamperedPayload = Buffer.from(JSON.stringify({ ip: '203.0.113.8', timestamp: now })).toString('base64url');
    assert.equal(verifyClientIpAssertion(`${tamperedPayload}.${signature}`, now), null);

    const sessionSignedSignature = createHmac('sha256', process.env.SESSION_SECRET!).update(payload).digest('base64url');
    assert.equal(verifyClientIpAssertion(`${payload}.${sessionSignedSignature}`, now), null);

    delete process.env.SIGNUP_IP_ASSERTION_SECRET;
    const legacySignature = createHmac('sha256', process.env.SESSION_SECRET!).update(payload).digest('base64url');
    assert.equal(verifyClientIpAssertion(`${payload}.${legacySignature}`, now), '203.0.113.7');
  } finally {
    if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSessionSecret;
    if (originalAssertionSecret === undefined) delete process.env.SIGNUP_IP_ASSERTION_SECRET;
    else process.env.SIGNUP_IP_ASSERTION_SECRET = originalAssertionSecret;
  }
});