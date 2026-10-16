import assert from 'node:assert/strict';
import { buildInvoicePaymentCompareAndSet, matchesPaymentIdempotencyRequest, normalizePaymentIdempotencyKey, parsePositiveAmountMinor } from '../src/services/fee-payment-guard.js';

assert.equal(parsePositiveAmountMinor('125.50'), 12550);
assert.equal(parsePositiveAmountMinor(0.01), 1);
assert.equal(parsePositiveAmountMinor(''), null);
assert.equal(parsePositiveAmountMinor('NaN'), null);
assert.equal(parsePositiveAmountMinor('Infinity'), null);
assert.equal(parsePositiveAmountMinor(-1), null);
assert.equal(parsePositiveAmountMinor(Number.MAX_VALUE), null);

assert.equal(normalizePaymentIdempotencyKey('  pay-123  '), 'pay-123');
assert.equal(normalizePaymentIdempotencyKey(''), null);
assert.equal(normalizePaymentIdempotencyKey('a'.repeat(300)), null);
assert.equal(normalizePaymentIdempotencyKey('   '), null);

const recordedPayment = { amount: 12550, method: 'BANK_TRANSFER', reference: 'bank-ref-1' };
assert.equal(matchesPaymentIdempotencyRequest({
  existing: { ...recordedPayment, allocations: [{ invoiceItemId: 'item-1', amount: 10000 }, { invoiceItemId: 'item-2', amount: 2550 }] },
  requested: { amount: 12550, method: 'BANK_TRANSFER', reference: 'bank-ref-1', idempotencyKey: 'pay-123', allocations: [{ invoiceItemId: 'item-2', amount: 25.5 }, { invoiceItemId: 'item-1', amount: 100 }] },
}), true);
assert.equal(matchesPaymentIdempotencyRequest({
  existing: { ...recordedPayment, reference: 'pay-123', allocations: [{ invoiceItemId: 'item-1', amount: 12550 }] },
  requested: { amount: 12550, method: 'BANK_TRANSFER', reference: null, idempotencyKey: 'pay-123', allocations: [{ invoiceItemId: 'item-1', amount: 125.5 }] },
}), true);
assert.equal(matchesPaymentIdempotencyRequest({
  existing: { ...recordedPayment, allocations: [{ invoiceItemId: 'item-1', amount: 12550 }] },
  requested: { amount: 12551, method: 'BANK_TRANSFER', reference: 'bank-ref-1', idempotencyKey: 'pay-123', allocations: [{ invoiceItemId: 'item-1', amount: 125.5 }] },
}), false);
assert.equal(matchesPaymentIdempotencyRequest({
  existing: { ...recordedPayment, allocations: [{ invoiceItemId: 'item-1', amount: 12550 }] },
  requested: { amount: 12550, method: 'CASH', reference: 'bank-ref-1', idempotencyKey: 'pay-123', allocations: [{ invoiceItemId: 'item-1', amount: 125.5 }] },
}), false);
assert.equal(matchesPaymentIdempotencyRequest({
  existing: { ...recordedPayment, allocations: [{ invoiceItemId: 'item-1', amount: 12550 }] },
  requested: { amount: 12550, method: 'BANK_TRANSFER', reference: 'different-ref', idempotencyKey: 'pay-123', allocations: [{ invoiceItemId: 'item-1', amount: 125.5 }] },
}), false);
assert.equal(matchesPaymentIdempotencyRequest({
  existing: { ...recordedPayment, allocations: [{ invoiceItemId: 'item-1', amount: 12550 }] },
  requested: { amount: 12550, method: 'BANK_TRANSFER', reference: 'bank-ref-1', idempotencyKey: 'pay-123', allocations: [{ invoiceItemId: 'item-2', amount: 125.5 }] },
}), false);
assert.equal(matchesPaymentIdempotencyRequest({
  existing: { ...recordedPayment, allocations: [{ invoiceItemId: 'item-1', amount: 12550 }] },
  requested: { amount: 12550, method: 'BANK_TRANSFER', reference: 'bank-ref-1', idempotencyKey: 'pay-123', allocations: [{ invoiceItemId: 'item-1', amount: 50 }, { invoiceItemId: 'item-1', amount: 75.5 }] },
}), true);

assert.deepEqual(buildInvoicePaymentCompareAndSet({
  invoiceId: 'invoice-1',
  schoolId: 'school-1',
  currentAmountPaid: 2500,
  currentStatus: 'PART_PAID',
  paymentAmountMinor: 500,
  nextStatus: 'PAID',
}), {
  where: {
    id: 'invoice-1',
    schoolId: 'school-1',
    amountPaid: 2500,
    status: 'PART_PAID',
  },
  data: {
    amountPaid: { increment: 500 },
    status: 'PAID',
  },
});

console.log('Fee payment guard tests passed');
