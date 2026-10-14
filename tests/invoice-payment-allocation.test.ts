import assert from 'node:assert/strict';
import { validateInvoicePaymentAllocation } from '../src/services/invoice-payment-allocation.js';

assert.deepEqual(validateInvoicePaymentAllocation({ paymentAmountMinor: 1900, allocatedAmountMinor: 900, outstandingMinor: 1900 }), {
  valid: true,
  unallocatedAmountMinor: 1000,
});
assert.deepEqual(validateInvoicePaymentAllocation({ paymentAmountMinor: 900, allocatedAmountMinor: 900, outstandingMinor: 1900 }), {
  valid: true,
  unallocatedAmountMinor: 0,
});
assert.equal(validateInvoicePaymentAllocation({ paymentAmountMinor: 0, allocatedAmountMinor: 0, outstandingMinor: 1900 }).error, 'INVALID_PAYMENT_AMOUNT');
assert.equal(validateInvoicePaymentAllocation({ paymentAmountMinor: 2000, allocatedAmountMinor: 0, outstandingMinor: 1900 }).error, 'PAYMENT_EXCEEDS_BALANCE');
assert.equal(validateInvoicePaymentAllocation({ paymentAmountMinor: 900, allocatedAmountMinor: 1000, outstandingMinor: 1900 }).error, 'ALLOCATIONS_EXCEED_PAYMENT');

console.log('Invoice payment allocation tests passed');