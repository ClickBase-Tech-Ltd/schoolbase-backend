import type { Prisma } from '@prisma/client';

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function inferStaffPrefix(schoolName?: string | null, schoolInitials?: string | null) {
  const configured = (schoolInitials || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (configured) return configured.slice(0, 8);

  const words = (schoolName || '').trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return 'SCH';
  const initials = words.slice(0, 4).map((word) => word[0]).join('').toUpperCase();
  return initials || 'SCH';
}

export function formatStaffNumber(prefix: string, year: number, sequence: number) {
  const normalizedPrefix = prefix.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'SCH';
  return `${normalizedPrefix}/ST/${year}/${String(sequence).padStart(5, '0')}`;
}

export function parseStaffNumberSequence(staffNumber: string, prefix: string, year: number) {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}/ST/${year}/(\\d{5,})$`, 'i');
  const match = staffNumber.trim().match(pattern);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

export async function reserveNextStaffNumber({
  transaction,
  schoolId,
  schoolName,
  schoolInitials,
  year = new Date().getFullYear(),
}: {
  transaction: Prisma.TransactionClient;
  schoolId: string;
  schoolName?: string | null;
  schoolInitials?: string | null;
  year?: number;
}) {
  const prefix = inferStaffPrefix(schoolName, schoolInitials);
  await transaction.staffNumberCounter.upsert({
    where: { schoolId_year: { schoolId, year } },
    update: {},
    create: { schoolId, year, lastSeq: 0 },
  });

  const rows = await transaction.$queryRawUnsafe<Array<{ lastSeq: number }>>(
    'SELECT lastSeq FROM StaffNumberCounter WHERE schoolId = ? AND year = ? FOR UPDATE',
    schoolId,
    year,
  );
  const storedSequence = rows[0]?.lastSeq || 0;
  const profileNumbers = await transaction.employeeProfile.findMany({
    where: { schoolId, staffNumber: { startsWith: `${prefix}/ST/${year}/` } },
    select: { staffNumber: true },
  });
  const highestExisting = profileNumbers.reduce((highest, profile) => {
    const sequence = parseStaffNumberSequence(profile.staffNumber, prefix, year);
    return sequence === null ? highest : Math.max(highest, sequence);
  }, 0);
  const nextSequence = Math.max(storedSequence, highestExisting) + 1;
  await transaction.staffNumberCounter.update({
    where: { schoolId_year: { schoolId, year } },
    data: { lastSeq: nextSequence },
  });
  return formatStaffNumber(prefix, year, nextSequence);
}
