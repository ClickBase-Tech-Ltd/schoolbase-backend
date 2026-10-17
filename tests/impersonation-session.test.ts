import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { createVerifyAuth } from '../src/middleware/roleAuth.js';
import { getSessionSecret } from '../src/services/security-config.js';

const activeAdminId = randomUUID();
const inactiveAdminId = randomUUID();
const schoolAdminId = randomUUID();
const targetSchoolId = randomUUID();
const missingSchoolId = randomUUID();
const secret = getSessionSecret();
const database = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      if (where.id === activeAdminId) return { id: activeAdminId, schoolId: null, role: 'PLATFORM_ADMIN', isActive: true };
      if (where.id === inactiveAdminId) return { id: inactiveAdminId, schoolId: null, role: 'PLATFORM_ADMIN', isActive: false };
      if (where.id === schoolAdminId) return { id: schoolAdminId, schoolId: targetSchoolId, role: 'SCHOOL_ADMIN', isActive: true };
      return { id: where.id, schoolId: targetSchoolId, role: 'TEACHER', isActive: true };
    },
  },
  guardian: { findUnique: async () => null },
  school: { findUnique: async ({ where }: { where: { id: string } }) => where.id === targetSchoolId ? { id: targetSchoolId } : null },
} as unknown as Pick<PrismaClient, 'user' | 'guardian' | 'school'>;

async function issueToken(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
}

async function authenticate(token: string) {
  let statusCode = 200;
  let responseBody: unknown;
  let nextCalled = false;
  const request = { cookies: { schoolbase_session: token } } as never;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    },
  } as never;
  await createVerifyAuth(database, secret)(request, response, (() => { nextCalled = true; }) as never);
  return { statusCode, responseBody, nextCalled };
}

describe('school impersonation session verification', () => {
  it('accepts an explicitly delegated school-admin session from an active platform admin', async () => {
    const token = await issueToken({
      userId: activeAdminId,
      role: 'SCHOOL_ADMIN',
      schoolId: targetSchoolId,
      sessionPurpose: 'SCHOOL_IMPERSONATION',
    });

    assert.deepEqual(await authenticate(token), { statusCode: 200, responseBody: undefined, nextCalled: true });
  });

  it('continues to accept a normal school-admin session with matching role and school', async () => {
    const token = await issueToken({
      userId: schoolAdminId,
      role: 'SCHOOL_ADMIN',
      schoolId: targetSchoolId,
    });

    assert.deepEqual(await authenticate(token), { statusCode: 200, responseBody: undefined, nextCalled: true });
  });

  it('rejects impersonation sessions from inactive platform admins', async () => {
    const token = await issueToken({
      userId: inactiveAdminId,
      role: 'SCHOOL_ADMIN',
      schoolId: targetSchoolId,
      sessionPurpose: 'SCHOOL_IMPERSONATION',
    });

    const result = await authenticate(token);
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  it('rejects impersonation sessions targeting a missing school', async () => {
    const token = await issueToken({
      userId: activeAdminId,
      role: 'SCHOOL_ADMIN',
      schoolId: missingSchoolId,
      sessionPurpose: 'SCHOOL_IMPERSONATION',
    });

    const result = await authenticate(token);
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  it('does not relax role or school matching for ordinary sessions', async () => {
    const token = await issueToken({
      userId: randomUUID(),
      role: 'SCHOOL_ADMIN',
      schoolId: targetSchoolId,
    });

    const result = await authenticate(token);
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });
});