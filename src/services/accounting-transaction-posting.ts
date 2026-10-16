export type FinancialPostingType = 'INCOME' | 'EXPENSE';

export interface FinancialPostingAccounts {
  cashAccountId: string;
  bankAccountId: string;
  clearingAccountId: string;
  incomeAccountId: string;
  expenseAccountId: string;
  accountsPayableAccountId: string;
}

export interface FinancialJournalLine {
  accountId: string;
  side: 'DEBIT' | 'CREDIT';
  amount: number;
  description: string;
}

export function buildFinancialTransactionJournalLines({
  type,
  amountMinor,
  paymentMethod,
  accounts,
  description,
}: {
  type: FinancialPostingType;
  amountMinor: number;
  paymentMethod: string | null;
  accounts: FinancialPostingAccounts;
  description?: string | null;
}): FinancialJournalLine[] | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor === 0) return null;
  const magnitude = Math.abs(amountMinor);
  if (!Number.isSafeInteger(magnitude)) return null;

  const isReversal = amountMinor < 0;
  const counterAccountId = type === 'INCOME'
    ? accounts.incomeAccountId
    : paymentMethod === null
      ? accounts.accountsPayableAccountId
      : paymentAccountId(paymentMethod, accounts);
  const liquidAccountId = type === 'INCOME'
    ? paymentAccountId(paymentMethod, accounts)
    : paymentMethod === null ? accounts.accountsPayableAccountId : null;
  const operatingAccountId = type === 'INCOME' ? accounts.incomeAccountId : accounts.expenseAccountId;
  const memo = description?.trim() || (type === 'INCOME' ? 'Other income' : 'Operating expense');

  if (type === 'INCOME') {
    const cashAccountId = liquidAccountId ?? accounts.bankAccountId;
    return isReversal
      ? [
          { accountId: operatingAccountId, side: 'DEBIT', amount: magnitude, description: `Income reversal: ${memo}` },
          { accountId: cashAccountId, side: 'CREDIT', amount: magnitude, description: `Cash returned: ${memo}` },
        ]
      : [
          { accountId: cashAccountId, side: 'DEBIT', amount: magnitude, description: `Cash received: ${memo}` },
          { accountId: operatingAccountId, side: 'CREDIT', amount: magnitude, description: `Income recorded: ${memo}` },
        ];
  }

  return isReversal
    ? [
        { accountId: counterAccountId, side: 'DEBIT', amount: magnitude, description: `Expense reversal: ${memo}` },
        { accountId: operatingAccountId, side: 'CREDIT', amount: magnitude, description: `Expense reversed: ${memo}` },
      ]
    : [
        { accountId: operatingAccountId, side: 'DEBIT', amount: magnitude, description: `Expense recorded: ${memo}` },
        { accountId: counterAccountId, side: 'CREDIT', amount: magnitude, description: `Expense paid or payable: ${memo}` },
      ];
}

function paymentAccountId(paymentMethod: string | null, accounts: FinancialPostingAccounts): string {
  if (paymentMethod === 'CASH') return accounts.cashAccountId;
  if (paymentMethod === 'CARD' || paymentMethod === 'ONLINE') return accounts.clearingAccountId;
  return accounts.bankAccountId;
}