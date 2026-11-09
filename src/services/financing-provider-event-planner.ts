import {
  transitionFinancingApplication,
  type FinancingApplicationStatus,
} from './financing-application-lifecycle.js';
import type { NormalizedFinancingProviderEvent } from './financing-provider-contract.js';

export type FinancingProviderEventPlan =
  | {
      action: 'APPLICATION_STATUS_CHANGED';
      nextStatus: FinancingApplicationStatus;
    }
  | {
      action: 'APPLICATION_STATUS_UNCHANGED';
      currentStatus: FinancingApplicationStatus;
    }
  | {
      action: 'OFFER_RECORDED';
      nextStatus: 'OFFERED';
      offerReference: string;
    }
  | {
      action: 'DISBURSEMENT_PENDING_RECONCILIATION';
      amountMinor: number;
      currency: string;
      settlementReference: string;
    }
  | {
      action: 'DISBURSEMENT_REQUIRES_REVIEW';
      reason: 'APPLICATION_OFFER_NOT_ACCEPTED';
      amountMinor: number;
      currency: string;
      settlementReference: string;
    };

export function planFinancingProviderEvent(
  currentStatus: FinancingApplicationStatus,
  event: NormalizedFinancingProviderEvent,
): FinancingProviderEventPlan {
  if (event.type === 'APPLICATION_STATUS') {
    if (event.status === currentStatus) {
      return { action: 'APPLICATION_STATUS_UNCHANGED', currentStatus };
    }
    return {
      action: 'APPLICATION_STATUS_CHANGED',
      nextStatus: transitionFinancingApplication(currentStatus, event.status),
    };
  }

  if (event.type === 'OFFER_ISSUED') {
    if (currentStatus !== 'OFFERED') {
      transitionFinancingApplication(currentStatus, 'OFFERED');
    }
    return {
      action: 'OFFER_RECORDED',
      nextStatus: 'OFFERED',
      offerReference: event.offerReference,
    };
  }

  const disbursement = {
    amountMinor: event.amountMinor,
    currency: event.currency,
    settlementReference: event.settlementReference,
  };
  if (currentStatus !== 'OFFER_ACCEPTED') {
    return {
      action: 'DISBURSEMENT_REQUIRES_REVIEW',
      reason: 'APPLICATION_OFFER_NOT_ACCEPTED',
      ...disbursement,
    };
  }
  return {
    action: 'DISBURSEMENT_PENDING_RECONCILIATION',
    ...disbursement,
  };
}
