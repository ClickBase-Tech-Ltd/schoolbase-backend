import { Prisma, type PrismaClient } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { buildActiveStudentWhere, buildStudentRosterWhere } from './student-lifecycle.js';

export type AiRole = 'SCHOOL_ADMIN' | 'BURSAR' | 'TEACHER' | 'STAFF' | 'PARENT' | 'STUDENT' | 'PLATFORM_ADMIN';
export type AiModelAction = 'count' | 'list';
export type AiScope = 'school' | 'platform' | 'self';

export type AiModelRegistryEntry = {
  model: string;
  label: string;
  businessPurpose: string;
  scope: AiScope;
  scopeField: 'id' | 'schoolId';
  sensitivity: 'public' | 'internal' | 'restricted' | 'financial' | 'student';
  permissions: AiRole[];
  fields: readonly string[];
  filters: readonly string[];
  readOnly: true;
  status: 'reviewed' | 'restricted' | 'pending';
  usesBusinessService?: string;
};

export type AiQueryPlan = {
  model: string;
  action: AiModelAction;
  fields: string[];
  filters: Record<string, unknown>;
  limit: number;
  ordering?: { field: string; direction: 'asc' | 'desc' };
  tenantScope: AiScope;
};

export type AiValidationContext = {
  role?: string | null;
  schoolId?: string | null;
  requestedSchoolId?: string | null;
  userId?: string | null;
};

type AiConversationContextPayload = {
  version: 1;
  expiresAt: number;
  userId: string;
  role: string;
  schoolId: string;
  plan: AiQueryPlan;
};

const AI_CONVERSATION_CONTEXT_TTL_MS = 10 * 60 * 1_000;
const MAX_CONTEXT_TOKEN_LENGTH = 4_096;

export type AiQueryExecutionResult = {
  model: string;
  action: AiModelAction;
  matched: number;
  filters: Record<string, unknown>;
  data: unknown;
  audit: {
    role: string | null;
    schoolId: string | null;
    requestedSchoolId: string | null;
    readOnly: true;
  };
};

export type AiReviewStatus = 'reviewed' | 'restricted' | 'pending' | 'excluded' | 'service-required';

export type AiCoverageReview = {
  status: AiReviewStatus;
  queryable: boolean;
  requiresService: boolean;
  sensitivity: 'public' | 'internal' | 'restricted' | 'financial' | 'student';
  permissions: AiRole[];
  notes: string;
  businessService?: string;
};

export type AiReadinessStatus = {
  milestone: number;
  engineMode: 'read-only';
  schemaReconciliationRequired: boolean;
  productionDatabaseInspectionRequired: boolean;
  readyForPilot: boolean;
  pilotRoles: AiRole[];
  allowedModels: string[];
  blockers: string[];
  nextGate: string;
};

export const AI_SCHEMA_RECONCILIATION = {
  backendPrismaModels: 164,
  sqlSnapshotApplicationTables: 123,
  missingFromSnapshot: [
    'CountrySchoolFollowUp', 'CountryFollowUpDigest', 'CountrySchoolFollowUpEvent', 'CountryAdminConversation',
    'CountryAdminMessage', 'CountryAdminConversationRead', 'CountryAdminAnnouncement', 'CountryAdminAnnouncementAcknowledgement',
    'EmployeeProfile', 'StaffNumberCounter', 'StaffEmploymentEvent', 'CompetitionExamPractice', 'SignupRateLimit',
    'SchoolReview', 'FinancingInstitution', 'FinancingProduct', 'SchoolFinancingProduct', 'FinancingProviderEvent',
    'FinancingApplication', 'FinancingApplicationEvent', 'FinancingApplicationPayment', 'StaffAttendancePolicy',
    'AttendanceStation', 'AttendanceStationEvent', 'StaffAttendanceRecord', 'StaffAttendanceEvent', 'TermReportCardConfig',
    'TermReportCardComment', 'AdmissionApplicationEvent', 'AdmissionExportAudit', 'SchoolAdminNotification',
    'AdmissionDeliveryAttempt', 'AdmissionDeliveryRetry', 'AccountingAccount', 'AccountingJournalEntry', 'AccountingPeriod',
    'AccountingJournalLine', 'BankStatementImport', 'BankStatementReconciliationEvent', 'BankStatementLine',
    'BankStatementMatch', 'CashbookExportAudit',
  ],
  productionSchemaUnverified: true,
} as const;

export const AI_MODEL_PERMISSION_REVIEW: Record<string, AiCoverageReview> = {
  school: { status: 'reviewed', queryable: true, requiresService: false, sensitivity: 'internal', permissions: ['SCHOOL_ADMIN'], notes: 'Only minimal school metadata is queryable in the authenticated school context.', businessService: 'security-context' },
  pupil: { status: 'reviewed', queryable: true, requiresService: true, sensitivity: 'student', permissions: ['SCHOOL_ADMIN', 'BURSAR'], notes: 'Student records are school-scoped and active-student semantics use the existing lifecycle helper.', businessService: 'student-lifecycle' },
  employeeProfile: { status: 'reviewed', queryable: true, requiresService: false, sensitivity: 'restricted', permissions: ['SCHOOL_ADMIN'], notes: 'School-admin-only employee directory fields; excludes contact details, emergency contacts, photos, account data, payroll, attendance, and assignment joins. Production schema presence remains unverified.', businessService: 'admin-staff-directory' },
  guardian: { status: 'reviewed', queryable: false, requiresService: true, sensitivity: 'student', permissions: ['SCHOOL_ADMIN'], notes: 'Guardian data is direct PII and must be gated to school-admin operations and approved data access only.', businessService: 'guardian-notification-recipients' },
  class: { status: 'reviewed', queryable: true, requiresService: false, sensitivity: 'internal', permissions: ['SCHOOL_ADMIN'], notes: 'Class metadata is school-scoped; relational student/teacher joins are not enabled.', businessService: 'student-lifecycle' },
  subject: { status: 'reviewed', queryable: true, requiresService: false, sensitivity: 'internal', permissions: ['SCHOOL_ADMIN'], notes: 'Only school-scoped curriculum metadata is queryable; assignments and results are excluded.', businessService: 'school-curriculum' },
  academicYear: { status: 'reviewed', queryable: true, requiresService: false, sensitivity: 'internal', permissions: ['SCHOOL_ADMIN'], notes: 'Only school-scoped academic-year metadata is queryable.', businessService: 'school-calendar' },
  attendanceRecord: { status: 'service-required', queryable: false, requiresService: true, sensitivity: 'student', permissions: ['SCHOOL_ADMIN', 'TEACHER'], notes: 'Attendance queries remain blocked until an authoritative attendance service adapter and role assignment scope exist.', businessService: 'attendance-domain' },
  invoice: { status: 'service-required', queryable: false, requiresService: true, sensitivity: 'financial', permissions: ['SCHOOL_ADMIN', 'BURSAR'], notes: 'Financial queries remain blocked until execution is routed through authoritative balance and allocation services.', businessService: 'invoice-balance' },
  payment: { status: 'service-required', queryable: false, requiresService: true, sensitivity: 'financial', permissions: ['SCHOOL_ADMIN', 'BURSAR'], notes: 'Financial queries remain blocked until execution is routed through authoritative payment/allocation services.', businessService: 'invoice-payment-allocation' },
  feeSchedule: { status: 'service-required', queryable: false, requiresService: true, sensitivity: 'financial', permissions: ['SCHOOL_ADMIN', 'BURSAR'], notes: 'Financial queries remain blocked until schedule semantics are provided by the billing service.', businessService: 'fee-invoice-issuance' },
  accountingJournalEntry: { status: 'pending', queryable: false, requiresService: true, sensitivity: 'financial', permissions: ['BURSAR', 'SCHOOL_ADMIN'], notes: 'Journal entries require finance-owner review and strict separation from operational reporting.', businessService: 'accounting-journal' },
  accountingPeriod: { status: 'pending', queryable: false, requiresService: true, sensitivity: 'financial', permissions: ['BURSAR', 'SCHOOL_ADMIN'], notes: 'Period and ledger scope requires explicit finance-domain approval before conversational access.', businessService: 'accounting-ledger' },
  bankStatementImport: { status: 'pending', queryable: false, requiresService: true, sensitivity: 'financial', permissions: ['BURSAR'], notes: 'Bank-reconciliation data is highly sensitive and should remain within finance service boundaries.', businessService: 'bank-statement-workflow' },
  cashbookExportAudit: { status: 'pending', queryable: false, requiresService: true, sensitivity: 'financial', permissions: ['BURSAR'], notes: 'Cashbooks and export audits are finance-domain reporting artifacts requiring explicit validation.', businessService: 'cashbook-csv' },
  user: { status: 'restricted', queryable: false, requiresService: true, sensitivity: 'restricted', permissions: ['SCHOOL_ADMIN', 'PLATFORM_ADMIN'], notes: 'User-account metadata is restricted and not available for general conversational access.', businessService: 'roleAuth' },
  financingApplication: { status: 'pending', queryable: false, requiresService: true, sensitivity: 'financial', permissions: ['SCHOOL_ADMIN', 'PLATFORM_ADMIN'], notes: 'Tuition financing data must not be exposed without service-owner confirmation and policy review.', businessService: 'tuition-financing-feature-gate' },
  schoolReview: { status: 'pending', queryable: false, requiresService: true, sensitivity: 'internal', permissions: ['SCHOOL_ADMIN'], notes: 'School review records are operationally sensitive and must be reviewed before query exposure.', businessService: 'school-reviews' },
  supportRequest: { status: 'excluded', queryable: false, requiresService: false, sensitivity: 'internal', permissions: [], notes: 'Support tickets from school operations remain out of scope for the first read-only AI engine.', businessService: undefined },
};

export const AI_ENGINE_READINESS: AiReadinessStatus = {
  milestone: 3,
  engineMode: 'read-only',
  schemaReconciliationRequired: true,
  productionDatabaseInspectionRequired: true,
  readyForPilot: false,
  pilotRoles: ['SCHOOL_ADMIN', 'BURSAR'],
  allowedModels: ['school', 'pupil', 'employeeProfile', 'class', 'subject', 'academicYear'],
  blockers: [
    'Live MySQL schema reconciliation against the actual deployed database is required before broader coverage is claimed.',
    'EmployeeProfile is absent from the dated SQL snapshot; verify its presence and approved fields in the deployed schema before enabling staff queries there.',
    'Finance domain-owner review is required for accounting, bank reconciliation, and cashbook reporting.',
    'The first approved pilot scope must remain read-only and role-scoped.',
  ],
  nextGate: 'Approve the schema reconciliation and pilot-scope review before expanding the model registry any further.',
};

export const SCHOOLBASE_AI_MODEL_REGISTRY: Record<string, AiModelRegistryEntry> = {
  school: {
    model: 'school',
    label: 'School',
    businessPurpose: 'School configuration, tenant context and operational metadata.',
    scope: 'school',
    scopeField: 'id',
    sensitivity: 'internal',
    permissions: ['SCHOOL_ADMIN'],
    fields: ['id', 'name', 'country', 'currency', 'timezone'],
    filters: ['id', 'name', 'country'],
    readOnly: true,
    status: 'reviewed',
    usesBusinessService: 'security-context',
  },
  pupil: {
    model: 'pupil',
    label: 'Student',
    businessPurpose: 'Student records, enrollment, status, and school assignment.',
    scope: 'school',
    scopeField: 'schoolId',
    sensitivity: 'student',
    permissions: ['SCHOOL_ADMIN', 'BURSAR'],
    fields: ['id', 'firstName', 'lastName', 'admissionNo', 'classId', 'isActive', 'status', 'createdAt'],
    filters: ['id', 'classId', 'isActive', 'status', 'admissionNo', 'firstName', 'lastName'],
    readOnly: true,
    status: 'reviewed',
    usesBusinessService: 'student-lifecycle',
  },
  employeeProfile: {
    model: 'employeeProfile',
    label: 'Staff profile',
    businessPurpose: 'School-scoped employee directory details, excluding personal contact and account information.',
    scope: 'school',
    scopeField: 'schoolId',
    sensitivity: 'restricted',
    permissions: ['SCHOOL_ADMIN'],
    fields: ['firstName', 'lastName', 'jobTitle', 'department', 'classification', 'employmentType', 'employmentStatus', 'startDate', 'endDate'],
    filters: ['firstName', 'lastName', 'jobTitle', 'department', 'classification', 'employmentType', 'employmentStatus'],
    readOnly: true,
    status: 'reviewed',
    usesBusinessService: 'admin-staff-directory',
  },
  class: {
    model: 'class',
    label: 'Class',
    businessPurpose: 'Academic classes and arm assignments for student grouping.',
    scope: 'school',
    scopeField: 'schoolId',
    sensitivity: 'internal',
    permissions: ['SCHOOL_ADMIN'],
    fields: ['id', 'name', 'phase', 'arm', 'createdAt'],
    filters: ['id', 'name', 'phase', 'arm'],
    readOnly: true,
    status: 'reviewed',
    usesBusinessService: 'student-lifecycle',
  },
  subject: {
    model: 'subject',
    label: 'Subject',
    businessPurpose: 'Curriculum subjects and school catalog metadata.',
    scope: 'school',
    scopeField: 'schoolId',
    sensitivity: 'internal',
    permissions: ['SCHOOL_ADMIN'],
    fields: ['id', 'name', 'code', 'createdAt'],
    filters: ['id', 'name', 'code'],
    readOnly: true,
    status: 'reviewed',
    usesBusinessService: 'school-curriculum',
  },
  academicYear: {
    model: 'academicYear',
    label: 'Academic year',
    businessPurpose: 'Academic-year and period context for school operations.',
    scope: 'school',
    scopeField: 'schoolId',
    sensitivity: 'internal',
    permissions: ['SCHOOL_ADMIN'],
    fields: ['id', 'name', 'isCurrent', 'createdAt'],
    filters: ['id', 'name', 'isCurrent'],
    readOnly: true,
    status: 'reviewed',
    usesBusinessService: 'school-calendar',
  },
};

const SAFE_ACTIONS = new Set<AiModelAction>(['count', 'list']);
const MAX_QUERY_LIMIT = 100;
const DEFAULT_QUERY_LIMIT = 25;
const MAX_FILTER_STRING_LENGTH = 120;
const MAX_QUESTION_LENGTH = 500;

export function isAiEngineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SCHOOLBASE_AI_ENGINE_ENABLED === 'true';
}

export function isAiPilotAccessAllowed(
  context: { role?: string | null; schoolId?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const pilotSchools = (env.SCHOOLBASE_AI_PILOT_SCHOOL_IDS ?? '')
    .split(',')
    .map((schoolId) => schoolId.trim())
    .filter(Boolean);

  if (env.NODE_ENV === 'production' && pilotSchools.length === 0) return false;
  if (pilotSchools.length > 0
    && (!context.schoolId || !pilotSchools.includes(context.schoolId) || context.role !== 'SCHOOL_ADMIN')) {
    return false;
  }
  return true;
}

export function getAiSchemaReconciliationSummary() {
  return {
    ...AI_SCHEMA_RECONCILIATION,
    reviewStatus: 'milestone-2-in-progress',
    productionDatabaseAccess: 'read-only-inspection-only',
  };
}

export function getAiModelCoverageStatus(modelName: string): AiCoverageReview | null {
  return Object.hasOwn(AI_MODEL_PERMISSION_REVIEW, modelName) ? AI_MODEL_PERMISSION_REVIEW[modelName] : null;
}

export function getAiReadinessStatus(): AiReadinessStatus {
  return { ...AI_ENGINE_READINESS, allowedModels: [...AI_ENGINE_READINESS.allowedModels] };
}

export function getAiEngineCapabilities(role?: string | null): string[] {
  const normalizedRole = normalizeRole(role);
  const entries = Object.values(SCHOOLBASE_AI_MODEL_REGISTRY).filter((entry) => {
    const review = AI_MODEL_PERMISSION_REVIEW[entry.model];
    if (!normalizedRole || !review?.queryable || review.status !== 'reviewed') return false;
    return entry.permissions.includes(normalizedRole as AiRole) && review.permissions.includes(normalizedRole as AiRole);
  });
  return entries.map((entry) => entry.model);
}

export function buildAiQueryPlan(
  question: string,
  context: AiValidationContext = {},
): AiQueryPlan | null {
  const normalizedQuestion = String(question ?? '').trim();
  if (!normalizedQuestion || normalizedQuestion.length > MAX_QUESTION_LENGTH) return null;
  if (isAiFollowupQuestion(normalizedQuestion)) {
    return null;
  }

  if (/\b(fee|fees|invoice|bill|owe|owing|outstanding|payment|paid|collection|revenue|accounting|ledger|cashbook|refund|waiver|discount)\b/i.test(normalizedQuestion)
    || /\b(attendance|absent|present|exam|examination|result|report card|admission|application|guardian|parent)\b/i.test(normalizedQuestion)
    || /\b(compare|average|highest|lowest|sum|total amount|between|this month|last month|this term|last term|this year|last year|after|before|during)\b/i.test(normalizedQuestion)
  ) return null;

  const detectedModel = detectModel(normalizedQuestion);
  if (!detectedModel || !(detectedModel in SCHOOLBASE_AI_MODEL_REGISTRY)) return null;
  if (!/\b(show|list|find|search|look up|retrieve|fetch|display|pull up|get(?: me)?|who|which|give me|provide|how many|head\s?count|count|number of|what is|what are|tell me)\b/i.test(normalizedQuestion)
    && !/\b(?:students?|pupils?|learners?)\s+do we have\b/i.test(normalizedQuestion)) return null;
  if (detectedModel === 'pupil' && /\b(class|arm|phase|primary|nursery|secondary|jss|sss)\b/i.test(normalizedQuestion)) return null;
  if (detectedModel === 'employeeProfile'
    && /\b(assigned|assignment|teaches?|class|subject|timetable|salary|payroll|wage|email|phone|contact|emergency|photo|account|former|left|inactive|tenure|before|after|during|them|those|these|their)\b/i.test(normalizedQuestion)) {
    return null;
  }

  const action = detectAction(normalizedQuestion);
  const entry = SCHOOLBASE_AI_MODEL_REGISTRY[detectedModel];
  const fields = [...entry.fields];
  const filters = buildFilters(normalizedQuestion, detectedModel);
  if (!filters) return null;
  const limit = inferLimit(normalizedQuestion);

  return {
    model: detectedModel,
    action,
    fields,
    filters,
    limit,
    ordering: detectOrdering(normalizedQuestion, detectedModel)
      ?? (detectedModel === 'employeeProfile' ? { field: 'lastName', direction: 'asc' } : undefined),
    tenantScope: entry.scope,
  };
}

export function createAiConversationContextToken(
  plan: AiQueryPlan,
  context: AiValidationContext,
  secret: Uint8Array,
  now = Date.now(),
): string {
  if (!context.userId || !context.role || !context.schoolId) {
    throw new Error('Authenticated user, role, and school are required for conversation context.');
  }

  const validated = validateAiQueryPlan(plan, context);
  if (!validated.ok) throw new Error('Only validated query plans can be stored in conversation context.');

  const payload: AiConversationContextPayload = {
    version: 1,
    expiresAt: now + AI_CONVERSATION_CONTEXT_TTL_MS,
    userId: context.userId,
    role: normalizeRole(context.role) as string,
    schoolId: context.schoolId,
    plan: validated.plan,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = signContext(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function resolveAiFollowupPlan(
  question: string,
  token: string,
  context: AiValidationContext,
  secret: Uint8Array,
  now = Date.now(),
): { ok: true; plan: AiQueryPlan } | { ok: false; reason: 'invalid' | 'expired' | 'identity_changed' | 'unsupported' } {
  if (!token || token.length > MAX_CONTEXT_TOKEN_LENGTH) return { ok: false, reason: 'invalid' };
  const [encodedPayload, signature, extra] = token.split('.');
  if (!encodedPayload || !signature || extra !== undefined) return { ok: false, reason: 'invalid' };

  const expectedSignature = signContext(encodedPayload, secret);
  const providedSignature = Buffer.from(signature);
  const expectedSignatureBytes = Buffer.from(expectedSignature);
  if (providedSignature.length !== expectedSignatureBytes.length || !timingSafeEqual(providedSignature, expectedSignatureBytes)) {
    return { ok: false, reason: 'invalid' };
  }

  let payload: AiConversationContextPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as AiConversationContextPayload;
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (!payload || payload.version !== 1 || !Number.isSafeInteger(payload.expiresAt)) return { ok: false, reason: 'invalid' };
  if (payload.expiresAt <= now) return { ok: false, reason: 'expired' };
  if (payload.userId !== context.userId || payload.role !== normalizeRole(context.role) || payload.schoolId !== context.schoolId) {
    return { ok: false, reason: 'identity_changed' };
  }

  const normalizedQuestion = String(question ?? '').trim();
  const followupEntity = getAiFollowupEntity(normalizedQuestion);
  if (!followupEntity) {
    return { ok: false, reason: 'unsupported' };
  }
  if (followupEntity === 'student' && payload.plan.model !== 'pupil') return { ok: false, reason: 'unsupported' };
  if (followupEntity === 'staff' && payload.plan.model !== 'employeeProfile') return { ok: false, reason: 'unsupported' };

  const plan: AiQueryPlan = { ...payload.plan, action: 'list', limit: DEFAULT_QUERY_LIMIT };
  const validated = validateAiQueryPlan(plan, context);
  if (!validated.ok) return { ok: false, reason: 'unsupported' };
  return { ok: true, plan: validated.plan };
}

export function validateAiQueryPlan(
  plan: Partial<AiQueryPlan>,
  context: AiValidationContext = {},
): { ok: true; plan: AiQueryPlan } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!plan.model || !Object.hasOwn(SCHOOLBASE_AI_MODEL_REGISTRY, plan.model)) {
    errors.push('Unsupported model for AI queries.');
  }

  const modelName = plan.model && Object.hasOwn(SCHOOLBASE_AI_MODEL_REGISTRY, plan.model) ? plan.model : null;
  if (!modelName) {
    return { ok: false, errors };
  }

  const entry = SCHOOLBASE_AI_MODEL_REGISTRY[modelName];
  const role = normalizeRole(context.role);
  const review = AI_MODEL_PERMISSION_REVIEW[modelName];

  if (!review || review.status !== 'reviewed' || !review.queryable) {
    errors.push(`The ${entry.label} data domain is not enabled for AI queries.`);
  }

  if (!role || !entry.permissions.includes(role as AiRole) || !review?.permissions.includes(role as AiRole)) {
    errors.push(`Role ${role ?? 'unknown'} is not authorised to query ${entry.label}.`);
  }

  if (plan.action && !SAFE_ACTIONS.has(plan.action as AiModelAction)) {
    errors.push('Only read-only count and list operations are permitted.');
  }

  if (typeof plan.limit === 'number' && (plan.limit < 1 || plan.limit > MAX_QUERY_LIMIT)) {
    errors.push(`Query limit must be between 1 and ${MAX_QUERY_LIMIT}.`);
  }

  if (plan.fields) {
    const invalidFields = plan.fields.filter((field) => !entry.fields.includes(field));
    if (invalidFields.length > 0) {
      errors.push(`Fields not authorized for ${entry.label}: ${invalidFields.join(', ')}`);
    }
  }

  if (plan.filters) {
    const filterKeys = Object.keys(plan.filters);
    const invalidFilters = filterKeys.filter((key) => !entry.filters.includes(key));
    if (invalidFilters.length > 0) {
      errors.push(`Filters not authorized for ${entry.label}: ${invalidFilters.join(', ')}`);
    }
    if (Object.prototype.hasOwnProperty.call(plan.filters, entry.scopeField)) {
      errors.push(`Tenant scope filter ${entry.scopeField} is controlled by the authenticated server context.`);
    }
    for (const [key, value] of Object.entries(plan.filters)) {
      const isScalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
      if (!isScalar || (typeof value === 'string' && value.length > MAX_FILTER_STRING_LENGTH)
        || (typeof value === 'number' && !Number.isFinite(value))) {
        errors.push(`Filter ${key} must be a bounded scalar value.`);
      }
    }
    if (modelName === 'employeeProfile' && plan.filters) {
      const allowedStaffFilterValues: Record<string, readonly string[]> = {
        classification: ['ACADEMIC', 'NON_ACADEMIC'],
        employmentType: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMPORARY'],
        employmentStatus: ['ACTIVE', 'SUSPENDED', 'RESIGNED', 'TERMINATED'],
      };
      for (const [field, allowedValues] of Object.entries(allowedStaffFilterValues)) {
        const value = plan.filters[field];
        if (value !== undefined && (typeof value !== 'string' || !allowedValues.includes(value))) {
          errors.push(`Filter ${field} must be one of the approved staff values.`);
        }
      }
    }
  }

  if (plan.ordering) {
    if (!entry.fields.includes(plan.ordering.field)) {
      errors.push(`Sort field ${plan.ordering.field} is not authorized for ${entry.label}.`);
    }
    if (plan.ordering.direction !== 'asc' && plan.ordering.direction !== 'desc') {
      errors.push('Sort direction must be asc or desc.');
    }
  }

  if (entry.scope === 'school' && !context.schoolId) {
    errors.push('School-scoped queries require an authenticated school context.');
  }

  if (context.requestedSchoolId && context.schoolId && context.requestedSchoolId !== context.schoolId && role !== 'PLATFORM_ADMIN') {
    errors.push('Requested school scope does not match the authenticated school.');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    plan: {
      model: entry.model,
      action: (plan.action as AiModelAction) ?? 'list',
      fields: plan.fields && plan.fields.length > 0 ? plan.fields : [...entry.fields],
      filters: plan.filters ?? {},
      limit: plan.limit ?? DEFAULT_QUERY_LIMIT,
      ordering: plan.ordering ?? { field: 'id', direction: 'asc' },
      tenantScope: entry.scope,
    },
  };
}

export async function executeAiQueryPlan(
  prisma: Pick<PrismaClient, 'pupil' | 'school' | 'class' | 'subject' | 'academicYear' | 'employeeProfile'>,
  plan: AiQueryPlan,
  context: AiValidationContext = {},
): Promise<AiQueryExecutionResult> {
  const validated = validateAiQueryPlan(plan, context);
  if (!validated.ok) {
    throw new Error(validated.errors.join(' '));
  }

  const { model, action, fields, filters, limit, ordering } = validated.plan;
  const entry = SCHOOLBASE_AI_MODEL_REGISTRY[model];
  const schoolId = context.schoolId;
  if (!schoolId) throw new Error('Authenticated school scope is required.');

  const modelClient = getReadOnlyDelegate(prisma, model);
  const where = buildSecureWhere(model, entry.scopeField, schoolId, filters);
  const matched = await modelClient.count(where);
  const data = action === 'count'
    ? { count: matched }
    : {
      items: await modelClient.findMany({
        where,
        take: limit,
        select: buildSafeSelect(fields),
        orderBy: { [ordering?.field ?? 'id']: ordering?.direction ?? 'asc' },
      }),
      total: matched,
      limit,
    };

  return {
    model,
    action,
    matched,
    filters: { ...filters },
    data,
    audit: {
      role: context.role ?? null,
      schoolId,
      requestedSchoolId: context.requestedSchoolId ?? null,
      readOnly: true,
    },
  };
}

function detectModel(question: string): string | null {
  const modelTerms: ReadonlyArray<{ model: string; pattern: RegExp }> = [
    { model: 'pupil', pattern: /\b(?:students?|pupils?|learners?|enrolments?|enrollments?|schoolchildren)\b/i },
    { model: 'employeeProfile', pattern: /\b(?:staff|employees?|teachers?|educators?|workforce|personnel)\b/i },
    { model: 'invoice', pattern: /\b(?:invoices?|bills?|fees?\s+owed|outstanding\s+fees?)\b/i },
    { model: 'payment', pattern: /\b(?:payments?|receipts?|collections?|collected)\b/i },
    { model: 'class', pattern: /\b(?:classes|class|classrooms?|arms?|sections?)\b/i },
    { model: 'attendanceRecord', pattern: /\b(?:attendance|absent|present)\b/i },
    { model: 'subject', pattern: /\b(?:subjects?|courses?|curriculum)\b/i },
    { model: 'feeSchedule', pattern: /\b(?:fee\s+schedule|fees?\s+structure|tuition\s+fees?)\b/i },
    { model: 'academicYear', pattern: /\b(?:academic\s+years?|school\s+years?|academic\s+sessions?)\b/i },
    { model: 'school', pattern: /\b(?:school\s+(?:settings?|details?|profile|configuration|information)|school['’]s\s+(?:settings?|details?|profile))\b/i },
  ];
  const matches = modelTerms.filter(({ pattern }) => pattern.test(question));
  return matches.length === 1 ? matches[0].model : null;
}

function detectAction(question: string): AiModelAction {
  if (/\b(?:how many|head\s?count|count|number of|total number of|total)\b/i.test(question)
    || /\b(?:students?|pupils?|learners?)\s+do we have\b/i.test(question)) return 'count';
  return 'list';
}

function buildFilters(question: string, model: string | null): Record<string, unknown> | null {
  const normalized = question.toLowerCase();
  const filters: Record<string, unknown> = {};
  if (model === 'pupil') {
    filters.isActive = /\b(?:inactive|not active|not currently enrolled)\b/i.test(normalized) ? false : true;
  }
  if (model === 'academicYear') {
    const asksCurrent = /\b(?:current|currently active|this school year)\b/i.test(normalized);
    const asksPrevious = /\b(?:previous|past|former)\b/i.test(normalized);
    if (asksCurrent && asksPrevious) return null;
    if (asksCurrent) filters.isCurrent = true;
    else if (asksPrevious) filters.isCurrent = false;
  }
  if (model === 'employeeProfile') {
    const hasFirstName = /\bfirst name\b/i.test(normalized);
    const hasLastName = /\blast name\b/i.test(normalized);
    if ((/\bname\b|\b(?:named|called)\b/i.test(normalized)) && !hasFirstName && !hasLastName) return null;

    const status = normalized.match(/\b(active|suspended|resigned|terminated)\b/i);
    filters.employmentStatus = (status?.[1] ?? 'active').toUpperCase();

    if (/\bnon[- ](?:academic|teaching)\b/i.test(normalized)) filters.classification = 'NON_ACADEMIC';
    else if (/\b(?:academic|teaching)\s+(?:staff|workforce|employees?)\b/i.test(normalized)) filters.classification = 'ACADEMIC';
    else if (/\bacademic\b/i.test(normalized)) filters.classification = 'ACADEMIC';

    const department = normalized.match(/\b(?:in|from|within)\s+(?:the\s+)?([a-z0-9][a-z0-9 &-]{0,80}?)\s+department\b/i);
    if (/\bdepartment\b/i.test(normalized) && !department?.[1]) return null;
    if (/\b(?:in|from|within)\b/i.test(normalized)
      && !department?.[1]
      && !/\b(?:in|from|within)\s+(?:the\s+)?(?:my|our|this|the)\s+school\b/i.test(normalized)) {
      return null;
    }
    if (department?.[1]) filters.department = department[1].trim();

    const firstName = normalized.match(/\bfirst name\s+(?:is\s+)?([a-z][a-z'-]{0,59})\b/i);
    if (/\bfirst name\b/i.test(normalized) && !firstName?.[1]) return null;
    if (firstName?.[1]) filters.firstName = firstName[1];
    const lastName = normalized.match(/\blast name\s+(?:is\s+)?([a-z][a-z'-]{0,59})\b/i);
    if (/\blast name\b/i.test(normalized) && !lastName?.[1]) return null;
    if (lastName?.[1]) filters.lastName = lastName[1];

    const jobTitle = normalized.match(/\b(?:job title|position|titled?)\s+(?:is\s+)?["']?([a-z0-9][a-z0-9 &-]{0,80})["']?(?:\s+in\b|\s+from\b|\s+department\b|[?.!,]|$)/i);
    if (/\b(?:job title|position|titled?)\b/i.test(normalized) && !jobTitle?.[1]) return null;
    if (jobTitle?.[1]) filters.jobTitle = jobTitle[1].trim();
    else if (/\bteachers?\b/i.test(normalized)) filters.jobTitle = 'teacher';

    const employmentType = normalized.match(/\b(full[- ]time|part[- ]time|contract|temporary)\s+(?:staff|employees?|teachers?)\b|\b(?:staff|employees?|teachers?)\s+(?:on\s+)?(full[- ]time|part[- ]time|contract|temporary)\b/i);
    const normalizedType = employmentType?.[1] ?? employmentType?.[2];
    if (/\b(full[- ]time|part[- ]time|contract|temporary)\b/i.test(normalized) && !normalizedType) return null;
    if (normalizedType) filters.employmentType = normalizedType.replace(/[- ]/g, '_').toUpperCase();

    if (/\b(named|called|role|payroll|salary|wage|email|phone|contact|emergency|photo|account|former|left|inactive|tenure|joined|hired|started|since|before|after|during|them|those|these|their)\b/i.test(normalized)) {
      return null;
    }
  }

  return filters;
}

function inferLimit(question: string): number {
  const normalized = question.toLowerCase();
  const preciseMatch = normalized.match(/(?:limit|top|first|show)\s+(\d+)/i);
  if (preciseMatch?.[1]) {
    return Math.min(Number(preciseMatch[1]), MAX_QUERY_LIMIT);
  }
  if (/(all|every|complete)/.test(normalized)) return MAX_QUERY_LIMIT;
  return DEFAULT_QUERY_LIMIT;
}

function detectOrdering(question: string, model?: string): { field: string; direction: 'asc' | 'desc' } | undefined {
  const normalized = question.toLowerCase();
  if (model === 'employeeProfile' && /(latest|newest|most recent|recent)/.test(normalized)) {
    return { field: 'startDate', direction: 'desc' };
  }
  if (model === 'employeeProfile' && /(oldest|earliest|first)/.test(normalized)) {
    return { field: 'startDate', direction: 'asc' };
  }
  if (/(latest|newest|most recent|recent)/.test(normalized)) {
    return { field: 'createdAt', direction: 'desc' };
  }
  if (/(oldest|earliest|first)/.test(normalized)) {
    return { field: 'createdAt', direction: 'asc' };
  }
  return undefined;
}

function normalizeRole(role?: string | null): string | null {
  const value = String(role ?? '').trim();
  if (!value) return null;
  return value.toUpperCase();
}

function getAiFollowupEntity(question: string): 'student' | 'staff' | 'any' | null {
  const match = question.match(/^(?:show|list|find|display)\s+(?:me\s+)?(them|those students|those pupils|those learners|the same students|the same pupils|those staff|those employees|those teachers|the same staff|the same employees|the same teachers)[?.!]*$/i);
  if (!match?.[1]) return null;
  if (/students|pupils|learners/i.test(match[1])) return 'student';
  if (/staff|employees|teachers/i.test(match[1])) return 'staff';
  return 'any';
}

function isAiFollowupQuestion(question: string): boolean {
  return getAiFollowupEntity(question) !== null;
}

function signContext(encodedPayload: string, secret: Uint8Array): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

type AiReadOnlyDelegate = {
  count(where: Record<string, unknown>): Promise<number>;
  findMany(args: {
    where: Record<string, unknown>;
    take: number;
    select: Record<string, boolean>;
    orderBy: Record<string, 'asc' | 'desc'>;
  }): Promise<unknown[]>;
};

function getReadOnlyDelegate(
  prisma: Pick<PrismaClient, 'pupil' | 'school' | 'class' | 'subject' | 'academicYear' | 'employeeProfile'>,
  model: string,
): AiReadOnlyDelegate {
  switch (model) {
    case 'pupil':
      return {
        count: (where) => prisma.pupil.count({ where: where as Prisma.PupilWhereInput }),
        findMany: (args) => prisma.pupil.findMany({
          where: args.where as Prisma.PupilWhereInput,
          take: args.take,
          select: args.select as Prisma.PupilSelect,
          orderBy: args.orderBy as Prisma.PupilOrderByWithRelationInput,
        }),
      };
    case 'employeeProfile':
      return {
        count: (where) => prisma.employeeProfile.count({ where: where as Prisma.EmployeeProfileWhereInput }),
        findMany: (args) => prisma.employeeProfile.findMany({
          where: args.where as Prisma.EmployeeProfileWhereInput,
          take: args.take,
          select: args.select as Prisma.EmployeeProfileSelect,
          orderBy: args.orderBy as Prisma.EmployeeProfileOrderByWithRelationInput,
        }),
      };
    case 'school':
      return {
        count: (where) => prisma.school.count({ where: where as Prisma.SchoolWhereInput }),
        findMany: (args) => prisma.school.findMany({
          where: args.where as Prisma.SchoolWhereInput,
          take: args.take,
          select: args.select as Prisma.SchoolSelect,
          orderBy: args.orderBy as Prisma.SchoolOrderByWithRelationInput,
        }),
      };
    case 'class':
      return {
        count: (where) => prisma.class.count({ where: where as Prisma.ClassWhereInput }),
        findMany: (args) => prisma.class.findMany({
          where: args.where as Prisma.ClassWhereInput,
          take: args.take,
          select: args.select as Prisma.ClassSelect,
          orderBy: args.orderBy as Prisma.ClassOrderByWithRelationInput,
        }),
      };
    case 'subject':
      return {
        count: (where) => prisma.subject.count({ where: where as Prisma.SubjectWhereInput }),
        findMany: (args) => prisma.subject.findMany({
          where: args.where as Prisma.SubjectWhereInput,
          take: args.take,
          select: args.select as Prisma.SubjectSelect,
          orderBy: args.orderBy as Prisma.SubjectOrderByWithRelationInput,
        }),
      };
    case 'academicYear':
      return {
        count: (where) => prisma.academicYear.count({ where: where as Prisma.AcademicYearWhereInput }),
        findMany: (args) => prisma.academicYear.findMany({
          where: args.where as Prisma.AcademicYearWhereInput,
          take: args.take,
          select: args.select as Prisma.AcademicYearSelect,
          orderBy: args.orderBy as Prisma.AcademicYearOrderByWithRelationInput,
        }),
      };
    default:
      throw new Error('Model is not supported by the read-only query adapter.');
  }
}

function buildSecureWhere(
  model: string,
  scopeField: 'id' | 'schoolId',
  schoolId: string,
  filters: Record<string, unknown>,
): Record<string, unknown> {
  if (model === 'pupil' && typeof filters.isActive === 'boolean') {
    const lifecycleWhere = filters.isActive
      ? buildActiveStudentWhere(schoolId)
      : buildStudentRosterWhere(schoolId, 'INACTIVE');
    const { isActive: _isActive, ...otherFilters } = filters;
    return { ...lifecycleWhere, ...otherFilters, schoolId };
  }
  if (model === 'employeeProfile') {
    const textFilters = new Set(['firstName', 'lastName', 'jobTitle', 'department']);
    const staffWhere: Record<string, unknown> = { schoolId };
    for (const [field, value] of Object.entries(filters)) {
      staffWhere[field] = textFilters.has(field) ? { contains: value } : value;
    }
    return staffWhere;
  }
  return { ...filters, [scopeField]: schoolId };
}

function buildSafeSelect(fields: string[]): Record<string, boolean> {
  return fields.reduce<Record<string, boolean>>((accumulator, field) => {
    if (!field || field === 'password' || field.endsWith('Hash')) {
      return accumulator;
    }
    accumulator[field] = true;
    return accumulator;
  }, {});
}
