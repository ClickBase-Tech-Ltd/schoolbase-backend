import assert from 'node:assert/strict';
import { checksumBankStatement, parseBankStatementCsv } from '../src/services/bank-statement.js';

const parsed = parseBankStatementCsv('Date,Description,Reference,Debit,Credit\n2026-10-01,"Transfer, parent",TX-1,,125.50\n2026-10-02,Stationery,TX-2,20.00,');
assert.equal(parsed.length, 2);
assert.equal(parsed[0].direction, 'CREDIT');
assert.equal(parsed[0].amountMinor, 12550);
assert.equal(parsed[0].description, 'Transfer, parent');
assert.equal(parsed[1].direction, 'DEBIT');
assert.equal(parsed[1].amountMinor, 2000);
assert.equal(parseBankStatementCsv('\uFEFFDate,Description,Amount\n2026-10-03,Deposit,10.00')[0].direction, 'CREDIT');
assert.equal(checksumBankStatement('same'), checksumBankStatement('same'));

assert.throws(() => parseBankStatementCsv('Date,Description,Debit,Credit\ninvalid,Transfer,1,0'), /valid date/);
assert.throws(() => parseBankStatementCsv('Date,Description,Debit,Credit\n2026-10-01,Transfer,1,1'), /exactly one/);
assert.throws(() => parseBankStatementCsv('Date,Description,Value\n2026-10-01,Transfer,10'), /Amount\/Type or Debit\/Credit/);

console.log('Bank statement CSV tests passed');