import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import test from 'node:test';
import { SignJWT } from 'jose';
import { PrismaClient } from '@prisma/client';
import { getSessionSecret } from '../../services/security-config.js';

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

test('manual signup approval is rejected until explicit email-ownership policy is approved', {
  skip: !canRunAgainstLocalDatabase,
}, async () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 14);
  const email = `manual-approval-policy-${suffix}@example.invalid`;
  const slug = `manual-approval-policy-${suffix}`;

  try {
    await prisma.signupOtp.create({
      data: {
        email,
        schoolName: `Manual Approval Policy ${suffix}`,
        slug,
        country: 'NG',
        adminName: 'Manual Approval Test',
        passwordHash: 'integration-test-only',
        otpHash: 'manual-approval-test-hash',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const { default: adminRouter } = await import('../schoolbase-admin.js');
    app.use('/schoolbase-admin/api', adminRouter);

    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const token = await new SignJWT({ role: 'PLATFORM_ADMIN', userId: 'policy-test-user' })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(getSessionSecret());

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/schoolbase-admin/api/signups/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `schoolbase_session=${token}`,
        },
        body: JSON.stringify({ email }),
      });

      const body = await response.json() as { message?: string };
      assert.equal(response.status, 409, `Expected 409 but got ${response.status}: ${JSON.stringify(body)}`);
      assert.match(String(body.message || ''), /manual approval.*disabled|email-ownership policy|verify.*email/i);
      assert.equal(await prisma.school.count({ where: { email } }), 0);
      assert.equal(await prisma.user.count({ where: { email } }), 0);
      assert.equal(await prisma.signupOtp.count({ where: { email } }), 1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await prisma.signupOtp.deleteMany({ where: { email } });
    await prisma.$disconnect();
  }
});

test('manual signup approval rejects verified signups without creating partial accounts', {
  skip: !canRunAgainstLocalDatabase,
}, async () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 14);
  const email = `manual-approval-verified-${suffix}@example.invalid`;
  const slug = `manual-approval-verified-${suffix}`;

  try {
    await prisma.signupOtp.create({
      data: {
        email,
        schoolName: `Manual Approval Verified ${suffix}`,
        slug,
        country: 'NG',
        adminName: 'Verified Approval Test',
        passwordHash: 'integration-test-only',
        otpHash: 'manual-approval-verified-hash',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        verifiedAt: new Date(Date.now() - 1000),
      },
    });

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const { default: adminRouter } = await import('../schoolbase-admin.js');
    app.use('/schoolbase-admin/api', adminRouter);

    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const token = await new SignJWT({ role: 'PLATFORM_ADMIN', userId: 'verified-policy-test-user' })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(getSessionSecret());

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/schoolbase-admin/api/signups/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `schoolbase_session=${token}`,
        },
        body: JSON.stringify({ email }),
      });

      const body = await response.json() as { message?: string };
      assert.equal(response.status, 400, `Expected 400 but got ${response.status}: ${JSON.stringify(body)}`);
      assert.match(String(body.message || ''), /already verified/i);
      assert.equal(await prisma.school.count({ where: { email } }), 0);
      assert.equal(await prisma.user.count({ where: { email } }), 0);
      assert.equal(await prisma.signupOtp.count({ where: { email } }), 1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await prisma.signupOtp.deleteMany({ where: { email } });
    await prisma.$disconnect();
  }
});
