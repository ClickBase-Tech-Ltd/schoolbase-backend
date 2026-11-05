export const SUBSCRIPTION_TERM_DAYS = 90;
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

export type SubscriptionPlan = 'STARTER' | 'GROWTH' | 'ENTERPRISE';
export type SubscriptionBillingIntent = 'NEW' | 'RENEWAL' | 'UPGRADE';

export interface SubscriptionQuoteInput {
  intent: SubscriptionBillingIntent;
  currentPlan: string | null;
  currentExpiry: Date | null;
  targetPlan: SubscriptionPlan;
  planPrices: Record<SubscriptionPlan, number>;
  now?: Date;
}

export interface SubscriptionQuote {
  intent: SubscriptionBillingIntent;
  amountMinor: number;
  termDays: number;
  remainingDays: number | null;
  currentPlan: SubscriptionPlan | null;
  targetPlan: SubscriptionPlan;
}

const PLAN_RANK: Record<SubscriptionPlan, number> = {
  STARTER: 1,
  GROWTH: 2,
  ENTERPRISE: 3,
};

function isSubscriptionPlan(plan: string | null): plan is SubscriptionPlan {
  return plan !== null && Object.hasOwn(PLAN_RANK, plan);
}

export function getSubscriptionQuote(input: SubscriptionQuoteInput): SubscriptionQuote {
  const { intent, targetPlan, currentExpiry, planPrices } = input;
  const now = input.now ?? new Date();
  const targetPrice = planPrices[targetPlan];
  if (!Number.isSafeInteger(targetPrice) || targetPrice <= 0) {
    throw new Error('The selected plan does not have a configured online price.');
  }

  const currentPlan = isSubscriptionPlan(input.currentPlan) ? input.currentPlan : null;
  const hasActivePaidSubscription = Boolean(
    currentPlan && currentExpiry && currentExpiry.getTime() > now.getTime(),
  );
  if (intent === 'NEW' && hasActivePaidSubscription) {
    throw new Error('Choose to renew the current plan or upgrade the active subscription.');
  }
  if (
    intent === 'RENEWAL' &&
    (!currentPlan || currentPlan !== targetPlan)
  ) {
    throw new Error('Renewal must use the current plan. Choose upgrade to change plans.');
  }
  if (intent !== 'UPGRADE') {
    return {
      intent,
      amountMinor: targetPrice,
      termDays: SUBSCRIPTION_TERM_DAYS,
      remainingDays: null,
      currentPlan,
      targetPlan,
    };
  }

  if (!currentPlan || !currentExpiry || currentExpiry.getTime() <= now.getTime()) {
    throw new Error('Only an active paid subscription can be upgraded online.');
  }
  if (PLAN_RANK[targetPlan] <= PLAN_RANK[currentPlan]) {
    throw new Error('Choose a higher plan to upgrade.');
  }
  const currentPrice = planPrices[currentPlan];
  if (!Number.isSafeInteger(currentPrice) || currentPrice <= 0) {
    throw new Error('The current plan price is unavailable. Contact SchoolBase for an upgrade quote.');
  }

  const remainingDays = Math.ceil((currentExpiry.getTime() - now.getTime()) / DAY_IN_MILLISECONDS);
  const amountMinor = Math.ceil(((targetPrice - currentPrice) * remainingDays) / SUBSCRIPTION_TERM_DAYS);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 2147483647) {
    throw new Error('The upgrade price could not be calculated. Contact SchoolBase for a quote.');
  }

  return {
    intent,
    amountMinor,
    termDays: SUBSCRIPTION_TERM_DAYS,
    remainingDays,
    currentPlan,
    targetPlan,
  };
}

export function getRenewedExpiry(currentExpiry: Date | null, paymentDate: Date): Date {
  const baseDate = currentExpiry && currentExpiry.getTime() > paymentDate.getTime()
    ? currentExpiry
    : paymentDate;
  return new Date(baseDate.getTime() + SUBSCRIPTION_TERM_DAYS * DAY_IN_MILLISECONDS);
}

export function addSubscriptionBillingMetadata(
  details: Record<string, unknown>,
  quote: SubscriptionQuote | null,
  currentExpiry: Date | null,
) {
  if (!quote) return details;
  return {
    ...details,
    billingIntent: quote.intent,
    termDays: quote.termDays,
    previousPlan: quote.currentPlan,
    quotedRemainingDays: quote.remainingDays,
    previousExpiry: currentExpiry?.toISOString() ?? null,
  };
}
