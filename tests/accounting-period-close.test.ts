import assert from 'node:assert/strict';
import { buildAccountingPeriodCloseState } from '../src/services/accounting-periods.js';

const state = buildAccountingPeriodCloseState({
  startDate: '2026-10-01',
  endDate: '2026-10-31',
  totalDebitMinor: 2500,
  totalCreditMinor: 2500,
  ledgerBalanceMinor: 2500,
  bankStatementMinor: 2500,
  hasOpenEntries: false,
  isBankReconciled: true,
});

assert.equal(state.allowed, true);
assert.equal(state.status, 'CLOSED');
assert.equal(state.name, '2026-10');
assert.equal(state.differenceMinor, 0);

const blocked = buildAccountingPeriodCloseState({
  startDate: '2026-10-01',
  endDate: '2026-10-31',
  totalDebitMinor: 2500,
  totalCreditMinor: 2300,
  ledgerBalanceMinor: 2500,
  bankStatementMinor: 2200,
  hasOpenEntries: true,
  isBankReconciled: false,
});

assert.equal(blocked.allowed, false);
assert.equal(blocked.status, 'OPEN');

console.log('Accounting period close tests passed');
