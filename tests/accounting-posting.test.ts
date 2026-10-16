import assert from 'node:assert/strict';
import { buildFeePaymentJournalEntry, buildOpeningBalanceJournalLines } from '../src/services/accounting-posting.js';

const result = buildFeePaymentJournalEntry({
  amountMinor: 2500,
  reference: 'PAY-1001',
  description: 'Fee payment received',
});

assert.equal(result.valid, true);
assert.equal(result.journal.lines.length, 2);
assert.equal(result.journal.lines[0].side, 'DEBIT');
assert.equal(result.journal.lines[1].side, 'CREDIT');
assert.equal(result.journal.lines[0].amount, 2500);
assert.equal(result.journal.lines[1].amount, 2500);

console.log('Accounting payment journal posting tests passed');

const positiveOpeningBalance = buildOpeningBalanceJournalLines({
  assetAccountId: 'bank',
  equityAccountId: 'opening-equity',
  openingBalanceMinor: 125000,
});
assert.equal(positiveOpeningBalance?.[0].side, 'DEBIT');
assert.equal(positiveOpeningBalance?.[1].side, 'CREDIT');
assert.equal(positiveOpeningBalance?.[0].amount, 125000);

const overdrawnOpeningBalance = buildOpeningBalanceJournalLines({
  assetAccountId: 'bank',
  equityAccountId: 'opening-equity',
  openingBalanceMinor: -3000,
});
assert.equal(overdrawnOpeningBalance?.[0].side, 'CREDIT');
assert.equal(overdrawnOpeningBalance?.[1].side, 'DEBIT');
assert.equal(overdrawnOpeningBalance?.[0].amount, 3000);
assert.equal(buildOpeningBalanceJournalLines({ assetAccountId: 'bank', equityAccountId: 'bank', openingBalanceMinor: 100 }), null);
