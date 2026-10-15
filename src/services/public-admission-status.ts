import { createHash } from 'node:crypto';
import { normalizeAdmissionStatus, validateApplicantAdmissionReply } from '../routes/admissions-utils.js';

type PublicAdmissionStatusClient = {
  school: {
    findUnique(args: any): Promise<{ id: string } | null>;
  };
  admissionApplication: {
    findFirst(args: any): Promise<any>;
  };
  admissionApplicationEvent: {
    findMany(args: any): Promise<any[]>;
  };
  $transaction<T>(callback: (transaction: any) => Promise<T>): Promise<T>;
};

type ApplicantReplyResult =
  | { ok: true; status: 201; message: { type: string; body: string; createdAt: Date } }
  | { ok: false; status: 400 | 404 | 409; error: string };

function hashStatusToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function findApplicationForToken(
  prisma: PublicAdmissionStatusClient,
  schoolSlug: string,
  token: string,
  now: Date,
): Promise<{ school: { id: string }; application: any } | false | null> {
  const school = await prisma.school.findUnique({ where: { slug: schoolSlug }, select: { id: true } });
  if (!school) return null;

  const application = await prisma.admissionApplication.findFirst({
    where: {
      schoolId: school.id,
      publicStatusTokenHash: hashStatusToken(token),
      publicStatusTokenExpiresAt: { gt: now },
    },
    select: { id: true, schoolId: true, applicationNumber: true, status: true, createdAt: true },
  });
  return application ? { school, application } : false;
}

export async function getPublicAdmissionStatus(
  prisma: PublicAdmissionStatusClient,
  schoolSlug: string,
  token: string,
  now = new Date(),
) {
  const match = await findApplicationForToken(prisma, schoolSlug, token, now);
  if (match === null || match === false) return match;

  const messages = await prisma.admissionApplicationEvent.findMany({
    where: {
      schoolId: match.school.id,
      admissionApplicationId: match.application.id,
      type: { in: ['MORE_INFORMATION_REQUESTED', 'APPLICANT_REPLY'] },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: { type: true, reason: true, createdAt: true },
  });

  return {
    application: {
      reference: match.application.applicationNumber,
      status: normalizeAdmissionStatus(match.application.status),
      createdAt: match.application.createdAt,
    },
    messages: messages.map((message) => ({ type: message.type, body: message.reason, createdAt: message.createdAt })),
  };
}

export async function submitPublicAdmissionReply(
  prisma: PublicAdmissionStatusClient,
  input: { schoolSlug: string; token: string; message: unknown },
  now = new Date(),
): Promise<ApplicantReplyResult> {
  const reply = validateApplicantAdmissionReply(input.message);
  if (!reply.valid) return { ok: false, status: 400, error: reply.error };

  const match = await findApplicationForToken(prisma, input.schoolSlug, input.token, now);
  if (!match) return { ok: false, status: 404, error: 'Application status could not be verified' };
  if (match.application.status !== 'NEEDS_INFORMATION') {
    return { ok: false, status: 409, error: 'The school is not currently waiting for more information' };
  }

  try {
    const event = await prisma.$transaction(async (transaction) => {
      const updated = await transaction.admissionApplication.updateMany({
        where: { id: match.application.id, schoolId: match.school.id, status: 'NEEDS_INFORMATION' },
        data: { status: 'UNDER_REVIEW' },
      });
      if (updated.count !== 1) throw new Error('ADMISSION_REPLY_CONFLICT');

      const createdEvent = await transaction.admissionApplicationEvent.create({
        data: {
          schoolId: match.school.id,
          admissionApplicationId: match.application.id,
          actorName: 'Applicant',
          type: 'APPLICANT_REPLY',
          fromStatus: 'NEEDS_INFORMATION',
          toStatus: 'UNDER_REVIEW',
          reason: reply.message,
        },
        select: { id: true, type: true, reason: true, createdAt: true },
      });
      const recipients = await transaction.user.findMany({
        where: { schoolId: match.school.id, role: 'SCHOOL_ADMIN' },
        select: { id: true },
      });
      if (recipients.length) {
        await transaction.schoolAdminNotification.createMany({
          data: recipients.map((recipient: { id: string }) => ({
            schoolId: match.school.id,
            recipientUserId: recipient.id,
            admissionApplicationId: match.application.id,
            type: `APPLICANT_REPLY_${createdEvent.id}`,
            title: 'Applicant replied',
            body: 'The applicant sent the requested information. Open the review workspace to read it.',
          })),
          skipDuplicates: true,
        });
      }
      return createdEvent;
    });

    return {
      ok: true,
      status: 201,
      message: { type: event.type, body: event.reason, createdAt: event.createdAt },
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'ADMISSION_REPLY_CONFLICT') {
      return { ok: false, status: 409, error: 'The application changed before your reply could be saved' };
    }
    throw error;
  }
}