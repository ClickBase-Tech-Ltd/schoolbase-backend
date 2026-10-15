import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdmissionInboxWhere, buildAdmissionNotificationRecipientWhere } from '../admission-notification-access.js';

test('admission inbox queries are scoped to one school and recipient', () => {
  assert.deepEqual(buildAdmissionInboxWhere('school-a', 'admin-a'), {
    schoolId: 'school-a',
    recipientUserId: 'admin-a',
  });
  assert.notDeepEqual(buildAdmissionInboxWhere('school-a', 'admin-a'), buildAdmissionInboxWhere('school-b', 'admin-a'));
  assert.notDeepEqual(buildAdmissionInboxWhere('school-a', 'admin-a'), buildAdmissionInboxWhere('school-a', 'admin-b'));
});

test('mark-read lookup requires notification, school, and recipient to match', () => {
  assert.deepEqual(buildAdmissionNotificationRecipientWhere('notice-a', 'school-a', 'admin-a'), {
    id: 'notice-a',
    schoolId: 'school-a',
    recipientUserId: 'admin-a',
  });
});
