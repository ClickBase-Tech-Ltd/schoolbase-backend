import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildStaffAttendanceSummary,
  computeStaffAttendanceStatus,
  getSchoolLocalDate,
  isEmployeeExpectedOnDate,
  isStaffAttendanceWorkday,
  isValidSchoolDate,
  schoolLocalTimeToUtc,
  type StaffAttendancePolicyInput,
} from '../src/services/staff-attendance.ts';

const policy: StaffAttendancePolicyInput = {
  shiftStartTime: '08:30',
  checkInGraceMinutes: 15,
  checkOutCutoffMinutes: 540,
  requireCheckout: true,
  workDays: '1,2,3,4,5',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
};

describe('staff attendance policy', () => {
  it('marks check-ins on time through the grace boundary and late afterwards', () => {
    assert.equal(
      computeStaffAttendanceStatus({
        policy,
        timeZone: 'Africa/Lagos',
        localDate: '2026-10-16',
        checkInAt: '2026-10-16T07:44:00.000Z',
        checkOutAt: null,
        now: new Date('2026-10-16T10:00:00.000Z'),
      }),
      'PRESENT',
    );

    assert.equal(
      computeStaffAttendanceStatus({
        policy,
        timeZone: 'Africa/Lagos',
        localDate: '2026-10-16',
        checkInAt: '2026-10-16T07:46:00.000Z',
        checkOutAt: null,
        now: new Date('2026-10-16T10:00:00.000Z'),
      }),
      'LATE',
    );
  });

  it('keeps pending, not checked in and missing checkout distinct without inferring absence', () => {
    assert.equal(
      computeStaffAttendanceStatus({
        policy,
        timeZone: 'Africa/Lagos',
        localDate: '2026-10-16',
        checkInAt: '2026-10-16T07:20:00.000Z',
        checkOutAt: null,
        now: new Date('2026-10-16T17:00:00.000Z'),
      }),
      'MISSING_CHECKOUT',
    );

    assert.equal(
      computeStaffAttendanceStatus({
        policy,
        timeZone: 'Africa/Lagos',
        localDate: '2026-10-16',
        checkInAt: null,
        checkOutAt: null,
        now: new Date('2026-10-16T08:00:00.000Z'),
      }),
      'PENDING',
    );

    assert.equal(
      computeStaffAttendanceStatus({
        policy,
        timeZone: 'Africa/Lagos',
        localDate: '2026-10-16',
        checkInAt: null,
        checkOutAt: null,
        now: new Date('2026-10-16T17:00:00.000Z'),
      }),
      'NOT_CHECKED_IN',
    );
  });

  it('reconciles expected roster categories without counting leave or pending twice', () => {
    const summary = buildStaffAttendanceSummary([
      { status: 'PRESENT' },
      { status: 'LATE' },
      { status: 'MISSING_CHECKOUT' },
      { status: 'PENDING' },
      { status: 'NOT_CHECKED_IN' },
      { status: 'PRESENT' },
    ]);

    assert.deepEqual(summary, {
      expected: 6,
      present: 2,
      late: 1,
      missingCheckout: 1,
      absent: 0,
      pending: 1,
      notCheckedIn: 1,
    });
  });

  it('evaluates weekdays, effective dates and employee employment dates', () => {
    assert.equal(isStaffAttendanceWorkday('2026-10-16', policy), true);
    assert.equal(isStaffAttendanceWorkday('2026-10-17', policy), false);
    assert.equal(isStaffAttendanceWorkday('2025-12-31', policy), false);
    assert.equal(isEmployeeExpectedOnDate({
      localDate: '2026-10-16',
      startDate: '2026-01-01',
      endDate: null,
      employmentStatus: 'ACTIVE',
      userIsActive: true,
      policy,
    }), true);
    assert.equal(isEmployeeExpectedOnDate({
      localDate: '2026-10-16',
      startDate: '2026-10-17',
      endDate: null,
      employmentStatus: 'ACTIVE',
      userIsActive: true,
      policy,
    }), false);
  });

  it('uses the school timezone for local work dates and timestamp conversion', () => {
    const instant = new Date('2026-10-16T00:30:00.000Z');
    assert.equal(getSchoolLocalDate(instant, 'Africa/Lagos'), '2026-10-16');
    assert.equal(getSchoolLocalDate(instant, 'America/New_York'), '2026-10-15');
    assert.equal(schoolLocalTimeToUtc('2026-10-16', '08:30', 'Africa/Lagos').toISOString(), '2026-10-16T07:30:00.000Z');
    assert.equal(schoolLocalTimeToUtc('2026-03-08', '01:30', 'America/New_York').toISOString(), '2026-03-08T06:30:00.000Z');
    assert.equal(isValidSchoolDate('2026-10-16'), true);
    assert.equal(isValidSchoolDate('2026-02-30'), false);
  });
});
