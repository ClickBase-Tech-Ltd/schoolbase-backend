export const financingApplicationStatuses = [
  'DRAFT',
  'CONSENTED',
  'SUBMITTED',
  'UNDER_REVIEW',
  'MORE_INFO_REQUIRED',
  'OFFERED',
  'OFFER_ACCEPTED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type FinancingApplicationStatus = typeof financingApplicationStatuses[number];

const allowedTransitions: Record<FinancingApplicationStatus, readonly FinancingApplicationStatus[]> = {
  DRAFT: ['CONSENTED', 'SUBMITTED', 'CANCELLED', 'EXPIRED'],
  CONSENTED: ['SUBMITTED', 'CANCELLED', 'EXPIRED'],
  SUBMITTED: ['UNDER_REVIEW', 'MORE_INFO_REQUIRED', 'OFFERED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  UNDER_REVIEW: ['MORE_INFO_REQUIRED', 'OFFERED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  MORE_INFO_REQUIRED: ['SUBMITTED', 'CANCELLED', 'EXPIRED'],
  OFFERED: ['OFFER_ACCEPTED', 'CANCELLED', 'EXPIRED'],
  OFFER_ACCEPTED: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export class InvalidFinancingApplicationTransitionError extends Error {
  constructor(
    public readonly currentStatus: FinancingApplicationStatus,
    public readonly requestedStatus: FinancingApplicationStatus,
  ) {
    super(`Financing application cannot transition from ${currentStatus} to ${requestedStatus}.`);
    this.name = 'InvalidFinancingApplicationTransitionError';
  }
}

export function transitionFinancingApplication(
  currentStatus: FinancingApplicationStatus,
  requestedStatus: FinancingApplicationStatus,
): FinancingApplicationStatus {
  if (!allowedTransitions[currentStatus].includes(requestedStatus)) {
    throw new InvalidFinancingApplicationTransitionError(currentStatus, requestedStatus);
  }
  return requestedStatus;
}

export function getAllowedFinancingApplicationTransitions(
  currentStatus: FinancingApplicationStatus,
): readonly FinancingApplicationStatus[] {
  return allowedTransitions[currentStatus];
}
