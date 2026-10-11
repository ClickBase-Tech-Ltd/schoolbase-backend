import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import { clip, endPath, popGraphicsState, pushGraphicsState, rectangle } from 'pdf-lib';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { ID_CARD_TEMPLATES, type IdCardOrientation } from './id-card-pricing.js';

export type IdCardRenderSnapshot = {
  templateId: string;
  orientation?: IdCardOrientation;
  includeCardBack?: boolean;
  parentPortalQrUrl?: string | null;
  school: {
    name: string;
    initials?: string | null;
    logoUrl?: string | null;
    primaryColor?: string | null;
    address?: string | null;
    phone?: string | null;
    slug?: string | null;
  };
  students: Array<{
    id: string;
    firstName: string;
    middleName?: string | null;
    lastName: string;
    admissionNo?: string | null;
    photoUrl?: string | null;
    className?: string | null;
  }>;
};

const CARD_WIDTH = 243.4;
const CARD_HEIGHT = 153.5;
const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');

export function resolveLocalUploadPath(url?: string | null) {
  if (!url) return null;
  const uploadPath = url.startsWith('/api/uploads/') ? url.slice('/api'.length) : url;
  if (!uploadPath.startsWith('/uploads/')) return null;

  const resolved = path.resolve(UPLOADS_ROOT, uploadPath.slice('/uploads/'.length));
  return resolved.startsWith(`${UPLOADS_ROOT}${path.sep}`) ? resolved : null;
}

export const ID_CARD_TEMPLATE_ACCENTS = {
  crestClassic: '#173f35',
  modernInstitution: '#146b72',
  inkSaver: '#111111',
  houseTeam: '#194c91',
  earlyLearners: '#e6a84a',
  seniorCollege: '#263b3d',
  signatureCollection: '#53314b',
} as const;

function parseColor(value?: string | null) {
  const match = value?.match(/^#?([0-9a-f]{6})$/i);
  if (!match) return rgb(0.04, 0.35, 0.42);
  const hex = match[1];
  return rgb(Number.parseInt(hex.slice(0, 2), 16) / 255, Number.parseInt(hex.slice(2, 4), 16) / 255, Number.parseInt(hex.slice(4, 6), 16) / 255);
}

function safeText(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\u0000-\u00ff]/g, '?').trim();
}

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'SB';
}

function wrapText(value: string, font: PDFFont, size: number, maxWidth: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of value.split(/\s+/)) {
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      if (line) {
        lines.push(line);
        line = '';
      }
      let fragment = '';
      for (const character of word) {
        if (fragment && font.widthOfTextAtSize(`${fragment}${character}`, size) > maxWidth) {
          lines.push(fragment);
          fragment = character;
        } else {
          fragment += character;
        }
      }
      line = fragment;
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function fitStudentName(value: string, font: PDFFont, baseSize: number, maxWidth: number) {
  let size = baseSize * 0.9;
  let lines = wrapText(safeText(value), font, size, maxWidth);
  while (lines.length > 2 && size > 5) {
    size = Math.max(5, size - 0.5);
    lines = wrapText(safeText(value), font, size, maxWidth);
  }
  return { size, lines };
}

function drawStudentName(
  page: PDFPage,
  value: string,
  options: { x: number; y: number; size: number; font: PDFFont; color: ReturnType<typeof rgb>; maxWidth: number; centered?: boolean },
) {
  const { size, lines } = fitStudentName(value, options.font, options.size, options.maxWidth);
  const lineHeight = size + 2;
  lines.forEach((line, index) => {
    const textWidth = options.font.widthOfTextAtSize(line, size);
    page.drawText(line, {
      ...options,
      x: options.centered ? options.x + (options.maxWidth - textWidth) / 2 : options.x,
      y: options.y - index * lineHeight,
      size,
    });
  });
  return lines.length;
}

function drawContainedText(
  page: PDFPage,
  value: string,
  options: { x: number; y: number; size: number; font: PDFFont; color: ReturnType<typeof rgb>; maxWidth: number },
) {
  let text = safeText(value);
  let size = options.size;
  const minimumSize = 5;
  while (size > minimumSize && options.font.widthOfTextAtSize(text, size) > options.maxWidth) {
    size = Math.max(minimumSize, size - 0.5);
  }
  if (options.font.widthOfTextAtSize(text, size) > options.maxWidth) {
    const suffix = '...';
    while (text.length > 0 && options.font.widthOfTextAtSize(`${text}${suffix}`, size) > options.maxWidth) {
      text = text.slice(0, -1);
    }
    text = `${text.trimEnd()}${suffix}`;
  }
  page.drawText(text, { ...options, size });
}

function drawCenteredContainedText(
  page: PDFPage,
  value: string,
  options: { x: number; y: number; size: number; font: PDFFont; color: ReturnType<typeof rgb>; maxWidth: number },
) {
  let text = safeText(value);
  let size = options.size;
  while (size > 5 && options.font.widthOfTextAtSize(text, size) > options.maxWidth) size = Math.max(5, size - 0.5);
  if (options.font.widthOfTextAtSize(text, size) > options.maxWidth) {
    while (text.length > 0 && options.font.widthOfTextAtSize(`${text}...`, size) > options.maxWidth) text = text.slice(0, -1);
    text = `${text.trimEnd()}...`;
  }
  const width = options.font.widthOfTextAtSize(text, size);
  page.drawText(text, { ...options, x: options.x + (options.maxWidth - width) / 2, size });
}

async function readLocalImage(url?: string | null) {
  const resolved = resolveLocalUploadPath(url);
  if (!resolved) return null;
  try {
    return await readFile(resolved);
  } catch {
    return null;
  }
}

async function drawPhoto(document: PDFDocument, page: PDFPage, photoUrl: string | null | undefined, x: number, y: number, width: number, height: number, shape: 'rectangle' | 'circle' = 'rectangle', borderColor = rgb(1, 1, 1)) {
  const bytes = await readLocalImage(photoUrl);
  if (!bytes) return false;
  try {
    const imageBytes = shape === 'circle'
      ? await sharp(bytes)
          .resize(512, 512, { fit: 'cover' })
          .composite([{
            input: Buffer.from('<svg width="512" height="512"><circle cx="256" cy="256" r="256" fill="white"/></svg>'),
            blend: 'dest-in',
          }])
          .png()
          .toBuffer()
      : bytes;
    const image = shape === 'circle' || photoUrl?.toLowerCase().endsWith('.png')
      ? await document.embedPng(imageBytes)
      : await document.embedJpg(imageBytes);
    const scale = Math.max(width / image.width, height / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    if (shape === 'circle') {
      page.drawImage(image, { x, y, width, height });
      page.drawEllipse({ x: x + width / 2, y: y + height / 2, xScale: width / 2, yScale: height / 2, borderWidth: 3.5, borderColor });
    } else {
      page.pushOperators(pushGraphicsState(), rectangle(x, y, width, height), clip(), endPath());
      page.drawImage(image, {
        x: x + (width - drawWidth) / 2,
        y: y + (height - drawHeight) / 2,
        width: drawWidth,
        height: drawHeight,
      });
      page.pushOperators(popGraphicsState());
      page.drawRectangle({ x, y, width, height, borderWidth: 1.2, borderColor });
    }
    return true;
  } catch {
    return false;
  }
}

async function drawLogo(document: PDFDocument, page: PDFPage, logoUrl: string | null | undefined, x: number, y: number, size: number) {
  const bytes = await readLocalImage(logoUrl);
  if (!bytes) return false;
  try {
    const image = logoUrl?.toLowerCase().endsWith('.png')
      ? await document.embedPng(bytes)
      : await document.embedJpg(bytes);
    const scale = Math.min(size / image.width, size / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, { x: x + (size - width) / 2, y: y + (size - height) / 2, width, height });
    return true;
  } catch {
    return false;
  }
}

async function drawSchoolMark(document: PDFDocument, page: PDFPage, snapshot: IdCardRenderSnapshot, x: number, y: number, size: number, foreground: ReturnType<typeof rgb>, font: PDFFont) {
  if (await drawLogo(document, page, snapshot.school.logoUrl, x, y, size)) return;
  page.drawCircle({ x: x + size / 2, y: y + size / 2, size: size / 2, color: rgb(1, 1, 1) });
  drawContainedText(page, snapshot.school.initials || initials(snapshot.school.name || 'School'), {
    x: x + 1,
    y: y + size / 2 - 2,
    size: Math.max(5, size * 0.28),
    font,
    color: foreground,
    maxWidth: size - 2,
  });
}

export async function generateIdCardPdf(snapshot: IdCardRenderSnapshot) {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const accent = parseColor(snapshot.school.primaryColor);
  const templateAccent = parseColor(ID_CARD_TEMPLATE_ACCENTS[snapshot.templateId as keyof typeof ID_CARD_TEMPLATE_ACCENTS] || snapshot.school.primaryColor);
  const template = ID_CARD_TEMPLATES[snapshot.templateId as keyof typeof ID_CARD_TEMPLATES];
  if (!template) throw new Error('The selected card template is unavailable.');
  const orientation = snapshot.orientation || template.defaultOrientation;
  const isPortrait = orientation === 'PORTRAIT';
  const includeCardBack = snapshot.includeCardBack ?? Boolean(snapshot.parentPortalQrUrl);
  const pageWidth = isPortrait ? CARD_HEIGHT : CARD_WIDTH;
  const pageHeight = isPortrait ? CARD_WIDTH : CARD_HEIGHT;

  for (const student of snapshot.students) {
    const page = document.addPage([pageWidth, pageHeight]);
    const fullName = safeText([student.firstName, student.middleName, student.lastName].filter(Boolean).join(' '));
    const schoolName = safeText(snapshot.school.name || 'School');
    const nameSize = fullName.length > 25 ? 13 : 16;
    const isInkSaver = snapshot.templateId === 'inkSaver';
    const isEarlyLearners = snapshot.templateId === 'earlyLearners';
    const isHouseTeam = snapshot.templateId === 'houseTeam';
    const isSeniorCollege = snapshot.templateId === 'seniorCollege';
    const isSignatureCollection = snapshot.templateId === 'signatureCollection';
    const isModernInstitution = snapshot.templateId === 'modernInstitution';
    const bandColor = isInkSaver ? rgb(0.15, 0.15, 0.15) : templateAccent;
    const background = isEarlyLearners ? rgb(1, 0.97, 0.89) : rgb(0.98, 0.99, 0.99);

    page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: background });
    if (isSignatureCollection) {
      page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, borderWidth: 4, borderColor: bandColor });
      page.drawRectangle({ x: 8, y: 8, width: pageWidth - 16, height: pageHeight - 16, borderWidth: 0.7, borderColor: rgb(0.78, 0.68, 0.45) });
      page.drawRectangle({ x: 0, y: pageHeight - 30, width: pageWidth, height: 30, color: bandColor });
    } else if (snapshot.templateId === 'crestClassic') {
      page.drawRectangle({ x: 0, y: pageHeight - 38, width: pageWidth, height: 38, color: bandColor });
      page.drawRectangle({ x: 0, y: pageHeight - 41, width: pageWidth, height: 3, color: isInkSaver ? rgb(0.45, 0.45, 0.45) : rgb(0.82, 0.7, 0.38) });
    } else if (isHouseTeam) {
      page.drawRectangle({ x: 0, y: 0, width: 10, height: pageHeight, color: bandColor });
      page.drawRectangle({ x: 10, y: pageHeight - 12, width: pageWidth - 10, height: 12, color: bandColor });
    } else if (isSeniorCollege) {
      page.drawRectangle({ x: 0, y: pageHeight - 7, width: pageWidth, height: 7, color: bandColor });
      page.drawRectangle({ x: 12, y: 12, width: pageWidth - 24, height: pageHeight - 24, borderWidth: 0.7, borderColor: rgb(0.72, 0.77, 0.77) });
    } else if (isEarlyLearners) {
      page.drawRectangle({ x: 0, y: pageHeight - 34, width: pageWidth, height: 34, color: bandColor });
      page.drawCircle({ x: pageWidth - 14, y: pageHeight - 36, size: 18, color: rgb(1, 0.89, 0.63), opacity: 0.7 });
    } else if (isModernInstitution) {
      page.drawRectangle({ x: 0, y: pageHeight - 34, width: pageWidth, height: 34, color: bandColor });
      page.drawRectangle({ x: 0, y: pageHeight - 37, width: pageWidth, height: 3, color: rgb(1, 1, 1), opacity: 0.86 });
      page.drawRectangle({ x: 0, y: 0, width: 4, height: pageHeight - 37, color: bandColor });
    } else if (isInkSaver) {
      page.drawRectangle({ x: 0, y: pageHeight - 30, width: pageWidth, height: 30, color: rgb(1, 1, 1) });
      page.drawLine({ start: { x: 0, y: pageHeight - 31 }, end: { x: pageWidth, y: pageHeight - 31 }, thickness: 1.4, color: rgb(0.18, 0.18, 0.18) });
    } else {
      page.drawRectangle({ x: 0, y: pageHeight - 31, width: pageWidth, height: 31, color: bandColor });
      page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: 5, color: bandColor, opacity: 0.14 });
    }

    if (isPortrait) {
      const mastheadY = pageHeight - (snapshot.templateId === 'crestClassic' ? 33 : 29);
      await drawSchoolMark(document, page, snapshot, 12, mastheadY, isModernInstitution ? 20 : 22, bandColor, bold);
      drawContainedText(page, schoolName, { x: 40, y: pageHeight - 22, size: 9, font: bold, color: snapshot.templateId === 'inkSaver' ? rgb(0.1, 0.1, 0.1) : rgb(1, 1, 1), maxWidth: pageWidth - 52 });
      const proofScale = pageWidth / (isPortrait ? 176 : 384);
      const photoWidth = isModernInstitution
        ? pageWidth * (isPortrait ? 0.4 : 0.27)
        : (snapshot.templateId === 'seniorCollege' ? 72 : isEarlyLearners ? 80 : 64) * proofScale;
      const photoHeight = isModernInstitution
        ? pageHeight * (isPortrait ? 0.29 : 0.55)
        : (snapshot.templateId === 'seniorCollege' ? 96 : isEarlyLearners ? 80 : 80) * proofScale;
      const photoX = isModernInstitution
        ? pageWidth * (isPortrait ? 0.3 : 0.06)
        : isPortrait || isEarlyLearners || snapshot.templateId === 'crestClassic'
          ? (pageWidth - photoWidth) / 2
          : (isHouseTeam ? 24 : snapshot.templateId === 'seniorCollege' ? 24 : 16) * proofScale;
      const photoTop = isModernInstitution
        ? pageHeight * (isPortrait ? 0.25 : 0.31)
        : snapshot.templateId === 'crestClassic'
          ? 108 * proofScale
          : snapshot.templateId === 'seniorCollege'
            ? (pageHeight - photoHeight) / 2
            : (isEarlyLearners ? 52 : 53) * proofScale;
      const photoY = pageHeight - photoTop - photoHeight;
      const photoShape = isEarlyLearners ? 'circle' : 'rectangle';
      if (snapshot.templateId === 'crestClassic') {
        const markSize = 44 * proofScale;
        const markTop = 56 * proofScale;
        await drawSchoolMark(document, page, snapshot, (pageWidth - markSize) / 2, pageHeight - markTop - markSize, markSize, bandColor, bold);
      }
      const hasPhoto = await drawPhoto(document, page, student.photoUrl, photoX, photoY, photoWidth, photoHeight, photoShape, isEarlyLearners ? bandColor : rgb(1, 1, 1));
      if (!hasPhoto) {
        if (photoShape === 'circle') {
            page.drawEllipse({ x: photoX + photoWidth / 2, y: photoY + photoHeight / 2, xScale: photoWidth / 2, yScale: photoHeight / 2, color: rgb(0.94, 0.87, 0.73), borderWidth: 3.5, borderColor: bandColor });
          const mark = initials(fullName);
          const markWidth = bold.widthOfTextAtSize(mark, 16);
          page.drawText(mark, { x: photoX + (photoWidth - markWidth) / 2, y: photoY + photoHeight / 2 - 5, size: 16, font: bold, color: bandColor });
        } else {
          page.drawRectangle({ x: photoX, y: photoY, width: photoWidth, height: photoHeight, color: rgb(0.9, 0.93, 0.93) });
          page.drawText(initials(fullName), { x: photoX + 20, y: photoY + 30, size: 16, font: bold, color: bandColor });
        }
      }
      const textX = snapshot.templateId === 'houseTeam' ? 96 : 12;
      const textWidth = pageWidth - textX - 12;
      if (isEarlyLearners) {
        const textLeft = 8 * proofScale;
        const textWidth = pageWidth - textLeft * 2;
        const nameY = photoY - 23 * proofScale;
        const nameLines = drawStudentName(page, fullName, { x: textLeft, y: nameY, size: 14, font: bold, color: rgb(0.22, 0.28, 0.22), maxWidth: textWidth, centered: true });
        const classLabelY = nameY - nameLines * 16.5 * proofScale - 3.5 * proofScale;
        drawCenteredContainedText(page, 'CLASS', { x: textLeft, y: classLabelY, size: 7 * proofScale, font: bold, color: rgb(0.51, 0.46, 0.36), maxWidth: textWidth });
        drawCenteredContainedText(page, student.className || 'Class not assigned', { x: textLeft, y: classLabelY - 10 * proofScale, size: 10 * proofScale, font: regular, color: rgb(0.22, 0.28, 0.22), maxWidth: textWidth });
        drawCenteredContainedText(page, `ADMISSION NUMBER · ${student.admissionNo || 'Not assigned'}`, { x: textLeft, y: classLabelY - 23 * proofScale, size: 7 * proofScale, font: bold, color: rgb(0.51, 0.46, 0.36), maxWidth: textWidth });
      } else if (snapshot.templateId === 'crestClassic') {
        drawStudentName(page, fullName, { x: 12, y: pageHeight - 148, size: nameSize, font: bold, color: rgb(0.08, 0.12, 0.14), maxWidth: pageWidth - 24, centered: true });
        drawContainedText(page, 'ADMISSION NO.', { x: 12, y: 40, size: 5.5, font: bold, color: rgb(0.42, 0.48, 0.49), maxWidth: pageWidth - 24 });
        drawContainedText(page, student.admissionNo || 'Not assigned', { x: 12, y: 29, size: 8, font: regular, color: rgb(0.2, 0.25, 0.27), maxWidth: pageWidth - 24 });
        drawContainedText(page, 'CLASS', { x: 12, y: 18, size: 5.5, font: bold, color: rgb(0.42, 0.48, 0.49), maxWidth: pageWidth - 24 });
        drawContainedText(page, student.className || 'Class not assigned', { x: 38, y: 18, size: 7, font: bold, color: bandColor, maxWidth: pageWidth - 50 });
      } else if (isModernInstitution) {
        drawContainedText(page, 'STUDENT IDENTITY', { x: 12, y: pageHeight - 139, size: 6, font: bold, color: bandColor, maxWidth: pageWidth - 24 });
        const nameLines = drawStudentName(page, fullName, { x: 12, y: pageHeight - 155, size: fullName.length > 25 ? 11 : 13, font: bold, color: rgb(0.08, 0.12, 0.14), maxWidth: pageWidth - 24, centered: true });
        const detailsShift = nameLines > 1 ? 12 : 0;
        drawContainedText(page, 'ADMISSION NO.', { x: 12, y: pageHeight - 175 - detailsShift, size: 5.5, font: bold, color: rgb(0.42, 0.48, 0.49), maxWidth: pageWidth - 24 });
        drawContainedText(page, student.admissionNo || 'Not assigned', { x: 12, y: pageHeight - 188 - detailsShift, size: 8, font: bold, color: rgb(0.2, 0.25, 0.27), maxWidth: pageWidth - 24 });
        drawContainedText(page, 'CLASS', { x: 12, y: pageHeight - 207 - detailsShift, size: 5.5, font: bold, color: rgb(0.42, 0.48, 0.49), maxWidth: pageWidth - 24 });
        drawContainedText(page, student.className || 'Class not assigned', { x: 12, y: pageHeight - 220 - detailsShift, size: 8, font: bold, color: bandColor, maxWidth: pageWidth - 24 });
      } else {
        drawStudentName(page, fullName, { x: textX, y: pageHeight - 148, size: nameSize, font: bold, color: rgb(0.08, 0.12, 0.14), maxWidth: textWidth, centered: true });
        drawContainedText(page, 'ADMISSION NUMBER', { x: textX, y: 40, size: 6, font: bold, color: rgb(0.42, 0.48, 0.49), maxWidth: textWidth });
        drawContainedText(page, student.admissionNo || 'Not assigned', { x: textX, y: 29, size: 8, font: regular, color: rgb(0.2, 0.25, 0.27), maxWidth: textWidth });
        drawContainedText(page, student.className || 'Class not assigned', { x: textX, y: 18, size: 7, font: bold, color: bandColor, maxWidth: textWidth });
      }
    } else {
      const lightHeader = isInkSaver || isSeniorCollege;
      await drawSchoolMark(document, page, snapshot, 12, pageHeight - 27, 21, lightHeader ? bandColor : rgb(0.04, 0.35, 0.42), bold);
      drawContainedText(page, schoolName, { x: 40, y: pageHeight - 21, size: 9, font: bold, color: lightHeader ? rgb(0.1, 0.12, 0.12) : rgb(1, 1, 1), maxWidth: isModernInstitution ? pageWidth - 122 : pageWidth - 52 });
      if (isModernInstitution) drawContainedText(page, 'STUDENT ID', { x: pageWidth - 72, y: pageHeight - 19, size: 5.5, font: bold, color: rgb(1, 1, 1), maxWidth: 60 });
      const photoWidth = isModernInstitution ? 62 : isSeniorCollege ? 62 : isSignatureCollection ? 64 : 68;
      const photoHeight = isModernInstitution ? 82 : isSeniorCollege ? 84 : isSignatureCollection ? 86 : 92;
      const photoX = isHouseTeam ? 21 : isSignatureCollection ? 18 : 14;
      const photoY = isModernInstitution ? 17 : isSeniorCollege || isSignatureCollection ? 22 : 14;
      const hasPhoto = await drawPhoto(document, page, student.photoUrl, photoX, photoY, photoWidth, photoHeight);
      if (!hasPhoto) {
        page.drawRectangle({ x: photoX, y: photoY, width: photoWidth, height: photoHeight, color: rgb(0.9, 0.93, 0.93) });
        page.drawText(initials(fullName), { x: photoX + 20, y: photoY + 39, size: 22, font: bold, color: bandColor });
      }
      const textX = isModernInstitution ? 88 : isHouseTeam ? 98 : 94;
      const textWidth = pageWidth - textX - 12;
      const titleOffset = isSignatureCollection ? 56 : 53;
      if (isEarlyLearners) {
        const textLeft = 8 * proofScale;
        const textWidth = pageWidth - textLeft * 2;
        const nameY = photoY - 19 * proofScale;
        const nameLines = drawStudentName(page, fullName, { x: textLeft, y: nameY, size: 14, font: bold, color: rgb(0.22, 0.28, 0.22), maxWidth: textWidth, centered: true });
        const classLabelY = nameY - nameLines * 16.5 * proofScale - 3.5 * proofScale;
        drawCenteredContainedText(page, 'CLASS', { x: textLeft, y: classLabelY, size: 7 * proofScale, font: bold, color: rgb(0.51, 0.46, 0.36), maxWidth: textWidth });
        drawCenteredContainedText(page, student.className || 'Class not assigned', { x: textLeft, y: classLabelY - 10 * proofScale, size: 10 * proofScale, font: regular, color: rgb(0.22, 0.28, 0.22), maxWidth: textWidth });
        drawCenteredContainedText(page, `ADMISSION NUMBER · ${student.admissionNo || 'Not assigned'}`, { x: textLeft, y: classLabelY - 23 * proofScale, size: 7 * proofScale, font: bold, color: rgb(0.51, 0.46, 0.36), maxWidth: textWidth });
      } else if (snapshot.templateId === 'houseTeam') {
        drawContainedText(page, 'STUDENT IDENTITY', { x: textX, y: pageHeight - 53, size: 6, font: bold, color: bandColor, maxWidth: textWidth });
        const nameLines = drawStudentName(page, fullName, { x: textX, y: pageHeight - 70, size: nameSize, font: bold, color: rgb(0.08, 0.12, 0.14), maxWidth: textWidth });
        const detailsOffset = nameLines > 1 ? 97 : 91;
        drawContainedText(page, 'ADMISSION NO.', { x: textX, y: pageHeight - detailsOffset, size: 5.5, font: bold, color: rgb(0.42, 0.48, 0.49), maxWidth: textWidth });
        drawContainedText(page, student.admissionNo || 'Not assigned', { x: textX, y: pageHeight - detailsOffset - 12, size: 8, font: regular, color: rgb(0.1, 0.15, 0.16), maxWidth: textWidth });
        drawContainedText(page, 'CLASS', { x: textX, y: 37, size: 5.5, font: bold, color: rgb(0.42, 0.48, 0.49), maxWidth: textWidth });
        drawContainedText(page, student.className || 'Class not assigned', { x: textX, y: 24, size: 8, font: bold, color: bandColor, maxWidth: textWidth });
      } else if (isModernInstitution) {
        drawContainedText(page, 'STUDENT IDENTITY', { x: textX, y: pageHeight - 49, size: 6, font: bold, color: bandColor, maxWidth: textWidth });
        const nameLines = drawStudentName(page, fullName, { x: textX, y: pageHeight - 68, size: fullName.length > 23 ? 11 : 14, font: bold, color: rgb(0.08, 0.12, 0.14), maxWidth: textWidth });
        const detailsOffset = nameLines > 1 ? 96 : 88;
        page.drawLine({ start: { x: textX, y: pageHeight - detailsOffset + 7 }, end: { x: pageWidth - 12, y: pageHeight - detailsOffset + 7 }, thickness: 0.6, color: rgb(0.84, 0.88, 0.88) });
        drawContainedText(page, 'ADMISSION NO.', { x: textX, y: pageHeight - detailsOffset, size: 5.5, font: bold, color: rgb(0.42, 0.48, 0.49), maxWidth: textWidth });
        drawContainedText(page, student.admissionNo || 'Not assigned', { x: textX, y: pageHeight - detailsOffset - 12, size: 9, font: bold, color: rgb(0.1, 0.15, 0.16), maxWidth: textWidth });
        drawContainedText(page, 'CLASS', { x: textX, y: nameLines > 1 ? 31 : 37, size: 5.5, font: bold, color: rgb(0.42, 0.48, 0.49), maxWidth: textWidth });
        drawContainedText(page, student.className || 'Class not assigned', { x: textX, y: nameLines > 1 ? 18 : 24, size: 8, font: bold, color: bandColor, maxWidth: textWidth });
      } else {
        drawContainedText(page, isSeniorCollege ? 'STUDENT IDENTIFICATION' : 'STUDENT ID', { x: textX, y: pageHeight - titleOffset, size: 7, font: bold, color: bandColor, maxWidth: textWidth });
        const nameLines = drawStudentName(page, fullName, { x: textX, y: pageHeight - 68, size: nameSize, font: bold, color: rgb(0.08, 0.12, 0.14), maxWidth: textWidth });
        const detailsOffset = nameLines > 1 ? 95 : 87;
        drawContainedText(page, 'ADMISSION NUMBER', { x: textX, y: pageHeight - detailsOffset, size: 6, font: bold, color: rgb(0.42, 0.48, 0.49), maxWidth: textWidth });
        drawContainedText(page, student.admissionNo || 'Not assigned', { x: textX, y: pageHeight - detailsOffset - 13, size: 9, font: regular, color: rgb(0.1, 0.15, 0.16), maxWidth: textWidth });
        drawContainedText(page, 'CLASS', { x: textX, y: nameLines > 1 ? 28 : 34, size: 6, font: bold, color: rgb(0.42, 0.48, 0.49), maxWidth: textWidth });
        drawContainedText(page, student.className || 'Class not assigned', { x: textX, y: nameLines > 1 ? 15 : 21, size: 9, font: bold, color: bandColor, maxWidth: textWidth });
      }
    }
    const frameColor = snapshot.templateId === 'earlyLearners'
      ? rgb(0.91, 0.77, 0.42)
      : snapshot.templateId === 'crestClassic'
        ? rgb(0.78, 0.66, 0.35)
        : snapshot.templateId === 'houseTeam'
          ? rgb(0.1, 0.3, 0.57)
          : snapshot.templateId === 'signatureCollection'
            ? rgb(0.33, 0.19, 0.29)
            : rgb(0.72, 0.78, 0.78);
    page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, borderWidth: 1, borderColor: frameColor });

    if (includeCardBack) {
      const back = document.addPage([pageWidth, pageHeight]);
      const backPaper = rgb(0.985, 0.99, 0.99);
      const ink = rgb(0.12, 0.18, 0.2);
      const softInk = rgb(0.33, 0.4, 0.42);
      const backAccent = isInkSaver ? rgb(0.18, 0.2, 0.21) : accent;
      back.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: backPaper });
      back.drawRectangle({ x: 0, y: pageHeight - 27, width: pageWidth, height: 27, color: backAccent });
      await drawSchoolMark(document, back, snapshot, 10, pageHeight - 23, 18, backAccent, bold);
      drawContainedText(back, 'STUDENT ID', { x: 34, y: pageHeight - 17, size: 7, font: bold, color: rgb(1, 1, 1), maxWidth: pageWidth - 46 });

      const isBackPortrait = orientation === 'PORTRAIT';
      const textX = 12;
      const hasQr = Boolean(snapshot.parentPortalQrUrl);
      const textWidth = isBackPortrait ? pageWidth - 24 : pageWidth - (hasQr ? 82 : 24);
      const issuedLabelY = pageHeight - (isBackPortrait ? 48 : 45);
      const schoolNameY = pageHeight - (isBackPortrait ? 62 : 58);
      const dividerY = pageHeight - (isBackPortrait ? 69 : 65);
      const foundLabelY = pageHeight - (isBackPortrait ? 85 : 79);
      const messageTopY = pageHeight - (isBackPortrait ? 98 : 92);
      back.drawText('THIS CARD IS ISSUED BY', { x: textX, y: issuedLabelY, size: 6, font: bold, color: backAccent, maxWidth: textWidth });
      drawContainedText(back, schoolName, { x: textX, y: schoolNameY, size: 10, font: bold, color: ink, maxWidth: textWidth });
      back.drawLine({ start: { x: textX, y: dividerY }, end: { x: pageWidth - textX, y: dividerY }, thickness: 0.6, color: rgb(0.79, 0.83, 0.83) });

      back.drawText('IF FOUND', { x: textX, y: foundLabelY, size: 6, font: bold, color: backAccent });
      const returnMessage = 'Please return it to the school office or hand it to the nearest police station.';
      const returnLines = wrapText(returnMessage, regular, 7, textWidth);
      returnLines.forEach((line, index) => back.drawText(line, {
        x: textX,
        y: messageTopY - index * 9,
        size: 7,
        font: regular,
        color: softInk,
        maxWidth: textWidth,
      }));

      const schoolContact = [snapshot.school.address, snapshot.school.phone].filter(Boolean).join(' · ');
      if (schoolContact) {
        const contactLabelY = isBackPortrait ? messageTopY - returnLines.length * 9 - 12 : 39;
        const contactTextY = contactLabelY - 10;
        back.drawText('SCHOOL OFFICE', { x: textX, y: contactLabelY, size: 5.5, font: bold, color: backAccent, maxWidth: textWidth });
        wrapText(safeText(schoolContact), regular, 6, textWidth).slice(0, 2).forEach((line, index) => back.drawText(line, {
          x: textX,
          y: contactTextY - index * 8,
          size: 6,
          font: regular,
          color: softInk,
          maxWidth: textWidth,
        }));
      }

      if (snapshot.parentPortalQrUrl) {
        const qrDataUrl = await QRCode.toDataURL(snapshot.parentPortalQrUrl, { errorCorrectionLevel: 'M', margin: 1, width: 512 });
        const qrBytes = Buffer.from(qrDataUrl.split(',')[1], 'base64');
        const qrImage = await document.embedPng(qrBytes);
        const qrSize = 42;
        const qrX = isBackPortrait ? (pageWidth - qrSize) / 2 : pageWidth - qrSize - 12;
        const qrY = 12;
        const portalLabel = 'PARENT PORTAL';
        const portalLabelWidth = bold.widthOfTextAtSize(portalLabel, 6);
        back.drawRectangle({ x: qrX - 4, y: qrY - 4, width: qrSize + 8, height: qrSize + 8, color: rgb(1, 1, 1), borderWidth: 0.6, borderColor: rgb(0.79, 0.83, 0.83) });
        back.drawImage(qrImage, { x: qrX, y: qrY, width: qrSize, height: qrSize });
        back.drawText(portalLabel, {
          x: isBackPortrait ? textX + (textWidth - portalLabelWidth) / 2 : qrX + (qrSize - portalLabelWidth) / 2,
          y: isBackPortrait ? 68 : qrY + qrSize + 4,
          size: 6,
          font: bold,
          color: backAccent,
          maxWidth: portalLabelWidth,
        });
      }
      back.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, borderWidth: 1, borderColor: rgb(0.82, 0.86, 0.86) });
    }
  }

  return new Uint8Array(await document.save());
}

export async function generateIdCardA4SheetPdf(snapshot: IdCardRenderSnapshot) {
  const cardBytes = await generateIdCardPdf(snapshot);
  const cardDocument = await PDFDocument.load(cardBytes);
  const sheetDocument = await PDFDocument.create();
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const firstPage = cardDocument.getPage(0);
  const cardWidth = firstPage.getWidth();
  const cardHeight = firstPage.getHeight();
  const margin = 28;
  const gap = 12;
  const columns = Math.max(1, Math.floor((pageWidth - 2 * margin + gap) / (cardWidth + gap)));
  const rows = Math.max(1, Math.floor((pageHeight - 2 * margin + gap) / (cardHeight + gap)));
  const perSheet = columns * rows;
  const embeddedPages = await sheetDocument.embedPdf(cardBytes, cardDocument.getPageIndices());
  const includeCardBack = snapshot.includeCardBack ?? Boolean(snapshot.parentPortalQrUrl);
  const sheetGroups = includeCardBack
    ? [embeddedPages.filter((_, index) => index % 2 === 0), embeddedPages.filter((_, index) => index % 2 === 1)]
    : [embeddedPages];

  for (const group of sheetGroups) {
    for (let start = 0; start < group.length; start += perSheet) {
      const page = sheetDocument.addPage([pageWidth, pageHeight]);
      const pageCards = group.slice(start, start + perSheet);
      pageCards.forEach((card, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = margin + column * (cardWidth + gap);
        const y = pageHeight - margin - cardHeight - row * (cardHeight + gap);
        page.drawPage(card, { x, y, width: cardWidth, height: cardHeight });
        const mark = 5;
        const inset = 1.5;
        const color = rgb(0.45, 0.48, 0.49);
        page.drawLine({ start: { x: x - inset, y }, end: { x: x - inset - mark, y }, thickness: 0.35, color });
        page.drawLine({ start: { x, y: y - inset }, end: { x, y: y - inset - mark }, thickness: 0.35, color });
        page.drawLine({ start: { x: x + cardWidth + inset, y }, end: { x: x + cardWidth + inset + mark, y }, thickness: 0.35, color });
        page.drawLine({ start: { x: x + cardWidth, y: y - inset }, end: { x: x + cardWidth, y: y - inset - mark }, thickness: 0.35, color });
        page.drawLine({ start: { x: x - inset, y: y + cardHeight }, end: { x: x - inset - mark, y: y + cardHeight }, thickness: 0.35, color });
        page.drawLine({ start: { x, y: y + cardHeight + inset }, end: { x, y: y + cardHeight + inset + mark }, thickness: 0.35, color });
        page.drawLine({ start: { x: x + cardWidth + inset, y: y + cardHeight }, end: { x: x + cardWidth + inset + mark, y: y + cardHeight }, thickness: 0.35, color });
        page.drawLine({ start: { x: x + cardWidth, y: y + cardHeight + inset }, end: { x: x + cardWidth, y: y + cardHeight + inset + mark }, thickness: 0.35, color });
      });
    }
  }

  return new Uint8Array(await sheetDocument.save());
}

export async function savePrivateIdCardArtifact(orderId: string, bytes: Uint8Array) {
  const storageRoot = path.resolve(process.env.ID_CARD_STORAGE_DIR || path.join(process.cwd(), 'private-storage', 'id-cards'));
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(storageRoot, `${orderId}.pdf`);
  await writeFile(artifactPath, bytes, { mode: 0o600 });
  return artifactPath;
}
