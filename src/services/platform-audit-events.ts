export type PlatformAuditCategory =
  | 'ACCESS'
  | 'SCHOOL'
  | 'STUDENT'
  | 'ACADEMICS'
  | 'FINANCE'
  | 'COMMUNICATIONS'
  | 'MARKETING'
  | 'COMPETITION'
  | 'CONFIGURATION'
  | 'OPERATIONS';

export type PlatformAuditEvent = {
  category: PlatformAuditCategory;
  action: string;
  resourceType: string;
  summary: string;
};

export type PlatformAuditOutcome = 'SUCCESS' | 'REDIRECTED' | 'REJECTED' | 'FAILED' | 'NOT_RECORDED';

const idPattern = /^(?:cm[a-z0-9]{16,}|[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}|\d{12,})$/i;

export function compactAuditEventFilters(eventNames: string[]) {
  const exactEvents = new Set<string>();
  const eventPrefixes = new Set<string>();
  const dynamicIdPattern = /^(.*?)(?:cm[a-z0-9]{16,}|[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}|\d{12,})(?:_|$)/i;

  for (const eventName of eventNames) {
    const match = eventName.match(dynamicIdPattern);
    if (match?.[1]) eventPrefixes.add(match[1]);
    else exactEvents.add(eventName);
  }

  return { events: Array.from(exactEvents), eventPrefixes: Array.from(eventPrefixes) };
}

function cleanPath(path: string): string {
  return path.split(/[?#]/, 1)[0] || '/';
}

function readableResource(path: string): string {
  const tokens = cleanPath(path).split('/').filter(Boolean)
    .filter((token) => !['api', 'schoolbase-admin'].includes(token.toLowerCase()))
    .filter((token) => token !== ':id' && !idPattern.test(token));
  const resource = tokens.at(-1) || 'platform settings';
  const normalized = resource.replace(/[-_]/g, ' ').replace(/\bapi\b/gi, '').trim();
  const labels: Record<string, string> = {
    'activity': 'platform activity',
    'activity summary': 'activity summary',
    'audit logs': 'audit records',
    'exam practices': 'exam practice',
    'question sets': 'question set',
    'signups': 'school signup',
    'students import': 'student records',
    'whatsapp': 'WhatsApp',
  };
  const lower = normalized.toLowerCase();
  if (labels[lower]) return labels[lower]!;
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase()) || 'platform settings';
}

function classifyPath(method: string, path: string): PlatformAuditEvent {
  const normalizedPath = cleanPath(path).toLowerCase();
  const resourceType = readableResource(normalizedPath);
  const verb = method.toUpperCase();

  if (/\/(login|logout|session|auth)(\/|$)/.test(normalizedPath)) {
    const action = normalizedPath.includes('logout') ? 'session.ended' : 'session.updated';
    return { category: 'ACCESS', action, resourceType: 'Session', summary: normalizedPath.includes('logout') ? 'Ended a user session' : 'Updated authentication session' };
  }
  if (normalizedPath.includes('/signups/approve')) return { category: 'SCHOOL', action: 'school.signup.approved', resourceType: 'School signup', summary: 'Approved a school signup' };
  if (normalizedPath.includes('/signups/remind')) return { category: 'SCHOOL', action: 'school.signup.reminder_sent', resourceType: 'School signup', summary: 'Sent a school signup reminder' };
  if (normalizedPath.includes('/ads/apply')) return { category: 'MARKETING', action: 'advertiser.application.received', resourceType: 'Advertiser application', summary: 'Received an advertiser application' };
  if (normalizedPath.includes('/ads/advertisers') && normalizedPath.endsWith('/verify')) return { category: 'MARKETING', action: 'advertiser.verified', resourceType: 'Advertiser', summary: 'Verified an advertiser' };
  if (normalizedPath.includes('/ads/advertisers') && normalizedPath.endsWith('/reject')) return { category: 'MARKETING', action: 'advertiser.rejected', resourceType: 'Advertiser', summary: 'Rejected an advertiser application' };
  if (normalizedPath.includes('/ads/campaigns') && normalizedPath.endsWith('/submit')) return { category: 'MARKETING', action: 'campaign.submitted', resourceType: 'Advertising campaign', summary: 'Submitted an advertising campaign for review' };
  if (normalizedPath.includes('/ads/campaigns') && normalizedPath.endsWith('/approve')) return { category: 'MARKETING', action: 'campaign.approved', resourceType: 'Advertising campaign', summary: 'Approved an advertising campaign' };
  if (normalizedPath.includes('/ads/campaigns') && normalizedPath.endsWith('/live')) return { category: 'MARKETING', action: 'campaign.activated', resourceType: 'Advertising campaign', summary: 'Activated an advertising campaign' };
  if (/\/settings(?:\/|$)/.test(normalizedPath)) return { category: 'CONFIGURATION', action: 'platform.settings.updated', resourceType: 'Platform settings', summary: 'Updated platform settings' };
  if (/\/schools(?:\/|$)/.test(normalizedPath)) return genericEvent('SCHOOL', verb, 'School records');
  if (normalizedPath.includes('/students/import')) return { category: 'STUDENT', action: 'student.imported', resourceType: 'Student records', summary: 'Imported student records' };
  if (normalizedPath.includes('/results') && normalizedPath.includes('publish')) return { category: 'ACADEMICS', action: 'results.published', resourceType: 'Results', summary: 'Published school results' };
  if (normalizedPath.includes('/whatsapp/send-message')) return { category: 'COMMUNICATIONS', action: 'message.sent', resourceType: 'WhatsApp message', summary: 'Sent a WhatsApp message' };
  if (normalizedPath.includes('/whatsapp/connect')) return { category: 'COMMUNICATIONS', action: 'whatsapp.connection_started', resourceType: 'WhatsApp connection', summary: 'Started a WhatsApp connection' };
  if (normalizedPath.includes('/whatsapp/disconnect')) return { category: 'COMMUNICATIONS', action: 'whatsapp.disconnected', resourceType: 'WhatsApp connection', summary: 'Disconnected WhatsApp' };
  if (/\/(verify|verification)(\/|$)/.test(normalizedPath)) return { category: 'SCHOOL', action: 'school.verification.updated', resourceType: 'School verification', summary: 'Updated school verification' };
  if (/\/competition\/school\/tournaments\/[^/]+\/register-school$/.test(normalizedPath)) return { category: 'COMPETITION', action: 'tournament.school_registration.requested', resourceType: 'Tournament registration', summary: 'Requested school tournament registration' };
  if (/\/competition\/school\/tournaments\/[^/]+\/nominations$/.test(normalizedPath)) return { category: 'COMPETITION', action: 'tournament.pupils.nominated', resourceType: 'Tournament nominations', summary: 'Nominated students for a tournament' };
  if (/\/competition\/school\/tournaments\/[^/]+\/decline-invitation$/.test(normalizedPath)) return { category: 'COMPETITION', action: 'tournament.invitation.declined', resourceType: 'Tournament invitation', summary: 'Declined a tournament invitation' };
  if (/\/competition\/school\/tournaments\/[^/]+\/register$/.test(normalizedPath)) return { category: 'COMPETITION', action: 'tournament.participation.requested', resourceType: 'Tournament participation', summary: 'Accepted or requested tournament participation' };
  if (/\/competition\/admin\/tournaments\/matches\/[^/]+\/result$/.test(normalizedPath)) return { category: 'COMPETITION', action: 'tournament.match.result_recorded', resourceType: 'Tournament match', summary: 'Recorded a tournament match result' };
  if (/\/competition\/admin\/tournaments\/[^/]+\/status$/.test(normalizedPath)) return { category: 'COMPETITION', action: 'tournament.status.updated', resourceType: 'Tournament', summary: 'Updated tournament status' };
  if (normalizedPath.includes('/competition/')) return genericEvent('COMPETITION', verb, resourceType);
  if (/\/(students|pupils)(\/|$)/.test(normalizedPath)) return genericEvent('STUDENT', verb, 'Student');
  if (/\/(attendance)(\/|$)/.test(normalizedPath)) return genericEvent('ACADEMICS', verb, 'Attendance');
  if (/\/(results|assessments|subjects|classes|teachers|timetable)(\/|$)/.test(normalizedPath)) return genericEvent('ACADEMICS', verb, resourceType);
  if (/\/(fees|invoices|payments|cashbook)(\/|$)/.test(normalizedPath)) return genericEvent('FINANCE', verb, resourceType);
  if (/\/(ads|campaigns|advertisers)(\/|$)/.test(normalizedPath)) return genericEvent('MARKETING', verb, resourceType);
  if (/\/(whatsapp|emails|communications|announcements)(\/|$)/.test(normalizedPath)) return genericEvent('COMMUNICATIONS', verb, resourceType);
  if (/\/(settings|configuration|plans|subscriptions)(\/|$)/.test(normalizedPath)) return genericEvent('CONFIGURATION', verb, resourceType);
  if (/\/(schools|signups)(\/|$)/.test(normalizedPath)) return genericEvent('SCHOOL', verb, resourceType);
  return genericEvent('OPERATIONS', verb, resourceType);
}

function genericEvent(category: PlatformAuditCategory, method: string, resourceType: string): PlatformAuditEvent {
  const verb = method === 'POST' ? 'created' : method === 'DELETE' ? 'removed' : method === 'GET' ? 'viewed' : 'updated';
  const actionVerb = verb === 'created' ? 'created' : verb === 'removed' ? 'removed' : verb === 'viewed' ? 'viewed' : 'updated';
  return {
    category,
    action: `${category.toLowerCase()}.${actionVerb}`,
    resourceType,
    summary: `${verb[0]?.toUpperCase()}${verb.slice(1)} ${resourceType}`,
  };
}

export function classifyPlatformAuditEvent(method: string, path: string): PlatformAuditEvent {
  return classifyPath(method, path);
}

export function extractPlatformAuditResourceId(path: string): string | undefined {
  return cleanPath(path).split('/').filter(Boolean).find((token) => idPattern.test(token));
}

export function normalizeLegacyPlatformAuditEvent(event: string, details: string | null | undefined): PlatformAuditEvent {
  const requestMatch = details?.match(/^\s*(GET|POST|PUT|PATCH|DELETE)\s+([^|\s]+)/i);
  if (requestMatch) return classifyPath(requestMatch[1]!, requestMatch[2]!);

  const apiMatch = event.match(/^API_(GET|POST|PUT|PATCH|DELETE)_(.+)$/i);
  if (apiMatch) {
    const route = apiMatch[2]!.replace(/cm[a-z0-9]{16,}/gi, ':id').replace(/_/g, '/');
    return classifyPath(apiMatch[1]!, `/${route}`);
  }

  const mapped: Record<string, PlatformAuditEvent> = {
    UPGRADE: { category: 'CONFIGURATION', action: 'school.plan.upgraded', resourceType: 'School plan', summary: 'Upgraded a school plan' },
    SETPLAN: { category: 'CONFIGURATION', action: 'school.plan.updated', resourceType: 'School plan', summary: 'Updated a school plan' },
    SET_PLAN: { category: 'CONFIGURATION', action: 'school.plan.updated', resourceType: 'School plan', summary: 'Updated a school plan' },
    CANCEL: { category: 'CONFIGURATION', action: 'school.subscription.cancelled', resourceType: 'Subscription', summary: 'Cancelled a school subscription' },
    SUSPEND: { category: 'SCHOOL', action: 'school.suspended', resourceType: 'School', summary: 'Suspended a school' },
    ACTIVATE: { category: 'SCHOOL', action: 'school.activated', resourceType: 'School', summary: 'Activated a school' },
    IMPERSONATE: { category: 'ACCESS', action: 'admin.impersonated_school', resourceType: 'School session', summary: 'Started school impersonation' },
    LOGIN_SUCCESS: { category: 'ACCESS', action: 'session.login_succeeded', resourceType: 'Session', summary: 'Signed in successfully' },
    LOGIN_FAILED: { category: 'ACCESS', action: 'session.login_failed', resourceType: 'Session', summary: 'Failed sign-in attempt' },
    SCHOOL_SIGNUP_COMPLETED: { category: 'SCHOOL', action: 'school.signup.completed', resourceType: 'School signup', summary: 'Completed a school signup' },
    STUDENT_REGISTERED: { category: 'STUDENT', action: 'student.registered', resourceType: 'Student', summary: 'Registered a student' },
    STUDENTS_IMPORTED: { category: 'STUDENT', action: 'student.imported', resourceType: 'Student records', summary: 'Imported student records' },
    PAYMENT_RECORDED: { category: 'FINANCE', action: 'payment.recorded', resourceType: 'Payment', summary: 'Recorded a payment' },
    RESULTS_PUBLISHED: { category: 'ACADEMICS', action: 'results.published', resourceType: 'Results', summary: 'Published school results' },
    ATTENDANCE_RECORDED: { category: 'ACADEMICS', action: 'attendance.recorded', resourceType: 'Attendance', summary: 'Recorded attendance' },
    VERIFY: { category: 'SCHOOL', action: 'school.verification.updated', resourceType: 'School verification', summary: 'Updated school verification' },
    VERIFIED: { category: 'SCHOOL', action: 'school.verification.updated', resourceType: 'School verification', summary: 'Updated school verification' },
  };
  const normalized = event.trim().toUpperCase();
  const existing = mapped[normalized];
  if (existing) return existing;

  return genericEvent('OPERATIONS', 'POST', event.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()));
}

export function inferPlatformAuditOutcome(
  event: string,
  details: string | null | undefined,
  storedOutcome?: string | null,
): PlatformAuditOutcome {
  const outcome = storedOutcome?.toUpperCase();
  if (outcome && ['SUCCESS', 'REDIRECTED', 'REJECTED', 'FAILED'].includes(outcome)) return outcome as PlatformAuditOutcome;

  const status = details?.match(/\bstatus(?:Code)?\s*:\s*(\d{3})\b/i);
  if (status) {
    const statusCode = Number(status[1]);
    if (statusCode >= 200 && statusCode < 300) return 'SUCCESS';
    if (statusCode >= 300 && statusCode < 400) return 'REDIRECTED';
    if (statusCode >= 400 && statusCode < 500) return 'REJECTED';
    if (statusCode >= 500) return 'FAILED';
  }

  const normalizedEvent = event.toUpperCase();
  if (/(?:^|_)(?:LOGIN_SUCCESS|PARENT_LOGIN_SUCCESS)$/.test(normalizedEvent)) return 'SUCCESS';
  if (/(?:^|_)(?:LOGIN_FAILED|PARENT_LOGIN_FAILED)$/.test(normalizedEvent)) return 'FAILED';
  if (/(?:^|_)(?:FAILED|ERROR|REJECTED|DENIED)$/.test(normalizedEvent)) return 'FAILED';
  if (/(?:^|_)(?:SUCCESS|COMPLETED|RECORDED|PUBLISHED|APPROVED|ACTIVATED)$/.test(normalizedEvent)) return 'SUCCESS';
  return 'NOT_RECORDED';
}

export function safeAuditPath(path: string): string {
  return cleanPath(path)
    .replace(/\bcm[a-z0-9]{16,}\b/gi, ':id')
    .replace(/\b[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}\b/gi, ':id')
    .replace(/\b\d{12,}\b/g, ':id');
}

export function sanitizeLegacyAuditDetails(details: string | null | undefined): string | null {
  if (!details?.trim()) return null;
  const parts = details.split(' | ');
  const requestMatch = parts[0]?.match(/^\s*(GET|POST|PUT|PATCH|DELETE)\s+([^\s]+)/i);
  const safeParts = requestMatch
    ? [`${requestMatch[1]!.toUpperCase()} ${safeAuditPath(requestMatch[2]!)}`, ...parts.slice(1)]
    : parts;
  return safeParts.join(' · ').slice(0, 1000);
}