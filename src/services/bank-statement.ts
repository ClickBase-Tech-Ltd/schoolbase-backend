import { createHash } from 'node:crypto';

export type ParsedBankStatementLine = {
  transactionDate: Date;
  description: string;
  reference: string | null;
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: number;
};

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(field.trim());
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && csv[index + 1] === '\n') index += 1;
      row.push(field.trim());
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  row.push(field.trim());
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseMinorAmount(value: string): number | null {
  const normalized = value.replace(/[\s,₦$£€]/g, '');
  if (!normalized) return 0;
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(amount) ? amount : null;
}

export function parseBankStatementCsv(csv: string): ParsedBankStatementLine[] {
  if (csv.length > 5_000_000) throw new Error('CSV file exceeds the 5 MB limit.');
  const rows = parseCsvRows(csv);
  if (rows.length < 2) throw new Error('CSV must include a header and at least one transaction.');

  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, '').toLowerCase().replace(/\s+/g, '').replace(/[_-]/g, ''));
  const dateIndex = headers.findIndex((header) => ['date', 'transactiondate', 'valuedate'].includes(header));
  const descriptionIndex = headers.findIndex((header) => ['description', 'details', 'narration', 'memo'].includes(header));
  const referenceIndex = headers.findIndex((header) => ['reference', 'referencenumber', 'transactionid'].includes(header));
  const debitIndex = headers.findIndex((header) => header === 'debit');
  const creditIndex = headers.findIndex((header) => header === 'credit');
  const amountIndex = headers.findIndex((header) => header === 'amount');
  const typeIndex = headers.findIndex((header) => ['type', 'direction'].includes(header));

  if (dateIndex < 0 || descriptionIndex < 0 || (amountIndex < 0 && (debitIndex < 0 || creditIndex < 0))) {
    throw new Error('CSV needs Date and Description columns, plus Amount/Type or Debit/Credit columns.');
  }

  const parsed = rows.slice(1).map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV row ${index + 2} has an unexpected number of columns.`);
    const transactionDate = parseDate(values[dateIndex]);
    const description = values[descriptionIndex].trim();
    const reference = referenceIndex >= 0 ? values[referenceIndex].trim() || null : null;
    if (!transactionDate || !description) throw new Error(`CSV row ${index + 2} needs a valid date and description.`);

    let direction: 'DEBIT' | 'CREDIT';
    let amountMinor: number | null;
    if (amountIndex >= 0) {
      const amountText = values[amountIndex].trim();
      const negative = amountText.startsWith('-') || (amountText.startsWith('(') && amountText.endsWith(')'));
      amountMinor = parseMinorAmount(amountText.replace(/[()-]/g, ''));
      const type = typeIndex >= 0 ? values[typeIndex].trim().toUpperCase() : '';
      if (type === 'DEBIT' || type === 'WITHDRAWAL' || type === 'DR') direction = 'DEBIT';
      else if (type === 'CREDIT' || type === 'DEPOSIT' || type === 'CR') direction = 'CREDIT';
      else if (type) throw new Error(`CSV row ${index + 2} has an unsupported transaction type.`);
      else direction = negative ? 'DEBIT' : 'CREDIT';
    } else {
      const debit = parseMinorAmount(values[debitIndex] ?? '');
      const credit = parseMinorAmount(values[creditIndex] ?? '');
      if (debit === null || credit === null || (debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
        throw new Error(`CSV row ${index + 2} must have exactly one positive debit or credit amount.`);
      }
      direction = debit > 0 ? 'DEBIT' : 'CREDIT';
      amountMinor = debit || credit;
    }

    if (amountMinor === null || amountMinor <= 0) throw new Error(`CSV row ${index + 2} must have a positive amount.`);
    return { transactionDate, description, reference, direction, amountMinor };
  });

  return parsed;
}

export function checksumBankStatement(csv: string): string {
  return createHash('sha256').update(csv, 'utf8').digest('hex');
}