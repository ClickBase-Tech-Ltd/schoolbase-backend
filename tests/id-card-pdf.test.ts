import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { ID_CARD_TEMPLATES, type IdCardOrientation } from '../src/services/id-card-pricing.ts';
import { fitStudentName, generateIdCardA4SheetPdf, generateIdCardPdf, ID_CARD_TEMPLATE_ACCENTS, resolveLocalUploadPath, type IdCardRenderSnapshot } from '../src/services/id-card-pdf.ts';

const sample: Omit<IdCardRenderSnapshot, 'templateId' | 'orientation'> = {
  school: { name: 'Greenfield Academy', initials: 'GA', primaryColor: '#0A6670' },
  students: [{ id: 'sample-student', firstName: 'Ada', middleName: null, lastName: 'Okafor', admissionNo: 'GA-001', className: 'JSS 1 A' }],
};

describe('ID card PDF layout', () => {
  it('resolves API-prefixed upload URLs to files inside the backend uploads directory', () => {
    assert.equal(
      resolveLocalUploadPath('/api/uploads/photos/student.jpg'),
      new URL('../uploads/photos/student.jpg', import.meta.url).pathname,
    );
    assert.equal(resolveLocalUploadPath('/uploads/photos/student.jpg'), new URL('../uploads/photos/student.jpg', import.meta.url).pathname);
    assert.equal(resolveLocalUploadPath('/api/uploads/../../.env'), null);
    assert.equal(resolveLocalUploadPath('https://example.com/student.jpg'), null);
  });

  it('embeds student photos for every design and orientation using the API uploads path', async () => {
    const photoUrl = `/api/uploads/photos/id-card-test-${randomUUID()}.png`;
    const photoPath = resolveLocalUploadPath(photoUrl);
    assert.ok(photoPath);
    await mkdir(path.dirname(photoPath), { recursive: true });
    await writeFile(photoPath, await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 28, g: 110, b: 145 } },
    }).png().toBuffer());

    try {
      for (const templateId of Object.keys(ID_CARD_TEMPLATES)) {
        for (const orientation of ['PORTRAIT', 'LANDSCAPE'] as const satisfies readonly IdCardOrientation[]) {
          const bytes = await generateIdCardPdf({
            ...sample,
            templateId,
            orientation,
            students: [{ ...sample.students[0], photoUrl }],
          });
          const document = await PDFDocument.load(bytes);
          const hasEmbeddedImage = document.context.enumerateIndirectObjects().some(([, object]) =>
            object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image',
          );
          assert.equal(hasEmbeddedImage, true, `${templateId} ${orientation} should embed the student photo`);
        }
      }
    } finally {
      await rm(photoPath, { force: true });
    }
  });

  it('wraps complete long student names into two lines with a 10% smaller base size', async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.HelveticaBold);
    const fullName = 'Chukwuemeka Nwachukwu-Nwankwo Uchechukwu Okafor';
    const normalName = fitStudentName('Ada Okafor', font, 16, 132);
    const fitted = fitStudentName(fullName, font, 16, 132);
    assert.equal(normalName.size, 14.4);
    assert.equal(fitted.lines.length, 2);
    assert.equal(fitted.lines.join(' '), fullName);
    assert.ok(fitted.size <= 14.4);
    assert.ok(fitted.lines.every((line) => font.widthOfTextAtSize(line, fitted.size) <= 132));
  });

  it('generates cards with long student names for every design and orientation', async () => {
    const longName = {
      firstName: 'Chukwuemeka',
      middleName: 'Nwachukwu-Nwankwo',
      lastName: 'Uchechukwu Okafor',
    };
    for (const templateId of Object.keys(ID_CARD_TEMPLATES)) {
      for (const orientation of ['PORTRAIT', 'LANDSCAPE'] as const satisfies readonly IdCardOrientation[]) {
        const bytes = await generateIdCardPdf({
          ...sample,
          templateId,
          orientation,
          students: [{ ...sample.students[0], ...longName }],
        });
        const document = await PDFDocument.load(bytes);
        assert.equal(document.getPageCount(), 1, `${templateId} ${orientation} should generate one complete card`);
      }
    }
  });

  it('keeps a distinct accent for every selectable card design', () => {
    const templateIds = Object.keys(ID_CARD_TEMPLATES);
    const accents = templateIds.map((templateId) => ID_CARD_TEMPLATE_ACCENTS[templateId as keyof typeof ID_CARD_TEMPLATE_ACCENTS]);
    assert.equal(accents.length, Object.keys(ID_CARD_TEMPLATE_ACCENTS).length);
    assert.equal(new Set(accents).size, accents.length);
  });

  for (const [templateId, template] of Object.entries(ID_CARD_TEMPLATES)) {
    it(`renders ${template.label} at CR80 dimensions in portrait and landscape`, async () => {
      for (const orientation of ['PORTRAIT', 'LANDSCAPE'] as const satisfies readonly IdCardOrientation[]) {
        const bytes = await generateIdCardPdf({ ...sample, templateId, orientation });
        const document = await PDFDocument.load(bytes);
        const [page] = document.getPages();
        assert.equal(document.getPageCount(), 1);
        assert.equal(Math.round(page.getWidth() * 100) / 100, orientation === 'PORTRAIT' ? 153.5 : 243.4);
        assert.equal(Math.round(page.getHeight() * 100) / 100, orientation === 'PORTRAIT' ? 243.4 : 153.5);
      }
    });
  }

  it('uses each template default orientation when old snapshots have no layout field', async () => {
    for (const [templateId, template] of Object.entries(ID_CARD_TEMPLATES)) {
      const bytes = await generateIdCardPdf({ ...sample, templateId });
      const document = await PDFDocument.load(bytes);
      const [page] = document.getPages();
      const portrait = template.defaultOrientation === 'PORTRAIT';
      assert.equal(page.getWidth() < page.getHeight(), portrait);
    }
  });

  it('renders complete front-and-QR-back output for every design and orientation', async () => {
    for (const templateId of Object.keys(ID_CARD_TEMPLATES)) {
      for (const orientation of ['PORTRAIT', 'LANDSCAPE'] as const satisfies readonly IdCardOrientation[]) {
        const bytes = await generateIdCardPdf({
          ...sample,
          templateId,
          orientation,
          parentPortalQrUrl: 'https://schoolbase.live/parent/login?schoolSlug=greenfield-academy',
        });
        const document = await PDFDocument.load(bytes);
        const width = orientation === 'PORTRAIT' ? 153.5 : 243.4;
        const height = orientation === 'PORTRAIT' ? 243.4 : 153.5;
        assert.equal(document.getPageCount(), 2, `${templateId} ${orientation} should have front and back pages`);
        assert.deepEqual(document.getPages().map((page) => [page.getWidth(), page.getHeight()]), [[width, height], [width, height]]);
      }
    }
  });

  it('renders a text-only back when Parent Portal QR is not configured', async () => {
    const bytes = await generateIdCardPdf({
      ...sample,
      templateId: 'modernInstitution',
      orientation: 'LANDSCAPE',
      includeCardBack: true,
      parentPortalQrUrl: null,
    });
    const document = await PDFDocument.load(bytes);
    assert.equal(document.getPageCount(), 2);
    assert.deepEqual(document.getPages().map((page) => [page.getWidth(), page.getHeight()]), [[243.4, 153.5], [243.4, 153.5]]);
  });

  it('preserves every selected design and orientation in A4 output', async () => {
    for (const templateId of Object.keys(ID_CARD_TEMPLATES)) {
      for (const orientation of ['PORTRAIT', 'LANDSCAPE'] as const satisfies readonly IdCardOrientation[]) {
        const document = await PDFDocument.load(await generateIdCardA4SheetPdf({ ...sample, templateId, orientation }));
        assert.equal(document.getPageCount(), 1, `${templateId} ${orientation} should fit on one A4 sheet`);
        const [page] = document.getPages();
        assert.equal(Math.round(page.getWidth()), 595);
        assert.equal(Math.round(page.getHeight()), 842);
      }
    }
  });

  it('imposes CR80 cards on exact A4 sheets and keeps duplex fronts and backs on separate aligned sheets', async () => {
    const base = { ...sample, templateId: 'modernInstitution', orientation: 'LANDSCAPE' as const };
    const singleSheet = await PDFDocument.load(await generateIdCardA4SheetPdf(base));
    assert.equal(singleSheet.getPageCount(), 1);
    assert.equal(Math.round(singleSheet.getPage(0).getWidth()), 595);
    assert.equal(Math.round(singleSheet.getPage(0).getHeight()), 842);

    const duplexSheets = await PDFDocument.load(await generateIdCardA4SheetPdf({
      ...base,
      includeCardBack: true,
      parentPortalQrUrl: 'https://schoolbase.live/parent/login?schoolSlug=greenfield-academy',
      students: [sample.students[0], { ...sample.students[0], id: 'sample-student-2', admissionNo: 'GA-002' }],
    }));
    assert.equal(duplexSheets.getPageCount(), 2);
    for (const page of duplexSheets.getPages()) {
      assert.equal(Math.round(page.getWidth()), 595);
      assert.equal(Math.round(page.getHeight()), 842);
    }
  });
});
