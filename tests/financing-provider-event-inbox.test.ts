import assert from 'node:assert/strict';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  claimFinancingProviderEvent,
  completeFinancingProviderEvent,
  FinancingProviderConfigurationError,
  FinancingProviderEventConflictError,
  receiveFinancingProviderWebhook,
} from '../src/services/financing-provider-event-inbox.js';
import type { FinancingProviderAdapter } from '../src/services/financing-provider-contract.js';

type StoredEvent = Record<string, unknown> & { id: string; payloadHash: string };

function createInMemoryPrisma() {
  const events = new Map<string, StoredEvent>();
  const byId = new Map<string, StoredEvent>();
  const institutions = new Map([
    ['bank-a', { id: 'institution-a', integrationMode: 'API', status: 'ACTIVE' }],
    ['bank-b', { id: 'institution-b', integrationMode: 'API', status: 'ACTIVE' }],
    ['bank-suspended', { id: 'institution-suspended', integrationMode: 'API', status: 'SUSPENDED' }],
  ]);
  const prisma = {
    financingInstitution: {
      findUnique: async ({ where }: { where: { code: string } }) => institutions.get(where.code) ?? null,
    },
    financingProviderEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const key = `${data.institutionId}:${data.externalEventId}`;
        if (events.has(key)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const event = {
          ...data,
          id: `event-${events.size + 1}`,
          status: 'RECEIVED',
          attempts: 0,
          lockExpiresAt: null,
        } as StoredEvent;
        events.set(key, event);
        byId.set(event.id, event);
        return event;
      },
      findUnique: async ({ where }: { where: { institutionId_externalEventId: { institutionId: string; externalEventId: string } } }) => {
        if ('id' in where) return byId.get(where.id) ?? null;
        const { institutionId, externalEventId } = where.institutionId_externalEventId;
        return events.get(`${institutionId}:${externalEventId}`) ?? null;
      },
      updateMany: async ({ where, data }: {
        where: {
          id: string;
          attempts?: number | { lt: number };
          OR?: Array<Record<string, unknown>>;
          status?: string;
          lockExpiresAt?: Date | { equals: Date; gt: Date };
        };
        data: Record<string, unknown>;
      }) => {
        const event = byId.get(where.id);
        if (!event) return { count: 0 };
        if (typeof where.attempts === 'number' && event.attempts !== where.attempts) {
          return { count: 0 };
        }
        if (where.attempts && typeof where.attempts === 'object' &&
            'lt' in where.attempts && Number(event.attempts) >= where.attempts.lt) {
          return { count: 0 };
        }
        if (where.OR) {
          const eligible = where.OR.some((condition) => {
            if (condition.status === 'RECEIVED') return event.status === 'RECEIVED';
            return event.status === 'PROCESSING' &&
              event.lockExpiresAt instanceof Date &&
              condition.lockExpiresAt !== null &&
              typeof condition.lockExpiresAt === 'object' &&
              'lte' in condition.lockExpiresAt &&
              event.lockExpiresAt <= (condition.lockExpiresAt as { lte: Date }).lte;
          });
          if (!eligible) return { count: 0 };
        } else {
          const lockFilter = where.lockExpiresAt;
          const expectedLease = lockFilter instanceof Date ? lockFilter : lockFilter?.equals;
          const activeAfter = lockFilter instanceof Date ? null : lockFilter?.gt;
          if (event.status !== where.status ||
              event.lockExpiresAt?.getTime() !== expectedLease?.getTime() ||
              (activeAfter && event.lockExpiresAt <= activeAfter)) {
            return { count: 0 };
          }
        }

        for (const [key, value] of Object.entries(data)) {
          if (key === 'attempts' && value && typeof value === 'object' && 'increment' in value) {
            event.attempts = Number(event.attempts) + Number((value as { increment: number }).increment);
          } else {
            event[key] = value;
          }
        }
        return { count: 1 };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, events };
}

const event: unknown = {
  eventId: 'external-1',
  applicationReference: 'application-1',
  occurredAt: '2026-11-04T00:00:00Z',
  type: 'APPLICATION_STATUS',
  status: 'UNDER_REVIEW',
  rawKyc: { shouldNotPersist: true },
};

const { prisma, events } = createInMemoryPrisma();
let verifiedCalls = 0;
const bankAAdapter: FinancingProviderAdapter<undefined, 'API'> = {
  institutionCode: 'bank-a',
  mode: 'API',
  async startApplication() {
    return { mode: 'API', applicationReference: 'unused' };
  },
  async verifyAndNormalizeWebhook() {
    verifiedCalls += 1;
    return event;
  },
};
const request = { headers: {}, rawBody: new Uint8Array() };
const first = await receiveFinancingProviderWebhook(prisma, {
  adapter: bankAAdapter,
  request,
});
assert.equal(first.duplicate, false);
assert.equal(events.size, 1);
assert.equal(verifiedCalls, 1);
assert.equal(JSON.stringify(first.event).includes('shouldNotPersist'), false);

const duplicate = await receiveFinancingProviderWebhook(prisma, {
  adapter: bankAAdapter,
  request,
});
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.event.id, first.event.id);
assert.equal(events.size, 1);
assert.equal(verifiedCalls, 2);

await assert.rejects(
  () => receiveFinancingProviderWebhook(prisma, {
    adapter: {
      ...bankAAdapter,
      async verifyAndNormalizeWebhook() {
        return { ...(event as Record<string, unknown>), status: 'REJECTED' };
      },
    },
    request,
  }),
  FinancingProviderEventConflictError,
);
assert.equal(events.size, 1);

const bankBAdapter: FinancingProviderAdapter<undefined, 'API'> = {
  ...bankAAdapter,
  institutionCode: 'bank-b',
};
const anotherInstitution = await receiveFinancingProviderWebhook(prisma, {
  adapter: bankBAdapter,
  request,
});
assert.equal(anotherInstitution.duplicate, false);
assert.equal(events.size, 2);

await assert.rejects(
  () => receiveFinancingProviderWebhook(prisma, {
    adapter: {
      ...bankAAdapter,
      async verifyAndNormalizeWebhook() {
        return {
          ...(event as Record<string, unknown>),
          type: 'DISBURSEMENT_REPORTED',
          amountMinor: -1,
          currency: 'NGN',
          settlementReference: 'ref',
        };
      },
    },
    request,
  }),
  /Financing provider event is invalid: INVALID_DISBURSEMENT_AMOUNT/,
);
assert.equal(events.size, 2);

await assert.rejects(
  () => receiveFinancingProviderWebhook(prisma, {
    adapter: { ...bankAAdapter, institutionCode: 'bank-suspended' },
    request,
  }),
  FinancingProviderConfigurationError,
);
await assert.rejects(
  () => receiveFinancingProviderWebhook(prisma, {
    adapter: {
      ...bankAAdapter,
      async verifyAndNormalizeWebhook() {
        throw new Error('Invalid provider signature.');
      },
    },
    request,
  }),
  /Invalid provider signature/,
);
await assert.rejects(
  () => receiveFinancingProviderWebhook(prisma, {
    adapter: {
      institutionCode: 'bank-a',
      mode: 'MANUAL',
      async startApplication() {
        return { mode: 'MANUAL', applicationReference: 'unused' };
      },
      async verifyAndNormalizeWebhook() {
        return event;
      },
    },
    request,
  }),
  FinancingProviderConfigurationError,
);
assert.equal(events.size, 2);
await assert.rejects(
  () => receiveFinancingProviderWebhook(prisma, {
    adapter: { ...bankAAdapter, institutionCode: 'unknown-bank' },
    request,
  }),
  FinancingProviderConfigurationError,
);
await assert.rejects(
  () => receiveFinancingProviderWebhook(prisma, {
    adapter: {
      institutionCode: 'bank-a',
      mode: 'API',
      async startApplication() {
        return { mode: 'API', applicationReference: 'unused' };
      },
    },
    request,
  }),
  FinancingProviderConfigurationError,
);

const claimTime = new Date('2026-11-04T01:00:00Z');
const claim = await claimFinancingProviderEvent(prisma, {
  eventId: first.event.id,
  now: claimTime,
  leaseMilliseconds: 10_000,
});
assert.ok(claim.status === 'CLAIMED');
assert.equal(claim.event.status, 'PROCESSING');
assert.equal(claim.event.attempts, 1);
assert.deepEqual(await claimFinancingProviderEvent(prisma, {
  eventId: first.event.id,
  now: new Date(claimTime.getTime() + 1_000),
}), { status: 'NOT_CLAIMABLE' });

const expiredLeaseClaim = await claimFinancingProviderEvent(prisma, {
  eventId: first.event.id,
  now: new Date(claimTime.getTime() + 11_000),
});
assert.ok(expiredLeaseClaim.status === 'CLAIMED');
assert.equal(expiredLeaseClaim.event.attempts, 2);
assert.equal(await completeFinancingProviderEvent(prisma, {
  eventId: first.event.id,
  leaseExpiresAt: claim.leaseExpiresAt,
  status: 'PROCESSED',
  now: new Date(claimTime.getTime() + 12_000),
}), false);
assert.equal(await completeFinancingProviderEvent(prisma, {
  eventId: first.event.id,
  leaseExpiresAt: expiredLeaseClaim.leaseExpiresAt,
  status: 'PROCESSED',
  now: new Date(claimTime.getTime() + 13_000),
}), true);
assert.equal(await completeFinancingProviderEvent(prisma, {
  eventId: first.event.id,
  leaseExpiresAt: expiredLeaseClaim.leaseExpiresAt,
  status: 'PROCESSED',
  now: new Date(claimTime.getTime() + 14_000),
}), false);

const bankBEvent = [...events.values()].find((stored) => stored.institutionId === 'institution-b');
assert.ok(bankBEvent);
const shortLease = await claimFinancingProviderEvent(prisma, {
  eventId: bankBEvent.id,
  now: claimTime,
  leaseMilliseconds: 1_000,
});
assert.ok(shortLease.status === 'CLAIMED');
assert.equal(await completeFinancingProviderEvent(prisma, {
  eventId: bankBEvent.id,
  leaseExpiresAt: shortLease.leaseExpiresAt,
  status: 'PROCESSED',
  now: new Date(shortLease.leaseExpiresAt.getTime() + 1),
}), false);

bankBEvent.status = 'PROCESSING';
bankBEvent.attempts = 2;
bankBEvent.lockExpiresAt = new Date(claimTime.getTime() - 1);
assert.deepEqual(await claimFinancingProviderEvent(prisma, {
  eventId: bankBEvent.id,
  maxAttempts: 2,
  now: claimTime,
}), { status: 'FAILED', reason: 'MAX_ATTEMPTS_EXCEEDED' });
assert.equal(bankBEvent.status, 'FAILED');
assert.equal(bankBEvent.lockExpiresAt, null);
assert.equal(bankBEvent.lastErrorCode, 'MAX_ATTEMPTS_EXCEEDED');

await assert.rejects(() => claimFinancingProviderEvent(prisma, {
  eventId: bankBEvent.id,
  maxAttempts: 0,
  now: claimTime,
}), /maximum attempts must be between 1 and 100/);

console.log('Financing provider event inbox tests passed');
