import type { Prisma } from '@prisma/client';

export type StudentEnrollmentStatus = 'ACTIVE' | 'INACTIVE';

export function normalizeStudentEnrollmentStatus(value: unknown): StudentEnrollmentStatus | null {
  const status = String(value ?? '').trim().toUpperCase();
  return status === 'ACTIVE' || status === 'INACTIVE' ? status : null;
}

export function isStudentCurrentlyEnrolled(student: { isActive?: boolean | null; status?: string | null }): boolean {
  return student.isActive !== false && normalizeStudentEnrollmentStatus(student.status) !== 'INACTIVE';
}

export function filterActiveStudents<T extends { isActive?: boolean | null; status?: string | null }>(students: T[]): T[] {
  return students.filter((student) => isStudentCurrentlyEnrolled(student));
}

export function buildActiveStudentWhere(schoolId: string): Prisma.PupilWhereInput {
  return {
    schoolId,
    isActive: true,
    OR: [{ status: null }, { status: { not: 'INACTIVE' } }],
  };
}

export function buildStudentRosterWhere(schoolId: string, status: StudentEnrollmentStatus): Prisma.PupilWhereInput {
  if (status === 'INACTIVE') {
    return { schoolId, OR: [{ isActive: false }, { status: 'INACTIVE' }] };
  }

  return buildActiveStudentWhere(schoolId);
}