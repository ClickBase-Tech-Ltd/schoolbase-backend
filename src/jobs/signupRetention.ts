import { PrismaClient } from '@prisma/client';
import cron from 'node-cron';

const prisma = new PrismaClient();

export async function cleanupExpiredSignupData(now = new Date()) {
  const [expiredPendingSignups, expiredRecoveryKeys, expiredRateLimits] = await Promise.all([
    prisma.signupOtp.deleteMany({
      where: { verifiedAt: null, expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
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
  };
}

export function initializeSignupRetentionJob() {
  return cron.schedule('23 2 * * *', async () => {
    try {
      const result = await cleanupExpiredSignupData();
      console.info('[SignupRetention] Daily cleanup completed:', result);
    } catch (error) {
      console.error('[SignupRetention] Daily cleanup failed:', error instanceof Error ? error.message : error);
    }
  });
}