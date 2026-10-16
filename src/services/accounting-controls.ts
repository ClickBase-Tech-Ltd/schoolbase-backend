export type ReconciliationStatus = 'MATCHED' | 'DISCREPANT';

export function calculateReconciliationDifference({
  ledgerBalanceMinor,
  bankStatementMinor,
}: {
  ledgerBalanceMinor: number;
  bankStatementMinor: number;
}): {
  status: ReconciliationStatus;
  differenceMinor: number;
  ledgerBalanceMinor: number;
  bankStatementMinor: number;
} {
  const ledgerBalance = Number(ledgerBalanceMinor) || 0;
  const bankBalance = Number(bankStatementMinor) || 0;
  const differenceMinor = ledgerBalance - bankBalance;

  return {
    status: differenceMinor === 0 ? 'MATCHED' : 'DISCREPANT',
    differenceMinor,
    ledgerBalanceMinor: ledgerBalance,
    bankStatementMinor: bankBalance,
  };
}

export function canCloseAccountingPeriod({
  totalDebitMinor,
  totalCreditMinor,
  hasOpenEntries,
  isBankReconciled,
}: {
  totalDebitMinor: number;
  totalCreditMinor: number;
  hasOpenEntries: boolean;
  isBankReconciled: boolean;
}): { allowed: boolean; reason: string } {
  if (hasOpenEntries) {
    return {
      allowed: false,
      reason: 'There are open accounting entries. Resolve them before closing the period.',
    };
  }

  if (Number(totalDebitMinor) !== Number(totalCreditMinor)) {
    return {
      allowed: false,
      reason: 'The trial balance is not balanced before the period can close.',
    };
  }

  if (!isBankReconciled) {
    return {
      allowed: false,
      reason: 'The bank reconciliation must be completed before closing the period.',
    };
  }

  return {
    allowed: true,
    reason: 'ready',
  };
}
