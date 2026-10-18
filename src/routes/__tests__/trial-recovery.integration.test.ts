import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL;
const canRunAgainstLocalDatabase = (() => {
  if (!databaseUrl) return false;
  try {
    const url = new URL(databaseUrl);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
      && url.pathname.replace(/^\//, '') === 'schoolbase';
  } catch {
    return false;
  }
})();

test('signup verification retry recovers the same account only with its recovery key', {
  skip: !canRunAgainstLocalDatabase,
}, async () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 14);
  const email = `signup-recovery-${suffix}@example.invalid`;
  const slug = `signup-recovery-${suffix}`;
  const recoveryKey = randomUUID() + randomUUID();
  const recoveryKeyHash = createHash('sha256').update(recoveryKey).digest('hex');
  let schoolId: string | undefined;

  try {
    const school = await prisma.school.create({
      data: { name: `Signup Recovery ${suffix}`, slug, country: 'NG', status: 'TRIAL' },
      select: { id: true },
    });
    schoolId = school.id;
    const user = await prisma.user.create({
      data: {
        email,
        name: 'Signup Recovery Test',
        role: 'SCHOOL_ADMIN',
        passwordHash: 'integration-test-only',
        schoolId: school.id,
      },
      select: { id: true },
    });
    await prisma.signupOtp.create({
      data: {
        email,
        schoolName: `Signup Recovery ${suffix}`,
        slug,
        country: 'NG',
        adminName: 'Signup Recovery Test',
        passwordHash: 'integration-test-only',
        otpHash: 'already-consumed-test-challenge',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        verifiedAt: new Date(),
        recoveryKeyHash,
        recoveryExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const app = express();
    app.use(express.json());
    const { default: trialRouter } = await import('../trial.js');
    app.use('/api/trial', trialRouter);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}/api/trial/verify-otp`;

    try {
      const recover = (key: string) => fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminEmail: email, recoveryKey: key }),
      });

      const firstRetry = await recover(recoveryKey);
      const firstBody = await firstRetry.json() as { recovered?: boolean; token?: string; school?: { id: string } };
      assert.equal(firstRetry.status, 200);
      assert.equal(firstBody.recovered, true);
      assert.ok(firstBody.token);
      assert.equal(firstBody.school?.id, school.id);

      const wrongKeyRetry = await recover(`${recoveryKey}-wrong`);
      assert.equal(wrongKeyRetry.status, 401);

      const secondRetry = await recover(recoveryKey);
      const secondBody = await secondRetry.json() as { recovered?: boolean; token?: string; school?: { id: string } };
      assert.equal(secondRetry.status, 200);
      assert.equal(secondBody.recovered, true);
      assert.equal(secondBody.school?.id, school.id);
      assert.ok(secondBody.token);

      assert.equal(await prisma.school.count({ where: { id: school.id } }), 1);
      assert.equal(await prisma.user.count({ where: { id: user.id } }), 1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await prisma.signupOtp.deleteMany({ where: { email } });
    if (schoolId) await prisma.school.delete({ where: { id: schoolId } }).catch(() => {});
    await prisma.$disconnect();
  }
});