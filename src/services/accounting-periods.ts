import { calculateReconciliationDifference, canCloseAccountingPeriod } from './accounting-controls.js';

export type AccountingPeriodStatus = 'OPEN' | 'CLOSED';

export function buildAccountingPeriodCloseState({
  startDate,
  endDate,
  totalDebitMinor,
  totalCreditMinor,
  ledgerBalanceMinor,
  bankStatementMinor,
  hasOpenEntries,
  isBankReconciled,
}: {
  startDate: string | Date;
  endDate: string | Date;
  totalDebitMinor: number;
  totalCreditMinor: number;
  ledgerBalanceMinor: number;
  bankStatementMinor: number;
  hasOpenEntries: boolean;
  isBankReconciled: boolean;
}) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const monthKey = Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())
    ? 'UNSPECIFIED'
    : `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;

  const closeCheck = canCloseAccountingPeriod({
    totalDebitMinor,
    totalCreditMinor,
    hasOpenEntries,
    isBankReconciled,
  });

  const reconciliation = calculateReconciliationDifference({
    ledgerBalanceMinor,
    bankStatementMinor,
  });

  return {
    allowed: closeCheck.allowed,
    status: closeCheck.allowed ? 'CLOSED' : 'OPEN',
    reason: closeCheck.reason,
    name: monthKey,
    differenceMinor: reconciliation.differenceMinor,
    ledgerBalanceMinor: reconciliation.ledgerBalanceMinor,
    bankStatementMinor: reconciliation.bankStatementMinor,
    totalDebitMinor,
    totalCreditMinor,
    isReconciled: reconciliation.status === 'MATCHED',
    closedAt: closeCheck.allowed ? new Date().toISOString() : null,
  };
}
