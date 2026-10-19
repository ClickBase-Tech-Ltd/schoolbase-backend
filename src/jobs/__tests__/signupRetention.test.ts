import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { cleanupExpiredSignupData } from '../signupRetention.js';

const databaseUrl = process.env.DATABASE_URL;
const canRunAgainstLocalDatabase = (() => {
  if (!databaseUrl || process.env.SIGNUP_INTEGRATION_TESTS !== '1') return false;
  try {
    const url = new URL(databaseUrl);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
      && url.pathname.replace(/^\//, '') === 'schoolbase_signup_test';
  } catch {
    return false;
  }
})();

test('expired pending signups remain visible for a full retention window before cleanup', {
  skip: !canRunAgainstLocalDatabase,
}, async () => {
  const prisma = new PrismaClient();
  const now = new Date('2026-10-19T12:00:00.000Z');
  const freshEmail = `pending-retention-fresh-${randomUUID().slice(0, 10)}@example.invalid`;
  const staleEmail = `pending-retention-stale-${randomUUID().slice(0, 10)}@example.invalid`;

  try {
    await prisma.signupOtp.createMany({
      data: [
        {
          email: freshEmail,
          schoolName: 'Fresh Expired Queue',
          slug: `fresh-${randomUUID().slice(0, 10)}`,
          country: 'NG',
          adminName: 'Fresh Retention Test',
          passwordHash: 'fresh-retention-only',
          otpHash: 'fresh-retention-otp',
          expiresAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
        },
        {
          email: staleEmail,
          schoolName: 'Stale Expired Queue',
          slug: `stale-${randomUUID().slice(0, 10)}`,
          country: 'NG',
          adminName: 'Stale Retention Test',
          passwordHash: 'stale-retention-only',
          otpHash: 'stale-retention-otp',
          expiresAt: new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000),
        },
      ],
    });

    const result = await cleanupExpiredSignupData(now);

    assert.equal(result.expiredPendingSignups, 1);
    assert.equal(await prisma.signupOtp.count({ where: { email: freshEmail } }), 1);
    assert.equal(await prisma.signupOtp.count({ where: { email: staleEmail } }), 0);
  } finally {
    await prisma.signupOtp.deleteMany({ where: { email: { in: [freshEmail, staleEmail] } } });
    await prisma.$disconnect();
  }
});
