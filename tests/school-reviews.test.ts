import assert from 'node:assert/strict';
import { isPubliclyEligibleSchoolReview, isTrustedSchoolBaseOrigin, redactSchoolName, schoolReviewPublicIdentity, validateSchoolReviewSubmission } from '../src/services/school-reviews.js';

const validInput = {
  rating: 5,
  reviewText: '  Reliable and straightforward to use.  ',
  publishConsent: true,
  schoolNameConsent: false,
  schoolLogoConsent: false,
};

const valid = validateSchoolReviewSubmission(validInput);
assert.equal(valid.valid, true);
if (valid.valid) {
  assert.equal(valid.value.reviewText, 'Reliable and straightforward to use.');
  assert.equal(valid.value.schoolNameConsent, false);
}

for (const rating of [0, 6, 2.5, '5', null]) {
  assert.equal(validateSchoolReviewSubmission({ ...validInput, rating }).valid, false);
}
assert.equal(validateSchoolReviewSubmission({ ...validInput, reviewText: 'x'.repeat(2001) }).valid, false);
assert.equal(validateSchoolReviewSubmission({ ...validInput, reviewText: '<script>alert(1)</script>' }).valid, true);
assert.equal(validateSchoolReviewSubmission({ ...validInput, publishConsent: false, schoolNameConsent: true }).valid, false);
assert.equal(validateSchoolReviewSubmission({ ...validInput, schoolLogoConsent: 'yes' }).valid, false);

assert.equal(isPubliclyEligibleSchoolReview({ status: 'PENDING', publishConsent: true, consentRevokedAt: null }), false);
assert.equal(isPubliclyEligibleSchoolReview({ status: 'REJECTED', publishConsent: true, consentRevokedAt: null }), false);
assert.equal(isPubliclyEligibleSchoolReview({ status: 'APPROVED', publishConsent: false, consentRevokedAt: null }), false);
assert.equal(isPubliclyEligibleSchoolReview({ status: 'APPROVED', publishConsent: true, consentRevokedAt: new Date() }), false);
assert.equal(isPubliclyEligibleSchoolReview({ status: 'APPROVED', publishConsent: true, consentRevokedAt: null }), true);

const privateIdentity = schoolReviewPublicIdentity({
  schoolNameConsent: false,
  schoolLogoConsent: false,
  school: { name: 'Private Academy', logoUrl: 'https://example.test/logo.png' },
});
assert.deepEqual(privateIdentity, { schoolName: null, schoolLogoUrl: null });
assert.equal(redactSchoolName('We at Private Academy have used SchoolBase for a year.', 'Private Academy', false), 'We at the school have used SchoolBase for a year.');
assert.equal(redactSchoolName('Great service from Private Academy', 'Private Academy', true), 'Great service from Private Academy');

assert.equal(isTrustedSchoolBaseOrigin('https://schoolbase.live'), true);
assert.equal(isTrustedSchoolBaseOrigin('https://www.schoolbase.live'), true);
assert.equal(isTrustedSchoolBaseOrigin('http://localhost:3000'), true);
assert.equal(isTrustedSchoolBaseOrigin('https://schoolbase.live.attacker.example'), false);
assert.equal(isTrustedSchoolBaseOrigin('http://schoolbase.live'), false);
assert.equal(isTrustedSchoolBaseOrigin(undefined), false);

console.log('School review policy tests passed');