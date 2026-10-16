import { Router, type Request, type Response } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedRequest } from '../middleware/roleAuth.js';
import { getSessionSecret } from '../services/security-config.js';
import { issueAttendanceStationToken } from '../services/staff-attendance-station-token.js';
import {
  buildStaffAttendanceSummary,
  computeStaffAttendanceStatus,
  getSchoolLocalDate,
  isEmployeeExpectedOnDate,
  isStaffAttendanceWorkday,
  isValidSchoolDate,
  parseWorkDays,
  schoolLocalTimeToUtc,
} from '../services/staff-attendance.js';

type AttendanceDatabase = Pick<PrismaClient, 'school' | 'employeeProfile' | 'staffAttendancePolicy' | 'staffAttendanceRecord' | 'staffAttendanceEvent' | 'attendanceStation' | 'attendanceStationEvent' | '$transaction' | 'user'>;

function schoolSession(req: Request) {
  const user = (req as AuthenticatedRequest).user;
  if (user?.role !== 'SCHOOL_ADMIN' || !user.schoolId) return null;
  return { userId: user.userId, schoolId: user.schoolId };
}

export function createStaffAttendanceRouter(database: AttendanceDatabase) {
  const router = Router();

  router.get('/stations', async (req: Request, res: Response) => {
    const session = schoolSession(req);
    if (!session) return res.status(403).json({ error: 'School administrator access required' });
    try {
      const [stations, school] = await Promise.all([
        database.attendanceStation.findMany({
          where: { schoolId: session.schoolId },
          orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
          select: { id: true, publicCode: true, name: true, locationLabel: true, isActive: true, tokenVersion: true, createdAt: true, updatedAt: true },
        }),
        database.school.findUnique({ where: { id: session.schoolId }, select: { name: true, logoUrl: true } }),
      ]);
      return res.json({ stations, school });
    } catch (error) {
      console.error('Error fetching attendance stations:', error);
      return res.status(500).json({ error: 'Failed to fetch attendance stations' });
    }
  });

  router.post('/stations', async (req: Request, res: Response) => {
    const session = schoolSession(req);
    if (!session) return res.status(403).json({ error: 'School administrator access required' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const locationLabel = typeof req.body?.locationLabel === 'string' ? req.body.locationLabel.trim() : '';
    if (!name || name.length > 80 || locationLabel.length > 120) return res.status(400).json({ error: 'Enter a station name (up to 80 characters) and a location label up to 120 characters.' });

    try {
      const station = await database.$transaction(async (tx) => {
        const actor = await tx.user.findFirst({ where: { id: session.userId, schoolId: session.schoolId, role: 'SCHOOL_ADMIN', isActive: true }, select: { id: true } });
        if (!actor) throw Object.assign(new Error('School administrator account is unavailable.'), { statusCode: 403 });
        const created = await tx.attendanceStation.create({ data: { schoolId: session.schoolId, name, locationLabel: locationLabel || null } });
        await tx.attendanceStationEvent.create({
          data: { schoolId: session.schoolId, stationId: created.id, actorUserId: actor.id, eventType: 'STATION_CREATED', reason: 'Station created by school administrator', details: { name, locationLabel: locationLabel || null } },
        });
        return created;
      });
      const school = await database.school.findUnique({ where: { id: session.schoolId }, select: { name: true, logoUrl: true } });
      return res.status(201).json({ station: { id: station.id, publicCode: station.publicCode, name: station.name, locationLabel: station.locationLabel, isActive: station.isActive, createdAt: station.createdAt }, school });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'A station with this name already exists.' });
      const statusCode = Number((error as { statusCode?: number })?.statusCode);
      if (statusCode) return res.status(statusCode).json({ error: (error as Error).message });
      console.error('Error creating attendance station:', error);
      return res.status(500).json({ error: 'Failed to create attendance station' });
    }
  });

  router.get('/stations/:stationId/code', async (req: Request, res: Response) => {
    const session = schoolSession(req);
    if (!session) return res.status(403).json({ error: 'School administrator access required' });
    const now = new Date();
    try {
      const station = await database.$transaction(async (tx) => {
        const current = await tx.attendanceStation.findFirst({ where: { id: req.params.stationId, schoolId: session.schoolId, isActive: true } });
        if (!current) return null;
        if (current.lastCodeIssuedAt && now.getTime() - current.lastCodeIssuedAt.getTime() < 8_000) {
          throw Object.assign(new Error('Wait briefly before refreshing this station code.'), { statusCode: 429 });
        }
        const updated = await tx.attendanceStation.updateMany({
          where: { id: current.id, schoolId: session.schoolId, isActive: true, tokenVersion: current.tokenVersion, lastCodeIssuedAt: current.lastCodeIssuedAt },
          data: { lastCodeIssuedAt: now },
        });
        if (updated.count !== 1) throw Object.assign(new Error('Station code was refreshed by another display request.'), { statusCode: 409 });
        await tx.attendanceStationEvent.create({
          data: {
            schoolId: session.schoolId,
            stationId: current.id,
            eventType: 'CODE_ISSUED',
            details: { tokenVersion: current.tokenVersion, issuedAt: now.toISOString() },
          },
        });
        return current;
      });
      if (!station) return res.status(404).json({ error: 'Active attendance station not found.' });
      const school = await database.school.findUnique({ where: { id: session.schoolId }, select: { name: true, logoUrl: true } });
      const signed = await issueAttendanceStationToken({ schoolId: session.schoolId, stationId: station.id, tokenVersion: station.tokenVersion, secret: getSessionSecret(), now });
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      return res.json({ station: { id: station.id, publicCode: station.publicCode, name: station.name, locationLabel: station.locationLabel }, school, stationToken: signed.token, expiresAt: signed.expiresAt.toISOString(), refreshAfterSeconds: 15 });
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode);
      if (statusCode) return res.status(statusCode).json({ error: (error as Error).message });
      console.error('Error issuing attendance station code:', error);
      return res.status(500).json({ error: 'Failed to issue attendance station code' });
    }
  });

  router.patch('/stations/:stationId/revoke', async (req: Request, res: Response) => {
    const session = schoolSession(req);
    if (!session) return res.status(403).json({ error: 'School administrator access required' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 8 || reason.length > 1000) return res.status(400).json({ error: 'Provide a revocation reason between 8 and 1,000 characters.' });

    try {
      const station = await database.$transaction(async (tx) => {
        const actor = await tx.user.findFirst({ where: { id: session.userId, schoolId: session.schoolId, role: 'SCHOOL_ADMIN', isActive: true }, select: { id: true } });
        if (!actor) throw Object.assign(new Error('School administrator account is unavailable.'), { statusCode: 403 });
        const current = await tx.attendanceStation.findFirst({ where: { id: req.params.stationId, schoolId: session.schoolId } });
        if (!current) return null;
        if (!current.isActive) return current;
        const revoked = await tx.attendanceStation.update({ where: { id: current.id }, data: { isActive: false, tokenVersion: { increment: 1 } } });
        await tx.attendanceStationEvent.create({
          data: { schoolId: session.schoolId, stationId: current.id, actorUserId: actor.id, eventType: 'STATION_REVOKED', reason, details: { previousTokenVersion: current.tokenVersion, tokenVersion: revoked.tokenVersion } },
        });
        return revoked;
      });
      if (!station) return res.status(404).json({ error: 'Attendance station not found.' });
      return res.json({ station: { id: station.id, name: station.name, isActive: station.isActive, tokenVersion: station.tokenVersion } });
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode);
      if (statusCode) return res.status(statusCode).json({ error: (error as Error).message });
      console.error('Error revoking attendance station:', error);
      return res.status(500).json({ error: 'Failed to revoke attendance station' });
    }
  });

  router.get('/policy', async (req: Request, res: Response) => {
    const session = schoolSession(req);
    if (!session) return res.status(403).json({ error: 'School administrator access required' });

    try {
      const school = await database.school.findUnique({ where: { id: session.schoolId }, select: { timezone: true } });
      if (!school) return res.status(404).json({ error: 'School not found' });
      const requestedDate = typeof req.query.date === 'string' ? req.query.date : getSchoolLocalDate(new Date(), school.timezone);
      if (!isValidSchoolDate(requestedDate)) return res.status(400).json({ error: 'Provide a valid school-local date.' });
      const date = new Date(`${requestedDate}T00:00:00.000Z`);
      const policy = await database.staffAttendancePolicy.findFirst({
        where: { schoolId: session.schoolId, isActive: true, effectiveFrom: { lte: date }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }] },
        orderBy: { effectiveFrom: 'desc' },
      });

      return res.json({
        policy: policy ?? {
          schoolId: session.schoolId,
          name: 'Standard attendance',
          shiftStartTime: '08:30',
          checkInGraceMinutes: 15,
          checkOutCutoffMinutes: 540,
          requireCheckout: true,
          workDays: '1,2,3,4,5',
          effectiveFrom: '1970-01-01',
          effectiveTo: null,
          isActive: true,
        },
        timeZone: school.timezone,
      });
    } catch (error) {
      console.error('Error fetching staff attendance policy:', error);
      return res.status(500).json({ error: 'Failed to fetch attendance policy' });
    }
  });

  router.put('/policy', async (req: Request, res: Response) => {
    const session = schoolSession(req);
    if (!session) return res.status(403).json({ error: 'School administrator access required' });

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() || 'Standard attendance' : 'Standard attendance';
    const shiftStartTime = typeof req.body?.shiftStartTime === 'string' ? req.body.shiftStartTime.trim() : '';
    const checkInGraceMinutes = Number(req.body?.checkInGraceMinutes);
    const checkOutCutoffMinutes = Number(req.body?.checkOutCutoffMinutes);
    const requireCheckout = req.body?.requireCheckout !== false;
    const workDays = typeof req.body?.workDays === 'string' ? req.body.workDays.trim() : '';
    const effectiveFrom = typeof req.body?.effectiveFrom === 'string' ? req.body.effectiveFrom : '';

    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(shiftStartTime)) return res.status(400).json({ error: 'Shift start time must be in HH:MM format.' });
    if (!Number.isInteger(checkInGraceMinutes) || checkInGraceMinutes < 0 || checkInGraceMinutes > 180
      || !Number.isInteger(checkOutCutoffMinutes) || checkOutCutoffMinutes < 60 || checkOutCutoffMinutes > 1440) {
      return res.status(400).json({ error: 'Set a valid grace period and checkout cutoff.' });
    }
    const workDayValues = parseWorkDays(workDays);
    if (!workDayValues.length || workDayValues.length !== new Set(workDays.split(',').map((value: string) => Number(value.trim()))).size) {
      return res.status(400).json({ error: 'Choose one or more workdays using ISO weekday numbers from 1 to 7.' });
    }
    if (!isValidSchoolDate(effectiveFrom)) return res.status(400).json({ error: 'Provide a valid policy effective-from date.' });

    try {
      const date = new Date(`${effectiveFrom}T00:00:00.000Z`);
      const previousDate = new Date(date.getTime() - 86_400_000);
      const policy = await database.$transaction(async (tx) => {
        const existing = await tx.staffAttendancePolicy.findFirst({ where: { schoolId: session.schoolId, name, effectiveFrom: date } });
        if (existing) {
          const records = await tx.staffAttendanceRecord.count({ where: { schoolId: session.schoolId, policyId: existing.id } });
          if (records > 0) throw Object.assign(new Error('This policy version already has attendance records; choose a later effective date.'), { statusCode: 409 });
          return tx.staffAttendancePolicy.update({
            where: { id: existing.id },
            data: { shiftStartTime, checkInGraceMinutes, checkOutCutoffMinutes, requireCheckout, workDays: workDayValues.join(','), isActive: true },
          });
        }

        const earlierPolicies = await tx.staffAttendancePolicy.findMany({
          where: { schoolId: session.schoolId, name, isActive: true, effectiveFrom: { lt: date }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }] },
          select: { id: true },
        });
        for (const earlier of earlierPolicies) {
          await tx.staffAttendancePolicy.update({ where: { id: earlier.id }, data: { effectiveTo: previousDate } });
        }

        return tx.staffAttendancePolicy.create({
          data: { schoolId: session.schoolId, name, shiftStartTime, checkInGraceMinutes, checkOutCutoffMinutes, requireCheckout, workDays: workDayValues.join(','), effectiveFrom: date, isActive: true },
        });
      });
      return res.json({ policy });
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode);
      if (statusCode) return res.status(statusCode).json({ error: (error as Error).message });
      console.error('Error saving staff attendance policy:', error);
      return res.status(500).json({ error: 'Failed to save attendance policy' });
    }
  });

  router.get('/', async (req: Request, res: Response) => {
    const session = schoolSession(req);
    if (!session) return res.status(403).json({ error: 'School administrator access required' });

    try {
      const school = await database.school.findUnique({ where: { id: session.schoolId }, select: { timezone: true } });
      if (!school) return res.status(404).json({ error: 'School not found' });
      const localDate = typeof req.query.date === 'string' ? req.query.date : getSchoolLocalDate(new Date(), school.timezone);
      if (!isValidSchoolDate(localDate)) return res.status(400).json({ error: 'Provide a valid school-local date.' });
      const attendanceDate = new Date(`${localDate}T00:00:00.000Z`);
      const policy = await database.staffAttendancePolicy.findFirst({
        where: { schoolId: session.schoolId, isActive: true, effectiveFrom: { lte: attendanceDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: attendanceDate } }] },
        orderBy: { effectiveFrom: 'desc' },
      }) ?? {
        id: null,
        schoolId: session.schoolId,
        name: 'Standard attendance',
        shiftStartTime: '08:30',
        checkInGraceMinutes: 15,
        checkOutCutoffMinutes: 540,
        requireCheckout: true,
        workDays: '1,2,3,4,5',
        effectiveFrom: new Date('1970-01-01T00:00:00.000Z'),
        effectiveTo: null,
        isActive: true,
      };
      const employees = await database.employeeProfile.findMany({
        where: {
          schoolId: session.schoolId,
          employmentStatus: 'ACTIVE',
          startDate: { lte: attendanceDate },
          AND: [{ OR: [{ endDate: null }, { endDate: { gte: attendanceDate } }] }],
          user: { isActive: true },
        },
        select: { id: true, firstName: true, lastName: true, staffNumber: true, jobTitle: true, employmentStatus: true, startDate: true, endDate: true, user: { select: { isActive: true } } },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      });
      const attendanceRecords = await database.staffAttendanceRecord.findMany({ where: { schoolId: session.schoolId, date: attendanceDate, shiftKey: 'DEFAULT' } });
      const recordsByEmployee = new Map(attendanceRecords.map((record) => [record.employeeId, record]));
      const expectedEmployees = employees.filter((employee) => isEmployeeExpectedOnDate({
        localDate,
        startDate: employee.startDate,
        endDate: employee.endDate,
        employmentStatus: employee.employmentStatus,
        userIsActive: employee.user.isActive,
        policy,
      }));
      const records = isStaffAttendanceWorkday(localDate, policy) ? expectedEmployees.map((employee) => {
        const record = recordsByEmployee.get(employee.id);
        const status = record?.status === 'ABSENT' ? 'ABSENT' : computeStaffAttendanceStatus({
          policy,
          timeZone: school.timezone,
          localDate,
          checkInAt: record?.checkInAt ?? null,
          checkOutAt: record?.checkOutAt ?? null,
          now: new Date(),
        });
        return {
          id: record?.id ?? null,
          employeeId: employee.id,
          date: localDate,
          status,
          checkInAt: record?.checkInAt?.toISOString() ?? null,
          checkOutAt: record?.checkOutAt?.toISOString() ?? null,
          reason: record?.reason ?? null,
          employee: { id: employee.id, firstName: employee.firstName, lastName: employee.lastName, staffNumber: employee.staffNumber, jobTitle: employee.jobTitle, employmentStatus: employee.employmentStatus },
        };
      }) : [];

      return res.json({
        date: localDate,
        timeZone: school.timezone,
        isWorkday: isStaffAttendanceWorkday(localDate, policy),
        policy,
        summary: buildStaffAttendanceSummary(records.map(({ status }) => ({ status }))),
        records,
      });
    } catch (error) {
      console.error('Error fetching staff attendance records:', error);
      return res.status(500).json({ error: 'Failed to fetch staff attendance records' });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    const session = schoolSession(req);
    if (!session) return res.status(403).json({ error: 'School administrator access required' });

    const employeeId = typeof req.body?.employeeId === 'string' ? req.body.employeeId.trim() : '';
    let localDate = typeof req.body?.date === 'string' ? req.body.date : '';
    const action = typeof req.body?.action === 'string' ? req.body.action.toUpperCase() : '';
    const checkInTime = typeof req.body?.checkInTime === 'string' ? req.body.checkInTime : null;
    const checkOutTime = typeof req.body?.checkOutTime === 'string' ? req.body.checkOutTime : null;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const requestedKey = req.get('Idempotency-Key') || req.body?.idempotencyKey;
    const idempotencyKey = typeof requestedKey === 'string' && requestedKey.length <= 191 ? requestedKey.trim() : '';

    if (!employeeId) return res.status(400).json({ error: 'Choose a staff member to register.' });
    if (localDate && !isValidSchoolDate(localDate)) return res.status(400).json({ error: 'Provide a valid school-local date.' });
    if (!['CHECK_IN', 'CHECK_OUT', 'CORRECT', 'ABSENT'].includes(action)) return res.status(400).json({ error: 'Choose a valid attendance action.' });
    if (action === 'CORRECT' && !checkInTime && !checkOutTime) return res.status(400).json({ error: 'Provide a corrected check-in or checkout time.' });
    if (action !== 'CORRECT' && (checkInTime || checkOutTime)) return res.status(400).json({ error: 'Client-provided timestamps are allowed only for a reasoned correction.' });
    if ((checkInTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(checkInTime)) || (checkOutTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(checkOutTime))) return res.status(400).json({ error: 'Enter valid school-local check-in and checkout times.' });
    if (reason.length < 8 || reason.length > 1000) return res.status(400).json({ error: 'Provide a reason between 8 and 1,000 characters.' });
    if (!idempotencyKey) return res.status(400).json({ error: 'An idempotency key is required for attendance writes.' });

    try {
      const school = await database.school.findUnique({ where: { id: session.schoolId }, select: { timezone: true } });
      if (!school) return res.status(404).json({ error: 'School not found' });
      if (!localDate) localDate = getSchoolLocalDate(new Date(), school.timezone);
      if ((action === 'CHECK_IN' || action === 'CHECK_OUT') && getSchoolLocalDate(new Date(), school.timezone) !== localDate) {
        return res.status(400).json({ error: 'Server-timestamped check-in/out is available only for the current school-local date. Use a reasoned correction for historical entries.' });
      }
      const attendanceDate = new Date(`${localDate}T00:00:00.000Z`);
      const policy = await database.staffAttendancePolicy.findFirst({
        where: { schoolId: session.schoolId, isActive: true, effectiveFrom: { lte: attendanceDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: attendanceDate } }] },
        orderBy: { effectiveFrom: 'desc' },
      }) ?? {
        id: null,
        schoolId: session.schoolId,
        name: 'Standard attendance',
        shiftStartTime: '08:30',
        checkInGraceMinutes: 15,
        checkOutCutoffMinutes: 540,
        requireCheckout: true,
        workDays: '1,2,3,4,5',
        effectiveFrom: new Date('1970-01-01T00:00:00.000Z'),
        effectiveTo: null,
        isActive: true,
      };
      if (!isStaffAttendanceWorkday(localDate, policy)) return res.status(400).json({ error: 'The selected date is outside the configured workdays or policy dates.' });
      const correctedCheckInAt = action === 'CORRECT' && checkInTime ? schoolLocalTimeToUtc(localDate, checkInTime, school.timezone) : null;
      const correctedCheckOutAt = action === 'CORRECT' && checkOutTime ? schoolLocalTimeToUtc(localDate, checkOutTime, school.timezone) : null;
      if (correctedCheckInAt && correctedCheckOutAt && correctedCheckOutAt < correctedCheckInAt) return res.status(400).json({ error: 'Check-out must be after check-in.' });

      const result = await database.$transaction(async (tx) => {
        const priorEvent = await tx.staffAttendanceEvent.findFirst({ where: { schoolId: session.schoolId, idempotencyKey } });
        if (priorEvent) {
          const priorRecord = await tx.staffAttendanceRecord.findFirst({ where: { id: priorEvent.attendanceId, schoolId: session.schoolId } });
          const priorDetails = priorEvent.details && typeof priorEvent.details === 'object' && !Array.isArray(priorEvent.details)
            ? priorEvent.details as Record<string, unknown>
            : {};
          const samePayload = priorDetails.action === action
            && priorDetails.checkInTime === (action === 'CORRECT' ? checkInTime : null)
            && priorDetails.checkOutTime === (action === 'CORRECT' ? checkOutTime : null)
            && priorDetails.reason === reason;
          if (!priorRecord || priorRecord.employeeId !== employeeId || priorRecord.date.getTime() !== attendanceDate.getTime() || !samePayload) {
            throw Object.assign(new Error('That idempotency key was already used for a different attendance operation.'), { statusCode: 409 });
          }
          return { record: priorRecord, duplicate: true, created: false };
        }
        const actor = await tx.user.findFirst({ where: { id: session.userId, schoolId: session.schoolId, role: 'SCHOOL_ADMIN', isActive: true }, select: { id: true } });
        if (!actor) throw Object.assign(new Error('School administrator account is unavailable.'), { statusCode: 403 });
        const employee = await tx.employeeProfile.findFirst({
          where: { id: employeeId, schoolId: session.schoolId, employmentStatus: 'ACTIVE', startDate: { lte: attendanceDate }, AND: [{ OR: [{ endDate: null }, { endDate: { gte: attendanceDate } }] }], user: { isActive: true } },
          select: { id: true },
        });
        if (!employee) throw Object.assign(new Error('Staff profile not found or not expected on this date.'), { statusCode: 404 });
        const existing = await tx.staffAttendanceRecord.findFirst({ where: { schoolId: session.schoolId, employeeId, date: attendanceDate, shiftKey: 'DEFAULT' } });
        const acceptedAt = new Date();
        let checkInAt = existing?.checkInAt ?? null;
        let checkOutAt = existing?.checkOutAt ?? null;
        if (action === 'CHECK_IN') {
          if (existing?.checkInAt) throw Object.assign(new Error('A check-in is already recorded. Use a reasoned correction to change it.'), { statusCode: 409 });
          checkInAt = acceptedAt;
        } else if (action === 'CHECK_OUT') {
          if (!existing?.checkInAt || existing.checkOutAt) throw Object.assign(new Error('A single check-in is required before checkout, and checkout can be recorded only once.'), { statusCode: 409 });
          checkOutAt = acceptedAt;
        } else if (action === 'CORRECT') {
          checkInAt = correctedCheckInAt ?? existing?.checkInAt ?? null;
          checkOutAt = correctedCheckOutAt ?? existing?.checkOutAt ?? null;
        } else {
          checkInAt = null;
          checkOutAt = null;
        }
        if (action === 'ABSENT' && computeStaffAttendanceStatus({ policy, timeZone: school.timezone, localDate, checkInAt: null, checkOutAt: null, now: acceptedAt }) === 'PENDING') {
          throw Object.assign(new Error('An employee cannot be marked absent before the configured school-local cutoff.'), { statusCode: 400 });
        }
        const status = action === 'ABSENT' ? 'ABSENT' : computeStaffAttendanceStatus({ policy, timeZone: school.timezone, localDate, checkInAt, checkOutAt, now: acceptedAt });
        if (status === 'PENDING' || status === 'NOT_CHECKED_IN' || status === 'NON_WORKDAY') throw Object.assign(new Error('Attendance needs a check-in time or an explicit absence decision.'), { statusCode: 400 });
        const beforeSnapshot = existing ? {
          date: localDate,
          shiftKey: existing.shiftKey,
          checkInAt: existing.checkInAt?.toISOString() ?? null,
          checkOutAt: existing.checkOutAt?.toISOString() ?? null,
          status: existing.status,
          reason: existing.reason,
        } : null;
        const data = { schoolId: session.schoolId, employeeId, policyId: policy.id, date: attendanceDate, shiftKey: 'DEFAULT', checkInAt, checkOutAt, status, reason };
        const record = existing
          ? await tx.staffAttendanceRecord.update({ where: { id: existing.id }, data: { policyId: policy.id, checkInAt, checkOutAt, status, reason } })
          : await tx.staffAttendanceRecord.create({ data });
        const afterSnapshot = { date: localDate, shiftKey: 'DEFAULT', checkInAt: record.checkInAt?.toISOString() ?? null, checkOutAt: record.checkOutAt?.toISOString() ?? null, status: record.status, reason: record.reason };
        await tx.staffAttendanceEvent.create({
          data: {
            schoolId: session.schoolId,
            attendanceId: record.id,
            employeeId,
            actorUserId: actor.id,
            eventType: action === 'CHECK_IN' ? 'MANUAL_CHECK_IN' : action === 'CHECK_OUT' ? 'MANUAL_CHECK_OUT' : action === 'ABSENT' ? 'MANUAL_ABSENCE' : 'MANUAL_CORRECTION',
            status,
            reason,
            idempotencyKey,
            details: { action, checkInTime: action === 'CORRECT' ? checkInTime : null, checkOutTime: action === 'CORRECT' ? checkOutTime : null, reason },
            beforeSnapshot: beforeSnapshot ?? Prisma.JsonNull,
            afterSnapshot,
          },
        });
        return { record, duplicate: false, created: !existing };
      });
      return res.status(result.duplicate || !result.created ? 200 : 201).json({ record: result.record, duplicate: result.duplicate });
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode);
      if (statusCode) return res.status(statusCode).json({ error: (error as Error).message });
      if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'An attendance record already exists for this employee and date. Reload it before correcting.' });
      console.error('Error creating staff attendance record:', error);
      return res.status(500).json({ error: 'Failed to save staff attendance' });
    }
  });

  router.get('/:attendanceId/events', async (req: Request, res: Response) => {
    const session = schoolSession(req);
    if (!session) return res.status(403).json({ error: 'School administrator access required' });

    try {
      const attendance = await database.staffAttendanceRecord.findFirst({ where: { id: req.params.attendanceId, schoolId: session.schoolId }, select: { id: true } });
      if (!attendance) return res.status(404).json({ error: 'Attendance record not found.' });
      const events = await database.staffAttendanceEvent.findMany({
        where: { attendanceId: attendance.id, schoolId: session.schoolId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, eventType: true, status: true, reason: true, beforeSnapshot: true, afterSnapshot: true, createdAt: true, actor: { select: { name: true } } },
      });
      return res.json({ events });
    } catch (error) {
      console.error('Error fetching staff attendance history:', error);
      return res.status(500).json({ error: 'Failed to fetch attendance history.' });
    }
  });

  return router;
}