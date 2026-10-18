import { Router, Request, Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { hasPendingOtp, generateOtp, getSignupOtp, replaceSignupOtpAfterDelivery } from '../services/otp.js';
import { sendSignupOtpEmail } from '../services/email.js';
import { allowSignupOtpRequest, verifyClientIpAssertion } from '../services/signup-rate-limit.js';
import { recordActivity } from '../middleware/activityAudit.js';
import { getSessionSecret } from '../services/security-config.js';

const router = Router();
const prisma = new PrismaClient();

// ============================================
// HELPER: Get JWT secret
// ============================================
function secret() {
  return getSessionSecret();
}

function loginDetails(email: unknown, result: string) {
  return `Login ${result} for ${String(email ?? '').trim().toLowerCase() || 'unknown account'}`;
}

// ============================================
// POST /api/auth/platform-login
// Platform admin login ONLY
// ============================================
router.post('/platform-login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};
    
    if (!email || !password) {
      return res.status(400).json({ 
        error: 'Email and password are required.' 
      });
    }

    const user = await prisma.user.findUnique({
      where: { email: String(email).trim().toLowerCase() },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        passwordHash: true,
        schoolId: true,
        isActive: true,
      },
    });

    // User not found
    if (!user || !user.passwordHash) {
      await recordActivity({ event: 'LOGIN_FAILED', details: loginDetails(email, 'failed: account not found') }).catch(() => {});
      return res.status(401).json({ 
        error: 'Invalid email or password.' 
      });
    }

    if (!user.isActive) {
      await recordActivity({ event: 'LOGIN_FAILED', details: loginDetails(email, 'failed: account inactive'), userId: user.id, schoolId: user.schoolId || undefined }).catch(() => {});
      return res.status(403).json({ error: 'This account is inactive. Contact your school administrator.' });
    }

    if (user.schoolId) {
      const school = await prisma.school.findUnique({ where: { id: user.schoolId }, select: { archivedAt: true } });
      if (school?.archivedAt) return res.status(403).json({ error: 'This school account is archived. Contact SchoolBase support.' });
    }

    // Password invalid
    const valid = await bcrypt.compare(String(password), user.passwordHash);
    if (!valid) {
      await recordActivity({ event: 'LOGIN_FAILED', details: loginDetails(email, 'failed: invalid password') }).catch(() => {});
      return res.status(401).json({ 
        error: 'Invalid email or password.' 
      });
    }

    // CRITICAL: PLATFORM_ADMIN only
    if (user.role !== 'PLATFORM_ADMIN') {
      await recordActivity({ event: 'LOGIN_FAILED', details: loginDetails(email, 'failed: platform role required'), userId: user.id, schoolId: user.schoolId || undefined }).catch(() => {});
      console.warn(`[AUTH] Non-platform admin tried to login to platform: ${email} (${user.role})`);
      return res.status(403).json({ 
        error: 'Only platform admins can access this portal.' 
      });
    }

    // Create JWT token (no schoolId for platform admin)
    const token = await new SignJWT({
      userId: user.id,
      role: user.role,
      email: user.email,
      name: user.name,
      schoolId: null, // Platform admin has no school
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(secret());

    // Set httpOnly session cookie
    res.cookie('schoolbase_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
      domain: process.env.NODE_ENV === 'production' ? '.schoolbase.live' : undefined,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    await recordActivity({ event: 'LOGIN_SUCCESS', details: loginDetails(user.email, 'succeeded'), userId: user.id });

    res.json({
      success: true,
      token,
      role: user.role,
      userId: user.id,
      name: user.name,
      email: user.email,
      schoolId: null,
    });
  } catch (error) {
    console.error('[AUTH] Platform login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================
// POST /api/auth/school-login
// School admin, staff, parent login
// ============================================
async function handleSchoolLogin(req: Request, res: Response) {
  try {
    const { email, password } = req.body ?? {};

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required.',
      });
    }

    const user = await prisma.user.findUnique({
      where: { email: String(email).trim().toLowerCase() },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        passwordHash: true,
        schoolId: true,
        isActive: true,
      },
    });

    // User not found - check if there's a pending OTP
    if (!user || !user.passwordHash) {
      const normalizedEmail = String(email).trim().toLowerCase();

      // Check if this email has a pending OTP waiting to be verified
      if (await hasPendingOtp(normalizedEmail)) {
        const pendingSignup = await getSignupOtp(normalizedEmail);
        const allowed = await allowSignupOtpRequest(normalizedEmail, verifyClientIpAssertion(req.get('x-schoolbase-client-ip-assertion')) || undefined);
        if (allowed && pendingSignup) {
          const otp = generateOtp();
          try {
            await sendSignupOtpEmail(normalizedEmail, otp, pendingSignup.schoolName);
            const replaced = await replaceSignupOtpAfterDelivery(normalizedEmail, otp, pendingSignup.otpHash);
            if (!replaced) console.warn('[AUTH] Pending signup was completed while OTP resend was in flight.');
          } catch (error) {
            console.error('[AUTH] OTP resend failed:', error);
          }
        }

        // Return special response indicating verification needed
        return res.status(401).json({
          error: 'Please verify your email first',
          needsVerification: true,
          email: normalizedEmail,
        });
      }

      // No pending OTP - standard "not found" response
      await recordActivity({ event: 'LOGIN_FAILED', details: loginDetails(email, 'failed: account not found') }).catch(() => {});
      return res.status(401).json({
        error: 'Invalid email or password.',
      });
    }

    if (!user.isActive) {
      await recordActivity({ event: 'LOGIN_FAILED', details: loginDetails(email, 'failed: account inactive'), userId: user.id, schoolId: user.schoolId || undefined }).catch(() => {});
      return res.status(403).json({ error: 'This account is inactive. Contact your school administrator.' });
    }

    // Password invalid
    const valid = await bcrypt.compare(String(password), user.passwordHash);
    if (!valid) {
      await recordActivity({ event: 'LOGIN_FAILED', details: loginDetails(email, 'failed: invalid password') }).catch(() => {});
      return res.status(401).json({
        error: 'Invalid email or password.',
      });
    }

    // ALLOW: PLATFORM_ADMIN can login through this endpoint (they just have no schoolId)
    // REQUIRED: School users MUST have a schoolId
    if (user.role !== 'PLATFORM_ADMIN' && !user.schoolId) {
      await recordActivity({ event: 'LOGIN_FAILED', details: loginDetails(email, 'failed: school assignment missing'), userId: user.id }).catch(() => {});
      console.error(`[AUTH] School user has no schoolId: ${email} (${user.role})`);
      return res.status(403).json({
        error: 'This account is not assigned to a school.',
      });
    }

    // Create JWT token (with schoolId for school users, null for platform admin)
    const token = await new SignJWT({
      userId: user.id,
      role: user.role,
      email: user.email,
      name: user.name,
      schoolId: user.schoolId || null,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(secret());

    // Set httpOnly session cookie
    res.cookie('schoolbase_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
      domain: process.env.NODE_ENV === 'production' ? '.schoolbase.live' : undefined,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    await recordActivity({ event: 'LOGIN_SUCCESS', details: loginDetails(user.email, 'succeeded'), userId: user.id, schoolId: user.schoolId || undefined });

    return res.json({
      success: true,
      token,
      role: user.role,
      userId: user.id,
      name: user.name,
      email: user.email,
      schoolId: user.schoolId,
    });
  } catch (error) {
    console.error('[AUTH] School login error:', error);
    return res.status(500).json({ error: 'Login failed' });
  }
}

router.post('/school-login', handleSchoolLogin);
router.post('/login', handleSchoolLogin);
router.post('/admin-login', handleSchoolLogin);

// ============================================
// GET/POST /api/auth/verify
// Verify current session
// ============================================
async function verifySessionRoute(req: Request, res: Response) {
  try {
    const token = req.cookies?.schoolbase_session || req.cookies?.schoolbase_staff || req.cookies?.staff_session;

    if (!token) {
      return res.status(401).json({
        authenticated: false,
        error: 'No session found',
      });
    }

    const { payload } = await jwtVerify(token, secret());
    const userId = payload && typeof payload.userId === 'string' ? payload.userId : null;
    if (!userId) {
      const guardianId = payload && typeof payload.guardianId === 'string' ? payload.guardianId : null;
      if (!guardianId) return res.status(401).json({ authenticated: false, error: 'Invalid session' });
      const guardian = await prisma.guardian.findUnique({ where: { id: guardianId }, select: { id: true, schoolId: true } });
      const schoolArchived = guardian
        ? Boolean(await prisma.school.findUnique({ where: { id: guardian.schoolId }, select: { archivedAt: true } }).then((school) => school?.archivedAt))
        : false;
      if (!guardian || schoolArchived || (typeof payload.schoolId === 'string' && payload.schoolId !== guardian.schoolId)) {
        return res.status(401).json({ authenticated: false, error: 'Session is no longer active' });
      }
      return res.json({ authenticated: true, user: payload, session: payload, school: null });
    }

    const activeUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, schoolId: true, role: true, isActive: true },
    });
    const effectiveSchoolId = payload.sessionPurpose === 'SCHOOL_IMPERSONATION' && typeof payload.schoolId === 'string'
      ? payload.schoolId
      : activeUser?.schoolId;
    const schoolArchived = effectiveSchoolId
      ? Boolean(await prisma.school.findUnique({ where: { id: effectiveSchoolId }, select: { archivedAt: true } }).then((school) => school?.archivedAt))
      : false;
    const isSchoolImpersonation = payload.sessionPurpose === 'SCHOOL_IMPERSONATION'
      && payload.role === 'SCHOOL_ADMIN'
      && activeUser?.role === 'PLATFORM_ADMIN'
      && activeUser.isActive
      && typeof payload.schoolId === 'string'
      && await prisma.school.findUnique({ where: { id: payload.schoolId }, select: { id: true } });
    if (!activeUser || !activeUser.isActive || schoolArchived || (!isSchoolImpersonation && (activeUser.role !== payload.role || (activeUser.schoolId || null) !== (typeof payload.schoolId === 'string' ? payload.schoolId : null)))) {
      return res.status(401).json({ authenticated: false, error: 'Session is no longer active' });
    }

    let schoolInfo = null;
    try {
      if (payload && typeof payload === 'object' && (payload as any).schoolId) {
        const schoolId = String((payload as any).schoolId);
        const school = await prisma.school.findUnique({
          where: { id: schoolId },
          select: { id: true, plan: true, status: true, trialEndsAt: true, subscriptionExpiresAt: true },
        });
        if (school) {
          schoolInfo = school;
        }
      }
    } catch (err) {
      console.error('[AUTH] Failed to fetch school info for verify:', err);
    }

    return res.json({
      authenticated: true,
      user: payload,
      session: payload,
      school: schoolInfo,
    });
  } catch (error) {
    console.error('[AUTH] Verify error:', error);
    return res.status(401).json({
      authenticated: false,
      error: 'Invalid session',
    });
  }
}

router.get('/verify', verifySessionRoute);
router.post('/verify', verifySessionRoute);

// ============================================
// POST /api/auth/logout
// Clear session and logout user, then redirect
// ============================================
router.post('/logout', (req: Request, res: Response) => {
  try {
    // Get redirect URL from query params
    const redirectUrl = req.query.redirectUrl || '/login';
    
    console.log('[AUTH] Logout request received');
    console.log('[AUTH] Redirect URL:', redirectUrl);
    
    // Clear the session cookie with exact same options as when set
    res.clearCookie('schoolbase_session', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
      domain: process.env.NODE_ENV === 'production' ? '.schoolbase.live' : undefined,
    });

    console.log('[AUTH] Session cookie cleared');
    
    // CRITICAL: Redirect to frontend login page
    const frontendUrl = process.env.FRONTEND_URL || 'https://www.schoolbase.live';
    res.redirect(302, `${frontendUrl}${redirectUrl}`);
  } catch (error) {
    console.error('[AUTH] Logout error:', error);
    res.status(500).json({ 
      error: 'Failed to logout' 
    });
  }
});

export default router;
