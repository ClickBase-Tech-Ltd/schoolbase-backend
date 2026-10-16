import assert from 'node:assert/strict';
import { calculateAccountingBalances } from '../src/services/accounting-ledger.js';

const balances = calculateAccountingBalances({
  accounts: [
    { id: 'cash', code: '1010', name: 'Cash at Bank', type: 'ASSET' },
    { id: 'income', code: '4000', name: 'Fee Income', type: 'REVENUE' },
    { id: 'expense', code: '5000', name: 'Operating Expenses', type: 'EXPENSE' },
  ],
  journalLines: [
    { accountId: 'cash', side: 'DEBIT', amount: 2500 },
    { accountId: 'income', side: 'CREDIT', amount: 2500 },
    { accountId: 'cash', side: 'DEBIT', amount: 1200 },
    { accountId: 'expense', side: 'CREDIT', amount: 1200 },
  ],
});

assert.equal(balances.length, 3);
assert.equal(balances.find((item) => item.code === '1010')?.balanceMinor, 3700);
assert.equal(balances.find((item) => item.code === '4000')?.balanceMinor, -2500);
assert.equal(balances.find((item) => item.code === '5000')?.balanceMinor, -1200);

console.log('Accounting trial balance tests passed');
