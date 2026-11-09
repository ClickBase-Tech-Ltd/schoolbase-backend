import { createHash } from 'node:crypto';
import {
  type FinancingApplicationStatus,
  type Prisma,
  type PrismaClient,
  PaymentMethod,
} from '@prisma/client';
import {
  InvalidFinancingApplicationTransitionError,
  transitionFinancingApplication,
} from './financing-application-lifecycle.js';
import {
  parseNormalizedFinancingProviderEvent,
  FinancingProviderEventValidationError,
  type NormalizedFinancingProviderEvent,
} from './financing-provider-contract.js';
import { planFinancingProviderEvent } from './financing-provider-event-planner.js';
import { isTuitionFinancingEnabled } from './tuition-financing-feature-gate.js';

export const FINANCING_INTEREST_NOTICE_VERSION = 'tuition-financing-interest-v2';
export const FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS = [
  'school_only_recording',
  'no_lender_application_or_data_sharing',
  'invoice_payment_obligations_unchanged',
] as const;
export type FinancingInterestAcknowledgementKey = typeof FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS[number];

export function isFinancingInterestAcknowledgementList(
  value: unknown,
): value is FinancingInterestAcknowledgementKey[] {
  if (!Array.isArray(value) || value.length !== FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS.length) return false;
  return FINANCING_INTEREST_ACKNOWLEDGEMENT_KEYS.every((key) => value.includes(key));
}

export class FinancingFeatureDisabledError extends Error {
  constructor() {
    super('Tuition financing is not available.');
    this.name = 'FinancingFeatureDisabledError';
  }
}

export class InvalidFinancingApplicationScopeError extends Error {
  constructor() {
    super('The pupil, guardian, invoice, and institution must belong to the same eligible financing scope.');
    this.name = 'InvalidFinancingApplicationScopeError';
  }
}

export async function createFinancingApplication(
  prisma: PrismaClient,
  input: {
    schoolId: string;
    pupilId: string;
    guardianId: string;
    invoiceId: string;
    institutionId?: string;
    productId?: string;
    interestNoticeVersion: string;
    acknowledgedItems: FinancingInterestAcknowledgementKey[];
  },
) {
  if (!(await isTuitionFinancingEnabled(prisma))) {
    throw new FinancingFeatureDisabledError();
  }
  if (input.interestNoticeVersion !== FINANCING_INTEREST_NOTICE_VERSION) {
    throw new Error('A current tuition-financing interest notice acknowledgement is required.');
  }
  if (!isFinancingInterestAcknowledgementList(input.acknowledgedItems)) {
    throw new Error('All current tuition-financing acknowledgements are required.');
  }

  const interestKey = createHash('sha256')
    .update(JSON.stringify([
      input.schoolId,
      input.pupilId,
      input.guardianId,
      input.invoiceId,
      input.institutionId ?? null,
      input.productId ?? null,
    ]))
    .digest('hex');

  try {
    return await prisma.$transaction(async (transaction) => {
      const [school, pupil, guardian, guardianPupil, invoice, institution, product] = await Promise.all([
        transaction.school.findFirst({
          where: {
            id: input.schoolId,
            tuitionFinancingParticipationEnabled: true,
          },
          select: { id: true, currency: true },
        }),
        transaction.pupil.findFirst({
          where: { id: input.pupilId, schoolId: input.schoolId, isActive: true },
          select: { id: true },
        }),
        transaction.guardian.findFirst({
          where: { id: input.guardianId, schoolId: input.schoolId },
          select: { id: true },
        }),
        transaction.guardianPupil.findUnique({
          where: { guardianId_pupilId: { guardianId: input.guardianId, pupilId: input.pupilId } },
          select: { guardianId: true },
        }),
        transaction.invoice.findFirst({
          where: {
            id: input.invoiceId,
            schoolId: input.schoolId,
            pupilId: input.pupilId,
            status: { in: ['SENT', 'PART_PAID', 'OVERDUE'] },
            voidedAt: null,
          },
          select: { id: true, amountDue: true, amountPaid: true },
        }),
        input.institutionId
          ? transaction.financingInstitution.findFirst({
            where: { id: input.institutionId, status: 'ACTIVE' },
            select: { id: true },
          })
          : Promise.resolve({ id: null }),
        input.productId
          ? transaction.financingProduct.findFirst({
            where: {
              id: input.productId,
              status: 'ACTIVE',
              effectiveAt: { lte: new Date() },
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
              institution: {
                status: 'ACTIVE',
                ...(process.env.NODE_ENV === 'production' ? { isDemo: false } : {}),
              },
              schools: { some: { schoolId: input.schoolId } },
            },
            select: { id: true, institutionId: true, currency: true },
          })
          : Promise.resolve(null),
      ]);

      if (!school || !pupil || !guardian || !guardianPupil || !invoice ||
          (input.institutionId && (!institution || !institution.id)) ||
          (input.productId && (!product || product.currency !== school.currency ||
            (input.institutionId && input.institutionId !== product.institutionId))) ||
          invoice.amountDue <= invoice.amountPaid) {
        throw new InvalidFinancingApplicationScopeError();
      }

      const existingApplication = await transaction.financingApplication.findUnique({
        where: { interestKey },
      });
      if (existingApplication) return existingApplication;

      return transaction.financingApplication.create({
        data: {
          schoolId: input.schoolId,
          pupilId: input.pupilId,
          guardianId: input.guardianId,
          invoiceId: input.invoiceId,
          ...(input.institutionId || product?.institutionId
            ? { institutionId: input.institutionId ?? product?.institutionId }
            : {}),
          ...(product ? { productId: product.id } : {}),
          interestKey,
          events: {
            create: {
              schoolId: input.schoolId,
              actorType: 'PARENT',
              actorId: input.guardianId,
              eventType: 'PARENT_INTEREST_RECORDED',
              toStatus: 'DRAFT',
              metadata: {
                noticeVersion: input.interestNoticeVersion,
                acknowledgedItems: input.acknowledgedItems,
                ...(product ? { productId: product.id } : {}),
              },
            },
          },
        },
      });
    });
  } catch (error) {
    const isUniqueConflict = error !== null && typeof error === 'object' &&
      'code' in error && error.code === 'P2002';
    if (!isUniqueConflict) throw error;

    const existingApplication = await prisma.financingApplication.findUnique({
      where: { interestKey },
    });
    if (existingApplication) return existingApplication;
    throw error;
  }
}

export const manualFinancingStatusSources = [
  'BANK_PORTAL',
  'BANK_SECURE_MESSAGE',
  'BANK_DOCUMENT',
  'BANK_PHONE',
  'DEMO_SIMULATION',
] as const;
export type ManualFinancingStatusSource = typeof manualFinancingStatusSources[number];

export class InvalidManualFinancingUpdateError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'NOT_MANUAL' | 'INVALID_TRANSITION' | 'CONCURRENT_CHANGE' | 'INVALID_SOURCE',
  ) {
    super(`Manual financing status update is not valid: ${code}.`);
    this.name = 'InvalidManualFinancingUpdateError';
  }
}

export async function updateManualFinancingApplicationStatus(
  prisma: PrismaClient,
  input: {
    applicationId: string;
    schoolId: string;
    actorId: string;
    status: FinancingApplicationStatus;
    source: ManualFinancingStatusSource;
    sourceReference?: string;
  },
) {
  if (!(await isTuitionFinancingEnabled(prisma))) {
    throw new FinancingFeatureDisabledError();
  }
  if (!input.applicationId.trim() || !input.schoolId.trim() || !input.actorId.trim()) {
    throw new Error('A financing application, school, and authenticated actor are required.');
  }
  if (!manualFinancingStatusSources.includes(input.source) ||
      (input.source === 'DEMO_SIMULATION' && process.env.NODE_ENV === 'production')) {
    throw new InvalidManualFinancingUpdateError('INVALID_SOURCE');
  }
  if (input.status === 'CONSENTED') {
    throw new InvalidManualFinancingUpdateError('INVALID_TRANSITION');
  }
  const sourceReference = input.sourceReference?.trim() || null;
  if (sourceReference && sourceReference.length > 191) {
    throw new Error('The bank reference must be 191 characters or fewer.');
  }

  return prisma.$transaction(async (transaction) => {
    const application = await transaction.financingApplication.findFirst({
      where: { id: input.applicationId, schoolId: input.schoolId },
      select: {
        id: true,
        schoolId: true,
        status: true,
        institution: { select: { integrationMode: true, isDemo: true } },
        product: { select: { applicationMode: true } },
      },
    });
    if (!application) throw new InvalidManualFinancingUpdateError('NOT_FOUND');
    if (!application.institution || !application.product ||
        application.institution.integrationMode !== 'MANUAL' ||
        application.product.applicationMode !== 'SCHOOL_CONTACT' ||
        application.institution.isDemo !== (input.source === 'DEMO_SIMULATION') ||
        (application.institution.isDemo && process.env.NODE_ENV === 'production')) {
      throw new InvalidManualFinancingUpdateError('NOT_MANUAL');
    }

    let nextStatus: FinancingApplicationStatus;
    try {
      nextStatus = transitionFinancingApplication(application.status, input.status);
    } catch (error) {
      if (error instanceof InvalidFinancingApplicationTransitionError) {
        throw new InvalidManualFinancingUpdateError('INVALID_TRANSITION');
      }
      throw error;
    }

    const updated = await transaction.financingApplication.updateMany({
      where: { id: application.id, schoolId: input.schoolId, status: application.status },
      data: { status: nextStatus },
    });
    if (updated.count !== 1) throw new InvalidManualFinancingUpdateError('CONCURRENT_CHANGE');

    await transaction.financingApplicationEvent.create({
      data: {
        schoolId: application.schoolId,
        applicationId: application.id,
        actorId: input.actorId,
        actorType: 'SCHOOL',
        eventType: input.source === 'DEMO_SIMULATION'
          ? 'DEMO_STATUS_SIMULATED'
          : 'MANUAL_BANK_STATUS_RECORDED',
        fromStatus: application.status,
        toStatus: nextStatus,
        metadata: {
          source: input.source,
          ...(sourceReference ? { sourceReference } : {}),
          simulated: input.source === 'DEMO_SIMULATION',
        },
      },
    });

    return { id: application.id, status: nextStatus };
  });
}

export class InvalidManualFinancingSettlementError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'NOT_ELIGIBLE' | 'PAYMENT_NOT_FOUND' | 'PAYMENT_ALREADY_LINKED' | 'SIMULATION_ALREADY_RECORDED',
  ) {
    super(`Manual financing settlement could not be reconciled: ${code}.`);
    this.name = 'InvalidManualFinancingSettlementError';
  }
}

export async function simulateDemoFinancingFunding(
  prisma: PrismaClient,
  input: { applicationId: string; schoolId: string; actorId: string },
) {
  if (!(await isTuitionFinancingEnabled(prisma))) {
    throw new FinancingFeatureDisabledError();
  }
  if (process.env.NODE_ENV === 'production') {
    throw new InvalidManualFinancingSettlementError('NOT_ELIGIBLE');
  }

  const demoActionKey = createHash('sha256')
    .update(`${input.applicationId}:DEMO_FUNDING_SIMULATED`)
    .digest('hex');
  try {
    return await prisma.$transaction(async (transaction) => {
    const application = await transaction.financingApplication.findFirst({
      where: { id: input.applicationId, schoolId: input.schoolId },
      select: {
        id: true,
        schoolId: true,
        status: true,
        institution: { select: { integrationMode: true, isDemo: true } },
        product: { select: { applicationMode: true } },
        events: {
          where: { eventType: 'DEMO_FUNDING_SIMULATED' },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!application) throw new InvalidManualFinancingSettlementError('NOT_FOUND');
    if (application.status !== 'OFFER_ACCEPTED' ||
        application.institution?.integrationMode !== 'MANUAL' ||
        !application.institution.isDemo ||
        application.product?.applicationMode !== 'SCHOOL_CONTACT') {
      throw new InvalidManualFinancingSettlementError('NOT_ELIGIBLE');
    }
    if (application.events.length > 0) {
      throw new InvalidManualFinancingSettlementError('SIMULATION_ALREADY_RECORDED');
    }
    await transaction.financingApplicationEvent.create({
      data: {
        schoolId: application.schoolId,
        applicationId: application.id,
        actorId: input.actorId,
        demoActionKey,
        actorType: 'SCHOOL',
        eventType: 'DEMO_FUNDING_SIMULATED',
        fromStatus: application.status,
        toStatus: application.status,
        metadata: { simulated: true, paymentPosted: false },
      },
    });
    return { applicationId: application.id, simulated: true, paymentPosted: false };
    });
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      throw new InvalidManualFinancingSettlementError('SIMULATION_ALREADY_RECORDED');
    }
    throw error;
  }
}

export async function linkManualFinancingPayment(
  prisma: PrismaClient,
  input: {
    applicationId: string;
    schoolId: string;
    actorId: string;
    paymentId: string;
    bankReference: string;
  },
) {
  if (!(await isTuitionFinancingEnabled(prisma))) {
    throw new FinancingFeatureDisabledError();
  }
  const bankReference = input.bankReference.trim();
  if (!input.applicationId.trim() || !input.schoolId.trim() || !input.actorId.trim() ||
      !input.paymentId.trim() || !bankReference || bankReference.length > 191) {
    throw new Error('An application, payment, actor, and matching bank reference are required.');
  }

  return prisma.$transaction(async (transaction) => {
    const application = await transaction.financingApplication.findFirst({
      where: { id: input.applicationId, schoolId: input.schoolId },
      select: {
        id: true,
        schoolId: true,
        invoiceId: true,
        status: true,
        institution: { select: { integrationMode: true, isDemo: true } },
        product: { select: { applicationMode: true } },
      },
    });
    if (!application) throw new InvalidManualFinancingSettlementError('NOT_FOUND');
    if (application.status !== 'OFFER_ACCEPTED' ||
        application.institution?.integrationMode !== 'MANUAL' ||
        application.institution.isDemo ||
        application.product?.applicationMode !== 'SCHOOL_CONTACT') {
      throw new InvalidManualFinancingSettlementError('NOT_ELIGIBLE');
    }
    const acceptedApplication = await transaction.financingApplication.updateMany({
      where: { id: application.id, schoolId: input.schoolId, status: 'OFFER_ACCEPTED' },
      data: { updatedAt: new Date() },
    });
    if (acceptedApplication.count !== 1) {
      throw new InvalidManualFinancingSettlementError('NOT_ELIGIBLE');
    }

    const payment = await transaction.payment.findFirst({
      where: {
        id: input.paymentId,
        invoiceId: application.invoiceId,
        method: PaymentMethod.BANK_TRANSFER,
        reference: bankReference,
        invoice: { schoolId: input.schoolId },
      },
      select: {
        id: true,
        amount: true,
        reference: true,
        paidAt: true,
        financingApplicationPayment: { select: { id: true } },
      },
    });
    if (!payment || !payment.reference || payment.amount <= 0) {
      throw new InvalidManualFinancingSettlementError('PAYMENT_NOT_FOUND');
    }
    if (payment.financingApplicationPayment) {
      throw new InvalidManualFinancingSettlementError('PAYMENT_ALREADY_LINKED');
    }

    const linkedPayment = await transaction.financingApplicationPayment.create({
      data: {
        applicationId: application.id,
        paymentId: payment.id,
        bankReference,
        recordedBy: input.actorId,
      },
      select: {
        id: true,
        paymentId: true,
        bankReference: true,
        recordedAt: true,
      },
    });
    await transaction.financingApplicationEvent.create({
      data: {
        schoolId: application.schoolId,
        applicationId: application.id,
        actorId: input.actorId,
        actorType: 'SCHOOL',
        eventType: 'MANUAL_SETTLEMENT_RECONCILED',
        fromStatus: application.status,
        toStatus: application.status,
        metadata: { paymentId: payment.id, bankReference },
      },
    });

    return {
      ...linkedPayment,
      amount: payment.amount,
      paidAt: payment.paidAt,
    };
  });
}

export type FinancingProviderEventProcessingResult =
  | { status: 'PROCESSED'; applicationId: string; action: string }
  | { status: 'REVIEW_REQUIRED'; reason: string; applicationId?: string }
  | { status: 'LEASE_LOST' };

class FinancingEventLeaseLostError extends Error {}

export async function processClaimedFinancingProviderEvent(
  prisma: PrismaClient,
  input: {
    eventId: string;
    leaseExpiresAt: Date;
    now?: Date;
  },
): Promise<FinancingProviderEventProcessingResult> {
  const eventId = input.eventId.trim();
  const now = input.now ?? new Date();
  if (!eventId || Number.isNaN(now.getTime()) || Number.isNaN(input.leaseExpiresAt.getTime())) {
    throw new Error('A provider event ID, processing time, and valid lease expiry are required.');
  }

  try {
    return await prisma.$transaction(async (transaction) => {
      const event = await transaction.financingProviderEvent.findUnique({
        where: { id: eventId },
      });
      if (!event || event.status !== 'PROCESSING' || !event.lockExpiresAt ||
          event.lockExpiresAt.getTime() !== input.leaseExpiresAt.getTime() ||
          event.lockExpiresAt.getTime() <= now.getTime()) {
        return { status: 'LEASE_LOST' };
      }

      let normalizedEvent: NormalizedFinancingProviderEvent;
      try {
        normalizedEvent = parseNormalizedFinancingProviderEvent(event.normalizedPayload);
      } catch (error) {
        if (!(error instanceof FinancingProviderEventValidationError)) throw error;
        await updateProviderEventStatus(transaction, eventId, input.leaseExpiresAt, now, 'REVIEW_REQUIRED', error.code);
        return { status: 'REVIEW_REQUIRED', reason: error.code };
      }
      if (event.externalEventId !== normalizedEvent.eventId ||
          event.eventType !== normalizedEvent.type ||
          event.applicationReference !== normalizedEvent.applicationReference ||
          event.occurredAt.getTime() !== new Date(normalizedEvent.occurredAt).getTime()) {
        await updateProviderEventStatus(
          transaction,
          eventId,
          input.leaseExpiresAt,
          now,
          'REVIEW_REQUIRED',
          'STORED_EVENT_MISMATCH',
        );
        return { status: 'REVIEW_REQUIRED', reason: 'STORED_EVENT_MISMATCH' };
      }

      const application = await transaction.financingApplication.findFirst({
        where: {
          institutionId: event.institutionId,
          externalApplicationReference: normalizedEvent.applicationReference,
        },
      });
      if (!application) {
        await updateProviderEventStatus(
          transaction,
          eventId,
          input.leaseExpiresAt,
          now,
          'REVIEW_REQUIRED',
          'UNMATCHED_APPLICATION',
        );
        return { status: 'REVIEW_REQUIRED', reason: 'UNMATCHED_APPLICATION' };
      }

      let plan;
      try {
        plan = planFinancingProviderEvent(application.status, normalizedEvent);
      } catch (error) {
        if (!(error instanceof InvalidFinancingApplicationTransitionError)) throw error;
        await updateProviderEventStatus(
          transaction,
          eventId,
          input.leaseExpiresAt,
          now,
          'REVIEW_REQUIRED',
          'OUT_OF_ORDER_PROVIDER_EVENT',
        );
        return {
          status: 'REVIEW_REQUIRED',
          reason: 'OUT_OF_ORDER_PROVIDER_EVENT',
          applicationId: application.id,
        };
      }

      if (plan.action === 'DISBURSEMENT_PENDING_RECONCILIATION' ||
          plan.action === 'DISBURSEMENT_REQUIRES_REVIEW') {
        const reason = plan.action === 'DISBURSEMENT_PENDING_RECONCILIATION'
          ? 'DISBURSEMENT_PENDING_RECONCILIATION'
          : plan.reason;
        await transaction.financingApplicationEvent.create({
          data: {
            schoolId: application.schoolId,
            applicationId: application.id,
            providerEventId: event.id,
            actorType: 'LENDER',
            eventType: 'DISBURSEMENT_REPORTED',
            fromStatus: application.status,
            toStatus: application.status,
            metadata: {
              amountMinor: plan.amountMinor,
              currency: plan.currency,
              settlementReference: plan.settlementReference,
            },
          },
        });
        await updateProviderEventStatus(
          transaction,
          eventId,
          input.leaseExpiresAt,
          now,
          'REVIEW_REQUIRED',
          reason,
        );
        return { status: 'REVIEW_REQUIRED', reason, applicationId: application.id };
      }

      const nextStatus: FinancingApplicationStatus =
        plan.action === 'APPLICATION_STATUS_CHANGED' || plan.action === 'OFFER_RECORDED'
          ? plan.nextStatus
          : plan.currentStatus;
      const eventType = plan.action === 'OFFER_RECORDED'
        ? 'PROVIDER_OFFER_REPORTED'
        : plan.action === 'APPLICATION_STATUS_UNCHANGED'
          ? 'PROVIDER_STATUS_CONFIRMED'
          : 'PROVIDER_STATUS_CHANGED';
      const metadata = plan.action === 'OFFER_RECORDED'
        ? { offerReference: plan.offerReference }
        : { providerEventType: normalizedEvent.type };

      if (nextStatus !== application.status) {
        const updated = await transaction.financingApplication.updateMany({
          where: { id: application.id, status: application.status },
          data: { status: nextStatus },
        });
        if (updated.count !== 1) throw new Error('Financing application changed during provider event processing.');
      }

      await transaction.financingApplicationEvent.create({
        data: {
          schoolId: application.schoolId,
          applicationId: application.id,
          providerEventId: event.id,
          actorType: 'LENDER',
          eventType,
          fromStatus: application.status,
          toStatus: nextStatus,
          metadata,
        },
      });
      await updateProviderEventStatus(
        transaction,
        eventId,
        input.leaseExpiresAt,
        now,
        'PROCESSED',
      );
      return { status: 'PROCESSED', applicationId: application.id, action: eventType };
    });
  } catch (error) {
    if (error instanceof FinancingEventLeaseLostError) return { status: 'LEASE_LOST' };
    throw error;
  }
}

async function updateProviderEventStatus(
  transaction: Prisma.TransactionClient,
  eventId: string,
  leaseExpiresAt: Date,
  now: Date,
  status: 'PROCESSED' | 'REVIEW_REQUIRED',
  errorCode?: string,
): Promise<void> {
  const updated = await transaction.financingProviderEvent.updateMany({
    where: {
      id: eventId,
      status: 'PROCESSING',
      lockExpiresAt: { equals: leaseExpiresAt, gt: now },
    },
    data: {
      status,
      lockExpiresAt: null,
      processedAt: status === 'PROCESSED' ? now : null,
      lastErrorCode: errorCode ?? null,
    },
  });
  if (updated.count !== 1) throw new FinancingEventLeaseLostError();
}
