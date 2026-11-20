// ============================================================
// ALNOKHBA QB — schema regression tests (bun test)
//
// Regression for the "exam save 400" bug: the color validator used to
// reject the literal "transparent" that the designer emits, so saving any
// exam whose shape fill was transparent (the default!) failed with 400.
//   • fill "transparent" must PASS sanitizeDocument
//   • an invalid color like "#12" must FAIL
// ============================================================

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { sanitizeDocument } from '@/lib/qb/schema';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./omr-fixtures/document.json', import.meta.url), 'utf8'),
) as { elements: Array<Record<string, unknown>> };

function withShapeFill(fill: string): Record<string, unknown> {
  return {
    ...FIXTURE,
    elements: [
      ...FIXTURE.elements,
      {
        id: 'test_shape_fill_1',
        page: 0,
        type: 'shape',
        x: 10,
        y: 10,
        widthMm: 20,
        heightMm: 10,
        style: {},
        content: { shape: 'rect', fill, stroke: '#000000', strokeWidth: 0.3 },
      },
    ],
  };
}

describe('sanitizeDocument color handling', () => {
  test('fill "transparent" passes (regression: exam save 400)', () => {
    const doc = sanitizeDocument(withShapeFill('transparent')) as {
      elements: Array<{ id: string; content: { fill: string } }>;
    };
    const shape = doc.elements.find((el) => el.id === 'test_shape_fill_1');
    expect(shape).toBeDefined();
    expect(shape?.content.fill).toBe('transparent');
  });

  test('invalid color "#12" fails', () => {
    expect(() => sanitizeDocument(withShapeFill('#12'))).toThrow();
  });

  test('the untouched fixture document still passes', () => {
    expect(() => sanitizeDocument(FIXTURE)).not.toThrow();
  });
});
