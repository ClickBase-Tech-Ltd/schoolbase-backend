import assert from 'node:assert/strict';
import { adminRouteAccess, isAdminRouteAllowed } from '../src/services/admin-route-access.js';

assert.equal(adminRouteAccess('/fees/data', 'GET'), 'ACCOUNTING');
assert.equal(adminRouteAccess('/invoices/invoice-1', 'GET'), 'ACCOUNTING');
assert.equal(adminRouteAccess('/school/school-1', 'GET'), 'ACCOUNTING');
assert.equal(adminRouteAccess('/students/data', 'GET'), 'SCHOOL_ADMIN');
assert.equal(adminRouteAccess('/staff-attendance', 'GET'), 'SCHOOL_ADMIN');
assert.equal(adminRouteAccess('/staff-attendance/policy', 'PUT'), 'SCHOOL_ADMIN');
assert.equal(adminRouteAccess('/staff-attendance/attendance-1/events', 'GET'), 'SCHOOL_ADMIN');
assert.equal(adminRouteAccess('/platform/overview', 'GET'), 'PLATFORM_ADMIN');
assert.equal(adminRouteAccess('/school-logo/school-1', 'GET'), 'AUTHENTICATED_SCHOOL');
assert.equal(adminRouteAccess('/verify', 'POST'), 'PUBLIC');
assert.equal(adminRouteAccess('/impersonate', 'POST'), 'SIGNED_TOKEN');

for (const role of ['TEACHER', 'PARENT', 'STUDENT', 'PLATFORM_ADMIN', undefined]) {
  assert.equal(isAdminRouteAllowed('ACCOUNTING', role), false, `${role} must not enter the Bursar API`);
}
assert.equal(isAdminRouteAllowed('ACCOUNTING', 'BURSAR'), true);
assert.equal(isAdminRouteAllowed('ACCOUNTING', 'SCHOOL_ADMIN'), true);
assert.equal(isAdminRouteAllowed('SCHOOL_ADMIN', 'SCHOOL_ADMIN'), true);
assert.equal(isAdminRouteAllowed(adminRouteAccess('/staff-attendance', 'GET'), 'SCHOOL_ADMIN'), true);
for (const role of ['BURSAR', 'TEACHER', 'PARENT', 'STUDENT', 'PLATFORM_ADMIN', undefined]) {
  assert.equal(isAdminRouteAllowed('SCHOOL_ADMIN', role), false, `${role} must not enter School Admin APIs`);
}
assert.equal(isAdminRouteAllowed('SCHOOL_ADMIN', 'STAFF'), false, 'STAFF must not enter School Admin APIs');
assert.equal(isAdminRouteAllowed('PLATFORM_ADMIN', 'PLATFORM_ADMIN'), true);
assert.equal(isAdminRouteAllowed('PLATFORM_ADMIN', 'SCHOOL_ADMIN'), false);
assert.equal(isAdminRouteAllowed('AUTHENTICATED_SCHOOL', 'TEACHER'), true);
assert.equal(isAdminRouteAllowed('AUTHENTICATED_SCHOOL', undefined), false);

console.log('Admin route access tests passed');