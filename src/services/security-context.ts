export type SecurityContextInput = {
  authenticatedSchoolId?: string | null;
  authenticatedRole?: string | null;
  requestedSchoolId?: string | null;
};

export type SecurityContextResult = {
  schoolId: string | null;
  rejected: boolean;
  reason?: string;
};

export function buildSchoolAdminMembershipWhere(userId: string, schoolId: string) {
  return { id: userId, schoolId, role: 'SCHOOL_ADMIN' as const };
}

const KNOWN_ROLES = new Set([
  'SCHOOL_ADMIN',
  'TEACHER',
  'STUDENT',
  'PARENT',
  'BURSAR',
  'PLATFORM_ADMIN',
  'ADMIN',
]);

function normalizeRole(role?: string | null): string | null {
  const normalized = normalize(role)?.toUpperCase() ?? null;
  return normalized && KNOWN_ROLES.has(normalized) ? normalized : null;
}

/**
 * Resolve tenant scope without allowing school users to switch schools through
 * query parameters, headers, or request bodies.
 */
export function resolveSchoolScope(input: SecurityContextInput): SecurityContextResult {
  const authenticatedSchoolId = normalize(input.authenticatedSchoolId);
  const requestedSchoolId = normalize(input.requestedSchoolId);
  const role = normalizeRole(input.authenticatedRole);

  if (authenticatedSchoolId) {
    if (!role) {
      return { schoolId: null, rejected: false };
    }

    if (requestedSchoolId && requestedSchoolId !== authenticatedSchoolId && role !== 'PLATFORM_ADMIN') {
      return {
        schoolId: null,
        rejected: true,
        reason: 'Requested school does not match the authenticated school',
      };
    }

    return { schoolId: role === 'PLATFORM_ADMIN' && requestedSchoolId ? requestedSchoolId : authenticatedSchoolId, rejected: false };
  }

  if (role === 'PLATFORM_ADMIN' && requestedSchoolId) {
    return { schoolId: requestedSchoolId, rejected: false };
  }

  return { schoolId: null, rejected: false };
}

function normalize(value?: string | null): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}
