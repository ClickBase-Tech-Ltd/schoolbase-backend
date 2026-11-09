import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAiQueryPlan,
  validateAiQueryPlan,
} from '../src/services/schoolbase-ai-engine.js';

const schoolAdminContext = { role: 'SCHOOL_ADMIN', schoolId: 'school-eval-1' };

const supportedParaphrases = [
  { question: 'How many active students are enrolled?', model: 'pupil', action: 'count', filters: { isActive: true } },
  { question: 'What is our learner headcount?', model: 'pupil', action: 'count', filters: { isActive: true } },
  { question: 'Show pupils who are not currently enrolled', model: 'pupil', action: 'list', filters: { isActive: false } },
  { question: 'How many active teachers are in the Science department?', model: 'employeeProfile', action: 'count', filters: { employmentStatus: 'ACTIVE', department: 'science', jobTitle: 'teacher' } },
  { question: 'Show academic staff', model: 'employeeProfile', action: 'list', filters: { employmentStatus: 'ACTIVE', classification: 'ACADEMIC' } },
  { question: 'Find employees whose first name is Raymond', model: 'employeeProfile', action: 'list', filters: { employmentStatus: 'ACTIVE', firstName: 'raymond' } },
  { question: 'List full-time employees', model: 'employeeProfile', action: 'list', filters: { employmentStatus: 'ACTIVE', employmentType: 'FULL_TIME' } },
  { question: 'How many classes are there?', model: 'class', action: 'count', filters: {} },
  { question: 'Show every class arm', model: 'class', action: 'list', filters: {} },
  { question: 'Fetch the curriculum catalogue', model: 'subject', action: 'list', filters: {} },
  { question: 'How many subjects are offered?', model: 'subject', action: 'count', filters: {} },
  { question: 'Retrieve the current school year', model: 'academicYear', action: 'list', filters: { isCurrent: true } },
  { question: 'Count previous academic sessions', model: 'academicYear', action: 'count', filters: { isCurrent: false } },
  { question: 'Get the school configuration', model: 'school', action: 'list', filters: {} },
] as const;

const mustReject = [
  'List students and their classes',
  'Show students in Primary 4',
  'Find staff named Raymond',
  'List teachers assigned to Mathematics',
  'Show staff phone numbers',
  'How much do students owe?',
  'Which students were absent yesterday?',
  'Compare this year with last year',
  'What is the meaning of life?',
] as const;

test('natural-language evaluation corpus plans supported paraphrases without changing scope', () => {
  let passed = 0;
  for (const scenario of supportedParaphrases) {
    const plan = buildAiQueryPlan(scenario.question, schoolAdminContext);
    assert.ok(plan, `Expected a plan for: ${scenario.question}`);
    assert.equal(plan.model, scenario.model, `Unexpected model for: ${scenario.question}`);
    assert.equal(plan.action, scenario.action, `Unexpected action for: ${scenario.question}`);
    assert.deepEqual(plan.filters, scenario.filters, `Unexpected filters for: ${scenario.question}`);

    const validation = validateAiQueryPlan(plan, schoolAdminContext);
    assert.equal(validation.ok, true, `Expected the authorized plan to validate: ${scenario.question}`);
    if (validation.ok) {
      assert.equal(validation.plan.tenantScope, 'school');
      assert.equal(validation.plan.limit <= 100, true);
    }
    passed += 1;
  }
  assert.equal(passed / supportedParaphrases.length, 1, 'supported paraphrase evaluation must meet 100% baseline');
});

test('evaluation corpus fails closed on ambiguity, unsupported domains, and guessed joins', () => {
  for (const question of mustReject) {
    assert.equal(buildAiQueryPlan(question, schoolAdminContext), null, `Expected no plan for: ${question}`);
  }
});

test('evaluation corpus enforces role and tenant authorization independently of phrasing', () => {
  const staffPlan = buildAiQueryPlan('Show academic staff', schoolAdminContext);
  assert.ok(staffPlan);
  assert.equal(
    validateAiQueryPlan(staffPlan, { role: 'BURSAR', schoolId: 'school-eval-1' }).ok,
    false,
    'Bursar role must not gain access to the staff directory',
  );
  assert.equal(
    validateAiQueryPlan(staffPlan, { role: 'SCHOOL_ADMIN', schoolId: 'school-eval-2', requestedSchoolId: 'school-eval-1' }).ok,
    false,
    'a request cannot override the authenticated tenant scope',
  );

  const studentPlan = buildAiQueryPlan('How many active students are enrolled?', schoolAdminContext);
  assert.ok(studentPlan);
  assert.equal(
    validateAiQueryPlan(studentPlan, { role: 'TEACHER', schoolId: 'school-eval-1' }).ok,
    false,
    'teacher role must not inherit school-admin or bursar student access',
  );
});
