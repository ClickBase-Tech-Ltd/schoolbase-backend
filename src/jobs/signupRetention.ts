import { PrismaClient } from '@prisma/client';
import cron from 'node-cron';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();
const PENDING_SIGNUP_RETENTION_DAYS = 30;

export async function cleanupExpiredSignupData(now = new Date()) {
  const pendingSignupRetentionCutoff = new Date(now.getTime() - PENDING_SIGNUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const [expiredPendingSignups, expiredRecoveryKeys, expiredRateLimits] = await Promise.all([
    prisma.signupOtp.deleteMany({
      where: {
        verifiedAt: null,
        expiresAt: { lt: pendingSignupRetentionCutoff },
      },
    }),
    prisma.signupOtp.updateMany({
      where: { recoveryExpiresAt: { lte: now }, recoveryKeyHash: { not: null } },
      data: { recoveryKeyHash: null, recoveryExpiresAt: null },
    }),
    prisma.signupRateLimit.deleteMany({
      where: { updatedAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
    }),
  ]);

  return {
    expiredPendingSignups: expiredPendingSignups.count,
    expiredRecoveryKeys: expiredRecoveryKeys.count,
    expiredRateLimits: expiredRateLimits.count,
    retentionDays: PENDING_SIGNUP_RETENTION_DAYS,
  };
}

export function initializeSignupRetentionJob() {
  return cron.schedule('23 2 * * *', async () => {
    const runId = randomUUID();
    const startedAt = Date.now();
    try {
      const result = await cleanupExpiredSignupData();
      console.info(JSON.stringify({
        job: 'signup-retention',
        runId,
        outcome: 'completed',
        durationMs: Date.now() - startedAt,
        ...result,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        job: 'signup-retention',
        runId,
        outcome: 'failed',
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }));
    }
  });
}