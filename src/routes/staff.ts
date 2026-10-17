import { Router, type Request, type RequestHandler, type Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { verifyAuth, type AuthenticatedRequest } from '../middleware/roleAuth.js';
import { reserveNextStaffNumber } from '../services/staff-number.js';

const prisma = new PrismaClient();
const profilePhotoDirectory = path.join(process.cwd(), 'uploads', 'photos');
fs.mkdirSync(profilePhotoDirectory, { recursive: true });
const selfProfilePhotoUpload = multer({
  storage: multer.diskStorage({
    destination: profilePhotoDirectory,
    filename: (_req, file, callback) => callback(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  fileFilter: (_req, file, callback) => callback(null, ['image/jpeg', 'image/png'].includes(file.mimetype)),
  limits: { fileSize: 4 * 1024 * 1024 },
});

type StaffProfileDatabase = Pick<PrismaClient, 'user' | 'employeeProfile' | 'school' | 'staffNumberCounter' | '$transaction'>;

export function createStaffRouter(database: StaffProfileDatabase, authenticate: RequestHandler = verifyAuth) {
const router = Router();
router.use(authenticate);

router.get('/me', async (req: AuthenticatedRequest, res: Response) => {
  const user = req.user;
  if (!user?.userId || !['STAFF', 'TEACHER', 'BURSAR'].includes(user.role) || !user.schoolId) {
    return res.status(403).json({ error: 'Employee account required.' });
  }

  const employee = await database.employeeProfile.findFirst({
      where: { userId: user.userId, schoolId: user.schoolId, user: { isActive: true } },
    select: {
        id: true,
      staffNumber: true,
      firstName: true,
      middleName: true,
      lastName: true,
      jobTitle: true,
      department: true,
      classification: true,
      employmentType: true,
      employmentStatus: true,
      startDate: true,
      photoUrl: true,
      school: { select: { name: true, logoUrl: true, primaryColor: true } },
    },
  });
  if (!employee) return res.status(404).json({ error: 'Your employee profile has not been linked yet.' });
  return res.json({ employee });
});

router.put('/me', selfProfilePhotoUpload.single('photo'), async (req: AuthenticatedRequest, res: Response) => {
  const user = req.user;
  if (!user?.userId || !['STAFF', 'TEACHER', 'BURSAR'].includes(user.role) || !user.schoolId) {
    return res.status(403).json({ error: 'Employee account required.' });
  }

  const firstName = typeof req.body?.firstName === 'string' ? req.body.firstName.trim() : '';
  const middleName = typeof req.body?.middleName === 'string' ? req.body.middleName.trim() : '';
  const lastName = typeof req.body?.lastName === 'string' ? req.body.lastName.trim() : '';
  const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
  if (!firstName || !lastName || firstName.length > 100 || middleName.length > 100 || lastName.length > 100 || phone.length > 40) {
    return res.status(400).json({ error: 'Enter a valid first name, last name, and phone number.' });
  }

  try {
    const employee = await database.$transaction(async (tx) => {
      const account = await tx.user.findFirst({
        where: { id: user.userId, schoolId: user.schoolId, role: user.role as 'STAFF' | 'TEACHER' | 'BURSAR', isActive: true },
        select: { id: true, createdAt: true },
      });
      if (!account) throw Object.assign(new Error('Your account is no longer active.'), { statusCode: 403 });

      const existing = await tx.employeeProfile.findFirst({
        where: { userId: user.userId, schoolId: user.schoolId },
        select: { id: true, firstName: true, middleName: true, lastName: true, phone: true, photoUrl: true, jobTitle: true, department: true, employmentStatus: true, startDate: true },
      });
      if (existing) {
        if (existing.employmentStatus !== 'ACTIVE') throw Object.assign(new Error('Only active employee profiles can be updated.'), { statusCode: 403 });
        const updated = await tx.employeeProfile.update({
          where: { id: existing.id },
          data: { firstName, middleName: middleName || null, lastName, phone: phone || null, ...(req.file ? { photoUrl: `/uploads/photos/${req.file.filename}` } : {}) },
          select: { id: true, staffNumber: true, firstName: true, middleName: true, lastName: true, phone: true, photoUrl: true, jobTitle: true, department: true, employmentStatus: true, startDate: true, school: { select: { name: true } } },
        });
        if (existing.firstName !== firstName || existing.middleName !== (middleName || null) || existing.lastName !== lastName || existing.phone !== (phone || null)) {
          await tx.staffEmploymentEvent.create({
            data: {
              schoolId: user.schoolId!,
              employeeId: existing.id,
              actorUserId: user.userId,
              eventType: 'PROFILE_UPDATED_BY_EMPLOYEE',
              previousStatus: existing.employmentStatus,
              nextStatus: existing.employmentStatus,
              previousJobTitle: existing.jobTitle,
              nextJobTitle: existing.jobTitle,
              previousDepartment: existing.department,
              nextDepartment: existing.department,
            },
          });
        }
        if (req.file && existing.photoUrl?.startsWith('/uploads/photos/')) {
          const oldPhoto = path.join(profilePhotoDirectory, path.basename(existing.photoUrl));
          fs.unlink(oldPhoto, () => undefined);
        }
        return updated;
      }

      const school = await tx.school.findUnique({ where: { id: user.schoolId }, select: { name: true, initials: true } });
      if (!school) throw Object.assign(new Error('School not found.'), { statusCode: 404 });
      const staffNumber = await reserveNextStaffNumber({ transaction: tx, schoolId: user.schoolId!, schoolName: school.name, schoolInitials: school.initials });
      const jobTitle = user.role === 'TEACHER' ? 'Teacher' : user.role === 'BURSAR' ? 'Bursar' : 'Staff member';
      const startDate = new Date(Date.UTC(account.createdAt.getUTCFullYear(), account.createdAt.getUTCMonth(), account.createdAt.getUTCDate()));
      const created = await tx.employeeProfile.create({
        data: {
          schoolId: user.schoolId!,
          userId: user.userId,
          staffNumber,
          firstName,
          middleName: middleName || null,
          lastName,
          phone: phone || null,
          photoUrl: req.file ? `/uploads/photos/${req.file.filename}` : null,
          jobTitle,
          classification: user.role === 'TEACHER' ? 'ACADEMIC' : 'NON_ACADEMIC',
          employmentType: 'FULL_TIME',
          employmentStatus: 'ACTIVE',
          startDate,
        },
        select: { id: true, staffNumber: true, firstName: true, middleName: true, lastName: true, phone: true, photoUrl: true, jobTitle: true, department: true, employmentStatus: true, startDate: true, school: { select: { name: true } } },
      });
      await tx.staffEmploymentEvent.create({
        data: {
          schoolId: user.schoolId!,
          employeeId: created.id,
          actorUserId: user.userId,
          eventType: 'PROFILE_COMPLETED_BY_EMPLOYEE',
          effectiveAt: created.startDate,
          nextStatus: 'ACTIVE',
          nextJobTitle: jobTitle,
        },
      });
      return created;
    });
    return res.json({ employee });
  } catch (error) {
    if (req.file) fs.unlink(req.file.path, () => undefined);
    const statusCode = Number((error as { statusCode?: number })?.statusCode);
    if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'An employee profile is already linked to this account.' });
    return res.status(statusCode || 500).json({ error: statusCode ? (error as Error).message : 'Unable to update your staff profile.' });
  }
});

return router;
}

export default createStaffRouter(prisma);