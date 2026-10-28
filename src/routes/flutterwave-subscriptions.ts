import { PaymentMethod, PrismaClient } from '@prisma/client';
import { Router, Request, Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { sendPaymentSuccessEmail } from '../jobs/subscriptionEmails.js';
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
      body: { success: true, school, reference, transaction: { reference, amount: payment.amount, currency: paymentDetails.currency } },
    };
  }

  if (
    paymentDetails.source !== 'flutterwave-subscription-init' ||
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
    select: { id: true, name: true, slug: true, country: true, currency: true },
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

  const subscriptionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const updatedSchool = await prisma.$transaction(async (txClient) => {
    const completedDetails = {
      ...paymentDetails,
      paymentStatus: 'COMPLETED',
      status: 'ACTIVE',
      transactionId,
      source: 'flutterwave-subscription-verify',
    };
    const claimed = await txClient.platformPayment.updateMany({
      where: { id: payment.id, note: payment.note },
      data: {
        method: PaymentMethod.CARD,
        recordedBy: school.id,
        note: JSON.stringify(completedDetails),
      },
    });
    if (claimed.count !== 1) return null;

    return txClient.school.update({
      where: { id: school.id },
      data: { status: 'ACTIVE', plan, subscriptionExpiresAt },
      select: { id: true, name: true, slug: true, status: true, plan: true, subscriptionExpiresAt: true },
    });
  });

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
      body: { success: true, school: alreadyUpdatedSchool, reference, transaction: { reference, amount: expectedAmountMinor, currency: expectedCurrency } },
    };
  }

  try {
    const admin = await prisma.user.findFirst({
      where: { schoolId: school.id, role: 'SCHOOL_ADMIN' },
      select: { email: true, name: true },
    });
    if (admin?.email) {
      const amountFormatted = new Intl.NumberFormat(market.locale, {
        style: 'currency',
        currency: market.currency,
        minimumFractionDigits: 2,
      }).format(expectedAmountMinor / 100);
      const expiryDate = subscriptionExpiresAt.toLocaleDateString(market.locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      await sendPaymentSuccessEmail(admin.email, updatedSchool.name, admin.name, plan, amountFormatted, expiryDate);
    }
  } catch (error) {
    console.error('Failed to send Flutterwave subscription confirmation email:', error);
  }

  return {
    status: 200,
    body: { success: true, school: updatedSchool, reference, transaction: { reference, amount: expectedAmountMinor, currency: expectedCurrency } },
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
        select: { id: true, name: true, slug: true, country: true, currency: true },
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
    const secretKey = process.env.FLUTTERWAVE_SECRET_KEY?.trim();
    const frontendBaseUrl = getFlutterwaveFrontendBaseUrl();
    if (!secretKey || !frontendBaseUrl) {
      return res.status(503).json({ error: 'Flutterwave checkout is not fully configured on the server.' });
    }
    if (!user.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) {
      return res.status(400).json({ error: 'A valid school administrator email is required for checkout.' });
    }

    const reference = `SB-FLW-${randomUUID()}`;
    const note = JSON.stringify({
      schoolId: school.id,
      schoolName: school.name,
      schoolSlug: school.slug,
      plan,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      source: 'flutterwave-subscription-init',
      provider: 'FLUTTERWAVE',
      subscription: true,
      country: market.countryCode,
      currency: market.currency,
      expectedAmountMinor: planSetting.amountMinor,
    });
    const payment = await prisma.platformPayment.create({
      data: {
        amount: planSetting.amountMinor,
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
          amount: planSetting.amountMinor / 100,
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
