import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import multer from 'multer';
import { isPublicTutorialVideoUrl } from '../services/video-tutorial-media.js';
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import ReportCardService from '../services/report-card.service.js';
import { sendAdmissionApplicantEmail, sendPlatformCommunicationEmail } from '../services/email.js';
import { CommunicationService, RulesEngine, TemplateEngine, RecipientResolver, DeliveryQueue, DriverManager, EmailDriver, WhatsAppDriver } from '../communications/index.js';
import baileysSessionManager from '../communications/whatsapp-baileys.js';
import { CommunicationRulesRegistry, DEFAULT_COMMUNICATION_RULES } from '../communications/rules.js';
import { normalizeAdmissionStatus } from './admissions-utils.js';
import { getPublicAdmissionStatus, submitPublicAdmissionReply } from '../services/public-admission-status.js';
import { findAdmissionByRequestKey } from '../services/admission-application-access.js';
import { getConfiguredPaymentPlans, getPublicPaymentPlans } from '../services/platform-settings.js';
import { getActivePlacementAds, isValidLandingUrl, normalizePlacementType } from './ads-utils.js';
import { sendAdvertiserApplicationNotification, sendAdvertiserStatusEmail } from '../services/email.js';
import { whatsappDeliveryStore } from '../services/whatsapp-delivery-store.js';
import { AdmissionDeliveryRetryStore } from '../services/admission-delivery-retry-store.js';

type PublicAdmissionsSchool = {
  id: string;
  name: string;
  slug: string;
  primaryColor: string | null;
  logoUrl: string | null;
  address: string | null;
  city: string | null;
  admissionsEnabled: boolean;
  admissionsCapabilityEnabled: boolean;
  admissionsOpeningDate: Date | null;
  admissionsClosingDate: Date | null;
  admissionsIntroText: string | null;
  admissionsRequirements: string | null;
  admissionsContactInfo: string | null;
  email: string | null;
  phone: string | null;
  classes: {
    id: string;
    name: string;
    phase: string;
    arm: string | null;
  }[];
};

type ExtendedPrismaClient = PrismaClient & {
  resultPin: any;
  resultPinBatch: any;
  admissionApplication: any;
  adCampaign: any;
  adAnalyticsEvent: any;
  adPlacement: any;
  advertiser: any;
  admissionDeliveryAttempt: any;
};

const router = Router();
const prisma = new PrismaClient() as ExtendedPrismaClient;
const publicAdmissionRetryStore = new AdmissionDeliveryRetryStore(prisma);
const adApplicationAttempts = new Map<string, number[]>();

router.get('/pricing', async (_req: Request, res: Response) => {
  try {
    const plans = await getConfiguredPaymentPlans(prisma);
    if (!plans) return res.status(503).json({ error: 'Pricing is temporarily unavailable.' });
    res.json({ currency: 'NGN', plans: getPublicPaymentPlans(plans) });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load pricing.' });
  }
});

async function handleAdPlacementRequest(req: Request, res: Response) {
  const requestedPath = String(req.query.path ?? '/login');
  const placementType = normalizePlacementType(requestedPath);
  const eventName = String(req.query.event ?? '').trim().toLowerCase();
  const campaignId = typeof req.query.id === 'string' ? req.query.id : null;

  if (eventName && campaignId) {
    const campaign = await prisma.adCampaign.findUnique({ where: { id: campaignId }, select: { id: true, status: true, enabled: true } });
    if (!campaign || campaign.status !== 'LIVE' || !campaign.enabled) {
      return res.status(403).json({ success: false, message: 'Campaign is not active' });
    }

    await prisma.adAnalyticsEvent.create({
      data: {
        campaignId: campaign.id,
        placementId: null,
        eventType: eventName === 'click' ? 'CLICK' : 'IMPRESSION',
        sourcePath: requestedPath,
        userAgent: req.headers['user-agent'] ?? null,
        referrer: req.headers.referer ?? null,
      },
    }).catch(() => {});

    return res.json({ success: true, recorded: eventName });
  }

  const placement = await prisma.adPlacement.findUnique({
    where: { type: placementType as any },
    include: {
      campaigns: {
        orderBy: { sortOrder: 'asc' },
        include: {
          campaign: {
            include: {
              creatives: { orderBy: { createdAt: 'asc' } },
              advertiser: true,
              placements: {
                select: { sortOrder: true },
              },
            },
          },
        },
      },
    },
  });

  if (!placement) {
    return res.json({ placementType, ads: [] });
  }

  const now = new Date();
  const activeAds = getActivePlacementAds(placement, now).map((ad) => ({ ...ad, label: placement.label }));

  return res.json({ placementType, ads: activeAds });
}

router.get('/ads/placements', async (req: Request, res: Response) => {
  await handleAdPlacementRequest(req, res);
});

router.post('/ads/placements', async (req: Request, res: Response) => {
  await handleAdPlacementRequest(req, res);
});

router.post('/ads/apply', async (req: Request, res: Response) => {
  const { companyName, contactName, email, phone, website, category, campaignTitle, headline, summary, landingUrl, placementTypes = [], budget, currency = 'NGN', companyWebsite = '' } = req.body || {};
  const honeypot = String(req.body?.companyWebsite || companyWebsite || '').trim();
  if (honeypot) return res.status(400).json({ message: 'Unable to submit application.' });

  const normalizedHeadline = headline ? String(headline).trim() : String(campaignTitle || '').trim();

  const clientKey = String(req.ip || req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const recentAttempts = (adApplicationAttempts.get(clientKey) || []).filter((timestamp) => now - timestamp < 60 * 60 * 1000);
  if (recentAttempts.length >= 5) return res.status(429).json({ message: 'Too many applications from this network. Please try again later.' });
  recentAttempts.push(now);
  adApplicationAttempts.set(clientKey, recentAttempts);

  const requiredValues = [companyName, contactName, email, campaignTitle, landingUrl];
  if (requiredValues.some((value) => !String(value || '').trim())) {
    return res.status(400).json({ message: 'Company, contact, email, campaign title, and landing URL are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ message: 'Enter a valid contact email.' });
  }
  if (!isValidLandingUrl(String(landingUrl).trim())) {
    return res.status(400).json({ message: 'Landing URL must use http or https.' });
  }
  if (String(companyName).trim().length > 160 || String(contactName).trim().length > 120 || String(campaignTitle).trim().length > 160 || String(summary || '').trim().length > 2000) {
    return res.status(400).json({ message: 'One or more fields are too long.' });
  }

  const requestedTypes = Array.isArray(placementTypes) ? placementTypes.map((value) => String(value)) : [];
  const placements = await prisma.adPlacement.findMany({
    where: { type: { in: requestedTypes as any }, enabled: true },
    select: { id: true },
  });
  if (requestedTypes.length > 0 && placements.length !== new Set(requestedTypes).size) {
    return res.status(400).json({ message: 'One or more selected placements are unavailable.' });
  }

  const existingApplication = await prisma.advertiser.findFirst({
    where: { email: String(email).trim(), verificationStatus: 'PENDING', campaigns: { some: { status: 'DRAFT' } } },
    select: { id: true },
  });
  if (existingApplication) return res.status(409).json({ message: 'An application from this email is already awaiting review.' });

  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const advertiser = await tx.advertiser.create({
        data: {
          companyName: String(companyName).trim(),
          contactName: String(contactName).trim(),
          email: String(email).trim(),
          phone: phone ? String(phone).trim() : null,
          website: website ? String(website).trim() : null,
          category: category ? String(category).trim() : null,
          verificationStatus: 'PENDING',
          notes: 'Submitted through the public Advertise with SchoolBase form.',
        },
      });
      const campaign = await tx.adCampaign.create({
        data: {
          advertiserId: advertiser.id,
          title: String(campaignTitle).trim(),
          slug: `${String(campaignTitle).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
          headline: normalizedHeadline || null,
          summary: summary ? String(summary).trim() : null,
          landingUrl: String(landingUrl).trim(),
          budget: Number(budget || 0),
          currency: String(currency || 'NGN').trim(),
          status: 'DRAFT',
          enabled: false,
          placements: placements.length ? { createMany: { data: placements.map((placement: { id: string }) => ({ placementId: placement.id })) } } : undefined,
        },
      });
      return { advertiserId: advertiser.id, campaignId: campaign.id };
    });
    await sendAdvertiserApplicationNotification({ companyName: String(companyName).trim(), contactName: String(contactName).trim(), email: String(email).trim(), campaignTitle: String(campaignTitle).trim(), landingUrl: String(landingUrl).trim(), placementTypes: requestedTypes }).catch((error) => console.error('[PUBLIC ADS] Internal notification failed:', error));
    await sendAdvertiserStatusEmail({ email: String(email).trim(), contactName: String(contactName).trim(), companyName: String(companyName).trim(), status: 'RECEIVED' }).catch((error) => console.error('[PUBLIC ADS] Applicant confirmation email failed:', error));
    return res.status(201).json({ success: true, message: 'Application received. SchoolBase will review it and contact you.', ...result });
  } catch (error) {
    console.error('[PUBLIC ADS] Application failed:', error);
    return res.status(500).json({ message: 'Unable to submit the advertising application right now.' });
  }
});

const reportCardService = new ReportCardService(prisma);

const publicCommunicationRulesRegistry = new CommunicationRulesRegistry(DEFAULT_COMMUNICATION_RULES);

const publicSharedDriverManager = new DriverManager({
  EMAIL: new EmailDriver(async ({ recipient, request, content }) => {
    const schoolName = String(request.data?.schoolName ?? 'SchoolBase');
    const subject = String(request.subject ?? 'Admission notification');
    const body = String(request.body ?? '');
    if (request.event === 'AdmissionCreated' && request.metadata?.audience === 'APPLICANT') {
      await sendAdmissionApplicantEmail(
        recipient.address,
        schoolName,
        subject,
        String(request.body ?? content.body),
        typeof request.data?.schoolLogo === 'string' ? request.data.schoolLogo : undefined,
      );

      return {
        channel: 'EMAIL',
        recipient: recipient.address,
        status: 'SENT',
        provider: 'email-service',
      } as const;
    }

    await sendPlatformCommunicationEmail(
      recipient.address,
      recipient.name ?? 'Recipient',
      schoolName,
      subject,
      subject,
      body,
    );

    return {
      channel: 'EMAIL',
      recipient: recipient.address,
      status: 'SENT',
      provider: 'email-service',
    } as const;
  }),
  WHATSAPP: new WhatsAppDriver(async ({ recipient, request, content }) => {
    const schoolId = request.schoolId ?? '';
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

    return {
      channel: 'WHATSAPP',
      recipient: recipient.address,
      status: 'QUEUED',
      provider: 'baileys',
      messageId: delivery?.id ?? undefined,
    } as const;
  }),
});

const publicSharedDeliveryQueue = new DeliveryQueue(
  publicSharedDriverManager.send.bind(publicSharedDriverManager),
  async (task, outcome, attemptNumber) => {
    const metadata = task.request.metadata ?? {};
    if (task.request.event !== 'AdmissionCreated' || typeof metadata.admissionApplicationId !== 'string') return;
    await prisma.admissionDeliveryAttempt.upsert({
      where: {
        admissionApplicationId_audience_channel_attemptNumber: {
          admissionApplicationId: metadata.admissionApplicationId,
          audience: String(metadata.audience ?? 'UNKNOWN'),
          channel: outcome.channel,
          attemptNumber,
        },
      },
      create: {
        admissionApplicationId: metadata.admissionApplicationId,
        audience: String(metadata.audience ?? 'UNKNOWN'),
        channel: outcome.channel,
        attemptNumber,
        status: outcome.status,
        provider: outcome.provider,
        providerMessageId: outcome.messageId,
        error: outcome.error,
      },
      update: {
        status: outcome.status,
        provider: outcome.provider,
        providerMessageId: outcome.messageId,
        error: outcome.error,
      },
    });
  },
  publicAdmissionRetryStore,
);
void publicSharedDeliveryQueue.restorePending().catch((error) => console.error('[admissions] Could not restore durable email retries:', error));

function createPublicCommunicationService() {
  return new CommunicationService({
    rulesEngine: new RulesEngine(publicCommunicationRulesRegistry),
    templateEngine: new TemplateEngine(),
    recipientResolver: new RecipientResolver(),
    deliveryQueue: publicSharedDeliveryQueue,
    driverManager: publicSharedDriverManager,
  });
}

function getPublicGrade(score: number | null | undefined): string | null {
  if (typeof score !== 'number' || Number.isNaN(score)) return null;
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

export function buildPublicResultPayloadItem(input: {
  assessmentId: string;
  assessmentName?: string | null;
  termName?: string | null;
  termId?: string | null;
  totalScore?: number | null;
  caScore?: number | null;
  testScore?: number | null;
  examScore?: number | null;
  grade?: string | null;
}) {
  return {
    id: input.assessmentId,
    assessmentId: input.assessmentId,
    term: input.termName ?? 'Unknown term',
    termId: input.termId ?? null,
    subject: input.assessmentName ?? 'Assessment',
    totalScore: input.totalScore ?? null,
    caScore: input.caScore ?? null,
    testScore: input.testScore ?? null,
    examScore: input.examScore ?? null,
    grade: input.grade ?? null,
  };
}

function normalizePublicAdmissionValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

type AdmissionNotificationSchool = {
  id: string;
  name: string;
  logoUrl: string | null;
  email: string | null;
  phone: string | null;
};

async function notifyAdmissionSubmissionRecipients(
  school: AdmissionNotificationSchool,
  application: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    childName: string | null;
    intendedClass: string | null;
    note: string | null;
    createdAt: Date;
    guardianEmail: string | null;
    statusUrl: string | null;
  }
) {
  const schoolSubject = 'New admission application received';
  const schoolBody = `A new admission application has been submitted for ${school.name}.

Applicant: ${application.firstName} ${application.lastName}
Intended Class: ${application.intendedClass ?? 'N/A'}
Submitted At: ${application.createdAt.toLocaleString()}

Review the application in the admissions admin dashboard.`;

  const applicantBody = `Hello ${application.firstName} ${application.lastName},

Thank you for applying to ${school.name}. We have received your admission request for ${application.childName ?? 'your child'} in ${application.intendedClass ?? 'the requested class'}.

Our admissions team will review your application and contact you with the next update.

If you need help, you can reply to this email or contact the school directly.`;
  const applicantConfirmationBody = application.statusUrl
    ? `${applicantBody}\n\nCheck your application or reply to a request securely here:\n${application.statusUrl}`
    : applicantBody;

  const staffRecipients = [] as Array<{ channel: 'EMAIL' | 'WHATSAPP'; address: string; name: string }>;
  if (school.email) {
    staffRecipients.push({ channel: 'EMAIL', address: school.email, name: 'Admissions Team' });
  }
  if (school.phone) {
    staffRecipients.push({ channel: 'WHATSAPP', address: school.phone, name: 'Admissions Team' });
  }
  const applicantRecipients = [] as Array<{ channel: 'EMAIL' | 'WHATSAPP'; address: string; name: string }>;
  if (application.email) {
    applicantRecipients.push({ channel: 'EMAIL', address: application.email, name: `${application.firstName} ${application.lastName}`.trim() || 'Applicant' });
  }
  if (application.phone) {
    applicantRecipients.push({ channel: 'WHATSAPP', address: application.phone, name: `${application.firstName} ${application.lastName}`.trim() || 'Applicant' });
  }

  const communicationService = createPublicCommunicationService();
  const dispatches = [
    { audience: 'SCHOOL', recipients: staffRecipients, subject: schoolSubject, body: schoolBody },
    { audience: 'APPLICANT', recipients: applicantRecipients, subject: 'Your admission application has been received', body: applicantConfirmationBody },
  ];
  for (const delivery of dispatches) {
    if (delivery.recipients.length === 0) continue;
    await communicationService.dispatch({
      event: 'AdmissionCreated',
      schoolId: school.id,
      recipients: delivery.recipients,
      template: 'Admission',
      subject: delivery.subject,
      body: delivery.body,
      data: {
        schoolName: school.name,
        schoolLogo: school.logoUrl,
        studentName: delivery.audience === 'SCHOOL' ? 'Applicant' : application.childName ?? `${application.firstName} ${application.lastName}`.trim(),
        className: application.intendedClass ?? 'N/A',
        admissionNo: 'N/A',
        recipientName: delivery.audience === 'SCHOOL' ? 'Admissions Team' : `${application.firstName} ${application.lastName}`.trim(),
        ...(delivery.audience === 'APPLICANT' && application.statusUrl ? { statusUrl: application.statusUrl } : {}),
      },
      metadata: {
        admissionApplicationId: application.id,
        audience: delivery.audience,
        schoolName: school.name,
      },
    });
  }
}

function getAdmissionsFrontendOrigin(): string {
  const configured = String(process.env.FRONTEND_URL ?? '').split(',')[0]?.trim();
  try {
    const parsed = new URL(configured || 'https://www.schoolbase.live');
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return `${parsed.protocol}//${parsed.host}`;
  } catch {
    // Use the canonical public application host when configuration is invalid.
  }
  return 'https://www.schoolbase.live';
}

function buildPublicAdmissionStatusUrl(schoolSlug: string, token: string): string {
  return `${getAdmissionsFrontendOrigin()}/admissions/${encodeURIComponent(schoolSlug)}/status#${encodeURIComponent(token)}`;
}

const publicUploadDir = path.join(process.cwd(), 'uploads', 'photos');
if (!fs.existsSync(publicUploadDir)) {
  fs.mkdirSync(publicUploadDir, { recursive: true });
}

const publicStorage = multer.diskStorage({
  destination: publicUploadDir,
  filename: (_req, file, cb) => {
    const extension = file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg';
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(7)}${extension}`;
    cb(null, uniqueName);
  },
});

function matchesPublicImageSignature(filePath: string): boolean {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    const isJpeg = bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const isPng = bytesRead >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isWebp = bytesRead >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
    return isJpeg || isPng || isWebp;
  } finally {
    fs.closeSync(descriptor);
  }
}

const publicFileFilter = (_req: any, file: any, cb: any) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type'), false);
  }
};

const publicUpload = multer({
  storage: publicStorage,
  fileFilter: publicFileFilter,
  limits: { fileSize: 4 * 1024 * 1024 },
});

export async function resolveSchoolForPublicResultCheck(prismaClient: PrismaClient, schoolCode: string) {
  const normalizedInput = String(schoolCode ?? '').trim();
  const compactInput = normalizedInput.replace(/\s+/g, ' ').trim();
  const slugCandidates = [compactInput.toLowerCase(), compactInput.toLowerCase().replace(/\s+/g, '-'), compactInput.replace(/\s+/g, '-').toLowerCase()];
  const initialsCandidates = [compactInput.replace(/\s+/g, '').toUpperCase(), compactInput.toUpperCase()];
  const nameCandidates = [compactInput, compactInput.toLowerCase(), compactInput.toUpperCase()];

  const results = await prismaClient.school.findMany({
    where: {
      OR: [
        { slug: { in: slugCandidates } },
        { initials: { in: initialsCandidates } },
        { name: { contains: compactInput } },
        { name: { contains: compactInput.toLowerCase() } },
        { name: { contains: compactInput.toUpperCase() } },
      ],
    },
    select: {
      id: true,
      name: true,
      slug: true,
      initials: true,
      resultAccessPinEnabled: true,
      resultAccessMode: true,
    },
  });

  if (!results.length) {
    return null;
  }

  const normalizedWanted = compactInput.toLowerCase().replace(/\s+/g, ' ');

  const exactMatch = results.find((school) => {
    if (!school.slug || !compactInput) return false;
    const name = (school.name || '').toLowerCase().replace(/\s+/g, ' ');
    const slug = (school.slug || '').toLowerCase().replace(/\s+/g, '-');
    const initials = (school.initials || '').toUpperCase().replace(/\s+/g, '');
    return slug === normalizedWanted.replace(/\s+/g, '-') || name === normalizedWanted || initials === compactInput.replace(/\s+/g, '').toUpperCase();
  });

  return exactMatch ?? results[0] ?? null;
}

router.get('/admissions/:schoolSlug/settings', async (req: Request, res: Response) => {
  try {
    const schoolSlug = String(req.params.schoolSlug ?? '').trim();
    if (!schoolSlug) {
      return res.status(400).json({ error: 'School slug is required' });
    }

    const school = await prisma.school.findUnique({
      where: { slug: schoolSlug },
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        primaryColor: true,
        address: true,
        city: true,
        admissionsEnabled: true,
        admissionsCapabilityEnabled: true,
        admissionsOpeningDate: true,
        admissionsClosingDate: true,
        admissionsIntroText: true,
        admissionsRequirements: true,
        admissionsContactInfo: true,
        email: true,
        phone: true,
        classes: {
          select: {
            id: true,
            name: true,
            phase: true,
            arm: true,
          },
          orderBy: [
            { phase: 'asc' },
            { name: 'asc' },
          ],
        },
      },
    }) as PublicAdmissionsSchool | null;

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    const requirements = (school.admissionsRequirements ?? '')
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .filter(Boolean);

    res.json({
      ok: true,
      enabled: Boolean(school.admissionsCapabilityEnabled && school.admissionsEnabled),
      capabilityEnabled: Boolean(school.admissionsCapabilityEnabled),
      school: {
        id: school.id,
        name: school.name,
        slug: school.slug,
        logoUrl: school.logoUrl,
        primaryColor: school.primaryColor,
        address: school.address,
        city: school.city,
        email: school.email,
        phone: school.phone,
      },
      classes: school.classes,
      openingDate: school.admissionsOpeningDate ? school.admissionsOpeningDate.toISOString() : null,
      closingDate: school.admissionsClosingDate ? school.admissionsClosingDate.toISOString() : null,
      introText: school.admissionsIntroText || `Apply online for ${school.name} in just a few steps.`,
      requirements: requirements.length > 0 ? requirements : [
        'Provide the applicant details and parent contact information.',
        'Share your preferred class or grade level.',
        'Our admissions team will review your request and get back to you shortly.',
      ],
      contactInfo: school.admissionsContactInfo || `Email: ${school.email || 'N/A'} • Phone: ${school.phone || 'N/A'}`,
    });
  } catch (error) {
    console.error('Error fetching public admissions settings:', error);
    res.status(500).json({ error: 'Failed to fetch admissions information' });
  }
});

router.post('/admissions', (req: Request, res: Response, next: any) => {
  if (!req.is('multipart/form-data')) {
    return next();
  }

  publicUpload.single('photo')(req, res, (uploadError: any) => {
    if (uploadError) {
      console.error('Public admissions photo upload error:', uploadError);
      return res.status(400).json({ error: uploadError.message || 'Invalid photo upload' });
    }

    next();
  });
}, async (req: Request, res: Response) => {
  try {
    if (req.file && !matchesPublicImageSignature(req.file.path)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'The uploaded file is not a valid JPEG, PNG, or WebP image' });
    }
    const schoolSlug = normalizePublicAdmissionValue(req.body?.schoolSlug);
    const firstName = normalizePublicAdmissionValue(req.body?.firstName);
    const lastName = normalizePublicAdmissionValue(req.body?.lastName);
    const email = normalizePublicAdmissionValue(req.body?.email);
    const phone = normalizePublicAdmissionValue(req.body?.phone);
    const studentFirstName = normalizePublicAdmissionValue(req.body?.studentFirstName) ?? normalizePublicAdmissionValue(req.body?.childName);
    const studentMiddleName = normalizePublicAdmissionValue(req.body?.studentMiddleName);
    const studentLastName = normalizePublicAdmissionValue(req.body?.studentLastName) ?? normalizePublicAdmissionValue(req.body?.childName);
    const studentEmail = normalizePublicAdmissionValue(req.body?.studentEmail);
    const studentPhone = normalizePublicAdmissionValue(req.body?.studentPhone);
    const gender = normalizePublicAdmissionValue(req.body?.gender);
    const dateOfBirth = req.body?.dateOfBirth ? new Date(req.body.dateOfBirth) : null;
    const admissionDate = req.body?.admissionDate ? new Date(req.body.admissionDate) : null;
    const intendedClass = normalizePublicAdmissionValue(req.body?.intendedClass);
    const address = normalizePublicAdmissionValue(req.body?.address);
    const bloodGroup = normalizePublicAdmissionValue(req.body?.bloodGroup);
    const genotype = normalizePublicAdmissionValue(req.body?.genotype);
    const medicalNotes = normalizePublicAdmissionValue(req.body?.medicalNotes);
    const previousSchool = normalizePublicAdmissionValue(req.body?.previousSchool);
    const previousClass = normalizePublicAdmissionValue(req.body?.previousClass);
    const guardianFirst = normalizePublicAdmissionValue(req.body?.guardianFirst) ?? firstName;
    const guardianLast = normalizePublicAdmissionValue(req.body?.guardianLast) ?? lastName;
    const guardianRelationship = normalizePublicAdmissionValue(req.body?.guardianRelationship) ?? 'Parent';
    const guardianEmail = normalizePublicAdmissionValue(req.body?.guardianEmail) ?? email;
    const guardianPhone = normalizePublicAdmissionValue(req.body?.guardianPhone) ?? phone;
    const guardianAltPhone = normalizePublicAdmissionValue(req.body?.guardianAltPhone);
    const guardianOccupation = normalizePublicAdmissionValue(req.body?.guardianOccupation);
    const note = normalizePublicAdmissionValue(req.body?.note);
    const requestId = normalizePublicAdmissionValue(req.headers['x-admission-request-id']);
    const publicStatusToken = normalizePublicAdmissionValue(req.headers['x-admission-status-token']);
    const parentName = `${guardianFirst || firstName || ''} ${guardianLast || lastName || ''}`.trim() || null;
    const childName = `${studentFirstName || ''} ${studentLastName || ''}`.trim() || null;

    if (!schoolSlug || !firstName || !lastName || !email || !phone || !studentFirstName || !studentLastName) {
      return res.status(400).json({ error: 'School, applicant name, applicant email, applicant phone, and student name are required' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid applicant email address' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a student photo before submitting' });
    }

    const school = await prisma.school.findUnique({
      where: { slug: schoolSlug },
      select: { id: true, name: true, slug: true, email: true, phone: true, admissionsContactInfo: true, address: true, primaryColor: true, logoUrl: true, city: true, admissionsCapabilityEnabled: true, admissionsEnabled: true, admissionsOpeningDate: true, admissionsClosingDate: true, admissionsIntroText: true, admissionsRequirements: true },
    });

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    const now = new Date();
    if (!school.admissionsCapabilityEnabled) {
      return res.status(404).json({ error: 'Online admissions are not available' });
    }
    if (!school.admissionsEnabled) {
      return res.status(403).json({ error: 'Online admissions are currently closed' });
    }

    if (school.admissionsOpeningDate && now < school.admissionsOpeningDate) {
      return res.status(403).json({
        error: 'Online admissions are not open yet',
        openingDate: school.admissionsOpeningDate.toISOString(),
      });
    }

    if (school.admissionsClosingDate && now > school.admissionsClosingDate) {
      return res.status(403).json({
        error: 'Online admissions are closed',
        closingDate: school.admissionsClosingDate.toISOString(),
      });
    }

    if (requestId) {
      const previousApplication = await findAdmissionByRequestKey(prisma, school.id, requestId, {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          childName: true,
          intendedClass: true,
          status: true,
          createdAt: true,
        },
      });

      if (previousApplication) {
        if (req.file) fs.unlink(req.file.path, () => undefined);
        return res.status(200).json({
          ok: true,
          message: 'Admission request already received.',
          application: {
            ...previousApplication,
            status: normalizeAdmissionStatus(previousApplication.status),
          },
        });
      }
    }

    const application = await prisma.$transaction(async (transaction) => {
      const createdApplication = await transaction.admissionApplication.create({
        data: {
        schoolId: school.id,
        requestKey: requestId,
        applicationNumber: `ADM-${new Date().getFullYear()}-${createHash('sha256').update(`${school.id}:${requestId || randomUUID()}`).digest('hex').slice(0, 8).toUpperCase()}`,
        publicStatusTokenHash: publicStatusToken ? createHash('sha256').update(publicStatusToken).digest('hex') : null,
        publicStatusTokenExpiresAt: publicStatusToken ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) : null,
        firstName,
        lastName,
        email,
        phone,
        childName,
        dateOfBirth: Number.isNaN(dateOfBirth?.getTime()) ? null : dateOfBirth,
        intendedClass: intendedClass ?? null,
        parentName,
        note: note ?? null,
        status: 'SUBMITTED',
        studentFirstName,
        studentMiddleName,
        studentLastName,
        studentEmail,
        studentPhone,
        gender,
        admissionDate: Number.isNaN(admissionDate?.getTime()) ? null : admissionDate,
        address: address ?? null,
        bloodGroup: bloodGroup ?? null,
        genotype: genotype ?? null,
        medicalNotes: medicalNotes ?? null,
        previousSchool: previousSchool ?? null,
        previousClass: previousClass ?? null,
        photoUrl: req.file ? `/uploads/photos/${req.file.filename}` : null,
        guardianFirst,
        guardianLast,
        guardianRelationship,
        guardianEmail,
        guardianPhone,
        guardianAltPhone,
        guardianOccupation,
        studentId: null,
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          childName: true,
          intendedClass: true,
          status: true,
          createdAt: true,
        },
      });

      const admissionAdmins = await transaction.user.findMany({
        where: { schoolId: school.id, role: 'SCHOOL_ADMIN' },
        select: { id: true },
      });
      if (admissionAdmins.length > 0) {
        const applicantName = `${firstName} ${lastName}`.trim();
        await transaction.schoolAdminNotification.createMany({
          data: admissionAdmins.map((recipient) => ({
            schoolId: school.id,
            recipientUserId: recipient.id,
            admissionApplicationId: createdApplication.id,
            type: 'ADMISSION_APPLICATION',
            title: 'New admission application',
            body: `${applicantName}${intendedClass ? ` · ${intendedClass}` : ''} · received ${createdApplication.createdAt.toLocaleString()}`.slice(0, 500),
          })),
          skipDuplicates: true,
        });
      }

      await transaction.admissionApplicationEvent.create({
        data: {
          schoolId: school.id,
          admissionApplicationId: createdApplication.id,
          actorName: 'Public applicant',
          type: 'APPLICATION_SUBMITTED',
          toStatus: 'SUBMITTED',
          metadata: { source: 'PUBLIC_FORM' },
        },
      });

      return createdApplication;
    }) as {
      id: string;
      firstName: string;
      lastName: string;
      email: string | null;
      phone: string | null;
      childName: string | null;
      intendedClass: string | null;
      status: string;
      createdAt: Date;
    };

    try {
      await notifyAdmissionSubmissionRecipients(school, {
        id: application.id,
        firstName: application.firstName,
        lastName: application.lastName,
        email: application.email,
        phone: application.phone,
        childName: application.childName,
        intendedClass: application.intendedClass,
        note: note ?? null,
        createdAt: application.createdAt,
        guardianEmail,
        statusUrl: publicStatusToken ? buildPublicAdmissionStatusUrl(school.slug, publicStatusToken) : null,
      });
    } catch (notificationError) {
      console.warn('Failed to send admission submission notification:', notificationError);
    }

    res.status(201).json({
      ok: true,
      message: 'Admission request received. Our team will review it shortly.',
      application: {
        ...application,
        status: normalizeAdmissionStatus(application.status),
      },
    });
  } catch (error) {
    const prismaError = error as { code?: string; meta?: { target?: string[] } };
    const retryRequestId = normalizePublicAdmissionValue(req.headers['x-admission-request-id']);
    const retrySchoolSlug = normalizePublicAdmissionValue(req.body?.schoolSlug);
    if (prismaError?.code === 'P2002' && retryRequestId && retrySchoolSlug) {
      const school = await prisma.school.findUnique({ where: { slug: retrySchoolSlug }, select: { id: true } }).catch(() => null);
      const existing = school?.id ? await findAdmissionByRequestKey(prisma, school.id, retryRequestId, {
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, childName: true, intendedClass: true, status: true, createdAt: true },
      }).catch(() => null) : null;
      if (existing) {
        if (req.file) fs.unlink(req.file.path, () => undefined);
        return res.status(200).json({
          ok: true,
          message: 'Admission request already received.',
          application: { ...existing, status: normalizeAdmissionStatus(existing.status) },
        });
      }
    }
    console.error('Error creating public admission application:', error);
    res.status(500).json({ error: 'Failed to submit admission request' });
  }
});

router.post('/admissions/status/reply', async (req: Request, res: Response) => {
  try {
    const schoolSlug = normalizePublicAdmissionValue(req.body?.schoolSlug);
    const statusToken = normalizePublicAdmissionValue(req.body?.token);
    if (!schoolSlug || !statusToken || statusToken.length < 32 || statusToken.length > 256) {
      return res.status(400).json({ error: 'A valid application access token is required' });
    }
    const result = await submitPublicAdmissionReply(prisma, {
      schoolSlug,
      token: statusToken,
      message: req.body?.message,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(result.status).json({ ok: true, status: 'UNDER_REVIEW', message: result.message });
  } catch (error) {
    console.error('Error saving applicant admission reply:', error);
    return res.status(500).json({ error: 'Unable to send your reply right now' });
  }
});

router.post('/admissions/status', async (req: Request, res: Response) => {
  try {
    const schoolSlug = normalizePublicAdmissionValue(req.body?.schoolSlug);
    const statusToken = normalizePublicAdmissionValue(req.body?.token);

    if (!schoolSlug || !statusToken || statusToken.length < 32 || statusToken.length > 256) {
      return res.status(400).json({ error: 'School slug and a valid application access token are required' });
    }

    const result = await getPublicAdmissionStatus(prisma, schoolSlug, statusToken);
    if (result === null) {
      return res.status(404).json({ error: 'School not found' });
    }
    if (result === false) {
      return res.status(404).json({ error: 'Application status could not be verified' });
    }
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Error fetching admissions status:', error);
    res.status(500).json({ error: 'Failed to fetch admissions status' });
  }
});

router.get('/videos', async (_req: Request, res: Response) => {
  try {
    const storedVideos = await prisma.videoTutorial.findMany({
      orderBy: [{ featured: 'desc' }, { createdAt: 'desc' }],
    });
    const videos = storedVideos.filter((video) => isPublicTutorialVideoUrl(video.videoUrl));

    res.json({
      videos: videos.map((video) => ({
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
    console.error('Error fetching public videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
});

router.get('/videos/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const video = await prisma.videoTutorial.findUnique({
      where: { id },
    });

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    if (!isPublicTutorialVideoUrl(video.videoUrl)) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.json({
      video: {
        id: video.id,
        title: video.title,
        description: video.description,
        videoUrl: video.videoUrl,
        category: video.category,
        featured: video.featured,
        createdAt: video.createdAt,
        updatedAt: video.updatedAt,
      },
    });
  } catch (error) {
    console.error('Error fetching public video:', error);
    res.status(500).json({ error: 'Failed to fetch video' });
  }
});

router.post('/results/check', async (req: Request, res: Response) => {
  try {
    const schoolCode = String(req.body?.schoolCode ?? '').trim().toLowerCase();
    const admissionNo = String(req.body?.admissionNo ?? '').trim();
    const pin = String(req.body?.pin ?? '').trim();
    const termId = String(req.body?.termId ?? '').trim();

    if (!schoolCode || !admissionNo) {
      return res.status(400).json({ error: 'School code and admission number are required' });
    }

    const school = await resolveSchoolForPublicResultCheck(prisma, schoolCode);

    if (!school) {
      return res.status(404).json({ error: 'School not found for the provided school code' });
    }

    const pinAccessEnabled = Boolean(school.resultAccessPinEnabled);
    const mode = school.resultAccessMode || 'NONE';
    if (mode === 'PARENT_PORTAL_ONLY') {
      return res.status(403).json({
        error: 'This school only allows parent-portal result access',
        requiresPin: false,
      });
    }

    const pupil = await prisma.pupil.findFirst({
      where: {
        schoolId: school.id,
        admissionNo,
      },
      include: {
        class: {
          select: {
            id: true,
            name: true,
            phase: true,
          },
        },
      },
    });

    if (!pupil || !pupil.class) {
      return res.status(404).json({ error: 'Student record not found for the supplied admission number' });
    }

    const publishedAssessmentWhere: any = {
      schoolId: school.id,
      phase: pupil.class.phase,
      status: 'PUBLISHED',
    };

    if (!pinAccessEnabled) {
      const where: any = { ...publishedAssessmentWhere };

      if (termId && termId !== 'latest') {
        where.termId = termId;
      }

      const assessments = await prisma.assessment.findMany({
        where,
        include: {
          term: {
            select: { id: true, name: true, sortOrder: true },
          },
          results: {
            where: { pupilId: pupil.id },
            select: {
              id: true,
              caScore: true,
              testScore: true,
              examScore: true,
              totalScore: true,
            },
          },
        },
        orderBy: [
          { term: { sortOrder: 'desc' } },
          { createdAt: 'desc' },
        ],
      });

      const resultPayload = assessments.map((assessment) => {
        const result = assessment.results[0];
        const totalScore = result?.totalScore ?? null;
        return buildPublicResultPayloadItem({
          assessmentId: assessment.id,
          assessmentName: assessment.name ?? 'Assessment',
          termName: assessment.term?.name ?? 'Unknown term',
          termId: assessment.term?.id ?? null,
          totalScore,
          caScore: result?.caScore ?? null,
          testScore: result?.testScore ?? null,
          examScore: result?.examScore ?? null,
          grade: getPublicGrade(totalScore) ?? null,
        });
      });

      const reportCards = await Promise.all(
        assessments.map(async (assessment) => {
          try {
            const reportCardData = await reportCardService.generateReportCard(assessment.id, pupil.id, school.id);
            return {
              assessmentId: assessment.id,
              ...reportCardData,
            };
          } catch (error) {
            console.error('Error generating public report card payload:', error);
            return null;
          }
        })
      );

      const hasPublishedResults = resultPayload.length > 0 || reportCards.some(Boolean);

      return res.json({
        ok: true,
        requiresPin: false,
        message: hasPublishedResults ? null : 'No published results are available yet for this student.',
        school: {
          id: school.id,
          name: school.name,
          slug: school.slug,
          mode: school.resultAccessMode || 'NONE',
        },
        student: {
          id: pupil.id,
          firstName: pupil.firstName,
          lastName: pupil.lastName,
          admissionNo: pupil.admissionNo,
          className: pupil.class?.name ?? null,
        },
        results: resultPayload,
        reportCards: reportCards.filter(Boolean),
        term: assessments[0]?.term ?? null,
      });
    }

    // Only require a PIN when the school has explicitly enabled PIN-protected result access.
    if (!pin) {
      return res.status(403).json({
        error: 'PIN is required to view results',
        requiresPin: true,
        student: {
          id: pupil.id,
          firstName: pupil.firstName,
          lastName: pupil.lastName,
          admissionNo: pupil.admissionNo,
          className: pupil.class?.name ?? null,
        },
        school: {
          id: school.id,
          name: school.name,
          slug: school.slug,
          mode: school.resultAccessMode || 'NONE',
        },
      });
    }

    const effectiveTermId = termId && termId !== 'latest' ? termId : null;

    const candidates = await prisma.resultPin.findMany({
      where: {
        schoolId: school.id,
        status: 'ACTIVE',
        OR: [
          { studentId: pupil.id },
          { studentId: null },
        ],
        ...(effectiveTermId ? { termId: effectiveTermId } : {}),
      },
      select: {
        id: true,
        pinHash: true,
        type: true,
        studentId: true,
        expiresAt: true,
        termId: true,
        assessmentId: true,
      },
      orderBy: { generatedAt: 'desc' },
    });

    const now = Date.now();
    let matchedPin: { id: string; type: string; studentId: string | null; termId: string | null; assessmentId: string | null } | null = null;

    for (const candidate of candidates) {
      if (candidate.expiresAt && new Date(candidate.expiresAt).getTime() < now) {
        continue;
      }

      const matches = await bcrypt.compare(pin, candidate.pinHash);
      if (!matches) {
        continue;
      }

      if (candidate.type === 'GENERIC' && !candidate.studentId) {
        await prisma.resultPin.update({
          where: { id: candidate.id },
          data: { studentId: pupil.id, assignedAt: new Date() },
        });
      }

      matchedPin = candidate;
      break;
    }

    if (!matchedPin) {
      return res.status(403).json({ error: 'The supplied PIN is invalid or has expired' });
    }

    const where: any = { ...publishedAssessmentWhere };

    const pinTermId = matchedPin?.termId && matchedPin.termId !== 'latest' ? matchedPin.termId : null;
    const resolvedTermId = effectiveTermId || pinTermId;

    if (resolvedTermId) {
      where.termId = resolvedTermId;
    }

    const assessments = await prisma.assessment.findMany({
      where,
      include: {
        term: {
          select: { id: true, name: true, sortOrder: true },
        },
        results: {
          where: { pupilId: pupil.id },
          select: {
            id: true,
            caScore: true,
            testScore: true,
            examScore: true,
            totalScore: true,
          },
        },
      },
      orderBy: [
        { term: { sortOrder: 'desc' } },
        { createdAt: 'desc' },
      ],
    });

    const resultPayload = assessments.map((assessment) => {
      const result = assessment.results[0];
      const totalScore = result?.totalScore ?? null;
      return buildPublicResultPayloadItem({
        assessmentId: assessment.id,
        assessmentName: assessment.name ?? 'Assessment',
        termName: assessment.term?.name ?? 'Unknown term',
        termId: assessment.term?.id ?? null,
        totalScore,
        caScore: result?.caScore ?? null,
        testScore: result?.testScore ?? null,
        examScore: result?.examScore ?? null,
        grade: getPublicGrade(totalScore) ?? null,
      });
    });

    const reportCards = await Promise.all(
      assessments.map(async (assessment) => {
        try {
          const reportCardData = await reportCardService.generateReportCard(assessment.id, pupil.id, school.id);
          return {
            assessmentId: assessment.id,
            ...reportCardData,
          };
        } catch (error) {
          console.error('Error generating public report card payload:', error);
          return null;
        }
      })
    );

    const hasPublishedResults = resultPayload.length > 0 || reportCards.some(Boolean);

    res.json({
      ok: true,
      requiresPin: false,
      message: hasPublishedResults ? null : 'No published results are available yet for this student.',
      school: {
        id: school.id,
        name: school.name,
        slug: school.slug,
        mode: school.resultAccessMode || 'NONE',
      },
      student: {
        id: pupil.id,
        firstName: pupil.firstName,
        lastName: pupil.lastName,
        admissionNo: pupil.admissionNo,
        className: pupil.class?.name ?? null,
      },
      results: resultPayload,
      reportCards: reportCards.filter(Boolean),
      term: assessments[0]?.term ?? null,
    });
  } catch (error) {
    console.error('Error checking public result access:', error);
    res.status(500).json({ error: 'Failed to check results' });
  }
});

export default router;
