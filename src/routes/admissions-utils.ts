export type AdmissionStatus = 'SUBMITTED' | 'UNDER_REVIEW' | 'NEEDS_INFORMATION' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

const STATUS_VALUES: Record<string, AdmissionStatus> = {
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  'UNDER-REVIEW': 'UNDER_REVIEW',
  NEEDS_INFORMATION: 'NEEDS_INFORMATION',
  'NEEDS INFORMATION': 'NEEDS_INFORMATION',
  'NEEDS-INFORMATION': 'NEEDS_INFORMATION',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
};

const STATUS_LABELS: Record<AdmissionStatus, string> = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under Review',
  NEEDS_INFORMATION: 'Needs Information',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

const ADMISSION_TRANSITIONS: Record<AdmissionStatus, AdmissionStatus[]> = {
  SUBMITTED: ['UNDER_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'WITHDRAWN'],
  UNDER_REVIEW: ['NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'WITHDRAWN'],
  NEEDS_INFORMATION: ['UNDER_REVIEW', 'REJECTED', 'WITHDRAWN'],
  APPROVED: [],
  REJECTED: [],
  WITHDRAWN: [],
};

export function normalizeAdmissionStatus(value?: string | null): AdmissionStatus {
  if (!value) return 'SUBMITTED';
  const normalized = String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
  return STATUS_VALUES[normalized] ?? 'SUBMITTED';
}

export function isAdmissionApprovalStatus(value?: string | null): boolean {
  return normalizeAdmissionStatus(value) === 'APPROVED';
}

export function getAdmissionStatusLabel(status?: string | null): string {
  const normalized = normalizeAdmissionStatus(status);
  return STATUS_LABELS[normalized] ?? STATUS_LABELS.SUBMITTED;
}

export function canTransitionAdmissionStatus(from: string | null | undefined, to: string | null | undefined): boolean {
  const current = normalizeAdmissionStatus(from);
  const next = normalizeAdmissionStatus(to);
  return current === next || ADMISSION_TRANSITIONS[current].includes(next);
}

export function requiresAdmissionDecisionReason(status: string | null | undefined): boolean {
  const normalized = normalizeAdmissionStatus(status);
  return normalized === 'REJECTED' || normalized === 'WITHDRAWN';
}

export function validateApplicantAdmissionReply(value: unknown): { valid: true; message: string } | { valid: false; error: string } {
  if (typeof value !== 'string') return { valid: false, error: 'Reply must be text' };
  const message = value.trim();
  if (message.length < 2) return { valid: false, error: 'Reply must contain at least 2 characters' };
  if (message.length > 5000) return { valid: false, error: 'Reply must be 5,000 characters or fewer' };
  return { valid: true, message };
}
