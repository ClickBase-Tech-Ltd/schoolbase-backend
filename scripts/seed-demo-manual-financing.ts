import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL;
const databaseHost = databaseUrl ? new URL(databaseUrl).hostname : '';
if (process.env.NODE_ENV === 'production' ||
    process.env.ENABLE_DEMO_FINANCING_SEED !== 'YES_LOCAL_ONLY' ||
    !['localhost', '127.0.0.1', '::1'].includes(databaseHost)) {
  throw new Error('Demo financing seed is restricted to an explicitly enabled local database.');
}

const schoolId = process.env.DEMO_FINANCING_SCHOOL_ID?.trim();
const creatorId = process.env.DEMO_FINANCING_CREATOR_ID?.trim();
const configuredCheckerId = process.env.DEMO_FINANCING_CHECKER_ID?.trim();
const checkerId = configuredCheckerId || creatorId;
const schoolAdminId = process.env.DEMO_FINANCING_SCHOOL_ADMIN_ID?.trim();
if (!schoolId || !creatorId || !checkerId || !schoolAdminId) {
  throw new Error('Set the demo school, Platform Admin creator, and School Admin IDs.');
}

const prisma = new PrismaClient();

try {
  const [school, creator, checker, schoolAdmin] = await Promise.all([
    prisma.school.findUnique({ where: { id: schoolId }, select: { id: true, currency: true } }),
    prisma.user.findUnique({ where: { id: creatorId }, select: { id: true, role: true, isActive: true } }),
    prisma.user.findUnique({ where: { id: checkerId }, select: { id: true, role: true, isActive: true } }),
    prisma.user.findUnique({ where: { id: schoolAdminId }, select: { id: true, role: true, schoolId: true, isActive: true } }),
  ]);
  if (!school || !creator?.isActive || creator.role !== 'PLATFORM_ADMIN' ||
      !checker?.isActive || checker.role !== 'PLATFORM_ADMIN' ||
      !schoolAdmin?.isActive || schoolAdmin.role !== 'SCHOOL_ADMIN' || schoolAdmin.schoolId !== school.id) {
    throw new Error('Demo seed identities must be active admins in the selected school/platform.');
  }

  const now = new Date();
  await prisma.$transaction(async (transaction) => {
    const institution = await transaction.financingInstitution.upsert({
      where: { code: 'DEMO_MANUAL' },
      update: {
        displayName: 'Demo Manual Bank (TEST ONLY)',
        integrationMode: 'MANUAL',
        isDemo: true,
        status: 'ACTIVE',
      },
      create: {
        code: 'DEMO_MANUAL',
        displayName: 'Demo Manual Bank (TEST ONLY)',
        integrationMode: 'MANUAL',
        isDemo: true,
        status: 'ACTIVE',
      },
    });
    const product = await transaction.financingProduct.upsert({
      where: { institutionId_code: { institutionId: institution.id, code: 'DEMO_TUITION' } },
      update: {
        displayName: 'Demo Tuition Plan (TEST ONLY)',
        summary: 'A simulated manual partner workflow. This is not a real bank offer.',
        eligibilitySummary: 'Demonstration content only. No real eligibility rules apply.',
        termsSummary: 'Fictional test data only. No real loan, approval, rate, fee, or funding is available.',
        termsVersion: 'DEMO-ONLY-v1',
        termsUrl: 'https://demo.invalid/terms',
        currency: school.currency,
        applicationMode: 'SCHOOL_CONTACT',
        applicationUrl: null,
        approvalEvidenceReference: 'DEMO-ONLY-NOT-BANK-APPROVAL',
        createdBy: creator.id,
        approvedBy: checker.id,
        approvedAt: now,
        effectiveAt: now,
        expiresAt: null,
        status: 'ACTIVE',
      },
      create: {
        institutionId: institution.id,
        code: 'DEMO_TUITION',
        displayName: 'Demo Tuition Plan (TEST ONLY)',
        summary: 'A simulated manual partner workflow. This is not a real bank offer.',
        eligibilitySummary: 'Demonstration content only. No real eligibility rules apply.',
        termsSummary: 'Fictional test data only. No real loan, approval, rate, fee, or funding is available.',
        termsVersion: 'DEMO-ONLY-v1',
        termsUrl: 'https://demo.invalid/terms',
        currency: school.currency,
        applicationMode: 'SCHOOL_CONTACT',
        approvalEvidenceReference: 'DEMO-ONLY-NOT-BANK-APPROVAL',
        createdBy: creator.id,
        approvedBy: checker.id,
        approvedAt: now,
        effectiveAt: now,
        status: 'ACTIVE',
      },
    });
    await transaction.schoolFinancingProduct.upsert({
      where: { schoolId_productId: { schoolId: school.id, productId: product.id } },
      update: { enabledBy: schoolAdmin.id },
      create: { schoolId: school.id, productId: product.id, enabledBy: schoolAdmin.id },
    });
    await transaction.school.update({
      where: { id: school.id },
      data: {
        tuitionFinancingParticipationEnabled: true,
        tuitionFinancingParticipationUpdatedAt: now,
        tuitionFinancingParticipationUpdatedBy: schoolAdmin.id,
      },
    });
    await transaction.platformAuditLog.create({
      data: {
        userId: creator.id,
        schoolId: school.id,
        event: 'TUITION_FINANCING_DEMO_SEEDED',
        category: 'FINANCING',
        action: 'DEMO_FIXTURE_CREATED',
        outcome: 'SUCCESS',
        resourceType: 'FinancingProduct',
        resourceId: product.id,
        summary: 'Created a test-only manual financing fixture; no real lender or offer.',
        details: JSON.stringify({ institutionCode: institution.code, productCode: product.code }),
      },
    });
    console.log(`Seeded ${institution.displayName} and ${product.displayName} for school ${school.id}.`);
    if (creator.id === checker.id) console.warn('This local demo fixture was approved by the same Platform Admin who created it.');
    console.log('The Parent flow, school manual status controls, and DEMO_SIMULATION source are test-only; no payment is posted.');
  });
} finally {
  await prisma.$disconnect();
}
