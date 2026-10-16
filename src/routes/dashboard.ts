import { Router, Request, Response } from 'express';
import { jwtVerify } from 'jose';
import { PrismaClient } from '@prisma/client';
import { getJwtSecret } from '../services/security-config.js';

const router = Router();
const prisma = new PrismaClient();

const secret = getJwtSecret;

// GET /api/admin/dashboard - Get dashboard statistics
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    // Get JWT from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    
    let schoolId: string;
    try {
      const verified = await jwtVerify(token, secret());
      if (verified.payload.role !== 'SCHOOL_ADMIN') {
        return res.status(403).json({ error: 'Forbidden: School Admin access required' });
      }
      if (typeof verified.payload.schoolId !== 'string' || !verified.payload.schoolId) {
        return res.status(403).json({ error: 'Invalid school session' });
      }
      schoolId = verified.payload.schoolId as string;
    } catch (error) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Fetch all dashboard data in parallel
    const [school, invoices, pupilCount, classCount, readyAssessment, recentPayments, recentPupils, recentTeachers, recentAnnouncements] = 
      await Promise.all([
        prisma.school.findUnique({
          where: { id: schoolId },
          include: { partner: true, enabledPhases: true },
        }),
        prisma.invoice.findMany({
          where: { schoolId },
          select: { amountDue: true, amountPaid: true, status: true },
        }),
        prisma.pupil.count({
          where: { schoolId, isActive: true },
        }),
        prisma.class.count({
          where: { schoolId },
        }),
        prisma.assessment.findFirst({
          where: { schoolId, status: 'APPROVED' },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.payment.findMany({
          take: 3,
          orderBy: { paidAt: 'desc' },
          include: {
            invoice: {
              include: {
                pupil: true,
              },
            },
          },
          where: { invoice: { schoolId } },
        }),
        prisma.pupil.findMany({
          where: { schoolId, isActive: true },
          orderBy: { createdAt: 'desc' },
          take: 3,
          include: {
            class: {
              select: {
                name: true,
                arm: true,
              },
            },
          },
        }),
        prisma.user.findMany({
          where: { schoolId, role: 'TEACHER' },
          orderBy: { createdAt: 'desc' },
          take: 3,
        }),
        prisma.announcement.findMany({
          where: { schoolId },
          orderBy: { publishedAt: 'desc' },
          take: 3,
        }),
      ]);

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    res.json({
      school,
      invoices,
      pupilCount,
      classCount,
      readyAssessment,
      recentPayments,
      recentPupils,
      recentTeachers,
      recentAnnouncements,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

export default router;
