import assert from 'node:assert/strict';
import { validateAccountingJournalEntry } from '../src/services/accounting-journal.js';

const balanced = validateAccountingJournalEntry({
  lines: [
    { accountId: 'acc-1', side: 'DEBIT', amount: 5000 },
    { accountId: 'acc-2', side: 'CREDIT', amount: 5000 },
  ],
});
assert.equal(balanced.valid, true);
assert.equal(balanced.debitTotal, 5000);
assert.equal(balanced.creditTotal, 5000);

const unbalanced = validateAccountingJournalEntry({
  lines: [
    { accountId: 'acc-1', side: 'DEBIT', amount: 3000 },
    { accountId: 'acc-2', side: 'CREDIT', amount: 2000 },
  ],
});
assert.equal(unbalanced.valid, false);
assert.match(unbalanced.error ?? '', /not balanced/i);

const invalidSide = validateAccountingJournalEntry({
  lines: [{ accountId: 'acc-1', side: 'UNKNOWN', amount: 5000 }],
});
assert.equal(invalidSide.valid, false);
assert.match(invalidSide.error ?? '', /DEBIT or CREDIT/i);

console.log('Accounting journal validation tests passed');
