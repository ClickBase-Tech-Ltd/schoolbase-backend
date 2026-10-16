export type PersistedStaffAttendanceStatus = 'PRESENT' | 'LATE' | 'MISSING_CHECKOUT' | 'ABSENT';
export type StaffAttendanceStatus = PersistedStaffAttendanceStatus | 'PENDING' | 'NOT_CHECKED_IN' | 'NON_WORKDAY';

export interface StaffAttendancePolicyInput {
  shiftStartTime: string;
  checkInGraceMinutes: number;
  checkOutCutoffMinutes: number;
  requireCheckout: boolean;
  workDays: string;
  effectiveFrom: string | Date;
  effectiveTo: string | Date | null;
}

export interface EvaluateStaffAttendanceInput {
  policy: StaffAttendancePolicyInput;
  timeZone: string;
  localDate: string;
  checkInAt: string | Date | null;
  checkOutAt: string | Date | null;
  now?: Date;
}

export interface StaffAttendanceRosterRow {
  status: StaffAttendanceStatus;
}

function dateString(value: string | Date) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function getSchoolLocalDate(date: Date, timeZone: string) {
  const parts = localParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isValidSchoolDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseWorkDays(value: string) {
  const days = value.split(',').map((day) => Number(day.trim()));
  if (!days.length || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) return [];
  return [...new Set(days)];
}

export function isStaffAttendanceWorkday(localDate: string, policy: StaffAttendancePolicyInput) {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  const isoWeekday = date.getUTCDay() || 7;
  const start = dateString(policy.effectiveFrom);
  const end = policy.effectiveTo ? dateString(policy.effectiveTo) : null;
  return localDate >= start && (!end || localDate <= end) && parseWorkDays(policy.workDays).includes(isoWeekday);
}

export function isEmployeeExpectedOnDate(input: {
  localDate: string;
  startDate: string | Date;
  endDate?: string | Date | null;
  employmentStatus: string;
  userIsActive: boolean;
  policy: StaffAttendancePolicyInput;
}) {
  const start = dateString(input.startDate);
  const end = input.endDate ? dateString(input.endDate) : null;
  return input.employmentStatus === 'ACTIVE'
    && input.userIsActive
    && input.localDate >= start
    && (!end || input.localDate <= end)
    && isStaffAttendanceWorkday(input.localDate, input.policy);
}

function clockMinutes(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Invalid policy clock value');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error('Invalid policy clock value');
  return hours * 60 + minutes;
}

function instantMinutes(value: Date, timeZone: string) {
  const parts = localParts(value, timeZone);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function computeStaffAttendanceStatus(input: EvaluateStaffAttendanceInput): StaffAttendanceStatus {
  const { policy, timeZone, localDate } = input;
  if (!isStaffAttendanceWorkday(localDate, policy)) return 'NON_WORKDAY';

  const start = clockMinutes(policy.shiftStartTime);
  const checkInDeadline = start + policy.checkInGraceMinutes;
  const checkOutDeadline = start + policy.checkOutCutoffMinutes;
  const checkIn = input.checkInAt ? new Date(input.checkInAt) : null;
  const checkOut = input.checkOutAt ? new Date(input.checkOutAt) : null;

  if (checkIn && getSchoolLocalDate(checkIn, timeZone) !== localDate) throw new Error('Check-in must fall on the selected school-local date');
  if (checkOut && getSchoolLocalDate(checkOut, timeZone) !== localDate) throw new Error('Check-out must fall on the selected school-local date');

  if (!checkIn) {
    const currentLocalDate = getSchoolLocalDate(input.now ?? new Date(), timeZone);
    if (currentLocalDate < localDate || (currentLocalDate === localDate && instantMinutes(input.now ?? new Date(), timeZone) < checkOutDeadline)) return 'PENDING';
    return 'NOT_CHECKED_IN';
  }

  const status: PersistedStaffAttendanceStatus = instantMinutes(checkIn, timeZone) > checkInDeadline ? 'LATE' : 'PRESENT';
  if (checkOut || !policy.requireCheckout) return status;

  const currentLocalDate = getSchoolLocalDate(input.now ?? new Date(), timeZone);
  if (currentLocalDate > localDate || (currentLocalDate === localDate && instantMinutes(input.now ?? new Date(), timeZone) >= checkOutDeadline)) {
    return 'MISSING_CHECKOUT';
  }

  return status;
}

export function buildStaffAttendanceSummary(rows: StaffAttendanceRosterRow[]) {
  return rows.reduce((summary, row) => {
    summary.expected += 1;
    if (row.status === 'PRESENT') summary.present += 1;
    else if (row.status === 'LATE') summary.late += 1;
    else if (row.status === 'MISSING_CHECKOUT') summary.missingCheckout += 1;
    else if (row.status === 'ABSENT') summary.absent += 1;
    else if (row.status === 'PENDING') summary.pending += 1;
    else if (row.status === 'NOT_CHECKED_IN') summary.notCheckedIn += 1;
    return summary;
  }, { expected: 0, present: 0, late: 0, missingCheckout: 0, absent: 0, pending: 0, notCheckedIn: 0 });
}

export function schoolLocalTimeToUtc(localDate: string, localTime: string, timeZone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) {
    throw new Error('Provide a valid school-local date and time');
  }

  const desired = `${localDate}T${localTime}`;
  const desiredUtc = Date.parse(`${desired}:00Z`);
  let guess = desiredUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = localParts(new Date(guess), timeZone);
    const actual = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
    const delta = Date.parse(`${desired}:00Z`) - Date.parse(`${actual}:00Z`);
    if (delta === 0) return new Date(guess);
    guess += delta;
  }

  const finalParts = localParts(new Date(guess), timeZone);
  if (`${finalParts.year}-${finalParts.month}-${finalParts.day}T${finalParts.hour}:${finalParts.minute}` !== desired) {
    throw new Error('That local time does not exist in the school timezone');
  }
  return new Date(guess);
}
