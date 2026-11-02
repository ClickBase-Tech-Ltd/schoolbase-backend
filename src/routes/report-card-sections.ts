import { Router, type RequestHandler, type Response } from 'express';
import { BehaviourRating, PrismaClient } from '@prisma/client';
import { verifyAuth, type AuthenticatedRequest } from '../middleware/roleAuth.js';
import {
  isReportCardRating,
  normalizeReportCardSectionsConfig,
  readReportCardSectionsConfig,
} from '../services/report-card-sections.js';

const router = Router();
const prisma = new PrismaClient();

function asyncRoute(
  handler: (req: AuthenticatedRequest, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req as AuthenticatedRequest, res).catch((error: unknown) => {
      console.error('Report-card sections request failed', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to process report-card sections request' });
        return;
      }
      next(error);
    });
  };
}

function schoolIdFor(req: AuthenticatedRequest, res: Response): string | null {
  const schoolId = req.user?.schoolId;
  if (!schoolId) res.status(403).json({ error: 'School access is required' });
  return schoolId ?? null;
}

function requireAdmin(req: AuthenticatedRequest, res: Response): boolean {
  if (req.user?.role !== 'SCHOOL_ADMIN') {
    res.status(403).json({ error: 'School administrator access is required' });
    return false;
  }
  return true;
}

async function findSchoolTerm(termId: string, schoolId: string) {
  return prisma.term.findFirst({
    where: { id: termId, academicYear: { schoolId } },
    include: { academicYear: { select: { name: true, schoolId: true } } },
  });
}

async function canManageClass(req: AuthenticatedRequest, classId: string, schoolId: string) {
  if (req.user?.role === 'SCHOOL_ADMIN') return true;
  if (req.user?.role !== 'TEACHER' || !req.user.userId) return false;
  const assignment = await prisma.teacherClass.findFirst({
    where: { teacherId: req.user.userId, classId, schoolId },
    select: { id: true },
  });
  return Boolean(assignment);
}

router.use(verifyAuth);

router.get('/settings', asyncRoute(async (req, res) => {
  const schoolId = schoolIdFor(req, res);
  if (!schoolId || !requireAdmin(req, res)) return;
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: { reportCardSectionDefaults: true },
  });
  if (!school) return res.status(404).json({ error: 'School not found' });
  try {
    return res.json({ config: readReportCardSectionsConfig(school.reportCardSectionDefaults) });
  } catch (error) {
    console.error('Invalid saved report-card section defaults', error);
    return res.status(500).json({ error: 'Saved report-card section settings are invalid' });
  }
}));

router.put('/settings', asyncRoute(async (req, res) => {
  const schoolId = schoolIdFor(req, res);
  if (!schoolId || !requireAdmin(req, res)) return;
  let config;
  try {
    config = normalizeReportCardSectionsConfig(req.body?.config);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid report-card settings' });
  }
  try {
    await prisma.school.update({
      where: { id: schoolId },
      data: { reportCardSectionDefaults: JSON.stringify(config) },
    });
    return res.json({ config });
  } catch (error) {
    console.error('Failed to save report-card section defaults', error);
    return res.status(500).json({ error: 'Failed to save report-card section defaults' });
  }
}));

router.get('/terms/:termId', asyncRoute(async (req, res) => {
  const schoolId = schoolIdFor(req, res);
  if (!schoolId) return;
  if (req.user?.role !== 'SCHOOL_ADMIN' && req.user?.role !== 'TEACHER') {
    return res.status(403).json({ error: 'Staff access is required' });
  }
  const term = await findSchoolTerm(req.params.termId, schoolId);
  if (!term) return res.status(404).json({ error: 'Term not found' });
  if (req.user?.role === 'TEACHER') {
    const assignment = await prisma.teacherClass.findFirst({
      where: { teacherId: req.user.userId, schoolId },
      select: { id: true },
    });
    if (!assignment) return res.status(403).json({ error: 'No class assignment is available' });
  }
  const [config, defaults] = await Promise.all([
    prisma.termReportCardConfig.findUnique({ where: { termId: term.id } }),
    prisma.school.findUnique({ where: { id: schoolId }, select: { reportCardSectionDefaults: true } }),
  ]);
  try {
    return res.json({
      term: { id: term.id, name: term.name, academicYear: term.academicYear.name },
      config: config
        ? readReportCardSectionsConfig(config.configData)
        : readReportCardSectionsConfig(defaults?.reportCardSectionDefaults),
      publishedAt: config?.publishedAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error('Invalid saved report-card term configuration', error);
    return res.status(500).json({ error: 'Saved report-card section settings are invalid' });
  }
}));

router.put('/terms/:termId', asyncRoute(async (req, res) => {
  const schoolId = schoolIdFor(req, res);
  if (!schoolId || !requireAdmin(req, res)) return;
  const term = await findSchoolTerm(req.params.termId, schoolId);
  if (!term) return res.status(404).json({ error: 'Term not found' });
  const current = await prisma.termReportCardConfig.findUnique({ where: { termId: term.id } });
  if (current?.publishedAt) return res.status(409).json({ error: 'Published term sections cannot be changed' });
  let config;
  try {
    config = normalizeReportCardSectionsConfig(req.body?.config);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid term configuration' });
  }
  if (current) {
    const [behaviourCount, psychomotorCount] = await Promise.all([
      prisma.behaviourAssessment.count({ where: { termId: term.id } }),
      prisma.psychomotorAssessment.count({ where: { termId: term.id } }),
    ]);
    const indicatorsChanged =
      JSON.stringify(config.affectiveIndicators) !== JSON.stringify(readReportCardSectionsConfig(current.configData).affectiveIndicators)
      || JSON.stringify(config.psychomotorIndicators) !== JSON.stringify(readReportCardSectionsConfig(current.configData).psychomotorIndicators);
    if ((behaviourCount > 0 || psychomotorCount > 0) && indicatorsChanged) {
      return res.status(409).json({ error: 'Indicator names cannot change after ratings have been entered for this term' });
    }
  }
  try {
    const saved = await prisma.termReportCardConfig.upsert({
      where: { termId: term.id },
      create: { schoolId, termId: term.id, configData: JSON.stringify(config), updatedBy: req.user?.userId },
      update: { configData: JSON.stringify(config), updatedBy: req.user?.userId },
    });
    return res.json({ config, publishedAt: saved.publishedAt?.toISOString() ?? null });
  } catch (error) {
    console.error('Failed to save term report-card sections', error);
    return res.status(500).json({ error: 'Failed to save term report-card sections' });
  }
}));

router.post('/terms/:termId/publish', asyncRoute(async (req, res) => {
  const schoolId = schoolIdFor(req, res);
  if (!schoolId || !requireAdmin(req, res)) return;
  const term = await findSchoolTerm(req.params.termId, schoolId);
  if (!term) return res.status(404).json({ error: 'Term not found' });
  const existing = await prisma.termReportCardConfig.findUnique({ where: { termId: term.id } });
  if (!existing) return res.status(409).json({ error: 'Save the term configuration before publishing' });
  const published = await prisma.termReportCardConfig.update({
    where: { termId: term.id },
    data: { publishedAt: new Date(), publishedBy: req.user?.userId, updatedBy: req.user?.userId },
  });
  return res.json({ publishedAt: published.publishedAt?.toISOString() ?? null });
}));

router.post('/terms/:termId/reopen', asyncRoute(async (req, res) => {
  const schoolId = schoolIdFor(req, res);
  if (!schoolId || !requireAdmin(req, res)) return;
  const term = await findSchoolTerm(req.params.termId, schoolId);
  if (!term) return res.status(404).json({ error: 'Term not found' });
  const existing = await prisma.termReportCardConfig.findFirst({
    where: { termId: term.id, schoolId, publishedAt: { not: null } },
  });
  if (!existing) return res.status(409).json({ error: 'Term sections are not published' });
  try {
    const reopenedAt = new Date();
    await prisma.termReportCardConfig.update({
      where: { termId: term.id },
      data: {
        publishedAt: null,
        publishedBy: null,
        reopenedAt,
        reopenedBy: req.user?.userId,
        updatedBy: req.user?.userId,
      },
    });
    return res.json({ publishedAt: null, reopenedAt: reopenedAt.toISOString() });
  } catch (error) {
    console.error('Failed to reopen term report-card sections', error);
    return res.status(500).json({ error: 'Failed to reopen term report-card sections' });
  }
}));

router.get('/terms/:termId/classes/:classId/entries', asyncRoute(async (req, res) => {
  const schoolId = schoolIdFor(req, res);
  if (!schoolId) return;
  const term = await findSchoolTerm(req.params.termId, schoolId);
  const klass = await prisma.class.findFirst({
    where: { id: req.params.classId, schoolId },
    select: { id: true, name: true },
  });
  if (!term || !klass) return res.status(404).json({ error: 'Term or class not found' });
  if (!(await canManageClass(req, klass.id, schoolId))) {
    return res.status(403).json({ error: 'You are not assigned to this class' });
  }
  const [configRecord, school] = await Promise.all([
    prisma.termReportCardConfig.findUnique({ where: { termId: term.id } }),
    prisma.school.findUnique({ where: { id: schoolId }, select: { reportCardSectionDefaults: true } }),
  ]);
  let config;
  try {
    config = readReportCardSectionsConfig(
      configRecord?.configData ?? school?.reportCardSectionDefaults,
    );
    if (!configRecord && req.user?.role === 'SCHOOL_ADMIN') {
      await prisma.termReportCardConfig.upsert({
        where: { termId: term.id },
        create: { schoolId, termId: term.id, configData: JSON.stringify(config), updatedBy: req.user?.userId },
        update: {},
      });
    }
  } catch (error) {
    console.error('Invalid saved report-card section configuration', error);
    return res.status(500).json({ error: 'Saved report-card section settings are invalid' });
  }
  const pupils = await prisma.pupil.findMany({
    where: { schoolId, classId: klass.id, isActive: true, OR: [{ status: null }, { status: { not: 'INACTIVE' } }] },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: { id: true, firstName: true, lastName: true, admissionNo: true },
  });
  const pupilIds = pupils.map((pupil) => pupil.id);
  const [behaviours, psychomotor, comments] = await Promise.all([
    prisma.behaviourAssessment.findMany({ where: { termId: term.id, classId: klass.id, pupilId: { in: pupilIds } } }),
    prisma.psychomotorAssessment.findMany({ where: { termId: term.id, classId: klass.id, pupilId: { in: pupilIds } } }),
    prisma.termReportCardComment.findMany({ where: { termId: term.id, classId: klass.id, pupilId: { in: pupilIds } } }),
  ]);
  const parseRatings = (raw: string) => {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, string | null>;
  };
  let behaviourMap: Map<string, { values: Record<string, string | null> }>;
  let psychomotorMap: Map<string, { values: Record<string, string | null> }>;
  try {
    behaviourMap = new Map(behaviours.map((row) => [row.pupilId, { values: parseRatings(row.behaviours) }]));
    psychomotorMap = new Map(psychomotor.map((row) => [row.pupilId, { values: parseRatings(row.skills) }]));
  } catch (error) {
    console.error('Invalid saved report-card ratings', error);
    return res.status(500).json({ error: 'Saved report-card ratings could not be read' });
  }
  const commentsMap = new Map(comments.map((row) => [row.pupilId, row]));
  return res.json({
    term: { id: term.id, name: term.name },
    class: klass,
    config,
    publishedAt: configRecord?.publishedAt?.toISOString() ?? null,
    pupils: pupils.map((pupil) => ({
      ...pupil,
      affective: behaviourMap.get(pupil.id)?.values ?? {},
      psychomotor: psychomotorMap.get(pupil.id)?.values ?? {},
      teacherRemark: commentsMap.get(pupil.id)?.teacherRemark ?? '',
      principalRemark: req.user?.role === 'SCHOOL_ADMIN' ? commentsMap.get(pupil.id)?.principalRemark ?? '' : '',
    })),
  });
}));

router.put('/terms/:termId/classes/:classId/entries', asyncRoute(async (req, res) => {
  const schoolId = schoolIdFor(req, res);
  if (!schoolId) return;
  const term = await findSchoolTerm(req.params.termId, schoolId);
  const klass = await prisma.class.findFirst({
    where: { id: req.params.classId, schoolId },
    select: { id: true },
  });
  if (!term || !klass) return res.status(404).json({ error: 'Term or class not found' });
  if (!(await canManageClass(req, klass.id, schoolId))) {
    return res.status(403).json({ error: 'You are not assigned to this class' });
  }
  const configRecord = await prisma.termReportCardConfig.findUnique({ where: { termId: term.id } });
  if (configRecord?.publishedAt) return res.status(409).json({ error: 'Published term sections are locked' });
  const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { reportCardSectionDefaults: true } });
  let config;
  try {
    config = readReportCardSectionsConfig(configRecord?.configData ?? school?.reportCardSectionDefaults);
  } catch (error) {
    console.error('Invalid saved report-card section configuration', error);
    return res.status(500).json({ error: 'Saved report-card section settings are invalid' });
  }
  if (!configRecord) {
    await prisma.termReportCardConfig.upsert({
      where: { termId: term.id },
      create: { schoolId, termId: term.id, configData: JSON.stringify(config), updatedBy: req.user?.userId },
      update: {},
    });
  }
  const entries = req.body?.entries;
  if (!Array.isArray(entries) || entries.length > 500) {
    return res.status(400).json({ error: 'Entries must be an array of at most 500 pupils' });
  }
  const pupilIds = entries.map((entry: any) => entry?.pupilId);
  if (pupilIds.some((id: unknown) => typeof id !== 'string') || new Set(pupilIds).size !== pupilIds.length) {
    return res.status(400).json({ error: 'Each pupil must appear once with a valid pupilId' });
  }
  const pupils = await prisma.pupil.findMany({
    where: { id: { in: pupilIds }, schoolId, classId: klass.id, isActive: true },
    select: { id: true },
  });
  if (pupils.length !== pupilIds.length) {
    return res.status(400).json({ error: 'One or more pupils do not belong to this class and school' });
  }
  for (const entry of entries) {
    if (config.affectiveEnabled && entry.affective !== undefined) {
      if (!entry.affective || typeof entry.affective !== 'object' || Array.isArray(entry.affective)) {
        return res.status(400).json({ error: 'Affective ratings must be an indicator-to-rating object' });
      }
      const submittedKeys = Object.keys(entry.affective);
      if (submittedKeys.some((key) => !config.affectiveIndicators.includes(key))) {
        return res.status(400).json({ error: 'Affective ratings include an unconfigured indicator' });
      }
      if (Object.values(entry.affective).some((rating) => rating !== null && !isReportCardRating(rating))) {
        return res.status(400).json({ error: 'Affective ratings contain an invalid rating' });
      }
    }
    if (config.psychomotorEnabled && entry.psychomotor !== undefined) {
      if (!entry.psychomotor || typeof entry.psychomotor !== 'object' || Array.isArray(entry.psychomotor)) {
        return res.status(400).json({ error: 'Psychomotor ratings must be an indicator-to-rating object' });
      }
      const submittedKeys = Object.keys(entry.psychomotor);
      if (submittedKeys.some((key) => !config.psychomotorIndicators.includes(key))) {
        return res.status(400).json({ error: 'Psychomotor ratings include an unconfigured indicator' });
      }
      if (Object.values(entry.psychomotor).some((rating) => rating !== null && !isReportCardRating(rating))) {
        return res.status(400).json({ error: 'Psychomotor ratings contain an invalid rating' });
      }
    }
    if (entry.teacherRemark !== undefined && (typeof entry.teacherRemark !== 'string' || entry.teacherRemark.length > 2000)) {
      return res.status(400).json({ error: 'Teacher comments must be text of at most 2000 characters' });
    }
    if (entry.principalRemark !== undefined && (typeof entry.principalRemark !== 'string' || entry.principalRemark.length > 2000)) {
      return res.status(400).json({ error: 'Principal comments must be text of at most 2000 characters' });
    }
    if (req.user?.role === 'TEACHER' && entry.principalRemark !== undefined) {
      return res.status(403).json({ error: 'Only school administrators can edit principal comments' });
    }
  }

  const ratingOrder = ['NEEDS_IMPROVEMENT', 'SATISFACTORY', 'GOOD', 'VERY_GOOD', 'EXCELLENT'];
  const toOverallRating = (values: Record<string, unknown>) => {
    const indexes = Object.values(values)
      .filter(isReportCardRating)
      .map((rating) => ratingOrder.indexOf(rating));
    return indexes.length
      ? (ratingOrder[Math.round(indexes.reduce((sum, index) => sum + index, 0) / indexes.length)] as BehaviourRating)
      : BehaviourRating.SATISFACTORY;
  };

  try {
    await prisma.$transaction(async (tx) => {
      for (const entry of entries) {
        if (config.affectiveEnabled && entry.affective !== undefined) {
          const hasAffectiveRating = Object.values(entry.affective).some(isReportCardRating);
          if (!hasAffectiveRating) {
            await tx.behaviourAssessment.deleteMany({ where: { pupilId: entry.pupilId, termId: term.id } });
          } else {
            await tx.behaviourAssessment.upsert({
              where: { pupilId_termId: { pupilId: entry.pupilId, termId: term.id } },
              create: {
                schoolId, classId: klass.id, pupilId: entry.pupilId, termId: term.id,
                behaviours: JSON.stringify(entry.affective), overallRating: toOverallRating(entry.affective),
                ratedBy: req.user?.userId, ratedAt: new Date(),
              },
              update: {
                schoolId, classId: klass.id,
                behaviours: JSON.stringify(entry.affective), overallRating: toOverallRating(entry.affective),
                ratedBy: req.user?.userId, ratedAt: new Date(),
              },
            });
          }
        }
        if (config.psychomotorEnabled && entry.psychomotor !== undefined) {
          const hasPsychomotorRating = Object.values(entry.psychomotor).some(isReportCardRating);
          if (!hasPsychomotorRating) {
            await tx.psychomotorAssessment.deleteMany({ where: { pupilId: entry.pupilId, termId: term.id } });
          } else {
            await tx.psychomotorAssessment.upsert({
              where: { pupilId_termId: { pupilId: entry.pupilId, termId: term.id } },
              create: {
                schoolId, classId: klass.id, pupilId: entry.pupilId, termId: term.id,
                skills: JSON.stringify(entry.psychomotor), ratedBy: req.user?.userId, ratedAt: new Date(),
              },
              update: {
                schoolId, classId: klass.id,
                skills: JSON.stringify(entry.psychomotor), ratedBy: req.user?.userId, ratedAt: new Date(),
              },
            });
          }
        }
        if ((config.teacherCommentsEnabled && entry.teacherRemark !== undefined)
          || (config.principalCommentsEnabled && entry.principalRemark !== undefined)) {
          const current = await tx.termReportCardComment.findUnique({
            where: { pupilId_termId: { pupilId: entry.pupilId, termId: term.id } },
            select: { teacherRemark: true, principalRemark: true },
          });
          const teacherRemark = config.teacherCommentsEnabled && entry.teacherRemark !== undefined
            ? entry.teacherRemark.trim() || null
            : current?.teacherRemark ?? null;
          const principalRemark = config.principalCommentsEnabled && entry.principalRemark !== undefined
            ? entry.principalRemark.trim() || null
            : current?.principalRemark ?? null;
          await tx.termReportCardComment.upsert({
            where: { pupilId_termId: { pupilId: entry.pupilId, termId: term.id } },
            create: {
              schoolId, classId: klass.id, pupilId: entry.pupilId, termId: term.id,
              teacherRemark, principalRemark, updatedBy: req.user?.userId,
            },
            update: { schoolId, classId: klass.id, teacherRemark, principalRemark, updatedBy: req.user?.userId },
          });
        }
      }
    });
    return res.json({ saved: entries.length });
  } catch (error) {
    console.error('Failed to save report-card section entries', error);
    return res.status(500).json({ error: 'Failed to save report-card section entries' });
  }
}));

export default router;
