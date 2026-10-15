import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunicationService, RulesEngine, TemplateEngine, RecipientResolver, DeliveryQueue, DriverManager, EmailDriver, type DeliveryTask } from '../index.js';

test('dispatches a notification through the communication engine', async () => {
  const emailDriver = new EmailDriver(async () => ({
    channel: 'EMAIL',
    recipient: 'guardian@example.com',
    status: 'QUEUED',
    provider: 'email-test',
  }));

  const service = new CommunicationService({
    rulesEngine: new RulesEngine(),
    templateEngine: new TemplateEngine(),
    recipientResolver: new RecipientResolver(),
    deliveryQueue: new DeliveryQueue(async () => ({
      channel: 'EMAIL',
      recipient: 'guardian@example.com',
      status: 'QUEUED',
      provider: 'email-test',
    })),
    driverManager: new DriverManager({ EMAIL: emailDriver }),
  });

  const result = await service.dispatch({
    event: 'FeeInvoiceCreated',
    schoolId: 'school-1',
    recipients: [
      {
        channel: 'EMAIL',
        address: 'guardian@example.com',
        name: 'Ada',
      },
    ],
    template: 'FeeReminder',
    data: {
      studentName: 'Amara',
      schoolName: 'Bright Stars',
      amount: '5000',
      balance: '5000',
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0]?.channel, 'EMAIL');
});

test('treats PIN delivery notifications as multi-channel communication', async () => {
  const rulesEngine = new RulesEngine();
  const ruleSet = await rulesEngine.evaluate('PinDelivered', 'school-1');

  assert.equal(ruleSet.template, 'Results');
  assert.deepEqual(ruleSet.channels, ['EMAIL', 'WHATSAPP']);
});

test('delivery queue schedules retries for failed sends', async () => {
  const failedSend = async () => ({
    channel: 'WHATSAPP' as const,
    recipient: '+2347000000000',
    status: 'FAILED' as const,
    provider: 'wa-test',
    error: 'network error',
  });

  const deliveryQueue = new DeliveryQueue(failedSend);

  const outcome = await deliveryQueue.enqueue(
    {
      event: 'FeeInvoiceCreated',
      schoolId: 'school-1',
      data: { studentName: 'Amara' },
    },
    { channel: 'WHATSAPP', address: '+2347000000000', name: 'Ada' },
    { subject: 'Retry test', body: 'This is a retry test.' }
  );

  assert.equal(outcome.status, 'FAILED');
  assert.equal(deliveryQueue.getQueueSummary().pendingCount, 1);
  assert.ok(deliveryQueue.getQueueSummary().nextRunAt);
});

test('delivery queue reports each provider attempt to the persistence hook', async () => {
  const recorded: Array<{ attemptNumber: number; status: string; event: string }> = [];
  const deliveryQueue = new DeliveryQueue(
    async () => ({ channel: 'EMAIL', recipient: 'applicant@example.com', status: 'FAILED', provider: 'mail-test', error: 'provider unavailable' }),
    async (task, outcome, attemptNumber) => {
      recorded.push({ attemptNumber, status: outcome.status, event: task.request.event });
    },
  );

  await deliveryQueue.enqueue(
    { event: 'AdmissionCreated', schoolId: 'school-1' },
    { channel: 'EMAIL', address: 'applicant@example.com' },
    { subject: 'Admission received', body: 'Safe delivery test' },
  );

  assert.deepEqual(recorded, [{ attemptNumber: 1, status: 'FAILED', event: 'AdmissionCreated' }]);
});

test('delivery queue restores a persisted admission retry after restart', async () => {
  let persistedTask: DeliveryTask | null = null;
  const durableStore = {
    async save(task: DeliveryTask) { persistedTask = structuredClone(task); },
    async loadPending() { return persistedTask ? [structuredClone(persistedTask)] : []; },
    async claim() { return true; },
    async complete() { persistedTask = null; },
  };
  const failedQueue = new DeliveryQueue(
    async () => ({ channel: 'EMAIL', recipient: 'applicant@example.com', status: 'FAILED', provider: 'mail-test', error: 'provider unavailable' }),
    undefined,
    durableStore,
  );

  await failedQueue.enqueue(
    { event: 'AdmissionCreated', schoolId: 'school-1', metadata: { admissionApplicationId: 'application-1', audience: 'APPLICANT' } },
    { channel: 'EMAIL', address: 'applicant@example.com', name: 'Applicant' },
    { subject: 'Application received', body: 'Safe retry content' },
  );
  assert.ok(persistedTask);

  const restartedQueue = new DeliveryQueue(
    async () => ({ channel: 'EMAIL', recipient: 'applicant@example.com', status: 'SENT', provider: 'mail-test' }),
    undefined,
    durableStore,
  );
  assert.equal(await restartedQueue.restorePending(), 1);
  assert.equal(restartedQueue.getQueueSummary('school-1').pendingCount, 1);
});

test('delivery queue summaries are isolated by school', async () => {
  const deliveryQueue = new DeliveryQueue(async (request) => ({
    channel: 'WHATSAPP' as const,
    recipient: request.schoolId === 'school-a' ? '+2347000000001' : '+2347000000002',
    status: 'FAILED' as const,
    provider: 'wa-test',
    error: 'temporary failure',
  }));

  for (const schoolId of ['school-a', 'school-b']) {
    await deliveryQueue.enqueue(
      { event: 'AnnouncementCreated', schoolId },
      { channel: 'WHATSAPP', address: '+2347000000000' },
      { subject: 'Test', body: 'Test message' },
    );
  }

  assert.equal(deliveryQueue.getQueueSummary('school-a').pendingCount, 1);
  assert.equal(deliveryQueue.getQueueSummary('school-b').pendingCount, 1);
  assert.equal(deliveryQueue.getQueueSummary().pendingCount, 2);
});
