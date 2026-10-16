import { Request, Response, NextFunction } from 'express';
import { jwtVerify } from 'jose';
import { getSessionSecret } from '../services/security-config.js';

const SECRET = getSessionSecret();

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
export async function verifyAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    // Check unified session cookie, with backward compatibility for legacy cookies
    const token = req.cookies?.schoolbase_session || req.cookies?.schoolbase_staff || req.cookies?.staff_session;
    
    if (!token) {
      return res.status(401).json({ error: 'No authentication token' });
    }

    const { payload } = await jwtVerify(token, SECRET);
    
    if (!payload || typeof payload !== 'object') {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = payload as any;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

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
