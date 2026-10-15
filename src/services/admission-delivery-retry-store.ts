import { Prisma, PrismaClient } from '@prisma/client';
import type { DeliveryTask, DurableDeliveryQueueStore } from '../communications/index.js';

export class AdmissionDeliveryRetryStore implements DurableDeliveryQueueStore {
  constructor(private readonly prisma: PrismaClient) {}

  async save(task: DeliveryTask) {
    const applicationId = task.request.metadata?.admissionApplicationId;
    if (typeof applicationId !== 'string' || !task.request.schoolId || task.recipient.channel !== 'EMAIL') return;
    const audience = String(task.request.metadata?.audience ?? 'UNKNOWN').slice(0, 32);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await this.prisma.admissionDeliveryRetry.upsert({
      where: { id: task.id },
      create: {
        id: task.id,
        admissionApplicationId: applicationId,
        schoolId: task.request.schoolId,
        audience,
        event: task.request.event.slice(0, 64),
        recipient: task.recipient as unknown as Prisma.InputJsonValue,
        content: task.content as unknown as Prisma.InputJsonValue,
        task: task as unknown as Prisma.InputJsonValue,
        attempts: task.attempts,
        lastError: task.lastError ?? null,
        nextAttemptAt: new Date(task.nextAttemptAt),
        lockExpiresAt: null,
        expiresAt,
        status: 'QUEUED',
      },
      update: {
        recipient: task.recipient as unknown as Prisma.InputJsonValue,
        content: task.content as unknown as Prisma.InputJsonValue,
        task: task as unknown as Prisma.InputJsonValue,
        attempts: task.attempts,
        lastError: task.lastError ?? null,
        nextAttemptAt: new Date(task.nextAttemptAt),
        lockExpiresAt: null,
        expiresAt,
        status: 'QUEUED',
      },
    });
  }

  async loadPending(): Promise<DeliveryTask[]> {
    const now = new Date();
    await this.prisma.admissionDeliveryRetry.deleteMany({ where: { expiresAt: { lte: now } } });
    await this.prisma.admissionDeliveryRetry.updateMany({
      where: { status: 'PROCESSING', lockExpiresAt: { lte: now } },
      data: { status: 'QUEUED', lockExpiresAt: null, nextAttemptAt: now },
    });
    const rows = await this.prisma.admissionDeliveryRetry.findMany({
      where: { status: 'QUEUED', expiresAt: { gt: now } },
      orderBy: { nextAttemptAt: 'asc' },
    });
    return rows.map((row) => row.task as unknown as DeliveryTask);
  }

  async claim(taskId: string, now: Date, lockExpiresAt: Date): Promise<boolean> {
    const result = await this.prisma.admissionDeliveryRetry.updateMany({
      where: {
        id: taskId,
        expiresAt: { gt: now },
        OR: [
          { status: 'QUEUED', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', lockExpiresAt: { lte: now } },
        ],
      },
      data: { status: 'PROCESSING', lockExpiresAt },
    });
    return result.count === 1;
  }

  async complete(taskId: string) {
    await this.prisma.admissionDeliveryRetry.deleteMany({ where: { id: taskId } });
  }
}
