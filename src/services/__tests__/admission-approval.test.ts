import test from 'node:test';
import assert from 'node:assert/strict';
import { findCompletedAdmissionConversion } from '../admission-approval.js';

const schoolId = 'school-a';
const applicationId = 'application-1';

 test('completed approval recovery returns the pupil linked to the same-school application', async () => {
  const calls: Record<string, any> = {};
  const prisma = {
    admissionApplication: {
      findFirst: async (args: unknown) => {
        calls.applicationLookup = args;
        return { id: applicationId, schoolId, studentId: 'pupil-1', status: 'APPROVED' };
      },
    },
    pupil: {
      findFirst: async (args: unknown) => {
        calls.pupilLookup = args;
        return { id: 'pupil-1', admissionNo: 'GFA-2026-0001', firstName: 'Amina', lastName: 'Okafor' };
      },
    },
  };

  const result = await findCompletedAdmissionConversion(prisma, schoolId, applicationId);

  assert.deepEqual(calls.applicationLookup.where, {
    id: applicationId,
    schoolId,
    status: 'APPROVED',
    studentId: { not: null },
  });
  assert.deepEqual(calls.pupilLookup.where, { id: 'pupil-1', schoolId });
  assert.equal(result?.student.admissionNo, 'GFA-2026-0001');
});

test('approval recovery never returns an application or pupil from another school', async () => {
  let pupilLookups = 0;
  const prisma = {
    admissionApplication: {
      findFirst: async (args: any) => {
        assert.equal(args.where.schoolId, schoolId);
        return null;
      },
    },
    pupil: {
      findFirst: async () => {
        pupilLookups += 1;
        return { id: 'pupil-from-school-b' };
      },
    },
  };

  const result = await findCompletedAdmissionConversion(prisma, schoolId, applicationId);

  assert.equal(result, null);
  assert.equal(pupilLookups, 0);
});

test('approval recovery refuses a dangling or cross-school pupil link', async () => {
  let pupilQuery: any;
  const prisma = {
    admissionApplication: {
      findFirst: async () => ({ id: applicationId, schoolId, studentId: 'pupil-1', status: 'APPROVED' }),
    },
    pupil: {
      findFirst: async (args: unknown) => {
        pupilQuery = args;
        return null;
      },
    },
  };

  const result = await findCompletedAdmissionConversion(prisma, schoolId, applicationId);

  assert.deepEqual(pupilQuery.where, { id: 'pupil-1', schoolId });
  assert.equal(result, null);
});
