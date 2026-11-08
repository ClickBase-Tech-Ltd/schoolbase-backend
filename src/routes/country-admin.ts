import { Router, type NextFunction, type Request, type Response } from 'express';
import { Prisma, PrismaClient, type SupportStatus } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify } from 'jose';
import { getSessionSecret } from '../services/security-config.js';
import { buildSchoolSetupStatus } from '../services/onboarding.js';
import { billingMarkets, type BillingMarketCode } from '../services/billing-markets.js';
import {
  sendCountryAdminInviteEmail,
  sendCountryCommunicationsNotificationEmail,
  sendSupportStatusUpdateNotification,
} from '../services/email.js';
import { chooseCountryRepresentative } from '../services/country-work-assignment.js';

const prisma = new PrismaClient();
const countryAdmin = Router();
const countryRepresentativeAdmin = Router();
const countryFollowUpStages = ['NEW', 'CONTACTED', 'ONBOARDING', 'BLOCKED', 'OPERATIONAL'] as const;

type CountryCommunicationRecipient = { email: string; name: string };
type CountryCommunicationNotificationType = 'private-message' | 'announcement';

function notifyCountryCommunicationRecipients(
  recipients: CountryCommunicationRecipient[],
  notificationType: CountryCommunicationNotificationType,
  workspacePath: '/country-admin/messages' | '/schoolbase-admin/country-communications',
) {
  const deliveries = recipients
    .filter((recipient) => recipient.email.trim())
    .map((recipient) => sendCountryCommunicationsNotificationEmail({
      email: recipient.email,
      recipientName: recipient.name,
      notificationType,
      workspacePath,
    }));

  void Promise.allSettled(deliveries).then((results) => {
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      console.error(
        `[country-admin] ${notificationType} email notifications failed for ${failures.length} of ${results.length} recipients:`,
        failures.map((result) => result.status === 'rejected' ? result.reason : undefined),
      );
    }
  });
}

type PlatformAdminRequest = Request & { platformAdminUserId?: string };
type CountryRepRequest = Request & {
  countryRepresentative?: {
    userId: string;
    countryCode: BillingMarketCode;
    name: string;
    email: string;
    countryFollowUpRemindersEnabled: boolean;
  };
};

function sessionSecret() {
  return getSessionSecret();
}

async function authenticateCountryRepresentative(req: CountryRepRequest, res: Response, next: NextFunction) {
  let payload;
  try {
    const token = req.cookies?.schoolbase_session || req.cookies?.schoolbase_staff || req.cookies?.staff_session;
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    ({ payload } = await jwtVerify(token, sessionSecret()));
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }

  const userId = typeof payload.userId === 'string' ? payload.userId : null;
  if (!userId || payload.role !== 'COUNTRY_REP') {
    return res.status(403).json({ error: 'Country representative access required.' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        countryCode: true,
        schoolId: true,
        isActive: true,
        countryFollowUpRemindersEnabled: true,
      },
    });
    if (
      !user ||
      !user.isActive ||
      user.role !== 'COUNTRY_REP' ||
      user.schoolId ||
      !user.countryCode ||
      user.countryCode !== payload.countryCode ||
      !Object.hasOwn(billingMarkets, user.countryCode)
    ) {
      return res.status(401).json({ error: 'Country representative session is no longer active.' });
    }

    req.countryRepresentative = {
      userId: user.id,
      countryCode: user.countryCode as BillingMarketCode,
      name: user.name,
      email: user.email,
      countryFollowUpRemindersEnabled: user.countryFollowUpRemindersEnabled,
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

async function authenticatePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  let payload;
  try {
    const token = req.cookies?.schoolbase_session || req.get('x-schoolbase-session');
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    ({ payload } = await jwtVerify(token, sessionSecret()));
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }

  const userId = typeof payload.userId === 'string' ? payload.userId : null;
  if (!userId || payload.role !== 'PLATFORM_ADMIN') {
    return res.status(403).json({ error: 'Platform administrator access required.' });
  }

  try {
    const user = await prisma.user.findFirst({
      where: { id: userId, role: 'PLATFORM_ADMIN', isActive: true },
      select: { id: true },
    });
    if (!user) return res.status(403).json({ error: 'Platform administrator access required.' });
    (req as PlatformAdminRequest).platformAdminUserId = user.id;
    return next();
  } catch (error) {
    return next(error);
  }
}

async function writeCountryOperationsAudit(
  tx: Prisma.TransactionClient,
  event: {
    userId?: string;
    actorRole: string;
    schoolId?: string;
    countryCode: string | null;
    action: string;
    event: string;
    resourceType: string;
    resourceId: string;
    summary: string;
    details?: Record<string, unknown>;
  },
) {
  await tx.platformAuditLog.create({
    data: {
      userId: event.userId,
      schoolId: event.schoolId,
      event: event.event,
      category: 'COUNTRY_OPERATIONS',
      action: event.action,
      outcome: 'SUCCESS',
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      summary: event.summary,
      actorRole: event.actorRole,
      details: JSON.stringify({ countryCode: event.countryCode, ...event.details }),
    },
  });
}

function setupStatusForSchool(school: {
  name: string;
  country: string;
  currency: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  logoUrl: string | null;
  principalName: string | null;
  principalComment: string | null;
  principalSignatureUrl: string | null;
  stampUrl: string | null;
  _count: {
    enabledPhases: number;
    academicYears: number;
    classes: number;
    subjects: number;
    teacherClasses: number;
    feeSchedules: number;
    pupils: number;
    announcements: number;
    assessments: number;
  };
}) {
  return buildSchoolSetupStatus({
    school,
    counts: {
      enabledPhases: school._count.enabledPhases,
      academicYears: school._count.academicYears,
      classes: school._count.classes,
      subjects: school._count.subjects,
      teacherClasses: school._count.teacherClasses,
      feeSchedules: school._count.feeSchedules,
      students: school._count.pupils,
      announcements: school._count.announcements,
      assessments: school._count.assessments,
    },
  });
}

const schoolSetupSelect = {
  currency: true,
  address: true,
  logoUrl: true,
  principalName: true,
  principalComment: true,
  principalSignatureUrl: true,
  stampUrl: true,
  _count: {
    select: {
      enabledPhases: true,
      academicYears: true,
      classes: true,
      subjects: true,
      teacherClasses: true,
      feeSchedules: true,
      pupils: true,
      announcements: true,
      assessments: true,
    },
  },
} satisfies Prisma.SchoolSelect;

const schoolWhere = (countryCode: BillingMarketCode, search = ''): Prisma.SchoolWhereInput => ({
  country: countryCode,
  archivedAt: null,
  ...(search ? {
    OR: [
      { name: { contains: search } },
      { email: { contains: search } },
      { phone: { contains: search } },
      { city: { contains: search } },
    ],
  } : {}),
});

countryAdmin.use(authenticateCountryRepresentative);

countryAdmin.patch('/reminder-preferences', async (req: CountryRepRequest, res: Response) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Reminder preference must be enabled or disabled.' });
  }

  try {
    await prisma.user.update({
      where: { id: req.countryRepresentative!.userId },
      data: { countryFollowUpRemindersEnabled: enabled },
    });
    return res.json({ success: true, enabled });
  } catch (error) {
    console.error('[country-admin] reminder preference update failed:', error);
    return res.status(500).json({ error: 'Unable to update your reminder preference.' });
  }
});

countryAdmin.get('/overview', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  const page = Number.parseInt(String(req.query.page || '1'), 10);
  const limit = Number.parseInt(String(req.query.limit || '25'), 10);
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const followUpStage = typeof req.query.followUpStage === 'string' ? req.query.followUpStage : '';
  const followUpFilter = typeof req.query.followUpFilter === 'string' ? req.query.followUpFilter : '';
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ error: 'Invalid page or page size.' });
  }
  if (status && !['PENDING', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED'].includes(status)) {
    return res.status(400).json({ error: 'Invalid school status filter.' });
  }
  if (followUpStage && !countryFollowUpStages.includes(followUpStage as typeof countryFollowUpStages[number])) {
    return res.status(400).json({ error: 'Invalid follow-up stage filter.' });
  }
  if (followUpFilter && !['OVERDUE', 'TODAY', 'UPCOMING', 'NO_DATE', 'BLOCKED'].includes(followUpFilter)) {
    return res.status(400).json({ error: 'Invalid follow-up filter.' });
  }

  const baseWhere = schoolWhere(representative.countryCode);
  const listWhere = schoolWhere(representative.countryCode, search);
  if (status) listWhere.status = status as Prisma.EnumSchoolStatusFilter['equals'];
  const listFilters: Prisma.SchoolWhereInput[] = [];
  if (followUpStage === 'NEW') {
    listFilters.push({
      OR: [
        { countryFollowUp: { is: null } },
        { countryFollowUp: { is: { stage: 'NEW' } } },
      ],
    });
  } else if (followUpStage) {
    listFilters.push({ countryFollowUp: { is: { stage: followUpStage as typeof countryFollowUpStages[number] } } });
  }
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setUTCDate(startOfTomorrow.getUTCDate() + 1);
  if (followUpFilter === 'OVERDUE') {
    listFilters.push({ countryFollowUp: { is: { nextContactAt: { lt: startOfToday } } } });
  } else if (followUpFilter === 'TODAY') {
    listFilters.push({ countryFollowUp: { is: { nextContactAt: { gte: startOfToday, lt: startOfTomorrow } } } });
  } else if (followUpFilter === 'UPCOMING') {
    listFilters.push({ countryFollowUp: { is: { nextContactAt: { gte: startOfTomorrow } } } });
  } else if (followUpFilter === 'NO_DATE') {
    listFilters.push({
      OR: [
        { countryFollowUp: { is: null } },
        { countryFollowUp: { is: { nextContactAt: null } } },
      ],
    });
  } else if (followUpFilter === 'BLOCKED') {
    listFilters.push({ countryFollowUp: { is: { stage: 'BLOCKED' } } });
  }
  if (listFilters.length) listWhere.AND = listFilters;

  try {
    const [schools, total, activeCount, trialCount, openSupportCount, overdueFollowUps, blockedSchools] = await Promise.all([
      prisma.school.findMany({
        where: listWhere,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          city: true,
          country: true,
          status: true,
          plan: true,
          createdAt: true,
          trialEndsAt: true,
          countryFollowUp: {
            select: {
              stage: true,
              ownerUserId: true,
              owner: { select: { id: true, name: true } },
              nextContactAt: true,
              events: {
                where: { note: { not: null } },
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { note: true },
              },
            },
          },
          ...schoolSetupSelect,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.school.count({ where: listWhere }),
      prisma.school.count({ where: { ...baseWhere, status: 'ACTIVE' } }),
      prisma.school.count({ where: { ...baseWhere, status: 'TRIAL' } }),
      prisma.supportRequest.count({
        where: { status: { notIn: ['CLOSED', 'RESOLVED'] }, school: { country: representative.countryCode } },
      }),
      prisma.countrySchoolFollowUp.count({
        where: { school: baseWhere, nextContactAt: { lt: startOfToday } },
      }),
      prisma.countrySchoolFollowUp.count({
        where: { school: baseWhere, stage: 'BLOCKED' },
      }),
    ]);

    return res.json({
      country: billingMarkets[representative.countryCode],
      representative: {
        name: representative.name,
        email: representative.email,
        followUpRemindersEnabled: representative.countryFollowUpRemindersEnabled,
      },
      summary: {
        schools: total,
        active: activeCount,
        trials: trialCount,
        openSupport: openSupportCount,
        overdueFollowUps,
        blockedSchools,
      },
      schools: schools.map((school) => {
        const setup = setupStatusForSchool(school);
        return {
          id: school.id,
          name: school.name,
          email: school.email,
          phone: school.phone,
          city: school.city,
          country: school.country,
          status: school.status,
          plan: school.plan,
          createdAt: school.createdAt,
          trialEndsAt: school.trialEndsAt,
          setupProgress: setup.completionPercentage,
          setupComplete: setup.isComplete,
          incompleteItems: setup.incompleteItems,
          followUp: school.countryFollowUp ? {
            stage: school.countryFollowUp.stage,
            ownerUserId: school.countryFollowUp.ownerUserId,
            owner: school.countryFollowUp.owner,
            nextContactAt: school.countryFollowUp.nextContactAt,
            latestNote: school.countryFollowUp.events[0]?.note ?? null,
          } : null,
        };
      }),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[country-admin] overview failed:', error);
    return res.status(500).json({ error: 'Unable to load the country dashboard.' });
  }
});

countryAdmin.get('/schools/:schoolId/follow-up', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  try {
    const school = await prisma.school.findFirst({
      where: { id: req.params.schoolId, ...schoolWhere(representative.countryCode) },
      select: {
        id: true,
        name: true,
        countryFollowUp: {
          select: {
            id: true,
            stage: true,
            ownerUserId: true,
            owner: { select: { id: true, name: true } },
            nextContactAt: true,
            events: {
              orderBy: { createdAt: 'desc' },
              take: 50,
              select: {
                id: true,
                actorName: true,
                changes: true,
                note: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });
    if (!school) return res.status(404).json({ error: 'School not found in your assigned country.' });

    return res.json({
      school: { id: school.id, name: school.name },
      followUp: school.countryFollowUp ? {
        ...school.countryFollowUp,
        stage: school.countryFollowUp.stage,
      } : {
        id: null,
        stage: 'NEW',
        ownerUserId: null,
        owner: null,
        nextContactAt: null,
        events: [],
      },
    });
  } catch (error) {
    console.error('[country-admin] school follow-up history failed:', error);
    return res.status(500).json({ error: 'Unable to load this school follow-up history.' });
  }
});

countryAdmin.patch('/schools/:schoolId/follow-up', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  const body = req.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'A follow-up update is required.' });
  }

  const hasStage = Object.hasOwn(body, 'stage');
  const hasNextContact = Object.hasOwn(body, 'nextContactAt');
  const hasNote = Object.hasOwn(body, 'note');
  if (Object.hasOwn(body, 'ownerUserId')) {
    return res.status(400).json({ error: 'Follow-up ownership is assigned automatically.' });
  }
  if (!hasStage && !hasNextContact && !hasNote) {
    return res.status(400).json({ error: 'Choose at least one follow-up update.' });
  }

  let stage: typeof countryFollowUpStages[number] | undefined;
  if (hasStage) {
    if (typeof body.stage !== 'string' || !countryFollowUpStages.includes(body.stage as typeof countryFollowUpStages[number])) {
      return res.status(400).json({ error: 'Select a valid follow-up stage.' });
    }
    stage = body.stage as typeof countryFollowUpStages[number];
  }

  let nextContactAt: Date | null | undefined;
  if (hasNextContact) {
    if (body.nextContactAt === null) {
      nextContactAt = null;
    } else if (typeof body.nextContactAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.nextContactAt)) {
      const parsed = new Date(`${body.nextContactAt}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== body.nextContactAt) {
        return res.status(400).json({ error: 'Enter a valid next-contact date.' });
      }
      nextContactAt = parsed;
    } else {
      return res.status(400).json({ error: 'Enter a valid next-contact date.' });
    }
  }

  let note: string | null = null;
  if (hasNote) {
    if (typeof body.note !== 'string' || body.note.length > 2000) {
      return res.status(400).json({ error: 'Follow-up notes must be 2,000 characters or fewer.' });
    }
    note = body.note.trim() || null;
  }

  try {
    const school = await prisma.school.findFirst({
      where: { id: req.params.schoolId, ...schoolWhere(representative.countryCode) },
      select: { id: true, name: true },
    });
    if (!school) return res.status(404).json({ error: 'School not found in your assigned country.' });

    const result = await prisma.$transaction(async (tx) => {
      const automaticOwner = await chooseCountryRepresentative(tx, representative.countryCode, 'followUp');
      const existing = await tx.countrySchoolFollowUp.findUnique({
        where: { schoolId: school.id },
        select: {
          id: true,
          stage: true,
          ownerUserId: true,
          owner: { select: { id: true, name: true } },
          nextContactAt: true,
        },
      });
      const nextStage = stage ?? existing?.stage ?? 'NEW';
      const existingOwnerIsActive = existing?.ownerUserId
        ? await tx.user.findFirst({
          where: {
            id: existing.ownerUserId,
            role: 'COUNTRY_REP',
            countryCode: representative.countryCode,
            isActive: true,
            schoolId: null,
          },
          select: { id: true, name: true },
        })
        : null;
      const owner = existingOwnerIsActive ?? automaticOwner;
      const nextOwnerUserId = owner?.id ?? null;
      const nextDate = hasNextContact ? nextContactAt! : existing?.nextContactAt ?? null;
      const dateString = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
      const changes: Record<string, Prisma.InputJsonValue | null> = {};

      if ((existing?.stage ?? 'NEW') !== nextStage) {
        changes.stage = { from: existing?.stage ?? 'NEW', to: nextStage };
      }
      if ((existing?.ownerUserId ?? null) !== nextOwnerUserId) {
        changes.owner = {
          from: existing?.owner ? { id: existing.owner.id, name: existing.owner.name } : null,
          to: owner ? { id: owner.id, name: owner.name } : null,
        };
      }
      if (dateString(existing?.nextContactAt ?? null) !== dateString(nextDate)) {
        changes.nextContactAt = {
          from: dateString(existing?.nextContactAt ?? null),
          to: dateString(nextDate),
        };
      }
      if (Object.keys(changes).length === 0 && !note) return { unchanged: true as const };

      const followUp = await tx.countrySchoolFollowUp.upsert({
        where: { schoolId: school.id },
        update: {
          ...(stage !== undefined ? { stage } : {}),
          ownerUserId: nextOwnerUserId,
          ...(hasNextContact ? { nextContactAt } : {}),
        },
        create: {
          schoolId: school.id,
          stage: nextStage,
          ownerUserId: nextOwnerUserId,
          nextContactAt: nextDate,
        },
        select: { id: true },
      });
      await tx.countrySchoolFollowUpEvent.create({
        data: {
          followUpId: followUp.id,
          actorUserId: representative.userId,
          actorName: representative.name,
          ...(Object.keys(changes).length ? { changes } : {}),
          note,
        },
      });
      await writeCountryOperationsAudit(tx, {
        userId: representative.userId,
        actorRole: 'COUNTRY_REP',
        schoolId: school.id,
        countryCode: representative.countryCode,
        action: 'country.follow_up.updated',
        event: 'COUNTRY_FOLLOW_UP_UPDATED',
        resourceType: 'School follow-up',
        resourceId: followUp.id,
        summary: 'Updated a country school follow-up',
        details: { changes, noteAdded: Boolean(note) },
      });
      return { unchanged: false as const };
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('[country-admin] school follow-up update failed:', error);
    return res.status(500).json({ error: 'Unable to save this school follow-up.' });
  }
});

countryAdmin.get('/reports', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  try {
    const schools = await prisma.school.findMany({
      where: schoolWhere(representative.countryCode),
      select: {
        name: true,
        country: true,
        phone: true,
        email: true,
        city: true,
        status: true,
        createdAt: true,
        ...schoolSetupSelect,
      },
      orderBy: { createdAt: 'asc' },
    });

    const byStatus = new Map<string, number>();
    const byCity = new Map<string, number>();
    const bySignupMonth = new Map<string, number>();
    let setupComplete = 0;
    const now = new Date();
    const firstMonth = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    for (let offset = 0; offset < 12; offset += 1) {
      const month = new Date(firstMonth.getFullYear(), firstMonth.getMonth() + offset, 1);
      bySignupMonth.set(`${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`, 0);
    }

    for (const school of schools) {
      byStatus.set(school.status, (byStatus.get(school.status) ?? 0) + 1);
      const city = school.city?.trim() || 'Not specified';
      byCity.set(city, (byCity.get(city) ?? 0) + 1);
      if (setupStatusForSchool(school).isComplete) setupComplete += 1;
      if (school.createdAt >= firstMonth) {
        const month = `${school.createdAt.getFullYear()}-${String(school.createdAt.getMonth() + 1).padStart(2, '0')}`;
        if (bySignupMonth.has(month)) bySignupMonth.set(month, (bySignupMonth.get(month) ?? 0) + 1);
      }
    }

    return res.json({
      country: billingMarkets[representative.countryCode],
      summary: {
        schools: schools.length,
        setupComplete,
        setupInProgress: schools.length - setupComplete,
      },
      schoolsByStatus: [...byStatus].map(([status, count]) => ({ status, count })),
      schoolsByCity: [...byCity]
        .map(([city, count]) => ({ city, count }))
        .sort((left, right) => right.count - left.count || left.city.localeCompare(right.city)),
      signupsByMonth: [...bySignupMonth].map(([month, count]) => ({ month, count })),
    });
  } catch (error) {
    console.error('[country-admin] reports failed:', error);
    return res.status(500).json({ error: 'Unable to load country reports.' });
  }
});

countryAdmin.get('/support', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  const page = Number.parseInt(String(req.query.page || '1'), 10);
  const limit = Number.parseInt(String(req.query.limit || '25'), 10);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ error: 'Invalid page or page size.' });
  }
  const where: Prisma.SupportRequestWhereInput = {
    school: { country: representative.countryCode },
    status: { not: 'CLOSED' },
  };

  try {
    const [requests, total] = await Promise.all([
      prisma.supportRequest.findMany({
        where,
        select: {
          id: true,
          subject: true,
          status: true,
          priority: true,
          requesterName: true,
          requesterEmail: true,
          lastMessageAt: true,
          school: { select: { id: true, name: true } },
          assignedCountryRep: { select: { id: true, name: true } },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { body: true, senderRole: true },
          },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.supportRequest.count({ where }),
    ]);
    return res.json({
      requests: requests.map((request) => ({
        ...request,
        latestMessage: request.messages[0] ?? null,
        messages: undefined,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[country-admin] support list failed:', error);
    return res.status(500).json({ error: 'Unable to load country support requests.' });
  }
});

countryAdmin.get('/support/:requestId', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  try {
    const request = await prisma.supportRequest.findFirst({
      where: {
        id: req.params.requestId,
        school: { country: representative.countryCode },
      },
      select: {
        id: true,
        subject: true,
        status: true,
        priority: true,
        requesterName: true,
        requesterEmail: true,
        requesterRole: true,
        createdAt: true,
        lastMessageAt: true,
        school: { select: { id: true, name: true, email: true } },
        assignedCountryRep: { select: { id: true, name: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 200,
          select: { id: true, senderRole: true, senderName: true, body: true, readAt: true, createdAt: true },
        },
      },
    });
    if (!request) return res.status(404).json({ error: 'Support request not found.' });

    await prisma.supportRequestMessage.updateMany({
      where: { supportRequestId: request.id, senderRole: 'SCHOOL', readAt: null },
      data: { readAt: new Date() },
    });
    return res.json({ request });
  } catch (error) {
    console.error('[country-admin] support detail failed:', error);
    return res.status(500).json({ error: 'Unable to load this support request.' });
  }
});

countryAdmin.post('/support/:requestId/reply', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  const body = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!body || body.length > 20000) {
    return res.status(400).json({ error: 'Write a reply of no more than 20,000 characters.' });
  }

  try {
    const request = await prisma.supportRequest.findFirst({
      where: { id: req.params.requestId, school: { country: representative.countryCode } },
      include: { school: { select: { name: true, email: true } } },
    });
    if (!request) return res.status(404).json({ error: 'Support request not found.' });
    if (request.status === 'CLOSED') return res.status(409).json({ error: 'This support request is closed.' });

    const updated = await prisma.$transaction(async (tx) => {
      const message = await tx.supportRequestMessage.create({
        data: {
          supportRequestId: request.id,
          senderUserId: representative.userId,
          senderRole: 'PLATFORM_ADMIN',
          senderName: representative.name,
          senderEmail: representative.email,
          body,
        },
      });
      await tx.supportRequest.update({
        where: { id: request.id },
        data: { response: body, status: 'WAITING_FOR_CUSTOMER', lastMessageAt: message.createdAt },
      });
      await writeCountryOperationsAudit(tx, {
        userId: representative.userId,
        actorRole: 'COUNTRY_REP',
        schoolId: request.schoolId,
        countryCode: representative.countryCode,
        action: 'country.support.reply_sent',
        event: 'COUNTRY_SUPPORT_REPLY_SENT',
        resourceType: 'Support request',
        resourceId: request.id,
        summary: 'Replied to a country support request',
        details: { statusFrom: request.status, statusTo: 'WAITING_FOR_CUSTOMER' },
      });
      return tx.supportRequest.findUniqueOrThrow({
        where: { id: request.id },
        select: {
          id: true,
          subject: true,
          status: true,
          school: { select: { name: true, email: true } },
        },
      });
    });

    void sendSupportStatusUpdateNotification(
      updated.id,
      'WAITING_FOR_CUSTOMER',
      updated.subject,
      body,
      updated.school.name,
      request.requesterEmail || updated.school.email,
    ).catch((error) => console.error('[country-admin] support reply notification failed:', error));

    return res.status(201).json({ success: true, status: 'WAITING_FOR_CUSTOMER' });
  } catch (error) {
    console.error('[country-admin] support reply failed:', error);
    return res.status(500).json({ error: 'Unable to send the support reply.' });
  }
});

countryAdmin.patch('/support/:requestId/status', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  const status = req.body?.status;
  const allowedStatuses = new Set<SupportStatus>(['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED']);
  if (typeof status !== 'string' || !allowedStatuses.has(status as SupportStatus)) {
    return res.status(400).json({ error: 'Select a valid support status.' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const request = await tx.supportRequest.findFirst({
        where: { id: req.params.requestId, school: { country: representative.countryCode } },
        select: { id: true, schoolId: true, status: true, subject: true },
      });
      if (!request) return null;
      await tx.supportRequest.update({
        where: { id: request.id },
        data: { status: status as SupportStatus },
      });
      if (request.status !== status) {
        await writeCountryOperationsAudit(tx, {
          userId: representative.userId,
          actorRole: 'COUNTRY_REP',
          schoolId: request.schoolId,
          countryCode: representative.countryCode,
          action: 'country.support.status_updated',
          event: 'COUNTRY_SUPPORT_STATUS_UPDATED',
          resourceType: 'Support request',
          resourceId: request.id,
          summary: 'Updated a country support request status',
          details: { statusFrom: request.status, statusTo: status },
        });
      }
      return true;
    });
    if (!result) return res.status(404).json({ error: 'Support request not found.' });
    return res.json({ success: true, status });
  } catch (error) {
    console.error('[country-admin] support status update failed:', error);
    return res.status(500).json({ error: 'Unable to update the support request.' });
  }
});

countryAdmin.get('/communications/unread-count', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  try {
    const [conversations, unacknowledgedAnnouncements] = await Promise.all([
      prisma.countryAdminConversation.findMany({
        where: { representativeUserId: representative.userId },
        select: {
          lastMessageAt: true,
          messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { id: true } },
          reads: { where: { userId: representative.userId }, select: { lastReadMessageId: true }, take: 1 },
        },
      }),
      prisma.countryAdminAnnouncement.count({
        where: {
          OR: [{ countryCode: null }, { countryCode: representative.countryCode }],
          acknowledgements: { none: { representativeUserId: representative.userId } },
        },
      }),
    ]);
    const unreadThreads = conversations.filter((conversation) =>
      Boolean(conversation.messages[0] && conversation.messages[0].id !== conversation.reads[0]?.lastReadMessageId),
    ).length;
    return res.json({ unreadCount: unreadThreads + unacknowledgedAnnouncements });
  } catch (error) {
    console.error('[country-admin] communications unread count failed:', error);
    return res.status(500).json({ error: 'Unable to load message notifications.' });
  }
});

countryAdmin.get('/communications', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  try {
    const [threads, announcements] = await Promise.all([
      prisma.countryAdminConversation.findMany({
        where: { representativeUserId: representative.userId },
        orderBy: [{ status: 'asc' }, { lastMessageAt: 'desc' }],
        take: 100,
        include: {
          platformAdminOwner: { select: { id: true, name: true, email: true } },
          messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, include: { sender: { select: { name: true, role: true } } } },
          reads: { where: { userId: representative.userId }, select: { lastReadMessageId: true }, take: 1 },
        },
      }),
      prisma.countryAdminAnnouncement.findMany({
        where: { OR: [{ countryCode: null }, { countryCode: representative.countryCode }] },
        orderBy: [{ isImportant: 'desc' }, { publishedAt: 'desc' }],
        take: 100,
        include: {
          createdBy: { select: { name: true } },
          acknowledgements: {
            where: { representativeUserId: representative.userId },
            select: { acknowledgedAt: true },
            take: 1,
          },
        },
      }),
    ]);
    return res.json({
      threads: threads.map(({ reads, ...thread }) => ({
        ...thread,
        unread: Boolean(thread.messages[0] && thread.messages[0].id !== reads[0]?.lastReadMessageId),
      })),
      announcements: announcements.map(({ acknowledgements, ...announcement }) => ({
        ...announcement,
        acknowledgedAt: acknowledgements[0]?.acknowledgedAt ?? null,
      })),
    });
  } catch (error) {
    console.error('[country-admin] communications list failed:', error);
    return res.status(500).json({ error: 'Unable to load country communications.' });
  }
});

countryAdmin.post('/communications/threads', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  const body = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!subject || subject.length > 160 || !body || body.length > 5000) {
    return res.status(400).json({ error: 'Enter a subject and message (up to 5,000 characters).' });
  }

  try {
    const platformAdmins = await prisma.user.findMany({
      where: { role: 'PLATFORM_ADMIN', isActive: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, email: true, name: true },
    });
    const platformAdmin = platformAdmins[0];
    const conversation = await prisma.$transaction(async (tx) => {
      const created = await tx.countryAdminConversation.create({
        data: {
          representativeUserId: representative.userId,
          platformAdminOwnerId: platformAdmin?.id ?? null,
          createdByUserId: representative.userId,
          subject,
          messages: { create: { senderUserId: representative.userId, body } },
        },
        select: { id: true, lastMessageAt: true, messages: { select: { id: true } } },
      });
      await tx.countryAdminConversationRead.create({
        data: {
          conversationId: created.id,
          userId: representative.userId,
          lastReadAt: created.lastMessageAt,
          lastReadMessageId: created.messages[0]?.id ?? null,
        },
      });
      await writeCountryOperationsAudit(tx, {
        userId: representative.userId,
        actorRole: 'COUNTRY_REP',
        countryCode: representative.countryCode,
        action: 'country.communication.thread_created',
        event: 'COUNTRY_COMMUNICATION_THREAD_CREATED',
        resourceType: 'Country admin conversation',
        resourceId: created.id,
        summary: 'Started a private conversation with the platform team',
      });
      return created;
    });
    notifyCountryCommunicationRecipients(
      platformAdmins,
      'private-message',
      '/schoolbase-admin/country-communications',
    );
    return res.status(201).json({ thread: conversation });
  } catch (error) {
    console.error('[country-admin] conversation creation failed:', error);
    return res.status(500).json({ error: 'Unable to start a conversation with the platform team.' });
  }
});

countryAdmin.get('/communications/threads/:threadId', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  try {
    const thread = await prisma.countryAdminConversation.findFirst({
      where: { id: req.params.threadId, representativeUserId: representative.userId },
      include: {
        representative: { select: { id: true, name: true, email: true, countryCode: true } },
        platformAdminOwner: { select: { id: true, name: true, email: true } },
        messages: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: { sender: { select: { id: true, name: true, role: true } } },
        },
      },
    });
    if (!thread) return res.status(404).json({ error: 'Conversation not found.' });
    await prisma.countryAdminConversationRead.upsert({
      where: { conversationId_userId: { conversationId: thread.id, userId: representative.userId } },
      create: {
        conversationId: thread.id,
        userId: representative.userId,
        lastReadAt: thread.lastMessageAt,
        lastReadMessageId: thread.messages.at(-1)?.id ?? null,
      },
      update: {
        lastReadAt: thread.lastMessageAt,
        lastReadMessageId: thread.messages.at(-1)?.id ?? null,
      },
    });
    return res.json({ thread });
  } catch (error) {
    console.error('[country-admin] conversation detail failed:', error);
    return res.status(500).json({ error: 'Unable to open this conversation.' });
  }
});

countryAdmin.post('/communications/threads/:threadId/messages', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  const body = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!body || body.length > 5000) return res.status(400).json({ error: 'Enter a message of up to 5,000 characters.' });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const thread = await tx.countryAdminConversation.findFirst({
        where: { id: req.params.threadId, representativeUserId: representative.userId },
        select: { id: true, status: true },
      });
      if (!thread) return { notFound: true as const };
      if (thread.status === 'RESOLVED') return { resolved: true as const };
      const platformAdmins = await tx.user.findMany({
        where: { role: 'PLATFORM_ADMIN', isActive: true },
        select: { email: true, name: true },
      });
      const message = await tx.countryAdminMessage.create({
        data: { conversationId: thread.id, senderUserId: representative.userId, body },
        include: { sender: { select: { id: true, name: true, role: true } } },
      });
      await tx.countryAdminConversation.update({
        where: { id: thread.id },
        data: { lastMessageAt: message.createdAt },
      });
      await tx.countryAdminConversationRead.upsert({
        where: { conversationId_userId: { conversationId: thread.id, userId: representative.userId } },
        create: {
          conversationId: thread.id,
          userId: representative.userId,
          lastReadAt: message.createdAt,
          lastReadMessageId: message.id,
        },
        update: { lastReadAt: message.createdAt, lastReadMessageId: message.id },
      });
      await writeCountryOperationsAudit(tx, {
        userId: representative.userId,
        actorRole: 'COUNTRY_REP',
        countryCode: representative.countryCode,
        action: 'country.communication.message_sent',
        event: 'COUNTRY_COMMUNICATION_MESSAGE_SENT',
        resourceType: 'Country admin conversation',
        resourceId: thread.id,
        summary: 'Sent a message to the platform team',
      });
      return { message, recipients: platformAdmins };
    });
    if ('notFound' in result) return res.status(404).json({ error: 'Conversation not found.' });
    if ('resolved' in result) return res.status(409).json({ error: 'This conversation is resolved. Reopen it before replying.' });
    notifyCountryCommunicationRecipients(
      result.recipients,
      'private-message',
      '/schoolbase-admin/country-communications',
    );
    return res.status(201).json({ message: result.message });
  } catch (error) {
    console.error('[country-admin] conversation reply failed:', error);
    return res.status(500).json({ error: 'Unable to send your message.' });
  }
});

countryAdmin.patch('/communications/threads/:threadId', async (req: CountryRepRequest, res: Response) => {
  const status = req.body?.status;
  if (status !== 'OPEN' && status !== 'RESOLVED') {
    return res.status(400).json({ error: 'Select a valid conversation status.' });
  }
  try {
    const result = await prisma.$transaction(async (tx) => {
      const thread = await tx.countryAdminConversation.findFirst({
        where: { id: req.params.threadId, representativeUserId: req.countryRepresentative!.userId },
        select: { id: true, status: true },
      });
      if (!thread) return null;
      if (thread.status !== status) {
        await tx.countryAdminConversation.update({ where: { id: thread.id }, data: { status } });
        await writeCountryOperationsAudit(tx, {
          userId: req.countryRepresentative!.userId,
          actorRole: 'COUNTRY_REP',
          countryCode: req.countryRepresentative!.countryCode,
          action: 'country.communication.status_updated',
          event: 'COUNTRY_COMMUNICATION_STATUS_UPDATED',
          resourceType: 'Country admin conversation',
          resourceId: thread.id,
          summary: status === 'RESOLVED' ? 'Resolved a platform communication thread' : 'Reopened a platform communication thread',
          details: { statusFrom: thread.status, statusTo: status },
        });
      }
      return true;
    });
    if (!result) return res.status(404).json({ error: 'Conversation not found.' });
    return res.json({ success: true, status });
  } catch (error) {
    console.error('[country-admin] conversation status update failed:', error);
    return res.status(500).json({ error: 'Unable to update conversation status.' });
  }
});

countryAdmin.post('/communications/announcements/:announcementId/acknowledge', async (req: CountryRepRequest, res: Response) => {
  const representative = req.countryRepresentative!;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const announcement = await tx.countryAdminAnnouncement.findFirst({
        where: {
          id: req.params.announcementId,
          OR: [{ countryCode: null }, { countryCode: representative.countryCode }],
        },
        select: { id: true },
      });
      if (!announcement) return false;
      const acknowledgementKey = {
        announcementId_representativeUserId: {
          announcementId: announcement.id,
          representativeUserId: representative.userId,
        },
      };
      const priorAcknowledgement = await tx.countryAdminAnnouncementAcknowledgement.findUnique({
        where: acknowledgementKey,
        select: { acknowledgedAt: true },
      });
      const acknowledgement = await tx.countryAdminAnnouncementAcknowledgement.upsert({
        where: acknowledgementKey,
        create: { announcementId: announcement.id, representativeUserId: representative.userId },
        update: {},
        select: { acknowledgedAt: true },
      });
      if (!priorAcknowledgement) {
        await writeCountryOperationsAudit(tx, {
          userId: representative.userId,
          actorRole: 'COUNTRY_REP',
          countryCode: representative.countryCode,
          action: 'country.announcement.acknowledged',
          event: 'COUNTRY_ANNOUNCEMENT_ACKNOWLEDGED',
          resourceType: 'Country admin announcement',
          resourceId: announcement.id,
          summary: 'Acknowledged a platform announcement',
        });
      }
      return acknowledgement;
    });
    if (!result) return res.status(404).json({ error: 'Announcement not found.' });
    return res.json({ acknowledgedAt: result.acknowledgedAt });
  } catch (error) {
    console.error('[country-admin] announcement acknowledgement failed:', error);
    return res.status(500).json({ error: 'Unable to acknowledge this announcement.' });
  }
});

countryRepresentativeAdmin.use(authenticatePlatformAdmin);

countryRepresentativeAdmin.get('/communications/unread-count', async (req: PlatformAdminRequest, res: Response) => {
  const userId = req.platformAdminUserId!;
  try {
    const conversations = await prisma.countryAdminConversation.findMany({
      select: {
        lastMessageAt: true,
        messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { id: true } },
        reads: { where: { userId }, select: { lastReadMessageId: true }, take: 1 },
      },
    });
    const unreadCount = conversations.filter((conversation) =>
      Boolean(conversation.messages[0] && conversation.messages[0].id !== conversation.reads[0]?.lastReadMessageId),
    ).length;
    return res.json({ unreadCount });
  } catch (error) {
    console.error('[country-admin] platform communications unread count failed:', error);
    return res.status(500).json({ error: 'Unable to load message notifications.' });
  }
});

countryRepresentativeAdmin.get('/communications', async (req: PlatformAdminRequest, res: Response) => {
  const country = typeof req.query.country === 'string' ? req.query.country.trim().toUpperCase() : '';
  if (country && !Object.hasOwn(billingMarkets, country)) {
    return res.status(400).json({ error: 'Select a supported country.' });
  }
  try {
    const [representatives, platformAdmins, threads, announcements] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'COUNTRY_REP', isActive: true, ...(country ? { countryCode: country } : {}) },
        orderBy: [{ countryCode: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, email: true, countryCode: true },
      }),
      prisma.user.findMany({
        where: { role: 'PLATFORM_ADMIN', isActive: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, email: true },
      }),
      prisma.countryAdminConversation.findMany({
        where: country ? { representative: { countryCode: country } } : {},
        orderBy: [{ status: 'asc' }, { lastMessageAt: 'desc' }],
        take: 250,
        include: {
          representative: { select: { id: true, name: true, email: true, countryCode: true } },
          platformAdminOwner: { select: { id: true, name: true, email: true } },
          messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, include: { sender: { select: { name: true, role: true } } } },
          reads: { where: { userId: req.platformAdminUserId! }, select: { lastReadMessageId: true }, take: 1 },
        },
      }),
      prisma.countryAdminAnnouncement.findMany({
        where: country ? { OR: [{ countryCode: null }, { countryCode: country }] } : {},
        orderBy: { publishedAt: 'desc' },
        take: 100,
        include: {
          createdBy: { select: { name: true } },
          acknowledgements: {
            where: {
              representative: {
                isActive: true,
                ...(country ? { countryCode: country } : {}),
              },
            },
            select: { representative: { select: { id: true, name: true, email: true, countryCode: true } } },
          },
        },
      }),
    ]);
    const activeAudienceCount = (announcementCountryCode: string | null) => representatives.filter((representative) =>
      !announcementCountryCode || representative.countryCode === announcementCountryCode,
    ).length;

    return res.json({
      representatives,
      platformAdmins,
      threads: threads.map(({ reads, ...thread }) => ({
        ...thread,
        unread: Boolean(thread.messages[0] && thread.messages[0].id !== reads[0]?.lastReadMessageId),
      })),
      announcements: announcements.map(({ acknowledgements, ...announcement }) => ({
        ...announcement,
        audienceCount: activeAudienceCount(announcement.countryCode),
        acknowledgementCount: acknowledgements.length,
        acknowledgedBy: acknowledgements.map(({ representative }) => representative),
      })),
    });
  } catch (error) {
    console.error('[country-admin] platform communications list failed:', error);
    return res.status(500).json({ error: 'Unable to load country communications.' });
  }
});

countryRepresentativeAdmin.post('/communications/threads', async (req: PlatformAdminRequest, res: Response) => {
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  const body = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const representativeUserId = typeof req.body?.representativeUserId === 'string' ? req.body.representativeUserId : '';
  if (!subject || subject.length > 160 || !body || body.length > 5000 || !representativeUserId) {
    return res.status(400).json({ error: 'Select a representative and enter a subject and message (up to 5,000 characters).' });
  }

  try {
    const representative = await prisma.user.findFirst({
      where: { id: representativeUserId, role: 'COUNTRY_REP', isActive: true, countryCode: { not: null } },
      select: { id: true, name: true, email: true, countryCode: true },
    });
    if (!representative?.countryCode || !Object.hasOwn(billingMarkets, representative.countryCode)) {
      return res.status(404).json({ error: 'Active country representative not found.' });
    }

    const conversation = await prisma.$transaction(async (tx) => {
      const created = await tx.countryAdminConversation.create({
        data: {
          representativeUserId: representative.id,
          platformAdminOwnerId: req.platformAdminUserId!,
          createdByUserId: req.platformAdminUserId!,
          subject,
          messages: { create: { senderUserId: req.platformAdminUserId!, body } },
        },
        select: { id: true, lastMessageAt: true, messages: { select: { id: true } } },
      });
      await tx.countryAdminConversationRead.create({
        data: {
          conversationId: created.id,
          userId: req.platformAdminUserId!,
          lastReadAt: created.lastMessageAt,
          lastReadMessageId: created.messages[0]?.id ?? null,
        },
      });
      await writeCountryOperationsAudit(tx, {
        userId: req.platformAdminUserId,
        actorRole: 'PLATFORM_ADMIN',
        countryCode: representative.countryCode,
        action: 'country.communication.thread_created',
        event: 'COUNTRY_COMMUNICATION_THREAD_CREATED',
        resourceType: 'Country admin conversation',
        resourceId: created.id,
        summary: 'Started a private conversation with a country representative',
      });
      return created;
    });
    notifyCountryCommunicationRecipients(
      [representative],
      'private-message',
      '/country-admin/messages',
    );
    return res.status(201).json({ thread: conversation });
  } catch (error) {
    console.error('[country-admin] platform conversation creation failed:', error);
    return res.status(500).json({ error: 'Unable to start a conversation.' });
  }
});

countryRepresentativeAdmin.get('/communications/threads/:threadId', async (req: PlatformAdminRequest, res: Response) => {
  try {
    const thread = await prisma.countryAdminConversation.findUnique({
      where: { id: req.params.threadId },
      include: {
        representative: { select: { id: true, name: true, email: true, countryCode: true } },
        platformAdminOwner: { select: { id: true, name: true, email: true } },
        messages: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: { sender: { select: { id: true, name: true, role: true } } },
        },
      },
    });
    if (!thread) return res.status(404).json({ error: 'Conversation not found.' });
    await prisma.countryAdminConversationRead.upsert({
      where: { conversationId_userId: { conversationId: thread.id, userId: req.platformAdminUserId! } },
      create: {
        conversationId: thread.id,
        userId: req.platformAdminUserId!,
        lastReadAt: thread.lastMessageAt,
        lastReadMessageId: thread.messages.at(-1)?.id ?? null,
      },
      update: { lastReadAt: thread.lastMessageAt, lastReadMessageId: thread.messages.at(-1)?.id ?? null },
    });
    return res.json({ thread });
  } catch (error) {
    console.error('[country-admin] platform conversation detail failed:', error);
    return res.status(500).json({ error: 'Unable to open this conversation.' });
  }
});

countryRepresentativeAdmin.post('/communications/threads/:threadId/messages', async (req: PlatformAdminRequest, res: Response) => {
  const body = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!body || body.length > 5000) return res.status(400).json({ error: 'Enter a message of up to 5,000 characters.' });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const thread = await tx.countryAdminConversation.findUnique({
        where: { id: req.params.threadId },
        select: {
          id: true,
          status: true,
          representative: { select: { name: true, email: true, countryCode: true } },
        },
      });
      if (!thread) return null;
      if (thread.status === 'RESOLVED') return { resolved: true as const };
      const message = await tx.countryAdminMessage.create({
        data: { conversationId: thread.id, senderUserId: req.platformAdminUserId!, body },
        include: { sender: { select: { id: true, name: true, role: true } } },
      });
      await tx.countryAdminConversation.update({
        where: { id: thread.id },
        data: { lastMessageAt: message.createdAt },
      });
      await tx.countryAdminConversationRead.upsert({
        where: { conversationId_userId: { conversationId: thread.id, userId: req.platformAdminUserId! } },
        create: {
          conversationId: thread.id,
          userId: req.platformAdminUserId!,
          lastReadAt: message.createdAt,
          lastReadMessageId: message.id,
        },
        update: { lastReadAt: message.createdAt, lastReadMessageId: message.id },
      });
      await writeCountryOperationsAudit(tx, {
        userId: req.platformAdminUserId,
        actorRole: 'PLATFORM_ADMIN',
        countryCode: thread.representative.countryCode,
        action: 'country.communication.message_sent',
        event: 'COUNTRY_COMMUNICATION_MESSAGE_SENT',
        resourceType: 'Country admin conversation',
        resourceId: thread.id,
        summary: 'Sent a message to a country representative',
      });
      return { message, recipients: [thread.representative] };
    });
    if (!result) return res.status(404).json({ error: 'Conversation not found.' });
    if ('resolved' in result) return res.status(409).json({ error: 'This conversation is resolved. Reopen it before replying.' });
    notifyCountryCommunicationRecipients(
      result.recipients,
      'private-message',
      '/country-admin/messages',
    );
    return res.status(201).json({ message: result.message });
  } catch (error) {
    console.error('[country-admin] platform conversation reply failed:', error);
    return res.status(500).json({ error: 'Unable to send your message.' });
  }
});

countryRepresentativeAdmin.patch('/communications/threads/:threadId', async (req: PlatformAdminRequest, res: Response) => {
  const status = req.body?.status;
  const dueAt = req.body?.dueAt;
  const platformAdminOwnerId = req.body?.platformAdminOwnerId;
  const parsedDueAt = typeof dueAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dueAt)
    ? new Date(`${dueAt}T00:00:00.000Z`)
    : null;
  const dueAtToSave = dueAt === null ? null : parsedDueAt;
  if (
    (status !== undefined && status !== 'OPEN' && status !== 'RESOLVED') ||
    (dueAt !== undefined && dueAt !== null && (!parsedDueAt || Number.isNaN(parsedDueAt.getTime()) || parsedDueAt.toISOString().slice(0, 10) !== dueAt)) ||
    (platformAdminOwnerId !== undefined && platformAdminOwnerId !== null && typeof platformAdminOwnerId !== 'string')
  ) {
    return res.status(400).json({ error: 'Provide a valid status, due date, or platform-admin owner.' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.countryAdminConversation.findUnique({
        where: { id: req.params.threadId },
        select: {
          id: true,
          status: true,
          dueAt: true,
          platformAdminOwnerId: true,
          representative: { select: { countryCode: true } },
        },
      });
      if (!existing) return null;
      if (typeof platformAdminOwnerId === 'string') {
        const owner = await tx.user.findFirst({
          where: { id: platformAdminOwnerId, role: 'PLATFORM_ADMIN', isActive: true },
          select: { id: true },
        });
        if (!owner) throw new Error('PLATFORM_ADMIN_OWNER_INVALID');
      }

      const updated = await tx.countryAdminConversation.update({
        where: { id: existing.id },
        data: {
          ...(status !== undefined ? { status } : {}),
          ...(dueAt !== undefined ? { dueAt: dueAtToSave } : {}),
          ...(platformAdminOwnerId !== undefined ? { platformAdminOwnerId } : {}),
        },
        select: { id: true, status: true, dueAt: true, platformAdminOwnerId: true },
      });
      const details: Record<string, unknown> = {};
      if (status !== undefined && existing.status !== updated.status) details.status = { from: existing.status, to: updated.status };
      if (dueAt !== undefined && existing.dueAt?.toISOString().slice(0, 10) !== updated.dueAt?.toISOString().slice(0, 10)) {
        details.dueAt = { from: existing.dueAt?.toISOString().slice(0, 10) ?? null, to: updated.dueAt?.toISOString().slice(0, 10) ?? null };
      }
      if (platformAdminOwnerId !== undefined && existing.platformAdminOwnerId !== updated.platformAdminOwnerId) {
        details.platformAdminOwnerId = { from: existing.platformAdminOwnerId, to: updated.platformAdminOwnerId };
      }
      if (Object.keys(details).length) {
        await writeCountryOperationsAudit(tx, {
          userId: req.platformAdminUserId,
          actorRole: 'PLATFORM_ADMIN',
          countryCode: existing.representative.countryCode,
          action: 'country.communication.thread_updated',
          event: 'COUNTRY_COMMUNICATION_THREAD_UPDATED',
          resourceType: 'Country admin conversation',
          resourceId: existing.id,
          summary: 'Updated a country communication thread',
          details,
        });
      }
      return updated;
    });
    if (!result) return res.status(404).json({ error: 'Conversation not found.' });
    return res.json({ thread: result });
  } catch (error) {
    if (error instanceof Error && error.message === 'PLATFORM_ADMIN_OWNER_INVALID') {
      return res.status(400).json({ error: 'Select an active platform administrator as the owner.' });
    }
    console.error('[country-admin] platform conversation update failed:', error);
    return res.status(500).json({ error: 'Unable to update this conversation.' });
  }
});

countryRepresentativeAdmin.post('/communications/announcements', async (req: PlatformAdminRequest, res: Response) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const requestedCountry = req.body?.countryCode;
  const countryCode = typeof requestedCountry === 'string' && requestedCountry.trim()
    ? requestedCountry.trim().toUpperCase()
    : null;
  const isImportant = req.body?.isImportant === true;
  if (
    !title || title.length > 160 || !body || body.length > 10000 ||
    (requestedCountry !== undefined && requestedCountry !== null && typeof requestedCountry !== 'string') ||
    (req.body?.isImportant !== undefined && typeof req.body.isImportant !== 'boolean') ||
    (countryCode !== null && !Object.hasOwn(billingMarkets, countryCode))
  ) {
    return res.status(400).json({ error: 'Enter a title and announcement (up to 10,000 characters) and choose a supported audience.' });
  }
  try {
    const representatives = await prisma.user.findMany({
      where: {
        role: 'COUNTRY_REP',
        isActive: true,
        ...(countryCode ? { countryCode } : {}),
      },
      select: { email: true, name: true },
    });
    const announcement = await prisma.$transaction(async (tx) => {
      const created = await tx.countryAdminAnnouncement.create({
        data: { createdByUserId: req.platformAdminUserId!, countryCode, title, body, isImportant },
        select: { id: true, title: true, countryCode: true, isImportant: true, publishedAt: true },
      });
      await writeCountryOperationsAudit(tx, {
        userId: req.platformAdminUserId,
        actorRole: 'PLATFORM_ADMIN',
        countryCode,
        action: 'country.announcement.published',
        event: 'COUNTRY_ANNOUNCEMENT_PUBLISHED',
        resourceType: 'Country admin announcement',
        resourceId: created.id,
        summary: countryCode ? 'Published a country-specific representative announcement' : 'Published a representative announcement to all countries',
        details: { isImportant },
      });
      return created;
    });
    notifyCountryCommunicationRecipients(
      representatives,
      'announcement',
      '/country-admin/messages',
    );
    return res.status(201).json({ announcement });
  } catch (error) {
    console.error('[country-admin] announcement publishing failed:', error);
    return res.status(500).json({ error: 'Unable to publish this announcement.' });
  }
});

async function createInvite(user: { id: string; email: string; name: string; countryCode: string | null }) {
  const market = Object.values(billingMarkets).find(({ countryCode }) => countryCode === user.countryCode);
  if (!market) throw new Error('Country representative has no supported country assignment.');

  const token = randomBytes(32).toString('hex');
  await prisma.passwordReset.create({
    data: {
      userId: user.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const configuredFrontendUrl = (process.env.FRONTEND_URL || 'https://www.schoolbase.live').split(',')[0].trim();
  const frontendUrl = new URL(configuredFrontendUrl);
  if (
    frontendUrl.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(frontendUrl.hostname) &&
    !frontendUrl.port
  ) {
    frontendUrl.port = '3000';
  }
  const setupUrl = new URL('/reset-password', frontendUrl);
  setupUrl.searchParams.set('token', token);
  setupUrl.searchParams.set('email', user.email);
  setupUrl.searchParams.set('purpose', 'country-admin-invitation');
  await sendCountryAdminInviteEmail(user.email, setupUrl.toString(), user.name, market.countryName);
}

countryRepresentativeAdmin.get('/', async (_req: Request, res: Response) => {
  try {
    const representatives = await prisma.user.findMany({
      where: { role: 'COUNTRY_REP' },
      select: { id: true, name: true, email: true, countryCode: true, isActive: true, createdAt: true },
      orderBy: [{ countryCode: 'asc' }, { name: 'asc' }],
    });
    return res.json({ representatives });
  } catch (error) {
    console.error('[country-admin] representative list failed:', error);
    return res.status(500).json({ error: 'Unable to load country representatives.' });
  }
});

countryRepresentativeAdmin.post('/', async (req: PlatformAdminRequest, res: Response) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const countryCode = typeof req.body?.countryCode === 'string' ? req.body.countryCode.trim().toUpperCase() : '';
  if (!name || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !Object.hasOwn(billingMarkets, countryCode)) {
    return res.status(400).json({ error: 'Enter a name, valid email address, and supported country.' });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) return res.status(409).json({ error: 'An account already uses this email address.' });

    const representative = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name,
          email,
          role: 'COUNTRY_REP',
          countryCode,
          schoolId: null,
          passwordHash: null,
          isActive: true,
        },
        select: { id: true, name: true, email: true, countryCode: true, isActive: true, createdAt: true },
      });
      await writeCountryOperationsAudit(tx, {
        userId: req.platformAdminUserId,
        actorRole: 'PLATFORM_ADMIN',
        countryCode,
        action: 'country.representative.created',
        event: 'COUNTRY_REPRESENTATIVE_CREATED',
        resourceType: 'Country representative',
        resourceId: created.id,
        summary: 'Created a country representative account',
      });
      return created;
    });
    try {
      await createInvite(representative);
    } catch (error) {
      console.error('[country-admin] representative invitation email failed:', error);
      return res.status(502).json({
        error: 'The representative account was created, but the invitation email could not be sent. Resend the invitation from this page.',
        accountCreated: true,
        representative,
      });
    }
    return res.status(201).json({ representative, invitationSent: true });
  } catch (error) {
    console.error('[country-admin] representative creation failed:', error);
    return res.status(500).json({ error: 'Unable to create the country representative.' });
  }
});

countryRepresentativeAdmin.post('/:userId/invite', async (req: Request, res: Response) => {
  try {
    const representative = await prisma.user.findFirst({
      where: { id: req.params.userId, role: 'COUNTRY_REP', isActive: true },
      select: { id: true, name: true, email: true, countryCode: true },
    });
    if (!representative || !representative.countryCode) return res.status(404).json({ error: 'Active country representative not found.' });
    await createInvite(representative);
    return res.json({ success: true });
  } catch (error) {
    console.error('[country-admin] representative invitation failed:', error);
    return res.status(500).json({ error: 'Unable to send the invitation email.' });
  }
});

countryRepresentativeAdmin.patch('/:userId', async (req: PlatformAdminRequest, res: Response) => {
  const countryCode = req.body?.countryCode;
  const isActive = req.body?.isActive;
  if (
    (countryCode === undefined && isActive === undefined) ||
    (countryCode !== undefined && (typeof countryCode !== 'string' || !Object.hasOwn(billingMarkets, countryCode.toUpperCase()))) ||
    (isActive !== undefined && typeof isActive !== 'boolean')
  ) {
    return res.status(400).json({ error: 'Provide a supported country and/or an active status.' });
  }

  try {
    const representative = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findFirst({
        where: { id: req.params.userId, role: 'COUNTRY_REP' },
        select: { id: true, countryCode: true, isActive: true },
      });
      if (!existing) return null;
      const updated = await tx.user.update({
        where: { id: existing.id },
        data: {
          ...(typeof countryCode === 'string' ? { countryCode: countryCode.toUpperCase() } : {}),
          ...(typeof isActive === 'boolean' ? { isActive } : {}),
        },
        select: { id: true, name: true, email: true, countryCode: true, isActive: true, createdAt: true },
      });
      const details: Record<string, unknown> = {};
      if (existing.countryCode !== updated.countryCode) {
        details.countryCode = { from: existing.countryCode, to: updated.countryCode };
      }
      if (existing.isActive !== updated.isActive) {
        details.isActive = { from: existing.isActive, to: updated.isActive };
      }
      if (Object.keys(details).length) {
        await writeCountryOperationsAudit(tx, {
          userId: req.platformAdminUserId,
          actorRole: 'PLATFORM_ADMIN',
          countryCode: updated.countryCode ?? existing.countryCode,
          action: 'country.representative.updated',
          event: 'COUNTRY_REPRESENTATIVE_UPDATED',
          resourceType: 'Country representative',
          resourceId: updated.id,
          summary: 'Updated country representative access or assignment',
          details,
        });
      }
      return updated;
    });
    if (!representative) return res.status(404).json({ error: 'Country representative not found.' });
    return res.json({ representative });
  } catch (error) {
    console.error('[country-admin] representative update failed:', error);
    return res.status(500).json({ error: 'Unable to update the country representative.' });
  }
});

export { countryAdmin as default, countryRepresentativeAdmin };
