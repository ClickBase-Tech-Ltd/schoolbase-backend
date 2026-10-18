import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { getSessionSecret } from './security-config.js';

const prisma = new PrismaClient();
const WINDOW_MS = 15 * 60 * 1000;
const EMAIL_COOLDOWN_MS = 60 * 1000;
const EMAIL_LIMIT = 5;
const IP_LIMIT = 20;

function getClientIpAssertionSecret(): string | null {
  return process.env.SIGNUP_IP_ASSERTION_SECRET?.trim()
    || process.env.SESSION_SECRET?.trim()
    || null;
}

function bucketKey(kind: 'email' | 'email-cooldown' | 'ip', value: string): string {
  return createHmac('sha256', getSessionSecret()).update(`${kind}:${value}`).digest('hex');
}

export function verifyClientIpAssertion(assertion?: string, now = Date.now()): string | null {
  if (!assertion || assertion.length > 512) return null;
  const secret = getClientIpAssertionSecret();
  if (!secret) return null;
  const [encodedPayload, signature, extra] = assertion.split('.');
  if (!encodedPayload || !signature || extra) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as { ip?: unknown; timestamp?: unknown };
    if (typeof payload.ip !== 'string' || !isValidIp(payload.ip) || typeof payload.timestamp !== 'number') return null;
    if (Math.abs(now - payload.timestamp) > 2 * 60 * 1000) return null;

    const expected = createHmac('sha256', secret).update(encodedPayload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    return payload.ip;
  } catch {
    return null;
  }
}

function isValidIp(value: string): boolean {
  return value.length <= 64 && !value.includes(',') && isIP(value) !== 0;
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

export async function allowSignupOtpRequest(email: string, clientIp?: string): Promise<boolean> {
  const normalizedEmail = email.trim().toLowerCase();
  const allowedByCooldown = await acquire(bucketKey('email-cooldown', normalizedEmail), 1, EMAIL_COOLDOWN_MS);
  const allowedByEmail = await acquire(bucketKey('email', normalizedEmail), EMAIL_LIMIT);
  const allowedByIp = clientIp ? await acquire(bucketKey('ip', clientIp), IP_LIMIT) : true;
  return allowedByCooldown && allowedByEmail && allowedByIp;
}

export const signupRateLimitPolicy = {
  emailCooldownMs: EMAIL_COOLDOWN_MS,
  emailWindowMs: WINDOW_MS,
  emailWindowLimit: EMAIL_LIMIT,
  ipWindowLimit: IP_LIMIT,
};