import assert from 'node:assert/strict';
import {
  canApproveFinancingProduct,
  getFinancingProductActivationBlockers,
  getFinancingProductApprovalBlockers,
  InvalidFinancingProductInputError,
  parseFinancingProductInput,
} from '../src/services/financing-products.js';

const productInput = {
  institutionId: 'institution-1',
  code: 'TUITION_FLEX',
  displayName: 'Tuition Flex',
  summary: 'A bank-approved tuition product.',
  eligibilitySummary: 'Eligibility is assessed by the bank.',
  termsSummary: 'See the bank-approved terms for details.',
  termsUrl: 'https://bank.example/terms',
  termsVersion: '2026-01',
  currency: 'NGN',
  applicationMode: 'HOSTED',
  applicationUrl: 'https://bank.example/apply',
  effectiveAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2027-01-01T00:00:00.000Z',
};

const product = parseFinancingProductInput(productInput);
assert.equal(product.code, 'TUITION_FLEX');
assert.equal(product.currency, 'NGN');
assert.deepEqual(getFinancingProductActivationBlockers(product, 'HOSTED', 'AGREEMENT-1'), []);
assert.deepEqual(getFinancingProductApprovalBlockers(product, 'AGREEMENT-1'), []);
const demoProduct = parseFinancingProductInput({
  ...productInput,
  termsUrl: 'https://demo.invalid/terms',
  termsVersion: 'DEMO-ONLY-v1',
  applicationMode: 'SCHOOL_CONTACT',
  applicationUrl: null,
});
assert.deepEqual(getFinancingProductApprovalBlockers(demoProduct, 'DEMO-ONLY-NOT-BANK-APPROVAL'), []);
assert.deepEqual(
  getFinancingProductActivationBlockers(product, 'HOSTED', null),
  ['Record the bank/product approval reference.'],
);

assert.deepEqual(
  getFinancingProductActivationBlockers(
    { ...product, applicationMode: 'API' },
    'API',
    'AGREEMENT-1',
  ),
  ['API products cannot be activated until a verified institution-specific adapter is installed.'],
);
assert.equal(canApproveFinancingProduct('creator-1', 'approver-2'), true);
assert.equal(canApproveFinancingProduct('creator-1', 'creator-1'), true);
assert.equal(canApproveFinancingProduct('', 'creator-1'), false);
assert.equal(canApproveFinancingProduct('creator-1', ''), false);
assert.deepEqual(
  getFinancingProductApprovalBlockers({ ...product, termsUrl: null }, 'AGREEMENT-1'),
  ['Provide a link to the bank-approved full terms.'],
);

assert.throws(
  () => parseFinancingProductInput({ ...productInput, applicationUrl: 'http://bank.example/apply' }),
  InvalidFinancingProductInputError,
);
assert.throws(
  () => parseFinancingProductInput({ ...productInput, expiresAt: '2025-01-01T00:00:00.000Z' }),
  InvalidFinancingProductInputError,
);

console.log('Financing product configuration tests passed');
