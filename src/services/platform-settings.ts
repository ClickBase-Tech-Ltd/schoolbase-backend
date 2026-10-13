import { PrismaClient } from '@prisma/client';

export const competitionFeatureKeys = [
  'competition.enabled',
  'competition.dailyChallenge.enabled',
  'competition.examPractice.enabled',
  'competition.questionBank.enabled',
  'competition.leaderboard.enabled',
  'competition.gamification.enabled',
  'competition.studentVsStudent.enabled',
  'competition.classCompetition.enabled',
  'competition.schoolTournament.enabled',
  'competition.publicTournament.enabled',
  'competition.sponsors.enabled',
  'competition.prizes.enabled',
  'competition.certificates.enabled',
  'competition.regional.enabled',
  'competition.national.enabled',
  'competition.international.enabled',
] as const;

export type CompetitionFeatureKey = typeof competitionFeatureKeys[number];

export const competitionFeatureDefaults = Object.fromEntries(
  competitionFeatureKeys.map((key) => [key, false]),
) as Record<CompetitionFeatureKey, boolean>;

export const platformSettingDefaults = {
  maintenanceMode: false,
  allowSignup: true,
  allowTrial: true,
  autoApproveSchools: false,
  supportEmail: 'support@schoolbase.live',
  signupNotificationRecipients: [],
  supportNotificationRecipients: [],
  competitionFeatures: competitionFeatureDefaults,
  paymentPlans: {
    STARTER: { label: 'Starter', priceLabel: '₦60,000 / term', amountMinor: 6000000, studentLimit: 150 },
    GROWTH: { label: 'Growth', priceLabel: '₦85,000 / term', amountMinor: 8500000, studentLimit: 600 },
    ENTERPRISE: { label: 'Enterprise', priceLabel: 'Custom pricing', amountMinor: 0, studentLimit: null },
  },
};

export function normalizeEmailList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return Array.from(new Set(values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))));
}

export function getPaymentPlans(settings: Record<string, unknown>) {
  const candidate = settings.paymentPlans && typeof settings.paymentPlans === 'object'
    ? settings.paymentPlans
    : settings;
  const defaults = platformSettingDefaults.paymentPlans;
  const source = candidate && typeof candidate === 'object' ? candidate as Record<string, any> : {};

  return {
    STARTER: { ...defaults.STARTER, ...(source.STARTER ?? {}) },
    GROWTH: { ...defaults.GROWTH, ...(source.GROWTH ?? {}) },
    ENTERPRISE: { ...defaults.ENTERPRISE, ...(source.ENTERPRISE ?? {}) },
  };
}

export function isValidPaymentPlans(value: unknown): value is typeof platformSettingDefaults.paymentPlans {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const plans = value as Record<string, any>;
  return ['STARTER', 'GROWTH', 'ENTERPRISE'].every((plan) => {
    const config = plans[plan];
    return Boolean(
      config &&
      typeof config.label === 'string' &&
      config.label.trim() &&
      typeof config.priceLabel === 'string' &&
      config.priceLabel.trim() &&
      Number.isInteger(config.amountMinor) &&
      config.amountMinor >= 0 &&
      (config.studentLimit === null || (Number.isInteger(config.studentLimit) && config.studentLimit > 0))
    );
  });
}

export async function getConfiguredPaymentPlans(prisma: PrismaClient) {
  const entry = await prisma.platformSetting.findUnique({ where: { key: 'paymentPlans' } });
  if (!entry) return null;

  const parsed = parsePlatformSettingValue(entry.value);
  return isValidPaymentPlans(parsed) ? getPaymentPlans(parsed as Record<string, unknown>) : null;
}

export async function ensurePlatformPaymentPlans(prisma: PrismaClient) {
  const existing = await prisma.platformSetting.findUnique({ where: { key: 'paymentPlans' } });
  if (existing) {
    const parsed = parsePlatformSettingValue(existing.value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const migrated = getPaymentPlans(parsed as Record<string, unknown>);
      if (isValidPaymentPlans(migrated) && serializePlatformSettingValue(migrated) !== existing.value) {
        await prisma.platformSetting.update({
          where: { key: 'paymentPlans' },
          data: { value: serializePlatformSettingValue(migrated) },
        });
      }
    }
    return;
  }

  await prisma.platformSetting.create({
    data: {
      key: 'paymentPlans',
      value: serializePlatformSettingValue(platformSettingDefaults.paymentPlans),
    },
  });
}

export function getPublicPaymentPlans(settings: Record<string, unknown>) {
  const plans = getPaymentPlans(settings);
  const formatPrice = (amountMinor: number, customLabel?: string) => {
    return amountMinor > 0
      ? `₦${(amountMinor / 100).toLocaleString('en-NG')} / term`
      : customLabel || 'Custom pricing';
  };

  return {
    starter: { ...plans.STARTER, priceLabel: formatPrice(plans.STARTER.amountMinor, plans.STARTER.priceLabel) },
    standard: { ...plans.GROWTH, priceLabel: formatPrice(plans.GROWTH.amountMinor, plans.GROWTH.priceLabel) },
    group: { ...plans.ENTERPRISE, priceLabel: formatPrice(plans.ENTERPRISE.amountMinor, plans.ENTERPRISE.priceLabel) },
  };
}

export function serializePlatformSettingValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    console.warn('Failed to serialize platform setting value, storing as string', error);
    return String(value);
  }
}

export function parsePlatformSettingValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function getPlatformSettings(prisma: PrismaClient) {
  const entries = await prisma.platformSetting.findMany({ select: { key: true, value: true } });

  const settings = Object.fromEntries(
    entries.map((entry) => [entry.key, parsePlatformSettingValue(entry.value)])
  );

  return {
    ...platformSettingDefaults,
    ...settings,
  } as Record<string, unknown>;
}

export async function getPlatformSettingValue<T>(
  prisma: PrismaClient,
  key: string,
  defaultValue: T
): Promise<T> {
  const entry = await prisma.platformSetting.findUnique({ where: { key } });
  if (!entry) {
    return defaultValue;
  }

  const parsed = parsePlatformSettingValue(entry.value);
  return (parsed as T) ?? defaultValue;
}
