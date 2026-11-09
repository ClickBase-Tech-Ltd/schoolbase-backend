import type { FinancingProductApplicationMode, FinancingIntegrationMode } from '@prisma/client';

export type FinancingProductInput = {
  institutionId: string;
  code: string;
  displayName: string;
  summary: string;
  eligibilitySummary: string;
  termsSummary: string;
  termsUrl: string | null;
  termsVersion: string;
  currency: string;
  applicationMode: FinancingProductApplicationMode;
  applicationUrl: string | null;
  effectiveAt: Date;
  expiresAt: Date | null;
};

export class InvalidFinancingProductInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFinancingProductInputError';
  }
}

function isApplicationMode(value: unknown): value is FinancingProductApplicationMode {
  return value === 'HOSTED' || value === 'SCHOOL_CONTACT' || value === 'API';
}

function requiredText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string') {
    throw new InvalidFinancingProductInputError(`${label} is required.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new InvalidFinancingProductInputError(
      `${label} must be between 1 and ${maximumLength} characters.`,
    );
  }
  return normalized;
}

function optionalHttpsUrl(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) {
    throw new InvalidFinancingProductInputError(`${label} must be an HTTPS URL of at most 2048 characters.`);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
      throw new Error('invalid URL');
    }
    return url.toString();
  } catch {
    throw new InvalidFinancingProductInputError(`${label} must be a valid HTTPS URL.`);
  }
}

export function parseFinancingProductInput(value: unknown): FinancingProductInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidFinancingProductInputError('Product details are required.');
  }
  const input = value as Record<string, unknown>;
  const code = requiredText(input.code, 'Product code', 64).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(code)) {
    throw new InvalidFinancingProductInputError(
      'Product code must contain 2–64 letters, digits, underscores, or hyphens.',
    );
  }
  const currency = requiredText(input.currency, 'Currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new InvalidFinancingProductInputError('Currency must be a three-letter ISO currency code.');
  }
  const applicationMode = input.applicationMode;
  if (!isApplicationMode(applicationMode)) {
    throw new InvalidFinancingProductInputError('Choose a supported application route.');
  }
  const effectiveAt = new Date(String(input.effectiveAt ?? ''));
  if (Number.isNaN(effectiveAt.getTime())) {
    throw new InvalidFinancingProductInputError('A valid effective date is required.');
  }
  const expiresAt = input.expiresAt ? new Date(String(input.expiresAt)) : null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt <= effectiveAt)) {
    throw new InvalidFinancingProductInputError('Expiry must be a valid date after the effective date.');
  }

  return {
    institutionId: requiredText(input.institutionId, 'Institution', 191),
    code,
    displayName: requiredText(input.displayName, 'Product name', 191),
    summary: requiredText(input.summary, 'Product description', 500),
    eligibilitySummary: requiredText(input.eligibilitySummary, 'Eligibility information', 5000),
    termsSummary: requiredText(input.termsSummary, 'Approved terms summary', 10000),
    termsUrl: optionalHttpsUrl(input.termsUrl, 'Terms link'),
    termsVersion: requiredText(input.termsVersion, 'Terms version', 80),
    currency,
    applicationMode,
    applicationUrl: optionalHttpsUrl(input.applicationUrl, 'Application link'),
    effectiveAt,
    expiresAt,
  };
}

export function getFinancingProductActivationBlockers(
  product: FinancingProductInput,
  institutionMode: FinancingIntegrationMode,
  approvalEvidenceReference: string | null,
): string[] {
  const blockers = getFinancingProductApprovalBlockers(product, approvalEvidenceReference);
  if (product.applicationMode === 'HOSTED') {
    if (institutionMode !== 'HOSTED') blockers.push('Product and institution integration modes must match.');
  } else if (product.applicationMode === 'SCHOOL_CONTACT') {
    if (institutionMode !== 'MANUAL') blockers.push('School follow-up products require manual institution mode.');
  } else {
    blockers.push('API products cannot be activated until a verified institution-specific adapter is installed.');
  }
  return blockers;
}

export function getFinancingProductApprovalBlockers(
  product: FinancingProductInput,
  approvalEvidenceReference: string | null,
): string[] {
  const blockers: string[] = [];
  if (!approvalEvidenceReference?.trim()) blockers.push('Record the bank/product approval reference.');
  if (!product.termsUrl) blockers.push('Provide a link to the bank-approved full terms.');
  if (!product.termsSummary.trim() || !product.termsVersion.trim()) {
    blockers.push('Provide the bank-approved terms summary and version.');
  }
  if (product.applicationMode === 'HOSTED' && !product.applicationUrl) {
    blockers.push('Configure the lender-hosted application URL.');
  }
  return blockers;
}

export function canApproveFinancingProduct(createdBy: string, approverId: string): boolean {
  return Boolean(createdBy && approverId);
}
