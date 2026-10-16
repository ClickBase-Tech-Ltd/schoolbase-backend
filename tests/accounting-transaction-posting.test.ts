import assert from 'node:assert/strict';
import { validateAccountingJournalEntry } from '../src/services/accounting-journal.js';
import { buildFinancialTransactionJournalLines, type FinancialPostingAccounts } from '../src/services/accounting-transaction-posting.js';

const accounts: FinancialPostingAccounts = {
  cashAccountId: 'cash',
  bankAccountId: 'bank',
  clearingAccountId: 'clearing',
  incomeAccountId: 'income',
  expenseAccountId: 'expense',
  accountsPayableAccountId: 'payable',
};

function assertBalanced(lines: NonNullable<ReturnType<typeof buildFinancialTransactionJournalLines>>) {
  assert.equal(validateAccountingJournalEntry({ lines }).valid, true);
}

const cashIncome = buildFinancialTransactionJournalLines({ type: 'INCOME', amountMinor: 12500, paymentMethod: 'CASH', accounts });
assert.deepEqual(cashIncome?.map(({ accountId, side }) => [accountId, side]), [['cash', 'DEBIT'], ['income', 'CREDIT']]);
assertBalanced(cashIncome ?? []);

const transferIncome = buildFinancialTransactionJournalLines({ type: 'INCOME', amountMinor: 12500, paymentMethod: 'BANK_TRANSFER', accounts });
assert.deepEqual(transferIncome?.map(({ accountId, side }) => [accountId, side]), [['bank', 'DEBIT'], ['income', 'CREDIT']]);
assertBalanced(transferIncome ?? []);

const onlineIncome = buildFinancialTransactionJournalLines({ type: 'INCOME', amountMinor: 12500, paymentMethod: 'ONLINE', accounts });
assert.deepEqual(onlineIncome?.map(({ accountId, side }) => [accountId, side]), [['clearing', 'DEBIT'], ['income', 'CREDIT']]);
assertBalanced(onlineIncome ?? []);

const paidExpense = buildFinancialTransactionJournalLines({ type: 'EXPENSE', amountMinor: 5000, paymentMethod: 'CASH', accounts });
assert.deepEqual(paidExpense?.map(({ accountId, side }) => [accountId, side]), [['expense', 'DEBIT'], ['cash', 'CREDIT']]);
assertBalanced(paidExpense ?? []);

const payableExpense = buildFinancialTransactionJournalLines({ type: 'EXPENSE', amountMinor: 5000, paymentMethod: null, accounts });
assert.deepEqual(payableExpense?.map(({ accountId, side }) => [accountId, side]), [['expense', 'DEBIT'], ['payable', 'CREDIT']]);
assertBalanced(payableExpense ?? []);

const cardExpense = buildFinancialTransactionJournalLines({ type: 'EXPENSE', amountMinor: 5000, paymentMethod: 'CARD', accounts });
assert.deepEqual(cardExpense?.map(({ accountId, side }) => [accountId, side]), [['expense', 'DEBIT'], ['clearing', 'CREDIT']]);
assertBalanced(cardExpense ?? []);

const reversal = buildFinancialTransactionJournalLines({ type: 'EXPENSE', amountMinor: -5000, paymentMethod: null, accounts });
assert.deepEqual(reversal?.map(({ accountId, side }) => [accountId, side]), [['payable', 'DEBIT'], ['expense', 'CREDIT']]);
assertBalanced(reversal ?? []);
assert.equal(buildFinancialTransactionJournalLines({ type: 'INCOME', amountMinor: 0, paymentMethod: null, accounts }), null);

console.log('Accounting transaction posting tests passed');