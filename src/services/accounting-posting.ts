import { validateAccountingJournalEntry } from './accounting-journal.js';

export type FeePaymentJournalLine = {
  accountCode: string;
  side: 'DEBIT' | 'CREDIT';
  amount: number;
  description?: string;
};

export type FeePaymentJournalResult = {
  valid: boolean;
  error?: string;
  journal: {
    reference: string;
    lines: FeePaymentJournalLine[];
  };
  debitTotal: number;
  creditTotal: number;
  difference: number;
};

export function buildFeePaymentJournalEntry({
  amountMinor,
  reference,
  description,
  cashAccountCode = '1010',
  feeIncomeAccountCode = '4000',
}: {
  amountMinor: number;
  reference: string;
  description?: string;
  cashAccountCode?: string;
  feeIncomeAccountCode?: string;
}): FeePaymentJournalResult {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return {
      valid: false,
      error: 'Payment journal amount must be a positive integer minor-unit value',
      journal: { reference, lines: [] },
      debitTotal: 0,
      creditTotal: 0,
      difference: 0,
    };
  }

  const referenceText = reference.trim() || `FEE-${Date.now()}`;
  const lines: FeePaymentJournalLine[] = [
    {
      accountCode: cashAccountCode,
      side: 'DEBIT',
      amount: amountMinor,
      description: description ? `Cash received: ${description}` : 'Cash received from fee payment',
    },
    {
      accountCode: feeIncomeAccountCode,
      side: 'CREDIT',
      amount: amountMinor,
      description: description ? `Fee income recorded: ${description}` : 'Fee income recorded from payment',
    },
  ];

  const validation = validateAccountingJournalEntry({
    lines: lines.map((line) => ({
      accountId: line.accountCode,
      side: line.side,
      amount: line.amount,
      description: line.description,
    })),
  });

  return {
    valid: validation.valid,
    error: validation.error,
    journal: { reference: referenceText, lines },
    debitTotal: validation.debitTotal,
    creditTotal: validation.creditTotal,
    difference: validation.difference,
  };
}

export function buildOpeningBalanceJournalLines({
  assetAccountId,
  equityAccountId,
  openingBalanceMinor,
}: {
  assetAccountId: string;
  equityAccountId: string;
  openingBalanceMinor: number;
}): Array<{ accountId: string; side: 'DEBIT' | 'CREDIT'; amount: number; description: string }> | null {
  if (!assetAccountId || !equityAccountId || assetAccountId === equityAccountId || !Number.isSafeInteger(openingBalanceMinor) || openingBalanceMinor === 0) return null;
  const amount = Math.abs(openingBalanceMinor);
  if (!Number.isSafeInteger(amount)) return null;
  const assetSide = openingBalanceMinor > 0 ? 'DEBIT' : 'CREDIT';
  const equitySide = openingBalanceMinor > 0 ? 'CREDIT' : 'DEBIT';
  return [
    { accountId: assetAccountId, side: assetSide, amount, description: 'Opening cash or bank balance' },
    { accountId: equityAccountId, side: equitySide, amount, description: 'Opening balance equity offset' },
  ];
}
