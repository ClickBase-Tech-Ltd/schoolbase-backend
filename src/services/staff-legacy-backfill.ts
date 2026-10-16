export type LegacyStaffUser = {
  id: string;
  schoolId: string | null;
  name: string;
  role: string;
  createdAt: Date;
  isActive: boolean;
};

export type StaffBackfillCandidate = {
  userId: string;
  schoolId: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  jobTitle: string;
  classification: 'ACADEMIC' | 'NON_ACADEMIC';
  employmentStatus: 'ACTIVE';
  employmentType: 'FULL_TIME';
  startDate: Date;
};

export type StaffBackfillSkip = { userId: string; reason: string };

export function planLegacyStaffBackfill(users: LegacyStaffUser[]) {
  const candidates: StaffBackfillCandidate[] = [];
  const skipped: StaffBackfillSkip[] = [];

  for (const user of users) {
    if (!user.schoolId) {
      skipped.push({ userId: user.id, reason: 'No school association' });
      continue;
    }
    if (!user.isActive) {
      skipped.push({ userId: user.id, reason: 'Inactive account requires administrator review' });
      continue;
    }
    if (user.role !== 'TEACHER' && user.role !== 'BURSAR') {
      skipped.push({ userId: user.id, reason: 'Role is not safely classifiable by the automatic backfill' });
      continue;
    }

    const nameParts = user.name.trim().split(/\s+/).filter(Boolean);
    const honorifics = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'professor', 'rev', 'revd', 'pastor', 'imam', 'chief', 'engr', 'hon', 'sir', 'dame']);
    while (nameParts.length > 0 && honorifics.has(nameParts[0].replace(/\.+$/, '').toLowerCase())) nameParts.shift();
    if (nameParts.length < 2) {
      skipped.push({ userId: user.id, reason: 'Name is ambiguous after removing honorifics' });
      continue;
    }

    const [firstName, ...remainingNameParts] = nameParts;
    const lastName = remainingNameParts.pop();
    if (!lastName) {
      skipped.push({ userId: user.id, reason: 'Name does not contain a last name' });
      continue;
    }

    const startDate = new Date(Date.UTC(
      user.createdAt.getUTCFullYear(),
      user.createdAt.getUTCMonth(),
      user.createdAt.getUTCDate(),
    ));
    candidates.push({
      userId: user.id,
      schoolId: user.schoolId,
      firstName,
      middleName: remainingNameParts.join(' ') || null,
      lastName,
      jobTitle: user.role === 'TEACHER' ? 'Teacher' : 'Bursar',
      classification: user.role === 'TEACHER' ? 'ACADEMIC' : 'NON_ACADEMIC',
      employmentStatus: 'ACTIVE',
      employmentType: 'FULL_TIME',
      startDate,
    });
  }

  return { candidates, skipped };
}
