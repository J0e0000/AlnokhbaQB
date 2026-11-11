'use client';

// ============================================================
// ALNOKHBA QB — Exam Canvas (deterministic DOM renderer)
// Evaluated Fabric.js as the view layer; replaced with a
// deterministic DOM renderer because Fabric's text direction /
// scaling internals rendered inconsistently (WYSIWYG violation).
// The canonical QBDocument stays the single source of truth;
// this view renders elements at mm×scale and commits geometry
// on interaction end through the same store actions.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesignerStore } from '@/lib/qb/designer-store';
import type { QBElement } from '@/lib/qb/types';

const PXM = 96 / 25.4; // base px per mm at scale 1

type DragState = {
  id: string;
  mode: 'move' | 'resize' | 'rotate';
  startX: number;
  startY: number;
  origin: { x: number; y: number; widthMm: number; heightMm: number; rotation: number };
};

export default function ExamCanvas({ page }: { page: number }) {
  const document = useDesignerStore((s) => s.document);
  const zoom = useDesignerStore((s) => s.zoom);
  const gridSnap = useDesignerStore((s) => s.gridSnap);
  const selectedElementId = useDesignerStore((s) => s.selectedElementId);
  const selectElement = useDesignerStore((s) => s.selectElement);
  const commitGeometry = useDesignerStore((s) => s.commitGeometry);
  const updateElement = useDesignerStore((s) => s.updateElement);

  const dragRef = useRef<DragState | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<Record<string, { x: number; y: number; widthMm: number; heightMm: number; rotation: number }>>({});
  const [guide, setGuide] = useState<{ x?: number; y?: number } | null>(null);

  const scale = PXM * zoom;
  const pageW = document.pageSize.widthMm;
  const pageH = document.pageSize.heightMm;

  // ---------- geometry commit on pointer up ----------
  const endDrag = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    setGuide(null);
    if (!d) return;
    const g = live[d.id];
    if (!g) return;
    commitGeometry(d.id, g);
    setLive((prev) => {
      const next = { ...prev };
      delete next[d.id];
      return next;
    });
  }, [live, commitGeometry]);

  // ---------- pointer move ----------
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dxMm = (e.clientX - d.startX) / scale;
      const dyMm = (e.clientY - d.startY) / scale;
      const o = d.origin;
      let next = { ...o };

      if (d.mode === 'move') {
        next.x = o.x + dxMm;
        next.y = o.y + dyMm;
        if (gridSnap) {
          next.x = Math.round(next.x);
          next.y = Math.round(next.y);
        }
        // center alignment guides
        const cx = next.x + o.widthMm / 2;
        const cy = next.y + o.heightMm / 2;
        if (Math.abs(cx - pageW / 2) < 2) {
          next.x = pageW / 2 - o.widthMm / 2;
          setGuide({ x: pageW / 2 });
        } else if (Math.abs(cy - pageH / 2) < 2) {
          next.y = pageH / 2 - o.heightMm / 2;
          setGuide({ y: pageH / 2 });
        } else {
          setGuide(null);
        }
      } else if (d.mode === 'resize') {
        next.widthMm = Math.max(5, o.widthMm + dxMm);
        next.heightMm = Math.max(3, o.heightMm + dyMm);
        if (gridSnap) {
          next.widthMm = Math.max(5, Math.round(next.widthMm));
          next.heightMm = Math.max(3, Math.round(next.heightMm));
        }
      } else if (d.mode === 'rotate') {
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (rect) {
          const cx = rect.left + (o.x + o.widthMm / 2) * scale;
          const cy = rect.top + (o.y + o.heightMm / 2) * scale;
          const ang = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90;
          next.rotation = Math.round(ang / 5) * 5;
        }
      }
      setLive((prev) => ({ ...prev, [d.id]: next }));
    };
    const onUp = () => endDrag();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [scale, gridSnap, pageW, pageH, endDrag]);

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (window.document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const store = useDesignerStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        store.redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void store.save();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const id = store.selectedElementId;
        if (id) {
          e.preventDefault();
          store.deleteElement(id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const startDrag = (e: React.PointerEvent, el: QBElement, mode: DragState['mode']) => {
    if (el.locked) return;
    e.stopPropagation();
    selectElement(el.id);
    const g = live[el.id] ?? { x: el.x, y: el.y, widthMm: el.widthMm, heightMm: el.heightMm, rotation: el.rotation };
    dragRef.current = {
      id: el.id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      origin: g,
    };
  };

  const geomOf = (el: QBElement) => live[el.id] ?? { x: el.x, y: el.y, widthMm: el.widthMm, heightMm: el.heightMm, rotation: el.rotation };

  // ---------- element content rendering (mirrors render-exam.ts semantics) ----------
  const renderContent = (el: QBElement) => {
    const style = (el as { style: { fontFamily: string; fontSize: number; bold: boolean; italic: boolean; underline: boolean; align: string; color: string; lineHeight: number; direction?: 'rtl' | 'ltr' } }).style;
    const content = el.content as Record<string, unknown>;
    const base: React.CSSProperties = {
      fontFamily: style.fontFamily,
      fontSize: `${style.fontSize}pt`,
      fontWeight: style.bold ? 700 : 400,
      fontStyle: style.italic ? 'italic' : 'normal',
      textDecoration: style.underline ? 'underline' : 'none',
      textAlign: style.align as 'right',
      color: style.color,
      lineHeight: style.lineHeight,
      direction: style.direction ?? document.direction,
      width: '100%',
      height: '100%',
      overflow: 'visible',
      whiteSpace: 'pre-wrap',
    };

    switch (el.type) {
      case 'text':
        return <div style={base}>{String((content as { text?: string }).text ?? '')}</div>;
      case 'header':
        return <div style={{ ...base, fontWeight: 700 }}>{String((content as { text?: string }).text ?? '')}</div>;
      case 'page-number':
        return <div style={base}>{`صفحة ${page + 1} من ${document.pageCount}`}</div>;
      case 'name-fields': {
        const c = content as { fields?: string[]; showStudentId?: boolean };
        const lines: string[] = [];
        if (c.showStudentId) lines.push('رقم الطالب: ........................');
        for (const f of c.fields ?? []) lines.push(`${f}: ........................`);
        return <div style={base}>{lines.join('\n')}</div>;
      }
      case 'question': {
        const c = content as { questionId?: string; showNumber?: boolean; optionLayout?: string; showOptionLetter?: boolean };
        const q = document.questions.find((qq) => qq.id === c.questionId);
        if (!q) return <div style={base} />;
        const num = c.showNumber ? `${q.number}. ` : '';
        const opts = q.options.map((o) => `${c.showOptionLetter === false ? '' : `${o.id}) `}${o.text}`);
        return (
          <div style={base}>
            <div>{num}{q.prompt}</div>
            {c.optionLayout === 'vertical' ? (
              opts.map((t, i) => <div key={i} style={{ paddingInlineStart: '6mm' }}>{t}</div>)
            ) : c.optionLayout === 'grid2' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', paddingInlineStart: '6mm' }}>
                {opts.map((t, i) => <div key={i}>{t}</div>)}
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6mm', paddingInlineStart: '6mm' }}>
                {opts.map((t, i) => <span key={i}>{t}</span>)}
              </div>
            )}
          </div>
        );
      }
      case 'shape': {
        const c = content as { shape?: string; fill?: string; stroke?: string; strokeWidth?: number };
        return (
          <div
            style={{
              width: '100%', height: '100%',
              background: !c.fill || c.fill === 'transparent' ? 'transparent' : c.fill,
              border: `${Math.max(0.5, (c.strokeWidth ?? 0.3) * scale)}px solid ${c.stroke}`,
              borderRadius: c.shape === 'ellipse' ? '50%' : 0,
            }}
          />
        );
      }
      case 'line': {
        const c = content as { stroke?: string; strokeWidth?: number; dash?: string };
        return (
          <div
            style={{
              width: '100%', height: 0,
              borderTop: `${Math.max(0.5, (c.strokeWidth ?? 0.3) * scale)}px ${c.dash === 'dashed' ? 'dashed' : 'solid'} ${c.stroke}`,
            }}
          />
        );
      }
      case 'image':
      case 'logo': {
        const c = content as { dataUrl?: string; fit?: string };
        if (!c.dataUrl) return <div style={{ width: '100%', height: '100%', background: '#f1f5f9', border: '1px dashed #94a3b8' }} />;
        return (
          <img
            src={c.dataUrl}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: (c.fit as 'contain') ?? 'contain' }}
            draggable={false}
          />
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="flex justify-center overflow-auto rounded-lg bg-slate-200/70 p-6">
      <div style={{ width: pageW * scale + 24, height: pageH * scale + 24, position: 'relative', flexShrink: 0 }}>
        <div
          ref={surfaceRef}
          onPointerDown={() => selectElement(null)}
          style={{
            position: 'absolute',
            left: 12,
            top: 12,
            width: pageW * scale,
            height: pageH * scale,
            background: '#ffffff',
            boxShadow: '0 3px 12px rgba(15,23,42,0.25)',
            userSelect: 'none',
          }}
        >
          {/* page border */}
          {document.branding.showBorders && document.branding.borderStyle !== 'none' && (
            <div
              style={{
                position: 'absolute',
                inset: 3,
                border: `${document.branding.borderStyle === 'double' ? 4 : 1.5}px ${document.branding.borderStyle === 'double' ? 'double' : 'solid'} ${document.branding.borderColor}`,
                pointerEvents: 'none',
              }}
            />
          )}

          {/* elements */}
          {document.elements
            .filter((el) => (el.page ?? 0) === page && el.visible !== false)
            .map((el) => {
              const g = geomOf(el);
              const selected = el.id === selectedElementId;
              return (
                <div
                  key={el.id}
                  onPointerDown={(e) => startDrag(e, el, 'move')}
                  style={{
                    position: 'absolute',
                    left: g.x * scale,
                    top: g.y * scale,
                    width: g.widthMm * scale,
                    height: g.heightMm * scale,
                    transform: g.rotation ? `rotate(${g.rotation}deg)` : undefined,
                    transformOrigin: 'center center',
                    outline: selected ? '2px solid #10b981' : 'none',
                    outlineOffset: 1,
                    cursor: el.locked ? 'default' : 'move',
                    touchAction: 'none',
                  }}
                >
                  {renderContent(el)}
                  {selected && !el.locked && (
                    <>
                      <div
                        onPointerDown={(e) => startDrag(e, el, 'resize')}
                        style={{ position: 'absolute', right: -5, bottom: -5, width: 11, height: 11, background: '#10b981', border: '2px solid white', borderRadius: 3, cursor: 'nwse-resize', touchAction: 'none' }}
                      />
                      <div
                        onPointerDown={(e) => startDrag(e, el, 'rotate')}
                        style={{ position: 'absolute', left: '50%', top: -22, width: 12, height: 12, marginLeft: -6, background: '#0ea5e9', border: '2px solid white', borderRadius: 999, cursor: 'grab', touchAction: 'none' }}
                      />
                    </>
                  )}
                </div>
              );
            })}

          {/* alignment guide */}
          {guide?.x !== undefined && (
            <div style={{ position: 'absolute', left: guide.x * scale, top: 0, bottom: 0, width: 1, background: '#10b981', pointerEvents: 'none' }} />
          )}
          {guide?.y !== undefined && (
            <div style={{ position: 'absolute', top: guide.y * scale, left: 0, right: 0, height: 1, background: '#10b981', pointerEvents: 'none' }} />
          )}
        </div>
      </div>
    </div>
  );
}
