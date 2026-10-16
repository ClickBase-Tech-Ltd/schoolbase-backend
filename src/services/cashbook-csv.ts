export interface CashbookCsvRow {
  id: string;
  transactionDate: Date | string;
  type: string;
  amount: number;
  currency: string;
  status: string;
  categoryName: string;
  description?: string | null;
  referenceNumber?: string | null;
  createdByName: string;
  postedByName?: string | null;
}

function csvCell(value: unknown, protectFormula = true): string {
  let text = String(value ?? '');
  if (protectFormula && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildCashbookCsv(rows: CashbookCsvRow[]): string {
  const header = ['ID', 'Transaction Date', 'Type', 'Amount Minor Units', 'Currency', 'Status', 'Category', 'Description', 'Reference', 'Recorded By', 'Approved By'];
  const records = rows.map((row) => [
    row.id,
    new Date(row.transactionDate).toISOString(),
    row.type,
    String(row.amount),
    row.currency,
    row.status,
    row.categoryName,
    row.description ?? '',
    row.referenceNumber ?? '',
    row.createdByName,
    row.postedByName ?? '',
  ].map((value, index) => csvCell(value, index !== 3)).join(','));
  return [header.map((value) => csvCell(value, false)).join(','), ...records].join('\r\n');
}