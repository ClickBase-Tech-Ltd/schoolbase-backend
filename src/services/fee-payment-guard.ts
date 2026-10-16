export function parsePositiveAmountMinor(value: unknown): number | null {
  const amount = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(amount) || amount <= 0 || amount > Number.MAX_SAFE_INTEGER / 100) return null;

  const amountMinor = Math.round(amount * 100);
  return Number.isSafeInteger(amountMinor) && amountMinor > 0 ? amountMinor : null;
}

export function normalizePaymentIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const normalized = value.trim();
  if (!normalized || normalized.length > 191) return null;

  return normalized;
}

export function matchesPaymentIdempotencyRequest(input: {
  existing: {
    amount: number;
    method: string;
    reference: string | null;
    allocations?: Array<{ invoiceItemId: string; amount: number }>;
  };
  requested: {
    amount: number;
    method: string;
    reference: unknown;
    idempotencyKey: string;
    allocations?: unknown;
  };
}): boolean {
  const { existing, requested } = input;
  const referenceMatches = (!requested.reference && existing.reference === requested.idempotencyKey)
    || (typeof requested.reference === 'string' && existing.reference === requested.reference)
    || (requested.reference === undefined && existing.reference === null);
  const existingAllocations = canonicalPaymentAllocations(existing.allocations ?? []);
  const requestedAllocations = normalizeRequestedPaymentAllocations(requested.allocations);

  return existing.amount === requested.amount
    && existing.method === requested.method
    && referenceMatches
    && existingAllocations !== null
    && requestedAllocations !== null
    && existingAllocations === requestedAllocations;
}

function normalizeRequestedPaymentAllocations(value: unknown): string | null {
  if (!Array.isArray(value)) return canonicalPaymentAllocations([]);

  const allocations: Array<{ invoiceItemId: string; amount: number }> = [];
  for (const allocation of value) {
    if (!allocation || typeof allocation !== 'object') continue;
    const row = allocation as { invoiceItemId?: unknown; amount?: unknown };
    const invoiceItemId = String(row.invoiceItemId ?? '').trim();
    const amount = Number(row.amount);
    if (!invoiceItemId || !Number.isFinite(amount) || amount <= 0) continue;

    const amountMinor = Math.round(amount * 100);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
    allocations.push({ invoiceItemId, amount: amountMinor });
  }

  return canonicalPaymentAllocations(allocations);
}

function canonicalPaymentAllocations(allocations: Array<{ invoiceItemId: string; amount: number }>): string | null {
  const totals = new Map<string, number>();
  for (const allocation of allocations) {
    if (!allocation.invoiceItemId || !Number.isSafeInteger(allocation.amount) || allocation.amount <= 0) return null;
    const total = (totals.get(allocation.invoiceItemId) ?? 0) + allocation.amount;
    if (!Number.isSafeInteger(total)) return null;
    totals.set(allocation.invoiceItemId, total);
  }

  return JSON.stringify([...totals.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function buildInvoicePaymentCompareAndSet(input: {
  invoiceId: string;
  schoolId: string;
  currentAmountPaid: number;
  currentStatus: string;
  paymentAmountMinor: number;
  nextStatus: string;
}) {
  return {
    where: {
      id: input.invoiceId,
      schoolId: input.schoolId,
      amountPaid: input.currentAmountPaid,
      status: input.currentStatus,
    },
    data: {
      amountPaid: { increment: input.paymentAmountMinor },
      status: input.nextStatus,
    },
  };
}
