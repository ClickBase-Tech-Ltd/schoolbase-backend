import { PaymentMethod, PrismaClient } from '@prisma/client';
import { Router, Request, Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { sendSubscriptionReceipt } from '../services/subscription-receipts.js';
import { requireAdmin, verifyAuth, type AuthenticatedRequest } from '../middleware/roleAuth.js';
import {
  getBillingMarket,
  getBillingMarketCatalog,
  getFlutterwaveFrontendBaseUrl,
  getFlutterwaveWebhookSecret,
  getMarketPricing,
  isFlutterwaveSubscriptionConfigured,
} from '../services/billing-markets.js';
import type { BillingPlanCode } from '../services/billing-markets.js';
import {
  addSubscriptionBillingMetadata,
  getRenewedExpiry,
  getSubscriptionQuote,
  type SubscriptionBillingIntent,
} from '../services/subscription-billing.js';

const router = Router();
const prisma = new PrismaClient();
const FLUTTERWAVE_API_URL = 'https://api.flutterwave.com/v3';
const paymentPlanMap: Record<string, BillingPlanCode> = {
  STARTER: 'STARTER',
  STANDARD: 'GROWTH',
  GROWTH: 'GROWTH',
  ENTERPRISE: 'ENTERPRISE',
};

function toMinorUnits(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

function parsePaymentDetails(note: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(note);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function initializeFlutterwaveCheckout(input: {
  reference: string;
  amountMinor: number;
  currency: string;
  email: string;
  name: string;
  schoolName: string;
  planLabel: string;
  redirectUrl: string;
  meta: Record<string, string | number>;
}): Promise<string> {
  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY?.trim();
  if (!secretKey) throw new Error('Flutterwave is not configured for checkout.');

  const response = await fetch(`${FLUTTERWAVE_API_URL}/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tx_ref: input.reference,
      amount: input.amountMinor / 100,
      currency: input.currency,
      redirect_url: input.redirectUrl,
      customer: { email: input.email, name: input.name },
      customizations: {
        title: 'SchoolBase Subscription',
        description: `${input.schoolName} - ${input.planLabel}`,
      },
      meta: input.meta,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const responseData: unknown = await response.json().catch(() => null);
  const checkoutLink = responseData && typeof responseData === 'object'
    ? (responseData as { data?: { link?: unknown } }).data?.link
    : null;
  let checkoutUrl: URL | null = null;
  if (typeof checkoutLink === 'string') {
    try {
      checkoutUrl = new URL(checkoutLink);
    } catch {
      checkoutUrl = null;
    }
  }

  if (
    !response.ok ||
    !checkoutUrl ||
    checkoutUrl.hostname !== 'checkout.flutterwave.com' ||
    checkoutUrl.protocol !== 'https:'
  ) {
    console.error('Flutterwave checkout initialization returned an invalid response:', response.status);
    throw new Error('Unable to start Flutterwave checkout.');
  }

  return checkoutUrl.toString();
}

async function completeSubscription(reference: string, transactionId: string) {
  const payment = await prisma.platformPayment.findFirst({ where: { reference } });
  if (!payment?.note) {
    return { status: 404, body: { error: 'A matching server-created payment was not found.' } };
  }

  const paymentDetails = parsePaymentDetails(payment.note);
  if (!paymentDetails) {
    return { status: 500, body: { error: 'The payment record is invalid and requires support review.' } };
  }

  const schoolId = typeof paymentDetails.schoolId === 'string' ? paymentDetails.schoolId : payment.recordedBy;
  if (
    paymentDetails.paymentStatus === 'COMPLETED' &&
    paymentDetails.provider === 'FLUTTERWAVE' &&
    paymentDetails.subscription === true &&
    paymentDetails.transactionId === transactionId &&
    schoolId
  ) {
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true, name: true, slug: true, status: true, plan: true, subscriptionExpiresAt: true },
    });
    if (!school) return { status: 404, body: { error: 'School not found for completed payment.' } };
    return {
      status: 200,
      body: {
        success: true,
        school,
        receiptPaymentId: payment.id,
        reference,
        subscriptionApplied: paymentDetails.subscriptionApplied !== false,
        message: paymentDetails.subscriptionApplied === false
          ? 'Payment was received, but the subscription needs SchoolBase review before access can be updated.'
          : undefined,
        transaction: { reference, amount: payment.amount, currency: paymentDetails.currency },
      },
    };
  }

  if (
    !['flutterwave-subscription-init', 'flutterwave-public-subscription-init'].includes(String(paymentDetails.source)) ||
    paymentDetails.subscription !== true ||
    paymentDetails.provider !== 'FLUTTERWAVE' ||
    paymentDetails.paymentStatus !== 'PENDING' ||
    payment.reference !== reference
  ) {
    return { status: 400, body: { error: 'The payment record is not a pending Flutterwave subscription checkout.' } };
  }

  const expectedAmountMinor = Number(paymentDetails.expectedAmountMinor);
  const expectedCurrency = typeof paymentDetails.currency === 'string' ? paymentDetails.currency.toUpperCase() : '';
  const expectedCountry = typeof paymentDetails.country === 'string' ? paymentDetails.country.toUpperCase() : '';
  const plan = typeof paymentDetails.plan === 'string' ? paymentPlanMap[paymentDetails.plan.toUpperCase()] : undefined;
  if (
    !schoolId ||
    !plan ||
    !Number.isSafeInteger(expectedAmountMinor) ||
    expectedAmountMinor <= 0 ||
    expectedAmountMinor > 2147483647 ||
    payment.amount !== expectedAmountMinor
  ) {
    return { status: 400, body: { error: 'The payment record has an invalid subscription snapshot.' } };
  }

  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: {
      id: true,
      name: true,
      slug: true,
      country: true,
      currency: true,
      plan: true,
      subscriptionExpiresAt: true,
    },
  });
  if (!school) return { status: 404, body: { error: 'School not found for subscription verification.' } };
  const market = getBillingMarket(school.country);
  if (
    !market ||
    market.countryCode !== expectedCountry ||
    market.currency !== expectedCurrency ||
    String(school.currency ?? '').trim().toUpperCase() !== market.currency
  ) {
    return { status: 409, body: { error: 'The payment snapshot no longer matches the school billing market.' } };
  }

  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY?.trim();
  if (!secretKey) return { status: 503, body: { error: 'Flutterwave is not configured for payment verification.' } };

  let providerResponse: globalThis.Response;
  try {
    providerResponse = await fetch(
      `${FLUTTERWAVE_API_URL}/transactions/${encodeURIComponent(transactionId)}/verify`,
      { headers: { Authorization: `Bearer ${secretKey}` }, signal: AbortSignal.timeout(15000) },
    );
  } catch (error) {
    console.error('Flutterwave transaction verification request failed:', error);
    return { status: 502, body: { error: 'Unable to verify the payment with Flutterwave. Please retry.' } };
  }

  const providerResult: unknown = await providerResponse.json().catch(() => null);
  const transaction = providerResult && typeof providerResult === 'object'
    ? (providerResult as { data?: unknown }).data
    : null;
  const tx = transaction && typeof transaction === 'object'
    ? transaction as Record<string, unknown>
    : null;

  if (!providerResponse.ok || !tx) {
    console.error('Flutterwave transaction verification was unsuccessful:', providerResponse.status);
    return { status: providerResponse.status >= 500 ? 502 : 400, body: { error: 'Flutterwave could not verify this transaction.' } };
  }

  if (
    String(tx.id) !== transactionId ||
    tx.status !== 'successful' ||
    tx.tx_ref !== reference ||
    String(tx.currency ?? '').trim().toUpperCase() !== expectedCurrency ||
    toMinorUnits(tx.amount) !== expectedAmountMinor
  ) {
    return { status: 400, body: { error: 'The verified payment does not match the reference, amount, and billing currency.' } };
  }

  const providerCreatedAt = typeof tx.created_at === 'string' ? new Date(tx.created_at) : null;
  const paymentRecordedAt = providerCreatedAt && !Number.isNaN(providerCreatedAt.getTime()) ? providerCreatedAt : new Date();
  const billingIntent: SubscriptionBillingIntent = ['NEW', 'RENEWAL', 'UPGRADE'].includes(String(paymentDetails.billingIntent))
    ? paymentDetails.billingIntent as SubscriptionBillingIntent
    : 'NEW';
  const previousExpiry = typeof paymentDetails.previousExpiry === 'string'
    ? new Date(paymentDetails.previousExpiry)
    : null;
  const hasBillingSnapshot = ['NEW', 'RENEWAL', 'UPGRADE'].includes(String(paymentDetails.billingIntent))
    && Object.hasOwn(paymentDetails, 'previousExpiry')
    && Object.hasOwn(paymentDetails, 'schoolPlanAtCheckout');
  const subscriptionExpiresAt = billingIntent === 'UPGRADE'
    ? previousExpiry
    : billingIntent === 'RENEWAL'
      ? getRenewedExpiry(previousExpiry, paymentRecordedAt)
      : getRenewedExpiry(null, paymentRecordedAt);
  const applyResult = await prisma.$transaction(async (txClient) => {
    const currentSchool = await txClient.school.findUnique({
      where: { id: school.id },
      select: { plan: true, subscriptionExpiresAt: true },
    });
    if (!currentSchool) return { school: null, reviewRequired: false };
    const snapshotMatches = !hasBillingSnapshot || (
      currentSchool.plan === paymentDetails.schoolPlanAtCheckout &&
      (currentSchool.subscriptionExpiresAt?.getTime() ?? null) === (previousExpiry?.getTime() ?? null)
    );
    const currentPlanRanks: Record<string, number> = { STARTER: 1, GROWTH: 2, ENTERPRISE: 3 };
    const activeAtPayment = Boolean(
      currentPlanRanks[currentSchool.plan] &&
      currentSchool.subscriptionExpiresAt &&
      currentSchool.subscriptionExpiresAt.getTime() > paymentRecordedAt.getTime(),
    );
    const intentStillValid = billingIntent === 'NEW'
      ? !activeAtPayment
      : billingIntent === 'RENEWAL'
        ? currentSchool.plan === plan
        : currentPlanRanks[plan] > currentPlanRanks[currentSchool.plan]
          && Boolean(currentSchool.subscriptionExpiresAt && currentSchool.subscriptionExpiresAt.getTime() > paymentRecordedAt.getTime());
    const legacyActivePaymentNeedsReview = !hasBillingSnapshot && activeAtPayment;
    const reviewRequired = !snapshotMatches || !intentStillValid || legacyActivePaymentNeedsReview;
    const completedDetails = {
      ...paymentDetails,
      paymentStatus: 'COMPLETED',
      status: 'ACTIVE',
      transactionId,
      source: 'flutterwave-subscription-verify',
      subscriptionApplied: !reviewRequired,
      subscriptionApplicationStatus: reviewRequired ? 'REVIEW_REQUIRED' : 'APPLIED',
      paymentDateSource: providerCreatedAt && !Number.isNaN(providerCreatedAt.getTime()) ? 'FLUTTERWAVE_CREATED_AT' : 'VERIFIED_AT',
    };
    const claimed = await txClient.platformPayment.updateMany({
      where: { id: payment.id, note: payment.note },
      data: {
        createdAt: paymentRecordedAt,
        method: PaymentMethod.CARD,
        recordedBy: school.id,
        note: JSON.stringify(completedDetails),
      },
    });
    if (claimed.count !== 1) return { school: null, reviewRequired: false };
    if (reviewRequired) return { school: null, reviewRequired: true };

    const updated = await txClient.school.update({
      where: { id: school.id },
      data: { status: 'ACTIVE', plan, subscriptionExpiresAt },
      select: { id: true, name: true, slug: true, status: true, plan: true, subscriptionExpiresAt: true },
    });
    return { school: updated, reviewRequired: false };
  });

  const updatedSchool = applyResult.school;
  if (!updatedSchool && applyResult.reviewRequired) {
    let receiptEmailStatus: 'SENT' | 'FAILED' = 'SENT';
    try {
      await sendSubscriptionReceipt(payment.id);
    } catch (error) {
      receiptEmailStatus = 'FAILED';
      console.error('Flutterwave payment was confirmed for review, but sending its receipt email failed:', error);
    }
    return {
      status: 200,
      body: {
        success: true,
        subscriptionApplied: false,
        message: 'Payment was received, but the subscription changed or expired during checkout. Contact SchoolBase to apply it.',
        reference,
        receiptPaymentId: payment.id,
        receiptEmailStatus,
        transaction: { reference, amount: expectedAmountMinor, currency: expectedCurrency },
      },
    };
  }
  if (!subscriptionExpiresAt) {
    return { status: 500, body: { error: 'The subscription expiry could not be calculated. Contact SchoolBase support.' } };
  }

  if (!updatedSchool) {
    const latest = await prisma.platformPayment.findUnique({ where: { id: payment.id }, select: { note: true } });
    const latestDetails = latest?.note ? parsePaymentDetails(latest.note) : null;
    if (
      latestDetails?.paymentStatus !== 'COMPLETED' ||
      latestDetails.provider !== 'FLUTTERWAVE' ||
      latestDetails.transactionId !== transactionId
    ) {
      return { status: 409, body: { error: 'Payment verification is already in progress. Please retry shortly.' } };
    }
    const alreadyUpdatedSchool = await prisma.school.findUnique({
      where: { id: school.id },
      select: { id: true, name: true, slug: true, status: true, plan: true, subscriptionExpiresAt: true },
    });
    if (!alreadyUpdatedSchool) return { status: 404, body: { error: 'School not found after payment verification.' } };
    return {
      status: 200,
      body: {
        success: true,
        school: alreadyUpdatedSchool,
        receiptPaymentId: payment.id,
        reference,
        subscriptionApplied: latestDetails.subscriptionApplied !== false,
        message: latestDetails.subscriptionApplied === false
          ? 'Payment was received, but the subscription needs SchoolBase review before access can be updated.'
          : undefined,
        transaction: { reference, amount: expectedAmountMinor, currency: expectedCurrency },
      },
    };
  }

  let receiptEmailStatus: 'SENT' | 'FAILED' = 'SENT';
  try {
    await sendSubscriptionReceipt(payment.id);
  } catch (error) {
    receiptEmailStatus = 'FAILED';
    console.error('Flutterwave subscription payment was confirmed, but sending its receipt email failed:', error);
  }

  return {
    status: 200,
    body: { success: true, school: updatedSchool, reference, receiptPaymentId: payment.id, receiptEmailStatus, transaction: { reference, amount: expectedAmountMinor, currency: expectedCurrency } },
  };
}

router.post('/subscription/init', verifyAuth, requireAdmin, async (req: Request, res: Response) => {
  const user = (req as AuthenticatedRequest).user;
  const planLabel = typeof req.body?.plan === 'string' ? req.body.plan.trim().toUpperCase() : '';
  const plan = paymentPlanMap[planLabel];
  if (!user?.schoolId || !plan) {
    return res.status(400).json({ error: 'A signed-in school administrator and supported plan are required.' });
  }

  try {
    const [school, catalog] = await Promise.all([
      prisma.school.findUnique({
        where: { id: user.schoolId },
        select: {
          id: true,
          name: true,
          slug: true,
          country: true,
          currency: true,
          plan: true,
          subscriptionExpiresAt: true,
        },
      }),
      getBillingMarketCatalog(prisma),
    ]);
    if (!school) return res.status(404).json({ error: 'School not found.' });
    const market = getBillingMarket(school.country);
    if (!market || String(school.currency ?? '').trim().toUpperCase() !== market.currency) {
      return res.status(409).json({ error: 'The school billing country and currency do not match.' });
    }

    const pricing = getMarketPricing(
      market,
      catalog,
      Boolean(process.env.PAYSTACK_SECRET_KEY),
      isFlutterwaveSubscriptionConfigured(),
    );
    if (!pricing.checkoutAvailable || pricing.provider !== 'FLUTTERWAVE') {
      return res.status(409).json({ error: 'Flutterwave subscription checkout is not enabled for this billing market.' });
    }

    const planSetting = catalog[market.countryCode].plans[plan];
    if (!planSetting || planSetting.amountMinor <= 0 || planSetting.amountMinor > 2147483647) {
      return res.status(409).json({ error: 'The selected plan does not have a valid online checkout price.' });
    }
    const now = new Date();
    const isPaidPlan = ['STARTER', 'GROWTH', 'ENTERPRISE'].includes(school.plan);
    const hasActivePaidSubscription = isPaidPlan
      && school.subscriptionExpiresAt !== null
      && school.subscriptionExpiresAt.getTime() > now.getTime();
    const requestedIntent = req.body?.billingIntent;
    if (
      requestedIntent !== undefined &&
      requestedIntent !== 'NEW' &&
      requestedIntent !== 'RENEWAL' &&
      requestedIntent !== 'UPGRADE'
    ) {
      return res.status(400).json({ error: 'Choose whether this payment is a new subscription, renewal, or upgrade.' });
    }
    const billingIntent: SubscriptionBillingIntent | null = requestedIntent || (
      hasActivePaidSubscription ? null : 'NEW'
    );
    if (!billingIntent) {
      return res.status(400).json({ error: 'Choose explicitly whether to renew the current plan or upgrade.' });
    }
    let quote: ReturnType<typeof getSubscriptionQuote>;
    try {
      const marketPlans = catalog[market.countryCode].plans;
      quote = getSubscriptionQuote({
        intent: billingIntent,
        currentPlan: school.plan,
        currentExpiry: school.subscriptionExpiresAt,
        targetPlan: plan,
        planPrices: {
          STARTER: marketPlans.STARTER.amountMinor,
          GROWTH: marketPlans.GROWTH.amountMinor,
          ENTERPRISE: marketPlans.ENTERPRISE.amountMinor,
        },
        now,
      });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to calculate the subscription price.' });
    }
    if (!Number.isSafeInteger(req.body?.amountMinor) || req.body.amountMinor !== quote.amountMinor) {
      return res.status(400).json({ error: 'The subscription price has changed. Refresh the page and review the updated amount before paying.' });
    }
    const secretKey = process.env.FLUTTERWAVE_SECRET_KEY?.trim();
    const frontendBaseUrl = getFlutterwaveFrontendBaseUrl();
    if (!secretKey || !frontendBaseUrl) {
      return res.status(503).json({ error: 'Flutterwave checkout is not fully configured on the server.' });
    }
    if (!user.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) {
      return res.status(400).json({ error: 'A valid school administrator email is required for checkout.' });
    }

    const reference = `SB-FLW-${randomUUID()}`;
    const note = JSON.stringify(addSubscriptionBillingMetadata({
      schoolId: school.id,
      schoolName: school.name,
      schoolSlug: school.slug,
      plan,
      schoolPlanAtCheckout: school.plan,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      source: 'flutterwave-subscription-init',
      provider: 'FLUTTERWAVE',
      subscription: true,
      country: market.countryCode,
      currency: market.currency,
      expectedAmountMinor: quote.amountMinor,
    }, quote, school.subscriptionExpiresAt));
    const payment = await prisma.platformPayment.create({
      data: {
        amount: quote.amountMinor,
        method: PaymentMethod.CARD,
        reference,
        recordedBy: school.id,
        note,
      },
      select: { id: true },
    });

    let response: globalThis.Response;
    try {
      response = await fetch(`${FLUTTERWAVE_API_URL}/payments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx_ref: reference,
          amount: quote.amountMinor / 100,
          currency: market.currency,
          redirect_url: `${frontendBaseUrl}/admin/subscription-success`,
          customer: {
            email: user.email,
            name: user.name || user.email,
          },
          customizations: {
            title: 'SchoolBase Subscription',
            description: `${school.name} - ${planSetting.label}`,
          },
          meta: {
            schoolId: school.id,
            plan,
            country: market.countryCode,
            billingIntent: quote.intent,
            amountMinor: quote.amountMinor,
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      await prisma.platformPayment.updateMany({
        where: { id: payment.id, note },
        data: { note: JSON.stringify({ ...JSON.parse(note), paymentStatus: 'FAILED' }) },
      });
      console.error('Flutterwave subscription initialization request failed:', error);
      return res.status(502).json({ error: 'Unable to start Flutterwave checkout. Please try again.' });
    }

    const responseData: unknown = await response.json().catch(() => null);
    const checkoutLink = responseData && typeof responseData === 'object'
      ? (responseData as { data?: { link?: unknown } }).data?.link
      : null;
    let checkoutHost = '';
    let checkoutProtocol = '';
    if (typeof checkoutLink === 'string') {
      try {
        const checkoutUrl = new URL(checkoutLink);
        checkoutHost = checkoutUrl.hostname;
        checkoutProtocol = checkoutUrl.protocol;
      } catch {
        checkoutHost = '';
      }
    }
    if (
      !response.ok ||
      typeof checkoutLink !== 'string' ||
      checkoutHost !== 'checkout.flutterwave.com' ||
      checkoutProtocol !== 'https:'
    ) {
      await prisma.platformPayment.updateMany({
        where: { id: payment.id, note },
        data: { note: JSON.stringify({ ...JSON.parse(note), paymentStatus: 'FAILED' }) },
      });
      console.error('Flutterwave subscription initialization returned an invalid response:', response.status);
      return res.status(502).json({ error: 'Unable to start Flutterwave checkout. Please try again.' });
    }

    return res.json({ authorization_url: checkoutLink, reference });
  } catch (error) {
    console.error('Flutterwave subscription initialization failed:', error);
    return res.status(500).json({ error: 'Unable to start Flutterwave checkout.' });
  }
});

router.post('/public-subscription/init', async (req: Request, res: Response) => {
  const schoolSlug = typeof req.body?.slug === 'string' ? req.body.slug.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const planLabel = typeof req.body?.plan === 'string' ? req.body.plan.trim().toUpperCase() : '';
  const plan = paymentPlanMap[planLabel];

  if (
    !schoolSlug ||
    schoolSlug.length > 120 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    !name ||
    name.length > 120 ||
    !plan ||
    plan === 'ENTERPRISE'
  ) {
    return res.status(400).json({ error: 'A school URL name, valid contact details, and supported paid plan are required.' });
  }

  try {
    const [school, catalog] = await Promise.all([
      prisma.school.findFirst({
        where: { slug: schoolSlug },
        select: {
          id: true,
          name: true,
          slug: true,
          country: true,
          currency: true,
          plan: true,
          subscriptionExpiresAt: true,
          archivedAt: true,
        },
      }),
      getBillingMarketCatalog(prisma),
    ]);
    if (!school) return res.status(404).json({ error: 'School not found for subscription checkout.' });
    if (school.archivedAt) return res.status(409).json({ error: 'Archived schools cannot start subscription checkout.' });
    if (
      ['STARTER', 'GROWTH', 'ENTERPRISE'].includes(school.plan) &&
      school.subscriptionExpiresAt &&
      school.subscriptionExpiresAt.getTime() > Date.now()
    ) {
      return res.status(409).json({ error: 'An active school must sign in as an administrator to choose renewal or upgrade.' });
    }

    const market = getBillingMarket(school.country);
    if (!market || String(school.currency ?? '').trim().toUpperCase() !== market.currency) {
      return res.status(409).json({ error: 'The school billing country and currency do not match.' });
    }

    const pricing = getMarketPricing(
      market,
      catalog,
      Boolean(process.env.PAYSTACK_SECRET_KEY?.trim()),
      isFlutterwaveSubscriptionConfigured(),
    );
    if (!pricing.checkoutAvailable || pricing.provider !== 'FLUTTERWAVE') {
      return res.status(409).json({ error: 'Flutterwave checkout is not enabled for this school billing market.' });
    }

    const planSetting = catalog[market.countryCode].plans[plan];
    if (!planSetting || planSetting.amountMinor <= 0 || planSetting.amountMinor > 2147483647) {
      return res.status(409).json({ error: 'The selected plan does not have a valid online checkout price.' });
    }
    let quote: ReturnType<typeof getSubscriptionQuote>;
    try {
      const marketPlans = catalog[market.countryCode].plans;
      quote = getSubscriptionQuote({
        intent: 'NEW',
        currentPlan: school.plan,
        currentExpiry: school.subscriptionExpiresAt,
        targetPlan: plan,
        planPrices: {
          STARTER: marketPlans.STARTER.amountMinor,
          GROWTH: marketPlans.GROWTH.amountMinor,
          ENTERPRISE: marketPlans.ENTERPRISE.amountMinor,
        },
      });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to calculate the subscription price.' });
    }

    const frontendBaseUrl = getFlutterwaveFrontendBaseUrl();
    if (!frontendBaseUrl) {
      return res.status(503).json({ error: 'Flutterwave checkout is not fully configured on the server.' });
    }

    const reference = `SB-FLW-${randomUUID()}`;
    const note = JSON.stringify(addSubscriptionBillingMetadata({
      schoolId: school.id,
      schoolName: school.name,
      schoolSlug: school.slug,
      plan,
      schoolPlanAtCheckout: school.plan,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      source: 'flutterwave-public-subscription-init',
      provider: 'FLUTTERWAVE',
      subscription: true,
      country: market.countryCode,
      currency: market.currency,
      expectedAmountMinor: quote.amountMinor,
      contactEmail: email,
    }, quote, school.subscriptionExpiresAt));
    const payment = await prisma.platformPayment.create({
      data: {
        amount: quote.amountMinor,
        method: PaymentMethod.CARD,
        reference,
        recordedBy: school.id,
        note,
      },
      select: { id: true },
    });

    let checkoutLink: string;
    try {
      checkoutLink = await initializeFlutterwaveCheckout({
        reference,
        amountMinor: quote.amountMinor,
        currency: market.currency,
        email,
        name,
        schoolName: school.name,
        planLabel: planSetting.label,
        redirectUrl: `${frontendBaseUrl}/admin/subscription-success`,
        meta: {
          schoolId: school.id,
          plan,
          country: market.countryCode,
          billingIntent: quote.intent,
          amountMinor: quote.amountMinor,
        },
      });
    } catch (error) {
      await prisma.platformPayment.updateMany({
        where: { id: payment.id, note },
        data: { note: JSON.stringify({ ...JSON.parse(note), paymentStatus: 'FAILED' }) },
      });
      console.error('Flutterwave public subscription initialization failed:', error);
      return res.status(502).json({ error: 'Unable to start Flutterwave checkout. Please try again.' });
    }

    return res.json({ authorization_url: checkoutLink, reference });
  } catch (error) {
    console.error('Flutterwave public subscription initialization failed:', error);
    return res.status(500).json({ error: 'Unable to start Flutterwave checkout.' });
  }
});

router.post('/subscription/verify', async (req: Request, res: Response) => {
  const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim() : '';
  const transactionId = typeof req.body?.transactionId === 'string' || typeof req.body?.transactionId === 'number'
    ? String(req.body.transactionId).trim()
    : '';
  if (!reference || reference.length > 200 || !/^\d{1,30}$/.test(transactionId)) {
    return res.status(400).json({ error: 'A valid payment reference and Flutterwave transaction ID are required.' });
  }

  try {
    const result = await completeSubscription(reference, transactionId);
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error('Flutterwave subscription verification failed:', error);
    return res.status(500).json({ error: 'Unable to verify the Flutterwave subscription payment.' });
  }
});

router.post('/webhook', async (req: Request, res: Response) => {
  const webhookSecret = getFlutterwaveWebhookSecret();
  const signature = req.get('verif-hash');
  if (!webhookSecret || !signature || !safeEqual(signature, webhookSecret)) {
    return res.status(401).end();
  }

  const payload = req.body as { event?: unknown; data?: { id?: unknown; tx_ref?: unknown; status?: unknown } };
  const transactionId = typeof payload?.data?.id === 'string' || typeof payload?.data?.id === 'number'
    ? String(payload.data.id)
    : '';
  const reference = typeof payload?.data?.tx_ref === 'string' ? payload.data.tx_ref.trim() : '';
  if (payload?.event !== 'charge.completed' || payload.data?.status !== 'successful' || !reference || !/^\d{1,30}$/.test(transactionId)) {
    return res.status(200).end();
  }

  try {
    const result = await completeSubscription(reference, transactionId);
    return res.status(result.status >= 500 ? result.status : 200).end();
  } catch (error) {
    console.error('Flutterwave webhook processing failed:', error);
    return res.status(500).end();
  }
});

export default router;
