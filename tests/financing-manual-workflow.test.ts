import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import {
  InvalidManualFinancingSettlementError,
  InvalidManualFinancingUpdateError,
  linkManualFinancingPayment,
  simulateDemoFinancingFunding,
  updateManualFinancingApplicationStatus,
} from '../src/services/financing-applications.js';

const now = new Date('2026-11-04T12:00:00.000Z');

function createPrisma(options: {
  status?: string;
  schoolId?: string;
  integrationMode?: string;
  applicationMode?: string;
  isDemo?: boolean;
} = {}) {
  const state = {
    application: {
      id: 'application-1',
      schoolId: options.schoolId ?? 'school-1',
      status: options.status ?? 'DRAFT',
      institution: {
        integrationMode: options.integrationMode ?? 'MANUAL',
        isDemo: options.isDemo ?? false,
      },
      product: { applicationMode: options.applicationMode ?? 'SCHOOL_CONTACT' },
    },
    events: [] as Array<Record<string, unknown>>,
    paymentWrites: 0,
  };
  const transaction = {
    financingApplication: {
      findFirst: async ({ where }: { where: { id: string; schoolId: string } }) =>
        where.id === state.application.id && where.schoolId === state.application.schoolId
          ? structuredClone(state.application)
          : null,
      updateMany: async ({ where, data }: {
        where: { id: string; schoolId: string; status: string };
        data: { status: string };
      }) => {
        if (where.id !== state.application.id ||
            where.schoolId !== state.application.schoolId ||
            where.status !== state.application.status) return { count: 0 };
        state.application.status = data.status;
        return { count: 1 };
      },
    },
    financingApplicationEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.events.push(data);
        return data;
      },
    },
    payment: {
      create: async () => {
        state.paymentWrites += 1;
        throw new Error('Manual financing workflow must not create a payment.');
      },
    },
  };
  const prisma = {
    platformSetting: { findUnique: async () => ({ value: 'true' }) },
    $transaction: async <T>(operation: (value: never) => Promise<T>) => operation(transaction as never),
  } as unknown as PrismaClient;
  return { prisma, state };
}

const realBank = createPrisma();
const submitted = await updateManualFinancingApplicationStatus(realBank.prisma, {
  applicationId: 'application-1',
  schoolId: 'school-1',
  actorId: 'bursar-1',
  status: 'SUBMITTED',
  source: 'BANK_PORTAL',
  sourceReference: 'BANK-CASE-100',
});
assert.equal(submitted.status, 'SUBMITTED');
assert.equal(realBank.state.events.length, 1);
assert.equal(realBank.state.events[0].actorId, 'bursar-1');
assert.equal(realBank.state.events[0].eventType, 'MANUAL_BANK_STATUS_RECORDED');
assert.deepEqual(realBank.state.events[0].metadata, {
  source: 'BANK_PORTAL',
  sourceReference: 'BANK-CASE-100',
  simulated: false,
});

for (const status of ['UNDER_REVIEW', 'OFFERED', 'OFFER_ACCEPTED'] as const) {
  const updated = await updateManualFinancingApplicationStatus(realBank.prisma, {
    applicationId: 'application-1',
    schoolId: 'school-1',
    actorId: 'bursar-1',
    status,
    source: 'BANK_SECURE_MESSAGE',
    sourceReference: `BANK-CASE-${status}`,
  });
  assert.equal(updated.status, status);
}
assert.deepEqual(
  realBank.state.events.map((event) => event.toStatus),
  ['SUBMITTED', 'UNDER_REVIEW', 'OFFERED', 'OFFER_ACCEPTED'],
);
assert.equal(realBank.state.paymentWrites, 0);

await assert.rejects(
  updateManualFinancingApplicationStatus(realBank.prisma, {
    applicationId: 'application-1',
    schoolId: 'school-1',
    actorId: 'bursar-1',
    status: 'CONSENTED',
    source: 'BANK_PORTAL',
  }),
  (error: unknown) => error instanceof InvalidManualFinancingUpdateError &&
    error.code === 'INVALID_TRANSITION',
);

const nonManual = createPrisma({ integrationMode: 'API' });
await assert.rejects(
  updateManualFinancingApplicationStatus(nonManual.prisma, {
    applicationId: 'application-1',
    schoolId: 'school-1',
    actorId: 'bursar-1',
    status: 'SUBMITTED',
    source: 'BANK_PORTAL',
  }),
  (error: unknown) => error instanceof InvalidManualFinancingUpdateError &&
    error.code === 'NOT_MANUAL',
);

const crossSchoolStatus = createPrisma({ schoolId: 'school-2' });
await assert.rejects(
  updateManualFinancingApplicationStatus(crossSchoolStatus.prisma, {
    applicationId: 'application-1',
    schoolId: 'school-1',
    actorId: 'bursar-1',
    status: 'SUBMITTED',
    source: 'BANK_PORTAL',
  }),
  (error: unknown) => error instanceof InvalidManualFinancingUpdateError &&
    error.code === 'NOT_FOUND',
);

const demoBank = createPrisma({ isDemo: true });
const demoSubmitted = await updateManualFinancingApplicationStatus(demoBank.prisma, {
  applicationId: 'application-1',
  schoolId: 'school-1',
  actorId: 'bursar-1',
  status: 'SUBMITTED',
  source: 'DEMO_SIMULATION',
});
assert.equal(demoSubmitted.status, 'SUBMITTED');
assert.equal(demoBank.state.events[0].eventType, 'DEMO_STATUS_SIMULATED');

await assert.rejects(
  updateManualFinancingApplicationStatus(demoBank.prisma, {
    applicationId: 'application-1',
    schoolId: 'school-1',
    actorId: 'bursar-1',
    status: 'UNDER_REVIEW',
    source: 'BANK_PORTAL',
  }),
  (error: unknown) => error instanceof InvalidManualFinancingUpdateError &&
    error.code === 'NOT_MANUAL',
);

function createSettlementPrisma(options: {
  isDemo?: boolean;
  status?: string;
  integrationMode?: string;
  applicationMode?: string;
  paymentMethod?: string;
  paymentReference?: string;
  paymentInvoiceId?: string;
  paymentSchoolId?: string;
  paymentAlreadyLinked?: boolean;
} = {}) {
  const state = {
    application: {
      id: 'application-settlement',
      schoolId: 'school-1',
      invoiceId: 'invoice-1',
      status: options.status ?? 'OFFER_ACCEPTED',
      institution: { integrationMode: options.integrationMode ?? 'MANUAL', isDemo: options.isDemo ?? false },
      product: { applicationMode: options.applicationMode ?? 'SCHOOL_CONTACT' },
      events: [] as Array<{ id: string }>,
    },
    linkedPayments: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
  };
  const transaction = {
    financingApplication: {
      findFirst: async ({ where }: { where: { id: string; schoolId: string } }) =>
        where.id === state.application.id && where.schoolId === state.application.schoolId
          ? structuredClone(state.application)
          : null,
      updateMany: async ({ where }: { where: { status: string } }) =>
        where.status === state.application.status ? { count: 1 } : { count: 0 },
    },
    payment: {
      findFirst: async ({ where }: {
        where: {
          id: string;
          invoiceId: string;
          reference: string;
          method: string;
          invoice: { schoolId: string };
        };
      }) =>
        where.id === 'payment-1' && where.invoiceId === 'invoice-1' && where.reference === 'BANK-SETTLEMENT-1'
          && where.method === 'BANK_TRANSFER'
          && where.invoice.schoolId === 'school-1'
          && (options.paymentMethod ?? 'BANK_TRANSFER') === where.method
          && (options.paymentReference ?? 'BANK-SETTLEMENT-1') === where.reference
          && (options.paymentInvoiceId ?? where.invoiceId) === where.invoiceId
          && (options.paymentSchoolId ?? where.invoice.schoolId) === where.invoice.schoolId
          ? {
              id: 'payment-1',
              amount: 12500,
              reference: options.paymentReference ?? 'BANK-SETTLEMENT-1',
              paidAt: now,
              financingApplicationPayment: options.paymentAlreadyLinked ? { id: 'existing-link' } : null,
            }
          : null,
    },
    financingApplicationPayment: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.linkedPayments.push(data);
        return { id: 'link-1', ...data, recordedAt: now };
      },
    },
    financingApplicationEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.events.push(data);
        if (data.eventType === 'DEMO_FUNDING_SIMULATED') {
          state.application.events.push({ id: 'demo-funding-event' });
        }
        return data;
      },
    },
  };
  const prisma = {
    platformSetting: { findUnique: async () => ({ value: 'true' }) },
    $transaction: async <T>(operation: (value: never) => Promise<T>) => operation(transaction as never),
  } as unknown as PrismaClient;
  return { prisma, state };
}

const actualSettlement = createSettlementPrisma();
const linked = await linkManualFinancingPayment(actualSettlement.prisma, {
  applicationId: 'application-settlement',
  schoolId: 'school-1',
  actorId: 'bursar-1',
  paymentId: 'payment-1',
  bankReference: 'BANK-SETTLEMENT-1',
});
assert.equal(linked.paymentId, 'payment-1');
assert.equal(actualSettlement.state.linkedPayments.length, 1);
assert.equal(actualSettlement.state.events[0].eventType, 'MANUAL_SETTLEMENT_RECONCILED');
assert.equal(actualSettlement.state.events[0].actorId, 'bursar-1');

for (const invalidPayment of [
  { paymentReference: 'OTHER-REFERENCE' },
  { paymentMethod: 'CASH' },
  { paymentInvoiceId: 'another-invoice' },
  { paymentSchoolId: 'another-school' },
]) {
  const invalidSettlement = createSettlementPrisma(invalidPayment);
  await assert.rejects(
    linkManualFinancingPayment(invalidSettlement.prisma, {
      applicationId: 'application-settlement',
      schoolId: 'school-1',
      actorId: 'bursar-1',
      paymentId: 'payment-1',
      bankReference: 'BANK-SETTLEMENT-1',
    }),
    (error: unknown) => error instanceof InvalidManualFinancingSettlementError &&
      error.code === 'PAYMENT_NOT_FOUND',
  );
  assert.equal(invalidSettlement.state.linkedPayments.length, 0);
  assert.equal(invalidSettlement.state.events.length, 0);
}

const linkedAlready = createSettlementPrisma({ paymentAlreadyLinked: true });
await assert.rejects(
  linkManualFinancingPayment(linkedAlready.prisma, {
    applicationId: 'application-settlement',
    schoolId: 'school-1',
    actorId: 'bursar-1',
    paymentId: 'payment-1',
    bankReference: 'BANK-SETTLEMENT-1',
  }),
  (error: unknown) => error instanceof InvalidManualFinancingSettlementError &&
    error.code === 'PAYMENT_ALREADY_LINKED',
);
assert.equal(linkedAlready.state.linkedPayments.length, 0);

for (const invalidApplication of [
  { status: 'OFFERED' },
  { integrationMode: 'API' },
  { applicationMode: 'HOSTED' },
]) {
  const ineligible = createSettlementPrisma(invalidApplication);
  await assert.rejects(
    linkManualFinancingPayment(ineligible.prisma, {
      applicationId: 'application-settlement',
      schoolId: 'school-1',
      actorId: 'bursar-1',
      paymentId: 'payment-1',
      bankReference: 'BANK-SETTLEMENT-1',
    }),
    (error: unknown) => error instanceof InvalidManualFinancingSettlementError &&
      error.code === 'NOT_ELIGIBLE',
  );
  assert.equal(ineligible.state.linkedPayments.length, 0);
}

const wrongSchool = createSettlementPrisma();
await assert.rejects(
  linkManualFinancingPayment(wrongSchool.prisma, {
    applicationId: 'application-settlement',
    schoolId: 'another-school',
    actorId: 'bursar-1',
    paymentId: 'payment-1',
    bankReference: 'BANK-SETTLEMENT-1',
  }),
  (error: unknown) => error instanceof InvalidManualFinancingSettlementError &&
    error.code === 'NOT_FOUND',
);
assert.equal(wrongSchool.state.linkedPayments.length, 0);

const demoSettlement = createSettlementPrisma({ isDemo: true });
await assert.rejects(
  linkManualFinancingPayment(demoSettlement.prisma, {
    applicationId: 'application-settlement',
    schoolId: 'school-1',
    actorId: 'bursar-1',
    paymentId: 'payment-1',
    bankReference: 'BANK-SETTLEMENT-1',
  }),
  (error: unknown) => error instanceof InvalidManualFinancingSettlementError &&
    error.code === 'NOT_ELIGIBLE',
);

function createDemoFundingPrisma() {
  const state = {
    events: [] as Array<Record<string, unknown>>,
    existing: false,
    paymentWrites: 0,
  };
  const transaction = {
    financingApplication: {
      findFirst: async () => ({
        id: 'demo-app',
        schoolId: 'school-1',
        status: 'OFFER_ACCEPTED',
        institution: { integrationMode: 'MANUAL', isDemo: true },
        product: { applicationMode: 'SCHOOL_CONTACT' },
        events: state.existing ? [{ id: 'already-simulated' }] : [],
      }),
    },
    financingApplicationEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.events.push(data);
        state.existing = true;
        return data;
      },
    },
    payment: {
      create: async () => {
        state.paymentWrites += 1;
        throw new Error('Demo funding simulation must not create a payment.');
      },
    },
  };
  const prisma = {
    platformSetting: { findUnique: async () => ({ value: 'true' }) },
    $transaction: async <T>(operation: (value: never) => Promise<T>) => operation(transaction as never),
  } as unknown as PrismaClient;
  return { prisma, state };
}

const demoFunding = createDemoFundingPrisma();
const simulatedFunding = await simulateDemoFinancingFunding(demoFunding.prisma, {
  applicationId: 'demo-app',
  schoolId: 'school-1',
  actorId: 'bursar-1',
});
assert.equal(simulatedFunding.paymentPosted, false);
assert.equal(demoFunding.state.paymentWrites, 0);
assert.equal(demoFunding.state.events[0].eventType, 'DEMO_FUNDING_SIMULATED');
assert.deepEqual(demoFunding.state.events[0].metadata, { simulated: true, paymentPosted: false });
await assert.rejects(
  simulateDemoFinancingFunding(demoFunding.prisma, {
    applicationId: 'demo-app',
    schoolId: 'school-1',
    actorId: 'bursar-1',
  }),
  (error: unknown) => error instanceof InvalidManualFinancingSettlementError &&
    error.code === 'SIMULATION_ALREADY_RECORDED',
);

console.log('Manual financing workflow tests passed');
