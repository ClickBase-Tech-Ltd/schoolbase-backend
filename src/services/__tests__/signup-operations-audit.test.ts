import assert from 'node:assert/strict';
import test from 'node:test';
import { attemptAndAuditSignupReminder, buildSignupReminderAuditEvent } from '../signup-operations-audit.js';

test('reminder audit captures actor and outcome without storing raw email or OTP', () => {
  const event = buildSignupReminderAuditEvent({
    actorUserId: 'platform-admin-id',
    email: ' Admin@Example.Test ',
    outcome: 'delivery-failed',
    requestId: 'request-123',
    auditSecret: 'test-audit-secret',
  });

  assert.equal(event.userId, 'platform-admin-id');
  assert.equal(event.outcome, 'FAILED');
  assert.equal(event.actorRole, 'PLATFORM_ADMIN');
  assert.equal(event.requestId, 'request-123');
  assert.equal(event.resourceId.length, 64);
  assert.doesNotMatch(JSON.stringify(event), /admin@example\.test|123456/);
  assert.match(event.details, /delivery-failed/);
});

test('email pseudonym is stable for a signup and bound to the audit key', () => {
  const build = (email: string, auditSecret: string) => buildSignupReminderAuditEvent({
    actorUserId: 'actor',
    email,
    outcome: 'sent',
    requestId: 'req',
    auditSecret,
  }).resourceId;

  assert.equal(build('Admin@Example.Test', 'key-a'), build('admin@example.test', 'key-a'));
  assert.notEqual(build('admin@example.test', 'key-a'), build('admin@example.test', 'key-b'));
});

test('reminder attempt always audits cooldown and delivery failure outcomes', async () => {
  const auditEvents: Array<ReturnType<typeof buildSignupReminderAuditEvent>> = [];
  const common = {
    actorUserId: 'platform-admin-id',
    email: 'admin@example.test',
    requestId: 'bulk-request-1',
    auditSecret: 'audit-test-key',
    writeAudit: async (event: ReturnType<typeof buildSignupReminderAuditEvent>) => { auditEvents.push(event); },
  };

  const cooldown = await attemptAndAuditSignupReminder({
    ...common,
    isCoolingDown: async () => true,
    sendReminder: async () => { throw new Error('must not send during cooldown'); },
  });
  const deliveryFailure = await attemptAndAuditSignupReminder({
    ...common,
    isCoolingDown: async () => false,
    sendReminder: async () => { throw new Error('SMTP failure'); },
  });

  assert.equal(cooldown.outcome, 'cooldown');
  assert.equal(deliveryFailure.outcome, 'delivery-failed');
  assert.equal(auditEvents.length, 2);
  assert.equal(auditEvents[0]?.requestId, 'bulk-request-1');
  assert.equal(auditEvents[0]?.details.includes('cooldown'), true);
  assert.equal(auditEvents[1]?.details.includes('delivery-failed'), true);
  assert.equal(JSON.stringify(auditEvents).includes('admin@example.test'), false);
});