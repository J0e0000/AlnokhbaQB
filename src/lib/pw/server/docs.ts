// Pagewise — server-side office document builders.
// Pure Node helpers that turn extracted text into real office files:
// .docx (docx), .xlsx (SheetJS) and .pptx (pptxgenjs).
// Imported only by lib/pw/server/engines.ts — Node runtime, no DOM.

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import * as XLSX from 'xlsx';
import PptxGenJS from 'pptxgenjs';

/** One paragraph produced by the text-extraction pipeline. */
export interface DocxParagraph {
  text: string;
  /** Render as Heading 2 instead of body text. */
  heading?: boolean;
  /** Force right-to-left paragraph direction (e.g. Arabic content). */
  rtl?: boolean;
}

/** One slide produced by the PDF-to-PowerPoint pipeline. */
export interface PptxSlide {
  title: string;
  body: string;
}

const ARABIC_RE = /[\u0600-\u06FF]/;

/**
 * Build a .docx from extracted paragraphs.
 * Arabic paragraphs automatically get bidirectional (RTL) layout.
 */
export async function textToDocxBuffer(paragraphs: DocxParagraph[]): Promise<Buffer> {
  const children = paragraphs.map((p) => {
    const rtl = p.rtl === true || ARABIC_RE.test(p.text);
    return new Paragraph({
      heading: p.heading ? HeadingLevel.HEADING_2 : undefined,
      bidirectional: rtl,
      children: [new TextRun({ text: p.text, rightToLeft: rtl })],
    });
  });

  const doc = new Document({
    creator: 'Pagewise',
    description: 'Text extracted from a PDF by Pagewise.',
    title: 'Extracted document text',
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

/**
 * Build an .xlsx workbook from per-page rows.
 * `pages[p]` is an array of rows, each row an array of string cells.
 * One worksheet per page, named Page_1 .. Page_N (Excel name limit: 31 chars).
 */
export function pagesToXlsxBuffer(pages: string[][][]): Buffer {
  const sheets: string[][][] = pages.length > 0 ? pages : [[['']]];
  const wb = XLSX.utils.book_new();
  for (let i = 0; i < sheets.length; i++) {
    const rows = sheets[i].length > 0 ? sheets[i] : [['']];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, `Page_${i + 1}`.slice(0, 31));
  }
  // SheetJS returns a Buffer for bookType 'xlsx' with type 'buffer' on Node.
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * Build a widescreen .pptx (13.33 x 7.5 in) from slides.
 * `title` is rendered large at the top, `body` below it (may be empty).
 */
export async function pagesToPptxBuffer(slides: PptxSlide[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDE';

  for (let i = 0; i < slides.length; i++) {
    const slide = pptx.addSlide();
    const { title, body } = slides[i];
    slide.addText(title.length > 0 ? title : `Page ${i + 1}`, {
      x: 0.6,
      y: 0.35,
      w: 12.13,
      h: 1.1,
      fontSize: 28,
      bold: true,
      color: '333333',
      valign: 'top',
    });
    slide.addText(body, {
      x: 0.6,
      y: 1.6,
      w: 12.13,
      h: 5.4,
      fontSize: 16,
      color: '555555',
      valign: 'top',
    });
  }

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return out as Buffer;
}
