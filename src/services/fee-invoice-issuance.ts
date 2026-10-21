import { createHash } from 'node:crypto';

export function normalizeFeeScheduleName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function buildFeeInvoiceIssuanceKey(input: {
  pupilId: string;
  termId: string;
  scheduleName: string;
  classId?: string | null;
  phase?: string | null;
}): string {
  const identity = [
    'fee-invoice-v2',
    input.pupilId,
    input.termId,
    normalizeFeeScheduleName(input.scheduleName),
    input.classId ?? null,
    input.phase ?? null,
  ];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
