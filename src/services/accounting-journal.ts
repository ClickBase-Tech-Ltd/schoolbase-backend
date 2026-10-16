export type AccountingJournalLineInput = {
  accountId: string;
  side: string;
  amount: number;
  description?: string;
};

export type AccountingJournalValidationResult = {
  valid: boolean;
  error?: string;
  debitTotal: number;
  creditTotal: number;
  difference: number;
};

export function validateAccountingJournalEntry(input: { lines: AccountingJournalLineInput[] }): AccountingJournalValidationResult {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { valid: false, error: 'Journal entry requires at least one line', debitTotal: 0, creditTotal: 0, difference: 0 };
  }

  let debitTotal = 0;
  let creditTotal = 0;

  for (const line of input.lines) {
    if (!line || typeof line.accountId !== 'string' || !line.accountId.trim()) {
      return { valid: false, error: 'Each journal line requires a valid account ID', debitTotal, creditTotal, difference: debitTotal - creditTotal };
    }

    if (line.side !== 'DEBIT' && line.side !== 'CREDIT') {
      return { valid: false, error: 'Each journal line must specify DEBIT or CREDIT', debitTotal, creditTotal, difference: debitTotal - creditTotal };
    }

    const amount = Number(line.amount);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(amount)) {
      return { valid: false, error: 'Each journal line amount must be a positive integer minor-unit value', debitTotal, creditTotal, difference: debitTotal - creditTotal };
    }

    if (line.side === 'DEBIT') {
      debitTotal += amount;
    } else {
      creditTotal += amount;
    }
  }

  const difference = debitTotal - creditTotal;
  if (difference !== 0) {
    return {
      valid: false,
      error: `Journal entry is not balanced: debits ${debitTotal} do not equal credits ${creditTotal}`,
      debitTotal,
      creditTotal,
      difference,
    };
  }

  return {
    valid: true,
    debitTotal,
    creditTotal,
    difference: 0,
  };
}
