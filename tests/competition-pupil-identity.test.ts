import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import {
  isEligibleCompetitionPupilLink,
  resolveCompetitionGuardianPupilChoices,
  resolveCompetitionGuardianSession,
  resolveCompetitionPupilIdentity,
  selectCompetitionGuardianPupil,
} from '../src/services/competition-pupil-identity.js';

const validLink = {
  userRole: 'STUDENT',
  userSchoolId: 'school-1',
  pupilSchoolId: 'school-1',
  linkSchoolId: 'school-1',
  linkStatus: 'ACTIVE',
  pupilIsActive: true,
  pupilStatus: 'ACTIVE',
};

assert.equal(isEligibleCompetitionPupilLink(validLink), true);
assert.equal(isEligibleCompetitionPupilLink({ ...validLink, userRole: 'PARENT' }), true);
assert.equal(isEligibleCompetitionPupilLink({ ...validLink, userRole: 'SCHOOL_ADMIN' }), false);
assert.equal(isEligibleCompetitionPupilLink({ ...validLink, userSchoolId: 'school-2' }), false);
assert.equal(isEligibleCompetitionPupilLink({ ...validLink, pupilSchoolId: 'school-2' }), false);
assert.equal(isEligibleCompetitionPupilLink({ ...validLink, linkSchoolId: 'school-2' }), false);
assert.equal(isEligibleCompetitionPupilLink({ ...validLink, linkStatus: 'REVOKED' }), false);
assert.equal(isEligibleCompetitionPupilLink({ ...validLink, pupilIsActive: false }), false);
assert.equal(isEligibleCompetitionPupilLink({ ...validLink, pupilStatus: 'INACTIVE' }), false);
assert.equal(isEligibleCompetitionPupilLink({ ...validLink, userSchoolId: null }), false);

const guardianPupilLinks = [
  {
    guardianId: 'guardian-1',
    guardian: { id: 'guardian-1', schoolId: 'school-1' },
    pupil: { id: 'pupil-1', schoolId: 'school-1', classId: 'class-1', firstName: 'Ada', lastName: 'One', isActive: true, status: 'ACTIVE', class: { name: 'Year 1' } },
  },
  {
    guardianId: 'guardian-2',
    guardian: { id: 'guardian-2', schoolId: 'school-1' },
    pupil: { id: 'pupil-2', schoolId: 'school-1', classId: null, firstName: 'Ben', lastName: 'Two', isActive: true, status: null, class: null },
  },
  {
    guardianId: 'guardian-1',
    guardian: { id: 'guardian-1', schoolId: 'school-1' },
    pupil: { id: 'pupil-3', schoolId: 'school-2', classId: null, firstName: 'Cross', lastName: 'School', isActive: true, status: null, class: null },
  },
  {
    guardianId: 'guardian-1',
    guardian: { id: 'guardian-1', schoolId: 'school-1' },
    pupil: { id: 'pupil-4', schoolId: 'school-1', classId: null, firstName: 'Inactive', lastName: 'Pupil', isActive: false, status: 'INACTIVE', class: null },
  },
  {
    guardianId: 'guardian-foreign',
    guardian: { id: 'guardian-foreign', schoolId: 'school-1' },
    pupil: { id: 'pupil-5', schoolId: 'school-1', classId: null, firstName: 'Not in family', lastName: 'Pupil', isActive: true, status: 'ACTIVE', class: null },
  },
];
const guardianPupilQueries: unknown[] = [];
const guardianPrisma = {
  guardianPupil: {
    findMany: async (args: unknown) => {
      guardianPupilQueries.push(args);
      return guardianPupilLinks;
    },
  },
} as unknown as PrismaClient;
const validGuardianChoices = await resolveCompetitionGuardianPupilChoices(guardianPrisma, ['guardian-1', 'guardian-2', 'guardian-1']);
assert.deepEqual(validGuardianChoices, [
  { pupilId: 'pupil-1', schoolId: 'school-1', classId: 'class-1', firstName: 'Ada', lastName: 'One', className: 'Year 1' },
  { pupilId: 'pupil-2', schoolId: 'school-1', classId: null, firstName: 'Ben', lastName: 'Two', className: null },
]);
assert.deepEqual(guardianPupilQueries[0], {
  where: {
    guardianId: { in: ['guardian-1', 'guardian-2'] },
    pupil: { isActive: true, OR: [{ status: null }, { status: { not: 'INACTIVE' } }] },
  },
  select: {
    guardianId: true,
    guardian: { select: { id: true, schoolId: true } },
    pupil: { select: { id: true, schoolId: true, classId: true, firstName: true, lastName: true, isActive: true, status: true, class: { select: { name: true } } } },
  },
});
assert.equal(selectCompetitionGuardianPupil(validGuardianChoices), null);
assert.equal(selectCompetitionGuardianPupil(validGuardianChoices, 'pupil-2')?.pupilId, 'pupil-2');
assert.equal(selectCompetitionGuardianPupil(validGuardianChoices, 'pupil-outside-family'), null);
assert.equal(selectCompetitionGuardianPupil([validGuardianChoices[0]!])?.pupilId, 'pupil-1');
assert.deepEqual(await resolveCompetitionGuardianPupilChoices(guardianPrisma, []), []);

const sessionPrisma = {
  guardian: {
    findMany: async () => [{ id: 'guardian-1' }, { id: 'guardian-2' }],
  },
} as unknown as PrismaClient;
assert.deepEqual(await resolveCompetitionGuardianSession(sessionPrisma, {
  guardianId: 'guardian-1',
  guardianIds: ['guardian-2', 'guardian-2', 12],
  schoolId: 'school-1',
}), { id: 'guardian-1', guardianIds: ['guardian-1', 'guardian-2'], schoolId: 'school-1' });
const foreignOnlySessionPrisma = {
  guardian: { findMany: async () => [{ id: 'guardian-2' }] },
} as unknown as PrismaClient;
assert.equal(await resolveCompetitionGuardianSession(foreignOnlySessionPrisma, {
  guardianId: 'guardian-1', guardianIds: ['guardian-2'], schoolId: 'school-1',
}), null);

const queries: Array<{ kind: string; args: unknown }> = [];
const prisma = {
  user: {
    findUnique: async (args: unknown) => {
      queries.push({ kind: 'user', args });
      return { id: 'user-1', role: 'STUDENT', schoolId: 'school-1' };
    },
  },
  competitionPupilAccount: {
    findUnique: async (args: unknown) => {
      queries.push({ kind: 'link', args });
      return {
        schoolId: 'school-1',
        status: 'ACTIVE',
        pupil: { id: 'pupil-1', schoolId: 'school-1', classId: 'class-1', isActive: true, status: null },
      };
    },
  },
} as unknown as PrismaClient;

const identity = await resolveCompetitionPupilIdentity(prisma, 'user-1');
assert.deepEqual(identity, {
  userId: 'user-1',
  pupilId: 'pupil-1',
  schoolId: 'school-1',
  classId: 'class-1',
});
assert.deepEqual(queries.map((query) => query.kind), ['user', 'link']);
assert.deepEqual(queries[1].args, {
  where: { userId: 'user-1' },
  select: {
    schoolId: true,
    status: true,
    pupil: { select: { id: true, schoolId: true, classId: true, isActive: true, status: true } },
  },
});

function prismaWithIdentity(user: unknown, account: unknown) {
  return {
    user: { findUnique: async () => user },
    competitionPupilAccount: { findUnique: async () => account },
  } as unknown as PrismaClient;
}

const enrolledPupil = {
  id: 'pupil-1',
  schoolId: 'school-1',
  classId: null,
  isActive: true,
  status: null,
};
const studentUser = { id: 'user-1', role: 'STUDENT', schoolId: 'school-1' };
const parentUser = { id: 'parent-1', role: 'PARENT', schoolId: 'school-1' };
const activeLink = { schoolId: 'school-1', status: 'ACTIVE', pupil: enrolledPupil };

assert.deepEqual(await resolveCompetitionPupilIdentity(prismaWithIdentity(parentUser, activeLink), 'parent-1'), {
  userId: 'parent-1',
  pupilId: 'pupil-1',
  schoolId: 'school-1',
  classId: null,
});
assert.equal(await resolveCompetitionPupilIdentity(prismaWithIdentity(null, activeLink), 'missing-user'), null);
assert.equal(await resolveCompetitionPupilIdentity(prismaWithIdentity({ ...studentUser, role: 'TEACHER' }, activeLink), 'user-1'), null);
assert.equal(await resolveCompetitionPupilIdentity(prismaWithIdentity({ ...studentUser, schoolId: null }, activeLink), 'user-1'), null);
assert.equal(await resolveCompetitionPupilIdentity(prismaWithIdentity(studentUser, null), 'user-1'), null);
assert.equal(await resolveCompetitionPupilIdentity(prismaWithIdentity(studentUser, { ...activeLink, status: 'REVOKED' }), 'user-1'), null);
assert.equal(await resolveCompetitionPupilIdentity(prismaWithIdentity(studentUser, { ...activeLink, schoolId: 'school-2' }), 'user-1'), null);
assert.equal(await resolveCompetitionPupilIdentity(prismaWithIdentity(studentUser, { ...activeLink, pupil: { ...enrolledPupil, schoolId: 'school-2' } }), 'user-1'), null);
assert.equal(await resolveCompetitionPupilIdentity(prismaWithIdentity(studentUser, { ...activeLink, pupil: { ...enrolledPupil, status: 'INACTIVE' } }), 'user-1'), null);
assert.equal(await resolveCompetitionPupilIdentity(prismaWithIdentity(studentUser, { ...activeLink, pupil: { ...enrolledPupil, isActive: false } }), 'user-1'), null);

console.log('Competition pupil identity tests passed');