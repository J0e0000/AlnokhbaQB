// Organize tools: merge, split/extract, remove pages, order, rotate.
// All run fully in the browser with pdf-lib.

import { PDFDocument, degrees } from 'pdf-lib';
import { parsePageOrder, parsePageRanges } from '../range';
import { baseName } from '../blob';
import type { OptionValues, OutFile, RunCtx } from '../types';

export async function loadDoc(file: File | ArrayBuffer): Promise<PDFDocument> {
  const buf = file instanceof File ? await file.arrayBuffer() : file;
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buf, { ignoreEncryption: true, throwOnInvalidObject: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/encrypt|password|PDFDict|PDFStream|Expected instance/i.test(msg)) {
      throw new Error(
        'This PDF is encrypted or its structure is unreadable. If it is password-protected, use the Unlock tool first; if it is damaged, try Repair.'
      );
    }
    throw e;
  }
  if (doc.isEncrypted) {
    throw new Error('This PDF is encrypted. Use the Unlock tool with its password first, then retry.');
  }
  return doc;
}

export async function saveDoc(doc: PDFDocument, name: string, info?: string): Promise<OutFile> {
  const bytes = await doc.save({ useObjectStreams: true });
  return { name, blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }), info };
}

/** Merge PDFs in the chosen order. */
export async function runMerge(files: File[], _opts: OptionValues, ctx: RunCtx): Promise<OutFile[]> {
  if (files.length < 2) throw new Error('Pick at least two PDF files to merge');
  const out = await PDFDocument.create();
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    ctx.onProgress(`Adding ${files[i].name} (${i + 1}/${files.length})…`, Math.round(((i + 1) / files.length) * 90));
    const src = await loadDoc(files[i]);
    if (src.getPageCount() === 0) {
      throw new Error(`"${files[i].name}" is not a valid PDF (0 pages). Try the Repair tool first.`);
    }
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    total += pages.length;
  }
  ctx.onProgress('Writing merged document…', 100);
  return [await saveDoc(out, 'merged.pdf', `${files.length} files · ${total} pages`)];
}

/** Split: extract ranges into one document, or burst every N pages. */
export async function runSplit(files: File[], opts: OptionValues, ctx: RunCtx): Promise<OutFile[]> {
  const src = await loadDoc(files[0]);
  const n = src.getPageCount();
  const base = baseName(files[0].name);
  if (opts.mode === 'every') {
    const k = Math.max(1, Math.floor(Number(opts.size) || 1));
    const outs: OutFile[] = [];
    for (let i = 0; i < n; i += k) {
      const part = await PDFDocument.create();
      const idx = Array.from({ length: Math.min(k, n - i) }, (_, j) => i + j);
      (await part.copyPages(src, idx)).forEach((p) => part.addPage(p));
      const first = idx[0] + 1;
      const last = idx[idx.length - 1] + 1;
      ctx.onProgress(`Part ${outs.length + 1} (pages ${first}-${last})…`, Math.round(((i + k) / n) * 95));
      outs.push(await saveDoc(part, `${base}_pages_${first}-${last}.pdf`));
    }
    return outs;
  }
  const idx = parsePageRanges(String(opts.ranges ?? ''), n);
  ctx.onProgress(`Extracting ${idx.length} page${idx.length > 1 ? 's' : ''}…`, 60);
  const out = await PDFDocument.create();
  (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
  return [await saveDoc(out, `${base}_extract.pdf`, `${idx.length} of ${n} pages`)];
}

/** Remove listed pages; error if nothing would remain. */
export async function runRemove(files: File[], opts: OptionValues, ctx: RunCtx): Promise<OutFile[]> {
  const src = await loadDoc(files[0]);
  const n = src.getPageCount();
  const remove = new Set(parsePageRanges(String(opts.pages ?? ''), n));
  const keep = src.getPageIndices().filter((i) => !remove.has(i));
  if (keep.length === 0) throw new Error('That would remove every page — the result would be empty.');
  ctx.onProgress(`Removing ${remove.size} page${remove.size > 1 ? 's' : ''}…`, 50);
  const out = await PDFDocument.create();
  (await out.copyPages(src, keep)).forEach((p) => out.addPage(p));
  return [await saveDoc(out, `${baseName(files[0].name)}_trimmed.pdf`, `${keep.length} pages remain (was ${n})`)];
}

/** Build a new document from an explicit order, e.g. "3,1,2,2". */
export async function runOrganizeOrder(files: File[], opts: OptionValues, ctx: RunCtx): Promise<OutFile[]> {
  const src = await loadDoc(files[0]);
  const n = src.getPageCount();
  const order = parsePageOrder(String(opts.order ?? ''), n);
  ctx.onProgress(`Building new order (${order.length} pages)…`, 50);
  const out = await PDFDocument.create();
  (await out.copyPages(src, order)).forEach((p) => out.addPage(p));
  return [await saveDoc(out, `${baseName(files[0].name)}_organized.pdf`, `${order.length} pages`)];
}

/** Rotate all or selected pages by 90/180/270 degrees (clockwise). */
export async function runRotate(files: File[], opts: OptionValues, ctx: RunCtx): Promise<OutFile[]> {
  const src = await loadDoc(files[0]);
  const n = src.getPageCount();
  const input = String(opts.pages ?? '').trim();
  const targets = input ? parsePageRanges(input, n) : src.getPageIndices();
  const deg = Number(opts.degrees ?? 90);
  ctx.onProgress(`Rotating ${targets.length} page${targets.length > 1 ? 's' : ''} by ${deg}°…`, 50);
  for (const i of targets) {
    const page = src.getPage(i);
    const current = page.getRotation().angle;
    page.setRotation(degrees((current + deg) % 360));
  }
  return [await saveDoc(src, `${baseName(files[0].name)}_rotated.pdf`, `${targets.length} of ${n} pages rotated ${deg}°`)];
}
