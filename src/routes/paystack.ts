// @ts-nocheck
// @ts-nocheck
import { Router, Request, Response } from 'express';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sendPaymentSuccessEmail } from '../jobs/subscriptionEmails.js';
import { getConfiguredPaymentPlans } from '../services/platform-settings.js';
import { getBillingMarketCatalog, getMarketPricing } from '../services/billing-markets.js';
import { getBillingMarket } from '../services/billing-markets.js';
import {
  addSubscriptionBillingMetadata,
  getRenewedExpiry,
  getSubscriptionQuote,
  type SubscriptionBillingIntent,
} from '../services/subscription-billing.js';

const router = Router();
const prisma = new PrismaClient();

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

// GET /api/paystack/status - Safe provider configuration/readiness check
router.get('/status', async (_req: Request, res: Response) => {
  res.json({
    provider: 'Paystack',
    configured: Boolean(PAYSTACK_SECRET_KEY),
    status: PAYSTACK_SECRET_KEY ? 'configured' : 'not_configured',
  });
});

// POST /api/paystack/init - Initialize Paystack payment
router.post('/init', async (req: Request, res: Response) => {
  try {
    const { email, amount, amountMinor, metadata, callback_url, cancel_action } = req.body;

    const normalizedAmount = typeof amount === 'number' ? amount : typeof amountMinor === 'number' ? amountMinor / 100 : null;
    const normalizedCallbackUrl = typeof callback_url === 'string' && callback_url.trim() ? callback_url.trim() : undefined;
    const normalizedCancelAction = typeof cancel_action === 'string' && cancel_action.trim()
      ? cancel_action.trim()
      : normalizedCallbackUrl || normalizedCallbackUrl;

    if (!email || normalizedAmount === null) {
      return res.status(400).json({ error: 'Missing required fields: email and amountMinor/amount' });
    }

    const isSubscription = metadata?.isSubscription === true;
    const requestedPlan = String(metadata?.plan || '').trim().toUpperCase();
    const planMap: Record<string, 'STARTER' | 'GROWTH' | 'ENTERPRISE'> = {
      STARTER: 'STARTER',
      STANDARD: 'GROWTH',
      GROWTH: 'GROWTH',
      ENTERPRISE: 'ENTERPRISE',
    };
    const planLabel = planMap[requestedPlan] || requestedPlan;
    const paymentPlans = await getConfiguredPaymentPlans(prisma);
    if (!paymentPlans && !isSubscription) {
      return res.status(503).json({ error: 'Pricing is temporarily unavailable. Please try again later.' });
    }
    const configuredPlan = paymentPlans ? (paymentPlans as any)[planLabel] : null;
    if (!isSubscription && configuredPlan && configuredPlan.amountMinor > 0 && Math.round(normalizedAmount * 100) !== configuredPlan.amountMinor) {
      return res.status(400).json({ error: 'The selected plan price has changed. Please refresh the page and try again.' });
    }

    const reference = `TXN-${Date.now()}-${crypto.randomUUID()}`;
    let school = null;
    let marketCountry = '';
    let marketCurrency = '';
    let subscriptionQuote = null;
    let subscriptionBillingIntent: SubscriptionBillingIntent | null = null;
    let subscriptionCurrentExpiry: Date | null = null;

    if (isSubscription) {
      const schoolSlug = typeof metadata?.schoolSlug === 'string' ? metadata.schoolSlug.trim() : '';
      const requestedCurrency = typeof req.body.currency === 'string' ? req.body.currency.trim().toUpperCase() : '';
      const requestedAmountMinor = typeof amountMinor === 'number' ? amountMinor : NaN;

      if (!schoolSlug || !Number.isSafeInteger(requestedAmountMinor) || requestedAmountMinor <= 0 || !planMap[requestedPlan]) {
        return res.status(400).json({ error: 'A school, supported plan, and valid amount are required for subscription checkout.' });
      }

      school = await prisma.school.findFirst({
        where: { slug: schoolSlug },
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

      if (!school) return res.status(404).json({ error: 'School not found for subscription checkout.' });

      const schoolMarket = getBillingMarket(school.country);
      marketCountry = schoolMarket?.countryCode || '';
      marketCurrency = schoolMarket?.currency || '';
      if (
        !schoolMarket ||
        String(school.currency || '').trim().toUpperCase() !== marketCurrency ||
        requestedCurrency !== marketCurrency
      ) {
        return res.status(409).json({ error: 'Online subscription checkout is not enabled for this school billing market.' });
      }
      const catalog = await getBillingMarketCatalog(prisma);
      const marketPricing = getMarketPricing(schoolMarket, catalog, Boolean(PAYSTACK_SECRET_KEY));
      const marketPlans = catalog[schoolMarket.countryCode].plans;
      const marketPlan = marketPlans[planMap[requestedPlan]];
      if (!marketPricing.checkoutAvailable || marketPricing.provider !== 'PAYSTACK') {
        return res.status(409).json({ error: 'Online subscription checkout is not enabled for this school billing market.' });
      }
      if (!PAYSTACK_SECRET_KEY) {
        return res.status(503).json({ error: 'Paystack is not configured for subscription checkout.' });
      }
      if (!marketPlan || marketPlan.amountMinor <= 0) {
        return res.status(400).json({ error: 'The selected plan price is unavailable or has changed. Refresh the page before trying again.' });
      }
      const now = new Date();
      const hasActivePaidSubscription = ['STARTER', 'GROWTH', 'ENTERPRISE'].includes(school.plan)
        && school.subscriptionExpiresAt !== null
        && school.subscriptionExpiresAt.getTime() > now.getTime();
      const requestedIntent = metadata?.billingIntent;
      if (
        requestedIntent !== undefined &&
        requestedIntent !== 'NEW' &&
        requestedIntent !== 'RENEWAL' &&
        requestedIntent !== 'UPGRADE'
      ) {
        return res.status(400).json({ error: 'Choose whether this payment is a new subscription, renewal, or upgrade.' });
      }
      subscriptionBillingIntent = requestedIntent || (hasActivePaidSubscription ? null : 'NEW');
      if (!subscriptionBillingIntent) {
        return res.status(400).json({ error: 'Choose Upgrade explicitly to change an active subscription plan.' });
      }
      subscriptionCurrentExpiry = school.subscriptionExpiresAt;
      try {
        subscriptionQuote = getSubscriptionQuote({
          intent: subscriptionBillingIntent,
          currentPlan: school.plan,
          currentExpiry: school.subscriptionExpiresAt,
          targetPlan: planMap[requestedPlan],
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
      if (requestedAmountMinor !== subscriptionQuote.amountMinor) {
        return res.status(400).json({ error: 'The subscription price has changed. Refresh the page and review the updated amount before paying.' });
      }
    }

    const resolvedAmountMinor = isSubscription
      ? subscriptionQuote.amountMinor
      : Math.round(normalizedAmount * 100);

    // Build metadata for Paystack while preserving the original values for verification.
    const paystackMetadata = {
      plan: isSubscription ? planLabel : metadata?.plan || '',
      schoolName: isSubscription ? school.name : metadata?.schoolName || '',
      schoolSlug: isSubscription ? school.slug : metadata?.schoolSlug || metadata?.slug || '',
      schoolId: isSubscription ? school.id : '',
      country: isSubscription ? marketCountry : '',
      currency: isSubscription ? marketCurrency : '',
      isSubscription,
      billingIntent: subscriptionBillingIntent,
      name: metadata?.name || '',
      phone: metadata?.phone || '',
      amountMinor: resolvedAmountMinor,
      custom_fields: [
        { display_name: 'Plan', variable_name: 'plan', value: metadata?.plan || '' },
        { display_name: 'School Name', variable_name: 'school_name', value: metadata?.schoolName || '' },
        { display_name: 'Contact Name', variable_name: 'contact_name', value: metadata?.name || '' },
        { display_name: 'Contact Phone', variable_name: 'contact_phone', value: metadata?.phone || '' },
      ],
    };

    if (!school) {
      school = metadata?.schoolSlug || metadata?.slug || metadata?.schoolName
        ? await prisma.school.findFirst({
          where: metadata?.schoolSlug || metadata?.slug
            ? { slug: String(metadata.schoolSlug || metadata.slug) }
            : { name: String(metadata.schoolName) },
          select: { id: true, name: true, slug: true, country: true, currency: true },
        })
        : null;
    }

    const existingPlatformPayment = await prisma.platformPayment.findFirst({
      where: { reference },
      select: { id: true },
    });

    if (!existingPlatformPayment) {
      await prisma.platformPayment.create({
        data: {
          amount: resolvedAmountMinor,
          method: 'CARD',
          reference,
          recordedBy: school?.id || null,
          note: JSON.stringify(addSubscriptionBillingMetadata({
            schoolId: school?.id || null,
            schoolName: school?.name || metadata?.schoolName || '',
            schoolSlug: school?.slug || metadata?.schoolSlug || metadata?.slug || '',
            plan: isSubscription ? planLabel : metadata?.plan || '',
            status: 'PENDING',
            paymentStatus: 'PENDING',
            source: 'paystack-init',
            subscription: isSubscription,
            country: isSubscription ? marketCountry : undefined,
            currency: isSubscription ? marketCurrency : undefined,
            expectedAmountMinor: isSubscription ? resolvedAmountMinor : undefined,
            schoolPlanAtCheckout: isSubscription ? school.plan : undefined,
          }, subscriptionQuote, subscriptionCurrentExpiry)),
        },
      });
    }

    // Initialize transaction with Paystack
    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        email,
        amount: resolvedAmountMinor,
        ...(isSubscription ? { currency: marketCurrency } : {}),
        reference,
        metadata: paystackMetadata,
        callback_url: normalizedCallbackUrl,
        cancel_action: normalizedCancelAction,
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json(response.data);
  } catch (error: any) {
    console.error('Error initializing Paystack payment:', {
      message: error.message,
      responseData: error.response?.data,
    });
    const statusCode = error.response?.status || 500;
    res.status(statusCode).json({
      error: 'Failed to initialize payment',
      details: error.response?.data || error.message,
    });
  }
});

// POST /api/paystack/verify-subscription - Verify and activate a subscription payment
router.post('/verify-subscription', async (req: Request, res: Response) => {
  try {
    const { reference } = req.body;

    if (typeof reference !== 'string' || !reference.trim() || reference.length > 200) {
      return res.status(400).json({ error: 'Missing reference' });
    }

    const payment = await prisma.platformPayment.findFirst({
      where: { reference: reference.trim() },
    });
    if (!payment || !payment.note) {
      return res.status(404).json({ error: 'A matching server-created payment was not found.' });
    }

    let paymentDetails: Record<string, any>;
    try {
      paymentDetails = JSON.parse(payment.note);
    } catch {
      return res.status(400).json({ error: 'The payment record is invalid and requires support review.' });
    }

    if (paymentDetails.paymentStatus === 'COMPLETED') {
      const completedSchoolId = paymentDetails.schoolId || payment.recordedBy;
      const completedSchool = completedSchoolId
        ? await prisma.school.findUnique({
          where: { id: completedSchoolId },
          select: { id: true, name: true, slug: true, status: true, plan: true, subscriptionExpiresAt: true },
        })
        : null;
      if (!completedSchool) return res.status(404).json({ error: 'School not found for completed payment.' });
      return res.json({
        success: true,
        school: completedSchool,
        subscriptionApplied: paymentDetails.subscriptionApplied !== false,
        message: paymentDetails.subscriptionApplied === false
          ? 'Payment was received, but the subscription needs SchoolBase review before access can be updated.'
          : undefined,
        transaction: { reference: reference.trim(), amount: payment.amount, currency: paymentDetails.currency || 'NGN' },
      });
    }
    if (paymentDetails.source !== 'paystack-init' || paymentDetails.subscription !== true) {
      return res.status(400).json({ error: 'The payment record is not a subscription checkout.' });
    }

    const verifyResponse = await axios.get(
      `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference.trim())}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const transaction = verifyResponse.data?.data;
    const metadata = transaction?.metadata || {};
    if (
      !transaction ||
      transaction.status !== 'success' ||
      transaction.reference !== reference.trim()
    ) {
      return res.status(400).json({ error: 'Payment not completed' });
    }
    const providerPaidAt = typeof transaction.paid_at === 'string' ? new Date(transaction.paid_at) : null;
    const paymentRecordedAt = providerPaidAt && !Number.isNaN(providerPaidAt.getTime()) ? providerPaidAt : new Date();

    const schoolId = paymentDetails.schoolId || payment.recordedBy;
    if (!schoolId) return res.status(400).json({ error: 'The payment is not linked to a school.' });

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        id: true,
        name: true,
        slug: true,
        country: true,
        currency: true,
        status: true,
        plan: true,
        subscriptionExpiresAt: true,
      },
    });
    if (!school) return res.status(404).json({ error: 'School not found for subscription verification' });
    const schoolMarket = getBillingMarket(school.country);

    const planLabel = String(paymentDetails.plan || metadata.plan || '').trim().toUpperCase();
    const planMap: Record<string, 'STARTER' | 'GROWTH' | 'ENTERPRISE'> = {
      STARTER: 'STARTER',
      STANDARD: 'GROWTH',
      GROWTH: 'GROWTH',
      ENTERPRISE: 'ENTERPRISE',
    };
    const nextPlan = planMap[planLabel];
    if (!nextPlan) {
      return res.status(400).json({ error: 'The payment does not contain a supported subscription plan.' });
    }

    const currentCatalog = await getBillingMarketCatalog(prisma);
    const configuredPlan = currentCatalog.NG.plans[nextPlan];
    const snapshotAmount = Number(paymentDetails.expectedAmountMinor);
    const expectedAmountMinor = Number.isSafeInteger(snapshotAmount) && snapshotAmount > 0
      ? snapshotAmount
      : configuredPlan?.amountMinor;
    const transactionAmount = Number(transaction.amount);

    if (
      schoolMarket?.countryCode !== 'NG' ||
      String(school.currency || '').trim().toUpperCase() !== schoolMarket.currency ||
      String(transaction.currency || '').trim().toUpperCase() !== 'NGN' ||
      !Number.isSafeInteger(expectedAmountMinor) ||
      expectedAmountMinor <= 0 ||
      payment.amount !== expectedAmountMinor ||
      transactionAmount !== expectedAmountMinor ||
      (paymentDetails.currency && String(paymentDetails.currency).toUpperCase() !== 'NGN') ||
      (paymentDetails.country && String(paymentDetails.country).toUpperCase() !== 'NG')
    ) {
      return res.status(400).json({ error: 'The verified payment does not match the school, market, currency, and plan amount.' });
    }

    const billingIntent: SubscriptionBillingIntent = ['NEW', 'RENEWAL', 'UPGRADE'].includes(paymentDetails.billingIntent)
      ? paymentDetails.billingIntent
      : 'NEW';
    const previousExpiry = typeof paymentDetails.previousExpiry === 'string'
      ? new Date(paymentDetails.previousExpiry)
      : null;
    const hasBillingSnapshot = ['NEW', 'RENEWAL', 'UPGRADE'].includes(paymentDetails.billingIntent)
      && Object.hasOwn(paymentDetails, 'previousExpiry')
      && Object.hasOwn(paymentDetails, 'schoolPlanAtCheckout');
    const paidAt = paymentRecordedAt;
    const subscriptionExpiresAt = billingIntent === 'UPGRADE'
      ? previousExpiry
      : billingIntent === 'RENEWAL'
        ? getRenewedExpiry(previousExpiry, paidAt)
        : getRenewedExpiry(null, paidAt);
    const applyResult = await prisma.$transaction(async (tx) => {
      const currentSchool = await tx.school.findUnique({
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
        currentSchool.subscriptionExpiresAt.getTime() > paidAt.getTime(),
      );
      const intentStillValid = billingIntent === 'NEW'
        ? !activeAtPayment
        : billingIntent === 'RENEWAL'
          ? currentSchool.plan === nextPlan
          : currentPlanRanks[nextPlan] > currentPlanRanks[currentSchool.plan]
            && Boolean(currentSchool.subscriptionExpiresAt && currentSchool.subscriptionExpiresAt.getTime() > paidAt.getTime());
      const legacyActivePaymentNeedsReview = !hasBillingSnapshot && activeAtPayment;
      const reviewRequired = !snapshotMatches || !intentStillValid || legacyActivePaymentNeedsReview;
      const completedDetails = {
        ...paymentDetails,
        schoolId: school.id,
        schoolName: school.name,
        schoolSlug: school.slug,
        plan: nextPlan,
        country: 'NG',
        currency: 'NGN',
        expectedAmountMinor,
        status: 'ACTIVE',
        paymentStatus: 'COMPLETED',
        source: 'paystack-verify',
        subscriptionApplied: !reviewRequired,
        subscriptionApplicationStatus: reviewRequired ? 'REVIEW_REQUIRED' : 'APPLIED',
        paymentDateSource: providerPaidAt && !Number.isNaN(providerPaidAt.getTime()) ? 'PAYSTACK_PAID_AT' : 'VERIFIED_AT',
      };
      const claimed = await tx.platformPayment.updateMany({
        where: { id: payment.id, note: payment.note },
        data: {
          createdAt: paymentRecordedAt,
          method: 'CARD',
          recordedBy: school.id,
          note: JSON.stringify(completedDetails),
        },
      });
      if (claimed.count !== 1) return { school: null, reviewRequired: false };
      if (reviewRequired) return { school: null, reviewRequired: true };

      const updated = await tx.school.update({
        where: { id: school.id },
        data: {
          status: 'ACTIVE',
          plan: nextPlan,
          subscriptionExpiresAt,
        },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          plan: true,
          subscriptionExpiresAt: true,
        },
      });
      return { school: updated, reviewRequired: false };
    });

    const updatedSchool = applyResult.school;
    if (!updatedSchool && applyResult.reviewRequired) {
      return res.json({
        success: true,
        subscriptionApplied: false,
        message: 'Payment was received, but the subscription changed or expired during checkout. Contact SchoolBase to apply it.',
        reference: transaction.reference,
        transaction: { reference: transaction.reference, amount: expectedAmountMinor, currency: 'NGN' },
      });
    }

    if (!updatedSchool) {
      const latestPayment = await prisma.platformPayment.findUnique({
        where: { id: payment.id },
        select: { note: true },
      });
      let latestPaymentDetails: Record<string, any> | null = null;
      if (latestPayment?.note) {
        try {
          latestPaymentDetails = JSON.parse(latestPayment.note);
        } catch {
          return res.status(500).json({ error: 'The payment status could not be confirmed. Contact SchoolBase support with your payment reference.' });
        }
      }
      if (latestPaymentDetails?.paymentStatus !== 'COMPLETED') {
        return res.status(409).json({ error: 'Payment verification is already in progress. Please retry shortly or contact support.' });
      }

      const alreadyUpdatedSchool = await prisma.school.findUnique({
        where: { id: school.id },
        select: { id: true, name: true, slug: true, status: true, plan: true, subscriptionExpiresAt: true },
      });
      if (!alreadyUpdatedSchool) return res.status(404).json({ error: 'School not found after payment verification.' });
      return res.json({
        success: true,
        school: alreadyUpdatedSchool,
        transaction: { reference: transaction.reference, amount: expectedAmountMinor, currency: 'NGN' },
      });
    }

    // Send payment success email
    try {
      const admin = await prisma.user.findFirst({
        where: {
          schoolId: school.id,
          role: 'SCHOOL_ADMIN',
        },
        select: { email: true, name: true },
      });

      if (admin?.email) {
        const amountFormatted = (expectedAmountMinor / 100).toLocaleString('en-NG', {
          style: 'currency',
          currency: 'NGN',
          minimumFractionDigits: 2,
        });

        const expiryDate = subscriptionExpiresAt.toLocaleDateString('en-NG', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });

        await sendPaymentSuccessEmail(
          admin.email,
          updatedSchool.name,
          admin.name,
          nextPlan,
          amountFormatted,
          expiryDate
        );
      }
    } catch (emailError) {
      console.error('Error sending payment success email:', emailError);
      // Don't fail the subscription verification if email fails
    }

    res.json({
      success: true,
      school: updatedSchool,
      transaction: {
        reference: transaction.reference,
        amount: expectedAmountMinor,
        currency: 'NGN',
      },
    });
  } catch (error: any) {
    console.error('Error verifying subscription payment:', error);
    res.status(500).json({
      error: 'Failed to verify subscription payment',
      details: error.response?.data || error.message,
    });
  }
});

export default router;
