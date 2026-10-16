import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planLegacyStaffBackfill, type LegacyStaffUser } from '../src/services/staff-legacy-backfill.ts';

function user(overrides: Partial<LegacyStaffUser> = {}): LegacyStaffUser {
  return {
    id: 'user_cuid_12345',
    schoolId: 'school_greenfield',
    name: 'Ada N. Okafor',
    role: 'TEACHER',
    createdAt: new Date('2022-03-14T16:30:00.000Z'),
    isActive: true,
    ...overrides,
  };
}

describe('legacy staff profile backfill plan', () => {
  it('uses the existing account and school IDs without changing identity details', () => {
    const result = planLegacyStaffBackfill([user()]);
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.candidates[0], {
      userId: 'user_cuid_12345',
      schoolId: 'school_greenfield',
      firstName: 'Ada',
      middleName: 'N.',
      lastName: 'Okafor',
      jobTitle: 'Teacher',
      classification: 'ACADEMIC',
      employmentStatus: 'ACTIVE',
      employmentType: 'FULL_TIME',
      startDate: new Date('2022-03-14T00:00:00.000Z'),
    });
  });

  it('maps an active bursar to a non-academic bursar profile', () => {
    const result = planLegacyStaffBackfill([user({ role: 'BURSAR', name: 'Timi Bello' })]);
    assert.equal(result.candidates[0]?.jobTitle, 'Bursar');
    assert.equal(result.candidates[0]?.classification, 'NON_ACADEMIC');
  });

  it('does not treat an honorific as an employee first name', () => {
    const result = planLegacyStaffBackfill([user({ name: 'Mr. Okafor' })]);
    assert.equal(result.candidates.length, 0);
    assert.deepEqual(result.skipped, [{ userId: 'user_cuid_12345', reason: 'Name is ambiguous after removing honorifics' }]);
  });

  it('skips inactive, unassigned, unclassified and ambiguous-name accounts', () => {
    const result = planLegacyStaffBackfill([
      user({ id: 'inactive', isActive: false }),
      user({ id: 'no-school', schoolId: null }),
      user({ id: 'admin', role: 'SCHOOL_ADMIN' }),
      user({ id: 'mononym', name: 'Madonna' }),
    ]);
    assert.equal(result.candidates.length, 0);
    assert.deepEqual(result.skipped.map((entry) => entry.userId), ['inactive', 'no-school', 'admin', 'mononym']);
  });
});