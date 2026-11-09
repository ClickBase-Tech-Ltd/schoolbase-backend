import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  type FinancingProviderAdapter,
  type FinancingProviderWebhookRequest,
  parseNormalizedFinancingProviderEvent,
  type NormalizedFinancingProviderEvent,
} from './financing-provider-contract.js';

export class FinancingProviderEventConflictError extends Error {
  constructor(
    public readonly institutionId: string,
    public readonly externalEventId: string,
  ) {
    super('A provider event ID was received again with different normalized content.');
    this.name = 'FinancingProviderEventConflictError';
  }
}

export class FinancingProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinancingProviderConfigurationError';
  }
}

export async function receiveFinancingProviderWebhook<
  TSubmissionPayload,
  TMode extends 'HOSTED' | 'API' | 'MANUAL',
>(
  prisma: PrismaClient,
  input: {
    adapter: FinancingProviderAdapter<TSubmissionPayload, TMode>;
    request: FinancingProviderWebhookRequest;
  },
): Promise<{ event: Awaited<ReturnType<PrismaClient['financingProviderEvent']['create']>>; duplicate: boolean }> {
  if (!input.adapter.verifyAndNormalizeWebhook) {
    throw new FinancingProviderConfigurationError('The provider adapter does not implement webhook verification.');
  }

  const providerEvent = await input.adapter.verifyAndNormalizeWebhook(input.request);
  const normalizedEvent = parseNormalizedFinancingProviderEvent(providerEvent);
  const institution = await prisma.financingInstitution.findUnique({
    where: { code: input.adapter.institutionCode },
    select: { id: true, integrationMode: true, status: true },
  });
  if (!institution) {
    throw new FinancingProviderConfigurationError('The financing institution is not configured.');
  }
  if (institution.status !== 'ACTIVE') {
    throw new FinancingProviderConfigurationError('The financing institution is suspended.');
  }
  if (institution.integrationMode !== input.adapter.mode) {
    throw new FinancingProviderConfigurationError('The provider adapter mode does not match the institution configuration.');
  }

  return persistNormalizedEvent(prisma, institution.id, normalizedEvent);
}

async function persistNormalizedEvent(
  prisma: PrismaClient,
  institutionId: string,
  inputEvent: NormalizedFinancingProviderEvent,
): Promise<{ event: Awaited<ReturnType<PrismaClient['financingProviderEvent']['create']>>; duplicate: boolean }> {
  const normalizedEvent = inputEvent;
  const payloadHash = hashNormalizedEvent(normalizedEvent);
  const data = {
    institutionId,
    externalEventId: normalizedEvent.eventId,
    eventType: normalizedEvent.type,
    applicationReference: normalizedEvent.applicationReference,
    occurredAt: new Date(normalizedEvent.occurredAt),
    payloadHash,
    normalizedPayload: JSON.parse(JSON.stringify(normalizedEvent)),
  };

  try {
    const event = await prisma.financingProviderEvent.create({ data });
    return { event, duplicate: false };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }

    const existing = await prisma.financingProviderEvent.findUnique({
      where: {
        institutionId_externalEventId: {
          institutionId,
          externalEventId: normalizedEvent.eventId,
        },
      },
    });
    if (!existing) throw error;
    if (existing.payloadHash !== payloadHash) {
      throw new FinancingProviderEventConflictError(institutionId, normalizedEvent.eventId);
    }
    return { event: existing, duplicate: true };
  }
}

export type FinancingProviderEventCompletionStatus = 'PROCESSED' | 'REVIEW_REQUIRED' | 'FAILED';

export type FinancingProviderEventClaimResult =
  | {
      status: 'CLAIMED';
      event: NonNullable<Awaited<ReturnType<PrismaClient['financingProviderEvent']['findUnique']>>>;
      leaseExpiresAt: Date;
    }
  | { status: 'NOT_CLAIMABLE' }
  | { status: 'FAILED'; reason: 'MAX_ATTEMPTS_EXCEEDED' };

function hashNormalizedEvent(event: NormalizedFinancingProviderEvent): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

export async function claimFinancingProviderEvent(
  prisma: PrismaClient,
  input: {
    eventId: string;
    leaseMilliseconds?: number;
    maxAttempts?: number;
    now?: Date;
  },
): Promise<FinancingProviderEventClaimResult> {
  const eventId = input.eventId.trim();
  const leaseMilliseconds = input.leaseMilliseconds ?? 30_000;
  const maxAttempts = input.maxAttempts ?? 10;
  const now = input.now ?? new Date();
  if (!eventId) throw new Error('A financing provider event ID is required.');
  if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1_000 || leaseMilliseconds > 300_000) {
    throw new Error('Event processing lease must be between 1 second and 5 minutes.');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error('Event processing maximum attempts must be between 1 and 100.');
  }
  if (Number.isNaN(now.getTime())) throw new Error('A valid event claim time is required.');
  const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);
  const existing = await prisma.financingProviderEvent.findUnique({ where: { id: eventId } });
  if (!existing) return { status: 'NOT_CLAIMABLE' };

  const claimableStates = [
    { status: 'RECEIVED' as const },
    { status: 'PROCESSING' as const, lockExpiresAt: { lte: now } },
  ];

  if (existing.attempts >= maxAttempts) {
    const failed = await prisma.financingProviderEvent.updateMany({
      where: {
        id: eventId,
        attempts: existing.attempts,
        OR: claimableStates,
      },
      data: {
        status: 'FAILED',
        lockExpiresAt: null,
        lastErrorCode: 'MAX_ATTEMPTS_EXCEEDED',
      },
    });
    return failed.count === 1
      ? { status: 'FAILED', reason: 'MAX_ATTEMPTS_EXCEEDED' }
      : { status: 'NOT_CLAIMABLE' };
  }

  const claimed = await prisma.financingProviderEvent.updateMany({
    where: {
      id: eventId,
      attempts: { lt: maxAttempts },
      OR: claimableStates,
    },
    data: {
      status: 'PROCESSING',
      attempts: { increment: 1 },
      lockExpiresAt: leaseExpiresAt,
      lastErrorCode: null,
    },
  });
  if (claimed.count !== 1) return { status: 'NOT_CLAIMABLE' };

  const claimedEvent = await prisma.financingProviderEvent.findUnique({ where: { id: eventId } });
  if (!claimedEvent) throw new Error('Claimed financing provider event could not be loaded.');
  return { status: 'CLAIMED', event: claimedEvent, leaseExpiresAt };
}

export async function completeFinancingProviderEvent(
  prisma: PrismaClient,
  input: {
    eventId: string;
    leaseExpiresAt: Date;
    status: FinancingProviderEventCompletionStatus;
    errorCode?: string;
    now?: Date;
  },
): Promise<boolean> {
  const eventId = input.eventId.trim();
  if (!eventId) throw new Error('A financing provider event ID is required.');
  if (Number.isNaN(input.leaseExpiresAt.getTime())) throw new Error('A valid event lease expiry is required.');
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('A valid event completion time is required.');

  const errorCode = input.errorCode?.trim();
  if (input.status === 'PROCESSED' && errorCode) {
    throw new Error('Processed provider events cannot include an error code.');
  }
  if (input.status !== 'PROCESSED' && (!errorCode || errorCode.length > 80)) {
    throw new Error('A bounded error code is required for review or failed events.');
  }

  const result = await prisma.financingProviderEvent.updateMany({
    where: {
      id: eventId,
      status: 'PROCESSING',
      lockExpiresAt: { equals: input.leaseExpiresAt, gt: now },
    },
    data: {
      status: input.status,
      lockExpiresAt: null,
      processedAt: input.status === 'PROCESSED' ? now : null,
      lastErrorCode: input.status === 'PROCESSED' ? null : errorCode,
    },
  });
  return result.count === 1;
}
