import assert from 'node:assert/strict';
import { sumOutstandingInvoiceBalance } from '../src/services/invoice-balance.js';

assert.equal(sumOutstandingInvoiceBalance([
  { status: 'SENT', amountDue: 10000, amountPaid: 0 },
  { status: 'PART_PAID', amountDue: 10000, amountPaid: 2500 },
  { status: 'OVERDUE', amountDue: 5000, amountPaid: 6000 },
  { status: 'PAID', amountDue: 3000, amountPaid: 3000 },
  { status: 'VOIDED', amountDue: 7000, amountPaid: 0 },
  { status: 'DRAFT', amountDue: 2000, amountPaid: 0 },
]), 17500);

console.log('Invoice balance tests passed');