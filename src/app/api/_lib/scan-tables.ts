// Tables found on a scanned sheet (marks tables, grade tables, handwritten grids).
//
// The engine returns the grid geometry always, and the cell text when it can run
// tesseract (self-hosted / dev). Vercel has no tesseract, so there the engine
// sends the grid crop instead and we OCR that crop once with the configured AI
// provider — the same pipeline /api/ocr uses.

import { processDocument } from '@/lib/qb/ocr/engine';

export interface ScanTable {
  rows: number;
  cols: number;
  cells: string[][];
  text?: string;
  source: 'tesseract' | 'ai' | 'none';
  bbox?: number[];
}

const MAX_TABLES = 2;

function asGrid(value: unknown, rows: number, cols: number): string[][] {
  if (!Array.isArray(value)) return [];
  const grid = value
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => (typeof cell === 'string' ? cell : '')));
  if (grid.length !== rows || grid.some((row) => row.length !== cols)) return [];
  return grid;
}

/** "a | b | c" lines → grid, when the model returned a pipe table. */
export function parsePipeGrid(text: string): string[][] | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('|'))
    .map((line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  if (lines.length < 2) return null;
  const width = lines[0].length;
  if (width < 2 || lines.some((row) => row.length !== width)) return null;
  return lines;
}

/** Engine payload → tables the UI can render. Never throws. */
export async function resolveScanTables(raw: unknown): Promise<ScanTable[]> {
  if (!Array.isArray(raw)) return [];
  const out: ScanTable[] = [];
  for (const entry of raw.slice(0, MAX_TABLES)) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const rows = Number(item.rows);
    const cols = Number(item.cols);
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) continue;
    const table: ScanTable = {
      rows,
      cols,
      cells: asGrid(item.cells, rows, cols),
      source: item.source === 'tesseract' ? 'tesseract' : 'none',
      bbox: Array.isArray(item.bbox) ? (item.bbox as number[]) : undefined,
    };
    const crop = typeof item.crop === 'string' ? item.crop : '';
    if (!table.cells.length && crop) {
      try {
        const ocr = await processDocument({ base64: crop, mime: 'image/jpeg', lang: 'ara' });
        if (ocr.ok && ocr.text) {
          table.text = ocr.text;
          const grid = parsePipeGrid(ocr.text);
          if (grid && grid.length === rows && grid[0].length === cols) {
            table.cells = grid;
            table.source = 'ai';
          }
        }
      } catch {
        // OCR is a bonus: the sheet itself still has to be reviewable
      }
    }
    out.push(table);
  }
  return out;
}
