import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import {
  AI_SCHEMA_RECONCILIATION,
  AI_ENGINE_READINESS,
  buildAiQueryPlan,
  createAiConversationContextToken,
  executeAiQueryPlan,
  getAiEngineCapabilities,
  getAiModelCoverageStatus,
  getAiReadinessStatus,
  getAiSchemaReconciliationSummary,
  isAiEngineEnabled,
  isAiPilotAccessAllowed,
  resolveAiFollowupPlan,
  SCHOOLBASE_AI_MODEL_REGISTRY,
  validateAiQueryPlan,
} from '../src/services/schoolbase-ai-engine.js';

for (const entry of Object.values(SCHOOLBASE_AI_MODEL_REGISTRY)) {
  const prismaModelName = `${entry.model[0]?.toUpperCase()}${entry.model.slice(1)}`;
  const prismaModel = Prisma.dmmf.datamodel.models.find((model) => model.name === prismaModelName);
  assert.ok(prismaModel, `${entry.model} must exist in the generated Prisma schema`);
  const scalarFields = new Set(prismaModel.fields.filter((field) => field.kind !== 'object').map((field) => field.name));
  for (const field of [...entry.fields, ...entry.filters]) {
    assert.ok(scalarFields.has(field), `${entry.model}.${field} must be a scalar Prisma field`);
  }
}

const valid = validateAiQueryPlan(
  {
    model: 'pupil',
    action: 'count',
    fields: ['id', 'firstName', 'lastName'],
    filters: { status: 'ACTIVE' },
    limit: 10,
  },
  { role: 'SCHOOL_ADMIN', schoolId: 'school-1' },
);
assert.equal(valid.ok, true, 'valid school-admin student query should pass');

const tenantOverride = validateAiQueryPlan(
  {
    model: 'pupil',
    action: 'count',
    fields: ['id'],
    filters: { schoolId: 'other-school' },
    limit: 10,
  },
  { role: 'SCHOOL_ADMIN', schoolId: 'school-1' },
);
assert.equal(tenantOverride.ok, false, 'caller-provided tenant filters must be rejected');

const nestedFilter = validateAiQueryPlan(
  {
    model: 'pupil',
    action: 'count',
    fields: ['id'],
    filters: { isActive: { not: true } },
    limit: 10,
  },
  { role: 'SCHOOL_ADMIN', schoolId: 'school-1' },
);
assert.equal(nestedFilter.ok, false, 'operator objects must not pass as filter values');

const unavailableFinanceModel = validateAiQueryPlan(
  { model: 'invoice', action: 'count', fields: ['id'], filters: {}, limit: 10 },
  { role: 'BURSAR', schoolId: 'school-1' },
);
assert.equal(unavailableFinanceModel.ok, false, 'finance queries must stay blocked until service-backed execution exists');

const inheritedModel = validateAiQueryPlan(
  { model: 'toString', action: 'count', fields: [], filters: {}, limit: 10 },
  { role: 'SCHOOL_ADMIN', schoolId: 'school-1' },
);
assert.equal(inheritedModel.ok, false, 'prototype properties must not be accepted as registry models');

const crossSchool = validateAiQueryPlan(
  { model: 'pupil', action: 'count', fields: ['id'], filters: {}, limit: 10 },
  { role: 'SCHOOL_ADMIN', schoolId: 'school-1', requestedSchoolId: 'school-2' },
);
assert.equal(crossSchool.ok, false, 'authenticated users cannot change their school scope');

const invalid = validateAiQueryPlan(
  { model: 'pupil', action: 'count', fields: ['passwordHash'], filters: { password: 'x' }, limit: 50 },
  { role: 'TEACHER', schoolId: 'school-1' },
);
assert.equal(invalid.ok, false, 'teacher should not query forbidden student fields');

const validStaffQuery = validateAiQueryPlan(
  {
    model: 'employeeProfile',
    action: 'list',
    fields: ['firstName', 'lastName', 'jobTitle', 'department', 'employmentStatus'],
    filters: { employmentStatus: 'ACTIVE', department: 'science' },
    limit: 10,
  },
  { role: 'SCHOOL_ADMIN', schoolId: 'school-1' },
);
assert.equal(validStaffQuery.ok, true, 'school admins may query the reviewed staff directory fields');

const staffContactQuery = validateAiQueryPlan(
  {
    model: 'employeeProfile',
    action: 'list',
    fields: ['firstName', 'phone', 'emergencyContactPhone'],
    filters: {},
    limit: 10,
  },
  { role: 'SCHOOL_ADMIN', schoolId: 'school-1' },
);
assert.equal(staffContactQuery.ok, false, 'staff contact and emergency details are not queryable');

const bursarStaffQuery = validateAiQueryPlan(
  { model: 'employeeProfile', action: 'count', fields: ['firstName'], filters: {}, limit: 10 },
  { role: 'BURSAR', schoolId: 'school-1' },
);
assert.equal(bursarStaffQuery.ok, false, 'staff directory queries are restricted to school admins');

const invalidStaffStatus = validateAiQueryPlan(
  { model: 'employeeProfile', action: 'count', fields: ['firstName'], filters: { employmentStatus: 'EVERYTHING' }, limit: 10 },
  { role: 'SCHOOL_ADMIN', schoolId: 'school-1' },
);
assert.equal(invalidStaffStatus.ok, false, 'staff enum filters must use known employment statuses');

const plan = buildAiQueryPlan('How many active students do we have?', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' });
assert.ok(plan, 'simple supported questions should produce a plan');
assert.equal(plan.model, 'pupil');
assert.equal(plan.action, 'count');
assert.equal(plan.limit > 0, true);
assert.deepEqual(plan.filters, { isActive: true });
assert.deepEqual(
  buildAiQueryPlan('How many students do we have?', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' })?.filters,
  { isActive: true },
  'student counts default to current active enrollment semantics',
);
assert.deepEqual(
  buildAiQueryPlan('List inactive students', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' })?.filters,
  { isActive: false },
  'inactive queries use an explicit inactive filter',
);
assert.equal(
  buildAiQueryPlan('Students do we have', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' })?.action,
  'count',
  'a short student-count question should be interpreted as a count, not navigation',
);
assert.equal(buildAiQueryPlan('What is the learner headcount?', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' })?.action, 'count');
assert.equal(buildAiQueryPlan('Retrieve the current school year', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' })?.model, 'academicYear');
assert.deepEqual(buildAiQueryPlan('Retrieve the current school year', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' })?.filters, { isCurrent: true });
assert.deepEqual(buildAiQueryPlan('Count previous academic sessions', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' })?.filters, { isCurrent: false });
assert.equal(buildAiQueryPlan('Show the course catalogue', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' })?.model, 'subject');
assert.equal(buildAiQueryPlan('Give me the current teaching workforce', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' })?.filters.classification, 'ACADEMIC');
assert.equal(buildAiQueryPlan('Find employees whose first name is Raymond', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' })?.filters.firstName, 'raymond');
assert.equal(buildAiQueryPlan('List students and their classes', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' }), null,
  'multi-domain relationship questions must not be narrowed to one model');
assert.equal(
  buildAiQueryPlan('Show our school details', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' })?.model,
  'school',
  'school details requests should use the registered school metadata query',
);

assert.equal(buildAiQueryPlan('Show me those students', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' }), null,
  'anaphoric follow-ups must not become an unfiltered query');
assert.equal(buildAiQueryPlan('How many students are in Primary 5?', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' }), null,
  'class relationship questions must not be reduced to an unfiltered student query');
assert.equal(buildAiQueryPlan('How much do students owe?', { role: 'BURSAR', schoolId: 'school-1' }), null,
  'financial questions remain unavailable until service-backed execution is implemented');
assert.equal(buildAiQueryPlan('What is the meaning of life?', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' }), null,
  'unrecognized questions must not fall back to student queries');

const staffPlan = buildAiQueryPlan('How many active teachers are in the Science department?', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' });
assert.ok(staffPlan, 'supported staff roster questions should produce a plan');
assert.equal(staffPlan.model, 'employeeProfile');
assert.equal(staffPlan.action, 'count');
assert.deepEqual(staffPlan.filters, {
  employmentStatus: 'ACTIVE',
  department: 'science',
  jobTitle: 'teacher',
});
assert.equal(buildAiQueryPlan('List academic staff', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' })?.filters.classification, 'ACADEMIC');
assert.equal(buildAiQueryPlan('Find staff with first name Ada', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' })?.filters.firstName, 'ada');
assert.equal(buildAiQueryPlan('Find staff with name Raymond', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' }), null,
  'an ambiguous staff-name query must not broaden to the full directory');
assert.equal(buildAiQueryPlan('Find staff named Raymond', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' }), null,
  'ambiguous named-staff queries must not broaden to the full directory');
assert.equal(buildAiQueryPlan('Find staff in HR', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' }), null,
  'an unrecognized staff department constraint must not broaden to the full active directory');
assert.equal(buildAiQueryPlan('Show teachers assigned to Mathematics', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' }), null,
  'teacher assignment queries must not be reduced to an unfiltered staff roster');
assert.equal(buildAiQueryPlan('List staff phone numbers', { role: 'SCHOOL_ADMIN', schoolId: 'school-1' }), null,
  'staff contact questions must be denied rather than answered with a partial roster');

const contextIdentity = { role: 'SCHOOL_ADMIN', schoolId: 'school-1', userId: 'user-1' };
const contextSecret = new TextEncoder().encode('test-only-ai-context-secret');
const contextToken = createAiConversationContextToken(plan, contextIdentity, contextSecret, 1_000);
const followupPlan = resolveAiFollowupPlan('Show me those students', contextToken, contextIdentity, contextSecret, 2_000);
assert.equal(followupPlan.ok, true, 'valid follow-up context should resolve');
if (followupPlan.ok) {
  assert.equal(followupPlan.plan.model, 'pupil');
  assert.equal(followupPlan.plan.action, 'list');
  assert.deepEqual(followupPlan.plan.filters, { isActive: true });
}
assert.deepEqual(
  resolveAiFollowupPlan('Show me those students', contextToken, { ...contextIdentity, schoolId: 'school-2' }, contextSecret, 2_000),
  { ok: false, reason: 'identity_changed' },
  'conversation context cannot cross school scope',
);
assert.deepEqual(
  resolveAiFollowupPlan('Show me those students', contextToken, contextIdentity, contextSecret, 700_000),
  { ok: false, reason: 'expired' },
  'conversation context expires',
);
assert.equal(
  resolveAiFollowupPlan('Show me those students', `${contextToken}tampered`, contextIdentity, contextSecret, 2_000).ok,
  false,
  'tampered context is rejected',
);

const staffContextToken = createAiConversationContextToken(staffPlan, contextIdentity, contextSecret, 1_000);
const staffFollowup = resolveAiFollowupPlan('Show me those staff', staffContextToken, contextIdentity, contextSecret, 2_000);
assert.equal(staffFollowup.ok, true, 'staff follow-ups preserve the prior staff filters');
if (staffFollowup.ok) {
  assert.equal(staffFollowup.plan.model, 'employeeProfile');
  assert.deepEqual(staffFollowup.plan.filters, staffPlan.filters);
}
assert.deepEqual(
  resolveAiFollowupPlan('Show me those staff', contextToken, contextIdentity, contextSecret, 2_000),
  { ok: false, reason: 'unsupported' },
  'student conversation context cannot be reinterpreted as a staff query',
);

assert.equal(isAiEngineEnabled({ SCHOOLBASE_AI_ENGINE_ENABLED: 'true' } as NodeJS.ProcessEnv), true);
assert.equal(isAiEngineEnabled({ SCHOOLBASE_AI_ENGINE_ENABLED: 'false' } as NodeJS.ProcessEnv), false);
assert.equal(
  isAiPilotAccessAllowed({ role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, { NODE_ENV: 'development' } as NodeJS.ProcessEnv),
  true,
  'local development remains usable without the production pilot allowlist',
);
assert.equal(
  isAiPilotAccessAllowed({ role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, { NODE_ENV: 'production' } as NodeJS.ProcessEnv),
  false,
  'production must fail closed if the pilot allowlist is missing',
);
const pilotEnvironment = {
  NODE_ENV: 'production',
  SCHOOLBASE_AI_PILOT_SCHOOL_IDS: 'school-1, school-2',
} as NodeJS.ProcessEnv;
assert.equal(isAiPilotAccessAllowed({ role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, pilotEnvironment), true);
assert.equal(isAiPilotAccessAllowed({ role: 'SCHOOL_ADMIN', schoolId: 'school-3' }, pilotEnvironment), false);
assert.equal(isAiPilotAccessAllowed({ role: 'BURSAR', schoolId: 'school-1' }, pilotEnvironment), false);
assert.equal(AI_SCHEMA_RECONCILIATION.missingFromSnapshot.length, 42);
assert.equal(getAiSchemaReconciliationSummary().backendPrismaModels, 164);
assert.equal(getAiModelCoverageStatus('invoice')?.status, 'service-required');
assert.equal(getAiModelCoverageStatus('employeeProfile')?.queryable, true);
assert.equal(getAiModelCoverageStatus('accountingJournalEntry')?.status, 'pending');
assert.equal(AI_ENGINE_READINESS.milestone, 3);
assert.equal(getAiReadinessStatus().engineMode, 'read-only');
assert.ok(getAiEngineCapabilities('SCHOOL_ADMIN').includes('pupil'));
assert.ok(getAiEngineCapabilities('SCHOOL_ADMIN').includes('employeeProfile'));
assert.equal(getAiEngineCapabilities('BURSAR').includes('employeeProfile'), false);
assert.deepEqual(getAiEngineCapabilities('TEACHER'), [], 'teacher queries remain disabled until assignment scoping is enforced');

const withFakePrisma = {
  pupil: {
    count: async ({ where }: { where: Record<string, unknown> }) => {
      assert.equal(where.schoolId, 'school-1');
      assert.equal(where.isActive, true);
      assert.ok(Array.isArray(where.OR), 'active status must use the authoritative lifecycle predicate');
      return 9;
    },
    findMany: async ({ where, take, select, orderBy }: {
      where: Record<string, unknown>;
      take: number;
      select: Record<string, boolean>;
      orderBy: Record<string, 'asc' | 'desc'>;
    }) => {
      assert.equal(where.schoolId, 'school-1');
      assert.equal(take, 10);
      assert.equal(select.id, true);
      assert.deepEqual(orderBy, { id: 'asc' });
      return [{ id: 'p1', firstName: 'Ada' }];
    },
  },
  employeeProfile: {
    count: async ({ where }: { where: Record<string, unknown> }) => {
      assert.equal(where.schoolId, 'school-1');
      assert.deepEqual(where.employmentStatus, 'ACTIVE');
      assert.deepEqual(where.department, { contains: 'science' });
      return 2;
    },
    findMany: async ({ where, take, select, orderBy }: {
      where: Record<string, unknown>;
      take: number;
      select: Record<string, boolean>;
      orderBy: Record<string, 'asc' | 'desc'>;
    }) => {
      assert.equal(where.schoolId, 'school-1');
      assert.equal(take, 10);
      assert.equal(select.emergencyContactPhone, undefined);
      assert.equal(select.phone, undefined);
      assert.deepEqual(orderBy, { lastName: 'asc' });
      return [{ firstName: 'Ada', lastName: 'Lovelace', jobTitle: 'Teacher', department: 'Science', employmentStatus: 'ACTIVE' }];
    },
  },
};

const executed = await executeAiQueryPlan(
  withFakePrisma as any,
  {
    model: 'pupil',
    action: 'count',
    fields: ['id'],
    filters: { isActive: true },
    limit: 10,
    ordering: { field: 'id', direction: 'asc' },
    tenantScope: 'school',
  },
  { role: 'SCHOOL_ADMIN', schoolId: 'school-1' },
);
assert.equal(executed.matched, 9);
assert.deepEqual(executed.filters, { isActive: true }, 'query results should retain enrollment filters for accurate explanations');
assert.equal(executed.audit.readOnly, true);

const listed = await executeAiQueryPlan(
  withFakePrisma as any,
  {
    model: 'pupil',
    action: 'list',
    fields: ['id', 'firstName'],
    filters: { isActive: true },
    limit: 10,
    ordering: { field: 'id', direction: 'asc' },
    tenantScope: 'school',
  },
  { role: 'SCHOOL_ADMIN', schoolId: 'school-1' },
);
assert.equal(listed.matched, 9, 'list result reports the total matching count, not just page size');
assert.deepEqual(listed.data, { items: [{ id: 'p1', firstName: 'Ada' }], total: 9, limit: 10 });

const staffResults = await executeAiQueryPlan(
  withFakePrisma as any,
  staffPlan,
  { role: 'SCHOOL_ADMIN', schoolId: 'school-1' },
);
assert.equal(staffResults.matched, 2);
assert.equal(staffResults.model, 'employeeProfile');

console.log('SchoolBase AI engine validation tests passed');
