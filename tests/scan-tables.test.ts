// ============================================================
// ALNOKHBA QB — tables found on a scanned sheet
// (bun test tests/scan-tables.test.ts)
//
// The engine always returns the grid geometry. Cell text comes from tesseract
// when the host has it; otherwise the Node layer OCRs the grid crop once with
// the AI provider and reads back a pipe-separated table.
// ============================================================

import { describe, expect, test } from 'bun:test';
import { parsePipeGrid } from '@/app/api/_lib/scan-tables';

describe('parsePipeGrid', () => {
  test('reads a markdown-style table into cells', () => {
    const text = '| الاسم | الدرجة |\n| علي | 9 |\n| منى | 10 |';
    expect(parsePipeGrid(text)).toEqual([
      ['الاسم', 'الدرجة'],
      ['علي', '9'],
      ['منى', '10'],
    ]);
  });

  test('keeps surrounding prose out of the grid', () => {
    const text = 'هذا جدول الدرجات:\n| a | b |\n| 1 | 2 |\nوشكرًا';
    expect(parsePipeGrid(text)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('rejects ragged or single-line output instead of guessing', () => {
    expect(parsePipeGrid('| a | b |')).toBeNull();
    expect(parsePipeGrid('| a | b |\n| 1 |')).toBeNull();
    expect(parsePipeGrid('لا يوجد جدول هنا')).toBeNull();
  });
});
