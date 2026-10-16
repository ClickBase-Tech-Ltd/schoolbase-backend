import { PrismaClient } from '@prisma/client';
import { planLegacyStaffBackfill } from '../src/services/staff-legacy-backfill.js';
import { reserveNextStaffNumber } from '../src/services/staff-number.js';

const prisma = new PrismaClient();
const applyChanges = process.argv.includes('--apply');
const confirmed = process.argv.includes('--confirm-school-scoped-backfill');

async function main() {
  if (applyChanges && !confirmed) {
    throw new Error('Refusing to write without --confirm-school-scoped-backfill. Run once without --apply to review the dry-run first.');
  }

  const users = await prisma.user.findMany({
    where: { schoolId: { not: null }, role: { in: ['TEACHER', 'BURSAR'] } },
    orderBy: [{ schoolId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, schoolId: true, name: true, role: true, createdAt: true, isActive: true },
  });
  const existingProfiles = await prisma.employeeProfile.findMany({
    where: { userId: { in: users.map((user) => user.id) } },
    select: { userId: true },
  });
  const legacyProfiles = await prisma.employeeProfile.findMany({
    where: { staffNumber: { startsWith: 'LEGACY-' } },
    orderBy: [{ schoolId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      schoolId: true,
      staffNumber: true,
      firstName: true,
      middleName: true,
      lastName: true,
      jobTitle: true,
      employmentStatus: true,
      startDate: true,
      school: { select: { name: true, initials: true } },
    },
  });
  const existingUserIds = new Set(existingProfiles.map((profile) => profile.userId));
  const plan = planLegacyStaffBackfill(users);
  const candidates = plan.candidates.filter((candidate) => !existingUserIds.has(candidate.userId));
  const alreadyLinked = plan.candidates.length - candidates.length;

  const report = {
    mode: applyChanges ? 'APPLY' : 'DRY_RUN',
    eligibleAccounts: candidates.length,
    alreadyLinked,
    legacyStaffNumbersToReplace: legacyProfiles.length,
    ...(!applyChanges ? { skipped: plan.skipped } : {}),
    ...(!applyChanges ? { candidates: candidates.map(({ userId, schoolId, firstName, middleName, lastName, jobTitle, classification, startDate }) => ({
      userId,
      schoolId,
      staffNumber: 'Assigned on apply',
      name: [firstName, middleName, lastName].filter(Boolean).join(' '),
      jobTitle,
      classification,
      startDate: startDate.toISOString().slice(0, 10),
    })) } : {}),
  };
  if (applyChanges) {
    const skipReasons: Record<string, number> = {};
    for (const item of plan.skipped) skipReasons[item.reason] = (skipReasons[item.reason] || 0) + 1;
    console.log(JSON.stringify({ ...report, skippedCount: plan.skipped.length, skipReasons }, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  if (!applyChanges) {
    console.log('Dry run only. No records were written. Review candidates and skips, then rerun with --apply --confirm-school-scoped-backfill.');
    return;
  }

  let created = 0;
  let renumbered = 0;
  let newlyLinked = 0;
  let failures = 0;
  for (const profile of legacyProfiles) {
    try {
      await prisma.$transaction(async (tx) => {
        const current = await tx.employeeProfile.findFirst({
          where: { id: profile.id, schoolId: profile.schoolId, staffNumber: { startsWith: 'LEGACY-' } },
          select: { id: true, staffNumber: true },
        });
        if (!current) return;
        const staffNumber = await reserveNextStaffNumber({
          transaction: tx,
          schoolId: profile.schoolId,
          schoolName: profile.school.name,
          schoolInitials: profile.school.initials,
        });
        await tx.employeeProfile.update({ where: { id: current.id }, data: { staffNumber } });
        await tx.staffEmploymentEvent.create({
          data: {
            schoolId: profile.schoolId,
            employeeId: current.id,
            eventType: 'STAFF_NUMBER_ASSIGNED',
            effectiveAt: new Date(),
            reason: 'Replaced temporary legacy staff number with the school standard.',
            previousStatus: profile.employmentStatus,
            nextStatus: profile.employmentStatus,
            previousJobTitle: profile.jobTitle,
            nextJobTitle: profile.jobTitle,
            previousStaffNumber: current.staffNumber,
            nextStaffNumber: staffNumber,
          },
        });
        renumbered += 1;
      });
    } catch (error) {
      failures += 1;
      console.error(JSON.stringify({ profileId: profile.id, error: error instanceof Error ? error.message : 'Unknown staff-number update error' }));
    }
  }

  for (const candidate of candidates) {
    try {
      await prisma.$transaction(async (tx) => {
        const currentUser = await tx.user.findFirst({
          where: { id: candidate.userId, schoolId: candidate.schoolId, role: { in: ['TEACHER', 'BURSAR'] }, isActive: true },
          select: { id: true, name: true, createdAt: true },
        });
        if (!currentUser) throw new Error('Account no longer matches the approved active same-school candidate.');
        const currentProfile = await tx.employeeProfile.findUnique({ where: { userId: currentUser.id }, select: { id: true } });
        if (currentProfile) {
          newlyLinked += 1;
          return;
        }

        const school = await tx.school.findUnique({ where: { id: candidate.schoolId }, select: { name: true, initials: true } });
        if (!school) throw new Error('School no longer exists.');
        const staffNumber = await reserveNextStaffNumber({ transaction: tx, schoolId: candidate.schoolId, schoolName: school.name, schoolInitials: school.initials });
        const employee = await tx.employeeProfile.create({
          data: {
            schoolId: candidate.schoolId,
            userId: candidate.userId,
            staffNumber,
            firstName: candidate.firstName,
            middleName: candidate.middleName,
            lastName: candidate.lastName,
            jobTitle: candidate.jobTitle,
            classification: candidate.classification,
            employmentType: candidate.employmentType,
            employmentStatus: candidate.employmentStatus,
            startDate: candidate.startDate,
          },
          select: { id: true },
        });
        await tx.staffEmploymentEvent.create({
          data: {
            schoolId: candidate.schoolId,
            employeeId: employee.id,
            eventType: 'LEGACY_IMPORT',
            effectiveAt: candidate.startDate,
            nextStatus: 'ACTIVE',
            nextJobTitle: candidate.jobTitle,
            nextStaffNumber: staffNumber,
          },
        });
        created += 1;
      });
    } catch (error) {
      failures += 1;
      console.error(JSON.stringify({ userId: candidate.userId, schoolId: candidate.schoolId, error: error instanceof Error ? error.message : 'Unknown backfill error' }));
    }
  }

  console.log(JSON.stringify({ completed: failures === 0, created, renumbered, alreadyLinkedDuringApply: newlyLinked, failed: failures, attempted: candidates.length + legacyProfiles.length }));
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Staff backfill failed.');
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
