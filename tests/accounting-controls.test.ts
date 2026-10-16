import assert from 'node:assert/strict';
import { calculateReconciliationDifference, canCloseAccountingPeriod } from '../src/services/accounting-controls.js';

const reconciled = calculateReconciliationDifference({
  ledgerBalanceMinor: 2500,
  bankStatementMinor: 2500,
});
assert.equal(reconciled.differenceMinor, 0);
assert.equal(reconciled.status, 'MATCHED');

const discrepancy = calculateReconciliationDifference({
  ledgerBalanceMinor: 2500,
  bankStatementMinor: 2200,
});
assert.equal(discrepancy.differenceMinor, 300);
assert.equal(discrepancy.status, 'DISCREPANT');

const periodCanClose = canCloseAccountingPeriod({
  totalDebitMinor: 2500,
  totalCreditMinor: 2500,
  hasOpenEntries: false,
  isBankReconciled: true,
});
assert.equal(periodCanClose.allowed, true);
assert.equal(periodCanClose.reason, 'ready');

const periodBlocked = canCloseAccountingPeriod({
  totalDebitMinor: 2500,
  totalCreditMinor: 2300,
  hasOpenEntries: true,
  isBankReconciled: false,
});
assert.equal(periodBlocked.allowed, false);
assert.match(periodBlocked.reason, /balanced|reconciled|open/i);

console.log('Accounting control tests passed');
