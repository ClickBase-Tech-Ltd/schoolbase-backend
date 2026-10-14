export type InvoicePaymentAllocationInput = {
  paymentAmountMinor: number;
  allocatedAmountMinor: number;
  outstandingMinor: number;
};

export type InvoicePaymentAllocationResult = {
  valid: boolean;
  unallocatedAmountMinor: number;
  error?: 'INVALID_PAYMENT_AMOUNT' | 'PAYMENT_EXCEEDS_BALANCE' | 'ALLOCATIONS_EXCEED_PAYMENT';
};

export function validateInvoicePaymentAllocation(input: InvoicePaymentAllocationInput): InvoicePaymentAllocationResult {
  const { paymentAmountMinor, allocatedAmountMinor, outstandingMinor } = input;
  if (!Number.isSafeInteger(paymentAmountMinor) || paymentAmountMinor <= 0 || !Number.isSafeInteger(allocatedAmountMinor) || allocatedAmountMinor < 0) {
    return { valid: false, unallocatedAmountMinor: 0, error: 'INVALID_PAYMENT_AMOUNT' };
  }
  if (!Number.isSafeInteger(outstandingMinor) || paymentAmountMinor > outstandingMinor) {
    return { valid: false, unallocatedAmountMinor: 0, error: 'PAYMENT_EXCEEDS_BALANCE' };
  }
  if (allocatedAmountMinor > paymentAmountMinor) {
    return { valid: false, unallocatedAmountMinor: 0, error: 'ALLOCATIONS_EXCEED_PAYMENT' };
  }
  return { valid: true, unallocatedAmountMinor: paymentAmountMinor - allocatedAmountMinor };
}