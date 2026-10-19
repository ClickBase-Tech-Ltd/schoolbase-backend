import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverPendingSignupReminder } from '../signup-reminder.js';

test('failed reminder delivery never replaces the currently valid OTP', async () => {
  let replaceCalled = false;

  await assert.rejects(deliverPendingSignupReminder({
    generateCode: () => '123456',
    send: async () => { throw new Error('SMTP unavailable'); },
    replace: async () => {
      replaceCalled = true;
      return true;
    },
  }), /SMTP unavailable/);

  assert.equal(replaceCalled, false);
});

test('accepted reminder delivery replaces only if the pending OTP is unchanged', async () => {
  const sentCodes: string[] = [];
  const replacedCodes: string[] = [];
  const result = await deliverPendingSignupReminder({
    generateCode: () => '654321',
    send: async (code) => { sentCodes.push(code); },
    replace: async (code) => {
      replacedCodes.push(code);
      return true;
    },
  });

  assert.equal(result, 'sent');
  assert.deepEqual(sentCodes, ['654321']);
  assert.deepEqual(replacedCodes, sentCodes);
});

test('delivery accepted after another action changed the OTP reports a conflict', async () => {
  let replaceCalled = false;
  const result = await deliverPendingSignupReminder({
    generateCode: () => '654321',
    send: async () => {},
    replace: async () => {
      replaceCalled = true;
      return false;
    },
  });

  assert.equal(replaceCalled, true);
  assert.equal(result, 'conflict');
});