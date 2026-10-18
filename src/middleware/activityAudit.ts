import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { jwtVerify } from 'jose';
import { PrismaClient } from '@prisma/client';
import { getSessionSecret as getConfiguredSessionSecret } from '../services/security-config.js';
import { classifyPlatformAuditEvent, extractPlatformAuditResourceId, safeAuditPath } from '../services/platform-audit-events.js';

const prisma = new PrismaClient();

function getSessionSecret() {
  return getConfiguredSessionSecret();
}

function getSessionToken(req: Request) {
  return req.cookies?.schoolbase_session || req.cookies?.schoolbase_staff || req.cookies?.staff_session || null;
}

function getEventName(method: string, path: string) {
  const normalizedPath = path.toLowerCase();
  if (method === 'POST' && normalizedPath.includes('/students/import')) return 'STUDENTS_IMPORTED';
  if (method === 'POST' && /\/students(?:\/|$)/.test(normalizedPath)) return 'STUDENT_ACTIVITY';
  if (method === 'POST' && normalizedPath.includes('/fees/schedules')) return 'FEE_SCHEDULE_CREATED';
  if (method === 'POST' && normalizedPath.includes('/invoices')) return 'INVOICE_ISSUED';
  if (method === 'POST' && normalizedPath.includes('/payments')) return 'PAYMENT_RECORDED';
  if (method === 'POST' && normalizedPath.includes('/attendance')) return 'ATTENDANCE_RECORDED';
  if (method === 'POST' && normalizedPath.includes('/admissions')) return 'ADMISSION_ACTIVITY';
  if (method === 'POST' && (normalizedPath.includes('/publish') || normalizedPath.includes('/results/publish'))) return 'RESULTS_PUBLISHED';

  const route = path.replace(/^\/+/, '').replace(/\//g, '_').replace(/[^a-zA-Z0-9_:-]/g, '');
  return `API_${method}_${route || 'ROOT'}`.slice(0, 190);
}

function getSafeBodyFields(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const excluded = /password|token|otp|secret|authorization|cookie|pin|answer|credential|private.?key|recovery.?key/i;
  return Object.keys(body as Record<string, unknown>)
    .filter((key) => !excluded.test(key))
    .slice(0, 30)
    .join(', ');
}

export async function recordActivity(data: {
  event: string;
  details: string;
  userId?: string;
  schoolId?: string;
  category?: string;
  action?: string;
  outcome?: string;
  resourceType?: string;
  resourceId?: string;
  summary?: string;
  actorRole?: string;
  requestId?: string;
}) {
  await prisma.platformAuditLog.create({
    data: {
      event: data.event,
      details: data.details,
      userId: data.userId,
      schoolId: data.schoolId,
      category: data.category,
      action: data.action,
      outcome: data.outcome,
      resourceType: data.resourceType,
      resourceId: data.resourceId,
      summary: data.summary,
      actorRole: data.actorRole,
      requestId: data.requestId,
    },
  });
}

export function activityAuditMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    next();
    return;
  }

  const path = req.path || req.originalUrl || '/';
  if (
    path.includes('/audit-logs') ||
    path.includes('/health') ||
    path.includes('/api/admin/verify') ||
    path.includes('/ads/') ||
    path.includes('/api/ads/')
  ) {
    next();
    return;
  }

  res.on('finish', () => {
    void (async () => {
      let userId: string | undefined;
      let schoolId: string | undefined;
      let role: string | undefined;

      try {
        const token = getSessionToken(req);
        if (token) {
          const { payload } = await jwtVerify(token, getSessionSecret());
          userId = typeof payload.userId === 'string' ? payload.userId : undefined;
          schoolId = typeof payload.schoolId === 'string' ? payload.schoolId : undefined;
          role = typeof payload.role === 'string' ? payload.role : undefined;
        }
        if (res.statusCode >= 400 && !userId && !role) return;

        const fields = getSafeBodyFields(req.body);
        const auditEvent = classifyPlatformAuditEvent(req.method, path);
        const safePath = safeAuditPath(path);
        const outcome = res.statusCode < 300 ? 'SUCCESS' : res.statusCode < 400 ? 'REDIRECTED' : res.statusCode < 500 ? 'REJECTED' : 'FAILED';
        const details = [
          `${req.method} ${safePath}`,
          role ? `role: ${role}` : null,
          fields ? `fields: ${fields}` : null,
          `status: ${res.statusCode}`,
        ].filter(Boolean).join(' | ');

        await recordActivity({
          userId,
          schoolId,
          event: getEventName(req.method, safePath),
          details,
          category: auditEvent.category,
          action: auditEvent.action,
          outcome,
          resourceType: auditEvent.resourceType,
          resourceId: extractPlatformAuditResourceId(path),
          summary: auditEvent.summary,
          actorRole: role,
          requestId: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].slice(0, 191) : randomUUID(),
        });
      } catch (error) {
        console.warn('[AUDIT] Failed to record activity:', error instanceof Error ? error.message : error);
      }
    })();
  });

  next();
}
