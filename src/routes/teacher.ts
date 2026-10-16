// @ts-nocheck
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { verifyAuth, requireTeacher, AuthenticatedRequest } from '../middleware/roleAuth.js';
import { filterActiveStudents, isStudentCurrentlyEnrolled } from '../services/student-lifecycle.js';
import ResultsEngineService from '../services/results-engine.service.js';

const router = Router();
const prisma = new PrismaClient();
const resultsEngine = new ResultsEngineService(prisma);

const DEFAULT_WA_COMPONENTS = [
  { id: 'ca', name: 'Continuous Assessment', maxScore: 20, weight: 20, sortOrder: 1 },
  { id: 'test', name: 'Test', maxScore: 20, weight: 20, sortOrder: 2 },
  { id: 'exam', name: 'Examination', maxScore: 60, weight: 60, sortOrder: 3 },
];

function getAssessmentComponents(componentData?: string | null) {
  if (!componentData) return DEFAULT_WA_COMPONENTS;

  try {
    const parsed = JSON.parse(componentData);
    const components = Array.isArray(parsed?.components) ? parsed.components : [];

    if (components.length === 0) return DEFAULT_WA_COMPONENTS;

    return [...components].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  } catch {
    return DEFAULT_WA_COMPONENTS;
  }
}

function normalizeTeacherResultScores(
  componentData: string | null,
  score: {
    caScore?: number | null;
    testScore?: number | null;
    examScore?: number | null;
    totalScore?: number | null;
  }
) {
  const components = getAssessmentComponents(componentData);
  const rawScores = {
    ca: score.caScore ?? null,
    test: score.testScore ?? null,
    exam: score.examScore ?? null,
  };

  const mappedScores: Record<string, number | null> = {};
  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    const id = (component.id ?? '').toString().toLowerCase();
    const name = (component.name ?? '').toString().toLowerCase();
    let value: number | null = null;

    if (id.includes('ca') || name.includes('ca') || name.includes('continuous')) {
      value = rawScores.ca;
    } else if (id.includes('test') || name.includes('test')) {
      value = rawScores.test;
    } else if (id.includes('exam') || name.includes('exam') || name.includes('examination')) {
      value = rawScores.exam;
    } else if (index === 0) {
      value = rawScores.ca;
    } else if (index === 1) {
      value = rawScores.test;
    } else if (index === 2) {
      value = rawScores.exam;
    } else {
      value = rawScores.ca ?? rawScores.test ?? rawScores.exam ?? null;
    }

    mappedScores[component.id] = value;
  }

  const allScoresPresent = Object.values(mappedScores).every(
    (value) => value !== null && value !== undefined
  );

  const totalScore =
    score.totalScore !== null && score.totalScore !== undefined
      ? score.totalScore
      : allScoresPresent
      ? parseFloat(
          components
            .reduce((sum, component) => {
              const componentValue = mappedScores[component.id] ?? 0;
              return sum + (componentValue / component.maxScore) * component.weight;
            }, 0)
            .toFixed(1)
        )
      : null;

  const scoresJson: Record<string, number> = {};
  for (const component of components) {
    const componentValue = mappedScores[component.id];
    if (componentValue !== null && componentValue !== undefined) {
      scoresJson[component.id] = componentValue;
    }
  }

  return { totalScore, scoresJson };
}

// Apply authentication middleware to all teacher routes
router.use(verifyAuth);
router.use(requireTeacher);

router.get('/school', async (req: AuthenticatedRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(403).json({ error: 'Teacher session has no school scope' });

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        id: true,
        name: true,
        slug: true,
        initials: true,
        tagline: true,
        logoUrl: true,
        phone: true,
        email: true,
        address: true,
        city: true,
        country: true,
        currency: true,
        timezone: true,
        websiteEnabled: true,
        manualPaymentAccountName: true,
        manualPaymentAccountNumber: true,
        manualPaymentBankName: true,
        paymentAccounts: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            label: true,
            bankName: true,
            accountName: true,
            accountNumber: true,
            branchName: true,
            currency: true,
            purpose: true,
            isDefault: true,
            isActive: true,
          },
        },
      },
    });

    if (!school) return res.status(404).json({ error: 'School not found' });
    return res.json(school);
  } catch (error) {
    console.error('[GET /api/teacher/school] Failed to fetch teacher school profile:', error);
    return res.status(500).json({ error: 'Failed to fetch school profile' });
  }
});

// GET /api/teacher/dashboard - Teacher dashboard data
router.get('/dashboard', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;

    // Get teacher info
    const teacher = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    // Get school info
    const school = await prisma.school.findUnique({
      where: { id: schoolId! },
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        country: true,
      },
    });

    // Get assigned classes
    const teacherClasses = await prisma.teacherClass.findMany({
      where: { teacherId: userId, schoolId },
      include: {
        class: {
          include: {
            pupils: { select: { id: true, firstName: true, lastName: true, isActive: true, status: true } },
          },
        },
      },
    });

    const classIds = teacherClasses.map((teacherClass) => teacherClass.class.id);

    // Get assigned subjects
    const teacherSubjects = await prisma.teacherSubject.findMany({
      where: {
        teacherId: userId,
        schoolId,
        subject: {
          subjectClasses: {
            some: {
              classId: { in: classIds },
            },
          },
        },
      },
      include: {
        subject: true,
      },
    });

    // Calculate total students
    const allStudentIds = new Set<string>();
    teacherClasses.forEach((tc) => {
      filterActiveStudents(tc.class.pupils).forEach((p) => {
        allStudentIds.add(p.id);
      });
    });

    res.json({
      teacher: {
        id: teacher.id,
        name: teacher.name,
        email: teacher.email,
        role: teacher.role,
      },
      school,
      classes: teacherClasses.map((tc) => ({
        id: tc.class.id,
        name: tc.class.name,
        phase: tc.class.phase,
        arm: tc.class.arm,
        studentCount: filterActiveStudents(tc.class.pupils).length,
      })),
      subjects: teacherSubjects.map((ts) => ({
        id: ts.subject.id,
        name: ts.subject.name,
      })),
      totalStudents: allStudentIds.size,
      classCount: teacherClasses.length,
    });
  } catch (error: any) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/teacher/classes - Get all classes assigned to teacher
router.get('/classes', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId } = req.user!;

    const { schoolId } = req.user!;

    const classes = await prisma.teacherClass.findMany({
      where: { teacherId: userId, schoolId },
      include: {
        class: {
          include: {
            pupils: true,
          },
        },
      },
    });

    res.json({
      classes: classes.map((tc) => {
        const activePupils = filterActiveStudents(tc.class.pupils);

        return {
          id: tc.class.id,
          name: tc.class.name,
          phase: tc.class.phase,
          arm: tc.class.arm,
          studentCount: activePupils.length,
          pupils: activePupils.map((p) => ({
            id: p.id,
            name: `${p.firstName} ${p.lastName}`,
            admissionNo: p.admissionNo,
            email: p.studentEmail,
          })),
        };
      }),
    });
  } catch (error: any) {
    console.error('Classes error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/teacher/classes/:classId/students - Get students in a specific class
router.get('/classes/:classId/students', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId } = req.user!;
    const { classId } = req.params;

    // Verify teacher has access to this class
    const { schoolId } = req.user!;

    const assignment = await prisma.teacherClass.findFirst({
      where: {
        teacherId: userId,
        classId,
        schoolId,
      },
    });

    if (!assignment) {
      return res.status(403).json({ error: 'Unauthorized: Not assigned to this class' });
    }

    const pupils = await prisma.pupil.findMany({
      where: {
        schoolId,
        classId,
        isActive: true,
        OR: [{ status: null }, { status: { not: 'INACTIVE' } }],
      },
      include: {
        class: {
          select: {
            id: true,
            name: true,
            arm: true,
            phase: true,
          },
        },
        guardians: {
          include: {
            guardian: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phone: true,
                email: true,
              },
            },
          },
        },
      },
      orderBy: { firstName: 'asc' },
    });

    res.json({
      students: filterActiveStudents(pupils).map((p) => ({
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        admissionNo: p.admissionNo,
        email: p.studentEmail,
        photoUrl: p.photoUrl,
        status: p.isActive ? 'ACTIVE' : 'INACTIVE',
        class: p.class,
        guardians: p.guardians,
      })),
    });
  } catch (error: any) {
    console.error('Students error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/teacher/students/:studentId - Get the full read-only profile for an assigned student
router.get('/students/:studentId', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;
    const { studentId } = req.params;

    const pupil = await prisma.pupil.findFirst({
      where: {
        id: studentId,
        schoolId,
        class: { teacherClasses: { some: { teacherId: userId, schoolId } } },
      },
      include: { class: true, guardians: { include: { guardian: true } } },
    });

    if (!pupil) return res.status(404).json({ error: 'Student not found' });

    const [invoices, attendanceRecords, termSummaries, promotionHistory, invoiceTotals] = await Promise.all([
      prisma.invoice.findMany({
        where: { pupilId: studentId, schoolId },
        include: { feeSchedule: { include: { term: { include: { academicYear: true } } } }, payments: { orderBy: { paidAt: 'desc' }, take: 5 }, adjustments: true },
        orderBy: { createdAt: 'desc' },
        take: 12,
      }),
      prisma.attendanceRecord.findMany({ where: { pupilId: studentId, schoolId }, orderBy: { date: 'desc' }, take: 30 }),
      prisma.studentTermSummary.findMany({ where: { pupilId: studentId, schoolId }, orderBy: { updatedAt: 'desc' }, take: 8 }),
      prisma.promotionRecord.findMany({ where: { pupilId: studentId, schoolId }, orderBy: { decidedAt: 'desc' }, take: 8 }),
      prisma.invoice.aggregate({ where: { pupilId: studentId, schoolId }, _sum: { amountDue: true, amountPaid: true }, _count: { _all: true } }),
    ]);

    const totalDue = invoiceTotals._sum.amountDue || 0;
    const totalPaid = invoiceTotals._sum.amountPaid || 0;
    const attendance = {
      total: attendanceRecords.length,
      present: attendanceRecords.filter((record) => record.status === 'PRESENT').length,
      absent: attendanceRecords.filter((record) => record.status === 'ABSENT').length,
      late: attendanceRecords.filter((record) => record.status === 'LATE').length,
    };

    res.json({
      ...pupil,
      feesBalance: totalDue - totalPaid,
      invoiceCount: invoiceTotals._count._all,
      invoices,
      attendance: { ...attendance, percentage: attendance.total > 0 ? Math.round(((attendance.present + attendance.late * 0.5) / attendance.total) * 100) : null, records: attendanceRecords },
      termSummaries,
      promotionHistory,
    });
  } catch (error) {
    console.error('Error fetching teacher student profile:', error);
    res.status(500).json({ error: 'Failed to fetch student profile' });
  }
});

// GET /api/teacher/subjects - Get assigned subjects
router.get('/subjects', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;
    const assessmentId = typeof req.query.assessmentId === 'string' ? req.query.assessmentId : null;

    const teacherClasses = await prisma.teacherClass.findMany({
      where: { teacherId: userId, schoolId },
      select: {
        classId: true,
        class: {
          select: {
            phase: true,
          },
        },
      },
    });

    const classIds = teacherClasses.map((teacherClass) => teacherClass.classId);

    if (classIds.length === 0) {
      return res.json({ subjects: [] });
    }

    let phaseFilter: 'EARLY_YEARS' | 'PRIMARY' | 'SECONDARY' | null = null;
    if (assessmentId) {
      const assessment = await prisma.assessment.findFirst({
        where: { id: assessmentId, schoolId },
        select: { phase: true },
      });

      if (!assessment) {
        return res.status(404).json({ error: 'Assessment not found' });
      }

      phaseFilter = assessment.phase as 'EARLY_YEARS' | 'PRIMARY' | 'SECONDARY';
    }

    const subjects = await prisma.teacherSubject.findMany({
      where: {
        teacherId: userId,
        schoolId,
        subject: {
          subjectClasses: {
            some: {
              classId: { in: classIds },
              ...(phaseFilter ? { class: { phase: phaseFilter } } : {}),
            },
          },
        },
      },
      include: {
        subject: {
          include: {
            subjectClasses: {
              where: { classId: { in: classIds } },
              include: { class: { select: { id: true, name: true, arm: true, phase: true } } },
            },
          },
        },
      },
    });

    res.json({
      subjects: subjects.map((ts) => ({
        id: ts.subjectId,
        name: ts.subject.name,
        code: ts.subject.code,
        classes: ts.subject.subjectClasses.map((subjectClass) => subjectClass.class),
      })),
    });
  } catch (error: any) {
    console.error('Subjects error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/teacher/assessments - Get assessments for teacher's assigned classes
router.get('/assessments', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;

    // Get teacher's assigned classes
    const teacherClasses = await prisma.teacherClass.findMany({
      where: { teacherId: userId, schoolId },
      include: {
        class: {
          select: {
            phase: true,
            pupils: {
              select: {
                id: true,
                isActive: true,
                status: true,
              },
            },
          },
        },
      },
    });

    const teacherSubjects = await prisma.teacherSubject.findMany({
      where: {
        teacherId: userId,
        schoolId,
        subject: {
          subjectClasses: {
            some: {
              classId: { in: teacherClasses.map((teacherClass) => teacherClass.classId) },
            },
          },
        },
      },
      select: {
        subject: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    // Get unique phases from assigned classes
    const phases = Array.from(new Set(teacherClasses.map((tc) => tc.class.phase)));

    const studentsByPhase = new Map<string, Set<string>>();
    teacherClasses.forEach((teacherClass) => {
      const phase = teacherClass.class.phase;
      const students = studentsByPhase.get(phase) ?? new Set<string>();

      filterActiveStudents(teacherClass.class.pupils).forEach((pupil) => {
        students.add(pupil.id);
      });

      studentsByPhase.set(phase, students);
    });

    if (phases.length === 0) {
      // Teacher has no assigned classes
      return res.json({ assessments: [] });
    }

    const academicYears = await prisma.academicYear.findMany({
      where: { schoolId },
      select: {
        id: true,
        name: true,
        isCurrent: true,
      },
      orderBy: [{ isCurrent: 'desc' }, { name: 'asc' }],
    });

    // Get assessments matching teacher's class phases
    const assessments = await prisma.assessment.findMany({
      where: {
        schoolId,
        phase: { in: phases },
      },
      select: {
        id: true,
        name: true,
        phase: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        term: {
          select: {
            id: true,
            name: true,
            academicYear: {
              select: {
                id: true,
                name: true,
                isCurrent: true,
              },
            },
          },
        },
        results: {
          select: {
            lockedAt: true,
            subjectId: true,
            subject: true,
            subjectRef: { select: { id: true, name: true } },
          },
        },
        _count: {
          select: {
            results: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({
      assessments: assessments.map((assessment) => ({
        ...assessment,
        subjects: Array.from(
          new Map(
            assessment.results
              .map((result) => {
                const subjectId = result.subjectId || result.subjectRef?.id || null;
                const subjectName = result.subjectRef?.name || result.subject || null;
                return subjectName ? [subjectId || subjectName, { id: subjectId, name: subjectName }] : null;
              })
              .filter((subject): subject is [string, { id: string | null; name: string }] => Boolean(subject)),
          ).values(),
        ),
        isLocked: assessment.results.some((result) => result.lockedAt !== null),
        canEdit: !assessment.results.some((result) => result.lockedAt !== null) && assessment.status !== 'PUBLISHED',
        studentCount: studentsByPhase.get(assessment.phase)?.size ?? 0,
        entryCount: assessment._count.results,
        subjectCount: new Set(assessment.results.map((result) => result.subjectId || result.subjectRef?.id || result.subjectRef?.name || result.subject).filter(Boolean)).size,
        sessionName: assessment.term?.academicYear?.name ?? null,
      })),
      sessions: academicYears.map((academicYear) => ({
        id: academicYear.id,
        name: academicYear.name,
        isCurrent: academicYear.isCurrent,
      })),
    });
  } catch (error: any) {
    console.error('Assessments error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/teacher/assessments/:assessmentId - Get assessment with results (supports ?subject=subjectId filter)
router.get('/assessments/:assessmentId', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;
    const { assessmentId } = req.params;
    const subjectIdParam = typeof req.query.subjectId === 'string' ? req.query.subjectId : null;
    const subjectParam = typeof req.query.subject === 'string' ? req.query.subject : null;

    // Verify teacher is assigned to a class with this assessment's phase
    const teacherClasses = await prisma.teacherClass.findMany({
      where: { teacherId: userId, schoolId },
      include: {
        class: {
          select: {
            name: true,
            phase: true,
            pupils: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                admissionNo: true,
                isActive: true,
                status: true,
              },
            },
          },
        },
      },
    });

    const teacherSubjects = await prisma.teacherSubject.findMany({
      where: { teacherId: userId, schoolId },
      select: {
        subject: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    const phases = Array.from(new Set(teacherClasses.map((tc) => tc.class.phase)));

    const assessment = await prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
      include: {
        term: {
          include: {
            academicYear: true,
          },
        },
        results: {
          include: {
            pupil: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                admissionNo: true,
                isActive: true,
                status: true,
              },
            },
            subjectRef: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!assessment || assessment.schoolId !== schoolId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Check if teacher is authorized to view this assessment (phase must match)
    if (!phases.includes(assessment.phase)) {
      return res.status(403).json({ error: 'Not authorized to view this assessment' });
    }

    const activeAssessmentResults = assessment.results.filter((result) =>
      isStudentCurrentlyEnrolled({
        isActive: result.pupil?.isActive ?? true,
        status: result.pupil?.status ?? null,
      })
    );

    // Filter results by subject if provided
    let filteredResults = activeAssessmentResults;
    if (subjectIdParam) {
      const allowedSubjectIds = new Set(teacherSubjects.map((teacherSubject) => teacherSubject.subject.id));
      if (!allowedSubjectIds.has(subjectIdParam)) {
        return res.status(403).json({ error: 'Not authorized to view this subject' });
      }

      filteredResults = activeAssessmentResults.filter((r) => r.subjectId === subjectIdParam);
    } else if (subjectParam) {
      // Backward compatibility for existing links that still send a subject name.
      const allowedSubjectNames = new Set(teacherSubjects.map((teacherSubject) => teacherSubject.subject.name));
      if (!allowedSubjectNames.has(subjectParam)) {
        return res.status(403).json({ error: 'Not authorized to view this subject' });
      }

      filteredResults = activeAssessmentResults.filter((r) => 
        r.subjectRef?.name === subjectParam || r.subject === subjectParam
      );
    }

    const phaseClassIds = teacherClasses
      .filter((teacherClass) => teacherClass.class.phase === assessment.phase)
      .map((teacherClass) => teacherClass.classId);

    let eligibleClassIds = new Set<string>(phaseClassIds);
    let forcedSubjectName: string | null = null;

    if (subjectIdParam || subjectParam) {
      const allowedSubjectIds = new Set(teacherSubjects.map((teacherSubject) => teacherSubject.subject.id));
      const allowedSubjectNames = new Set(teacherSubjects.map((teacherSubject) => teacherSubject.subject.name));

      if (subjectIdParam) {
        if (!allowedSubjectIds.has(subjectIdParam)) {
          return res.status(403).json({ error: 'Not authorized to view this subject' });
        }
      } else if (subjectParam) {
        if (!allowedSubjectNames.has(subjectParam)) {
          return res.status(403).json({ error: 'Not authorized to view this subject' });
        }
      }

      const teacherSubjectAssignment = teacherSubjects.find((teacherSubject) => {
        if (subjectIdParam) return teacherSubject.subject.id === subjectIdParam;
        return teacherSubject.subject.name === subjectParam;
      });

      if (!teacherSubjectAssignment) {
        return res.status(403).json({ error: 'Not authorized to view this subject' });
      }

      const subjectClasses = await prisma.subjectClass.findMany({
        where: {
          schoolId,
          subjectId: teacherSubjectAssignment.subject.id,
          classId: { in: phaseClassIds },
        },
        select: {
          classId: true,
        },
      });

      if (subjectClasses.length === 0) {
        return res.status(403).json({
          error: 'Not authorized to view this subject for the assessment classes',
        });
      }

      eligibleClassIds = new Set(subjectClasses.map((subjectClass) => subjectClass.classId));
      forcedSubjectName = teacherSubjectAssignment.subject.name;

      if (subjectIdParam) {
        filteredResults = activeAssessmentResults.filter((r) => r.subjectId === subjectIdParam);
      } else {
        filteredResults = activeAssessmentResults.filter(
          (r) => r.subjectRef?.name === subjectParam || r.subject === subjectParam
        );
      }
    }

    const rosterMap = new Map<
      string,
      {
        id: string;
        firstName: string;
        lastName: string;
        admissionNo: string;
      }
    >();

    const pupilClassMap = new Map<
      string,
      {
        classId: string;
        className: string;
      }
    >();

    teacherClasses
      .filter(
        (teacherClass) =>
          teacherClass.class.phase === assessment.phase && eligibleClassIds.has(teacherClass.classId)
      )
      .forEach((teacherClass) => {
        const classInfo = {
          classId: teacherClass.classId,
          className: teacherClass.class.name,
        };

        filterActiveStudents(teacherClass.class.pupils).forEach((pupil) => {
          if (!rosterMap.has(pupil.id)) {
            rosterMap.set(pupil.id, {
              id: pupil.id,
              firstName: pupil.firstName,
              lastName: pupil.lastName,
              admissionNo: pupil.admissionNo ?? '',
            });
          }

          if (!pupilClassMap.has(pupil.id)) {
            pupilClassMap.set(pupil.id, classInfo);
          }
        });
      });

    const resultsByPupilId = new Map<string, typeof filteredResults>(
      filteredResults.reduce((acc, result) => {
        const existing = acc.get(result.pupilId) ?? [];
        existing.push(result);
        acc.set(result.pupilId, existing);
        return acc;
      }, new Map<string, typeof filteredResults>())
    );

    const rosterResults: Array<{
      id: string | null;
      pupilId: string;
      pupilName: string;
      admissionNo: string;
      classId: string | null;
      className: string | null;
      subjectId: string | null;
      subject: string;
      caScore: number | null;
      testScore: number | null;
      examScore: number | null;
      totalScore: number | null;
      grade: string | null;
    }> = [];

    for (const pupil of rosterMap.values()) {
      const pupilResults = resultsByPupilId.get(pupil.id) ?? [];

      if (pupilResults.length > 0) {
        for (const result of pupilResults) {
          const subjectName =
            forcedSubjectName || result.subjectRef?.name || result.subject || 'Unknown';

          const totalFromResult = result.totalScore ?? null;
          const computedTotal =
            totalFromResult !== null
              ? totalFromResult
              : result.caScore !== null && result.testScore !== null && result.examScore !== null
              ? result.caScore + result.testScore + result.examScore
              : null;

          let grade = result.grade ?? null;
          if (!grade && computedTotal !== null) {
            grade = await resultsEngine.calculateGrade(schoolId!, computedTotal);
          }

          const pupilClass = pupilClassMap.get(pupil.id);
      rosterResults.push({
            id: result.id,
            pupilId: pupil.id,
            pupilName: `${pupil.lastName} ${pupil.firstName}`,
            admissionNo: pupil.admissionNo,
            classId: pupilClass?.classId ?? null,
            className: pupilClass?.className ?? null,
            subjectId: result.subjectId ?? null,
            subject: subjectName,
            caScore: result.caScore ?? null,
            testScore: result.testScore ?? null,
            examScore: result.examScore ?? null,
            totalScore: computedTotal,
            grade,
          });
        }
      } else {
        const pupilClass = pupilClassMap.get(pupil.id);
        rosterResults.push({
          id: null,
          pupilId: pupil.id,
          pupilName: `${pupil.lastName} ${pupil.firstName}`,
          admissionNo: pupil.admissionNo,
          classId: pupilClass?.classId ?? null,
          className: pupilClass?.className ?? null,
          subjectId: subjectIdParam ?? null,
          subject: forcedSubjectName || 'Unknown',
          caScore: null,
          testScore: null,
          examScore: null,
          totalScore: null,
          grade: null,
        });
      }
    }

    rosterResults.sort((a, b) => {
      const studentComparison = a.pupilName.localeCompare(b.pupilName);
      if (studentComparison !== 0) return studentComparison;
      return a.subject.localeCompare(b.subject);
    });

    const uniqueStudentCount = rosterMap.size;
    const resultSubjects = Array.from(
      new Set(filteredResults.map((result) => result.subjectRef?.name || result.subject || forcedSubjectName || 'Unknown'))
    )
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    const isLocked = activeAssessmentResults.some((result) => result.lockedAt !== null);

    res.json({
      assessment: {
        id: assessment.id,
        name: assessment.name,
        phase: assessment.phase,
        status: assessment.status,
        isLocked,
        canEdit: !isLocked && assessment.status !== 'PUBLISHED',
        studentCount: uniqueStudentCount,
        entryCount: filteredResults.length,
        subjectCount: resultSubjects.length,
        subjects: resultSubjects,
        results: rosterResults,
      },
    });
  } catch (error: any) {
    console.error('Assessment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/teacher/classes/:classId/assessments - Get assessments for a specific class assigned to teacher
router.get('/classes/:classId/assessments', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;
    const { classId } = req.params;

    // Verify teacher is assigned to this class
    const assignment = await prisma.teacherClass.findFirst({
      where: {
        teacherId: userId,
        classId,
        schoolId,
      },
      include: {
        class: true,
      },
    });

    if (!assignment) {
      return res.status(403).json({ error: 'Unauthorized: Not assigned to this class' });
    }

    // Get current academic year and term
    const currentTerm = await prisma.term.findFirst({
      where: {
        academicYear: {
          schoolId,
          isCurrent: true,
        },
      },
    });

    if (!currentTerm) {
      return res.json({ assessments: [] });
    }

    // Get assessments for this class's phase and current term
    const assessments = await prisma.assessment.findMany({
      where: {
        schoolId,
        phase: assignment.class.phase,
        termId: currentTerm.id,
        status: { in: ['APPROVED', 'PUBLISHED'] }, // Only show approved/published assessments
      },
      select: {
        id: true,
        name: true,
        phase: true,
        status: true,
        createdAt: true,
        _count: {
          select: {
            results: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ 
      assessments: assessments.map((a) => ({
        id: a.id,
        title: a.name,
        type: a.phase,
        status: a.status,
        createdAt: a.createdAt,
        resultsCount: a._count.results,
      })),
    });
  } catch (error: any) {
    console.error('Class assessments error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/teacher/results/:classId - Get existing results for a class
router.get('/results/:classId', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;
    const { classId } = req.params;

    // Verify teacher is assigned to this class
    const assignment = await prisma.teacherClass.findUnique({
      where: {
        teacherId_classId: {
          teacherId: userId,
          classId,
        },
      },
      include: {
        class: true,
      },
    });

    if (!assignment) {
      return res.status(403).json({ error: 'Unauthorized: Not assigned to this class' });
    }

    // Get all results for this class's assessments
    const results = await prisma.result.findMany({
      where: {
        assessment: {
          schoolId,
          phase: assignment.class.phase,
        },
      },
      include: {
        assessment: {
          select: {
            id: true,
            termId: true,
          },
        },
      },
    });

    res.json({ 
      results: results.map((r) => ({
        id: r.id,
        studentId: r.pupilId,
        assessmentId: r.assessmentId,
        caScore: r.caScore,
        testScore: r.testScore,
        examScore: r.examScore,
        totalScore: r.totalScore,
        grade: r.grade,
        score: r.totalScore, // Also include for compatibility
      })),
    });
  } catch (error: any) {
    console.error('Results error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/teacher/results - Save result scores (supports optional subject parameter)
router.post('/results', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;
    const { assessmentId, scores: requestScores, entries: requestEntries, subjectId, subject } = req.body;
    const scores = Array.isArray(requestScores)
      ? requestScores
      : Array.isArray(requestEntries)
      ? requestEntries
      : [];

    if (!assessmentId || !Array.isArray(scores)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify assessment belongs to teacher's school
    const assessment = await prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
    });

    if (!assessment || assessment.schoolId !== schoolId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const teacherClasses = await prisma.teacherClass.findMany({
      where: {
        teacherId: userId,
        schoolId,
      },
      select: {
        classId: true,
        class: {
          select: {
            phase: true,
          },
        },
      },
    });

    const eligiblePupilIds = new Set(
      (
        await prisma.pupil.findMany({
          where: {
            schoolId,
            id: { in: scores.map((score) => score.pupilId).filter(Boolean) },
            isActive: true,
            OR: [{ status: null }, { status: { not: 'INACTIVE' } }],
          },
          select: { id: true },
        })
      ).map((pupil) => pupil.id)
    );

    const filteredScores = scores.filter((score) => {
      const pupilId = score.pupilId;
      return typeof pupilId === 'string' && eligiblePupilIds.has(pupilId);
    });

    if (filteredScores.length === 0) {
      return res.json({ success: true, results: [] });
    }

    const existingAssessmentResults = await prisma.result.findMany({
      where: { assessmentId },
      select: { lockedAt: true },
    });

    const assessmentIsLocked = existingAssessmentResults.some((result) => result.lockedAt !== null);
    const assessmentIsPublished = assessment.status === 'PUBLISHED';

    if (assessmentIsPublished || assessmentIsLocked) {
      return res.status(403).json({ error: 'This assessment is locked and can no longer be edited.' });
    }

    const classIdsInAssessmentPhase = teacherClasses
      .filter((teacherClass) => teacherClass.class.phase === assessment.phase)
      .map((teacherClass) => teacherClass.classId);

    // If subject is specified, verify teacher is assigned to it
    if ((subjectId && typeof subjectId === 'string') || (subject && typeof subject === 'string')) {
      const teacherSubjectAssignment = await prisma.teacherSubject.findFirst({
        where: {
          teacherId: userId,
          schoolId,
          ...(subjectId && typeof subjectId === 'string'
            ? { subjectId }
            : {
                subject: {
                  name: subject,
                },
              }),
        },
        include: {
          subject: true,
        },
      });

      if (!teacherSubjectAssignment) {
        return res.status(403).json({ error: `Not authorized to score subject` });
      }

      const subjectClassAssignment = await prisma.subjectClass.findFirst({
        where: {
          schoolId,
          subjectId: teacherSubjectAssignment.subjectId,
          classId: {
            in: classIdsInAssessmentPhase,
          },
        },
        include: {
          class: true,
          subject: true,
        },
      });

      if (!subjectClassAssignment) {
        return res.status(403).json({
          error: 'Not authorized to score this subject for the assessment class',
        });
      }

      const resolvedSubjectId = teacherSubjectAssignment.subjectId;
      const resolvedSubjectName = teacherSubjectAssignment.subject.name;

      // Bulk upsert results
      const results = await Promise.all(
        filteredScores.map(
          (score: {
            pupilId: string;
            caScore?: number | null;
            testScore?: number | null;
            examScore?: number | null;
            totalScore?: number | null;
          }) => {
            const { totalScore, scoresJson } = normalizeTeacherResultScores(
              assessment.componentData,
              score
            );

            return prisma.result.upsert({
              where: {
                assessmentId_pupilId_subject: {
                  assessmentId,
                  pupilId: score.pupilId,
                  subject: resolvedSubjectName,
                },
              },
              update: {
                classId: assessment.classId ?? null,
                subjectId: resolvedSubjectId,
                subject: resolvedSubjectName,
                caScore: score.caScore,
                testScore: score.testScore,
                examScore: score.examScore,
                totalScore,
                scores: Object.keys(scoresJson).length > 0 ? JSON.stringify(scoresJson) : undefined,
                grade: null,
                classPosition: null,
                subjectPosition: null,
                updatedBy: userId,
              },
              create: {
                assessmentId,
                pupilId: score.pupilId,
                subjectId: resolvedSubjectId,
                subject: resolvedSubjectName,
                classId: assessment.classId ?? null,
                caScore: score.caScore,
                testScore: score.testScore,
                examScore: score.examScore,
                totalScore,
                scores: Object.keys(scoresJson).length > 0 ? JSON.stringify(scoresJson) : undefined,
                updatedBy: userId,
              },
            });
          }
        )
      );

      return res.json({ success: true, results });
    }

    // Bulk upsert results
    const results = await Promise.all(
      filteredScores.map(
        (score: {
          pupilId: string;
          caScore?: number | null;
          testScore?: number | null;
          examScore?: number | null;
          totalScore?: number | null;
        }) => {
          const { totalScore, scoresJson } = normalizeTeacherResultScores(
            assessment.componentData,
            score
          );

          return prisma.result.upsert({
            where: {
              assessmentId_pupilId_subject: {
                assessmentId,
                pupilId: score.pupilId,
                subject: subject || null,
              },
            },
            update: {
              classId: assessment.classId ?? null,
              subjectId: null,
              caScore: score.caScore,
              testScore: score.testScore,
              examScore: score.examScore,
              totalScore,
              scores: Object.keys(scoresJson).length > 0 ? JSON.stringify(scoresJson) : undefined,
              grade: null,
              classPosition: null,
              subjectPosition: null,
              updatedBy: userId,
            },
            create: {
              assessmentId,
              pupilId: score.pupilId,
              subject: subject || null,
              subjectId: null,
              classId: assessment.classId ?? null,
              caScore: score.caScore,
              testScore: score.testScore,
              examScore: score.examScore,
              totalScore,
              scores: Object.keys(scoresJson).length > 0 ? JSON.stringify(scoresJson) : undefined,
              updatedBy: userId,
            },
          });
        }
      )
    );

    res.json({ success: true, results });
  } catch (error: any) {
    console.error('Results save error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/teacher/attendance - Save attendance records
router.post('/attendance', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;
    const { classId, date, attendanceData } = req.body;

    if (!classId || !date || !Array.isArray(attendanceData)) {
      return res.status(400).json({ error: 'classId, date, and attendanceData array required' });
    }

    // Verify teacher is assigned to this class
    const assignment = await prisma.teacherClass.findFirst({
      where: {
        teacherId: userId,
        classId,
        schoolId,
      },
    });

    if (!assignment) {
      return res.status(403).json({ error: 'Unauthorized: Not assigned to this class' });
    }

    // Parse date
    const attendanceDate = new Date(date);
    attendanceDate.setUTCHours(0, 0, 0, 0);

    // Validate attendance statuses
    const validStatuses = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'];
    for (const att of attendanceData) {
      if (!validStatuses.includes(att.status)) {
        return res.status(400).json({ error: `Invalid status: ${att.status}` });
      }
    }

    // Delete existing records for this date and class
    await prisma.attendanceRecord.deleteMany({
      where: {
        schoolId,
        classId,
        date: attendanceDate,
      },
    });

    const activePupilIds = new Set(
      (
        await prisma.pupil.findMany({
          where: {
            schoolId,
            classId,
            isActive: true,
            OR: [{ status: null }, { status: { not: 'INACTIVE' } }],
          },
          select: { id: true },
        })
      ).map((pupil) => pupil.id)
    );

    const validAttendance = attendanceData.filter((att: { studentId?: string; pupilId?: string; status: string }) => {
      const pupilId = att.pupilId || att.studentId;
      return typeof pupilId === 'string' && activePupilIds.has(pupilId);
    });

    // Create new attendance records
    const records = await Promise.all(
      validAttendance.map((att: { studentId?: string; pupilId?: string; status: string }) => {
        const pupilId = att.pupilId || att.studentId;
        if (!pupilId) {
          throw new Error('pupilId or studentId required for each attendance record');
        }
        return prisma.attendanceRecord.create({
          data: {
            schoolId,
            classId,
            pupilId: pupilId!, // Non-null assertion after validation
            date: attendanceDate,
            status: att.status as any,
          },
        });
      })
    );

    res.status(201).json({
      success: true,
      message: `Marked attendance for ${records.length} students`,
      recordsCreated: records.length,
    });
  } catch (error: any) {
    console.error('Error marking attendance:', error);
    res.status(500).json({ error: 'Failed to mark attendance' });
  }
});

// GET /api/teacher/attendance/summary?classId=X&startDate=Y&endDate=Z - Get attendance summary for a date range
router.get('/attendance/summary', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;
    const { classId, startDate, endDate } = req.query;

    if (!classId || !startDate || !endDate) {
      return res.status(400).json({ error: 'classId, startDate, and endDate query parameters required' });
    }

    // Verify teacher is assigned to this class
    const assignment = await prisma.teacherClass.findUnique({
      where: {
        teacherId_classId: {
          teacherId: userId,
          classId: classId as string,
        },
      },
    });

    if (!assignment) {
      return res.status(403).json({ error: 'Unauthorized: Not assigned to this class' });
    }

    // Parse dates
    const start = new Date(startDate as string);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(endDate as string);
    end.setUTCHours(0, 0, 0, 0);

    // Fetch students in the class
    const students = await prisma.pupil.findMany({
      where: {
        schoolId,
        classId: classId as string,
        isActive: true,
        OR: [{ status: null }, { status: { not: 'INACTIVE' } }],
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        admissionNo: true,
        isActive: true,
        status: true,
      },
      orderBy: { firstName: 'asc' },
    });

    // Fetch attendance records for the date range
    const attendanceRecords = await prisma.attendanceRecord.findMany({
      where: {
        schoolId,
        classId: classId as string,
        date: {
          gte: start,
          lte: end,
        },
      },
      select: {
        pupilId: true,
        date: true,
        status: true,
      },
    });

    const activeStudents = filterActiveStudents(students);

    // Group attendance by student and date
    const attendanceByStudent: Record<string, Record<string, { status: string }>> = {};
    
    activeStudents.forEach((student) => {
      attendanceByStudent[student.id] = {};
    });

    attendanceRecords.forEach((record) => {
      const dateStr = record.date.toISOString().split('T')[0];
      if (!attendanceByStudent[record.pupilId]) {
        attendanceByStudent[record.pupilId] = {};
      }
      attendanceByStudent[record.pupilId][dateStr] = {
        status: record.status,
      };
    });

    // Format response
    const formattedStudents = activeStudents.map((student) => ({
      id: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      admissionNo: student.admissionNo,
      attendance: attendanceByStudent[student.id],
    }));

    res.json({
      students: formattedStudents,
      dateRange: {
        startDate: start.toISOString().split('T')[0],
        endDate: end.toISOString().split('T')[0],
      },
    });
  } catch (error: any) {
    console.error('Error fetching attendance summary:', error);
    res.status(500).json({ error: 'Failed to fetch attendance summary' });
  }
});

// GET /api/teacher/attendance/check - Check if attendance already taken for a date
router.get('/attendance/check', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;
    const { classId, date } = req.query;

    if (!classId || !date) {
      return res.status(400).json({ error: 'classId and date required' });
    }

    // Verify teacher is assigned to this class
    const assignment = await prisma.teacherClass.findUnique({
      where: {
        teacherId_classId: {
          teacherId: userId,
          classId: classId as string,
        },
      },
    });

    if (!assignment) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Parse date
    const checkDate = new Date(date as string);
    checkDate.setUTCHours(0, 0, 0, 0);

    // Check if attendance exists for this date
    const existingAttendance = await prisma.attendanceRecord.findMany({
      where: {
        schoolId,
        classId: classId as string,
        date: checkDate,
      },
      select: { pupilId: true, status: true },
    });

    res.json({
      exists: existingAttendance.length > 0,
      count: existingAttendance.length,
      submittedDate: existingAttendance.length > 0 ? checkDate.toISOString().split('T')[0] : null,
    });
  } catch (error: any) {
    console.error('Error checking attendance:', error);
    res.status(500).json({ error: 'Failed to check attendance' });
  }
});

// GET /api/teacher/profile - Get teacher profile
router.get('/profile', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;

    const teacher = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId! },
      select: { name: true, slug: true },
    });

    res.json({
      id: teacher.id,
      name: teacher.name,
      email: teacher.email,
      role: teacher.role,
      school,
      createdAt: teacher.createdAt,
    });
  } catch (error: any) {
    console.error('Profile error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/teacher/announcements - Get announcements for teacher dashboard
router.get('/announcements', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;

    // Fetch announcements for the school
    const announcements = await prisma.announcement.findMany({
      where: { 
        schoolId,
        published: true,
      },
      select: {
        id: true,
        title: true,
        body: true,
        publishedAt: true,
        createdAt: true,
      },
      orderBy: { publishedAt: 'desc' },
      take: 50,
    });

    res.json({
      announcements: announcements || [],
      total: announcements.length,
    });
  } catch (error: any) {
    console.error('Messages error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
