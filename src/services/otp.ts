import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';

const prisma = new PrismaClient();

export function generateOtp(): string {
  return randomInt(100000, 1_000_000).toString();
}

export interface SignupOtpPayload {
  email: string;
  schoolName: string;
  slug: string;
  country: string;
  adminName: string;
  tagline?: string;
  address?: string;
  phone?: string;
  password?: string;
  passwordHash?: string;
  otp: string;
  expirationMinutes?: number;
}

export interface SignupOtpRecord {
  email: string;
  schoolName: string;
  slug: string;
  country: string;
  adminName: string;
  tagline: string | null;
  address: string | null;
  phone: string | null;
  passwordHash: string;
  otpHash: string;
  attempts: number;
  expiresAt: Date;
  verifiedAt: Date | null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function saveSignupOtp(payload: SignupOtpPayload): Promise<string> {
  const normalizedEmail = normalizeEmail(payload.email);
  const expirationMinutes = payload.expirationMinutes ?? 10;

  if (!payload.password && !payload.passwordHash) {
    throw new Error('Password or password hash is required to save signup OTP');
  }

  const [otpHash, passwordHash] = await Promise.all([
    bcrypt.hash(payload.otp, 10),
    payload.password
      ? bcrypt.hash(payload.password, 10)
      : Promise.resolve(payload.passwordHash ?? ''),
  ]);

  await prisma.signupOtp.upsert({
    where: { email: normalizedEmail },
    create: {
      email: normalizedEmail,
      schoolName: payload.schoolName.trim(),
      slug: payload.slug.trim().toLowerCase(),
      country: payload.country.trim().toUpperCase(),
      adminName: payload.adminName.trim(),
      tagline: payload.tagline?.trim() || null,
      address: payload.address?.trim() || null,
      phone: payload.phone?.trim() || null,
      passwordHash,
      otpHash,
      attempts: 0,
      expiresAt: new Date(Date.now() + expirationMinutes * 60 * 1000),
      verifiedAt: null,
    },
    update: {
      schoolName: payload.schoolName.trim(),
      slug: payload.slug.trim().toLowerCase(),
      country: payload.country.trim().toUpperCase(),
      adminName: payload.adminName.trim(),
      tagline: payload.tagline?.trim() || null,
      address: payload.address?.trim() || null,
      phone: payload.phone?.trim() || null,
      passwordHash,
      otpHash,
      attempts: 0,
      expiresAt: new Date(Date.now() + expirationMinutes * 60 * 1000),
      verifiedAt: null,
    },
  });
  return otpHash;
}

export async function resendSignupOtp(
  email: string,
  otp: string,
  expirationMinutes = 10,
): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  const entry = await prisma.signupOtp.findUnique({
    where: { email: normalizedEmail },
  });

  if (!entry || entry.verifiedAt) {
    return false;
  }

  await prisma.signupOtp.update({
    where: { email: normalizedEmail },
    data: {
      otpHash: await bcrypt.hash(otp, 10),
      attempts: 0,
      expiresAt: new Date(Date.now() + expirationMinutes * 60 * 1000),
    },
  });

  return true;
}

export async function replaceSignupOtpAfterDelivery(
  email: string,
  otp: string,
  expectedOtpHash: string,
  expirationMinutes = 10,
): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  const updated = await prisma.signupOtp.updateMany({
    where: { email: normalizedEmail, otpHash: expectedOtpHash, verifiedAt: null },
    data: {
      otpHash: await bcrypt.hash(otp, 10),
      attempts: 0,
      expiresAt: new Date(Date.now() + expirationMinutes * 60 * 1000),
    },
  });
  return updated.count === 1;
}

export async function restoreSignupOtp(record: SignupOtpRecord, expectedOtpHash: string): Promise<boolean> {
  const restored = await prisma.signupOtp.updateMany({
    where: {
      email: normalizeEmail(record.email),
      otpHash: expectedOtpHash,
      verifiedAt: null,
    },
    data: {
      schoolName: record.schoolName,
      slug: record.slug,
      country: record.country,
      adminName: record.adminName,
      tagline: record.tagline,
      address: record.address,
      phone: record.phone,
      passwordHash: record.passwordHash,
      otpHash: record.otpHash,
      attempts: record.attempts,
      expiresAt: record.expiresAt,
      verifiedAt: record.verifiedAt,
    },
  });
  return restored.count === 1;
}

export async function verifySignupOtp(email: string, code: string): Promise<SignupOtpRecord | null> {
  const normalizedEmail = normalizeEmail(email);
  const entry = await prisma.signupOtp.findUnique({
    where: { email: normalizedEmail },
  });

  if (!entry || entry.verifiedAt) {
    return null;
  }

  if (entry.expiresAt.getTime() < Date.now()) {
    return null;
  }

  if (entry.attempts >= 5) {
    return null;
  }

  const valid = await bcrypt.compare(code, entry.otpHash);
  if (!valid) {
    await prisma.signupOtp.updateMany({
      where: {
        email: normalizedEmail,
        otpHash: entry.otpHash,
        verifiedAt: null,
        attempts: { lt: 5 },
        expiresAt: { gt: new Date() },
      },
      data: { attempts: { increment: 1 } },
    });
    return null;
  }

  return entry;
}

export async function getSignupOtp(email: string): Promise<SignupOtpRecord | null> {
  const normalizedEmail = normalizeEmail(email);
  const entry = await prisma.signupOtp.findUnique({
    where: { email: normalizedEmail },
    select: {
      email: true,
      schoolName: true,
      slug: true,
      country: true,
      adminName: true,
      tagline: true,
      address: true,
      phone: true,
      passwordHash: true,
      otpHash: true,
      attempts: true,
      expiresAt: true,
      verifiedAt: true,
    },
  });

  if (!entry) {
    return null;
  }

  return {
    email: entry.email,
    schoolName: entry.schoolName,
    slug: entry.slug,
    country: entry.country,
    adminName: entry.adminName,
    tagline: entry.tagline,
    address: entry.address,
    phone: entry.phone,
    passwordHash: entry.passwordHash,
    otpHash: entry.otpHash,
    attempts: entry.attempts,
    expiresAt: entry.expiresAt,
    verifiedAt: entry.verifiedAt,
  };
}

export async function hasPendingOtp(email: string): Promise<boolean> {
  const entry = await prisma.signupOtp.findUnique({
    where: { email: normalizeEmail(email) },
    select: { verifiedAt: true },
  });

  return !!entry && !entry.verifiedAt;
}
