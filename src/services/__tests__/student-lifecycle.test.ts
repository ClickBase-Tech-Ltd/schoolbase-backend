import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActiveStudentWhere,
  buildStudentRosterWhere,
  filterActiveStudents,
  isStudentCurrentlyEnrolled,
  normalizeStudentEnrollmentStatus,
} from '../student-lifecycle.js';

describe('student enrollment lifecycle', () => {
  it('normalizes only supported enrollment statuses', () => {
    assert.equal(normalizeStudentEnrollmentStatus(' active '), 'ACTIVE');
    assert.equal(normalizeStudentEnrollmentStatus('inactive'), 'INACTIVE');
    assert.equal(normalizeStudentEnrollmentStatus('graduated'), null);
    assert.equal(normalizeStudentEnrollmentStatus(undefined), null);
  });

  it('treats either inactive lifecycle field as not currently enrolled', () => {
    assert.equal(isStudentCurrentlyEnrolled({ isActive: false, status: 'ACTIVE' }), false);
    assert.equal(isStudentCurrentlyEnrolled({ isActive: true, status: 'INACTIVE' }), false);
    assert.equal(isStudentCurrentlyEnrolled({ isActive: true, status: 'ACTIVE' }), true);
    assert.equal(isStudentCurrentlyEnrolled({ isActive: true, status: null }), true);
  });

  it('keeps inactive pupils out of expected class coverage while retaining active pupils', () => {
    const pupils = [
      { id: 'active', isActive: true, status: 'ACTIVE' },
      { id: 'legacy-inactive', isActive: true, status: 'INACTIVE' },
      { id: 'flag-inactive', isActive: false, status: 'ACTIVE' },
    ];
    assert.deepEqual(pupils.filter(isStudentCurrentlyEnrolled).map((pupil) => pupil.id), ['active']);
  });

  it('finds inactive records when either lifecycle field marks them inactive', () => {
    assert.deepEqual(buildStudentRosterWhere('school-1', 'INACTIVE'), {
      schoolId: 'school-1',
      OR: [{ isActive: false }, { status: 'INACTIVE' }],
    });
  });

  it('keeps inactive status values out of the active roster', () => {
    const expectedWhere = {
      schoolId: 'school-1',
      isActive: true,
      OR: [{ status: null }, { status: { not: 'INACTIVE' } }],
    };

    assert.deepEqual(buildActiveStudentWhere('school-1'), expectedWhere);
    assert.deepEqual(buildStudentRosterWhere('school-1', 'ACTIVE'), expectedWhere);
  });

  it('filters a roster to only currently enrolled pupils for active workflows', () => {
    const pupils = [
      { id: 'active', isActive: true, status: 'ACTIVE' },
      { id: 'legacy-inactive', isActive: true, status: 'INACTIVE' },
      { id: 'flag-inactive', isActive: false, status: 'ACTIVE' },
      { id: 'statusless-active', isActive: true, status: null },
    ];

    assert.deepEqual(
      filterActiveStudents(pupils).map((pupil) => pupil.id),
      ['active', 'statusless-active']
    );
  });
});