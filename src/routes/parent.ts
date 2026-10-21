import { Router, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { PrismaClient } from '@prisma/client';
import { recordActivity } from '../middleware/activityAudit.js';
import bcrypt from 'bcryptjs';
import { resolveSupportedCurrency } from '../services/currency.js';
import { getSessionSecret } from '../services/security-config.js';
import { verifyAuth, requireParent, type AuthenticatedRequest } from '../middleware/roleAuth.js';
import { resolveCompetitionFeature } from '../services/competition-feature-gate.js';
import { sumOutstandingInvoiceBalance } from '../services/invoice-balance.js';

const router = Router();
const prisma = new PrismaClient() as PrismaClient & {
  resultPin: any;
  resultPinBatch: any;
};

router.use((req, res, next) => {
  if (req.method === 'POST' && (req.path === '/login' || req.path === '/verify')) return next();
  verifyAuth(req as AuthenticatedRequest, res, () => requireParent(req as AuthenticatedRequest, res, next));
});

function secret() {
  return getSessionSecret();
}

function normalizePhone(phone: string, country?: string) {
  const cleaned = phone.trim().replace(/\s+/g, '').replace(/[^+\d]/g, '');
  if (!cleaned) return '';
  const normalized = cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned;
  if (normalized.startsWith('+')) {
    return normalized;
  }

  if (normalized.startsWith('0')) {
    const countryCodes: Record<string, string> = {
      NG: '+234',
      GH: '+233',
      RW: '+250',
    };
    const code = country ? countryCodes[country.toUpperCase()] : undefined;
    if (code) {
      return `${code}${normalized.slice(1)}`;
    }
  }

  return normalized;
}

function buildLoginPhoneCandidates(phone: string, country?: string) {
  const normalized = normalizePhone(phone, country);
  const candidates = new Set<string>();
  if (!normalized) return [];

  candidates.add(normalized);
  if (normalized.startsWith('+')) {
    const match = normalized.match(/^\+(\d{1,3})(\d+)$/);
    if (match) {
      candidates.add(`0${match[2]}`);
    }
  } else if (normalized.startsWith('0')) {
    const countryCodes: Record<string, string> = {
      NG: '+234',
      GH: '+233',
      RW: '+250',
    };
    const code = country ? countryCodes[country.toUpperCase()] : undefined;
    if (code) {
      candidates.add(`${code}${normalized.slice(1)}`);
    }

    if (!country) {
      candidates.add(`+234${normalized.slice(1)}`);
      candidates.add(`+233${normalized.slice(1)}`);
      candidates.add(`+250${normalized.slice(1)}`);
    }
  }

  return Array.from(candidates);
}

function normalizeAdmission(admissionNo: string) {
  return admissionNo.replace(/\W+/g, '').toLowerCase();
}

async function resolveParentFamily(data: any) {
  const claimedGuardianIds = Array.from(new Set([
    data.guardianId,
    ...(Array.isArray(data.guardianIds) ? data.guardianIds : []),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0)));

  if (claimedGuardianIds.length === 0) return { guardians: [], pupilIds: [] as string[] };

  const primaryGuardian = await prisma.guardian.findUnique({
    where: { id: data.guardianId },
    select: { id: true, schoolId: true, phone: true, whatsapp: true },
  });
  if (!primaryGuardian) return { guardians: [], pupilIds: [] as string[] };

  const school = await prisma.school.findUnique({
    where: { id: primaryGuardian.schoolId },
    select: { country: true },
  });
  const familyPhone = String(data.phone || primaryGuardian.whatsapp || primaryGuardian.phone || '');
  const phoneCandidates = buildLoginPhoneCandidates(familyPhone, school?.country || undefined);
  const phonePredicate = phoneCandidates.flatMap((value) => [
    { phone: value },
    { whatsapp: value },
  ]);

  const familyGuardians = await prisma.guardian.findMany({
    where: {
      schoolId: primaryGuardian.schoolId,
      OR: [
        { id: { in: claimedGuardianIds } },
        ...(phonePredicate.length ? phonePredicate : []),
      ],
    },
    select: {
      id: true,
      schoolId: true,
      firstName: true,
      lastName: true,
      pupils: { select: { pupilId: true } },
    },
  });

  return {
    guardians: familyGuardians,
    schoolId: primaryGuardian.schoolId,
    pupilIds: Array.from(new Set(familyGuardians.flatMap((guardian) => guardian.pupils.map((link) => link.pupilId)))),
  };
}

async function signToken(payload: Record<string, unknown>) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret());
}

router.post('/login', async (req: Request, res: Response) => {
  try {
    const phone = String(req.body.phone ?? '').trim();
    const admissionNo = String(req.body.admissionNo ?? '').trim();
    const schoolSlug = String(req.body.schoolSlug ?? '').trim();

    let country: string | undefined;
    if (schoolSlug) {
      const school = await prisma.school.findUnique({
        where: { slug: schoolSlug },
        select: { country: true },
      });
      country = school?.country ?? undefined;
    }

    const inputAdm = normalizeAdmission(admissionNo);
    let guardianRecord: any | null = null;

    if (inputAdm) {
      const pupilWhere: any = schoolSlug
        ? { school: { slug: schoolSlug }, admissionNo: { contains: admissionNo } }
        : { admissionNo: { contains: admissionNo } };

      const pupils = await prisma.pupil.findMany({
        where: pupilWhere,
        include: { guardians: { include: { guardian: true } } },
        orderBy: { createdAt: 'asc' },
      });

      const matchedPupil = pupils.find((pupil) => {
        const stored = pupil.admissionNo ?? '';
        const normStored = normalizeAdmission(stored);
        return (
          normStored === inputAdm ||
          normStored.startsWith(inputAdm) ||
          inputAdm.startsWith(normStored)
        );
      });

      if (matchedPupil) {
        const phoneCandidates = phone ? buildLoginPhoneCandidates(phone, country) : [];

        if (phoneCandidates.length > 0) {
          for (const gp of matchedPupil.guardians) {
            const guardian = gp.guardian;
            if (!guardian) continue;
            const gPhones = [guardian.phone, guardian.whatsapp].filter(Boolean) as string[];
            if (gPhones.some((value) => phoneCandidates.includes(value))) {
              guardianRecord = guardian;
              break;
            }
          }
        }

      }

      if (guardianRecord) {
        const familyPhone = guardianRecord.whatsapp || guardianRecord.phone || phone;
        const familyPhones = buildLoginPhoneCandidates(familyPhone, country);
        const familyGuardians = await prisma.guardian.findMany({
          where: {
            schoolId: matchedPupil?.schoolId ?? guardianRecord.schoolId,
            OR: familyPhones.flatMap((value) => [{ phone: value }, { whatsapp: value }]),
          },
          select: { id: true },
        });
        const token = await signToken({
          guardianId: guardianRecord.id,
          guardianIds: familyGuardians.map((guardian) => guardian.id),
          schoolId: matchedPupil?.schoolId ?? guardianRecord.schoolId,
          name: `${guardianRecord.firstName} ${guardianRecord.lastName}`,
          phone: familyPhone,
        });

        await recordActivity({ event: 'PARENT_LOGIN_SUCCESS', details: `Parent login succeeded for ${schoolSlug || 'school portal'}`, schoolId: matchedPupil?.schoolId ?? guardianRecord.schoolId }).catch(() => {});
        return res.json({ success: true, token });
      }
    }

    const phoneCandidates = buildLoginPhoneCandidates(phone, country);
    if (phoneCandidates.length === 0) {
      await recordActivity({ event: 'PARENT_LOGIN_FAILED', details: `Parent login failed: invalid phone input for ${schoolSlug || 'school portal'}` }).catch(() => {});
      return res.status(400).json({ error: 'Phone number not found. Contact the school.' });
    }

    const predicate = phoneCandidates.flatMap((value) => [
      { phone: value },
      { whatsapp: value },
    ]);

    const whereCondition = schoolSlug
      ? { school: { slug: schoolSlug }, OR: predicate }
      : { OR: predicate };

    const guardians = await prisma.guardian.findMany({
      where: whereCondition,
      include: { school: true, pupils: { include: { pupil: true } } },
    });

    if (guardians.length === 0) {
      await recordActivity({ event: 'PARENT_LOGIN_FAILED', details: `Parent login failed: guardian not found for ${schoolSlug || 'school portal'}` }).catch(() => {});
      return res.status(404).json({ error: 'Phone number not found. Contact the school.' });
    }

    const schoolIds = Array.from(new Set(guardians.map((guardian) => guardian.schoolId)));
    if (!schoolSlug && schoolIds.length > 1) {
      return res.status(400).json({ error: 'This phone is registered with more than one school. Enter the school slug to continue.' });
    }

    let guardian = guardians[0];
    const sameSchoolGuardians = guardians.filter((item) => item.schoolId === guardian.schoolId);

    if (inputAdm) {
      const matchingGuardian = sameSchoolGuardians.find((candidate) => candidate.pupils.some((gp) => {
        const stored = gp.pupil.admissionNo ?? '';
        const normStored = normalizeAdmission(stored);
        return (
          normStored === inputAdm ||
          normStored.startsWith(inputAdm) ||
          inputAdm.startsWith(normStored)
        );
      }));

      if (!matchingGuardian) {
        await recordActivity({ event: 'PARENT_LOGIN_FAILED', details: `Parent login failed: admission mismatch for ${schoolSlug || 'school portal'}`, schoolId: guardian.schoolId }).catch(() => {});
        return res.status(400).json({ error: 'Admission number does not match this phone.' });
      }
      guardian = matchingGuardian;
    }

    const token = await signToken({
      role: 'PARENT',
      guardianId: guardian.id,
      guardianIds: sameSchoolGuardians.map((item) => item.id),
      schoolId: guardian.schoolId,
      name: `${guardian.firstName} ${guardian.lastName}`,
      phone: guardian.whatsapp || guardian.phone || '',
    });

    await recordActivity({ event: 'PARENT_LOGIN_SUCCESS', details: `Parent login succeeded for ${schoolSlug || 'school portal'}`, schoolId: guardian.schoolId }).catch(() => {});
    res.json({ success: true, token });
  } catch (error) {
    console.error('Parent login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Verify parent session
router.post('/verify', async (req: Request, res: Response) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const sessionCookie = cookieHeader.split(';').find(c => c.trim().startsWith('schoolbase_session='));
    
    if (!sessionCookie) {
      return res.json({ authenticated: false });
    }

    const token = sessionCookie.split('=')[1];
    const { payload } = await jwtVerify(token, secret());
    const data = payload as any;
    if (data.role !== 'PARENT' || typeof data.guardianId !== 'string' || !data.guardianId) {
      return res.json({ authenticated: false });
    }

    return res.json({
      authenticated: true,
      guardianId: data.guardianId,
      name: data.name,
      phone: data.phone,
      schoolId: data.schoolId,
    });
  } catch (error) {
    res.json({ authenticated: false });
  }
});

// Get parent dashboard data
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const sessionCookie = cookieHeader.split(';').find(c => c.trim().startsWith('schoolbase_session='));
    
    if (!sessionCookie) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = sessionCookie.split('=')[1];
    const { payload } = await jwtVerify(token, secret());
    const data = payload as any;

    const family = await resolveParentFamily(data);
    const guardians = await prisma.guardian.findMany({
      where: { id: { in: family.guardians.map((item) => item.id) } },
      include: { 
        pupils: { 
          include: { 
            pupil: { 
              include: { 
                class: true,
              } 
            } 
          } 
        },
        school: true
      },
    });

    const guardian = guardians[0];
    if (!guardian) {
      return res.status(404).json({ error: 'Guardian not found' });
    }

    const children = Array.from(new Map(guardians.flatMap((item: any) => item.pupils).map((gp: any) => [gp.pupil.id, gp.pupil])).values()).map((pupil: any) => ({
      id: pupil.id,
      firstName: pupil.firstName,
      lastName: pupil.lastName,
      admissionNo: pupil.admissionNo,
      class: pupil.class,
      status: pupil.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
      latestGrade: null,
    }));

    // Get invoices for all children
    const invoices = await prisma.invoice.findMany({
      where: {
        pupilId: { in: children.map((c: any) => c.id) },
        status: { not: 'VOIDED' },
      },
      include: { pupil: true },
    });

    const outstandingFees = sumOutstandingInvoiceBalance(invoices);

    // Get announcements
    const announcements = await prisma.announcement.findMany({
      where: { 
        schoolId: data.schoolId,
        published: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    res.json({
      guardianName: `${guardian.firstName} ${guardian.lastName}`,
      children,
      outstandingFees,
      announcements: announcements.map(a => ({
        id: a.id,
        title: a.title,
        content: a.body,
        createdAt: a.createdAt,
      })),
      recentResults: [],
    });
  } catch (error) {
    console.error('Error loading dashboard:', error);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// Get parent's children
router.get('/children', async (req: Request, res: Response) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const sessionCookie = cookieHeader.split(';').find(c => c.trim().startsWith('schoolbase_session='));
    
    if (!sessionCookie) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = sessionCookie.split('=')[1];
    const { payload } = await jwtVerify(token, secret());
    const data = payload as any;

    const family = await resolveParentFamily(data);
    const guardians = await prisma.guardian.findMany({
      where: { id: { in: family.guardians.map((item) => item.id) } },
      include: {
        pupils: {
          include: {
            pupil: {
              include: {
                class: true,
                // include pupil guardians so frontend can show DOB and guardian contacts
                guardians: { include: { guardian: true } },
              },
            },
          },
        },
      },
    });

    if (guardians.length === 0) {
      return res.status(404).json({ error: 'Guardian not found' });
    }

    // Get invoices for children
    const invoices = await prisma.invoice.findMany({
      where: {
        pupilId: { in: family.pupilIds },
      },
    });

    const linkedPupils = Array.from(new Map(guardians.flatMap((item: any) => item.pupils).map((gp: any) => [gp.pupil.id, gp.pupil])).values());
    const children = linkedPupils.map((pupil: any) => ({
      id: pupil.id,
      firstName: pupil.firstName,
      lastName: pupil.lastName,
      admissionNo: pupil.admissionNo,
      class: pupil.class,
      photoUrl: pupil.photoUrl || null,
      status: pupil.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
      latestGrade: null,
      dateOfBirth: pupil.dateOfBirth ?? null,
      guardians: (pupil.guardians || []).map((g: any) => g.guardian ? {
        id: g.guardian.id,
        firstName: g.guardian.firstName,
        lastName: g.guardian.lastName,
        phone: g.guardian.phone,
        whatsapp: g.guardian.whatsapp,
        email: g.guardian.email,
      } : null).filter(Boolean),
      outstandingFee: invoices
        .filter(inv => inv.pupilId === pupil.id && ['SENT', 'PART_PAID', 'OVERDUE'].includes(inv.status))
        .reduce((sum, inv) => sum + inv.amountDue, 0),
    }));

    res.json({ children });
  } catch (error) {
    console.error('Error loading children:', error);
    res.status(500).json({ error: 'Failed to load children' });
  }
});

router.get('/children/:id/timetable', verifyAuth, async (req: Request, res: Response) => {
  try {
    const session = (req as AuthenticatedRequest).user as (AuthenticatedRequest['user'] & {
      guardianId?: string;
      guardianIds?: string[];
      phone?: string;
    }) | undefined;
    if (!session?.guardianId) return res.status(403).json({ error: 'Parent access required' });

    const family = await resolveParentFamily(session);
    const childId = req.params.id;
    if (!family.pupilIds.includes(childId)) {
      return res.status(403).json({ error: 'Unauthorized access to this child' });
    }

    const pupil = await prisma.pupil.findFirst({
      where: { id: childId, schoolId: family.schoolId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        classId: true,
        class: { select: { name: true, arm: true } },
      },
    });
    if (!pupil) return res.status(404).json({ error: 'Student not found' });
    if (!pupil.classId) {
      return res.json({ child: pupil, timetable: null, periods: [], entries: [] });
    }

    const config = await prisma.timetableConfig.findFirst({
      where: {
        schoolId: family.schoolId,
        status: 'PUBLISHED',
        academicYear: { isCurrent: true },
      },
      include: {
        academicYear: { select: { name: true } },
        term: { select: { name: true } },
        periods: { orderBy: [{ dayOfWeek: 'asc' }, { sortOrder: 'asc' }] },
        entries: {
          where: { schoolId: family.schoolId, classId: pupil.classId },
          include: {
            period: true,
            subject: { select: { name: true } },
            teacher: { select: { name: true } },
          },
          orderBy: [{ period: { dayOfWeek: 'asc' } }, { period: { sortOrder: 'asc' } }],
        },
        scheduledActivities: {
          where: {
            schoolId: family.schoolId,
            OR: [
              { audienceType: 'SCHOOL' },
              { audienceType: 'CLASSES', classes: { some: { classId: pupil.classId } } },
            ],
          },
          include: { activity: true, period: true },
          orderBy: [{ period: { dayOfWeek: 'asc' } }, { period: { sortOrder: 'asc' } }],
        },
      },
      orderBy: { publishedAt: 'desc' },
    });

    if (!config) return res.json({ child: pupil, timetable: null, periods: [], entries: [] });
    return res.json({
      child: pupil,
      timetable: {
        name: config.name,
        academicYear: config.academicYear.name,
        term: config.term?.name || null,
        publishedAt: config.publishedAt,
      },
      periods: config.periods,
      entries: config.entries,
    });
  } catch (error) {
    console.error('Error loading parent timetable:', error);
    return res.status(500).json({ error: 'Failed to load child timetable' });
  }
});

    // GET /api/parent/children/:id - Get single child profile (parent-scoped)
    router.get('/children/:id', async (req: Request, res: Response) => {
      try {
        const cookieHeader = req.headers.cookie || '';
        const sessionCookie = cookieHeader.split(';').find(c => c.trim().startsWith('schoolbase_session='));
    
        if (!sessionCookie) {
          return res.status(401).json({ error: 'Unauthorized' });
        }

        const token = sessionCookie.split('=')[1];
        const { payload } = await jwtVerify(token, secret());
        const data = payload as any;

        const childId = req.params.id;

        // Verify parent has access to this child
        const family = await resolveParentFamily(data);
        if (!family.pupilIds.includes(childId)) {
          return res.status(403).json({ error: 'Unauthorized access to this child' });
        }

        const pupil = await prisma.pupil.findUnique({
          where: { id: childId },
          include: {
            class: true,
            guardians: { include: { guardian: true } },
            school: true,
          },
        });

        if (!pupil) return res.status(404).json({ error: 'Student not found' });

        // Compute fees balance for this child
        const invoices = await prisma.invoice.findMany({ where: { pupilId: childId, status: { not: 'VOIDED' } } });
        const totalDue = invoices.reduce((sum, inv) => sum + inv.amountDue, 0);
        const totalPaid = invoices.reduce((sum, inv) => sum + inv.amountPaid, 0);
        const feesBalance = totalDue - totalPaid;

        res.json({
          id: pupil.id,
          firstName: pupil.firstName,
          lastName: pupil.lastName,
          admissionNo: pupil.admissionNo,
          photoUrl: pupil.photoUrl || null,
          dateOfBirth: pupil.dateOfBirth || null,
          gender: pupil.gender || null,
          class: pupil.class || null,
          medicalNotes: pupil.medicalNotes || null,
          guardians: (pupil.guardians || []).map((g: any) => g.guardian ? {
            id: g.guardian.id,
            firstName: g.guardian.firstName,
            lastName: g.guardian.lastName,
            phone: g.guardian.phone,
            whatsapp: g.guardian.whatsapp,
            email: g.guardian.email,
          } : null).filter(Boolean),
          feesBalance,
        });
      } catch (error) {
        console.error('Error loading child profile:', error);
        res.status(500).json({ error: 'Failed to load child profile' });
      }
    });

// Get child's attendance for today or recent records
router.get('/attendance/:childId', async (req: Request, res: Response) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const sessionCookie = cookieHeader.split(';').find(c => c.trim().startsWith('schoolbase_session='));
    
    if (!sessionCookie) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = sessionCookie.split('=')[1];
    const { payload } = await jwtVerify(token, secret());
    const data = payload as any;

    const childId = req.params.childId;
    const days = req.query.days ? parseInt(req.query.days as string) : 7;

    // Verify parent has access to this child
    const family = await resolveParentFamily(data);
    if (!family.pupilIds.includes(childId)) {
      return res.status(403).json({ error: 'Unauthorized access to this child' });
    }

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    fromDate.setHours(0, 0, 0, 0);

    // Get attendance records for the period
    const attendanceRecords = await prisma.attendanceRecord.findMany({
      where: {
        pupilId: childId,
        date: {
          gte: fromDate,
        },
      },
      orderBy: { date: 'desc' },
      take: 50,
    });

    // Get today's attendance if it exists
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayAttendance = attendanceRecords.find(
      a => new Date(a.date).getTime() === today.getTime()
    );

    // Calculate attendance percentage for the period
    const totalRecords = attendanceRecords.length;
    const presentCount = attendanceRecords.filter(a => a.status === 'PRESENT' || a.status === 'LATE').length;
    const attendancePercentage = totalRecords > 0 ? Math.round((presentCount / totalRecords) * 100) : null;

    res.json({
      todayStatus: todayAttendance?.status || null,
      todayDate: todayAttendance?.date || null,
      attendancePercentage,
      recentRecords: attendanceRecords.slice(0, 10).map(a => ({
        date: a.date,
        status: a.status,
      })),
    });
  } catch (error) {
    console.error('Error loading attendance:', error);
    res.status(500).json({ error: 'Failed to load attendance' });
  }
});

// Get available terms
router.get('/terms', async (req: Request, res: Response) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const sessionCookie = cookieHeader.split(';').find(c => c.trim().startsWith('schoolbase_session='));
    
    if (!sessionCookie) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = sessionCookie.split('=')[1];
    const { payload } = await jwtVerify(token, secret());
    const data = payload as any;

    // Get school from guardian's children
    const family = await resolveParentFamily(data);
    if (!family.schoolId) return res.json({ terms: [] });

    const terms = await prisma.term.findMany({
      where: {
        academicYear: {
          schoolId: family.schoolId,
          isCurrent: true,
        },
      },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true, sortOrder: true },
    });

    res.json({ terms });
  } catch (error) {
    console.error('Error fetching terms:', error);
    res.status(500).json({ error: 'Failed to fetch terms' });
  }
});

async function ensureResultPinAccess(childId: string, suppliedPin?: string | null, termId?: string | null) {
  const child = await prisma.pupil.findUnique({
    where: { id: childId },
    select: { id: true, schoolId: true },
  });

  if (!child) {
    return { allowed: false, requiresPin: false, error: 'Student not found' };
  }

  const school = await prisma.school.findUnique({
    where: { id: child.schoolId },
    select: {
      id: true,
      resultAccessPinEnabled: true,
      resultAccessMode: true,
    },
  });

  if (!school || !school.resultAccessPinEnabled) {
    return { allowed: true, requiresPin: false, matchedPinTermId: null };
  }

  const mode = school.resultAccessMode || 'NONE';
  // Parent portal access should not be blocked by PUBLIC_CHECKER_ONLY mode
  // Mode only affects public result checking, not authenticated parent portal access
  // If PIN is enabled, we'll require it below

  // Allow parent portal access if PIN is enabled (modes: NONE, PARENT_PORTAL_ONLY, BOTH)
  // If no PIN is supplied, request one
  const normalizedPin = String(suppliedPin ?? '').trim();
  if (!normalizedPin) {
    return { allowed: false, requiresPin: true, error: 'Result PIN required', matchedPinTermId: null };
  }

  const candidates = await prisma.resultPin.findMany({
    where: {
      schoolId: child.schoolId,
      status: 'ACTIVE',
      OR: [
        { studentId: child.id },
        { studentId: null },
      ],
      ...(termId ? { termId } : {}),
    },
    select: {
      id: true,
      pinHash: true,
      type: true,
      studentId: true,
      expiresAt: true,
      termId: true,
    },
    orderBy: { generatedAt: 'desc' },
  });

  const now = Date.now();
  for (const candidate of candidates) {
    if (candidate.expiresAt && new Date(candidate.expiresAt).getTime() < now) {
      continue;
    }

    const matches = await bcrypt.compare(normalizedPin, candidate.pinHash);
    if (matches) {
      if (candidate.type === 'GENERIC' && !candidate.studentId) {
        await prisma.resultPin.update({
          where: { id: candidate.id },
          data: { studentId: child.id, assignedAt: new Date() },
        });
      }

      return { allowed: true, requiresPin: false, matchedPinTermId: candidate.termId ?? null };
    }
  }

  return { allowed: false, requiresPin: false, error: 'Invalid result PIN', matchedPinTermId: null };
}

// Get child results by term and assessment
router.get('/results', async (req: Request, res: Response) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const sessionCookie = cookieHeader.split(';').find(c => c.trim().startsWith('schoolbase_session='));

    if (!sessionCookie) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = sessionCookie.split('=')[1];
    const { payload } = await jwtVerify(token, secret());
    const data = payload as any;

    const childId = req.query.childId as string;
    const termId = req.query.termId as string;
    const suppliedPin = req.query.pin as string | undefined;

    if (!childId) {
      return res.status(400).json({ error: 'childId required' });
    }

    const family = await resolveParentFamily(data);
    if (!family.pupilIds.includes(childId)) {
      return res.status(403).json({ error: 'Unauthorized access to this child' });
    }

    const accessCheck = await ensureResultPinAccess(childId, suppliedPin, termId || null);
    if (!accessCheck.allowed) {
      if (accessCheck.requiresPin) {
        return res.status(403).json({ error: accessCheck.error || 'Result PIN required', requiresPin: true });
      }

      return res.status(403).json({ error: accessCheck.error || 'Result PIN validation failed', requiresPin: false });
    }

    const effectiveTermId = termId && termId !== 'latest' ? termId : accessCheck.matchedPinTermId || null;

    // Get child's school and phase
    const child = await prisma.pupil.findUnique({
      where: { id: childId },
      include: {
        class: {
          select: { phase: true, schoolId: true }
        }
      }
    });

    if (!child || !child.class) {
      return res.json({ results: [], term: null });
    }

    // Build where clause for assessments
    const where: any = {
      schoolId: child.class.schoolId,
      phase: child.class.phase,
      status: 'PUBLISHED',
    };

    // If a term was explicitly selected, or the PIN corresponds to a specific term, filter to it.
    if (effectiveTermId && effectiveTermId !== 'latest') {
      where.termId = effectiveTermId;
    }

    // Get the assessments (and their results for this child)
    const assessments = await prisma.assessment.findMany({
      where,
      include: {
        term: {
          select: { id: true, name: true }
        },
        results: {
          where: { pupilId: childId },
          select: {
            id: true,
            caScore: true,
            testScore: true,
            examScore: true,
            totalScore: true,
          }
        }
      },
      orderBy: [
        { term: { sortOrder: 'desc' } },
        { createdAt: 'desc' }
      ]
    });

    // Determine which term to display (latest or selected)
    let selectedTerm = null;
    let filteredAssessments = assessments;

    if (!effectiveTermId || effectiveTermId === 'latest') {
      // Group by term and get latest
      const groupedByTerm = new Map<string, any[]>();
      assessments.forEach((a) => {
        if (a.term) {
          if (!groupedByTerm.has(a.term.id)) {
            groupedByTerm.set(a.term.id, []);
          }
          groupedByTerm.get(a.term.id)!.push(a);
        }
      });

      // Get the latest term by sort order when no explicit term has been requested.
      const latestTerm = assessments
        .map((assessment) => assessment.term)
        .filter((term): term is { id: string; name: string; sortOrder?: number | null } => Boolean(term))
        .sort((a, b) => (b.sortOrder ?? 0) - (a.sortOrder ?? 0))[0] ?? null;

      if (latestTerm) {
        selectedTerm = latestTerm;
        filteredAssessments = assessments.filter((assessment) => assessment.term?.id === latestTerm.id);
      }
    } else {
      selectedTerm = assessments.find((assessment) => assessment.term?.id === effectiveTermId)?.term || null;
      filteredAssessments = assessments.filter((assessment) => assessment.term?.id === effectiveTermId);
    }

    // Transform results - flatten assessment results into subjects
    const results = filteredAssessments
      .filter(a => a.results.length > 0)
      .map(assessment => {
        const result = assessment.results[0];
        return {
          id: result.id,
          subject: assessment.name,
          assessmentId: assessment.id,
          caScore: result.caScore,
          testScore: result.testScore,
          examScore: result.examScore,
          totalScore: result.totalScore,
          grade: result.totalScore ? getGrade(result.totalScore) : null,
        };
      });

    res.json({ 
      results,
      term: selectedTerm,
      assessments: filteredAssessments
    });
  } catch (error) {
    console.error('Error loading results:', error);
    res.status(500).json({ error: 'Failed to load results' });
  }
});

// Get invoices
router.get('/invoices', async (req: Request, res: Response) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const sessionCookie = cookieHeader.split(';').find(c => c.trim().startsWith('schoolbase_session='));
    
    if (!sessionCookie) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = sessionCookie.split('=')[1];
    const { payload } = await jwtVerify(token, secret());
    const data = payload as any;

    const family = await resolveParentFamily(data);
    if (family.guardians.length === 0) {
      return res.status(404).json({ error: 'Guardian not found' });
    }

    const invoices = await prisma.invoice.findMany({
      where: {
        pupilId: { in: family.pupilIds },
        status: { not: 'VOIDED' },
      },
      include: {
        pupil: true,
        feeSchedule: true,
        items: {
          include: {
            allocations: { select: { amount: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      invoices: invoices.map(inv => ({
        id: inv.id,
        childId: inv.pupilId,
        childName: `${inv.pupil.firstName} ${inv.pupil.lastName}`,
        amountDue: inv.amountDue,
        amountPaid: inv.amountPaid,
        status: inv.status,
        dueDate: inv.dueDate,
        description: inv.feeSchedule?.name || 'School Fees',
        items: (inv.items as Array<{
          id: string;
          name: string;
          amount: number;
          quantity: number;
          description: string | null;
          feeScheduleItemId: string | null;
          allocations: Array<{ amount: number }>;
        }>).map((item) => {
          const amountPaid = item.allocations.reduce(
            (sum, allocation) => sum + Number(allocation.amount || 0),
            0,
          );
          const amountOutstanding = Math.max(
            0,
            Number(item.amount || 0) * Number(item.quantity || 1) - amountPaid,
          );

          return {
            id: item.id,
            name: item.name,
            amount: item.amount,
            quantity: item.quantity,
            description: item.description,
            feeScheduleItemId: item.feeScheduleItemId,
            amountPaid,
            amountOutstanding,
          };
        }),
      })),
    });
  } catch (error) {
    console.error('Error loading invoices:', error);
    res.status(500).json({ error: 'Failed to load invoices' });
  }
});

// Get payments
router.get('/payments', async (req: Request, res: Response) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const sessionCookie = cookieHeader.split(';').find(c => c.trim().startsWith('schoolbase_session='));
    
    if (!sessionCookie) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = sessionCookie.split('=')[1];
    const { payload } = await jwtVerify(token, secret());
    const data = payload as any;

    const family = await resolveParentFamily(data);
    if (family.guardians.length === 0) {
      return res.status(404).json({ error: 'Guardian not found' });
    }

    const requestedChildId = typeof req.query.childId === 'string' ? req.query.childId.trim() : '';
    if (requestedChildId && !family.pupilIds.includes(requestedChildId)) {
      return res.status(404).json({ error: 'Child not found in this family.' });
    }
    const parseQueryInteger = (value: unknown, fallback: number, minimum: number) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !value.trim()) return null;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
    };
    const offset = parseQueryInteger(req.query.offset, 0, 0);
    const requestedLimit = parseQueryInteger(req.query.limit, 50, 1);
    if (offset === null || requestedLimit === null) {
      return res.status(400).json({ error: 'Payment offset must be a non-negative integer and limit must be a positive integer.' });
    }
    const limit = Math.min(requestedLimit, 50);
    const paymentWhere = {
      invoice: {
        pupilId: { in: requestedChildId ? [requestedChildId] : family.pupilIds },
      },
    };

    const [payments, paymentSummary] = await Promise.all([
      prisma.payment.findMany({
        where: paymentWhere,
        include: { invoice: true },
        orderBy: { paidAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.payment.aggregate({
        where: paymentWhere,
        _sum: { amount: true },
        _count: { _all: true },
        _max: { paidAt: true },
      }),
    ]);

    res.json({
      payments: payments.map(p => ({
        id: p.id,
        invoiceId: p.invoiceId,
        amount: p.amount,
        paidAt: p.paidAt,
        method: p.method || 'UNKNOWN',
        reference: p.reference || p.invoice?.invoiceNo || p.id,
        invoiceNo: p.invoice?.invoiceNo || null,
      })),
      totalPaid: paymentSummary._sum.amount ?? 0,
      paymentCount: paymentSummary._count._all,
      latestPaidAt: paymentSummary._max.paidAt?.toISOString() ?? null,
      offset,
      limit,
    });
  } catch (error) {
    console.error('Error loading payments:', error);
    res.status(500).json({ error: 'Failed to load payments' });
  }
});

// Get announcements
router.get('/announcements', async (req: Request, res: Response) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const sessionCookie = cookieHeader.split(';').find(c => c.trim().startsWith('schoolbase_session='));
    
    if (!sessionCookie) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = sessionCookie.split('=')[1];
    const { payload } = await jwtVerify(token, secret());
    const data = payload as any;

    const announcements = await prisma.announcement.findMany({
      where: { 
        schoolId: data.schoolId,
        published: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({
      announcements: announcements.map(a => ({
        id: a.id,
        title: a.title,
        body: a.body,
        publishedAt: a.publishedAt,
        createdAt: a.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error loading announcements:', error);
    res.status(500).json({ error: 'Failed to load announcements' });
  }
});

// Get school info
router.get('/school', async (req: Request, res: Response) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const sessionCookie = cookieHeader.split(';').find(c => c.trim().startsWith('schoolbase_session='));
    
    if (!sessionCookie) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = sessionCookie.split('=')[1];
    const { payload } = await jwtVerify(token, secret());
    const data = payload as any;

    const school = await prisma.school.findUnique({
      where: { id: data.schoolId },
      include: {
        paymentAccounts: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    res.json({
      id: school.id,
      name: school.name,
      address: school.address || '',
      phone: school.phone || '',
      email: school.email || '',
      principal: school.principalName || '',
        motto: school.tagline || '',
        manualPaymentAccountName: school.manualPaymentAccountName || '',
        manualPaymentAccountNumber: school.manualPaymentAccountNumber || '',
        manualPaymentBankName: school.manualPaymentBankName || '',
      city: school.city || '',
      country: school.country || 'NG',
      currency: resolveSupportedCurrency(school.currency),
      initials: school.initials || '',
      termCount: school.termCount,
      logoUrl: school.logoUrl || '',
      principalComment: school.principalComment || '',
      paymentAccounts: school.paymentAccounts,
    });
  } catch (error) {
    console.error('Error loading school:', error);
    res.status(500).json({ error: 'Failed to load school' });
  }
});

// Get invoice details
router.get('/invoices/:id', async (req: Request, res: Response) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const sessionCookie = cookieHeader.split(';').find(c => c.trim().startsWith('schoolbase_session='));

    if (!sessionCookie) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = sessionCookie.split('=')[1];
    const { payload } = await jwtVerify(token, secret());
    const data = payload as any;
    const { id } = req.params;

    const family = await resolveParentFamily(data);
    if (family.guardians.length === 0) {
      return res.status(404).json({ error: 'Guardian not found' });
    }

    const allowedPupilIds = family.pupilIds;

    const invoice = await prisma.invoice.findFirst({
      where: {
        id,
        pupilId: { in: allowedPupilIds },
      },
      include: {
        pupil: {
          include: { class: true },
        },
        feeSchedule: {
          include: {
            term: { include: { academicYear: true } },
          },
        },
        items: {
          include: {
            allocations: { select: { amount: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        payments: {
          orderBy: { paidAt: 'desc' },
        },
      },
    });

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    type ParentFeeAdjustment = {
      id: string;
      adjustmentType: string;
      amount: number | null;
      percentage: number | null;
      reason: string | null;
      status: string;
      approvedBy: string | null;
      createdAt: Date;
    };
    const feeAdjustmentDelegate = (prisma as any)['studentFeeAdjustment'] as {
      findMany: (args: unknown) => Promise<ParentFeeAdjustment[]>;
    };
    const adjustments: ParentFeeAdjustment[] = await feeAdjustmentDelegate.findMany({
      where: {
        schoolId: data.schoolId,
        invoiceId: invoice.id,
      },
      orderBy: { createdAt: 'desc' },
    });

    const school = await prisma.school.findUnique({
      where: { id: data.schoolId },
      select: {
        name: true,
        currency: true,
        address: true,
        city: true,
        phone: true,
        email: true,
        logoUrl: true,
        principalName: true,
        tagline: true,
        principalComment: true,
        manualPaymentAccountName: true,
        manualPaymentAccountNumber: true,
        manualPaymentBankName: true,
        paymentAccounts: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    const invoiceItems = invoice.items as Array<{
      id: string;
      name: string;
      amount: number;
      quantity: number;
      description: string | null;
      feeScheduleItemId: string | null;
      allocations: Array<{ amount: number }>;
    }>;
    const subtotal = invoiceItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const totalAdjustments = adjustments.reduce((sum: number, adjustment: ParentFeeAdjustment) => {
      if (adjustment.amount !== null && adjustment.amount !== undefined) {
        return sum + Number(adjustment.amount);
      }
      if (adjustment.percentage !== null && adjustment.percentage !== undefined) {
        return sum + Math.round((subtotal * Number(adjustment.percentage)) / 100);
      }
      return sum;
    }, 0);

    res.json({
      invoice: {
        ...invoice,
        dueDate: invoice.dueDate ? invoice.dueDate.toISOString() : null,
        createdAt: invoice.createdAt.toISOString(),
        updatedAt: invoice.updatedAt.toISOString(),
        items: invoiceItems.map((item) => {
          const amountPaid = item.allocations.reduce(
            (sum, allocation) => sum + Number(allocation.amount || 0),
            0,
          );

          return {
            id: item.id,
            name: item.name,
            amount: item.amount,
            quantity: item.quantity,
            description: item.description,
            feeScheduleItemId: item.feeScheduleItemId,
            amountPaid,
            amountOutstanding: Math.max(
              0,
              Number(item.amount || 0) * Number(item.quantity || 1) - amountPaid,
            ),
          };
        }),
        adjustments: adjustments.map((adjustment: ParentFeeAdjustment) => ({
          id: adjustment.id,
          adjustmentType: adjustment.adjustmentType,
          amount: adjustment.amount,
          percentage: adjustment.percentage,
          reason: adjustment.reason,
          status: adjustment.status,
          approvedBy: adjustment.approvedBy,
          createdAt: adjustment.createdAt.toISOString(),
        })),
        payments: invoice.payments.map((payment) => ({
          ...payment,
          paidAt: payment.paidAt.toISOString(),
        })),
      },
      school,
      subtotal,
      totalAdjustments,
      outstanding: Math.max(0, invoice.amountDue - invoice.amountPaid),
    });
  } catch (error) {
    console.error('Error fetching invoice:', error);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// Helper function to calculate grade
function getGrade(score: number): string {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

router.get('/competition/achievements', async (req: Request, res: Response) => {
  try {
    if (!(await resolveCompetitionFeature(prisma, 'competition.gamification.enabled'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
    const sessionCookie = String(req.headers.cookie || '').split(';').find((cookie) => cookie.trim().startsWith('schoolbase_session='));
    if (!sessionCookie) return res.status(401).json({ error: 'UNAUTHORIZED' });
    const token = sessionCookie.split('=')[1];
    const { payload } = await jwtVerify(token, secret());
    const family = await resolveParentFamily(payload as any);
    if (!family.pupilIds.length) return res.json({ children: [] });

    const [pupils, achievements, xpTransactions, attempts, practiceSummaries] = await Promise.all([
      prisma.pupil.findMany({ where: { id: { in: family.pupilIds }, schoolId: family.schoolId }, select: { id: true, firstName: true, middleName: true, lastName: true, photoUrl: true, class: { select: { name: true } } } }),
      prisma.competitionPupilAchievement.findMany({ where: { pupilId: { in: family.pupilIds } }, select: { pupilId: true, awardedAt: true, achievement: { select: { code: true, title: true, description: true, iconUrl: true } } }, orderBy: { awardedAt: 'desc' } }),
      prisma.competitionXpTransaction.groupBy({ by: ['pupilId'], where: { pupilId: { in: family.pupilIds } }, _sum: { amount: true } }),
      prisma.competitionChallengeAttempt.findMany({ where: { pupilId: { in: family.pupilIds }, status: { in: ['SUBMITTED', 'EXPIRED'] } }, select: { pupilId: true, status: true, score: true, correctCount: true, questionCount: true, accuracyPercent: true, elapsedMs: true, submittedAt: true, challenge: { select: { title: true } } }, orderBy: { submittedAt: 'desc' }, take: 50 }),
      prisma.competitionChallengeAttempt.groupBy({ by: ['pupilId'], where: { pupilId: { in: family.pupilIds }, status: 'SUBMITTED' }, _count: { _all: true }, _max: { accuracyPercent: true, submittedAt: true } }),
    ]);
    const xpByPupil = new Map(xpTransactions.map((entry) => [entry.pupilId, entry._sum.amount ?? 0]));
    const practiceSummaryByPupil = new Map(practiceSummaries.map((entry) => [entry.pupilId, {
      completedChallenges: entry._count._all,
      personalBestAccuracy: entry._max.accuracyPercent?.toNumber() ?? null,
      latestCompletionAt: entry._max.submittedAt,
    }]));
    const achievementsByPupil = new Map<string, typeof achievements>();
    for (const achievement of achievements) {
      const existing = achievementsByPupil.get(achievement.pupilId) || [];
      existing.push(achievement);
      achievementsByPupil.set(achievement.pupilId, existing);
    }
    const attemptsByPupil = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      const existing = attemptsByPupil.get(attempt.pupilId) || [];
      if (existing.length < 5) existing.push(attempt);
      attemptsByPupil.set(attempt.pupilId, existing);
    }
    res.json({ children: pupils.map((pupil) => ({ id: pupil.id, displayName: `${pupil.firstName} ${pupil.middleName ? `${pupil.middleName[0]}. ` : ''}${pupil.lastName}`, photoUrl: pupil.photoUrl, className: pupil.class?.name ?? null, xp: xpByPupil.get(pupil.id) ?? 0, practiceSummary: practiceSummaryByPupil.get(pupil.id) ?? { completedChallenges: 0, personalBestAccuracy: null, latestCompletionAt: null }, achievements: (achievementsByPupil.get(pupil.id) || []).map((entry) => ({ ...entry.achievement, awardedAt: entry.awardedAt })), recentAttempts: (attemptsByPupil.get(pupil.id) || []).map((attempt) => ({ title: attempt.challenge.title, status: attempt.status, score: attempt.score, correctCount: attempt.correctCount, questionCount: attempt.questionCount, accuracyPercent: attempt.accuracyPercent?.toNumber() ?? null, elapsedMs: attempt.elapsedMs, submittedAt: attempt.submittedAt })) })) });
  } catch (error) {
    console.error('[parent] Competition achievements failed', error);
    res.status(500).json({ error: 'COMPETITION_ACHIEVEMENTS_FAILED' });
  }
});

export default router;
