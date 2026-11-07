import { Prisma, type PrismaClient } from '@prisma/client';
import { billingMarkets, type BillingMarketCode } from './billing-markets.js';

type AssignmentTransaction = Prisma.TransactionClient;
type WorkType = 'followUp' | 'support';

type Representative = { id: string; name: string };

export function selectLeastLoadedRepresentative(
  representatives: Representative[],
  workload: Map<string, number>,
) {
  if (!representatives.length) return null;
  return representatives.reduce((leastLoaded, candidate) => {
    const leastCount = workload.get(leastLoaded.id) ?? 0;
    const candidateCount = workload.get(candidate.id) ?? 0;
    return candidateCount < leastCount ||
      (candidateCount === leastCount && candidate.id.localeCompare(leastLoaded.id) < 0)
      ? candidate
      : leastLoaded;
  });
}

function isBillingMarketCode(value: string): value is BillingMarketCode {
  return Object.hasOwn(billingMarkets, value);
}

async function lockCountryRepresentatives(tx: AssignmentTransaction, countryCode: BillingMarketCode) {
  return tx.$queryRaw<Representative[]>(Prisma.sql`
    SELECT id, name
    FROM User
    WHERE role = 'COUNTRY_REP'
      AND countryCode = ${countryCode}
      AND isActive = true
      AND schoolId IS NULL
    ORDER BY id
    FOR UPDATE
  `);
}

async function getWorkloads(
  tx: AssignmentTransaction,
  countryCode: BillingMarketCode,
  representatives: Representative[],
  workType: WorkType,
) {
  const workload = new Map(representatives.map(({ id }) => [id, 0]));
  const ids = representatives.map(({ id }) => id);
  if (!ids.length) return workload;

  if (workType === 'followUp') {
    const counts = await tx.countrySchoolFollowUp.groupBy({
      by: ['ownerUserId'],
      where: {
        ownerUserId: { in: ids },
        school: { country: countryCode },
        stage: { not: 'OPERATIONAL' },
      },
      _count: { _all: true },
    });
    for (const row of counts) {
      if (row.ownerUserId) workload.set(row.ownerUserId, row._count._all);
    }
  } else {
    const counts = await tx.supportRequest.groupBy({
      by: ['assignedCountryRepId'],
      where: {
        assignedCountryRepId: { in: ids },
        school: { country: countryCode },
        status: { notIn: ['CLOSED', 'RESOLVED'] },
      },
      _count: { _all: true },
    });
    for (const row of counts) {
      if (row.assignedCountryRepId) workload.set(row.assignedCountryRepId, row._count._all);
    }
  }

  return workload;
}

export async function chooseCountryRepresentative(
  tx: AssignmentTransaction,
  countryCode: BillingMarketCode,
  workType: WorkType,
) {
  const representatives = await lockCountryRepresentatives(tx, countryCode);
  if (!representatives.length) return null;

  const workload = await getWorkloads(tx, countryCode, representatives, workType);
  return selectLeastLoadedRepresentative(representatives, workload);
}

export async function chooseCountryRepresentativeForSchool(
  tx: AssignmentTransaction,
  schoolId: string,
  workType: WorkType,
) {
  const [school] = await tx.$queryRaw<Array<{ country: string }>>(Prisma.sql`
    SELECT country
    FROM School
    WHERE id = ${schoolId}
    FOR UPDATE
  `);
  if (!school || !isBillingMarketCode(school.country)) return null;
  return chooseCountryRepresentative(tx, school.country, workType);
}

export async function reconcileUnassignedCountryWork(prisma: PrismaClient) {
  const result = { followUpsAssigned: 0, supportRequestsAssigned: 0, countriesWithoutRepresentatives: 0 };

  for (const countryCode of Object.keys(billingMarkets) as BillingMarketCode[]) {
    const countryResult = await prisma.$transaction(async (tx) => {
      const representatives = await lockCountryRepresentatives(tx, countryCode);
      if (!representatives.length) {
        const [unassignedFollowUps, unassignedSupportRequests] = await Promise.all([
          tx.countrySchoolFollowUp.count({
            where: {
              stage: { not: 'OPERATIONAL' },
              school: { country: countryCode },
            },
          }),
          tx.supportRequest.count({
            where: {
              school: { country: countryCode },
              status: { notIn: ['CLOSED', 'RESOLVED'] },
            },
          }),
        ]);
        return {
          followUpsAssigned: 0,
          supportRequestsAssigned: 0,
          withoutRepresentatives: unassignedFollowUps + unassignedSupportRequests > 0,
        };
      }

      const followUpWorkload = await getWorkloads(tx, countryCode, representatives, 'followUp');
      const unassignedFollowUps = await tx.countrySchoolFollowUp.findMany({
        where: {
          school: { country: countryCode },
          OR: [
            { ownerUserId: null },
            { ownerUserId: { notIn: representatives.map(({ id }) => id) } },
          ],
        },
        select: { id: true, ownerUserId: true, owner: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      let followUpsAssigned = 0;

      for (const followUp of unassignedFollowUps) {
        const owner = selectLeastLoadedRepresentative(representatives, followUpWorkload);
        if (!owner) break;
        const updated = await tx.countrySchoolFollowUp.updateMany({
          where: { id: followUp.id, ownerUserId: followUp.ownerUserId },
          data: { ownerUserId: owner.id },
        });
        if (!updated.count) continue;

        await tx.countrySchoolFollowUpEvent.create({
          data: {
            followUpId: followUp.id,
            actorName: 'Automatic assignment',
            changes: {
              owner: {
                from: followUp.ownerUserId ? { id: followUp.ownerUserId, name: followUp.owner?.name ?? 'Former representative' } : null,
                to: { id: owner.id, name: owner.name },
              },
            },
          },
        });
        followUpWorkload.set(owner.id, (followUpWorkload.get(owner.id) ?? 0) + 1);
        followUpsAssigned++;
      }

      const supportWorkload = await getWorkloads(tx, countryCode, representatives, 'support');
      const unassignedRequests = await tx.supportRequest.findMany({
        where: {
          school: { country: countryCode },
          status: { notIn: ['CLOSED', 'RESOLVED'] },
          OR: [
            { assignedCountryRepId: null },
            { assignedCountryRepId: { notIn: representatives.map(({ id }) => id) } },
          ],
        },
        select: { id: true, assignedCountryRepId: true },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      let supportRequestsAssigned = 0;

      for (const request of unassignedRequests) {
        const owner = selectLeastLoadedRepresentative(representatives, supportWorkload);
        if (!owner) break;
        const updated = await tx.supportRequest.updateMany({
          where: { id: request.id, assignedCountryRepId: request.assignedCountryRepId },
          data: { assignedCountryRepId: owner.id },
        });
        if (!updated.count) continue;
        supportWorkload.set(owner.id, (supportWorkload.get(owner.id) ?? 0) + 1);
        supportRequestsAssigned++;
      }

      return { followUpsAssigned, supportRequestsAssigned, withoutRepresentatives: false };
    });

    result.followUpsAssigned += countryResult.followUpsAssigned;
    result.supportRequestsAssigned += countryResult.supportRequestsAssigned;
    if (countryResult.withoutRepresentatives) result.countriesWithoutRepresentatives++;
  }

  if (result.followUpsAssigned || result.supportRequestsAssigned || result.countriesWithoutRepresentatives) {
    console.log('[CountryWorkAssignment] Reconciliation completed:', result);
  }
  return result;
}
