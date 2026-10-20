import { Router, type Request, type Response } from 'express';
import { PrismaClient, SchoolReviewStatus } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import { verifyAuth, type AuthenticatedRequest } from '../middleware/roleAuth.js';
import { isPubliclyEligibleSchoolReview, isTrustedSchoolBaseOrigin, redactSchoolName, schoolReviewPublicIdentity, validateSchoolReviewSubmission } from '../services/school-reviews.js';
import { getSessionSecret } from '../services/security-config.js';
import { jwtVerify } from 'jose';

const router = Router();
const prisma = new PrismaClient();
const MAX_PUBLIC_PAGE_SIZE = 12;
const MAX_MODERATION_PAGE_SIZE = 50;

async function allowMutation(bucket: string, limit: number, windowMs: number): Promise<boolean> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowMs);
  const bucketKey = createHmac('sha256', getSessionSecret()).update(`school-review:${bucket}`).digest('hex');

  return prisma.$transaction(async (tx) => {
    await tx.signupRateLimit.upsert({
      where: { bucketKey },
      create: { bucketKey, windowStartedAt: now, requestCount: 0 },
      update: {},
    });
    await tx.signupRateLimit.updateMany({
      where: { bucketKey, windowStartedAt: { lte: cutoff } },
      data: { windowStartedAt: now, requestCount: 0 },
    });
    const updated = await tx.signupRateLimit.updateMany({
      where: { bucketKey, windowStartedAt: { gt: cutoff }, requestCount: { lt: limit } },
      data: { requestCount: { increment: 1 } },
    });
    return updated.count === 1;
  });
}

function publicReviewDto(review: {
  id: string;
  rating: number;
  reviewText: string | null;
  createdAt: Date;
  status: string;
  publishConsent: boolean;
  consentRevokedAt: Date | null;
  schoolNameConsent: boolean;
  schoolLogoConsent: boolean;
  school: { name: string; logoUrl: string | null };
}) {
  if (!isPubliclyEligibleSchoolReview(review)) return null;
  const identity = schoolReviewPublicIdentity(review);
  return {
    id: review.id,
    rating: review.rating,
    reviewText: redactSchoolName(review.reviewText, review.school.name, review.schoolNameConsent),
    createdAt: review.createdAt,
    ...identity,
  };
}

async function requirePlatformAdmin(req: Request, res: Response): Promise<string | null> {
  const token = req.cookies?.schoolbase_session || req.get('x-schoolbase-session');
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, getSessionSecret());
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    if (payload.role !== 'PLATFORM_ADMIN' || !userId) {
      res.status(403).json({ error: 'Platform administrator access required.' });
      return null;
    }
    const moderator = await prisma.user.findFirst({ where: { id: userId, role: 'PLATFORM_ADMIN', isActive: true }, select: { id: true } });
    if (!moderator) {
      res.status(403).json({ error: 'Platform administrator access required.' });
      return null;
    }
    return moderator.id;
  } catch {
    res.status(401).json({ error: 'Invalid session.' });
    return null;
  }
}

router.get('/public', async (req, res) => {
  const requestedLimit = Number(req.query.limit ?? 6);
  const take = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), MAX_PUBLIC_PAGE_SIZE) : 6;
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

  try {
    const where = { status: SchoolReviewStatus.APPROVED, publishConsent: true, consentRevokedAt: null };
    const [reviews, count, ratingAggregate] = await Promise.all([
      prisma.schoolReview.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          rating: true,
          reviewText: true,
          createdAt: true,
          status: true,
          publishConsent: true,
          consentRevokedAt: true,
          schoolNameConsent: true,
          schoolLogoConsent: true,
          school: { select: { name: true, logoUrl: true } },
        },
      }),
      prisma.schoolReview.count({ where }),
      prisma.schoolReview.aggregate({ where, _avg: { rating: true } }),
    ]);
    const hasMore = reviews.length > take;
    const page = reviews.slice(0, take).map(publicReviewDto).filter((review) => review !== null);
    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.json({
      reviews: page,
      averageRating: count ? Math.round((ratingAggregate._avg.rating ?? 0) * 10) / 10 : null,
      reviewCount: count,
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
    });
  } catch (error) {
    console.error('[school-reviews] public listing failed:', error instanceof Error ? error.message : 'unknown error');
    return res.status(500).json({ error: 'Unable to load reviews.' });
  }
});

router.get('/mine', verifyAuth, async (req: Request, res: Response) => {
  const user = (req as AuthenticatedRequest).user;
  if (user?.role !== 'SCHOOL_ADMIN' || !user.userId || !user.schoolId) {
    return res.status(403).json({ error: 'School administrator access required.' });
  }

  const membership = await prisma.user.findFirst({
    where: { id: user.userId, schoolId: user.schoolId, role: 'SCHOOL_ADMIN', isActive: true },
    select: { id: true },
  });
  if (!membership) return res.status(403).json({ error: 'School administrator access required.' });

  try {
    const review = await prisma.schoolReview.findUnique({
      where: { schoolId: user.schoolId },
      select: {
        id: true,
        rating: true,
        reviewText: true,
        status: true,
        publishConsent: true,
        schoolNameConsent: true,
        schoolLogoConsent: true,
        consentRevokedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return res.json({ review });
  } catch (error) {
    console.error('[school-reviews] own review lookup failed:', error instanceof Error ? error.message : 'unknown error');
    return res.status(500).json({ error: 'Unable to load your review.' });
  }
});

router.put('/mine', verifyAuth, async (req: Request, res: Response) => {
  if (!isTrustedSchoolBaseOrigin(req.get('origin'))) return res.status(403).json({ error: 'Request origin is not allowed.' });
  const user = (req as AuthenticatedRequest).user;
  if (user?.role !== 'SCHOOL_ADMIN' || !user.userId || !user.schoolId) {
    return res.status(403).json({ error: 'School administrator access required.' });
  }
  if (!(await allowMutation(`school:${user.schoolId}`, 5, 60 * 60 * 1000))) {
    return res.status(429).json({ error: 'Please wait before submitting another review update.' });
  }

  const membership = await prisma.user.findFirst({
    where: { id: user.userId, schoolId: user.schoolId, role: 'SCHOOL_ADMIN', isActive: true },
    select: { id: true },
  });
  if (!membership) return res.status(403).json({ error: 'School administrator access required.' });

  const validation = validateSchoolReviewSubmission(req.body);
  if (!validation.valid) return res.status(400).json({ error: validation.error });
  const now = new Date();
  const { rating, reviewText, publishConsent, schoolNameConsent, schoolLogoConsent } = validation.value;

  try {
    const review = await prisma.$transaction(async (tx) => {
      const saved = await tx.schoolReview.upsert({
        where: { schoolId: user.schoolId },
        create: {
          id: randomUUID(),
          schoolId: user.schoolId,
          submittedByUserId: user.userId,
          rating,
          reviewText,
          status: SchoolReviewStatus.PENDING,
          publishConsent,
          schoolNameConsent,
          schoolLogoConsent,
          consentGrantedAt: publishConsent ? now : null,
        },
        update: {
          submittedByUserId: user.userId,
          rating,
          reviewText,
          status: SchoolReviewStatus.PENDING,
          publishConsent,
          schoolNameConsent,
          schoolLogoConsent,
          consentGrantedAt: publishConsent ? now : null,
          consentRevokedAt: publishConsent ? null : now,
          moderatedByUserId: null,
          moderatedAt: null,
          moderationNote: null,
        },
        select: {
          id: true,
          rating: true,
          reviewText: true,
          status: true,
          publishConsent: true,
          schoolNameConsent: true,
          schoolLogoConsent: true,
          consentRevokedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      await tx.platformAuditLog.create({
        data: {
          schoolId: user.schoolId,
          userId: user.userId,
          event: 'SCHOOL_REVIEW_SUBMITTED',
          category: 'SCHOOL',
          action: 'school.review.submitted',
          outcome: 'SUCCESS',
          resourceType: 'School review',
          resourceId: saved.id,
          summary: 'Submitted or updated a SchoolBase review',
          actorRole: 'SCHOOL_ADMIN',
          details: JSON.stringify({ rating, reviewTextPresent: Boolean(reviewText), publishConsent }),
        },
      });
      return saved;
    });
    return res.json({ review });
  } catch (error) {
    console.error('[school-reviews] submission failed:', error instanceof Error ? error.message : 'unknown error');
    return res.status(500).json({ error: 'Unable to save your review.' });
  }
});

router.get('/moderation', async (req, res) => {
  const moderatorId = await requirePlatformAdmin(req, res);
  if (!moderatorId) return;
  const requestedPage = Number(req.query.page ?? 1);
  const requestedLimit = Number(req.query.limit ?? 20);
  const page = Number.isInteger(requestedPage) ? Math.max(1, requestedPage) : 1;
  const take = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), MAX_MODERATION_PAGE_SIZE) : 20;
  const status = typeof req.query.status === 'string' && Object.values(SchoolReviewStatus).includes(req.query.status as SchoolReviewStatus)
    ? req.query.status as SchoolReviewStatus
    : undefined;
  const ratingValue = Number(req.query.rating);
  const rating = Number.isInteger(ratingValue) && ratingValue >= 1 && ratingValue <= 5 ? ratingValue : undefined;
  const where = { ...(status ? { status } : {}), ...(rating ? { rating } : {}) };

  try {
    const [reviews, total] = await Promise.all([
      prisma.schoolReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * take,
        take,
        select: {
          id: true,
          schoolId: true,
          rating: true,
          reviewText: true,
          status: true,
          publishConsent: true,
          schoolNameConsent: true,
          schoolLogoConsent: true,
          createdAt: true,
          updatedAt: true,
          moderatedAt: true,
          moderationNote: true,
          school: { select: { name: true, logoUrl: true } },
          submittedBy: { select: { name: true, email: true } },
          moderatedBy: { select: { name: true } },
        },
      }),
      prisma.schoolReview.count({ where }),
    ]);
    return res.json({ reviews, page, pageSize: take, total });
  } catch (error) {
    console.error('[school-reviews] moderation queue failed:', error instanceof Error ? error.message : 'unknown error');
    return res.status(500).json({ error: 'Unable to load the moderation queue.' });
  }
});

router.patch('/:reviewId/moderation', async (req, res) => {
  const moderatorId = await requirePlatformAdmin(req, res);
  if (!moderatorId) return;
  if (!isTrustedSchoolBaseOrigin(req.get('origin'))) return res.status(403).json({ error: 'Request origin is not allowed.' });
  if (!(await allowMutation(`moderator:${moderatorId}`, 60, 60 * 60 * 1000))) {
    return res.status(429).json({ error: 'Please wait before making more moderation changes.' });
  }

  const status = req.body?.status;
  if (status === SchoolReviewStatus.APPROVED && req.body?.privacyReviewed !== true) {
    return res.status(400).json({ error: 'Confirm the review contains no student, parent, fee, or academic information before approval.' });
  }
  const moderationNote = typeof req.body?.moderationNote === 'string' ? req.body.moderationNote.trim() : '';
  if (![SchoolReviewStatus.APPROVED, SchoolReviewStatus.REJECTED].includes(status)) {
    return res.status(400).json({ error: 'Choose approve or reject.' });
  }
  if (moderationNote.length > 2000) return res.status(400).json({ error: 'Moderation note must be 2,000 characters or fewer.' });

  try {
    const existing = await prisma.schoolReview.findUnique({ where: { id: req.params.reviewId }, select: { id: true, schoolId: true, publishConsent: true, consentRevokedAt: true } });
    if (!existing) return res.status(404).json({ error: 'Review not found.' });
    if (status === SchoolReviewStatus.APPROVED && (!existing.publishConsent || existing.consentRevokedAt)) {
      return res.status(409).json({ error: 'Current publication consent is required before approval.' });
    }

    const review = await prisma.$transaction(async (tx) => {
      const updated = await tx.schoolReview.update({
        where: { id: existing.id },
        data: { status, moderatedByUserId: moderatorId, moderatedAt: new Date(), moderationNote: moderationNote || null },
        select: { id: true, schoolId: true, status: true, rating: true, moderatedAt: true },
      });
      await tx.platformAuditLog.create({
        data: {
          schoolId: existing.schoolId,
          userId: moderatorId,
          event: status === SchoolReviewStatus.APPROVED ? 'SCHOOL_REVIEW_APPROVED' : 'SCHOOL_REVIEW_REJECTED',
          category: 'SCHOOL',
          action: status === SchoolReviewStatus.APPROVED ? 'school.review.approved' : 'school.review.rejected',
          outcome: 'SUCCESS',
          resourceType: 'School review',
          resourceId: existing.id,
          summary: status === SchoolReviewStatus.APPROVED ? 'Approved a SchoolBase review' : 'Rejected a SchoolBase review',
          actorRole: 'PLATFORM_ADMIN',
          details: JSON.stringify({ moderationNotePresent: Boolean(moderationNote) }),
        },
      });
      return updated;
    });
    return res.json({ review });
  } catch (error) {
    console.error('[school-reviews] moderation update failed:', error instanceof Error ? error.message : 'unknown error');
    return res.status(500).json({ error: 'Unable to update review status.' });
  }
});

export default router;