import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import {
  createFinancingApplication,
  FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS,
  isFinancingInterestAcknowledgementList,
  InvalidFinancingApplicationScopeError,
  processClaimedFinancingProviderEvent,
} from '../src/services/financing-applications.js';

const now = new Date('2026-11-04T12:00:00.000Z');
const leaseExpiresAt = new Date(now.getTime() + 30_000);

assert.equal(isFinancingInterestAcknowledgementList([...FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS]), true);
assert.equal(isFinancingInterestAcknowledgementList(FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS.slice(0, 2)), false);
assert.equal(isFinancingInterestAcknowledgementList([
  FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS[0],
  FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS[0],
  FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS[1],
]), false);

function createProcessorPrisma(options: {
  applicationStatus?: string;
  applicationReference?: string;
  failHistoryCreate?: boolean;
  eventType?: string;
  normalizedPayload?: Record<string, unknown>;
} = {}) {
  let state = {
    event: {
      id: 'event-1',
      institutionId: 'institution-1',
      externalEventId: 'provider-event-1',
      eventType: options.eventType ?? 'APPLICATION_STATUS',
      applicationReference: 'provider-app-1',
      occurredAt: new Date('2026-11-04T11:00:00.000Z'),
      normalizedPayload: options.normalizedPayload ?? {
        eventId: 'provider-event-1',
        applicationReference: 'provider-app-1',
        occurredAt: '2026-11-04T11:00:00.000Z',
        type: 'APPLICATION_STATUS',
        status: 'UNDER_REVIEW',
      },
      status: 'PROCESSING',
      lockExpiresAt: leaseExpiresAt,
      processedAt: null as Date | null,
      lastErrorCode: null as string | null,
    },
    application: {
      id: 'application-1',
      schoolId: 'school-1',
      institutionId: 'institution-1',
      externalApplicationReference: options.applicationReference ?? 'provider-app-1',
      status: options.applicationStatus ?? 'SUBMITTED',
    },
    history: [] as Array<Record<string, unknown>>,
  };

  const prisma = {
    $transaction: async <T>(operation: (transaction: never) => Promise<T>): Promise<T> => {
      const working = structuredClone(state);
      const transaction = {
        financingProviderEvent: {
          findUnique: async () => structuredClone(working.event),
          updateMany: async ({ where, data }: {
            where: { id: string; status: string; lockExpiresAt: { equals: Date; gt: Date } };
            data: Record<string, unknown>;
          }) => {
            if (where.id !== working.event.id ||
                where.status !== working.event.status ||
                working.event.lockExpiresAt?.getTime() !== where.lockExpiresAt.equals.getTime() ||
                working.event.lockExpiresAt?.getTime() <= where.lockExpiresAt.gt.getTime()) {
              return { count: 0 };
            }
            Object.assign(working.event, data);
            return { count: 1 };
          },
        },
        financingApplication: {
          findFirst: async ({ where }: {
            where: { institutionId: string; externalApplicationReference: string };
          }) => {
            if (where.institutionId !== working.application.institutionId ||
                where.externalApplicationReference !== working.application.externalApplicationReference) {
              return null;
            }
            return structuredClone(working.application);
          },
          updateMany: async ({ where, data }: {
            where: { id: string; status: string };
            data: { status: string };
          }) => {
            if (where.id !== working.application.id || where.status !== working.application.status) {
              return { count: 0 };
            }
            working.application.status = data.status;
            return { count: 1 };
          },
        },
        financingApplicationEvent: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            if (options.failHistoryCreate) throw new Error('simulated history write failure');
            working.history.push(data);
            return data;
          },
        },
      };
      const result = await operation(transaction as never);
      state = working;
      return result;
    },
  };

  return {
    prisma: prisma as unknown as PrismaClient,
    getState: () => structuredClone(state),
  };
}

const normal = createProcessorPrisma();
assert.deepEqual(
  await processClaimedFinancingProviderEvent(normal.prisma, {
    eventId: 'event-1',
    leaseExpiresAt,
    now,
  }),
  { status: 'PROCESSED', applicationId: 'application-1', action: 'PROVIDER_STATUS_CHANGED' },
);
assert.equal(normal.getState().application.status, 'UNDER_REVIEW');
assert.equal(normal.getState().event.status, 'PROCESSED');
assert.equal(normal.getState().history.length, 1);
assert.equal(normal.getState().history[0]?.schoolId, 'school-1');

const outOfOrder = createProcessorPrisma({ applicationStatus: 'REJECTED' });
assert.deepEqual(
  await processClaimedFinancingProviderEvent(outOfOrder.prisma, {
    eventId: 'event-1',
    leaseExpiresAt,
    now,
  }),
  {
    status: 'REVIEW_REQUIRED',
    reason: 'OUT_OF_ORDER_PROVIDER_EVENT',
    applicationId: 'application-1',
  },
);
assert.equal(outOfOrder.getState().application.status, 'REJECTED');
assert.equal(outOfOrder.getState().history.length, 0);

const unmatched = createProcessorPrisma({ applicationReference: 'different-provider-app' });
assert.deepEqual(
  await processClaimedFinancingProviderEvent(unmatched.prisma, {
    eventId: 'event-1',
    leaseExpiresAt,
    now,
  }),
  { status: 'REVIEW_REQUIRED', reason: 'UNMATCHED_APPLICATION' },
);
assert.equal(unmatched.getState().event.status, 'REVIEW_REQUIRED');

const staleLease = createProcessorPrisma();
const staleLeaseResult = await processClaimedFinancingProviderEvent(staleLease.prisma, {
  eventId: 'event-1',
  leaseExpiresAt: new Date(leaseExpiresAt.getTime() + 1),
  now,
});
assert.deepEqual(staleLeaseResult, { status: 'LEASE_LOST' });
assert.equal(staleLease.getState().application.status, 'SUBMITTED');

const rollback = createProcessorPrisma({ failHistoryCreate: true });
await assert.rejects(() => processClaimedFinancingProviderEvent(rollback.prisma, {
  eventId: 'event-1',
  leaseExpiresAt,
  now,
}), /simulated history write failure/);
assert.equal(rollback.getState().application.status, 'SUBMITTED');
assert.equal(rollback.getState().event.status, 'PROCESSING');
assert.equal(rollback.getState().history.length, 0);

const disbursement = createProcessorPrisma({
  applicationStatus: 'OFFER_ACCEPTED',
  eventType: 'DISBURSEMENT_REPORTED',
  normalizedPayload: {
    eventId: 'provider-event-1',
    applicationReference: 'provider-app-1',
    occurredAt: '2026-11-04T11:00:00.000Z',
    type: 'DISBURSEMENT_REPORTED',
    amountMinor: 12500,
    currency: 'NGN',
    settlementReference: 'settlement-1',
  },
});
assert.deepEqual(
  await processClaimedFinancingProviderEvent(disbursement.prisma, {
    eventId: 'event-1',
    leaseExpiresAt,
    now,
  }),
  {
    status: 'REVIEW_REQUIRED',
    reason: 'DISBURSEMENT_PENDING_RECONCILIATION',
    applicationId: 'application-1',
  },
);
assert.equal(disbursement.getState().event.status, 'REVIEW_REQUIRED');
assert.equal(disbursement.getState().application.status, 'OFFER_ACCEPTED');
assert.equal(disbursement.getState().history.length, 1);
assert.equal(disbursement.getState().history[0]?.eventType, 'DISBURSEMENT_REPORTED');
assert.equal(disbursement.getState().history[0]?.toStatus, 'OFFER_ACCEPTED');

function createApplicationPrisma(options: {
  invoiceSchoolId?: string;
  schoolParticipationEnabled?: boolean;
  existingApplication?: boolean;
  uniqueConflict?: boolean;
  institutionActive?: boolean;
  productActive?: boolean;
} = {}) {
  let createdApplications = 0;
  let createdApplicationData: Record<string, unknown> | null = null;
  let institutionLookups = 0;
  const schoolId = 'school-1';
  const prisma = {
    platformSetting: {
      findUnique: async () => ({ key: 'tuitionFinancingEnabled', value: 'true' }),
    },
    financingApplication: {
      findUnique: async ({ where }: { where: { interestKey: string } }) =>
        options.uniqueConflict && /^[a-f0-9]{64}$/.test(where.interestKey)
          ? { id: 'parallel-application', status: 'DRAFT' }
          : null,
    },
    $transaction: async <T>(operation: (transaction: never) => Promise<T>): Promise<T> => {
      const transaction = {
        school: {
          findFirst: async ({ where }: { where: { id: string; tuitionFinancingParticipationEnabled: boolean } }) =>
            where.id === schoolId &&
            where.tuitionFinancingParticipationEnabled === (options.schoolParticipationEnabled ?? true)
              ? { id: schoolId, currency: 'NGN' }
              : null,
        },
        pupil: {
          findFirst: async ({ where }: { where: { id: string; schoolId: string; isActive: boolean } }) =>
            where.id === 'pupil-1' && where.schoolId === schoolId && where.isActive
              ? { id: 'pupil-1' }
              : null,
        },
        guardian: {
          findFirst: async ({ where }: { where: { id: string; schoolId: string } }) =>
            where.id === 'guardian-1' && where.schoolId === schoolId
              ? { id: 'guardian-1' }
              : null,
        },
        guardianPupil: {
          findUnique: async ({ where }: {
            where: { guardianId_pupilId: { guardianId: string; pupilId: string } };
          }) =>
            where.guardianId_pupilId.guardianId === 'guardian-1' &&
            where.guardianId_pupilId.pupilId === 'pupil-1'
              ? { guardianId: 'guardian-1' }
              : null,
        },
        invoice: {
          findFirst: async ({ where }: {
            where: {
              id: string;
              schoolId: string;
              pupilId: string;
              status: { in: string[] };
              voidedAt: null;
            };
          }) =>
            where.id === 'invoice-1' &&
            where.schoolId === (options.invoiceSchoolId ?? schoolId) &&
            where.pupilId === 'pupil-1'
              ? { id: 'invoice-1', amountDue: 50000, amountPaid: 10000 }
              : null,
        },
        financingInstitution: {
          findFirst: async ({ where }: { where: { id: string; status: string } }) => {
            institutionLookups += 1;
            return options.institutionActive !== false &&
              where.id === 'institution-1' && where.status === 'ACTIVE'
              ? { id: 'institution-1' }
              : null;
          },
        },
        financingProduct: {
          findFirst: async ({ where }: { where: { id: string } }) =>
            options.productActive && where.id === 'product-1'
              ? { id: 'product-1', institutionId: 'institution-1', currency: 'NGN' }
              : null,
        },
        financingApplication: {
          findUnique: async () => options.existingApplication
            ? { id: 'existing-application', status: 'DRAFT' }
            : null,
          create: async ({ data }: { data: Record<string, unknown> }) => {
            if (options.uniqueConflict) {
              throw Object.assign(new Error('simulated unique constraint conflict'), { code: 'P2002' });
            }
            createdApplications += 1;
            createdApplicationData = data;
            return { id: 'application-created', ...data };
          },
        },
      };
      return operation(transaction as never);
    },
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    get createdApplications() { return createdApplications; },
    get createdApplicationData() { return createdApplicationData; },
    get institutionLookups() { return institutionLookups; },
  };
}

const scopedApplication = createApplicationPrisma();
await assert.rejects(() => createFinancingApplication(scopedApplication.prisma, {
  schoolId: 'school-1',
  pupilId: 'pupil-1',
  guardianId: 'guardian-1',
  invoiceId: 'invoice-1',
  institutionId: 'institution-1',
  interestNoticeVersion: 'outdated-notice',
  acknowledgedItems: [...FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS],
}), /current tuition-financing interest notice/);
assert.equal(scopedApplication.createdApplications, 0);

await assert.rejects(() => createFinancingApplication(scopedApplication.prisma, {
  schoolId: 'school-1',
  pupilId: 'pupil-1',
  guardianId: 'guardian-1',
  invoiceId: 'invoice-1',
  institutionId: 'institution-1',
  interestNoticeVersion: 'tuition-financing-interest-v2',
  acknowledgedItems: [],
}), /All current tuition-financing acknowledgements are required/);
assert.equal(scopedApplication.createdApplications, 0);

const application = await createFinancingApplication(scopedApplication.prisma, {
  schoolId: 'school-1',
  pupilId: 'pupil-1',
  guardianId: 'guardian-1',
  invoiceId: 'invoice-1',
  institutionId: 'institution-1',
  interestNoticeVersion: 'tuition-financing-interest-v2',
  acknowledgedItems: [...FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS],
});
assert.equal(application.id, 'application-created');
assert.equal(scopedApplication.createdApplications, 1);
assert.match(String(application.interestKey), /^[a-f0-9]{64}$/);
assert.deepEqual(application.events.create.metadata, {
  noticeVersion: 'tuition-financing-interest-v2',
  acknowledgedItems: FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS,
});

const generalInterest = createApplicationPrisma();
const generalApplication = await createFinancingApplication(generalInterest.prisma, {
  schoolId: 'school-1',
  pupilId: 'pupil-1',
  guardianId: 'guardian-1',
  invoiceId: 'invoice-1',
  interestNoticeVersion: 'tuition-financing-interest-v2',
  acknowledgedItems: [...FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS],
});
assert.equal(generalApplication.id, 'application-created');
assert.equal(generalInterest.createdApplications, 1);
assert.equal(generalInterest.institutionLookups, 0);
assert.match(String(generalApplication.interestKey), /^[a-f0-9]{64}$/);
assert.equal(
  Object.prototype.hasOwnProperty.call(generalInterest.createdApplicationData ?? {}, 'institutionId'),
  false,
);

const repeatedGeneralInterest = createApplicationPrisma({ existingApplication: true });
const existingGeneralApplication = await createFinancingApplication(repeatedGeneralInterest.prisma, {
  schoolId: 'school-1',
  pupilId: 'pupil-1',
  guardianId: 'guardian-1',
  invoiceId: 'invoice-1',
  interestNoticeVersion: 'tuition-financing-interest-v2',
  acknowledgedItems: [...FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS],
});
assert.equal(existingGeneralApplication.id, 'existing-application');
assert.equal(repeatedGeneralInterest.createdApplications, 0);
assert.equal(repeatedGeneralInterest.institutionLookups, 0);

const inactiveInstitution = createApplicationPrisma({ institutionActive: false });
await assert.rejects(() => createFinancingApplication(inactiveInstitution.prisma, {
  schoolId: 'school-1',
  pupilId: 'pupil-1',
  guardianId: 'guardian-1',
  invoiceId: 'invoice-1',
  institutionId: 'institution-1',
  interestNoticeVersion: 'tuition-financing-interest-v2',
  acknowledgedItems: [...FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS],
}), InvalidFinancingApplicationScopeError);
assert.equal(inactiveInstitution.institutionLookups, 1);
assert.equal(inactiveInstitution.createdApplications, 0);

const inactiveProduct = createApplicationPrisma();
await assert.rejects(() => createFinancingApplication(inactiveProduct.prisma, {
  schoolId: 'school-1',
  pupilId: 'pupil-1',
  guardianId: 'guardian-1',
  invoiceId: 'invoice-1',
  productId: 'product-1',
  interestNoticeVersion: 'tuition-financing-interest-v2',
  acknowledgedItems: [...FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS],
}), InvalidFinancingApplicationScopeError);
assert.equal(inactiveProduct.createdApplications, 0);

const selectedProduct = createApplicationPrisma({ productActive: true });
const productApplication = await createFinancingApplication(selectedProduct.prisma, {
  schoolId: 'school-1',
  pupilId: 'pupil-1',
  guardianId: 'guardian-1',
  invoiceId: 'invoice-1',
  productId: 'product-1',
  interestNoticeVersion: 'tuition-financing-interest-v2',
  acknowledgedItems: [...FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS],
});
assert.equal(selectedProduct.createdApplications, 1);
assert.equal(selectedProduct.createdApplicationData?.productId, 'product-1');
assert.equal(selectedProduct.createdApplicationData?.institutionId, 'institution-1');

const crossSchoolApplication = createApplicationPrisma({ invoiceSchoolId: 'school-2' });
await assert.rejects(() => createFinancingApplication(crossSchoolApplication.prisma, {
  schoolId: 'school-1',
  pupilId: 'pupil-1',
  guardianId: 'guardian-1',
  invoiceId: 'invoice-1',
  institutionId: 'institution-1',
  interestNoticeVersion: 'tuition-financing-interest-v2',
  acknowledgedItems: [...FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS],
}), InvalidFinancingApplicationScopeError);
assert.equal(crossSchoolApplication.createdApplications, 0);

const optedOutSchool = createApplicationPrisma({ schoolParticipationEnabled: false });
await assert.rejects(() => createFinancingApplication(optedOutSchool.prisma, {
  schoolId: 'school-1',
  pupilId: 'pupil-1',
  guardianId: 'guardian-1',
  invoiceId: 'invoice-1',
  institutionId: 'institution-1',
  interestNoticeVersion: 'tuition-financing-interest-v2',
  acknowledgedItems: [...FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS],
}), InvalidFinancingApplicationScopeError);
assert.equal(optedOutSchool.createdApplications, 0);

const repeatedInterest = createApplicationPrisma({ existingApplication: true });
const existingApplication = await createFinancingApplication(repeatedInterest.prisma, {
  schoolId: 'school-1',
  pupilId: 'pupil-1',
  guardianId: 'guardian-1',
  invoiceId: 'invoice-1',
  institutionId: 'institution-1',
  interestNoticeVersion: 'tuition-financing-interest-v2',
  acknowledgedItems: [...FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS],
});
assert.equal(existingApplication.id, 'existing-application');
assert.equal(repeatedInterest.createdApplications, 0);

const concurrentInterest = createApplicationPrisma({ uniqueConflict: true });
const concurrentApplication = await createFinancingApplication(concurrentInterest.prisma, {
  schoolId: 'school-1',
  pupilId: 'pupil-1',
  guardianId: 'guardian-1',
  invoiceId: 'invoice-1',
  institutionId: 'institution-1',
  interestNoticeVersion: 'tuition-financing-interest-v2',
  acknowledgedItems: [...FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS],
});
assert.equal(concurrentApplication.id, 'parallel-application');
assert.equal(concurrentInterest.createdApplications, 0);

console.log('Financing application persistence tests passed');
