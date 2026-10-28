import { PrismaClient } from '@prisma/client';
import {
  getConfiguredPaymentPlans,
  getPublicPaymentPlans,
  parsePlatformSettingValue,
} from './platform-settings.js';

export const billingMarkets = {
  NG: {
    countryCode: 'NG',
    countryName: 'Nigeria',
    currency: 'NGN',
    locale: 'en-NG',
    currencyExponent: 2,
  },
  GH: {
    countryCode: 'GH',
    countryName: 'Ghana',
    currency: 'GHS',
    locale: 'en-GH',
    currencyExponent: 2,
  },
  SL: {
    countryCode: 'SL',
    countryName: 'Sierra Leone',
    currency: 'SLE',
    locale: 'en-SL',
    currencyExponent: 2,
  },
  LR: {
    countryCode: 'LR',
    countryName: 'Liberia',
    currency: 'LRD',
    locale: 'en-LR',
    currencyExponent: 2,
  },
  GM: {
    countryCode: 'GM',
    countryName: 'The Gambia',
    currency: 'GMD',
    locale: 'en-GM',
    currencyExponent: 2,
  },
} as const;

export type BillingMarketCode = keyof typeof billingMarkets;
export type BillingMarket = (typeof billingMarkets)[BillingMarketCode];
export type BillingProvider = 'PAYSTACK' | 'FLUTTERWAVE';
export type BillingPlanCode = 'STARTER' | 'GROWTH' | 'ENTERPRISE';
export type BillingPricingStatus = 'DRAFT' | 'PUBLISHED';

export function getFlutterwaveWebhookSecret(
  environment: {
    FLUTTERWAVE_WEBHOOK_SECRET_HASH?: string;
    FLUTTERWAVE_WEBHOOK_SECRET?: string;
  } = process.env,
): string | null {
  const secret = environment.FLUTTERWAVE_WEBHOOK_SECRET_HASH?.trim()
    || environment.FLUTTERWAVE_WEBHOOK_SECRET?.trim();
  return secret || null;
}

export function getFlutterwaveFrontendBaseUrl(configuredUrl = process.env.FRONTEND_URL): string | null {
  const firstUrl = configuredUrl?.split(',')[0]?.trim();
  if (!firstUrl) return null;
  try {
    const url = new URL(firstUrl);
    const isLocalDevelopmentUrl =
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !isLocalDevelopmentUrl)
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isFlutterwaveSubscriptionConfigured(
  environment: {
    FLUTTERWAVE_SECRET_KEY?: string;
    FLUTTERWAVE_WEBHOOK_SECRET_HASH?: string;
    FLUTTERWAVE_WEBHOOK_SECRET?: string;
    FRONTEND_URL?: string;
  } = process.env,
): boolean {
  return Boolean(
    environment.FLUTTERWAVE_SECRET_KEY?.trim() &&
    getFlutterwaveWebhookSecret(environment) &&
    getFlutterwaveFrontendBaseUrl(environment.FRONTEND_URL),
  );
}

export interface BillingPlanSetting {
  label: string;
  amountMinor: number;
  studentLimit: number | null;
  customPriceLabel: string;
}

export interface BillingMarketSetting {
  pricingStatus: BillingPricingStatus;
  provider: BillingProvider;
  providerVerified: boolean;
  checkoutEnabled: boolean;
  plans: Record<BillingPlanCode, BillingPlanSetting>;
}

export type BillingMarketCatalog = Record<BillingMarketCode, BillingMarketSetting>;

const billingMarketAliases: Record<string, BillingMarketCode> = {
  NIGERIA: 'NG',
  GHANA: 'GH',
  'SIERRA LEONE': 'SL',
  LIBERIA: 'LR',
  GAMBIA: 'GM',
  'THE GAMBIA': 'GM',
};

const marketPlanDefaults: Record<BillingMarketCode, Record<BillingPlanCode, BillingPlanSetting>> = {
  NG: {
    STARTER: { label: 'Starter', amountMinor: 6000000, studentLimit: 150, customPriceLabel: '' },
    GROWTH: { label: 'Growth', amountMinor: 8500000, studentLimit: 600, customPriceLabel: '' },
    ENTERPRISE: { label: 'Enterprise', amountMinor: 0, studentLimit: null, customPriceLabel: 'Custom pricing' },
  },
  GH: {
    STARTER: { label: 'Starter', amountMinor: 48000, studentLimit: 150, customPriceLabel: '' },
    GROWTH: { label: 'Growth', amountMinor: 68000, studentLimit: 600, customPriceLabel: '' },
    ENTERPRISE: { label: 'Enterprise', amountMinor: 0, studentLimit: null, customPriceLabel: 'Custom from GHS1,200' },
  },
  SL: {
    STARTER: { label: 'Starter', amountMinor: 800000, studentLimit: 150, customPriceLabel: '' },
    GROWTH: { label: 'Growth', amountMinor: 1100000, studentLimit: 600, customPriceLabel: '' },
    ENTERPRISE: { label: 'Enterprise', amountMinor: 0, studentLimit: null, customPriceLabel: 'Custom from Le 2,000,000' },
  },
  LR: {
    STARTER: { label: 'Starter', amountMinor: 7500, studentLimit: 150, customPriceLabel: '' },
    GROWTH: { label: 'Growth', amountMinor: 10000, studentLimit: 600, customPriceLabel: '' },
    ENTERPRISE: { label: 'Enterprise', amountMinor: 0, studentLimit: null, customPriceLabel: 'Custom from L$18,000' },
  },
  GM: {
    STARTER: { label: 'Starter', amountMinor: 2500, studentLimit: 150, customPriceLabel: '' },
    GROWTH: { label: 'Growth', amountMinor: 3500, studentLimit: 600, customPriceLabel: '' },
    ENTERPRISE: { label: 'Enterprise', amountMinor: 0, studentLimit: null, customPriceLabel: 'Custom from D6,500' },
  },
};

export const defaultBillingMarketCatalog: BillingMarketCatalog = {
  NG: {
    pricingStatus: 'PUBLISHED',
    provider: 'PAYSTACK',
    providerVerified: false,
    checkoutEnabled: true,
    plans: marketPlanDefaults.NG,
  },
  GH: {
    pricingStatus: 'DRAFT',
    provider: 'FLUTTERWAVE',
    providerVerified: false,
    checkoutEnabled: false,
    plans: marketPlanDefaults.GH,
  },
  SL: {
    pricingStatus: 'DRAFT',
    provider: 'FLUTTERWAVE',
    providerVerified: false,
    checkoutEnabled: false,
    plans: marketPlanDefaults.SL,
  },
  LR: {
    pricingStatus: 'DRAFT',
    provider: 'FLUTTERWAVE',
    providerVerified: false,
    checkoutEnabled: false,
    plans: marketPlanDefaults.LR,
  },
  GM: {
    pricingStatus: 'DRAFT',
    provider: 'FLUTTERWAVE',
    providerVerified: false,
    checkoutEnabled: false,
    plans: marketPlanDefaults.GM,
  },
};

export function getBillingMarket(countryCode: unknown): BillingMarket | null {
  if (typeof countryCode !== 'string') return null;
  const normalizedCountryCode = countryCode.trim().toUpperCase();
  const canonicalCountryCode = Object.hasOwn(billingMarkets, normalizedCountryCode)
    ? normalizedCountryCode as BillingMarketCode
    : billingMarketAliases[normalizedCountryCode];
  return canonicalCountryCode ? billingMarkets[canonicalCountryCode] : null;
}

export function isValidBillingMarketCatalog(value: unknown): value is BillingMarketCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const catalog = value as Record<string, unknown>;
  const marketCodes = Object.keys(billingMarkets) as BillingMarketCode[];
  if (Object.keys(catalog).length !== marketCodes.length || marketCodes.some((code) => !(code in catalog))) {
    return false;
  }

  return marketCodes.every((code) => {
    const market = catalog[code];
    if (!market || typeof market !== 'object' || Array.isArray(market)) return false;
    const setting = market as Record<string, unknown>;
    if (
      (setting.pricingStatus !== 'DRAFT' && setting.pricingStatus !== 'PUBLISHED') ||
      (setting.provider !== 'PAYSTACK' && setting.provider !== 'FLUTTERWAVE') ||
      typeof setting.providerVerified !== 'boolean' ||
      typeof setting.checkoutEnabled !== 'boolean' ||
      !setting.plans ||
      typeof setting.plans !== 'object' ||
      Array.isArray(setting.plans)
    ) return false;

    const plans = setting.plans as Record<string, unknown>;
    const planCodes: BillingPlanCode[] = ['STARTER', 'GROWTH', 'ENTERPRISE'];
    if (Object.keys(plans).length !== planCodes.length || planCodes.some((plan) => !(plan in plans))) return false;

    const validPlans = planCodes.every((plan) => {
      const item = plans[plan];
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const planSetting = item as Record<string, unknown>;
      return typeof planSetting.label === 'string' &&
        planSetting.label.trim().length > 0 &&
        planSetting.label.length <= 80 &&
        Number.isSafeInteger(planSetting.amountMinor) &&
        Number(planSetting.amountMinor) >= 0 &&
        (planSetting.studentLimit === null ||
          (Number.isSafeInteger(planSetting.studentLimit) && Number(planSetting.studentLimit) > 0)) &&
        typeof planSetting.customPriceLabel === 'string' &&
        planSetting.customPriceLabel.length <= 120;
    });
    if (!validPlans) return false;

    return setting.pricingStatus !== 'PUBLISHED' ||
      (Number((plans.STARTER as Record<string, unknown>).amountMinor) > 0 &&
        Number((plans.GROWTH as Record<string, unknown>).amountMinor) > 0);
  });
}

export async function getBillingMarketCatalog(prisma: PrismaClient): Promise<BillingMarketCatalog> {
  const entry = await prisma.platformSetting.findUnique({ where: { key: 'billingMarketPricing' } });
  if (entry) {
    const parsed = parsePlatformSettingValue(entry.value);
    if (!isValidBillingMarketCatalog(parsed)) {
      throw new Error('The saved country billing catalog is invalid. Review platform billing settings.');
    }
    return parsed;
  }

  const catalog: BillingMarketCatalog = structuredClone(defaultBillingMarketCatalog);
  const legacyNigeriaPlans = await getConfiguredPaymentPlans(prisma);
  if (!legacyNigeriaPlans) {
    throw new Error('Nigeria plan pricing is unavailable. Configure valid platform payment plans before loading the billing catalog.');
  }
  for (const plan of ['STARTER', 'GROWTH', 'ENTERPRISE'] as const) {
    const legacyPlan = legacyNigeriaPlans[plan];
    catalog.NG.plans[plan] = {
      label: legacyPlan.label,
      amountMinor: legacyPlan.amountMinor,
      studentLimit: legacyPlan.studentLimit,
      customPriceLabel: legacyPlan.amountMinor === 0 ? legacyPlan.priceLabel : '',
    };
  }
  return catalog;
}

export function getMarketPricing(
  market: BillingMarket,
  catalog: BillingMarketCatalog,
  paystackConfigured = false,
  flutterwaveConfigured = false,
) {
  const setting = catalog[market.countryCode as BillingMarketCode];
  const planSettings = setting.plans;
  const publicPlans = setting.pricingStatus === 'PUBLISHED'
    ? getPublicPaymentPlans({
      STARTER: { ...planSettings.STARTER, priceLabel: planSettings.STARTER.customPriceLabel },
      GROWTH: { ...planSettings.GROWTH, priceLabel: planSettings.GROWTH.customPriceLabel },
      ENTERPRISE: { ...planSettings.ENTERPRISE, priceLabel: planSettings.ENTERPRISE.customPriceLabel },
    }, market.currency, market.locale, market.currencyExponent)
    : null;
  const providerIntegrationAvailable = setting.provider === 'PAYSTACK'
    ? market.countryCode === 'NG' && paystackConfigured
    : market.countryCode !== 'NG' && flutterwaveConfigured;
  const providerReviewComplete = market.countryCode === 'NG' || setting.providerVerified;
  const checkoutAvailable = setting.pricingStatus === 'PUBLISHED' &&
    setting.checkoutEnabled &&
    providerReviewComplete &&
    providerIntegrationAvailable;

  return {
    market,
    pricingStatus: setting.pricingStatus,
    checkoutAvailable,
    provider: checkoutAvailable ? setting.provider : null,
    plans: publicPlans,
  };
}
