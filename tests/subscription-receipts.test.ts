import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { buildSubscriptionReceiptPdf, type SubscriptionReceiptData } from '../src/services/subscription-receipts.js';

process.env.SCHOOLBASE_LOGO_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2N8AAAAASUVORK5CYII=';

const receipt: SubscriptionReceiptData = {
  id: 'payment12345678',
  receiptNumber: 'SB-2026-12345678',
  schoolId: 'school-1',
  schoolName: 'Bright Future School',
  schoolEmails: ['billing@school.example'],
  plan: 'STARTER',
  amountMinor: 4200000,
  currency: 'NGN',
  method: 'BANK_TRANSFER',
  reference: 'BANK-REF-2026-001',
  paidAt: new Date('2026-11-05T07:00:00.000Z'),
  billingAction: 'RENEWAL',
  applicationStatus: 'APPLIED',
  subscriptionExpiresAt: new Date('2027-02-03T07:00:00.000Z'),
};

const bytes = await buildSubscriptionReceiptPdf(receipt);
assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), '%PDF-');
const document = await PDFDocument.load(bytes);
assert.equal(document.getPageCount(), 1);
assert.equal(document.getTitle(), `SchoolBase payment receipt ${receipt.receiptNumber}`);

console.log('Subscription receipt PDF generation test passed.');
