import { Request, Response, NextFunction } from 'express';
import { jwtVerify } from 'jose';
import { PrismaClient } from '@prisma/client';
import { getSessionSecret } from '../services/security-config.js';

const SECRET = getSessionSecret();
const prisma = new PrismaClient();

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    schoolId: string;
    email: string;
    name: string;
    role: string;
    iat: number;
    exp: number;
  };
}

// Verify JWT token and extract user data
export function createVerifyAuth(database: Pick<PrismaClient, 'user' | 'guardian'>, secret: Uint8Array = SECRET) {
  return async function verifyAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const token = req.cookies?.schoolbase_session || req.cookies?.schoolbase_staff || req.cookies?.staff_session;

      if (!token) {
        return res.status(401).json({ error: 'No authentication token' });
      }

      const { payload } = await jwtVerify(token, secret);

      if (!payload || typeof payload !== 'object') {
        return res.status(401).json({ error: 'Invalid token' });
      }

      const userId = typeof payload.userId === 'string' ? payload.userId : null;
      if (!userId) {
        const guardianId = typeof payload.guardianId === 'string' ? payload.guardianId : null;
        if (payload.role !== 'PARENT' || !guardianId) return res.status(401).json({ error: 'Invalid token' });
        const guardian = await database.guardian.findUnique({ where: { id: guardianId }, select: { id: true, schoolId: true } });
        if (!guardian || (typeof payload.schoolId === 'string' && payload.schoolId !== guardian.schoolId)) {
          return res.status(401).json({ error: 'Session is no longer active' });
        }
        req.user = payload as any;
        next();
        return;
      }
      const user = await database.user.findUnique({
        where: { id: userId },
        select: { id: true, schoolId: true, role: true, isActive: true },
      });
      if (!user || !user.isActive || user.role !== payload.role || (user.schoolId || null) !== (typeof payload.schoolId === 'string' ? payload.schoolId : null)) {
        return res.status(401).json({ error: 'Session is no longer active' });
      }

      req.user = payload as any;
      next();
    } catch (error) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

export const verifyAuth = createVerifyAuth(prisma);

// Ensure user is a teacher
export function requireTeacher(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (req.user.role !== 'TEACHER') {
    return res.status(403).json({ error: 'Forbidden: Teacher access required' });
  }

  next();
}

export function requireParent(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (req.user.role !== 'PARENT') {
    return res.status(403).json({ error: 'Forbidden: Parent access required' });
  }

  next();
}

// Ensure user is an admin
export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (req.user.role !== 'SCHOOL_ADMIN') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }

  next();
}

// Allow both teacher and admin
export function requireStaff(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (req.user.role !== 'TEACHER' && req.user.role !== 'SCHOOL_ADMIN' && req.user.role !== 'BURSAR') {
    return res.status(403).json({ error: 'Forbidden: Staff access required' });
  }

  next();
}

// Ensure user is a bursar/accountant
export function requireBursar(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (req.user.role !== 'BURSAR') {
    return res.status(403).json({ error: 'Forbidden: Bursar/Accountant access required' });
  }

  next();
}

// Accounting is available to the school administrator and accounting staff.
export function requireAccountingAccess(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (req.user.role !== 'BURSAR' && req.user.role !== 'SCHOOL_ADMIN') {
    return res.status(403).json({ error: 'Forbidden: Accounting access required' });
  }

  next();
}
