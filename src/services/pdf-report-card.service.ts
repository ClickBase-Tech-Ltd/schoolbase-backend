import { PDFDocument, PDFPage, rgb, degrees, PageSizes } from 'pdf-lib';
import ReportCardService from './report-card.service.js';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

interface ReportCardData {
  student: {
    id: string;
    name: string;
    admissionNo: string | null;
    gender: string | null;
    dateOfBirth: string | null;
    photoUrl: string | null;
  };
  school: {
    id: string;
    name: string;
    address: string | null;
    logoUrl: string | null;
    stampUrl: string | null;
    principalName: string | null;
    principalSignatureUrl: string | null;
    principalComment?: string | null;
    initials: string | null;
  };
  class: { name: string; phase: string };
  term: { name: string; session: string; sortOrder: number | null };
  subjects: Array<{
    subjectId: string;
    subjectName: string;
    totalScore: number;
    grade: string;
    subjectPosition: number | null;
    teacherRemark: string | null;
    comment: string | null;
  }>;
  averageScore: number;
  classPosition: number | null;
  totalSubjects: number;
  teacherRemark: string | null;
  principalRemark: string | null;
  reportCardSections?: {
    affective?: Record<string, string>;
    psychomotor?: Record<string, string>;
    teacherCommentsEnabled?: boolean;
    principalCommentsEnabled?: boolean;
    termPrincipalRemark?: string | null;
    attendance?: {
      present: number;
      late: number;
      absent: number;
      excused: number;
      recordedDays: number;
      classRecordedDays: number;
      percentage: number | null;
      coverageComplete: boolean;
      unavailableReason: string | null;
    };
  };
  statistics: {
    highestScore: number;
    lowestScore: number;
    passRate: number;
  };
  thirdTermHistory?: {
    terms: Array<{
      id: string;
      name: string;
      sortOrder: number;
    }>;
    entries: Array<{
      subjectId: string | null;
      subjectName: string;
      currentTotal: number | null;
      cumulativeTotal: number | null;
      previousTotals: Array<{
        termId: string;
        termName: string;
        sortOrder: number;
        totalScore: number | null;
        examScore: number | null;
      }>;
    }>;
  } | null;
}

type ReportCardSubject = ReportCardData['subjects'][number] & {
  caScore?: number | null;
  testScore?: number | null;
  examScore?: number | null;
};

type InlineReportCardData = ReportCardData & {
  subjects: ReportCardSubject[];
  studentPhotoDataUrl?: string | null;
  schoolLogoDataUrl?: string | null;
  schoolStampDataUrl?: string | null;
  principalSignatureDataUrl?: string | null;
};

class PDFReportCardService {
  private prisma: PrismaClient;
  private reportCardService: ReportCardService;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || new PrismaClient();
    this.reportCardService = new ReportCardService(prismaClient);
  }

  /**
   * Generate PDF for a single report card
   */
  async generateReportCardPDF(
    assessmentId: string,
    pupilId: string,
    schoolId: string,
    explicitSignatoryId?: string | null,
    explicitSignatoryMode?: 'auto' | 'principal' | null
  ): Promise<Uint8Array> {
    // Get report card data
    const reportCard = await this.reportCardService.generateReportCard(
      assessmentId,
      pupilId,
      schoolId,
      explicitSignatoryId ?? null,
      explicitSignatoryMode ?? null
    );
    const html = await PDFReportCardService.buildReportCardHtml(reportCard as InlineReportCardData);
    return await PDFReportCardService.renderHtmlToPdf(html);
  }

  private static escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private static buildImageHtml(src?: string | null, alt = ''): string {
    if (!src) return '';
    const safeSrc = this.escapeHtml(src);
    const safeAlt = this.escapeHtml(alt);
    return `<img src="${safeSrc}" alt="${safeAlt}" />`;
  }

  private static buildAssetUrl(value?: string | null): string | null {
    if (!value) return null;
    if (/^https?:\/\//i.test(value) || value.startsWith('data:')) {
      return value;
    }

    const baseUrl = process.env.NEXT_PUBLIC_API_URL || process.env.BACKEND_URL || 'http://localhost:3006';
    const normalizedBase = baseUrl.replace(/\/$/, '');
    return new URL(value.startsWith('/') ? value : `/${value}`, normalizedBase).toString();
  }

  private static async fetchAssetDataUrl(value?: string | null): Promise<string | null> {
    const assetUrl = this.buildAssetUrl(value);
    if (!assetUrl) return null;

    try {
      const response = await fetch(assetUrl);
      if (!response.ok) return assetUrl;

      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || 'image/png';
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    } catch {
      return assetUrl;
    }
  }

  private static async buildReportCardHtml(reportCard: InlineReportCardData): Promise<string> {
    const studentPhotoDataUrl = reportCard.studentPhotoDataUrl ?? (await this.fetchAssetDataUrl(reportCard.student.photoUrl));
    const schoolLogoDataUrl = reportCard.schoolLogoDataUrl ?? (await this.fetchAssetDataUrl(reportCard.school.logoUrl));
    const schoolStampDataUrl = reportCard.schoolStampDataUrl ?? (await this.fetchAssetDataUrl(reportCard.school.stampUrl));
    // Use resolved signatory data only; do not fall back to School principal fields
    const signatorySignatureUrl = (reportCard as any).signatory?.signatureUrl ?? null;
    const signatoryName = (reportCard as any).signatory?.name ?? (reportCard as any).signatory?.title ?? null;
    const signatoryTitle = (reportCard as any).signatory?.title ?? null;
    const signatoryComment = (reportCard as any).signatory?.comment ?? null;
    const principalSignatureDataUrl =
      reportCard.principalSignatureDataUrl ?? (await this.fetchAssetDataUrl(signatorySignatureUrl));

    const subjects = reportCard.subjects as ReportCardSubject[];
    const totalLabel = 'Total';
    const formatRatings = (ratings?: Record<string, string>) => ratings
      ? Object.entries(ratings).length
        ? Object.entries(ratings)
        .map(([indicator, rating]) => `<div><strong>${this.escapeHtml(indicator)}:</strong> ${this.escapeHtml(rating.replace(/_/g, ' ').toLowerCase())}</div>`)
        .join('')
        : '<div>Not assessed</div>'
      : '';
    const sections = reportCard.reportCardSections;
    const optionalSectionsHtml = sections ? `
      ${sections.affective ? `<div class="remark-box"><div class="remark-title">AFFECTIVE DEVELOPMENT</div>${formatRatings(sections.affective)}</div>` : ''}
      ${sections.psychomotor ? `<div class="remark-box"><div class="remark-title">PSYCHOMOTOR SKILLS</div>${formatRatings(sections.psychomotor)}</div>` : ''}
      ${sections.attendance && sections.attendance.classRecordedDays > 0 ? `<div class="remark-box"><div class="remark-title">ATTENDANCE</div><div>${sections.attendance.percentage !== null
        ? `${sections.attendance.percentage}% (${sections.attendance.present + sections.attendance.late} of ${sections.attendance.present + sections.attendance.late + sections.attendance.absent} recorded school days)`
        : `${sections.attendance.recordedDays} pupil attendance records across ${sections.attendance.classRecordedDays} class attendance days`}</div>${sections.attendance.unavailableReason ? `<div>${this.escapeHtml(sections.attendance.unavailableReason)}</div>` : ''}</div>` : ''}
    ` : '';

    const subjectsHtml = subjects
      .map((subject) => `
        <tr>
          <td class="subject">${this.escapeHtml(subject.subjectName)}</td>
          <td class="num">${subject.caScore ?? '-'}</td>
          <td class="num">${subject.testScore ?? '-'}</td>
          <td class="num">${subject.examScore ?? '-'}</td>
          <td class="num total">${subject.totalScore.toFixed(1)}</td>
          <td class="grade"><span>${this.escapeHtml(subject.grade)}</span></td>
          <td class="num">${subject.subjectPosition ?? '-'}</td>
        </tr>
      `)
      .join('');

    const summaryPosition = reportCard.classPosition ?? '-';
    const principalName = signatoryName || 'Principal/Headmaster';
    const showThirdTermHistory = reportCard.term.sortOrder === 3 && reportCard.thirdTermHistory?.entries?.length;
    const thirdTermHistoryHtml = showThirdTermHistory
      ? `
        <div class="remarks" style="margin-top: 10px;">
          <div class="remark-box">
            <div class="remark-title">THIRD TERM CUMULATIVE HISTORY</div>
            <div style="margin-top: 6px; overflow-x: auto;">
              <table style="font-size: 9px; width: 100%; border-collapse: collapse;">
                <thead>
                  <tr>
                    <th style="text-align:left; border: 1px solid #d1d5db; padding: 4px; background: #f3f4f6;">Subject</th>
                    ${reportCard.thirdTermHistory?.terms.map((term) => `<th style="border: 1px solid #d1d5db; padding: 4px; background: #f3f4f6;">${this.escapeHtml(term.name)}</th>`).join('')}
                    <th style="border: 1px solid #d1d5db; padding: 4px; background: #f3f4f6;">Term 3</th>
                    <th style="border: 1px solid #d1d5db; padding: 4px; background: #f3f4f6;">Cumulative</th>
                  </tr>
                </thead>
                <tbody>
                  ${reportCard.thirdTermHistory?.entries.map((entry) => `
                    <tr>
                      <td style="border: 1px solid #d1d5db; padding: 4px; font-weight: 700;">${this.escapeHtml(entry.subjectName)}</td>
                      ${entry.previousTotals.map((termTotal) => `<td style="border: 1px solid #d1d5db; padding: 4px; text-align: center;">${termTotal.totalScore !== null ? termTotal.totalScore.toFixed(1) : '—'}</td>`).join('')}
                      <td style="border: 1px solid #d1d5db; padding: 4px; text-align: center;">${entry.currentTotal !== null ? entry.currentTotal.toFixed(1) : '—'}</td>
                      <td style="border: 1px solid #d1d5db; padding: 4px; text-align: center; font-weight: 700;">${entry.cumulativeTotal !== null ? entry.cumulativeTotal.toFixed(1) : '—'}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `
      : '';

    return `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            @page { size: A4; margin: 0; }
            * { box-sizing: border-box; }
            body {
              margin: 0;
              padding: 0;
              background: #fff;
              font-family: Arial, sans-serif;
              color: #111827;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
            .page {
              width: 210mm;
              min-height: 297mm;
              padding: 10mm;
              margin: 0 auto;
            }
            .card {
              border: 2px solid #111827;
              padding: 10mm;
            }
            .header {
              text-align: center;
              padding-bottom: 10px;
              border-bottom: 2px solid #111827;
              margin-bottom: 14px;
            }
            .logo {
              width: 80px;
              height: 80px;
              object-fit: contain;
              margin: 0 auto 8px;
            }
            .title {
              margin: 0;
              font-size: 20px;
              font-weight: 700;
            }
            .subtle {
              margin: 4px 0 0;
              font-size: 11px;
              color: #374151;
            }
            .report-tag {
              margin: 6px 0 0;
              font-size: 12px;
              font-weight: 700;
            }
            .meta-grid {
              display: grid;
              grid-template-columns: repeat(4, 1fr);
              gap: 8px;
              margin-top: 12px;
              font-size: 10px;
              color: #374151;
            }
            .meta-grid strong { display: block; color: #6b7280; font-size: 9px; }
            .student {
              display: flex;
              gap: 16px;
              margin-bottom: 14px;
            }
            .photo {
              flex: 0 0 auto;
              width: 80px;
              height: 96px;
              border: 2px solid #9ca3af;
              border-radius: 6px;
              overflow: hidden;
              display: flex;
              align-items: center;
              justify-content: center;
              background: #f3f4f6;
            }
            .photo img { width: 100%; height: 100%; object-fit: cover; }
            .info-grid {
              flex: 1;
              display: grid;
              grid-template-columns: repeat(2, minmax(0, 1fr));
              gap: 10px 24px;
              font-size: 10px;
              padding-top: 2px;
            }
            .info-grid .label { color: #6b7280; font-weight: 700; }
            .info-grid .value { color: #111827; font-weight: 700; }
            .section-title {
              font-size: 11px;
              font-weight: 700;
              margin: 0 0 6px;
            }
            table {
              width: 100%;
              border-collapse: collapse;
              font-size: 10px;
            }
            thead th {
              background: #1f2937;
              color: #fff;
              padding: 5px 6px;
              border: 1px solid #6b7280;
              text-align: center;
            }
            tbody td {
              border: 1px solid #6b7280;
              padding: 4px 6px;
              background: #fff;
            }
            tbody tr:nth-child(even) td { background: #f9fafb; }
            td.subject { font-weight: 700; text-align: left; }
            td.num { text-align: center; }
            td.total { font-weight: 700; }
            td.grade span {
              display: inline-block;
              background: #dbeafe;
              color: #1e3a8a;
              font-weight: 700;
              padding: 2px 7px;
              border-radius: 999px;
            }
            .summary-grid {
              display: grid;
              grid-template-columns: repeat(${reportCard.reportCardSections?.attendance ? 5 : 4}, 1fr);
              gap: 8px;
              margin: 14px 0;
              font-size: 10px;
            }
            .summary-box {
              border: 2px solid #9ca3af;
              border-radius: 6px;
              padding: 8px;
              text-align: center;
            }
            .summary-box .name { color: #6b7280; font-weight: 700; }
            .summary-box .value { font-size: 16px; font-weight: 700; color: #111827; margin-top: 2px; }
            .remarks { margin-top: 8px; display: grid; gap: 8px; }
            .remark-box { border: 1px solid #9ca3af; border-radius: 4px; padding: 6px; font-size: 10px; }
            .remark-box .remark-title { font-weight: 700; margin-bottom: 4px; }
            .footer-signatures {
              display: grid;
              grid-template-columns: repeat(3, 1fr);
              gap: 10px;
              margin-top: 16px;
              font-size: 10px;
            }
            .sig { border-top: 1px solid #4b5563; padding-top: 8px; }
            .sig-line { height: 48px; display:flex; align-items:center; justify-content:center; margin-bottom: 4px; }
            .sig-line img { max-width: 100%; max-height: 48px; object-fit: contain; }
            .stamp {
              border: 2px dashed #9ca3af;
              border-radius: 6px;
              display:flex;
              align-items:center;
              justify-content:center;
              min-height: 78px;
              padding: 8px;
            }
            .stamp img { max-width: 100%; max-height: 62px; object-fit: contain; }
            .footer-note {
              margin-top: 12px;
              padding-top: 8px;
              border-top: 1px solid #d1d5db;
              text-align: center;
              font-size: 10px;
              color: #6b7280;
            }
          </style>
        </head>
        <body>
          <div class="page">
            <div class="card">
              <div class="header">
                ${schoolLogoDataUrl ? `<img class="logo" src="${this.escapeHtml(schoolLogoDataUrl)}" alt="School Logo" />` : '<div class="logo" style="border:4px solid #111827;border-radius:999px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#2563eb,#1e3a8a);color:#fff;font-weight:700;font-size:18px;">SB</div>'}
                <h1 class="title">${this.escapeHtml(reportCard.school.name)}</h1>
                ${reportCard.school.address ? `<p class="subtle">${this.escapeHtml(reportCard.school.address)}</p>` : ''}
                <p class="report-tag">STATEMENT OF RESULT</p>
                <p class="subtle">${this.escapeHtml(reportCard.term.session)}</p>
                <div class="meta-grid">
                  <div><strong>TERM</strong>${this.escapeHtml(reportCard.term.name)}</div>
                  <div><strong>CLASS</strong>${this.escapeHtml(reportCard.class.name)}</div>
                  <div><strong>ASSESSMENT</strong>${this.escapeHtml('Assessment')}</div>
                  <div><strong>DATE</strong>${new Date().toLocaleDateString()}</div>
                </div>
              </div>

              <div class="student">
                <div class="photo">
                  ${studentPhotoDataUrl ? `<img src="${this.escapeHtml(studentPhotoDataUrl)}" alt="Student Photo" />` : '<span style="font-size:10px;color:#6b7280;text-align:center;padding:4px;">Student Photo</span>'}
                </div>
                <div class="info-grid">
                  <div><div class="label">Pupil's Name:</div><div class="value">${this.escapeHtml(reportCard.student.name)}</div></div>
                  <div><div class="label">Admission No:</div><div class="value">${this.escapeHtml(reportCard.student.admissionNo || 'N/A')}</div></div>
                  <div><div class="label">Class:</div><div class="value">${this.escapeHtml(reportCard.class.name)}</div></div>
                  <div><div class="label">Term/Session:</div><div class="value">${this.escapeHtml(reportCard.term.name)} ${this.escapeHtml(reportCard.term.session)}</div></div>
                  <div><div class="label">Date of Birth:</div><div class="value">${this.escapeHtml(reportCard.student.dateOfBirth || '—')}</div></div>
                  <div><div class="label">Gender:</div><div class="value">${this.escapeHtml(reportCard.student.gender || '—')}</div></div>
                </div>
              </div>

              <div>
                <p class="section-title">ACADEMIC PERFORMANCE</p>
                <table>
                  <thead>
                    <tr>
                      <th style="text-align:left">Subject</th>
                      <th>CA</th>
                      <th>Test</th>
                      <th>Exam</th>
                      <th>${totalLabel}</th>
                      <th>Grade</th>
                      <th>Position</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${subjectsHtml}
                  </tbody>
                </table>
              </div>

              <div class="summary-grid">
                <div class="summary-box"><div class="name">Average</div><div class="value">${reportCard.averageScore.toFixed(1)}%</div></div>
                <div class="summary-box"><div class="name">Position</div><div class="value">${summaryPosition}</div></div>
                <div class="summary-box"><div class="name">Subjects</div><div class="value">${reportCard.totalSubjects}</div></div>
                <div class="summary-box"><div class="name">Pass Rate</div><div class="value">${reportCard.statistics.passRate.toFixed(0)}%</div></div>
                ${reportCard.reportCardSections?.attendance ? `<div class="summary-box"><div class="name">Attendance</div><div class="value">${reportCard.reportCardSections.attendance.percentage !== null
                  ? `${reportCard.reportCardSections.attendance.percentage}%`
                  : reportCard.reportCardSections.attendance.classRecordedDays === 0
                    ? 'No records'
                    : 'Incomplete'}</div>${reportCard.reportCardSections.attendance.percentage !== null
                  ? `<div class="name">${reportCard.reportCardSections.attendance.present + reportCard.reportCardSections.attendance.late}/${reportCard.reportCardSections.attendance.present + reportCard.reportCardSections.attendance.late + reportCard.reportCardSections.attendance.absent} days</div>`
                  : ''}</div>` : ''}
              </div>

              <div class="remarks">
                ${optionalSectionsHtml}
                ${reportCard.teacherRemark ? `<div class="remark-box"><div class="remark-title">TEACHER'S REMARK:</div><div>${this.escapeHtml(reportCard.teacherRemark)}</div></div>` : ''}
                ${reportCard.principalRemark ? `<div class="remark-box"><div class="remark-title">PRINCIPAL'S REMARK:</div><div>${this.escapeHtml(reportCard.principalRemark)}</div></div>` : ''}
                ${thirdTermHistoryHtml}
              </div>

              <div class="footer-signatures">
                <div class="sig">
                  <div class="sig-line"></div>
                  <div><strong>Teacher's Signature</strong></div>
                  <div>${new Date().toLocaleDateString()}</div>
                </div>
                <div class="sig">
                  <div class="stamp">
                    ${schoolStampDataUrl ? `<img src="${this.escapeHtml(schoolStampDataUrl)}" alt="School Stamp" />` : '<div style="color:#9ca3af;font-weight:700;text-align:center;">SCHOOL STAMP</div>'}
                  </div>
                </div>
                <div class="sig">
                  <div class="sig-line">
                    ${principalSignatureDataUrl ? `<img src="${this.escapeHtml(principalSignatureDataUrl)}" alt="Signature" />` : ''}
                  </div>
                  <div><strong>${this.escapeHtml(signatoryTitle ?? "Principal's Signature")}</strong></div>
                  <div>${this.escapeHtml(principalName)}</div>
                  ${signatoryComment ? `<div class="text-xs" style="color:#6b7280;margin-top:4px;">${this.escapeHtml(signatoryComment)}</div>` : ''}
                </div>
              </div>

              <div class="footer-note">
                <div>Verification Code: ${this.escapeHtml(reportCard.student.id.slice(0, 8).toUpperCase())}</div>
                <div>Generated on ${new Date().toLocaleString()}</div>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
  }

  private static async renderHtmlToPdf(html: string): Promise<Uint8Array> {
    const puppeteer = await import('puppeteer-core');
    const executablePath = this.resolveChromeExecutable();

    const browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 2 });
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      });
      await page.close();
      return new Uint8Array(pdf);
    } finally {
      await browser.close();
    }
  }

  private static resolveChromeExecutable(): string {
    const candidates = [
      process.env.CHROME_PATH,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome 2.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error('Chrome executable not found. Set CHROME_PATH to your local Chrome binary.');
  }

  /**
   * Generate PDFs for all students in an assessment
   * Returns zip file or individual PDFs
   */
  async generateBulkReportCardPDFs(
    assessmentId: string,
    schoolId: string,
    explicitSignatoryId?: string | null,
    explicitSignatoryMode?: 'auto' | 'principal' | null
  ): Promise<Map<string, Uint8Array>> {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
    });

    if (!assessment) {
      throw new Error('Assessment not found');
    }

    // Get all students in this assessment
    const results = await this.prisma.result.findMany({
      where: { assessmentId, assessment: { schoolId } },
      select: { pupilId: true },
      distinct: ['pupilId'],
    });

    const pdfMap = new Map<string, Uint8Array>();

    for (const result of results) {
      try {
        const pdfBytes = await this.generateReportCardPDF(
          assessmentId,
          result.pupilId,
          schoolId,
          explicitSignatoryId ?? null,
          explicitSignatoryMode ?? null
        );

        // Get pupil name for filename
        const pupil = await this.prisma.pupil.findFirst({
          where: { id: result.pupilId, schoolId },
        });

        const filename = `${pupil?.firstName}_${pupil?.lastName}_${assessmentId}.pdf`;
        pdfMap.set(filename, pdfBytes);
      } catch (error) {
        console.error(`Error generating PDF for pupil ${result.pupilId}:`, error);
      }
    }

    return pdfMap;
  }

  /**
   * Generate class ranking report PDF
   */
  async generateClassRankingPDF(
    assessmentId: string,
    schoolId: string
  ): Promise<Uint8Array> {
    const pdfDoc = await PDFDocument.create();
    const helvetica = await pdfDoc.embedFont('Helvetica');
    const page = pdfDoc.addPage(PageSizes.A4);
    const { width, height } = page.getSize();

    let yPosition = height - 40;
    const leftMargin = 40;
    const rightMargin = width - 40;
    const contentWidth = rightMargin - leftMargin;
    const lineHeight = 12;

    // Helper function
    const drawText = (text: string, x: number, y: number, size: number = 11) => {
      page.drawText(text, { x, y, size, font: helvetica, color: rgb(0, 0, 0) });
    };

    const drawBoldText = (text: string, x: number, y: number, size: number = 11) => {
      page.drawText(text, { x, y, size, font: helvetica, color: rgb(0, 0, 0) });
    };

    const drawLine = (y: number) => {
      page.drawLine({
        start: { x: leftMargin, y },
        end: { x: rightMargin, y },
        thickness: 0.5,
        color: rgb(0.5, 0.5, 0.5),
      });
    };

    // Get assessment details
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, schoolId },
      include: {
        class: true,
        term: { include: { academicYear: true } },
      },
    });

    if (!assessment) {
      throw new Error('Assessment not found');
    }

    // Header
    drawBoldText(assessment.class?.name || 'Class Report', leftMargin, yPosition, 16);
    yPosition -= lineHeight * 1.5;

    drawText(`Assessment: ${assessment.name}`, leftMargin, yPosition, 11);
    yPosition -= lineHeight;

    drawText(
      `Term: ${assessment.term?.name} - ${assessment.term?.academicYear?.name}`,
      leftMargin,
      yPosition,
      11
    );
    yPosition -= lineHeight * 2;

    drawLine(yPosition);
    yPosition -= 15;

    // Get ranking data
    const rankingData = await this.reportCardService.getReportCardSummaries(
      assessmentId,
      schoolId
    );

    // Table header
    drawBoldText('RANK', leftMargin, yPosition, 10);
    drawBoldText('STUDENT NAME', leftMargin + 60, yPosition, 10);
    drawBoldText('AVE. SCORE', leftMargin + 250, yPosition, 10);
    drawBoldText('GRADE', leftMargin + 330, yPosition, 10);

    yPosition -= lineHeight;
    drawLine(yPosition);
    yPosition -= 10;

    // Rankings
    for (const student of rankingData.summaries) {
      if (yPosition < 80) {
        const newPage = pdfDoc.addPage(PageSizes.A4);
        yPosition = newPage.getSize().height - 40;
      }

      drawText(student.classPosition?.toString() || '-', leftMargin, yPosition, 10);
      drawText(student.pupilName.substring(0, 30), leftMargin + 60, yPosition, 10);
      drawText(student.totalScore?.toFixed(2) || '-', leftMargin + 250, yPosition, 10);
      drawText(student.grade || '-', leftMargin + 330, yPosition, 10);

      yPosition -= lineHeight;
    }

    const pdfBytes = await pdfDoc.save();
    return pdfBytes;
  }
}

export default PDFReportCardService;
