import test from 'node:test';
import assert from 'node:assert/strict';
import { findAdmissionByRequestKey, findSchoolScopedAdmissionApplication } from '../admission-application-access.js';

test('duplicate submission lookup always combines request key with the active school', async () => {
  let query: any;
  const prisma = {
    admissionApplication: {
      findFirst: async (args: any) => {
        query = args;
        return { id: 'application-a', schoolId: 'school-a', requestKey: 'request-1' };
      },
    },
  };

  const application = await findAdmissionByRequestKey(prisma, 'school-a', 'request-1', {
    where: { schoolId: 'attacker-supplied-school' },
    select: { id: true, status: true },
  });

  assert.deepEqual(query, {
    where: { schoolId: 'school-a', requestKey: 'request-1' },
    select: { id: true, status: true },
  });
  assert.equal(application.id, 'application-a');
});

test('individual application lookup always pins ID to authenticated school', async () => {
  let query: any;
  const prisma = {
    admissionApplication: {
      findFirst: async (args: any) => {
        query = args;
        return null;
      },
    },
  };

  await findSchoolScopedAdmissionApplication(prisma, 'school-a', 'application-from-b', {
    where: { status: 'SUBMITTED', schoolId: 'attacker-supplied-school' },
    select: { id: true, status: true },
  });

  assert.deepEqual(query, {
    where: { status: 'SUBMITTED', id: 'application-from-b', schoolId: 'school-a' },
    select: { id: true, status: true },
  });
});

test('a missing same-school application remains unavailable', async () => {
  const prisma = {
    admissionApplication: { findFirst: async () => null },
  };

  const result = await findSchoolScopedAdmissionApplication(prisma, 'school-a', 'application-from-b');

  assert.equal(result, null);
});
