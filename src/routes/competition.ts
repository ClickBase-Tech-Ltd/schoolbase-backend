import { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { jwtVerify } from 'jose';
import { PrismaClient } from '@prisma/client';
import { getSessionSecret } from '../services/security-config.js';
import { resolveCompetitionFeature } from '../services/competition-feature-gate.js';
import { resolveCompetitionGuardianPupilChoices, resolveCompetitionGuardianSession, resolveCompetitionPupilIdentity, selectCompetitionGuardianPupil, type CompetitionPupilIdentity } from '../services/competition-pupil-identity.js';
import { calculateCompetitionAnswerPoints, parseCompetitionScoringPolicy } from '../services/competition-scoring.js';
import { parseCompetitionXpPolicy } from '../services/competition-rewards.js';
import { parseCompetitionAchievementCriteria, shouldAwardCompetitionAchievement } from '../services/competition-achievements.js';
import { buildCompetitionLeaderboard, chooseCompetitionMatchWinner } from '../services/competition-leaderboard.js';
import { canTransitionCompetitionTournament, parseCompetitionTournamentDate, type CompetitionTournamentStatus } from '../services/competition-tournaments.js';
import { isSeniorSecondaryCompetitionGrade, matchesCompetitionAudience, parseCompetitionAudience } from '../services/competition-audience.js';
import { getCompetitionDailyLimitError } from '../services/competition-daily-limit.js';
import { getCompetitionExamPracticeGrades, isCompetitionExamPracticeSubjectAllowed, isEligibleForCompetitionExamPractice, normalizeCompetitionExamPracticeGrade } from '../services/competition-exam-practice.js';
import { canApproveCompetitionQuestionSet } from '../services/competition-question-set-review.js';

const router = Router();
const prisma = new PrismaClient();

interface CompetitionRequest extends Request {
  competitionUser?: { id: string; role: string; schoolId: string | null };
  competitionGuardian?: { id: string; guardianIds: string[]; schoolId: string };
}

async function requireSession(req: CompetitionRequest, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.schoolbase_session || req.cookies?.schoolbase_staff || req.cookies?.staff_session;
    if (!token) return res.status(401).json({ error: 'AUTH_REQUIRED' });
    const { payload } = await jwtVerify(token, getSessionSecret());
    if (typeof payload.guardianId === 'string') {
      if (typeof payload.schoolId !== 'string') return res.status(401).json({ error: 'AUTH_INVALID' });
      const guardianSession = await resolveCompetitionGuardianSession(prisma, {
        guardianId: payload.guardianId,
        guardianIds: payload.guardianIds,
        schoolId: payload.schoolId,
      });
      if (!guardianSession) return res.status(401).json({ error: 'AUTH_INVALID' });
      req.competitionGuardian = guardianSession;
      return next();
    }
    if (typeof payload.userId !== 'string' || typeof payload.role !== 'string') return res.status(401).json({ error: 'AUTH_INVALID' });
    const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { id: true, role: true, schoolId: true } });
    if (!user || user.role !== payload.role) return res.status(401).json({ error: 'AUTH_INVALID' });
    req.competitionUser = user;
    next();
  } catch {
    return res.status(401).json({ error: 'AUTH_INVALID' });
  }
}

async function resolveLearnerIdentity(req: CompetitionRequest, res: Response): Promise<CompetitionPupilIdentity | null> {
  if (req.competitionUser) {
    const identity = await resolveCompetitionPupilIdentity(prisma, req.competitionUser.id);
    if (!identity) res.status(403).json({ error: 'STUDENT_IDENTITY_NOT_LINKED' });
    return identity;
  }

  const guardianSession = req.competitionGuardian;
  if (!guardianSession) {
    res.status(403).json({ error: 'STUDENT_IDENTITY_NOT_LINKED' });
    return null;
  }

  const choices = await resolveCompetitionGuardianPupilChoices(prisma, guardianSession.guardianIds);
  if (choices.length === 0 || choices.some((choice) => choice.schoolId !== guardianSession.schoolId)) {
    res.status(403).json({ error: 'STUDENT_IDENTITY_NOT_LINKED' });
    return null;
  }

  const requestedPupilId = typeof req.query.pupilId === 'string'
    ? req.query.pupilId
    : typeof req.body?.pupilId === 'string'
      ? req.body.pupilId
      : undefined;
  const choice = selectCompetitionGuardianPupil(choices, requestedPupilId);
  if (requestedPupilId) {
    if (!choice) {
      res.status(403).json({ error: 'GUARDIAN_PUPIL_NOT_LINKED' });
      return null;
    }
  }

  if (!choice && choices.length > 1) {
    res.status(409).json({
      error: 'CHILD_SELECTION_REQUIRED',
      children: choices.map(({ pupilId, firstName, lastName, className }) => ({ pupilId, firstName, lastName, className })),
    });
    return null;
  }

  if (!choice) return null;
  return { userId: '', pupilId: choice.pupilId, schoolId: choice.schoolId, classId: choice.classId };
}

async function requirePlatformAdmin(req: CompetitionRequest, res: Response, next: NextFunction) {
  if (req.competitionUser?.role !== 'PLATFORM_ADMIN') return res.status(403).json({ error: 'PLATFORM_ADMIN_REQUIRED' });
  next();
}

async function isChallengePracticeEnabled(): Promise<boolean> {
  const [dailyChallengeEnabled, examPracticeEnabled] = await Promise.all([
    resolveCompetitionFeature(prisma, 'competition.dailyChallenge.enabled'),
    resolveCompetitionFeature(prisma, 'competition.examPractice.enabled'),
  ]);
  return dailyChallengeEnabled || examPracticeEnabled;
}

async function requireSchoolStaff(req: CompetitionRequest, res: Response, next: NextFunction) {
  if (!req.competitionUser?.schoolId || !['SCHOOL_ADMIN', 'TEACHER'].includes(req.competitionUser.role)) {
    return res.status(403).json({ error: 'SCHOOL_STAFF_REQUIRED' });
  }
  next();
}

function isPrismaUniqueError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
}

function secureShuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

class AttemptLimitError extends Error {}

router.get('/admin/categories', requireSession, requirePlatformAdmin, async (_req, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.questionBank.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const categories = await prisma.competitionCategory.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, take: 250 });
  res.json({ categories });
});

router.post('/admin/categories', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.questionBank.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { code, name, description, subjectId, countryCode } = req.body ?? {};
  if (typeof code !== 'string' || !/^[A-Z0-9_-]{2,40}$/.test(code.trim().toUpperCase()) || typeof name !== 'string' || !name.trim() || name.length > 191) return res.status(400).json({ error: 'INVALID_CATEGORY' });
  if (subjectId && typeof subjectId === 'string' && !(await prisma.subject.findUnique({ where: { id: subjectId }, select: { id: true } }))) return res.status(400).json({ error: 'SUBJECT_NOT_FOUND' });
  try {
    const category = await prisma.competitionCategory.create({ data: { code: code.trim().toUpperCase(), name: name.trim(), description: typeof description === 'string' ? description.slice(0, 4000) : undefined, subjectId: typeof subjectId === 'string' ? subjectId : undefined, countryCode: typeof countryCode === 'string' ? countryCode.trim().toUpperCase().slice(0, 2) : undefined } });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'CATEGORY_CREATED', entityType: 'CompetitionCategory', entityId: category.id } });
    res.status(201).json({ category });
  } catch (error) {
    if (isPrismaUniqueError(error)) return res.status(409).json({ error: 'CATEGORY_CODE_EXISTS' });
    console.error('[competition] category creation failed', error);
    res.status(500).json({ error: 'CATEGORY_CREATE_FAILED' });
  }
});

router.get('/admin/scoring-policies', requireSession, requirePlatformAdmin, async (_req, res) => {
  if (!(await isChallengePracticeEnabled())) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const policies = await prisma.competitionScoringPolicy.findMany({ orderBy: [{ name: 'asc' }, { version: 'desc' }], take: 100 });
  res.json({ policies });
});

router.post('/admin/scoring-policies', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await isChallengePracticeEnabled())) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { name, policy } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || !policy || typeof policy !== 'object' || Array.isArray(policy) || !Number.isInteger(policy.basePoints) || policy.basePoints < 0 || policy.basePoints > 100000) return res.status(400).json({ error: 'INVALID_SCORING_POLICY' });
  try { parseCompetitionScoringPolicy(JSON.stringify(policy)); } catch { return res.status(400).json({ error: 'INVALID_SCORING_POLICY' }); }
  const version = Number.isInteger(req.body?.version) && req.body.version > 0 ? req.body.version : 1;
  try {
    const scoringPolicy = await prisma.competitionScoringPolicy.create({ data: { name: name.trim(), version, policyJson: JSON.stringify(policy), createdByUserId: req.competitionUser?.id } });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'SCORING_POLICY_CREATED', entityType: 'CompetitionScoringPolicy', entityId: scoringPolicy.id } });
    res.status(201).json({ scoringPolicy });
  } catch (error) {
    if (isPrismaUniqueError(error)) return res.status(409).json({ error: 'SCORING_POLICY_VERSION_EXISTS' });
    console.error('[competition] scoring policy creation failed', error);
    res.status(500).json({ error: 'SCORING_POLICY_CREATE_FAILED' });
  }
});

router.get('/admin/achievements', requireSession, requirePlatformAdmin, async (_req, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.gamification.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const achievements = await prisma.competitionAchievement.findMany({
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    take: 100,
    select: { id: true, code: true, title: true, description: true, criteriaJson: true, isActive: true, createdAt: true, _count: { select: { awards: true } } },
  });
  res.json({ achievements: achievements.map(({ criteriaJson, ...achievement }) => {
    let criteria: ReturnType<typeof parseCompetitionAchievementCriteria> | null = null;
    try { criteria = parseCompetitionAchievementCriteria(criteriaJson); } catch { /* Preserve visibility of malformed legacy definitions for administrators. */ }
    return { ...achievement, criteria };
  }) });
});

router.post('/admin/achievements', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.gamification.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { code, title, description, criteria } = req.body ?? {};
  if (typeof code !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code) || code.length > 80 || typeof title !== 'string' || !title.trim() || title.trim().length > 120 || typeof description !== 'string' || !description.trim() || description.trim().length > 1000) return res.status(400).json({ error: 'INVALID_ACHIEVEMENT' });
  let normalizedCriteria: ReturnType<typeof parseCompetitionAchievementCriteria>;
  try { normalizedCriteria = parseCompetitionAchievementCriteria(JSON.stringify(criteria)); } catch { return res.status(400).json({ error: 'INVALID_ACHIEVEMENT_CRITERIA' }); }
  try {
    const achievement = await prisma.competitionAchievement.create({
      data: { code, title: title.trim(), description: description.trim(), criteriaJson: JSON.stringify(normalizedCriteria), isActive: false },
      select: { id: true, code: true, title: true, description: true, criteriaJson: true, isActive: true, createdAt: true },
    });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'ACHIEVEMENT_CREATED', entityType: 'CompetitionAchievement', entityId: achievement.id, afterJson: JSON.stringify(normalizedCriteria) } });
    res.status(201).json({ achievement: { ...achievement, criteria: normalizedCriteria } });
  } catch (error) {
    if (isPrismaUniqueError(error)) return res.status(409).json({ error: 'ACHIEVEMENT_CODE_EXISTS' });
    console.error('[competition] achievement creation failed', error);
    res.status(500).json({ error: 'ACHIEVEMENT_CREATE_FAILED' });
  }
});

router.patch('/admin/achievements/:id/status', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.gamification.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  if (typeof req.body?.isActive !== 'boolean') return res.status(400).json({ error: 'INVALID_ACHIEVEMENT_STATUS' });
  try {
    const achievement = await prisma.competitionAchievement.update({ where: { id: req.params.id }, data: { isActive: req.body.isActive }, select: { id: true, code: true, isActive: true } });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: req.body.isActive ? 'ACHIEVEMENT_ACTIVATED' : 'ACHIEVEMENT_DEACTIVATED', entityType: 'CompetitionAchievement', entityId: achievement.id, afterJson: JSON.stringify({ isActive: achievement.isActive }) } });
    res.json({ achievement });
  } catch (error) {
    console.error('[competition] achievement status update failed', error);
    res.status(404).json({ error: 'ACHIEVEMENT_NOT_FOUND' });
  }
});

router.post('/admin/challenges', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await isChallengePracticeEnabled())) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { categoryId, questionSetId, scoringPolicyId, title, description, ageRange, gradeLabel, questionCount, durationSeconds, attemptLimit, difficultyMix, completionXp = 0 } = req.body ?? {};
  const ageMatch = typeof ageRange === 'string' ? ageRange.trim().match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})$/) : null;
  const minimumAge = ageMatch ? Number(ageMatch[1]) : 0;
  const maximumAge = ageMatch ? Number(ageMatch[2]) : 0;
  const classLabel = typeof gradeLabel === 'string' ? gradeLabel.trim() : '';
  const validAgeRange = !ageRange || Boolean(ageMatch && minimumAge >= 2 && maximumAge <= 25 && minimumAge <= maximumAge);
  if (![categoryId, questionSetId, scoringPolicyId].every((value) => typeof value === 'string') || typeof title !== 'string' || !title.trim() || !validAgeRange || !classLabel || classLabel.length > 60 || !Number.isInteger(questionCount) || questionCount < 1 || questionCount > 100 || !Number.isInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > 7200 || !Number.isInteger(attemptLimit) || attemptLimit < 1 || attemptLimit > 10 || !Number.isInteger(completionXp) || completionXp < 0 || completionXp > 100_000) return res.status(400).json({ error: 'INVALID_CHALLENGE' });
  if (isSeniorSecondaryCompetitionGrade(classLabel) && questionCount !== 50) return res.status(400).json({ error: 'SENIOR_CHALLENGE_REQUIRES_50_QUESTIONS' });
  const [category, questionSet, scoringPolicy] = await Promise.all([
    prisma.competitionCategory.findUnique({ where: { id: categoryId }, select: { id: true } }),
    prisma.competitionQuestionSet.findUnique({ where: { id: questionSetId }, select: { id: true, categoryId: true, status: true, _count: { select: { questions: true } } } }),
    prisma.competitionScoringPolicy.findUnique({ where: { id: scoringPolicyId }, select: { id: true } }),
  ]);
  if (!category || !questionSet || !scoringPolicy || questionSet.categoryId !== category.id || questionSet.status === 'ARCHIVED' || questionSet._count.questions < questionCount) return res.status(400).json({ error: 'CHALLENGE_CONFIGURATION_INCOMPLETE' });
  const audienceLabel = ageMatch ? `Ages ${minimumAge}-${maximumAge} · ${classLabel}` : classLabel;
  const challenge = await prisma.competitionChallenge.create({ data: { categoryId, questionSetId, scoringPolicyId, title: title.trim(), description: typeof description === 'string' ? description.slice(0, 5000) : undefined, gradeLabel: audienceLabel, questionCount, durationSeconds, attemptLimit, difficultyMixJson: difficultyMix && typeof difficultyMix === 'object' && !Array.isArray(difficultyMix) ? JSON.stringify(difficultyMix) : undefined, xpPolicyJson: JSON.stringify({ completionXp }), status: 'DRAFT', createdByUserId: req.competitionUser?.id } });
  await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'CHALLENGE_CREATED', entityType: 'CompetitionChallenge', entityId: challenge.id } });
  res.status(201).json({ challenge });
});

router.get('/admin/overview', requireSession, requirePlatformAdmin, async (_req, res) => {
  try {
    const [questionSets, questions, challenges, attempts, tournaments, openFlags] = await Promise.all([
      prisma.competitionQuestionSet.count(),
      prisma.competitionQuestion.count(),
      prisma.competitionChallenge.count(),
      prisma.competitionChallengeAttempt.count(),
      prisma.competitionTournament.count(),
      prisma.competitionSuspiciousActivity.count({ where: { status: 'OPEN' } }),
    ]);
    res.json({ questionSets, questions, challenges, attempts, tournaments, openFlags });
  } catch (error) {
    console.error('[competition] admin overview failed', error);
    res.status(500).json({ error: 'COMPETITION_OVERVIEW_FAILED' });
  }
});

router.get('/admin/question-sets', requireSession, requirePlatformAdmin, async (_req, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.questionBank.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const sets = await prisma.competitionQuestionSet.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: { category: true, _count: { select: { questions: true } } },
  });
  res.json({ questionSets: sets });
});

router.post('/admin/question-sets', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.questionBank.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { categoryId, name, description, gradeLabel, topic, locale } = req.body ?? {};
  if (typeof categoryId !== 'string' || typeof name !== 'string' || !name.trim() || name.trim().length > 191) {
    return res.status(400).json({ error: 'INVALID_QUESTION_SET' });
  }
  try {
    const category = await prisma.competitionCategory.findUnique({ where: { id: categoryId }, select: { id: true } });
    if (!category) return res.status(400).json({ error: 'INVALID_CATEGORY' });
    const questionSet = await prisma.competitionQuestionSet.create({
      data: {
        categoryId,
        name: name.trim(),
        description: typeof description === 'string' ? description.slice(0, 5000) : undefined,
        gradeLabel: typeof gradeLabel === 'string' ? gradeLabel.slice(0, 80) : undefined,
        topic: typeof topic === 'string' ? topic.slice(0, 160) : undefined,
        locale: typeof locale === 'string' ? locale.slice(0, 16) : 'en',
        createdByUserId: req.competitionUser?.id,
      },
    });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'QUESTION_SET_CREATED', entityType: 'CompetitionQuestionSet', entityId: questionSet.id } });
    res.status(201).json({ questionSet });
  } catch (error) {
    console.error('[competition] question set creation failed', error);
    res.status(isPrismaUniqueError(error) ? 409 : 500).json({ error: isPrismaUniqueError(error) ? 'QUESTION_SET_EXISTS' : 'QUESTION_SET_CREATE_FAILED' });
  }
});

router.post('/admin/question-sets/:id/review', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.questionBank.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const action = req.body?.action;
  const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 4000) : null;
  if (!['APPROVE', 'RETURN_TO_DRAFT'].includes(action)) return res.status(400).json({ error: 'INVALID_QUESTION_SET_REVIEW_ACTION' });

  const questionSet = await prisma.competitionQuestionSet.findUnique({
    where: { id: req.params.id },
    select: { id: true, status: true, questions: { select: { status: true } } },
  });
  if (!questionSet) return res.status(404).json({ error: 'QUESTION_SET_NOT_FOUND' });
  if (questionSet.status === 'ARCHIVED') return res.status(409).json({ error: 'QUESTION_SET_ARCHIVED' });
  if (action === 'APPROVE' && !canApproveCompetitionQuestionSet(questionSet.questions.map((question) => question.status))) {
    return res.status(409).json({ error: 'QUESTION_SET_REVIEW_INCOMPLETE' });
  }

  try {
    const status = action === 'APPROVE' ? 'APPROVED' : 'DRAFT';
    const updated = await prisma.competitionQuestionSet.update({
      where: { id: questionSet.id },
      data: { status, reviewedByUserId: req.competitionUser?.id, reviewedAt: new Date(), reviewNotes: notes },
      select: { id: true, status: true, reviewedAt: true },
    });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: `QUESTION_SET_${action}`, entityType: 'CompetitionQuestionSet', entityId: updated.id, reason: notes } });
    res.json({ questionSet: updated });
  } catch (error) {
    console.error('[competition] question-set review failed', error);
    res.status(500).json({ error: 'QUESTION_SET_REVIEW_FAILED' });
  }
});

router.get('/admin/questions', requireSession, requirePlatformAdmin, async (req, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.questionBank.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const questionSetId = typeof req.query.questionSetId === 'string' ? req.query.questionSetId : undefined;
  const questions = await prisma.competitionQuestion.findMany({
    where: questionSetId ? { questionSetId } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      questionSet: { select: { id: true, name: true } },
      options: { orderBy: { sortOrder: 'asc' } },
      media: true,
    },
  });
  res.json({ questions });
});

router.post('/admin/questions', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.questionBank.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { questionSetId, prompt, type, difficulty, explanation, options, basePoints, timeLimitSeconds } = req.body ?? {};
  const allowedTypes = ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'IMAGE', 'ORDERING', 'MATCHING', 'SHORT_ANSWER'];
  const allowedDifficulties = ['EASY', 'MEDIUM', 'HARD', 'EXPERT'];
  if (typeof questionSetId !== 'string' || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000 || !allowedTypes.includes(type) || !allowedDifficulties.includes(difficulty)) {
    return res.status(400).json({ error: 'INVALID_QUESTION' });
  }
  if (!Array.isArray(options) || options.length < 2 || options.length > 12 || options.some((option) => !option || typeof option.content !== 'string' || !option.content.trim() || typeof option.isCorrect !== 'boolean')) {
    return res.status(400).json({ error: 'INVALID_QUESTION_OPTIONS' });
  }
  if (options.filter((option) => option.isCorrect).length !== 1) return res.status(400).json({ error: 'QUESTION_REQUIRES_ONE_CORRECT_OPTION' });
  try {
    const questionSet = await prisma.competitionQuestionSet.findUnique({ where: { id: questionSetId }, select: { id: true, status: true } });
    if (!questionSet || questionSet.status === 'ARCHIVED') return res.status(400).json({ error: 'INVALID_QUESTION_SET' });
    const question = await prisma.$transaction(async (transaction) => {
      const createdQuestion = await transaction.competitionQuestion.create({
        data: {
          questionSetId,
          prompt: prompt.trim(),
          type,
          difficulty,
          explanation: typeof explanation === 'string' ? explanation.slice(0, 12000) : undefined,
          basePoints: Number.isInteger(basePoints) && basePoints >= 0 && basePoints <= 100000 ? basePoints : 100,
          timeLimitSeconds: Number.isInteger(timeLimitSeconds) && timeLimitSeconds > 0 && timeLimitSeconds <= 3600 ? timeLimitSeconds : undefined,
          createdByUserId: req.competitionUser?.id,
          options: { create: options.map((option, sortOrder) => ({ content: option.content.trim().slice(0, 4000), isCorrect: option.isCorrect, sortOrder })) },
        },
        include: { options: { orderBy: { sortOrder: 'asc' } } },
      });
      await transaction.competitionQuestionSet.updateMany({
        where: { id: questionSetId, status: { in: ['IN_REVIEW', 'APPROVED', 'REJECTED'] } },
        data: { status: 'DRAFT', reviewedByUserId: null, reviewedAt: null, reviewNotes: null },
      });
      return createdQuestion;
    });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'QUESTION_CREATED', entityType: 'CompetitionQuestion', entityId: question.id } });
    res.status(201).json({ question });
  } catch (error) {
    console.error('[competition] question creation failed', error);
    res.status(500).json({ error: 'QUESTION_CREATE_FAILED' });
  }
});

router.post('/admin/questions/:id/review', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.questionBank.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const action = req.body?.action;
  const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 4000) : null;
  if (!['APPROVE', 'REJECT', 'REQUEST_CHANGES'].includes(action)) return res.status(400).json({ error: 'INVALID_REVIEW_ACTION' });
  const status = action === 'APPROVE' ? 'APPROVED' : action === 'REJECT' ? 'REJECTED' : 'DRAFT';
  try {
    const question = await prisma.competitionQuestion.update({
      where: { id: req.params.id },
      data: { status, reviewedByUserId: req.competitionUser?.id, reviewedAt: new Date(), reviewNotes: notes },
      select: { id: true, questionSetId: true, status: true, reviewedAt: true },
    });
    if (status !== 'APPROVED') {
      await prisma.competitionQuestionSet.updateMany({
        where: { id: question.questionSetId, status: 'APPROVED' },
        data: { status: 'DRAFT', reviewedByUserId: null, reviewedAt: null, reviewNotes: null },
      });
    }
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: `QUESTION_${action}`, entityType: 'CompetitionQuestion', entityId: question.id, reason: notes } });
    res.json({ question });
  } catch (error) {
    console.error('[competition] question review failed', error);
    res.status(404).json({ error: 'QUESTION_NOT_FOUND' });
  }
});

router.get('/admin/challenges', requireSession, requirePlatformAdmin, async (_req, res) => {
  if (!(await isChallengePracticeEnabled())) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const challenges = await prisma.competitionChallenge.findMany({ orderBy: { updatedAt: 'desc' }, take: 100, include: { category: true, questionSet: { select: { gradeLabel: true, status: true } }, _count: { select: { attempts: true } } } });
  res.json({ challenges: challenges.map(({ xpPolicyJson, ...challenge }) => {
    let completionXp = 0;
    try { completionXp = parseCompetitionXpPolicy(xpPolicyJson).completionXp; } catch { /* Keep malformed legacy policy from blocking challenge administration. */ }
    return { ...challenge, completionXp };
  }) });
});

router.patch('/admin/challenges/:id/status', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await isChallengePracticeEnabled())) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const status = req.body?.status;
  if (!['DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'].includes(status)) return res.status(400).json({ error: 'INVALID_CHALLENGE_STATUS' });
  if (status === 'ACTIVE') {
    const challenge = await prisma.competitionChallenge.findUnique({ where: { id: req.params.id }, select: { gradeLabel: true, questionCount: true, questionSet: { include: { questions: { where: { status: 'APPROVED' }, select: { id: true } } } } } });
    if (!parseCompetitionAudience(challenge?.gradeLabel)) return res.status(409).json({ error: 'CHALLENGE_AUDIENCE_REQUIRED' });
    if (!challenge) return res.status(404).json({ error: 'CHALLENGE_NOT_FOUND' });
    if (isSeniorSecondaryCompetitionGrade(challenge.gradeLabel) && challenge.questionCount !== 50) return res.status(409).json({ error: 'SENIOR_CHALLENGE_REQUIRES_50_QUESTIONS' });
    if (challenge.questionSet.status !== 'APPROVED') return res.status(409).json({ error: 'QUESTION_SET_NOT_APPROVED' });
    if (challenge.questionSet.questions.length < challenge.questionCount) return res.status(409).json({ error: 'APPROVED_QUESTION_COUNT_INSUFFICIENT' });
  }
  try {
    const challenge = await prisma.competitionChallenge.update({ where: { id: req.params.id }, data: { status } });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'CHALLENGE_STATUS_CHANGED', entityType: 'CompetitionChallenge', entityId: challenge.id, afterJson: JSON.stringify({ status }) } });
    res.json({ challenge });
  } catch (error) {
    console.error('[competition] challenge status update failed', error);
    res.status(404).json({ error: 'CHALLENGE_NOT_FOUND' });
  }
});

router.get('/admin/exam-practices', requireSession, requirePlatformAdmin, async (_req, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.examPractice.enabled')) || !(await resolveCompetitionFeature(prisma, 'competition.questionBank.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const examPractices = await prisma.competitionExamPractice.findMany({
    orderBy: [{ examCode: 'asc' }, { countryCode: 'asc' }, { gradeLabel: 'asc' }, { subjectCategory: { name: 'asc' } }],
    take: 500,
    include: { subjectCategory: { select: { id: true, name: true, code: true } }, challenge: { select: { id: true, title: true, status: true, questionCount: true, durationSeconds: true, attemptLimit: true, questionSet: { select: { id: true, name: true, gradeLabel: true, _count: { select: { questions: true } } } } } } },
  });
  res.json({ examPractices });
});

router.post('/admin/exam-practices', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.examPractice.enabled')) || !(await resolveCompetitionFeature(prisma, 'competition.questionBank.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { challengeId, examCode, countryCode, gradeLabel, format = 'PRACTICE', syllabusVersion } = req.body ?? {};
  const supportedExamCodes = ['WAEC', 'BECE', 'JUNIOR_WAEC'];
  if (typeof challengeId !== 'string' || typeof examCode !== 'string' || !supportedExamCodes.includes(examCode) || typeof countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(countryCode) || typeof gradeLabel !== 'string' || !gradeLabel.trim() || gradeLabel.trim().length > 80 || !['PRACTICE', 'MOCK_EXAM'].includes(format) || syllabusVersion !== undefined && (typeof syllabusVersion !== 'string' || syllabusVersion.length > 80)) return res.status(400).json({ error: 'INVALID_EXAM_PRACTICE' });
  const normalizedCountryCode = countryCode.trim().toUpperCase();
  if (!getCompetitionExamPracticeGrades(normalizedCountryCode, examCode).length || !normalizeCompetitionExamPracticeGrade(normalizedCountryCode, examCode, gradeLabel)) return res.status(400).json({ error: 'INVALID_EXAM_PRACTICE_GRADE' });
  const challenge = await prisma.competitionChallenge.findUnique({
    where: { id: challengeId },
    select: {
      id: true,
      status: true,
      gradeLabel: true,
      category: { select: { name: true } },
      questionCount: true,
      categoryId: true,
      questionSet: { select: { id: true, status: true, categoryId: true, gradeLabel: true, _count: { select: { questions: true } } } },
    },
  });
  const challengeGrade = challenge?.gradeLabel?.split('·').at(-1)?.trim();
  const normalizedGrade = normalizeCompetitionExamPracticeGrade(normalizedCountryCode, examCode, gradeLabel);
  if (challenge && !isCompetitionExamPracticeSubjectAllowed({ countryCode: normalizedCountryCode, examCode, gradeLabel, subjectName: challenge.category.name })) return res.status(400).json({ error: 'EXAM_PRACTICE_SUBJECT_NOT_ALLOWED' });
  if (challenge && isSeniorSecondaryCompetitionGrade(challenge.gradeLabel) && challenge.questionCount !== 50) return res.status(400).json({ error: 'SENIOR_CHALLENGE_REQUIRES_50_QUESTIONS' });
  if (!challenge || challenge.status !== 'ACTIVE' || challenge.questionSet.status !== 'APPROVED' || challenge.questionSet.categoryId !== challenge.categoryId || !normalizedGrade || normalizeCompetitionExamPracticeGrade(normalizedCountryCode, examCode, challengeGrade) !== normalizedGrade || normalizeCompetitionExamPracticeGrade(normalizedCountryCode, examCode, challenge.questionSet.gradeLabel) !== normalizedGrade || challenge.questionSet._count.questions < challenge.questionCount) return res.status(400).json({ error: 'EXAM_PRACTICE_CHALLENGE_MISMATCH' });
  try {
    const examPractice = await prisma.competitionExamPractice.create({
      data: { challengeId, examCode, countryCode: normalizedCountryCode, gradeLabel: normalizedGrade, subjectCategoryId: challenge.categoryId, format, syllabusVersion: typeof syllabusVersion === 'string' && syllabusVersion.trim() ? syllabusVersion.trim() : undefined, isActive: true, createdByUserId: req.competitionUser?.id },
      include: { subjectCategory: { select: { id: true, name: true, code: true } }, challenge: { select: { id: true, title: true, status: true, questionCount: true, durationSeconds: true, attemptLimit: true, questionSet: { select: { id: true, name: true, gradeLabel: true, status: true, _count: { select: { questions: true } } } } } } },
    });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'EXAM_PRACTICE_CONFIGURED', entityType: 'CompetitionExamPractice', entityId: examPractice.id, afterJson: JSON.stringify({ examCode, countryCode: normalizedCountryCode, gradeLabel: normalizedGrade, format, syllabusVersion }) } });
    res.status(201).json({ examPractice });
  } catch (error) {
    if (isPrismaUniqueError(error)) return res.status(409).json({ error: 'EXAM_PRACTICE_ALREADY_CONFIGURED' });
    console.error('[competition] exam practice configuration failed', error);
    res.status(500).json({ error: 'EXAM_PRACTICE_CONFIGURE_FAILED' });
  }
});

router.patch('/admin/exam-practices/:id/status', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.examPractice.enabled')) || !(await resolveCompetitionFeature(prisma, 'competition.questionBank.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  if (typeof req.body?.isActive !== 'boolean') return res.status(400).json({ error: 'INVALID_EXAM_PRACTICE_STATUS' });
  try {
    const currentPractice = await prisma.competitionExamPractice.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        examCode: true,
        countryCode: true,
        gradeLabel: true,
        subjectCategory: { select: { name: true } },
        challenge: {
          select: {
            status: true,
            gradeLabel: true,
            questionCount: true,
            questionSet: {
              select: {
                status: true,
                gradeLabel: true,
                _count: { select: { questions: true } },
              },
            },
          },
        },
      },
    });
    if (!currentPractice) return res.status(404).json({ error: 'EXAM_PRACTICE_NOT_FOUND' });
    const challengeGrade = currentPractice.challenge.gradeLabel?.split('·').at(-1)?.trim();
    const canonicalGrade = normalizeCompetitionExamPracticeGrade(currentPractice.countryCode, currentPractice.examCode, currentPractice.gradeLabel);
    const subjectAllowed = isCompetitionExamPracticeSubjectAllowed({ countryCode: currentPractice.countryCode, examCode: currentPractice.examCode, gradeLabel: currentPractice.gradeLabel, subjectName: currentPractice.subjectCategory.name });
    const validGrade = canonicalGrade && normalizeCompetitionExamPracticeGrade(currentPractice.countryCode, currentPractice.examCode, challengeGrade) === canonicalGrade && normalizeCompetitionExamPracticeGrade(currentPractice.countryCode, currentPractice.examCode, currentPractice.challenge.questionSet.gradeLabel) === canonicalGrade;
    if (req.body.isActive && (!subjectAllowed || currentPractice.challenge.status !== 'ACTIVE' || currentPractice.challenge.questionSet.status !== 'APPROVED' || !validGrade || currentPractice.challenge.questionSet._count.questions < currentPractice.challenge.questionCount || isSeniorSecondaryCompetitionGrade(currentPractice.gradeLabel) && currentPractice.challenge.questionCount !== 50)) {
      return res.status(409).json({ error: 'EXAM_PRACTICE_CONTENT_UNAVAILABLE' });
    }
    const examPractice = await prisma.competitionExamPractice.update({ where: { id: req.params.id }, data: { isActive: req.body.isActive }, include: { subjectCategory: { select: { id: true, name: true, code: true } }, challenge: { select: { id: true, title: true, status: true, questionCount: true, durationSeconds: true, attemptLimit: true, questionSet: { select: { id: true, name: true, gradeLabel: true, status: true, _count: { select: { questions: true } } } } } } } });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: req.body.isActive ? 'EXAM_PRACTICE_ACTIVATED' : 'EXAM_PRACTICE_DEACTIVATED', entityType: 'CompetitionExamPractice', entityId: examPractice.id, afterJson: JSON.stringify({ isActive: examPractice.isActive }) } });
    res.json({ examPractice });
  } catch (error) {
    console.error('[competition] exam practice status update failed', error);
    res.status(404).json({ error: 'EXAM_PRACTICE_NOT_FOUND' });
  }
});

router.get('/admin/tournaments', requireSession, requirePlatformAdmin, async (_req, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const [tournaments, categories, prizesEnabled, certificatesEnabled, sponsorsEnabled, nationalEnabled] = await Promise.all([
    prisma.competitionTournament.findMany({ where: { scope: { in: (await resolveCompetitionFeature(prisma, 'competition.national.enabled')) ? ['SCHOOL', 'CLASS', 'COUNTRY'] : ['SCHOOL', 'CLASS'] } }, orderBy: { createdAt: 'desc' }, take: 100, include: { category: true, _count: { select: { schools: true, participants: true } }, schools: { include: { school: { select: { id: true, name: true, logoUrl: true } } }, orderBy: { registeredAt: 'desc' }, take: 100 }, participants: { include: { pupil: { select: { firstName: true, lastName: true } }, school: { select: { id: true, name: true, logoUrl: true } }, class: { select: { name: true } } }, orderBy: { registeredAt: 'desc' }, take: 500 }, rounds: { orderBy: { roundNumber: 'asc' }, include: { matches: { orderBy: { scheduledAt: 'asc' }, include: { homeParticipant: { select: { displayNameSnapshot: true } }, awayParticipant: { select: { displayNameSnapshot: true } } } } } } } }),
    prisma.competitionCategory.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 250 }),
    resolveCompetitionFeature(prisma, 'competition.prizes.enabled'),
    resolveCompetitionFeature(prisma, 'competition.certificates.enabled'),
    resolveCompetitionFeature(prisma, 'competition.sponsors.enabled'),
    resolveCompetitionFeature(prisma, 'competition.national.enabled'),
  ]);
  res.json({ tournaments, categories, capabilities: { prizesEnabled, certificatesEnabled, sponsorsEnabled, nationalEnabled } });
});

router.post('/admin/tournaments', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { title, slug, categoryId, scope, countryCode, description, rules, registrationOpensAt, registrationClosesAt, startsAt, endsAt, participantLimit, scoringPolicy } = req.body ?? {};
  const allowedScopes = ['SCHOOL', 'CLASS', ...(await resolveCompetitionFeature(prisma, 'competition.national.enabled') ? ['COUNTRY'] : [])];
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 160 || typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 160 || typeof categoryId !== 'string' || !allowedScopes.includes(scope) || scope === 'COUNTRY' && (typeof countryCode !== 'string' || !/^[A-Z]{2}$/.test(countryCode))) return res.status(400).json({ error: 'INVALID_TOURNAMENT' });
  if (!scoringPolicy || typeof scoringPolicy !== 'object' || Array.isArray(scoringPolicy) || !Number.isInteger(scoringPolicy.basePoints) || scoringPolicy.basePoints < 0 || scoringPolicy.basePoints > 100000) return res.status(400).json({ error: 'INVALID_TOURNAMENT_SCORING' });
  let dates: { registrationOpensAt: Date | null; registrationClosesAt: Date | null; startsAt: Date | null; endsAt: Date | null };
  try {
    dates = { registrationOpensAt: parseCompetitionTournamentDate(registrationOpensAt), registrationClosesAt: parseCompetitionTournamentDate(registrationClosesAt), startsAt: parseCompetitionTournamentDate(startsAt), endsAt: parseCompetitionTournamentDate(endsAt) };
  } catch { return res.status(400).json({ error: 'INVALID_TOURNAMENT_DATES' }); }
  if (dates.registrationOpensAt && dates.registrationClosesAt && dates.registrationOpensAt >= dates.registrationClosesAt || dates.registrationClosesAt && dates.startsAt && dates.registrationClosesAt > dates.startsAt || dates.startsAt && dates.endsAt && dates.startsAt >= dates.endsAt || participantLimit !== undefined && participantLimit !== null && (!Number.isInteger(participantLimit) || participantLimit < 1 || participantLimit > 100_000)) return res.status(400).json({ error: 'INVALID_TOURNAMENT_DATES' });
  try { parseCompetitionScoringPolicy(JSON.stringify(scoringPolicy)); } catch { return res.status(400).json({ error: 'INVALID_TOURNAMENT_SCORING' }); }
  const category = await prisma.competitionCategory.findUnique({ where: { id: categoryId }, select: { id: true } });
  if (!category) return res.status(400).json({ error: 'INVALID_TOURNAMENT_CATEGORY' });
  try {
    const tournament = await prisma.competitionTournament.create({ data: { title: title.trim(), slug, categoryId, scope, countryCode: scope === 'COUNTRY' ? countryCode : null, description: typeof description === 'string' ? description.slice(0, 5000) : undefined, rules: typeof rules === 'string' ? rules.slice(0, 10000) : undefined, registrationOpensAt: dates.registrationOpensAt, registrationClosesAt: dates.registrationClosesAt, startsAt: dates.startsAt, endsAt: dates.endsAt, participantLimit: participantLimit ?? null, scoringPolicyJson: JSON.stringify(scoringPolicy), createdByUserId: req.competitionUser?.id }, select: { id: true, title: true, slug: true, scope: true, status: true } });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'TOURNAMENT_CREATED', entityType: 'CompetitionTournament', entityId: tournament.id } });
    res.status(201).json({ tournament });
  } catch (error) {
    if (isPrismaUniqueError(error)) return res.status(409).json({ error: 'TOURNAMENT_SLUG_EXISTS' });
    console.error('[competition] tournament creation failed', error);
    res.status(500).json({ error: 'TOURNAMENT_CREATE_FAILED' });
  }
});

router.patch('/admin/tournaments/:id/status', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const nextStatus = req.body?.status as CompetitionTournamentStatus;
  if (!['DRAFT', 'UPCOMING', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'LIVE', 'COMPLETED', 'CANCELLED'].includes(nextStatus)) return res.status(400).json({ error: 'INVALID_TOURNAMENT_STATUS' });
  const tournament = await prisma.competitionTournament.findUnique({ where: { id: req.params.id }, include: { _count: { select: { schools: true, participants: true } } } });
  if (!tournament) return res.status(404).json({ error: 'TOURNAMENT_NOT_FOUND' });
  if (tournament.scope === 'COUNTRY' && !(await resolveCompetitionFeature(prisma, 'competition.national.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  if (!canTransitionCompetitionTournament(tournament.status, nextStatus)) return res.status(409).json({ error: 'TOURNAMENT_TRANSITION_NOT_ALLOWED' });
  const now = new Date();
  if (nextStatus === 'REGISTRATION_OPEN' && (!tournament.registrationClosesAt || tournament.registrationClosesAt <= now)) return res.status(409).json({ error: 'TOURNAMENT_REGISTRATION_WINDOW_REQUIRED' });
  if (nextStatus === 'LIVE' && tournament._count.participants === 0) return res.status(409).json({ error: 'TOURNAMENT_PARTICIPANTS_REQUIRED' });
  const updated = await prisma.competitionTournament.updateMany({ where: { id: tournament.id, status: tournament.status }, data: { status: nextStatus } });
  if (!updated.count) return res.status(409).json({ error: 'TOURNAMENT_STATE_CHANGED' });
  await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'TOURNAMENT_STATUS_CHANGED', entityType: 'CompetitionTournament', entityId: tournament.id, beforeJson: JSON.stringify({ status: tournament.status }), afterJson: JSON.stringify({ status: nextStatus }) } });
  res.json({ success: true, status: nextStatus });
});

router.get('/school/tournaments', requireSession, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const nationalEnabled = await resolveCompetitionFeature(prisma, 'competition.national.enabled');
  const schoolAdmin = req.competitionUser?.role === 'SCHOOL_ADMIN' && req.competitionUser.schoolId ? req.competitionUser : null;
  const identity = schoolAdmin ? null : await resolveLearnerIdentity(req, res);
  if (!schoolAdmin && !identity) return;
  const schoolId = schoolAdmin?.schoolId ?? identity!.schoolId;
  const pupilSchool = nationalEnabled ? await prisma.school.findUnique({ where: { id: schoolId }, select: { country: true } }) : null;
  const now = new Date();
  const tournaments = await prisma.competitionTournament.findMany({
    where: {
      scope: { in: nationalEnabled ? ['SCHOOL', 'CLASS', 'COUNTRY'] : ['SCHOOL', 'CLASS'] },
      status: { in: ['UPCOMING', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'LIVE'] },
      OR: [{ registrationOpensAt: null }, { registrationOpensAt: { lte: now } }],
      AND: [
        { OR: [{ schoolId: null }, { schoolId }] },
        ...(nationalEnabled && pupilSchool ? [{ OR: [{ scope: { not: 'COUNTRY' as const } }, { countryCode: pupilSchool.country.toUpperCase() }] }] : []),
      ],
    },
    select: {
      id: true,
      title: true,
      description: true,
      rules: true,
      scope: true,
      countryCode: true,
      status: true,
      registrationOpensAt: true,
      registrationClosesAt: true,
      startsAt: true,
      endsAt: true,
      participantLimit: true,
      _count: { select: { participants: true } },
      schools: { where: { schoolId }, select: { id: true, status: true } },
      participants: {
        where: { pupilId: identity?.pupilId ?? '' },
        select: { id: true, status: true, visibilityApproved: true, nominatedAt: true, guardianConsentStatus: true, school: { select: { id: true, name: true, logoUrl: true } } },
      },
    },
    orderBy: { startsAt: 'asc' },
    take: 50,
  });
  res.json({ tournaments: tournaments.map(({ schools, participants, ...tournament }) => ({ ...tournament, schoolRegistration: schools[0] ? { registered: true, status: schools[0].status } : { registered: false, status: null }, ownRegistration: Array.isArray(participants) && participants[0] ? { registered: true, status: participants[0].status, visibilityApproved: participants[0].visibilityApproved, nominated: Boolean(participants[0].nominatedAt), guardianConsentStatus: participants[0].guardianConsentStatus, invitingSchool: participants[0].school } : { registered: false, status: null, visibilityApproved: false, nominated: false, guardianConsentStatus: null, invitingSchool: null } })) });
});

router.post('/school/tournaments/:tournamentId/register-school', requireSession, requireSchoolStaff, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const schoolId = req.competitionUser?.schoolId;
  if (!schoolId) return res.status(403).json({ error: 'SCHOOL_SCOPE_REQUIRED' });
  const nationalEnabled = await resolveCompetitionFeature(prisma, 'competition.national.enabled');
  const school = nationalEnabled ? await prisma.school.findUnique({ where: { id: schoolId }, select: { country: true } }) : null;
  const tournament = await prisma.competitionTournament.findFirst({ where: { id: req.params.tournamentId, scope: { in: nationalEnabled ? ['SCHOOL', 'CLASS', 'COUNTRY'] : ['SCHOOL', 'CLASS'] }, status: 'REGISTRATION_OPEN', AND: [{ OR: [{ schoolId: null }, { schoolId }] }, ...(nationalEnabled && school ? [{ OR: [{ scope: { not: 'COUNTRY' as const } }, { countryCode: school.country.toUpperCase() }] }] : [])] }, select: { id: true, registrationOpensAt: true, registrationClosesAt: true } });
  const now = new Date();
  if (!tournament || tournament.registrationOpensAt && tournament.registrationOpensAt > now || tournament.registrationClosesAt && tournament.registrationClosesAt <= now) return res.status(409).json({ error: 'TOURNAMENT_REGISTRATION_CLOSED' });
  const registration = await prisma.competitionTournamentSchool.upsert({ where: { tournamentId_schoolId: { tournamentId: tournament.id, schoolId } }, create: { tournamentId: tournament.id, schoolId, status: 'PENDING' }, update: {}, select: { id: true, status: true, registeredAt: true } });
  res.status(201).json({ registration });
});

router.get('/school/tournaments/:tournamentId/roster', requireSession, requireSchoolStaff, async (req: CompetitionRequest, res) => {
  if (req.competitionUser?.role !== 'SCHOOL_ADMIN' || !req.competitionUser.schoolId) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const schoolId = req.competitionUser.schoolId;
  const tournament = await prisma.competitionTournament.findFirst({
    where: { id: req.params.tournamentId, status: 'REGISTRATION_OPEN', AND: [{ OR: [{ schoolId: null }, { schoolId }] }] },
    select: { id: true, registrationOpensAt: true, registrationClosesAt: true, participantLimit: true, _count: { select: { participants: true } }, schools: { where: { schoolId, status: 'APPROVED' }, select: { id: true } } },
  });
  const now = new Date();
  if (!tournament || tournament.registrationOpensAt && tournament.registrationOpensAt > now || tournament.registrationClosesAt && tournament.registrationClosesAt <= now) return res.status(409).json({ error: 'TOURNAMENT_REGISTRATION_CLOSED' });
  if (!tournament.schools.length) return res.status(403).json({ error: 'SCHOOL_REGISTRATION_APPROVAL_REQUIRED' });
  const [pupils, participants] = await Promise.all([
    prisma.pupil.findMany({
      where: { schoolId, isActive: true, OR: [{ status: null }, { status: { not: 'INACTIVE' } }], guardians: { some: { guardian: { schoolId } } } },
      select: { id: true, firstName: true, lastName: true, admissionNo: true, class: { select: { name: true } } },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: 1000,
    }),
    prisma.competitionTournamentParticipant.findMany({ where: { tournamentId: tournament.id, schoolId }, select: { pupilId: true, status: true, guardianConsentStatus: true, nominatedAt: true } }),
  ]);
  const participantByPupil = new Map(participants.map((participant) => [participant.pupilId, participant]));
  res.json({
    tournament: { id: tournament.id, participantLimit: tournament.participantLimit, participants: tournament._count.participants },
    pupils: pupils.map((pupil) => ({ ...pupil, nomination: participantByPupil.get(pupil.id) ?? null })),
  });
});

router.post('/school/tournaments/:tournamentId/nominations', requireSession, requireSchoolStaff, async (req: CompetitionRequest, res) => {
  if (req.competitionUser?.role !== 'SCHOOL_ADMIN' || !req.competitionUser.schoolId) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const requestedPupilIds: unknown[] = Array.isArray(req.body?.pupilIds) ? req.body.pupilIds : [];
  const pupilIds = Array.from(new Set<string>(requestedPupilIds.filter((id): id is string => typeof id === 'string' && id.length > 0)));
  if (!pupilIds.length || pupilIds.length > 500) return res.status(400).json({ error: 'PUPILS_REQUIRED' });
  const schoolId = req.competitionUser.schoolId;
  const tournament = await prisma.competitionTournament.findFirst({
    where: { id: req.params.tournamentId, status: 'REGISTRATION_OPEN', AND: [{ OR: [{ schoolId: null }, { schoolId }] }] },
    select: { id: true, registrationOpensAt: true, registrationClosesAt: true, participantLimit: true, _count: { select: { participants: true } }, schools: { where: { schoolId, status: 'APPROVED' }, select: { id: true } } },
  });
  const now = new Date();
  if (!tournament || tournament.registrationOpensAt && tournament.registrationOpensAt > now || tournament.registrationClosesAt && tournament.registrationClosesAt <= now) return res.status(409).json({ error: 'TOURNAMENT_REGISTRATION_CLOSED' });
  if (!tournament.schools.length) return res.status(403).json({ error: 'SCHOOL_REGISTRATION_APPROVAL_REQUIRED' });
  const eligiblePupils = await prisma.pupil.findMany({
    where: { id: { in: pupilIds }, schoolId, isActive: true, OR: [{ status: null }, { status: { not: 'INACTIVE' } }], guardians: { some: { guardian: { schoolId } } } },
    select: { id: true, classId: true, admissionNo: true, guardians: { select: { guardianId: true } } },
  });
  if (eligiblePupils.length !== pupilIds.length) return res.status(400).json({ error: 'PUPILS_NOT_ELIGIBLE' });
  try {
    const result = await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM CompetitionTournament WHERE id = ${tournament.id} FOR UPDATE`;
      const existing = await transaction.competitionTournamentParticipant.findMany({ where: { tournamentId: tournament.id, pupilId: { in: pupilIds } }, select: { id: true, pupilId: true, status: true, guardianConsentStatus: true } });
      const existingIds = new Set(existing.map(({ pupilId }) => pupilId));
      const newPupils = eligiblePupils.filter((pupil) => !existingIds.has(pupil.id));
      const currentCount = await transaction.competitionTournamentParticipant.count({ where: { tournamentId: tournament.id, status: { notIn: ['WITHDRAWN', 'DISQUALIFIED'] } } });
      if (tournament.participantLimit !== null && currentCount + newPupils.length > tournament.participantLimit) throw new Error('TOURNAMENT_FULL');
      if (newPupils.length) {
        await transaction.competitionTournamentParticipant.createMany({ data: newPupils.map((pupil) => ({
          tournamentId: tournament.id,
          tournamentSchoolId: tournament.schools[0]!.id,
          schoolId,
          pupilId: pupil.id,
          classId: pupil.classId,
          status: 'INVITED' as const,
          displayNameSnapshot: `Student ${pupil.id.slice(-4)}`,
          visibilityApproved: false,
          nominatedAt: now,
          nominatedByUserId: req.competitionUser!.id,
        })) });
      }
      return { invited: newPupils.length, alreadyListed: existing.length };
    });
    await prisma.competitionAuditLog.create({ data: { schoolId, actorUserId: req.competitionUser.id, action: 'TOURNAMENT_PUPILS_NOMINATED', entityType: 'CompetitionTournament', entityId: tournament.id, afterJson: JSON.stringify(result) } });
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'TOURNAMENT_FULL') return res.status(409).json({ error: 'TOURNAMENT_FULL' });
    console.error('[competition] tournament nomination failed', error);
    res.status(500).json({ error: 'TOURNAMENT_NOMINATION_FAILED' });
  }
});

router.post('/school/tournaments/:tournamentId/register', requireSession, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  if (!req.competitionGuardian) return res.status(403).json({ error: 'GUARDIAN_SESSION_REQUIRED' });
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  const nationalEnabled = await resolveCompetitionFeature(prisma, 'competition.national.enabled');
  const pupilSchool = nationalEnabled ? await prisma.school.findUnique({ where: { id: identity.schoolId }, select: { country: true } }) : null;
  const tournament = await prisma.competitionTournament.findFirst({ where: { id: req.params.tournamentId, scope: { in: nationalEnabled ? ['SCHOOL', 'CLASS', 'COUNTRY'] : ['SCHOOL', 'CLASS'] }, status: 'REGISTRATION_OPEN', AND: [{ OR: [{ schoolId: null }, { schoolId: identity.schoolId }] }, ...(nationalEnabled && pupilSchool ? [{ OR: [{ scope: { not: 'COUNTRY' as const } }, { countryCode: pupilSchool.country.toUpperCase() }] }] : [])] }, select: { id: true, registrationOpensAt: true, registrationClosesAt: true, participantLimit: true, _count: { select: { participants: true } }, schools: { where: { schoolId: identity.schoolId, status: 'APPROVED' }, select: { id: true } } } });
  const now = new Date();
  if (!tournament || tournament.registrationOpensAt && tournament.registrationOpensAt > now || tournament.registrationClosesAt && tournament.registrationClosesAt <= now) return res.status(409).json({ error: 'TOURNAMENT_REGISTRATION_CLOSED' });
  if (!tournament.schools.length) return res.status(403).json({ error: 'SCHOOL_REGISTRATION_APPROVAL_REQUIRED' });
  const participant = await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT id FROM CompetitionTournament WHERE id = ${tournament.id} FOR UPDATE`;
    const existing = await transaction.competitionTournamentParticipant.findUnique({ where: { tournamentId_pupilId: { tournamentId: tournament.id, pupilId: identity.pupilId } }, select: { id: true, status: true, registeredAt: true, nominatedAt: true, guardianConsentStatus: true } });
    if (existing?.status === 'INVITED' && existing.nominatedAt && !existing.guardianConsentStatus) {
      return transaction.competitionTournamentParticipant.update({ where: { id: existing.id }, data: { status: 'PENDING', guardianConsentStatus: 'ACCEPTED', guardianConsentAt: new Date(), guardianConsentGuardianId: req.competitionGuardian!.id }, select: { id: true, status: true, registeredAt: true } });
    }
    if (existing?.guardianConsentStatus === 'DECLINED' || existing?.status === 'WITHDRAWN') throw new Error('TOURNAMENT_PARTICIPATION_DECLINED');
    if (existing) return { id: existing.id, status: existing.status, registeredAt: existing.registeredAt };
    const count = await transaction.competitionTournamentParticipant.count({ where: { tournamentId: tournament.id, status: { notIn: ['WITHDRAWN', 'DISQUALIFIED'] } } });
    if (tournament.participantLimit !== null && count >= tournament.participantLimit) throw new Error('TOURNAMENT_FULL');
    return transaction.competitionTournamentParticipant.create({ data: { tournamentId: tournament.id, schoolId: identity.schoolId, pupilId: identity.pupilId, classId: identity.classId, status: 'PENDING', displayNameSnapshot: `Student ${identity.pupilId.slice(-4)}`, visibilityApproved: false, guardianConsentStatus: 'ACCEPTED', guardianConsentAt: new Date(), guardianConsentGuardianId: req.competitionGuardian!.id }, select: { id: true, status: true, registeredAt: true } });
  }).catch((registerError: unknown) => {
    if (registerError instanceof Error && registerError.message === 'TOURNAMENT_FULL') return null;
    if (registerError instanceof Error && registerError.message === 'TOURNAMENT_PARTICIPATION_DECLINED') return 'DECLINED' as const;
    throw registerError;
  });
  if (participant === 'DECLINED') return res.status(409).json({ error: 'TOURNAMENT_PARTICIPATION_DECLINED' });
  if (!participant) return res.status(409).json({ error: 'TOURNAMENT_FULL' });
  res.status(201).json({ participant });
});

router.post('/school/tournaments/:tournamentId/decline-invitation', requireSession, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  if (!req.competitionGuardian) return res.status(403).json({ error: 'GUARDIAN_SESSION_REQUIRED' });
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  const participant = await prisma.competitionTournamentParticipant.findFirst({ where: { tournamentId: req.params.tournamentId, pupilId: identity.pupilId, schoolId: identity.schoolId, status: 'INVITED', nominatedAt: { not: null }, guardianConsentStatus: null }, select: { id: true } });
  if (!participant) return res.status(404).json({ error: 'TOURNAMENT_INVITATION_NOT_FOUND' });
  const updated = await prisma.competitionTournamentParticipant.updateMany({ where: { id: participant.id, status: 'INVITED', guardianConsentStatus: null }, data: { status: 'WITHDRAWN', guardianConsentStatus: 'DECLINED', guardianConsentAt: new Date(), guardianConsentGuardianId: req.competitionGuardian.id } });
  if (updated.count !== 1) return res.status(409).json({ error: 'TOURNAMENT_INVITATION_ALREADY_DECIDED' });
  await prisma.competitionAuditLog.create({ data: { schoolId: identity.schoolId, action: 'TOURNAMENT_GUARDIAN_DECLINED', entityType: 'CompetitionTournamentParticipant', entityId: participant.id, afterJson: JSON.stringify({ guardianId: req.competitionGuardian.id, decision: 'DECLINED' }) } });
  res.json({ success: true, status: 'WITHDRAWN' });
});

router.patch('/admin/tournaments/:tournamentId/schools/:schoolRegistrationId', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const status = req.body?.status;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : '';
  if (!['APPROVED', 'WITHDRAWN'].includes(status) || !reason) return res.status(400).json({ error: 'REGISTRATION_DECISION_REQUIRED' });
  const registration = await prisma.competitionTournamentSchool.findFirst({ where: { id: req.params.schoolRegistrationId, tournamentId: req.params.tournamentId, status: 'PENDING' }, select: { id: true, schoolId: true } });
  if (!registration) return res.status(404).json({ error: 'SCHOOL_REGISTRATION_NOT_FOUND' });
  const updated = await prisma.competitionTournamentSchool.update({ where: { id: registration.id }, data: { status, ...(status === 'APPROVED' ? { approvedAt: new Date(), approvedByUserId: req.competitionUser?.id } : {}), decisionReason: reason }, select: { id: true, schoolId: true, status: true, approvedAt: true } });
  if (status === 'WITHDRAWN') await prisma.competitionTournamentParticipant.updateMany({ where: { tournamentId: req.params.tournamentId, schoolId: registration.schoolId, status: 'PENDING' }, data: { status: 'WITHDRAWN' } });
  await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: `TOURNAMENT_SCHOOL_${status}`, entityType: 'CompetitionTournamentSchool', entityId: updated.id, reason } });
  res.json({ registration: updated });
});

router.patch('/admin/tournaments/:tournamentId/participants/:participantId', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const status = req.body?.status;
  const visibilityApproved = req.body?.visibilityApproved;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : '';
  if (!['APPROVED', 'WITHDRAWN', 'DISQUALIFIED'].includes(status) || typeof visibilityApproved !== 'boolean' || !reason) return res.status(400).json({ error: 'PARTICIPANT_DECISION_REQUIRED' });
  const participant = await prisma.competitionTournamentParticipant.findFirst({ where: { id: req.params.participantId, tournamentId: req.params.tournamentId, status: 'PENDING' }, select: { id: true, schoolId: true, guardianConsentStatus: true } });
  if (!participant) return res.status(404).json({ error: 'PARTICIPANT_NOT_FOUND' });
  if (status === 'APPROVED' && participant.guardianConsentStatus !== 'ACCEPTED') return res.status(409).json({ error: 'GUARDIAN_OPT_IN_REQUIRED' });
  if (status === 'APPROVED') {
    const schoolRegistration = await prisma.competitionTournamentSchool.findFirst({ where: { tournamentId: req.params.tournamentId, schoolId: participant.schoolId, status: 'APPROVED' }, select: { id: true } });
    if (!schoolRegistration) return res.status(409).json({ error: 'SCHOOL_REGISTRATION_APPROVAL_REQUIRED' });
  }
  const updated = await prisma.competitionTournamentParticipant.update({ where: { id: participant.id }, data: { status, visibilityApproved, ...(status === 'APPROVED' ? { approvedAt: new Date() } : {}) }, select: { id: true, status: true, visibilityApproved: true, approvedAt: true } });
  await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: `TOURNAMENT_PARTICIPANT_${status}`, entityType: 'CompetitionTournamentParticipant', entityId: updated.id, reason, afterJson: JSON.stringify({ visibilityApproved }) } });
  res.json({ participant: updated });
});

router.post('/admin/tournaments/:tournamentId/rounds', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const roundNumber = req.body?.roundNumber;
  if (!name || name.length > 120 || !Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > 100) return res.status(400).json({ error: 'INVALID_TOURNAMENT_ROUND' });
  let startsAt: Date | null;
  let endsAt: Date | null;
  try { startsAt = parseCompetitionTournamentDate(req.body?.startsAt); endsAt = parseCompetitionTournamentDate(req.body?.endsAt); } catch { return res.status(400).json({ error: 'INVALID_ROUND_DATES' }); }
  if (startsAt && endsAt && startsAt >= endsAt) return res.status(400).json({ error: 'INVALID_ROUND_DATES' });
  const tournament = await prisma.competitionTournament.findUnique({ where: { id: req.params.tournamentId }, select: { id: true, status: true } });
  if (!tournament || !['REGISTRATION_CLOSED', 'LIVE'].includes(tournament.status)) return res.status(409).json({ error: 'TOURNAMENT_NOT_READY_FOR_ROUNDS' });
  try {
    const round = await prisma.competitionTournamentRound.create({ data: { tournamentId: tournament.id, name, roundNumber, startsAt, endsAt } });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'TOURNAMENT_ROUND_CREATED', entityType: 'CompetitionTournamentRound', entityId: round.id } });
    res.status(201).json({ round });
  } catch (error) {
    if (isPrismaUniqueError(error)) return res.status(409).json({ error: 'ROUND_NUMBER_EXISTS' });
    console.error('[competition] tournament round creation failed', error);
    res.status(500).json({ error: 'ROUND_CREATE_FAILED' });
  }
});

router.post('/admin/tournaments/rounds/:roundId/matches', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { homeParticipantId, awayParticipantId } = req.body ?? {};
  if (typeof homeParticipantId !== 'string' || typeof awayParticipantId !== 'string' || homeParticipantId === awayParticipantId) return res.status(400).json({ error: 'MATCH_PARTICIPANTS_REQUIRED' });
  let scheduledAt: Date | null;
  try { scheduledAt = parseCompetitionTournamentDate(req.body?.scheduledAt); } catch { return res.status(400).json({ error: 'INVALID_MATCH_DATE' }); }
  const round = await prisma.competitionTournamentRound.findUnique({ where: { id: req.params.roundId }, select: { id: true, tournamentId: true, status: true, tournament: { select: { status: true } } } });
  if (!round || !['PENDING', 'LIVE'].includes(round.status) || !['REGISTRATION_CLOSED', 'LIVE'].includes(round.tournament.status)) return res.status(409).json({ error: 'ROUND_NOT_READY' });
  const participants = await prisma.competitionTournamentParticipant.findMany({ where: { id: { in: [homeParticipantId, awayParticipantId] }, tournamentId: round.tournamentId, status: 'APPROVED' }, select: { id: true } });
  if (participants.length !== 2) return res.status(400).json({ error: 'APPROVED_MATCH_PARTICIPANTS_REQUIRED' });
  const match = await prisma.competitionTournamentMatch.create({ data: { roundId: round.id, homeParticipantId, awayParticipantId, scheduledAt } });
  await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'TOURNAMENT_MATCH_SCHEDULED', entityType: 'CompetitionTournamentMatch', entityId: match.id } });
  res.status(201).json({ match });
});

router.patch('/admin/tournaments/matches/:matchId/result', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { homeScore, awayScore } = req.body ?? {};
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : '';
  if (!Number.isInteger(homeScore) || homeScore < 0 || homeScore > 1_000_000 || !Number.isInteger(awayScore) || awayScore < 0 || awayScore > 1_000_000 || !reason) return res.status(400).json({ error: 'MATCH_RESULT_AND_REASON_REQUIRED' });
  const match = await prisma.competitionTournamentMatch.findUnique({ where: { id: req.params.matchId }, include: { round: { select: { id: true, status: true, tournamentId: true, tournament: { select: { status: true } } } } } });
  if (!match || !['LIVE', 'DISPUTED', 'SCHEDULED'].includes(match.status) || match.round.status === 'CANCELLED' || match.round.tournament.status !== 'LIVE') return res.status(409).json({ error: 'MATCH_NOT_OPEN_FOR_RESULT' });
  const winnerParticipantId = homeScore === awayScore ? null : homeScore > awayScore ? match.homeParticipantId : match.awayParticipantId;
  const updated = await prisma.competitionTournamentMatch.updateMany({ where: { id: match.id, status: match.status }, data: { homeScore, awayScore, winnerParticipantId, completedAt: new Date(), status: 'COMPLETED', resultJson: JSON.stringify({ reason }) } });
  if (!updated.count) return res.status(409).json({ error: 'MATCH_STATE_CHANGED' });
  await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'TOURNAMENT_MATCH_RESULT_RECORDED', entityType: 'CompetitionTournamentMatch', entityId: match.id, reason, beforeJson: JSON.stringify({ status: match.status, homeScore: match.homeScore, awayScore: match.awayScore }), afterJson: JSON.stringify({ status: 'COMPLETED', homeScore, awayScore, winnerParticipantId }) } });
  res.json({ success: true, winnerParticipantId, status: 'COMPLETED' });
});

router.get('/admin/sponsors', requireSession, requirePlatformAdmin, async (_req, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.sponsors.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const [sponsors, advertisers] = await Promise.all([
    prisma.competitionSponsor.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { advertiser: { select: { companyName: true, website: true, verificationStatus: true } }, _count: { select: { tournaments: true, prizes: true } } } }),
    prisma.advertiser.findMany({ where: { verificationStatus: 'VERIFIED', competitionSponsor: null }, select: { id: true, companyName: true, website: true, verificationStatus: true }, orderBy: { companyName: 'asc' }, take: 200 }),
  ]);
  res.json({ sponsors, advertisers });
});

router.post('/admin/sponsors', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.sponsors.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { advertiserId, sponsorshipLevel, startsAt, endsAt, prizeContribution, reason } = req.body ?? {};
  if (typeof advertiserId !== 'string' || !['PRIMARY', 'SECONDARY', 'PRIZE'].includes(sponsorshipLevel) || typeof reason !== 'string' || !reason.trim()) return res.status(400).json({ error: 'INVALID_SPONSOR' });
  let start: Date | null; let end: Date | null;
  try { start = parseCompetitionTournamentDate(startsAt); end = parseCompetitionTournamentDate(endsAt); } catch { return res.status(400).json({ error: 'INVALID_SPONSOR_DATES' }); }
  if (start && end && start >= end) return res.status(400).json({ error: 'INVALID_SPONSOR_DATES' });
  const advertiser = await prisma.advertiser.findFirst({ where: { id: advertiserId, verificationStatus: 'VERIFIED' }, select: { id: true } });
  if (!advertiser) return res.status(400).json({ error: 'VERIFIED_ADVERTISER_REQUIRED' });
  try {
    const sponsor = await prisma.competitionSponsor.create({ data: { advertiserId, sponsorshipLevel, startsAt: start, endsAt: end, prizeContribution: typeof prizeContribution === 'string' ? prizeContribution.trim().slice(0, 2000) : undefined, status: 'PENDING' } });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'COMPETITION_SPONSOR_CREATED', entityType: 'CompetitionSponsor', entityId: sponsor.id, reason: reason.trim().slice(0, 1000) } });
    res.status(201).json({ sponsor });
  } catch (error) {
    if (isPrismaUniqueError(error)) return res.status(409).json({ error: 'SPONSOR_ALREADY_EXISTS' });
    console.error('[competition] sponsor creation failed', error);
    res.status(500).json({ error: 'SPONSOR_CREATE_FAILED' });
  }
});

router.patch('/admin/sponsors/:sponsorId/status', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.sponsors.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { status, reason } = req.body ?? {};
  if (!['APPROVED', 'REJECTED', 'PAUSED'].includes(status) || typeof reason !== 'string' || !reason.trim()) return res.status(400).json({ error: 'SPONSOR_DECISION_REQUIRED' });
  const sponsor = await prisma.competitionSponsor.findUnique({ where: { id: req.params.sponsorId }, include: { advertiser: { select: { verificationStatus: true } } } });
  if (!sponsor) return res.status(404).json({ error: 'SPONSOR_NOT_FOUND' });
  if (status === 'APPROVED' && sponsor.advertiser.verificationStatus !== 'VERIFIED') return res.status(409).json({ error: 'VERIFIED_ADVERTISER_REQUIRED' });
  const updated = await prisma.competitionSponsor.update({ where: { id: sponsor.id }, data: { status, approvedAt: status === 'APPROVED' ? new Date() : null } });
  await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: `COMPETITION_SPONSOR_${status}`, entityType: 'CompetitionSponsor', entityId: sponsor.id, reason: reason.trim().slice(0, 1000), beforeJson: JSON.stringify({ status: sponsor.status }), afterJson: JSON.stringify({ status }) } });
  res.json({ sponsor: updated });
});

router.post('/admin/tournaments/:tournamentId/sponsors', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.sponsors.enabled')) || !(await resolveCompetitionFeature(prisma, 'competition.schoolTournament.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { sponsorId, level, deliverables } = req.body ?? {};
  if (typeof sponsorId !== 'string' || !['PRIMARY', 'SECONDARY', 'PRIZE'].includes(level) || !Array.isArray(deliverables) || deliverables.length > 30 || deliverables.some((item) => typeof item !== 'string' || !item.trim() || item.length > 300)) return res.status(400).json({ error: 'INVALID_SPONSOR_DELIVERABLES' });
  const sponsor = await prisma.competitionSponsor.findFirst({ where: { id: sponsorId, status: 'APPROVED', advertiser: { verificationStatus: 'VERIFIED' } }, select: { id: true } });
  const tournament = await prisma.competitionTournament.findFirst({ where: { id: req.params.tournamentId, scope: { in: ['SCHOOL', 'CLASS'] }, status: { notIn: ['COMPLETED', 'CANCELLED'] } }, select: { id: true } });
  if (!sponsor || !tournament) return res.status(404).json({ error: 'APPROVED_SPONSOR_OR_TOURNAMENT_REQUIRED' });
  try {
    const link = await prisma.competitionTournamentSponsor.create({ data: { sponsorId, tournamentId: tournament.id, level, deliverablesJson: JSON.stringify(deliverables.map((item: string) => item.trim())), approvedAt: new Date() } });
    await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'TOURNAMENT_SPONSOR_ATTACHED', entityType: 'CompetitionTournamentSponsor', entityId: link.id, afterJson: JSON.stringify({ sponsorId, tournamentId: tournament.id, level }) } });
    res.status(201).json({ sponsor: link });
  } catch (error) {
    if (isPrismaUniqueError(error)) return res.status(409).json({ error: 'SPONSOR_ALREADY_ATTACHED' });
    console.error('[competition] tournament sponsor attach failed', error);
    res.status(500).json({ error: 'SPONSOR_ATTACH_FAILED' });
  }
});

router.get('/admin/tournaments/:tournamentId/prizes', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.prizes.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const prizes = await prisma.competitionPrize.findMany({ where: { tournamentId: req.params.tournamentId }, select: { id: true, name: true, description: true, valueMinor: true, currency: true, status: true, awardedAt: true, fulfilledAt: true, fulfillmentNotes: true, recipient: { select: { id: true, firstName: true, lastName: true } }, participant: { select: { id: true, displayNameSnapshot: true, visibilityApproved: true } }, sponsor: { select: { id: true, advertiser: { select: { companyName: true } } } } }, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json({ prizes });
});

router.post('/admin/tournaments/:tournamentId/prizes', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.prizes.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { name, description, valueMinor, currency = 'NGN', sponsorId, reason } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 160 || typeof reason !== 'string' || !reason.trim() || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || valueMinor !== undefined && valueMinor !== null && (!Number.isSafeInteger(valueMinor) || valueMinor < 0 || valueMinor > 2_147_483_647)) return res.status(400).json({ error: 'INVALID_PRIZE' });
  const tournament = await prisma.competitionTournament.findFirst({ where: { id: req.params.tournamentId, scope: { in: ['SCHOOL', 'CLASS'] }, status: { notIn: ['CANCELLED'] } }, select: { id: true, schoolId: true } });
  if (!tournament) return res.status(404).json({ error: 'TOURNAMENT_NOT_FOUND' });
  if (sponsorId && !(await prisma.competitionTournamentSponsor.findFirst({ where: { tournamentId: tournament.id, sponsorId, sponsor: { status: 'APPROVED', advertiser: { verificationStatus: 'VERIFIED' } } }, select: { id: true } }))) return res.status(400).json({ error: 'APPROVED_EVENT_SPONSOR_REQUIRED' });
  const prize = await prisma.competitionPrize.create({ data: { tournamentId: tournament.id, schoolId: tournament.schoolId, sponsorId: typeof sponsorId === 'string' ? sponsorId : null, name: name.trim(), description: typeof description === 'string' ? description.trim().slice(0, 2000) : null, valueMinor: valueMinor ?? null, currency } });
  await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'TOURNAMENT_PRIZE_CREATED', entityType: 'CompetitionPrize', entityId: prize.id, reason: reason.trim().slice(0, 1000) } });
  res.status(201).json({ prize });
});

router.patch('/admin/prizes/:prizeId/status', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.prizes.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { status, participantId, reason } = req.body ?? {};
  if (!['AWARDED', 'FULFILLING', 'FULFILLED', 'CANCELLED'].includes(status) || typeof reason !== 'string' || !reason.trim()) return res.status(400).json({ error: 'PRIZE_DECISION_REQUIRED' });
  const prize = await prisma.competitionPrize.findUnique({ where: { id: req.params.prizeId }, select: { id: true, tournamentId: true, status: true, participantId: true, recipientPupilId: true } });
  if (!prize) return res.status(404).json({ error: 'PRIZE_NOT_FOUND' });
  const validNext: Record<string, string[]> = { AVAILABLE: ['AWARDED', 'CANCELLED'], AWARDED: ['FULFILLING', 'CANCELLED'], FULFILLING: ['FULFILLED', 'CANCELLED'], FULFILLED: [], CANCELLED: [] };
  if (!validNext[prize.status]?.includes(status)) return res.status(409).json({ error: 'PRIZE_TRANSITION_NOT_ALLOWED' });
  let resolvedParticipantId = prize.participantId;
  let recipientPupilId = prize.recipientPupilId;
  if (status === 'AWARDED') {
    if (typeof participantId !== 'string') return res.status(400).json({ error: 'APPROVED_PARTICIPANT_REQUIRED' });
    const participant = await prisma.competitionTournamentParticipant.findFirst({ where: { id: participantId, tournamentId: prize.tournamentId, status: 'APPROVED' }, select: { id: true, pupilId: true } });
    if (!participant) return res.status(400).json({ error: 'APPROVED_PARTICIPANT_REQUIRED' });
    resolvedParticipantId = participant.id;
    recipientPupilId = participant.pupilId;
  }
  if (status === 'FULFILLED' && !prize.participantId) return res.status(409).json({ error: 'PRIZE_RECIPIENT_REQUIRED' });
  const updated = await prisma.competitionPrize.update({ where: { id: prize.id }, data: { status, participantId: resolvedParticipantId, recipientPupilId, ...(status === 'AWARDED' ? { awardedAt: new Date() } : {}), ...(status === 'FULFILLED' ? { fulfilledAt: new Date(), fulfillmentNotes: reason.trim().slice(0, 2000) } : {}) } });
  await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: `TOURNAMENT_PRIZE_${status}`, entityType: 'CompetitionPrize', entityId: prize.id, reason: reason.trim().slice(0, 1000), beforeJson: JSON.stringify({ status: prize.status }), afterJson: JSON.stringify({ status }) } });
  res.json({ prize: updated });
});

router.post('/admin/tournaments/:tournamentId/certificates', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.certificates.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { participantId, achievementTitle, reason } = req.body ?? {};
  if (typeof participantId !== 'string' || typeof achievementTitle !== 'string' || !achievementTitle.trim() || achievementTitle.trim().length > 191 || typeof reason !== 'string' || !reason.trim()) return res.status(400).json({ error: 'CERTIFICATE_ISSUE_DETAILS_REQUIRED' });
  const participant = await prisma.competitionTournamentParticipant.findFirst({ where: { id: participantId, tournamentId: req.params.tournamentId, status: 'APPROVED', visibilityApproved: true }, select: { id: true, pupilId: true, schoolId: true, displayNameSnapshot: true, tournament: { select: { title: true, status: true } }, school: { select: { name: true } } } });
  if (!participant || participant.tournament.status !== 'COMPLETED') return res.status(409).json({ error: 'COMPLETED_TOURNAMENT_AND_VISIBLE_PARTICIPANT_REQUIRED' });
  const certificateCode = randomBytes(32).toString('hex');
  const certificateCodeHash = createHash('sha256').update(certificateCode).digest('hex');
  const certificate = await prisma.competitionCertificate.create({ data: { schoolId: participant.schoolId, tournamentId: req.params.tournamentId, participantId: participant.id, pupilId: participant.pupilId, certificateCodeHash, displayNameSnapshot: participant.displayNameSnapshot, schoolNameSnapshot: participant.school.name, achievementTitle: achievementTitle.trim() } });
  await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'TOURNAMENT_CERTIFICATE_ISSUED', entityType: 'CompetitionCertificate', entityId: certificate.id, reason: reason.trim().slice(0, 1000) } });
  res.status(201).json({ certificate: { id: certificate.id, displayNameSnapshot: certificate.displayNameSnapshot, schoolNameSnapshot: certificate.schoolNameSnapshot, achievementTitle: certificate.achievementTitle, issuedAt: certificate.issuedAt }, verificationCode: certificateCode });
});

router.get('/admin/tournaments/:tournamentId/certificates', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.certificates.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const certificates = await prisma.competitionCertificate.findMany({ where: { tournamentId: req.params.tournamentId }, select: { id: true, displayNameSnapshot: true, schoolNameSnapshot: true, achievementTitle: true, issuedAt: true, status: true, revokedAt: true, revokedReason: true }, orderBy: { issuedAt: 'desc' }, take: 200 });
  res.json({ certificates });
});

router.patch('/admin/certificates/:certificateId/revoke', requireSession, requirePlatformAdmin, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.certificates.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : '';
  if (!reason) return res.status(400).json({ error: 'CERTIFICATE_REVOCATION_REASON_REQUIRED' });
  const certificate = await prisma.competitionCertificate.findFirst({ where: { id: req.params.certificateId, status: 'ISSUED' }, select: { id: true, status: true } });
  if (!certificate) return res.status(404).json({ error: 'ISSUED_CERTIFICATE_NOT_FOUND' });
  const updated = await prisma.competitionCertificate.update({ where: { id: certificate.id }, data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: reason }, select: { id: true, status: true, revokedAt: true } });
  await prisma.competitionAuditLog.create({ data: { actorUserId: req.competitionUser?.id, action: 'TOURNAMENT_CERTIFICATE_REVOKED', entityType: 'CompetitionCertificate', entityId: certificate.id, reason } });
  res.json({ certificate: updated });
});

router.get('/certificates/verify/:code', async (req, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.certificates.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const code = req.params.code;
  if (!/^[a-f0-9]{64}$/.test(code)) return res.status(400).json({ error: 'INVALID_CERTIFICATE_CODE' });
  const certificate = await prisma.competitionCertificate.findUnique({ where: { certificateCodeHash: createHash('sha256').update(code).digest('hex') }, select: { displayNameSnapshot: true, schoolNameSnapshot: true, achievementTitle: true, issuedAt: true, status: true, tournament: { select: { title: true } } } });
  if (!certificate) return res.status(404).json({ error: 'CERTIFICATE_NOT_FOUND' });
  res.json({ valid: certificate.status === 'ISSUED', status: certificate.status, recipient: certificate.displayNameSnapshot, school: certificate.schoolNameSnapshot, achievement: certificate.achievementTitle, tournament: certificate.tournament?.title ?? null, issuedAt: certificate.issuedAt });
});

router.get('/school/overview', requireSession, requireSchoolStaff, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.dailyChallenge.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const schoolId = req.competitionUser!.schoolId!;
  if (req.competitionUser!.role === 'TEACHER') {
    const assignments = await prisma.teacherClass.findMany({ where: { schoolId, teacherId: req.competitionUser!.id }, select: { classId: true } });
    const classIds = assignments.map((item) => item.classId);
    const [attempts, challenges] = await Promise.all([
      prisma.competitionChallengeAttempt.count({ where: { schoolId, classId: { in: classIds } } }),
      prisma.competitionChallenge.count({ where: { status: 'ACTIVE', schoolId, OR: [{ classId: { in: classIds } }, { classId: null }] } }),
    ]);
    return res.json({ attempts, challenges, assignedClasses: classIds.length });
  }
  const [attempts, challenges, tournaments, participants] = await Promise.all([
    prisma.competitionChallengeAttempt.count({ where: { schoolId } }),
    prisma.competitionChallenge.count({ where: { status: 'ACTIVE', OR: [{ schoolId }, { schoolId: null }] } }),
    prisma.competitionTournamentSchool.count({ where: { schoolId } }),
    prisma.competitionTournamentParticipant.count({ where: { schoolId, status: 'APPROVED' } }),
  ]);
  res.json({ attempts, challenges, tournaments, participants });
});

router.get('/school/student-links', requireSession, async (req: CompetitionRequest, res) => {
  if (req.competitionUser?.role !== 'SCHOOL_ADMIN' || !req.competitionUser.schoolId) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });
  if (!(await resolveCompetitionFeature(prisma, 'competition.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const schoolId = req.competitionUser.schoolId;
  const [pupils, links] = await Promise.all([
    prisma.pupil.findMany({
      where: { schoolId, isActive: true, OR: [{ status: null }, { status: { not: 'INACTIVE' } }] },
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
        admissionNo: true,
        class: { select: { name: true } },
        guardians: {
          select: {
            relation: true,
            guardian: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phone: true,
                whatsapp: true,
                email: true,
              },
            },
          },
        },
        competitionAccount: { select: { id: true, userId: true, status: true } },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: 500,
    }),
    prisma.competitionPupilAccount.findMany({
      where: { schoolId },
      select: {
        id: true,
        pupilId: true,
        userId: true,
        status: true,
        linkedAt: true,
        pupil: { select: { firstName: true, lastName: true, admissionNo: true, class: { select: { name: true } } } },
        user: { select: { name: true } },
        guardian: { select: { firstName: true, lastName: true, phone: true, whatsapp: true, email: true } },
      },
      orderBy: { linkedAt: 'desc' },
      take: 500,
    }),
  ]);
  res.json({ pupils, links });
});

router.post('/school/student-links', requireSession, async (req: CompetitionRequest, res) => {
  if (req.competitionUser?.role !== 'SCHOOL_ADMIN' || !req.competitionUser.schoolId) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });
  if (!(await resolveCompetitionFeature(prisma, 'competition.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const { pupilId, guardianId } = req.body ?? {};
  if (typeof pupilId !== 'string' || typeof guardianId !== 'string') return res.status(400).json({ error: 'PUPIL_AND_GUARDIAN_REQUIRED' });
  const schoolId = req.competitionUser.schoolId;
  try {
    const link = await prisma.$transaction(async (transaction) => {
      const [pupil, guardianLink] = await Promise.all([
        transaction.pupil.findFirst({ where: { id: pupilId, schoolId, isActive: true, OR: [{ status: null }, { status: { not: 'INACTIVE' } }] }, select: { id: true } }),
        transaction.guardianPupil.findFirst({ where: { pupilId, guardianId, guardian: { schoolId } }, select: { guardianId: true } }),
      ]);
      if (!pupil || !guardianLink) throw new Error('PUPIL_OR_GUARDIAN_NOT_ELIGIBLE');
      return transaction.competitionPupilAccount.create({ data: { schoolId, pupilId, guardianId, linkedByUserId: req.competitionUser!.id } });
    });
    await prisma.competitionAuditLog.create({ data: { schoolId, actorUserId: req.competitionUser.id, action: 'STUDENT_PUPIL_ACCOUNT_LINKED', entityType: 'CompetitionPupilAccount', entityId: link.id, reason: 'School administrator linked an existing SchoolBase guardian relationship to an active pupil.' } });
    res.status(201).json({ link: { id: link.id, pupilId: link.pupilId, guardianId: link.guardianId, status: link.status } });
  } catch (error) {
    if (isPrismaUniqueError(error)) return res.status(409).json({ error: 'PUPIL_ALREADY_LINKED' });
    if (error instanceof Error && error.message === 'PUPIL_OR_GUARDIAN_NOT_ELIGIBLE') return res.status(400).json({ error: error.message });
    console.error('[competition] pupil account linking failed', error);
    res.status(500).json({ error: 'PARENT_ACCOUNT_LINK_FAILED' });
  }
});

router.delete('/school/student-links/:linkId', requireSession, async (req: CompetitionRequest, res) => {
  if (req.competitionUser?.role !== 'SCHOOL_ADMIN' || !req.competitionUser.schoolId) return res.status(403).json({ error: 'SCHOOL_ADMIN_REQUIRED' });
  if (!(await resolveCompetitionFeature(prisma, 'competition.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const link = await prisma.competitionPupilAccount.findFirst({ where: { id: req.params.linkId, schoolId: req.competitionUser.schoolId, status: 'ACTIVE' }, select: { id: true, pupilId: true, guardianId: true, userId: true } });
  if (!link) return res.status(404).json({ error: 'ACTIVE_LINK_NOT_FOUND' });
  await prisma.competitionPupilAccount.update({ where: { id: link.id }, data: { status: 'REVOKED', revokedAt: new Date() } });
  await prisma.competitionAuditLog.create({ data: { schoolId: req.competitionUser.schoolId, actorUserId: req.competitionUser.id, action: 'STUDENT_PUPIL_ACCOUNT_LINK_REVOKED', entityType: 'CompetitionPupilAccount', entityId: link.id, reason: 'School administrator revoked the guardian-to-pupil Competition link.' } });
  res.json({ success: true });
});

router.get('/student/challenges', requireSession, async (req: CompetitionRequest, res) => {
  const [dailyChallengeEnabled, examPracticeEnabled] = await Promise.all([
    resolveCompetitionFeature(prisma, 'competition.dailyChallenge.enabled'),
    resolveCompetitionFeature(prisma, 'competition.examPractice.enabled'),
  ]);
  if (!dailyChallengeEnabled && !examPracticeEnabled) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  const now = new Date();
  const practiceTypeFilters = [
    ...(dailyChallengeEnabled ? [{ examPractice: null }] : []),
    ...(examPracticeEnabled ? [{ examPractice: { isActive: true } }] : []),
  ];
  const candidateChallenges = await prisma.competitionChallenge.findMany({
    where: {
      status: 'ACTIVE',
      questionSet: { status: 'APPROVED' },
      AND: [{ OR: [{ schoolId: null }, { schoolId: identity.schoolId }] }, { OR: [{ classId: null }, { classId: identity.classId }] }, { OR: [{ opensAt: null }, { opensAt: { lte: now } }] }, { OR: [{ closesAt: null }, { closesAt: { gte: now } }] }, { OR: practiceTypeFilters }],
    },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      gradeLabel: true,
      questionCount: true,
      durationSeconds: true,
      opensAt: true,
      closesAt: true,
      attemptLimit: true,
      questionSet: { select: { status: true } },
      examPractice: { select: { id: true, isActive: true, examCode: true, countryCode: true, gradeLabel: true, format: true, syllabusVersion: true, subjectCategory: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const [pupil, classRecord] = await Promise.all([
    prisma.pupil.findUnique({ where: { id: identity.pupilId }, select: { firstName: true, lastName: true, photoUrl: true, school: { select: { country: true } } } }),
    identity.classId ? prisma.class.findUnique({ where: { id: identity.classId }, select: { name: true } }) : null,
  ]);
  const eligibleChallenges = candidateChallenges.filter((challenge) => challenge.examPractice
    ? examPracticeEnabled && isEligibleForCompetitionExamPractice({
      practice: { ...challenge.examPractice, subjectName: challenge.examPractice.subjectCategory.name },
      schoolCountry: pupil?.school.country,
      className: classRecord?.name,
      challengeStatus: challenge.status,
      questionSetStatus: challenge.questionSet.status,
      isActive: challenge.examPractice?.isActive,
    })
    : dailyChallengeEnabled && matchesCompetitionAudience({ audienceLabel: challenge.gradeLabel, className: classRecord?.name }));
  const attempts = await prisma.competitionChallengeAttempt.findMany({
    where: { pupilId: identity.pupilId, challengeId: { in: eligibleChallenges.map((item) => item.id) } },
    select: { id: true, challengeId: true, status: true, score: true, submittedAt: true },
    orderBy: { createdAt: 'desc' },
  });
  const practiceSummary = await prisma.competitionChallengeAttempt.aggregate({
    where: { pupilId: identity.pupilId, status: 'SUBMITTED' },
    _count: { _all: true },
    _max: { submittedAt: true },
  });
  const [leaderboardEnabled, studentVsStudentEnabled] = await Promise.all([
    resolveCompetitionFeature(prisma, 'competition.leaderboard.enabled'),
    resolveCompetitionFeature(prisma, 'competition.studentVsStudent.enabled'),
  ]);
  res.json({
    identity: { pupilId: identity.pupilId, classId: identity.classId, firstName: pupil?.firstName ?? null, lastName: pupil?.lastName ?? null, photoUrl: pupil?.photoUrl ?? null, className: classRecord?.name ?? null },
    capabilities: { leaderboardEnabled, studentVsStudentEnabled },
    challenges: eligibleChallenges.map(({ examPractice, ...challenge }) => ({ ...challenge, examPractice: examPractice ? { examCode: examPractice.examCode, countryCode: examPractice.countryCode, gradeLabel: examPractice.gradeLabel, format: examPractice.format, syllabusVersion: examPractice.syllabusVersion, subjectName: examPractice.subjectCategory.name } : null, attemptsUsed: attempts.filter((attempt) => attempt.challengeId === challenge.id && !['INVALIDATED', 'ABANDONED'].includes(attempt.status)).length })),
    ineligibleChallengeCount: candidateChallenges.length - eligibleChallenges.length,
    practiceSummary: { completedChallenges: practiceSummary._count._all, latestCompletionAt: practiceSummary._max.submittedAt },
    attempts,
  });
});

router.get('/student/challenges/:challengeId/leaderboard', requireSession, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.leaderboard.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  if (!identity.classId) return res.status(403).json({ error: 'CLASS_LEADERBOARD_UNAVAILABLE' });

  const challenge = await prisma.competitionChallenge.findFirst({
    where: {
      id: req.params.challengeId,
      status: { in: ['ACTIVE', 'PAUSED', 'COMPLETED'] },
      AND: [{ OR: [{ schoolId: null }, { schoolId: identity.schoolId }] }, { OR: [{ classId: null }, { classId: identity.classId }] }],
    },
    select: { id: true, title: true },
  });
  if (!challenge) return res.status(404).json({ error: 'CHALLENGE_NOT_FOUND' });

  const participated = await prisma.competitionChallengeAttempt.count({ where: { pupilId: identity.pupilId, challengeId: challenge.id, status: 'SUBMITTED' } });
  if (!participated) return res.status(403).json({ error: 'LEADERBOARD_PARTICIPATION_REQUIRED' });

  const attempts = await prisma.competitionChallengeAttempt.findMany({
    where: { schoolId: identity.schoolId, classId: identity.classId, challengeId: challenge.id, status: 'SUBMITTED' },
    select: { pupilId: true, score: true, accuracyPercent: true, elapsedMs: true, submittedAt: true, pupil: { select: { firstName: true, lastName: true } } },
    orderBy: { submittedAt: 'asc' },
    take: 500,
  });
  const entries = buildCompetitionLeaderboard(attempts.filter((attempt) => attempt.submittedAt).map((attempt) => ({
    pupilId: attempt.pupilId,
    firstName: attempt.pupil.firstName,
    lastName: attempt.pupil.lastName,
    score: attempt.score,
    accuracyPercent: attempt.accuracyPercent?.toNumber() ?? null,
    elapsedMs: attempt.elapsedMs,
    submittedAt: attempt.submittedAt!,
  })));
  res.json({ challenge: { id: challenge.id, title: challenge.title }, entries });
});

router.get('/student/matches', requireSession, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.studentVsStudent.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  const now = new Date();
  await prisma.competitionStudentChallenge.updateMany({ where: { status: 'PENDING', expiresAt: { lte: now }, OR: [{ senderPupilId: identity.pupilId }, { recipientPupilId: identity.pupilId }] }, data: { status: 'EXPIRED' } });
  const matches = await prisma.competitionStudentChallenge.findMany({
    where: { OR: [{ senderPupilId: identity.pupilId }, { recipientPupilId: identity.pupilId }] },
    include: {
      challenge: { select: { id: true, title: true } },
      sender: { select: { id: true, firstName: true, lastName: true, photoUrl: true } },
      recipient: { select: { id: true, firstName: true, lastName: true, photoUrl: true } },
      senderAttempt: { select: { id: true, status: true, score: true, accuracyPercent: true, elapsedMs: true, questions: { select: { questionId: true } } } },
      recipientAttempt: { select: { id: true, status: true, score: true, accuracyPercent: true, elapsedMs: true, questions: { select: { questionId: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const mask = (firstName: string, lastName: string) => `${firstName} ${lastName.trim().charAt(0)}.`;
  res.json({ matches: matches.map((match) => ({
    id: match.id,
    challenge: match.challenge,
    status: match.status,
    isSender: match.senderPupilId === identity.pupilId,
    opponentName: match.senderPupilId === identity.pupilId ? mask(match.recipient.firstName, match.recipient.lastName) : mask(match.sender.firstName, match.sender.lastName),
    opponentPhotoUrl: match.senderPupilId === identity.pupilId ? match.recipient.photoUrl : match.sender.photoUrl,
    expiresAt: match.expiresAt,
    createdAt: match.createdAt,
    acceptedAt: match.acceptedAt,
    completedAt: match.completedAt,
    winner: match.winnerPupilId === identity.pupilId ? 'YOU' : match.winnerPupilId ? 'OPPONENT' : null,
    yourAttempt: match.senderPupilId === identity.pupilId ? match.senderAttempt : match.recipientAttempt,
    opponentAttempt: match.senderPupilId === identity.pupilId ? match.recipientAttempt : match.senderAttempt,
  })) });
});

router.get('/student/challenges/:challengeId/peers', requireSession, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.studentVsStudent.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  if (!identity.classId) return res.status(403).json({ error: 'CLASS_PARTICIPATION_REQUIRED' });
  const now = new Date();
  const challenge = await prisma.competitionChallenge.findFirst({
    where: { id: req.params.challengeId, status: 'ACTIVE', AND: [{ OR: [{ schoolId: null }, { schoolId: identity.schoolId }] }, { OR: [{ classId: null }, { classId: identity.classId }] }, { OR: [{ opensAt: null }, { opensAt: { lte: now } }] }, { OR: [{ closesAt: null }, { closesAt: { gte: now } }] }] },
    select: { gradeLabel: true, opensAt: true },
  });
  if (!challenge) return res.status(404).json({ error: 'CHALLENGE_NOT_FOUND' });
  const [classRecord, sender] = await Promise.all([
    prisma.class.findUnique({ where: { id: identity.classId }, select: { name: true } }),
    prisma.pupil.findUnique({ where: { id: identity.pupilId }, select: { id: true } }),
  ]);
  if (!sender || !matchesCompetitionAudience({ audienceLabel: challenge.gradeLabel, className: classRecord?.name })) return res.status(403).json({ error: 'CHALLENGE_AUDIENCE_MISMATCH' });
  const candidates = await prisma.pupil.findMany({
    where: { schoolId: identity.schoolId, classId: identity.classId, id: { not: identity.pupilId }, isActive: true, OR: [{ status: null }, { status: { not: 'INACTIVE' } }], guardians: { some: { guardian: { schoolId: identity.schoolId } } } },
    select: { id: true, firstName: true, lastName: true },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    take: 100,
  });
  const peers = candidates
    .filter((candidate) => matchesCompetitionAudience({ audienceLabel: challenge.gradeLabel, className: classRecord?.name }))
    .map(({ id, firstName, lastName }) => ({ id, displayName: `${firstName} ${lastName.trim().charAt(0)}.` }));
  res.json({ peers });
});

router.post('/student/matches', requireSession, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.studentVsStudent.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  const { recipientPupilId, challengeId } = req.body ?? {};
  if (typeof recipientPupilId !== 'string' || typeof challengeId !== 'string' || recipientPupilId === identity.pupilId || !identity.classId) return res.status(400).json({ error: 'MATCH_PARTICIPANTS_REQUIRED' });
  const [sender, recipient, challenge] = await Promise.all([
    prisma.pupil.findFirst({ where: { id: identity.pupilId, schoolId: identity.schoolId, classId: identity.classId, isActive: true, OR: [{ status: null }, { status: { not: 'INACTIVE' } }] }, select: { id: true, dateOfBirth: true, class: { select: { name: true } } } }),
    prisma.pupil.findFirst({ where: { id: recipientPupilId, schoolId: identity.schoolId, classId: identity.classId, isActive: true, OR: [{ status: null }, { status: { not: 'INACTIVE' } }], guardians: { some: { guardian: { schoolId: identity.schoolId } } } }, select: { id: true, dateOfBirth: true, class: { select: { name: true } } } }),
    prisma.competitionChallenge.findFirst({ where: { id: challengeId, status: 'ACTIVE', AND: [{ OR: [{ schoolId: null }, { schoolId: identity.schoolId }] }, { OR: [{ classId: null }, { classId: identity.classId }] }, { OR: [{ opensAt: null }, { opensAt: { lte: new Date() } }] }, { OR: [{ closesAt: null }, { closesAt: { gte: new Date() } }] }] }, select: { id: true, gradeLabel: true, opensAt: true } }),
  ]);
  if (!sender || !recipient) return res.status(404).json({ error: 'MATCH_PARTICIPANT_UNAVAILABLE' });
  const senderHasCompleted = await prisma.competitionChallengeAttempt.count({ where: { pupilId: identity.pupilId, challengeId, status: 'SUBMITTED' } });
  if (!senderHasCompleted) return res.status(403).json({ error: 'MATCH_SENDER_COMPLETION_REQUIRED' });
  if (!challenge || !matchesCompetitionAudience({ audienceLabel: challenge.gradeLabel, className: sender.class?.name }) || !matchesCompetitionAudience({ audienceLabel: challenge.gradeLabel, className: recipient.class?.name })) return res.status(409).json({ error: 'MATCH_CHALLENGE_UNAVAILABLE' });
  const match = await prisma.$transaction(async (transaction) => {
    const participantIds = [identity.pupilId, recipientPupilId].sort();
    await transaction.$queryRaw`SELECT id FROM Pupil WHERE id = ${participantIds[0]} FOR UPDATE`;
    await transaction.$queryRaw`SELECT id FROM Pupil WHERE id = ${participantIds[1]} FOR UPDATE`;
    const priorMatch = await transaction.competitionStudentChallenge.findFirst({ where: { challengeId, status: { in: ['PENDING', 'ACCEPTED'] }, OR: [{ senderPupilId: identity.pupilId, recipientPupilId }, { senderPupilId: recipientPupilId, recipientPupilId: identity.pupilId }] }, select: { id: true } });
    if (priorMatch) throw new Error('MATCH_ALREADY_EXISTS');
    return transaction.competitionStudentChallenge.create({ data: { challengeId, senderPupilId: identity.pupilId, recipientPupilId, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }, select: { id: true, status: true, expiresAt: true } });
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'MATCH_ALREADY_EXISTS') return null;
    throw error;
  });
  if (!match) return res.status(409).json({ error: 'MATCH_ALREADY_EXISTS' });
  await prisma.competitionAuditLog.create({ data: { schoolId: identity.schoolId, actorUserId: identity.userId || undefined, action: 'STUDENT_CHALLENGE_INVITED', entityType: 'CompetitionStudentChallenge', entityId: match.id } });
  res.status(201).json({ match });
});

router.patch('/student/matches/:matchId', requireSession, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.studentVsStudent.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  const action = req.body?.action;
  if (!['ACCEPT', 'DECLINE', 'CANCEL'].includes(action)) return res.status(400).json({ error: 'INVALID_MATCH_ACTION' });
  const match = await prisma.competitionStudentChallenge.findFirst({ where: { id: req.params.matchId, OR: [{ senderPupilId: identity.pupilId }, { recipientPupilId: identity.pupilId }] }, select: { id: true, senderPupilId: true, recipientPupilId: true, status: true, expiresAt: true } });
  if (!match) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });
  if (match.status !== 'PENDING') return res.status(409).json({ error: 'MATCH_NOT_PENDING' });
  if (match.expiresAt <= new Date()) {
    await prisma.competitionStudentChallenge.update({ where: { id: match.id }, data: { status: 'EXPIRED' } });
    return res.status(409).json({ error: 'MATCH_EXPIRED' });
  }
  const isSender = match.senderPupilId === identity.pupilId;
  if ((action === 'ACCEPT' || action === 'DECLINE') && isSender) return res.status(403).json({ error: 'RECIPIENT_ACTION_REQUIRED' });
  if (action === 'CANCEL' && !isSender) return res.status(403).json({ error: 'SENDER_ACTION_REQUIRED' });
  const status = action === 'ACCEPT' ? 'ACCEPTED' : action === 'DECLINE' ? 'DECLINED' : 'CANCELLED';
  const updated = await prisma.competitionStudentChallenge.updateMany({ where: { id: match.id, status: 'PENDING', expiresAt: { gt: new Date() } }, data: { status, ...(action === 'ACCEPT' ? { acceptedAt: new Date() } : {}) } });
  if (updated.count !== 1) return res.status(409).json({ error: 'MATCH_STATE_CHANGED' });
  await prisma.competitionAuditLog.create({ data: { schoolId: identity.schoolId, actorUserId: identity.userId || undefined, action: `STUDENT_CHALLENGE_${status}`, entityType: 'CompetitionStudentChallenge', entityId: match.id } });
  res.json({ success: true, status });
});

router.post('/student/matches/:matchId/attempt', requireSession, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.studentVsStudent.enabled')) || !(await resolveCompetitionFeature(prisma, 'competition.dailyChallenge.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  const match = await prisma.competitionStudentChallenge.findFirst({
    where: {
      id: req.params.matchId,
      status: 'ACCEPTED',
      OR: [{ senderPupilId: identity.pupilId }, { recipientPupilId: identity.pupilId }],
    },
    include: {
      challenge: {
        include: {
          scoringPolicy: true,
          questionSet: {
            include: {
              questions: {
                where: { status: 'APPROVED' },
                select: {
                  id: true,
                  version: true,
                  options: { select: { id: true }, orderBy: { sortOrder: 'asc' } },
                },
              },
            },
          },
        },
      },
      senderAttempt: { select: { id: true, questions: { select: { questionId: true } } } },
      recipientAttempt: { select: { id: true, questions: { select: { questionId: true } } } },
    },
  });
  if (!match) return res.status(404).json({ error: 'ACCEPTED_MATCH_NOT_FOUND' });
  const isSender = match.senderPupilId === identity.pupilId;
  const assignedAttemptId = isSender ? match.senderAttemptId : match.recipientAttemptId;
  if (assignedAttemptId) return res.status(409).json({ error: 'MATCH_ATTEMPT_ALREADY_STARTED' });
  const challenge = match.challenge;
  const now = new Date();
  if (!['ACTIVE', 'PAUSED'].includes(challenge.status) || challenge.questionSet.questions.length < challenge.questionCount) return res.status(409).json({ error: 'MATCH_CHALLENGE_UNAVAILABLE' });
  const matchAttemptQuestions = match.senderAttempt?.questions ?? match.recipientAttempt?.questions ?? [];
  const sharedQuestionIds = matchAttemptQuestions.map((entry) => entry.questionId);
  const sharedQuestions: Array<{ id: string; version: number; options: Array<{ id: string }> }> = sharedQuestionIds.length
    ? sharedQuestionIds.flatMap((questionId) => challenge.questionSet.questions.filter((question) => question.id === questionId))
    : [];
  if (sharedQuestionIds.length && sharedQuestions.length !== challenge.questionCount) return res.status(409).json({ error: 'MATCH_QUESTION_SET_UNAVAILABLE' });
  const selectedQuestions: Array<{ id: string; version: number; options: Array<{ id: string }> }> = sharedQuestions.length === challenge.questionCount
    ? sharedQuestions
    : secureShuffle(challenge.questionSet.questions as Array<{ id: string; version: number; options: Array<{ id: string }> }>).slice(0, challenge.questionCount);
  const attemptIdempotencyKey = `student-match:${match.id}:${isSender ? 'sender' : 'recipient'}`;
  try {
    const attempt = await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM CompetitionStudentChallenge WHERE id = ${match.id} FOR UPDATE`;
      const currentMatch = await transaction.competitionStudentChallenge.findUnique({ where: { id: match.id }, select: { status: true, senderAttemptId: true, recipientAttemptId: true } });
      if (!currentMatch || currentMatch.status !== 'ACCEPTED') throw new Error('MATCH_NOT_ACTIVE');
      if ((isSender ? currentMatch.senderAttemptId : currentMatch.recipientAttemptId)) throw new Error('MATCH_ATTEMPT_ALREADY_STARTED');
      const created = await transaction.competitionChallengeAttempt.create({
        data: {
          schoolId: identity.schoolId,
          pupilId: identity.pupilId,
          classId: identity.classId,
          challengeId: challenge.id,
          academicYearId: challenge.academicYearId,
          termId: challenge.termId,
          scoringPolicyId: challenge.scoringPolicyId,
          attemptNumber: (await transaction.competitionChallengeAttempt.count({ where: { pupilId: identity.pupilId, challengeId: challenge.id } })) + 1,
          status: 'STARTED',
          idempotencyKey: attemptIdempotencyKey,
          startedAt: new Date(),
          deadlineAt: new Date(Date.now() + challenge.durationSeconds * 1000),
          questionCount: selectedQuestions.length,
          scoringPolicyVersion: challenge.scoringPolicy.version,
          scoringSnapshotJson: challenge.scoringPolicy.policyJson,
          questions: { create: selectedQuestions.map((question, position) => ({ questionId: question.id, position, questionVersion: question.version, optionOrderJson: JSON.stringify(secureShuffle(question.options as Array<{ id: string }>).map((option) => option.id)) })) },
        },
        include: {
          questions: {
            orderBy: { position: 'asc' },
            include: {
              question: {
                select: {
                  id: true,
                  prompt: true,
                  type: true,
                  options: { select: { id: true, content: true }, orderBy: { sortOrder: 'asc' } },
                },
              },
            },
          },
        },
      });
      await transaction.competitionStudentChallenge.update({ where: { id: match.id }, data: isSender ? { senderAttemptId: created.id } : { recipientAttemptId: created.id } });
      return created;
    });
    res.status(201).json({ attempt: presentAttempt(attempt) });
  } catch (error) {
    if (error instanceof Error && error.message === 'MATCH_NOT_ACTIVE') return res.status(409).json({ error: 'MATCH_NOT_ACTIVE' });
    if (error instanceof Error && error.message === 'MATCH_ATTEMPT_ALREADY_STARTED') return res.status(409).json({ error: 'MATCH_ATTEMPT_ALREADY_STARTED' });
    if (isPrismaUniqueError(error)) return res.status(409).json({ error: 'MATCH_ATTEMPT_ALREADY_STARTED' });
    console.error('[competition] matched attempt creation failed', error);
    res.status(500).json({ error: 'MATCH_ATTEMPT_CREATE_FAILED' });
  }
});

router.post('/student/challenges/:challengeId/attempts', requireSession, async (req: CompetitionRequest, res) => {
  if (!(await isChallengePracticeEnabled())) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  const idempotencyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : '';
  if (!idempotencyKey || idempotencyKey.length > 191) return res.status(400).json({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
  const now = new Date();
  const challengeQuestionInclude = {
    scoringPolicy: true,
    examPractice: { include: { subjectCategory: { select: { name: true } } } },
    questionSet: {
      include: {
        questions: {
          where: { status: 'APPROVED' as const },
          select: {
            id: true,
            version: true,
            basePoints: true,
            options: {
              select: { id: true, content: true },
              orderBy: { sortOrder: 'asc' as const },
            },
          },
        },
      },
    },
  };
  const challenge = await prisma.competitionChallenge.findFirst({
    where: { id: req.params.challengeId, status: 'ACTIVE', AND: [{ OR: [{ schoolId: null }, { schoolId: identity.schoolId }] }, { OR: [{ classId: null }, { classId: identity.classId }] }, { OR: [{ opensAt: null }, { opensAt: { lte: now } }] }, { OR: [{ closesAt: null }, { closesAt: { gte: now } }] }] },
    include: challengeQuestionInclude,
  });
  if (!challenge || challenge.questionSet.status !== 'APPROVED' || challenge.questionSet.questions.length < challenge.questionCount) return res.status(404).json({ error: 'CHALLENGE_UNAVAILABLE' });
  if (!(await resolveCompetitionFeature(prisma, challenge.examPractice ? 'competition.examPractice.enabled' : 'competition.dailyChallenge.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const [pupilAudience, learnerClass] = await Promise.all([
    prisma.pupil.findUnique({ where: { id: identity.pupilId }, select: { school: { select: { country: true } } } }),
    identity.classId ? prisma.class.findUnique({ where: { id: identity.classId }, select: { name: true } }) : null,
  ]);
  const audienceEligible = challenge.examPractice
    ? isEligibleForCompetitionExamPractice({ practice: { ...challenge.examPractice, subjectName: challenge.examPractice.subjectCategory.name }, schoolCountry: pupilAudience?.school.country, className: learnerClass?.name, challengeStatus: challenge.status, questionSetStatus: challenge.questionSet.status, isActive: challenge.examPractice.isActive })
    : matchesCompetitionAudience({ audienceLabel: challenge.gradeLabel, className: learnerClass?.name });
  if (!audienceEligible) {
    return res.status(403).json({ error: 'CHALLENGE_AUDIENCE_MISMATCH' });
  }
  const attemptQuestionInclude = {
    questions: {
      orderBy: { position: 'asc' as const },
      include: {
        question: {
          select: {
            id: true,
            prompt: true,
            type: true,
            options: { select: { id: true, content: true }, orderBy: { sortOrder: 'asc' as const } },
          },
        },
      },
    },
  };
  const existing = await prisma.competitionChallengeAttempt.findUnique({ where: { idempotencyKey }, include: attemptQuestionInclude });
  if (existing) {
    if (existing.pupilId !== identity.pupilId || existing.challengeId !== challenge.id) return res.status(409).json({ error: 'IDEMPOTENCY_KEY_CONFLICT' });
    return res.json({ attempt: presentAttempt(existing) });
  }

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const startOfNextDay = new Date(startOfDay);
  startOfNextDay.setDate(startOfNextDay.getDate() + 1);

  const todaysAttempts = await prisma.competitionChallengeAttempt.findMany({
    where: {
      pupilId: identity.pupilId,
      startedAt: { gte: startOfDay, lt: startOfNextDay },
    },
    select: {
      startedAt: true,
      challenge: { select: { examPractice: { select: { id: true } } } },
    },
  });
  const dailyLimitError = getCompetitionDailyLimitError(
    todaysAttempts,
    now,
    challenge.examPractice ? 'EXAM' : 'DAILY',
  );
  if (dailyLimitError) return res.status(409).json({ error: dailyLimitError, message: 'Please come back tomorrow.' });

  const selected = secureShuffle(challenge.questionSet.questions).slice(0, challenge.questionCount);
  const deadlineAt = new Date(now.getTime() + challenge.durationSeconds * 1000);
  try {
    const attempt = await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM Pupil WHERE id = ${identity.pupilId} FOR UPDATE`;
      const usedAttempts = await transaction.competitionChallengeAttempt.count({ where: { pupilId: identity.pupilId, challengeId: challenge.id, status: { notIn: ['INVALIDATED', 'ABANDONED'] } } });
      if (usedAttempts >= challenge.attemptLimit) throw new AttemptLimitError();
      const lastAttempt = await transaction.competitionChallengeAttempt.findFirst({ where: { pupilId: identity.pupilId, challengeId: challenge.id }, orderBy: { attemptNumber: 'desc' }, select: { attemptNumber: true } });
      return transaction.competitionChallengeAttempt.create({
        data: {
          schoolId: identity.schoolId,
          pupilId: identity.pupilId,
          classId: identity.classId,
          challengeId: challenge.id,
          academicYearId: challenge.academicYearId,
          termId: challenge.termId,
          scoringPolicyId: challenge.scoringPolicyId,
          attemptNumber: (lastAttempt?.attemptNumber ?? 0) + 1,
          status: 'STARTED',
          idempotencyKey,
          startedAt: now,
          deadlineAt,
          questionCount: selected.length,
          scoringPolicyVersion: challenge.scoringPolicy.version,
          scoringSnapshotJson: challenge.scoringPolicy.policyJson,
          questions: { create: selected.map((question, position) => ({ questionId: question.id, position, questionVersion: question.version, optionOrderJson: JSON.stringify(secureShuffle(question.options).map((option) => option.id)) })) },
        },
        include: attemptQuestionInclude,
      });
    });
    res.status(201).json({ attempt: presentAttempt(attempt) });
  } catch (error) {
    if (error instanceof AttemptLimitError) return res.status(409).json({ error: 'ATTEMPT_LIMIT_REACHED' });
    if (isPrismaUniqueError(error)) return res.status(409).json({ error: 'ATTEMPT_ALREADY_CREATED' });
    console.error('[competition] attempt creation failed', error);
    res.status(500).json({ error: 'ATTEMPT_CREATE_FAILED' });
  }
});

router.get('/student/attempts/:attemptId', requireSession, async (req: CompetitionRequest, res) => {
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  const attempt = await prisma.competitionChallengeAttempt.findFirst({
    where: { id: req.params.attemptId, pupilId: identity.pupilId, schoolId: identity.schoolId, status: 'STARTED' },
    include: {
      questions: {
        orderBy: { position: 'asc' },
        include: {
          question: {
            select: {
              id: true,
              prompt: true,
              type: true,
              options: { select: { id: true, content: true }, orderBy: { sortOrder: 'asc' } },
            },
          },
        },
      },
      answers: { select: { questionId: true, responseJson: true } },
    },
  });
  if (!attempt) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
  const savedAnswers = attempt.answers.flatMap((answer) => {
    try {
      const response = JSON.parse(answer.responseJson) as { optionId?: unknown };
      return typeof response.optionId === 'string' ? [{ questionId: answer.questionId, optionId: response.optionId }] : [];
    } catch {
      return [];
    }
  });
  res.json({ attempt: presentAttempt(attempt), savedAnswers });
});

router.post('/student/attempts/:attemptId/answers/:questionId', requireSession, async (req: CompetitionRequest, res) => {
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  const selectedOptionId = req.body?.optionId;
  if (typeof selectedOptionId !== 'string') return res.status(400).json({ error: 'OPTION_ID_REQUIRED' });
  const attempt = await prisma.competitionChallengeAttempt.findFirst({ where: { id: req.params.attemptId, pupilId: identity.pupilId, schoolId: identity.schoolId }, select: { id: true, status: true, startedAt: true, deadlineAt: true, scoringSnapshotJson: true, questions: { where: { questionId: req.params.questionId }, select: { id: true, questionId: true, question: { select: { difficulty: true, timeLimitSeconds: true } } } } } });
  if (!attempt || attempt.questions.length !== 1) return res.status(404).json({ error: 'ATTEMPT_QUESTION_NOT_FOUND' });
  if (attempt.status !== 'STARTED' || !attempt.deadlineAt || attempt.deadlineAt < new Date()) return res.status(409).json({ error: 'ATTEMPT_NOT_ACTIVE' });
  const option = await prisma.competitionQuestionOption.findFirst({ where: { id: selectedOptionId, questionId: req.params.questionId }, select: { id: true, isCorrect: true } });
  if (!option) return res.status(400).json({ error: 'OPTION_NOT_VALID' });
  const attemptQuestion = attempt.questions[0];
  if (!attemptQuestion) return res.status(404).json({ error: 'ATTEMPT_QUESTION_NOT_FOUND' });
  const elapsedMs = Math.max(0, Date.now() - attempt.startedAt!.getTime());
  let awardedPoints: number;
  try {
    awardedPoints = calculateCompetitionAnswerPoints({ isCorrect: option.isCorrect, difficulty: attemptQuestion.question.difficulty, elapsedMs, timeLimitSeconds: attemptQuestion.question.timeLimitSeconds, policy: parseCompetitionScoringPolicy(attempt.scoringSnapshotJson) });
  } catch (scoringError) {
    console.error('[competition] scoring policy snapshot invalid', scoringError);
    return res.status(500).json({ error: 'SCORING_POLICY_INVALID' });
  }
  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM CompetitionChallengeAttempt WHERE id = ${attempt.id} FOR UPDATE`;
      const current = await transaction.competitionChallengeAttempt.findFirst({ where: { id: attempt.id, pupilId: identity.pupilId, schoolId: identity.schoolId }, select: { status: true, deadlineAt: true } });
      if (!current || current.status !== 'STARTED' || !current.deadlineAt || current.deadlineAt < new Date()) throw new Error('ATTEMPT_NOT_ACTIVE');
      await transaction.competitionAnswerSubmission.create({ data: { attemptId: attempt.id, questionId: req.params.questionId, responseJson: JSON.stringify({ optionId: option.id }), isCorrect: option.isCorrect, awardedPoints, elapsedMs } });
      await transaction.competitionChallengeAttempt.update({ where: { id: attempt.id }, data: { score: { increment: awardedPoints }, correctCount: { increment: option.isCorrect ? 1 : 0 } } });
    });
    res.json({ accepted: true });
  } catch (error) {
    if (isPrismaUniqueError(error)) {
      const existingSubmission = await prisma.competitionAnswerSubmission.findUnique({
        where: { attemptId_questionId: { attemptId: attempt.id, questionId: req.params.questionId } },
        select: { responseJson: true },
      });
      if (existingSubmission) {
        let savedOptionId: string | null = null;
        try {
          const response = JSON.parse(existingSubmission.responseJson) as { optionId?: unknown };
          if (typeof response.optionId === 'string') savedOptionId = response.optionId;
        } catch {
          return res.status(500).json({ error: 'ANSWER_RECOVERY_FAILED' });
        }
        if (savedOptionId) return res.json({ accepted: true, alreadyRecorded: true, optionId: savedOptionId });
      }
      return res.status(409).json({ error: 'QUESTION_ALREADY_ANSWERED' });
    }
    if (error instanceof Error && error.message === 'ATTEMPT_NOT_ACTIVE') return res.status(409).json({ error: 'ATTEMPT_NOT_ACTIVE' });
    console.error('[competition] answer submission failed', error);
    res.status(500).json({ error: 'ANSWER_SUBMISSION_FAILED' });
  }
});

router.post('/student/attempts/:attemptId/submit', requireSession, async (req: CompetitionRequest, res) => {
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  const gamificationEnabled = await resolveCompetitionFeature(prisma, 'competition.gamification.enabled');
  const attempt = await prisma.competitionChallengeAttempt.findFirst({ where: { id: req.params.attemptId, pupilId: identity.pupilId, schoolId: identity.schoolId }, select: { id: true } });
  if (!attempt) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
  const studentVsStudentEnabled = await resolveCompetitionFeature(prisma, 'competition.studentVsStudent.enabled');
  const linkedMatch = studentVsStudentEnabled
    ? await prisma.competitionStudentChallenge.findFirst({ where: { OR: [{ senderAttemptId: attempt.id }, { recipientAttemptId: attempt.id }] }, select: { id: true } })
    : null;
  const now = new Date();
  const updated = await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT id FROM Pupil WHERE id = ${identity.pupilId} FOR UPDATE`;
    if (linkedMatch) await transaction.$queryRaw`SELECT id FROM CompetitionStudentChallenge WHERE id = ${linkedMatch.id} FOR UPDATE`;
    await transaction.$queryRaw`SELECT id FROM CompetitionChallengeAttempt WHERE id = ${attempt.id} FOR UPDATE`;
    const current = await transaction.competitionChallengeAttempt.findFirst({ where: { id: attempt.id, pupilId: identity.pupilId, schoolId: identity.schoolId }, include: { answers: { select: { isCorrect: true } }, challenge: { select: { title: true, xpPolicyJson: true } } } });
    if (!current) throw new Error('ATTEMPT_NOT_FOUND');
    const xpIdempotencyKey = `competition-attempt-completion:${current.id}`;
    if (current.status === 'SUBMITTED' || current.status === 'EXPIRED') {
      const existingAward = current.status === 'SUBMITTED'
        ? await transaction.competitionXpTransaction.findUnique({ where: { idempotencyKey: xpIdempotencyKey }, select: { amount: true } })
        : null;
      const existingAchievements = current.status === 'SUBMITTED'
        ? await transaction.competitionPupilAchievement.findMany({ where: { pupilId: identity.pupilId, sourceType: 'CHALLENGE_COMPLETION', sourceId: current.id }, select: { achievement: { select: { code: true, title: true } } } })
        : [];
      return { attempt: current, firstCompletion: false, xpAwarded: existingAward?.amount ?? 0, achievementsAwarded: existingAchievements.map(({ achievement }) => achievement) };
    }
    if (current.status !== 'STARTED') throw new Error('ATTEMPT_NOT_ACTIVE');
    const finalStatus = current.deadlineAt && current.deadlineAt < now ? 'EXPIRED' : 'SUBMITTED';
    const count = current.answers.length;
    const accurate = current.answers.filter((answer) => answer.isCorrect).length;
    const priorCompletedAttempts = finalStatus === 'SUBMITTED'
      ? await transaction.competitionChallengeAttempt.count({ where: { pupilId: identity.pupilId, status: 'SUBMITTED', id: { not: current.id } } })
      : 1;
    const completedAttempt = await transaction.competitionChallengeAttempt.update({ where: { id: current.id }, data: { status: finalStatus, submittedAt: now, elapsedMs: Math.max(0, now.getTime() - (current.startedAt?.getTime() ?? now.getTime())), accuracyPercent: count ? (accurate / count) * 100 : 0 } });
    const match = linkedMatch ? await transaction.competitionStudentChallenge.findFirst({
      where: { id: linkedMatch.id, status: 'ACCEPTED' },
      include: {
        senderAttempt: { select: { id: true, status: true, score: true, accuracyPercent: true, elapsedMs: true } },
        recipientAttempt: { select: { id: true, status: true, score: true, accuracyPercent: true, elapsedMs: true } },
      },
    }) : null;
    if (match?.senderAttempt && match.recipientAttempt && ['SUBMITTED', 'EXPIRED'].includes(match.senderAttempt.status) && ['SUBMITTED', 'EXPIRED'].includes(match.recipientAttempt.status)) {
      const winnerPupilId = chooseCompetitionMatchWinner({
        senderPupilId: match.senderPupilId,
        sender: { ...match.senderAttempt, accuracyPercent: match.senderAttempt.accuracyPercent?.toNumber() ?? null },
        recipientPupilId: match.recipientPupilId,
        recipient: { ...match.recipientAttempt, accuracyPercent: match.recipientAttempt.accuracyPercent?.toNumber() ?? null },
      });
      await transaction.competitionStudentChallenge.updateMany({ where: { id: match.id, status: 'ACCEPTED' }, data: { status: 'COMPLETED', winnerPupilId, completedAt: now } });
    }
    const completionXp = finalStatus === 'SUBMITTED' && gamificationEnabled
      ? parseCompetitionXpPolicy(current.challenge.xpPolicyJson).completionXp
      : 0;
    if (completionXp > 0) {
      await transaction.competitionXpTransaction.create({
        data: {
          schoolId: identity.schoolId,
          pupilId: identity.pupilId,
          attemptId: current.id,
          sourceType: 'CHALLENGE_COMPLETION',
          sourceId: current.id,
          amount: completionXp,
          reason: `Completed ${current.challenge.title}`.slice(0, 500),
          idempotencyKey: xpIdempotencyKey,
        },
      });
    }
    let achievementsAwarded: Array<{ code: string; title: string }> = [];
    if (finalStatus === 'SUBMITTED' && gamificationEnabled) {
      const definitions = await transaction.competitionAchievement.findMany({ where: { isActive: true }, select: { id: true, code: true, title: true, criteriaJson: true } });
      const eligibleDefinitions = definitions.filter((definition) => {
        try {
          return shouldAwardCompetitionAchievement({
            criteria: parseCompetitionAchievementCriteria(definition.criteriaJson),
            priorCompletedChallenges: priorCompletedAttempts,
            correctCount: accurate,
            questionCount: current.questionCount,
          });
        } catch {
          console.warn('[competition] skipping invalid achievement criteria', definition.code);
          return false;
        }
      });
      if (eligibleDefinitions.length > 0) {
        const existingAchievements = await transaction.competitionPupilAchievement.findMany({ where: { pupilId: identity.pupilId, achievementId: { in: eligibleDefinitions.map(({ id }) => id) } }, select: { achievementId: true } });
        const existingAchievementIds = new Set(existingAchievements.map(({ achievementId }) => achievementId));
        const newAchievements = eligibleDefinitions.filter(({ id }) => !existingAchievementIds.has(id));
        if (newAchievements.length > 0) {
          await transaction.competitionPupilAchievement.createMany({
            data: newAchievements.map(({ id }) => ({ pupilId: identity.pupilId, achievementId: id, sourceType: 'CHALLENGE_COMPLETION', sourceId: current.id })),
            skipDuplicates: true,
          });
          achievementsAwarded = newAchievements.map(({ code, title }) => ({ code, title }));
        }
      }
    }
    return { attempt: completedAttempt, firstCompletion: finalStatus === 'SUBMITTED' && priorCompletedAttempts === 0, xpAwarded: completionXp, achievementsAwarded };
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'ATTEMPT_NOT_FOUND') return null;
    throw error;
  });
  if (!updated) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
  if (updated.attempt.status !== 'SUBMITTED' && updated.attempt.status !== 'EXPIRED') return res.status(409).json({ error: 'ATTEMPT_NOT_ACTIVE' });
  res.json({ result: { status: updated.attempt.status, score: updated.attempt.score, correctCount: updated.attempt.correctCount, questionCount: updated.attempt.questionCount, accuracyPercent: updated.attempt.accuracyPercent, elapsedMs: updated.attempt.elapsedMs, firstCompletion: updated.firstCompletion, xpAwarded: updated.xpAwarded, achievementsAwarded: updated.achievementsAwarded } });
});

router.get('/student/me', requireSession, async (req: CompetitionRequest, res) => {
  if (!(await resolveCompetitionFeature(prisma, 'competition.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  const identity = await resolveLearnerIdentity(req, res);
  if (!identity) return;
  const gamificationEnabled = await resolveCompetitionFeature(prisma, 'competition.gamification.enabled');
  const [pupil, xp] = await Promise.all([
    prisma.pupil.findUnique({ where: { id: identity.pupilId }, select: { firstName: true, class: { select: { name: true } } } }),
    gamificationEnabled
      ? prisma.competitionXpTransaction.aggregate({ where: { pupilId: identity.pupilId }, _sum: { amount: true } })
      : Promise.resolve(null),
  ]);
  res.json({ student: { firstName: pupil?.firstName, className: pupil?.class?.name, xp: xp?._sum.amount ?? null } });
});

function presentAttempt(attempt: any) {
  return {
    id: attempt.id,
    status: attempt.status,
    startedAt: attempt.startedAt,
    deadlineAt: attempt.deadlineAt,
    questions: attempt.questions.map((entry: any) => ({
      id: entry.question.id,
      type: entry.question.type,
      prompt: entry.question.prompt,
      options: JSON.parse(entry.optionOrderJson).map((optionId: string) => entry.question.options.find((option: any) => option.id === optionId)).filter(Boolean),
    })),
  };
}

export default router;
