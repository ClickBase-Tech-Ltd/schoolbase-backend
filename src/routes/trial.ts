import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateOtp, getSignupOtp, saveSignupOtp, verifySignupOtp, replaceSignupOtpAfterDelivery } from '../services/otp.js';
import { sendSignupOtpEmail, sendWelcomeEmail } from '../services/email.js';
import { sendInternalSignupNotification } from '../services/email.js';
import { recordActivity } from '../middleware/activityAudit.js';
import { getPlatformSettingValue } from '../services/platform-settings.js';
import { getSessionSecret } from '../services/security-config.js';
import { allowSignupOtpRequest, verifyClientIpAssertion } from '../services/signup-rate-limit.js';

const router = Router();
const prisma = new PrismaClient();

function secret() {
  return getSessionSecret();
}

// GET /api/trial/status - Safe signup/OTP readiness check without sending mail or creating data
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const [maintenanceMode, allowSignup, allowTrial] = await Promise.all([
      getPlatformSettingValue(prisma, 'maintenanceMode', false),
      getPlatformSettingValue(prisma, 'allowSignup', true),
      getPlatformSettingValue(prisma, 'allowTrial', true),
    ]);
    const emailConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    const enabled = !maintenanceMode && allowSignup && allowTrial;
    const status = enabled && emailConfigured ? 'ready' : 'degraded';
    res.json({
      status,
      signup: enabled ? 'enabled' : 'disabled',
      email: emailConfigured ? 'configured' : 'not_configured',
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Signup readiness check failed:', error);
    res.status(503).json({ status: 'down', signup: 'unknown', email: 'unknown' });
  }
});

// POST /api/trial/request-otp - Request OTP for signup
router.post('/request-otp', async (req: Request, res: Response) => {
  try {
    const maintenanceMode = await getPlatformSettingValue(prisma, 'maintenanceMode', false);
    const allowSignup = await getPlatformSettingValue(prisma, 'allowSignup', true);
    const allowTrial = await getPlatformSettingValue(prisma, 'allowTrial', true);

    if (maintenanceMode) {
      return res.status(503).json({ error: 'Platform is in maintenance mode. Signup is temporarily disabled.' });
    }

    if (!allowSignup) {
      return res.status(403).json({ error: 'New signups are currently disabled.' });
    }

    if (!allowTrial) {
      return res.status(403).json({ error: 'Trial signup is currently disabled.' });
    }

    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(503).json({ error: 'Signup verification email is temporarily unavailable. Please try again later or contact SchoolBase support.' });
    }

    const schoolName = String(req.body.schoolName ?? '').trim();
    const slug = String(req.body.slug ?? '').trim();
    const tagline = String(req.body.tagline ?? '').trim();
    const address = String(req.body.address ?? '').trim();
    const phone = String(req.body.phone ?? '').trim();
    const country = String(req.body.country ?? '').trim();
    const adminName = String(req.body.adminName ?? '').trim();
    const adminEmail = String(req.body.adminEmail ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');

    if (!schoolName || !slug || !country || !adminName || !adminEmail || !password) {
      return res.status(400).json({
        error: 'Missing required fields'
      });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    // Check if school slug already exists
    const existingSchool = await prisma.school.findUnique({
      where: { slug: slug.toLowerCase() },
    });

    if (existingSchool) {
      return res.status(409).json({ error: 'School slug already exists' });
    }

    // Check if email already exists as a completed user
    const existingUser = await prisma.user.findUnique({
      where: { email: adminEmail },
    });

    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered. Please use a different email or contact support if you need to recover your account.' });
    }

    // Allow resending OTP if email is already in signup process
    const existingSignup = await prisma.signupOtp.findUnique({
      where: { email: adminEmail },
    });

    if (existingSignup && !existingSignup.verifiedAt) {
      console.log('Refreshing OTP for an existing pending signup.');
    }

    if (!(await allowSignupOtpRequest(adminEmail, verifyClientIpAssertion(req.get('x-schoolbase-client-ip-assertion')) || undefined))) {
      return res.status(429).json({ error: 'Too many verification requests. Please wait before trying again.' });
    }

    const otp = generateOtp();
    const priorSignup = existingSignup && !existingSignup.verifiedAt
      ? {
          email: existingSignup.email,
          schoolName: existingSignup.schoolName,
          slug: existingSignup.slug,
          country: existingSignup.country,
          adminName: existingSignup.adminName,
          tagline: existingSignup.tagline,
          address: existingSignup.address,
          phone: existingSignup.phone,
          passwordHash: existingSignup.passwordHash,
          otpHash: existingSignup.otpHash,
          attempts: existingSignup.attempts,
          expiresAt: existingSignup.expiresAt,
          verifiedAt: existingSignup.verifiedAt,
        }
      : null;
    try {
      if (priorSignup) {
        try {
          await sendSignupOtpEmail(adminEmail, otp, priorSignup.schoolName);
        } catch (error) {
          console.error('OTP resend delivery failed:', error);
          return res.status(503).json({ error: 'We could not send the verification email. Please try again later.' });
        }
        const replaced = await replaceSignupOtpAfterDelivery(adminEmail, otp, priorSignup.otpHash);
        if (!replaced) return res.status(409).json({ error: 'This signup has already been verified. Please sign in.' });
      } else {
        const requestedOtpHash = await saveSignupOtp({ email: adminEmail, schoolName, slug, country, adminName, tagline, address, phone, password, otp });
        try {
          await sendSignupOtpEmail(adminEmail, otp, schoolName);
        } catch (error) {
          await prisma.signupOtp.deleteMany({ where: { email: adminEmail, otpHash: requestedOtpHash, verifiedAt: null } }).catch(() => {});
          throw error;
        }
      }
    } catch (error) {
      console.error('OTP email delivery failed:', error);
      return res.status(503).json({ error: 'We could not send the verification email. Check the address or try again later.' });
    }

    return res.json({
      success: true,
      message: 'Verification code sent to your email',
      email: adminEmail,
    });
  } catch (error: any) {
    console.error('Request OTP error:', error);
    return res.status(500).json({
      error: 'Failed to request OTP',
      details: error.message,
    });
  }
});

// POST /api/trial/verify-otp - Verify OTP and create account
router.post('/verify-otp', async (req: Request, res: Response) => {
  try {
    const maintenanceMode = await getPlatformSettingValue(prisma, 'maintenanceMode', false);
    const allowSignup = await getPlatformSettingValue(prisma, 'allowSignup', true);
    const allowTrial = await getPlatformSettingValue(prisma, 'allowTrial', true);

    const adminEmail = String(req.body.adminEmail ?? '').trim().toLowerCase();
    const otp = String(req.body.otp ?? '').trim();
    const recoveryKey = String(req.body.recoveryKey ?? '').trim();

    if (!adminEmail || (!otp && !recoveryKey)) {
      return res.status(400).json({
        error: 'Email and verification code are required'
      });
    }

    const recoveryHash = recoveryKey ? createHash('sha256').update(recoveryKey).digest('hex') : null;
    let signupOtp = await getSignupOtp(adminEmail);

    if (signupOtp?.verifiedAt) {
      const recovery = await prisma.signupOtp.findUnique({
        where: { email: adminEmail },
        select: { recoveryKeyHash: true, recoveryExpiresAt: true },
      });
      const expected = recovery?.recoveryKeyHash;
      const suppliedBuffer = recoveryHash ? Buffer.from(recoveryHash, 'hex') : Buffer.alloc(0);
      const expectedBuffer = expected ? Buffer.from(expected, 'hex') : Buffer.alloc(0);
      const recoveryMatches = expectedBuffer.length === 32
        && suppliedBuffer.length === 32
        && timingSafeEqual(suppliedBuffer, expectedBuffer)
        && Boolean(recovery?.recoveryExpiresAt && recovery.recoveryExpiresAt > new Date());
      if (!recoveryMatches) {
        return res.status(401).json({ error: 'Invalid or expired verification code' });
      }

      const adminUser = await prisma.user.findUnique({
        where: { email: adminEmail },
        select: { id: true, email: true, name: true, role: true, schoolId: true, isActive: true },
      });
      if (!adminUser?.isActive || !adminUser.schoolId) {
        return res.status(409).json({ error: 'The signup account is not available for recovery. Contact support.' });
      }
      const school = await prisma.school.findUnique({
        where: { id: adminUser.schoolId },
        select: { id: true, name: true, slug: true, archivedAt: true },
      });
      if (!school || school.archivedAt) {
        return res.status(409).json({ error: 'The signup account is not available for recovery. Contact support.' });
      }
      await recordActivity({
        event: 'SCHOOL_SIGNUP_SESSION_RECOVERED',
        details: `Signup session recovered for school ${school.id}`,
        userId: adminUser.id,
        schoolId: school.id,
      }).catch((error) => console.warn('Failed to record signup recovery activity:', error));
      const token = await new SignJWT({
        userId: adminUser.id,
        schoolId: school.id,
        email: adminUser.email,
        name: adminUser.name,
        role: adminUser.role,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('7d')
        .sign(secret());

      return res.status(200).json({
        success: true,
        recovered: true,
        message: 'School registered successfully',
        school: { id: school.id, name: school.name, slug: school.slug },
        user: { id: adminUser.id, email: adminUser.email, name: adminUser.name, role: adminUser.role },
        token,
      });
    }

    if (maintenanceMode) {
      return res.status(503).json({ error: 'Platform is in maintenance mode. Signup is temporarily disabled.' });
    }

    if (!allowSignup) {
      return res.status(403).json({ error: 'New signups are currently disabled.' });
    }

    if (!allowTrial) {
      return res.status(403).json({ error: 'Trial signup is currently disabled.' });
    }

    signupOtp = otp ? await verifySignupOtp(adminEmail, otp) : null;
    if (!signupOtp || !recoveryHash) {
      return res.status(401).json({ error: 'Invalid or expired verification code' });
    }

    // Create school
    const { school, adminUser } = await prisma.$transaction(async (tx) => {
      const school = await tx.school.create({
        data: {
          name: signupOtp.schoolName,
          slug: signupOtp.slug,
          tagline: signupOtp.tagline || null,
          address: signupOtp.address || null,
          phone: signupOtp.phone || null,
          country: signupOtp.country,
          email: adminEmail,
          status: 'TRIAL',
          trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      const adminUser = await tx.user.create({
        data: {
          email: adminEmail,
          name: signupOtp.adminName,
          role: 'SCHOOL_ADMIN',
          passwordHash: signupOtp.passwordHash,
          schoolId: school.id,
        },
      });
      const consumed = await tx.signupOtp.updateMany({
        where: {
          email: adminEmail,
          otpHash: signupOtp.otpHash,
          verifiedAt: null,
          attempts: { lt: 5 },
          expiresAt: { gt: new Date() },
        },
        data: {
          verifiedAt: new Date(),
          recoveryKeyHash: recoveryHash,
          recoveryExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });
      if (consumed.count !== 1) throw Object.assign(new Error('Verification code expired or was already used. Please request a new code.'), { statusCode: 409 });
      return { school, adminUser };
    });

    await recordActivity({
      event: 'SCHOOL_SIGNUP_COMPLETED',
      details: `New school signup completed for ${school.name} by ${adminEmail}`,
      userId: adminUser.id,
      schoolId: school.id,
    }).catch((error) => console.warn('Failed to record school signup activity:', error));

    // Generate JWT token
    const token = await new SignJWT({
      userId: adminUser.id,
      schoolId: school.id,
      email: adminUser.email,
      name: adminUser.name,
      role: adminUser.role,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(secret());

    // Send welcome email
    try {
      await sendWelcomeEmail(adminEmail, signupOtp.schoolName, signupOtp.adminName);
    } catch (emailError) {
      console.warn('Welcome email failed (non-blocking):', emailError);
    }

    // Send internal notification to team (non-blocking)
    sendInternalSignupNotification(signupOtp.schoolName, adminEmail, signupOtp.adminName)
      .then(() => console.log('Internal signup notification sent'))
      .catch((err) => console.warn('Internal signup notification failed (non-blocking):', err));

    return res.status(201).json({
      success: true,
      message: 'School registered successfully',
      school: {
        id: school.id,
        name: school.name,
        slug: school.slug,
      },
      user: {
        id: adminUser.id,
        email: adminUser.email,
        name: adminUser.name,
        role: adminUser.role,
      },
      token,
    });
  } catch (error: any) {
    console.error('Verify OTP error:', error);
    return res.status(error.statusCode || 500).json({
      error: 'Failed to create account',
      details: error.message,
    });
  }
});

// POST /api/trial/resend-otp - Resend OTP for pending signup
router.post('/resend-otp', async (req: Request, res: Response) => {
  try {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(503).json({ error: 'Signup verification email is temporarily unavailable. Please try again later or contact SchoolBase support.' });
    }
    const adminEmail = String(req.body.adminEmail ?? '').trim().toLowerCase();
    if (!adminEmail) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const signupOtp = await getSignupOtp(adminEmail);
    if (!signupOtp || signupOtp.verifiedAt) {
      return res.status(404).json({ error: 'Pending signup not found or already verified' });
    }

    if (!(await allowSignupOtpRequest(adminEmail, verifyClientIpAssertion(req.get('x-schoolbase-client-ip-assertion')) || undefined))) {
      return res.status(429).json({ error: 'Too many verification requests. Please wait before trying again.' });
    }

    const otp = generateOtp();
    try {
      await sendSignupOtpEmail(adminEmail, otp, signupOtp.schoolName);
    } catch (error) {
      console.error('Resend OTP email failed:', error);
      return res.status(503).json({ error: 'We could not send the verification email. Please try again later.' });
    }

    const replaced = await replaceSignupOtpAfterDelivery(adminEmail, otp, signupOtp.otpHash);
    if (!replaced) return res.status(409).json({ error: 'This signup has already been verified. Please sign in.' });

    return res.json({ success: true, message: 'Verification code resent' });
  } catch (error: any) {
    console.error('Resend OTP error:', error);
    return res.status(500).json({ error: 'Failed to resend OTP' });
  }
});

// POST /api/trial/start - Start trial for a school
router.post('/start', async (req: Request, res: Response) => {
  try {
    const { schoolId, days = 7 } = req.body;

    if (!schoolId) {
      return res.status(400).json({ error: 'Missing schoolId' });
    }

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + days);

    // Update school with trial end date
    const school = await prisma.school.update({
      where: { id: schoolId },
      data: {
        trialEndsAt,
        status: 'TRIAL',
      },
      select: {
        id: true,
        name: true,
        trialEndsAt: true,
        status: true,
      },
    });

    res.json({
      success: true,
      message: `Trial started for ${days} days`,
      school,
    });
  } catch (error: any) {
    console.error('Error starting trial:', error);
    res.status(500).json({
      error: 'Failed to start trial',
      details: error.message,
    });
  }
});

export default router;
