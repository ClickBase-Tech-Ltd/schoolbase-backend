import assert from 'node:assert/strict';
import { buildBankChargeJournalLines, canApproveStatement, canPrepareStatement, canReopenStatement, canVoidStatement, remainingReconciliationAmount, validateReconciliationAllocation } from '../src/services/bank-statement-workflow.js';

assert.equal(canPrepareStatement({ status: 'IMPORTED', statementLineCount: 2, matchedStatementLineCount: 2, unmatchedLedgerLineCount: 0 }).allowed, true);
assert.equal(canPrepareStatement({ status: 'IMPORTED', statementLineCount: 2, matchedStatementLineCount: 1, unmatchedLedgerLineCount: 0 }).allowed, false);
assert.equal(canPrepareStatement({ status: 'IMPORTED', statementLineCount: 2, matchedStatementLineCount: 2, unmatchedLedgerLineCount: 1 }).allowed, false);
assert.equal(canApproveStatement({ status: 'PREPARED', preparerId: 'user-a', reviewerId: 'user-b' }).allowed, true);
assert.equal(canApproveStatement({ status: 'PREPARED', preparerId: 'user-a', reviewerId: 'user-a' }).allowed, false);
assert.equal(canReopenStatement({ status: 'RECONCILED', role: 'BURSAR', reason: 'correction' }).allowed, false);
assert.equal(canReopenStatement({ status: 'RECONCILED', role: 'SCHOOL_ADMIN', reason: 'correction' }).allowed, true);
assert.equal(canReopenStatement({ status: 'RECONCILED', role: 'SCHOOL_ADMIN', reason: '' }).allowed, false);
assert.equal(canVoidStatement({ status: 'IMPORTED', reason: 'duplicate import' }).allowed, true);
assert.equal(canVoidStatement({ status: 'RECONCILED', reason: 'duplicate import' }).allowed, false);
assert.equal(remainingReconciliationAmount(1000, 350), 650);
assert.equal(validateReconciliationAllocation({ statementAmountMinor: 1000, statementAllocatedMinor: 400, journalAmountMinor: 700, journalAllocatedMinor: 250, allocationAmountMinor: 450 }).allowed, true);
assert.equal(validateReconciliationAllocation({ statementAmountMinor: 1000, statementAllocatedMinor: 800, journalAmountMinor: 700, journalAllocatedMinor: 250, allocationAmountMinor: 250 }).allowed, false);
assert.equal(validateReconciliationAllocation({ statementAmountMinor: 1000, statementAllocatedMinor: 400, journalAmountMinor: 700, journalAllocatedMinor: 600, allocationAmountMinor: 200 }).allowed, false);
assert.equal(validateReconciliationAllocation({ statementAmountMinor: 1000, statementAllocatedMinor: 0, journalAmountMinor: 700, journalAllocatedMinor: 0, allocationAmountMinor: 0 }).allowed, false);
const bankCharge = buildBankChargeJournalLines({ bankAccountId: 'bank', bankChargesAccountId: 'fees', amountMinor: 425, reason: 'Monthly service charge' });
assert.deepEqual(bankCharge?.map(({ accountId, side, amount }) => [accountId, side, amount]), [['fees', 'DEBIT', 425], ['bank', 'CREDIT', 425]]);
assert.equal(buildBankChargeJournalLines({ bankAccountId: 'bank', bankChargesAccountId: 'fees', amountMinor: 0, reason: 'Charge' }), null);
assert.equal(buildBankChargeJournalLines({ bankAccountId: 'bank', bankChargesAccountId: 'fees', amountMinor: 425, reason: ' ' }), null);

console.log('Bank statement workflow tests passed');