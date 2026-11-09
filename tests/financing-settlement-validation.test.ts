import assert from 'node:assert/strict';
import {
  FinancingSettlementValidationError,
  validateFinancingSettlementCandidate,
  type FinancingSettlementCandidate,
} from '../src/services/financing-settlement-validation.js';

const validCandidate: FinancingSettlementCandidate = {
  bankConfirmed: true,
  reconciled: true,
  amountMinor: 2500,
  outstandingMinor: 5000,
  settlementCurrency: 'NGN',
  invoiceCurrency: 'ngn',
  settlementReference: ' bank-ref-1 ',
};

assert.deepEqual(validateFinancingSettlementCandidate(validCandidate), {
  amountMinor: 2500,
  currency: 'NGN',
  settlementReference: 'bank-ref-1',
});

const partialSettlement = validateFinancingSettlementCandidate({
  ...validCandidate,
  amountMinor: 2500,
  outstandingMinor: 5000,
});
assert.equal(partialSettlement.amountMinor < validCandidate.outstandingMinor, true);

function assertRejected(
  candidate: FinancingSettlementCandidate,
  code: FinancingSettlementValidationError['code'],
) {
  assert.throws(
    () => validateFinancingSettlementCandidate(candidate),
    (error: unknown) => error instanceof FinancingSettlementValidationError && error.code === code,
  );
}

assertRejected({ ...validCandidate, bankConfirmed: false }, 'SETTLEMENT_NOT_CONFIRMED');
assertRejected({ ...validCandidate, reconciled: false }, 'SETTLEMENT_NOT_RECONCILED');
assertRejected({ ...validCandidate, amountMinor: 0 }, 'INVALID_SETTLEMENT_AMOUNT');
assertRejected({ ...validCandidate, amountMinor: Number.MAX_SAFE_INTEGER + 1 }, 'INVALID_SETTLEMENT_AMOUNT');
assertRejected({ ...validCandidate, outstandingMinor: -1 }, 'INVALID_OUTSTANDING_AMOUNT');
assertRejected({ ...validCandidate, outstandingMinor: 0 }, 'NO_OUTSTANDING_BALANCE');
assertRejected({ ...validCandidate, amountMinor: 5001, outstandingMinor: 5000 }, 'SETTLEMENT_EXCEEDS_OUTSTANDING');
assertRejected({ ...validCandidate, settlementCurrency: 'N'}, 'INVALID_CURRENCY');
assertRejected({ ...validCandidate, settlementCurrency: 'GHS' }, 'CURRENCY_MISMATCH');
assertRejected({ ...validCandidate, settlementReference: '  ' }, 'INVALID_SETTLEMENT_REFERENCE');
assertRejected({ ...validCandidate, settlementReference: 'x'.repeat(192) }, 'INVALID_SETTLEMENT_REFERENCE');

console.log('Financing settlement validation tests passed');
