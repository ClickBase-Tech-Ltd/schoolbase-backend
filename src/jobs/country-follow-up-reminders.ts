import { Prisma, PrismaClient } from '@prisma/client';
import cron from 'node-cron';
import { billingMarkets, type BillingMarketCode } from '../services/billing-markets.js';
import { reconcileUnassignedCountryWork } from '../services/country-work-assignment.js';
import { sendCountryFollowUpDigestEmail } from '../services/email.js';

const prisma = new PrismaClient();
const DIGEST_CLAIM_TIMEOUT_MS = 30 * 60 * 1000;

export function getUtcReminderWindow(now: Date) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return { today, tomorrow };
}

async function claimDigest(userId: string, digestDate: Date, now: Date) {
  try {
    await prisma.countryFollowUpDigest.create({
      data: { userId, digestDate, claimedAt: now },
    });
    return true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }

    const existing = await prisma.countryFollowUpDigest.findUnique({
      where: { userId_digestDate: { userId, digestDate } },
      select: { id: true, status: true },
    });
    if (!existing || existing.status === 'SENT') return false;

    const claimed = await prisma.countryFollowUpDigest.updateMany({
      where: {
        id: existing.id,
        OR: [
          { status: 'FAILED' },
          {
            status: 'PROCESSING',
            claimedAt: { lt: new Date(now.getTime() - DIGEST_CLAIM_TIMEOUT_MS) },
          },
        ],
      },
      data: { status: 'PROCESSING', claimedAt: now, error: null },
    });
    return claimed.count === 1;
  }
}

export async function sendCountryFollowUpDigests(now = new Date()) {
  await reconcileUnassignedCountryWork(prisma);
  const { today, tomorrow } = getUtcReminderWindow(now);
  const representatives = await prisma.user.findMany({
    where: {
      role: 'COUNTRY_REP',
      isActive: true,
      schoolId: null,
      countryCode: { in: Object.keys(billingMarkets) },
      countryFollowUpRemindersEnabled: true,
    },
    select: { id: true, name: true, email: true, countryCode: true },
  });
  let sent = 0;
  let failed = 0;

  for (const representative of representatives) {
    if (!representative.countryCode) continue;

    try {
      const schools = await prisma.countrySchoolFollowUp.findMany({
        where: {
          ownerUserId: representative.id,
          stage: { not: 'OPERATIONAL' },
          nextContactAt: { lt: tomorrow },
          school: { country: representative.countryCode, archivedAt: null },
        },
        select: {
          nextContactAt: true,
          school: { select: { name: true, city: true } },
        },
        orderBy: { nextContactAt: 'asc' },
      });
      if (!schools.length) continue;

      if (!await claimDigest(representative.id, today, now)) continue;

      const country = billingMarkets[representative.countryCode as BillingMarketCode];
      await sendCountryFollowUpDigestEmail({
        email: representative.email,
        representativeName: representative.name,
        countryName: country.countryName,
        schools: schools.map((followUp) => ({
          name: followUp.school.name,
          city: followUp.school.city,
          nextContactAt: followUp.nextContactAt!,
          overdue: followUp.nextContactAt! < today,
        })),
      });
      await prisma.countryFollowUpDigest.update({
        where: { userId_digestDate: { userId: representative.id, digestDate: today } },
        data: { status: 'SENT', sentAt: now, error: null },
      });
      sent++;
      console.log(`[CountryFollowUpReminders] Daily digest sent to ${representative.email}`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[CountryFollowUpReminders] Failed to send digest to ${representative.email}:`, error);
      try {
        await prisma.countryFollowUpDigest.updateMany({
          where: {
            userId: representative.id,
            digestDate: today,
            status: 'PROCESSING',
          },
          data: { status: 'FAILED', error: message.slice(0, 2000) },
        });
      } catch (recordError) {
        console.error('[CountryFollowUpReminders] Failed to record digest error:', recordError);
      }
    }
  }

  console.log(`[CountryFollowUpReminders] Digest run complete: ${sent} sent, ${failed} failed`);
  return { sent, failed };
}

export function initializeCountryFollowUpReminderJob() {
  const task = cron.schedule('15 8 * * *', async () => {
    console.log('[CountryFollowUpReminders] Daily digest job triggered');
    try {
      await sendCountryFollowUpDigests();
    } catch (error) {
      console.error('[CountryFollowUpReminders] Daily digest job failed:', error);
    }
  }, { timezone: 'UTC' });
  console.log('✓ Country follow-up reminder job initialized (daily at 8:15 AM UTC)');
  return task;
}

export function initializeCountryWorkAssignmentJob() {
  const reconcile = async () => {
    try {
      await reconcileUnassignedCountryWork(prisma);
    } catch (error) {
      console.error('[CountryWorkAssignment] Automatic assignment reconciliation failed:', error);
    }
  };
  void reconcile();

  const task = cron.schedule('*/15 * * * *', reconcile, { timezone: 'UTC' });
  console.log('✓ Country work assignment reconciliation initialized (every 15 minutes)');
  return task;
}

export function stopCountryFollowUpReminderJob(task: { stop: () => void } | null) {
  task?.stop();
}
