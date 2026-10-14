import assert from 'node:assert/strict';
import { classifyPlatformAuditEvent, normalizeLegacyPlatformAuditEvent, safeAuditPath } from '../src/services/platform-audit-events.js';
import { classifyPlatformAuditEvent, extractPlatformAuditResourceId, inferPlatformAuditOutcome, normalizeLegacyPlatformAuditEvent, safeAuditPath } from '../src/services/platform-audit-events.js';

assert.deepEqual(classifyPlatformAuditEvent('POST', '/schoolbase-admin/api/signups/approve'), {
  category: 'SCHOOL',
  action: 'school.signup.approved',
  resourceType: 'School signup',
  summary: 'Approved a school signup',
});

assert.deepEqual(classifyPlatformAuditEvent('POST', '/schoolbase-admin/api/admin/verify'), {
  category: 'SCHOOL',
  action: 'school.verification.updated',
  resourceType: 'School verification',
  summary: 'Updated school verification',
});

assert.deepEqual(classifyPlatformAuditEvent('POST', '/schoolbase-admin/api/ads/campaigns/cmv123456789012345678/submit'), {
  category: 'MARKETING',
  action: 'campaign.submitted',
  resourceType: 'Advertising campaign',
  summary: 'Submitted an advertising campaign for review',
});

assert.deepEqual(classifyPlatformAuditEvent('POST', '/api/competition/school/tournaments/cmv123456789012345678/register'), {
  category: 'COMPETITION',
  action: 'tournament.participation.requested',
  resourceType: 'Tournament participation',
  summary: 'Accepted or requested tournament participation',
});

assert.deepEqual(classifyPlatformAuditEvent('POST', '/api/competition/school/tournaments/cmv123456789012345678/nominations'), {
  category: 'COMPETITION',
  action: 'tournament.pupils.nominated',
  resourceType: 'Tournament nominations',
  summary: 'Nominated students for a tournament',
});

assert.deepEqual(normalizeLegacyPlatformAuditEvent('API_POST_schoolbase-admin_api_signups_approve', 'POST /schoolbase-admin/api/signups/approve?email=private@example.com | status: 201'), {
  category: 'SCHOOL',
  action: 'school.signup.approved',
  resourceType: 'School signup',
  summary: 'Approved a school signup',
});

assert.equal(safeAuditPath('/api/students/cmv123456789012345678?PupilId=secret-id'), '/api/students/:id');
assert.equal(safeAuditPath('/api/payments/1234567890123456/confirm'), '/api/payments/:id/confirm');
assert.equal(extractPlatformAuditResourceId('/api/students/cmv123456789012345678?PupilId=secret-id'), 'cmv123456789012345678');
assert.equal(inferPlatformAuditOutcome('LOGIN_SUCCESS', null), 'SUCCESS');
assert.equal(inferPlatformAuditOutcome('PARENT_LOGIN_FAILED', null), 'FAILED');
assert.equal(inferPlatformAuditOutcome('API_POST_api_students', 'POST /api/students | status: 201'), 'SUCCESS');
assert.equal(inferPlatformAuditOutcome('API_POST_api_students', 'POST /api/students | status: 403'), 'REJECTED');
assert.equal(inferPlatformAuditOutcome('OLD_EVENT', 'legacy details'), 'NOT_RECORDED');

console.log('Platform audit event tests passed');