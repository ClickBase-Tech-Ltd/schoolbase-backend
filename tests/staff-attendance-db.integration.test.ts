import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import express from 'express';
import { SignJWT } from 'jose';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { getSessionSecret } from '../src/services/security-config.js';
import { getSchoolLocalDate } from '../src/services/staff-attendance.js';
import { issueAttendanceStationToken } from '../src/services/staff-attendance-station-token.js';

dotenv.config();

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL must point to a disposable migrated MySQL database.');

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
let createVerifyAuth: typeof import('../src/middleware/roleAuth.js').createVerifyAuth;
let createAdminRouteAuthorization: typeof import('../src/middleware/adminRouteAuthorization.js').createAdminRouteAuthorization;
let createStaffAttendanceRouter: typeof import('../src/routes/staff-attendance.js').createStaffAttendanceRouter;
let createStaffAttendanceScanRouter: typeof import('../src/routes/staff-attendance-scan.js').createStaffAttendanceScanRouter;
let createStaffRouter: typeof import('../src/routes/staff.js').createStaffRouter;

async function createFixture() {
  const suffix = randomUUID();
  const schoolA = await prisma.school.create({ data: { name: `Attendance Test A ${suffix}`, slug: `attendance-test-a-${suffix}` } });
  const schoolB = await prisma.school.create({ data: { name: `Attendance Test B ${suffix}`, slug: `attendance-test-b-${suffix}` } });
  const admin = await prisma.user.create({ data: { schoolId: schoolA.id, email: `attendance-admin-${suffix}@example.test`, name: 'Attendance Admin', role: 'SCHOOL_ADMIN' } });
  const linkedUser = await prisma.user.create({ data: { schoolId: schoolA.id, email: `attendance-staff-${suffix}@example.test`, name: 'Attendance Employee', role: 'STAFF' } });
  const foreignUser = await prisma.user.create({ data: { schoolId: schoolB.id, email: `attendance-foreign-${suffix}@example.test`, name: 'Foreign Employee', role: 'STAFF' } });
  const employee = await prisma.employeeProfile.create({ data: {
    schoolId: schoolA.id,
    userId: linkedUser.id,
    staffNumber: `TST/ST/2026/${suffix.slice(0, 8)}`,
    firstName: 'Attendance',
    lastName: 'Employee',
    jobTitle: 'Test staff',
    classification: 'NON_ACADEMIC',
    startDate: new Date('2026-01-01T00:00:00.000Z'),
  } });
  const foreignEmployee = await prisma.employeeProfile.create({ data: {
    schoolId: schoolB.id,
    userId: foreignUser.id,
    staffNumber: `TSTB/ST/2026/${suffix.slice(0, 8)}`,
    firstName: 'Foreign',
    lastName: 'Employee',
    jobTitle: 'Test staff',
    classification: 'NON_ACADEMIC',
    startDate: new Date('2026-01-01T00:00:00.000Z'),
  } });
  const policy = await prisma.staffAttendancePolicy.create({ data: {
    schoolId: schoolA.id,
    name: `Default ${suffix}`,
    shiftStartTime: '08:30',
    checkInGraceMinutes: 15,
    checkOutCutoffMinutes: 540,
    requireCheckout: true,
    workDays: '1,2,3,4,5,6,7',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  } });
  return { schoolA, schoolB, admin, employee, foreignEmployee, policy };
}

before(async () => {
  await prisma.$queryRaw`SELECT 1`;
  const authModule = await import('../src/middleware/roleAuth.js');
  const authorizationModule = await import('../src/middleware/adminRouteAuthorization.js');
  const attendanceModule = await import('../src/routes/staff-attendance.js');
  const scanModule = await import('../src/routes/staff-attendance-scan.js');
  const staffModule = await import('../src/routes/staff.js');
  createVerifyAuth = authModule.createVerifyAuth;
  createAdminRouteAuthorization = authorizationModule.createAdminRouteAuthorization;
  createStaffAttendanceRouter = attendanceModule.createStaffAttendanceRouter;
  createStaffAttendanceScanRouter = scanModule.createStaffAttendanceScanRouter;
  createStaffRouter = staffModule.createStaffRouter;
});

after(async () => {
  await prisma.$disconnect();
});

describe('staff attendance MySQL integration', () => {
  it('lets existing employee accounts complete and update only their own profile', async () => {
    const fixture = await createFixture();
    const legacyTeacher = await prisma.user.create({ data: {
      schoolId: fixture.schoolA.id,
      email: `legacy-teacher-${randomUUID()}@example.test`,
      name: 'Legacy Teacher',
      role: 'TEACHER',
    } });
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/staff', createStaffRouter(prisma, createVerifyAuth(prisma, getSessionSecret())));
    const server: Server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}/api/staff/me`;
    const teacherToken = await new SignJWT({ userId: legacyTeacher.id, email: legacyTeacher.email, name: legacyTeacher.name, role: 'TEACHER', schoolId: fixture.schoolA.id })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(getSessionSecret());
    const parentToken = await new SignJWT({ userId: fixture.admin.id, email: fixture.admin.email, name: fixture.admin.name, role: 'SCHOOL_ADMIN', schoolId: fixture.schoolA.id })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(getSessionSecret());

    try {
      const completed = await fetch(endpoint, {
        method: 'PUT',
        headers: { Cookie: `schoolbase_session=${teacherToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: 'Amara', middleName: 'N.', lastName: 'Okafor', phone: '+2348000000000', role: 'SCHOOL_ADMIN', isActive: false }),
      });
      assert.equal(completed.status, 200);
      const completedData = await completed.json() as { employee: { staffNumber: string; firstName: string } };
      assert.match(completedData.employee.staffNumber, /\/ST\/\d{4}\/\d{5,}$/);
      assert.equal(completedData.employee.firstName, 'Amara');

      const updated = await fetch(endpoint, {
        method: 'PUT',
        headers: { Cookie: `schoolbase_session=${teacherToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: 'Amara', middleName: '', lastName: 'Bello', phone: '+2348111111111' }),
      });
      assert.equal(updated.status, 200);
      const updatedData = await updated.json() as { employee: { lastName: string; phone: string } };
      assert.equal(updatedData.employee.lastName, 'Bello');
      assert.equal(updatedData.employee.phone, '+2348111111111');

      const persistedUser = await prisma.user.findUniqueOrThrow({ where: { id: legacyTeacher.id }, select: { role: true, isActive: true } });
      assert.deepEqual(persistedUser, { role: 'TEACHER', isActive: true });
      assert.equal(await prisma.staffEmploymentEvent.count({ where: { schoolId: fixture.schoolA.id, employee: { userId: legacyTeacher.id } } }), 2);

      const denied = await fetch(endpoint, {
        method: 'PUT',
        headers: { Cookie: `schoolbase_session=${parentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: 'Should', lastName: 'Fail' }),
      });
      assert.equal(denied.status, 403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('enforces signed active school sessions and the School Admin role over HTTP', async () => {
    const fixture = await createFixture();
    const teacher = await prisma.user.create({
      data: { schoolId: fixture.schoolA.id, email: `attendance-teacher-${randomUUID()}@example.test`, name: 'Attendance Teacher', role: 'TEACHER' },
    });
    const inactiveAdmin = await prisma.user.create({
      data: { schoolId: fixture.schoolA.id, email: `attendance-inactive-${randomUUID()}@example.test`, name: 'Inactive Admin', role: 'SCHOOL_ADMIN', isActive: false },
    });
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin', createAdminRouteAuthorization(createVerifyAuth(prisma, getSessionSecret())));
    app.use('/api/admin/staff-attendance', createStaffAttendanceRouter(prisma));
    const server: Server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}/api/admin/staff-attendance`;

    async function tokenFor(user: { id: string; email: string; name: string; role: string }, schoolId = fixture.schoolA.id) {
      return new SignJWT({ userId: user.id, email: user.email, name: user.name, role: user.role, schoolId })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(getSessionSecret());
    }

    try {
      const unauthenticated = await fetch(endpoint);
      assert.equal(unauthenticated.status, 401);

      const staffToken = await tokenFor({ id: fixture.employee.userId, email: 'staff@example.test', name: 'Attendance Employee', role: 'STAFF' });
      const staffResponse = await fetch(endpoint, { headers: { Cookie: `schoolbase_session=${staffToken}` } });
      assert.equal(staffResponse.status, 403);

      const teacherToken = await tokenFor(teacher);
      const teacherResponse = await fetch(endpoint, { headers: { Cookie: `schoolbase_session=${teacherToken}` } });
      assert.equal(teacherResponse.status, 403);

      const adminToken = await tokenFor(fixture.admin);
      const adminResponse = await fetch(endpoint, { headers: { Cookie: `schoolbase_session=${adminToken}` } });
      assert.equal(adminResponse.status, 200);
      const adminPayload = await adminResponse.json() as { records: Array<{ employeeId: string }>; summary: { expected: number } };
      assert.equal(adminPayload.summary.expected, 1);
      assert.equal(adminPayload.records[0]?.employeeId, fixture.employee.id);

      const inactiveToken = await tokenFor(inactiveAdmin);
      const inactiveResponse = await fetch(endpoint, { headers: { Cookie: `schoolbase_session=${inactiveToken}` } });
      assert.equal(inactiveResponse.status, 401);

      const wrongSchoolToken = await tokenFor(fixture.admin, fixture.schoolB.id);
      const wrongSchoolResponse = await fetch(endpoint, { headers: { Cookie: `schoolbase_session=${wrongSchoolToken}` } });
      assert.equal(wrongSchoolResponse.status, 401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('runs policy, roster, check-in/out, correction and history workflows through the HTTP API', async () => {
    const fixture = await createFixture();
    const teacher = await prisma.user.create({
      data: { schoolId: fixture.schoolA.id, email: `workflow-teacher-${randomUUID()}@example.test`, name: 'Workflow Teacher', role: 'TEACHER' },
    });
    const localDate = getSchoolLocalDate(new Date(), 'Africa/Lagos');
    const nextDate = new Date(`${localDate}T00:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const nextLocalDate = nextDate.toISOString().slice(0, 10);

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin', createAdminRouteAuthorization(createVerifyAuth(prisma, getSessionSecret())));
    app.use('/api/admin/staff-attendance', createStaffAttendanceRouter(prisma));
    const server: Server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}/api/admin/staff-attendance`;
    const token = await new SignJWT({
      userId: fixture.admin.id,
      email: fixture.admin.email,
      name: fixture.admin.name,
      role: fixture.admin.role,
      schoolId: fixture.schoolA.id,
    }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(getSessionSecret());
    const headers = { Cookie: `schoolbase_session=${token}` };

    async function send(path: string, method = 'GET', body?: unknown, idempotencyKey?: string) {
      const response = await fetch(`${endpoint}${path}`, {
        method,
        headers: {
          ...headers,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { response, data: await response.json().catch(() => ({})) as Record<string, any> };
    }

    try {
      const invalidPolicy = await send('/policy', 'PUT', {
        name: 'Standard attendance', shiftStartTime: '25:10', checkInGraceMinutes: 15,
        checkOutCutoffMinutes: 1440, requireCheckout: true, workDays: '1,2,3,4,5,6,7', effectiveFrom: localDate,
      });
      assert.equal(invalidPolicy.response.status, 400);

      const savedPolicy = await send('/policy', 'PUT', {
        name: 'Standard attendance', shiftStartTime: '08:30', checkInGraceMinutes: 15,
        checkOutCutoffMinutes: 1440, requireCheckout: true, workDays: '1,2,3,4,5,6,7', effectiveFrom: localDate,
      });
      assert.equal(savedPolicy.response.status, 200);
      assert.equal(savedPolicy.data.policy.workDays, '1,2,3,4,5,6,7');

      const roster = await send(`/?date=${localDate}`);
      assert.equal(roster.response.status, 200);
      assert.equal(roster.data.summary.expected, 1);
      assert.equal(roster.data.records[0].employeeId, fixture.employee.id);
      assert.equal(roster.data.records[0].status, 'PENDING');
      assert.equal(roster.data.timeZone, 'Africa/Lagos');

      const absenceKey = randomUUID();
      const prematureAbsence = await send('/', 'POST', {
        employeeId: fixture.employee.id, date: localDate, action: 'ABSENT', reason: 'Attempted before policy cutoff',
      }, absenceKey);
      assert.equal(prematureAbsence.response.status, 400);

      const pastWorkday = new Date(`${localDate}T00:00:00.000Z`);
      do {
        pastWorkday.setUTCDate(pastWorkday.getUTCDate() - 1);
      } while (pastWorkday.getUTCDay() === 0 || pastWorkday.getUTCDay() === 6);
      const pastAbsence = await send('/', 'POST', {
        employeeId: fixture.employee.id,
        date: pastWorkday.toISOString().slice(0, 10),
        action: 'ABSENT',
        reason: 'Verified past absence from register',
      }, randomUUID());
      assert.equal(pastAbsence.response.status, 201);
      assert.equal(pastAbsence.data.record.status, 'ABSENT');

      const checkInKey = randomUUID();
      const checkIn = await send('/', 'POST', {
        employeeId: fixture.employee.id, date: localDate, action: 'CHECK_IN', reason: 'Recorded at school entrance',
      }, checkInKey);
      assert.equal(checkIn.response.status, 201);
      assert.ok(checkIn.data.record.checkInAt);
      assert.equal(checkIn.data.record.checkOutAt, null);

      const sameReplay = await send('/', 'POST', {
        employeeId: fixture.employee.id, date: localDate, action: 'CHECK_IN', reason: 'Recorded at school entrance',
      }, checkInKey);
      assert.equal(sameReplay.response.status, 200);
      assert.equal(sameReplay.data.duplicate, true);

      const mismatchedReplay = await send('/', 'POST', {
        employeeId: fixture.employee.id, date: localDate, action: 'CHECK_OUT', reason: 'Recorded at school entrance',
      }, checkInKey);
      assert.equal(mismatchedReplay.response.status, 409);

      const duplicateCheckIn = await send('/', 'POST', {
        employeeId: fixture.employee.id, date: localDate, action: 'CHECK_IN', reason: 'Second check-in attempt',
      }, randomUUID());
      assert.equal(duplicateCheckIn.response.status, 409);

      const checkOut = await send('/', 'POST', {
        employeeId: fixture.employee.id, date: localDate, action: 'CHECK_OUT', reason: 'Recorded at school exit',
      }, randomUUID());
      assert.equal(checkOut.response.status, 200);
      assert.ok(checkOut.data.record.checkOutAt);

      const duplicateCheckOut = await send('/', 'POST', {
        employeeId: fixture.employee.id, date: localDate, action: 'CHECK_OUT', reason: 'Repeated exit action',
      }, randomUUID());
      assert.equal(duplicateCheckOut.response.status, 409);

      const correction = await send('/', 'POST', {
        employeeId: fixture.employee.id, date: localDate, action: 'CORRECT', checkInTime: '08:00', checkOutTime: '23:00', reason: 'Signed register confirms exact times',
      }, randomUUID());
      assert.equal(correction.response.status, 200);
      assert.equal(correction.data.record.status, 'PRESENT');

      const history = await send(`/${encodeURIComponent(correction.data.record.id)}/events`);
      assert.equal(history.response.status, 200);
      assert.equal(history.data.events.length, 3);
      assert.equal(history.data.events[0].eventType, 'MANUAL_CHECK_IN');
      assert.equal(history.data.events[1].eventType, 'MANUAL_CHECK_OUT');
      assert.equal(history.data.events[2].eventType, 'MANUAL_CORRECTION');
      assert.equal(history.data.events[2].reason, 'Signed register confirms exact times');
      assert.ok(history.data.events[2].beforeSnapshot.checkInAt);
      assert.equal(history.data.events[2].afterSnapshot.status, 'PRESENT');

      const retroactivePolicyEdit = await send('/policy', 'PUT', {
        name: 'Standard attendance', shiftStartTime: '08:45', checkInGraceMinutes: 15,
        checkOutCutoffMinutes: 1440, requireCheckout: true, workDays: '1,2,3,4,5,6,7', effectiveFrom: localDate,
      });
      assert.equal(retroactivePolicyEdit.response.status, 409);

      const foreignWrite = await send('/', 'POST', {
        employeeId: fixture.foreignEmployee.id, date: localDate, action: 'CHECK_IN', reason: 'Foreign employee should fail',
      }, randomUUID());
      assert.equal(foreignWrite.response.status, 404);

      const noSundayPolicy = await send('/policy', 'PUT', {
        name: 'Standard attendance', shiftStartTime: '09:00', checkInGraceMinutes: 10,
        checkOutCutoffMinutes: 600, requireCheckout: false, workDays: '1,2,3,4,5', effectiveFrom: nextLocalDate,
      });
      assert.equal(noSundayPolicy.response.status, 200);
      const tomorrowPolicy = await send(`/policy?date=${nextLocalDate}`);
      assert.equal(tomorrowPolicy.data.policy.shiftStartTime, '09:00');
      const currentPolicy = await send(`/policy?date=${localDate}`);
      assert.equal(currentPolicy.data.policy.shiftStartTime, '08:30');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('creates and revokes attendance stations and accepts only active same-school staff scans', async () => {
    const fixture = await createFixture();
    const staffUser = await prisma.user.findUniqueOrThrow({ where: { id: fixture.employee.userId } });
    const foreignUser = await prisma.user.findUniqueOrThrow({ where: { id: fixture.foreignEmployee.userId } });
    const teacherUser = await prisma.user.create({ data: { schoolId: fixture.schoolA.id, email: `attendance-teacher-linked-${randomUUID()}@example.test`, name: 'Teacher Employee', role: 'TEACHER' } });
    const teacherEmployee = await prisma.employeeProfile.create({ data: {
      schoolId: fixture.schoolA.id,
      userId: teacherUser.id,
      staffNumber: `TST/TE/2026/${randomUUID().slice(0, 8)}`,
      firstName: 'Teacher',
      lastName: 'Employee',
      jobTitle: 'Teacher',
      classification: 'ACADEMIC',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
    } });
    const unlinkedTeacher = await prisma.user.create({ data: { schoolId: fixture.schoolA.id, email: `attendance-teacher-unlinked-${randomUUID()}@example.test`, name: 'Unlinked Teacher', role: 'TEACHER' } });
    const localDate = getSchoolLocalDate(new Date(), 'Africa/Lagos');
    await prisma.staffAttendancePolicy.update({
      where: { id: fixture.policy.id },
      data: { workDays: '1,2,3,4,5,6,7', checkOutCutoffMinutes: 1440 },
    });

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin', createAdminRouteAuthorization(createVerifyAuth(prisma, getSessionSecret())));
    app.use('/api/admin/staff-attendance', createStaffAttendanceRouter(prisma));
    app.use('/api/staff/attendance', createStaffAttendanceScanRouter(prisma, getSessionSecret(), createVerifyAuth(prisma, getSessionSecret())));
    const server: Server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    async function cookie(user: { id: string; email: string; name: string; role: string }, schoolId: string) {
      return new SignJWT({ userId: user.id, email: user.email, name: user.name, role: user.role, schoolId })
        .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(getSessionSecret());
    }
    async function call(path: string, sessionToken: string, method = 'GET', body?: unknown) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Cookie: `schoolbase_session=${sessionToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { response, body: await response.json().catch(() => ({})) as Record<string, any> };
    }

    try {
      const adminCookie = await cookie(fixture.admin, fixture.schoolA.id);
      const staffCookie = await cookie(staffUser, fixture.schoolA.id);
      const foreignCookie = await cookie(foreignUser, fixture.schoolB.id);
      const teacherCookie = await cookie(teacherUser, fixture.schoolA.id);
      const unlinkedTeacherCookie = await cookie(unlinkedTeacher, fixture.schoolA.id);
      const denied = await call('/api/admin/staff-attendance/stations', staffCookie);
      assert.equal(denied.response.status, 403);

      const created = await call('/api/admin/staff-attendance/stations', adminCookie, 'POST', { name: 'Main gate', locationLabel: 'Front entrance' });
      assert.equal(created.response.status, 201);
      const stationId = created.body.station.id as string;
      const code = await call(`/api/admin/staff-attendance/stations/${stationId}/code`, adminCookie);
      assert.equal(code.response.status, 200);
      assert.equal(typeof code.body.stationToken, 'string');
      assert.equal(code.body.school.name, fixture.schoolA.name);
      assert.equal(code.response.headers.get('cache-control'), 'private, no-store, max-age=0');
      const throttledCode = await call(`/api/admin/staff-attendance/stations/${stationId}/code`, adminCookie);
      assert.equal(throttledCode.response.status, 429);
      const station = await prisma.attendanceStation.findUniqueOrThrow({ where: { id: stationId } });
      const signedCode = await issueAttendanceStationToken({ schoolId: fixture.schoolA.id, stationId, tokenVersion: station.tokenVersion, secret: getSessionSecret() });

      const foreignScan = await call('/api/staff/attendance/scan', foreignCookie, 'POST', { stationToken: signedCode.token, requestedAction: 'CHECK_IN' });
      assert.equal(foreignScan.response.status, 404);

      const firstScan = await call('/api/staff/attendance/scan', staffCookie, 'POST', { stationToken: signedCode.token, requestedAction: 'CHECK_IN' });
      assert.equal(firstScan.response.status, 201);
      assert.equal(firstScan.body.accepted, true);
      assert.equal(firstScan.body.action, 'CHECK_IN');
      assert.ok(firstScan.body.checkInAt);
      const accidentalCheckoutAttempt = await call('/api/staff/attendance/scan', staffCookie, 'POST', { stationToken: signedCode.token, requestedAction: 'CHECK_IN' });
      assert.equal(accidentalCheckoutAttempt.response.status, 409);
      assert.equal(accidentalCheckoutAttempt.body.nextAction, 'CHECK_OUT');
      assert.equal((await prisma.staffAttendanceRecord.findFirstOrThrow({ where: { schoolId: fixture.schoolA.id, employeeId: fixture.employee.id, date: new Date(`${localDate}T00:00:00.000Z`) } })).checkOutAt, null);

      const linkedTeacherScan = await call('/api/staff/attendance/scan', teacherCookie, 'POST', { stationToken: signedCode.token, requestedAction: 'CHECK_IN' });
      assert.equal(linkedTeacherScan.response.status, 201);
      assert.equal(linkedTeacherScan.body.accepted, true);
      assert.equal(linkedTeacherScan.body.action, 'CHECK_IN');
      const unlinkedTeacherScan = await call('/api/staff/attendance/scan', unlinkedTeacherCookie, 'POST', { stationToken: signedCode.token, requestedAction: 'CHECK_IN' });
      assert.equal(unlinkedTeacherScan.response.status, 403);

      const repeatedScan = await call('/api/staff/attendance/scan', staffCookie, 'POST', { stationToken: signedCode.token, requestedAction: 'CHECK_IN' });
      assert.equal(repeatedScan.response.status, 200);
      assert.equal(repeatedScan.body.duplicate, true);

      const printStaffUser = await prisma.user.create({ data: { schoolId: fixture.schoolA.id, email: `print-staff-${randomUUID()}@example.test`, name: 'Printed Code Employee', role: 'STAFF' } });
      const printEmployee = await prisma.employeeProfile.create({ data: {
        schoolId: fixture.schoolA.id,
        userId: printStaffUser.id,
        staffNumber: `PRT/ST/2026/${randomUUID().slice(0, 8)}`,
        firstName: 'Printed',
        lastName: 'Employee',
        jobTitle: 'Test staff',
        classification: 'NON_ACADEMIC',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
      } });
      const printStaffCookie = await cookie(printStaffUser, fixture.schoolA.id);
      const printRequestId = randomUUID();
      const printedScan = await call('/api/staff/attendance/scan', printStaffCookie, 'POST', {
        stationCode: station.publicCode,
        scanRequestId: printRequestId,
        requestedAction: 'CHECK_IN',
      });
      assert.equal(printedScan.response.status, 201);
      assert.equal(printedScan.body.action, 'CHECK_IN');
      assert.ok(printedScan.body.checkInAt);
      const printedScanRetry = await call('/api/staff/attendance/scan', printStaffCookie, 'POST', {
        stationCode: station.publicCode,
        scanRequestId: printRequestId,
        requestedAction: 'CHECK_IN',
      });
      assert.equal(printedScanRetry.response.status, 200);
      assert.equal(printedScanRetry.body.duplicate, true);

      const concurrentUser = await prisma.user.create({ data: { schoolId: fixture.schoolA.id, email: `concurrent-staff-${randomUUID()}@example.test`, name: 'Concurrent Scan Employee', role: 'STAFF' } });
      const concurrentEmployee = await prisma.employeeProfile.create({ data: {
        schoolId: fixture.schoolA.id,
        userId: concurrentUser.id,
        staffNumber: `CON/ST/2026/${randomUUID().slice(0, 8)}`,
        firstName: 'Concurrent',
        lastName: 'Employee',
        jobTitle: 'Test staff',
        classification: 'NON_ACADEMIC',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
      } });
      const concurrentCookie = await cookie(concurrentUser, fixture.schoolA.id);
      const concurrentToken = await issueAttendanceStationToken({ schoolId: fixture.schoolA.id, stationId, tokenVersion: station.tokenVersion, secret: getSessionSecret() });
      const concurrentResponses = await Promise.all([
        call('/api/staff/attendance/scan', concurrentCookie, 'POST', { stationToken: concurrentToken.token, requestedAction: 'CHECK_IN' }),
        call('/api/staff/attendance/scan', concurrentCookie, 'POST', { stationToken: concurrentToken.token, requestedAction: 'CHECK_IN' }),
      ]);
      assert.equal(concurrentResponses.filter(({ response }) => response.status === 201).length, 1);
      assert.equal(concurrentResponses.filter(({ response }) => response.status === 409).length, 1);
      assert.equal(await prisma.staffAttendanceRecord.count({ where: { schoolId: fixture.schoolA.id, employeeId: concurrentEmployee.id, date: new Date(`${localDate}T00:00:00.000Z`) } }), 1);
      assert.equal(await prisma.staffAttendanceEvent.count({ where: { schoolId: fixture.schoolA.id, employeeId: concurrentEmployee.id, stationId } }), 1);

      const revokedUser = await prisma.user.create({ data: { schoolId: fixture.schoolA.id, email: `revoked-staff-${randomUUID()}@example.test`, name: 'Revoked Scan Employee', role: 'STAFF' } });
      await prisma.employeeProfile.create({ data: {
        schoolId: fixture.schoolA.id,
        userId: revokedUser.id,
        staffNumber: `REV/ST/2026/${randomUUID().slice(0, 8)}`,
        firstName: 'Revoked',
        lastName: 'Employee',
        jobTitle: 'Test staff',
        classification: 'NON_ACADEMIC',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
      } });
      const revokedUserCookie = await cookie(revokedUser, fixture.schoolA.id);
      await prisma.user.update({ where: { id: revokedUser.id }, data: { isActive: false } });
      const revokedAccountScan = await call('/api/staff/attendance/scan', revokedUserCookie, 'POST', { stationToken: concurrentToken.token, requestedAction: 'CHECK_IN' });
      assert.equal(revokedAccountScan.response.status, 401);

      await prisma.attendanceStation.update({ where: { id: stationId }, data: { lastCodeIssuedAt: new Date(Date.now() - 9_000) } });
      const nextCode = await call(`/api/admin/staff-attendance/stations/${stationId}/code`, adminCookie);
      assert.equal(nextCode.response.status, 200);
      const refreshedStation = await prisma.attendanceStation.findUniqueOrThrow({ where: { id: stationId } });
      const secondSignedCode = await issueAttendanceStationToken({ schoolId: fixture.schoolA.id, stationId, tokenVersion: refreshedStation.tokenVersion, secret: getSessionSecret() });
      const wrongStepCheckout = await call('/api/staff/attendance/scan', staffCookie, 'POST', { stationToken: secondSignedCode.token, requestedAction: 'CHECK_IN' });
      assert.equal(wrongStepCheckout.response.status, 409);
      const checkout = await call('/api/staff/attendance/scan', staffCookie, 'POST', { stationToken: secondSignedCode.token, requestedAction: 'CHECK_OUT' });
      assert.equal(checkout.response.status, 201);
      assert.equal(checkout.body.action, 'CHECK_OUT');
      assert.ok(checkout.body.checkOutAt);
      const afterCheckoutStation = await prisma.attendanceStation.findUniqueOrThrow({ where: { id: stationId } });
      const afterCheckoutCode = await issueAttendanceStationToken({ schoolId: fixture.schoolA.id, stationId, tokenVersion: afterCheckoutStation.tokenVersion, secret: getSessionSecret() });
      const postCheckoutScan = await call('/api/staff/attendance/scan', staffCookie, 'POST', { stationToken: afterCheckoutCode.token, requestedAction: 'CHECK_IN' });
      assert.equal(postCheckoutScan.response.status, 409);
      assert.equal(postCheckoutScan.body.nextAction, 'COMPLETE');

      const revoked = await call(`/api/admin/staff-attendance/stations/${stationId}/revoke`, adminCookie, 'PATCH', { reason: 'Station replaced after security review' });
      assert.equal(revoked.response.status, 200);
      assert.equal(revoked.body.station.isActive, false);
      const afterRevoke = await call('/api/staff/attendance/scan', staffCookie, 'POST', { stationToken: secondSignedCode.token, requestedAction: 'CHECK_OUT' });
      assert.equal(afterRevoke.response.status, 410);
      const printedCodeAfterRevoke = await call('/api/staff/attendance/scan', printStaffCookie, 'POST', {
        stationCode: station.publicCode,
        scanRequestId: randomUUID(),
        requestedAction: 'CHECK_IN',
      });
      assert.equal(printedCodeAfterRevoke.response.status, 410);

      const record = await prisma.staffAttendanceRecord.findFirst({ where: { schoolId: fixture.schoolA.id, employeeId: fixture.employee.id, date: new Date(`${localDate}T00:00:00.000Z`) } });
      assert.ok(record?.checkInAt && record.checkOutAt);
      const teacherRecord = await prisma.staffAttendanceRecord.findFirst({ where: { schoolId: fixture.schoolA.id, employeeId: teacherEmployee.id, date: new Date(`${localDate}T00:00:00.000Z`) } });
      assert.ok(teacherRecord?.checkInAt);
      const events = await prisma.staffAttendanceEvent.findMany({ where: { schoolId: fixture.schoolA.id, stationId }, orderBy: { createdAt: 'asc' } });
      assert.equal(events.filter((event) => event.eventType === 'STATION_CHECK_IN').length, 4);
      assert.equal(events.filter((event) => event.eventType === 'STATION_CHECK_OUT').length, 1);
      assert.equal(events.filter((event) => event.employeeId === printEmployee.id).length, 1);
      assert.equal(events.filter((event) => event.employeeId === concurrentEmployee.id).length, 1);
      const stationEvents = await prisma.attendanceStationEvent.findMany({ where: { schoolId: fixture.schoolA.id, stationId }, orderBy: { createdAt: 'asc' } });
      assert.deepEqual(stationEvents.map((event) => event.eventType), ['STATION_CREATED', 'CODE_ISSUED', 'CODE_ISSUED', 'STATION_REVOKED']);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects concurrent duplicate employee/date/shift rows with the database unique key', async () => {
    const fixture = await createFixture();
    const date = new Date('2026-10-16T00:00:00.000Z');
    const results = await Promise.allSettled([
      prisma.staffAttendanceRecord.create({ data: { schoolId: fixture.schoolA.id, employeeId: fixture.employee.id, policyId: fixture.policy.id, date, shiftKey: 'DEFAULT', status: 'PRESENT', checkInAt: new Date('2026-10-16T07:30:00.000Z') } }),
      prisma.staffAttendanceRecord.create({ data: { schoolId: fixture.schoolA.id, employeeId: fixture.employee.id, policyId: fixture.policy.id, date, shiftKey: 'DEFAULT', status: 'PRESENT', checkInAt: new Date('2026-10-16T07:31:00.000Z') } }),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal((rejected?.reason as { code?: string })?.code, 'P2002');
    assert.equal(await prisma.staffAttendanceRecord.count({ where: { schoolId: fixture.schoolA.id, employeeId: fixture.employee.id, date, shiftKey: 'DEFAULT' } }), 1);
  });

  it('commits a correction and immutable before/after event in one transaction', async () => {
    const fixture = await createFixture();
    const date = new Date('2026-10-16T00:00:00.000Z');
    const original = await prisma.staffAttendanceRecord.create({ data: { schoolId: fixture.schoolA.id, employeeId: fixture.employee.id, policyId: fixture.policy.id, date, shiftKey: 'DEFAULT', status: 'LATE', checkInAt: new Date('2026-10-16T07:50:00.000Z'), reason: 'Original late check-in' } });
    const beforeSnapshot = { status: original.status, checkInAt: original.checkInAt?.toISOString() ?? null, checkOutAt: null, reason: original.reason };
    const correctedAt = new Date('2026-10-16T07:40:00.000Z');
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.staffAttendanceRecord.update({ where: { id: original.id }, data: { status: 'PRESENT', checkInAt: correctedAt, reason: 'Corrected from signed register' } });
      await tx.staffAttendanceEvent.create({ data: {
        schoolId: fixture.schoolA.id,
        attendanceId: original.id,
        employeeId: fixture.employee.id,
        actorUserId: fixture.admin.id,
        eventType: 'MANUAL_CORRECTION',
        status: 'PRESENT',
        reason: 'Corrected from signed register',
        idempotencyKey: randomUUID(),
        beforeSnapshot,
        afterSnapshot: { status: updated.status, checkInAt: updated.checkInAt?.toISOString() ?? null, checkOutAt: null, reason: updated.reason },
      } });
      return updated;
    });

    const events = await prisma.staffAttendanceEvent.findMany({ where: { attendanceId: original.id, schoolId: fixture.schoolA.id }, orderBy: { createdAt: 'asc' } });
    assert.equal(result.status, 'PRESENT');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].beforeSnapshot, beforeSnapshot);
    assert.deepEqual(events[0].afterSnapshot, { status: 'PRESENT', checkInAt: correctedAt.toISOString(), checkOutAt: null, reason: 'Corrected from signed register' });
    assert.equal(events[0].actorUserId, fixture.admin.id);
  });

  it('rolls back the attendance projection when the idempotency event insert conflicts', async () => {
    const fixture = await createFixture();
    const idempotencyKey = randomUUID();
    const date = new Date('2026-10-16T00:00:00.000Z');
    const existing = await prisma.staffAttendanceRecord.create({ data: { schoolId: fixture.schoolA.id, employeeId: fixture.employee.id, policyId: fixture.policy.id, date, shiftKey: 'DEFAULT', status: 'PRESENT' } });
    await prisma.staffAttendanceEvent.create({ data: { schoolId: fixture.schoolA.id, attendanceId: existing.id, employeeId: fixture.employee.id, actorUserId: fixture.admin.id, eventType: 'MANUAL_REGISTER', status: 'PRESENT', reason: 'Initial attendance accepted', idempotencyKey } });
    const secondDate = new Date('2026-10-19T00:00:00.000Z');

    await assert.rejects(prisma.$transaction(async (tx) => {
      const created = await tx.staffAttendanceRecord.create({ data: { schoolId: fixture.schoolA.id, employeeId: fixture.employee.id, policyId: fixture.policy.id, date: secondDate, shiftKey: 'DEFAULT', status: 'PRESENT' } });
      await tx.staffAttendanceEvent.create({ data: { schoolId: fixture.schoolA.id, attendanceId: created.id, employeeId: fixture.employee.id, actorUserId: fixture.admin.id, eventType: 'MANUAL_REGISTER', status: 'PRESENT', reason: 'Reused idempotency key must roll back', idempotencyKey } });
    }), (error: unknown) => (error as { code?: string }).code === 'P2002');

    assert.equal(await prisma.staffAttendanceRecord.count({ where: { schoolId: fixture.schoolA.id, employeeId: fixture.employee.id, date: secondDate } }), 0);
  });

  it('scopes employee lookups to the authenticated school and hides foreign profiles', async () => {
    const fixture = await createFixture();

    assert.equal(await prisma.employeeProfile.findFirst({ where: { id: fixture.foreignEmployee.id, schoolId: fixture.schoolA.id } }), null);
    assert.notEqual(await prisma.employeeProfile.findFirst({ where: { id: fixture.foreignEmployee.id, schoolId: fixture.schoolB.id } }), null);
    assert.equal(await prisma.staffAttendanceRecord.count({ where: { schoolId: fixture.schoolA.id, employeeId: fixture.foreignEmployee.id } }), 0);
  });
});
