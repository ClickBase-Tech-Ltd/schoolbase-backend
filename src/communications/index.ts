import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { resolveSupportedCurrency } from '../services/currency.js';
import { CommunicationRulesRegistry, DEFAULT_COMMUNICATION_RULES } from './rules.js';

export type CommunicationChannel = 'EMAIL' | 'WHATSAPP' | 'SMS' | 'PUSH';

export interface DeliveryTask {
  id: string;
  request: CommunicationRequest;
  recipient: CommunicationRecipient;
  content: { subject: string; body: string };
  attempts: number;
  lastError?: string;
  nextAttemptAt: number;
  createdAt: string;
}

export interface DurableDeliveryQueueStore {
  save(task: DeliveryTask): Promise<void>;
  loadPending(): Promise<DeliveryTask[]>;
  claim(taskId: string, now: Date, lockExpiresAt: Date): Promise<boolean>;
  complete(taskId: string): Promise<void>;
}

export interface DeliveryQueueSummary {
  pendingCount: number;
  nextRunAt?: string;
  tasks: Array<{
    id: string;
    channel: CommunicationChannel;
    recipient: string;
    attempts: number;
    nextAttemptAt: string;
    lastError?: string;
  }>;
}

export interface CommunicationRecipient {
  channel: CommunicationChannel;
  address: string;
  name?: string;
}

export interface CommunicationData {
  [key: string]: unknown;
}

export interface CommunicationRequest {
  event: string;
  schoolId?: string;
  recipients?: CommunicationRecipient[];
  template?: string;
  body?: string;
  subject?: string;
  data?: CommunicationData;
  metadata?: CommunicationData;
}

export interface DeliveryOutcome {
  channel: CommunicationChannel;
  recipient: string;
  status: 'SENT' | 'QUEUED' | 'FAILED';
  provider?: string;
  messageId?: string;
  error?: string;
}

export interface DispatchResult {
  success: boolean;
  deliveries: DeliveryOutcome[];
  skipped: number;
}

export interface CommunicationDriver {
  send(
    request: CommunicationRequest,
    recipient: CommunicationRecipient,
    content: { subject: string; body: string }
  ): Promise<DeliveryOutcome>;
}

export interface CommunicationRuleSet {
  template: string;
  channels: CommunicationChannel[];
}

export class RulesEngine {
  constructor(private readonly ruleRegistry: CommunicationRulesRegistry = new CommunicationRulesRegistry(DEFAULT_COMMUNICATION_RULES)) {}

  async evaluate(event: string, schoolId?: string): Promise<CommunicationRuleSet> {
    const defaultRule: CommunicationRuleSet = (() => {
      switch (event) {
        case 'FeeInvoiceCreated':
          return { template: 'Invoice', channels: ['EMAIL', 'WHATSAPP'] };
        case 'AdmissionCreated':
          return { template: 'Admission', channels: ['EMAIL', 'WHATSAPP'] };
        case 'StudentAccessResent':
          return { template: 'StudentAccess', channels: ['EMAIL', 'WHATSAPP'] };
        case 'AnnouncementCreated':
          return { template: 'Announcement', channels: ['EMAIL', 'WHATSAPP'] };
        case 'FeePaymentReceived':
          return { template: 'Receipt', channels: ['EMAIL', 'WHATSAPP'] };
        case 'AttendanceMarked':
          return { template: 'Attendance', channels: ['EMAIL', 'WHATSAPP'] };
        case 'ResultsPublished':
          return { template: 'Results', channels: ['EMAIL', 'WHATSAPP'] };
        case 'PinDelivered':
          return { template: 'Results', channels: ['EMAIL', 'WHATSAPP'] };
        case 'HomeworkAssigned':
          return { template: 'Homework', channels: ['EMAIL'] };
        case 'PromotionCompleted':
          return { template: 'Promotion', channels: ['EMAIL', 'WHATSAPP'] };
        default:
          return { template: 'Default', channels: ['EMAIL'] };
      }
    })();

    if (!schoolId) {
      return defaultRule;
    }

    const registryRules = await this.ruleRegistry.loadRules(schoolId);
    const registryRule = registryRules[event];
    if (!registryRule) {
      return defaultRule;
    }

    if (!registryRule.enabled) {
      return { template: defaultRule.template, channels: [] as CommunicationChannel[] };
    }

    return {
      template: registryRule.template || defaultRule.template,
      channels: registryRule.channels.length > 0 ? (registryRule.channels as CommunicationChannel[]) : defaultRule.channels,
    };
  }
}

export class TemplateEngine {
  private readonly templates: Record<string, string> = {
    Invoice: 'Invoice issued for {{studentName}}. Amount due: {{amount}}.',
    Receipt: 'Receipt received for {{studentName}}. Balance: {{balance}}.',
    Attendance: 'Attendance update for {{studentName}}. Please review the latest status.',
    Results: 'Results published for {{studentName}}. Please view the latest report.',
    Homework: 'Homework assigned for {{studentName}}.',
    Promotion: 'Promotion update for {{studentName}}. Please review the latest school notice.',
    FeeReminder: 'Fee reminder for {{studentName}}. Amount due: {{amount}}. Balance: {{balance}}.',
    Announcement: '{{title}}\n\n{{message}}',
    Admission: 'Admission completed for {{studentName}}. Admission No: {{admissionNo}}.',
    StudentAccess: 'Parent portal access reminder for {{studentName}}. Admission No: {{admissionNo}}. Open {{parentPortalUrl}} to sign in.',
    Default: 'Hello {{recipientName}}, a new communication update is available.',
  };

  render(
    template: string,
    data: CommunicationData = {},
    fallbackBody?: string,
    channel?: CommunicationChannel
  ): { subject: string; body: string } {
    const source = fallbackBody ?? this.templates[template] ?? this.templates.Default;
    const subject = this.renderString(`{{schoolName}} ${template}`, data);

    let body = this.renderString(source, data);

    // If rendering for WhatsApp and school metadata is present, append a small signature/footer
    if (channel === 'WHATSAPP' && data.school && typeof data.school === 'object') {
      try {
        const school: any = data.school as any;
        const parts: string[] = [];
        if (school.name) parts.push(`— ${String(school.name)}`);
        if (school.phone) parts.push(`${String(school.phone)}`);
        if (school.email) parts.push(`${String(school.email)}`);
        if (parts.length > 0) {
          body = `${body}\n\n${parts.join(' | ')}`;
        }
      } catch (e) {
        // ignore signature failures
      }
    }

    return {
      subject: subject.trim(),
      body,
    };
  }

  private renderString(value: string, data: CommunicationData): string {
    return value.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const replacement = data[key];
      return replacement == null ? '' : String(replacement);
    });
  }
}

export class RecipientResolver {
  resolve(recipients?: CommunicationRecipient[], data: CommunicationData = {}): CommunicationRecipient[] {
    if (recipients && recipients.length > 0) {
      return recipients.filter((recipient) => Boolean(recipient.address));
    }

    const fallbackAddress = data.address;
    if (typeof fallbackAddress === 'string' && fallbackAddress.length > 0) {
      return [{ channel: 'EMAIL', address: fallbackAddress }];
    }

    return [];
  }
}

export class DeliveryQueue {
  private queue: DeliveryTask[] = [];
  private scheduledTimer: NodeJS.Timeout | null = null;
  private readonly maxAttempts = 3;
  private readonly retryDelays = [15, 60, 180];

  constructor(
    private readonly sendFn: (
      request: CommunicationRequest,
      recipient: CommunicationRecipient,
      content: { subject: string; body: string }
    ) => Promise<DeliveryOutcome>,
     private readonly onOutcome?: (task: DeliveryTask, outcome: DeliveryOutcome, attemptNumber: number) => Promise<void>,
    private readonly durableStore?: DurableDeliveryQueueStore,
  ) {}

  async restorePending() {
    if (!this.durableStore) return 0;
    const pending = await this.durableStore.loadPending();
    const knownIds = new Set(this.queue.map((task) => task.id));
    for (const task of pending) {
      if (!knownIds.has(task.id)) this.queue.push(task);
    }
    this.scheduleNextRetry();
    return pending.length;
  }

  async enqueue(request: CommunicationRequest, recipient: CommunicationRecipient, content: { subject: string; body: string }) {
    const task: DeliveryTask = {
      id: crypto.randomUUID(),
      request,
      recipient,
      content,
      attempts: 0,
      createdAt: new Date().toISOString(),
      nextAttemptAt: Date.now(),
    };

    const outcome = await this.sendTask(task);
    if (outcome.status === 'FAILED' && task.attempts < this.maxAttempts) {
      task.attempts += 1;
      task.lastError = outcome.error;
      task.nextAttemptAt = Date.now() + this.delayForAttempt(task.attempts);
      await this.persistRetry(task);
      this.queue.push(task);
      this.scheduleNextRetry();
    }

    return outcome;
  }

  getQueueSummary(schoolId?: string): DeliveryQueueSummary {
    const normalizedSchoolId = schoolId?.trim();
    const visibleTasks = normalizedSchoolId
      ? this.queue.filter((task) => task.request.schoolId === normalizedSchoolId)
      : this.queue;
    const tasks = visibleTasks.map((task) => ({
      id: task.id,
      channel: task.recipient.channel,
      recipient: task.recipient.address,
      attempts: task.attempts,
      nextAttemptAt: new Date(task.nextAttemptAt).toISOString(),
      lastError: task.lastError,
    }));

    const nextRunAt = visibleTasks.reduce<number | undefined>((next, task) => {
      if (next === undefined || task.nextAttemptAt < next) {
        return task.nextAttemptAt;
      }
      return next;
    }, undefined);

    return {
      pendingCount: visibleTasks.length,
      nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : undefined,
      tasks,
    };
  }

  async retryTask(taskId: string) {
    const index = this.queue.findIndex((task) => task.id === taskId);
    if (index === -1) return false;

    const task = this.queue[index];
    task.nextAttemptAt = Date.now();
    await this.persistRetry(task);
    this.scheduleNextRetry();
    return true;
  }

  private delayForAttempt(attempt: number) {
    return this.retryDelays[Math.min(attempt - 1, this.retryDelays.length - 1)] * 1000;
  }

  private scheduleNextRetry() {
    if (this.scheduledTimer) return;
    if (this.queue.length === 0) return;

    const nextRun = Math.min(...this.queue.map((task) => task.nextAttemptAt));
    const delay = Math.max(0, nextRun - Date.now());
    this.scheduledTimer = setTimeout(async () => {
      this.scheduledTimer = null;
      await this.processQueue();
    }, delay);
    this.scheduledTimer.unref?.();
  }

  private async processQueue() {
    const now = Date.now();
    const readyTasks = this.queue.filter((task) => task.nextAttemptAt <= now);
    this.queue = this.queue.filter((task) => task.nextAttemptAt > now);

    for (const task of readyTasks) {
      if (this.durableStore) {
        const now = new Date();
        const claimed = await this.durableStore.claim(task.id, now, new Date(now.getTime() + 120_000)).catch((error) => {
          console.error('[DeliveryQueue] Failed to claim durable retry:', error);
          return false;
        });
        if (!claimed) continue;
      }
      const outcome = await this.sendTask(task);
      if (outcome.status === 'FAILED' && task.attempts < this.maxAttempts) {
        task.attempts += 1;
        task.lastError = outcome.error;
        task.nextAttemptAt = Date.now() + this.delayForAttempt(task.attempts);
        await this.persistRetry(task);
        this.queue.push(task);
      } else {
        await this.durableStore?.complete(task.id).catch((error) => {
          console.error('[DeliveryQueue] Failed to complete durable retry:', error);
        });
      }
    }

    if (this.queue.length > 0) {
      this.scheduleNextRetry();
    }
  }

  private async persistRetry(task: DeliveryTask) {
    await this.durableStore?.save(task).catch((error) => {
      console.error('[DeliveryQueue] Failed to persist retry job:', error);
    });
  }

  private async sendTask(task: DeliveryTask) {
    try {
      const result = await this.sendFn(task.request, task.recipient, task.content);
      await this.onOutcome?.(task, result, task.attempts + 1).catch((error) => {
        console.error('[DeliveryQueue] Failed to persist provider outcome:', error);
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome: DeliveryOutcome = {
        channel: task.recipient.channel,
        recipient: task.recipient.address,
        status: 'FAILED' as const,
        provider: 'delivery-queue',
        error: message,
      };
      await this.onOutcome?.(task, outcome, task.attempts + 1).catch((persistError) => {
        console.error('[DeliveryQueue] Failed to persist provider outcome:', persistError);
      });
      return outcome;
    }
  }
}

export class DriverManager {
  private readonly drivers = new Map<CommunicationChannel, CommunicationDriver>();

  constructor(drivers: Partial<Record<CommunicationChannel, CommunicationDriver>> = {}) {
    for (const [channel, driver] of Object.entries(drivers) as Array<[string, CommunicationDriver]>) {
      this.register(channel.toUpperCase() as CommunicationChannel, driver);
    }
  }

  register(channel: CommunicationChannel, driver: CommunicationDriver) {
    this.drivers.set(channel, driver);
  }

  async send(request: CommunicationRequest, recipient: CommunicationRecipient, content: { subject: string; body: string }) {
    const driver = this.drivers.get(recipient.channel);
    if (!driver) {
      return {
        channel: recipient.channel,
        recipient: recipient.address,
        status: 'FAILED' as const,
        error: `No driver registered for ${recipient.channel}`,
      };
    }

    return driver.send(request, recipient, content);
  }
}

export class EmailDriver implements CommunicationDriver {
  constructor(
    private readonly sendHandler?: (payload: { request: CommunicationRequest; recipient: CommunicationRecipient; content: { subject: string; body: string } }) => Promise<DeliveryOutcome>
  ) {}

  async send(request: CommunicationRequest, recipient: CommunicationRecipient, content: { subject: string; body: string }) {
    try {
      if (this.sendHandler) {
        return await this.sendHandler({ request, recipient, content });
      }

      return {
        channel: 'EMAIL',
        recipient: recipient.address,
        status: 'QUEUED',
        provider: 'email-driver',
      } as DeliveryOutcome;
    } catch (error) {
      return {
        channel: 'EMAIL',
        recipient: recipient.address,
        status: 'FAILED',
        provider: 'email-driver',
        error: error instanceof Error ? error.message : String(error),
      } as DeliveryOutcome;
    }
  }
}

export class WhatsAppDriver implements CommunicationDriver {
  constructor(
    private readonly sendHandler?: (payload: { request: CommunicationRequest; recipient: CommunicationRecipient; content: { subject: string; body: string } }) => Promise<DeliveryOutcome>
  ) {}

  async send(request: CommunicationRequest, recipient: CommunicationRecipient, content: { subject: string; body: string }) {
    try {
      if (this.sendHandler) {
        return await this.sendHandler({ request, recipient, content });
      }

      return {
        channel: 'WHATSAPP',
        recipient: recipient.address,
        status: 'QUEUED',
        provider: 'wppconnect-stub',
      } as DeliveryOutcome;
    } catch (error) {
      return {
        channel: 'WHATSAPP',
        recipient: recipient.address,
        status: 'FAILED',
        provider: 'wppconnect-stub',
        error: error instanceof Error ? error.message : String(error),
      } as DeliveryOutcome;
    }
  }
}

export class CommunicationService {
  constructor(
    private readonly dependencies: {
      rulesEngine: RulesEngine;
      templateEngine: TemplateEngine;
      recipientResolver: RecipientResolver;
      deliveryQueue: DeliveryQueue;
      driverManager: DriverManager;
    }
  ) {}

  async dispatch(request: CommunicationRequest): Promise<DispatchResult> {
    const ruleSet = await this.dependencies.rulesEngine.evaluate(request.event, request.schoolId);
    const recipients = this.dependencies.recipientResolver.resolve(request.recipients, request.data);
    const resolvedRecipients: CommunicationRecipient[] = recipients.length > 0
      ? recipients
      : ruleSet.channels.map((channel) => ({ channel, address: '' }));

    if (resolvedRecipients.length === 0) {
      return { success: false, deliveries: [], skipped: 0 };
    }

    const deliveries: DeliveryOutcome[] = [];
    let skipped = 0;

    for (const recipient of resolvedRecipients) {
      if (!recipient.address) {
        skipped += 1;
        continue;
      }

      // Load school metadata when available so templates can include school details
      let schoolMeta: Record<string, unknown> | undefined = undefined;
      try {
        if (request.schoolId) {
          const prisma = new PrismaClient();
          const s = await prisma.school.findUnique({
            where: { id: request.schoolId },
            select: { id: true, name: true, initials: true, phone: true, email: true, logoUrl: true, address: true, city: true, country: true },
          });
          if (s) {
            schoolMeta = s as Record<string, unknown>;
          }
        }
      } catch (e) {
        // ignore DB errors, rendering can proceed without school metadata
        console.warn('[CommunicationService] Failed to load school metadata for template rendering', e);
      }

      const renderData = {
        ...(request.data ?? {}),
        currency: resolveSupportedCurrency(
          typeof request.data?.currency === 'string' ? request.data.currency : undefined,
          typeof request.data?.schoolCurrency === 'string' ? request.data.schoolCurrency : undefined
        ),
        recipientName: recipient.name ?? 'Guardian',
        schoolName: request.data?.schoolName ?? (schoolMeta?.name as string) ?? 'SchoolBase',
        school: schoolMeta,
      };

      const content = this.dependencies.templateEngine.render(
        request.template ?? ruleSet.template,
        renderData,
        request.body,
        recipient.channel
      );

      const outcome = await this.dependencies.deliveryQueue.enqueue(request, recipient, content);
      deliveries.push(outcome);
    }

    return {
      success: deliveries.some((delivery) => !['FAILED'].includes(delivery.status)),
      deliveries,
      skipped,
    };
  }
}

export default CommunicationService;
