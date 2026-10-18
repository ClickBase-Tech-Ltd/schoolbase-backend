import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { getSessionSecret } from './security-config.js';

const prisma = new PrismaClient();
const WINDOW_MS = 15 * 60 * 1000;
const EMAIL_COOLDOWN_MS = 60 * 1000;
const EMAIL_LIMIT = 5;
let cleanupCounter = 0;

function bucketKey(kind: 'email' | 'email-cooldown', value: string): string {
  return createHmac('sha256', getSessionSecret()).update(`${kind}:${value}`).digest('hex');
}

async function acquire(bucket: string, limit: number, windowMs = WINDOW_MS): Promise<boolean> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowMs);

  return prisma.$transaction(async (tx) => {
    await tx.signupRateLimit.upsert({
      where: { bucketKey: bucket },
      create: { bucketKey: bucket, windowStartedAt: now, requestCount: 0 },
      update: {},
    });

    await tx.signupRateLimit.updateMany({
      where: { bucketKey: bucket, windowStartedAt: { lte: cutoff } },
      data: { windowStartedAt: now, requestCount: 0 },
    });

    const updated = await tx.signupRateLimit.updateMany({
      where: { bucketKey: bucket, windowStartedAt: { gt: cutoff }, requestCount: { lt: limit } },
      data: { requestCount: { increment: 1 } },
    });

    return updated.count === 1;
  });
}

export async function allowSignupOtpRequest(email: string): Promise<boolean> {
  cleanupCounter += 1;
  if (cleanupCounter % 100 === 0) {
    await Promise.all([
      prisma.signupRateLimit.deleteMany({
        where: { updatedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
      prisma.signupOtp.deleteMany({
        where: { verifiedAt: null, expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
    ]).catch((error) => console.warn('Signup retention cleanup failed:', error));
  }

  const normalizedEmail = email.trim().toLowerCase();
  const allowedByCooldown = await acquire(bucketKey('email-cooldown', normalizedEmail), 1, EMAIL_COOLDOWN_MS);
  const allowedByEmail = await acquire(bucketKey('email', normalizedEmail), EMAIL_LIMIT);
  return allowedByCooldown && allowedByEmail;
}

export const signupRateLimitPolicy = {
  emailCooldownMs: EMAIL_COOLDOWN_MS,
  emailWindowMs: WINDOW_MS,
  emailWindowLimit: EMAIL_LIMIT,
};