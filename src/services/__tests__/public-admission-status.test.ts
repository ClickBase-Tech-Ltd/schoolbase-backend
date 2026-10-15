import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getPublicAdmissionStatus, submitPublicAdmissionReply } from '../public-admission-status.js';

const now = new Date('2026-10-15T12:00:00.000Z');
const token = 'a'.repeat(48);
const application = {
  id: 'application-1',
  schoolId: 'school-1',
  applicationNumber: 'ADM-2026-0001',
  status: 'NEEDS_INFORMATION',
  createdAt: now,
};

function makePrisma(overrides: Record<string, any> = {}) {
  const calls: Record<string, any> = {};
  const client: any = {
    school: {
      findUnique: async (args: unknown) => {
        calls.schoolLookup = args;
        return { id: 'school-1' };
      },
    },
    admissionApplication: {
      findFirst: async (args: unknown) => {
        calls.applicationLookup = args;
        return application;
      },
    },
    admissionApplicationEvent: {
      findMany: async (args: unknown) => {
        calls.eventLookup = args;
        return [{ type: 'MORE_INFORMATION_REQUESTED', reason: 'Please provide proof of address.', createdAt: now }];
      },
    },
    $transaction: async (callback: (transaction: any) => Promise<unknown>) => callback({
      admissionApplication: {
        updateMany: async (args: unknown) => {
          calls.applicationUpdate = args;
          return { count: 1 };
        },
      },
      admissionApplicationEvent: {
        create: async (args: unknown) => {
          calls.eventCreate = args;
          return { id: 'event-1', type: 'APPLICANT_REPLY', reason: 'Attached proof of address.', createdAt: now };
        },
      },
      user: {
        findMany: async (args: unknown) => {
          calls.adminLookup = args;
          return [{ id: 'admin-1' }];
        },
      },
      schoolAdminNotification: {
        createMany: async (args: unknown) => {
          calls.notificationCreate = args;
        },
      },
    }),
    ...overrides,
  };

  return { client, calls };
}

test('public status lookup hashes the token and scopes application and events to its school', async () => {
  const { client, calls } = makePrisma();

  const result = await getPublicAdmissionStatus(client, 'greenfield', token, now);

  assert.equal((calls.schoolLookup as any).where.slug, 'greenfield');
  assert.deepEqual((calls.applicationLookup as any).where, {
    schoolId: 'school-1',
    publicStatusTokenHash: createHash('sha256').update(token).digest('hex'),
    publicStatusTokenExpiresAt: { gt: now },
  });
  assert.equal((calls.eventLookup as any).where.schoolId, 'school-1');
  assert.equal((calls.eventLookup as any).where.admissionApplicationId, 'application-1');
  assert.ok(result);
  assert.equal(result.application.status, 'NEEDS_INFORMATION');
  assert.equal(result.messages[0].body, 'Please provide proof of address.');
});

test('public status lookup rejects an unknown school without querying applications', async () => {
  const { client, calls } = makePrisma({
    school: { findUnique: async () => null },
  });

  const result = await getPublicAdmissionStatus(client, 'missing-school', token, now);

  assert.equal(result, null);
  assert.equal(calls.applicationLookup, undefined);
});

test('public status lookup rejects an expired or unknown token without reading messages', async () => {
  const { client, calls } = makePrisma({
    admissionApplication: { findFirst: async () => null },
  });

  const result = await getPublicAdmissionStatus(client, 'greenfield', token, now);

  assert.equal(result, false);
  assert.equal(calls.eventLookup, undefined);
});

test('applicant reply atomically moves the application and notifies school admins', async () => {
  const { client, calls } = makePrisma();

  const result = await submitPublicAdmissionReply(client, {
    schoolSlug: 'greenfield',
    token,
    message: '  Attached proof of address.  ',
  }, now);

  assert.deepEqual(result, {
    ok: true,
    status: 201,
    message: { type: 'APPLICANT_REPLY', body: 'Attached proof of address.', createdAt: now },
  });
  assert.deepEqual((calls.applicationUpdate as any).where, {
    id: 'application-1', schoolId: 'school-1', status: 'NEEDS_INFORMATION',
  });
  assert.equal((calls.eventCreate as any).data.reason, 'Attached proof of address.');
  assert.deepEqual((calls.adminLookup as any).where, { schoolId: 'school-1', role: 'SCHOOL_ADMIN' });
  assert.equal((calls.notificationCreate as any).data[0].recipientUserId, 'admin-1');
});

test('applicant reply reports a concurrent status change as a conflict without creating an event', async () => {
  const { client, calls } = makePrisma({
    $transaction: async (callback: (transaction: any) => Promise<unknown>) => callback({
      admissionApplication: { updateMany: async () => ({ count: 0 }) },
      admissionApplicationEvent: { create: async () => { calls.eventCreate = true; } },
      user: { findMany: async () => [] },
      schoolAdminNotification: { createMany: async () => undefined },
    }),
  });

  const result = await submitPublicAdmissionReply(client, {
    schoolSlug: 'greenfield',
    token,
    message: 'Additional detail provided.',
  }, now);

  assert.deepEqual(result, {
    ok: false,
    status: 409,
    error: 'The application changed before your reply could be saved',
  });
  assert.equal(calls.eventCreate, undefined);
});

test('applicant reply is rejected unless the application is waiting for information', async () => {
  const { client, calls } = makePrisma({
    admissionApplication: { findFirst: async () => ({ ...application, status: 'APPROVED' }) },
  });

  const result = await submitPublicAdmissionReply(client, {
    schoolSlug: 'greenfield',
    token,
    message: 'Additional detail provided.',
  }, now);

  assert.deepEqual(result, {
    ok: false,
    status: 409,
    error: 'The school is not currently waiting for more information',
  });
  assert.equal(calls.applicationUpdate, undefined);
});