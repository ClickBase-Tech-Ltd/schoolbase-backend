export const SCHOOL_REVIEW_TEXT_MAX_LENGTH = 2000;

export type SchoolReviewSubmission = {
  rating: number;
  reviewText: string | null;
  publishConsent: boolean;
  schoolNameConsent: boolean;
  schoolLogoConsent: boolean;
};

export type SchoolReviewValidation =
  | { valid: true; value: SchoolReviewSubmission }
  | { valid: false; error: string };

export function validateSchoolReviewSubmission(input: unknown): SchoolReviewValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, error: 'Review details are required.' };
  }

  const value = input as Record<string, unknown>;
  if (!Number.isInteger(value.rating) || Number(value.rating) < 1 || Number(value.rating) > 5) {
    return { valid: false, error: 'Choose a rating from 1 to 5 stars.' };
  }

  if (value.reviewText !== undefined && value.reviewText !== null && typeof value.reviewText !== 'string') {
    return { valid: false, error: 'Review text must be plain text.' };
  }

  const reviewText = typeof value.reviewText === 'string' ? value.reviewText.trim() : '';
  if (reviewText.length > SCHOOL_REVIEW_TEXT_MAX_LENGTH) {
    return { valid: false, error: `Review text must be ${SCHOOL_REVIEW_TEXT_MAX_LENGTH} characters or fewer.` };
  }

  const consentFields = ['publishConsent', 'schoolNameConsent', 'schoolLogoConsent'] as const;
  if (consentFields.some((field) => value[field] !== undefined && typeof value[field] !== 'boolean')) {
    return { valid: false, error: 'Consent selections must be true or false.' };
  }

  const publishConsent = value.publishConsent === true;
  const schoolNameConsent = value.schoolNameConsent === true;
  const schoolLogoConsent = value.schoolLogoConsent === true;

  if (!publishConsent && (schoolNameConsent || schoolLogoConsent)) {
    return { valid: false, error: 'School identification consent requires publication consent.' };
  }

  return {
    valid: true,
    value: {
      rating: Number(value.rating),
      reviewText: reviewText || null,
      publishConsent,
      schoolNameConsent,
      schoolLogoConsent,
    },
  };
}

export function isPubliclyEligibleSchoolReview(review: {
  status: string;
  publishConsent: boolean;
  consentRevokedAt: Date | null;
}): boolean {
  return review.status === 'APPROVED' && review.publishConsent && review.consentRevokedAt === null;
}

export function schoolReviewPublicIdentity(review: {
  schoolNameConsent: boolean;
  schoolLogoConsent: boolean;
  school: { name: string; logoUrl: string | null };
}): { schoolName: string | null; schoolLogoUrl: string | null } {
  return {
    schoolName: review.schoolNameConsent ? review.school.name : null,
    schoolLogoUrl: review.schoolLogoConsent ? review.school.logoUrl : null,
  };
}

export function isTrustedSchoolBaseOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    const isSchoolBaseHost = hostname === 'schoolbase.live' || hostname.endsWith('.schoolbase.live');
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    return (isSchoolBaseHost && url.protocol === 'https:') || (isLocalHost && url.protocol === 'http:');
  } catch {
    return false;
  }
}

export function redactSchoolName(text: string | null, schoolName: string, mayIdentifySchool: boolean): string | null {
  if (!text || mayIdentifySchool || !schoolName.trim()) return text;
  const escapedName = schoolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escapedName, 'gi'), 'the school');
}