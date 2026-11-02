import { PrismaClient } from '@prisma/client';
import { ResultWorkflowState, isValidTransition, getStateName } from './ResultWorkflowState.js';
import { ResultsValidator, ValidationResult } from './ResultsValidator.js';
import { calculateClassPositions, calculateSubjectPositions } from './result-ranking.js';
import { isPassingGrade, resolveGradeForScore } from '../../services/result-score-calculation.js';

/**
 * Results Domain Service
 * 
 * SINGLE SOURCE OF TRUTH for all results business logic.
 * 
 * ❌ NO business logic in routes
 * ❌ NO validation in services
 * ❌ NO calculation logic in frontend
 * ✅ ALL logic here, ALL logic audited, ALL logic deterministic
 */

interface DomainError {
  error: string;
  errorCode: string;
  message: string;
  action?: string;
  details?: any;
}

export class ResultsDomainService {
  private prisma: PrismaClient;
  private validator: ResultsValidator;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || new PrismaClient();
    this.validator = new ResultsValidator(this.prisma);
  }

  // ==================== GRADE CALCULATION ====================

  /**
   * Calculate total score from component scores
   * This is DETERMINISTIC - same input always produces same output
   */
  calculateTotalScore(
    componentScores: Record<string, number>,
    components: Array<{ id: string; maxScore: number; weight: number }>,
    schoolId?: string
  ): number {
    let totalScore = 0;

    for (const component of components) {
      const score = componentScores[component.id];
      if (score !== undefined && score !== null) {
        // Validate score is in range
        if (score < 0 || score > component.maxScore) {
          throw new Error(
            `Invalid score for component: ${score} (valid: 0-${component.maxScore})`
          );
        }

        // Convert to percentage and apply weight
        const percentage = (score / component.maxScore) * 100;
        const weighted = (percentage * component.weight) / 100;
        totalScore += weighted;
      }
    }

    return Math.round(totalScore * 100) / 100;
  }

  /**
   * Calculate grade based on total score
   * Uses school's GradingScale or defaults
   * DETERMINISTIC - stable grading scale
   */
  async calculateGrade(schoolId: string, totalScore: number): Promise<string> {
    const gradingScales = await this.prisma.gradingScale.findMany({
      where: { schoolId },
      orderBy: { minScore: 'desc' },
    });
    return resolveGradeForScore(totalScore, gradingScales);
  }

  // ==================== POSITIONING (WITH DETERMINISTIC TIE-BREAKING) ====================

  /**
   * Calculate subject positioning with deterministic tie-breaking
   * 
   * Tie-breaker rule (DETERMINISTIC):
   * 1. Total score DESC (highest first)
   * 2. CA score DESC (higher CA first) - extracted from scores JSON
   * 3. Alphabetical name ASC (A-Z as final tiebreaker)
   * 
   * This ensures same dataset always produces same rankings
   */
  async calculateSubjectPositioning(
    assessmentId: string,
    subjectId: string,
    schoolId: string
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const assessment = await tx.assessment.findFirst({
        where: { id: assessmentId, schoolId },
        select: { componentData: true },
      });
      if (!assessment?.componentData) return;

      let caComponentId = '';
      try {
        const config: unknown = JSON.parse(assessment.componentData);
        const components =
          config && typeof config === 'object' && 'components' in config && Array.isArray(config.components)
            ? config.components
            : [];
        const caComponent = components.find((component) => {
          if (!component || typeof component !== 'object' || !('name' in component) || !('id' in component)) return false;
          const name = typeof component.name === 'string' ? component.name.toLowerCase() : '';
          return name === 'ca' || name === 'continuous assessment';
        });
        if (caComponent && typeof caComponent.id === 'string') caComponentId = caComponent.id;
      } catch {
        caComponentId = '';
      }

      const results = await tx.result.findMany({
        where: { assessmentId, subjectId, assessment: { schoolId } },
        include: { pupil: true },
      });
      const positions = calculateSubjectPositions(results, caComponentId);

      await tx.result.updateMany({
        where: { assessmentId, subjectId, assessment: { schoolId } },
        data: { subjectPosition: null },
      });
      for (const result of positions) {
        await tx.result.update({
          where: { id: result.resultId },
          data: { subjectPosition: result.position },
        });
      }
    });
  }

  /**
   * Calculate class positioning with deterministic tie-breaking
   * 
   * Procedure:
   * 1. Get average score per student across all subjects
   * 2. Sort by average (DESC), then by student name (for determinism)
   * 3. Assign positions with tie handling
   */
  async calculateClassPositioning(assessmentId: string, schoolId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const results = await tx.result.findMany({
        where: { assessmentId, assessment: { schoolId } },
        include: { pupil: true },
      });
      const positions = calculateClassPositions(results);

      await tx.result.updateMany({
        where: { assessmentId, assessment: { schoolId } },
        data: { classPosition: null },
      });
      for (const result of positions) {
        await tx.result.update({
          where: { id: result.resultId },
          data: { classPosition: result.position },
        });
      }
    });
  }

  // ==================== VALIDATION ====================

  /**
   * Validate assessment results before publish
   */
  async validateResults(assessmentId: string, schoolId: string): Promise<ValidationResult> {
    return this.validator.validateAssessmentResults(assessmentId, schoolId);
  }

  /**
   * Check publish readiness
   */
  async isReadyForPublish(assessmentId: string, schoolId: string): Promise<{ ready: boolean; reason?: string }> {
    return this.validator.isReadyForPublish(assessmentId, schoolId);
  }

  // ==================== STATE TRANSITIONS ====================

  /**
   * Calculate next workflow state
   * Called after each operation to update assessment state
   */
  async calculateNextState(assessmentId: string, schoolId: string): Promise<ResultWorkflowState> {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
      include: {
        results: { select: { id: true, totalScore: true, grade: true, classPosition: true, subjectPosition: true } },
      },
    });

    if (!assessment) {
      throw new Error('Assessment not found');
    }

    // Determine current state based on data
    const hasComponentData = !!assessment.componentData;
    const hasScores =
      assessment.results.length > 0 &&
      assessment.results.some((r) => r.totalScore !== null && r.totalScore !== undefined);
    const hasGrades =
      assessment.results.length > 0 &&
      assessment.results.some((r) => r.grade !== null && r.grade !== undefined);
    const hasPositions =
      assessment.results.length > 0 &&
      assessment.results.some((r) => r.classPosition !== null && r.classPosition !== undefined);

    // State calculation logic
    if (!hasComponentData) return ResultWorkflowState.DRAFT;
    if (!hasScores) return ResultWorkflowState.CONFIGURED;
    if (!hasGrades) return ResultWorkflowState.SCORED;
    if (!hasPositions) return ResultWorkflowState.GRADED;

    // Check if validated
    const validation = await this.validateResults(assessmentId, schoolId);
    if (!validation.isValid) return ResultWorkflowState.POSITIONED;

    // If locked, stay locked
    const results = await this.prisma.result.findMany({
      where: { assessmentId, assessment: { schoolId } },
      select: { lockedAt: true },
      take: 1,
    });
    if (results[0]?.lockedAt) return ResultWorkflowState.LOCKED;

    return ResultWorkflowState.VALIDATED;
  }

  // ==================== LOCKING ====================

  /**
   * Lock results - prevent editing
   * Transition VALIDATED -> LOCKED
   */
  async lockResults(
    assessmentId: string,
    userId: string,
    schoolId: string
  ): Promise<void> {
    // Verify assessment
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
    });

    if (!assessment) {
      throw new Error('Assessment not found');
    }

    // Validate before locking
    const validation = await this.validateResults(assessmentId, schoolId);
    if (!validation.isValid) {
      throw new Error(`Cannot lock - validation errors exist: ${validation.blockers[0]?.message}`);
    }

    const now = new Date();

    const results = await this.prisma.result.findMany({
      where: { assessmentId: assessment.id },
      select: { id: true, pupilId: true },
    });

    // Lock all results
    await this.prisma.result.updateMany({
      where: { assessmentId: assessment.id },
      data: {
        lockedAt: now,
        lockedBy: userId,
      },
    });

    if (results.length > 0) {
      await this.prisma.resultAudit.createMany({
        data: results.map((result) => ({
          schoolId,
          assessmentId,
          resultId: result.id,
          pupilId: result.pupilId,
          action: 'BATCH_LOCKED',
          changes: JSON.stringify({ operation: 'lock_all_results', timestamp: now.toISOString() }),
          changedBy: userId,
          changedAt: now,
        })),
      });
    }
  }

  /**
   * Unlock results - allow editing
   * Transition LOCKED -> VALIDATED
   */
  async unlockResults(
    assessmentId: string,
    userId: string,
    schoolId: string,
    reason?: string
  ): Promise<void> {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
    });

    if (!assessment) {
      throw new Error('Assessment not found');
    }

    const now = new Date();

    const results = await this.prisma.result.findMany({
      where: { assessmentId: assessment.id },
      select: { id: true, pupilId: true },
    });

    // Unlock all results
    await this.prisma.result.updateMany({
      where: { assessmentId: assessment.id },
      data: {
        lockedAt: null,
        lockedBy: null,
      },
    });

    if (results.length > 0) {
      const baseChanges: Record<string, any> = {
        operation: 'unlock_all_results',
        timestamp: now.toISOString(),
      };

      if (reason) baseChanges.reason = reason;

      await this.prisma.resultAudit.createMany({
        data: results.map((result) => ({
          schoolId,
          assessmentId,
          resultId: result.id,
          pupilId: result.pupilId,
          action: 'BATCH_UNLOCKED',
          changes: JSON.stringify(baseChanges),
          changedBy: userId,
          changedAt: now,
        })),
      });
    }
  }

  // ==================== PUBLISHING ====================

  /**
   * Publish results - make visible to parents
   * Transition LOCKED -> PUBLISHED
   */
  async publishResults(
    assessmentId: string,
    userId: string,
    schoolId: string
  ): Promise<void> {
    const now = new Date();
    const { resolveReportSignatory } = await import('../../services/signatory-resolver.js');
    const resultsForSignatories = await this.prisma.result.findMany({
      where: { assessmentId, assessment: { schoolId } },
      select: { pupilId: true },
      distinct: ['pupilId'],
    });
    const signatoryByPupil = new Map<string, string | null>();
    for (const result of resultsForSignatories) {
      const resolved = await resolveReportSignatory({
        prisma: this.prisma,
        schoolId,
        pupilId: result.pupilId,
      });
      signatoryByPupil.set(result.pupilId, resolved?.signatoryId ?? null);
    }

    await this.prisma.$transaction(async (tx) => {
      const assessment = await tx.assessment.findFirst({
        where: { id: assessmentId, schoolId },
      });
      if (!assessment) throw new Error('Assessment not found');
      if (assessment.status === 'PUBLISHED') throw new Error('Assessment is already published');

      const validation = await new ResultsValidator(tx).validateAssessmentResults(assessmentId, schoolId);
      if (!validation.isValid) {
        const reason = validation.blockers[0]?.message ?? 'Results validation failed';
        throw new Error(`Not ready to publish: ${reason}`);
      }

      const statusUpdate = await tx.assessment.updateMany({
        where: { id: assessmentId, schoolId, status: assessment.status },
        data: { status: 'PUBLISHED' },
      });
      if (statusUpdate.count !== 1) {
        throw new Error('Assessment changed during publication; reload and try again');
      }

      const results = await tx.result.findMany({
        where: { assessmentId, assessment: { schoolId } },
        select: { id: true, pupilId: true },
      });
      await tx.result.updateMany({
        where: { assessmentId, assessment: { schoolId } },
        data: { publishedAt: now },
      });
      if (results.length > 0) {
        await tx.resultAudit.createMany({
          data: results.map((result) => ({
            schoolId,
            assessmentId,
            resultId: result.id,
            pupilId: result.pupilId,
            action: 'ASSESSMENT_PUBLISHED',
            changes: JSON.stringify({ status: 'PUBLISHED', timestamp: now.toISOString() }),
            changedBy: userId,
            changedAt: now,
            usedSignatoryId: signatoryByPupil.get(result.pupilId) ?? null,
          })),
        });
      }
    });
  }

  /**
   * Unpublish results - revert to locked state
   * Transition PUBLISHED -> LOCKED
   */
  async unpublishResults(
    assessmentId: string,
    userId: string,
    schoolId: string
  ): Promise<void> {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
    });

    if (!assessment) {
      throw new Error('Assessment not found');
    }

    const now = new Date();

    // Update assessment status
    await this.prisma.assessment.update({
      where: { id: assessment.id },
      data: {
        status: 'APPROVED',
      },
    });

    const results = await this.prisma.result.findMany({
      where: { assessmentId: assessment.id },
      select: { id: true, pupilId: true },
    });

    if (results.length > 0) {
      await this.prisma.result.updateMany({
        where: { assessmentId: assessment.id },
        data: { publishedAt: null },
      });

      await this.prisma.resultAudit.createMany({
        data: results.map((result) => ({
          schoolId,
          assessmentId,
          resultId: result.id,
          pupilId: result.pupilId,
          action: 'ASSESSMENT_UNPUBLISHED',
          changes: JSON.stringify({ status: 'APPROVED', timestamp: now.toISOString() }),
          changedBy: userId,
          changedAt: now,
        })),
      });
    }
  }

  // ==================== AUDIT ====================

  /**
   * Write audit entry (only called from domain layer)
   */
  async auditResultChange(
    resultId: string,
    assessmentId: string,
    pupilId: string,
    action: string,
    changes: Record<string, any>,
    userId: string,
    schoolId: string
  ): Promise<void> {
    await this.prisma.resultAudit.create({
      data: {
        resultId,
        assessmentId,
        pupilId,
        action,
        changes: typeof changes === 'string' ? changes : JSON.stringify(changes),
        changedBy: userId,
        schoolId,
        changedAt: new Date(),
      },
    });
  }

  // ==================== REPORTING ====================

  /**
   * Get assessment result sheet with statistics
   */
  async getAssessmentResultSheet(assessmentId: string, schoolId: string): Promise<any> {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
      include: { term: true, class: true },
    });

    if (!assessment) {
      throw new Error('Assessment not found');
    }

    const results = await this.prisma.result.findMany({
      where: { assessmentId, assessment: { schoolId }, pupil: { schoolId } },
      include: { pupil: true, subjectRef: true },
      orderBy: { classPosition: 'asc' },
    });

    const subjects = assessment.classId
      ? await this.prisma.subject.findMany({
          where: {
            schoolId,
            subjectClasses: {
              some: { classId: assessment.classId },
            },
          },
        })
      : [];

    const scoredResults = results.filter(
      (result) => typeof result.totalScore === 'number' && Number.isFinite(result.totalScore),
    );
    const totalScores = scoredResults.map((result) => result.totalScore!);
    const gradingScales = await this.prisma.gradingScale.findMany({
      where: { schoolId },
      orderBy: { minScore: 'desc' },
      select: { grade: true, minScore: true, maxScore: true },
    });
    const passCount = scoredResults.filter((result) =>
      isPassingGrade(resolveGradeForScore(result.totalScore!, gradingScales)),
    ).length;
    const passRate = scoredResults.length > 0 ? (passCount / scoredResults.length) * 100 : 0;
    const avgScore = totalScores.length > 0
      ? totalScores.reduce((a, b) => a + b, 0) / totalScores.length
      : 0;

    return {
      assessment: {
        id: assessment.id,
        name: assessment.name,
        status: assessment.status,
        term: assessment.term,
        class: assessment.class,
      },
      subjects,
      results,
      statistics: {
        totalStudents: new Set(results.map((result) => result.pupilId)).size,
        highestScore: Math.max(...totalScores, 0),
        lowestScore: totalScores.length > 0 ? Math.min(...totalScores) : 0,
        averageScore: Math.round(avgScore * 100) / 100,
        passCount,
        failCount: scoredResults.length - passCount,
        passRate: Math.round(passRate),
      },
    };
  }
}
