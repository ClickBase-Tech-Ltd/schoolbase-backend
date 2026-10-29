import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { jwtVerify } from 'jose';
import { ResultsDomainService } from '../domain/results/ResultsDomainService.js';
import { resolveStoredAssessmentTotal } from '../services/result-score-calculation.js';
import { getSessionSecret } from '../services/security-config.js';
import { resolveSchoolScope } from '../services/security-context.js';

const router = Router();
const prisma = new PrismaClient();
const resultsDomain = new ResultsDomainService(prisma);

function secret() {
  return getSessionSecret();
}

async function resolveSchoolId(req: Request): Promise<string | null> {
  const requestedSchoolId = (req.query.schoolId as string) || (req.headers['x-school-id'] as string) || (req.body as any)?.schoolId;

  const token = req.cookies?.schoolbase_session || req.cookies?.schoolbase_staff || req.cookies?.staff_session;
  let authenticatedSchoolId: string | null = null;
  let authenticatedRole: string | null = null;

  if (token) {
    try {
      const { payload } = await jwtVerify(token, secret());
      if (payload && typeof payload === 'object') {
        authenticatedRole = typeof payload.role === 'string' ? payload.role : null;
        if ('schoolId' in payload && payload.schoolId) {
          authenticatedSchoolId = String((payload as any).schoolId);
        }
      }
    } catch (error) {
      console.error('[results-engine] Failed to resolve schoolId from token', error);
    }
  }

  const scope = resolveSchoolScope({ authenticatedSchoolId, authenticatedRole, requestedSchoolId });
  if (scope.rejected) {
    console.warn('[results-engine] Rejected cross-school scope request');
    return null;
  }

  return scope.schoolId;
}

/**
 * Results Engine API Routes - Refactored Phase 8
 * 
 * THIN HTTP LAYER - All business logic now in ResultsDomainService
 * 
 * ❌ NO business logic here (routes only handle HTTP)
 * ❌ NO validation here (delegated to domain layer)
 * ❌ NO calculations here (delegated to domain layer)
 * ✅ Simple request/response mapping only
 */

// POST /api/results/calculate-grades/:assessmentId
// Calculate grades for all results - DELEGATES TO DOMAIN LAYER
router.post('/calculate-grades/:assessmentId', async (req: Request, res: Response) => {
  try {
    const { assessmentId } = req.params;
    const schoolId = await resolveSchoolId(req);
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!schoolId || !assessmentId) {
      return res.status(403).json({
        error: 'SCHOOL_SCOPE_REQUIRED',
        message: 'School scope verification failed',
      });
    }

    // Verify assessment exists and belongs to school
    const assessment = await prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
      include: { results: true },
    });

    if (!assessment) {
      return res.status(404).json({
        error: 'ASSESSMENT_NOT_FOUND',
        message: 'Assessment not found',
      });
    }

    if (!assessment.componentData) {
      return res.status(400).json({
        error: 'ASSESSMENT_NOT_CONFIGURED',
        message: 'Assessment not configured. Please define CA/Test/Exam weights first.',
        action: 'CONFIGURE_COMPONENTS',
      });
    }

    // Parse configuration
    const config = JSON.parse(assessment.componentData);
    const components = config.components || [];

    const calculateResultTotal = (result: any): number | null =>
      resolveStoredAssessmentTotal(assessment.componentData, result);

    // Calculate grades for all results
    let updateCount = 0;
    const errors = [];

    for (const result of assessment.results) {
      try {
        const effectiveTotal = calculateResultTotal(result);
        if (effectiveTotal !== null) {
          const grade = await resultsDomain.calculateGrade(schoolId, effectiveTotal);

          await prisma.result.update({
            where: { id: result.id },
            data: {
              grade,
              totalScore: result.totalScore ?? effectiveTotal,
            },
          });

          // Audit through domain layer
          await resultsDomain.auditResultChange(
            result.id,
            assessmentId,
            result.pupilId,
            'GRADE_CALCULATED',
            { totalScore: result.totalScore ?? effectiveTotal, grade },
            userId,
            schoolId
          );

          updateCount++;
        }
      } catch (e: any) {
        errors.push({
          resultId: result.id,
          error: e.message,
        });
      }
    }

    if (updateCount === 0) {
      return res.status(400).json({
        error: 'NO_RESULTS_TO_GRADE',
        message: 'No results with total scores to calculate grades for',
      });
    }

    const workflowState = await resultsDomain.calculateNextState(assessmentId, schoolId);

    res.json({
      success: true,
      message: `Grades calculated for ${updateCount} result${updateCount === 1 ? '' : 's'}`,
      gradesCalculated: updateCount,
      workflowState,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error: any) {
    console.error('Error calculating grades:', error);
    res.status(500).json({
      error: 'CALCULATION_FAILED',
      message: error.message || 'Failed to calculate grades',
    });
  }
});

// POST /api/results/calculate-positions/:assessmentId
// Calculate subject and class positions - DELEGATES TO DOMAIN LAYER
router.post('/calculate-positions/:assessmentId', async (req: Request, res: Response) => {
  try {
    const { assessmentId } = req.params;
    const schoolId = await resolveSchoolId(req);
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!schoolId || !assessmentId) {
      return res.status(403).json({
        error: 'SCHOOL_SCOPE_REQUIRED',
        message: 'School scope verification failed',
      });
    }

    // Verify assessment exists and belongs to school
    const assessment = await prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
      include: { results: true },
    });

    if (!assessment) {
      return res.status(404).json({
        error: 'ASSESSMENT_NOT_FOUND',
        message: 'Assessment not found',
      });
    }

    if (!assessment.componentData) {
      return res.status(400).json({
        error: 'ASSESSMENT_NOT_CONFIGURED',
        message: 'Assessment not configured',
      });
    }

    // Check grades calculated
    const missingGrades = assessment.results.filter((r) => !r.grade);
    if (missingGrades.length > 0) {
      return res.status(400).json({
        error: 'GRADES_NOT_CALCULATED',
        message: `${missingGrades.length} results missing grades. Calculate grades first.`,
        action: 'CALCULATE_GRADES',
      });
    }

    // Calculate subject positions for each subject
    const subjectIds = new Set(
      assessment.results
        .map((r) => r.subjectId)
        .filter((id) => id !== null)
    );

    let subjectPositionCount = 0;
    for (const subjectId of subjectIds) {
      if (subjectId) {
        await resultsDomain.calculateSubjectPositioning(assessmentId, subjectId, schoolId);
        subjectPositionCount++;
      }
    }

    // Calculate class position (with deterministic tie-breaking)
    await resultsDomain.calculateClassPositioning(assessmentId, schoolId);

    const workflowState = await resultsDomain.calculateNextState(assessmentId, schoolId);

    res.json({
      success: true,
      message: `Positions calculated successfully for ${subjectPositionCount} subject${subjectPositionCount === 1 ? '' : 's'}`,
      subjectsProcessed: subjectPositionCount,
      classPositionsCalculated: true,
      workflowState,
    });
  } catch (error: any) {
    console.error('Error calculating positions:', error);
    res.status(500).json({
      error: 'CALCULATION_FAILED',
      message: error.message || 'Failed to calculate positions',
    });
  }
});

// POST /api/results/validate/:assessmentId
// Validate all results before publishing - DELEGATES TO DOMAIN LAYER
router.post('/validate/:assessmentId', async (req: Request, res: Response) => {
  try {
    const { assessmentId } = req.params;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId || !assessmentId) {
      return res.status(403).json({
        error: 'SCHOOL_SCOPE_REQUIRED',
        message: 'School scope verification failed',
      });
    }

    // Verify assessment exists and belongs to school
    const assessment = await prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
    });

    if (!assessment) {
      return res.status(404).json({
        error: 'ASSESSMENT_NOT_FOUND',
        message: 'Assessment not found',
      });
    }

    const validation = await resultsDomain.validateResults(assessmentId, schoolId);

    const workflowState = await resultsDomain.calculateNextState(assessmentId, schoolId);

    res.json({
      ...validation,
      message: validation.isValid
        ? 'Validation passed. Results are ready to lock.'
        : 'This assessment is not ready yet. Please ask teachers to complete the following steps before results can proceed.',
      workflowState,
    });
  } catch (error: any) {
    console.error('Error validating results:', error);
    res.status(500).json({
      error: 'VALIDATION_FAILED',
      message: error.message || 'Failed to validate results',
    });
  }
});

// POST /api/results/lock/:assessmentId
// Lock results - prevent editing - DELEGATES TO DOMAIN LAYER
router.post('/lock/:assessmentId', async (req: Request, res: Response) => {
  try {
    const { assessmentId } = req.params;
    const schoolId = await resolveSchoolId(req);
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!schoolId || !assessmentId) {
      return res.status(403).json({
        error: 'SCHOOL_SCOPE_REQUIRED',
        message: 'School scope verification failed',
      });
    }

    // Verify assessment exists and belongs to school
    const assessment = await prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
      include: { _count: { select: { results: true } } },
    });

    if (!assessment) {
      return res.status(404).json({
        error: 'ASSESSMENT_NOT_FOUND',
        message: 'Assessment not found',
      });
    }

    // Lock results (domain layer handles validation)
    await resultsDomain.lockResults(assessmentId, userId, schoolId);
    const workflowState = await resultsDomain.calculateNextState(assessmentId, schoolId);

    res.json({
      success: true,
      message: 'Results locked successfully. Editing is now disabled.',
      lockedCount: assessment._count.results,
      status: assessment.status,
      workflowState,
    });
  } catch (error: any) {
    console.error('Error locking results:', error);
    res.status(400).json({
      error: 'LOCK_FAILED',
      message: error.message || 'Failed to lock results',
    });
  }
});

// POST /api/results/unlock/:assessmentId
// Unlock results - allow editing - DELEGATES TO DOMAIN LAYER
router.post('/unlock/:assessmentId', async (req: Request, res: Response) => {
  try {
    const { assessmentId } = req.params;
    const schoolId = await resolveSchoolId(req);
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!schoolId || !assessmentId) {
      return res.status(403).json({
        error: 'SCHOOL_SCOPE_REQUIRED',
        message: 'School scope verification failed',
      });
    }

    // Verify assessment exists and belongs to school
    const assessment = await prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
      include: { _count: { select: { results: true } } },
    });

    if (!assessment) {
      return res.status(404).json({
        error: 'ASSESSMENT_NOT_FOUND',
        message: 'Assessment not found',
      });
    }

    // Unlock results (domain layer handles validation)
    const reason = req.body && (req.body as any).reason ? String((req.body as any).reason) : undefined;
    await resultsDomain.unlockResults(assessmentId, userId, schoolId, reason);
    const workflowState = await resultsDomain.calculateNextState(assessmentId, schoolId);

    res.json({
      success: true,
      message: 'Results unlocked successfully. Editing is now enabled.',
      unlockedCount: assessment._count.results,
      status: assessment.status,
      workflowState,
    });
  } catch (error: any) {
    console.error('Error unlocking results:', error);
    res.status(400).json({
      error: 'UNLOCK_FAILED',
      message: error.message || 'Failed to unlock results',
    });
  }
});

// POST /api/results/publish/:assessmentId
// Publish results - make visible to parents - DELEGATES TO DOMAIN LAYER
router.post('/publish/:assessmentId', async (req: Request, res: Response) => {
  try {
    const { assessmentId } = req.params;
    const schoolId = await resolveSchoolId(req);
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!schoolId || !assessmentId) {
      return res.status(403).json({
        error: 'SCHOOL_SCOPE_REQUIRED',
        message: 'School scope verification failed',
      });
    }

    // Verify assessment exists and belongs to school
    const assessment = await prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
    });

    if (!assessment) {
      return res.status(404).json({
        error: 'ASSESSMENT_NOT_FOUND',
        message: 'Assessment not found',
      });
    }

    if (!assessment.componentData) {
      return res.status(400).json({
        error: 'ASSESSMENT_NOT_CONFIGURED',
        message: 'Assessment not configured',
      });
    }

    // Publish results (domain layer handles validation and state transitions)
    await resultsDomain.publishResults(assessmentId, userId, schoolId);
    const workflowState = await resultsDomain.calculateNextState(assessmentId, schoolId);

    res.json({
      success: true,
      message: 'Results published successfully',
      assessmentId,
      status: 'PUBLISHED',
      workflowState,
    });
  } catch (error: any) {
    console.error('Error publishing results:', error);
    res.status(400).json({
      error: 'PUBLISH_FAILED',
      message: error.message || 'Failed to publish results',
    });
  }
});

// POST /api/results/unpublish/:assessmentId
// Unpublish results - revert to locked - DELEGATES TO DOMAIN LAYER
router.post('/unpublish/:assessmentId', async (req: Request, res: Response) => {
  try {
    const { assessmentId } = req.params;
    const schoolId = await resolveSchoolId(req);
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!schoolId || !assessmentId) {
      return res.status(403).json({
        error: 'SCHOOL_SCOPE_REQUIRED',
        message: 'School scope verification failed',
      });
    }

    // Verify assessment exists and belongs to school
    const assessment = await prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
    });

    if (!assessment) {
      return res.status(404).json({
        error: 'ASSESSMENT_NOT_FOUND',
        message: 'Assessment not found',
      });
    }

    // Unpublish results
    await resultsDomain.unpublishResults(assessmentId, userId, schoolId);
    const workflowState = await resultsDomain.calculateNextState(assessmentId, schoolId);

    res.json({
      success: true,
      message: 'Results unpublished successfully',
      assessmentId,
      status: 'APPROVED',
      workflowState,
    });
  } catch (error: any) {
    console.error('Error unpublishing results:', error);
    res.status(400).json({
      error: 'UNPUBLISH_FAILED',
      message: error.message || 'Failed to unpublish results',
    });
  }
});

// GET /api/results/assessment/:assessmentId
// Get complete result sheet with statistics - DELEGATES TO DOMAIN LAYER
router.get('/assessment/:assessmentId', async (req: Request, res: Response) => {
  try {
    const { assessmentId } = req.params;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId || !assessmentId) {
      return res.status(403).json({
        error: 'SCHOOL_SCOPE_REQUIRED',
        message: 'School scope verification failed',
      });
    }

    // Ensure unpublished assessments are only accessible to staff
    const assessment = await prisma.assessment.findFirst({ where: { id: assessmentId, schoolId }, select: { status: true } });
    if (!assessment) {
      return res.status(404).json({ error: 'ASSESSMENT_NOT_FOUND' });
    }

    if (assessment.status !== 'PUBLISHED') {
      // Check for staff session token in cookies
      const cookieHeader = req.headers.cookie || '';
      const sessionCookie = cookieHeader.split(';').find(c => {
        const t = c.trim();
        return t.startsWith('schoolbase_session=') || t.startsWith('schoolbase_staff=') || t.startsWith('staff_session=');
      });

      if (!sessionCookie) {
        return res.status(403).json({ error: 'RESULTS_NOT_PUBLISHED' });
      }

      try {
        const token = sessionCookie.split('=')[1];
        const { payload } = await jwtVerify(token, secret());
        const role = (payload as any).role;
        const allowedRoles = ['PLATFORM_ADMIN', 'SCHOOL_ADMIN', 'TEACHER', 'BURSAR'];
        if (!role || !allowedRoles.includes(role)) {
          return res.status(403).json({ error: 'RESULTS_NOT_PUBLISHED' });
        }
      } catch (err) {
        return res.status(403).json({ error: 'RESULTS_NOT_PUBLISHED' });
      }
    }

    const resultSheet = await resultsDomain.getAssessmentResultSheet(assessmentId, schoolId);

    res.json(resultSheet);
  } catch (error: any) {
    console.error('Error fetching result sheet:', error);
    res.status(400).json({
      error: 'FETCH_FAILED',
      message: error.message || 'Failed to fetch result sheet',
    });
  }
});

// GET /api/results/:resultId/audit
// Get audit trail for a result
router.get('/:resultId/audit', async (req: Request, res: Response) => {
  try {
    const { resultId } = req.params;
    const schoolId = await resolveSchoolId(req);

    if (!schoolId) {
      return res.status(403).json({ error: 'SCHOOL_SCOPE_REQUIRED', message: 'School scope verification failed' });
    }

    const audits = await prisma.resultAudit.findMany({
      where: { resultId, schoolId },
      orderBy: { changedAt: 'desc' },
    });

    res.json({
      resultId,
      auditCount: audits.length,
      audits: audits.map((audit) => ({
        id: audit.id,
        action: audit.action,
        changes: JSON.parse(audit.changes || '{}'),
        changedBy: audit.changedBy,
        changedAt: audit.changedAt,
      })),
    });
  } catch (error: any) {
    console.error('Error fetching audit trail:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch audit trail' });
  }
});

// GET /api/results/assessment/:assessmentId/audits
// Get all audits for an assessment
router.get('/assessment/:assessmentId/audits', async (req: Request, res: Response) => {
  try {
    const { assessmentId } = req.params;
    const schoolId = await resolveSchoolId(req);

    if (!assessmentId) {
      return res.status(400).json({ error: 'Missing assessment ID' });
    }

    if (!schoolId) {
      return res.status(403).json({ error: 'SCHOOL_SCOPE_REQUIRED', message: 'School scope verification failed' });
    }

    // Verify assessment exists and belongs to school
    const assessment = await prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
      select: { id: true },
    });

    if (!assessment) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    const audits = await prisma.resultAudit.findMany({
      where: { assessmentId, schoolId },
      orderBy: { changedAt: 'desc' },
    });

    res.json({
      assessmentId,
      auditCount: audits.length,
      audits: audits.map((audit) => ({
        id: audit.id,
        resultId: audit.resultId,
        pupilId: audit.pupilId,
        action: audit.action,
        changes: JSON.parse(audit.changes || '{}'),
        changedBy: audit.changedBy,
        changedAt: audit.changedAt,
      })),
    });
  } catch (error: any) {
    console.error('Error fetching assessment audits:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch audits' });
  }
});

export default router;
