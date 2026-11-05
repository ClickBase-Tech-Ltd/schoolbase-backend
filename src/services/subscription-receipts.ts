import { PaymentMethod, PrismaClient } from '@prisma/client';
import {
  PDFDocument,
  StandardFonts,
  appendBezierCurve,
  clip,
  closePath,
  endPath,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from 'pdf-lib';
import { isValidEmail, sendSubscriptionReceiptEmail } from './email.js';

const prisma = new PrismaClient();
const PAID_STATUSES = new Set(['COMPLETED', 'SUCCESSFUL', 'SUCCESS', 'PAID', 'ACTIVE']);
let receiptLogoPromise: Promise<{ bytes: Uint8Array; contentType: string } | null> | null = null;

export interface SubscriptionReceiptData {
  id: string;
  receiptNumber: string;
  schoolId: string | null;
  schoolName: string;
  schoolEmails: string[];
  plan: string;
  amountMinor: number;
  currency: string;
  method: PaymentMethod | string;
  reference: string;
  paidAt: Date;
  billingAction: string | null;
  applicationStatus: string | null;
  subscriptionExpiresAt: Date | null;
}

function parsePaymentDetails(note: string | null): Record<string, unknown> | null {
  if (!note) return null;
  try {
    const parsed: unknown = JSON.parse(note);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getReceiptNumber(paymentId: string, paidAt: Date): string {
  return `SB-${paidAt.getUTCFullYear()}-${paymentId.toUpperCase()}`;
}

type ReceiptPaymentRow = {
  id: string;
  amount: number;
  method: PaymentMethod;
  reference: string | null;
  createdAt: Date;
  recordedBy: string | null;
  note: string | null;
};

type ReceiptSchoolInfo = {
  id: string;
  name: string;
  email: string | null;
  users: Array<{ email: string }>;
};

function mapPaymentToReceipt(
  payment: ReceiptPaymentRow,
  school: ReceiptSchoolInfo | null,
): SubscriptionReceiptData | null {
  const details = parsePaymentDetails(payment.note);
  const status = asString(details?.paymentStatus)?.toUpperCase()
    || asString(details?.status)?.toUpperCase()
    || '';
  const isSubscriptionPayment = details?.subscription === true
    || details?.source === 'manual-subscription-entry';
  if (!details || !isSubscriptionPayment || !PAID_STATUSES.has(status) || payment.amount <= 0) {
    return null;
  }

  const schoolId = payment.recordedBy || asString(details.schoolId);

  const schoolEmails = [
    school?.email,
    school?.users[0]?.email,
    asString(details.schoolEmail),
  ].filter((email): email is string => Boolean(email?.trim()))
    .map((email) => email.trim().toLowerCase());
  const invalidEmails = schoolEmails.filter((email) => !isValidEmail(email));
  if (invalidEmails.length) {
    console.warn(`Ignoring invalid school receipt email address(es) for payment ${payment.id}.`);
  }

  const rawExpiry = asString(details.subscriptionExpiresAt);
  const expiry = rawExpiry ? new Date(rawExpiry) : null;
  return {
    id: payment.id,
    receiptNumber: getReceiptNumber(payment.id, payment.createdAt),
    schoolId: school?.id || schoolId || null,
    schoolName: school?.name || asString(details.schoolName) || 'School',
    schoolEmails: [...new Set(schoolEmails.filter(isValidEmail))],
    plan: asString(details.plan) || 'Subscription',
    amountMinor: payment.amount,
    currency: (asString(details.currency) || 'NGN').toUpperCase(),
    method: payment.method,
    reference: payment.reference || payment.id,
    paidAt: payment.createdAt,
    billingAction: asString(details.billingIntent),
    applicationStatus: asString(details.subscriptionApplicationStatus)
      || (details.subscriptionApplied === false ? 'REVIEW_REQUIRED' : null),
    subscriptionExpiresAt: expiry && !Number.isNaN(expiry.getTime()) ? expiry : null,
  };
}

export async function getSubscriptionReceiptData(paymentId: string): Promise<SubscriptionReceiptData | null> {
  const payment = await prisma.platformPayment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      amount: true,
      method: true,
      reference: true,
      createdAt: true,
      recordedBy: true,
      note: true,
    },
  });
  if (!payment) return null;

  const details = parsePaymentDetails(payment.note);
  const schoolId = payment.recordedBy || asString(details?.schoolId);
  const school = schoolId
    ? await prisma.school.findUnique({
        where: { id: schoolId },
        select: {
          id: true,
          name: true,
          email: true,
          users: {
            where: { role: 'SCHOOL_ADMIN', isActive: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { email: true },
          },
        },
      })
    : null;
  return mapPaymentToReceipt(payment, school);
}

function safePdfText(value: string): string {
  return value.normalize('NFKD').replace(/[^\x20-\x7e]/g, '?');
}

function formatAmount(amountMinor: number, currency: string): string {
  return `${currency} ${(amountMinor / 100).toLocaleString('en', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function drawReceiptRow(
  page: ReturnType<PDFDocument['addPage']>,
  font: Awaited<ReturnType<PDFDocument['embedFont']>>,
  y: number,
  label: string,
  value: string,
) {
  page.drawText(safePdfText(label), { x: 54, y, size: 10, font, color: rgb(0.35, 0.39, 0.45) });
  page.drawText(safePdfText(value), { x: 225, y, size: 10, font, color: rgb(0.12, 0.16, 0.22), maxWidth: 315 });
}

async function getReceiptLogo() {
  if (!receiptLogoPromise) {
    receiptLogoPromise = (async () => {
      try {
        const logoUrl = process.env.SCHOOLBASE_LOGO_URL?.trim() || 'https://schoolbase.live/logo.png';
        const response = await fetch(logoUrl, { signal: AbortSignal.timeout(2500) });
        if (!response.ok) throw new Error(`Logo request returned HTTP ${response.status}.`);
        const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
        if (!['image/png', 'image/jpeg'].includes(contentType)) {
          throw new Error(`Unsupported receipt logo content type: ${contentType || 'unknown'}.`);
        }
        return { bytes: new Uint8Array(await response.arrayBuffer()), contentType };
      } catch (error) {
        console.warn('SchoolBase receipt logo could not be loaded; using the text mark:', error);
        return null;
      }
    })();
  }
  return receiptLogoPromise;
}

export async function buildSubscriptionReceiptPdf(receipt: SubscriptionReceiptData): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle(`SchoolBase payment receipt ${receipt.receiptNumber}`);
  document.setAuthor('SchoolBase');
  document.setSubject(`Subscription payment for ${receipt.schoolName}`);

  const page = document.addPage([595.28, 841.89]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const blue = rgb(10 / 255, 102 / 255, 194 / 255);
  const navy = rgb(0.07, 0.12, 0.20);

  page.drawRectangle({ x: 0, y: 680, width: 595.28, height: 161.89, color: blue });
  page.drawCircle({ x: 68, y: 773, size: 24, color: rgb(1, 1, 1) });
  const logo = await getReceiptLogo();
  if (logo) {
    try {
      const image = logo.contentType === 'image/png'
        ? await document.embedPng(logo.bytes)
        : await document.embedJpg(logo.bytes);
      const logoSize = 38;
      const logoX = 49;
      const logoY = 754;
      const scale = Math.min(logoSize / image.width, logoSize / image.height);
      const imageWidth = image.width * scale;
      const imageHeight = image.height * scale;
      const centerX = logoX + logoSize / 2;
      const centerY = logoY + logoSize / 2;
      const radius = logoSize / 2;
      const curve = radius * 0.5522847498;
      page.pushOperators(
        pushGraphicsState(),
        moveTo(centerX, centerY + radius),
        appendBezierCurve(centerX + curve, centerY + radius, centerX + radius, centerY + curve, centerX + radius, centerY),
        appendBezierCurve(centerX + radius, centerY - curve, centerX + curve, centerY - radius, centerX, centerY - radius),
        appendBezierCurve(centerX - curve, centerY - radius, centerX - radius, centerY - curve, centerX - radius, centerY),
        appendBezierCurve(centerX - radius, centerY + curve, centerX - curve, centerY + radius, centerX, centerY + radius),
        closePath(),
        clip(),
        endPath(),
      );
      try {
        page.drawImage(image, {
          x: logoX + (logoSize - imageWidth) / 2,
          y: logoY + (logoSize - imageHeight) / 2,
          width: imageWidth,
          height: imageHeight,
        });
      } finally {
        page.pushOperators(popGraphicsState());
      }
    } catch (error) {
      console.warn('SchoolBase receipt logo could not be embedded; using the text mark:', error);
      page.drawText('SB', { x: 53, y: 766, size: 17, font: bold, color: blue });
    }
  } else {
    page.drawText('SB', { x: 53, y: 766, size: 17, font: bold, color: blue });
  }
  page.drawText('SchoolBase', { x: 104, y: 780, size: 23, font: bold, color: rgb(1, 1, 1) });
  page.drawText('The school management system built for West African schools.', {
    x: 105, y: 759, size: 8.5, font: regular, color: rgb(0.94, 0.96, 1),
  });
  page.drawText('https://schoolbase.live', {
    x: 105, y: 742, size: 9, font: regular, color: rgb(1, 1, 1),
  });
  page.drawText('Plot 994 Action Layout, Abuja - Nigeria', {
    x: 105, y: 723, size: 9, font: regular, color: rgb(0.88, 0.92, 0.98),
  });
  page.drawText('OFFICIAL PAYMENT RECEIPT', {
    x: 54, y: 631, size: 18, font: bold, color: navy,
  });
  page.drawText('Payment received and recorded by SchoolBase.', {
    x: 54, y: 610, size: 10, font: regular, color: rgb(0.35, 0.39, 0.45),
  });

  page.drawRectangle({ x: 54, y: 535, width: 487, height: 48, color: rgb(0.94, 0.97, 1) });
  page.drawText('RECEIPT NUMBER', { x: 69, y: 562, size: 8, font: bold, color: blue });
  page.drawText(safePdfText(receipt.receiptNumber), { x: 69, y: 544, size: 12, font: bold, color: navy });
  page.drawText('PAYMENT STATUS', { x: 338, y: 562, size: 8, font: bold, color: blue });
  page.drawText('PAID / CONFIRMED', { x: 338, y: 544, size: 11, font: bold, color: rgb(0.02, 0.42, 0.25) });

  const detailsTop = 500;
  const rows: Array<[string, string]> = [
    ['School', receipt.schoolName],
    ['Plan', receipt.plan],
    ['Payment date', receipt.paidAt.toLocaleString('en-GB', {
      day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
    }) + ' UTC'],
    ['Amount received', formatAmount(receipt.amountMinor, receipt.currency)],
    ['Payment method', receipt.method.replace(/_/g, ' ')],
    ['Transaction reference', receipt.reference],
  ];
  if (receipt.billingAction) {
    rows.push(['Subscription action', receipt.billingAction.replace(/_/g, ' ').toLowerCase()]);
  }
  if (receipt.applicationStatus === 'REVIEW_REQUIRED') {
    rows.push(['Subscription status', 'Payment confirmed; subscription application under review']);
  } else if (receipt.subscriptionExpiresAt) {
    rows.push(['Subscription access through', receipt.subscriptionExpiresAt.toLocaleDateString('en-GB', {
      day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC',
    })]);
  } else if (receipt.applicationStatus === 'RECORD_ONLY') {
    rows.push(['Subscription status', 'Payment recorded; access was not changed']);
  }

  rows.forEach(([label, value], index) => {
    const y = detailsTop - index * 39;
    drawReceiptRow(page, regular, y, label, value);
    page.drawLine({
      start: { x: 54, y: y - 12 },
      end: { x: 541, y: y - 12 },
      thickness: 0.5,
      color: rgb(0.87, 0.89, 0.92),
    });
  });

  const totalY = detailsTop - rows.length * 39 - 20;
  page.drawText('TOTAL RECEIVED', { x: 54, y: totalY, size: 10, font: bold, color: navy });
  page.drawText(safePdfText(formatAmount(receipt.amountMinor, receipt.currency)), {
    x: 330, y: totalY - 2, size: 16, font: bold, color: blue,
  });

  page.drawLine({
    start: { x: 54, y: 92 },
    end: { x: 541, y: 92 },
    thickness: 1,
    color: rgb(0.83, 0.86, 0.90),
  });
  page.drawText('This receipt confirms that the payment above was received by SchoolBase.', {
    x: 54, y: 72, size: 9, font: regular, color: rgb(0.35, 0.39, 0.45),
  });
  page.drawText('SchoolBase  |  schoolbase.live  |  sales@schoolbase.live', {
    x: 54, y: 54, size: 8, font: regular, color: rgb(0.35, 0.39, 0.45),
  });
  return document.save();
}

export async function sendSubscriptionReceipt(paymentId: string) {
  const receipt = await getSubscriptionReceiptData(paymentId);
  if (!receipt) throw new Error('A confirmed subscription payment receipt was not found.');

  const pdf = await buildSubscriptionReceiptPdf(receipt);
  const emailResult = await sendSubscriptionReceiptEmail({
    receiptNumber: receipt.receiptNumber,
    schoolName: receipt.schoolName,
    plan: receipt.plan,
    amount: formatAmount(receipt.amountMinor, receipt.currency),
    paidAt: receipt.paidAt,
    schoolEmails: receipt.schoolEmails,
    pdf,
  });
  return { receipt, emailResult };
}

export async function listSchoolSubscriptionReceipts(schoolId: string) {
  const payments = await prisma.platformPayment.findMany({
    where: { recordedBy: schoolId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      amount: true,
      method: true,
      reference: true,
      createdAt: true,
      recordedBy: true,
      note: true,
    },
  });
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: {
      id: true,
      name: true,
      email: true,
      users: {
        where: { role: 'SCHOOL_ADMIN', isActive: true },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { email: true },
      },
    },
  });
  const receipts = payments
    .map((payment) => mapPaymentToReceipt(payment, school))
    .filter((receipt): receipt is SubscriptionReceiptData => receipt !== null);
  return receipts.map((receipt) => ({
    id: receipt.id,
    receiptNumber: receipt.receiptNumber,
    schoolName: receipt.schoolName,
    plan: receipt.plan,
    amountMinor: receipt.amountMinor,
    currency: receipt.currency,
    method: receipt.method,
    reference: receipt.reference,
    paidAt: receipt.paidAt.toISOString(),
    applicationStatus: receipt.applicationStatus,
  }));
}
