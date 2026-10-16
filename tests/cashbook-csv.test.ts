import assert from 'node:assert/strict';
import { buildCashbookCsv } from '../src/services/cashbook-csv.js';

const csv = buildCashbookCsv([{
  id: 'txn-1',
  transactionDate: '2026-10-15T10:00:00.000Z',
  type: 'INCOME',
  amount: 12550,
  currency: 'NGN',
  status: 'POSTED',
  categoryName: 'Fees, tuition',
  description: '=HYPERLINK("https://bad.invalid")',
  referenceNumber: 'INV-"42"',
  createdByName: 'Bursar',
  postedByName: 'Approver',
}]);

assert.match(csv, /^"ID","Transaction Date","Type","Amount Minor Units"/);
assert.match(csv, /"12,?550"/);
assert.match(csv, /"'=HYPERLINK\(""https:\/\/bad\.invalid""\)"/);
assert.match(csv, /"Fees, tuition"/);
assert.match(csv, /"INV-""42"""/);

console.log('Cashbook CSV tests passed');