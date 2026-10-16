// @ts-nocheck
import { Router, Request, Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import { PaymentMethod, Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { sendPasswordResetEmail, sendFeeReminderEmail, sendAttendanceNotificationEmail, sendTeacherWelcomeEmail, sendAdmissionNotificationEmail, sendAdmissionApplicantStatusEmail, sendStudentAccessReminderEmail, sendFeePaymentReceiptEmail, sendAnnouncementEmail, sendPlatformCommunicationEmail, sendSubscriptionPaymentSuccessEmail } from '../services/email.js';
import { CommunicationService, RulesEngine, TemplateEngine, RecipientResolver, DeliveryQueue, DriverManager, EmailDriver, WhatsAppDriver } from '../communications/index.js';
import baileysSessionManager from '../communications/whatsapp-baileys.js';
import { CommunicationRulesRegistry, DEFAULT_COMMUNICATION_RULES } from '../communications/rules.js';
import { ResultsDomainService } from '../domain/results/ResultsDomainService.js';
import requireActiveSubscription from '../middleware/subscriptionGuard.js';
import { checkSubscription, requireSubscription } from '../middleware/subscriptionGuard.js';
import { getNextAdmissionNo, normalizeAdmissionNo, reserveNextAdmissionNo, validateUniqueAdmissionNo } from '../services/student-admission.js';
import { findCompletedAdmissionConversion } from '../services/admission-approval.js';
import { findSchoolScopedAdmissionApplication } from '../services/admission-application-access.js';
import { buildAdmissionInboxWhere, buildAdmissionNotificationRecipientWhere } from '../services/admission-notification-access.js';
import { evaluateSchoolWhatsAppSend, getPersistedSchoolWhatsAppPolicyRecord, readSchoolWhatsAppPolicy } from '../services/whatsapp-policy.js';
import { whatsappDeliveryStore } from '../services/whatsapp-delivery-store.js';
import type { NextFunction } from 'express';
import { requireAccountingAccess, verifyAuth } from '../middleware/roleAuth.js';
import { recordActivity } from '../middleware/activityAudit.js';
import { buildGuardianNotificationRecipients } from '../services/guardian-notification-recipients.js';
import { buildSchoolAdminMembershipWhere, resolveSchoolScope } from '../services/security-context.js';
import { getSessionSecret } from '../services/security-config.js';
import { buildSchoolSetupStatus } from '../services/onboarding.js';
import { buildBulkStudentImportRows, parseCsvText, parseImportDate } from '../services/student-import.js';
import { buildActiveStudentWhere, buildStudentRosterWhere, filterActiveStudents, normalizeStudentEnrollmentStatus } from '../services/student-lifecycle.js';
import { validateInvoicePaymentAllocation } from '../services/invoice-payment-allocation.js';
import { buildInvoicePaymentCompareAndSet, matchesPaymentIdempotencyRequest, normalizePaymentIdempotencyKey, parsePositiveAmountMinor } from '../services/fee-payment-guard.js';
import { buildFeePaymentJournalEntry } from '../services/accounting-posting.js';
import { canTransitionAdmissionStatus, isAdmissionApprovalStatus, requiresAdmissionDecisionReason } from './admissions-utils.js';
import { AdmissionDeliveryRetryStore } from '../services/admission-delivery-retry-store.js';

const router = Router();
const prisma = new PrismaClient();
const admissionRetryStore = new AdmissionDeliveryRetryStore(prisma);
const resultsDomain = new ResultsDomainService(prisma);
const communicationRulesRegistry = new CommunicationRulesRegistry(DEFAULT_COMMUNICATION_RULES);

const sharedDriverManager = new DriverManager({
  EMAIL: new EmailDriver(async ({ recipient, request }) => {
    const metadata = { ...(request.metadata ?? {}), ...(request.data ?? {}) } as Record<string, unknown>;
    const studentName = String(metadata.studentName ?? 'Student');
    const className = String(metadata.className ?? 'Unknown Class');
    const termName = String(metadata.termName ?? 'Current Term');
    const amount = String(metadata.amount ?? '0.00');
    const paidAmount = String(metadata.paidAmount ?? '0.00');
    const outstanding = String(metadata.outstanding ?? '0.00');
    const currency = String(metadata.currency ?? 'NGN');
    const items = typeof metadata.items === 'string' ? metadata.items : undefined;
    const schoolName = String(metadata.schoolName ?? 'School');
    const logoUrl = typeof metadata.logoUrl === 'string' ? metadata.logoUrl : undefined;

    if (request.event === 'AdmissionCreated') {
      await sendAdmissionNotificationEmail(
        recipient.address,
        recipient.name ?? 'Guardian',
        studentName,
        className,
        String(metadata.admissionNo ?? 'N/A'),
        schoolName,
        logoUrl,
      );
    } else if (request.event === 'StudentAccessResent') {
      await sendStudentAccessReminderEmail(
        recipient.address,
        recipient.name ?? 'Guardian',
        studentName,
        className,
        String(metadata.admissionNo ?? 'N/A'),
        schoolName,
        logoUrl,
      );
    } else if (request.event === 'FeePaymentReceived') {
      await sendFeePaymentReceiptEmail(
        recipient.address,
        recipient.name ?? 'Guardian',
        studentName,
        className,
        currency,
        amount,
        paidAmount,
        outstanding,
        schoolName,
        logoUrl,
        items,
      );
    } else if (request.event === 'AnnouncementCreated') {
      await sendAnnouncementEmail(
        recipient.address,
        recipient.name ?? 'Guardian',
        String(metadata.title ?? request.subject ?? 'School Announcement'),
        String(metadata.message ?? request.body ?? ''),
        schoolName,
        logoUrl,
      );
    } else if (request.event === 'FeeInvoiceCreated') {
      await sendPlatformCommunicationEmail(
        recipient.address,
        recipient.name ?? 'Guardian',
        schoolName,
        'Fee Invoice',
        request.subject ?? 'Fee Invoice',
        request.body ?? '',
      );
    } else if (request.event === 'AttendanceMarked') {
      await sendAttendanceNotificationEmail(
        recipient.address,
        recipient.name ?? 'Guardian',
        studentName,
        className,
        String(metadata.date ?? ''),
        String(metadata.status ?? 'present') as 'present' | 'absent' | 'late',
        schoolName,
        String(metadata.customMessage ?? ''),
        logoUrl,
      );
    } else if (request.event.startsWith('Admission')) {
      await sendPlatformCommunicationEmail(
        recipient.address,
        recipient.name ?? 'Applicant',
        schoolName,
        request.subject ?? 'Admission application update',
        request.subject ?? 'Admission application update',
        request.body ?? '',
      );
    } else {
      await sendFeeReminderEmail(
        recipient.address,
        recipient.name ?? 'Guardian',
        studentName,
        className,
        termName,
        amount,
        paidAmount,
        outstanding,
        schoolName,
        logoUrl,
      );
    }

    return {
      channel: 'EMAIL',
      recipient: recipient.address,
      status: 'SENT',
      provider: 'email-service',
    } as const;
  }),
  WHATSAPP: new WhatsAppDriver(async ({ recipient, request, content }) => {
    const schoolId = request.schoolId ?? '';
    let deliveryId: string | undefined;
    try {
      const delivery = await whatsappDeliveryStore.upsertSchoolDelivery({
        schoolId,
        event: request.event,
        guardianId: typeof request.metadata?.guardianId === 'string' ? request.metadata.guardianId : null,
        recipientAddress: recipient.address,
        recipientName: recipient.name,
        messageBody: content.body,
        status: 'QUEUED',
        provider: 'baileys',
        attemptCount: 1,
        nextAttemptAt: new Date(Date.now() + 1_500),
      });
      deliveryId = delivery?.id;
    } catch (auditError) {
      console.warn('[admin] Could not create durable WhatsApp delivery record:', auditError);
    }

    return {
      channel: 'WHATSAPP',
      recipient: recipient.address,
      status: 'QUEUED',
      provider: 'baileys',
      messageId: deliveryId ?? undefined,
    } as const;
  }),
});

const sharedDeliveryQueue = new DeliveryQueue(
  sharedDriverManager.send.bind(sharedDriverManager),
  async (task, outcome, attemptNumber) => {
    const metadata = task.request.metadata ?? {};
    if (!String(task.request.event).startsWith('Admission') || typeof metadata.admissionApplicationId !== 'string') return;
    await (prisma as any).admissionDeliveryAttempt.upsert({
      where: {
        admissionApplicationId_audience_channel_attemptNumber: {
          admissionApplicationId: metadata.admissionApplicationId,
          audience: String(metadata.audience ?? 'APPLICANT_STATUS'),
          channel: outcome.channel,
          attemptNumber,
        },
      },
      create: {
        admissionApplicationId: metadata.admissionApplicationId,
        audience: String(metadata.audience ?? 'APPLICANT_STATUS'),
        channel: outcome.channel,
        attemptNumber,
        status: outcome.status,
        provider: outcome.provider,
        providerMessageId: outcome.messageId,
        error: outcome.error,
      },
      update: { status: outcome.status, provider: outcome.provider, providerMessageId: outcome.messageId, error: outcome.error },
    });
  },
  admissionRetryStore,
);
void sharedDeliveryQueue.restorePending().catch((error) => console.error('[admissions] Could not restore durable email retries:', error));

function createCommunicationService() {
  return new CommunicationService({
    rulesEngine: new RulesEngine(communicationRulesRegistry),
    templateEngine: new TemplateEngine(),
    recipientResolver: new RecipientResolver(),
    deliveryQueue: sharedDeliveryQueue,
    driverManager: sharedDriverManager,
  });
}

async function notifyAdmissionApplicantStatus(application: any, status: string, schoolId: string, requestedInformation?: string, statusToken?: string | null) {
  const recipients = [
    ...(application.email ? [{ channel: 'EMAIL' as const, address: application.email, name: `${application.firstName} ${application.lastName}`.trim() }] : []),
    ...(application.phone ? [{ channel: 'WHATSAPP' as const, address: application.phone, name: `${application.firstName} ${application.lastName}`.trim() }] : []),
  ];
  if (!recipients.length) return;
  const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { name: true, slug: true, logoUrl: true } });
  const normalizedStatus = String(status).toUpperCase();
  const configuredFrontendUrl = String(process.env.FRONTEND_URL ?? '').split(',')[0]?.trim();
  let frontendOrigin = 'https://www.schoolbase.live';
  try {
    const parsed = new URL(configuredFrontendUrl || frontendOrigin);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') frontendOrigin = `${parsed.protocol}//${parsed.host}`;
  } catch {
    // Keep the canonical public host when configuration is invalid.
  }
  const statusUrl = statusToken && school?.slug
    ? `${frontendOrigin}/admissions/${encodeURIComponent(school.slug)}/status#${encodeURIComponent(statusToken)}`
    : null;
  const emailRecipient = recipients.find((recipient) => recipient.channel === 'EMAIL');
  if (emailRecipient && emailRecipient.address) {
    try {
      await sendAdmissionApplicantStatusEmail({
        email: emailRecipient.address,
        applicantName: emailRecipient.name || `${application.firstName ?? ''} ${application.lastName ?? ''}`.trim() || 'Applicant',
        schoolName: school?.name || 'the school',
        status: normalizedStatus,
        requestedInformation,
        statusUrl,
        schoolLogo: school?.logoUrl ?? undefined,
      });
    } catch (error) {
      console.error('[admissions] Failed to send branded applicant status email:', error);
    }
  }

  const whatsappRecipients = recipients.filter((recipient) => recipient.channel === 'WHATSAPP');
  const message = normalizedStatus === 'APPROVED'
    ? `Your application to ${school?.name || 'the school'} has been approved. The admissions team will contact you with next steps.`
    : normalizedStatus === 'REJECTED'
      ? `Your application to ${school?.name || 'the school'} has been declined. Please contact the school if you need further information.`
      : normalizedStatus === 'NEEDS_INFORMATION'
        ? `${requestedInformation || 'The admissions team needs more information to continue reviewing your application.'}${statusUrl ? `\n\nReply securely or check your application status here:\n${statusUrl}` : ''}`
        : null;
  if (message && whatsappRecipients.length) {
    const event = `Admission${normalizedStatus}`;
    await createCommunicationService().dispatch({
      event,
      schoolId,
      recipients: whatsappRecipients,
      template: 'Admission',
      subject: `Admission application update: ${normalizedStatus.replace(/_/g, ' ')}`,
      body: message,
      data: { schoolName: school?.name || 'your school', recipientName: `${application.firstName} ${application.lastName}`.trim(), ...(statusUrl ? { statusUrl } : {}) },
      metadata: { admissionApplicationId: application.id, audience: `APPLICANT_${normalizedStatus}` },
    });
  }
}

// Setup multer for file uploads
const uploadDir = path.join(process.cwd(), 'uploads', 'photos');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req: any, file: any, cb: any) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB
});
const studentImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const settingsUploadDir = path.join(process.cwd(), 'uploads', 'settings');
if (!fs.existsSync(settingsUploadDir)) {
  fs.mkdirSync(settingsUploadDir, { recursive: true });
}

const settingsStorage = multer.diskStorage({
  destination: settingsUploadDir,
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(7)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const settingsUpload = multer({
  storage: settingsStorage,
  fileFilter,
  limits: { fileSize: 4 * 1024 * 1024 },
});

function secret() {
  return getSessionSecret();
}

function normalizeField(value: any): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function asCents(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.round(parsed));
}

async function buildItemizedInvoiceBreakdown({
  schoolId,
  scheduleId,
  pupilId,
  invoiceId,
  fallbackName,
  fallbackAmount,
}: {
  schoolId: string;
  scheduleId: string;
  pupilId: string;
  invoiceId: string;
  fallbackName?: string | null;
  fallbackAmount?: number;
}) {
  const schedule = await prisma.feeSchedule.findUnique({
    where: { id: scheduleId },
    select: { id: true, name: true, amount: true },
  });

  const scheduleItems = await prisma.feeScheduleItem.findMany({
    where: { feeScheduleId: scheduleId, schoolId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

  const adjustments = await prisma.studentFeeAdjustment.findMany({
    where: {
      schoolId,
      studentId: pupilId,
      status: { in: ['ACTIVE', 'APPROVED'] },
      OR: [{ invoiceId: null }, { invoiceId }],
    },
    orderBy: { createdAt: 'asc' },
  });

  const itemEntries = scheduleItems.length > 0
    ? scheduleItems.map((item) => ({
        id: item.id,
        name: item.name,
        amount: Math.max(0, asCents(item.amount)),
        feeScheduleItemId: item.id,
        description: item.description ?? null,
      }))
    : [{
        id: schedule?.id ?? invoiceId,
        name: fallbackName || schedule?.name || 'School Fees',
        amount: Math.max(0, asCents(fallbackAmount ?? schedule?.amount ?? 0)),
        feeScheduleItemId: null,
        description: null,
      }];

  const itemAdjustments = new Map<string, number>();
  let invoiceLevelReduction = 0;

  for (const adjustment of adjustments) {
    if (adjustment.feeScheduleItemId) {
      const entry = itemEntries.find((item) => item.feeScheduleItemId === adjustment.feeScheduleItemId);
      if (!entry) continue;

      let deduction = 0;

      if (adjustment.amount !== null && adjustment.amount !== undefined) {
        deduction = asCents(adjustment.amount);
      } else if (adjustment.percentage !== null && adjustment.percentage !== undefined) {
        deduction = Math.round((entry.amount * Number(adjustment.percentage)) / 100);
      }

      if (deduction > 0) {
        itemAdjustments.set(entry.id, (itemAdjustments.get(entry.id) ?? 0) + deduction);
      }
      continue;
    }

    let deduction = 0;
    if (adjustment.amount !== null && adjustment.amount !== undefined) {
      deduction = asCents(adjustment.amount);
    } else if (adjustment.percentage !== null && adjustment.percentage !== undefined) {
      deduction = Math.round((itemEntries.reduce((sum, entry) => sum + entry.amount, 0) * Number(adjustment.percentage)) / 100);
    }

    if (deduction > 0) {
      invoiceLevelReduction += deduction;
    }
  }

  const finalItems = itemEntries
    .map((entry) => {
      const deducted = itemAdjustments.get(entry.id) ?? 0;
      const adjustedAmount = Math.max(0, entry.amount - deducted);

      return {
        invoiceId,
        feeScheduleItemId: entry.feeScheduleItemId,
        name: entry.name,
        amount: adjustedAmount,
        quantity: 1,
        description: entry.description,
      };
    })
    .filter((entry) => entry.amount > 0);

  const subtotal = finalItems.reduce((sum, item) => sum + item.amount, 0);
  const amountDue = Math.max(0, subtotal - invoiceLevelReduction);

  return {
    items: finalItems,
    amountDue,
  };
}

function normalizeFeeScheduleItemInput(item: any, fallbackSortOrder: number = 0) {
  const name = String(item?.name ?? '').trim();
  const rawAmount = item?.amount;

  if (!name || rawAmount === undefined || rawAmount === null || rawAmount === '') {
    return null;
  }

  const parsedAmount = Number.parseFloat(String(rawAmount));
  if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
    return null;
  }

  return {
    name,
    amount: Math.round(parsedAmount * 100),
    description: item?.description ? String(item.description).trim() : null,
    isRequired: item?.isRequired !== false,
    sortOrder: Number.isFinite(Number(item?.sortOrder)) ? Number(item.sortOrder) : fallbackSortOrder,
  };
}

export function hasFeeScheduleItemChanges(nextItems: any[] = [], previousItems: any[] = []) {
  const normalize = (item: any) => {
    const name = String(item?.name ?? '').trim();
    const rawAmount = item?.amount;
    const parsedAmount = Number.parseFloat(String(rawAmount ?? ''));

    return {
      name,
      amount: Number.isFinite(parsedAmount) ? Math.round(parsedAmount * 100) : null,
      description: item?.description ? String(item.description).trim() : '',
      isRequired: item?.isRequired !== false,
    };
  };

  const next = nextItems.map(normalize).filter((item) => item.name || item.amount !== null);
  const previous = previousItems.map(normalize).filter((item) => item.name || item.amount !== null);

  if (next.length !== previous.length) return true;

  for (let index = 0; index < next.length; index += 1) {
    const current = next[index];
    const original = previous[index];

    if (
      current.name !== original.name ||
      current.amount !== original.amount ||
      current.description !== original.description ||
      current.isRequired !== original.isRequired
    ) {
      return true;
    }
  }

  return false;
}

export function resolveFeeScheduleAmount({
  amount,
  items = [],
  previousItems = [],
}: {
  amount?: number | string | null;
  items?: any[];
  previousItems?: any[];
}) {
  const itemPayload = Array.isArray(items) ? items : [];
  const validItems = itemPayload
    .map((item, index) => normalizeFeeScheduleItemInput(item, index))
    .filter(Boolean) as Array<{
      name: string;
      amount: number;
      description: string | null;
      isRequired: boolean;
      sortOrder: number;
    }>;

  if (validItems.length === 0) {
    const rawAmount = Number.parseFloat(String(amount ?? ''));
    return Number.isFinite(rawAmount) && rawAmount >= 0 ? Math.round(rawAmount * 100) : null;
  }

  const itemsChanged = hasFeeScheduleItemChanges(itemPayload, previousItems);

  if (itemsChanged) {
    return computeFeeScheduleTotalFromItems(itemPayload);
  }

  const rawAmount = Number.parseFloat(String(amount ?? ''));
  if (Number.isFinite(rawAmount) && rawAmount >= 0) {
    return Math.round(rawAmount * 100);
  }

  return computeFeeScheduleTotalFromItems(itemPayload);
}

function computeFeeScheduleTotalFromItems(items: any[] = []) {
  return items.reduce((sum, item) => {
    const normalized = normalizeFeeScheduleItemInput(item, sum);
    if (!normalized) return sum;
    return sum + normalized.amount;
  }, 0);
}

function formatFeeItemsForMessage(
  items: Array<{ name: string; amount: number; amountPaid?: number; amountOutstanding?: number }>,
  currency: string,
) {
  if (items.length === 0) return '';

  return items
    .map((item) => {
      const amount = `${currency} ${(item.amount / 100).toFixed(2)}`;
      if (item.amountPaid === undefined) return `- ${item.name}: ${amount}`;
      return `- ${item.name}: ${amount} | Paid: ${currency} ${(item.amountPaid / 100).toFixed(2)} | Remaining: ${currency} ${((item.amountOutstanding ?? 0) / 100).toFixed(2)}`;
    })
    .join('\n');
}

async function syncFeeScheduleAmount(scheduleId: string, schoolId: string) {
  const totals = await prisma.feeScheduleItem.aggregate({
    where: { feeScheduleId: scheduleId, schoolId },
    _sum: { amount: true },
  });

  return prisma.feeSchedule.update({
    where: { id: scheduleId },
    data: { amount: totals._sum.amount ?? 0 },
  });
}

async function resolveUserId(req: Request): Promise<string | null> {
  const token = req.cookies?.schoolbase_session || req.cookies?.schoolbase_staff || req.cookies?.staff_session;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload && typeof payload === 'object' && 'userId' in payload) {
      return String((payload as any).userId);
    }
  } catch (err) {
    console.error('[resolveUserId] JWT verification failed:', (err as Error).message);
  }

  return null;
}

async function isSchoolAdmissionAdmin(req: Request, schoolId: string): Promise<boolean> {
  const userId = await resolveUserId(req);
  if (!userId) return false;
  const user = await prisma.user.findFirst({ where: buildSchoolAdminMembershipWhere(userId, schoolId), select: { id: true } });
  return Boolean(user);
}

async function resolveSchoolId(req: Request) {
  // Check unified session cookie (supports both old and new names for backward compatibility)
  const token = req.cookies?.schoolbase_session || req.cookies?.schoolbase_staff || req.cookies?.staff_session;
  let authenticatedSchoolId: string | null = null;
  let authenticatedRole: string | null = null;
  
  if (token) {
    try {
      const { payload } = await jwtVerify(token, secret());
      authenticatedRole = typeof payload.role === 'string' ? payload.role : null;
      if (payload && typeof payload === 'object' && 'schoolId' in payload) {
        authenticatedSchoolId = String((payload as any).schoolId);
      }
    } catch (err) {
      console.error('[resolveSchoolId] JWT verification failed:', (err as Error).message);
    }
  }

  const requestedSchoolId = (req.query.schoolId as string)
    || (req.headers['x-school-id'] as string)
    || (req.body as any)?.schoolId;
  const scoped = resolveSchoolScope({ authenticatedSchoolId, authenticatedRole, requestedSchoolId });
  if (scoped.rejected) {
    console.warn('[resolveSchoolId] Rejected cross-school scope request');
    return null;
  }
  if (scoped.schoolId) return scoped.schoolId;

  let slug: string | null = null;
  const signedSlug = req.cookies?.schoolSlug_v2;
  if (signedSlug) {
    try {
      const { payload } = await jwtVerify(signedSlug, secret());
      if (payload && typeof payload === 'object' && 'slug' in payload) {
        slug = String((payload as any).slug);
      }
    } catch {
      // ignore invalid signed slug
    }
  }

  if (!slug) {
    const legacySlug = req.cookies?.schoolSlug;
    if (legacySlug && /^[a-z0-9-]+$/.test(legacySlug)) {
      slug = legacySlug;
    }
  }

  if (slug) {
    console.log('[resolveSchoolId] Looking up school by slug:', slug);
    const school = await prisma.school.findUnique({ where: { slug } });
    console.log('[resolveSchoolId] Found school by slug:', school?.id);
    return school?.id ?? null;
  }

  console.log('[resolveSchoolId] No schoolId found anywhere');
  return null;
}

async function resolvePathSchoolId(req: Request, requestedSchoolId: string | undefined) {
  const token = req.cookies?.schoolbase_session || req.cookies?.schoolbase_staff || req.cookies?.staff_session;
  if (!token || !requestedSchoolId) return null;

  try {
    const { payload } = await jwtVerify(token, secret());
    const authenticatedSchoolId = typeof payload.schoolId === 'string' ? payload.schoolId : null;
    const authenticatedRole = typeof payload.role === 'string' ? payload.role : null;
    const scoped = resolveSchoolScope({
      authenticatedSchoolId,
      authenticatedRole,
      requestedSchoolId,
    });
    return scoped.rejected ? null : scoped.schoolId;
  } catch {
    return null;
  }
}

async function resolveUserName(req: Request): Promise<string | null> {
  const token = req.cookies?.schoolbase_session || req.cookies?.schoolbase_staff || req.cookies?.staff_session;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload && typeof payload === 'object' && 'name' in payload) {
      return String((payload as any).name);
    }
  } catch (err) {
    console.error('[resolveUserName] JWT verification failed:', (err as Error).message);
  }

  return null;
}

// Apply subscription guard to school-scoped routes, excluding a small set of public endpoints
router.use((req: Request, res: Response, next: any) => {
  const allowlist = [
    '/verify',
    '/settings',
    '/settings/status',
    '/settings/data',
    '/logo/presign',
    '/school-logo',
    '/school-stamp',
    '/school-signature',
    '/school/',
    '/subscribe',
    '/subscription/status',
    '/impersonate',
    '/request-password-reset',
    '/reset-password',
    '/paystack',
    '/platform',
  ];

  // Allow exact or prefix matches for the allowlist
  for (const prefix of allowlist) {
    if (req.path === prefix || req.path.startsWith(prefix + '/') || req.path.startsWith(prefix)) {
      return next();
    }
  }

  // Allow read-only results access for school admins even if subscription is inactive.
  // This keeps assessment pages visible while still protecting writes.
  if (req.method === 'GET' && req.path.startsWith('/results')) {
    return next();
  }

  return requireActiveSubscription(req as any, res as any, next);
});

// GET /api/admin/admissions - List admission applications for the current school
router.get('/admissions/notifications', async (req: Request, res: Response) => {
  try {
    const [schoolId, userId] = await Promise.all([resolveSchoolId(req), resolveUserId(req)]);
    if (!schoolId || !userId) return res.status(401).json({ error: 'School admin session required' });

    const recipient = await prisma.user.findFirst({
      where: buildSchoolAdminMembershipWhere(userId, schoolId),
      select: { id: true },
    });
    if (!recipient) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });

    const where = buildAdmissionInboxWhere(schoolId, recipient.id);
    const [notifications, unreadCount] = await Promise.all([
      prisma.schoolAdminNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          createdAt: true,
          readAt: true,
          admissionApplication: {
            select: {
              id: true,
              intendedClass: true,
              status: true,
            },
          },
        },
      }),
      prisma.schoolAdminNotification.count({ where: { ...where, readAt: null } }),
    ]);

    res.json({ notifications, unreadCount });
  } catch (error) {
    console.error('Error fetching school admission notifications:', error);
    res.status(500).json({ error: 'Failed to fetch admission notifications' });
  }
});

router.patch('/admissions/notifications/:notificationId/read', async (req: Request, res: Response) => {
  try {
    const [schoolId, userId] = await Promise.all([resolveSchoolId(req), resolveUserId(req)]);
    if (!schoolId || !userId) return res.status(401).json({ error: 'School admin session required' });

    const recipient = await prisma.user.findFirst({
      where: buildSchoolAdminMembershipWhere(userId, schoolId),
      select: { id: true },
    });
    if (!recipient) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });

    const result = await prisma.schoolAdminNotification.updateMany({
      where: { ...buildAdmissionNotificationRecipientWhere(req.params.notificationId, schoolId, recipient.id), readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count === 0) {
      const exists = await prisma.schoolAdminNotification.findFirst({
        where: buildAdmissionNotificationRecipientWhere(req.params.notificationId, schoolId, recipient.id),
        select: { id: true },
      });
      if (!exists) return res.status(404).json({ error: 'Notification not found' });
    }
    res.json({ success: true, read: true });
  } catch (error) {
    console.error('Error marking school admission notification read:', error);
    res.status(500).json({ error: 'Failed to update admission notification' });
  }
});

router.get('/admissions/reports', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(401).json({ error: 'School ID required' });
    if (!(await isSchoolAdmissionAdmin(req, schoolId))) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return res.status(400).json({ error: 'A valid reporting date range is required' });
    const where = { schoolId, createdAt: { gte: from, lte: to } };
    const [total, byStatus, byClass, firstResponse] = await Promise.all([
      prisma.admissionApplication.count({ where }),
      prisma.admissionApplication.groupBy({ by: ['status'], where, _count: { _all: true } }),
      prisma.admissionApplication.groupBy({ by: ['intendedClass'], where, _count: { _all: true } }),
      prisma.$queryRaw<Array<{ averageHours: number | null; reviewedCount: number }>>`
        SELECT AVG(TIMESTAMPDIFF(SECOND, submittedAt, reviewedAt)) / 3600 AS averageHours,
               COUNT(*) AS reviewedCount
        FROM AdmissionApplication
        WHERE schoolId = ${schoolId} AND createdAt >= ${from} AND createdAt <= ${to} AND reviewedAt IS NOT NULL
      `,
    ]);
    const counts = Object.fromEntries(byStatus.map((item) => [item.status, item._count._all >= 5 ? item._count._all : null]));
    const approvedCount = byStatus.find((item) => item.status === 'APPROVED')?._count._all ?? 0;
    return res.json({
      range: { from: from.toISOString(), to: to.toISOString() },
      total,
      statusCounts: counts,
      suppressedStatusGroups: byStatus.filter((item) => item._count._all < 5).length,
      approvalRate: total >= 5 && approvedCount >= 5 ? approvedCount / total : null,
      averageHoursToFirstReview: Number(firstResponse[0]?.reviewedCount ?? 0) >= 5 ? firstResponse[0]?.averageHours ?? null : null,
      byClass: byClass
        .filter((item) => item._count._all >= 5)
        .map((item) => ({ intendedClass: item.intendedClass || 'Unspecified', count: item._count._all })),
      suppressedClassGroups: byClass.filter((item) => item._count._all < 5).length,
    });
  } catch (error) {
    console.error('Error building admissions report:', error);
    return res.status(500).json({ error: 'Failed to build admissions report' });
  }
});

router.get('/admissions/reviewers', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(401).json({ error: 'School ID required' });
    if (!(await isSchoolAdmissionAdmin(req, schoolId))) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });
    const currentUserId = await resolveUserId(req);
    const reviewers = await prisma.user.findMany({
      where: { schoolId, role: 'SCHOOL_ADMIN' },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
    return res.json({ reviewers, currentUserId });
  } catch (error) {
    console.error('Error fetching admission reviewers:', error);
    return res.status(500).json({ error: 'Failed to fetch reviewers' });
  }
});

router.get('/admissions/:id/events', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(401).json({ error: 'School ID required' });
    if (!(await isSchoolAdmissionAdmin(req, schoolId))) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });
    const application = await findSchoolScopedAdmissionApplication(prisma, schoolId, req.params.id, { select: { id: true } });
    if (!application) return res.status(404).json({ error: 'Admission application not found' });
    const events = await prisma.admissionApplicationEvent.findMany({
      where: { admissionApplicationId: application.id, schoolId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, type: true, fromStatus: true, toStatus: true, reason: true, metadata: true, actorName: true, createdAt: true },
    });
    return res.json({ events });
  } catch (error) {
    console.error('Error fetching admission application events:', error);
    return res.status(500).json({ error: 'Failed to fetch application history' });
  }
});

router.patch('/admissions/:id/review', async (req: Request, res: Response) => {
  try {
    const [schoolId, userId] = await Promise.all([resolveSchoolId(req), resolveUserId(req)]);
    if (!schoolId || !userId) return res.status(401).json({ error: 'School admin session required' });
    const actor = await prisma.user.findFirst({ where: buildSchoolAdminMembershipWhere(userId, schoolId), select: { id: true, name: true } });
    if (!actor) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });

    const application = await findSchoolScopedAdmissionApplication(prisma, schoolId, req.params.id, { select: { id: true } });
    if (!application) return res.status(404).json({ error: 'Admission application not found' });
    const assignedReviewerId = req.body?.assignedReviewerId === null || req.body?.assignedReviewerId === ''
      ? null
      : String(req.body?.assignedReviewerId ?? '').trim() || undefined;
    if (assignedReviewerId) {
      const reviewer = await prisma.user.findFirst({ where: buildSchoolAdminMembershipWhere(assignedReviewerId, schoolId), select: { id: true } });
      if (!reviewer) return res.status(400).json({ error: 'Reviewer must be an admin in this school' });
    }
    const internalReviewNotes = req.body?.internalReviewNotes;
    if (internalReviewNotes !== undefined && (typeof internalReviewNotes !== 'string' || internalReviewNotes.length > 10000)) {
      return res.status(400).json({ error: 'Review notes must be text under 10,000 characters' });
    }
    const followUpAt = req.body?.followUpAt ? new Date(req.body.followUpAt) : req.body?.followUpAt === null ? null : undefined;
    if (followUpAt && Number.isNaN(followUpAt.getTime())) return res.status(400).json({ error: 'Follow-up date is invalid' });

    const updated = await prisma.$transaction(async (transaction) => {
      const data = {
        ...(assignedReviewerId !== undefined ? { assignedReviewerId } : {}),
        ...(internalReviewNotes !== undefined ? { internalReviewNotes: internalReviewNotes.trim() || null } : {}),
        ...(followUpAt !== undefined ? { followUpAt } : {}),
      };
      const record = await transaction.admissionApplication.update({ where: { id: application.id }, data });
      await transaction.admissionApplicationEvent.create({
        data: {
          schoolId,
          admissionApplicationId: application.id,
          actorUserId: actor.id,
          actorName: actor.name,
          type: 'REVIEW_UPDATED',
          metadata: { changedFields: Object.keys(data) },
        },
      });
      return record;
    });
    return res.json({ success: true, application: updated });
  } catch (error) {
    console.error('Error updating admission review:', error);
    return res.status(500).json({ error: 'Failed to update application review' });
  }
});

router.get('/admissions/export', async (req: Request, res: Response) => {
  try {
    const [schoolId, actorId] = await Promise.all([resolveSchoolId(req), resolveUserId(req)]);
    if (!schoolId || !actorId) return res.status(401).json({ error: 'School admin session required' });
    const actor = await prisma.user.findFirst({ where: buildSchoolAdminMembershipWhere(actorId, schoolId), select: { id: true } });
    if (!actor) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });

    const status = String(req.query.status ?? '').trim().toUpperCase();
    const intendedClass = String(req.query.intendedClass ?? '').trim().slice(0, 120);
    const reviewerId = String(req.query.reviewerId ?? '').trim();
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    if (from && Number.isNaN(from.getTime()) || to && Number.isNaN(to.getTime()) || from && to && from > to) {
      return res.status(400).json({ error: 'A valid export date range is required' });
    }
    const where = {
      schoolId,
      ...(status && ['SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'WITHDRAWN'].includes(status) ? { status } : {}),
      ...(intendedClass ? { intendedClass: { contains: intendedClass } } : {}),
      ...(reviewerId === 'UNASSIGNED' ? { assignedReviewerId: null } : reviewerId ? { assignedReviewerId: reviewerId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };
    const applications = await prisma.admissionApplication.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 5001,
      select: {
        id: true, applicationNumber: true, status: true, intendedClass: true, createdAt: true,
        reviewedAt: true, assignedReviewer: { select: { name: true } }, studentId: true,
      },
    });
    if (applications.length > 5000) return res.status(413).json({ error: 'Export exceeds 5,000 rows; narrow the date range or filters' });
    const studentIds = applications.map((application) => application.studentId).filter(Boolean) as string[];
    const pupils = studentIds.length ? await prisma.pupil.findMany({ where: { schoolId, id: { in: studentIds } }, select: { id: true, admissionNo: true } }) : [];
    const admissionNumbers = new Map(pupils.map((pupil) => [pupil.id, pupil.admissionNo]));
    const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Application reference', 'Status', 'Intended class', 'Received at', 'First reviewed at', 'Reviewer', 'Admission number'].map(csvCell).join(','),
      ...applications.map((application) => [
        application.applicationNumber,
        application.status,
        application.intendedClass,
        application.createdAt.toISOString(),
        application.reviewedAt?.toISOString() ?? '',
        application.assignedReviewer?.name ?? '',
        application.studentId ? admissionNumbers.get(application.studentId) ?? '' : '',
      ].map(csvCell).join(',')),
    ];
    await prisma.admissionExportAudit.create({
      data: {
        schoolId,
        actorUserId: actor.id,
        rowCount: applications.length,
        filters: { status: status || null, intendedClass: intendedClass || null, reviewerId: reviewerId || null, from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
        redacted: true,
      },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="admissions-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(`\uFEFF${lines.join('\r\n')}`);
  } catch (error) {
    console.error('Error exporting admission applications:', error);
    return res.status(500).json({ error: 'Failed to export admissions' });
  }
});

router.get('/admissions/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(401).json({ error: 'School ID required' });
    if (!(await isSchoolAdmissionAdmin(req, schoolId))) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });
    const application = await findSchoolScopedAdmissionApplication(prisma, schoolId, req.params.id, {
      include: {
        assignedReviewer: { select: { id: true, name: true } },
        deliveryAttempts: {
          orderBy: { attemptedAt: 'desc' },
          take: 20,
          select: { id: true, audience: true, channel: true, attemptNumber: true, status: true, provider: true, providerMessageId: true, error: true, attemptedAt: true },
        },
      },
    });
    if (!application) return res.status(404).json({ error: 'Admission application not found' });
    return res.json({ application });
  } catch (error) {
    console.error('Error fetching admission application:', error);
    return res.status(500).json({ error: 'Failed to fetch admission application' });
  }
});

router.get('/admissions', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(401).json({ error: 'School ID required' });
    if (!(await isSchoolAdmissionAdmin(req, schoolId))) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });

    const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.pageSize ?? '25'), 10) || 25));
    const search = String(req.query.search ?? '').trim().slice(0, 120);
    const status = String(req.query.status ?? '').trim().toUpperCase();
    const intendedClass = String(req.query.intendedClass ?? '').trim().slice(0, 120);
    const reviewerId = String(req.query.reviewerId ?? '').trim();
    const completeness = String(req.query.completeness ?? '').trim().toUpperCase();
    const queueView = String(req.query.view ?? '').trim().toUpperCase();
    const fromDate = req.query.from ? new Date(String(req.query.from)) : null;
    const toDate = req.query.to ? new Date(String(req.query.to)) : null;
    const sortBy = ['createdAt', 'updatedAt', 'status'].includes(String(req.query.sortBy)) ? String(req.query.sortBy) : 'createdAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 'asc' : 'desc';
    const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const andConditions: any[] = [];
    if (completeness === 'INCOMPLETE') andConditions.push({ OR: [
      { email: null }, { phone: null }, { studentFirstName: null }, { studentLastName: null }, { guardianPhone: null }, { photoUrl: null },
    ] });
    if (completeness === 'COMPLETE') andConditions.push({
      email: { not: null }, phone: { not: null }, studentFirstName: { not: null },
      studentLastName: { not: null }, guardianPhone: { not: null }, photoUrl: { not: null },
    });
    if (search) andConditions.push({ OR: [
      { firstName: { contains: search } }, { lastName: { contains: search } },
      { childName: { contains: search } }, { applicationNumber: { contains: search } },
    ] });
    const where = {
      schoolId,
      ...(status && ['SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'WITHDRAWN'].includes(status) ? { status } : {}),
      ...(intendedClass ? { intendedClass: { contains: intendedClass } } : {}),
      ...(reviewerId === 'UNASSIGNED' ? { assignedReviewerId: null } : reviewerId ? { assignedReviewerId: reviewerId } : {}),
      ...(andConditions.length ? { AND: andConditions } : {}),
      ...(queueView === 'NEEDS_REVIEW' ? { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } : {}),
      ...(queueView === 'AWAITING_FAMILY' ? { status: 'NEEDS_INFORMATION' } : {}),
      ...(queueView === 'UNASSIGNED' ? { assignedReviewerId: null, status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } : {}),
      ...(queueView === 'RECENTLY_UPDATED' ? { updatedAt: { gte: recentCutoff } } : {}),
      ...(fromDate && !Number.isNaN(fromDate.getTime()) || toDate && !Number.isNaN(toDate.getTime()) ? {
        createdAt: {
          ...(fromDate && !Number.isNaN(fromDate.getTime()) ? { gte: fromDate } : {}),
          ...(toDate && !Number.isNaN(toDate.getTime()) ? { lte: toDate } : {}),
        },
      } : {}),
    };
    const [applications, total, statusCounts] = await Promise.all([
      prisma.admissionApplication.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, applicationNumber: true, status: true, firstName: true, lastName: true,
          childName: true, intendedClass: true, studentFirstName: true, studentMiddleName: true,
          studentLastName: true, studentId: true, createdAt: true, updatedAt: true,
          reviewedAt: true, reviewedBy: true, assignedReviewerId: true, followUpAt: true,
          email: true, phone: true, guardianPhone: true, photoUrl: true,
          assignedReviewer: { select: { id: true, name: true } },
        },
      }),
      prisma.admissionApplication.count({ where }),
      prisma.admissionApplication.groupBy({ by: ['status'], where: { schoolId }, _count: { _all: true } }),
    ]);
    const studentIds = applications.map((application) => application.studentId).filter(Boolean) as string[];
    const students = studentIds.length > 0
      ? await prisma.pupil.findMany({
          where: { schoolId, id: { in: studentIds } },
          select: { id: true, admissionNo: true },
        })
      : [];
    const admissionNumbers = new Map(students.map((student) => [student.id, student.admissionNo]));

    res.json({
      applications: applications.map((application) => ({
        ...application,
        admissionNo: application.studentId ? admissionNumbers.get(application.studentId) || null : null,
      })),
      pagination: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) },
      statusCounts: Object.fromEntries(statusCounts.map((item) => [item.status, item._count._all])),
    });
  } catch (error) {
    console.error('Error fetching admission applications:', error);
    res.status(500).json({ error: 'Failed to fetch admissions' });
  }
});

// PATCH /api/admin/admissions/:id/status - Update an admission application status
router.patch('/admissions/:id/status', async (req: Request, res: Response) => {
  try {
    const [schoolId, userId] = await Promise.all([resolveSchoolId(req), resolveUserId(req)]);
    if (!schoolId || !userId) return res.status(401).json({ error: 'School admin session required' });
    const actor = await prisma.user.findFirst({ where: buildSchoolAdminMembershipWhere(userId, schoolId), select: { id: true, name: true } });
    if (!actor) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });

    const { id } = req.params;
    const { status } = req.body;
    const allowedStatuses = ['SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'WITHDRAWN'];
    const nextStatus = String(status ?? '').toUpperCase();
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    if (!allowedStatuses.includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid admission status' });
    }
    if (requiresAdmissionDecisionReason(nextStatus) && !reason) {
      return res.status(400).json({ error: 'A reason is required for rejection or withdrawal' });
    }
    if (nextStatus === 'NEEDS_INFORMATION' && !reason) {
      return res.status(400).json({ error: 'Explain what information is needed from the applicant' });
    }
    const publicStatusToken = nextStatus === 'NEEDS_INFORMATION' ? crypto.randomBytes(32).toString('base64url') : null;

    const application = await findSchoolScopedAdmissionApplication(prisma, schoolId, id);

    if (!application) return res.status(404).json({ error: 'Admission application not found' });
    const currentStatus = String(application.status || 'SUBMITTED').toUpperCase();
    if (!canTransitionAdmissionStatus(currentStatus, nextStatus)) {
      return res.status(409).json({ error: `Cannot move an application from ${currentStatus} to ${nextStatus}` });
    }
    if (currentStatus === nextStatus && nextStatus !== 'APPROVED') {
      return res.json({ success: true, unchanged: true, application });
    }

    let classRecord: { id: string } | null = null;
    if (nextStatus === 'APPROVED' && !application.studentId) {
      const requestedClassId = typeof req.body?.classId === 'string' ? req.body.classId.trim() : '';
      classRecord = requestedClassId
        ? await prisma.class.findFirst({ where: { id: requestedClassId, schoolId }, select: { id: true } })
        : application.intendedClass
          ? await prisma.class.findFirst({ where: { schoolId, name: application.intendedClass.trim() }, select: { id: true } })
          : null;
      if (requestedClassId && !classRecord) return res.status(400).json({ error: 'Selected class is not available in this school' });
      if (!classRecord) return res.status(400).json({ error: 'Confirm an available class placement before approving this application' });
    }

    if (isAdmissionApprovalStatus(nextStatus) && application.studentId) {
      const repaired = await prisma.$transaction(async (transaction) => {
        const existingStudent = await transaction.pupil.findFirst({
          where: { id: application.studentId!, schoolId },
          select: { id: true, admissionNo: true, firstName: true, lastName: true },
        });

        if (!existingStudent) {
          throw new Error('Linked student record was not found');
        }

        let student = existingStudent;
        if (!student.admissionNo) {
          const [school] = await Promise.all([
            transaction.school.findUnique({
              where: { id: schoolId },
              select: { name: true, initials: true },
            }),

          ]);

          const admissionNo = await reserveNextAdmissionNo({
            transaction,
            schoolId,
            schoolName: school?.name,
            schoolInitials: school?.initials,
            year: new Date().getFullYear(),
          });

          student = await transaction.pupil.update({
            where: { id: existingStudent.id },
            data: { admissionNo },
            select: { id: true, admissionNo: true, firstName: true, lastName: true },
          });
        }

        const repairedApplication = await transaction.admissionApplication.update({
          where: { id: application.id },
          data: {
            status: 'APPROVED',
            reviewedAt: application.reviewedAt || new Date(),
            reviewedBy: application.reviewedBy || await resolveUserName(req),
          },
        });
        if (!existingStudent.admissionNo && student.admissionNo) {
          await transaction.admissionApplicationEvent.create({
            data: {
              schoolId, admissionApplicationId: application.id, actorUserId: actor.id, actorName: actor.name,
              type: 'ADMISSION_NUMBER_REPAIRED', fromStatus: application.status, toStatus: 'APPROVED',
              reason: reason || null, metadata: { studentId: student.id, admissionNo: student.admissionNo },
            },
          });
        }

        return { application: repairedApplication, student };
      });

      return res.status(200).json({
        success: true,
        alreadyProcessed: true,
        application: repaired.application,
        student: repaired.student,
      });
    }

    if (isAdmissionApprovalStatus(nextStatus)) {
      let result;
      try {
        result = await prisma.$transaction(async (transaction) => {
        const school = await transaction.school.findUnique({
          where: { id: schoolId },
          select: { name: true, initials: true },
        });

        const admissionNo = await reserveNextAdmissionNo({
          transaction,
          schoolId,
          schoolName: school?.name,
          schoolInitials: school?.initials,
          year: new Date().getFullYear(),
        });

        const student = await transaction.pupil.create({
          data: {
            schoolId,
            firstName: application.studentFirstName || application.childName || application.firstName,
            middleName: application.studentMiddleName,
            lastName: application.studentLastName || application.childName || application.lastName,
            admissionNo,
            classId: classRecord!.id,
            status: 'ACTIVE',
            isActive: true,
            admissionDate: application.admissionDate || new Date(),
            gender: application.gender,
            dateOfBirth: application.dateOfBirth,
            studentEmail: application.studentEmail,
            studentPhone: application.studentPhone,
            address: application.address,
            bloodGroup: application.bloodGroup,
            genotype: application.genotype,
            medicalNotes: application.medicalNotes,
            previousSchool: application.previousSchool,
            previousClass: application.previousClass,
            photoUrl: application.photoUrl,
          },
          select: { id: true, admissionNo: true, firstName: true, lastName: true },
        });

        const guardianFirst = application.guardianFirst || application.firstName;
        const guardianLast = application.guardianLast || application.lastName;
        const guardian = await transaction.guardian.create({
          data: {
            schoolId,
            firstName: guardianFirst,
            lastName: guardianLast,
            phone: application.guardianPhone || application.phone || '',
            altPhone: application.guardianAltPhone,
            email: application.guardianEmail || application.email,
            occupation: application.guardianOccupation,
          },
        });

        await transaction.guardianPupil.create({
          data: {
            guardianId: guardian.id,
            pupilId: student.id,
            relation: application.guardianRelationship || 'Parent',
          },
        });

        const updateResult = await transaction.admissionApplication.updateMany({
          where: { id: application.id, schoolId, studentId: null, status: application.status },
          data: {
            status: 'APPROVED',
            studentId: student.id,
            reviewedAt: new Date(),
            reviewedBy: actor.name,
            decisionReason: reason || null,
          },
        });
        if (updateResult.count !== 1) throw new Error('ADMISSION_APPROVAL_CONFLICT');
        const updated = await transaction.admissionApplication.findUnique({ where: { id: application.id } });

        await transaction.admissionApplicationEvent.create({
          data: {
            schoolId, admissionApplicationId: application.id, actorUserId: actor.id, actorName: actor.name,
            type: 'STATUS_CHANGED', fromStatus: application.status, toStatus: 'APPROVED', reason: reason || null,
            metadata: { studentId: student.id, guardianId: guardian.id, admissionNo: student.admissionNo, classId: classRecord!.id },
          },
        });

          return { application: updated, student };
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'ADMISSION_APPROVAL_CONFLICT') throw error;
        const completedConversion = await findCompletedAdmissionConversion(prisma, schoolId, application.id);
        if (!completedConversion) throw error;
        return res.status(200).json({ success: true, alreadyProcessed: true, ...completedConversion });
      }

      await recordActivity({
        event: 'ADMISSION_CONVERTED_TO_STUDENT',
        details: `Approved admission converted to student: ${result.student.firstName} ${result.student.lastName}`,
        schoolId,
      }).catch((error) => console.warn('Failed to record admission conversion activity:', error));
      await notifyAdmissionApplicantStatus(application, 'APPROVED', schoolId)
        .catch((error) => console.warn('Failed to notify applicant of approval:', error));
      return res.status(200).json({ success: true, ...result });
    }

    const updatedApplication = await prisma.$transaction(async (transaction) => {
      const updateResult = await transaction.admissionApplication.updateMany({
        where: { id: application.id, schoolId, status: application.status },
        data: {
          status: nextStatus,
          reviewedAt: new Date(),
          reviewedBy: actor.name,
          decisionReason: reason || null,
          ...(publicStatusToken ? {
            publicStatusTokenHash: crypto.createHash('sha256').update(publicStatusToken).digest('hex'),
            publicStatusTokenExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          } : {}),
        },
      });
      if (updateResult.count !== 1) throw new Error('ADMISSION_STATUS_CONFLICT');
      const updated = await transaction.admissionApplication.findUnique({ where: { id: application.id } });
      await transaction.admissionApplicationEvent.create({
        data: {
          schoolId, admissionApplicationId: application.id, actorUserId: actor.id, actorName: actor.name,
          type: nextStatus === 'NEEDS_INFORMATION' ? 'MORE_INFORMATION_REQUESTED' : 'STATUS_CHANGED',
          fromStatus: application.status, toStatus: nextStatus, reason: reason || null,
        },
      });
      return updated;
    });

    await notifyAdmissionApplicantStatus({ ...application, id: application.id }, nextStatus, schoolId, nextStatus === 'NEEDS_INFORMATION' ? reason : undefined, publicStatusToken)
      .catch((error) => console.warn('Failed to notify applicant of admission status:', error));

    res.json({ success: true, application: updatedApplication });
  } catch (error) {
    console.error('Error updating admission application status:', error);
    res.status(500).json({ error: 'Failed to update admission status' });
  }
});

// POST /api/admin/students/send-access-notifications - Re-share parent portal access
router.post('/students/send-access-notifications', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    const pupilIds = Array.from(new Set((Array.isArray(req.body?.pupilIds) ? req.body.pupilIds : []).map((id: unknown) => String(id || '').trim()).filter(Boolean)));
    const channels = Array.from(new Set((Array.isArray(req.body?.channels) ? req.body.channels : ['EMAIL', 'WHATSAPP']).filter((channel: unknown) => channel === 'EMAIL' || channel === 'WHATSAPP'))) as Array<'EMAIL' | 'WHATSAPP'>;
    const forceResend = req.body?.forceResend === true;
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });
    if (pupilIds.length === 0) return res.status(400).json({ error: 'Select at least one student' });
    if (pupilIds.length > 100) return res.status(400).json({ error: 'You can notify up to 100 students at a time' });
    if (channels.length === 0) return res.status(400).json({ error: 'Select at least one delivery channel' });

    const pupils = await prisma.pupil.findMany({ where: { id: { in: pupilIds }, schoolId }, include: { class: true, guardians: { include: { guardian: true } } } });
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { name: true, logoUrl: true } });
    if (!school) return res.status(404).json({ error: 'School not found' });

    const whatsappCount = pupils.reduce((total, pupil) => total + pupil.guardians.reduce((count, link) => count + (buildGuardianNotificationRecipients(link.guardian).some((recipient) => recipient.channel === 'WHATSAPP') ? 1 : 0), 0), 0);
    if (channels.includes('WHATSAPP') && whatsappCount > 0) {
      const policy = await readSchoolWhatsAppPolicy(prisma, schoolId);
      const evaluation = evaluateSchoolWhatsAppSend(policy, { recipientCount: whatsappCount, approvedForBulk: req.body?.approvedForBulk === true });
      if (!evaluation.allowed) return res.status(429).json({ error: evaluation.reason || 'WhatsApp sending is currently unavailable' });
    }

    const service = createCommunicationService();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const totals = { sent: 0, queued: 0, failed: 0, skipped: 0, missingContact: 0, duplicateSuppressed: 0 };
    const results: Array<Record<string, unknown>> = [];
    for (const pupil of pupils) {
      const studentName = `${pupil.firstName} ${pupil.lastName}`.trim();
      const className = pupil.class ? `${pupil.class.name}${pupil.class.arm ? ` ${pupil.class.arm}` : ''}` : 'Unassigned';
      const channelResults: Array<Record<string, unknown>> = [];
      for (const link of pupil.guardians) {
        const guardian = link.guardian;
        const recipients = buildGuardianNotificationRecipients(link.guardian).filter((recipient) => channels.includes(recipient.channel));
        if (recipients.length === 0) { totals.missingContact++; continue; }
        const recent = forceResend ? [] : await prisma.notification.findMany({ where: { schoolId, guardianId: guardian.id, relatedId: pupil.id, type: 'STUDENT_ACCESS_RESEND', createdAt: { gte: cutoff } }, select: { channel: true } });
        const recentChannels = new Set(recent.map((notification) => notification.channel));
        const deliverable = recipients.filter((recipient) => !recentChannels.has(recipient.channel));
        recipients.filter((recipient) => recentChannels.has(recipient.channel)).forEach((recipient) => { totals.duplicateSuppressed++; channelResults.push({ guardianId: guardian.id, channel: recipient.channel, status: 'SKIPPED', reason: 'Recently sent' }); });
        if (deliverable.length === 0) continue;
        const parentPortalUrl = `${(process.env.FRONTEND_URL || 'https://www.schoolbase.live').replace(/\/$/, '')}/parent/login`;
        const message = `Hello ${guardian.firstName},\n\nYour parent portal access for ${studentName} is ready.\n\nAdmission number: ${pupil.admissionNo || 'N/A'}\nClass: ${className}\n\nOpen ${parentPortalUrl} and use the registered phone number with the admission number to sign in. No password is required.`;
        const dispatch = await service.dispatch({ event: 'StudentAccessResent', schoolId, recipients: deliverable, template: 'StudentAccess', subject: `Parent portal access for ${studentName}`, body: message, data: { studentName, className, admissionNo: String(pupil.admissionNo || 'N/A'), parentPortalUrl, schoolName: school.name, recipientName: guardian.firstName }, metadata: { guardianId: guardian.id, logoUrl: school.logoUrl ?? undefined } });
        for (const delivery of dispatch.deliveries) {
          const status = delivery.status === 'QUEUED' ? 'PENDING' : delivery.status;
          await prisma.notification.create({ data: { schoolId, guardianId: guardian.id, type: 'STUDENT_ACCESS_RESEND', title: 'Parent Portal Access Reminder', body: truncateNotificationBody(message), channel: delivery.channel, status, sentAt: delivery.status === 'SENT' || delivery.status === 'QUEUED' ? new Date() : undefined, failureReason: delivery.error, relatedId: pupil.id, reference: String(pupil.admissionNo || 'N/A') } });
          if (status === 'PENDING') totals.queued++; else if (status === 'SENT') totals.sent++; else totals.failed++;
          channelResults.push({ guardianId: guardian.id, channel: delivery.channel, status, error: delivery.error });
        }
      }
      if (channelResults.length === 0) totals.skipped++;
      results.push({ pupilId: pupil.id, studentName, channels: channelResults });
    }
    await recordActivity({ event: 'STUDENT_ACCESS_RESEND', details: `Parent portal access notifications requested for ${pupils.length} student(s)`, schoolId }).catch((error) => console.warn('Failed to record access resend activity:', error));
    return res.json({ totals, results, requested: pupilIds.length, processed: pupils.length });
  } catch (error) {
    console.error('Error sending student access notifications:', error);
    return res.status(500).json({
      error: 'Failed to send parent access notifications',
      ...(process.env.NODE_ENV !== 'production' ? { details: error instanceof Error ? error.message : String(error) } : {}),
    });
  }
});

function truncateNotificationBody(body: string, maxLength = 180) {
  if (!body) return body;
  return body.length <= maxLength ? body : `${body.slice(0, maxLength - 3)}...`;
}

// POST /api/admin/verify - Verify staff session from cookie
router.post('/verify', async (req: Request, res: Response) => {
  try {
    // Check for unified session cookie
    const token = req.cookies?.schoolbase_session || req.cookies?.schoolbase_staff || req.cookies?.staff_session;
    
    if (!token) {
      return res.status(401).json({ authenticated: false });
    }

    const { payload } = await jwtVerify(token, secret());
    
    // Add subscription status if school ID is available
    let subscriptionCheck = null;
    if ((payload as any).schoolId) {
      subscriptionCheck = await checkSubscription((payload as any).schoolId);
    }
    
    res.json({
      authenticated: true,
      session: payload,
      subscription: subscriptionCheck, // Added: subscription state (non-breaking)
    });
  } catch (error) {
    res.status(401).json({ authenticated: false });
  }
});

router.post('/impersonate', async (req: Request, res: Response) => {
  try {
    const { token } = req.body as { token?: string };
    if (!token) {
      return res.status(400).json({ error: 'Impersonation token is required.' });
    }

    const { payload } = await jwtVerify(token, secret());
    const schoolId = String((payload as any).schoolId || '');
    const purpose = String((payload as any).purpose || '');
    const adminId = String((payload as any).adminId || 'platform-admin');

    if (!schoolId || purpose !== 'IMPERSONATION') {
      return res.status(400).json({ error: 'Invalid impersonation token.' });
    }

    const sessionToken = await new SignJWT({
      userId: adminId,
      role: 'SCHOOL_ADMIN',
      email: 'impersonation@schoolbase.local',
      name: 'Platform Admin Impersonator',
      schoolId,
      impersonation: true,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(secret());

    res.json({
      success: true,
      token: sessionToken,
      schoolId,
    });
  } catch (error) {
    console.error('[API ADMIN] Impersonation exchange error:', error);
    return res.status(500).json({ error: 'Failed to exchange impersonation token.' });
  }
});

// POST /api/admin/login - DEPRECATED: Use /api/auth/platform-login or /api/auth/school-login
// This endpoint is kept for backward compatibility only
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await prisma.user.findUnique({
      where: { email: String(email).trim().toLowerCase() },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        passwordHash: true,
        schoolId: true,
      },
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const valid = await bcrypt.compare(String(password), user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // DEPRECATED: Add validation warnings
    console.warn(`[DEPRECATED] /api/admin/login called for ${user.role} (${email}). Use /api/auth/platform-login or /api/auth/school-login`);

    // For backward compatibility, still create token
    const token = await new SignJWT({
      userId: user.id,
      schoolId: user.schoolId,
      email: user.email,
      name: user.name,
      role: user.role,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(secret());

    // Set unified httpOnly session cookie for all user types
    res.cookie('schoolbase_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
      domain: process.env.NODE_ENV === 'production' ? '.schoolbase.live' : undefined,
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ 
      success: true, 
      token, // Include token so frontend can decode role
      role: user.role,
      userId: user.id,
      schoolId: user.schoolId,
      name: user.name,
      email: user.email
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/admin/school - Get logged-in admin's school data (multi-tenant safe)
router.get('/school', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      include: {
        partner: true,
        enabledPhases: true,
        paymentAccounts: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    res.json(school);
  } catch (error) {
    console.error('[GET /api/admin/school] Error:', error);
    res.status(500).json({ error: 'Failed to fetch school', details: String(error) });
  }
});

// GET /api/admin/school/:schoolId - Get school data by ID
router.get('/school/:schoolId', async (req: Request, res: Response) => {
  try {
    const { schoolId } = req.params;
    
    console.log('[GET /api/admin/school/:schoolId] schoolId:', schoolId);

    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    if ((await resolvePathSchoolId(req, schoolId)) !== schoolId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      include: {
        partner: true,
        enabledPhases: true,
        paymentAccounts: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    console.log('[GET /api/admin/school/:schoolId] school:', school ? 'found' : 'not found');

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    res.json(school);
  } catch (error) {
    console.error('[GET /api/admin/school/:schoolId] Error:', error);
    res.status(500).json({ error: 'Failed to fetch school', details: String(error) });
  }
});

// GET /api/admin/settings - Get school settings
router.get('/settings', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        name: true,
        initials: true,
        tagline: true,
        country: true,
        currency: true,
        address: true,
        city: true,
        phone: true,
        email: true,
        logoUrl: true,
        primaryColor: true,
        principalName: true,
        principalComment: true,
        principalSignatureUrl: true,
        stampUrl: true,
        manualPaymentAccountName: true,
        manualPaymentAccountNumber: true,
        manualPaymentBankName: true,
        admissionsEnabled: true,
        admissionsCapabilityEnabled: true,
        admissionsOpeningDate: true,
        admissionsClosingDate: true,
        admissionsIntroText: true,
        admissionsRequirements: true,
        admissionsContactInfo: true,
        resultAccessPinEnabled: true,
        resultAccessMode: true,
        resultAccessPinType: true,
        resultAccessPinValidity: true,
        resultAccessAllowRegeneration: true,
        paymentAccounts: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
        paystackPublicEncrypted: true,
        paystackSecretEncrypted: true,
      },
    });

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    res.json({
      config: {
        name: school.name,
        initials: school.initials,
        tagline: school.tagline,
        country: school.country,
        currency: school.currency,
        address: school.address,
        city: school.city,
        phone: school.phone,
        email: school.email,
        logoUrl: school.logoUrl,
        primaryColor: school.primaryColor,
        principalName: school.principalName,
        principalComment: school.principalComment,
        principalSignatureUrl: school.principalSignatureUrl,
        stampUrl: school.stampUrl,
        manualPaymentAccountName: school.manualPaymentAccountName,
        manualPaymentAccountNumber: school.manualPaymentAccountNumber,
        manualPaymentBankName: school.manualPaymentBankName,
        admissionsEnabled: school.admissionsEnabled,
        admissionsCapabilityEnabled: school.admissionsCapabilityEnabled,
        admissionsOpeningDate: school.admissionsOpeningDate,
        admissionsClosingDate: school.admissionsClosingDate,
        admissionsIntroText: school.admissionsIntroText,
        admissionsRequirements: school.admissionsRequirements,
        admissionsContactInfo: school.admissionsContactInfo,
        resultAccess: {
          enabled: school.resultAccessPinEnabled,
          mode: school.resultAccessMode,
          pinType: school.resultAccessPinType,
          pinValidity: school.resultAccessPinValidity,
          allowRegeneration: school.resultAccessAllowRegeneration,
        },
        paymentAccounts: school.paymentAccounts,
        hasPaystackPublic: Boolean(school.paystackPublicEncrypted),
        hasPaystackSecret: Boolean(school.paystackSecretEncrypted),
      },
    });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// POST /api/admin/settings - Save school settings
router.post('/settings', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const {
      name,
      initials,
      slug,
      tagline,
      country,
      currency,
      address,
      email,
      phone,
      principalName,
      principalComment,
      manualPaymentAccountName,
      manualPaymentAccountNumber,
      manualPaymentBankName,
      paymentAccounts,
      principalSignatureUrl,
      stampUrl,
      logoUrl,
      paystackPublic,
      paystackSecret,
      resultAccess,
      admissionsEnabled,
      admissionsCapabilityEnabled,
      admissionsOpeningDate,
      admissionsClosingDate,
      admissionsIntroText,
      admissionsRequirements,
      admissionsContactInfo,
    } = req.body;

    const normalizedSlug = typeof slug === 'string' ? slug.trim().toLowerCase() : null;
    if (!normalizedSlug || !/^[a-z0-9-]+$/.test(normalizedSlug)) {
      return res.status(400).json({ error: 'Invalid slug. Use only lowercase letters, numbers, and hyphens.' });
    }

    const existingSlugOwner = await prisma.school.findUnique({
      where: { slug: normalizedSlug },
      select: { id: true },
    });

    if (existingSlugOwner && existingSlugOwner.id !== schoolId) {
      return res.status(409).json({ error: 'The chosen slug is already in use. Please choose another.' });
    }

    const school = await prisma.school.update({
      where: { id: schoolId },
      data: {
        name,
        initials,
        slug: normalizedSlug,
        tagline: typeof tagline === 'string' ? tagline.trim() || null : null,
        country,
        currency,
        address,
        email: typeof email === 'string' ? email.trim() || null : null,
        phone: typeof phone === 'string' ? phone.trim() || null : null,
        principalName,
        principalComment,
        manualPaymentAccountName,
        manualPaymentAccountNumber,
        manualPaymentBankName,
        principalSignatureUrl,
        stampUrl,
        logoUrl,
        admissionsEnabled: Boolean(admissionsEnabled),
        admissionsCapabilityEnabled: Boolean(admissionsCapabilityEnabled),
        admissionsOpeningDate: admissionsOpeningDate ? new Date(admissionsOpeningDate) : null,
        admissionsClosingDate: admissionsClosingDate ? new Date(admissionsClosingDate) : null,
        admissionsIntroText: admissionsIntroText || null,
        admissionsRequirements: admissionsRequirements || null,
        admissionsContactInfo: admissionsContactInfo || null,
        resultAccessPinEnabled: Boolean(resultAccess?.enabled),
        resultAccessMode: resultAccess?.mode || 'NONE',
        resultAccessPinType: resultAccess?.pinType || 'NONE',
        resultAccessPinValidity: resultAccess?.pinValidity || 'TERM',
        resultAccessAllowRegeneration: Boolean(resultAccess?.allowRegeneration),
        paystackPublicEncrypted: paystackPublic || null,
        paystackSecretEncrypted: paystackSecret || null,
      },
    });

    if (Array.isArray(paymentAccounts)) {
      const normalizedAccounts = paymentAccounts
        .map((account: any, index: number) => ({
          label: String(account?.label || '').trim(),
          bankName: String(account?.bankName || '').trim(),
          accountName: String(account?.accountName || '').trim(),
          accountNumber: String(account?.accountNumber || '').trim(),
          branchName: String(account?.branchName || '').trim() || null,
          currency: String(account?.currency || '').trim() || null,
          purpose: String(account?.purpose || '').trim() || null,
          isDefault: Boolean(account?.isDefault),
          isActive: account?.isActive !== false,
          sortOrder: Number.isFinite(Number(account?.sortOrder)) ? Number(account.sortOrder) : index,
        }))
        .filter((account) => account.label && account.bankName && account.accountName && account.accountNumber);

      const defaultIndex = normalizedAccounts.findIndex((account) => account.isDefault);

      await prisma.paymentAccount.deleteMany({ where: { schoolId } });
      if (normalizedAccounts.length > 0) {
        await prisma.paymentAccount.createMany({
          data: normalizedAccounts.map((account, index) => ({
            schoolId,
            ...account,
            isDefault: defaultIndex === -1 ? index === 0 : index === defaultIndex,
          })),
        });
      }
    }

    res.json({ success: true, school });
  } catch (error) {
    console.error('Error saving settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// GET /api/admin/settings/status - Get settings status
router.get('/settings/status', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        paystackPublicEncrypted: true,
        paystackSecretEncrypted: true,
        twilioSidEncrypted: true,
        twilioTokenEncrypted: true,
      },
    });

    res.json({
      paystack: {
        effective: school?.paystackPublicEncrypted && school?.paystackSecretEncrypted ? 'per-school' : null,
      },
      twilio: {
        effective: school?.twilioSidEncrypted && school?.twilioTokenEncrypted ? 'per-school' : null,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching status:', error);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// GET /api/admin/settings/data - Get school settings and staff for authenticated school
router.get('/settings/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        name: true,
        initials: true,
        slug: true,
        tagline: true,
        address: true,
        city: true,
        country: true,
        currency: true,
        phone: true,
        email: true,
        logoUrl: true,
        primaryColor: true,
        principalName: true,
        principalComment: true,
        principalSignatureUrl: true,
        stampUrl: true,
        manualPaymentAccountName: true,
        manualPaymentAccountNumber: true,
        manualPaymentBankName: true,
        admissionsEnabled: true,
        admissionsCapabilityEnabled: true,
        admissionsOpeningDate: true,
        admissionsClosingDate: true,
        admissionsIntroText: true,
        admissionsRequirements: true,
        admissionsContactInfo: true,
        resultAccessPinEnabled: true,
        resultAccessMode: true,
        resultAccessPinType: true,
        resultAccessPinValidity: true,
        resultAccessAllowRegeneration: true,
        paymentAccounts: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
        paystackPublicEncrypted: true,
        paystackSecretEncrypted: true,
        enabledPhases: true,
      },
    });

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    const staff = await prisma.user.findMany({
      where: { schoolId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, role: true },
    });

    res.json({
      config: {
        name: school.name,
        initials: school.initials,
        slug: school.slug,
        tagline: school.tagline,
        address: school.address,
        city: school.city,
        country: school.country,
        currency: school.currency,
        phone: school.phone,
        email: school.email,
        logoUrl: school.logoUrl,
        primaryColor: school.primaryColor,
        principalName: school.principalName,
        principalComment: school.principalComment,
        principalSignatureUrl: school.principalSignatureUrl,
        stampUrl: school.stampUrl,
        manualPaymentAccountName: school.manualPaymentAccountName,
        manualPaymentAccountNumber: school.manualPaymentAccountNumber,
        manualPaymentBankName: school.manualPaymentBankName,
        admissionsEnabled: school.admissionsEnabled,
        admissionsCapabilityEnabled: school.admissionsCapabilityEnabled,
        admissionsOpeningDate: school.admissionsOpeningDate,
        admissionsClosingDate: school.admissionsClosingDate,
        admissionsIntroText: school.admissionsIntroText,
        admissionsRequirements: school.admissionsRequirements,
        admissionsContactInfo: school.admissionsContactInfo,
        resultAccess: {
          enabled: school.resultAccessPinEnabled,
          mode: school.resultAccessMode,
          pinType: school.resultAccessPinType,
          pinValidity: school.resultAccessPinValidity,
          allowRegeneration: school.resultAccessAllowRegeneration,
        },
        paymentAccounts: school.paymentAccounts,
        paystackPublicKey:
          process.env.PAYSTACK_SUBSCRIPTION_PUBLIC_KEY ||
          process.env.PAYSTACK_PUBLIC_KEY ||
          null,
        hasPaystackPublic: Boolean(school.paystackPublicEncrypted),
        hasPaystackSecret: Boolean(school.paystackSecretEncrypted),
        enabledPhases: school.enabledPhases,
      },
      staff,
    });
  } catch (error) {
    console.error('Error fetching settings data:', error);
    res.status(500).json({ error: 'Failed to fetch settings data' });
  }
});

// GET /api/admin/signatories - List signatories for the current school
router.get('/signatories', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const signatories = await prisma.signatory.findMany({
      where: { schoolId },
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
    });

    return res.json({ signatories });
  } catch (error) {
    console.error('Error fetching signatories:', error);
    return res.status(500).json({ error: 'Failed to fetch signatories' });
  }
});

// POST /api/admin/signatories - Create a signatory for the current school
router.post('/signatories', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { name, title, phase, signatureUrl, active = true } = req.body ?? {};
    if (!String(name ?? '').trim()) return res.status(400).json({ error: 'Name is required' });

    const signatory = await prisma.signatory.create({
      data: {
        schoolId,
        name: String(name).trim(),
        title: title ? String(title).trim() : null,
        phase: phase || null,
        signatureUrl: signatureUrl || null,
        active: Boolean(active),
      },
    });

    return res.status(201).json({ signatory });
  } catch (error) {
    console.error('Error creating signatory:', error);
    return res.status(500).json({ error: 'Failed to create signatory' });
  }
});

// PUT /api/admin/signatories/:id - Update a school signatory
router.put('/signatories/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const existing = await prisma.signatory.findFirst({ where: { id: req.params.id, schoolId } });
    if (!existing) return res.status(404).json({ error: 'Signatory not found' });

    const { name, title, phase, signatureUrl, active } = req.body ?? {};
    const signatory = await prisma.signatory.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined ? { name: String(name).trim() } : {}),
        ...(title !== undefined ? { title: title ? String(title).trim() : null } : {}),
        ...(phase !== undefined ? { phase: phase || null } : {}),
        ...(signatureUrl !== undefined ? { signatureUrl: signatureUrl || null } : {}),
        ...(active !== undefined ? { active: Boolean(active) } : {}),
      },
    });

    return res.json({ signatory });
  } catch (error) {
    console.error('Error updating signatory:', error);
    return res.status(500).json({ error: 'Failed to update signatory' });
  }
});

// DELETE /api/admin/signatories/:id - Deactivate a school signatory
router.delete('/signatories/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const existing = await prisma.signatory.findFirst({ where: { id: req.params.id, schoolId } });
    if (!existing) return res.status(404).json({ error: 'Signatory not found' });

    const signatory = await prisma.signatory.update({ where: { id: existing.id }, data: { active: false } });
    return res.json({ signatory });
  } catch (error) {
    console.error('Error deactivating signatory:', error);
    return res.status(500).json({ error: 'Failed to deactivate signatory' });
  }
});

// POST /api/admin/settings/upload - Upload school asset (signature, stamp, logo)
router.post('/settings/upload', settingsUpload.single('file'), async (req: Request, res: Response) => {
  console.log('[settings upload] contentType=', req.headers['content-type']);
  console.log('[settings upload] body=', req.body);
  console.log('[settings upload] file=', req.file ? {
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    path: req.file.path,
  } : null);

  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const fileType = (req.body.type || req.query.type) as string;

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const assetUrl = `/uploads/settings/${req.file.filename}`;
    
    // Update school record with the new asset URL
    const updateData: any = {};
    if (fileType === 'signature') {
      updateData.principalSignatureUrl = assetUrl;
    } else if (fileType === 'stamp') {
      updateData.stampUrl = assetUrl;
    } else if (fileType === 'logo') {
      updateData.logoUrl = assetUrl;
    }

    if (Object.keys(updateData).length > 0) {
      await prisma.school.update({
        where: { id: schoolId },
        data: updateData,
      });
    }

    res.json({
      success: true,
      message: 'File uploaded successfully',
      url: assetUrl,
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// GET /api/admin/school-logo/:schoolId - Redirect to school logo asset
router.get('/school-logo/:schoolId', async (req: Request, res: Response) => {
  try {
    const { schoolId } = req.params;
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { logoUrl: true },
    });

    if (!school || !school.logoUrl) {
      return res.status(404).json({ error: 'Logo not found' });
    }

    return res.redirect(307, school.logoUrl);
  } catch (error) {
    console.error('Error fetching school logo:', error);
    res.status(500).json({ error: 'Failed to fetch school logo' });
  }
});

// GET /api/admin/school-stamp/:schoolId - Redirect to school stamp asset
router.get('/school-stamp/:schoolId', async (req: Request, res: Response) => {
  try {
    const { schoolId } = req.params;
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { stampUrl: true },
    });

    if (!school || !school.stampUrl) {
      return res.status(404).json({ error: 'School stamp not found' });
    }

    return res.redirect(307, school.stampUrl);
  } catch (error) {
    console.error('Error fetching school stamp:', error);
    res.status(500).json({ error: 'Failed to fetch school stamp' });
  }
});

// GET /api/admin/school-signature/:schoolId - Redirect to principal signature asset
router.get('/school-signature/:schoolId', async (req: Request, res: Response) => {
  try {
    const { schoolId } = req.params;
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { principalSignatureUrl: true },
    });

    if (!school || !school.principalSignatureUrl) {
      return res.status(404).json({ error: 'Signature not found' });
    }

    return res.redirect(307, school.principalSignatureUrl);
  } catch (error) {
    console.error('Error fetching school signature:', error);
    res.status(500).json({ error: 'Failed to fetch school signature' });
  }
});

// POST /api/admin/logo/presign - Get local upload URL for logo upload
router.post('/logo/presign', async (req: Request, res: Response) => {
  try {
    const schoolId = (req.query.schoolId as string) || (req.headers['x-school-id'] as string);
    const { fileName, contentType, fileSize } = req.body;

    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    if (!fileName) {
      return res.status(400).json({ error: 'File name is required' });
    }

    res.json({
      success: true,
      type: 'local',
      uploadUrl: `/api/admin/settings/upload?schoolId=${schoolId}&type=logo`,
      fileName,
    });
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

// POST /api/admin/logo/confirm - Confirm logo upload
router.post('/logo/confirm', async (req: Request, res: Response) => {
  try {
    const schoolId = (req.query.schoolId as string) || (req.headers['x-school-id'] as string);
    const { key, url } = req.body;

    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    res.json({
      success: true,
      message: 'Logo confirmed',
      url: url || key,
    });
  } catch (error) {
    console.error('Error confirming logo:', error);
    res.status(500).json({ error: 'Failed to confirm logo' });
  }
});

// POST /api/admin/students/:pupilId/photo - Upload student photo
router.post('/students/:pupilId/photo', upload.single('photo'), async (req: Request, res: Response) => {
  try {
    const { pupilId } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // Verify the pupil exists
    const pupil = await prisma.pupil.findUnique({
      where: { id: pupilId },
    });

    if (!pupil) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Student not found' });
    }

    // Update pupil with photo URL
    const photoUrl = `/uploads/photos/${req.file.filename}`;
    await prisma.pupil.update({
      where: { id: pupilId },
      data: { photoUrl },
    });

    res.json({
      success: true,
      photoUrl,
      message: 'Student photo uploaded successfully',
    });
  } catch (error) {
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error uploading student photo:', error);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// GET /api/admin/dashboard - Get dashboard stats for client-side rendering
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    console.log('[GET /api/admin/dashboard] schoolId:', schoolId);

    const [invoices, pupilCount, classCount, readyAssessment, recentPayments, recentPupils, recentTeachers, recentAnnouncements] =
      await Promise.all([
        prisma.invoice.findMany({
          where: { schoolId },
          select: { amountDue: true, amountPaid: true, status: true },
        }),
        prisma.pupil.count({ where: { schoolId, isActive: true } }),
        prisma.class.count({ where: { schoolId } }),
        prisma.assessment.findFirst({
          where: { schoolId, status: 'APPROVED' },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.payment.findMany({
          take: 3,
          orderBy: { paidAt: 'desc' },
          include: { invoice: { include: { pupil: true } } },
          where: { invoice: { schoolId } },
        }),
        prisma.pupil.findMany({
          where: { schoolId, isActive: true },
          orderBy: { createdAt: 'desc' },
          take: 3,
          include: { class: { select: { name: true, arm: true } } },
        }),
        prisma.user.findMany({
          where: { schoolId, role: 'TEACHER' },
          orderBy: { createdAt: 'desc' },
          take: 3,
        }),
        prisma.announcement.findMany({
          where: { schoolId },
          orderBy: { publishedAt: 'desc' },
          take: 3,
        }),
      ]);

    const outstanding = invoices.reduce(
      (sum, inv) => sum + Math.max(0, inv.amountDue - inv.amountPaid),
      0,
    );
    const attentionCount = invoices.filter((i) =>
      ['SENT', 'PART_PAID', 'OVERDUE'].includes(i.status),
    ).length;

    console.log('[GET /api/admin/dashboard] invoices.length:', invoices.length, 'outstanding:', outstanding);

    res.json({
      invoices: invoices.map(inv => ({
        amountDue: inv.amountDue,
        amountPaid: inv.amountPaid,
        status: inv.status,
      })),
      pupilCount,
      classCount,
      readyAssessment,
      recentPayments,
      recentPupils,
      recentTeachers,
      recentAnnouncements,
      outstanding,
      attentionCount,
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// GET /api/admin/fees/data - Get fees page data
router.get('/fees/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { currency: true },
    });

    const currentAcademicYear = await prisma.academicYear.findFirst({
      where: { schoolId, isCurrent: true },
      orderBy: { createdAt: 'desc' },
    });

    const terms = currentAcademicYear
      ? await prisma.term.findMany({
          where: { academicYearId: currentAcademicYear.id },
          orderBy: { sortOrder: 'asc' },
        })
      : [];

    const invoices = await prisma.invoice.findMany({
      where: { schoolId },
      include: {
        pupil: { include: { class: true, guardians: { include: { guardian: true } } } },
        payments: { orderBy: { paidAt: 'desc' }, take: 1 },
        feeSchedule: { include: { term: { include: { academicYear: true } } } },
        items: {
          include: {
            allocations: { select: { amount: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });

    const outstanding = invoices.reduce(
      (s, i) => s + Math.max(0, i.amountDue - i.amountPaid),
      0,
    );

    const mappedInvoices = invoices.map((inv) => ({
      ...inv,
      dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
      academicYear: inv.feeSchedule?.term?.academicYear
        ? {
            id: inv.feeSchedule.term.academicYear.id,
            name: inv.feeSchedule.term.academicYear.name,
            isCurrent: inv.feeSchedule.term.academicYear.isCurrent,
          }
        : null,
    }));

    res.json({
      invoices: mappedInvoices,
      outstanding,
      currency: school?.currency || 'NGN',
      terms,
    });
  } catch (error) {
    console.error('Error fetching fees data:', error);
    res.status(500).json({ error: 'Failed to fetch fees data' });
  }
});

// GET /api/admin/fees/schedules - Get all fee schedules for school
router.get('/fees/schedules', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const feeSchedules = await prisma.feeSchedule.findMany({
      where: { schoolId },
      include: {
        term: { include: { academicYear: true } },
        class: true,
        items: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
      orderBy: [{ createdAt: 'desc' }],
    });

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { currency: true },
    });

    const terms = await prisma.term.findMany({
      where: { academicYear: { schoolId } },
      include: { academicYear: true },
      orderBy: [{ academicYear: { createdAt: 'desc' } }, { sortOrder: 'asc' }],
    });

    const classes = await prisma.class.findMany({
      where: { schoolId },
      select: { id: true, name: true, arm: true, phase: true },
      orderBy: { name: 'asc' },
    });

    res.json({
      feeSchedules,
      currency: school?.currency || 'NGN',
      terms,
      classes,
    });
  } catch (error) {
    console.error('Error fetching fee schedules:', error);
    res.status(500).json({ error: 'Failed to fetch fee schedules' });
  }
});

// POST /api/admin/fees/schedules - Create fee schedule
router.post('/fees/schedules', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { termId, classId, name, amount, items } = req.body;
    const itemPayload = Array.isArray(items) ? items : [];
    const validItems = itemPayload.map((item, index) => normalizeFeeScheduleItemInput(item, index)).filter(Boolean) as Array<{
      name: string;
      amount: number;
      description: string | null;
      isRequired: boolean;
      sortOrder: number;
    }>;

    const scheduleAmount = resolveFeeScheduleAmount({ amount, items: itemPayload, previousItems: [] });

    if (!termId || !name || scheduleAmount === null) {
      return res.status(400).json({
        error: 'Missing required fields: termId, name, and either a total amount or at least one fee item',
      });
    }

    // Verify term belongs to school
    const term = await prisma.term.findFirst({
      where: { id: termId, academicYear: { schoolId } },
    });

    if (!term) {
      return res.status(404).json({ error: 'Term not found' });
    }

    // Verify class belongs to school if provided
    if (classId) {
      const classExists = await prisma.class.findFirst({
        where: { id: classId, schoolId },
      });

      if (!classExists) {
        return res.status(404).json({ error: 'Class not found' });
      }
    }

    const feeSchedule = await prisma.feeSchedule.create({
      data: {
        schoolId,
        termId,
        classId: classId || null,
        name,
        amount: scheduleAmount,
      },
      include: {
        term: { include: { academicYear: true } },
        class: true,
        items: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (validItems.length > 0) {
      for (const item of validItems) {
        await prisma.feeScheduleItem.create({
          data: {
            schoolId,
            feeScheduleId: feeSchedule.id,
            name: item.name,
            amount: item.amount,
            description: item.description,
            isRequired: item.isRequired,
            sortOrder: item.sortOrder,
          },
        });
      }

      await prisma.feeSchedule.update({
        where: { id: feeSchedule.id },
        data: { amount: scheduleAmount },
      });
    }

    const refreshedSchedule = await prisma.feeSchedule.findUnique({
      where: { id: feeSchedule.id },
      include: {
        term: { include: { academicYear: true } },
        class: true,
        items: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    res.json({ success: true, feeSchedule: refreshedSchedule });
  } catch (error) {
    console.error('Error creating fee schedule:', error);
    res.status(500).json({ error: 'Failed to create fee schedule' });
  }
});

// PATCH /api/admin/fees/schedules/:id - Update fee schedule
router.patch('/fees/schedules/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;
    const { termId, classId, name, amount, items } = req.body;

    // Verify fee schedule belongs to school
    const feeSchedule = await prisma.feeSchedule.findFirst({
      where: { id, schoolId },
      include: {
        items: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!feeSchedule) {
      return res.status(404).json({ error: 'Fee schedule not found' });
    }

    const itemPayload = Array.isArray(items) ? items : [];
    const validItems = itemPayload.map((item, index) => normalizeFeeScheduleItemInput(item, index)).filter(Boolean) as Array<{
      name: string;
      amount: number;
      description: string | null;
      isRequired: boolean;
      sortOrder: number;
    }>;

    const updateData: any = {};

    if (name !== undefined) updateData.name = name;

    const nextTotal = resolveFeeScheduleAmount({
      amount,
      items: itemPayload,
      previousItems: feeSchedule.items ?? [],
    });

    if (nextTotal !== null) {
      updateData.amount = nextTotal;
    }

    if (termId !== undefined) {
      // Verify term belongs to school
      const term = await prisma.term.findFirst({
        where: { id: termId, academicYear: { schoolId } },
      });

      if (!term) {
        return res.status(404).json({ error: 'Term not found' });
      }

      updateData.termId = termId;
    }

    if (classId !== undefined) {
      if (classId) {
        // Verify class belongs to school
        const classExists = await prisma.class.findFirst({
          where: { id: classId, schoolId },
        });

        if (!classExists) {
          return res.status(404).json({ error: 'Class not found' });
        }
      }

      updateData.classId = classId || null;
    }

    const updated = await prisma.$transaction(async (transaction) => {
      if (Array.isArray(items)) {
        await transaction.feeScheduleItem.deleteMany({
          where: { feeScheduleId: id, schoolId },
        });

        if (validItems.length > 0) {
          await transaction.feeScheduleItem.createMany({
            data: validItems.map((item) => ({
              schoolId,
              feeScheduleId: id,
              name: item.name,
              amount: item.amount,
              description: item.description,
              isRequired: item.isRequired,
              sortOrder: item.sortOrder,
            })),
          });
        }
      }

      return transaction.feeSchedule.update({
        where: { id },
        data: updateData,
      });
    });

    const refreshedSchedule = await prisma.feeSchedule.findUnique({
      where: { id },
      include: {
        term: { include: { academicYear: true } },
        class: true,
        items: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    res.json({ success: true, feeSchedule: refreshedSchedule });
  } catch (error) {
    console.error('Error updating fee schedule:', error);
    res.status(500).json({ error: 'Failed to update fee schedule' });
  }
});

// DELETE /api/admin/fees/schedules/:id - Delete fee schedule
router.delete('/fees/schedules/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;

    // Verify fee schedule belongs to school
    const feeSchedule = await prisma.feeSchedule.findFirst({
      where: { id, schoolId },
    });

    if (!feeSchedule) {
      return res.status(404).json({ error: 'Fee schedule not found' });
    }

    // Check if schedule has invoices
    const invoiceCount = await prisma.invoice.count({
      where: { feeScheduleId: id },
    });

    if (invoiceCount > 0) {
      return res.status(400).json({
        error: `Cannot delete fee schedule with ${invoiceCount} invoice(s). Delete invoices first.`,
      });
    }

    await prisma.feeSchedule.delete({ where: { id } });

    res.json({ success: true, message: 'Fee schedule deleted' });
  } catch (error) {
    console.error('Error deleting fee schedule:', error);
    res.status(500).json({ error: 'Failed to delete fee schedule' });
  }
});

// GET /api/admin/fees/schedules/:id/items - List fee schedule items
router.get('/fees/schedules/:id/items', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;

    const feeSchedule = await prisma.feeSchedule.findFirst({
      where: { id, schoolId },
      select: { id: true },
    });

    if (!feeSchedule) {
      return res.status(404).json({ error: 'Fee schedule not found' });
    }

    const items = await prisma.feeScheduleItem.findMany({
      where: { feeScheduleId: id, schoolId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    res.json({ success: true, items });
  } catch (error) {
    console.error('Error fetching fee schedule items:', error);
    res.status(500).json({ error: 'Failed to fetch fee schedule items' });
  }
});

// POST /api/admin/fees/schedules/:id/items - Add a fee item to a fee schedule
router.post('/fees/schedules/:id/items', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;
    const { name, amount, isRequired, description, sortOrder } = req.body;

    if (!name || amount === undefined) {
      return res.status(400).json({ error: 'Missing required fields: name, amount' });
    }

    const feeSchedule = await prisma.feeSchedule.findFirst({
      where: { id, schoolId },
      select: { id: true },
    });

    if (!feeSchedule) {
      return res.status(404).json({ error: 'Fee schedule not found' });
    }

    const amountInCents = Math.round(parseFloat(String(amount)) * 100);
    if (amountInCents < 0) {
      return res.status(400).json({ error: 'Amount cannot be negative' });
    }

    const item = await prisma.feeScheduleItem.create({
      data: {
        schoolId,
        feeScheduleId: id,
        name: String(name).trim(),
        amount: amountInCents,
        isRequired: isRequired !== false,
        description: description ? String(description).trim() : null,
        sortOrder: sortOrder !== undefined ? Number(sortOrder) : 0,
      },
    });

    await syncFeeScheduleAmount(id, schoolId);

    res.json({ success: true, item });
  } catch (error) {
    console.error('Error creating fee schedule item:', error);
    res.status(500).json({ error: 'Failed to create fee schedule item' });
  }
});

// PATCH /api/admin/fees/schedules/items/:itemId - Update a fee item
router.patch('/fees/schedules/items/:itemId', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { itemId } = req.params;
    const { name, amount, isRequired, description, sortOrder } = req.body;

    const existingItem = await prisma.feeScheduleItem.findFirst({
      where: { id: itemId, schoolId },
    });

    if (!existingItem) {
      return res.status(404).json({ error: 'Fee schedule item not found' });
    }

    const updateData: any = {};

    if (name !== undefined) updateData.name = String(name).trim();
    if (amount !== undefined) updateData.amount = Math.round(parseFloat(String(amount)) * 100);
    if (isRequired !== undefined) updateData.isRequired = Boolean(isRequired);
    if (description !== undefined) updateData.description = description ? String(description).trim() : null;
    if (sortOrder !== undefined) updateData.sortOrder = Number(sortOrder);

    const updatedItem = await prisma.feeScheduleItem.update({
      where: { id: itemId },
      data: updateData,
    });

    await syncFeeScheduleAmount(existingItem.feeScheduleId, schoolId);

    res.json({ success: true, item: updatedItem });
  } catch (error) {
    console.error('Error updating fee schedule item:', error);
    res.status(500).json({ error: 'Failed to update fee schedule item' });
  }
});

// DELETE /api/admin/fees/schedules/items/:itemId - Delete a fee item
router.delete('/fees/schedules/items/:itemId', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { itemId } = req.params;

    const existingItem = await prisma.feeScheduleItem.findFirst({
      where: { id: itemId, schoolId },
    });

    if (!existingItem) {
      return res.status(404).json({ error: 'Fee schedule item not found' });
    }

    const invoiceItemCount = await prisma.invoiceItem.count({
      where: { feeScheduleItemId: itemId },
    });

    if (invoiceItemCount > 0) {
      return res.status(400).json({
        error: `Cannot delete fee item because it is already used in ${invoiceItemCount} invoice item(s).`,
      });
    }

    await prisma.feeScheduleItem.delete({ where: { id: itemId } });

    await syncFeeScheduleAmount(existingItem.feeScheduleId, schoolId);

    res.json({ success: true, message: 'Fee schedule item deleted' });
  } catch (error) {
    console.error('Error deleting fee schedule item:', error);
    res.status(500).json({ error: 'Failed to delete fee schedule item' });
  }
});

// GET /api/admin/fees/students/:studentId/adjustments - List student fee adjustments
router.get('/fees/students/:studentId/adjustments', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { studentId } = req.params;

    const pupil = await prisma.pupil.findFirst({
      where: { id: studentId, schoolId },
      select: { id: true },
    });

    if (!pupil) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const adjustments = await prisma.studentFeeAdjustment.findMany({
      where: { schoolId, studentId },
      orderBy: { createdAt: 'desc' },
      include: {
        feeScheduleItem: true,
        invoice: true,
      },
    });

    res.json({ success: true, adjustments });
  } catch (error) {
    console.error('Error fetching student fee adjustments:', error);
    res.status(500).json({ error: 'Failed to fetch student fee adjustments' });
  }
});

// POST /api/admin/fees/students/:studentId/adjustments - Create a student fee adjustment
router.post('/fees/students/:studentId/adjustments', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { studentId } = req.params;
    const { invoiceId, feeScheduleItemId, adjustmentType, amount, percentage, reason, status, approvedBy } = req.body;

    const pupil = await prisma.pupil.findFirst({
      where: { id: studentId, schoolId },
      select: { id: true },
    });

    if (!pupil) {
      return res.status(404).json({ error: 'Student not found' });
    }

    if (!adjustmentType) {
      return res.status(400).json({ error: 'Adjustment type is required' });
    }

    if ((amount === undefined) === (percentage === undefined)) {
      return res.status(400).json({ error: 'Either amount or percentage is required' });
    }

    if (amount !== undefined && (!Number.isFinite(Number(amount)) || Number(amount) < 0)) {
      return res.status(400).json({ error: 'Adjustment amount must be a non-negative number' });
    }

    if (percentage !== undefined && (!Number.isFinite(Number(percentage)) || Number(percentage) < 0 || Number(percentage) > 100)) {
      return res.status(400).json({ error: 'Adjustment percentage must be between 0 and 100' });
    }

    if (invoiceId) {
      const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, schoolId },
        select: { id: true },
      });
      if (!invoice) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
    }

    if (feeScheduleItemId) {
      const feeItem = await prisma.feeScheduleItem.findFirst({
        where: { id: feeScheduleItemId, schoolId },
        select: { id: true },
      });
      if (!feeItem) {
        return res.status(404).json({ error: 'Fee item not found' });
      }
    }

    const adjustment = await prisma.studentFeeAdjustment.create({
      data: {
        schoolId,
        studentId,
        invoiceId: invoiceId || null,
        feeScheduleItemId: feeScheduleItemId || null,
        adjustmentType,
        amount: amount !== undefined ? Math.round(parseFloat(String(amount)) * 100) : null,
        percentage: percentage !== undefined ? Number(percentage) : null,
        reason: reason ? String(reason).trim() : null,
        status: status || 'ACTIVE',
        approvedBy: approvedBy ? String(approvedBy).trim() : null,
      },
    });

    if (invoiceId) {
      const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, schoolId, pupilId: studentId },
        include: { items: true },
      });

      if (invoice) {
        const baseAmount = feeScheduleItemId
          ? invoice.items.find((item) => item.feeScheduleItemId === feeScheduleItemId)?.amount ?? 0
          : invoice.amountDue;
        const reduction = amount !== undefined
          ? Math.round(Number(amount) * 100)
          : Math.round((baseAmount * Number(percentage)) / 100);
        const nextAmountDue = Math.max(0, invoice.amountDue - reduction);

        if (feeScheduleItemId) {
          const item = invoice.items.find((entry) => entry.feeScheduleItemId === feeScheduleItemId);
          if (item) {
            await prisma.invoiceItem.update({
              where: { id: item.id },
              data: { amount: Math.max(0, item.amount - reduction) },
            });
          }
        }

        await prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            amountDue: nextAmountDue,
            status: invoice.amountPaid >= nextAmountDue ? 'PAID' : invoice.amountPaid > 0 ? 'PART_PAID' : invoice.status,
          },
        });
      }
    }

    res.json({ success: true, adjustment });
  } catch (error) {
    console.error('Error creating student fee adjustment:', error);
    res.status(500).json({ error: 'Failed to create student fee adjustment' });
  }
});

// PATCH /api/admin/fees/students/adjustments/:id - Update student fee adjustment
router.patch('/fees/students/adjustments/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;
    const { amount, percentage, reason, status, approvedBy } = req.body;

    const adjustment = await prisma.studentFeeAdjustment.findFirst({
      where: { id, schoolId },
    });

    if (!adjustment) {
      return res.status(404).json({ error: 'Adjustment not found' });
    }

    const updateData: any = {};
    if (amount !== undefined) updateData.amount = Math.round(parseFloat(String(amount)) * 100);
    if (percentage !== undefined) updateData.percentage = Number(percentage);
    if (reason !== undefined) updateData.reason = reason ? String(reason).trim() : null;
    if (status !== undefined) updateData.status = status;
    if (approvedBy !== undefined) updateData.approvedBy = approvedBy ? String(approvedBy).trim() : null;

    const updatedAdjustment = await prisma.studentFeeAdjustment.update({
      where: { id },
      data: updateData,
    });

    res.json({ success: true, adjustment: updatedAdjustment });
  } catch (error) {
    console.error('Error updating student fee adjustment:', error);
    res.status(500).json({ error: 'Failed to update student fee adjustment' });
  }
});

// DELETE /api/admin/fees/students/adjustments/:id - Delete student fee adjustment
router.delete('/fees/students/adjustments/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;

    const adjustment = await prisma.studentFeeAdjustment.findFirst({
      where: { id, schoolId },
    });

    if (!adjustment) {
      return res.status(404).json({ error: 'Adjustment not found' });
    }

    await prisma.studentFeeAdjustment.delete({ where: { id } });

    res.json({ success: true, message: 'Adjustment deleted' });
  } catch (error) {
    console.error('Error deleting student fee adjustment:', error);
    res.status(500).json({ error: 'Failed to delete student fee adjustment' });
  }
});

// POST /api/admin/fees/invoices/issue-bills - Create invoices for a term
router.post('/fees/invoices/issue-bills', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { termId } = req.body;
    const approvedForBulkWhatsApp = req.body?.bulkApproval === true;
    if (!termId) {
      return res.status(400).json({ error: 'Term ID required' });
    }

    // Get all fee schedules for this term
    const feeSchedules = await prisma.feeSchedule.findMany({
      where: { termId, schoolId },
      include: { 
        class: true,
        term: true,
      },
    });

    if (feeSchedules.length === 0) {
      return res.status(400).json({ error: 'No fee schedules found for this term' });
    }

    const eligiblePupilsBySchedule = new Map<string, any[]>();
    const activePupilWhere = buildActiveStudentWhere(schoolId);
    let whatsappRecipientCount = 0;

    for (const schedule of feeSchedules) {
      const eligiblePupils = await prisma.pupil.findMany({
        where: schedule.classId
          ? { ...activePupilWhere, classId: schedule.classId }
          : activePupilWhere,
        include: { guardians: { include: { guardian: true } }, class: true },
      });
      eligiblePupilsBySchedule.set(schedule.id, eligiblePupils);
      whatsappRecipientCount += eligiblePupils.reduce(
        (count, pupil) => count + pupil.guardians.filter((link: any) => Boolean(link.guardian.whatsapp || link.guardian.phone)).length,
        0,
      );
    }

    if (whatsappRecipientCount > 0) {
      const policy = await readSchoolWhatsAppPolicy(prisma, schoolId);
      const evaluation = evaluateSchoolWhatsAppSend(policy, {
        recipientCount: whatsappRecipientCount,
        approvedForBulk: approvedForBulkWhatsApp,
      });
      if (!evaluation.allowed) {
        return res.status(429).json({ error: evaluation.reason || 'WhatsApp sending is currently unavailable' });
      }
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true, logoUrl: true, currency: true },
    });

    const communicationService = createCommunicationService();
    let createdCount = 0;
    let notificationsCount = 0;
    let whatsappSent = 0;
    let whatsappFailed = 0;
    let queued = 0;
    const errors: string[] = [];

    // For each fee schedule, create invoices for eligible pupils
    for (const schedule of feeSchedules) {
      const eligiblePupils = eligiblePupilsBySchedule.get(schedule.id) || [];

      // Create invoices for each pupil (skip if already exists)
      for (const pupil of eligiblePupils) {
        try {
          // Check if invoice already exists
          const existingInvoice = await prisma.invoice.findFirst({
            where: {
              pupilId: pupil.id,
              feeScheduleId: schedule.id,
            },
          });

          if (existingInvoice) {
            continue; // Skip if already exists
          }

          // Generate unique invoice number
          const invoiceNo = `INV-${Date.now()}-${Math.random().toString(36).substring(7).toUpperCase()}`;

          const initialInvoiceTotal = schedule.amount;

          // Create invoice
          const invoice = await prisma.invoice.create({
            data: {
              schoolId,
              pupilId: pupil.id,
              feeScheduleId: schedule.id,
              invoiceNo,
              amountDue: initialInvoiceTotal,
              status: 'SENT', // Mark as sent when created
              dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
            },
          });

          const breakdown = await buildItemizedInvoiceBreakdown({
            schoolId,
            scheduleId: schedule.id,
            pupilId: pupil.id,
            invoiceId: invoice.id,
            fallbackName: schedule.name,
            fallbackAmount: initialInvoiceTotal,
          });

          if (breakdown.items.length > 0) {
            await prisma.invoiceItem.createMany({
              data: breakdown.items,
            });
          }

          if (breakdown.amountDue !== initialInvoiceTotal) {
            await prisma.invoice.update({
              where: { id: invoice.id },
              data: { amountDue: breakdown.amountDue },
            });
          }

          createdCount++;

          // Send notifications to guardians via both channels
          const pupilName = `${pupil.firstName} ${pupil.lastName}`;
          const className = pupil.class?.name || 'Unknown Class';
          const notificationCurrency = school?.currency || 'NGN';
          const amount = (breakdown.amountDue / 100).toFixed(2);
          const itemSummary = formatFeeItemsForMessage(
            breakdown.items.map((item) => ({ name: item.name, amount: item.amount })),
            notificationCurrency,
          );

          for (const guardianPupil of pupil.guardians) {
            const guardian = guardianPupil.guardian;
            const message = `Dear ${guardian.firstName}, an invoice for ${school?.name || 'School'} fees has been issued for ${pupilName} (${className}).\n\nFee items:\n${itemSummary}\n\nTotal due: ${notificationCurrency} ${amount}. Please contact the school for payment details.`;
            const whatsappAddress = guardian.whatsapp || guardian.phone;

            const recipients = [
              ...(whatsappAddress ? [{ channel: 'WHATSAPP' as const, address: whatsappAddress, name: guardian.firstName }] : []),
              ...(guardian.email ? [{ channel: 'EMAIL' as const, address: guardian.email, name: guardian.firstName }] : []),
            ];

            if (recipients.length > 0) {
              try {
                const dispatchResult = await communicationService.dispatch({
                  event: 'FeeInvoiceCreated',
                  schoolId,
                  recipients,
                  template: 'Invoice',
                  body: message,
                  subject: 'Fee Invoice Issued',
                  data: {
                    studentName: pupilName,
                    className,
                    amount,
                    balance: amount,
                    items: itemSummary,
                    schoolName: school?.name || 'School',
                    recipientName: guardian.firstName,
                  },
                  metadata: {
                    studentName: pupilName,
                    className,
                    amount,
                    balance: amount,
                    schoolName: school?.name || 'School',
                    termName: schedule.term?.name || 'Current Term',
                    paidAmount: '0.00',
                    outstanding: amount,
                    items: itemSummary,
                    logoUrl: school?.logoUrl ?? undefined,
                    invoiceId: invoice.id,
                    invoiceNo,
                    guardianId: guardian.id,
                  },
                });

                for (const delivery of dispatchResult.deliveries) {
                  const status = delivery.status === 'SENT' ? 'SENT' : delivery.status === 'QUEUED' ? 'PENDING' : 'FAILED';
                  await prisma.notification.create({
                    data: {
                      schoolId,
                      guardianId: guardian.id,
                      type: 'ISSUE_BILLS',
                      title: 'Fee Invoice Issued',
                      body: truncateNotificationBody(message),
                      channel: delivery.channel,
                      status,
                      sentAt: delivery.status === 'SENT' || delivery.status === 'QUEUED' ? new Date() : undefined,
                      failureReason: delivery.error,
                      relatedId: invoice.id,
                      reference: invoiceNo,
                    },
                  });

                  if (status !== 'FAILED') {
                    notificationsCount++;
                  }
                  if (delivery.channel === 'WHATSAPP') {
                    if (status === 'FAILED') whatsappFailed++;
                    else if (status === 'PENDING') queued++;
                    else whatsappSent++;
                  }
                }
              } catch (err) {
                errors.push(`Failed to dispatch communication for guardian ${guardian.id}`);
                await prisma.notification.create({
                  data: {
                    schoolId,
                    guardianId: guardian.id,
                    type: 'ISSUE_BILLS',
                    title: 'Fee Invoice Issued',
                    body: truncateNotificationBody(message),
                    channel: 'WHATSAPP',
                    status: 'FAILED',
                    failureReason: err instanceof Error ? err.message : String(err),
                    relatedId: invoice.id,
                    reference: invoiceNo,
                  },
                });
              }
            }
          }
        } catch (err) {
          errors.push(`Failed to create invoice for pupil ${pupil.id}: ${err}`);
        }
      }
    }

    res.json({
      success: true,
      message: `Created ${createdCount} invoices for term`,
      created: createdCount,
      notificationsSent: notificationsCount,
      whatsappSent,
      whatsappFailed,
      queued,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Error issuing bills:', error);
    res.status(500).json({ error: 'Failed to issue bills' });
  }
});

// POST /api/admin/fees/invoices/send-reminders - Send reminders for outstanding invoices
router.post('/fees/invoices/send-reminders', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const invoiceId = typeof req.body?.invoiceId === 'string' ? req.body.invoiceId.trim() : '';

    // Find invoices that may need reminders: sent, part-paid, or overdue
    const invoices = await prisma.invoice.findMany({
      where: {
        schoolId,
        status: { in: ['SENT', 'OVERDUE', 'PART_PAID'] },
        pupil: buildActiveStudentWhere(schoolId),
        ...(invoiceId ? { id: invoiceId } : {}),
      },
      include: {
        pupil: {
          include: {
            guardians: { include: { guardian: true } },
            class: true,
          },
        },
        feeSchedule: { include: { term: true } },
        items: {
          include: {
            allocations: { select: { amount: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (invoiceId && invoices.length === 0) {
      return res.status(404).json({ error: 'Invoice is not eligible for a reminder or was not found.' });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        name: true,
        logoUrl: true,
        currency: true,
      },
    });

    const communicationService = createCommunicationService();

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    let sentCount = 0;
    let skippedCount = 0;
    let processedGuardians = 0;
    const errors: string[] = [];

    // Send reminders to guardians
    for (const invoice of invoices) {
      const pupilName = `${invoice.pupil.firstName} ${invoice.pupil.lastName}`;
      const className = invoice.pupil.class?.name || 'Unknown Class';
      const amount = (invoice.amountDue / 100).toFixed(2);
      const outstanding = Math.max(0, invoice.amountDue - invoice.amountPaid) / 100;
      const itemSummary = formatFeeItemsForMessage(
        invoice.items.map((item) => {
          const amountPaid = item.allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
          return {
            name: item.name,
            amount: item.amount * item.quantity,
            amountPaid,
            amountOutstanding: Math.max(0, item.amount * item.quantity - amountPaid),
          };
        }),
        school.currency,
      );

      if (outstanding <= 0) {
        continue;
      }

      for (const guardianPupil of invoice.pupil.guardians) {
        processedGuardians++;
        const guardian = guardianPupil.guardian;
        const message = `Dear ${guardian.firstName}, this is a reminder that fee payment for ${pupilName} (${className}) is outstanding.\n\nFee items:\n${itemSummary}\n\nInvoice balance: ${school.currency} ${outstanding.toFixed(2)}. Please make payment at your earliest convenience. Thank you.`;
        const whatsappAddress = guardian.whatsapp || guardian.phone;
        const canSendWhatsApp = Boolean(whatsappAddress);
        const canSendEmail = Boolean(guardian.email);

        if (!canSendWhatsApp && !canSendEmail) {
          skippedCount++;
          continue;
        }

        const recipients = [
          ...(canSendWhatsApp ? [{ channel: 'WHATSAPP' as const, address: whatsappAddress!, name: guardian.firstName }] : []),
          ...(guardian.email ? [{ channel: 'EMAIL' as const, address: guardian.email, name: guardian.firstName }] : []),
        ];

        if (recipients.length > 0) {
          try {
            const dispatchResult = await communicationService.dispatch({
              event: 'FeeInvoiceCreated',
              schoolId,
              recipients,
              template: 'FeeReminder',
              body: message,
              subject: 'Fee Payment Reminder',
              data: {
                studentName: pupilName,
                className,
                amount,
                balance: outstanding.toFixed(2),
                items: itemSummary,
                schoolName: school.name,
                recipientName: guardian.firstName,
              },
              metadata: {
                studentName: pupilName,
                className,
                amount,
                balance: outstanding.toFixed(2),
                schoolName: school.name,
                termName: invoice.feeSchedule?.term?.name || 'Current Term',
                paidAmount: (invoice.amountPaid / 100).toFixed(2),
                outstanding: outstanding.toFixed(2),
                items: itemSummary,
                logoUrl: school.logoUrl ?? undefined,
                invoiceId: invoice.id,
                invoiceNo: invoice.invoiceNo,
                guardianId: guardian.id,
              },
            });

            for (const delivery of dispatchResult.deliveries) {
              const status = delivery.status === 'SENT' ? 'SENT' : delivery.status === 'QUEUED' ? 'PENDING' : 'FAILED';
              await prisma.notification.create({
                data: {
                  schoolId,
                  guardianId: guardian.id,
                  type: 'SEND_REMINDER',
                  title: 'Fee Payment Reminder',
                  body: truncateNotificationBody(message),
                  channel: delivery.channel,
                  status,
                  sentAt: delivery.status === 'SENT' || delivery.status === 'QUEUED' ? new Date() : undefined,
                  failureReason: delivery.error,
                  relatedId: invoice.id,
                  reference: invoice.invoiceNo,
                },
              });

              if (status !== 'FAILED') {
                sentCount++;
              }
            }
          } catch (err) {
            errors.push(`Failed to dispatch reminder communication for guardian ${guardian.id}`);
            await prisma.notification.create({
              data: {
                schoolId,
                guardianId: guardian.id,
                type: 'SEND_REMINDER',
                title: 'Fee Payment Reminder',
                body: truncateNotificationBody(message),
                channel: 'WHATSAPP',
                status: 'FAILED',
                failureReason: err instanceof Error ? err.message : String(err),
                relatedId: invoice.id,
                reference: invoice.invoiceNo,
              },
            });
          }
        }
      }
    }

    res.json({
      success: true,
      message: `Sent ${sentCount} reminders`,
      sent: sentCount,
      skipped: skippedCount,
      totalInvoices: invoices.length,
      totalGuardians: processedGuardians,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error sending reminders:', error);
    res.status(500).json({ error: message || 'Failed to send reminders' });
  }
});

// GET /api/admin/invoices/:id - Get invoice details with all related data
router.get('/invoices/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;

    // Fetch invoice with all related data
    const invoice = await prisma.invoice.findFirst({
      where: { id, schoolId },
      include: {
        pupil: {
          include: {
            class: true,
            guardians: { include: { guardian: true } },
          },
        },
        feeSchedule: {
          include: {
            term: { include: { academicYear: true } },
          },
        },
        payments: {
          orderBy: { paidAt: 'desc' },
        },
        items: {
          include: {
            allocations: { select: { amount: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        adjustments: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Fetch school details for invoice
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        name: true,
        currency: true,
        address: true,
        city: true,
        phone: true,
        email: true,
        logoUrl: true,
        principalName: true,
        principalSignatureUrl: true,
        stampUrl: true,
        manualPaymentAccountName: true,
        manualPaymentAccountNumber: true,
        manualPaymentBankName: true,
        paymentAccounts: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    // Map invoice data
    const mappedInvoice = {
      ...invoice,
      dueDate: invoice.dueDate ? invoice.dueDate.toISOString() : null,
      createdAt: invoice.createdAt.toISOString(),
      updatedAt: invoice.updatedAt.toISOString(),
      payments: invoice.payments.map((p) => ({
        ...p,
        paidAt: p.paidAt.toISOString(),
      })),
      items: invoice.items.map((item) => {
        const amountPaid = item.allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
        return {
          id: item.id,
          name: item.name,
          amount: item.amount,
          quantity: item.quantity,
          description: item.description,
          feeScheduleItemId: item.feeScheduleItemId,
          amountPaid,
          amountOutstanding: Math.max(0, item.amount * item.quantity - amountPaid),
        };
      }),
      adjustments: invoice.adjustments.map((adjustment) => ({
        id: adjustment.id,
        schoolId: adjustment.schoolId,
        studentId: adjustment.studentId,
        invoiceId: adjustment.invoiceId,
        feeScheduleItemId: adjustment.feeScheduleItemId,
        adjustmentType: adjustment.adjustmentType,
        amount: adjustment.amount,
        percentage: adjustment.percentage,
        reason: adjustment.reason,
        status: adjustment.status,
        approvedBy: adjustment.approvedBy,
        createdAt: adjustment.createdAt.toISOString(),
      })),
    };

    const subtotal = mappedInvoice.items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const totalAdjustments = mappedInvoice.adjustments.reduce((sum, adjustment) => {
      if (adjustment.amount !== null && adjustment.amount !== undefined) {
        return sum + Number(adjustment.amount || 0);
      }
      if (adjustment.percentage !== null && adjustment.percentage !== undefined) {
        return sum + Math.round((subtotal * Number(adjustment.percentage || 0)) / 100);
      }
      return sum;
    }, 0);

    res.json({
      invoice: mappedInvoice,
      school,
      subtotal,
      totalAdjustments,
      outstanding: Math.max(0, invoice.amountDue - invoice.amountPaid),
    });
  } catch (error) {
    console.error('Error fetching invoice:', error);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// POST /api/admin/invoices/:id/additional-charges - Add an auditable outstanding charge to an invoice
router.post('/invoices/:id/additional-charges', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const name = String(req.body?.name ?? '').trim();
    const reason = String(req.body?.reason ?? '').trim();
    const rawAmount = req.body?.amount;
    if (name.length < 2 || name.length > 120) return res.status(400).json({ error: 'Charge name must be between 2 and 120 characters.' });
    if (reason.length < 3 || reason.length > 500) return res.status(400).json({ error: 'Provide a reason between 3 and 500 characters.' });

    const amountMajor = typeof rawAmount === 'number' ? rawAmount : Number(rawAmount);
    const amountMinor = Math.round(amountMajor * 100);
    if (!Number.isFinite(amountMajor) || amountMinor <= 0 || !Number.isSafeInteger(amountMinor) || amountMinor > 2_147_483_647) {
      return res.status(400).json({ error: 'Charge amount must be greater than zero and within the supported currency range.' });
    }

    const userId = await resolveUserId(req);
    const invoice = await prisma.$transaction(async (tx) => {
      const current = await tx.invoice.findFirst({
        where: { id: req.params.id, schoolId },
        select: { id: true, amountDue: true, amountPaid: true, status: true, dueDate: true },
      });
      if (!current) throw Object.assign(new Error('Invoice not found.'), { statusCode: 404 });
      if (current.amountDue + amountMinor > 2_147_483_647) throw Object.assign(new Error('The updated invoice total exceeds the supported range.'), { statusCode: 400 });

      await tx.invoiceItem.create({
        data: {
          invoiceId: current.id,
          name,
          amount: amountMinor,
          quantity: 1,
          description: `Additional charge: ${reason}`,
        },
      });

      const nextAmountDue = current.amountDue + amountMinor;
      let nextStatus = current.status;
      if (current.status !== 'DRAFT') {
        nextStatus = current.amountPaid >= nextAmountDue
          ? 'PAID'
          : current.dueDate && current.dueDate < new Date()
            ? 'OVERDUE'
            : current.amountPaid > 0
              ? 'PART_PAID'
              : 'SENT';
      }

      return tx.invoice.update({
        where: { id: current.id },
        data: { amountDue: { increment: amountMinor }, status: nextStatus },
        select: { id: true, amountDue: true, amountPaid: true, status: true },
      });
    });

    res.status(201).json({ success: true, invoice });
    void recordActivity({
      event: 'INVOICE_ADDITIONAL_CHARGE_ADDED',
      details: `Added ${name} (${amountMinor} minor units) to invoice ${invoice.id}. Reason: ${reason}`,
      userId: userId || undefined,
      schoolId,
    }).catch((error) => console.warn('Failed to audit invoice additional charge:', error));
  } catch (error) {
    const statusCode = Number((error as { statusCode?: number })?.statusCode) || 500;
    if (statusCode >= 500) console.error('Error adding invoice additional charge:', error);
    return res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Failed to add invoice charge.' });
  }
});

// GET /api/admin/invoices/:id/pdf - Download invoice as PDF
router.get('/invoices/:id/pdf', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;

    // Fetch invoice with all related data
    const invoice = await prisma.invoice.findFirst({
      where: { id, schoolId },
      include: {
        pupil: {
          include: {
            class: true,
            guardians: { include: { guardian: true } },
          },
        },
        feeSchedule: {
          include: {
            term: { include: { academicYear: true } },
          },
        },
        payments: {
          orderBy: { paidAt: 'desc' },
        },
      },
    });

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Fetch school details
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        name: true,
        currency: true,
        address: true,
        city: true,
        phone: true,
        email: true,
        logoUrl: true,
        principalName: true,
        principalSignatureUrl: true,
        stampUrl: true,
        manualPaymentAccountName: true,
        manualPaymentAccountNumber: true,
        manualPaymentBankName: true,
      },
    });

    // Format currency
    const formatAmount = (amount: number, currency: string) => {
      return `${currency} ${(amount / 100).toFixed(2)}`;
    };

    // Generate HTML invoice
    const pupilName = `${invoice.pupil.firstName} ${invoice.pupil.lastName}`;
    const className = invoice.pupil.class
      ? `${invoice.pupil.class.name}${invoice.pupil.class.arm ? ` ${invoice.pupil.class.arm}` : ""}`
      : "Unassigned";
    const termName = invoice.feeSchedule?.term?.name || "Unknown Term";
    const academicYear = invoice.feeSchedule?.term?.academicYear?.name || "";
    const currency = school?.currency || "NGN";
    const outstanding = Math.max(0, invoice.amountDue - invoice.amountPaid);

    const paymentRows = invoice.payments
      .map(
        (p) => `
        <tr>
          <td>${new Date(p.paidAt).toLocaleDateString()}</td>
          <td>${p.method.replace(/_/g, " ")}</td>
          <td>${p.reference || "—"}</td>
          <td style="text-align: right;">${formatAmount(p.amount, currency)}</td>
        </tr>
      `
      )
      .join("");

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
          .container { max-width: 800px; margin: 0 auto; padding: 40px 20px; }
          .header { display: flex; justify-content: space-between; margin-bottom: 40px; border-bottom: 2px solid #ddd; padding-bottom: 20px; }
          .school-info h2 { font-size: 24px; margin-bottom: 10px; }
          .school-info p { font-size: 12px; color: #666; }
          .invoice-meta { text-align: right; }
          .invoice-meta p { font-size: 13px; margin: 5px 0; }
          .bill-to { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-bottom: 40px; }
          .bill-to-section h4 { font-size: 11px; text-transform: uppercase; color: #999; margin-bottom: 5px; font-weight: bold; }
          .bill-to-section p { margin: 3px 0; font-size: 13px; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
          thead { background: #f5f5f5; }
          th { padding: 10px; text-align: left; font-weight: bold; font-size: 13px; border-bottom: 2px solid #ddd; }
          td { padding: 10px; font-size: 13px; border-bottom: 1px solid #eee; }
          .summary-table { width: 100%; margin-bottom: 30px; }
          .summary-table td { padding: 8px 10px; font-size: 13px; }
          .summary-table .label { text-align: right; padding-right: 20px; font-weight: bold; }
          .summary-table .amount { text-align: right; font-weight: bold; }
          .outstanding { color: #d32f2f; }
          .paid { color: #388e3c; }
          .payment-instructions { background: #e3f2fd; padding: 15px; border-radius: 4px; margin-bottom: 20px; font-size: 13px; }
          .payment-instructions h4 { font-weight: bold; margin-bottom: 8px; }
          .payment-instructions p { margin: 4px 0; }
          .footer { text-align: center; font-size: 11px; color: #999; border-top: 1px solid #ddd; padding-top: 20px; margin-top: 30px; }
          .status-badge { display: inline-block; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 11px; }
          .status-paid { background: #c8e6c9; color: #1b5e20; }
          .status-overdue { background: #ffcdd2; color: #b71c1c; }
          .status-part-paid { background: #fff3e0; color: #e65100; }
          .status-draft { background: #f5f5f5; color: #424242; }
          @media print {
            body { margin: 0; padding: 0; }
            .container { padding: 20px; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <!-- Header -->
          <div class="header">
            <div class="school-info">
              <h2>${school?.name || "School"}</h2>
              ${school?.address ? `<p>${school.address}${school.city ? `, ${school.city}` : ""}</p>` : ""}
              ${school?.email ? `<p>${school.email}</p>` : ""}
              ${school?.phone ? `<p>${school.phone}</p>` : ""}
            </div>
            <div class="invoice-meta">
              <div>
                <p><strong>Invoice #:</strong> ${invoice.invoiceNo}</p>
                <p><strong>Date:</strong> ${new Date(invoice.createdAt).toLocaleDateString()}</p>
                ${invoice.dueDate ? `<p><strong>Due Date:</strong> ${new Date(invoice.dueDate).toLocaleDateString()}</p>` : ""}
                <p style="margin-top: 10px;"><span class="status-badge status-${invoice.status.toLowerCase().replace("_", "-")}">${invoice.status}</span></p>
              </div>
            </div>
          </div>

          <!-- Bill To -->
          <div class="bill-to">
            <div class="bill-to-section">
              <h4>Bill To</h4>
              <p><strong>${pupilName}</strong></p>
              <p>${className}</p>
              <p>${termName}, ${academicYear}</p>
            </div>
          </div>

          <!-- Invoice Details -->
          <table>
            <thead>
              <tr>
                <th>Description</th>
                <th style="text-align: right;">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>${invoice.feeSchedule?.name || "Fee"}</td>
                <td style="text-align: right;">${formatAmount(invoice.amountDue, currency)}</td>
              </tr>
            </tbody>
          </table>

          <!-- Summary -->
          <table class="summary-table">
            <tr>
              <td class="label">Amount Due:</td>
              <td class="amount">${formatAmount(invoice.amountDue, currency)}</td>
            </tr>
            <tr>
              <td class="label">Amount Paid:</td>
              <td class="amount paid">${formatAmount(invoice.amountPaid, currency)}</td>
            </tr>
            ${outstanding > 0 ? `<tr>
              <td class="label">Outstanding Balance:</td>
              <td class="amount outstanding">${formatAmount(outstanding, currency)}</td>
            </tr>` : ""}
          </table>

          <!-- Payment History -->
          ${invoice.payments.length > 0 ? `
            <h4 style="margin-bottom: 15px;">Payment History</h4>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th style="text-align: right;">Amount</th>
                </tr>
              </thead>
              <tbody>
                ${paymentRows}
              </tbody>
            </table>
          ` : ""}

          <!-- Payment Instructions -->
          ${outstanding > 0 && school && (school.manualPaymentAccountName || school.manualPaymentAccountNumber) ? `
            <div class="payment-instructions">
              <h4>Payment Instructions</h4>
              ${school.manualPaymentAccountName ? `<p><strong>Account Name:</strong> ${school.manualPaymentAccountName}</p>` : ""}
              ${school.manualPaymentAccountNumber ? `<p><strong>Account Number:</strong> ${school.manualPaymentAccountNumber}</p>` : ""}
              ${school.manualPaymentBankName ? `<p><strong>Bank:</strong> ${school.manualPaymentBankName}</p>` : ""}
            </div>
          ` : ""}

          <!-- Footer -->
          <div class="footer">
            <p>This is an automated invoice generated by SchoolBase</p>
            <p>Please retain for your records</p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Set response headers for PDF download
    res.setHeader("Content-Type", "text/html; charset=UTF-8");
    res.setHeader("Content-Disposition", `attachment; filename="invoice-${invoice.invoiceNo}.html"`);
    res.send(htmlContent);
  } catch (error) {
    console.error('Error generating invoice PDF:', error);
    res.status(500).json({ error: 'Failed to generate invoice PDF' });
  }
});

// POST /api/admin/fees/payments/record - Record a payment against an invoice
router.post('/fees/payments/record', verifyAuth, requireAccountingAccess, requireSubscription, async (req: Request, res: Response) => {
  try {
    console.log('[/fees/payments/record] Request received');
    console.log('[/fees/payments/record] Cookies:', Object.keys(req.cookies || {}));
    console.log('[/fees/payments/record] Body:', req.body);
    
    const schoolId = (req as any).user?.schoolId as string | undefined;
    console.log('[/fees/payments/record] Resolved schoolId:', schoolId);
    
    if (!schoolId) {
      console.error('[/fees/payments/record] No schoolId resolved');
      return res.status(400).json({ error: 'School ID required' });
    }

    const { invoiceId, amount, method, reference, allocations, idempotencyKey } = req.body;
    const normalizedIdempotencyKey = normalizePaymentIdempotencyKey(idempotencyKey);

    if (idempotencyKey !== undefined && idempotencyKey !== null && normalizedIdempotencyKey === null) {
      return res.status(400).json({ error: 'Payment idempotency key is invalid' });
    }

    // Validate required fields
    if (!invoiceId || !amount || !method) {
      return res.status(400).json({ error: 'Invoice ID, amount, and payment method are required' });
    }

    // Fetch the invoice
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, schoolId },
      include: {
        pupil: {
          include: {
            class: true,
            guardians: { include: { guardian: true } },
          },
        },
        items: {
          include: {
            allocations: { select: { amount: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!invoice || !invoice.pupil) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const amountInCents = parsePositiveAmountMinor(amount);
    if (amountInCents === null) {
      return res.status(400).json({ error: 'Payment amount must be a valid positive amount' });
    }
    if (typeof method !== 'string' || !Object.values(PaymentMethod).includes(method as PaymentMethod)) {
      return res.status(400).json({ error: 'Payment method is invalid' });
    }

    const itemAllocations = Array.isArray(allocations)
      ? allocations.filter((allocation: any) => allocation && allocation.invoiceItemId && Number(allocation.amount) > 0)
      : [];

    if (normalizedIdempotencyKey) {
      const existingPayment = await prisma.payment.findFirst({
        where: {
          invoiceId,
          idempotencyKey: normalizedIdempotencyKey,
        },
        include: {
          allocations: true,
        },
      });

      if (existingPayment) {
        if (!matchesPaymentIdempotencyRequest({
          existing: existingPayment,
          requested: { amount: amountInCents, method, reference, idempotencyKey: normalizedIdempotencyKey, allocations: itemAllocations },
        })) {
          return res.status(409).json({
            error: 'Payment idempotency key already exists for a different payload. Please retry with the same payment data or use a new idempotency key.',
          });
        }

        return res.status(200).json({
          success: true,
          idempotent: true,
          message: 'Payment already recorded',
          payment: {
            id: existingPayment.id,
            amount: (existingPayment.amount / 100).toFixed(2),
            method: existingPayment.method,
            reference: existingPayment.reference,
            paidAt: existingPayment.paidAt,
          },
          invoice: {
            id: invoice.id,
            amountDue: (invoice.amountDue / 100).toFixed(2),
            amountPaid: (invoice.amountPaid / 100).toFixed(2),
            status: invoice.status,
          },
        });
      }
    }

    // Idempotent retries must be recognized before checking the now-updated invoice balance.
    const outstanding = invoice.amountDue - invoice.amountPaid;
    if (amountInCents > outstanding) {
      return res.status(400).json({ error: `Payment amount cannot exceed outstanding balance of ${(outstanding / 100).toFixed(2)}` });
    }

    const allocationRows: Array<{ invoiceItemId: string; amount: number }> = [];
    for (const allocation of itemAllocations) {
      const item = invoice.items.find((invoiceItem) => invoiceItem.id === String(allocation.invoiceItemId));
      if (!item) {
        return res.status(400).json({ error: 'Payment allocation contains an invalid invoice item' });
      }

      const allocationAmount = Math.round(Number(allocation.amount) * 100);
      const alreadyAllocated = item.allocations.reduce((sum, existing) => sum + existing.amount, 0);
      const itemBalance = Math.max(0, item.amount * item.quantity - alreadyAllocated);

      if (!Number.isFinite(allocationAmount) || allocationAmount <= 0 || allocationAmount > itemBalance) {
        return res.status(400).json({
          error: `Payment allocation for ${item.name} exceeds its remaining balance`,
        });
      }

      allocationRows.push({ invoiceItemId: item.id, amount: allocationAmount });
    }

    const allocatedTotal = allocationRows.reduce((sum, allocation) => sum + allocation.amount, 0);
    const allocationValidation = validateInvoicePaymentAllocation({
      paymentAmountMinor: amountInCents,
      allocatedAmountMinor: allocatedTotal,
      outstandingMinor: outstanding,
    });
    if (!allocationValidation.valid) {
      const message = allocationValidation.error === 'PAYMENT_EXCEEDS_BALANCE'
        ? `Payment amount cannot exceed outstanding balance of ${(outstanding / 100).toFixed(2)}`
        : allocationValidation.error === 'ALLOCATIONS_EXCEED_PAYMENT'
          ? 'Payment allocations cannot exceed the payment amount'
          : 'Payment amount must be a valid amount greater than zero';
      return res.status(400).json({ error: message });
    }

    const userId = await resolveUserId(req);
    const accountingRecorderId = userId ?? (await prisma.user.findFirst({
      where: {
        schoolId,
        role: { in: ['SCHOOL_ADMIN', 'BURSAR'] },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    }))?.id ?? null;
    const schoolCurrency = (await prisma.school.findUnique({
      where: { id: schoolId },
      select: { currency: true },
    }))?.currency ?? 'NGN';

    const { payment, updatedInvoice, committedAllocationRows } = await prisma.$transaction(async (transaction) => {
      const currentInvoice = await transaction.invoice.findFirst({
        where: { id: invoiceId, schoolId },
        include: {
          pupil: { select: { firstName: true, lastName: true } },
          items: {
            include: { allocations: { select: { amount: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      if (!currentInvoice) throw new Error('INVOICE_NOT_FOUND');

      const currentOutstanding = currentInvoice.amountDue - currentInvoice.amountPaid;
      if (amountInCents > currentOutstanding) throw new Error('PAYMENT_EXCEEDS_BALANCE');

      const committedAllocationRows: Array<{ invoiceItemId: string; amount: number }> = [];
      for (const allocation of itemAllocations) {
        const item = currentInvoice.items.find((invoiceItem) => invoiceItem.id === String(allocation.invoiceItemId));
        if (!item) throw new Error('INVALID_PAYMENT_ALLOCATION_ITEM');
        const allocationAmount = Math.round(Number(allocation.amount) * 100);
        const alreadyAllocated = item.allocations.reduce((sum, existing) => sum + existing.amount, 0);
        const itemBalance = Math.max(0, item.amount * item.quantity - alreadyAllocated);
        if (!Number.isSafeInteger(allocationAmount) || allocationAmount <= 0 || allocationAmount > itemBalance) {
          throw new Error('PAYMENT_ALLOCATION_EXCEEDS_ITEM_BALANCE');
        }
        committedAllocationRows.push({ invoiceItemId: item.id, amount: allocationAmount });
      }

      const committedAllocatedTotal = committedAllocationRows.reduce((sum, allocation) => sum + allocation.amount, 0);
      const committedAllocationValidation = validateInvoicePaymentAllocation({
        paymentAmountMinor: amountInCents,
        allocatedAmountMinor: committedAllocatedTotal,
        outstandingMinor: currentOutstanding,
      });
      if (!committedAllocationValidation.valid) throw new Error(committedAllocationValidation.error);

      const nextAmountPaid = currentInvoice.amountPaid + amountInCents;
      const nextStatus = nextAmountPaid >= currentInvoice.amountDue ? 'PAID' : 'PART_PAID';
      const invoiceUpdate = await transaction.invoice.updateMany(buildInvoicePaymentCompareAndSet({
        invoiceId,
        schoolId,
        currentAmountPaid: currentInvoice.amountPaid,
        currentStatus: currentInvoice.status,
        paymentAmountMinor: amountInCents,
        nextStatus,
      }));
      if (invoiceUpdate.count !== 1) throw new Error('INVOICE_PAYMENT_CONFLICT');

      const payment = await transaction.payment.create({
        data: {
          invoiceId,
          amount: amountInCents,
          method,
          idempotencyKey: normalizedIdempotencyKey ?? null,
          reference: reference || normalizedIdempotencyKey || null,
          recordedBy: userId ?? null,
        },
      });

      if (committedAllocationRows.length > 0) {
        await transaction.paymentAllocation.createMany({
          data: committedAllocationRows.map((allocation) => ({
            paymentId: payment.id,
            invoiceItemId: allocation.invoiceItemId,
            amount: allocation.amount,
          })),
        });
      }

      const updatedInvoice = await transaction.invoice.findFirst({
        where: { id: invoiceId, schoolId },
        select: { id: true, amountDue: true, amountPaid: true, status: true },
      });
      if (!updatedInvoice) throw new Error('INVOICE_NOT_FOUND');

      if (accountingRecorderId) {
        const unallocatedAmount = committedAllocationValidation.unallocatedAmountMinor;
        const accountingRows = [
          ...committedAllocationRows,
          ...(unallocatedAmount > 0 ? [{ invoiceItemId: null, amount: unallocatedAmount }] : []),
        ];

        for (const [index, allocation] of accountingRows.entries()) {
          const invoiceItem = allocation.invoiceItemId
            ? currentInvoice.items.find((item) => item.id === allocation.invoiceItemId)
            : null;
          const accountingCategoryName = invoiceItem?.name?.trim() || 'Other Income';
          const accountingCategory = await transaction.accountCategory.upsert({
            where: {
              schoolId_type_name: {
                schoolId,
                type: 'INCOME',
                name: accountingCategoryName,
              },
            },
            update: {
              isActive: true,
              description: invoiceItem?.feeScheduleItemId
                ? 'Synchronized from the school fee schedule'
                : 'Fee income captured from invoice payments',
            },
            create: {
              schoolId,
              type: 'INCOME',
              name: accountingCategoryName,
              description: invoiceItem?.feeScheduleItemId
                ? 'Synchronized from the school fee schedule'
                : 'Fee income captured from invoice payments',
            },
          });

          const accountingTransaction = await transaction.financialTransaction.create({
            data: {
              schoolId,
              categoryId: accountingCategory.id,
              type: 'INCOME',
              amount: allocation.amount,
              currency: schoolCurrency,
              paymentMethod: method,
              paymentId: index === 0 ? payment.id : null,
              invoiceId,
              invoiceItemId: allocation.invoiceItemId,
              description: `Fee payment received for ${invoiceItem?.name || 'school fees'} - ${currentInvoice.pupil.firstName} ${currentInvoice.pupil.lastName} (${currentInvoice.invoiceNo})`,
              referenceNumber: currentInvoice.invoiceNo || payment.reference || payment.id,
              transactionDate: new Date(),
              status: 'POSTED',
              createdBy: accountingRecorderId,
              postedAt: new Date(),
              postedBy: accountingRecorderId,
            },
          });

          if (userId) {
            await transaction.financialAuditLog.create({
              data: {
                schoolId,
                transactionId: accountingTransaction.id,
                action: 'FEE_ITEM_PAYMENT_SYNCED_TO_ACCOUNTING',
                previousValues: JSON.stringify({ status: 'DRAFT' }),
                newValues: JSON.stringify({
                  invoiceId,
                  invoiceItemId: allocation.invoiceItemId,
                  paymentId: payment.id,
                  amount: allocation.amount,
                  category: accountingCategoryName,
                }),
                changedBy: userId,
              },
            });
          }
        }

        const cashAccount = await transaction.accountingAccount.findFirst({
          where: { schoolId, code: '1010', isActive: true },
          select: { id: true },
        });
        const feeIncomeAccount = await transaction.accountingAccount.findFirst({
          where: { schoolId, code: '4000', isActive: true },
          select: { id: true },
        });

        if (cashAccount && feeIncomeAccount) {
          const paymentJournal = buildFeePaymentJournalEntry({
            amountMinor: amountInCents,
            reference: `FEE-PAY-${payment.id}`,
            description: `${currentInvoice.pupil.firstName} ${currentInvoice.pupil.lastName} payment`,
          });

          if (!paymentJournal.valid) {
            throw new Error(paymentJournal.error ?? 'INVALID_FEE_PAYMENT_POSTING');
          }

          const journalEntry = await transaction.accountingJournalEntry.create({
            data: {
              schoolId,
              reference: paymentJournal.journal.reference,
              description: `Fee payment recorded for ${currentInvoice.invoiceNo || payment.id}`,
              entryDate: new Date(),
              status: 'POSTED',
              sourceType: 'FEE_PAYMENT',
              sourceId: payment.id,
              idempotencyKey: normalizedIdempotencyKey ?? `fee-payment-${payment.id}`,
              createdBy: accountingRecorderId,
              postedAt: new Date(),
            },
          });

          await transaction.accountingJournalLine.createMany({
            data: paymentJournal.journal.lines.map((line) => ({
              journalEntryId: journalEntry.id,
              accountId: line.side === 'DEBIT' ? cashAccount.id : feeIncomeAccount.id,
              side: line.side,
              amount: line.amount,
              description: line.description,
            })),
          });
        }
      } else {
        throw new Error('Unable to resolve a staff user for accounting synchronization');
      }

      return { payment, updatedInvoice, committedAllocationRows };
    });

    const refreshedInvoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: {
          include: {
            allocations: { select: { amount: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true, currency: true, logoUrl: true },
    });
    const communicationService = createCommunicationService();
    const guardians = invoice.pupil.guardians || [];
    const pupilName = `${invoice.pupil.firstName} ${invoice.pupil.lastName}`;
    const className = invoice.pupil.class?.name || 'Unknown Class';
    const amountPaidFormatted = (amountInCents / 100).toFixed(2);
    const newPaidAmountFormatted = (updatedInvoice.amountPaid / 100).toFixed(2);
    const balanceAmount = Math.max(0, updatedInvoice.amountDue - updatedInvoice.amountPaid) / 100;
    const balance = balanceAmount.toFixed(2);
    const paymentItemSummary = formatFeeItemsForMessage(
      invoice.items.map((item) => {
        const previousPaid = item.allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
        const currentAllocation = committedAllocationRows.find((allocation) => allocation.invoiceItemId === item.id)?.amount ?? 0;
        const totalPaidForItem = previousPaid + currentAllocation;
        return {
          name: item.name,
          amount: item.amount * item.quantity,
          amountPaid: totalPaidForItem,
          amountOutstanding: Math.max(0, item.amount * item.quantity - totalPaidForItem),
        };
      }),
      school?.currency ?? 'NGN',
    );
    const paymentMessage = `Dear guardian, we have received payment of ${school?.currency ?? 'NGN'} ${amountPaidFormatted} for ${pupilName} (${className}).\n\nFee item balances:\n${paymentItemSummary || 'See the parent invoice for the full breakdown.'}\n\nInvoice balance: ${school?.currency ?? 'NGN'} ${balance}. Thank you.`;

    for (const guardianPupil of guardians) {
      const guardian = guardianPupil.guardian;
      const whatsappAddress = guardian.whatsapp || guardian.phone;
      const recipients = [
        ...(guardian.email ? [{ channel: 'EMAIL' as const, address: guardian.email, name: guardian.firstName }] : []),
        ...(whatsappAddress ? [{ channel: 'WHATSAPP' as const, address: whatsappAddress, name: guardian.firstName }] : []),
      ];

      if (recipients.length === 0) {
        continue;
      }

      try {
        const dispatchResult = await communicationService.dispatch({
          event: 'FeePaymentReceived',
          schoolId,
          recipients,
          template: 'Receipt',
          subject: 'Payment Received',
          body: paymentMessage,
          data: {
            studentName: pupilName,
            className,
            amount: amountPaidFormatted,
            paidAmount: newPaidAmountFormatted,
            balance,
            items: paymentItemSummary,
            schoolName: school?.name || 'SchoolBase',
            recipientName: guardian.firstName,
          },
          metadata: {
            studentName: pupilName,
            className,
            currency: school?.currency ?? 'NGN',
            amount: amountPaidFormatted,
            paidAmount: newPaidAmountFormatted,
            outstanding: balance,
            items: paymentItemSummary,
            schoolName: school?.name || 'SchoolBase',
            logoUrl: school?.logoUrl ?? undefined,
            invoiceId: updatedInvoice.id,
            paymentId: payment.id,
            guardianId: guardian.id,
          },
        });

        for (const delivery of dispatchResult.deliveries) {
          const status = delivery.status === 'SENT' ? 'SENT' : delivery.status === 'QUEUED' ? 'PENDING' : 'FAILED';
          await prisma.notification.create({
            data: {
              schoolId,
              guardianId: guardian.id,
              type: 'RECEIPT',
              title: 'Payment Receipt',
              body: truncateNotificationBody(paymentMessage),
              channel: delivery.channel,
              status,
              sentAt: delivery.status === 'SENT' || delivery.status === 'QUEUED' ? new Date() : undefined,
              failureReason: delivery.error,
              relatedId: updatedInvoice.id,
              reference: String(payment.id),
            },
          });
        }
      } catch (dispatchError) {
        console.warn('⚠️ Failed to dispatch payment receipt:', dispatchError);
        await prisma.notification.create({
          data: {
            schoolId,
            guardianId: guardian.id,
            type: 'RECEIPT',
            title: 'Payment Receipt',
            body: truncateNotificationBody(paymentMessage),
            channel: guardian.whatsapp ? 'WHATSAPP' : 'EMAIL',
            status: 'FAILED',
            failureReason: dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
            relatedId: updatedInvoice.id,
            reference: String(payment.id),
          },
        });
      }
    }

    res.json({
      success: true,
      message: 'Payment recorded successfully',
      payment: {
        id: payment.id,
        amount: (payment.amount / 100).toFixed(2),
        method: payment.method,
        reference: payment.reference,
        paidAt: payment.paidAt,
      },
      invoice: {
        id: updatedInvoice.id,
        amountDue: (updatedInvoice.amountDue / 100).toFixed(2),
        amountPaid: (updatedInvoice.amountPaid / 100).toFixed(2),
        status: updatedInvoice.status,
        items: (refreshedInvoice?.items || []).map((item) => ({
          id: item.id,
          name: item.name,
          amount: item.amount,
          quantity: item.quantity,
          description: item.description,
          allocations: (item.allocations || []).map((allocation) => ({
            amount: allocation.amount,
          })),
        })),
      },
    });
  } catch (error) {
    console.error('Error recording payment:', error);
    const isUniqueConstraintConflict = typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'P2002';
    const requestBody = req.body ?? {};
    const replayIdempotencyKey = normalizePaymentIdempotencyKey(requestBody.idempotencyKey);
    const replayAmountMinor = parsePositiveAmountMinor(requestBody.amount);
    const replayInvoiceId = typeof requestBody.invoiceId === 'string' ? requestBody.invoiceId : null;
    const isPaymentRaceConflict = error instanceof Error
      && ['INVOICE_PAYMENT_CONFLICT', 'PAYMENT_EXCEEDS_BALANCE'].includes(error.message);
    if ((isUniqueConstraintConflict || isPaymentRaceConflict)
      && replayIdempotencyKey
      && replayAmountMinor !== null
      && replayInvoiceId
      && typeof requestBody.method === 'string') {
      const existingPayment = await prisma.payment.findFirst({
        where: { invoiceId: replayInvoiceId, idempotencyKey: replayIdempotencyKey },
        include: { allocations: true },
      });
      if (existingPayment) {
        if (!matchesPaymentIdempotencyRequest({
          existing: existingPayment,
          requested: {
            amount: replayAmountMinor,
            method: requestBody.method,
            reference: requestBody.reference,
            idempotencyKey: replayIdempotencyKey,
            allocations: requestBody.allocations,
          },
        })) {
          return res.status(409).json({
            error: 'Payment idempotency key already exists for a different payload. Please retry with the same payment data or use a new idempotency key.',
          });
        }
        const currentInvoice = await prisma.invoice.findFirst({
          where: { id: replayInvoiceId, schoolId: (req as any).user?.schoolId },
          select: { id: true, amountDue: true, amountPaid: true, status: true },
        });
        return res.status(200).json({
          success: true,
          idempotent: true,
          message: 'Payment already recorded',
          payment: {
            id: existingPayment.id,
            amount: (existingPayment.amount / 100).toFixed(2),
            method: existingPayment.method,
            reference: existingPayment.reference,
            paidAt: existingPayment.paidAt,
          },
          invoice: currentInvoice ? {
            id: currentInvoice.id,
            amountDue: (currentInvoice.amountDue / 100).toFixed(2),
            amountPaid: (currentInvoice.amountPaid / 100).toFixed(2),
            status: currentInvoice.status,
          } : undefined,
        });
      }
    }
    if (error instanceof Error && error.message === 'INVOICE_NOT_FOUND') {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    if (error instanceof Error && error.message === 'PAYMENT_EXCEEDS_BALANCE') {
      return res.status(409).json({ error: 'The invoice balance changed. Refresh it and retry with the current outstanding amount.' });
    }
    if (error instanceof Error && error.message === 'INVOICE_PAYMENT_CONFLICT') {
      return res.status(409).json({ error: 'Another payment updated this invoice. Refresh it before recording another payment.' });
    }
    if (error instanceof Error && ['INVALID_PAYMENT_ALLOCATION_ITEM', 'PAYMENT_ALLOCATION_EXCEEDS_ITEM_BALANCE', 'ALLOCATIONS_EXCEED_PAYMENT'].includes(error.message)) {
      return res.status(409).json({ error: 'Invoice item balances changed. Refresh the invoice and review the payment allocation.' });
    }
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

// GET /api/admin/notifications - Get notification log
router.get('/notifications', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { type, status, channel, fromDate, toDate, limit = 100, offset = 0 } = req.query;

    let whereClause: any = { schoolId };

    if (type) whereClause.type = type;
    if (status) whereClause.status = status;
    if (channel) whereClause.channel = channel;

    if (fromDate && toDate) {
      const from = new Date(fromDate as string);
      const to = new Date(toDate as string);
      from.setUTCHours(0, 0, 0, 0);
      to.setUTCHours(23, 59, 59, 999);
      whereClause.createdAt = { gte: from, lte: to };
    }

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where: whereClause,
        include: {
          guardian: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.notification.count({ where: whereClause }),
    ]);

    // Calculate statistics
    const stats = {
      total,
      sent: 0,
      failed: 0,
      pending: 0,
      byChannel: { WHATSAPP: 0, EMAIL: 0 },
      byType: { ISSUE_BILLS: 0, SEND_REMINDER: 0, ATTENDANCE_UPDATE: 0 },
    };

    const allNotifications = await prisma.notification.findMany({
      where: whereClause,
      select: { status: true, channel: true, type: true },
    });

    allNotifications.forEach((n) => {
      if (n.status === 'SENT') stats.sent++;
      if (n.status === 'FAILED') stats.failed++;
      if (n.status === 'PENDING') stats.pending++;
      stats.byChannel[n.channel as 'WHATSAPP' | 'EMAIL']++;
      stats.byType[n.type as 'ISSUE_BILLS' | 'SEND_REMINDER' | 'ATTENDANCE_UPDATE']++;
    });

    const mappedNotifications = notifications.map((n) => ({
      id: n.id,
      date: n.createdAt,
      guardian: `${n.guardian.firstName} ${n.guardian.lastName}`,
      guardianId: n.guardian.id,
      type: n.type,
      title: n.title,
      body: n.body,
      channel: n.channel,
      status: n.status,
      sentAt: n.sentAt,
      failureReason: n.failureReason,
      reference: n.reference,
    }));

    res.json({
      notifications: mappedNotifications,
      stats,
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.post('/notifications/retry-failed', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const incomingIds = Array.isArray(req.body?.notificationIds) ? req.body.notificationIds : [];
    const requestedType = typeof req.body?.type === 'string' ? req.body.type.trim() : '';
    const notificationIds = incomingIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    const query: any = {
      schoolId,
      channel: 'WHATSAPP',
      status: 'FAILED',
    };

    if (notificationIds.length > 0) {
      query.id = { in: notificationIds };
    }
    if (requestedType) {
      query.type = requestedType;
    }

    const notifications = await prisma.notification.findMany({
      where: query,
      include: {
        guardian: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            whatsapp: true,
            phone: true,
            altPhone: true,
          },
        },
      },
    });

    if (notifications.length === 0) {
      return res.status(400).json({ error: 'No failed WhatsApp notifications matched the selected retry filter.' });
    }

    const queued: string[] = [];
    const skipped: string[] = [];

    for (const notification of notifications) {
      const phoneNumber = notification.guardian?.whatsapp || notification.guardian?.phone || notification.guardian?.altPhone;
      if (!phoneNumber) {
        skipped.push(notification.id);
        await prisma.notification.update({
          where: { id: notification.id },
          data: {
            status: 'FAILED',
            failureReason: 'No valid WhatsApp number available for retry',
          },
        });
        continue;
      }

      const messageBody = String(notification.body || notification.title || 'SchoolBase notification');
      const queuedDelivery = await whatsappDeliveryStore.upsertSchoolDelivery({
        schoolId,
        event: String(notification.type || 'NotificationRetry'),
        guardianId: notification.guardianId,
        recipientAddress: phoneNumber,
        recipientName: `${notification.guardian.firstName} ${notification.guardian.lastName}`.trim() || 'Guardian',
        messageBody,
        status: 'QUEUED',
        provider: 'baileys',
        attemptCount: 0,
        nextAttemptAt: new Date(Date.now() + 2_000),
      });

      await prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: 'PENDING',
          failureReason: `Queued for background retry via WhatsApp worker${queuedDelivery?.id ? ` (${queuedDelivery.id})` : ''}`,
          sentAt: null,
        },
      });

      queued.push(notification.id);
    }

    return res.json({
      success: true,
      queuedCount: queued.length,
      skippedCount: skipped.length,
      queued,
      skipped,
      message: 'Selected failed WhatsApp notifications were queued for graceful background retry and policy-safe delivery.',
    });
  } catch (error) {
    console.error('Error queueing failed WhatsApp notifications:', error);
    res.status(500).json({ error: 'Failed to queue selected WhatsApp notifications for retry' });
  }
});

// GET /api/admin/students/data - Get students list for client-side rendering
router.get('/students/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const requestedStatus = normalizeStudentEnrollmentStatus(req.query.status || 'ACTIVE');
    if (!requestedStatus) {
      return res.status(400).json({ error: 'Choose ACTIVE or INACTIVE student records.' });
    }
    const pupilWhere = buildStudentRosterWhere(schoolId, requestedStatus);

    const [pupils, classes, school] = await Promise.all([
      prisma.pupil.findMany({
        where: pupilWhere,
        include: {
          class: true,
          guardians: { include: { guardian: true } },
        },
        orderBy: { lastName: 'asc' },
      }),
      prisma.class.findMany({
        where: { schoolId },
        orderBy: { name: 'asc' },
      }),
      prisma.school.findUnique({
        where: { id: schoolId },
        select: { name: true, initials: true },
      }),
    ]);

    const year = new Date().getFullYear();
    const nextAdmissionNo = getNextAdmissionNo({
      schoolId,
      schoolName: school?.name ?? null,
      schoolInitials: school?.initials ?? null,
      year,
      existingRecords: pupils.map((pupil) => ({
        id: pupil.id,
        schoolId: pupil.schoolId,
        admissionNo: pupil.admissionNo,
      })),
    });

    res.json({ pupils, classes, nextAdmissionNo });
  } catch (error) {
    console.error('Error fetching students data:', error);
    res.status(500).json({ error: 'Failed to fetch students data' });
  }
});

// POST /api/admin/students/import - Preview or import students from CSV
router.post('/students/import', studentImportUpload.single('file'), async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });
    if (!req.file) return res.status(400).json({ error: 'CSV file is required' });

    const rows = parseCsvText(req.file.buffer.toString('utf8'));
    const currentYear = new Date().getFullYear();
    const [classes, existingPupils, school, admissionCounter] = await Promise.all([
      prisma.class.findMany({ where: { schoolId }, select: { id: true, name: true, arm: true } }),
      prisma.pupil.findMany({ where: { schoolId }, select: { admissionNo: true } }),
      prisma.school.findUnique({ where: { id: schoolId }, select: { name: true, initials: true } }),
      prisma.admissionCounter.findUnique({ where: { schoolId_year: { schoolId, year: currentYear } } }),
    ]);
    const result = buildBulkStudentImportRows(
      rows,
      classes,
      existingPupils.map((pupil) => pupil.admissionNo).filter(Boolean) as string[],
    );

    if (req.query.preview === 'true') {
      const firstAdmissionNo = getNextAdmissionNo({
        schoolId,
        schoolName: school?.name,
        schoolInitials: school?.initials,
        year: currentYear,
        existingRecords: existingPupils.map((pupil) => ({ schoolId, admissionNo: pupil.admissionNo })),
      });
      const admissionPrefix = firstAdmissionNo.replace(/-\d{4}$/, '');
      const firstSequence = Math.max(
        Number(firstAdmissionNo.match(/(\d+)$/)?.[1] || 1),
        (admissionCounter?.lastSeq || 0) + 1,
      );
      const previewRows = result.validRows.map((row, index) => ({
        ...row,
        admissionNo: `${admissionPrefix}-${String(firstSequence + index).padStart(4, '0')}`,
      }));

      return res.json({
        previewRows,
        validRows: previewRows.length,
        errors: result.errors,
      });
    }

    if (result.validRows.length === 0) {
      return res.status(400).json({ error: 'No valid students found in the CSV file', errors: result.errors });
    }

    const importedCount = await prisma.$transaction(async (transaction) => {
      const firstAdmissionNo = await reserveNextAdmissionNo({
        transaction,
        schoolId,
        schoolName: school?.name,
        schoolInitials: school?.initials,
        year: currentYear,
      });
      const admissionPrefix = firstAdmissionNo.replace(/-\d{4}$/, '');
      const firstSequence = Number(firstAdmissionNo.match(/(\d+)$/)?.[1] || 1);
      let count = 0;
      for (const [index, row] of result.validRows.entries()) {
        const admissionNo = `${admissionPrefix}-${String(firstSequence + index).padStart(4, '0')}`;
        const rowStatus = normalizeStudentEnrollmentStatus(row.status || 'ACTIVE') || 'ACTIVE';
        const pupil = await transaction.pupil.create({
          data: {
            schoolId,
            firstName: row.firstName || '',
            lastName: row.lastName || '',
            middleName: row.middleName || null,
            admissionNo,
            classId: row.classId || null,
            status: rowStatus,
            isActive: rowStatus === 'ACTIVE',
            admissionDate: new Date(),
            gender: row.gender || null,
            dateOfBirth: parseImportDate(row.birthDate),
            address: row.address || null,
          },
        });

        if (row.guardianFirst && row.guardianLast && row.guardianPhone) {
          const guardian = await transaction.guardian.create({
            data: {
              schoolId,
              firstName: row.guardianFirst,
              lastName: row.guardianLast,
              phone: row.guardianPhone,
              whatsapp: row.guardianPhone,
              email: row.guardianEmail || null,
            },
          });
          await transaction.guardianPupil.create({
            data: { guardianId: guardian.id, pupilId: pupil.id, relation: 'Parent' },
          });
        }
        count += 1;
      }
      await transaction.admissionCounter.update({
        where: { schoolId_year: { schoolId, year: currentYear } },
        data: { lastSeq: firstSequence + result.validRows.length - 1 },
      });
      return count;
    });

    await recordActivity({
      event: 'STUDENTS_IMPORTED',
      details: `Imported ${importedCount} students from CSV`,
      schoolId,
    }).catch((error) => console.warn('Failed to record student import activity:', error));

    return res.json({ importedCount, errors: result.errors });
  } catch (error) {
    console.error('Error importing students:', error);
    return res.status(500).json({ error: 'Failed to import students' });
  }
});

// POST /api/admin/students - Create new student with guardian
router.post('/students', upload.single('photo'), async (req: Request, res: Response) => {
  console.log('[create student] contentType=', req.headers['content-type']);
  console.log('[create student] body=', req.body);
  console.log('[create student] file=', req.file ? {
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    path: req.file.path,
  } : null);

  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const {
      firstName: rawFirstName,
      lastName: rawLastName,
      middleName,
      admissionNo,
      classId,
      status,
      admissionDate,
      gender,
      dateOfBirth,
      studentEmail,
      studentPhone,
      address,
      bloodGroup,
      genotype,
      medicalNotes,
      previousSchool,
      previousClass,
      guardianFirst: rawGuardianFirst,
      guardianLast: rawGuardianLast,
      guardianRelationship,
      guardianEmail,
      guardianPhone,
      guardianAltPhone,
      guardianOccupation,
    } = req.body;

    const firstName = normalizeField(rawFirstName);
    const lastName = normalizeField(rawLastName);
    const normalizedStatus = normalizeStudentEnrollmentStatus(status || 'ACTIVE');
    if (!normalizedStatus) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Student status must be ACTIVE or INACTIVE.' });
    }
    const guardianFirst = normalizeField(rawGuardianFirst);
    const guardianLast = normalizeField(rawGuardianLast);
    const normalizedStudentEmail = normalizeField(studentEmail);
    const normalizedStudentPhone = normalizeField(studentPhone);
    const normalizedAddress = normalizeField(address);
    const normalizedBloodGroup = normalizeField(bloodGroup);
    const normalizedGenotype = normalizeField(genotype);
    const normalizedMedicalNotes = normalizeField(medicalNotes);
    const normalizedPreviousSchool = normalizeField(previousSchool);
    const normalizedPreviousClass = normalizeField(previousClass);
    const normalizedGuardianEmail = normalizeField(guardianEmail);
    const normalizedGuardianPhone = normalizeField(guardianPhone);
    const normalizedGuardianAltPhone = normalizeField(guardianAltPhone);
    const normalizedGuardianOccupation = normalizeField(guardianOccupation);
    let normalizedAdmissionNo = normalizeAdmissionNo(admissionNo ?? null);

    if (!normalizedAdmissionNo) {
      const school = await prisma.school.findUnique({
        where: { id: schoolId },
        select: { name: true, initials: true },
      });

      normalizedAdmissionNo = await prisma.$transaction((transaction) => reserveNextAdmissionNo({
        transaction,
        schoolId,
        schoolName: school?.name,
        schoolInitials: school?.initials,
        year: new Date().getFullYear(),
      }));
    }

    console.log('[create student] schoolId=%s, firstName=%s, lastName=%s, classId=%s, guardianFirst=%s, guardianLast=%s',
      schoolId,
      firstName,
      lastName,
      classId,
      guardianFirst,
      guardianLast,
    );

    // Validate required fields
    if (!firstName || !lastName) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({
        error: 'First name and last name are required',
        details: { firstName, lastName, schoolId },
      });
    }

    const hasGuardianName = Boolean(guardianFirst || guardianLast);
    if (hasGuardianName && (!guardianFirst || !guardianLast || !normalizedGuardianPhone)) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({
        error: 'Guardian first name, last name, and phone are required together',
      });
    }

    if (normalizedAdmissionNo) {
      const existingPupils = await prisma.pupil.findMany({
        where: { schoolId },
        select: { id: true, schoolId: true, admissionNo: true },
      });

      const duplicateCheck = validateUniqueAdmissionNo({
        schoolId,
        admissionNo: normalizedAdmissionNo,
        currentStudentId: null,
        existingRecords: existingPupils,
      });

      if (!duplicateCheck.isValid) {
        if (req.file) {
          try {
            fs.unlinkSync(req.file.path);
          } catch (e) {
            // ignore
          }
        }

        return res.status(409).json({
          error: duplicateCheck.error || 'Admission number already exists for this school.',
          details: { admissionNo: normalizedAdmissionNo },
        });
      }
    }

    // Create pupil
    const pupil = await prisma.pupil.create({
      data: {
        schoolId,
        firstName,
        lastName,
        middleName: normalizeField(middleName),
        admissionNo: normalizedAdmissionNo,
        classId: classId || null,
        status: normalizedStatus,
        isActive: normalizedStatus === 'ACTIVE',
        admissionDate: admissionDate ? new Date(admissionDate) : new Date(),
        gender: normalizeField(gender),
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        studentEmail: normalizedStudentEmail,
        studentPhone: normalizedStudentPhone,
        address: normalizedAddress,
        bloodGroup: normalizedBloodGroup,
        genotype: normalizedGenotype,
        medicalNotes: normalizedMedicalNotes,
        previousSchool: normalizedPreviousSchool,
        previousClass: normalizedPreviousClass,
        photoUrl: req.file ? `/uploads/photos/${req.file.filename}` : null,
      },
      include: {
        class: true,
        guardians: { include: { guardian: true } },
      },
    });

    await recordActivity({
      event: 'STUDENT_REGISTERED',
      details: `Student registered: ${pupil.firstName} ${pupil.lastName}${pupil.admissionNo ? ` (${pupil.admissionNo})` : ''}`,
      schoolId,
    }).catch((error) => console.warn('Failed to record student registration activity:', error));

    // Create or find guardian and link to pupil
    if (guardianFirst && guardianLast) {
      const guardian = await prisma.guardian.create({
        data: {
          schoolId,
          firstName: guardianFirst,
          lastName: guardianLast,
          phone: normalizedGuardianPhone || '',
          whatsapp: normalizedGuardianPhone || '',
          altPhone: normalizedGuardianAltPhone,
          email: normalizedGuardianEmail,
          occupation: normalizedGuardianOccupation,
        },
      });

      // Link guardian to pupil
      await prisma.guardianPupil.create({
        data: {
          guardianId: guardian.id,
          pupilId: pupil.id,
          relation: guardianRelationship || 'Parent',
        },
      });

      const whatsappAddress = guardian.whatsapp || guardian.phone;
      const recipients = [
        ...(guardian.email ? [{ channel: 'EMAIL' as const, address: guardian.email, name: guardian.firstName }] : []),
        ...(whatsappAddress ? [{ channel: 'WHATSAPP' as const, address: whatsappAddress, name: guardian.firstName }] : []),
      ];

      if (recipients.length > 0) {
        const className = pupil.class?.name || 'your class';
        const school = schoolId
          ? await prisma.school.findUnique({ where: { id: schoolId }, select: { name: true, logoUrl: true } })
          : null;
        const communicationService = createCommunicationService();
        const parentPortalUrl = `${(process.env.FRONTEND_URL || 'https://www.schoolbase.live').replace(/\/$/, '')}/parent/login`;
        const message = `Hello ${guardian.firstName},

Welcome to ${school?.name || 'your school'} on SchoolBase. ${pupil.firstName} ${pupil.lastName} has been successfully registered for ${className}.

Student details:
• Admission number: ${pupil.admissionNo || 'N/A'}

Parent portal login:
${parentPortalUrl}

How to use it:
1. Open the link above.
2. Enter the phone number registered with the school.
3. Enter your child's admission number.
4. Tap Sign in to view fees, results, attendance, notices, and other school updates.

No password is required. Please save this link for future access. If you need help, contact the school office.`;

        try {
          const dispatchResult = await communicationService.dispatch({
            event: 'AdmissionCreated',
            schoolId,
            recipients,
            template: 'Admission',
            subject: 'Student Admission Completed',
            body: message,
            data: {
              studentName: `${pupil.firstName} ${pupil.lastName}`,
              className,
              admissionNo: String(pupil.admissionNo || 'N/A'),
              schoolName: school?.name || 'SchoolBase',
              recipientName: guardian.firstName,
            },
            metadata: {
              studentName: `${pupil.firstName} ${pupil.lastName}`,
              className,
              admissionNo: String(pupil.admissionNo || 'N/A'),
              schoolName: school?.name || 'SchoolBase',
              logoUrl: school?.logoUrl ?? undefined,
            },
          });

          for (const delivery of dispatchResult.deliveries) {
            const status = delivery.status === 'SENT' ? 'SENT' : delivery.status === 'QUEUED' ? 'PENDING' : 'FAILED';
            await prisma.notification.create({
              data: {
                schoolId,
                guardianId: guardian.id,
                type: 'ADMISSION',
                title: 'Admission Notification',
                body: truncateNotificationBody(message),
                channel: delivery.channel,
                status,
                sentAt: delivery.status === 'SENT' || delivery.status === 'QUEUED' ? new Date() : undefined,
                failureReason: delivery.error,
                relatedId: pupil.id,
                reference: String(pupil.admissionNo || 'N/A'),
              },
            });
          }
        } catch (dispatchError) {
          console.warn('⚠️ Failed to dispatch admission notification:', dispatchError);
          await prisma.notification.create({
            data: {
              schoolId,
              guardianId: guardian.id,
              type: 'ADMISSION',
              title: 'Admission Notification',
              body: truncateNotificationBody(message),
              channel: guardian.whatsapp ? 'WHATSAPP' : 'EMAIL',
              status: 'FAILED',
              failureReason: dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
              relatedId: pupil.id,
              reference: String(pupil.admissionNo || 'N/A'),
            },
          });
        }
      }
    }

    // Fetch updated pupil with guardians
    const updatedPupil = await prisma.pupil.findUnique({
      where: { id: pupil.id },
      include: {
        class: true,
        guardians: { include: { guardian: true } },
      },
    });

    res.status(201).json(updatedPupil);
  } catch (error) {
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {
        // ignore
      }
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      console.error('[create student] Duplicate admission number or unique constraint violation:', error.meta);
      return res.status(409).json({
        error: 'A student with this admission number already exists for this school.',
      });
    }

    console.error('Error creating student:', error);
    res.status(500).json({ error: 'Failed to create student' });
  }
});

// GET /api/admin/students/:id - Get single student data
router.get('/students/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { id } = req.params;

    const pupil = await prisma.pupil.findFirst({
      where: { id, schoolId },
      include: {
        class: true,
        guardians: { include: { guardian: true } },
      },
    });

    if (!pupil) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const [invoices, invoiceTotals, attendanceRecords, termSummaries, promotionHistory, academicYears] = await Promise.all([
      prisma.invoice.findMany({
        where: { pupilId: id, schoolId },
        include: {
          feeSchedule: { include: { term: { include: { academicYear: true } } } },
          payments: { orderBy: { paidAt: 'desc' }, take: 5 },
          adjustments: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.invoice.aggregate({
        where: { pupilId: id, schoolId },
        _sum: { amountDue: true, amountPaid: true },
        _count: { _all: true },
      }),
      prisma.attendanceRecord.findMany({
        where: { pupilId: id, schoolId },
        orderBy: { date: 'desc' },
        take: 365,
      }),
      prisma.studentTermSummary.findMany({
        where: { pupilId: id, schoolId },
        orderBy: { updatedAt: 'desc' },
        take: 8,
      }),
      prisma.promotionRecord.findMany({
        where: { pupilId: id, schoolId },
        orderBy: { decidedAt: 'desc' },
        take: 8,
      }),
      prisma.academicYear.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        include: { terms: { orderBy: { sortOrder: 'asc' } } },
      }),
    ]);

    const currentAcademicYear = academicYears.find((year) => year.isCurrent) || academicYears[0] || null;

    const totalDue = invoiceTotals._sum.amountDue || 0;
    const totalPaid = invoiceTotals._sum.amountPaid || 0;
    const feesBalance = totalDue - totalPaid;
    const now = new Date();
    const currentTerm = currentAcademicYear?.terms
      .filter((term) => (!term.startsOn || term.startsOn <= now) && (!term.endsOn || term.endsOn >= now))
      .sort((a, b) => b.sortOrder - a.sortOrder)[0]
      || currentAcademicYear?.terms
        .filter((term) => !term.startsOn || term.startsOn <= now)
        .sort((a, b) => b.sortOrder - a.sortOrder)[0]
      || currentAcademicYear?.terms[0]
      || null;
    const termBalances = new Map<string, { academicYearId: string; academicYearName: string; termId: string; termName: string; amountDue: number; amountPaid: number; balance: number; invoiceCount: number }>();
    for (const invoice of invoices) {
      const term = invoice.feeSchedule?.term;
      const academicYear = term?.academicYear;
      const key = term?.id || `unassigned-${invoice.id}`;
      const existing = termBalances.get(key) || {
        academicYearId: academicYear?.id || '',
        academicYearName: academicYear?.name || 'Unassigned term',
        termId: term?.id || '',
        termName: term?.name || 'Unassigned term',
        amountDue: 0,
        amountPaid: 0,
        balance: 0,
        invoiceCount: 0,
      };
      existing.amountDue += Number(invoice.amountDue || 0);
      existing.amountPaid += Number(invoice.amountPaid || 0);
      existing.balance = Math.max(0, existing.amountDue - existing.amountPaid);
      existing.invoiceCount += 1;
      termBalances.set(key, existing);
    }
    const attendanceSummary = (records: typeof attendanceRecords) => ({
      total: records.length,
      present: records.filter((record) => record.status === 'PRESENT').length,
      absent: records.filter((record) => record.status === 'ABSENT').length,
      late: records.filter((record) => record.status === 'LATE').length,
      percentage: records.length > 0
        ? Math.round(((records.filter((record) => record.status === 'PRESENT').length + records.filter((record) => record.status === 'LATE').length * 0.5) / records.length) * 100)
        : null,
    });
    const attendancePeriods = academicYears.flatMap((year) => year.terms.map((term) => {
      const records = attendanceRecords.filter((record) => {
        const date = new Date(record.date);
        return Boolean(term.startsOn || term.endsOn)
          && (!term.startsOn || date >= term.startsOn)
          && (!term.endsOn || date <= term.endsOn);
      });
      return {
        academicYearId: year.id,
        academicYearName: year.name,
        termId: term.id,
        termName: term.name,
        sortOrder: term.sortOrder,
        startsOn: term.startsOn,
        isCurrent: year.id === currentAcademicYear?.id && term.id === currentTerm?.id,
        ...attendanceSummary(records),
        records: records.sort((a, b) => b.date.getTime() - a.date.getTime()),
      };
    }).filter((period) => period.total > 0).sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.startsOn && b.startsOn && a.startsOn.getTime() !== b.startsOn.getTime()) return b.startsOn.getTime() - a.startsOn.getTime();
      return b.sortOrder - a.sortOrder;
    }));
    const attendance = {
      total: attendanceRecords.length,
      present: attendanceRecords.filter((record) => record.status === 'PRESENT').length,
      absent: attendanceRecords.filter((record) => record.status === 'ABSENT').length,
      late: attendanceRecords.filter((record) => record.status === 'LATE').length,
    };
    const attendancePercentage = attendance.total > 0
      ? Math.round(((attendance.present + attendance.late * 0.5) / attendance.total) * 100)
      : null;

    res.json({
      ...pupil,
      feesBalance,
      invoiceCount: invoiceTotals._count._all,
      invoices,
      currentAcademicYear: currentAcademicYear ? { id: currentAcademicYear.id, name: currentAcademicYear.name } : null,
      currentTerm: currentTerm ? { id: currentTerm.id, name: currentTerm.name } : null,
      termBalances: Array.from(termBalances.values()).sort((a, b) => {
        if (a.academicYearId === currentAcademicYear?.id && b.academicYearId !== currentAcademicYear?.id) return -1;
        if (a.academicYearId !== currentAcademicYear?.id && b.academicYearId === currentAcademicYear?.id) return 1;
        return b.balance - a.balance;
      }),
      attendance: { ...attendance, percentage: attendancePercentage, records: attendanceRecords, periods: attendancePeriods },
      termSummaries,
      promotionHistory,
    });
  } catch (error) {
    console.error('Error fetching student:', error);
    res.status(500).json({ error: 'Failed to fetch student' });
  }
});

// PATCH /api/admin/students/:id - Update student data
router.patch('/students/:id', upload.single('photo'), async (req: Request, res: Response) => {
  console.log('[update student] contentType=', req.headers['content-type']);
  console.log('[update student] body=', req.body);
  console.log('[update student] file=', req.file ? {
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    path: req.file.path,
  } : null);

  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { id } = req.params;

    // Verify student exists and belongs to school
    const existingPupil = await prisma.pupil.findFirst({
      where: { id, schoolId },
      include: { guardians: true },
    });

    if (!existingPupil) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Student not found' });
    }

    const {
      firstName,
      middleName,
      lastName,
      classId,
      status,
      admissionDate,
      gender,
      dateOfBirth,
      studentEmail,
      studentPhone,
      address,
      bloodGroup,
      genotype,
      medicalNotes,
      previousSchool,
      previousClass,
      guardianFirst,
      guardianLast,
      guardianRelationship,
      guardianEmail,
      guardianPhone,
      guardianAltPhone,
      guardianOccupation,
    } = req.body;

    const normalizedStatus = status === undefined ? undefined : normalizeStudentEnrollmentStatus(status);
    if (status !== undefined && !normalizedStatus) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Student status must be ACTIVE or INACTIVE.' });
    }

    // Prepare photo URL if file was uploaded
    let photoUrl = existingPupil.photoUrl;
    if (req.file) {
      // Delete old photo if exists
      if (existingPupil.photoUrl) {
        const oldPath = path.join(process.cwd(), 'uploads', existingPupil.photoUrl.replace('/uploads/', ''));
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }
      photoUrl = `/uploads/photos/${req.file.filename}`;
    }

    const updateAdmissionNo = req.body.admissionNo !== undefined ? normalizeAdmissionNo(String(req.body.admissionNo)) : existingPupil.admissionNo ? normalizeAdmissionNo(existingPupil.admissionNo) : null;

    if (updateAdmissionNo) {
      const existingPupils = await prisma.pupil.findMany({
        where: { schoolId },
        select: { id: true, schoolId: true, admissionNo: true },
      });

      const duplicateCheck = validateUniqueAdmissionNo({
        schoolId,
        admissionNo: updateAdmissionNo,
        currentStudentId: id,
        existingRecords: existingPupils,
      });

      if (!duplicateCheck.isValid) {
        if (req.file) {
          try {
            fs.unlinkSync(req.file.path);
          } catch (e) {
            // ignore
          }
        }

        return res.status(409).json({
          error: duplicateCheck.error || 'Admission number already exists for this school.',
          details: { admissionNo: updateAdmissionNo },
        });
      }
    }

    const optionalText = (value: unknown) => {
      if (value === undefined || value === null) return undefined;
      const trimmed = String(value).trim();
      return trimmed || null;
    };

    const guardianLink = existingPupil.guardians[0];
    await prisma.$transaction(async (transaction) => {
      await transaction.pupil.update({
        where: { id },
        data: {
          firstName: firstName || existingPupil.firstName,
          middleName: optionalText(middleName),
          lastName: lastName || existingPupil.lastName,
          classId: optionalText(classId),
          status: normalizedStatus ?? optionalText(status),
          isActive: normalizedStatus === undefined ? undefined : normalizedStatus === 'ACTIVE',
          admissionDate: admissionDate === undefined ? undefined : admissionDate ? new Date(admissionDate) : null,
          gender: optionalText(gender),
          dateOfBirth: dateOfBirth === undefined ? undefined : dateOfBirth ? new Date(dateOfBirth) : null,
          studentEmail: optionalText(studentEmail),
          studentPhone: optionalText(studentPhone),
          address: optionalText(address),
          bloodGroup: optionalText(bloodGroup),
          genotype: optionalText(genotype),
          medicalNotes: optionalText(medicalNotes),
          previousSchool: optionalText(previousSchool),
          previousClass: optionalText(previousClass),
          admissionNo: updateAdmissionNo,
          photoUrl,
        },
      });

      if (guardianLink) {
        await transaction.guardian.update({
          where: { id: guardianLink.guardianId },
          data: {
            firstName: guardianFirst?.trim() || undefined,
            lastName: guardianLast?.trim() || undefined,
            phone: guardianPhone?.trim() || undefined,
            whatsapp: guardianPhone?.trim() || undefined,
            altPhone: optionalText(guardianAltPhone),
            email: optionalText(guardianEmail),
            occupation: optionalText(guardianOccupation),
          },
        });
        await transaction.guardianPupil.update({
          where: {
            guardianId_pupilId: {
              guardianId: guardianLink.guardianId,
              pupilId: id,
            },
          },
          data: { relation: guardianRelationship?.trim() || 'Parent' },
        });
      } else if (guardianFirst?.trim() && guardianLast?.trim() && guardianPhone?.trim()) {
        const guardian = await transaction.guardian.create({
          data: {
            schoolId,
            firstName: guardianFirst.trim(),
            lastName: guardianLast.trim(),
            phone: guardianPhone.trim(),
            whatsapp: guardianPhone.trim(),
            altPhone: optionalText(guardianAltPhone),
            email: optionalText(guardianEmail),
            occupation: optionalText(guardianOccupation),
          },
        });
        await transaction.guardianPupil.create({
          data: {
            guardianId: guardian.id,
            pupilId: id,
            relation: guardianRelationship?.trim() || 'Parent',
          },
        });
      }
    });

    const updatedPupil = await prisma.pupil.findUnique({
      where: { id },
      include: {
        class: true,
        guardians: { include: { guardian: true } },
      },
    });

    res.json(updatedPupil);
  } catch (error) {
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {
        // ignore
      }
    }
    console.error('Error updating student:', error);
    res.status(500).json({ error: 'Failed to update student' });
  }
});

// GET /api/admin/classes/data - Get classes list for client-side rendering
router.get('/classes/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const classes = await prisma.class.findMany({
      where: { schoolId },
      orderBy: [{ phase: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          select: {
            pupils: true,
            subjectClasses: true,
          },
        },
      },
    });

    res.json({ classes });
  } catch (error) {
    console.error('Error fetching classes data:', error);
    res.status(500).json({ error: 'Failed to fetch classes data' });
  }
});

// GET /api/admin/promotions/preview - Preview promotion decisions for a class
router.get('/promotions/preview', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { academicYearId, termId, classId } = req.query;
    if (!academicYearId || !termId || !classId) {
      return res.status(400).json({ error: 'academicYearId, termId, and classId are required' });
    }

    const currentClass = await prisma.class.findFirst({ where: { id: String(classId), schoolId } });
    if (!currentClass) {
      return res.status(404).json({ error: 'Class not found' });
    }

    const pupils = await prisma.pupil.findMany({
      where: { schoolId, classId: String(classId), isActive: true },
      include: { class: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });

    const classes = await prisma.class.findMany({
      where: { schoolId },
      orderBy: [{ phase: 'asc' }, { name: 'asc' }],
    });

    res.json({
      academicYearId: String(academicYearId),
      termId: String(termId),
      classId: String(classId),
      class: currentClass,
      pupils: pupils.map((pupil) => ({
        id: pupil.id,
        firstName: pupil.firstName,
        lastName: pupil.lastName,
        admissionNo: pupil.admissionNo,
        currentClassId: pupil.classId,
        currentClassName: pupil.class?.name || null,
        promotionDecision: null,
        promotionToClassId: null,
        rationale: null,
      })),
      classes,
    });
  } catch (error) {
    console.error('Error previewing promotions:', error);
    res.status(500).json({ error: 'Failed to preview promotions' });
  }
});

// POST /api/admin/promotions/apply - Apply promotion decisions for pupils
router.post('/promotions/apply', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { academicYearId, termId, fromClassId, decisions } = req.body;
    if (!academicYearId || !termId || !fromClassId || !Array.isArray(decisions) || decisions.length === 0) {
      return res.status(400).json({ error: 'academicYearId, termId, fromClassId and decisions are required' });
    }

    const currentClass = await prisma.class.findFirst({ where: { id: String(fromClassId), schoolId } });
    if (!currentClass) {
      return res.status(404).json({ error: 'Class not found' });
    }

    const pupilIds = decisions.map((item: any) => String(item.pupilId));
    const pupils = await prisma.pupil.findMany({ where: { id: { in: pupilIds }, schoolId } });
    const pupilsById = Object.fromEntries(pupils.map((p) => [p.id, p]));

    if (pupils.length !== pupilIds.length) {
      return res.status(400).json({ error: 'One or more pupils were not found' });
    }

    const validClassIds = decisions
      .map((item: any) => item.toClassId)
      .filter(Boolean)
      .map(String);

    const targetClasses = validClassIds.length
      ? await prisma.class.findMany({ where: { id: { in: validClassIds }, schoolId } })
      : [];
    const targetClassIds = new Set(targetClasses.map((c) => c.id));

    for (const decision of decisions) {
      if (!['PROMOTED', 'REPEATED', 'TRANSFERRED', 'GRADUATED'].includes(decision.decision)) {
        return res.status(400).json({ error: `Invalid decision: ${decision.decision}` });
      }
      if (['PROMOTED', 'TRANSFERRED'].includes(decision.decision) && !decision.toClassId) {
        return res.status(400).json({ error: 'toClassId is required for promoted or transferred pupils' });
      }
      if (decision.toClassId && !targetClassIds.has(String(decision.toClassId))) {
        return res.status(400).json({ error: `Invalid toClassId: ${decision.toClassId}` });
      }
    }

    const decidedBy = (await resolveUserName(req)) || 'Unknown';
    const decidedAt = new Date();

    await prisma.$transaction(async (tx) => {
      await Promise.all(decisions.map(async (decision: any) => {
        const pupil = pupilsById[decision.pupilId];
        const toClassId = decision.toClassId ? String(decision.toClassId) : null;
        let nextClassId: string | null = pupil.classId;

        if (decision.decision === 'PROMOTED' || decision.decision === 'TRANSFERRED') {
          nextClassId = toClassId;
        } else if (decision.decision === 'GRADUATED') {
          nextClassId = null;
        }

        await tx.pupil.update({
          where: { id: pupil.id },
          data: { classId: nextClassId },
        });

        await tx.promotionRecord.create({
          data: {
            schoolId,
            pupilId: pupil.id,
            fromClassId: String(fromClassId),
            toClassId,
            academicYearId: String(academicYearId),
            termId: String(termId),
            decision: decision.decision,
            rationale: decision.rationale || null,
            decidedBy,
            decidedAt,
          },
        });

        await tx.studentTermSummary.updateMany({
          where: { pupilId: pupil.id, termId: String(termId) },
          data: {
            promotionDecision: decision.decision,
            promotionToClass: toClassId,
            promotionDecidedBy: decidedBy,
            promotionDecidedAt: decidedAt,
          },
        });
      }));
    });

    res.json({ success: true, appliedCount: decisions.length });
  } catch (error) {
    console.error('Error applying promotions:', error);
    res.status(500).json({ error: 'Failed to apply promotions' });
  }
});

// GET /api/admin/promotions/history - Get promotion history records
router.get('/promotions/history', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { academicYearId, termId, classId, pupilId } = req.query;
    const where: any = { schoolId };
    if (academicYearId) where.academicYearId = String(academicYearId);
    if (termId) where.termId = String(termId);
    if (pupilId) where.pupilId = String(pupilId);
    if (classId) where.fromClassId = String(classId);

    const records = await prisma.promotionRecord.findMany({
      where,
      orderBy: { decidedAt: 'desc' },
    });

    const pupilIds = [...new Set(records.map((record) => record.pupilId))];
    const classIds = [...new Set(
      records.flatMap((record) => [record.fromClassId, record.toClassId]).filter((id): id is string => typeof id === 'string')
    )];

    const [pupils, classes] = await Promise.all([
      prisma.pupil.findMany({ where: { id: { in: pupilIds } } }),
      prisma.class.findMany({ where: { id: { in: classIds } } }),
    ]);

    const pupilsById = Object.fromEntries(pupils.map((p) => [p.id, p]));
    const classesById = Object.fromEntries(classes.map((c) => [c.id, c]));

    res.json({
      records: records.map((record) => ({
        id: record.id,
        pupilId: record.pupilId,
        pupilName: `${pupilsById[record.pupilId]?.firstName || ''} ${pupilsById[record.pupilId]?.lastName || ''}`.trim(),
        fromClassId: record.fromClassId,
        fromClassName: classesById[record.fromClassId]?.name || null,
        toClassId: record.toClassId,
        toClassName: record.toClassId ? classesById[record.toClassId]?.name || null : null,
        decision: record.decision,
        rationale: record.rationale,
        decidedBy: record.decidedBy,
        decidedAt: record.decidedAt,
      })),
    });
  } catch (error) {
    console.error('Error fetching promotion history:', error);
    res.status(500).json({ error: 'Failed to fetch promotion history' });
  }
});

// GET /api/admin/teachers/data - Get teachers, classes, and subjects for client-side rendering
router.get('/teachers/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const [classes, subjects, teachers] = await Promise.all([
      prisma.class.findMany({
        where: { schoolId },
        orderBy: { name: 'asc' },
      }),
      prisma.subject.findMany({
        where: { schoolId },
        orderBy: { name: 'asc' },
      }),
      prisma.user.findMany({
        where: { schoolId, role: { in: ['TEACHER', 'BURSAR'] } },
        orderBy: { name: 'asc' },
        include: {
          teacherClasses: { include: { class: true } },
          teacherSubjects: { include: { subject: true } },
        },
      }),
    ]);

    res.json({ classes, subjects, teachers });
  } catch (error) {
    console.error('Error fetching teachers data:', error);
    res.status(500).json({ error: 'Failed to fetch teachers data' });
  }
});

// GET /api/admin/results/data - Get assessments for client-side rendering
router.get('/results/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const currentAcademicYear = await prisma.academicYear.findFirst({
      where: { schoolId, isCurrent: true },
      select: { id: true, name: true },
    });

    const academicYears = await prisma.academicYear.findMany({
      where: { schoolId },
      select: { id: true, name: true, isCurrent: true },
      orderBy: [{ isCurrent: 'desc' }, { name: 'asc' }],
    });

    const assessments = await prisma.assessment.findMany({
      where: { schoolId },
      include: {
        _count: { select: { results: true } },
        term: {
          include: {
            academicYear: {
              select: {
                id: true,
                name: true,
                isCurrent: true,
              },
            },
          },
        },
        results: { select: { lockedAt: true } },
      },
      orderBy: [{ phase: 'asc' }, { createdAt: 'desc' }],
    });

    const sortedAssessments = [...assessments].sort((a, b) => {
      const aIsCurrent = a.term?.academicYear?.isCurrent === true;
      const bIsCurrent = b.term?.academicYear?.isCurrent === true;

      if (aIsCurrent !== bIsCurrent) {
        return Number(bIsCurrent) - Number(aIsCurrent);
      }

      const aTermOrder = a.term?.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bTermOrder = b.term?.sortOrder ?? Number.MAX_SAFE_INTEGER;

      if (aTermOrder !== bTermOrder) {
        return aTermOrder - bTermOrder;
      }

      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    res.json({
      assessments: sortedAssessments.map((assessment) => ({
        ...assessment,
        isLocked: assessment.results.some((result) => result.lockedAt !== null),
        canEdit: assessment.status === 'DRAFT' && !assessment.results.some((result) => result.lockedAt !== null),
        sessionName: assessment.term?.academicYear?.name ?? null,
      })),
      sessions: academicYears.map((academicYear) => ({
        id: academicYear.id,
        name: academicYear.name,
        isCurrent: academicYear.isCurrent,
      })),
    });
  } catch (error) {
    console.error('Error fetching results data:', error);
    res.status(500).json({ error: 'Failed to fetch results data' });
  }
});

// GET /api/admin/subjects/data - Get subjects, classes, and related data
router.get('/subjects/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const [subjects, classes, subjectClasses, teacherSubjects] = await Promise.all([
      prisma.subject.findMany({ where: { schoolId }, orderBy: { name: 'asc' } }),
      prisma.class.findMany({ where: { schoolId }, orderBy: { name: 'asc' } }),
      prisma.subjectClass.findMany({ where: { schoolId }, include: { class: true } }),
      prisma.teacherSubject.findMany({ where: { schoolId }, include: { teacher: true } }),
    ]);

    res.json({ subjects, classes, subjectClasses, teacherSubjects });
  } catch (error) {
    console.error('Error fetching subjects data:', error);
    res.status(500).json({ error: 'Failed to fetch subjects data' });
  }
});

// GET /api/admin/teacher-assignments/data - Get teacher assignments data
router.get('/teacher-assignments/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const [teachers, classes, subjects] = await Promise.all([
      prisma.user.findMany({
        where: { schoolId, role: 'TEACHER' },
        include: {
          teacherClasses: { include: { class: true } },
          teacherSubjects: { include: { subject: true } },
        },
        orderBy: { name: 'asc' },
      }),
      prisma.class.findMany({
        where: { schoolId },
        orderBy: { name: 'asc' },
      }),
      prisma.subject.findMany({
        where: { schoolId },
        orderBy: { name: 'asc' },
      }),
    ]);

    res.json({ teachers, classes, subjects });
  } catch (error) {
    console.error('Error fetching teacher-assignments data:', error);
    res.status(500).json({ error: 'Failed to fetch teacher-assignments data' });
  }
});

// GET /api/admin/website/data - Get website announcements
router.get('/website/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const announcements = await prisma.announcement.findMany({
      where: { schoolId },
      orderBy: { publishedAt: 'desc' },
      include: {
        academicYear: true,
        term: { include: { academicYear: true } },
      },
    });

    res.json({ announcements });
  } catch (error) {
    console.error('Error fetching website data:', error);
    res.status(500).json({ error: 'Failed to fetch website data' });
  }
});

// GET /api/admin/support/data - Get support requests
router.get('/support/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const supportRequests = await prisma.supportRequest.findMany({
      where: { schoolId },
      orderBy: { createdAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'asc' } } } as any,
    });

    const school = await prisma.school.findUnique({ where: { id: schoolId } });

    res.json({ 
      supportRequests: (supportRequests as any[]).map((request) => {
        const messages = ((request as any).messages || []).map((message: any) => {
          const isSchoolMessage = message.senderRole === 'SCHOOL';
          const normalizedSenderName = typeof message.senderName === 'string' ? message.senderName.trim() : '';
          const senderName = isSchoolMessage
            ? (school?.name || normalizedSenderName || 'School')
            : 'SchoolBase Support';

          return {
            id: message.id,
            senderRole: message.senderRole,
            senderName,
            senderEmail: message.senderEmail,
            body: message.body,
            createdAt: message.createdAt.toISOString(),
          };
        });

        if (request.response && !messages.some((message: any) => message.body === request.response)) {
          messages.push({
            id: `${request.id}-response`,
            senderRole: 'PLATFORM_ADMIN',
            senderName: 'SchoolBase Support',
            senderEmail: null,
            body: request.response,
            createdAt: request.updatedAt.toISOString(),
          });
        }

        return {
          id: request.id,
          subject: request.subject,
          message: request.message,
          response: request.response,
          status: request.status,
          priority: request.priority,
          createdAt: request.createdAt.toISOString(),
          updatedAt: request.updatedAt.toISOString(),
          messages,
          school: {
            id: schoolId,
            name: school?.name,
            country: school?.country,
          },
        };
      }),
    });
  } catch (error) {
    console.error('Error fetching support data:', error);
    res.status(500).json({ error: 'Failed to fetch support data' });
  }
});

// POST /api/admin/support - Create support request
router.post('/support', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { subject, message, priority = 'MEDIUM' } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message are required' });
    }

    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { id: true, name: true, country: true, email: true } });

    const supportRequest = await prisma.$transaction(async (tx) => {
      const createdRequest = await tx.supportRequest.create({
        data: {
          schoolId,
          subject,
          message,
          priority,
          status: 'OPEN',
        },
      });

      await tx.supportRequestMessage.create({
        data: {
          supportRequestId: createdRequest.id,
          senderRole: 'SCHOOL',
          senderName: school?.name || 'School',
          senderEmail: null,
          body: createdRequest.message,
        },
      });

      return createdRequest;
    });

    try {
      const { sendSupportRequestNotification } = await import('../services/email.js');
      sendSupportRequestNotification(
        supportRequest.id,
        supportRequest.subject,
        supportRequest.message,
        school?.name,
        school?.email,
      )
        .then(() => console.log('Support request notification queued'))
        .catch((err) => console.warn('Support request notification failed (non-blocking):', err));
    } catch (err) {
      console.warn('Could not import email service for support request notification:', err);
    }

    res.status(201).json({ 
      supportRequest: {
        id: supportRequest.id,
        subject: supportRequest.subject,
        message: supportRequest.message,
        response: supportRequest.response,
        status: supportRequest.status,
        priority: supportRequest.priority,
        createdAt: supportRequest.createdAt.toISOString(),
        updatedAt: supportRequest.updatedAt.toISOString(),
        messages: [{
          id: `${supportRequest.id}-initial`,
          senderRole: 'SCHOOL',
          senderName: school?.name || 'School',
          senderEmail: null,
          body: supportRequest.message,
          createdAt: supportRequest.createdAt.toISOString(),
        }],
        school: school ? {
          id: school.id,
          name: school.name,
          country: school.country,
        } : null,
      },
      message: 'Support request created successfully'
    });
  } catch (error) {
    console.error('Error creating support request:', error);
    res.status(500).json({ error: 'Failed to create support request' });
  }
});

// PATCH /api/admin/support/reply - Reply to support request
router.patch('/support/reply', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { requestId, response: responseText } = req.body;

    if (!requestId || !responseText) {
      return res.status(400).json({ error: 'Request ID and response are required' });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true, name: true, country: true },
    });

    // Verify the support request belongs to this school
    const supportRequest = await prisma.supportRequest.findFirst({
      where: { id: requestId, schoolId },
    });

    if (!supportRequest) {
      return res.status(404).json({ error: 'Support request not found' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.supportRequest.update({
        where: { id: requestId },
        data: {
          response: responseText,
          status: 'IN_PROGRESS',
          updatedAt: new Date(),
        },
      });

      await tx.supportRequestMessage.create({
        data: {
          supportRequestId: requestId,
          senderRole: 'SCHOOL',
          senderName: school?.name || 'School',
          senderEmail: null,
          body: responseText,
        },
      });

      return tx.supportRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { messages: { orderBy: { createdAt: 'asc' } } } as any,
      });
    });

    const messages = ((updated.messages || []).map((message: any) => {
      const isSchoolMessage = message.senderRole === 'SCHOOL';
      const normalizedSenderName = typeof message.senderName === 'string' ? message.senderName.trim() : '';
      const senderName = isSchoolMessage
        ? (school?.name || normalizedSenderName || 'School')
        : 'SchoolBase Support';

      return {
        id: message.id,
        senderRole: message.senderRole,
        senderName,
        senderEmail: message.senderEmail,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      };
    }));

    res.json({ 
      supportRequest: {
        id: updated.id,
        subject: updated.subject,
        message: updated.message,
        response: updated.response,
        status: updated.status,
        priority: updated.priority,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
        messages,
        school: null,
      },
      message: 'Reply sent successfully'
    });
  } catch (error) {
    console.error('Error replying to support request:', error);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// GET /api/admin/attendance/data - Get attendance data for client-side rendering
router.get('/attendance/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const classes = await prisma.class.findMany({
      where: { schoolId },
      orderBy: { name: 'asc' },
    });

    res.json({ classes });
  } catch (error) {
    console.error('Error fetching attendance data:', error);
    res.status(500).json({ error: 'Failed to fetch attendance data' });
  }
});

// GET /api/admin/notifications/data - Get notifications list
router.get('/notifications/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const notifications = await prisma.notification.findMany({
      where: { schoolId },
      include: { guardian: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const stats = {
      total: notifications.length,
      sent: notifications.filter((n: any) => n.status === 'SENT').length,
      failed: notifications.filter((n: any) => n.status === 'FAILED').length,
      pending: notifications.filter((n: any) => n.status === 'PENDING').length,
    };

    res.json({ notifications, stats });
  } catch (error) {
    console.error('Error fetching notifications data:', error);
    res.status(500).json({ error: 'Failed to fetch notifications data' });
  }
});

// GET /api/admin/analytics/data - Get school analytics
router.get('/analytics/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const termId = req.query.termId as string | undefined;
    const phaseQuery = req.query.phase as string | undefined;
    const selectedClassId = (req.query.classId as string | undefined) || (req.query.sectionId as string | undefined);
    
    console.log('[ANALYTICS] Received termId:', termId, 'phase:', phaseQuery, 'classId:', selectedClassId);
    
    // Build filter for assessments
    const assessmentWhere: any = {
      schoolId,
      status: {
        in: ['APPROVED', 'PUBLISHED', 'ARCHIVED'],
      },
    };
    
    if (phaseQuery && phaseQuery !== 'ALL') {
      assessmentWhere.phase = phaseQuery;
    }

    if (termId) {
      assessmentWhere.termId = termId;
    }

    if (selectedClassId) {
      assessmentWhere.classId = selectedClassId;
    }

    console.log('[ANALYTICS] assessmentWhere filter:', JSON.stringify(assessmentWhere));

    // Fetch published assessments for the selected term and phase
    const assessments = await prisma.assessment.findMany({
      where: assessmentWhere,
      select: { id: true, classId: true },
    });
    
    console.log('[ANALYTICS] Found assessments:', assessments.length);

    const assessmentIds = assessments.map((a) => a.id);
    const classIds = [...new Set(assessments.map((a) => a.classId).filter(Boolean))] as string[];

    // Fetch classes for display
    // If a specific class is selected, return that class
    // Otherwise, return all school classes (so user can see available classes even if no assessments exist)
    const classes = selectedClassId
      ? await prisma.class.findMany({
          where: {
            schoolId,
            id: selectedClassId,
          },
          select: {
            id: true,
            name: true,
            phase: true,
          },
          orderBy: { name: 'asc' },
        })
      : await prisma.class.findMany({
          where: {
            schoolId,
          },
          select: {
            id: true,
            name: true,
            phase: true,
          },
          orderBy: { name: 'asc' },
        });

    // Get all subjects for the school
    // First, get all results for the selected assessments
    const allResults = await prisma.result.findMany({
      where: {
        assessmentId: { in: assessmentIds },
      },
      select: { subjectId: true },
      distinct: ['subjectId'],
    });

    const subjectIds = allResults
      .map(r => r.subjectId)
      .filter(Boolean) as string[];

    // Fetch only subjects that have results in the selected term/phase/class
    const subjects = subjectIds.length > 0
      ? await prisma.subject.findMany({
          where: {
            schoolId,
            id: { in: subjectIds },
          },
          orderBy: { name: 'asc' },
        })
      : [];

    // Fetch results for these assessments (for analytics calculation)
    const results = await prisma.result.findMany({
      where: {
        assessmentId: { in: assessmentIds },
        OR: [
          { publishedAt: { not: null } },
          { totalScore: { not: null } },
          { grade: { not: null } },
        ],
      },
      include: {
        pupil: true,
      },
    });

    // Calculate grade distribution
    const gradeDistribution: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };

    results.forEach((result: any) => {
      // Calculate grade from score (assuming 40+ is pass)
      const score = result.totalScore || 0;
      let grade = 'F';
      if (score >= 90) grade = 'A';
      else if (score >= 80) grade = 'B';
      else if (score >= 70) grade = 'C';
      else if (score >= 60) grade = 'D';
      else if (score >= 40) grade = 'E';

      gradeDistribution[grade]++;
    });

    const schoolAverage = results.length > 0 
      ? (results.reduce((sum: number, r: any) => sum + (r.totalScore || 0), 0) / results.length) 
      : 0;

    const passCount = results.filter((r: any) => (r.totalScore || 0) >= 40).length;
    const passRate = results.length > 0 ? (passCount / results.length) * 100 : 0;

    // Get top performers and struggling students
    const sortedResults = [...results].sort((a: any, b: any) => (b.totalScore || 0) - (a.totalScore || 0));
    const topPerformers = sortedResults.slice(0, 10).map((r: any) => {
      const pupilName = r.pupil ? `${r.pupil.firstName} ${r.pupil.lastName}`.trim() : 'Unknown';
      return {
        name: pupilName,
        score: r.totalScore || 0,
      };
    });

    const strugglingStudents = sortedResults.slice(-10).map((r: any) => {
      const pupilName = r.pupil ? `${r.pupil.firstName} ${r.pupil.lastName}`.trim() : 'Unknown';
      return {
        name: pupilName,
        score: r.totalScore || 0,
      };
    }).reverse();

    res.json({
      schoolAnalytics: {
        schoolAverage: Math.round(schoolAverage * 10) / 10,
        passRate: Math.round(passRate * 10) / 10,
        totalResults: results.length,
        gradeDistribution,
        topPerformers,
        strugglingStudents,
      },
      classes,
      subjects,
    });
  } catch (error) {
    console.error('Error fetching analytics data:', error);
    res.status(500).json({ error: 'Failed to fetch analytics data' });
  }
});

// GET /api/admin/communications/rules - Get communication rules for the current school
router.get('/communications/rules', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    res.json({
      success: true,
      rules: communicationRulesRegistry.getRules(schoolId),
    });
  } catch (error) {
    console.error('Error fetching communication rules:', error);
    res.status(500).json({ error: 'Failed to fetch communication rules' });
  }
});

// GET /api/admin/communications/whatsapp-policy - Get WhatsApp safety policy
router.get('/communications/whatsapp-policy', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });
    const policy = await readSchoolWhatsAppPolicy(prisma, schoolId);
    res.json({ success: true, policy: getPersistedSchoolWhatsAppPolicyRecord(policy) });
  } catch (error) {
    console.error('Error fetching WhatsApp policy:', error);
    res.status(500).json({ error: 'Failed to fetch WhatsApp policy' });
  }
});

// PUT /api/admin/communications/whatsapp-policy - Update WhatsApp safety policy
router.put('/communications/whatsapp-policy', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });
    const current = await readSchoolWhatsAppPolicy(prisma, schoolId);
    const body = req.body || {};
    const numeric = (value: unknown, fallback: number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
    };
    const data = {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
      messagesPerMinute: numeric(body.messagesPerMinute, current.messagesPerMinute),
      messagesPerHour: numeric(body.messagesPerHour, current.messagesPerHour),
      messagesPerDay: numeric(body.messagesPerDay, current.messagesPerDay),
      batchSize: Math.max(1, numeric(body.batchSize, current.batchSize)),
      batchCooldownSeconds: numeric(body.batchCooldownSeconds, current.batchCooldownSeconds),
      quietHoursStart: typeof body.quietHoursStart === 'string' ? body.quietHoursStart : current.quietHoursStart,
      quietHoursEnd: typeof body.quietHoursEnd === 'string' ? body.quietHoursEnd : current.quietHoursEnd,
      requireApprovalForBulk: typeof body.requireApprovalForBulk === 'boolean' ? body.requireApprovalForBulk : current.requireApprovalForBulk,
      allowAutomaticRetries: typeof body.allowAutomaticRetries === 'boolean' ? body.allowAutomaticRetries : current.allowAutomaticRetries,
      timezone: typeof body.timezone === 'string' ? body.timezone : current.timezone,
    };
    const policy = await prisma.whatsAppPolicy.upsert({
      where: { schoolId },
      create: { schoolId, ...data },
      update: data,
    });
    res.json({ success: true, policy });
  } catch (error) {
    console.error('Error updating WhatsApp policy:', error);
    res.status(500).json({ error: 'Failed to update WhatsApp policy' });
  }
});

// PUT /api/admin/communications/rules - Update communication rules for the current school
router.put('/communications/rules', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { event, enabled } = req.body as { event?: string; enabled?: boolean };
    if (!event || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'event and enabled are required' });
    }

    communicationRulesRegistry.setRuleEnabled(schoolId, event, enabled);
    res.json({ success: true, rules: communicationRulesRegistry.getRules(schoolId) });
  } catch (error) {
    console.error('Error updating communication rules:', error);
    res.status(500).json({ error: 'Failed to update communication rules' });
  }
});

// GET /api/admin/whatsapp/data - Get WhatsApp delivery status
router.get('/whatsapp/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    res.json({
      deliveries: [],
      successCount: 0,
      failureCount: 0,
      session: baileysSessionManager.getStatus(schoolId),
      queue: sharedDeliveryQueue.getQueueSummary(),
    });
  } catch (error) {
    console.error('Error fetching whatsapp data:', error);
    res.status(500).json({ error: 'Failed to fetch whatsapp data' });
  }
});

// POST /api/admin/whatsapp/connect - Establish a WPPConnect session for the current school
router.post('/whatsapp/connect', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const status = await baileysSessionManager.connect(schoolId);
    res.json({ success: true, session: status });
  } catch (error) {
    console.error('Error connecting whatsapp:', error);
    res.status(500).json({ error: 'Failed to connect WhatsApp' });
  }
});

// GET /api/admin/whatsapp/queue - Get pending WhatsApp delivery retry queue
router.get('/whatsapp/queue', requireSubscription, async (req: Request, res: Response) => {
  try {
    res.json({ success: true, queue: sharedDeliveryQueue.getQueueSummary() });
  } catch (error) {
    console.error('Error fetching whatsapp queue:', error);
    res.status(500).json({ error: 'Failed to fetch WhatsApp queue' });
  }
});

// POST /api/admin/whatsapp/retry - Retry a manual WhatsApp message or queued item
router.post('/whatsapp/retry', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { phoneNumber, message, recipientName = 'Guardian' } = req.body;
    if (!phoneNumber || !message) {
      return res.status(400).json({ error: 'phoneNumber and message required' });
    }

    const communicationService = createCommunicationService();
    const dispatchResult = await communicationService.dispatch({
      event: 'WhatsAppRetry',
      schoolId,
      recipients: [{ channel: 'WHATSAPP', address: phoneNumber, name: recipientName }],
      body: message,
      data: { recipientName, schoolName: 'SchoolBase' },
    });

    res.json({
      success: dispatchResult.success,
      result: dispatchResult,
    });
  } catch (error) {
    console.error('Error retrying WhatsApp message:', error);
    res.status(500).json({ error: 'Failed to retry WhatsApp message' });
  }
});

// POST /api/admin/whatsapp/disconnect - End the WPPConnect session for the current school
router.post('/whatsapp/disconnect', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const status = await baileysSessionManager.disconnect(schoolId);
    res.json({ success: true, session: status });
  } catch (error) {
    console.error('Error disconnecting whatsapp:', error);
    res.status(500).json({ error: 'Failed to disconnect WhatsApp' });
  }
});

// GET /api/admin/whatsapp-baileys/status - Get Baileys WhatsApp session status for the current school
router.get('/whatsapp-baileys/status', requireSubscription, async (req: Request, res: Response) => {
  try {
    console.log('[Baileys Status] Getting status...');
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });
    const status = baileysSessionManager.getStatus(schoolId);
    console.log('[Baileys Status] Status retrieved for', schoolId, status);
    res.json({ success: true, session: status });
  } catch (error) {
    console.error('Error fetching Baileys whatsapp status:', error);
    res.status(500).json({ error: 'Failed to fetch Baileys WhatsApp status' });
  }
});

// POST /api/admin/whatsapp-baileys/connect - Start a minimal Baileys session
router.post('/whatsapp-baileys/connect', requireSubscription, async (req: Request, res: Response) => {
  try {
    const pairingPhoneNumber = typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber : undefined;
    const usePairingCode = Boolean(req.body?.usePairingCode);
    console.log('[Baileys Connect] Starting connection...', { pairingPhoneNumber, usePairingCode });
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });
    const status = await baileysSessionManager.connect(schoolId, pairingPhoneNumber, usePairingCode);
    console.log('[Baileys Connect] Connection status for', schoolId, status);
    res.json({ success: true, session: status });
  } catch (error) {
    console.error('Error connecting Baileys whatsapp:', error);
    res.status(500).json({ error: 'Failed to connect Baileys WhatsApp' });
  }
});

// POST /api/admin/whatsapp-baileys/debug - Run a one-off Baileys diagnostic probe
router.post('/whatsapp-baileys/debug', requireSubscription, async (req: Request, res: Response) => {
  try {
    const result = await baileysSessionManager.runDeepDebugProbe();
    res.json({ success: true, result });
  } catch (error) {
    console.error('Error running Baileys debug probe:', error);
    res.status(500).json({ error: 'Failed to run Baileys debug probe' });
  }
});

// POST /api/admin/whatsapp-baileys/send-message - Send a test message using Baileys
router.post('/whatsapp-baileys/send-message', requireSubscription, async (req: Request, res: Response) => {
  try {
    const { phoneNumber, phoneNumbers, message } = req.body;
    const recipients = Array.isArray(phoneNumbers) ? phoneNumbers : phoneNumber ? [phoneNumber] : [];

    if (!recipients.length || !message) {
      return res.status(400).json({ error: 'phoneNumber(s) and message required' });
    }

    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    // Append school signature/details automatically for admin-sent test messages
    let finalMessage = message;
    try {
      const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { name: true, phone: true, email: true } });
      if (school) {
        const parts = [] as string[];
        if (school.name) parts.push(String(school.name));
        if (school.phone) parts.push(String(school.phone));
        if (school.email) parts.push(String(school.email));
        if (parts.length > 0 && !String(message || '').includes(parts[0])) {
          finalMessage = `${String(message || '')}\n\n— ${parts.join(' | ')}`;
        }
      }
    } catch (e) {
      console.warn('[Baileys Send] Failed to load school details for signature', e);
    }

    const result = await baileysSessionManager.sendTextMessages(schoolId, recipients, finalMessage);
    if (!result.success) {
      return res.status(400).json({ success: false, error: 'One or more recipients failed', results: result.results });
    }

    res.json({ success: true, results: result.results });
  } catch (error) {
    console.error('Error sending Baileys whatsapp message:', error);
    res.status(500).json({ error: 'Failed to send Baileys WhatsApp message' });
  }
});

// POST /api/admin/whatsapp-baileys/disconnect - Disconnect Baileys session
router.post('/whatsapp-baileys/disconnect', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });
    const status = await baileysSessionManager.disconnect(schoolId);
    res.json({ success: true, session: status });
  } catch (error) {
    console.error('Error disconnecting Baileys whatsapp:', error);
    res.status(500).json({ error: 'Failed to disconnect Baileys WhatsApp' });
  }
});

// GET /api/admin/subscribe/data - Get subscription data
router.get('/subscribe/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
    });

    res.json({
      school: {
        id: school?.id,
        name: school?.name,
        country: school?.country,
        slug: school?.slug,
      },
      session: {
        name: 'Administrator',
        email: '',
      },
    });
  } catch (error) {
    console.error('Error fetching subscribe data:', error);
    res.status(500).json({ error: 'Failed to fetch subscribe data' });
  }
});

// GET /api/admin/school/:schoolId/setup-status - Get school setup completion status
router.get('/school/:schoolId/setup-status', async (req: Request, res: Response) => {
  try {
    const { schoolId } = req.params;

    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    if ((await resolvePathSchoolId(req, schoolId)) !== schoolId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        id: true,
        name: true,
        country: true,
        currency: true,
        address: true,
        city: true,
        phone: true,
        email: true,
        logoUrl: true,
        principalName: true,
        principalComment: true,
        principalSignatureUrl: true,
        stampUrl: true,
        manualPaymentAccountName: true,
        manualPaymentAccountNumber: true,
        manualPaymentBankName: true,
        paystackPublicEncrypted: true,
        paystackSecretEncrypted: true,
      },
    });

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    const [
      enabledPhases,
      academicYears,
      classes,
      subjects,
      teacherClasses,
      feeSchedules,
      pupils,
      announcements,
      assessments,
    ] = await Promise.all([
      prisma.schoolOnPhase.count({ where: { schoolId } }),
      prisma.academicYear.count({ where: { schoolId } }),
      prisma.class.count({ where: { schoolId } }),
      prisma.subject.count({ where: { schoolId } }),
      prisma.teacherClass.count({ where: { schoolId } }),
      prisma.feeSchedule.count({ where: { schoolId } }),
      prisma.pupil.count({ where: { schoolId, isActive: true } }),
      prisma.announcement.count({ where: { schoolId } }),
      prisma.assessment.count({ where: { schoolId } }),
    ]);

    const result = buildSchoolSetupStatus({
      school,
      counts: {
        enabledPhases,
        academicYears,
        classes,
        subjects,
        teacherClasses,
        feeSchedules,
        students: pupils,
        announcements,
        assessments,
      },
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching setup status:', error);
    res.status(500).json({ error: 'Failed to fetch setup status' });
  }
});

// ============== RESULTS/ASSESSMENTS MANAGEMENT ==============

// GET /api/admin/terms - Fetch available terms for current academic year
router.get('/terms', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);

    if (!schoolId) {
      return res.status(401).json({ error: 'School ID required' });
    }

    const terms = await prisma.term.findMany({
      where: {
        academicYear: {
          schoolId,
        },
      },
      orderBy: [
        { academicYear: { isCurrent: 'desc' } },
        { academicYear: { createdAt: 'desc' } },
        { sortOrder: 'asc' },
        { name: 'asc' },
      ],
      select: {
        id: true,
        name: true,
        sortOrder: true,
        academicYearId: true,
        academicYear: {
          select: {
            isCurrent: true,
          },
        },
      },
    });

    const normalizedTerms = terms.map((term) => ({
      id: term.id,
      name: term.name,
      sortOrder: term.sortOrder,
      academicYearId: term.academicYearId,
      isCurrent: term.academicYear?.isCurrent ?? false,
    }));

    res.json({ terms: normalizedTerms });
  } catch (error) {
    console.error('Error fetching terms:', error);
    res.status(500).json({ error: 'Failed to fetch terms' });
  }
});

// GET /api/admin/results/{id} - Fetch single assessment with results
router.get('/results/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId) {
      return res.status(401).json({ error: 'School ID required' });
    }

    const assessment = await prisma.assessment.findFirst({
      where: { id, schoolId },
      include: {
        term: {
          include: {
            academicYear: {
              select: {
                id: true,
                name: true,
                isCurrent: true,
              },
            },
          },
        },
        results: {
          include: {
            pupil: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                admissionNo: true,
                isActive: true,
                status: true,
                class: {
                  select: {
                    id: true,
                    name: true,
                    arm: true,
                    phase: true,
                  },
                },
              },
            },
            subjectRef: true,
          },
        },
        _count: { select: { results: true } },
      },
    });

    if (!assessment) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    const activeAssessmentResults = assessment.results.filter((result) =>
      filterActiveStudents([
        {
          isActive: result.pupil?.isActive ?? true,
          status: result.pupil?.status ?? null,
        },
      ]).length > 0
    );

    // Transform results to include full name
    const transformedResults = activeAssessmentResults.map((r) => ({
      ...r,
      pupil: {
        ...r.pupil,
        name: `${r.pupil.firstName} ${r.pupil.lastName}`.trim(),
      },
    }));

    // Third term historical totals support
    let thirdTermHistory = null;
    const currentTerm = assessment.term;
    if (currentTerm?.sortOrder === 3 && currentTerm.academicYear?.id) {
      const previousTerms = await prisma.term.findMany({
        where: {
          academicYearId: currentTerm.academicYear.id,
          sortOrder: { in: [1, 2] },
        },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          name: true,
          sortOrder: true,
        },
      });

      if (previousTerms.length > 0) {
        const buildSubjectKey = (subjectId: string | null, subject: string | null) =>
          subjectId ? `id:${subjectId}` : `name:${subject?.trim().toLowerCase() ?? ''}`;

        const previousResults = await prisma.result.findMany({
          where: {
            assessment: {
              termId: { in: previousTerms.map((term) => term.id) },
              status: 'PUBLISHED',
              schoolId,
            },
            pupilId: { in: transformedResults.map((result) => result.pupil.id) },
          },
          include: {
            assessment: {
              select: {
                id: true,
                term: {
                  select: {
                    id: true,
                    name: true,
                    sortOrder: true,
                  },
                },
              },
            },
            pupil: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                admissionNo: true,
              },
            },
          },
        });

        const publishedTermData = new Map<string, {
          totalScore: number;
          examScore: number;
          totalCount: number;
          examCount: number;
        }>();

        previousResults.forEach((previousResult) => {
          const pupilId = previousResult.pupilId;
          const termSort = previousResult.assessment?.term?.sortOrder;
          if (!termSort) return;

          const subjectKey = buildSubjectKey(previousResult.subjectId ?? null, previousResult.subject ?? null);
          const key = `${pupilId}:${subjectKey}:${termSort}`;
          const existingTermData = publishedTermData.get(key) ?? {
            totalScore: 0,
            examScore: 0,
            totalCount: 0,
            examCount: 0,
          };

          if (typeof previousResult.totalScore === 'number') {
            existingTermData.totalScore += previousResult.totalScore;
            existingTermData.totalCount += 1;
          }

          if (typeof previousResult.examScore === 'number') {
            existingTermData.examScore += previousResult.examScore;
            existingTermData.examCount += 1;
          }

          publishedTermData.set(key, existingTermData);
        });

        const historicalTotals = await (prisma as any).historicalTermTotal.findMany({
          where: {
            schoolId,
            academicYearId: currentTerm.academicYear.id,
            termId: { in: previousTerms.map((term) => term.id) },
            classId: assessment.classId ?? undefined,
            studentId: { in: transformedResults.map((result) => result.pupil.id) },
          },
        });

        const historicalTotalMap = new Map<string, number>();
        historicalTotals.forEach((record: any) => {
          const subjectKey = buildSubjectKey(record.subjectId ?? null, record.subject ?? null);
          historicalTotalMap.set(`${record.studentId}:${record.termId}:${subjectKey}`, record.totalScore);
        });

        const entries = transformedResults.map((result) => {
          const subjectId = result.subjectRef?.id ?? null;
          const subjectName = result.subjectRef?.name ?? result.subject ?? 'General';
          const subjectKey = buildSubjectKey(subjectId, result.subject ?? null);

          return {
            pupilId: result.pupil.id,
            pupilName: result.pupil.name,
            admissionNo: result.pupil.admissionNo ?? null,
            subjectId,
            subjectName,
            terms: previousTerms.map((term) => {
              const publishedKey = `${result.pupil.id}:${subjectKey}:${term.sortOrder}`;
              const publishedTotals = publishedTermData.get(publishedKey);
              let totalScore: number | null = null;
              let examScore: number | null = null;

              if (publishedTotals && publishedTotals.totalCount > 0) {
                totalScore = Math.round(publishedTotals.totalScore);
                examScore = publishedTotals.examCount > 0 ? Math.round(publishedTotals.examScore) : null;
              } else {
                const historyKey = `${result.pupil.id}:${term.id}:${subjectKey}`;
                const historicalScore = historicalTotalMap.get(historyKey);
                if (typeof historicalScore === 'number') {
                  totalScore = Math.round(historicalScore);
                  examScore = null;
                }
              }

              return {
                termId: term.id,
                termName: term.name,
                sortOrder: term.sortOrder,
                totalScore,
                examScore,
              };
            }),
          };
        });

        thirdTermHistory = {
          terms: previousTerms,
          entries,
        };
      }
    }

    // Ensure publishedAt is available at the assessment level.
    const fallbackPublishedAt =
      activeAssessmentResults.find((r: any) => r.publishedAt)?.publishedAt || null;

    res.json({
      ...assessment,
      publishedAt: fallbackPublishedAt,
      results: transformedResults,
      thirdTermHistory,
    });
  } catch (error) {
    console.error('Error fetching assessment:', error);
    res.status(500).json({ error: 'Failed to fetch assessment' });
  }
});

// POST /api/admin/assessments - Create new assessment
router.post('/assessments', requireSubscription, async (req: Request, res: Response) => {
  try {
    const { name, termId, phase } = req.body;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId || !name || !termId || !phase) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify term belongs to school
    const term = await prisma.term.findFirst({
      where: { id: termId, academicYear: { schoolId } },
    });

    if (!term) {
      return res.status(404).json({ error: 'Term not found' });
    }

    const assessment = await prisma.assessment.create({
      data: {
        name,
        termId,
        phase,
        schoolId,
        status: 'DRAFT',
      },
      include: { term: true, _count: { select: { results: true } } },
    });

    res.status(201).json(assessment);
  } catch (error) {
    console.error('Error creating assessment:', error);
    res.status(500).json({ error: 'Failed to create assessment' });
  }
});

// POST /api/admin/results - Enter/update scores for students
router.post('/results', requireSubscription, async (req: Request, res: Response) => {
  try {
    const { assessmentId, entries, subject } = req.body;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId || !assessmentId || !Array.isArray(entries)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    // Verify assessment belongs to school
    const assessment = await prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
    });

    if (!assessment) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    if (assessment.status !== 'DRAFT') {
      return res.status(400).json({ error: 'Cannot edit non-draft assessments' });
    }

    // Upsert results
    const results = await Promise.all(
      entries.map((entry: any) =>
        prisma.result.upsert({
          where: {
            assessmentId_pupilId_subject: {
              assessmentId,
              pupilId: entry.pupilId,
              subject: entry.subject || subject || null,
            },
          },
          update: {
            caScore: entry.caScore,
            testScore: entry.testScore,
            examScore: entry.examScore,
            totalScore: entry.totalScore,
            grade: entry.grade,
            comment: entry.comment,
          },
          create: {
            assessmentId,
            pupilId: entry.pupilId,
            subject: entry.subject || subject || null,
            caScore: entry.caScore,
            testScore: entry.testScore,
            examScore: entry.examScore,
            totalScore: entry.totalScore,
            grade: entry.grade,
            comment: entry.comment,
          },
        })
      )
    );

    res.json({ success: true, count: results.length });
  } catch (error) {
    console.error('Error updating results:', error);
    res.status(500).json({ error: 'Failed to update results' });
  }
});

// GET /api/admin/results/historical-totals - Fetch historical term totals for a class/year/subject/student
router.get('/results/historical-totals', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    const { academicYearId, termId, classId, studentId, subjectId } = req.query;

    if (!schoolId || !academicYearId || !termId || !classId) {
      return res.status(400).json({ error: 'Missing required query parameters' });
    }

    const totals = await (prisma as any).historicalTermTotal.findMany({
      where: {
        schoolId,
        academicYearId: String(academicYearId),
        termId: String(termId),
        classId: String(classId),
        studentId: studentId ? String(studentId) : undefined,
        subjectId: subjectId ? String(subjectId) : undefined,
      },
      include: {
        subjectRef: true,
      },
    });

    res.json({ success: true, totals });
  } catch (error) {
    console.error('Error fetching historical totals:', error);
    res.status(500).json({ error: 'Failed to fetch historical totals' });
  }
});

// POST /api/admin/results/historical-totals - Save or update a historical term total
router.post('/results/historical-totals', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    const entries = Array.isArray(req.body) ? req.body : [req.body];
    const createdBy = (req as any).user?.id || 'SYSTEM';

    if (!schoolId || entries.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const records: any[] = [];

    for (const entry of entries) {
      const { academicYearId, termId, classId, studentId, subjectId, subject, totalScore } = entry;

      if (!academicYearId || !termId || !classId || !studentId || totalScore === undefined) {
        return res.status(400).json({ error: 'Missing required fields for one or more entries' });
      }

      const existing = await (prisma as any).historicalTermTotal.findFirst({
        where: {
          schoolId,
          academicYearId,
          termId,
          classId,
          studentId,
          subjectId: subjectId ?? null,
        },
      });

      const record = existing
        ? await (prisma as any).historicalTermTotal.update({
            where: { id: existing.id },
            data: {
              subject,
              totalScore,
              createdBy,
            },
          })
        : await (prisma as any).historicalTermTotal.create({
            data: {
              schoolId,
              academicYearId,
              termId,
              classId,
              studentId,
              subjectId: subjectId ?? null,
              subject: subject ?? null,
              totalScore,
              createdBy,
            },
          });

      records.push(record);
    }

    res.json({ success: true, totals: records });
  } catch (error) {
    console.error('Error saving historical total:', error);
    res.status(500).json({ error: 'Failed to save historical total' });
  }
});

// POST /api/admin/assessments/{id}/approve - Approve assessment
router.post('/assessments/:id/approve', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId) {
      return res.status(401).json({ error: 'School ID required' });
    }

    const assessment = await prisma.assessment.findFirst({
      where: { id, schoolId },
    });

    if (!assessment) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    if (assessment.status !== 'DRAFT') {
      return res.status(400).json({ error: 'Only draft assessments can be approved' });
    }

    const readiness = await resultsDomain.isReadyForPublish(id, schoolId);
    if (!readiness.ready) {
      return res.status(400).json({
        success: false,
        error: readiness.reason || 'Assessment must be validated before approval',
        details: { reason: readiness.reason },
      });
    }

    const updated = await prisma.assessment.update({
      where: { id },
      data: { status: 'APPROVED' },
      include: { _count: { select: { results: true } } },
    });

    res.json({
      success: true,
      message: 'Assessment approved and ready to publish',
      status: 'APPROVED',
      assessment: updated,
    });
  } catch (error) {
    console.error('Error approving assessment:', error);
    res.status(500).json({ error: 'Failed to approve assessment' });
  }
});

// POST /api/admin/assessments/{id}/publish - Publish results
router.post('/assessments/:id/publish', requireSubscription, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId) {
      return res.status(401).json({ error: 'School ID required' });
    }

    const assessment = await prisma.assessment.findFirst({
      where: { id, schoolId },
    });

    if (!assessment) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    if (assessment.status !== 'APPROVED') {
      return res.status(400).json({ error: 'Only approved assessments can be published' });
    }

    const userId = (req as any).user?.id || 'SYSTEM';

    // Check readiness first so we can return validation details to the client
    const readiness = await resultsDomain.isReadyForPublish(id, schoolId);
    if (!readiness.ready) {
      return res.status(400).json({ error: readiness.reason || 'Not ready to publish', details: { reason: readiness.reason } });
    }

    // Delegate to domain layer to perform publish validations, state transitions and audits
    await resultsDomain.publishResults(id, userId, schoolId);

    const updated = await prisma.assessment.findFirst({
      where: { id, schoolId },
      include: { _count: { select: { results: true } } },
    });

    res.json({
      success: true,
      message: 'Results published successfully',
      status: 'PUBLISHED',
      assessment: updated,
    });
  } catch (error) {
    console.error('Error publishing assessment:', error);
    const message = error instanceof Error ? error.message : 'Failed to publish assessment';
    res.status(500).json({ error: message, details: { stack: (error as any)?.stack } });
  }
});

// POST /api/admin/assessments/{id}/return-draft - Return to draft
router.post('/assessments/:id/return-draft', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId) {
      return res.status(401).json({ error: 'School ID required' });
    }

    const assessment = await prisma.assessment.findFirst({
      where: { id, schoolId },
    });

    if (!assessment) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    if (assessment.status !== 'APPROVED') {
      return res.status(400).json({ error: 'Only approved assessments can be returned to draft' });
    }

    const updated = await prisma.assessment.update({
      where: { id },
      data: { status: 'DRAFT' },
      include: { _count: { select: { results: true } } },
    });

    res.json(updated);
  } catch (error) {
    console.error('Error returning to draft:', error);
    res.status(500).json({ error: 'Failed to return to draft' });
  }
});

// DELETE /api/admin/assessments/{id} - Safely delete assessment (DRAFT only, no results)
router.delete('/assessments/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId) {
      return res.status(401).json({ error: 'School ID required' });
    }

    // Fetch assessment with related counts
    const assessment = await prisma.assessment.findFirst({
      where: { id, schoolId },
      include: {
        _count: {
          select: {
            results: true,
            resultSheets: true,
            components: true,
          },
        },
      },
    });

    if (!assessment) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    // Safety checks
    if (assessment.status !== 'DRAFT') {
      return res.status(400).json({
        error: 'Can only delete DRAFT assessments',
        reason: `Assessment is ${assessment.status}. Only draft assessments can be deleted.`,
      });
    }

    if (assessment._count.results > 0) {
      return res.status(400).json({
        error: 'Cannot delete assessment with results',
        reason: `This assessment has ${assessment._count.results} result(s) entered. Please delete results first.`,
      });
    }

    if (assessment._count.resultSheets > 0) {
      return res.status(400).json({
        error: 'Cannot delete assessment with result sheets',
        reason: `This assessment has result sheets. Please archive them first.`,
      });
    }

    // Delete assessment (cascade will handle components, etc.)
    const deleted = await prisma.assessment.delete({
      where: { id },
    });

    console.log(`[AUDIT] Assessment deleted by admin: ${id}, School: ${schoolId}`);

    res.json({
      success: true,
      message: `Assessment "${deleted.name}" deleted successfully`,
      deletedId: id,
    });
  } catch (error) {
    console.error('Error deleting assessment:', error);
    const message = error instanceof Error ? error.message : 'Failed to delete assessment';
    res.status(500).json({
      error: 'Delete failed',
      message,
    });
  }
});

// ============== TEACHER MANAGEMENT ==============

// POST /api/admin/teachers - Create new teacher
router.post('/teachers', async (req: Request, res: Response) => {
  try {
    console.log('[POST /teachers] Request body:', req.body);
    
    const schoolId = await resolveSchoolId(req);
    console.log('[POST /teachers] Resolved schoolId:', schoolId);
    
    if (!schoolId) {
      console.error('[POST /teachers] Failed to resolve schoolId');
      return res.status(400).json({ error: 'School ID required' });
    }

    const { name, email, password, classIds = [], subjectIds = [], role = 'TEACHER' } = req.body;

    const normalizedRole = role === 'BURSAR' || role === 'ACCOUNTANT' ? 'BURSAR' : 'TEACHER';

    console.log('[POST /teachers] Extracted fields:', { name, email, classIds, subjectIds, role: normalizedRole });

    if (!name || !email || !password) {
      console.error('[POST /teachers] Missing required fields:', { name: !!name, email: !!email, password: !!password });
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (existingUser) {
      console.error('[POST /teachers] Email already exists:', email);
      return res.status(400).json({ error: 'Email already in use' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create staff user
    console.log('[POST /teachers] Creating user with:', { name, email: email.toLowerCase().trim(), role: normalizedRole, schoolId });
    
    const teacher = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase().trim(),
        passwordHash,
        role: normalizedRole,
        schoolId,
      },
    });

    console.log('[POST /teachers] User created:', teacher.id);

    // Assign to classes
    if (classIds && classIds.length > 0) {
      console.log('[POST /teachers] Assigning to classes:', classIds);
      await prisma.teacherClass.createMany({
        data: classIds.map((classId: string) => ({
          teacherId: teacher.id,
          classId,
          schoolId,
        })),
        skipDuplicates: true,
      });
    }

    // Assign to subjects
    if (subjectIds && subjectIds.length > 0) {
      console.log('[POST /teachers] Assigning to subjects:', subjectIds);
      await prisma.teacherSubject.createMany({
        data: subjectIds.map((subjectId: string) => ({
          teacherId: teacher.id,
          subjectId,
          schoolId,
        })),
        skipDuplicates: true,
      });
    }

    // Send email notification with login credentials
    try {
      const school = await prisma.school.findUnique({
        where: { id: schoolId },
        select: { name: true, logoUrl: true },
      });

      if (school) {
        // Send welcome email with login instructions and temp password
        await sendTeacherWelcomeEmail(
          email,
          name,
          school.name,
          password,
          'https://www.schoolbase.live/login?next=%2Fteacher',
          school.logoUrl ?? undefined,
        );
        console.log(`✅ Teacher welcome email sent to ${email}`);
      }
    } catch (emailError) {
      console.warn('⚠️ Failed to send teacher notification email:', emailError);
      // Don't fail the request if email fails
    }

    res.status(201).json({
      success: true,
      teacher: {
        id: teacher.id,
        name: teacher.name,
        email: teacher.email,
        role: teacher.role,
      },
      message: normalizedRole === 'BURSAR' ? 'Bursar / accountant created successfully. Login credentials sent to their email.' : 'Teacher created successfully. Login credentials sent to their email.',
    });
  } catch (error) {
    console.error('Error creating teacher:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to create teacher';
    res.status(500).json({ error: errorMessage });
  }
});

// PATCH /api/admin/teachers/:id - Update teacher
router.patch('/teachers/:id', async (req: Request, res: Response) => {
  try {
    console.log('[PATCH /teachers/:id] Request ID:', req.params.id);
    console.log('[PATCH /teachers/:id] Request body:', req.body);

    const schoolId = await resolveSchoolId(req);
    console.log('[PATCH /teachers/:id] Resolved schoolId:', schoolId);

    if (!schoolId) {
      console.error('[PATCH /teachers/:id] Failed to resolve schoolId');
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;
    const { name, email, password, classIds = [], subjectIds = [] } = req.body;

    // Verify staff member belongs to school
    const teacher = await prisma.user.findFirst({
      where: { id, schoolId, role: { in: ['TEACHER', 'BURSAR'] } },
    });

    if (!teacher) {
      console.error('[PATCH /teachers/:id] Staff member not found:', id);
      return res.status(404).json({ error: 'Staff member not found' });
    }

    console.log('[PATCH /teachers/:id] Updating teacher:', { id, name, email });

    // Update teacher basic info
    const updateData: any = {};
    if (name) updateData.name = name;
    if (email) {
      const trimmedEmail = email.toLowerCase().trim();
      // Check if email is already used by another user
      const existingUser = await prisma.user.findUnique({
        where: { email: trimmedEmail },
      });
      if (existingUser && existingUser.id !== id) {
        return res.status(400).json({ error: 'Email already in use' });
      }
      updateData.email = trimmedEmail;
    }
    if (password) {
      console.log('[PATCH /teachers/:id] Updating password');
      updateData.passwordHash = await bcrypt.hash(password, 10);
    }

    const updated = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    });

    console.log('[PATCH /teachers/:id] User updated:', updated.id);

    // Update class assignments - delete all and recreate
    if (classIds !== undefined && Array.isArray(classIds)) {
      console.log('[PATCH /teachers/:id] Updating class assignments to:', classIds);
      // Delete existing assignments
      await prisma.teacherClass.deleteMany({
        where: { teacherId: id },
      });

      // Create new assignments
      if (classIds && classIds.length > 0) {
        await prisma.teacherClass.createMany({
          data: classIds.map((classId: string) => ({
            teacherId: id,
            classId,
            schoolId,
          })),
          skipDuplicates: true,
        });
      }
    }

    // Update subject assignments - delete all and recreate
    if (subjectIds !== undefined && Array.isArray(subjectIds)) {
      console.log('[PATCH /teachers/:id] Updating subject assignments to:', subjectIds);
      // Delete existing assignments
      await prisma.teacherSubject.deleteMany({
        where: { teacherId: id },
      });

      // Create new assignments
      if (subjectIds && subjectIds.length > 0) {
        await prisma.teacherSubject.createMany({
          data: subjectIds.map((subjectId: string) => ({
            teacherId: id,
            subjectId,
            schoolId,
          })),
          skipDuplicates: true,
        });
      }
    }

    console.log('[PATCH /teachers/:id] Teacher updated successfully');
    res.json(updated);
  } catch (error) {
    console.error('Error updating teacher:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to update teacher';
    res.status(500).json({ error: errorMessage });
  }
});

// DELETE /api/admin/teachers/:id - Delete teacher
router.delete('/teachers/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;

    // Verify staff member belongs to school
    const teacher = await prisma.user.findFirst({
      where: { id, schoolId, role: { in: ['TEACHER', 'BURSAR'] } },
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    // Delete teacher and all associations
    await prisma.user.delete({
      where: { id },
    });

    res.json({ success: true, message: 'Teacher deleted' });
  } catch (error) {
    console.error('Error deleting teacher:', error);
    res.status(500).json({ error: 'Failed to delete teacher' });
  }
});

// POST /api/admin/teachers/:id/classes - Assign teacher to class
router.post('/teachers/:id/classes', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;
    const { classId } = req.body;

    if (!classId) {
      return res.status(400).json({ error: 'Class ID required' });
    }

    // Verify teacher and class exist and belong to school
    const [teacher, cls] = await Promise.all([
      prisma.user.findFirst({ where: { id, schoolId, role: 'TEACHER' } }),
      prisma.class.findFirst({ where: { id: classId, schoolId } }),
    ]);

    if (!teacher || !cls) {
      return res.status(404).json({ error: 'Teacher or class not found' });
    }

    // Create assignment
    const assignment = await prisma.teacherClass.upsert({
      where: {
        teacherId_classId: { teacherId: id, classId },
      },
      update: {},
      create: { teacherId: id, classId, schoolId },
    });

    res.json({ success: true, assignment });
  } catch (error) {
    console.error('Error assigning teacher to class:', error);
    res.status(500).json({ error: 'Failed to assign teacher' });
  }
});

// DELETE /api/admin/teachers/:id/classes/:classId - Remove teacher from class
router.delete('/teachers/:id/classes/:classId', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id, classId } = req.params;

    // Verify teacher belongs to school
    const teacher = await prisma.user.findFirst({
      where: { id, schoolId, role: 'TEACHER' },
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    // Delete assignment
    await prisma.teacherClass.delete({
      where: {
        teacherId_classId: { teacherId: id, classId },
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing teacher from class:', error);
    res.status(500).json({ error: 'Failed to remove teacher assignment' });
  }
});

// POST /api/admin/teachers/:id/subjects - Assign teacher to subject
router.post('/teachers/:id/subjects', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;
    const { subjectId } = req.body;

    if (!subjectId) {
      return res.status(400).json({ error: 'Subject ID required' });
    }

    // Verify teacher and subject exist and belong to school
    const [teacher, subject] = await Promise.all([
      prisma.user.findFirst({ where: { id, schoolId, role: 'TEACHER' } }),
      prisma.subject.findFirst({ where: { id: subjectId, schoolId } }),
    ]);

    if (!teacher || !subject) {
      return res.status(404).json({ error: 'Teacher or subject not found' });
    }

    // Create assignment
    const assignment = await prisma.teacherSubject.upsert({
      where: {
        teacherId_subjectId: { teacherId: id, subjectId },
      },
      update: {},
      create: { teacherId: id, subjectId, schoolId },
    });

    res.json({ success: true, assignment });
  } catch (error) {
    console.error('Error assigning teacher to subject:', error);
    res.status(500).json({ error: 'Failed to assign teacher' });
  }
});

// DELETE /api/admin/teachers/:id/subjects/:subjectId - Remove teacher from subject
router.delete('/teachers/:id/subjects/:subjectId', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id, subjectId } = req.params;

    // Verify teacher belongs to school
    const teacher = await prisma.user.findFirst({
      where: { id, schoolId, role: 'TEACHER' },
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    // Delete assignment
    await prisma.teacherSubject.delete({
      where: {
        teacherId_subjectId: { teacherId: id, subjectId },
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing teacher from subject:', error);
    res.status(500).json({ error: 'Failed to remove teacher assignment' });
  }
});

// GET /api/admin/academic-years - Get all academic years with terms for school
router.get('/academic-years', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const academicYears = await prisma.academicYear.findMany({
      where: { schoolId },
      orderBy: { createdAt: 'desc' },
      include: {
        terms: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    res.json({ academicYears });
  } catch (error) {
    console.error('Error fetching academic years:', error);
    res.status(500).json({ error: 'Failed to fetch academic years' });
  }
});

// POST /api/admin/academic-years - Create new academic year
router.post('/academic-years', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { name, isCurrent } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Academic year name is required' });
    }

    // If setting as current, unset others
    if (isCurrent) {
      await prisma.academicYear.updateMany({
        where: { schoolId },
        data: { isCurrent: false },
      });
    }

    const academicYear = await prisma.academicYear.create({
      data: {
        schoolId,
        name,
        isCurrent: isCurrent || false,
      },
    });

    res.json({ success: true, academicYear });
  } catch (error) {
    console.error('Error creating academic year:', error);
    res.status(500).json({ error: 'Failed to create academic year' });
  }
});

// DELETE /api/admin/academic-years/:id - Delete academic year
router.delete('/academic-years/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;

    // Verify ownership
    const academicYear = await prisma.academicYear.findFirst({
      where: { id, schoolId },
    });

    if (!academicYear) {
      return res.status(404).json({ error: 'Academic year not found' });
    }

    await prisma.academicYear.delete({
      where: { id },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting academic year:', error);
    res.status(500).json({ error: 'Failed to delete academic year' });
  }
});

// POST /api/admin/terms - Create new term
router.post('/terms', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { name, academicYearId, startsOn, endsOn, sortOrder } = req.body;

    if (!name || !academicYearId) {
      return res.status(400).json({ error: 'Term name and academic year are required' });
    }

    // Verify academic year belongs to this school
    const academicYear = await prisma.academicYear.findFirst({
      where: { id: academicYearId, schoolId },
    });

    if (!academicYear) {
      return res.status(404).json({ error: 'Academic year not found' });
    }

    const term = await prisma.term.create({
      data: {
        name,
        academicYearId,
        startsOn: startsOn ? new Date(startsOn) : null,
        endsOn: endsOn ? new Date(endsOn) : null,
        sortOrder: sortOrder || 1,
      },
    });

    res.json({ term });
  } catch (error) {
    console.error('Error creating term:', error);
    res.status(500).json({ error: 'Failed to create term' });
  }
});

// PATCH /api/admin/terms/:id - Update term
router.patch('/terms/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;
    const { name, startsOn, endsOn, sortOrder } = req.body;

    // Verify term belongs to this school
    const term = await prisma.term.findFirst({
      where: {
        id,
        academicYear: { schoolId },
      },
    });

    if (!term) {
      return res.status(404).json({ error: 'Term not found' });
    }

    const updated = await prisma.term.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(startsOn !== undefined && { startsOn: startsOn ? new Date(startsOn) : null }),
        ...(endsOn !== undefined && { endsOn: endsOn ? new Date(endsOn) : null }),
        ...(sortOrder !== undefined && { sortOrder }),
      },
    });

    res.json({ term: updated });
  } catch (error) {
    console.error('Error updating term:', error);
    res.status(500).json({ error: 'Failed to update term' });
  }
});

// DELETE /api/admin/terms/:id - Delete term
router.delete('/terms/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;

    // Verify term belongs to this school
    const term = await prisma.term.findFirst({
      where: {
        id,
        academicYear: { schoolId },
      },
    });

    if (!term) {
      return res.status(404).json({ error: 'Term not found' });
    }

    const invoiceCount = await prisma.invoice.count({
      where: { schoolId, feeSchedule: { termId: id } },
    });
    if (invoiceCount > 0) {
      return res.status(409).json({
        error: `This term cannot be deleted because it has ${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'} attached. Keep the term for financial history instead.`,
      });
    }

    await prisma.term.delete({
      where: { id },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting term:', error);
    res.status(500).json({ error: 'Failed to delete term' });
  }
});

// POST /api/admin/academic-years/:id/set-current - Set academic year as current
router.post('/academic-years/:id/set-current', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;

    // Verify academic year belongs to this school
    const academicYear = await prisma.academicYear.findFirst({
      where: { id, schoolId },
    });

    if (!academicYear) {
      return res.status(404).json({ error: 'Academic year not found' });
    }

    // Unset all current academic years for this school
    await prisma.academicYear.updateMany({
      where: { schoolId },
      data: { isCurrent: false },
    });

    // Set the selected one as current
    const updated = await prisma.academicYear.update({
      where: { id },
      data: { isCurrent: true },
    });

    res.json({ academicYear: updated });
  } catch (error) {
    console.error('Error setting current academic year:', error);
    res.status(500).json({ error: 'Failed to set current academic year' });
  }
});

// POST /api/admin/request-password-reset - Request password reset
router.post('/request-password-reset', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await prisma.user.findUnique({
      where: { email: String(email).trim().toLowerCase() },
      select: { id: true, email: true, name: true },
    });

    if (!user) {
      // Don't reveal if email exists for security
      return res.json({ success: true, message: 'If email exists, reset link has been sent' });
    }

    // Generate reset token
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Save to database
    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    // Send email
    const resetLink = `${process.env.FRONTEND_URL || 'https://www.schoolbase.live'}/reset-password?token=${token}&email=${encodeURIComponent(user.email)}`;
    await sendPasswordResetEmail(user.email, resetLink, user.name || 'User');

    res.json({ success: true, message: 'If email exists, reset link has been sent' });
  } catch (error) {
    console.error('Error requesting password reset:', error);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

// POST /api/admin/reset-password - Reset password with token
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { email, token, password } = req.body;

    if (!email || !token || !password) {
      return res.status(400).json({ error: 'Email, token, and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const user = await prisma.user.findUnique({
      where: { email: String(email).trim().toLowerCase() },
      select: { id: true, email: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or token' });
    }

    // Find valid reset token
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const resetRecord = await prisma.passwordReset.findFirst({
      where: {
        userId: user.id,
        tokenHash,
        expiresAt: { gt: new Date() },
        usedAt: null,
      },
    });

    if (!resetRecord) {
      return res.status(401).json({ error: 'Invalid or expired reset token' });
    }

    // Check attempts
    if (resetRecord.attempts > 5) {
      return res.status(429).json({ error: 'Too many attempts. Please request a new reset link' });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(password, 10);

    // Update user and mark token as used
    await Promise.all([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      }),
      prisma.passwordReset.update({
        where: { id: resetRecord.id },
        data: { usedAt: new Date() },
      }),
    ]);

    res.json({ success: true, message: 'Password reset successful' });
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// GET /api/admin/announcements - Get recent announcements for dashboard
router.get('/announcements', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const announcements = await prisma.announcement.findMany({
      where: { schoolId },
      orderBy: { publishedAt: 'desc' },
      take: 5,
    });

    res.json({ announcements });
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

// POST /api/admin/announcements - Create new announcement
router.post('/announcements', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { title, body, publish, bulkApproval, academicYearId, termId } = req.body;

    const normalizedTitle = String(title ?? '').trim();
    const normalizedBody = String(body ?? '').trim();

    if (!normalizedTitle || !normalizedBody) {
      return res.status(400).json({ error: 'Title and body are required' });
    }

    const normalizedAcademicYearId = academicYearId ? String(academicYearId) : null;
    const normalizedTermId = termId ? String(termId) : null;
    let announcementAcademicYearId = normalizedAcademicYearId;
    let announcementTermId = normalizedTermId;

    if (normalizedAcademicYearId) {
      const academicYear = await prisma.academicYear.findFirst({
        where: { id: normalizedAcademicYearId, schoolId },
        select: { id: true },
      });
      if (!academicYear) {
        return res.status(400).json({ error: 'Selected academic session was not found for this school' });
      }
    }

    if (normalizedTermId) {
      const term = await prisma.term.findFirst({
        where: {
          id: normalizedTermId,
          academicYear: { schoolId },
        },
        select: { id: true, academicYearId: true },
      });
      if (!term) {
        return res.status(400).json({ error: 'Selected term was not found for this school' });
      }
      if (normalizedAcademicYearId && term.academicYearId !== normalizedAcademicYearId) {
        return res.status(400).json({ error: 'Selected term does not belong to the selected academic session' });
      }
      if (!normalizedAcademicYearId) {
        announcementAcademicYearId = term.academicYearId;
      }
    }

    const publishNow = publish === true || publish === 'true';
    if (publishNow) {
      const policy = await readSchoolWhatsAppPolicy(prisma, schoolId);
      const guardianCount = await prisma.guardian.count({
        where: { pupils: { some: { pupil: buildActiveStudentWhere(schoolId) } } },
      });
      const policyCheck = evaluateSchoolWhatsAppSend(policy, {
        recipientCount: guardianCount,
        approvedForBulk: bulkApproval === true || bulkApproval === 'true',
      });
      if (!policyCheck.allowed) {
        return res.status(400).json({ error: policyCheck.reason || 'WhatsApp announcement approval required' });
      }
    }

    const announcement = await prisma.announcement.create({
      data: {
        schoolId,
        title: normalizedTitle,
        body: normalizedBody,
        academicYearId: announcementAcademicYearId,
        termId: announcementTermId,
        published: publishNow,
        publishedAt: publishNow ? new Date() : null,
      },
    });

    let sentCount = 0;
    let emailSent = 0;
    let whatsappSent = 0;
    let emailFailed = 0;
    let whatsappFailed = 0;
    const errors: string[] = [];

    if (announcement.published) {
      const guardians = await prisma.guardian.findMany({
        where: {
          pupils: { some: { pupil: buildActiveStudentWhere(schoolId) } },
        },
        select: {
          id: true,
          firstName: true,
          whatsapp: true,
          phone: true,
          altPhone: true,
          email: true,
        },
        orderBy: { lastName: 'asc' },
      });

      const school = await prisma.school.findUnique({
        where: { id: schoolId },
        select: { name: true, logoUrl: true },
      });
      const communicationService = createCommunicationService();
      const message = `Dear Parent,

    ${normalizedTitle}

    ${normalizedBody}

    Please contact the school office if you need any clarification.`;

      const processGuardian = async (guardian: typeof guardians[number]) => {
        const whatsappAddress = guardian.whatsapp || guardian.phone || guardian.altPhone;
        const recipients = [
          ...(guardian.email ? [{ channel: 'EMAIL' as const, address: guardian.email, name: guardian.firstName }] : []),
          ...(whatsappAddress ? [{ channel: 'WHATSAPP' as const, address: whatsappAddress, name: guardian.firstName }] : []),
        ];

        if (recipients.length === 0) {
          return;
        }

        try {
          const dispatchResult = await communicationService.dispatch({
            event: 'AnnouncementCreated',
            schoolId,
            recipients,
            template: 'Announcement',
            subject: `School Announcement: ${normalizedTitle}`,
            body: message,
            data: {
              title: normalizedTitle,
              message: normalizedBody,
              schoolName: school?.name || 'SchoolBase',
              recipientName: guardian.firstName,
            },
            metadata: {
              title: normalizedTitle,
              message: normalizedBody,
              schoolName: school?.name || 'SchoolBase',
              logoUrl: school?.logoUrl ?? undefined,
              announcementId: announcement.id,
              guardianId: guardian.id,
            },
          });

          for (const delivery of dispatchResult.deliveries) {
            const status = delivery.status === 'SENT' ? 'SENT' : delivery.status === 'QUEUED' ? 'PENDING' : 'FAILED';
            await prisma.notification.create({
              data: {
                schoolId,
                guardianId: guardian.id,
                type: 'ANNOUNCEMENT',
                title: `School Announcement: ${normalizedTitle}`,
                body: truncateNotificationBody(message),
                channel: delivery.channel,
                status,
                sentAt: delivery.status === 'SENT' || delivery.status === 'QUEUED' ? new Date() : undefined,
                failureReason: delivery.error,
                relatedId: announcement.id,
                reference: String(announcement.id),
              },
            });

            if (status !== 'FAILED') {
              sentCount++;
            }
            if (delivery.channel === 'EMAIL') {
              if (status === 'FAILED') emailFailed++;
              else emailSent++;
            }
            if (delivery.channel === 'WHATSAPP') {
              if (status === 'FAILED') whatsappFailed++;
              else whatsappSent++;
            }
          }
        } catch (err) {
          errors.push(`Failed to dispatch announcement for guardian ${guardian.id}`);
          if (guardian.email) emailFailed++;
          if (whatsappAddress) whatsappFailed++;
          await prisma.notification.create({
            data: {
              schoolId,
              guardianId: guardian.id,
              type: 'ANNOUNCEMENT',
              title: `School Announcement: ${normalizedTitle}`,
              body: truncateNotificationBody(message),
              channel: whatsappAddress ? 'WHATSAPP' : 'EMAIL',
              status: 'FAILED',
              failureReason: err instanceof Error ? err.message : String(err),
              relatedId: announcement.id,
              reference: String(announcement.id),
            },
          });
        }
      };

      const runAnnouncementDelivery = async () => {
        // WhatsApp sends are already paced by the school session rate limiter.
        // One worker prevents concurrent attempts from being rejected as bursts.
        const concurrency = 1;
        let nextIndex = 0;
        const workers = Array.from({ length: Math.min(concurrency, guardians.length) }, async () => {
          while (nextIndex < guardians.length) {
            const guardian = guardians[nextIndex];
            nextIndex += 1;
            await processGuardian(guardian);
          }
        });
        await Promise.all(workers);
      };

      void runAnnouncementDelivery().catch((error) => {
        console.error('Error processing queued announcement notifications:', error);
      });
    }

    res.status(201).json({ 
      success: true, 
      announcement,
      announcementId: announcement.id,
      sentCount,
      emailSent,
      whatsappSent,
      emailFailed,
      whatsappFailed,
      queued: announcement.published,
      errors: errors.length > 0 ? errors : undefined,
      message: 'Announcement created successfully' 
    });
  } catch (error) {
    console.error('Error creating announcement:', error);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

// GET /api/admin/announcements/:id/delivery-status - Read notification results for an announcement
router.get('/announcements/:id/delivery-status', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(401).json({ error: 'School ID required' });

    const announcement = await prisma.announcement.findFirst({
      where: { id: req.params.id, schoolId },
      select: { id: true },
    });
    if (!announcement) return res.status(404).json({ error: 'Announcement not found' });

    const notifications = await prisma.notification.findMany({
      where: { schoolId, relatedId: announcement.id, type: 'ANNOUNCEMENT' },
      select: { channel: true, status: true },
    });
    const count = (channel: string, statuses: string[]) => notifications.filter((item) => item.channel === channel && statuses.includes(item.status)).length;
    const pending = notifications.filter((item) => ['PENDING', 'QUEUED', 'SENDING'].includes(item.status)).length;

    res.json({
      complete: pending === 0,
      emailSent: count('EMAIL', ['SENT']),
      emailFailed: count('EMAIL', ['FAILED']),
      whatsappSent: count('WHATSAPP', ['SENT']),
      whatsappFailed: count('WHATSAPP', ['FAILED']),
      pending,
    });
  } catch (error) {
    console.error('Error fetching announcement delivery status:', error);
    res.status(500).json({ error: 'Failed to fetch announcement delivery status' });
  }
});

// PATCH /api/admin/announcements/:id - Update announcement
router.patch('/announcements/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;
    const { title, body, publish } = req.body;

    // Verify announcement belongs to school
    const announcement = await prisma.announcement.findFirst({
      where: { id, schoolId },
    });

    if (!announcement) {
      return res.status(404).json({ error: 'Announcement not found' });
    }

    const updateData: any = {};
    if (title !== undefined) updateData.title = title;
    if (body !== undefined) updateData.body = body;
    if (publish !== undefined) {
      const shouldPublish = publish === true || publish === 'true';
      updateData.published = shouldPublish;
      if (shouldPublish && !announcement.publishedAt) {
        updateData.publishedAt = new Date();
      }
    }

    const updated = await prisma.announcement.update({
      where: { id },
      data: updateData,
    });

    res.json({ 
      success: true, 
      announcement: updated,
      message: 'Announcement updated successfully'
    });
  } catch (error) {
    console.error('Error updating announcement:', error);
    res.status(500).json({ error: 'Failed to update announcement' });
  }
});

// DELETE /api/admin/announcements/:id - Delete announcement
router.delete('/announcements/:id', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { id } = req.params;

    // Verify announcement belongs to school
    const announcement = await prisma.announcement.findFirst({
      where: { id, schoolId },
    });

    if (!announcement) {
      return res.status(404).json({ error: 'Announcement not found' });
    }

    await prisma.announcement.delete({
      where: { id },
    });

    res.json({ success: true, message: 'Announcement deleted' });
  } catch (error) {
    console.error('Error deleting announcement:', error);
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

// GET /api/admin/payments/recent - Get recent payments for dashboard
router.get('/payments/recent', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const payments = await prisma.payment.findMany({
      where: { invoice: { schoolId } },
      include: {
        invoice: {
          include: {
            pupil: { include: { class: true } },
          },
        },
      },
      orderBy: { paidAt: 'desc' },
      take: 5,
    });

    res.json({ payments });
  } catch (error) {
    console.error('Error fetching recent payments:', error);
    res.status(500).json({ error: 'Failed to fetch recent payments' });
  }
});

// GET /api/admin/videos - Get video tutorials from database
router.get('/videos', async (req: Request, res: Response) => {
  try {
    const videos = await prisma.videoTutorial.findMany({
      orderBy: [
        { featured: 'desc' },
        { createdAt: 'desc' }
      ]
    });

    res.json({ videos });
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
});

// GET /api/admin/videos/:id - Get a specific video tutorial
router.get('/videos/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const video = await prisma.videoTutorial.findUnique({
      where: { id }
    });

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.json({ video });
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).json({ error: 'Failed to fetch video' });
  }
});

// ============== CLASSES MANAGEMENT ==============

// POST /api/admin/classes - Create new class
router.post('/classes', async (req: Request, res: Response) => {
  try {
    const { name, phase, arm } = req.body;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId || !name || !phase) {
      return res.status(400).json({ error: 'Missing required fields: name, phase' });
    }

    if (!['EARLY_YEARS', 'PRIMARY', 'SECONDARY'].includes(phase)) {
      return res.status(400).json({ error: 'Invalid phase. Must be EARLY_YEARS, PRIMARY, or SECONDARY' });
    }

    const newClass = await prisma.class.create({
      data: {
        schoolId,
        name,
        phase,
        arm: arm || null,
      },
      include: {
        _count: {
          select: { pupils: true, subjectClasses: true }
        }
      }
    });

    res.status(201).json(newClass);
  } catch (error) {
    console.error('Error creating class:', error);
    res.status(500).json({ error: 'Failed to create class' });
  }
});

// PATCH /api/admin/classes/:id - Update class
router.patch('/classes/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, phase, arm } = req.body;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId) {
      return res.status(401).json({ error: 'School ID required' });
    }

    // Verify class belongs to school
    const classItem = await prisma.class.findFirst({
      where: { id, schoolId }
    });

    if (!classItem) {
      return res.status(404).json({ error: 'Class not found' });
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (phase !== undefined) {
      if (!['EARLY_YEARS', 'PRIMARY', 'SECONDARY'].includes(phase)) {
        return res.status(400).json({ error: 'Invalid phase' });
      }
      updateData.phase = phase;
    }
    if (arm !== undefined) updateData.arm = arm || null;

    const updated = await prisma.class.update({
      where: { id },
      data: updateData,
      include: {
        _count: {
          select: { pupils: true, subjectClasses: true }
        }
      }
    });

    res.json(updated);
  } catch (error) {
    console.error('Error updating class:', error);
    res.status(500).json({ error: 'Failed to update class' });
  }
});

// DELETE /api/admin/classes/:id - Delete class
router.delete('/classes/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId) {
      return res.status(401).json({ error: 'School ID required' });
    }

    // Verify class belongs to school
    const classItem = await prisma.class.findFirst({
      where: { id, schoolId },
      include: { _count: { select: { pupils: true } } }
    });

    if (!classItem) {
      return res.status(404).json({ error: 'Class not found' });
    }

    if ((classItem as any)._count.pupils > 0) {
      return res.status(400).json({ error: 'Cannot delete class with students. Please remove all students first.' });
    }

    await prisma.class.delete({ where: { id } });

    res.json({ success: true, message: 'Class deleted successfully' });
  } catch (error) {
    console.error('Error deleting class:', error);
    res.status(500).json({ error: 'Failed to delete class' });
  }
});

// ============== SUBJECTS MANAGEMENT ==============

// POST /api/admin/subjects - Create new subject
router.post('/subjects', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId || !name) {
      return res.status(400).json({ error: 'Missing required fields: name' });
    }

    // Check if subject with same name already exists for this school
    const existing = await prisma.subject.findFirst({
      where: { schoolId, name }
    });

    if (existing) {
      return res.status(400).json({ error: 'Subject with this name already exists in your school' });
    }

    const newSubject = await prisma.subject.create({
      data: {
        schoolId,
        name,
      }
    });

    res.status(201).json(newSubject);
  } catch (error) {
    console.error('Error creating subject:', error);
    res.status(500).json({ error: 'Failed to create subject' });
  }
});

// PATCH /api/admin/subjects/:id - Update subject
router.patch('/subjects/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId) {
      return res.status(401).json({ error: 'School ID required' });
    }

    // Verify subject belongs to school
    const subject = await prisma.subject.findFirst({
      where: { id, schoolId }
    });

    if (!subject) {
      return res.status(404).json({ error: 'Subject not found' });
    }

    if (name) {
      // Check if new name conflicts with existing subject
      const existing = await prisma.subject.findFirst({
        where: { schoolId, name, NOT: { id } }
      });

      if (existing) {
        return res.status(400).json({ error: 'Subject with this name already exists' });
      }
    }

    const updated = await prisma.subject.update({
      where: { id },
      data: { name: name || undefined }
    });

    res.json(updated);
  } catch (error) {
    console.error('Error updating subject:', error);
    res.status(500).json({ error: 'Failed to update subject' });
  }
});

// DELETE /api/admin/subjects/:id - Delete subject
router.delete('/subjects/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId) {
      return res.status(401).json({ error: 'School ID required' });
    }

    // Verify subject belongs to school
    const subject = await prisma.subject.findFirst({
      where: { id, schoolId }
    });

    if (!subject) {
      return res.status(404).json({ error: 'Subject not found' });
    }

    // Delete all associations before deleting subject
    await prisma.subjectClass.deleteMany({ where: { subjectId: id } });
    await prisma.teacherSubject.deleteMany({ where: { subjectId: id } });

    await prisma.subject.delete({ where: { id } });

    res.json({ success: true, message: 'Subject deleted successfully' });
  } catch (error) {
    console.error('Error deleting subject:', error);
    res.status(500).json({ error: 'Failed to delete subject' });
  }
});

// POST /api/admin/class-subjects/:classId/:subjectId - Assign subject to class
router.post('/class-subjects/:classId/:subjectId', async (req: Request, res: Response) => {
  try {
    const { classId, subjectId } = req.params;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId) {
      return res.status(401).json({ error: 'School ID required' });
    }

    // Verify both class and subject belong to school
    const [classItem, subject] = await Promise.all([
      prisma.class.findFirst({ where: { id: classId, schoolId } }),
      prisma.subject.findFirst({ where: { id: subjectId, schoolId } })
    ]);

    if (!classItem) {
      return res.status(404).json({ error: 'Class not found' });
    }

    if (!subject) {
      return res.status(404).json({ error: 'Subject not found' });
    }

    // Check if assignment already exists
    const existing = await prisma.subjectClass.findFirst({
      where: { classId, subjectId }
    });

    if (existing) {
      return res.status(400).json({ error: 'Subject already assigned to this class' });
    }

    const assignment = await prisma.subjectClass.create({
      data: {
        schoolId,
        classId,
        subjectId,
      },
      include: { class: true, subject: true }
    });

    res.status(201).json(assignment);
  } catch (error) {
    console.error('Error assigning subject to class:', error);
    res.status(500).json({ error: 'Failed to assign subject' });
  }
});

// DELETE /api/admin/class-subjects/:classId/:subjectId - Remove subject from class
router.delete('/class-subjects/:classId/:subjectId', async (req: Request, res: Response) => {
  try {
    const { classId, subjectId } = req.params;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId) {
      return res.status(401).json({ error: 'School ID required' });
    }

    const assignment = await prisma.subjectClass.findFirst({
      where: { classId, subjectId, schoolId }
    });

    if (!assignment) {
      return res.status(404).json({ error: 'Subject assignment not found' });
    }

    await prisma.subjectClass.delete({ where: { id: assignment.id } });

    res.json({ success: true, message: 'Subject removed from class' });
  } catch (error) {
    console.error('Error removing subject from class:', error);
    res.status(500).json({ error: 'Failed to remove subject' });
  }
});

// GET /api/admin/attendance/data - Get attendance records for class and date
router.get('/attendance/data', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { classId, date } = req.query;
    if (!classId || !date) {
      return res.status(400).json({ error: 'classId and date required' });
    }

    // Parse date as ISO string
    const attendanceDate = new Date(date as string);
    attendanceDate.setUTCHours(0, 0, 0, 0);

    // Get all pupils in the class
    const pupils = await prisma.pupil.findMany({
      where: { schoolId, classId: classId as string, isActive: true },
      include: { guardians: { include: { guardian: true } } },
      orderBy: { lastName: 'asc' },
    });

    // Get attendance records for this date
    const attendanceRecords = await prisma.attendanceRecord.findMany({
      where: {
        schoolId,
        classId: classId as string,
        date: attendanceDate,
      },
    });

    // Create map for quick lookup
    const attendanceMap: { [key: string]: string } = {};
    attendanceRecords.forEach((record) => {
      attendanceMap[record.pupilId] = record.status;
    });

    // Build response with pupils and their attendance status
    const attendanceData = pupils.map((pupil) => ({
      pupilId: pupil.id,
      name: `${pupil.firstName} ${pupil.lastName}`,
      status: attendanceMap[pupil.id] || 'PRESENT',
      guardians: pupil.guardians.map((gp) => ({
        id: gp.guardian.id,
        name: gp.guardian.firstName,
        phone: gp.guardian.whatsapp || gp.guardian.phone,
        email: gp.guardian.email,
      })),
    }));

    const classData = await prisma.class.findUnique({
      where: { id: classId as string },
      select: { name: true, arm: true },
    });

    res.json({
      date: attendanceDate.toISOString().split('T')[0],
      classId,
      className: classData ? `${classData.name} ${classData.arm || ''}` : 'Unknown',
      pupils: attendanceData,
      totalPupils: pupils.length,
      presentCount: attendanceRecords.filter((r) => r.status === 'PRESENT').length,
      absentCount: attendanceRecords.filter((r) => r.status === 'ABSENT').length,
      lateCount: attendanceRecords.filter((r) => r.status === 'LATE').length,
    });
  } catch (error) {
    console.error('Error fetching attendance data:', error);
    res.status(500).json({ error: 'Failed to fetch attendance data' });
  }
});

// POST /api/admin/attendance/mark - Mark attendance for students
router.post('/attendance/mark', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { classId, date, attendance } = req.body;
    if (!classId || !date || !attendance) {
      return res.status(400).json({ error: 'classId, date, and attendance array required' });
    }

    // Parse date
    const attendanceDate = new Date(date);
    attendanceDate.setUTCHours(0, 0, 0, 0);

    // Validate attendance statuses
    const validStatuses = ['PRESENT', 'ABSENT', 'LATE'];
    for (const att of attendance) {
      if (!validStatuses.includes(att.status)) {
        return res.status(400).json({ error: `Invalid status: ${att.status}` });
      }
    }

    // Delete existing records for this date and class
    await prisma.attendanceRecord.deleteMany({
      where: {
        schoolId,
        classId,
        date: attendanceDate,
      },
    });

    // Create new attendance records
    const records = await Promise.all(
      attendance.map((att: { pupilId: string; status: 'PRESENT' | 'ABSENT' | 'LATE' | string }) =>
        prisma.attendanceRecord.create({
          data: {
            schoolId,
            classId,
            pupilId: att.pupilId,
            date: attendanceDate,
            status: att.status as 'PRESENT' | 'ABSENT' | 'LATE',
          },
        })
      )
    );

    res.status(201).json({
      success: true,
      message: `Marked attendance for ${records.length} students`,
      recordsCreated: records.length,
    });
  } catch (error) {
    console.error('Error marking attendance:', error);
    res.status(500).json({ error: 'Failed to mark attendance' });
  }
});

// GET /api/admin/attendance/summary - Get attendance summary and reports
router.get('/attendance/summary', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { classId, fromDate, toDate, pupilId } = req.query;

    // Build where clause
    let whereClause: any = { schoolId };
    if (classId) whereClause.classId = classId;
    if (pupilId) whereClause.pupilId = pupilId;

    if (fromDate && toDate) {
      const from = new Date(fromDate as string);
      const to = new Date(toDate as string);
      from.setUTCHours(0, 0, 0, 0);
      to.setUTCHours(23, 59, 59, 999);
      whereClause.date = { gte: from, lte: to };
    }

    const records = await prisma.attendanceRecord.findMany({
      where: whereClause,
      include: {
        pupil: { select: { id: true, firstName: true, lastName: true } },
        class: { select: { id: true, name: true } },
      },
      orderBy: { date: 'desc' },
    });

    // Calculate statistics
    const stats = {
      totalRecords: records.length,
      presentCount: records.filter((r) => r.status === 'PRESENT').length,
      absentCount: records.filter((r) => r.status === 'ABSENT').length,
      lateCount: records.filter((r) => r.status === 'LATE').length,
    };

    // Group by pupil for per-pupil stats
    const pupilStats: { [key: string]: any } = {};
    records.forEach((record) => {
      if (!pupilStats[record.pupilId]) {
        pupilStats[record.pupilId] = {
          pupilId: record.pupilId,
          name: `${record.pupil.firstName} ${record.pupil.lastName}`,
          total: 0,
          present: 0,
          absent: 0,
          late: 0,
          attendanceRate: 0,
        };
      }
      pupilStats[record.pupilId].total++;
      if (record.status === 'PRESENT') pupilStats[record.pupilId].present++;
      if (record.status === 'ABSENT') pupilStats[record.pupilId].absent++;
      if (record.status === 'LATE') pupilStats[record.pupilId].late++;
    });

    // Calculate attendance rates
    Object.values(pupilStats).forEach((stat: any) => {
      stat.attendanceRate = stat.total > 0 ? ((stat.present + stat.late * 0.5) / stat.total) * 100 : 0;
    });

    res.json({
      summary: stats,
      pupilStatistics: Object.values(pupilStats),
      records,
    });
  } catch (error) {
    console.error('Error fetching attendance summary:', error);
    res.status(500).json({ error: 'Failed to fetch attendance summary' });
  }
});

// POST /api/admin/attendance/notify - Send attendance notifications
router.post('/attendance/notify', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { classId, date, notificationType, customMessage } = req.body;
    if (!classId || !date) {
      return res.status(400).json({ error: 'classId and date required' });
    }

    // Parse date
    const attendanceDate = new Date(date);
    attendanceDate.setUTCHours(0, 0, 0, 0);

    // Get attendance records for this date
    const records = await prisma.attendanceRecord.findMany({
      where: { schoolId, classId, date: attendanceDate },
      include: {
        pupil: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            class: { select: { name: true } },
            guardians: { include: { guardian: true } },
          },
        },
      },
    });

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true, logoUrl: true, currency: true },
    });

    let sentCount = 0;
    const errors: string[] = [];

    // Send notifications to guardians
    for (const record of records) {
      const pupilName = `${record.pupil.firstName} ${record.pupil.lastName}`;
      let message = '';

      if (notificationType === 'ABSENT' && record.status === 'ABSENT') {
        message = customMessage || `Dear Guardian, ${pupilName} was absent from school on ${date}. Please contact the school for more information.`;
      } else if (notificationType === 'LATE' && record.status === 'LATE') {
        message = customMessage || `Dear Guardian, ${pupilName} arrived late to school on ${date}.`;
      } else if (notificationType === 'ALL') {
        const statusMsg = record.status === 'PRESENT' ? 'present' : record.status === 'ABSENT' ? 'absent' : 'arrived late';
        message = customMessage || `Attendance Update: ${pupilName} was ${statusMsg} on ${date}.`;
      } else {
        continue;
      }

      // Send to all guardians
      for (const guardianPupil of record.pupil.guardians) {
        const guardian = guardianPupil.guardian;

        // Try WhatsApp if available
        if (guardian.whatsapp) {
          try {
            const result = await baileysSessionManager.sendTextMessage(schoolId, guardian.whatsapp, message);
            if (result.success) {
              sentCount++;
            } else {
              errors.push(`WhatsApp failed for ${guardian.whatsapp}: ${result.error}`);
            }
          } catch (err) {
            errors.push(`WhatsApp failed for ${guardian.whatsapp}`);
          }
        } else if (guardian.email) {
          // Send email
          try {
            const className = record.pupil.class?.name || 'Unknown Class';
            const status = record.status.toLowerCase() as 'present' | 'absent' | 'late';
            await sendAttendanceNotificationEmail(
              guardian.email,
              guardian.firstName,
              pupilName,
              className,
              date,
              status,
              school?.name || 'School',
              message,
              school?.logoUrl ?? undefined,
            );
            sentCount++;
          } catch (err) {
            errors.push(`Email failed for ${guardian.email}`);
          }
        }
      }
    }

    res.json({
      success: true,
      sent: sentCount,
      total: records.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Error sending attendance notifications:', error);
    res.status(500).json({ error: 'Failed to send notifications' });
  }
});

// GET /api/admin/guardians - Get all guardians for school
router.get('/guardians', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const guardians = await prisma.guardian.findMany({
      where: {
        pupils: {
          some: {
            pupil: { schoolId },
          },
        },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        whatsapp: true,
        email: true,
      },
      orderBy: { lastName: 'asc' },
    });

    const mappedGuardians = guardians.map((g) => ({
      id: g.id,
      name: `${g.firstName} ${g.lastName}`,
      phone: g.whatsapp || g.phone,
      email: g.email,
      role: 'Guardian',
    }));

    res.json({ guardians: mappedGuardians });
  } catch (error) {
    console.error('Error fetching guardians:', error);
    res.status(500).json({ error: 'Failed to fetch guardians' });
  }
});

// POST /api/admin/whatsapp/send-message - Send WhatsApp message to guardian
router.post('/whatsapp/send-message', requireSubscription, async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const { phoneNumber, message, recipientName } = req.body;
    if (!phoneNumber || !message) {
      return res.status(400).json({ error: 'phoneNumber and message required' });
    }

    const result = await baileysSessionManager.sendTextMessage(schoolId, phoneNumber, message);

    res.json({
      success: result.success,
      message: result.success ? `Message sent to ${recipientName}` : `Message failed for ${recipientName}`,
      status: result.success ? 'sent' : 'failed',
      error: result.error,
    });
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
});

// POST /api/admin/seed/defaults/:schoolId
// Seed default grading scales for a school
router.post('/seed/defaults/:schoolId', async (req: Request, res: Response) => {
  try {
    const { schoolId } = req.params;
    const { ensureGradingScales = true, ensureAssessmentConfig = false, assessmentId } = req.body;

    // Verify school exists
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
    });

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    const results: any = {};

    // Seed grading scales if requested
    if (ensureGradingScales) {
      const existingScales = await prisma.gradingScale.findMany({
        where: { schoolId },
      });

      if (existingScales.length === 0) {
        const defaultScales = [
          { grade: 'A', minScore: 70, maxScore: 100 },
          { grade: 'B', minScore: 60, maxScore: 69 },
          { grade: 'C', minScore: 50, maxScore: 59 },
          { grade: 'D', minScore: 45, maxScore: 49 },
          { grade: 'E', minScore: 40, maxScore: 44 },
          { grade: 'F', minScore: 0, maxScore: 39 },
        ];

        for (const scale of defaultScales) {
          await prisma.gradingScale.create({
            data: { schoolId, ...scale },
          });
        }

        results.gradingScalesCreated = defaultScales.length;
      } else {
        results.gradingScalesExisted = existingScales.length;
      }
    }

    // Seed assessment configuration if requested
    if (ensureAssessmentConfig && assessmentId) {
      const assessment = await prisma.assessment.findFirst({
        where: { id: assessmentId, schoolId },
      });

      if (!assessment) {
        return res.status(404).json({ error: 'Assessment not found' });
      }

      if (!assessment.componentData) {
        const defaultConfig = {
          components: [
            {
              id: 'comp-ca',
              name: 'Continuous Assessment',
              maxScore: 20,
              weight: 20,
              sortOrder: 1,
            },
            {
              id: 'comp-test',
              name: 'Test',
              maxScore: 20,
              weight: 20,
              sortOrder: 2,
            },
            {
              id: 'comp-exam',
              name: 'Examination',
              maxScore: 60,
              weight: 60,
              sortOrder: 3,
            },
          ],
        };

        await prisma.assessment.update({
          where: { id: assessmentId },
          data: { componentData: JSON.stringify(defaultConfig) },
        });

        results.assessmentConfigured = true;
      } else {
        results.assessmentAlreadyConfigured = true;
      }
    }

    res.json({
      success: true,
      message: 'Defaults seeded successfully',
      schoolId,
      results,
    });
  } catch (error) {
    console.error('Error seeding defaults:', error);
    res.status(500).json({ error: 'Failed to seed defaults' });
  }
});

// GET /api/admin/subjects - Get all subjects for the school
router.get('/subjects', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });

    const subjects = await prisma.subject.findMany({
      where: { schoolId },
      select: {
        id: true,
        name: true,
      },
      orderBy: { name: 'asc' },
    });

    res.json({ subjects });
  } catch (error) {
    console.error('Error fetching subjects:', error);
    res.status(500).json({ error: 'Failed to fetch subjects' });
  }
});

// GET /api/admin/subscription/status - Get subscription status and details
router.get('/subscription/status', async (req: Request, res: Response) => {
  try {
    const schoolId = await resolveSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        id: true,
        name: true,
        status: true,
        plan: true,
        trialEndsAt: true,
        subscriptionExpiresAt: true,
      },
    });

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    // Determine subscription status
    const now = new Date();
    let subscriptionStatus = 'UNKNOWN';
    let daysRemaining = 0;
    let message = '';

    if (school.status === 'ACTIVE') {
      if (school.subscriptionExpiresAt) {
        const expiryDate = new Date(school.subscriptionExpiresAt);
        daysRemaining = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        if (daysRemaining > 0) {
          subscriptionStatus = 'ACTIVE';
          message = `Your ${school.plan} plan is active`;
        } else {
          subscriptionStatus = 'EXPIRED';
          message = 'Your subscription has expired';
        }
      } else {
        subscriptionStatus = 'ACTIVE';
        message = `Your ${school.plan} plan is active`;
      }
    } else if (school.status === 'TRIAL') {
      if (school.trialEndsAt) {
        const trialEndDate = new Date(school.trialEndsAt);
        daysRemaining = Math.ceil((trialEndDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        if (daysRemaining > 0) {
          subscriptionStatus = 'TRIAL';
          message = `Free trial in progress - ${daysRemaining} days remaining`;
        } else {
          subscriptionStatus = 'TRIAL_EXPIRED';
          message = 'Your free trial has expired';
        }
      } else {
        subscriptionStatus = 'TRIAL';
        message = 'Free trial in progress';
      }
    } else if (school.status === 'SUSPENDED') {
      subscriptionStatus = 'SUSPENDED';
      message = 'Your subscription has been suspended';
    } else if (school.status === 'CANCELLED') {
      subscriptionStatus = 'CANCELLED';
      message = 'Your subscription has been cancelled';
    } else if (school.status === 'PENDING') {
      subscriptionStatus = 'PENDING';
      message = 'Your subscription is pending approval';
    }

    res.json({
      subscriptionStatus,
      schoolName: school.name,
      currentPlan: school.plan,
      status: school.status,
      trialEndsAt: school.trialEndsAt,
      subscriptionExpiresAt: school.subscriptionExpiresAt,
      daysRemaining,
      message,
      canRenew: ['EXPIRED', 'TRIAL_EXPIRED', 'CANCELLED'].includes(subscriptionStatus),
      canUpgrade: subscriptionStatus === 'ACTIVE' && ['STARTER', 'GROWTH'].includes(school.plan),
    });
  } catch (error) {
    console.error('Error fetching subscription status:', error);
    res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

// POST /api/admin/send-trial-emails - Send subscription emails to all trial accounts
router.post('/send-trial-emails', async (req: Request, res: Response) => {
  try {
    console.log('[Trial Emails] Starting to send subscription emails to trial accounts...');

    // Find all TRIAL schools
    const trialSchools = await prisma.school.findMany({
      where: {
        status: 'TRIAL',
      },
      select: {
        id: true,
        name: true,
        plan: true,
        trialEndsAt: true,
      },
    });

    console.log(`[Trial Emails] Found ${trialSchools.length} trial schools`);

    const results = {
      total: trialSchools.length,
      sent: 0,
      failed: 0,
      details: [] as Array<{ schoolName: string; adminEmail: string; status: string; error?: string }>,
    };

    for (const school of trialSchools) {
      try {
        // Find the admin user for this school
        const admin = await prisma.user.findFirst({
          where: {
            schoolId: school.id,
            role: 'SCHOOL_ADMIN',
          },
          select: { email: true, name: true },
        });

        if (!admin?.email) {
          console.warn(`[Trial Emails] No admin email found for school: ${school.name}`);
          results.failed++;
          results.details.push({
            schoolName: school.name,
            adminEmail: 'N/A',
            status: 'failed',
            error: 'No admin email found',
          });
          continue;
        }

        // Format the trial end date
        const trialEndDate = school.trialEndsAt
          ? new Date(school.trialEndsAt).toLocaleDateString('en-NG', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })
          : 'N/A';

        // Send subscription email
        await sendSubscriptionPaymentSuccessEmail(
          admin.email,
          school.name,
          admin.name || 'Admin',
          school.plan || 'STARTER',
          'Trial Access',
          trialEndDate
        );

        console.log(`[Trial Emails] Email sent successfully to ${admin.email} for school: ${school.name}`);
        results.sent++;
        results.details.push({
          schoolName: school.name,
          adminEmail: admin.email,
          status: 'sent',
        });
      } catch (emailError) {
        console.error(`[Trial Emails] Error sending email for school ${school.name}:`, emailError);
        results.failed++;
        results.details.push({
          schoolName: school.name,
          adminEmail: 'unknown',
          status: 'failed',
          error: emailError instanceof Error ? emailError.message : 'Unknown error',
        });
      }
    }

    console.log('[Trial Emails] Completed. Summary:', results);
    res.json({
      success: true,
      message: `Sent subscription emails to ${results.sent} trial accounts (${results.failed} failed)`,
      results,
    });
  } catch (error) {
    console.error('[Trial Emails] Error in send-trial-emails endpoint:', error);
    res.status(500).json({
      error: 'Failed to send trial account emails',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
