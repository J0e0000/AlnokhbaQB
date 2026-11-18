// Shared page-range grammar: "1-3,5,8-"  (1-based input, 0-based output).
//  "8-"  = page 8 to the end
//  "-3"  = pages 1 to 3
// parsePageRanges  -> ascending, de-duplicated (extract / delete / rotate)
// parsePageOrder   -> order preserved, duplicates allowed (organize "3,1,2,2")

export class PageRangeError extends Error {}

function tokenPages(tok: string, n: number): number[] {
  const m = tok.match(/^(\d*)\s*-\s*(\d*)$/);
  let a: number, b: number;
  if (m) {
    a = m[1] === '' ? 1 : Number(m[1]);
    b = m[2] === '' ? n : Number(m[2]);
  } else if (/^\d+$/.test(tok)) {
    a = b = Number(tok);
  } else {
    throw new PageRangeError(`Bad page range "${tok}" (document has ${n} pages)`);
  }
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > n) {
    throw new PageRangeError(`Bad page range "${tok}" (document has ${n} pages)`);
  }
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i - 1);
  return out;
}

export function parsePageRanges(input: string, pageCount: number): number[] {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    throw new PageRangeError('Enter at least one page or range, e.g. 1-3,5');
  }
  if (pageCount < 1) {
    throw new PageRangeError('The document has no pages');
  }
  const seen = new Set<number>();
  for (const tok of trimmed.split(',').map((t) => t.trim()).filter(Boolean)) {
    for (const p of tokenPages(tok, pageCount)) seen.add(p);
  }
  if (seen.size === 0) {
    throw new PageRangeError('Enter at least one page or range, e.g. 1-3,5');
  }
  return [...seen].sort((x, y) => x - y);
}

export function parsePageOrder(input: string, pageCount: number): number[] {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    throw new PageRangeError('Enter the new page order, e.g. 3,1,2');
  }
  if (pageCount < 1) {
    throw new PageRangeError('The document has no pages');
  }
  const out: number[] = [];
  for (const tok of trimmed.split(',').map((t) => t.trim()).filter(Boolean)) {
    const pages = tokenPages(tok, pageCount);
    out.push(...pages);
  }
  if (out.length === 0) {
    throw new PageRangeError('Enter the new page order, e.g. 3,1,2');
  }
  return out;
}
