export type FinancingProviderMode = 'HOSTED' | 'API' | 'MANUAL';

export type ProviderReportedApplicationStatus =
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'MORE_INFO_REQUIRED'
  | 'OFFERED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED';

interface ProviderEventBase {
  eventId: string;
  occurredAt: string;
  applicationReference: string;
}

export type NormalizedFinancingProviderEvent =
  | (ProviderEventBase & {
      type: 'APPLICATION_STATUS';
      status: ProviderReportedApplicationStatus;
    })
  | (ProviderEventBase & {
      type: 'OFFER_ISSUED';
      offerReference: string;
    })
  | (ProviderEventBase & {
      type: 'DISBURSEMENT_REPORTED';
      amountMinor: number;
      currency: string;
      settlementReference: string;
    });

export type FinancingProviderApplicationStartResult =
  | {
      mode: 'HOSTED';
      applicationReference: string;
      redirectUrl: string;
      redirectExpiresAt: string;
    }
  | {
      mode: 'API' | 'MANUAL';
      applicationReference: string;
    };

export type FinancingProviderApplicationStartResultFor<TMode extends FinancingProviderMode> =
  Extract<FinancingProviderApplicationStartResult, { mode: TMode }>;

export interface FinancingProviderAdapter<
  TSubmissionPayload,
  TMode extends FinancingProviderMode = FinancingProviderMode,
> {
  readonly institutionCode: string;
  readonly mode: TMode;
  // Build this payload from consented, lender-approved fields only.
  startApplication(input: {
    applicationId: string;
    idempotencyKey: string;
    payload: TSubmissionPayload;
  }): Promise<FinancingProviderApplicationStartResultFor<TMode>>;
  // Implementations must verify the lender's documented signature/authentication before normalizing.
  verifyAndNormalizeWebhook?(request: FinancingProviderWebhookRequest): Promise<unknown>;
}

export interface FinancingProviderWebhookRequest {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  rawBody: Uint8Array;
}

export type FinancingProviderEventValidationErrorCode =
  | 'INVALID_EVENT'
  | 'INVALID_EVENT_ID'
  | 'INVALID_OCCURRED_AT'
  | 'INVALID_APPLICATION_REFERENCE'
  | 'INVALID_APPLICATION_STATUS'
  | 'INVALID_OFFER_REFERENCE'
  | 'INVALID_DISBURSEMENT_AMOUNT'
  | 'INVALID_DISBURSEMENT_CURRENCY'
  | 'INVALID_SETTLEMENT_REFERENCE';

export class FinancingProviderEventValidationError extends Error {
  constructor(public readonly code: FinancingProviderEventValidationErrorCode) {
    super(`Financing provider event is invalid: ${code}.`);
    this.name = 'FinancingProviderEventValidationError';
  }
}

const providerReportedStatuses = new Set<ProviderReportedApplicationStatus>([
  'SUBMITTED',
  'UNDER_REVIEW',
  'MORE_INFO_REQUIRED',
  'OFFERED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
]);

export function parseNormalizedFinancingProviderEvent(
  value: unknown,
): NormalizedFinancingProviderEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FinancingProviderEventValidationError('INVALID_EVENT');
  }

  const input = value as Record<string, unknown>;
  const eventId = normalizeRequiredString(input.eventId, 191, 'INVALID_EVENT_ID');
  const applicationReference = normalizeRequiredString(
    input.applicationReference,
    191,
    'INVALID_APPLICATION_REFERENCE',
  );
  const occurredAt = normalizeDate(input.occurredAt);

  if (input.type === 'APPLICATION_STATUS') {
    if (typeof input.status !== 'string' ||
        !providerReportedStatuses.has(input.status as ProviderReportedApplicationStatus)) {
      throw new FinancingProviderEventValidationError('INVALID_APPLICATION_STATUS');
    }
    return {
      eventId,
      applicationReference,
      occurredAt,
      type: 'APPLICATION_STATUS',
      status: input.status as ProviderReportedApplicationStatus,
    };
  }

  if (input.type === 'OFFER_ISSUED') {
    return {
      eventId,
      applicationReference,
      occurredAt,
      type: 'OFFER_ISSUED',
      offerReference: normalizeRequiredString(input.offerReference, 191, 'INVALID_OFFER_REFERENCE'),
    };
  }

  if (input.type === 'DISBURSEMENT_REPORTED') {
    if (!Number.isSafeInteger(input.amountMinor) || (input.amountMinor as number) <= 0) {
      throw new FinancingProviderEventValidationError('INVALID_DISBURSEMENT_AMOUNT');
    }
    if (typeof input.currency !== 'string' || !/^[A-Za-z]{3}$/.test(input.currency.trim())) {
      throw new FinancingProviderEventValidationError('INVALID_DISBURSEMENT_CURRENCY');
    }
    return {
      eventId,
      applicationReference,
      occurredAt,
      type: 'DISBURSEMENT_REPORTED',
      amountMinor: input.amountMinor as number,
      currency: input.currency.trim().toUpperCase(),
      settlementReference: normalizeRequiredString(
        input.settlementReference,
        191,
        'INVALID_SETTLEMENT_REFERENCE',
      ),
    };
  }

  throw new FinancingProviderEventValidationError('INVALID_EVENT');
}

function normalizeRequiredString(
  value: unknown,
  maxLength: number,
  errorCode: FinancingProviderEventValidationErrorCode,
): string {
  if (typeof value !== 'string') {
    throw new FinancingProviderEventValidationError(errorCode);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new FinancingProviderEventValidationError(errorCode);
  }
  return normalized;
}

function normalizeDate(value: unknown): string {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim())) {
    throw new FinancingProviderEventValidationError('INVALID_OCCURRED_AT');
  }
  const timestamp = new Date(value.trim());
  if (Number.isNaN(timestamp.getTime())) {
    throw new FinancingProviderEventValidationError('INVALID_OCCURRED_AT');
  }
  return timestamp.toISOString();
}
