import { Router, type Request, type Response } from 'express';
import { PrismaClient, SupportMessageSenderRole, SupportStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { getSessionSecret } from '../services/security-config.js';
import { jwtVerify } from 'jose';

const prisma = new PrismaClient();
const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 4, fileSize: 8 * 1024 * 1024 } });
const privateSupportDir = path.resolve(process.cwd(), 'private-support-uploads');
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const mimeForExtension: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};
const allowedStatuses = new Set<SupportStatus>(['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED']);

type Actor = {
  userId?: string;
  guardianId?: string;
  guardianIds?: string[];
  schoolId: string;
  role: string;
  name?: string;
  email?: string;
};

type ChatRequest = Request & { supportActor?: Actor };

function sessionSecret() {
  return getSessionSecret();
}

async function authenticate(req: ChatRequest, res: Response, next: (error?: unknown) => void) {
  try {
    const token = req.cookies?.schoolbase_session || req.cookies?.schoolbase_staff || req.cookies?.staff_session;
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    const { payload } = await jwtVerify(token, sessionSecret());
    const schoolId = typeof payload.schoolId === 'string' ? payload.schoolId : '';
    const role = typeof payload.role === 'string' ? payload.role : '';
    const actor: Actor = {
      schoolId,
      role,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      email: typeof payload.email === 'string' ? payload.email : undefined,
    };
    if (typeof payload.userId === 'string') actor.userId = payload.userId;
    if (typeof payload.guardianId === 'string') actor.guardianId = payload.guardianId;
    if (Array.isArray(payload.guardianIds)) actor.guardianIds = payload.guardianIds.filter((id): id is string => typeof id === 'string');
    if (!role || (role !== 'PLATFORM_ADMIN' && !schoolId)) {
      return res.status(403).json({ error: 'School account context is required.' });
    }
    req.supportActor = actor;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

async function authenticatePlatformAdmin(req: ChatRequest, res: Response, next: (error?: unknown) => void) {
  await authenticate(req, res, (error) => {
    if (error) return next(error);
    if (req.supportActor?.role !== 'PLATFORM_ADMIN') {
      return res.status(403).json({ error: 'Platform administrator access required.' });
    }
    next();
  });
}

function isParentActor(actor: Actor) {
  return actor.role === 'PARENT' || Boolean(actor.guardianId);
}

async function allowedGuardianIds(actor: Actor) {
  const ids = new Set([actor.guardianId, ...(actor.guardianIds || [])].filter((id): id is string => Boolean(id)));
  if (!ids.size) return [];
  const linked = await prisma.guardian.findMany({
    where: { id: { in: [...ids] }, schoolId: actor.schoolId },
    select: { id: true },
  });
  return linked.map((item) => item.id);
}

async function conversationScope(actor: Actor) {
  if (!isParentActor(actor)) return { schoolId: actor.schoolId };
  const guardianIds = await allowedGuardianIds(actor);
  return { schoolId: actor.schoolId, createdByGuardianId: { in: guardianIds } };
}

function requestSelect(messageLimit = 200) {
  return {
    id: true,
    schoolId: true,
    createdByUserId: true,
    createdByGuardianId: true,
    requesterName: true,
    requesterEmail: true,
    requesterRole: true,
    subject: true,
    status: true,
    priority: true,
    createdAt: true,
    updatedAt: true,
    lastMessageAt: true,
    school: { select: { id: true, name: true, country: true, plan: true, currency: true } },
    messages: {
      orderBy: { createdAt: 'asc' as const },
      take: messageLimit,
      include: { attachments: { orderBy: { createdAt: 'asc' as const } } },
    },
  };
}

function serializeRequest(request: any, currentRole?: string) {
  return {
    id: request.id,
    schoolId: request.schoolId,
    subject: request.subject,
    status: request.status,
    priority: request.priority,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    lastMessageAt: request.lastMessageAt,
    requester: {
      userId: request.createdByUserId,
      guardianId: request.createdByGuardianId,
      name: request.requesterName,
      email: request.requesterEmail,
      role: request.requesterRole,
    },
    school: request.school ? {
      id: request.school.id,
      name: request.school.name,
      country: request.school.country,
      plan: request.school.plan,
      currency: request.school.currency,
    } : undefined,
    unreadCount: currentRole === 'PLATFORM_ADMIN'
      ? request.messages?.filter((message: any) => message.senderRole !== 'PLATFORM_ADMIN' && !message.readAt).length || 0
      : request.messages?.filter((message: any) => message.senderRole === 'PLATFORM_ADMIN' && !message.readAt).length || 0,
    messages: request.messages?.map((message: any) => ({
      id: message.id,
      senderRole: message.senderRole,
      senderName: message.senderName,
      body: message.body,
      readAt: message.readAt,
      createdAt: message.createdAt,
      attachments: message.attachments?.map((attachment: any) => ({
        id: attachment.id,
        originalName: attachment.originalName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        url: attachment.url?.startsWith('/private/')
          ? currentRole === 'PLATFORM_ADMIN'
            ? `/schoolbase-admin/api/support-chat/attachments/${attachment.id}`
            : `/api/support/attachments/${attachment.id}`
          : attachment.url,
        createdAt: attachment.createdAt,
      })) || [],
    })) || [],
  };
}

async function persistAttachments(files: Express.Multer.File[]) {
  if (files.length === 0) return [];
  await mkdir(privateSupportDir, { recursive: true, mode: 0o700 });
  const persisted: Array<{ storedName: string; originalName: string; mimeType: string; size: number }> = [];
  try {
    for (const file of files) {
      const extension = path.extname(path.basename(file.originalname)).toLowerCase();
      const extensionMime = mimeForExtension[extension];
      const detectedMime = detectAllowedMime(file.buffer);
      let mimeType: string;
      if (extensionMime || allowedMimeTypes.has(file.mimetype)) {
        if (!detectedMime || !allowedMimeTypes.has(detectedMime) || extensionMime !== detectedMime || file.mimetype !== detectedMime) {
          throw new Error(`Unsupported attachment type: ${file.originalname}`);
        }
        mimeType = detectedMime;
      } else if (extension === '.csv') {
        mimeType = 'text/csv';
      } else {
        mimeType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.mimetype)
          ? file.mimetype
          : 'application/octet-stream';
      }
      const storedName = randomUUID();
      await writeFile(path.join(privateSupportDir, storedName), file.buffer, { flag: 'wx', mode: 0o600 });
      persisted.push({ storedName, originalName: path.basename(file.originalname).slice(0, 191), mimeType, size: file.size });
    }
    return persisted;
  } catch (error) {
    await Promise.all(persisted.map((item) => rm(path.join(privateSupportDir, item.storedName), { force: true })));
    throw error;
  }
}

function detectAllowedMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

async function discardAttachments(files: Array<{ storedName: string }>) {
  await Promise.all(files.map((item) => rm(path.join(privateSupportDir, item.storedName), { force: true }).catch(() => undefined)));
}

function sendChatMessage(req: ChatRequest, res: Response, next: (error?: unknown) => void) {
  upload.array('files', 4)(req, res, (error) => error ? next(error) : next());
}

function sendSupportEmailNotification(label: string, send: () => Promise<unknown>) {
  void send().catch((error) => {
    console.warn(`[support-chat] ${label} email notification failed (non-blocking):`, error);
  });
}

router.get('/conversations', authenticate, async (req: ChatRequest, res) => {
  try {
    const actor = req.supportActor!;
    const scope = await conversationScope(actor);
    const requestedLimit = Number.parseInt(String(req.query.limit || '20'), 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 20;
    const rows = await prisma.supportRequest.findMany({
      where: scope,
      orderBy: { lastMessageAt: 'desc' },
      take: limit,
      select: requestSelect(40),
    });
    const unreadCount = await prisma.supportRequestMessage.count({
      where: {
        supportRequest: scope,
        senderRole: 'PLATFORM_ADMIN',
        readAt: null,
      },
    });
    res.json({ conversations: rows.map((row) => serializeRequest(row, actor.role)), unreadCount });
  } catch (error) {
    console.error('[support-chat] customer list failed:', error);
    res.status(500).json({ error: 'Unable to load support conversations.' });
  }
});

router.post('/conversations', authenticate, sendChatMessage, async (req: ChatRequest, res) => {
  const actor = req.supportActor!;
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim().slice(0, 191) : '';
  const body = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 20000) : '';
  const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
  if (!subject || (!body && files.length === 0)) return res.status(400).json({ error: 'A topic and message or attachment are required.' });
  if (actor.role === 'PLATFORM_ADMIN' || !['SCHOOL_ADMIN', 'BURSAR', 'TEACHER', 'PARENT'].includes(actor.role)) {
    return res.status(403).json({ error: 'This account cannot start a school support conversation.' });
  }

  let persisted: Awaited<ReturnType<typeof persistAttachments>> = [];
  try {
    const school = await prisma.school.findUnique({ where: { id: actor.schoolId }, select: { id: true, name: true, country: true, plan: true, email: true } });
    if (!school) return res.status(403).json({ error: 'School account not found.' });
    if (isParentActor(actor) && !(await allowedGuardianIds(actor)).length) return res.status(403).json({ error: 'Parent account is not linked to this school.' });
    persisted = await persistAttachments(files);

    const request = await prisma.$transaction(async (tx) => {
      const created = await tx.supportRequest.create({
        data: {
          schoolId: actor.schoolId,
          createdByUserId: actor.userId || null,
          createdByGuardianId: actor.guardianId || null,
          requesterName: actor.name || 'School user',
          requesterEmail: actor.email || null,
          requesterRole: actor.role,
          subject,
          message: body || 'Attachment included',
          status: 'OPEN',
          lastMessageAt: new Date(),
        },
      });
      const message = await tx.supportRequestMessage.create({
        data: {
          supportRequestId: created.id,
          senderUserId: actor.userId || null,
          senderGuardianId: actor.guardianId || null,
          senderRole: 'SCHOOL',
          senderName: actor.name || 'School user',
          senderEmail: actor.email || null,
          body: body || 'Attachment included',
          attachments: persisted.length ? { create: persisted.map((attachment) => ({
            supportRequestId: created.id,
            fileName: attachment.storedName,
            originalName: attachment.originalName,
            mimeType: attachment.mimeType,
            size: attachment.size,
            url: '/private/pending',
          })) } : undefined,
        },
      });
      if (persisted.length) {
        const createdAttachments = await tx.supportAttachment.findMany({ where: { supportMessageId: message.id }, select: { id: true } });
        await Promise.all(createdAttachments.map((item) => tx.supportAttachment.update({ where: { id: item.id }, data: { url: `/private/${item.id}` } })));
      }
      return tx.supportRequest.findUniqueOrThrow({ where: { id: created.id, schoolId: actor.schoolId }, select: requestSelect() });
    });
    sendSupportEmailNotification('New conversation', async () => {
      const { sendSupportRequestNotification } = await import('../services/email.js');
      await sendSupportRequestNotification(
        request.id,
        subject,
        body || 'A file was attached to the support conversation.',
        school.name,
        actor.email || school.email,
      );
    });
    res.status(201).json({ conversation: serializeRequest(request, actor.role) });
  } catch (error) {
    await discardAttachments(persisted);
    console.error('[support-chat] create conversation failed:', error);
    res.status(500).json({ error: 'Unable to start a support conversation.' });
  }
});

router.get('/conversations/:id', authenticate, async (req: ChatRequest, res) => {
  try {
    const actor = req.supportActor!;
    const request = await prisma.supportRequest.findFirst({
      where: { id: req.params.id, ...(await conversationScope(actor)) },
      select: requestSelect(),
    });
    if (!request) return res.status(404).json({ error: 'Support conversation not found.' });
    res.json({ conversation: serializeRequest(request, actor.role) });
  } catch (error) {
    console.error('[support-chat] conversation fetch failed:', error);
    res.status(500).json({ error: 'Unable to load this support conversation.' });
  }
});

router.post('/conversations/:id/messages', authenticate, sendChatMessage, async (req: ChatRequest, res) => {
  const actor = req.supportActor!;
  const body = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 20000) : '';
  const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
  if (!body && files.length === 0) return res.status(400).json({ error: 'Write a message or attach a file.' });

  let persisted: Awaited<ReturnType<typeof persistAttachments>> = [];
  try {
    const request = await prisma.supportRequest.findFirst({
      where: { id: req.params.id, ...(await conversationScope(actor)) },
      include: { school: { select: { name: true, email: true } } },
    });
    if (!request) return res.status(404).json({ error: 'Support conversation not found.' });
    if (['CLOSED', 'RESOLVED'].includes(request.status)) return res.status(409).json({ error: 'Reopen this conversation before sending a message.' });
    persisted = await persistAttachments(files);
    const updated = await prisma.$transaction(async (tx) => {
      const message = await tx.supportRequestMessage.create({
        data: {
          supportRequestId: request.id,
          senderUserId: actor.userId || null,
          senderGuardianId: actor.guardianId || null,
          senderRole: 'SCHOOL',
          senderName: actor.name || 'School user',
          senderEmail: actor.email || null,
          body,
          attachments: persisted.length ? { create: persisted.map((attachment) => ({
            supportRequestId: request.id,
            fileName: attachment.storedName,
            originalName: attachment.originalName,
            mimeType: attachment.mimeType,
            size: attachment.size,
            url: '/private/pending',
          })) } : undefined,
        },
      });
      await tx.supportRequest.update({
        where: { id: request.id },
        data: { status: 'OPEN', updatedAt: new Date(), lastMessageAt: message.createdAt },
      });
      if (persisted.length) {
        const createdAttachments = await tx.supportAttachment.findMany({ where: { supportMessageId: message.id }, select: { id: true } });
        await Promise.all(createdAttachments.map((item) => tx.supportAttachment.update({ where: { id: item.id }, data: { url: `/private/${item.id}` } })));
      }
      return tx.supportRequest.findUniqueOrThrow({ where: { id: request.id }, select: requestSelect() });
    });
    sendSupportEmailNotification('Customer reply', async () => {
      const { sendSupportFollowupNotification } = await import('../services/email.js');
      await sendSupportFollowupNotification(
        updated.id,
        body || 'A file was attached to the support conversation.',
        request.school?.name,
        actor.email || request.school?.email,
      );
    });
    res.status(201).json({ conversation: serializeRequest(updated, actor.role) });
  } catch (error) {
    await discardAttachments(persisted);
    console.error('[support-chat] customer message failed:', error);
    res.status(500).json({ error: error instanceof Error && error.message.startsWith('Unsupported attachment') ? error.message : 'Unable to send the message.' });
  }
});

router.post('/conversations/:id/read', authenticate, async (req: ChatRequest, res) => {
  try {
    const actor = req.supportActor!;
    const request = await prisma.supportRequest.findFirst({ where: { id: req.params.id, ...(await conversationScope(actor)) }, select: { id: true } });
    if (!request) return res.status(404).json({ error: 'Support conversation not found.' });
    const result = await prisma.supportRequestMessage.updateMany({
      where: { supportRequestId: request.id, senderRole: 'PLATFORM_ADMIN', readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ success: true, markedRead: result.count });
  } catch (error) {
    console.error('[support-chat] mark read failed:', error);
    res.status(500).json({ error: 'Unable to mark messages as read.' });
  }
});

router.post('/conversations/:id/resolve', authenticate, async (req: ChatRequest, res) => updateCustomerStatus(req as ChatRequest, res, 'RESOLVED'));
router.post('/conversations/:id/reopen', authenticate, async (req: ChatRequest, res) => updateCustomerStatus(req as ChatRequest, res, 'OPEN'));

async function updateCustomerStatus(req: ChatRequest, res: Response, status: SupportStatus) {
  try {
    const actor = req.supportActor!;
    const result = await prisma.supportRequest.updateMany({
      where: { id: req.params.id, ...(await conversationScope(actor)) },
      data: { status, updatedAt: new Date() },
    });
    if (!result.count) return res.status(404).json({ error: 'Support conversation not found.' });
    res.json({ success: true, status });
  } catch (error) {
    console.error('[support-chat] customer status update failed:', error);
    res.status(500).json({ error: 'Unable to update conversation status.' });
  }
}

router.get('/attachments/:id', authenticate, async (req: ChatRequest, res) => streamAttachment(req, res, false));

const platform = Router();
platform.use(authenticatePlatformAdmin);

platform.get('/conversations', async (req: ChatRequest, res) => {
  try {
    const requestedLimit = Number.parseInt(String(req.query.limit || '30'), 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 30;
    const status = typeof req.query.status === 'string' && req.query.status !== 'ALL' ? req.query.status : undefined;
    if (status && !allowedStatuses.has(status as SupportStatus)) return res.status(400).json({ error: 'Invalid status filter.' });
    const query = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const rows = await prisma.supportRequest.findMany({
      where: {
        ...(status ? { status: status as SupportStatus } : {}),
        ...(query ? { OR: [
          { subject: { contains: query } },
          { requesterName: { contains: query } },
          { school: { name: { contains: query } } },
        ] } : {}),
      },
      orderBy: { lastMessageAt: 'desc' },
      take: limit,
      select: requestSelect(30),
    });
    const unreadCount = await prisma.supportRequestMessage.count({ where: { senderRole: 'SCHOOL', readAt: null } });
    res.json({ conversations: rows.map((row) => serializeRequest(row, 'PLATFORM_ADMIN')), unreadCount });
  } catch (error) {
    console.error('[support-chat] platform list failed:', error);
    res.status(500).json({ error: 'Unable to load support conversations.' });
  }
});

platform.get('/conversations/:id', async (req: ChatRequest, res) => {
  try {
    const request = await prisma.supportRequest.findUnique({ where: { id: req.params.id }, select: requestSelect() });
    if (!request) return res.status(404).json({ error: 'Support conversation not found.' });
    res.json({ conversation: serializeRequest(request, 'PLATFORM_ADMIN') });
  } catch (error) {
    console.error('[support-chat] platform conversation fetch failed:', error);
    res.status(500).json({ error: 'Unable to load support conversation.' });
  }
});

platform.post('/conversations/:id/messages', sendChatMessage, async (req: ChatRequest, res) => {
  const body = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 20000) : '';
  const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
  if (!body && files.length === 0) return res.status(400).json({ error: 'Write a reply or attach a file.' });
  let persisted: Awaited<ReturnType<typeof persistAttachments>> = [];
  try {
    const request = await prisma.supportRequest.findUnique({
      where: { id: req.params.id },
      include: { school: { select: { name: true, email: true } } },
    });
    if (!request) return res.status(404).json({ error: 'Support conversation not found.' });
    persisted = await persistAttachments(files);
    const updated = await prisma.$transaction(async (tx) => {
      const message = await tx.supportRequestMessage.create({
        data: {
          supportRequestId: request.id,
          senderUserId: req.supportActor?.userId || null,
          senderRole: 'PLATFORM_ADMIN',
          senderName: req.supportActor?.name || 'SchoolBase Support',
          senderEmail: req.supportActor?.email || null,
          body,
          attachments: persisted.length ? { create: persisted.map((attachment) => ({
            supportRequestId: request.id,
            fileName: attachment.storedName,
            originalName: attachment.originalName,
            mimeType: attachment.mimeType,
            size: attachment.size,
            url: `/schoolbase-admin/api/support-chat/attachments/PENDING`,
          })) } : undefined,
        },
      });
      if (persisted.length) {
        const createdAttachments = await tx.supportAttachment.findMany({ where: { supportMessageId: message.id }, select: { id: true } });
        await Promise.all(createdAttachments.map((item) => tx.supportAttachment.update({ where: { id: item.id }, data: { url: `/private/${item.id}` } })));
      }
      await tx.supportRequest.update({ where: { id: request.id }, data: { response: body || request.response, status: 'WAITING_FOR_CUSTOMER', updatedAt: new Date(), lastMessageAt: message.createdAt } });
      return tx.supportRequest.findUniqueOrThrow({ where: { id: request.id }, select: requestSelect() });
    });
    sendSupportEmailNotification('Platform reply', async () => {
      const { sendSupportStatusUpdateNotification } = await import('../services/email.js');
      await sendSupportStatusUpdateNotification(
        updated.id,
        'WAITING_FOR_CUSTOMER',
        updated.subject,
        body || 'SchoolBase Support attached a file to your conversation.',
        request.school?.name,
        request.requesterEmail || request.school?.email,
      );
    });
    res.status(201).json({ conversation: serializeRequest(updated, 'PLATFORM_ADMIN') });
  } catch (error) {
    await discardAttachments(persisted);
    console.error('[support-chat] platform reply failed:', error);
    res.status(500).json({ error: error instanceof Error && error.message.startsWith('Unsupported attachment') ? error.message : 'Unable to send reply.' });
  }
});

platform.patch('/conversations/:id/status', async (req: ChatRequest, res) => {
  const status = req.body?.status as SupportStatus;
  if (!allowedStatuses.has(status)) return res.status(400).json({ error: 'Invalid support status.' });
  try {
    const updated = await prisma.supportRequest.updateMany({ where: { id: req.params.id }, data: { status, updatedAt: new Date() } });
    if (!updated.count) return res.status(404).json({ error: 'Support conversation not found.' });
    res.json({ success: true, status });
  } catch (error) {
    console.error('[support-chat] status change failed:', error);
    res.status(500).json({ error: 'Unable to update support status.' });
  }
});

platform.post('/conversations/:id/read', async (req: ChatRequest, res) => {
  try {
    const request = await prisma.supportRequest.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!request) return res.status(404).json({ error: 'Support conversation not found.' });
    const result = await prisma.supportRequestMessage.updateMany({ where: { supportRequestId: request.id, senderRole: 'SCHOOL', readAt: null }, data: { readAt: new Date() } });
    res.json({ success: true, markedRead: result.count });
  } catch (error) {
    console.error('[support-chat] platform mark read failed:', error);
    res.status(500).json({ error: 'Unable to mark messages as read.' });
  }
});

platform.get('/attachments/:id', async (req: ChatRequest, res) => streamAttachment(req, res, true));

async function streamAttachment(req: ChatRequest, res: Response, platformAdmin: boolean) {
  try {
    const attachment = await prisma.supportAttachment.findUnique({
      where: { id: req.params.id },
      include: { supportRequest: { select: { id: true, schoolId: true, createdByGuardianId: true, createdByUserId: true } } },
    });
    if (!attachment || !attachment.fileName.match(/^[0-9a-f-]{36}(?:\.(jpg|png|webp|pdf))?$/i)) return res.status(404).json({ error: 'Attachment not found.' });
    const actor = req.supportActor!;
    if (platformAdmin) {
      if (actor.role !== 'PLATFORM_ADMIN') return res.status(403).json({ error: 'Platform administrator access required.' });
    } else {
      const allowed = await conversationScope(actor);
      if (attachment.supportRequest.schoolId !== actor.schoolId) return res.status(404).json({ error: 'Attachment not found.' });
      if (isParentActor(actor) && !(allowed as any).createdByGuardianId?.in?.includes(attachment.supportRequest.createdByGuardianId)) return res.status(404).json({ error: 'Attachment not found.' });
    }
    const filePath = path.resolve(privateSupportDir, attachment.fileName);
    if (!filePath.startsWith(`${privateSupportDir}${path.sep}`)) return res.status(404).json({ error: 'Attachment not found.' });
    const contents = await readFile(filePath);
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', contents.byteLength);
    const disposition = ['image/jpeg', 'image/png', 'image/webp'].includes(attachment.mimeType) ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(attachment.originalName)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(contents);
  } catch (error) {
    console.error('[support-chat] attachment stream failed:', error);
    res.status(404).json({ error: 'Attachment not found.' });
  }
}

export { router as default, platform as platformSupportChatRouter };
