import { Router, type Request, type Response, type NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyAuth, type AuthenticatedRequest } from '../middleware/roleAuth.js';
import { requireSubscription } from '../middleware/subscriptionGuard.js';
import { calculateIdCardQuote, ID_CARD_TEMPLATES, validateIdCardPricingRule, type IdCardOrientation, type IdCardPricingRule } from '../services/id-card-pricing.js';
import { decryptIdCardSnapshot, encryptIdCardSnapshot } from '../services/id-card-snapshot.js';
import { buildParentPortalQrUrl, getParentPortalQrStatus, getPublicAppOrigin } from '../services/id-card-qr.js';
import { buildIdCardPreflightWarnings, resolveIdCardPayerEmail, verifyPaystackSignature } from '../services/id-card-payment.js';
import { generateIdCardA4SheetPdf, generateIdCardPdf, savePrivateIdCardArtifact, type IdCardRenderSnapshot } from '../services/id-card-pdf.js';

const router = Router();
const prisma = new PrismaClient();
const PAYSTACK_BASE_URL = 'https://api.paystack.co';
const MAX_ORDER_CARDS = 200;
const ID_CARD_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type RawBodyRequest = Request & { rawBody?: Buffer };

function authenticatedUser(req: Request) {
  return (req as AuthenticatedRequest).user;
}

function requireSchoolAdmin(req: Request, res: Response, next: NextFunction) {
  const user = authenticatedUser(req);
  if (!user?.schoolId || !user.userId) return res.status(401).json({ error: 'School session required.' });
  if (user.role !== 'SCHOOL_ADMIN') return res.status(403).json({ error: 'School administrator access required.' });
  next();
}

async function getActivePricingRule() {
  const row = await prisma.idCardPricingRule.findFirst({
    where: { isActive: true, effectiveAt: { lte: new Date() } },
    orderBy: { effectiveAt: 'desc' },
  });
  if (!row) return null;
  try {
    const rule: unknown = JSON.parse(row.ruleJson);
    return validateIdCardPricingRule(rule) ? { row, rule } : null;
  } catch {
    return null;
  }
}

function addOrderEvent(tx: any, orderId: string, eventType: string, actorId: string | null, details?: Record<string, unknown>) {
  return tx.idCardOrderEvent.create({
    data: { orderId, eventType, actorId, details: details ? JSON.stringify(details) : null },
  });
}

router.post('/webhooks/paystack', async (req: Request, res: Response) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const rawBody = (req as RawBodyRequest).rawBody;
  if (!secret || !rawBody || !verifyPaystackSignature(rawBody, req.get('x-paystack-signature'), secret)) {
    return res.status(401).json({ error: 'Invalid payment webhook signature.' });
  }

  const event = req.body as {
    event?: string;
    data?: {
      id?: number | string;
      reference?: string;
      status?: string;
      amount?: number;
      currency?: string;
      metadata?: { orderType?: string; orderId?: string; schoolId?: string };
    };
  };
  if (event.event !== 'charge.success' || !event.data?.reference || !event.data.id) return res.status(200).json({ received: true });

  try {
    const transaction = event.data;
    const order = await prisma.idCardOrder.findFirst({
      where: { providerReference: transaction.reference },
      include: { quote: true },
    });
    if (!order) return res.status(200).json({ received: true });

    if (
      transaction.status !== 'success' ||
      Number(transaction.amount) !== order.amountMinor ||
      String(transaction.currency || '').toUpperCase() !== order.currency.toUpperCase() ||
      transaction.metadata?.orderType !== 'ID_CARD' ||
      transaction.metadata?.orderId !== order.id ||
      transaction.metadata?.schoolId !== order.schoolId
    ) {
      await addOrderEvent(prisma, order.id, 'PAYMENT_WEBHOOK_REJECTED', null, {
        providerTransactionId: transaction.id ? String(transaction.id) : null,
        reason: 'Payment event did not match the pending card order.',
      });
      return res.status(200).json({ received: true });
    }

    const confirmed = await prisma.idCardOrder.updateMany({
      where: { id: order.id, paymentStatus: 'PENDING', providerReference: transaction.reference },
      data: { paymentStatus: 'PAID', status: 'PAID', providerTransactionId: String(transaction.id) },
    });
    if (confirmed.count === 1) {
      await addOrderEvent(prisma, order.id, 'PAYMENT_CONFIRMED', null, {
        source: 'PAYSTACK_WEBHOOK',
        providerTransactionId: transaction.id ? String(transaction.id) : null,
        amountMinor: order.amountMinor,
        currency: order.currency,
      });
    }

    if (confirmed.count === 1 || (order.paymentStatus === 'PAID' && order.status !== 'READY')) {
      try {
        await verifyAndGenerate(order.id, order.schoolId, null);
      } catch (generationError) {
        console.error('[id-card-studio] Webhook-confirmed order generation deferred to retry', {
          orderId: order.id,
          message: generationError instanceof Error ? generationError.message : 'Unknown generation error.',
        });
      }
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('[id-card-studio] Paystack webhook processing failed', {
      message: error instanceof Error ? error.message : 'Unknown webhook error.',
    });
    return res.status(500).json({ error: 'Unable to process payment webhook.' });
  }
});

router.use(verifyAuth, requireSchoolAdmin);

router.get('/templates', (_req, res) => {
  res.json({
    templates: Object.entries(ID_CARD_TEMPLATES).map(([id, template]) => ({ id, ...template })),
    parentPortalQr: getParentPortalQrStatus(),
  });
});

router.get('/draft', async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  await prisma.idCardDraft.deleteMany({ where: { schoolId: user.schoolId, expiresAt: { lte: new Date() } } });
  const draft = await prisma.idCardDraft.findUnique({ where: { schoolId_createdBy: { schoolId: user.schoolId, createdBy: user.userId } } });
  if (!draft) return res.json({ draft: null });
  res.json({ draft: { ...JSON.parse(draft.draftJson), updatedAt: draft.updatedAt, expiresAt: draft.expiresAt } });
});

router.put('/draft', async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  const studentIds = req.body?.studentIds;
  const templateId = String(req.body?.templateId || '');
  const orientation = String(req.body?.orientation || '');
  const includeCardBack = req.body?.includeCardBack === true;
  const includeParentPortalQr = req.body?.includeParentPortalQr === true;
  const awardId = typeof req.body?.awardId === 'string' ? req.body.awardId : null;
  const template = ID_CARD_TEMPLATES[templateId as keyof typeof ID_CARD_TEMPLATES];
  if (!Array.isArray(studentIds) || studentIds.length > MAX_ORDER_CARDS || studentIds.some((id: unknown) => typeof id !== 'string')) {
    return res.status(400).json({ error: `A draft can contain at most ${MAX_ORDER_CARDS} student IDs.` });
  }
  if (new Set(studentIds).size !== studentIds.length) return res.status(400).json({ error: 'Draft contains duplicate student IDs.' });
  if (template && !template.orientations.includes(orientation as IdCardOrientation)) return res.status(400).json({ error: 'Draft orientation is not supported by this template.' });
  if (!templateId || !template) return res.status(400).json({ error: 'Choose a valid card design before saving the draft.' });
  if (includeParentPortalQr && (!includeCardBack || !getParentPortalQrStatus().available)) return res.status(400).json({ error: 'The QR draft setting is unavailable without a valid card back and public URL.' });

  const draftValue = { studentIds, templateId, orientation, includeCardBack, includeParentPortalQr, awardId };
  const draftJson = JSON.stringify(draftValue);
  if (Buffer.byteLength(draftJson, 'utf8') > 100_000) return res.status(413).json({ error: 'Draft is too large to save.' });
  const expiresAt = new Date(Date.now() + ID_CARD_DRAFT_TTL_MS);
  const draft = await prisma.idCardDraft.upsert({
    where: { schoolId_createdBy: { schoolId: user.schoolId, createdBy: user.userId } },
    create: { schoolId: user.schoolId, createdBy: user.userId, draftJson, expiresAt },
    update: { draftJson, expiresAt },
    select: { updatedAt: true, expiresAt: true },
  });
  res.json({ saved: true, updatedAt: draft.updatedAt, expiresAt: draft.expiresAt });
});

router.delete('/draft', async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  await prisma.idCardDraft.deleteMany({ where: { schoolId: user.schoolId, createdBy: user.userId } });
  res.json({ deleted: true });
});

router.get('/students', requireSubscription, async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  const search = String(req.query.search || '').trim();
  const classId = typeof req.query.classId === 'string' ? req.query.classId : undefined;
  const where: any = { schoolId: user.schoolId, isActive: true };
  if (classId) where.classId = classId;
  if (search) {
    where.OR = [
      { firstName: { contains: search } },
      { middleName: { contains: search } },
      { lastName: { contains: search } },
      { admissionNo: { contains: search } },
    ];
  }

  try {
    const [students, total, classes] = await Promise.all([
      prisma.pupil.findMany({
        where,
        take: 500,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        select: {
          id: true,
          firstName: true,
          middleName: true,
          lastName: true,
          admissionNo: true,
          photoUrl: true,
          classId: true,
          class: { select: { name: true, arm: true } },
        },
      }),
      prisma.pupil.count({ where }),
      prisma.class.findMany({ where: { schoolId: user.schoolId }, orderBy: { name: 'asc' }, select: { id: true, name: true, arm: true } }),
    ]);
    res.json({ students, total, classes, capped: total > students.length });
  } catch (error) {
    console.error('[id-card-studio] Failed to load students', error);
    res.status(500).json({ error: 'Unable to load student records.' });
  }
});

router.get('/students/:studentId/photo', requireSubscription, async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  try {
    const pupil = await prisma.pupil.findFirst({
      where: { id: req.params.studentId, schoolId: user.schoolId, isActive: true },
      select: { photoUrl: true },
    });
    if (!pupil?.photoUrl || !pupil.photoUrl.startsWith('/uploads/')) {
      return res.status(404).json({ error: 'Student photo not found.' });
    }

    const uploadsRoot = path.resolve(process.cwd(), 'uploads');
    const imagePath = path.resolve(uploadsRoot, pupil.photoUrl.slice('/uploads/'.length));
    if (!imagePath.startsWith(`${uploadsRoot}${path.sep}`)) {
      return res.status(404).json({ error: 'Student photo not found.' });
    }

    const extension = path.extname(imagePath).toLowerCase();
    const contentType = extension === '.png' ? 'image/png' : ['.jpg', '.jpeg'].includes(extension) ? 'image/jpeg' : null;
    if (!contentType) return res.status(415).json({ error: 'Student photo format is not supported for ID cards.' });

    const bytes = await readFile(imagePath);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return res.status(404).json({ error: 'Student photo not found.' });
    console.error('[id-card-studio] Failed to serve student photo', error);
    return res.status(500).json({ error: 'Unable to load student photo.' });
  }
});

router.get('/awards', requireSubscription, async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  const now = new Date();
  const awards = await prisma.idCardUsageAward.findMany({
    where: {
      schoolId: user.schoolId,
      status: 'APPROVED',
      awardType: { in: ['UNITS', 'FULL_ORDER'] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, awardType: true, unitsGranted: true, unitsReserved: true, unitsRedeemed: true, currency: true, eligibleTiersJson: true, terms: true, expiresAt: true },
  });
  res.json({ awards: awards.map((award) => ({
    id: award.id,
    awardType: award.awardType,
    availableUnits: Math.max(0, award.unitsGranted - award.unitsReserved - award.unitsRedeemed),
    currency: award.currency,
    eligibleTiers: JSON.parse(award.eligibleTiersJson),
    terms: award.terms,
    expiresAt: award.expiresAt,
  })).filter((award) => award.availableUnits > 0) });
});

router.post('/quotes', requireSubscription, async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  const rawIds = req.body?.studentIds;
  const templateId = String(req.body?.templateId || '');
  const template = ID_CARD_TEMPLATES[templateId as keyof typeof ID_CARD_TEMPLATES];
  const requestedOrientation = String(req.body?.orientation || template?.defaultOrientation || '');
  const includeParentPortalQr = req.body?.includeParentPortalQr === true;
  const includeCardBack = req.body?.includeCardBack === true || includeParentPortalQr;
  const awardId = typeof req.body?.awardId === 'string' ? req.body.awardId : null;
  if (!template) return res.status(400).json({ error: 'The selected card template is unavailable.' });
  if (!template.orientations.includes(requestedOrientation as IdCardOrientation)) {
    return res.status(400).json({ error: 'The selected orientation is not supported by this template.' });
  }
  if (includeCardBack && !includeParentPortalQr) {
    return res.status(400).json({ error: 'A Parent Portal QR is required on the card back.' });
  }
  if (includeParentPortalQr && !includeCardBack) {
    return res.status(400).json({ error: 'A Parent Portal QR requires a card back.' });
  }
  const orientation = requestedOrientation as IdCardOrientation;
  const parentPortalQr = getParentPortalQrStatus();
  if (includeParentPortalQr && !parentPortalQr.available) {
    return res.status(403).json({ error: parentPortalQr.reason || 'Parent Portal QR is not enabled.' });
  }
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > MAX_ORDER_CARDS || rawIds.some((id: unknown) => typeof id !== 'string')) {
    return res.status(400).json({ error: `Choose between 1 and ${MAX_ORDER_CARDS} students.` });
  }
  const studentIds = rawIds.map((id: string) => id.trim());
  if (new Set(studentIds).size !== studentIds.length) return res.status(400).json({ error: 'The selection contains duplicate students.' });

  try {
    const pricing = await getActivePricingRule();
    if (!pricing) return res.status(503).json({ error: 'ID-card pricing is not configured.' });
    const [students, school] = await Promise.all([
      prisma.pupil.findMany({
        where: { id: { in: studentIds }, schoolId: user.schoolId, isActive: true },
        select: {
          id: true,
          firstName: true,
          middleName: true,
          lastName: true,
          admissionNo: true,
          photoUrl: true,
          class: { select: { name: true, arm: true } },
        },
      }),
      prisma.school.findUnique({
        where: { id: user.schoolId },
        select: { id: true, name: true, slug: true, initials: true, logoUrl: true, primaryColor: true, address: true, phone: true, currency: true },
      }),
    ]);
    if (!school || students.length !== studentIds.length) return res.status(400).json({ error: 'One or more selected students are unavailable.' });

    const preflightWarnings = buildIdCardPreflightWarnings(students);

    const price = calculateIdCardQuote({ quantity: students.length, templateId, rule: pricing.rule });
    let awardDiscountMinor = 0;
    if (awardId) awardDiscountMinor = price.totalMinor;
    const quote = {
      ...price,
      discountMinor: awardDiscountMinor,
      totalMinor: price.totalMinor - awardDiscountMinor,
    };
    const snapshot: IdCardRenderSnapshot = {
      templateId,
      orientation,
      includeCardBack,
      parentPortalQrUrl: includeParentPortalQr ? buildParentPortalQrUrl(school.slug) : null,
      school: {
        name: school.name,
        slug: school.slug,
        initials: school.initials,
        logoUrl: school.logoUrl,
        primaryColor: school.primaryColor,
        address: school.address,
        phone: school.phone,
      },
      students: students.map((student) => ({
        id: student.id,
        firstName: student.firstName,
        middleName: student.middleName,
        lastName: student.lastName,
        admissionNo: student.admissionNo,
        photoUrl: student.photoUrl,
        className: [student.class?.name, student.class?.arm].filter(Boolean).join(' ') || null,
      })),
    };
    const saved = await prisma.$transaction(async (tx) => {
      if (awardId) {
        const lockedAwards = await tx.$queryRaw<Array<{ id: string; awardType: string; unitsGranted: number; unitsReserved: number; unitsRedeemed: number; currency: string; eligibleTiersJson: string }>>`
          SELECT id, awardType, unitsGranted, unitsReserved, unitsRedeemed, currency, eligibleTiersJson
          FROM IdCardUsageAward
          WHERE id = ${awardId} AND schoolId = ${user.schoolId} AND status = 'APPROVED'
            AND (expiresAt IS NULL OR expiresAt > CURRENT_TIMESTAMP(3))
          FOR UPDATE
        `;
        const award = lockedAwards[0];
        const eligibleTiers: unknown = award ? JSON.parse(award.eligibleTiersJson) : [];
        const availableUnits = award ? award.unitsGranted - award.unitsReserved - award.unitsRedeemed : 0;
        if (!award || !['UNITS', 'FULL_ORDER'].includes(award.awardType) || award.currency !== quote.currency || !Array.isArray(eligibleTiers) || !eligibleTiers.includes(quote.templateTier) || availableUnits < students.length) {
          throw new Error('This award is unavailable or does not cover the complete selected batch.');
        }
      }

      return tx.idCardQuote.create({
        data: {
          schoolId: user.schoolId,
          pricingRuleId: pricing.row.id,
          pricingRuleVersion: pricing.row.version,
          currency: quote.currency,
          quantity: quote.quantity,
          templateId: quote.templateId,
          templateTier: quote.templateTier,
          subtotalMinor: quote.subtotalMinor,
          discountMinor: quote.discountMinor,
          taxMinor: quote.taxMinor,
          totalMinor: quote.totalMinor,
          studentIdsJson: JSON.stringify(studentIds),
          optionsJson: JSON.stringify({ orientation, includeCardBack, includeParentPortalQr, awardId, bandBreakdown: quote.bandBreakdown, upliftPerCardMinor: quote.upliftPerCardMinor }),
          renderSnapshotEncrypted: encryptIdCardSnapshot(snapshot),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          createdBy: user.userId,
        },
      });
    });
    res.status(201).json({
      quote: {
        id: saved.id,
        quantity: quote.quantity,
        currency: quote.currency,
        templateId: quote.templateId,
        orientation,
        includeCardBack,
        includeParentPortalQr,
        awardId,
        templateTier: quote.templateTier,
        subtotalMinor: quote.subtotalMinor,
        discountMinor: quote.discountMinor,
        taxMinor: quote.taxMinor,
        totalMinor: quote.totalMinor,
        bandBreakdown: quote.bandBreakdown,
        upliftPerCardMinor: quote.upliftPerCardMinor,
        expiresAt: saved.expiresAt,
      },
      preview: snapshot,
      preflight: {
        selectedCount: students.length,
        warningCount: preflightWarnings.length,
        warnings: preflightWarnings,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create quote.';
    res.status(400).json({ error: message });
  }
});

router.get('/quotes/:quoteId/preview.pdf', async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  const quote = await prisma.idCardQuote.findFirst({
    where: { id: req.params.quoteId, schoolId: user.schoolId, status: 'QUOTED', expiresAt: { gt: new Date() } },
    select: { id: true, renderSnapshotEncrypted: true },
  });
  if (!quote?.renderSnapshotEncrypted) return res.status(404).json({ error: 'This card proof has expired. Review the order again to create a new proof.' });

  try {
    const snapshot = decryptIdCardSnapshot<IdCardRenderSnapshot>(quote.renderSnapshotEncrypted);
    if (!snapshot.students.length) return res.status(404).json({ error: 'No student card is available in this proof.' });
    const previewSnapshot = { ...snapshot, students: snapshot.students.slice(0, 1) };
    const bytes = await generateIdCardPdf(previewSnapshot);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="schoolbase-id-card-proof-${quote.id}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Length', bytes.byteLength);
    return res.send(Buffer.from(bytes));
  } catch (error) {
    console.error('[id-card-studio] Failed to render quote proof', {
      quoteId: quote.id,
      message: error instanceof Error ? error.message : 'Unknown proof rendering error.',
    });
    return res.status(500).json({ error: 'Unable to render the card proof. Please review the order again.' });
  }
});

router.post('/orders', requireSubscription, async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  const quoteId = String(req.body?.quoteId || '');
  if (!quoteId) return res.status(400).json({ error: 'Quote is required.' });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const quote = await tx.idCardQuote.findFirst({ where: { id: quoteId, schoolId: user.schoolId } });
      if (!quote || quote.status !== 'QUOTED' || quote.expiresAt <= new Date()) throw new Error('This quote has expired. Create a new quote.');
      const quoteOptions = JSON.parse(quote.optionsJson) as { awardId?: string | null };
      const awardId = typeof quoteOptions.awardId === 'string' ? quoteOptions.awardId : null;
      const requestedAwardId = typeof req.body?.awardId === 'string' && req.body.awardId.trim() ? req.body.awardId.trim() : null;
      if (requestedAwardId !== awardId) throw new Error('The selected free-card award does not match this quote. Review the quote again before continuing.');
      if (!awardId && quote.totalMinor === 0) throw new Error('A zero-value cash order must use an approved card usage award.');
      const order = await tx.idCardOrder.create({
        data: {
          schoolId: user.schoolId,
          quoteId: quote.id,
          currency: quote.currency,
          amountMinor: quote.totalMinor,
          renderSnapshotEncrypted: quote.renderSnapshotEncrypted,
          ...(awardId ? { status: 'PAID', paymentStatus: 'PAID' } : {}),
        },
      });
      if (awardId) {
        const award = await tx.idCardUsageAward.findFirst({ where: { id: awardId, schoolId: user.schoolId, status: 'APPROVED', awardType: { in: ['UNITS', 'FULL_ORDER'] }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
        if (!award) throw new Error('The selected award is no longer available. Create a new quote.');
        const eligibleTiers: unknown = JSON.parse(award.eligibleTiersJson);
        if (!Array.isArray(eligibleTiers) || !eligibleTiers.includes(quote.templateTier)) throw new Error('The selected award does not cover this template tier.');
        const availableUnits = award.unitsGranted - award.unitsReserved - award.unitsRedeemed;
        if (availableUnits < quote.quantity) throw new Error('The selected award no longer covers this complete batch.');
        const reserved = await tx.idCardUsageAward.updateMany({
          where: { id: award.id, schoolId: user.schoolId, status: 'APPROVED', unitsReserved: award.unitsReserved, unitsRedeemed: award.unitsRedeemed, unitsGranted: { gte: award.unitsRedeemed + award.unitsReserved + quote.quantity }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          data: { unitsReserved: { increment: quote.quantity } },
        });
        if (reserved.count !== 1) throw new Error('The selected award was used by another order. Create a new quote.');
        await tx.idCardAwardLedger.create({ data: { awardId: award.id, orderId: order.id, entryType: 'UNITS_RESERVED', units: quote.quantity, actorId: user.userId, reason: 'Reserved for ID-card order' } });
        await addOrderEvent(tx, order.id, 'AWARD_RESERVED', user.userId, { awardId: award.id, units: quote.quantity });
      }
      await tx.idCardQuote.update({ where: { id: quote.id }, data: { status: 'ORDERED' } });
      await addOrderEvent(tx, order.id, 'ORDER_CREATED', user.userId, { quantity: quote.quantity, amountMinor: quote.totalMinor, currency: quote.currency });
      return { order, awardFunded: Boolean(awardId) };
    });
    let order = result.order;
    if (result.awardFunded) {
      try {
        order = await verifyAndGenerate(result.order.id, user.schoolId, user.userId);
      } catch {
        order = await prisma.idCardOrder.findFirstOrThrow({ where: { id: result.order.id, schoolId: user.schoolId } });
      }
    }
    res.status(201).json({ order: { id: order.id, status: order.status, paymentStatus: order.paymentStatus, amountMinor: order.amountMinor, currency: order.currency, awardFunded: result.awardFunded } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create order.';
    res.status(400).json({ error: message });
  }
});

router.post('/orders/:orderId/pay', requireSubscription, async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).json({ error: 'Card-order payments are not configured.' });

  const order = await prisma.idCardOrder.findFirst({ where: { id: req.params.orderId, schoolId: user.schoolId }, include: { quote: true } });
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.paymentStatus === 'PAID') return res.status(409).json({ error: 'This order has already been paid.' });
  if (order.providerReference) return res.status(409).json({ error: 'Checkout was already initialized for this order. Refresh order status or use the existing checkout session.' });
  const school = await prisma.school.findUnique({ where: { id: user.schoolId }, select: { email: true } });
  const payerEmail = resolveIdCardPayerEmail(user.email, school?.email);
  if (!payerEmail) return res.status(400).json({ error: 'Add a valid email address to the school administrator account or school contact settings before starting payment.' });

  const reference = `IDCARD-${randomUUID()}`;
  const reserved = await prisma.idCardOrder.updateMany({
    where: { id: order.id, schoolId: user.schoolId, providerReference: null, paymentStatus: 'PENDING' },
    data: { providerReference: reference },
  });
  if (reserved.count !== 1) return res.status(409).json({ error: 'Payment is already being initialized.' });

  try {
    const publicAppOrigin = getPublicAppOrigin();
    if (!publicAppOrigin) throw new Error('The public app URL is not configured for payment callbacks.');
    const response = await axios.post(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
      email: payerEmail,
      amount: order.amountMinor,
      reference,
      currency: order.currency,
      callback_url: new URL(`/admin/id-cards/orders/${encodeURIComponent(order.id)}`, `${publicAppOrigin}/`).toString(),
      metadata: { orderType: 'ID_CARD', orderId: order.id, schoolId: order.schoolId },
    }, { headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } });
    await prisma.idCardOrderEvent.create({ data: { orderId: order.id, eventType: 'CHECKOUT_INITIALIZED', actorId: user.userId, details: JSON.stringify({ provider: 'PAYSTACK' }) } });
    return res.json({ authorizationUrl: response.data?.data?.authorization_url, accessCode: response.data?.data?.access_code, reference });
  } catch (error) {
    await prisma.idCardOrder.updateMany({ where: { id: order.id, providerReference: reference }, data: { providerReference: null } });
    const providerFailure = axios.isAxiosError(error)
      ? { status: error.response?.status, message: error.response?.data?.message }
      : { message: error instanceof Error ? error.message : 'Unknown payment initialization error.' };
    console.error('[id-card-studio] Payment initialization failed', providerFailure);
    if (axios.isAxiosError(error) && error.response?.status === 400 && /email/i.test(String(error.response.data?.message || ''))) {
      return res.status(400).json({ error: 'Paystack rejected the payer email. Add a valid email to the school administrator account or school contact settings, then retry checkout.' });
    }
    return res.status(502).json({ error: 'Unable to initialize payment. Please retry.' });
  }
});

router.get('/orders/:orderId', async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  const order = await prisma.idCardOrder.findFirst({
    where: { id: req.params.orderId, schoolId: user.schoolId },
    include: {
      school: { select: { name: true } },
      quote: { select: { quantity: true, templateId: true, templateTier: true, expiresAt: true, pricingRuleVersion: true } },
    },
  });
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json({
    order: {
      id: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      amountMinor: order.amountMinor,
      currency: order.currency,
      createdAt: order.createdAt,
      quantity: order.quote.quantity,
      templateId: order.quote.templateId,
      templateTier: order.quote.templateTier,
      pricingRuleVersion: order.quote.pricingRuleVersion,
      schoolName: order.school.name,
      providerReference: order.providerReference,
      providerTransactionId: order.providerTransactionId,
      canRetryPayment: order.paymentStatus === 'PENDING' && !order.providerReference,
    },
  });
});

router.get('/orders/:orderId/issuances', async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  const order = await prisma.idCardOrder.findFirst({
    where: { id: req.params.orderId, schoolId: user.schoolId },
    select: { id: true, status: true, paymentStatus: true },
  });
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'READY' || order.paymentStatus !== 'PAID') return res.status(403).json({ error: 'Issuance records are available after payment and generation.' });

  const issuances = await prisma.idCardIssuance.findMany({
    where: { orderId: order.id, schoolId: user.schoolId },
    include: {
      pupil: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, class: { select: { name: true, arm: true } } } },
      replacements: { select: { id: true, status: true, orderId: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ issuances: issuances.map((issuance) => ({
    id: issuance.id,
    pupilId: issuance.pupilId,
    pupilName: [issuance.pupil.firstName, issuance.pupil.middleName, issuance.pupil.lastName].filter(Boolean).join(' '),
    admissionNo: issuance.pupil.admissionNo,
    className: [issuance.pupil.class?.name, issuance.pupil.class?.arm].filter(Boolean).join(' ') || null,
    status: issuance.status,
    issuedAt: issuance.issuedAt,
    expiresAt: issuance.expiresAt,
    supersedesId: issuance.supersedesId,
    reason: issuance.reason,
    replacement: issuance.replacements[0] || null,
  })) });
});

router.post('/issuances/:issuanceId/actions', async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  const action = String(req.body?.action || '').toUpperCase();
  const reason = String(req.body?.reason || '').trim();
  const replacementOrderId = typeof req.body?.replacementOrderId === 'string' ? req.body.replacementOrderId : null;
  if (!['ISSUE', 'REPLACE', 'REVOKE'].includes(action)) return res.status(400).json({ error: 'Choose issue, replace, or revoke.' });
  if (reason.length < 8) return res.status(400).json({ error: 'Provide a reason of at least 8 characters.' });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const issuance = await tx.idCardIssuance.findFirst({
        where: { id: req.params.issuanceId, schoolId: user.schoolId },
        include: { order: { select: { id: true, status: true, paymentStatus: true } } },
      });
      if (!issuance) throw Object.assign(new Error('Issuance record not found.'), { statusCode: 404 });
      if (issuance.order.status !== 'READY' || issuance.order.paymentStatus !== 'PAID') throw Object.assign(new Error('Issuance actions require a paid, ready order.'), { statusCode: 403 });

      if (action === 'ISSUE') {
        if (issuance.status !== 'GENERATED') throw Object.assign(new Error('Only a generated card can be marked issued.'), { statusCode: 409 });
        const updated = await tx.idCardIssuance.update({ where: { id: issuance.id }, data: { status: 'ISSUED', issuedAt: new Date(), createdBy: user.userId } });
        await addOrderEvent(tx, issuance.orderId, 'CARD_ISSUED', user.userId, { issuanceId: issuance.id, pupilId: issuance.pupilId, reason });
        return updated;
      }

      if (action === 'REVOKE') {
        if (!['GENERATED', 'ISSUED'].includes(issuance.status)) throw Object.assign(new Error('Only a generated or issued card can be revoked.'), { statusCode: 409 });
        const updated = await tx.idCardIssuance.update({ where: { id: issuance.id }, data: { status: 'REVOKED', reason } });
        await addOrderEvent(tx, issuance.orderId, 'CARD_REVOKED', user.userId, { issuanceId: issuance.id, pupilId: issuance.pupilId, reason });
        return updated;
      }

      if (!['GENERATED', 'ISSUED'].includes(issuance.status)) throw Object.assign(new Error('Only a current generated or issued card can be replaced.'), { statusCode: 409 });
      if (!replacementOrderId) throw Object.assign(new Error('Select the paid order containing the replacement card first.'), { statusCode: 400 });
      const replacement = await tx.idCardIssuance.findFirst({
        where: {
          schoolId: user.schoolId,
          pupilId: issuance.pupilId,
          orderId: replacementOrderId,
          status: 'GENERATED',
          order: { status: 'READY', paymentStatus: 'PAID' },
        },
      });
      if (!replacement) throw Object.assign(new Error('Generate and pay for the replacement card before superseding this one.'), { statusCode: 409 });
      const linkedReplacement = await tx.idCardIssuance.update({ where: { id: replacement.id }, data: { supersedesId: issuance.id, reason } });
      const superseded = await tx.idCardIssuance.update({ where: { id: issuance.id }, data: { status: 'SUPERSEDED', reason } });
      await addOrderEvent(tx, issuance.orderId, 'CARD_SUPERSEDED', user.userId, { issuanceId: issuance.id, replacementIssuanceId: linkedReplacement.id, pupilId: issuance.pupilId, reason });
      await addOrderEvent(tx, replacement.orderId, 'CARD_REPLACEMENT_LINKED', user.userId, { issuanceId: linkedReplacement.id, supersedesId: issuance.id, pupilId: issuance.pupilId, reason });
      return superseded;
    });
    return res.json({ issuance: { id: result.id, status: result.status, issuedAt: result.issuedAt, supersedesId: result.supersedesId, reason: result.reason } });
  } catch (error) {
    const status = Number((error as { statusCode?: number })?.statusCode) || 400;
    return res.status(status).json({ error: error instanceof Error ? error.message : 'Unable to update the card issuance.' });
  }
});

export async function verifyAndGenerate(orderId: string, schoolId: string, actorId: string | null) {
  const order = await prisma.idCardOrder.findFirst({ where: { id: orderId, schoolId }, include: { quote: true } });
  if (!order) throw Object.assign(new Error('Order not found.'), { statusCode: 404 });
  if (order.paymentStatus === 'PAID' && order.status === 'READY') return order;
  if (order.paymentStatus !== 'PAID') {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret || !order.providerReference) throw Object.assign(new Error('Payment is not available for this order.'), { statusCode: 400 });
    const response = await axios.get(`${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(order.providerReference)}`, { headers: { Authorization: `Bearer ${secret}` } });
    const transaction = response.data?.data;
    const metadata = transaction?.metadata || {};
    if (transaction?.status !== 'success' || Number(transaction.amount) !== order.amountMinor || String(transaction.currency).toUpperCase() !== order.currency.toUpperCase() || transaction.reference !== order.providerReference || metadata.orderId !== order.id || metadata.schoolId !== schoolId || metadata.orderType !== 'ID_CARD') {
      throw Object.assign(new Error('Payment could not be verified for this order.'), { statusCode: 400 });
    }
    await prisma.$transaction(async (tx) => {
      const updated = await tx.idCardOrder.updateMany({ where: { id: order.id, paymentStatus: 'PENDING' }, data: { paymentStatus: 'PAID', status: 'PAID', providerTransactionId: String(transaction.id) } });
      if (updated.count === 1) await addOrderEvent(tx, order.id, 'PAYMENT_CONFIRMED', actorId, { currency: order.currency, amountMinor: order.amountMinor });
    });
  }

  const paidOrder = await prisma.idCardOrder.findFirst({ where: { id: order.id, schoolId }, include: { quote: true } });
  if (!paidOrder || paidOrder.paymentStatus !== 'PAID') throw Object.assign(new Error('Payment is not confirmed.'), { statusCode: 409 });
  const claimed = await prisma.idCardOrder.updateMany({ where: { id: paidOrder.id, status: { in: ['PAID', 'GENERATION_FAILED'] } }, data: { status: 'GENERATING' } });
  if (claimed.count === 0) return prisma.idCardOrder.findUniqueOrThrow({ where: { id: paidOrder.id } });

  await prisma.idCardOrderEvent.create({ data: { orderId: paidOrder.id, eventType: 'GENERATION_STARTED', actorId } });
  try {
    if (!paidOrder.renderSnapshotEncrypted) throw new Error('The approved render snapshot is unavailable.');
    const snapshot = decryptIdCardSnapshot<IdCardRenderSnapshot>(paidOrder.renderSnapshotEncrypted);
    const bytes = await generateIdCardPdf(snapshot);
    const artifactPath = await savePrivateIdCardArtifact(paidOrder.id, bytes);
    const studentIds = JSON.parse(paidOrder.quote.studentIdsJson) as string[];
    const quoteOptions = JSON.parse(paidOrder.quote.optionsJson) as { awardId?: string | null };
    const awardId = quoteOptions.awardId;
    const ready = await prisma.$transaction(async (tx) => {
      const updatedOrder = await tx.idCardOrder.update({ where: { id: paidOrder.id }, data: { status: 'READY', artifactKey: path.basename(artifactPath) } });
      await tx.idCardIssuance.createMany({
        data: studentIds.map((pupilId) => ({ schoolId, pupilId, orderId: paidOrder.id, status: 'GENERATED', createdBy: actorId })),
        skipDuplicates: true,
      });
      if (awardId) {
        const redeemed = await tx.idCardUsageAward.updateMany({
          where: { id: awardId, schoolId, unitsReserved: { gte: paidOrder.quote.quantity } },
          data: { unitsReserved: { decrement: paidOrder.quote.quantity }, unitsRedeemed: { increment: paidOrder.quote.quantity } },
        });
        if (redeemed.count !== 1) throw new Error('Reserved card-award units could not be finalized.');
        await tx.idCardAwardLedger.create({ data: { awardId, orderId: paidOrder.id, entryType: 'UNITS_REDEEMED', units: paidOrder.quote.quantity, actorId, reason: 'PDF generation completed' } });
        await addOrderEvent(tx, paidOrder.id, 'AWARD_REDEEMED', actorId, { awardId, units: paidOrder.quote.quantity });
      }
      await addOrderEvent(tx, paidOrder.id, 'GENERATION_COMPLETED', actorId, { cardCount: snapshot.students.length, issuanceRecords: studentIds.length });
      return updatedOrder;
    });
    return ready;
  } catch (error) {
    await prisma.idCardOrder.update({ where: { id: paidOrder.id }, data: { status: 'GENERATION_FAILED' } });
    await prisma.idCardOrderEvent.create({ data: { orderId: paidOrder.id, eventType: 'GENERATION_FAILED', actorId, details: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown generation failure' }) } });
    throw Object.assign(new Error('Payment is confirmed, but card generation failed. Use retry generation; you will not be charged again.'), { statusCode: 500 });
  }
}

router.post('/orders/:orderId/verify', async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  try {
    const order = await verifyAndGenerate(req.params.orderId, user.schoolId, user.userId);
    res.json({ order: { id: order.id, status: order.status, paymentStatus: order.paymentStatus, amountMinor: order.amountMinor, currency: order.currency } });
  } catch (error) {
    const status = Number((error as any)?.statusCode) || 500;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Unable to verify order.' });
  }
});

router.post('/orders/:orderId/retry-generation', async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  try {
    const order = await verifyAndGenerate(req.params.orderId, user.schoolId, user.userId);
    res.json({ order: { id: order.id, status: order.status, paymentStatus: order.paymentStatus } });
  } catch (error) {
    const status = Number((error as any)?.statusCode) || 500;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Unable to retry generation.' });
  }
});

router.get('/orders', async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  const orders = await prisma.idCardOrder.findMany({
    where: { schoolId: user.schoolId },
    include: { quote: { select: { quantity: true, templateId: true, templateTier: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ orders: orders.map((order) => ({ id: order.id, status: order.status, paymentStatus: order.paymentStatus, currency: order.currency, amountMinor: order.amountMinor, createdAt: order.createdAt, quantity: order.quote.quantity, templateId: order.quote.templateId, templateTier: order.quote.templateTier })) });
});

router.get('/orders/:orderId/download', async (req: Request, res: Response) => {
  const user = authenticatedUser(req)!;
  const format = String(req.query.format || 'CR80').toUpperCase();
  if (format !== 'CR80' && format !== 'A4') return res.status(400).json({ error: 'Choose CR80 or A4 output.' });
  const order = await prisma.idCardOrder.findFirst({ where: { id: req.params.orderId, schoolId: user.schoolId } });
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'READY' || order.paymentStatus !== 'PAID' || !order.artifactKey) return res.status(403).json({ error: 'Production cards are available only after verified payment and successful generation.' });

  try {
    if (!order.renderSnapshotEncrypted) return res.status(404).json({ error: 'Card render snapshot is unavailable. Contact support.' });
    const snapshot = decryptIdCardSnapshot<IdCardRenderSnapshot>(order.renderSnapshotEncrypted);
    const bytes = format === 'A4'
      ? await generateIdCardA4SheetPdf(snapshot)
      : await generateIdCardPdf(snapshot);
    await prisma.idCardOrderEvent.create({ data: { orderId: order.id, eventType: 'DOWNLOAD', actorId: user.userId, details: JSON.stringify({ format }) } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="schoolbase-id-cards-${order.id}-${format.toLowerCase()}.pdf"`);
    res.setHeader('Content-Length', bytes.byteLength);
    res.send(Buffer.from(bytes));
  } catch {
    res.status(404).json({ error: 'Card file is no longer available. Contact support.' });
  }
});

export default router;
