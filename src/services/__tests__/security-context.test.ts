import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchoolAdminMembershipWhere, resolveSchoolScope } from '../security-context.js';

test('admissions admin membership is constrained by user, school, and exact role', () => {
  assert.deepEqual(buildSchoolAdminMembershipWhere('admin-a', 'school-a'), {
    id: 'admin-a',
    schoolId: 'school-a',
    role: 'SCHOOL_ADMIN',
  });
  assert.notDeepEqual(buildSchoolAdminMembershipWhere('admin-a', 'school-a'), buildSchoolAdminMembershipWhere('admin-a', 'school-b'));
  assert.notDeepEqual(buildSchoolAdminMembershipWhere('admin-a', 'school-a'), {
    id: 'admin-a',
    schoolId: 'school-a',
    role: 'TEACHER',
  });
});

test('school users are pinned to their authenticated school', () => {
  assert.deepEqual(
    resolveSchoolScope({
      authenticatedSchoolId: 'school-a',
      authenticatedRole: 'SCHOOL_ADMIN',
      requestedSchoolId: 'school-b',
    }),
    {
      schoolId: null,
      rejected: true,
      reason: 'Requested school does not match the authenticated school',
    },
  );
});

test('matching requested school is accepted for school users', () => {
  assert.deepEqual(
    resolveSchoolScope({
      authenticatedSchoolId: 'school-a',
      authenticatedRole: 'TEACHER',
      requestedSchoolId: 'school-a',
    }),
    { schoolId: 'school-a', rejected: false },
  );
});

test('platform admins may target an explicitly requested school', () => {
  assert.deepEqual(
    resolveSchoolScope({
      authenticatedSchoolId: 'platform',
      authenticatedRole: 'PLATFORM_ADMIN',
      requestedSchoolId: 'school-b',
    }),
    { schoolId: 'school-b', rejected: false },
  );
});

test('missing context remains unresolved instead of guessing a tenant', () => {
  assert.deepEqual(resolveSchoolScope({ requestedSchoolId: 'school-a' }), {
    schoolId: null,
    rejected: false,
  });
});

test('unknown roles are treated as untrusted and do not resolve a school scope', () => {
  assert.deepEqual(
    resolveSchoolScope({
      authenticatedSchoolId: 'school-a',
      authenticatedRole: 'unknown-role',
    }),
    {
      schoolId: null,
      rejected: false,
    },
  );
});
