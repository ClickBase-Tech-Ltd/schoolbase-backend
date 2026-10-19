type InvoiceBalanceInput = {
  status: string;
  amountDue: number;
  amountPaid: number;
};

const OUTSTANDING_STATUSES = new Set(['SENT', 'PART_PAID', 'OVERDUE']);

export function sumOutstandingInvoiceBalance(invoices: readonly InvoiceBalanceInput[]) {
  return invoices.reduce((total, invoice) => {
    if (!OUTSTANDING_STATUSES.has(invoice.status)) return total;
    return total + Math.max(0, invoice.amountDue - invoice.amountPaid);
  }, 0);
}