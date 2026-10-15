import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { DeliveryTask } from '../../communications/index.js';
import { AdmissionDeliveryRetryStore } from '../admission-delivery-retry-store.js';

function makeTask(overrides: Partial<DeliveryTask> = {}): DeliveryTask {
  return {
    id: 'retry-1',
    request: {
      event: 'AdmissionCreated',
      schoolId: 'school-1',
      metadata: { admissionApplicationId: 'application-1', audience: 'APPLICANT' },
    },
    recipient: { channel: 'EMAIL', address: 'applicant@example.com', name: 'Applicant' },
    content: { subject: 'Application received', body: 'Safe message content' },
    attempts: 1,
    lastError: 'temporary provider failure',
    nextAttemptAt: Date.now() + 30_000,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test('durable admission retry store persists a bounded retry record', async () => {
  let saved: any = null;
  const prisma = {
    admissionDeliveryRetry: {
      upsert: async (args: any) => { saved = args; return args.create; },
    },
  } as unknown as PrismaClient;
  const store = new AdmissionDeliveryRetryStore(prisma);

  await store.save(makeTask());

  assert.equal(saved.where.id, 'retry-1');
  assert.equal(saved.create.admissionApplicationId, 'application-1');
  assert.equal(saved.create.schoolId, 'school-1');
  assert.equal(saved.create.audience, 'APPLICANT');
  assert.equal(saved.create.status, 'QUEUED');
  assert.equal(saved.create.attempts, 1);
  assert.equal(saved.create.recipient.address, 'applicant@example.com');
  assert.ok(saved.create.expiresAt.getTime() > Date.now());
});

test('durable retry store does not persist unrelated or WhatsApp deliveries', async () => {
  let writes = 0;
  const prisma = {
    admissionDeliveryRetry: { upsert: async () => { writes += 1; } },
  } as unknown as PrismaClient;
  const store = new AdmissionDeliveryRetryStore(prisma);

  await store.save(makeTask({ request: { event: 'AnnouncementCreated', schoolId: 'school-1' } }));
  await store.save(makeTask({ recipient: { channel: 'WHATSAPP', address: '+2348000000000' } }));

  assert.equal(writes, 0);
});

test('durable retry store restores pending payloads and deletes expired rows', async () => {
  const task = makeTask();
  const calls: string[] = [];
  const prisma = {
    admissionDeliveryRetry: {
      deleteMany: async () => { calls.push('delete-expired'); return { count: 0 }; },
      updateMany: async () => { calls.push('release-expired-leases'); return { count: 0 }; },
      findMany: async () => [{ task }],
    },
  } as unknown as PrismaClient;
  const store = new AdmissionDeliveryRetryStore(prisma);

  const restored = await store.loadPending();

  assert.deepEqual(restored, [task]);
  assert.deepEqual(calls, ['delete-expired', 'release-expired-leases']);
});

test('durable retry store claims jobs with a lease and removes completed jobs', async () => {
  const calls: any[] = [];
  const prisma = {
    admissionDeliveryRetry: {
      updateMany: async (args: any) => { calls.push(['claim', args]); return { count: 1 }; },
      deleteMany: async (args: any) => { calls.push(['complete', args]); return { count: 1 }; },
    },
  } as unknown as PrismaClient;
  const store = new AdmissionDeliveryRetryStore(prisma);
  const now = new Date();
  const lease = new Date(now.getTime() + 120_000);

  assert.equal(await store.claim('retry-1', now, lease), true);
  await store.complete('retry-1');

  assert.equal(calls[0][0], 'claim');
  assert.equal(calls[0][1].data.status, 'PROCESSING');
  assert.equal(calls[0][1].data.lockExpiresAt, lease);
  assert.deepEqual(calls[1], ['complete', { where: { id: 'retry-1' } }]);
});
