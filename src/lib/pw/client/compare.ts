// Compare: word-level diff between two PDFs, page by page (pdf.js text).

import { openPdf, closePdf, extractPageTextItems } from '../pdfjs';
import type { RunCtx } from '../types';

export type DiffOp = 'same' | 'add' | 'del';

export interface DiffChunk {
  op: DiffOp;
  text: string;
}

export interface PageDiff {
  page: number; // 1-based
  identical: boolean;
  left: DiffChunk[];
  right: DiffChunk[];
  additions: number;
  deletions: number;
}

const MAX_TOKENS = 3000; // keep LCS quadratic cost bounded per page

function tokenize(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Classic LCS table diff over tokens (bounded). */
function diffTokens(a: string[], b: string[]): DiffChunk[] {
  const norm = (t: string[]) => t.map(normalizeWord);
  const A = norm(a);
  const B = norm(b);
  const n = A.length;
  const m = B.length;
  // LCS lengths
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const chunks: DiffChunk[] = [];
  const push = (op: DiffOp, text: string) => {
    const last = chunks[chunks.length - 1];
    if (last && last.op === op) last.text += ' ' + text;
    else chunks.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', a[i]);
      i++;
    } else {
      push('add', b[j]);
      j++;
    }
  }
  while (i < n) push('del', a[i++]);
  while (j < m) push('add', b[j++]);
  return chunks;
}

/** Diff two PDFs page by page (aligned by page number). */
export async function diffPdfs(
  fileA: File,
  fileB: File,
  ctx: RunCtx
): Promise<{ pages: PageDiff[]; totalAdd: number; totalDel: number }> {
  const pdfA = await openPdf(await fileA.arrayBuffer());
  const pdfB = await openPdf(await fileB.arrayBuffer());
  const total = Math.max(pdfA.numPages, pdfB.numPages);
  const pages: PageDiff[] = [];
  let totalAdd = 0;
  let totalDel = 0;

  const textOf = async (pdf: Awaited<ReturnType<typeof openPdf>>, page: number): Promise<string> => {
    if (page > pdf.numPages) return '';
    const items = await extractPageTextItems(pdf, page);
    return items.map((it) => it.str).join(' ');
  };

  for (let p = 1; p <= total; p++) {
    ctx.onProgress(`Comparing page ${p} of ${total}…`, Math.round((p / total) * 100));
    const ta = await textOf(pdfA, p);
    const tb = await textOf(pdfB, p);
    const ta2 = tokenize(ta).slice(0, MAX_TOKENS);
    const tb2 = tokenize(tb).slice(0, MAX_TOKENS);
    const chunks = ta2.length === 0 && tb2.length === 0 ? [] : diffTokens(ta2, tb2);
    const additions = chunks.filter((c) => c.op === 'add').length;
    const deletions = chunks.filter((c) => c.op === 'del').length;
    totalAdd += additions;
    totalDel += deletions;
    pages.push({
      page: p,
      identical: additions + deletions === 0,
      left: chunks,
      right: chunks,
      additions,
      deletions,
    });
  }
  await closePdf(pdfA);
  await closePdf(pdfB);
  return { pages, totalAdd, totalDel };
}

/** Plain-text report of the diff (downloadable). */
export function diffReport(nameA: string, nameB: string, pages: PageDiff[], totalAdd: number, totalDel: number): string {
  const lines: string[] = [];
  lines.push(`Pagewise comparison report`);
  lines.push(`A: ${nameA}`);
  lines.push(`B: ${nameB}`);
  lines.push(`Pages compared: ${pages.length} · additions: ${totalAdd} words · deletions: ${totalDel} words`);
  lines.push('');
  for (const p of pages) {
    lines.push(`--- Page ${p.page} ${p.identical ? '(identical)' : `(+${p.additions} / -${p.deletions})`}`);
    if (!p.identical) {
      const right = p.right.map((c) => (c.op === 'add' ? `[[+${c.text}]]` : c.op === 'del' ? `[[-${c.text}]]` : c.text)).join(' ');
      lines.push(right);
    } else {
      lines.push('(no changes)');
    }
    lines.push('');
  }
  return lines.join('\n');
}
