import assert from 'node:assert/strict';
import type { Response } from 'express';

process.env.SESSION_SECRET ??= 'accounting-access-test-secret';

const { requireAccountingAccess, requireAdmin, requireBursar, requireParent, requireTeacher } = await import('../src/middleware/roleAuth.js');
type AuthenticatedRequest = import('../src/middleware/roleAuth.js').AuthenticatedRequest;

function authorize(middleware: typeof requireAccountingAccess, role?: string) {
  let statusCode: number | null = null;
  let responseBody: unknown;
  let nextCalled = false;
  const request = {
    user: role ? { role } : undefined,
  } as unknown as AuthenticatedRequest;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    },
  } as unknown as Response;

  middleware(request, response, () => {
    nextCalled = true;
  });

  return { statusCode, responseBody, nextCalled };
}

const roles = ['SCHOOL_ADMIN', 'BURSAR', 'TEACHER', 'PARENT', 'STUDENT', 'PLATFORM_ADMIN'];
const denied = (role: string) => ({
  statusCode: 403,
  responseBody: { error: 'Forbidden: Accounting access required' },
  nextCalled: false,
});

assert.deepEqual(authorize(requireAccountingAccess, 'SCHOOL_ADMIN'), { statusCode: null, responseBody: undefined, nextCalled: true });
assert.deepEqual(authorize(requireAccountingAccess, 'BURSAR'), { statusCode: null, responseBody: undefined, nextCalled: true });
for (const role of roles.filter((candidate) => !['SCHOOL_ADMIN', 'BURSAR'].includes(candidate))) {
  assert.deepEqual(authorize(requireAccountingAccess, role), denied(role));
}
assert.deepEqual(authorize(requireAccountingAccess), {
  statusCode: 401,
  responseBody: { error: 'Not authenticated' },
  nextCalled: false,
});

assert.deepEqual(authorize(requireAdmin, 'SCHOOL_ADMIN'), { statusCode: null, responseBody: undefined, nextCalled: true });
for (const role of roles.filter((candidate) => candidate !== 'SCHOOL_ADMIN')) {
  assert.equal(authorize(requireAdmin, role).statusCode, 403, `${role} must be denied school-admin middleware`);
}
assert.deepEqual(authorize(requireBursar, 'BURSAR'), { statusCode: null, responseBody: undefined, nextCalled: true });
for (const role of roles.filter((candidate) => candidate !== 'BURSAR')) {
  assert.equal(authorize(requireBursar, role).statusCode, 403, `${role} must be denied Bursar middleware`);
}
assert.deepEqual(authorize(requireTeacher, 'TEACHER'), { statusCode: null, responseBody: undefined, nextCalled: true });
for (const role of roles.filter((candidate) => candidate !== 'TEACHER')) {
  assert.equal(authorize(requireTeacher, role).statusCode, 403, `${role} must be denied Teacher middleware`);
}
assert.deepEqual(authorize(requireParent, 'PARENT'), { statusCode: null, responseBody: undefined, nextCalled: true });
for (const role of roles.filter((candidate) => candidate !== 'PARENT')) {
  assert.equal(authorize(requireParent, role).statusCode, 403, `${role} must be denied Parent middleware`);
}

console.log('Accounting access tests passed');
