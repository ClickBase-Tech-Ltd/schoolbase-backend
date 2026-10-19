import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';

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

test('signup transaction rolls back account creation when the school slug conflicts', {
  skip: !canRunAgainstLocalDatabase,
}, async () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 14);
  const email = `signup-rollback-${suffix}@example.invalid`;
  const slug = `signup-rollback-${suffix}`;
  const otp = '123456';
  const recoveryKey = randomUUID() + randomUUID();
  let existingSchoolId: string | undefined;

  try {
    const existingSchool = await prisma.school.create({
      data: { name: `Existing ${suffix}`, slug, country: 'NG', status: 'TRIAL' },
      select: { id: true },
    });
    existingSchoolId = existingSchool.id;

    const { default: bcrypt } = await import('bcryptjs');
    const { default: trialRouter } = await import('../trial.js');
    const otpHash = await bcrypt.hash(otp, 10);
    await prisma.signupOtp.create({
      data: {
        email,
        schoolName: `Signup Rollback ${suffix}`,
        slug,
        country: 'NG',
        adminName: 'Signup Rollback Test',
        passwordHash: 'integration-test-only',
        otpHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const app = express();
    app.use(express.json());
    app.use('/api/trial', trialRouter);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/trial/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminEmail: email, otp, recoveryKey }),
      });
      assert.equal(response.status, 409);
      assert.equal(await prisma.user.count({ where: { email } }), 0);

      const signup = await prisma.signupOtp.findUnique({ where: { email } });
      assert.ok(signup);
      assert.equal(signup.verifiedAt, null);
      assert.equal(signup.recoveryKeyHash, null);
      assert.equal(await prisma.school.count({ where: { id: existingSchool.id } }), 1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await prisma.signupOtp.deleteMany({ where: { email } });
    if (existingSchoolId) await prisma.school.delete({ where: { id: existingSchoolId } }).catch(() => {});
    await prisma.$disconnect();
  }
});

test('concurrent initial verification creates one account and both retries can recover it', {
  skip: !canRunAgainstLocalDatabase,
}, async () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 14);
  const email = `signup-concurrent-${suffix}@example.invalid`;
  const slug = `signup-concurrent-${suffix}`;
  const otp = '654321';
  const recoveryKey = randomUUID() + randomUUID();
  let createdSchoolId: string | undefined;

  try {
    const { default: bcrypt } = await import('bcryptjs');
    const otpHash = await bcrypt.hash(otp, 10);
    await prisma.signupOtp.create({
      data: {
        email,
        schoolName: `Signup Concurrent ${suffix}`,
        slug,
        country: 'NG',
        adminName: 'Signup Concurrent Test',
        passwordHash: 'integration-test-only',
        otpHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
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
    const submit = () => fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminEmail: email, otp, recoveryKey }),
    });

    try {
      const responses = await Promise.all([submit(), submit()]);
      const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{
        success?: boolean;
        recovered?: boolean;
        token?: string;
        school?: { id: string };
      }>));

      assert.ok(responses.every((response) => response.status === 200 || response.status === 201));
      assert.ok(bodies.every((body) => body.success === true && body.token && body.school?.id));
      createdSchoolId = bodies[0].school?.id;
      assert.ok(createdSchoolId);
      assert.ok(bodies.every((body) => body.school?.id === createdSchoolId));
      assert.equal(await prisma.school.count({ where: { slug } }), 1);
      assert.equal(await prisma.user.count({ where: { email } }), 1);

      const retry = await submit();
      const retryBody = await retry.json() as { success?: boolean; recovered?: boolean; school?: { id: string } };
      assert.equal(retry.status, 200);
      assert.equal(retryBody.success, true);
      assert.equal(retryBody.recovered, true);
      assert.equal(retryBody.school?.id, createdSchoolId);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await prisma.signupOtp.deleteMany({ where: { email } });
    if (createdSchoolId) await prisma.school.delete({ where: { id: createdSchoolId } }).catch(() => {});
    await prisma.$disconnect();
  }
});

test('resend compare-and-swap cannot reactivate an OTP consumed during delivery', {
  skip: !canRunAgainstLocalDatabase,
}, async () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 14);
  const email = `signup-resend-race-${suffix}@example.invalid`;
  const oldOtp = '246810';
  const newOtp = '135790';

  try {
    const { default: bcrypt } = await import('bcryptjs');
    const oldOtpHash = await bcrypt.hash(oldOtp, 10);
    await prisma.signupOtp.create({
      data: {
        email,
        schoolName: `Signup Resend Race ${suffix}`,
        slug: `signup-resend-race-${suffix}`,
        country: 'NG',
        adminName: 'Signup Resend Race Test',
        passwordHash: 'integration-test-only',
        otpHash: oldOtpHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const otpModule = await import('../../services/otp.js');
    const reminderModule = await import('../../services/signup-reminder.js');
    let releaseDelivery!: () => void;
    let deliveryStarted!: () => void;
    const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const deliveryStartedGate = new Promise<void>((resolve) => { deliveryStarted = resolve; });

    const reminderPromise = reminderModule.deliverPendingSignupReminder({
      generateCode: () => newOtp,
      send: async () => {
        deliveryStarted();
        await deliveryGate;
      },
      replace: (code) => otpModule.replaceSignupOtpAfterDelivery(email, code, oldOtpHash),
    });

    await deliveryStartedGate;
    const consumed = await prisma.signupOtp.updateMany({
      where: { email, otpHash: oldOtpHash, verifiedAt: null },
      data: { verifiedAt: new Date(), recoveryKeyHash: 'f'.repeat(64), recoveryExpiresAt: new Date(Date.now() + 10 * 60 * 1000) },
    });
    assert.equal(consumed.count, 1);
    releaseDelivery();

    const reminderResult = await reminderPromise;
    const stored = await prisma.signupOtp.findUnique({ where: { email } });
    assert.equal(reminderResult, 'conflict');
    assert.ok(stored);
    assert.equal(stored.otpHash, oldOtpHash);
    assert.ok(stored.verifiedAt);
    assert.equal(await bcrypt.compare(newOtp, stored.otpHash), false);
  } finally {
    await prisma.signupOtp.deleteMany({ where: { email } });
    await prisma.$disconnect();
  }
});

test('verification using the old OTP loses compare-and-swap after a delivered resend replaces it', {
  skip: !canRunAgainstLocalDatabase,
}, async () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 14);
  const email = `signup-resend-first-${suffix}@example.invalid`;
  const oldOtp = '246810';
  const newOtp = '135790';

  try {
    const { default: bcrypt } = await import('bcryptjs');
    const oldOtpHash = await bcrypt.hash(oldOtp, 10);
    await prisma.signupOtp.create({
      data: {
        email,
        schoolName: `Signup Resend First ${suffix}`,
        slug: `signup-resend-first-${suffix}`,
        country: 'NG',
        adminName: 'Signup Resend First Test',
        passwordHash: 'integration-test-only',
        otpHash: oldOtpHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const { replaceSignupOtpAfterDelivery } = await import('../../services/otp.js');
    assert.equal(await replaceSignupOtpAfterDelivery(email, newOtp, oldOtpHash), true);
    const oldCodeConsume = await prisma.signupOtp.updateMany({
      where: { email, otpHash: oldOtpHash, verifiedAt: null, attempts: { lt: 5 }, expiresAt: { gt: new Date() } },
      data: { verifiedAt: new Date() },
    });
    const stored = await prisma.signupOtp.findUnique({ where: { email } });

    assert.equal(oldCodeConsume.count, 0);
    assert.ok(stored);
    assert.equal(stored.verifiedAt, null);
    assert.equal(await bcrypt.compare(oldOtp, stored.otpHash), false);
    assert.equal(await bcrypt.compare(newOtp, stored.otpHash), true);
  } finally {
    await prisma.signupOtp.deleteMany({ where: { email } });
    await prisma.$disconnect();
  }
});