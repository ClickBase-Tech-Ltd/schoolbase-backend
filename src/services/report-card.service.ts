import { PrismaClient } from '@prisma/client';
import resolveReportSignatory from './signatory-resolver.js';
import { getDistinctStudentCount } from './report-card-statistics.js';
import { resolveStoredAssessmentTotal } from './result-score-calculation.js';

interface SubjectResult {
  subjectId: string;
  subjectName: string;
  caScore: number | null;
  testScore: number | null;
  examScore: number | null;
  totalScore: number;
  grade: string;
  subjectPosition: number | null;
  teacherRemark: string | null;
  comment: string | null;
}

interface ReportCardData {
  student: {
    id: string;
    name: string;
    admissionNo: string | null;
    gender: string | null;
    dateOfBirth: string | null;
    photoUrl: string | null;
  };
  gradingScale: Array<{
    grade: string;
    minScore: number;
    maxScore: number;
  }>;
  school: {
    id: string;
    name: string;
    address: string | null;
    logoUrl: string | null;
    stampUrl: string | null;
    principalName: string | null;
    principalSignatureUrl: string | null;
    initials: string | null;
  };
  class: {
    name: string;
    phase: string;
  };
  signatory?: {
    id?: string | null;
    name?: string | null;
    title?: string | null;
    signatureUrl?: string | null;
    source?: string | null;
  } | null;
  term: {
    name: string;
    session: string; // Academic year name
    sortOrder: number | null;
  };
  subjects: SubjectResult[];
  averageScore: number;
  classPosition: number | null;
  totalSubjects: number;
  teacherRemark: string | null;
  principalRemark: string | null;
  publishedAt?: string | null;
  statistics: {
    highestScore: number;
    lowestScore: number;
    passRate: number; // Percentage
  };
  thirdTermHistory?: {
    terms: Array<{
      id: string;
      name: string;
      sortOrder: number;
    }>;
    entries: Array<{
      subjectId: string | null;
      subjectName: string;
      currentTotal: number | null;
      cumulativeTotal: number | null;
      previousTotals: Array<{
        termId: string;
        termName: string;
        sortOrder: number;
        totalScore: number | null;
        examScore: number | null;
      }>;
    }>;
  } | null;
}

class ReportCardService {
  private prisma: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || new PrismaClient();
  }

  private async calculateGrade(schoolId: string, totalScore: number, storedGrade: string | null): Promise<string> {
    const gradingScales = await this.prisma.gradingScale.findMany({
      where: { schoolId },
      orderBy: { minScore: 'desc' },
    });

    if (gradingScales.length > 0) {
      for (const scale of gradingScales) {
        if (totalScore >= scale.minScore && totalScore <= scale.maxScore) {
          return scale.grade;
        }
      }

      return gradingScales[gradingScales.length - 1].grade;
    }

    if (totalScore >= 70) return 'A';
    if (totalScore >= 60) return 'B';
    if (totalScore >= 50) return 'C';
    if (totalScore >= 45) return 'D';
    if (totalScore >= 40) return 'E';

    return storedGrade || 'F';
  }

  private async getThirdTermHistory(
    assessment: any,
    schoolId: string,
    pupilId: string,
    currentSubjects: SubjectResult[]
  ) {
    const currentTerm = assessment.term;
    if (!currentTerm?.sortOrder || currentTerm.sortOrder !== 3 || !currentTerm.academicYear?.id) {
      return null;
    }

    const previousTerms = await this.prisma.term.findMany({
      where: {
        academicYearId: currentTerm.academicYear.id,
        sortOrder: { in: [1, 2] },
      },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        sortOrder: true,
      },
    });

    if (previousTerms.length === 0) {
      return null;
    }

    const buildSubjectKey = (subjectId: string | null, subject: string | null) =>
      subjectId ? `id:${subjectId}` : `name:${subject?.trim().toLowerCase() ?? ''}`;

    const previousResults = await this.prisma.result.findMany({
      where: {
        assessment: {
          termId: { in: previousTerms.map((term) => term.id) },
          status: 'PUBLISHED',
          schoolId,
        },
        pupilId,
      },
      include: {
        assessment: {
          select: {
            term: {
              select: {
                id: true,
                name: true,
                sortOrder: true,
              },
            },
          },
        },
      },
    });

    const publishedTermData = new Map<string, {
      totalScore: number;
      examScore: number;
      totalCount: number;
      examCount: number;
    }>();

    previousResults.forEach((previousResult) => {
      const termSort = previousResult.assessment?.term?.sortOrder;
      if (!termSort) return;

      const subjectKey = buildSubjectKey(previousResult.subjectId ?? null, previousResult.subject ?? null);
      const key = `${pupilId}:${subjectKey}:${termSort}`;
      const existingTermData = publishedTermData.get(key) ?? {
        totalScore: 0,
        examScore: 0,
        totalCount: 0,
        examCount: 0,
      };

      if (typeof previousResult.totalScore === 'number') {
        existingTermData.totalScore += previousResult.totalScore;
        existingTermData.totalCount += 1;
      }

      if (typeof previousResult.examScore === 'number') {
        existingTermData.examScore += previousResult.examScore;
        existingTermData.examCount += 1;
      }

      publishedTermData.set(key, existingTermData);
    });

    const historicalTotals = await (this.prisma as any).historicalTermTotal.findMany({
      where: {
        schoolId,
        academicYearId: currentTerm.academicYear.id,
        termId: { in: previousTerms.map((term) => term.id) },
        studentId: pupilId,
      },
    });

    const historicalTotalMap = new Map<string, number>();
    historicalTotals.forEach((record: any) => {
      const subjectKey = buildSubjectKey(record.subjectId ?? null, record.subject ?? null);
      historicalTotalMap.set(`${pupilId}:${record.termId}:${subjectKey}`, record.totalScore);
    });

    const entries = currentSubjects
      .map((subject) => {
        const subjectKey = buildSubjectKey(subject.subjectId || null, subject.subjectName || null);
        const previousTotals = previousTerms.map((term) => {
          const publishedKey = `${pupilId}:${subjectKey}:${term.sortOrder}`;
          const publishedTotals = publishedTermData.get(publishedKey);
          let totalScore: number | null = null;
          let examScore: number | null = null;

          if (publishedTotals && publishedTotals.totalCount > 0) {
            totalScore = Math.round(publishedTotals.totalScore);
            examScore = publishedTotals.examCount > 0 ? Math.round(publishedTotals.examScore) : null;
          } else {
            const historyKey = `${pupilId}:${term.id}:${subjectKey}`;
            const historicalScore = historicalTotalMap.get(historyKey);
            if (typeof historicalScore === 'number') {
              totalScore = Math.round(historicalScore);
            }
          }

          return {
            termId: term.id,
            termName: term.name,
            sortOrder: term.sortOrder,
            totalScore,
            examScore,
          };
        });

        const currentTotal = subject.totalScore ?? null;
        const cumulativeTotal =
          currentTotal === null
            ? null
            : previousTotals.reduce((sum, termTotal) => sum + (termTotal.totalScore ?? 0), 0) + currentTotal;

        return {
          subjectId: subject.subjectId || null,
          subjectName: subject.subjectName,
          currentTotal,
          cumulativeTotal,
          previousTotals,
        };
      })
      .filter(
        (entry) =>
          entry.previousTotals.some((termTotal) => termTotal.totalScore !== null) ||
          entry.currentTotal !== null
      );

    return {
      terms: previousTerms,
      entries,
    };
  }

  /**
   * Generate complete report card data for a student on an assessment
   */
  async generateReportCard(
    assessmentId: string,
    pupilId: string,
    schoolId: string,
    explicitSignatoryId?: string | null,
    explicitSignatoryMode?: 'auto' | 'principal' | null
  ): Promise<ReportCardData> {
    // Get assessment with all details
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
      include: {
        term: { include: { academicYear: true } },
        class: true,
      },
    });

    if (!assessment) {
      throw new Error('Assessment not found');
    }

    // Get pupil
    const pupil = await this.prisma.pupil.findFirst({
      where: { id: pupilId, schoolId },
      include: { class: true },
    });

    if (!pupil) {
      throw new Error('Student not found');
    }

    // Get school
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
    });

    if (!school) {
      throw new Error('School not found');
    }

    // Get all results for this student in this assessment
    const results = await this.prisma.result.findMany({
      where: {
        assessmentId,
        pupilId,
        assessment: { schoolId },
        pupil: { schoolId },
      },
      include: {
        subjectRef: true,
      },
    });

    // Get class info (use from pupil or assessment)
    const classInfo = pupil.class || assessment.class;
    if (!classInfo) {
      throw new Error('Class information not found');
    }

    // Build subject results
    const subjects: SubjectResult[] = [];

    for (const result of results) {
      const subjectName = result.subjectRef?.name || result.subject || 'Unknown';
      if (!subjectName || subjectName === 'Unknown') {
        continue;
      }

      const totalScore = resolveStoredAssessmentTotal(assessment.componentData, result);
      if (totalScore === null) continue;
      const grade = await this.calculateGrade(schoolId, totalScore, result.grade);

      subjects.push({
        subjectId: result.subjectId || '',
        subjectName,
        caScore: result.caScore ?? null,
        testScore: result.testScore ?? null,
        examScore: result.examScore ?? null,
        totalScore,
        grade,
        subjectPosition: result.subjectPosition,
        teacherRemark: result.teacherRemark,
        comment: result.comment,
      });
    }

    subjects.sort((a, b) => a.subjectName.localeCompare(b.subjectName));

    const thirdTermHistory = await this.getThirdTermHistory(assessment, schoolId, pupil.id, subjects);

    // Calculate statistics
    const validScores = subjects.map((subject) => subject.totalScore);
    const averageScore =
      validScores.length > 0
        ? Math.round((validScores.reduce((a, b) => a + b, 0) / validScores.length) * 100) / 100
        : 0;

    const passCount = subjects.filter((s) => s.totalScore >= 40).length;
    const passRate =
      subjects.length > 0
        ? Math.round((passCount / subjects.length) * 100 * 100) / 100
        : 0;

    // Get student's class position (should be same across all subjects)
    const classPosition = results[0]?.classPosition || null;

    // principalRemark will be determined from resolved signatory if present,
    // otherwise fall back to any per-result principalRemark (but never read from School table)
    let principalRemark: string | null = results[0]?.principalRemark || null;

    // Get teacher remark (from first result with one)
    const teacherRemark =
      results.find((r) => r.teacherRemark)?.teacherRemark ||
      results[0]?.comment ||
      null;
    const publishedAt = results.find((r) => r.publishedAt)?.publishedAt?.toISOString() ?? null;

    const gradingScaleRows = await this.prisma.gradingScale.findMany({
      where: { schoolId },
      orderBy: { minScore: 'desc' },
      select: { grade: true, minScore: true, maxScore: true },
    });

    const gradingScale = gradingScaleRows.length > 0
      ? gradingScaleRows.map((scale) => ({
          grade: scale.grade,
          minScore: scale.minScore,
          maxScore: scale.maxScore,
        }))
      : [
          { grade: 'A', minScore: 70, maxScore: 100 },
          { grade: 'B', minScore: 60, maxScore: 69 },
          { grade: 'C', minScore: 50, maxScore: 59 },
          { grade: 'D', minScore: 45, maxScore: 49 },
          { grade: 'E', minScore: 40, maxScore: 44 },
          { grade: 'F', minScore: 0, maxScore: 39 },
        ];

    // Resolve signatory for this pupil/school (centralized resolver)
    let resolvedSignatory = null;
    try {
      if (explicitSignatoryMode === 'principal') {
        // Find an active Signatory that represents the principal role.
        const principalSign = await this.prisma.signatory.findFirst({
          where: {
            schoolId,
            active: true,
            OR: [
              { key: 'principal' },
              { title: { contains: 'principal' } },
              { name: { contains: 'principal' } },
            ],
          },
          orderBy: { createdAt: 'desc' },
        });

        if (principalSign) {
          resolvedSignatory = {
            signatoryId: principalSign.id,
            name: principalSign.name,
            title: principalSign.title,
            signatureUrl: principalSign.signatureUrl,
            comment: (principalSign as any).comment ?? null,
            source: 'explicit' as const,
          };
        } else {
          resolvedSignatory = { source: 'none' as const };
        }
      } else {
        resolvedSignatory = await resolveReportSignatory({ prisma: this.prisma, schoolId, pupilId: pupil.id, explicitSignatoryId: explicitSignatoryId ?? null });
      }
    } catch (e) {
      resolvedSignatory = null;
    }

    // If we have a resolved signatory, prefer its comment as the principal remark
    if (resolvedSignatory && (resolvedSignatory as any).comment) {
      principalRemark = (resolvedSignatory as any).comment ?? principalRemark;
    }

    return {
      student: {
        id: pupil.id,
        name: `${pupil.lastName} ${pupil.firstName}${pupil.middleName ? ' ' + pupil.middleName : ''}`.trim(),
        admissionNo: pupil.admissionNo,
        gender: pupil.gender,
        dateOfBirth: pupil.dateOfBirth?.toISOString().split('T')[0] || null,
        photoUrl: pupil.photoUrl,
      },
      school: {
        id: school.id,
        name: school.name,
        address: school.address,
        logoUrl: school.logoUrl,
        stampUrl: school.stampUrl,
        principalName: school.principalName,
        principalSignatureUrl: school.principalSignatureUrl,
        initials: school.initials,
      },
      class: {
        name: classInfo.name,
        phase: classInfo.phase,
      },
      signatory: resolvedSignatory
        ? {
            id: (resolvedSignatory as any).signatoryId ?? null,
            name: (resolvedSignatory as any).name ?? null,
            title: (resolvedSignatory as any).title ?? null,
            signatureUrl: (resolvedSignatory as any).signatureUrl ?? null,
            source: (resolvedSignatory as any).source ?? null,
          }
        : null,
      gradingScale,
      term: {
        name: assessment.term?.name || 'Unknown',
        session: assessment.term?.academicYear?.name || 'Unknown',
        sortOrder: assessment.term?.sortOrder ?? null,
      },
      subjects,
      averageScore,
      classPosition,
      totalSubjects: subjects.length,
      teacherRemark,
      principalRemark,
      publishedAt,
      statistics: {
        highestScore: validScores.length > 0 ? Math.max(...validScores) : 0,
        lowestScore: validScores.length > 0 ? Math.min(...validScores) : 0,
        passRate,
      },
      thirdTermHistory,
    };
  }

  /**
   * Generate report cards for all students in an assessment
   */
  async generateBulkReportCards(
    assessmentId: string,
    schoolId: string,
    explicitSignatoryId?: string | null,
    explicitSignatoryMode?: 'auto' | 'principal' | null
  ): Promise<ReportCardData[]> {
    // Get assessment
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
    });

    if (!assessment) {
      throw new Error('Assessment not found');
    }

    // Get all results for this assessment
    const results = await this.prisma.result.findMany({
      where: { assessmentId, assessment: { schoolId }, pupil: { schoolId } },
      select: { pupilId: true },
      distinct: ['pupilId'],
    });

    // Generate report card for each student
    const reportCards: ReportCardData[] = [];

    for (const result of results) {
      try {
        const reportCard = await this.generateReportCard(
          assessmentId,
          result.pupilId,
          schoolId,
          explicitSignatoryId ?? null,
          explicitSignatoryMode ?? null
        );
        reportCards.push(reportCard);
      } catch (error) {
        console.error(
          `Error generating report card for pupil ${result.pupilId}:`,
          error
        );
      }
    }

    return reportCards;
  }

  /**
   * Get report card summary (for listing)
   */
  async getReportCardSummaries(assessmentId: string, schoolId: string) {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
      include: {
        class: true,
        term: { include: { academicYear: true } },
        _count: { select: { results: true } },
      },
    });

    if (!assessment) {
      throw new Error('Assessment not found');
    }

    // Get all unique students in this assessment
    const results = await this.prisma.result.findMany({
      where: { assessmentId, assessment: { schoolId }, pupil: { schoolId } },
      include: {
        pupil: true,
      },
      distinct: ['pupilId'],
    });

    // Get grouped statistics
    const summaries = results.map((result) => ({
      pupilId: result.pupilId,
      pupilName: `${result.pupil.lastName} ${result.pupil.firstName}`,
      admissionNo: result.pupil.admissionNo,
      classPosition: result.classPosition,
      totalScore: result.totalScore,
      grade: result.grade,
    }));

    return {
      assessment: {
        id: assessment.id,
        name: assessment.name,
        status: assessment.status,
        class: assessment.class?.name,
        term: assessment.term?.name,
        session: assessment.term?.academicYear?.name,
      },
      totalStudents: summaries.length,
      summaries: summaries.sort((a, b) => {
        // Sort by class position, then by total score
        if (a.classPosition && b.classPosition) {
          return a.classPosition - b.classPosition;
        }
        return (b.totalScore || 0) - (a.totalScore || 0);
      }),
    };
  }

  /**
   * Calculate class-wide statistics
   */
  async getClassStatistics(assessmentId: string, schoolId: string) {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
      include: {
        _count: { select: { results: true } },
      },
    });

    if (!assessment) {
      throw new Error('Assessment not found');
    }

    // Get all results
    const results = await this.prisma.result.findMany({
      where: { assessmentId, assessment: { schoolId }, pupil: { schoolId } },
    });

    const computedResults = results.map((r) => {
      return {
        ...r,
        computedTotal: resolveStoredAssessmentTotal(assessment.componentData, r),
      };
    });

    const scores = computedResults
      .filter((r) => r.computedTotal !== null)
      .map((r) => r.computedTotal!);

    const distinctStudentCount = getDistinctStudentCount(results);

    if (scores.length === 0) {
      return {
        assessmentId,
        totalStudents: distinctStudentCount,
        totalResults: results.length,
        statistics: {
          highestScore: 0,
          lowestScore: 0,
          averageScore: 0,
          medianScore: 0,
          standardDeviation: 0,
          passCount: 0,
          passRate: 0,
          gradeDistribution: {},
        },
      };
    }

    // Calculate statistics
    scores.sort((a, b) => a - b);

    const median =
      scores.length % 2 === 0
        ? (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2
        : scores[Math.floor(scores.length / 2)];

    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance =
      scores.reduce((sum, score) => sum + Math.pow(score - mean, 2), 0) /
      scores.length;
    const standardDeviation = Math.sqrt(variance);

    // Grade distribution
    const gradeDistribution: Record<string, number> = {};
    results.forEach((r) => {
      if (r.grade) {
        gradeDistribution[r.grade] = (gradeDistribution[r.grade] || 0) + 1;
      }
    });

    const passCount = scores.filter((s) => s >= 40).length;

    return {
      assessmentId,
      totalStudents: distinctStudentCount,
      totalResults: results.length,
      statistics: {
        highestScore: Math.max(...scores),
        lowestScore: Math.min(...scores),
        averageScore: Math.round(mean * 100) / 100,
        medianScore: Math.round(median * 100) / 100,
        standardDeviation: Math.round(standardDeviation * 100) / 100,
        passCount,
        passRate: Math.round((passCount / scores.length) * 100 * 100) / 100,
        gradeDistribution,
      },
    };
  }
}

export default ReportCardService;
