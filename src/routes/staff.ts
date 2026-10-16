import { Router, type Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { verifyAuth, type AuthenticatedRequest } from '../middleware/roleAuth.js';

const router = Router();
const prisma = new PrismaClient();

router.use(verifyAuth);

router.get('/me', async (req: AuthenticatedRequest, res: Response) => {
  const user = req.user;
  if (!user?.userId || user.role !== 'STAFF' || !user.schoolId) {
    return res.status(403).json({ error: 'Staff account required.' });
  }

  const employee = await prisma.employeeProfile.findFirst({
    where: { userId: user.userId, schoolId: user.schoolId, employmentStatus: 'ACTIVE', user: { isActive: true } },
    select: {
      staffNumber: true,
      firstName: true,
      middleName: true,
      lastName: true,
      jobTitle: true,
      department: true,
      classification: true,
      employmentType: true,
      startDate: true,
      school: { select: { name: true, logoUrl: true, primaryColor: true } },
    },
  });
  if (!employee) return res.status(403).json({ error: 'Active employee profile required.' });
  return res.json({ employee });
});

export default router;