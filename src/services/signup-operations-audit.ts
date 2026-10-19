import { createHmac } from 'node:crypto';

export type SignupReminderOutcome = 'sent' | 'not-found' | 'conflict' | 'delivery-failed' | 'cooldown';

export async function attemptAndAuditSignupReminder(input: {
  actorUserId: string;
  email: string;
  requestId: string;
  auditSecret: string;
  isCoolingDown: () => Promise<boolean>;
  sendReminder: () => Promise<'sent' | 'not-found' | 'conflict'>;
  writeAudit: (event: ReturnType<typeof buildSignupReminderAuditEvent>) => Promise<void>;
}) {
  let outcome: SignupReminderOutcome;
  try {
    if (await input.isCoolingDown()) {
      outcome = 'cooldown';
    } else {
      outcome = await input.sendReminder();
    }
  } catch {
    outcome = 'delivery-failed';
  }

  try {
    await input.writeAudit(buildSignupReminderAuditEvent({
      actorUserId: input.actorUserId,
      email: input.email,
      outcome,
      requestId: input.requestId,
      auditSecret: input.auditSecret,
    }));
  } catch {
    return { outcome, auditRecorded: false };
  }

  return { outcome, auditRecorded: true };
}

export function buildSignupReminderAuditEvent(input: {
  actorUserId: string;
  email: string;
  outcome: SignupReminderOutcome;
  requestId: string;
  auditSecret: string;
}) {
  const emailReference = createHmac('sha256', input.auditSecret)
    .update(input.email.trim().toLowerCase())
    .digest('hex');

  return {
    userId: input.actorUserId,
    event: 'PENDING_SIGNUP_REMINDER',
    category: 'SCHOOL',
    action: 'school.signup.reminder_attempted',
    outcome: input.outcome === 'sent' ? 'SUCCESS' : input.outcome === 'delivery-failed' ? 'FAILED' : 'REJECTED',
    resourceType: 'Pending signup',
    resourceId: emailReference,
    summary: input.outcome === 'sent' ? 'Sent pending signup reminder' : 'Pending signup reminder did not complete',
    actorRole: 'PLATFORM_ADMIN',
    requestId: input.requestId,
    details: `Pending signup reminder outcome: ${input.outcome}`,
  };
}