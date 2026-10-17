import { Prisma, PrismaClient } from '@prisma/client';
import { Router, type RequestHandler, type Response } from 'express';
import { verifyAuth, type AuthenticatedRequest } from '../middleware/roleAuth.js';
import { computeStaffAttendanceStatus, getSchoolLocalDate, isStaffAttendanceWorkday } from '../services/staff-attendance.js';
import { getSessionSecret } from '../services/security-config.js';
import { verifyAttendanceStationToken } from '../services/staff-attendance-station-token.js';

const SCAN_WINDOW_MS = 60_000;
const MAX_STATION_SCANS_PER_WINDOW = 60;
const prisma = new PrismaClient();

export function createStaffAttendanceScanRouter(database: PrismaClient, stationSecret: Uint8Array = getSessionSecret(), authenticate: RequestHandler = verifyAuth) {
  const router = Router();
  router.use(authenticate);

  router.post('/scan', async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user;
    if (!user?.userId || !['STAFF', 'TEACHER'].includes(user.role) || !user.schoolId) return res.status(403).json({ error: 'Active employee account required.' });
    const stationToken = typeof req.body?.stationToken === 'string' ? req.body.stationToken.trim() : '';
    const stationCode = typeof req.body?.stationCode === 'string' ? req.body.stationCode.trim() : '';
    const scanRequestId = typeof req.body?.scanRequestId === 'string' ? req.body.scanRequestId.trim() : '';
    if ((!stationToken && !stationCode) || (stationToken && stationCode) || stationToken.length > 4096 || stationCode.length > 191) {
      return res.status(400).json({ error: 'Provide either the current station token or printed station locator.' });
    }
    if (stationCode && !/^[a-zA-Z0-9_-]{12,191}$/.test(stationCode)) return res.status(400).json({ error: 'Printed station locator is invalid.' });
    if (stationCode && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scanRequestId)) {
      return res.status(400).json({ error: 'Provide a unique scan request ID for this printed station scan.' });
    }

    try {
      const printedLocator = Boolean(stationCode);
      const token = printedLocator
        ? await database.attendanceStation.findUnique({ where: { publicCode: stationCode }, select: { id: true, schoolId: true, tokenVersion: true } }).then((station) => station ? ({ stationId: station.id, schoolId: station.schoolId, tokenVersion: station.tokenVersion, jti: scanRequestId }) : null)
        : await verifyAttendanceStationToken(stationToken, stationSecret);
      if (!token) return res.status(404).json({ error: 'Attendance station not found.' });
      if (token.schoolId !== user.schoolId) return res.status(404).json({ error: 'Attendance station not found.' });

      const result = await database.$transaction(async (tx) => {
        const employee = await tx.employeeProfile.findFirst({
          where: { userId: user.userId, schoolId: user.schoolId, employmentStatus: 'ACTIVE', user: { isActive: true } },
          select: { id: true, startDate: true, endDate: true },
        });
        if (!employee) throw Object.assign(new Error('Active employee profile required.'), { statusCode: 403 });
        const school = await tx.school.findUnique({ where: { id: user.schoolId }, select: { timezone: true } });
        if (!school) throw Object.assign(new Error('School not found.'), { statusCode: 404 });
        const station = await tx.attendanceStation.findFirst({
          where: { id: token.stationId, schoolId: user.schoolId, isActive: true, tokenVersion: token.tokenVersion },
          select: { id: true, scanWindowStartedAt: true, scanWindowCount: true },
        });
        if (!station) throw Object.assign(new Error('Attendance station is inactive or has been rotated.'), { statusCode: 410 });

        const idempotencyKey = `${printedLocator ? 'placard' : 'station'}:${token.jti}:${employee.id}`;
        const previousEvent = await tx.staffAttendanceEvent.findFirst({ where: { schoolId: user.schoolId, idempotencyKey } });
        if (previousEvent) {
          const previousRecord = await tx.staffAttendanceRecord.findFirst({ where: { id: previousEvent.attendanceId, schoolId: user.schoolId } });
          if (!previousRecord) throw new Error('Attendance event has no current record');
          return { record: previousRecord, action: String((previousEvent.details as { action?: string } | null)?.action ?? 'CHECK_IN'), duplicate: true };
        }

        const now = new Date();
        const currentWindow = station.scanWindowStartedAt && now.getTime() - station.scanWindowStartedAt.getTime() < SCAN_WINDOW_MS;
        if (currentWindow && station.scanWindowCount >= MAX_STATION_SCANS_PER_WINDOW) {
          throw Object.assign(new Error('This station has reached its scan limit. Please use the supervised manual register.'), { statusCode: 429 });
        }
        const windowStartedAt = currentWindow ? station.scanWindowStartedAt : now;
        const updatedCounter = await tx.attendanceStation.updateMany({
          where: {
            id: station.id,
            schoolId: user.schoolId,
            isActive: true,
            tokenVersion: token.tokenVersion,
            scanWindowStartedAt: station.scanWindowStartedAt,
            scanWindowCount: station.scanWindowCount,
          },
          data: { scanWindowStartedAt: windowStartedAt, scanWindowCount: currentWindow ? { increment: 1 } : 1 },
        });
        if (updatedCounter.count !== 1) throw Object.assign(new Error('Station is busy; scan the current code again.'), { statusCode: 409 });

        const localDate = getSchoolLocalDate(now, school.timezone);
        const attendanceDate = new Date(`${localDate}T00:00:00.000Z`);
        if (employee.startDate > attendanceDate || (employee.endDate && employee.endDate < attendanceDate)) {
          throw Object.assign(new Error('Employee is not eligible for attendance on this date.'), { statusCode: 403 });
        }
        const policy = await tx.staffAttendancePolicy.findFirst({
          where: { schoolId: user.schoolId, isActive: true, effectiveFrom: { lte: attendanceDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: attendanceDate } }] },
          orderBy: { effectiveFrom: 'desc' },
        }) ?? {
          id: null,
          schoolId: user.schoolId,
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
        if (!isStaffAttendanceWorkday(localDate, policy)) throw Object.assign(new Error('Attendance is not scheduled for this school-local date.'), { statusCode: 400 });

        const existing = await tx.staffAttendanceRecord.findFirst({
          where: { schoolId: user.schoolId, employeeId: employee.id, date: attendanceDate, shiftKey: 'DEFAULT' },
        });
        if (existing?.status === 'ABSENT') throw Object.assign(new Error('An absence has already been recorded; contact the school administrator.'), { statusCode: 409 });
        const action = existing?.checkInAt && !existing.checkOutAt ? 'CHECK_OUT' : 'CHECK_IN';
        if (action === 'CHECK_IN' && existing?.checkInAt) throw Object.assign(new Error('Attendance is already complete for this shift.'), { statusCode: 409 });
        const checkInAt = action === 'CHECK_IN' ? now : existing?.checkInAt ?? null;
        const checkOutAt = action === 'CHECK_OUT' ? now : existing?.checkOutAt ?? null;
        const status = computeStaffAttendanceStatus({ policy, timeZone: school.timezone, localDate, checkInAt, checkOutAt, now });
        if (status === 'PENDING' || status === 'NOT_CHECKED_IN' || status === 'NON_WORKDAY') throw Object.assign(new Error('Unable to determine an attendance status for this scan.'), { statusCode: 400 });
        const beforeSnapshot = existing ? {
          date: localDate,
          shiftKey: existing.shiftKey,
          checkInAt: existing.checkInAt?.toISOString() ?? null,
          checkOutAt: existing.checkOutAt?.toISOString() ?? null,
          status: existing.status,
          reason: existing.reason,
        } : null;
        const record = existing
          ? await tx.staffAttendanceRecord.update({ where: { id: existing.id }, data: { policyId: policy.id, checkInAt, checkOutAt, status, reason: 'Authenticated attendance station scan' } })
          : await tx.staffAttendanceRecord.create({ data: { schoolId: user.schoolId, employeeId: employee.id, policyId: policy.id, date: attendanceDate, shiftKey: 'DEFAULT', checkInAt, checkOutAt, status, reason: 'Authenticated attendance station scan' } });
        await tx.staffAttendanceEvent.create({
          data: {
            schoolId: user.schoolId,
            attendanceId: record.id,
            employeeId: employee.id,
            actorUserId: user.userId,
            stationId: station.id,
            eventType: action === 'CHECK_IN' ? 'STATION_CHECK_IN' : 'STATION_CHECK_OUT',
            status,
            reason: 'Authenticated attendance station scan',
            idempotencyKey,
            beforeSnapshot: beforeSnapshot ?? Prisma.JsonNull,
            afterSnapshot: { date: localDate, shiftKey: 'DEFAULT', checkInAt: record.checkInAt?.toISOString() ?? null, checkOutAt: record.checkOutAt?.toISOString() ?? null, status: record.status },
            details: { action, stationTokenJti: printedLocator ? null : token.jti, printedLocator },
          },
        });
        return { record, action, duplicate: false };
      });

      return res.status(result.duplicate ? 200 : 201).json({
        accepted: true,
        duplicate: result.duplicate,
        action: result.action,
        status: result.record.status,
        checkInAt: result.record.checkInAt?.toISOString() ?? null,
        checkOutAt: result.record.checkOutAt?.toISOString() ?? null,
      });
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode);
      if (statusCode) return res.status(statusCode).json({ error: (error as Error).message });
      if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Attendance was already recorded for this shift.' });
      console.error('Error processing staff attendance scan:', error);
      return res.status(500).json({ error: 'Failed to process attendance scan' });
    }
  });

  return router;
}

export default createStaffAttendanceScanRouter(prisma);
