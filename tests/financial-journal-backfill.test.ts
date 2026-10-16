import assert from 'node:assert/strict';
import { classifyFinancialTransactionForBackfill } from '../src/services/financial-journal-backfill.js';

const eligible = { status: 'POSTED', invoiceId: null, paymentId: null, hasExistingJournal: false };
assert.equal(classifyFinancialTransactionForBackfill(eligible), 'ELIGIBLE');
assert.equal(classifyFinancialTransactionForBackfill({ ...eligible, status: 'REVERSED' }), 'ELIGIBLE');
assert.equal(classifyFinancialTransactionForBackfill({ ...eligible, status: 'DRAFT' }), 'SKIP_STATUS');
assert.equal(classifyFinancialTransactionForBackfill({ ...eligible, status: 'VOIDED' }), 'SKIP_STATUS');
assert.equal(classifyFinancialTransactionForBackfill({ ...eligible, invoiceId: 'invoice-1' }), 'SKIP_SOURCE_LINK');
assert.equal(classifyFinancialTransactionForBackfill({ ...eligible, paymentId: 'payment-1' }), 'SKIP_SOURCE_LINK');
assert.equal(classifyFinancialTransactionForBackfill({ ...eligible, reversalOfLinkedSource: true }), 'SKIP_SOURCE_LINK');
assert.equal(classifyFinancialTransactionForBackfill({ ...eligible, hasExistingJournal: true }), 'SKIP_ALREADY_JOURNALIZED');

console.log('Financial journal backfill classification tests passed');