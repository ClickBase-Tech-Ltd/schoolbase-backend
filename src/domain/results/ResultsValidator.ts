import { PrismaClient } from '@prisma/client';
import { ResultWorkflowState } from './ResultWorkflowState.js';
import { isStudentCurrentlyEnrolled } from '../../services/student-lifecycle.js';
import {
  calculateWeightedTotalScore,
  normalizeTeacherAssessmentScores,
  parseAssessmentScoreComponents,
} from '../../services/result-score-calculation.js';

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
  details?: any;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  blockers: ValidationError[]; // Errors that prevent publishing
}

/**
 * Centralized Results Validation Engine
 * 
 * All validation logic must go through this service.
 * No validation logic should exist in routes.
 */
export class ResultsValidator {
  private prisma: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || new PrismaClient();
  }

  /**
   * Comprehensive validation for results
   * Used before publish or other critical operations
   */
  async validateAssessmentResults(assessmentId: string, schoolId: string): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];
    const blockers: ValidationError[] = [];

    // Fetch assessment with full context
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
      include: {
        class: {
          include: {
            pupils: true,
            subjectClasses: { include: { subject: true } },
          },
        },
        results: {
          include: { pupil: true, subjectRef: true },
        },
        _count: { select: { results: true } },
      },
    });

    if (!assessment) {
      return {
        isValid: false,
        errors: [{
          field: 'assessment',
          message: 'Assessment not found',
          severity: 'error',
        }],
        warnings: [],
        blockers: [{
          field: 'assessment',
          message: 'Assessment not found',
          severity: 'error',
        }],
      };
    }

    // VALIDATION 1: Component configuration
    const componentError = this.validateComponentData(assessment.componentData);
    if (componentError) {
      errors.push(componentError);
      blockers.push(componentError);
    }

    // VALIDATION 1.1: Ensure at least one result exists
    if (assessment.results.length === 0) {
      const noResultsError: ValidationError = {
        field: 'results',
        message: 'Assessment has no recorded results yet',
        severity: 'error',
        details: { expectedResults: true },
      };
      errors.push(noResultsError);
      blockers.push(noResultsError);
    }

    // VALIDATION 2: Grading scale exists
    const gradingScales = await this.prisma.gradingScale.findMany({
      where: { schoolId: assessment.schoolId },
    });

    if (gradingScales.length === 0) {
      const warn: ValidationError = {
        field: 'gradingScale',
        message: 'No custom grading scale defined. Using defaults.',
        severity: 'warning',
      };
      warnings.push(warn);
    }

    const assessmentClasses =
      assessment.classId && assessment.class
        ? [assessment.class]
        : await this.prisma.class.findMany({
            where: { schoolId: assessment.schoolId, phase: assessment.phase },
            include: {
              pupils: true,
              subjectClasses: { include: { subject: true } },
            },
          });
    const expectedPupils = assessmentClasses.flatMap((classRecord) =>
      classRecord.pupils.filter(isStudentCurrentlyEnrolled)
    );
    const expectedPupilIds = new Set(expectedPupils.map((pupil) => pupil.id));
    const actualPupilIds = new Set(
      assessment.results
        .map((result) => result.pupilId)
        .filter((pupilId) => expectedPupilIds.has(pupilId))
    );

    // VALIDATION 3: Student coverage for active pupils in the assessment's class or phase.
    if (expectedPupils.length > actualPupilIds.size) {
      const missingCount = expectedPupils.length - actualPupilIds.size;
      const error: ValidationError = {
        field: 'studentCoverage',
        message: `Teachers still need to record results for ${missingCount} student${missingCount === 1 ? '' : 's'}.`,
        severity: 'error',
        details: {
          expected: expectedPupils.length,
          recorded: actualPupilIds.size,
          missing: missingCount,
        },
      };
      errors.push(error);
      blockers.push(error);
    }

    // VALIDATION 4: Subject coverage per active pupil.
    const missingSubjects: Array<{ pupilName: string; subjectName: string }> = [];
    for (const classRecord of assessmentClasses) {
      const expectedSubjects = new Set(classRecord.subjectClasses.map((sc) => sc.subject.id));
      for (const pupil of classRecord.pupils.filter(isStudentCurrentlyEnrolled)) {
        const pupilSubjects = new Set(
          assessment.results
            .filter((result) => result.pupilId === pupil.id)
            .map((result) => result.subjectId)
        );

        for (const subjectId of expectedSubjects) {
          if (!pupilSubjects.has(subjectId)) {
            const subject = classRecord.subjectClasses.find(
              (subjectClass) => subjectClass.subject.id === subjectId
            )?.subject;
            missingSubjects.push({
              pupilName: `${pupil.firstName} ${pupil.lastName}`,
              subjectName: subject?.name || 'Unknown',
            });
          }
        }
      }
    }

    if (missingSubjects.length > 0) {
      const error: ValidationError = {
        field: 'subjectCoverage',
        message: `Teachers still need to complete ${missingSubjects.length} student-subject entry${missingSubjects.length === 1 ? '' : 'ies'}.`,
        severity: 'error',
        details: {
          count: missingSubjects.length,
          samples: missingSubjects.slice(0, 5),
        },
      };
      errors.push(error);
      blockers.push(error);
    }

    const activeRosterResults = assessment.results.filter((result) =>
      expectedPupilIds.has(result.pupilId)
    );

    // Inactive pupils' saved rows are retained but no longer block a current assessment.
    const resultsWithoutTotals = activeRosterResults.filter(
      (r) => r.totalScore === null || r.totalScore === undefined
    );
    if (resultsWithoutTotals.length > 0) {
      const error: ValidationError = {
        field: 'totalScores',
        message: `Teachers still need to enter total scores for ${resultsWithoutTotals.length} result${resultsWithoutTotals.length === 1 ? '' : 's'}.`,
        severity: 'error',
        details: { count: resultsWithoutTotals.length },
      };
      errors.push(error);
      blockers.push(error);
    }

    // VALIDATION 6: Grades assigned
    const resultsWithoutGrades = activeRosterResults.filter(
      (r) => r.grade === null || r.grade === undefined
    );
    if (resultsWithoutGrades.length > 0) {
      const error: ValidationError = {
        field: 'grades',
        message: `Teachers still need to assign grades for ${resultsWithoutGrades.length} result${resultsWithoutGrades.length === 1 ? '' : 's'}.`,
        severity: 'error',
        details: { count: resultsWithoutGrades.length },
      };
      errors.push(error);
      blockers.push(error);
    }

    // VALIDATION 7: Positions calculated
    const resultsWithoutPositions = activeRosterResults.filter(
      (r) => !r.classPosition || !r.subjectPosition
    );
    if (resultsWithoutPositions.length > 0) {
      const error: ValidationError = {
        field: 'positions',
        message: `Teachers still need to record their scores or to confirm positions for ${resultsWithoutPositions.length} result${resultsWithoutPositions.length === 1 ? '' : 's'}.`,
        severity: 'error',
        details: { count: resultsWithoutPositions.length },
      };
      errors.push(error);
      blockers.push(error);
    }

    // VALIDATION 8: Invalid scores block publishing.
    const components = assessment.componentData
      ? parseAssessmentScoreComponents(assessment.componentData)
      : null;
    for (const result of activeRosterResults) {
      let invalidScore: string | null = null;
      if (result.totalScore !== null && result.totalScore !== undefined &&
          (!Number.isFinite(result.totalScore) || result.totalScore < 0 || result.totalScore > 100)) {
        invalidScore = `total score ${result.totalScore} is outside 0-100`;
      }

      if (components && result.scores) {
        try {
          const parsedScores: unknown = JSON.parse(result.scores);
          if (!parsedScores || typeof parsedScores !== 'object' || Array.isArray(parsedScores)) {
            invalidScore = invalidScore ?? 'component scores are malformed';
          } else {
            calculateWeightedTotalScore(
              components,
              parsedScores as Record<string, number | null | undefined>
            );
          }
        } catch (error) {
          invalidScore =
            invalidScore ??
            (error instanceof Error ? error.message : 'component scores are invalid');
        }
      } else if (assessment.componentData) {
        try {
          normalizeTeacherAssessmentScores(assessment.componentData, result);
        } catch (error) {
          invalidScore =
            invalidScore ??
            (error instanceof Error ? error.message : 'component scores are invalid');
        }
      }

      if (invalidScore) {
        const error: ValidationError = {
          field: 'scoreRange',
          message: `Student ${result.pupil.firstName} ${result.pupil.lastName}: ${invalidScore}.`,
          severity: 'error',
          details: { studentId: result.pupilId },
        };
        errors.push(error);
        blockers.push(error);
      }
    }

    return {
      isValid: blockers.length === 0,
      errors,
      warnings,
      blockers,
    };
  }

  /**
   * Validate component data structure
   */
  private validateComponentData(componentData: string | null): ValidationError | null {
    if (!componentData) {
      return {
        field: 'componentData',
        message: 'Assessment has no component structure defined',
        severity: 'error',
        details: {
          action: 'CONFIGURE_COMPONENTS',
        },
      };
    }

    try {
      const data = JSON.parse(componentData);
      const components = data.components || [];

      if (!Array.isArray(components) || components.length === 0) {
        return {
          field: 'componentData',
          message: 'No components defined in assessment structure',
          severity: 'error',
        };
      }

      const componentIds = new Set<string>();
      for (const component of components) {
        if (
          typeof component.id !== 'string' ||
          component.id.trim().length === 0 ||
          typeof component.name !== 'string' ||
          component.name.trim().length === 0 ||
          typeof component.maxScore !== 'number' ||
          !Number.isFinite(component.maxScore) ||
          typeof component.weight !== 'number' ||
          !Number.isFinite(component.weight)
        ) {
          return {
            field: 'componentData',
            message: `Component missing valid ID, name, maximum score, or weight: ${component.name || 'unnamed'}`,
            severity: 'error',
          };
        }

        if (componentIds.has(component.id)) {
          return {
            field: 'componentData',
            message: `Duplicate component ID: ${component.id}`,
            severity: 'error',
          };
        }
        componentIds.add(component.id);

        if (component.maxScore <= 0) {
          return {
            field: 'componentData',
            message: `Component "${component.name}" has invalid maxScore: ${component.maxScore}`,
            severity: 'error',
          };
        }

        if (component.weight < 0 || component.weight > 100) {
          return {
            field: 'componentData',
            message: `Component "${component.name}" has invalid weight: ${component.weight}%`,
            severity: 'error',
          };
        }
      }

      const totalWeight = components.reduce((sum: number, component: any) => sum + component.weight, 0);
      if (Math.abs(totalWeight - 100) > 0.01) {
        return {
          field: 'componentData',
          message: `Component weights total ${totalWeight}%, must equal 100%`,
          severity: 'error',
          details: { totalWeight },
        };
      }

      return null;
    } catch (e) {
      return {
        field: 'componentData',
        message: 'Invalid component data format (not valid JSON)',
        severity: 'error',
      };
    }
  }

  /**
   * Validate single result entry
   */
  async validateResultEntry(
    resultId: string,
    scores: Record<string, number>,
    assessmentId: string,
    schoolId: string
  ): Promise<ValidationResult> {
    const result = await this.prisma.result.findFirst({
      where: { id: resultId, assessment: { schoolId } },
      include: { assessment: true, pupil: true },
    });

    if (!result) {
      return {
        isValid: false,
        errors: [{
          field: 'result',
          message: 'Result not found',
          severity: 'error',
        }],
        warnings: [],
        blockers: [{
          field: 'result',
          message: 'Result not found',
          severity: 'error',
        }],
      };
    }

    if (result.assessment.schoolId !== schoolId) {
      return {
        isValid: false,
        errors: [{ field: 'result', message: 'Result not found', severity: 'error' }],
        warnings: [],
        blockers: [{ field: 'result', message: 'Result not found', severity: 'error' }],
      };
    }

    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];
    const blockers: ValidationError[] = [];

    // Check assessment has components
    const componentError = this.validateComponentData(result.assessment.componentData);
    if (componentError) {
      return {
        isValid: false,
        errors: [componentError],
        warnings: [],
        blockers: [componentError],
      };
    }

    // Validate score ranges
    try {
      const config = JSON.parse(result.assessment.componentData!);
      const components = config.components || [];

      for (const component of components) {
        const score = scores[component.id];
        if (score !== undefined && score !== null) {
          if (score < 0 || score > component.maxScore) {
            const error: ValidationError = {
              field: 'score',
              message: `${component.name}: ${score} is outside valid range 0-${component.maxScore}`,
              severity: 'error',
            };
            errors.push(error);
            blockers.push(error);
          }
        }
      }
    } catch (e) {
      // Already validated above
    }

    return {
      isValid: errors.length === 0 && blockers.length === 0,
      errors,
      warnings: [],
      blockers,
    };
  }

  /**
   * Check if ready for publish
   */
  async isReadyForPublish(assessmentId: string, schoolId: string): Promise<{ ready: boolean; reason?: string }> {
    const validation = await this.validateAssessmentResults(assessmentId, schoolId);

    if (!validation.isValid) {
      const reason = validation.blockers[0]?.message || validation.errors[0]?.message || 'Unknown error';
      return {
        ready: false,
        reason: `Validation failed: ${reason}`,
      };
    }

    return { ready: true };
  }
}
