import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdmissionApplicantEmailContent, buildEmailAssetUrlCandidates, buildTransportConfig, buildSetupReminderTaskSections, fetchInlineLogo } from '../email.js';

test('buildTransportConfig respects SMTP_SECURE=false in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.SMTP_SECURE = 'false';

  const config = buildTransportConfig();

  assert.equal(config.secure, false);
  assert.equal(config.port, 587);
});

test('buildTransportConfig defaults to secure=true when SMTP_SECURE is unset in production', () => {
  process.env.NODE_ENV = 'production';
  delete process.env.SMTP_SECURE;

  const config = buildTransportConfig();

  assert.equal(config.secure, true);
});

test('buildSetupReminderTaskSections includes completed and missing setup items', () => {
  const sections = buildSetupReminderTaskSections(
    ['Enabled school phases', 'Academic years'],
    ['Classes', 'Subjects', 'Fee schedules'],
  );

  assert.match(sections.completedHtml, /Enabled school phases/);
  assert.match(sections.completedHtml, /Academic years/);
  assert.match(sections.missingHtml, /Classes/);
  assert.match(sections.missingHtml, /Subjects/);
  assert.match(sections.missingHtml, /Fee schedules/);
});

test('admission applicant email uses the school-branded teacher welcome shell', () => {
  const content = buildAdmissionApplicantEmailContent({
    schoolName: 'Greenfield Academy',
    subject: 'Your admission application has been received',
    body: 'Hello Raymond Ikenna,\n\nThank you for applying to Greenfield Academy.\n\nCheck your application here:\nhttps://schoolbase.live/admissions/greenfield/status',
    logoSrc: 'cid:school-logo-1',
  });

  assert.match(content.html, /class="email-container"/);
  assert.match(content.html, /class="header"/);
  assert.match(content.html, /src="cid:school-logo-1"/);
  assert.match(content.html, /<h1>Greenfield Academy<\/h1>/);
  assert.match(content.html, /Your admission application has been received/);
  assert.match(content.html, /href="https:\/\/schoolbase\.live\/admissions\/greenfield\/status"/);
  assert.doesNotMatch(content.html, /For: <strong>Greenfield Academy<\/strong>/);
  assert.match(content.text, /Greenfield Academy Admissions Team/);
});

test('admission applicant email escapes untrusted content before rendering HTML', () => {
  const content = buildAdmissionApplicantEmailContent({
    schoolName: '<img src=x onerror=alert(1)>',
    subject: 'Application received',
    body: 'Hello Applicant,\n\nI applied <script>alert(1)</script>',
    logoSrc: 'https://schoolbase.live/logo.png',
  });

  assert.match(content.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(content.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(content.html, /<script>alert\(1\)<\/script>/);
});

test('relative email assets try the configured backend before the public API fallback', () => {
  const environmentKeys = ['BACKEND_URL', 'API_URL', 'BACKEND_API_URL', 'NEXT_PUBLIC_API_URL'] as const;
  const previousValues = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

  try {
    process.env.BACKEND_URL = 'http://localhost:3006';
    delete process.env.API_URL;
    delete process.env.BACKEND_API_URL;
    process.env.NEXT_PUBLIC_API_URL = 'https://api.schoolbase.live';

    assert.deepEqual(
      buildEmailAssetUrlCandidates('/uploads/settings/school-logo.png'),
      [
        'http://localhost:3006/uploads/settings/school-logo.png',
        'https://api.schoolbase.live/uploads/settings/school-logo.png',
      ],
    );
  } finally {
    for (const key of environmentKeys) {
      const previousValue = previousValues[key];
      if (previousValue === undefined) delete process.env[key];
      else process.env[key] = previousValue;
    }
  }
});

test('inline school logo falls through from a missing local file to the public API', async () => {
  const environmentKeys = ['BACKEND_URL', 'API_URL', 'BACKEND_API_URL', 'NEXT_PUBLIC_API_URL'] as const;
  const previousValues = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  const logoBytes = Buffer.from('school-logo-image');

  try {
    process.env.BACKEND_URL = 'http://localhost:3006';
    delete process.env.API_URL;
    delete process.env.BACKEND_API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      return url.startsWith('https://api.schoolbase.live/')
        ? new Response(logoBytes, { status: 200, headers: { 'content-type': 'image/png' } })
        : new Response(null, { status: 404 });
    }) as typeof fetch;

    const logo = await fetchInlineLogo('/uploads/settings/missing-test-school-logo.png');

    assert.deepEqual(requestedUrls, [
      'http://localhost:3006/uploads/settings/missing-test-school-logo.png',
      'https://api.schoolbase.live/uploads/settings/missing-test-school-logo.png',
    ]);
    assert.ok(logo);
    assert.match(logo.src, /^cid:school-logo-/);
    assert.deepEqual(logo.attachment.content, logoBytes);
    assert.equal(logo.attachment.contentType, 'image/png');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of environmentKeys) {
      const previousValue = previousValues[key];
      if (previousValue === undefined) delete process.env[key];
      else process.env[key] = previousValue;
    }
  }
});
