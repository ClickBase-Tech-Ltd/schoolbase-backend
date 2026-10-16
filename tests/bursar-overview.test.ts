import assert from 'node:assert/strict';
import { calculateSchoolFinanceSummary } from '../src/routes/bursar.ts';

const monthlyTransactions = [
  {
    id: 't1',
    type: 'INCOME',
    amount: 10000,
    description: 'Fee payment received for Ada Doe (INV-001)',
    category: { name: 'School Fees' },
  },
  {
    id: 't2',
    type: 'INCOME',
    amount: 3000,
    description: 'Grant received from PTA',
    category: { name: 'Other Income' },
  },
  {
    id: 't3',
    type: 'EXPENSE',
    amount: 5000,
    description: 'Electricity bill',
    category: { name: 'Utilities' },
  },
] as any;

const monthlyPayments = [
  { amount: 15000 },
  { amount: 20000 },
] as any;

const summary = calculateSchoolFinanceSummary({
  monthlyTransactions,
  monthlyPayments,
});

assert.equal(summary.monthlyIncome, 38000);
assert.equal(summary.monthlyExpenses, 5000);
assert.equal(summary.netMovement, 33000);
assert.equal(summary.cashPosition, 33000);

console.log('bursar overview summary test passed');
