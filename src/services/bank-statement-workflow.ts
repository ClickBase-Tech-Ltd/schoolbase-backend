export type BankStatementWorkflowStatus = 'IMPORTED' | 'PREPARED' | 'RECONCILED' | 'VOIDED';

export function buildBankChargeJournalLines({
  bankAccountId,
  bankChargesAccountId,
  amountMinor,
  reason,
}: {
  bankAccountId: string;
  bankChargesAccountId: string;
  amountMinor: number;
  reason: string;
}): Array<{ accountId: string; side: 'DEBIT' | 'CREDIT'; amount: number; description: string }> | null {
  const memo = reason.trim();
  if (!bankAccountId || !bankChargesAccountId || bankAccountId === bankChargesAccountId || !memo || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
  return [
    { accountId: bankChargesAccountId, side: 'DEBIT', amount: amountMinor, description: `Bank charge: ${memo}` },
    { accountId: bankAccountId, side: 'CREDIT', amount: amountMinor, description: `Bank charge paid: ${memo}` },
  ];
}

export function remainingReconciliationAmount(totalMinor: number, allocatedMinor: number): number {
  return Math.max(0, Number(totalMinor) - Number(allocatedMinor));
}

export function validateReconciliationAllocation({
  statementAmountMinor,
  statementAllocatedMinor,
  journalAmountMinor,
  journalAllocatedMinor,
  allocationAmountMinor,
}: {
  statementAmountMinor: number;
  statementAllocatedMinor: number;
  journalAmountMinor: number;
  journalAllocatedMinor: number;
  allocationAmountMinor: number;
}): { allowed: boolean; reason: string } {
  if (!Number.isSafeInteger(allocationAmountMinor) || allocationAmountMinor <= 0) {
    return { allowed: false, reason: 'Match amount must be a positive integer in minor units.' };
  }
  if (allocationAmountMinor > remainingReconciliationAmount(statementAmountMinor, statementAllocatedMinor)) {
    return { allowed: false, reason: 'Match amount exceeds the remaining bank statement amount.' };
  }
  if (allocationAmountMinor > remainingReconciliationAmount(journalAmountMinor, journalAllocatedMinor)) {
    return { allowed: false, reason: 'Match amount exceeds the remaining ledger amount.' };
  }
  return { allowed: true, reason: 'Allocation fits both remaining amounts.' };
}

export function canPrepareStatement({
  status,
  statementLineCount,
  matchedStatementLineCount,
  unmatchedLedgerLineCount,
}: {
  status: BankStatementWorkflowStatus;
  statementLineCount: number;
  matchedStatementLineCount: number;
  unmatchedLedgerLineCount: number;
}): { allowed: boolean; reason: string } {
  if (status !== 'IMPORTED') return { allowed: false, reason: 'Only an imported statement can be prepared for review.' };
  if (statementLineCount === 0 || matchedStatementLineCount !== statementLineCount) {
    return { allowed: false, reason: 'Match every bank statement transaction before preparing it for review.' };
  }
  if (unmatchedLedgerLineCount > 0) {
    return { allowed: false, reason: 'Match every posted ledger transaction in this account and period before preparing the statement.' };
  }
  return { allowed: true, reason: 'Statement is ready for independent review.' };
}

export function canApproveStatement({
  status,
  preparerId,
  reviewerId,
}: {
  status: BankStatementWorkflowStatus;
  preparerId: string | null;
  reviewerId: string;
}): { allowed: boolean; reason: string } {
  if (status !== 'PREPARED') return { allowed: false, reason: 'Only a prepared statement can be approved.' };
  if (!preparerId || preparerId === reviewerId) {
    return { allowed: false, reason: 'A different accounting user must review and approve this statement.' };
  }
  return { allowed: true, reason: 'Statement is approved and locked.' };
}

export function canReopenStatement({
  status,
  role,
  reason,
}: {
  status: BankStatementWorkflowStatus;
  role: string;
  reason: string;
}): { allowed: boolean; reason: string } {
  if (status !== 'RECONCILED') return { allowed: false, reason: 'Only a reconciled statement can be reopened.' };
  if (role !== 'SCHOOL_ADMIN') return { allowed: false, reason: 'Only a school administrator can reopen a reconciled statement.' };
  if (!reason.trim()) return { allowed: false, reason: 'A reason is required to reopen a reconciled statement.' };
  return { allowed: true, reason: 'Statement reopened with an audit reason.' };
}

export function canVoidStatement({
  status,
  reason,
}: {
  status: BankStatementWorkflowStatus;
  reason: string;
}): { allowed: boolean; reason: string } {
  if (status === 'RECONCILED') return { allowed: false, reason: 'Reopen a reconciled statement before voiding its import.' };
  if (status === 'VOIDED') return { allowed: false, reason: 'This statement import is already voided.' };
  if (!reason.trim()) return { allowed: false, reason: 'A reason is required to void a statement import.' };
  return { allowed: true, reason: 'Statement import voided and retained for audit.' };
}