import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { jwtVerify, SignJWT } from 'jose';
import axios from 'axios';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { sendSetupReminderEmail } from '../services/email.js';
import { getPlatformSettings, serializePlatformSettingValue, normalizeEmailList, parsePlatformSettingValue, platformSettingDefaults, competitionFeatureKeys } from '../services/platform-settings.js';
import { normalizeCompetitionFeatures } from '../services/competition-feature-gate.js';
import { sendPendingSignupReminderEmail, sendWelcomeEmail, sendInternalSignupNotification } from '../services/email.js';
import { sendAdvertiserStatusEmail } from '../services/email.js';
import { normalizePlacementIds } from './ads-utils.js';
import { generateOtp, resendSignupOtp } from '../services/otp.js';
import { getSessionSecret } from '../services/security-config.js';
import { buildSchoolSetupStatus } from '../services/onboarding.js';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { URL } from 'node:url';

const router = Router();
type AdsPrismaClient = PrismaClient & {
  advertiser: any;
  adCampaign: any;
  adCampaignPlacement: any;
  campaignApprovalLog: any;
  adAnalyticsEvent: any;
  adPlacement: any;
  adCreative: any;
};
const prisma = new PrismaClient() as AdsPrismaClient;
const supportDb = prisma as any;
type AdCampaignStatusValue = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'LIVE' | 'PAUSED' | 'EXPIRED';

async function syncCampaignPlacements(campaignId: string, nextPlacementIds: unknown) {
  const placementIds = normalizePlacementIds(nextPlacementIds);
  const validPlacements = await prisma.adPlacement.findMany({
    where: { id: { in: placementIds } },
    select: { id: true },
  });

  const validPlacementIds = new Set(validPlacements.map((placement: { id: string }) => placement.id));
  const missingPlacements = placementIds.filter((placementId: string) => !validPlacementIds.has(placementId));
  if (missingPlacements.length > 0) {
    throw new Error(`One or more selected placements are unavailable: ${missingPlacements.join(', ')}`);
  }

  await prisma.$transaction(async (tx) => {
    const transactionClient = tx as typeof prisma & {
      adCampaignPlacement: {
        deleteMany: (args: any) => Promise<any>;
        createMany: (args: any) => Promise<any>;
      };
    };

    await transactionClient.adCampaignPlacement.deleteMany({ where: { campaignId } });
    if (placementIds.length > 0) {
      await transactionClient.adCampaignPlacement.createMany({
        data: placementIds.map((placementId: string) => ({ campaignId, placementId })),
      });
    }
  });

  return placementIds;
}

function getDeploymentVersion(): string {
  const configuredVersion = process.env.GIT_COMMIT_SHA || process.env.RELEASE_VERSION || process.env.VERCEL_GIT_COMMIT_SHA;
  if (configuredVersion) return configuredVersion;

  try {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: unknown };
    return typeof packageJson.version === 'string' && packageJson.version.trim() ? packageJson.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function getSchoolSetupChecklistData(schoolId: string) {
  const [school, enabledPhases, academicYears, classes, subjects, teacherClasses, feeSchedules, pupils, announcements, assessments] = await Promise.all([
    prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        name: true,
        initials: true,
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
    }),
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

  const status = buildSchoolSetupStatus({
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

  const completedItems = Object.entries(status.setupItems)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => {
      const labels: Record<string, string> = {
        hasEnabledPhases: 'Enabled school phases',
        hasAcademicYears: 'Academic years',
        hasClasses: 'Classes',
        hasSubjects: 'Subjects',
        hasStaff: 'Staff / teacher setup',
        hasFees: 'Fee schedules',
        hasStudents: 'Students registered',
        hasSchoolProfile: 'School profile details',
        hasSchoolLogo: 'School logo / branding',
        hasPrincipalInfo: 'Principal info',
        hasPrincipalSignature: 'Principal signature',
        hasSchoolStamp: 'School stamp',
        hasAnnouncement: 'Send your first announcement',
        hasAssessment: 'Publish your first assessment',
      };
      return labels[key] || key;
    });

  const missingItems = Object.entries(status.setupItems)
    .filter(([, value]) => !Boolean(value))
    .map(([key]) => {
      const labels: Record<string, string> = {
        hasEnabledPhases: 'Enabled school phases',
        hasAcademicYears: 'Academic years',
        hasClasses: 'Classes',
        hasSubjects: 'Subjects',
        hasStaff: 'Staff / teacher setup',
        hasFees: 'Fee schedules',
        hasStudents: 'Students registered',
        hasSchoolProfile: 'School profile details',
        hasSchoolLogo: 'School logo / branding',
        hasPrincipalInfo: 'Principal info',
        hasPrincipalSignature: 'Principal signature',
        hasSchoolStamp: 'School stamp',
        hasAnnouncement: 'Send your first announcement',
        hasAssessment: 'Publish your first assessment',
      };
      return labels[key] || key;
    });

  return {
    completedItems,
    missingItems,
    completionPercentage: status.completionPercentage,
    setupItems: status.setupItems,
    isComplete: status.isComplete,
  };
}

// Helper to get JWT secret
function secret() {
  return getSessionSecret();
}

// Middleware to verify platform admin session
const requirePlatformAdminSession = async (req: Request, res: Response): Promise<string | null> => {
  try {
    const cookieToken = req.cookies?.schoolbase_session;
    const headerToken = req.get('x-schoolbase-session') || req.get('X-Schoolbase-Session');
    const sessionToken = cookieToken || headerToken;

    if (!sessionToken) {
      res.status(401).json({ message: 'Unauthorized - no session' });
      return null;
    }

    const { payload } = await jwtVerify(sessionToken, secret());

    if (payload.role !== 'PLATFORM_ADMIN') {
      res.status(403).json({ message: 'Forbidden - not a platform admin' });
      return null;
    }

    return payload.userId as string;
  } catch (error) {
    console.error('[ADMIN] Session verification error:', error);
    res.status(401).json({ message: 'Unauthorized - invalid session' });
    return null;
  }
};

router.get('/ads/overview', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const [advertisers, campaigns, placements] = await Promise.all([
    prisma.advertiser.findMany({
      orderBy: { createdAt: 'desc' },
      include: { campaigns: true },
    }),
    prisma.adCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        advertiser: true,
        placements: { include: { placement: true } },
        creatives: { orderBy: { createdAt: 'asc' }, take: 1 },
        approvalLogs: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    }),
    prisma.adPlacement.findMany({ orderBy: { sortOrder: 'asc' } }),
  ]);

  const now = new Date();
  const activeCampaigns = campaigns.filter((campaign: any) => campaign.status === 'LIVE' && campaign.enabled && (!campaign.startDate || campaign.startDate <= now) && (!campaign.endDate || campaign.endDate >= now)).length;
  const pendingApprovals = campaigns.filter((campaign: any) => campaign.status === 'SUBMITTED' || campaign.status === 'DRAFT').length;
  const monthlyRevenue = campaigns.filter((campaign: any) => campaign.status === 'LIVE').reduce((total: number, campaign: any) => total + Number(campaign.budget || 0), 0);
  const impressions = await prisma.adAnalyticsEvent.count({ where: { eventType: 'IMPRESSION' } });
  const clicks = await prisma.adAnalyticsEvent.count({ where: { eventType: 'CLICK' } });
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;

  res.json({
    summary: {
      activeCampaigns,
      pendingApprovals,
      monthlyRevenue,
      impressions,
      clicks,
      ctr,
    },
    advertisers,
    campaigns,
    placements,
  });
});

router.get('/ads/advertisers', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const advertisers = await prisma.advertiser.findMany({
    orderBy: { createdAt: 'desc' },
    include: { campaigns: true },
  });

  res.json({ advertisers });
});

router.post('/ads/advertisers', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const { companyName, contactName, email, phone, website, category } = req.body || {};
  if (!companyName || !contactName || !email) {
    return res.status(400).json({ message: 'companyName, contactName, and email are required.' });
  }

  const advertiser = await prisma.advertiser.create({
    data: {
      companyName: String(companyName).trim(),
      contactName: String(contactName).trim(),
      email: String(email).trim(),
      phone: phone ? String(phone).trim() : null,
      website: website ? String(website).trim() : null,
      category: category ? String(category).trim() : null,
      verificationStatus: 'PENDING',
    },
  });

  res.status(201).json({ advertiser });
});

router.post('/ads/advertisers/:id/verify', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const advertiser = await prisma.advertiser.update({
    where: { id: req.params.id },
    data: { verificationStatus: 'VERIFIED', verifiedAt: new Date(), rejectionReason: null },
  });

  await sendAdvertiserStatusEmail({ email: advertiser.email, contactName: advertiser.contactName, companyName: advertiser.companyName, status: 'VERIFIED' }).catch((error) => console.error('[ADS] Advertiser verification email failed:', error));

  res.json({ advertiser });
});

router.post('/ads/advertisers/:id/reject', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const reason = req.body?.reason ? String(req.body.reason).trim() : 'Rejected by platform admin';
  const advertiser = await prisma.advertiser.update({
    where: { id: req.params.id },
    data: { verificationStatus: 'REJECTED', rejectionReason: reason, verifiedAt: null },
  });

  await sendAdvertiserStatusEmail({ email: advertiser.email, contactName: advertiser.contactName, companyName: advertiser.companyName, status: 'REJECTED', reason }).catch((error) => console.error('[ADS] Advertiser rejection email failed:', error));

  res.json({ advertiser });
});

router.get('/ads/campaigns', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const campaigns = await prisma.adCampaign.findMany({
    orderBy: { createdAt: 'desc' },
    include: { advertiser: true, placements: { include: { placement: true } }, creatives: true, approvalLogs: { orderBy: { createdAt: 'desc' } } },
  });

  res.json({ campaigns });
});

router.post('/ads/campaigns', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const { advertiserId, title, headline, summary, landingUrl, startDate, endDate, budget, currency, placements = [], creative } = req.body || {};
  if (!advertiserId || !title || !landingUrl) {
    return res.status(400).json({ message: 'advertiserId, title, and landingUrl are required.' });
  }

  const advertiser = await prisma.advertiser.findUnique({ where: { id: advertiserId } });
  if (!advertiser) {
    return res.status(404).json({ message: 'Advertiser not found.' });
  }

  const campaign = await prisma.adCampaign.create({
    data: {
      advertiserId,
      title: String(title).trim(),
      slug: `${String(title).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
      headline: headline ? String(headline).trim() : null,
      summary: summary ? String(summary).trim() : null,
      landingUrl: String(landingUrl).trim(),
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      budget: Number(budget || 0),
      currency: currency ? String(currency).trim() : 'NGN',
      status: 'DRAFT',
      enabled: true,
      creatives: creative ? {
        create: {
          imageUrl: creative.imageUrl ? String(creative.imageUrl).trim() : null,
          headline: creative.headline ? String(creative.headline).trim() : null,
          description: creative.description ? String(creative.description).trim() : null,
          ctaText: creative.ctaText ? String(creative.ctaText).trim() : 'Learn more',
          altText: creative.altText ? String(creative.altText).trim() : null,
        },
      } : undefined,
    },
    include: { creatives: true, placements: true },
  });

  if (Array.isArray(placements) && placements.length > 0) {
    await prisma.adCampaignPlacement.createMany({
      data: placements.map((placementId: string) => ({ campaignId: campaign.id, placementId })),
    });
  }

  res.status(201).json({ campaign });
});

router.patch('/ads/campaigns/:id', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const { id } = req.params;
  const updates = req.body || {};
  const nextStatus = updates.status ? String(updates.status) : undefined;

  const validStatusValues = new Set(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'LIVE', 'PAUSED', 'EXPIRED']);
  if (nextStatus && !validStatusValues.has(nextStatus)) {
    return res.status(400).json({ message: 'Invalid campaign status.' });
  }

  try {
    const campaign = await prisma.adCampaign.update({
      where: { id },
      data: {
        title: updates.title ? String(updates.title).trim() : undefined,
        headline: updates.headline !== undefined ? (updates.headline ? String(updates.headline).trim() : null) : undefined,
        summary: updates.summary !== undefined ? (updates.summary ? String(updates.summary).trim() : null) : undefined,
        landingUrl: updates.landingUrl ? String(updates.landingUrl).trim() : undefined,
        startDate: updates.startDate ? new Date(updates.startDate) : undefined,
        endDate: updates.endDate ? new Date(updates.endDate) : undefined,
        budget: updates.budget !== undefined ? Number(updates.budget || 0) : undefined,
        currency: updates.currency ? String(updates.currency).trim() : undefined,
        enabled: updates.enabled !== undefined ? Boolean(updates.enabled) : undefined,
        status: nextStatus as AdCampaignStatusValue | undefined,
      },
    });

    let placements: string[] | undefined;
    if (updates.placements !== undefined) {
      placements = await syncCampaignPlacements(id, updates.placements);
    }

    const refreshedCampaign = await prisma.adCampaign.findUnique({
      where: { id },
      include: {
        advertiser: true,
        placements: { include: { placement: true } },
        creatives: { orderBy: { createdAt: 'asc' }, take: 1 },
        approvalLogs: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    });

    res.json({ campaign: refreshedCampaign || campaign, placements });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update campaign.';
    res.status(400).json({ message });
  }
});

router.patch('/ads/campaigns/:id/placements', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const { id } = req.params;
  try {
    const placements = await syncCampaignPlacements(id, req.body?.placements ?? []);
    const campaign = await prisma.adCampaign.findUnique({
      where: { id },
      include: { advertiser: true, placements: { include: { placement: true } }, creatives: { orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    res.json({ campaign, placements });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update campaign placements.';
    res.status(400).json({ message });
  }
});

router.post('/ads/campaigns/:id/submit', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const campaign = await prisma.adCampaign.update({
    where: { id: req.params.id },
    data: { status: 'SUBMITTED', submittedAt: new Date() },
  });

  res.json({ campaign });
});

router.post('/ads/campaigns/:id/approve', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const existingCampaign = await prisma.adCampaign.findUnique({
    where: { id: req.params.id },
    include: { advertiser: { select: { verificationStatus: true } } },
  });
  if (!existingCampaign || existingCampaign.status !== 'SUBMITTED') {
    return res.status(400).json({ message: 'Only submitted campaigns can be approved.' });
  }
  if (existingCampaign.advertiser.verificationStatus !== 'VERIFIED') {
    return res.status(400).json({ message: 'Verify the advertiser before approving this campaign.' });
  }

  const campaign = await prisma.adCampaign.update({
    where: { id: req.params.id },
    data: {
      status: 'APPROVED',
      approvedBy: session,
      approvedAt: new Date(),
      rejectedReason: null,
    },
  });

  await prisma.campaignApprovalLog.create({
    data: {
      campaignId: campaign.id,
      reviewerId: session,
      action: 'APPROVED',
      notes: req.body?.notes ? String(req.body.notes).trim() : 'Approved by platform admin',
    },
  });

  const approvedAdvertiser = await prisma.advertiser.findUnique({ where: { id: campaign.advertiserId }, select: { email: true, contactName: true, companyName: true } });
  if (approvedAdvertiser) await sendAdvertiserStatusEmail({ ...approvedAdvertiser, status: 'APPROVED' }).catch((error) => console.error('[ADS] Campaign approval email failed:', error));

  res.json({ campaign });
});

router.post('/ads/campaigns/:id/live', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const campaign = await prisma.adCampaign.findUnique({ where: { id: req.params.id } });
  if (!campaign || campaign.status !== 'APPROVED') {
    return res.status(400).json({ message: 'Only approved campaigns can go live.' });
  }

  const liveCampaign = await prisma.adCampaign.update({
    where: { id: campaign.id },
    data: { status: 'LIVE', enabled: true },
  });

  await prisma.campaignApprovalLog.create({
    data: { campaignId: campaign.id, reviewerId: session, action: 'LIVE', notes: 'Activated by platform admin' },
  });

  res.json({ campaign: liveCampaign });
});

router.post('/ads/campaigns/:id/resume', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const campaign = await prisma.adCampaign.findUnique({ where: { id: req.params.id } });
  if (!campaign || campaign.status !== 'PAUSED') {
    return res.status(400).json({ message: 'Only paused campaigns can be resumed.' });
  }

  const resumedCampaign = await prisma.adCampaign.update({
    where: { id: campaign.id },
    data: { status: 'LIVE', enabled: true },
  });

  await prisma.campaignApprovalLog.create({
    data: { campaignId: campaign.id, reviewerId: session, action: 'LIVE', notes: 'Resumed by platform admin after pause' },
  });

  res.json({ campaign: resumedCampaign });
});

router.post('/ads/campaigns/:id/reject', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const { reason } = req.body || {};
  const campaign = await prisma.adCampaign.update({
    where: { id: req.params.id },
    data: {
      status: 'REJECTED',
      approvedBy: session,
      rejectedReason: reason ? String(reason).trim() : 'Rejected by platform admin',
    },
  });

  await prisma.campaignApprovalLog.create({
    data: {
      campaignId: campaign.id,
      reviewerId: session,
      action: 'REJECTED',
      reason: reason ? String(reason).trim() : 'Rejected by platform admin',
    },
  });

  res.json({ campaign });
});

router.get('/operations/status', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const startedAt = Date.now();
  const localApiBase = `http://127.0.0.1:${process.env.API_PORT || 3006}`;
  const frontendBase = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/$/, '');
  const endpointDefinitions = [
    { key: 'api', label: 'Core API', url: `${localApiBase}/health` },
    { key: 'auth', label: 'Authentication API', url: `${localApiBase}/api/auth/login` },
    { key: 'public', label: 'Public API', url: `${localApiBase}/api/pricing` },
    { key: 'country', label: 'Country API', url: `${localApiBase}/api/country/config` },
    { key: 'schoolAdminApp', label: 'School Admin App', url: `${localApiBase}/api/admin/students/data` },
    { key: 'admin', label: 'Admin API', url: `${localApiBase}/api/admin/verify` },
    { key: 'subscription', label: 'Subscription API', url: `${localApiBase}/api/admin/subscribe/data` },
    { key: 'adminComponents', label: 'Assessment Components', url: `${localApiBase}/api/admin/assessment-components` },
    { key: 'flexibleResults', label: 'Flexible Results', url: `${localApiBase}/api/admin/flexible-results` },
    { key: 'assessmentSetup', label: 'Assessment Setup', url: `${localApiBase}/api/assessments/setup` },
    { key: 'parentsApp', label: 'Parents App', url: `${localApiBase}/api/parent/children` },
    { key: 'parent', label: 'Parent API', url: `${localApiBase}/api/parent/verify` },
    { key: 'teachersApp', label: 'Teachers App', url: `${localApiBase}/api/teacher/classes` },
    { key: 'teacher', label: 'Teacher API', url: `${localApiBase}/api/teacher/dashboard` },
    { key: 'bursar', label: 'Bursar API', url: `${localApiBase}/api/bursar/overview` },
    { key: 'results', label: 'Results API', url: `${localApiBase}/api/results/data` },
    { key: 'reportCards', label: 'Report Cards', url: `${localApiBase}/api/report-cards` },
    { key: 'pdfReports', label: 'PDF Reports', url: `${localApiBase}/api/pdf-reports` },
    { key: 'resultPins', label: 'Result PINs', url: `${localApiBase}/api/result-pins/status` },
    { key: 'timetable', label: 'Timetable API', url: `${localApiBase}/api/admin/timetable` },
    { key: 'paystack', label: 'Paystack API', url: `${localApiBase}/api/paystack/status` },
    { key: 'signup', label: 'Signup & OTP API', url: `${localApiBase}/api/trial/status` },
    { key: 'whatsapp', label: 'WhatsApp API', url: `${localApiBase}/api/whatsapp/status` },
    { key: 'communications', label: 'Communication API', url: `${localApiBase}/api/admin/notifications/data` },
    { key: 'platformAdminApp', label: 'Platform Admin App', url: `${localApiBase}/schoolbase-admin/api/schools?limit=1` },
    { key: 'platformAdmin', label: 'Platform Admin API', url: `${localApiBase}/schoolbase-admin/api/stats` },
    { key: 'adsApi', label: 'Ads API', url: `${localApiBase}/schoolbase-admin/api/ads/overview` },
    { key: 'platformWhatsApp', label: 'Platform WhatsApp', url: `${localApiBase}/schoolbase-admin/api/whatsapp/status` },
    ...(frontendBase ? [{ key: 'frontend', label: 'Frontend', url: `${frontendBase}/login` }] : []),
  ];

  const endpointChecks = await Promise.all(endpointDefinitions.map(async (endpoint) => {
    const checkStartedAt = Date.now();
    try {
      const response = await fetch(endpoint.url, { method: 'GET', signal: AbortSignal.timeout(5000), redirect: 'manual' });
      const reachable = response.status < 500;
      let providerStatus: string | undefined;
      try {
        const payload = await response.clone().json() as { status?: unknown };
        if (typeof payload?.status === 'string') providerStatus = payload.status;
      } catch {
        // Most protected endpoint checks return HTML or an empty body; reachability is still valid.
      }
      const normalizedProviderStatus = providerStatus?.toUpperCase();
      const status = !reachable || normalizedProviderStatus === 'DOWN' ? 'DOWN'
        : ['DEGRADED', 'NOT_CONFIGURED', 'NOT_READY', 'DISABLED'].includes(normalizedProviderStatus || '') ? 'DEGRADED'
          : 'UP';
      return { ...endpoint, status, httpStatus: response.status, responseMs: Date.now() - checkStartedAt, providerStatus };
    } catch (error) {
      return { ...endpoint, status: 'DOWN', httpStatus: null, responseMs: Date.now() - checkStartedAt, error: error instanceof Error ? error.message : 'Request failed' };
    }
  }));

  try {
    await prisma.$queryRaw`SELECT 1`;
    const database = { status: 'UP', responseMs: Date.now() - startedAt };
    const downCount = endpointChecks.filter((check) => check.status === 'DOWN').length;
    const signalSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recentAuditEvents, openSupportRequests, adCampaignCounts, adEventCounts] = await Promise.all([
      prisma.platformAuditLog.findMany({
        where: { createdAt: { gte: signalSince } },
        select: { id: true, event: true, details: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 12,
      }),
      (prisma as any).platformSupportRequest?.count?.({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }) ?? Promise.resolve(0),
      prisma.adCampaign.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
      prisma.adAnalyticsEvent.groupBy({ by: ['eventType'], _count: { _all: true } }).catch(() => []),
    ]);
    const attentionEvents = recentAuditEvents.filter((event: any) => /FAIL|ERROR|REJECT|DOWN|SCOPE/i.test(event.event));
    return res.json({
      service: downCount === endpointChecks.length ? 'down' : downCount > 0 ? 'degraded' : 'ready',
      database,
      endpointChecks,
      uptimeSeconds: Math.floor(process.uptime()),
      deploymentVersion: getDeploymentVersion(),
      checkedAt: new Date().toISOString(),
      responseMs: Date.now() - startedAt,
      environment: process.env.NODE_ENV || 'development',
      attention: {
        recentAuditEvents,
        attentionEvents,
        openSupportRequests,
      },
      ads: {
        campaignsByStatus: Object.fromEntries(adCampaignCounts.map((entry: any) => [entry.status, entry._count?._all || 0])),
        impressions: adEventCounts.find((entry: any) => entry.eventType === 'IMPRESSION')?._count?._all || 0,
        clicks: adEventCounts.find((entry: any) => entry.eventType === 'CLICK')?._count?._all || 0,
      },
    });
  } catch (error) {
    console.error('[platform operations] status check failed:', error);
    return res.status(503).json({ service: 'degraded', database: { status: 'DOWN', responseMs: Date.now() - startedAt }, endpointChecks, checkedAt: new Date().toISOString() });
  }
});

router.get('/operations/database-export', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return res.status(503).json({ error: 'DATABASE_URL is not configured' });

  let tempDir: string | null = null;
  let defaultsFile: string | null = null;
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== 'mysql:') {
      return res.status(501).json({ error: 'Database export currently supports MySQL only' });
    }

    const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (!databaseName) return res.status(503).json({ error: 'Database name is missing from DATABASE_URL' });

    const dumpCandidates = [
      process.env.MYSQLDUMP_PATH,
      'mysqldump',
      '/usr/bin/mysqldump',
      '/usr/local/bin/mysqldump',
      '/Applications/XAMPP/xamppfiles/bin/mysqldump',
    ].filter((candidate): candidate is string => Boolean(candidate));
    let dumpBinary: string | null = null;
    for (const candidate of dumpCandidates) {
      if (candidate === 'mysqldump') {
        dumpBinary = candidate;
        break;
      }
      try {
        await access(candidate);
        dumpBinary = candidate;
        break;
      } catch {
        // Try the next known installation path.
      }
    }
    if (!dumpBinary) return res.status(503).json({ error: 'mysqldump is not installed or MYSQLDUMP_PATH is invalid' });

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'schoolbase-db-export-'));
    defaultsFile = path.join(tempDir, 'client.cnf');
    const config = [
      '[client]',
      `host=${parsed.hostname}`,
      `user=${decodeURIComponent(parsed.username)}`,
      `password=${decodeURIComponent(parsed.password)}`,
      ...(parsed.port ? [`port=${parsed.port}`] : []),
      '',
    ].join('\n');
    await writeFile(defaultsFile, config, { mode: 0o600 });
    const cleanup = async () => {
      if (defaultsFile) await unlink(defaultsFile).catch(() => {});
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    };

    await prisma.platformAuditLog.create({
      data: {
        userId: session,
        event: 'DATABASE_EXPORT_STARTED',
        details: 'Platform administrator requested a complete database export.',
      },
    });

    const filename = `schoolbase-database-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
    const dumpFile = path.join(tempDir, 'database.sql');
    const dump = spawn(dumpBinary, [
      `--defaults-extra-file=${defaultsFile}`,
      '--single-transaction',
      '--quick',
      '--routines',
      '--triggers',
      '--set-gtid-purged=OFF',
      databaseName,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    dump.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const outputChunks: Buffer[] = [];
    dump.stdout.on('data', (chunk) => outputChunks.push(Buffer.from(chunk)));
    const dumpResult = await new Promise<{ code: number | null }>((resolve, reject) => {
      dump.on('error', reject);
      dump.on('close', (code) => resolve({ code }));
    });
    await writeFile(dumpFile, Buffer.concat(outputChunks), { mode: 0o600 });
    const dumpStats = await stat(dumpFile);
    if (dumpResult.code !== 0 || dumpStats.size === 0) {
      console.error('[platform operations] mysqldump failed:', dumpResult.code, stderr);
      await prisma.platformAuditLog.create({
        data: {
          userId: session,
          event: 'DATABASE_EXPORT_FAILED',
          details: `Database export failed with exit code ${dumpResult.code ?? 'unknown'}${stderr ? `: ${stderr.slice(0, 500)}` : '.'}`,
        },
      }).catch((error) => console.error('[platform operations] export audit failed:', error));
      await cleanup();
      return res.status(502).json({ error: 'Database export failed. No download was created.' });
    }

    await prisma.platformAuditLog.create({
      data: { userId: session, event: 'DATABASE_EXPORT_COMPLETED', details: 'Complete database export finished.' },
    }).catch((error) => console.error('[platform operations] export audit failed:', error));
    res.status(200);
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    const output = await readFile(dumpFile);
    await cleanup();
    res.send(output);
  } catch (error) {
    if (defaultsFile) await unlink(defaultsFile).catch(() => {});
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    console.error('[platform operations] database export setup failed:', error);
    return res.status(500).json({ error: 'Could not prepare database export' });
  }
});

// GET /schoolbase-admin/api/subscription-payments - Get platform subscription payment history
router.get('/subscription-payments', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const page = parseInt(req.query.page as string) || 1;
    const skip = (page - 1) * limit;

    const payments = await prisma.platformPayment.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        amount: true,
        method: true,
        reference: true,
        createdAt: true,
        recordedBy: true,
        note: true,
      },
    });

    const parseNote = (note: string | null) => {
      if (!note) return null;
      try {
        return JSON.parse(note);
      } catch {
        return null;
      }
    };

    const getSchoolNameFromNote = (noteText: string | null) => {
      if (!noteText) return null;
      const schoolNameMatch = noteText.match(/for\s+(.+?)\s*\(/i) || noteText.match(/for\s+(.+?)\s*—/i);
      if (schoolNameMatch?.[1]) {
        return schoolNameMatch[1].trim();
      }
      return null;
    };

    const paymentRecords = payments
      .map((payment: any) => {
        const parsedNote = parseNote(payment.note);
        const noteStatus = parsedNote?.paymentStatus?.toUpperCase() || parsedNote?.status?.toUpperCase();
        const noteText = typeof payment.note === 'string' ? payment.note : null;
        const reference = (payment.reference || '').toUpperCase();
        const isTrialLike =
          reference.startsWith('TRIAL-') ||
          /\btrial\b/i.test(noteText || '') ||
          payment.amount === 0 ||
          payment.method === 'OTHER';
        const hasSuccessfulStatus = noteStatus ? ['COMPLETED', 'SUCCESSFUL', 'SUCCESS', 'PAID', 'ACTIVE'].includes(noteStatus) : false;
        const isPaystackCheckoutEntry =
          parsedNote?.source === 'paystack-init' ||
          parsedNote?.source === 'paystack-verify' ||
          (payment.amount > 0 && payment.method === 'CARD' && Boolean(payment.reference));
        const isRelevantSubscriptionPayment = !isTrialLike && (hasSuccessfulStatus || isPaystackCheckoutEntry);

        return {
          payment,
          parsedNote,
          noteStatus,
          noteText,
          isRelevantSubscriptionPayment,
        };
      })
      .filter((entry) => entry.isRelevantSubscriptionPayment);

    const schoolIds = [...new Set(paymentRecords.flatMap((entry) => {
      const ids = [] as string[];
      if (entry.payment.recordedBy) ids.push(entry.payment.recordedBy);
      if (entry.parsedNote?.schoolId) ids.push(entry.parsedNote.schoolId);
      return ids;
    }).filter(Boolean))];

    const schools = schoolIds.length > 0
      ? await prisma.school.findMany({
          where: { id: { in: schoolIds } },
          select: {
            id: true,
            name: true,
            slug: true,
            email: true,
            country: true,
            plan: true,
            status: true,
          },
        })
      : [];

    const schoolMap = new Map(schools.map((school: any) => [school.id, school]));

    const formattedPayments = await Promise.all(paymentRecords.map(async (entry) => {
      const { payment, parsedNote, noteStatus, noteText } = entry;
      let school = schoolMap.get(payment.recordedBy) || (parsedNote?.schoolId ? schoolMap.get(parsedNote.schoolId) : null);

      if (!school) {
        const schoolName = getSchoolNameFromNote(noteText);
        if (schoolName) {
          const schoolMatch = await prisma.school.findFirst({
            where: {
              OR: [
                { name: { equals: schoolName } },
                { slug: { equals: schoolName } },
              ],
            },
            select: {
              id: true,
              name: true,
              slug: true,
              email: true,
              country: true,
              plan: true,
              status: true,
            },
          });
          school = schoolMatch || null;
        }
      }

      return {
        id: payment.id,
        amount: payment.amount,
        method: payment.method,
        reference: payment.reference,
        createdAt: payment.createdAt,
        schoolId: payment.recordedBy || parsedNote?.schoolId || null,
        schoolName: school?.name || parsedNote?.schoolName || getSchoolNameFromNote(noteText) || 'Unknown school',
        schoolSlug: school?.slug || parsedNote?.schoolSlug || null,
        schoolEmail: school?.email || parsedNote?.schoolEmail || null,
        schoolCountry: school?.country || parsedNote?.schoolCountry || null,
        plan: school?.plan || parsedNote?.plan || null,
        status: school?.status || parsedNote?.status || null,
        paymentStatus: noteStatus || 'COMPLETED',
      };
    }));

    const total = formattedPayments.length;
    const startIndex = (page - 1) * limit;
    const paginatedPayments = formattedPayments.slice(startIndex, startIndex + limit);

    res.json({
      payments: formattedPayments,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching subscription payments:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to fetch subscription payments' });
  }
});

// GET /schoolbase-admin/api/stats - Get platform dashboard statistics
router.get('/stats', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const [totalSchools, activeSchools, totalUsers, supportRequests, trialSchools] = await Promise.all([
      prisma.school.count(),
      prisma.school.count({ where: { status: 'ACTIVE' } }),
      prisma.user.count({ where: { role: { in: ['SCHOOL_ADMIN', 'BURSAR', 'TEACHER', 'PARENT'] } } }),
      (prisma as any).platformSupportRequest?.count?.() ?? Promise.resolve(0),
      prisma.school.count({ where: { status: 'TRIAL' } }),
    ]);

    res.json({
      totalSchools,
      activeSchools,
      totalUsers,
      supportRequests: supportRequests || 0,
      trialSchools,
      activePercentage: totalSchools > 0 ? Math.round((activeSchools / totalSchools) * 100) : 0,
    });
  } catch (error) {
    console.error('Error fetching platform stats:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to fetch stats' });
  }
});

// GET /schoolbase-admin/api/profile - Get current platform admin profile
router.get('/profile', async (req: Request, res: Response) => {
  const userId = await requirePlatformAdminSession(req, res);
  if (!userId) return;

  try {
    const admin = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });

    if (!admin || admin.role !== 'PLATFORM_ADMIN') {
      return res.status(403).json({ message: 'Platform admin session required' });
    }

    res.json({ admin });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to fetch profile' });
  }
});

// PATCH /schoolbase-admin/api/profile - Update current platform admin profile
router.patch('/profile', async (req: Request, res: Response) => {
  const userId = await requirePlatformAdminSession(req, res);
  if (!userId) return;

  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({ message: 'Name and email are required' });
    }

    const admin = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!admin || admin.role !== 'PLATFORM_ADMIN') {
      return res.status(403).json({ message: 'Platform admin session required' });
    }

    const updated = await prisma.user.update({
      where: { id: admin.id },
      data: {
        name: String(name).trim(),
        email: String(email).trim(),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });

    res.json({ admin: updated });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to update profile' });
  }
});

// GET /schoolbase-admin/api/settings - Get platform settings
router.get('/settings', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const settings = await getPlatformSettings(prisma);
    res.json({
      settings,
      defaults: platformSettingDefaults,
    });
  } catch (error) {
    console.error('Error fetching platform settings:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to fetch settings' });
  }
});

// PATCH /schoolbase-admin/api/settings - Update platform settings
router.patch('/settings', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { settings } = req.body ?? {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ message: 'A settings object is required.' });
    }

    const input = settings as Record<string, unknown>;
    const normalizedSettings: Record<string, unknown> = { ...input };
    for (const key of ['signupNotificationRecipients', 'supportNotificationRecipients']) {
      if (key in input) {
        const recipients = normalizeEmailList(input[key]);
        if (recipients.length === 0) {
          return res.status(400).json({ message: `${key} must contain at least one valid email address.` });
        }
        normalizedSettings[key] = recipients;
      }
    }

    if ('paymentPlans' in input) {
      const plans = input.paymentPlans;
      if (!plans || typeof plans !== 'object' || Array.isArray(plans)) {
        return res.status(400).json({ message: 'paymentPlans must be an object.' });
      }
      for (const plan of ['STARTER', 'GROWTH', 'ENTERPRISE']) {
        const config = (plans as Record<string, any>)[plan];
        if (!config || typeof config.label !== 'string' || !config.label.trim() || typeof config.priceLabel !== 'string' || !config.priceLabel.trim() || !Number.isInteger(config.amountMinor) || config.amountMinor < 0 || (config.studentLimit !== null && (!Number.isInteger(config.studentLimit) || config.studentLimit <= 0))) {
          return res.status(400).json({ message: `Invalid ${plan} payment plan configuration.` });
        }
      }
    }

    if ('competitionFeatures' in input) {
      const features = input.competitionFeatures;
      if (!features || typeof features !== 'object' || Array.isArray(features)) {
        return res.status(400).json({ message: 'competitionFeatures must be an object.' });
      }
      const featureSettings = features as Record<string, unknown>;
      if (Object.keys(featureSettings).some((key) => !competitionFeatureKeys.includes(key as typeof competitionFeatureKeys[number])) ||
          competitionFeatureKeys.some((key) => typeof featureSettings[key] !== 'boolean')) {
        return res.status(400).json({ message: 'competitionFeatures must contain every supported feature key with a boolean value.' });
      }
      if (featureSettings['competition.enabled'] !== true &&
          competitionFeatureKeys.some((key) => key !== 'competition.enabled' && featureSettings[key] === true)) {
        return res.status(400).json({ message: 'Enable the Competition module before enabling individual Competition features.' });
      }
      normalizedSettings.competitionFeatures = normalizeCompetitionFeatures(featureSettings);
    }

    const entries = Object.entries(normalizedSettings);
    await prisma.$transaction(
      entries.map(([key, value]) =>
        prisma.platformSetting.upsert({
          where: { key },
          create: { key, value: serializePlatformSettingValue(value) },
          update: { value: serializePlatformSettingValue(value) },
        })
      )
    );

    await prisma.platformAuditLog.create({
      data: {
        userId: session,
        event: 'PLATFORM_SETTINGS_UPDATED',
        details: `Updated settings: ${entries.map(([key]) => key).join(', ')}`,
      },
    });

    res.json({ success: true, settings: normalizedSettings });
  } catch (error) {
    console.error('Error updating platform settings:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to update settings' });
  }
});

// GET /schoolbase-admin/api/audit-logs - Get recent platform activity
router.get('/audit-logs', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const page = parseInt(req.query.page as string) || 1;
    const requestedLimit = parseInt(req.query.limit as string) || 50;
    const limit = Math.min(Math.max(requestedLimit, 10), 200);
    const requestedDays = Number.parseInt(String(req.query.days || '90'), 10);
    const days = Number.isFinite(requestedDays) ? Math.min(Math.max(requestedDays, 1), 365) : 90;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const skip = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const schoolName = String(req.query.school || '').trim();
    const action = String(req.query.action || '').trim();

    const where: any = {
      createdAt: { gte: since },
    };
    if (schoolName) where.school = { is: { name: schoolName } };
    if (action) where.event = action;
    if (search) {
      where.OR = [
        { event: { contains: search } },
        { details: { contains: search } },
        { user: { is: { name: { contains: search } } } },
        { user: { is: { email: { contains: search } } } },
        { school: { is: { name: { contains: search } } } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.platformAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          event: true,
          details: true,
          createdAt: true,
          user: {
            select: {
              name: true,
              email: true,
            },
          },
          school: {
            select: {
              name: true,
            },
          },
        },
      }),
      prisma.platformAuditLog.count({ where }),
    ]);

    res.json({
      logs: logs.map((log: any) => ({
        id: log.id,
        event: log.event,
        action: log.event,
        details: log.details,
        createdAt: log.createdAt,
        user: log.user,
        school: log.school,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to fetch activity' });
  }
});

// GET /schoolbase-admin/api/activity-summary - Summarize school activity for operations
router.get('/activity-summary', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const requestedDays = Number.parseInt(String(req.query.days || '30'), 10);
    const days = Number.isFinite(requestedDays) ? Math.min(Math.max(requestedDays, 7), 90) : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [logs, schools, eventTotal, recentEvents, protectedEvents] = await Promise.all([
      prisma.platformAuditLog.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 10000,
        select: { id: true, schoolId: true, event: true, createdAt: true, school: { select: { name: true } } },
      }),
      prisma.school.findMany({
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, status: true, createdAt: true },
      }),
      prisma.platformAuditLog.count({ where: { createdAt: { gte: since } } }),
      prisma.platformAuditLog.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
      prisma.platformAuditLog.count({
        where: {
          createdAt: { gte: since },
          OR: [{ event: { contains: 'VERIFY' } }, { details: { contains: 'verify' } }],
        },
      }),
    ]);

    const actionCounts = new Map<string, { action: string; count: number }>();
    const schoolCounts = new Map<string, { count: number; lastActivity: Date | null; actions: Set<string> }>();
    const dailyCounts = new Map<string, number>();

    for (const log of logs) {
      const action = log.event.replace(/^API_(GET|POST|PUT|PATCH|DELETE)_/, '').replace(/^API_/, '');
      const currentAction = actionCounts.get(log.event) || { action, count: 0 };
      currentAction.count += 1;
      actionCounts.set(log.event, currentAction);

      const day = log.createdAt.toISOString().slice(0, 10);
      dailyCounts.set(day, (dailyCounts.get(day) || 0) + 1);

      if (log.schoolId) {
        const current = schoolCounts.get(log.schoolId) || { count: 0, lastActivity: null, actions: new Set<string>() };
        current.count += 1;
        current.lastActivity = current.lastActivity && current.lastActivity > log.createdAt ? current.lastActivity : log.createdAt;
        current.actions.add(action);
        schoolCounts.set(log.schoolId, current);
      }
    }

    const schoolActivity = schools.map((school) => {
      const activity = schoolCounts.get(school.id);
      return {
        id: school.id,
        name: school.name,
        status: school.status,
        createdAt: school.createdAt,
        activityCount: activity?.count || 0,
        lastActivity: activity?.lastActivity || null,
        actionCount: activity?.actions.size || 0,
      };
    }).sort((a, b) => {
      if (b.activityCount !== a.activityCount) return b.activityCount - a.activityCount;
      return a.name.localeCompare(b.name);
    });

    const activeSchools = schoolActivity.filter((school) => school.activityCount > 0).length;
    const silentSchools = schoolActivity.filter((school) => school.activityCount === 0).length;
    const trend = Array.from({ length: days }, (_, index) => {
      const date = new Date(Date.now() - (days - index - 1) * 24 * 60 * 60 * 1000);
      const key = date.toISOString().slice(0, 10);
      return { date: key, count: dailyCounts.get(key) || 0 };
    });

    res.json({
      days,
      since,
      totals: { events: eventTotal, recentEvents, protectedEvents, schools: schools.length, activeSchools, silentSchools },
      actionBreakdown: Array.from(actionCounts.entries()).map(([event, item]) => ({ event, action: item.action, count: item.count })).sort((a, b) => b.count - a.count).slice(0, 50),
      trend,
      schoolActivity,
    });
  } catch (error) {
    console.error('Error building activity summary:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to build activity summary' });
  }
});

// GET /schoolbase-admin/api/schools - Get all schools with pagination and optional filtering
router.get('/schools', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const status = req.query.status as string;
    const search = (req.query.search as string) || '';
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status && ['ACTIVE', 'SUSPENDED', 'TRIAL', 'CANCELLED'].includes(status)) {
      where.status = status;
    }

    if (search.trim()) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { country: { contains: search, mode: 'insensitive' } },
        { plan: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [schools, total] = await Promise.all([
      prisma.school.findMany({
        where,
        select: {
          id: true,
          name: true,
          slug: true,
          email: true,
          phone: true,
          status: true,
          plan: true,
          country: true,
          createdAt: true,
          updatedAt: true,
          trialEndsAt: true,
          subscriptionExpiresAt: true,
          logoUrl: true,
          users: {
            where: { role: 'SCHOOL_ADMIN' },
            select: { email: true }
          },
          _count: {
            select: { users: true, pupils: true, classes: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.school.count({ where }),
    ]);

    // Get verification status for all schools - check if admin email has verified OTP
    const verificationMap = new Map<string, boolean>();
    if (schools.length > 0) {
      const adminEmails = schools
        .map((s: any) => s.users[0]?.email)
        .filter(Boolean)
        .map((email: string) => email.trim().toLowerCase());

      if (adminEmails.length > 0) {
        const verifiedOtps = await prisma.signupOtp.findMany({
          where: {
            email: { in: adminEmails },
            verifiedAt: { not: null }
          },
          select: { email: true }
        });

        verifiedOtps.forEach((otp: any) => {
          verificationMap.set((otp.email || '').trim().toLowerCase(), true);
        });
      }
    }

    res.json({
      schools: schools.map((school: any) => ({
        id: school.id,
        name: school.name,
        slug: school.slug,
        email: school.email,
        phone: school.phone,
        status: school.status,
        plan: school.plan,
        country: school.country,
        createdAt: school.createdAt,
        updatedAt: school.updatedAt,
        trialEndsAt: school.trialEndsAt,
        subscriptionExpiresAt: school.subscriptionExpiresAt,
        logoUrl: school.logoUrl,
        userCount: school._count.users,
        pupilCount: school._count.pupils,
        classCount: school._count.classes,
        planLimit: getPlanStudentLimit(school.plan),
        isVerified: verificationMap.has(school.users[0]?.email) || false,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching schools:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to fetch schools' });
  }
});

// GET /schoolbase-admin/api/schools/:schoolId - Get single school detail
router.get('/schools/:schoolId', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { schoolId } = req.params;

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        country: true,
        email: true,
        phone: true,
        tagline: true,
        address: true,
        plan: true,
        status: true,
        trialEndsAt: true,
        createdAt: true,
        principalName: true,
        principalComment: true,
        stampUrl: true,
        principalSignatureUrl: true,
        users: {
          where: { role: 'SCHOOL_ADMIN' },
          select: { email: true }
        },
      },
    });

    if (!school) {
      return res.status(404).json({ message: 'School not found.' });
    }

    const adminEmail = school.users[0]?.email;
    let isVerified = false;

    if (adminEmail) {
      const normalizedEmail = adminEmail.trim().toLowerCase();
      const verifiedOtp = await prisma.signupOtp.findFirst({
        where: {
          email: normalizedEmail,
          verifiedAt: { not: null }
        },
        select: { email: true }
      });

      isVerified = !!verifiedOtp;
    }

    res.json({
      ...school,
      isVerified,
    });
  } catch (error) {
    console.error('Error fetching school detail:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to fetch school detail' });
  }
});

// GET /schoolbase-admin/api/email-logs - Get email logs with filtering
router.get('/email-logs', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const emailType = req.query.emailType as string;
    const campaignOnly = req.query.campaignOnly === 'true';
    const limit = parseInt(req.query.limit as string) || 50;
    const page = parseInt(req.query.page as string) || 1;
    const skip = (page - 1) * limit;

    // Valid email types from Prisma enum
    const validEmailTypes = [
      'SIGNUP_VERIFICATION',
      'PASSWORD_RESET',
      'TRIAL_STARTED',
      'PURCHASE_CONFIRMATION',
      'WELCOME',
      'GUARDIAN_REGISTRATION',
      'INVOICE_PAYMENT',
      'SETUP_COMPLETION_REMINDER',
      'GETTING_STARTED',
      'TRIAL_EXPIRY_WARNING',
      'SUBSCRIPTION_EXPIRY_WARNING',
      'ONBOARDING_CHECKLIST',
      'PRODUCT_UPDATE',
      'PRICE_UPDATE',
      'SUBSCRIPTION_THANK_YOU',
      'SUPPORT_UPDATE',
      'ONBOARDING_GUIDANCE',
      'BEST_PRACTICE_TIP',
      'MANUAL_ANNOUNCEMENT',
      'POLICY_UPDATE',
      'ACCOUNT_SECURITY',
      'ACCOUNT_VERIFICATION_SUSPENSION',
    ];

    const where: any = {};
    if (emailType && emailType !== 'ALL') {
      const normalizedEmailType = emailType;
      if (!validEmailTypes.includes(normalizedEmailType)) {
        return res.status(400).json({ 
          message: `Invalid email type: ${emailType}. Valid types are: ${validEmailTypes.join(', ')}`
        });
      }
      where.emailType = normalizedEmailType;
    }
    if (campaignOnly) {
      where.metadata = { contains: '"campaign":true' };
    }

    const [logs, total] = await Promise.all([
      (prisma as any).emailLog.findMany({
        where,
        select: {
          id: true,
          schoolId: true,
          school: { select: { name: true } },
          recipientEmail: true,
          recipientName: true,
          emailType: true,
          subject: true,
          sentAt: true,
          status: true,
        },
        orderBy: { sentAt: 'desc' },
        skip,
        take: limit,
      }),
      (prisma as any).emailLog.count({ where }),
    ]);

    res.json({
      logs: logs.map((log: any) => ({
        ...log,
        schoolName: log.school?.name,
        school: undefined,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching email logs:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to fetch email logs' });
  }
});

// POST /schoolbase-admin/api/reminders/send-bulk - Send setup reminders to all incomplete schools
router.post('/reminders/send-bulk', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    console.log('📧 Sending bulk setup completion reminders...');
    
    // Find all schools with incomplete setup (those created more than 7 days ago but not all data entered)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    const allSchools = await prisma.school.findMany({
      where: {
        createdAt: { lt: sevenDaysAgo },
      },
      select: {
        id: true,
        name: true,
        email: true,
        users: {
          select: { email: true, name: true, role: true },
          where: { role: 'SCHOOL_ADMIN' },
        },
      },
    });

    const incompleteSchools: Array<typeof allSchools[number]> = [];
    for (const school of allSchools) {
      const checklist = await getSchoolSetupChecklistData(school.id);
      if (!checklist.isComplete) {
        incompleteSchools.push(school);
      }
    }

    console.log(`Found ${incompleteSchools.length} incomplete schools to send reminders to`);

    let sentCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    // Send reminder emails
    for (const school of incompleteSchools) {
      try {
        const admin = school.users[0];
        if (!admin || !admin.email) {
          console.warn(`⚠️ No admin email for school ${school.id}`);
          failedCount++;
          continue;
        }

        const checklist = await getSchoolSetupChecklistData(school.id);

        // Send actual email
        await sendSetupReminderEmail(
          admin.email,
          admin.name || 'School Administrator',
          school.name,
          [],
          checklist.completedItems,
          checklist.missingItems,
          checklist.completionPercentage,
        );

        // Log the successful email send attempt
        await (prisma as any).emailLog.create({
          data: {
            schoolId: school.id,
            recipientEmail: admin.email,
            recipientName: admin.name,
            emailType: 'SETUP_COMPLETION_REMINDER',
            subject: `Complete your SchoolBase setup - ${school.name}`,
            status: 'SENT',
            sentAt: new Date(),
          },
        });

        console.log(`✅ Reminder sent to ${school.name} (${admin.email})`);
        sentCount++;
      } catch (err: any) {
        console.error(`❌ Failed to send reminder to school ${school.id}:`, err);
        errors.push(`${school.name}: ${err.message}`);
        
        // Log the failed email attempt
        try {
          await (prisma as any).emailLog.create({
            data: {
              schoolId: school.id,
              recipientEmail: school.users[0]?.email,
              recipientName: school.users[0]?.name,
              emailType: 'SETUP_COMPLETION_REMINDER',
              subject: `Complete your SchoolBase setup - ${school.name}`,
              status: 'FAILED',
              error: err.message,
              sentAt: new Date(),
            },
          });
        } catch (logErr) {
          console.error('Failed to log email error:', logErr);
        }
        
        failedCount++;
      }
    }

    console.log(`📊 Summary: ${sentCount} sent, ${failedCount} failed`);
    
    res.json({ 
      success: true,
      sentCount, 
      failedCount,
      total: incompleteSchools.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error: any) {
    console.error('❌ Error sending bulk reminders:', error);
    res.status(500).json({ 
      success: false,
      message: error.message || 'Failed to send reminders' 
    });
  }
});

// POST /schoolbase-admin/api/reminders/send-single - Send setup reminder to specific school
router.post('/reminders/send-single', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { schoolId } = req.body;

    if (!schoolId) {
      return res.status(400).json({ 
        success: false,
        message: 'schoolId is required' 
      });
    }

    console.log(`📧 Sending setup reminder to school ${schoolId}...`);

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        id: true,
        name: true,
        email: true,
        users: {
          select: { email: true, name: true, role: true },
          where: { role: 'SCHOOL_ADMIN' },
        },
      },
    });

    if (!school) {
      return res.status(404).json({ 
        success: false,
        message: 'School not found' 
      });
    }

    const admin = school.users[0];
    if (!admin || !admin.email) {
      return res.status(400).json({ 
        success: false,
        message: 'School admin email not found' 
      });
    }

    try {
      const checklist = await getSchoolSetupChecklistData(school.id);

      if (checklist.isComplete) {
        return res.status(200).json({
          success: false,
          message: 'This school has already completed onboarding. No reminder email was sent.',
        });
      }

      // Send actual email
      await sendSetupReminderEmail(
        admin.email,
        admin.name || 'School Administrator',
        school.name,
        [],
        checklist.completedItems,
        checklist.missingItems,
        checklist.completionPercentage,
      );

      // Log the email send attempt
      await (prisma as any).emailLog.create({
        data: {
          schoolId: school.id,
          recipientEmail: admin.email,
          recipientName: admin.name,
          emailType: 'SETUP_COMPLETION_REMINDER',
          subject: `Complete your SchoolBase setup - ${school.name}`,
          status: 'SENT',
          sentAt: new Date(),
        },
      });

      console.log(`✅ Reminder sent to ${school.name} (${admin.email})`);
      
      res.json({ 
        success: true, 
        message: 'Reminder sent successfully',
        school: {
          id: school.id,
          name: school.name,
          adminEmail: admin.email
        }
      });
    } catch (emailError: any) {
      console.error(`❌ Failed to send email:`, emailError);
      
      // Log the failed attempt
      try {
        await (prisma as any).emailLog.create({
          data: {
            schoolId: school.id,
            recipientEmail: admin.email,
            recipientName: admin.name,
            emailType: 'SETUP_COMPLETION_REMINDER',
            subject: `Complete your SchoolBase setup - ${school.name}`,
            status: 'FAILED',
            error: emailError.message,
            sentAt: new Date(),
          },
        });
      } catch (logErr) {
        console.error('Failed to log email error:', logErr);
      }
      
      throw emailError;
    }
  } catch (error: any) {
    console.error('❌ Error sending reminder:', error);
    res.status(500).json({ 
      success: false,
      message: error.message || 'Failed to send reminder' 
    });
  }
});

// Helper function to get the next plan tier
function getNextPlan(currentPlan: string): string {
  const planProgression: Record<string, string> = {
    'FREE': 'STARTER',
    'STARTER': 'GROWTH',
    'GROWTH': 'ENTERPRISE',
    'ENTERPRISE': 'ENTERPRISE' // Can't upgrade beyond ENTERPRISE
  };
  return planProgression[currentPlan] || currentPlan;
}

function getPlanStudentLimit(plan: string): number | null {
  const limits: Record<string, number | null> = {
    FREE: null,
    STARTER: 150,
    GROWTH: 600,
    ENTERPRISE: null,
  };
  return limits[plan] ?? null;
}

// PATCH /schoolbase-admin/api/schools - School management actions
router.patch('/schools', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { schoolId, action, plan, days } = req.body as {
      schoolId: string;
      action: string;
      plan?: string;
      days?: number;
      expiresAt?: string;
    };

    const school = await prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) {
      return res.status(404).json({ message: 'School not found.' });
    }

    let updateData: Record<string, unknown> = {};
    let auditDetails = '';

    switch (action) {
      case 'suspend':
        updateData.status = 'SUSPENDED';
        auditDetails = `Suspended school ${school.name}`;
        break;
      case 'activate':
        updateData.status = 'ACTIVE';
        auditDetails = `Activated school ${school.name}`;
        break;
      case 'upgrade':
        const currentPlan = (school as any).plan;
        const nextPlan = getNextPlan(currentPlan);
        updateData.plan = nextPlan;
        updateData.status = 'ACTIVE';
        auditDetails = `Upgraded ${school.name} from ${currentPlan} to ${nextPlan}`;
        break;
      case 'setPlan':
        const validPlans = ['FREE', 'STARTER', 'GROWTH', 'ENTERPRISE'];
        if (!plan || !validPlans.includes(plan)) {
          return res.status(400).json({ message: 'A valid plan is required.' });
        }
        updateData.plan = plan;
        // Mirror the action modal: selecting any paid plan should activate the school.
        // If choosing FREE, only approve if the account is pending.
        if (plan !== 'FREE') {
          updateData.status = 'ACTIVE';
          auditDetails = `Approved subscription and set plan for ${school.name} to ${plan}`;
        } else if (school.status === 'PENDING') {
          updateData.status = 'ACTIVE';
          auditDetails = `Approved subscription and set plan for ${school.name} to ${plan}`;
        } else {
          auditDetails = `Set plan for ${school.name} to ${plan}`;
        }
        break;
      case 'setExpiry':
        // Set the subscription expiry date manually (ISO date string expected)
        const { expiresAt } = req.body as { expiresAt?: string };
        if (!expiresAt) {
          return res.status(400).json({ message: 'expiresAt is required.' });
        }
        const parsed = new Date(expiresAt);
        if (isNaN(parsed.getTime())) {
          return res.status(400).json({ message: 'Invalid expiresAt date.' });
        }
        updateData.subscriptionExpiresAt = parsed;
        // If setting a paid expiry ensure school is ACTIVE
        if (school.status !== 'ACTIVE') {
          updateData.status = 'ACTIVE';
        }
        auditDetails = `Set subscription expiry for ${school.name} to ${parsed.toISOString()}`;
        break;
      case 'extendTrial':
        if (!days) {
          return res.status(400).json({ message: 'Days are required to extend trial.' });
        }
        updateData.trialEndsAt = (school as any).trialEndsAt
          ? new Date(((school as any).trialEndsAt as Date).getTime() + days * 24 * 60 * 60 * 1000)
          : new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        auditDetails = `Extended trial for ${school.name} by ${days} days`;
        break;
      case 'cancel':
        updateData.status = 'CANCELLED';
        auditDetails = `Cancelled subscription for ${school.name}`;
        break;
      default:
        return res.status(400).json({ message: 'Invalid action.' });
    }

    const updated = await prisma.school.update({
      where: { id: schoolId },
      data: updateData,
    });

    // Record audit log
    try {
      await (prisma as any).platformAuditLog.create({
        data: {
          action: action.toUpperCase(),
          details: auditDetails,
          schoolId,
        },
      });
    } catch (err) {
      // Ignore audit log errors
    }

    res.json({ message: 'Action completed.', school: updated });
  } catch (error) {
    console.error('School action error:', error);
    res.status(500).json({ message: (error as Error).message || 'Action failed.' });
  }
});

// POST /schoolbase-admin/api/impersonate - Impersonate a school
router.post('/impersonate', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { schoolId } = req.body as { schoolId: string };

    const school = await prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) {
      return res.status(404).json({ message: 'School not found.' });
    }

    // Create impersonation token (valid for 1 hour)
    const impersonationToken = await new SignJWT({
      schoolId,
      adminId: session,
      purpose: 'IMPERSONATION',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret());

    // Record audit log
    try {
      await (prisma as any).platformAuditLog.create({
        data: {
          action: 'IMPERSONATE',
          details: `Impersonated school ${school.name}`,
          schoolId,
          userId: session,
        },
      });
    } catch (err) {
      // Ignore audit log errors
    }

    res.json({
      message: 'Impersonation token created.',
      token: impersonationToken,
      redirectUrl: `/admin?impersonate=${impersonationToken}`,
    });
  } catch (error) {
    console.error('Impersonate error:', error);
    res.status(500).json({ message: (error as Error).message || 'Impersonation failed.' });
  }
});

// POST /schoolbase-admin/api/impersonate/exchange - Exchange impersonation token for a school session token
router.post('/impersonate/exchange', async (req: Request, res: Response) => {
  try {
    const { token } = req.body as { token: string };
    if (!token) {
      return res.status(400).json({ message: 'Impersonation token is required.' });
    }

    const { payload } = await jwtVerify(token, secret());
    const schoolId = (payload as any).schoolId;
    const purpose = (payload as any).purpose;
    const adminId = (payload as any).adminId ?? 'platform-admin';

    if (!schoolId || purpose !== 'IMPERSONATION') {
      return res.status(400).json({ message: 'Invalid impersonation token.' });
    }

    const sessionToken = await new SignJWT({
      userId: adminId,
      role: 'SCHOOL_ADMIN',
      email: `impersonation@schoolbase.local`,
      name: 'Platform Admin Impersonator',
      schoolId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(secret());

    res.json({
      message: 'Impersonation session created.',
      token: sessionToken,
      schoolId,
    });
  } catch (error) {
    console.error('Impersonation exchange error:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to exchange impersonation token.' });
  }
});

const supportUploadDir = path.join(process.cwd(), 'uploads', 'support');
if (!fs.existsSync(supportUploadDir)) {
  fs.mkdirSync(supportUploadDir, { recursive: true });
}

const supportStorage = multer.diskStorage({
  destination: supportUploadDir,
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname) || '.bin';
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(7)}${extension}`;
    cb(null, uniqueName);
  },
});

const supportUpload = multer({
  storage: supportStorage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req: any, file: any, cb: any) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'image/jpg', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/plain'];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(csv|xlsx|xls|doc|docx|pdf|png|jpg|jpeg|webp|txt)$/i)) {
      cb(null, true);
      return;
    }
    cb(new Error('Unsupported file type. Upload images, PDFs, documents, or CSV files.'));
  },
});

const allowedSupportStatuses = new Set(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const);

function normalizeSupportStatus(value: unknown): 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' | undefined {
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toUpperCase();
  return allowedSupportStatuses.has(normalized as 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED')
    ? (normalized as 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED')
    : undefined;
}

router.get('/support/agents', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const agents = await prisma.user.findMany({
      where: { role: 'PLATFORM_ADMIN' },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
    res.json({ agents });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message || 'Failed to fetch support agents' });
  }
});

router.get('/support/tasks', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const tasks = await supportDb.supportTeamTask.findMany({
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
      include: {
        assignee: { select: { id: true, name: true, email: true } },
        creator: { select: { id: true, name: true, email: true } },
      },
    });
    res.json({ tasks });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message || 'Failed to fetch support tasks' });
  }
});

router.post('/support/tasks', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { title, description, priority = 'MEDIUM', assignedTo, dueAt } = req.body as Record<string, string | undefined>;
    if (!title?.trim()) return res.status(400).json({ message: 'Task title is required' });

    const task = await supportDb.supportTeamTask.create({
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        priority: priority || 'MEDIUM',
        assignedTo: assignedTo || null,
        createdBy: session,
        dueAt: dueAt ? new Date(dueAt) : null,
      },
      include: { assignee: { select: { id: true, name: true, email: true } }, creator: { select: { id: true, name: true, email: true } } },
    });
    res.status(201).json({ task });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message || 'Failed to create support task' });
  }
});

router.post('/support/requests', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { schoolId, subject, message, priority = 'MEDIUM' } = req.body as {
      schoolId?: string;
      subject?: string;
      message?: string;
      priority?: string;
    };

    if (!schoolId) return res.status(400).json({ message: 'School is required.' });
    if (!subject?.trim()) return res.status(400).json({ message: 'Ticket subject is required.' });
    if (!message?.trim()) return res.status(400).json({ message: 'Ticket details are required.' });

    const normalizedPriority = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(priority || '') ? (priority as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL') : 'MEDIUM';

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true, name: true, email: true, country: true },
    });

    if (!school) return res.status(404).json({ message: 'School not found.' });

    const request = await prisma.$transaction(async (tx) => {
      const created = await tx.supportRequest.create({
        data: {
          schoolId: school.id,
          createdByUserId: session,
          requesterName: 'SchoolBase Support',
          requesterEmail: null,
          requesterRole: 'PLATFORM_ADMIN',
          subject: subject.trim(),
          message: message.trim(),
          priority: normalizedPriority,
          status: 'OPEN',
          lastMessageAt: new Date(),
        },
      });

      await tx.supportRequestMessage.create({
        data: {
          supportRequestId: created.id,
          senderUserId: session,
          senderRole: 'PLATFORM_ADMIN',
          senderName: 'SchoolBase Support',
          senderEmail: null,
          body: message.trim(),
        },
      });

      return tx.supportRequest.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          messages: { orderBy: { createdAt: 'asc' } },
          school: { select: { id: true, name: true, country: true, email: true } },
        },
      });
    });

    try {
      const { sendSupportRequestNotification } = await import('../services/email.js');
      sendSupportRequestNotification(
        request.id,
        request.subject,
        request.message,
        school.name,
        school.email,
      )
        .then(() => console.log('Platform-created support request notification queued'))
        .catch((err) => console.warn('Platform-created support request notification failed (non-blocking):', err));
    } catch (error) {
      console.warn('Could not import email service for platform-created support request:', error);
    }

    res.status(201).json({
      request: {
        id: request.id,
        subject: request.subject,
        message: request.message,
        response: request.response,
        status: request.status,
        priority: request.priority,
        createdAt: request.createdAt.toISOString(),
        updatedAt: request.updatedAt.toISOString(),
        school: request.school ? {
          id: request.school.id,
          name: request.school.name,
          country: request.school.country,
        } : null,
      },
      message: 'School support ticket created successfully.'
    });
  } catch (error) {
    console.error('Error creating platform support request:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to create school support ticket.' });
  }
});

router.patch('/support/tasks/:taskId', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { title, description, status, priority, assignedTo, dueAt } = req.body as Record<string, string | null | undefined>;
    const task = await supportDb.supportTeamTask.update({
      where: { id: req.params.taskId },
      data: {
        ...(title !== undefined ? { title: title?.trim() || undefined } : {}),
        ...(description !== undefined ? { description: description?.trim() || null } : {}),
        ...(status !== undefined ? { status: status || 'OPEN' } : {}),
        ...(priority !== undefined ? { priority: priority || 'MEDIUM' } : {}),
        ...(assignedTo !== undefined ? { assignedTo: assignedTo || null } : {}),
        ...(dueAt !== undefined ? { dueAt: dueAt ? new Date(dueAt) : null } : {}),
      },
      include: { assignee: { select: { id: true, name: true, email: true } }, creator: { select: { id: true, name: true, email: true } } },
    });
    res.json({ task });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message || 'Failed to update support task' });
  }
});

router.delete('/support/tasks/:taskId', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    await supportDb.supportTeamTask.delete({ where: { id: req.params.taskId } });
    res.json({ message: 'Support task deleted' });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message || 'Failed to delete support task' });
  }
});

router.get('/support/requests/:requestId/notes', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const notes = await supportDb.supportInternalNote.findMany({
      where: { supportRequestId: req.params.requestId },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: { id: true, name: true, email: true } } },
    });
    res.json({ notes });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message || 'Failed to fetch internal notes' });
  }
});

router.post('/support/requests/:requestId/notes', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ message: 'Note cannot be empty' });

    const note = await supportDb.supportInternalNote.create({
      data: { supportRequestId: req.params.requestId, authorId: session, body },
      include: { author: { select: { id: true, name: true, email: true } } },
    });
    res.status(201).json({ note });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message || 'Failed to create internal note' });
  }
});

router.delete('/support/notes/:noteId', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    await supportDb.supportInternalNote.delete({ where: { id: req.params.noteId } });
    res.json({ message: 'Internal note deleted' });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message || 'Failed to delete internal note' });
  }
});

router.post('/support/upload', supportUpload.array('files', 10), async (req: Request, res: Response) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    const forwardedProto = String(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
    const publicBaseUrl = process.env.PUBLIC_API_URL || `${forwardedProto === 'https' || process.env.NODE_ENV === 'production' ? 'https' : 'http'}://${req.get('host')}`;
    const attachments = files.map((file: any) => ({
      id: `local-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      fileName: file.filename,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      url: `${publicBaseUrl}/uploads/support/${file.filename}`,
    }));

    res.json({ attachments });
  } catch (error) {
    console.error('Error uploading support files:', error);
    res.status(500).json({ error: 'Failed to upload support files' });
  }
});

// GET /schoolbase-admin/api/support - Get all support requests from all schools
router.get('/support', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const supportRequests = await supportDb.supportRequest.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: { attachments: { orderBy: { createdAt: 'asc' } } },
        },
        attachments: { orderBy: { createdAt: 'asc' } },
        school: { select: { id: true, name: true, country: true } }
      },
    });

    res.json({ 
      supportRequests: (supportRequests as any[]).map((request) => {
        const messages = ((request as any).messages || []).map((message: any) => {
          const isSchoolMessage = message.senderRole === 'SCHOOL';
          const normalizedSenderName = typeof message.senderName === 'string' ? message.senderName.trim() : '';
          const senderName = isSchoolMessage
            ? (request.school?.name || normalizedSenderName || 'School')
            : 'SchoolBase Support';

          return {
            id: message.id,
            senderRole: message.senderRole,
            senderName,
            senderEmail: message.senderEmail,
            body: message.body,
            createdAt: message.createdAt.toISOString(),
            attachments: ((message.attachments || []) as any[]).map((attachment: any) => ({
              id: attachment.id,
              fileName: attachment.fileName,
              originalName: attachment.originalName,
              mimeType: attachment.mimeType,
              size: attachment.size,
              url: attachment.url,
              createdAt: attachment.createdAt.toISOString(),
            })),
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
          attachments: ((request as any).attachments || []).map((attachment: any) => ({
            id: attachment.id,
            fileName: attachment.fileName,
            originalName: attachment.originalName,
            mimeType: attachment.mimeType,
            size: attachment.size,
            url: attachment.url,
            createdAt: attachment.createdAt.toISOString(),
          })),
          school: request.school ? {
            id: request.school.id,
            name: request.school.name,
            country: request.school.country,
          } : null,
        };
      }),
    });
  } catch (error) {
    console.error('Error fetching support requests:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to fetch support requests' });
  }
});

// PATCH /schoolbase-admin/api/support/reply - Send support replies
router.patch('/support/reply', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { requestId, response: responseText, status, attachments = [] } = req.body as {
      requestId: string;
      response?: string;
      status?: string;
      attachments?: Array<{ url: string; fileName?: string; originalName?: string; mimeType?: string; size?: number }>;
    };

    const normalizedStatus = normalizeSupportStatus(status);

    const supportRequest: any = await prisma.supportRequest.findUnique({
      where: { id: requestId },
      include: { school: { select: { id: true, name: true, country: true, email: true } } },
    });

    if (!supportRequest) {
      return res.status(404).json({ message: 'Support request not found.' });
    }

    // Update request with response only when provided and preserve existing response otherwise.
    const updateData: Record<string, unknown> = {};
    if (typeof responseText === 'string' && responseText.trim().length > 0) {
      updateData.response = responseText.trim();
    }
    if (normalizedStatus) {
      updateData.status = normalizedStatus;
    }

    const shouldNotifyStatus = Boolean(normalizedStatus && ['RESOLVED', 'CLOSED'].includes(normalizedStatus) && normalizedStatus !== supportRequest.status);

    const updated: any = await prisma.$transaction(async (tx) => {
      await tx.supportRequest.update({
        where: { id: requestId },
        data: updateData,
      });

      let createdMessage = null;
      if (responseText) {
        createdMessage = await tx.supportRequestMessage.create({
          data: {
            supportRequestId: requestId,
            senderRole: 'PLATFORM_ADMIN',
            senderName: 'SchoolBase Support',
            senderEmail: null,
            body: responseText,
          },
        });

        if (Array.isArray(attachments) && attachments.length > 0) {
          await (tx as any).supportAttachment.createMany({
            data: attachments.map((attachment) => ({
              supportRequestId: requestId,
              supportMessageId: createdMessage!.id,
              fileName: attachment.fileName || 'support-file',
              originalName: attachment.originalName || attachment.fileName || 'support-file',
              mimeType: attachment.mimeType || 'application/octet-stream',
              size: Number(attachment.size || 0),
              url: attachment.url,
            })),
          });
        }
      }

      return (tx as any).supportRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
            include: { attachments: { orderBy: { createdAt: 'asc' } } },
          },
          attachments: { orderBy: { createdAt: 'asc' } },
          school: { select: { id: true, name: true, country: true, email: true } },
        } as any,
      });
    });

    if (responseText && responseText.trim().length > 0) {
      try {
        const { sendSupportFollowupNotification } = await import('../services/email.js');
        sendSupportFollowupNotification(
          updated.id,
          responseText.trim(),
          updated.school?.name || supportRequest.school?.name,
          updated.school?.email || supportRequest.school?.email,
        )
          .then(() => console.log('Support followup notification queued'))
          .catch((err) => console.warn('Support followup notification failed (non-blocking):', err));
      } catch (err) {
        console.warn('Could not import email service for support followup notification:', err);
      }
    }

    if (shouldNotifyStatus) {
      try {
        const { sendSupportStatusUpdateNotification } = await import('../services/email.js');
        const statusMessage = typeof responseText === 'string' && responseText.trim().length > 0
          ? responseText.trim()
          : `Your support request has been marked as ${normalizedStatus?.toLowerCase() || 'updated'}.`;
        sendSupportStatusUpdateNotification(
          updated.id,
          normalizedStatus || updated.status,
          updated.subject,
          statusMessage,
          updated.school?.name || supportRequest.school?.name,
          updated.school?.email || supportRequest.school?.email,
        )
          .then(() => console.log('Support status notification queued'))
          .catch((err) => console.warn('Support status notification failed (non-blocking):', err));
      } catch (err) {
        console.warn('Could not import email service for support status notification:', err);
      }
    }

    const messages = ((updated as any).messages || []).map((message: any) => {
      const isSchoolMessage = message.senderRole === 'SCHOOL';
      const normalizedSenderName = typeof message.senderName === 'string' ? message.senderName.trim() : '';
      const senderName = isSchoolMessage
        ? (updated.school?.name || normalizedSenderName || 'School')
        : 'SchoolBase Support';

      return {
        id: message.id,
        senderRole: message.senderRole,
        senderName,
        senderEmail: message.senderEmail,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
        attachments: ((message.attachments || []) as any[]).map((attachment: any) => ({
          id: attachment.id,
          fileName: attachment.fileName,
          originalName: attachment.originalName,
          mimeType: attachment.mimeType,
          size: attachment.size,
          url: attachment.url,
          createdAt: attachment.createdAt.toISOString(),
        })),
      };
    });

    if (updated.response && !messages.some((message: any) => message.body === updated.response)) {
      messages.push({
        id: `${updated.id}-response`,
        senderRole: 'PLATFORM_ADMIN',
        senderName: 'SchoolBase Support',
        senderEmail: null,
        body: updated.response,
        createdAt: updated.updatedAt.toISOString(),
      });
    }

    // Return in the same format as the GET endpoint
    res.json({ 
      message: 'Reply sent.',
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
        attachments: ((updated as any).attachments || []).map((attachment: any) => ({
          id: attachment.id,
          fileName: attachment.fileName,
          originalName: attachment.originalName,
          mimeType: attachment.mimeType,
          size: attachment.size,
          url: attachment.url,
          createdAt: attachment.createdAt.toISOString(),
        })),
        school: updated.school,
      }
    });
  } catch (error) {
    console.error('Support reply error:', error);
    res.status(500).json({ message: (error as Error).message || 'Reply failed.' });
  }
});

// GET /schoolbase-admin/api/videos - Get all video tutorials
router.get('/videos', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const videos = await prisma.videoTutorial.findMany({
      orderBy: [{ featured: 'desc' }, { createdAt: 'desc' }],
    });

    res.json({
      videos: videos.map((video: any) => ({
        id: video.id,
        title: video.title,
        description: video.description,
        videoUrl: video.videoUrl,
        category: video.category,
        featured: video.featured,
        createdAt: video.createdAt,
        updatedAt: video.updatedAt,
      })),
    });
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to fetch videos' });
  }
});

// GET /schoolbase-admin/api/videos/:videoId - Get a specific video tutorial
router.get('/videos/:videoId', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { videoId } = req.params;

    const video = await prisma.videoTutorial.findUnique({
      where: { id: videoId },
    });

    if (!video) {
      return res.status(404).json({ message: 'Video not found' });
    }

    res.json({ video });
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).json({ message: 'Failed to fetch video' });
  }
});

// POST /schoolbase-admin/api/videos - Create new video tutorial
router.post('/videos', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { title, description, videoUrl, category, featured } = req.body;

    if (!title || !videoUrl) {
      return res.status(400).json({ message: 'Title and Video URL are required' });
    }

    const video = await prisma.videoTutorial.create({
      data: {
        title,
        description: description || '',
        videoUrl,
        category: category || 'Getting Started',
        featured: featured || false,
      },
    });

    res.status(201).json({
      videoId: video.id,
      ...video,
    });
  } catch (error) {
    console.error('Error creating video:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to create video' });
  }
});

// PATCH /schoolbase-admin/api/videos/:videoId - Update video tutorial
router.patch('/videos/:videoId', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { videoId } = req.params;
    const { title, description, videoUrl, category, featured } = req.body;

    if (!videoId) {
      return res.status(400).json({ message: 'Video ID is required' });
    }

    const video = await prisma.videoTutorial.update({
      where: { id: videoId },
      data: {
        ...(title && { title }),
        ...(description !== undefined && { description }),
        ...(videoUrl && { videoUrl }),
        ...(category && { category }),
        ...(featured !== undefined && { featured }),
      },
    });

    res.json(video);
  } catch (error) {
    console.error('Error updating video:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to update video' });
  }
});

// DELETE /schoolbase-admin/api/videos/:videoId - Delete video tutorial
router.delete('/videos/:videoId', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { videoId } = req.params;

    if (!videoId) {
      return res.status(400).json({ message: 'Video ID is required' });
    }

    await prisma.videoTutorial.delete({
      where: { id: videoId },
    });

    res.json({ success: true, message: 'Video deleted successfully' });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ message: (error as Error).message || 'Failed to delete video' });
  }
});

// POST /schoolbase-admin/api/campaigns/send - Send a campaign to manually entered recipients
router.post('/campaigns/send', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { recipients, emailType, subject, body } = req.body as {
      recipients?: unknown;
      emailType?: string;
      subject?: string;
      body?: string;
    };

    const MAX_RECIPIENTS = 100;
    const allowedEmailTypes = new Set([
      'CONSULTANT_PARTNERSHIP', 'SCHOOL_PARTNERSHIP_INTRODUCTION', 'PARTNERSHIP_FOLLOW_UP',
      'PRODUCT_UPDATE', 'PRICE_UPDATE', 'SUBSCRIPTION_THANK_YOU', 'SUPPORT_UPDATE',
      'ONBOARDING_GUIDANCE', 'BEST_PRACTICE_TIP', 'MANUAL_ANNOUNCEMENT',
      'POLICY_UPDATE', 'ACCOUNT_SECURITY', 'ACCOUNT_VERIFICATION_SUSPENSION',
    ]);
    const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ message: 'At least one recipient email is required.' });
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return res.status(400).json({ message: `A campaign can contain at most ${MAX_RECIPIENTS} recipients.` });
    }
    if (!emailType || !allowedEmailTypes.has(emailType)) {
      return res.status(400).json({ message: 'A valid campaign template is required.' });
    }
    if (!subject?.trim() || !body?.trim()) {
      return res.status(400).json({ message: 'Subject and body are required.' });
    }

    const normalizedRecipients = Array.from(new Set(
      recipients
        .filter((recipient): recipient is string => typeof recipient === 'string')
        .map((recipient) => recipient.trim().toLowerCase())
        .filter(Boolean),
    ));
    const invalidRecipients = normalizedRecipients.filter((recipient) => !isValidEmail(recipient));
    if (invalidRecipients.length > 0) {
      return res.status(400).json({ message: `Invalid email address(es): ${invalidRecipients.join(', ')}` });
    }

    const { sendPlatformCommunicationEmail } = await import('../services/email.js');
    const sent: string[] = [];
    const failed: { email: string; error: string }[] = [];

    for (const recipient of normalizedRecipients) {
      try {
        await sendPlatformCommunicationEmail(recipient, 'there', 'SchoolBase', emailType, subject.trim(), body.trim());
        sent.push(recipient);
        await (prisma as any).emailLog.create({
          data: { recipientEmail: recipient, recipientName: null, emailType, subject: subject.trim(), sentAt: new Date(), status: 'SENT', metadata: JSON.stringify({ campaign: true }) },
        }).catch(() => {});
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Email delivery failed';
        failed.push({ email: recipient, error: message });
        await (prisma as any).emailLog.create({
          data: { recipientEmail: recipient, recipientName: null, emailType, subject: subject.trim(), sentAt: new Date(), status: 'FAILED', error: message, metadata: JSON.stringify({ campaign: true }) },
        }).catch(() => {});
      }
    }

    return res.json({ success: failed.length === 0, sent, failed, sentCount: sent.length, failedCount: failed.length, total: normalizedRecipients.length });
  } catch (error) {
    console.error('Error sending campaign:', error);
    return res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to send campaign' });
  }
});

// POST /schoolbase-admin/api/emails/send - Send platform communication emails
router.post('/emails/send', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { targetType, selectedSchoolId, selectedSegment, emailType, subject, body } = req.body as {
      targetType: 'school' | 'segment';
      selectedSchoolId?: string;
      selectedSegment?: string;
      emailType: string;
      subject: string;
      body: string;
    };

    // Validate required fields
    if (!emailType || !subject || !body) {
      return res.status(400).json({ message: 'Email type, subject, and body are required.' });
    }

    let schools: any[] = [];

    // Get schools based on target type
    if (targetType === 'school') {
      if (!selectedSchoolId) {
        return res.status(400).json({ message: 'School ID is required for single school target.' });
      }
      schools = await prisma.school.findMany({
        where: { id: selectedSchoolId },
        include: {
          users: {
            where: { role: 'SCHOOL_ADMIN' },
            select: { email: true, name: true },
          },
        },
      });
    } else if (targetType === 'segment') {
      const where: any = {};
      
      if (selectedSegment === 'active') {
        where.status = 'ACTIVE';
      } else if (selectedSegment === 'trial') {
        where.status = 'TRIAL';
      } else if (selectedSegment === 'new') {
        // New schools in the last 7 days
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        where.createdAt = { gte: sevenDaysAgo };
      }
      // 'all' segment has no where clause

      schools = await prisma.school.findMany({
        where,
        include: {
          users: {
            where: { role: 'SCHOOL_ADMIN' },
            select: { email: true, name: true },
          },
        },
      });
    }

    if (schools.length === 0) {
      return res.status(400).json({ message: 'No schools found matching the selection criteria.' });
    }

    // Send emails
    const { sendPlatformCommunicationEmail } = await import('../services/email.js');
    
    let sentCount = 0;
    let skippedCount = 0;

    for (const school of schools) {
      const adminUser = school.users[0];
      if (!adminUser?.email) {
        skippedCount++;
        continue;
      }

      try {
        await sendPlatformCommunicationEmail(
          adminUser.email,
          adminUser.name || 'School Admin',
          school.name,
          emailType,
          subject,
          body
        );

        // Log email sent
        await (prisma as any).emailLog.create({
          data: {
            schoolId: school.id,
            recipientEmail: adminUser.email,
            recipientName: adminUser.name,
            emailType,
            subject,
            sentAt: new Date(),
            status: 'SENT',
          },
        }).catch(() => {}); // Ignore logging errors

        sentCount++;
      } catch (err) {
        skippedCount++;
        console.error(`Failed to send email to ${adminUser.email}:`, err);
        
        // Log failed email
        await (prisma as any).emailLog.create({
          data: {
            schoolId: school.id,
            recipientEmail: adminUser.email,
            recipientName: adminUser.name,
            emailType,
            subject,
            sentAt: new Date(),
            status: 'FAILED',
            error: (err as Error).message,
          },
        }).catch(() => {}); // Ignore logging errors
      }
    }

    res.json({
      success: true,
      sentCount,
      skippedCount,
      total: schools.length,
    });
  } catch (error: any) {
    console.error('❌ Error sending platform emails:', error);
    res.status(500).json({ 
      message: error.message || 'Failed to send emails'
    });
  }
});

export default router;

// --- Pending signup management (platform admin) ---
// GET /schoolbase-admin/api/signups/pending - list pending signup OTP entries
router.get('/signups/pending', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const page = parseInt(req.query.page as string) || 1;
    const skip = (page - 1) * limit;

    const now = new Date();
    const [items, total] = await Promise.all([
      prisma.signupOtp.findMany({
        where: { verifiedAt: null },
        select: {
          id: true,
          email: true,
          schoolName: true,
          slug: true,
          adminName: true,
          phone: true,
          country: true,
          attempts: true,
          expiresAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.signupOtp.count({ where: { verifiedAt: null } }),
    ]);

    const signups = items.map((item) => ({
      ...item,
      isExpired: item.expiresAt.getTime() <= now.getTime(),
    }));

    res.json({ success: true, signups, pagination: { page, limit, total } });
  } catch (err) {
    console.error('Error listing pending signups:', err);
    res.status(500).json({ message: 'Failed to list pending signups', details: String(err) });
  }
});

// POST /schoolbase-admin/api/signups/remind - follow up on incomplete signups
router.post('/signups/remind', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const requestedEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : null;
    const pendingSignups = await prisma.signupOtp.findMany({
      where: { verifiedAt: null, ...(requestedEmail ? { email: requestedEmail } : {}) },
      select: { email: true, schoolName: true, adminName: true },
    });

    if (requestedEmail && pendingSignups.length === 0) {
      return res.status(404).json({ message: 'Pending signup not found or already verified' });
    }

    let sentCount = 0;
    let skippedCount = 0;
    for (const signup of pendingSignups) {
      try {
        const otp = generateOtp();
        if (!(await resendSignupOtp(signup.email, otp))) {
          skippedCount += 1;
          continue;
        }
        await sendPendingSignupReminderEmail(signup.email, signup.adminName, signup.schoolName, otp);
        sentCount += 1;
      } catch (error) {
        skippedCount += 1;
        console.error(`Failed to send pending signup reminder to ${signup.email}:`, error);
      }
    }

    return res.json({ success: true, sentCount, skippedCount, total: pendingSignups.length });
  } catch (error: any) {
    console.error('Error sending pending signup reminders:', error);
    return res.status(500).json({ message: error.message || 'Failed to send pending signup reminders' });
  }
});

// POST /schoolbase-admin/api/signups/approve - Approve a pending signup manually (create school + admin)
router.post('/signups/approve', async (req: Request, res: Response) => {
  const session = await requirePlatformAdminSession(req, res);
  if (!session) return;

  try {
    const { email, forceSlug } = req.body as { email?: string; forceSlug?: string };
    if (!email) return res.status(400).json({ message: 'email is required' });

    const normalizedEmail = String(email).trim().toLowerCase();
    const otpEntry = await prisma.signupOtp.findUnique({ where: { email: normalizedEmail } });
    if (!otpEntry) return res.status(404).json({ message: 'Pending signup not found' });
    if (otpEntry.verifiedAt) return res.status(400).json({ message: 'Signup already verified' });

    // Ensure slug uniqueness - allow admin to provide forceSlug to override collisions
    let slug = (forceSlug || otpEntry.slug).trim().toLowerCase();
    const existing = await prisma.school.findUnique({ where: { slug } });
    if (existing) {
      // append timestamp to make unique
      slug = `${slug}-${Date.now().toString().slice(-5)}`;
    }

    // Ensure email not already taken by a user
    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existingUser) return res.status(409).json({ message: 'Email already registered as a user' });

    // Create school
    const school = await prisma.school.create({
      data: {
        name: otpEntry.schoolName,
        slug,
        tagline: otpEntry.tagline,
        address: otpEntry.address,
        phone: otpEntry.phone,
        country: otpEntry.country,
        email: normalizedEmail,
        status: 'TRIAL',
        trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // Create admin user
    const adminUser = await prisma.user.create({
      data: {
        email: normalizedEmail,
        name: otpEntry.adminName,
        role: 'SCHOOL_ADMIN',
        passwordHash: otpEntry.passwordHash,
        schoolId: school.id,
      },
    });

    // Mark OTP as verified and set verifiedAt
    await prisma.signupOtp.update({ where: { email: normalizedEmail }, data: { verifiedAt: new Date() } }).catch(() => {});

    // Audit log
    try {
      await (prisma as any).platformAuditLog.create({
        data: {
          event: 'MANUAL_SIGNUP_APPROVED',
          details: `Platform admin ${session || 'admin'} approved signup for ${otpEntry.schoolName} <${normalizedEmail}> and created school ${school.id}`,
        },
      });
    } catch (e) {
      console.warn('Failed to write audit log for manual signup approval', e);
    }

    // Send welcome and internal notification async
    sendWelcomeEmail(normalizedEmail, otpEntry.schoolName, otpEntry.adminName).catch(() => {});
    sendInternalSignupNotification(otpEntry.schoolName, normalizedEmail, otpEntry.adminName).catch(() => {});

    res.status(201).json({ success: true, school: { id: school.id, name: school.name, slug: school.slug }, user: { id: adminUser.id, email: adminUser.email } });
  } catch (err) {
    console.error('Error approving signup manually:', err);
    res.status(500).json({ message: 'Failed to approve signup', details: String(err) });
  }
});
