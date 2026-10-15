import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionAdmissionStatus, getAdmissionStatusLabel, isAdmissionApprovalStatus, normalizeAdmissionStatus, requiresAdmissionDecisionReason, validateApplicantAdmissionReply } from './admissions-utils.js';

test('normalizes known statuses to the allowed MVP values', () => {
  assert.equal(normalizeAdmissionStatus('submitted'), 'SUBMITTED');
  assert.equal(normalizeAdmissionStatus('under review'), 'UNDER_REVIEW');
  assert.equal(normalizeAdmissionStatus('under-review'), 'UNDER_REVIEW');
  assert.equal(normalizeAdmissionStatus('Approved'), 'APPROVED');
  assert.equal(normalizeAdmissionStatus('rejected'), 'REJECTED');
  assert.equal(normalizeAdmissionStatus('needs information'), 'NEEDS_INFORMATION');
  assert.equal(normalizeAdmissionStatus('needs-information'), 'NEEDS_INFORMATION');
  assert.equal(normalizeAdmissionStatus('withdrawn'), 'WITHDRAWN');
});

test('falls back to submitted for unknown values', () => {
  assert.equal(normalizeAdmissionStatus('random-status'), 'SUBMITTED');
  assert.equal(normalizeAdmissionStatus(undefined), 'SUBMITTED');
});

test('returns a readable label for each supported status', () => {
  assert.equal(getAdmissionStatusLabel('SUBMITTED'), 'Submitted');
  assert.equal(getAdmissionStatusLabel('UNDER_REVIEW'), 'Under Review');
  assert.equal(getAdmissionStatusLabel('APPROVED'), 'Approved');
  assert.equal(getAdmissionStatusLabel('REJECTED'), 'Rejected');
  assert.equal(getAdmissionStatusLabel('NEEDS_INFORMATION'), 'Needs Information');
  assert.equal(getAdmissionStatusLabel('WITHDRAWN'), 'Withdrawn');
});

test('treats mixed-case approval values as approved consistently', () => {
  assert.equal(isAdmissionApprovalStatus('approved'), true);
  assert.equal(isAdmissionApprovalStatus('Approved'), true);
  assert.equal(isAdmissionApprovalStatus('APPROVED'), true);
  assert.equal(isAdmissionApprovalStatus('REJECTED'), false);
});

test('enforces the admission review transition matrix', () => {
  assert.equal(canTransitionAdmissionStatus('SUBMITTED', 'UNDER_REVIEW'), true);
  assert.equal(canTransitionAdmissionStatus('UNDER_REVIEW', 'NEEDS_INFORMATION'), true);
  assert.equal(canTransitionAdmissionStatus('NEEDS_INFORMATION', 'UNDER_REVIEW'), true);
  assert.equal(canTransitionAdmissionStatus('APPROVED', 'UNDER_REVIEW'), false);
  assert.equal(canTransitionAdmissionStatus('REJECTED', 'APPROVED'), false);
});

test('requires a decision reason only for rejection and withdrawal', () => {
  assert.equal(requiresAdmissionDecisionReason('REJECTED'), true);
  assert.equal(requiresAdmissionDecisionReason('WITHDRAWN'), true);
  assert.equal(requiresAdmissionDecisionReason('APPROVED'), false);
  assert.equal(requiresAdmissionDecisionReason('UNDER_REVIEW'), false);
});

test('validates applicant replies with bounded normalized text', () => {
  assert.deepEqual(validateApplicantAdmissionReply('  Please see the attached record.  '), { valid: true, message: 'Please see the attached record.' });
  assert.equal(validateApplicantAdmissionReply(' ').valid, false);
  assert.equal(validateApplicantAdmissionReply('x'.repeat(5001)).valid, false);
});
