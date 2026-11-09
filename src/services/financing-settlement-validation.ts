export type FinancingSettlementValidationErrorCode =
  | 'SETTLEMENT_NOT_CONFIRMED'
  | 'SETTLEMENT_NOT_RECONCILED'
  | 'INVALID_SETTLEMENT_AMOUNT'
  | 'INVALID_OUTSTANDING_AMOUNT'
  | 'NO_OUTSTANDING_BALANCE'
  | 'SETTLEMENT_EXCEEDS_OUTSTANDING'
  | 'INVALID_CURRENCY'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_SETTLEMENT_REFERENCE';

export class FinancingSettlementValidationError extends Error {
  constructor(public readonly code: FinancingSettlementValidationErrorCode) {
    super(`Financing settlement is not eligible for posting: ${code}.`);
    this.name = 'FinancingSettlementValidationError';
  }
}

export interface FinancingSettlementCandidate {
  bankConfirmed: boolean;
  reconciled: boolean;
  amountMinor: number;
  outstandingMinor: number;
  settlementCurrency: string;
  invoiceCurrency: string;
  settlementReference: string;
}

export interface ValidatedFinancingSettlement {
  amountMinor: number;
  currency: string;
  settlementReference: string;
}

export function validateFinancingSettlementCandidate(
  candidate: FinancingSettlementCandidate,
): ValidatedFinancingSettlement {
  if (candidate.bankConfirmed !== true) {
    throw new FinancingSettlementValidationError('SETTLEMENT_NOT_CONFIRMED');
  }
  if (candidate.reconciled !== true) {
    throw new FinancingSettlementValidationError('SETTLEMENT_NOT_RECONCILED');
  }
  if (!Number.isSafeInteger(candidate.amountMinor) || candidate.amountMinor <= 0) {
    throw new FinancingSettlementValidationError('INVALID_SETTLEMENT_AMOUNT');
  }
  if (!Number.isSafeInteger(candidate.outstandingMinor) || candidate.outstandingMinor < 0) {
    throw new FinancingSettlementValidationError('INVALID_OUTSTANDING_AMOUNT');
  }
  if (candidate.outstandingMinor === 0) {
    throw new FinancingSettlementValidationError('NO_OUTSTANDING_BALANCE');
  }
  if (candidate.amountMinor > candidate.outstandingMinor) {
    throw new FinancingSettlementValidationError('SETTLEMENT_EXCEEDS_OUTSTANDING');
  }

  const settlementCurrency = candidate.settlementCurrency.trim().toUpperCase();
  const invoiceCurrency = candidate.invoiceCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(settlementCurrency) || !/^[A-Z]{3}$/.test(invoiceCurrency)) {
    throw new FinancingSettlementValidationError('INVALID_CURRENCY');
  }
  if (settlementCurrency !== invoiceCurrency) {
    throw new FinancingSettlementValidationError('CURRENCY_MISMATCH');
  }

  const settlementReference = candidate.settlementReference.trim();
  if (!settlementReference || settlementReference.length > 191) {
    throw new FinancingSettlementValidationError('INVALID_SETTLEMENT_REFERENCE');
  }

  return {
    amountMinor: candidate.amountMinor,
    currency: settlementCurrency,
    settlementReference,
  };
}
