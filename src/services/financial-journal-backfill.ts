export type FinancialBackfillDecision = 'ELIGIBLE' | 'SKIP_STATUS' | 'SKIP_SOURCE_LINK' | 'SKIP_ALREADY_JOURNALIZED';

export function classifyFinancialTransactionForBackfill({
  status,
  invoiceId,
  paymentId,
  hasExistingJournal,
  reversalOfLinkedSource = false,
}: {
  status: string;
  invoiceId: string | null;
  paymentId: string | null;
  hasExistingJournal: boolean;
  reversalOfLinkedSource?: boolean;
}): FinancialBackfillDecision {
  if (hasExistingJournal) return 'SKIP_ALREADY_JOURNALIZED';
  if (status !== 'POSTED' && status !== 'REVERSED') return 'SKIP_STATUS';
  if (invoiceId || paymentId || reversalOfLinkedSource) return 'SKIP_SOURCE_LINK';
  return 'ELIGIBLE';
}