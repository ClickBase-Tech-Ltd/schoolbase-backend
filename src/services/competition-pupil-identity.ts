import type { PrismaClient } from '@prisma/client';
import { isStudentCurrentlyEnrolled } from './student-lifecycle.js';

export type CompetitionPupilIdentity = {
  userId: string;
  pupilId: string;
  schoolId: string;
  classId: string | null;
};

export type CompetitionGuardianPupilChoice = {
  pupilId: string;
  schoolId: string;
  classId: string | null;
  firstName: string;
  lastName: string;
  className: string | null;
};

export type CompetitionGuardianSession = {
  id: string;
  guardianIds: string[];
  schoolId: string;
};

export async function resolveCompetitionGuardianSession(
  prisma: PrismaClient,
  claims: { guardianId: string; guardianIds?: unknown; schoolId: string },
): Promise<CompetitionGuardianSession | null> {
  if (!claims.guardianId || !claims.schoolId) return null;
  const claimedIds = Array.from(new Set([
    claims.guardianId,
    ...(Array.isArray(claims.guardianIds) ? claims.guardianIds.filter((id): id is string => typeof id === 'string') : []),
  ]));
  const guardians = await prisma.guardian.findMany({
    where: { id: { in: claimedIds }, schoolId: claims.schoolId },
    select: { id: true },
  });
  const guardianIds = guardians.map((guardian) => guardian.id);
  if (!guardianIds.includes(claims.guardianId)) return null;
  return { id: claims.guardianId, guardianIds, schoolId: claims.schoolId };
}

export function selectCompetitionGuardianPupil(
  choices: CompetitionGuardianPupilChoice[],
  pupilId?: string,
): CompetitionGuardianPupilChoice | null {
  if (pupilId) return choices.find((choice) => choice.pupilId === pupilId) ?? null;
  return choices.length === 1 ? choices[0] ?? null : null;
}

export function isEligibleCompetitionPupilLink(input: {
  userRole?: string | null;
  userSchoolId?: string | null;
  pupilSchoolId?: string | null;
  linkSchoolId?: string | null;
  linkStatus?: string | null;
  pupilIsActive?: boolean | null;
  pupilStatus?: string | null;
}): boolean {
  const validRoles = new Set(['STUDENT', 'PARENT']);
  return validRoles.has(input.userRole ?? '') &&
    Boolean(input.userSchoolId) &&
    input.userSchoolId === input.pupilSchoolId &&
    input.userSchoolId === input.linkSchoolId &&
    input.linkStatus === 'ACTIVE' &&
    isStudentCurrentlyEnrolled({ isActive: input.pupilIsActive, status: input.pupilStatus });
}

export async function resolveCompetitionPupilIdentity(
  prisma: PrismaClient,
  authenticatedUserId: string,
): Promise<CompetitionPupilIdentity | null> {
  const user = await prisma.user.findUnique({
    where: { id: authenticatedUserId },
    select: { id: true, role: true, schoolId: true },
  });

  if (!user || !['STUDENT', 'PARENT'].includes(user.role) || !user.schoolId) return null;

  const account = await prisma.competitionPupilAccount.findUnique({
    where: { userId: user.id },
    select: {
      schoolId: true,
      status: true,
      pupil: { select: { id: true, schoolId: true, classId: true, isActive: true, status: true } },
    },
  });

  if (!account || !isEligibleCompetitionPupilLink({
    userRole: user.role,
    userSchoolId: user.schoolId,
    pupilSchoolId: account.pupil.schoolId,
    linkSchoolId: account.schoolId,
    linkStatus: account.status,
    pupilIsActive: account.pupil.isActive,
    pupilStatus: account.pupil.status,
  })) {
    return null;
  }

  return {
    userId: user.id,
    pupilId: account.pupil.id,
    schoolId: user.schoolId,
    classId: account.pupil.classId,
  };
}

export async function resolveCompetitionGuardianPupilChoices(
  prisma: PrismaClient,
  guardianIds: string[],
): Promise<CompetitionGuardianPupilChoice[]> {
  const uniqueGuardianIds = Array.from(new Set(guardianIds.filter(Boolean)));
  if (uniqueGuardianIds.length === 0) return [];

  const guardianPupilLinks = await prisma.guardianPupil.findMany({
    where: {
      guardianId: { in: uniqueGuardianIds },
      pupil: {
        isActive: true,
        OR: [{ status: null }, { status: { not: 'INACTIVE' } }],
      },
    },
    select: {
      guardianId: true,
      guardian: { select: { id: true, schoolId: true } },
      pupil: {
        select: {
          id: true,
          schoolId: true,
          classId: true,
          firstName: true,
          lastName: true,
          isActive: true,
          status: true,
          class: { select: { name: true } },
        },
      },
    },
  });

  const choices = new Map<string, CompetitionGuardianPupilChoice>();
  for (const link of guardianPupilLinks) {
    if (!uniqueGuardianIds.includes(link.guardianId) ||
      link.guardian.schoolId !== link.pupil.schoolId ||
      !isStudentCurrentlyEnrolled({ isActive: link.pupil.isActive, status: link.pupil.status })) continue;
    choices.set(link.pupil.id, {
      pupilId: link.pupil.id,
      schoolId: link.pupil.schoolId,
      classId: link.pupil.classId,
      firstName: link.pupil.firstName,
      lastName: link.pupil.lastName,
      className: link.pupil.class?.name ?? null,
    });
  }
  return Array.from(choices.values());
}