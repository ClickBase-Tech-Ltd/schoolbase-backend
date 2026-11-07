import { Router, type NextFunction, type Request, type Response } from 'express';
import { Prisma, PrismaClient, type SupportStatus } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify } from 'jose';
import { getSessionSecret } from '../services/security-config.js';
import { buildSchoolSetupStatus } from '../services/onboarding.js';
import { billingMarkets, type BillingMarketCode } from '../services/billing-markets.js';
import { sendCountryAdminInviteEmail, sendSupportStatusUpdateNotification } from '../services/email.js';
import { chooseCountryRepresentative } from '../services/country-work-assignment.js';

const prisma = new PrismaClient();
const countryAdmin = Router();
const countryRepresentativeAdmin = Router();
const countryFollowUpStages = ['NEW', 'CONTACTED', 'ONBOARDING', 'BLOCKED', 'OPERATIONAL'] as const;

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
    return next();
  } catch (error) {
    return next(error);
  }
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
    const result = await prisma.supportRequest.updateMany({
      where: {
        id: req.params.requestId,
        school: { country: representative.countryCode },
      },
      data: { status: status as SupportStatus },
    });
    if (!result.count) return res.status(404).json({ error: 'Support request not found.' });
    return res.json({ success: true, status });
  } catch (error) {
    console.error('[country-admin] support status update failed:', error);
    return res.status(500).json({ error: 'Unable to update the support request.' });
  }
});

countryRepresentativeAdmin.use(authenticatePlatformAdmin);

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

countryRepresentativeAdmin.post('/', async (req: Request, res: Response) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const countryCode = typeof req.body?.countryCode === 'string' ? req.body.countryCode.trim().toUpperCase() : '';
  if (!name || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !Object.hasOwn(billingMarkets, countryCode)) {
    return res.status(400).json({ error: 'Enter a name, valid email address, and supported country.' });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) return res.status(409).json({ error: 'An account already uses this email address.' });

    const representative = await prisma.user.create({
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

countryRepresentativeAdmin.patch('/:userId', async (req: Request, res: Response) => {
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
    const result = await prisma.user.updateMany({
      where: { id: req.params.userId, role: 'COUNTRY_REP' },
      data: {
        ...(typeof countryCode === 'string' ? { countryCode: countryCode.toUpperCase() } : {}),
        ...(typeof isActive === 'boolean' ? { isActive } : {}),
      },
    });
    if (!result.count) return res.status(404).json({ error: 'Country representative not found.' });
    const representative = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { id: true, name: true, email: true, countryCode: true, isActive: true, createdAt: true },
    });
    return res.json({ representative });
  } catch (error) {
    console.error('[country-admin] representative update failed:', error);
    return res.status(500).json({ error: 'Unable to update the country representative.' });
  }
});

export { countryAdmin as default, countryRepresentativeAdmin };
