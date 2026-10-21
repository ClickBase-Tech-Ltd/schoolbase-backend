import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFeeInvoiceIssuanceKey, normalizeFeeScheduleName } from '../src/services/fee-invoice-issuance.js';

test('normalizes schedule names for stable invoice issuance identity', () => {
  assert.equal(normalizeFeeScheduleName('  TÚITION   Fees '), 'tuition fees');
});

test('duplicate schedule rows for the same student and billing target share an issuance key', () => {
  const common = { pupilId: 'pupil-1', termId: 'term-1', classId: 'class-1', phase: 'PRIMARY' };
  assert.equal(
    buildFeeInvoiceIssuanceKey({ ...common, scheduleName: 'Tuition Fees' }),
    buildFeeInvoiceIssuanceKey({ ...common, scheduleName: '  TUITION   FEES ' }),
  );
});

test('different terms or schedule targets do not share an issuance key', () => {
  const input = {
    pupilId: 'pupil-1',
    termId: 'term-1',
    scheduleName: 'Tuition Fees',
    classId: 'class-1',
    phase: 'PRIMARY',
  };
  const key = buildFeeInvoiceIssuanceKey(input);

  assert.notEqual(buildFeeInvoiceIssuanceKey({ ...input, termId: 'term-2' }), key);
  assert.notEqual(buildFeeInvoiceIssuanceKey({ ...input, classId: 'class-2' }), key);
  assert.notEqual(buildFeeInvoiceIssuanceKey({ ...input, classId: null, phase: null }), key);
});
