'use client';

import { create } from 'zustand';
import type { FormArea, FormTemplate, SheetResult } from './types';
import { makeTemplate, totalOmrQuestions } from './types';
import { loadFilesAsSheets, type SourceSheet } from './image';
import { readSheet } from './pipeline';

export type FormsStep = 'load' | 'template' | 'read' | 'review';

interface ReadingState {
  active: boolean;
  done: number;
  total: number;
  current: string;
  error: string | null;
}

interface FormsState {
  step: FormsStep;
  sheets: SourceSheet[];
  template: FormTemplate;
  results: SheetResult[];
  reviewCanvases: Record<string, HTMLCanvasElement>;
  reading: ReadingState;
  selectedSheetId: string | null;
  readOpts: { denoise: boolean; allowUnaligned: boolean };

  setStep: (s: FormsStep) => void;
  addFiles: (files: File[], onProgress?: (d: number, t: number, label: string) => void) => Promise<void>;
  removeSheet: (id: string) => void;
  setTemplate: (patch: Partial<FormTemplate> | ((t: FormTemplate) => FormTemplate)) => void;
  addArea: (area: FormArea) => void;
  updateArea: (id: string, patch: Partial<FormArea>) => void;
  removeArea: (id: string) => void;
  setReadOpts: (patch: Partial<{ denoise: boolean; allowUnaligned: boolean }>) => void;
  runRead: () => Promise<void>;
  editCell: (sheetId: string, field: string, patch: { labels?: string[]; status?: SheetResult['fields'][string]['status']; text?: string }) => void;
  selectSheet: (id: string | null) => void;
  resetAll: () => void;
  loadTemplateObject: (t: FormTemplate) => void;
}

export const useFormsStore = create<FormsState>((set, get) => ({
  step: 'load',
  sheets: [],
  template: makeTemplate(),
  results: [],
  reviewCanvases: {},
  reading: { active: false, done: 0, total: 0, current: '', error: null },
  selectedSheetId: null,
  readOpts: { denoise: true, allowUnaligned: false },

  setStep: (s) => set({ step: s }),

  addFiles: async (files, onProgress) => {
    const sheets = await loadFilesAsSheets(files, { maxWidth: 1700, onProgress });
    const prev = get().sheets;
    const merged = [...prev, ...sheets];
    set((state) => ({
      sheets: merged,
      // the first sheet ever loaded becomes the template reference
      template: state.template.refWidth === 0
        ? { ...state.template, refWidth: sheets[0].canvas.width, refHeight: sheets[0].canvas.height }
        : state.template,
      results: [],
      reviewCanvases: {},
      selectedSheetId: null,
      step: state.template.areas.length > 0 || state.template.refWidth > 0 ? state.step : 'template',
    }));
  },

  removeSheet: (id) =>
    set((state) => ({
      sheets: state.sheets.filter((s) => s.id !== id),
      results: state.results.filter((r) => r.sheetId !== id),
      selectedSheetId: state.selectedSheetId === id ? null : state.selectedSheetId,
    })),

  setTemplate: (patch) =>
    set((state) => ({
      template: typeof patch === 'function' ? patch(state.template) : { ...state.template, ...patch },
    })),

  addArea: (area) => set((state) => ({ template: { ...state.template, areas: [...state.template.areas, area] } })),
  updateArea: (id, patch) =>
    set((state) => ({
      template: { ...state.template, areas: state.template.areas.map((a) => (a.id === id ? { ...a, ...patch } : a)) },
    })),
  removeArea: (id) =>
    set((state) => ({ template: { ...state.template, areas: state.template.areas.filter((a) => a.id !== id) } })),

  setReadOpts: (patch) => set((state) => ({ readOpts: { ...state.readOpts, ...patch } })),

  runRead: async () => {
    const { sheets, template, readOpts } = get();
    if (!sheets.length) return;
    set({ reading: { active: true, done: 0, total: sheets.length, current: '', error: null }, results: [], reviewCanvases: {} });
    const results: SheetResult[] = [];
    const canvases: Record<string, HTMLCanvasElement> = {};
    try {
      for (let i = 0; i < sheets.length; i++) {
        set((s) => ({ reading: { ...s.reading, current: sheets[i].fileName, done: i } }));
        // yield to the UI between sheets
        await new Promise((r) => setTimeout(r, 0));
        const outcome = await readSheet(sheets[i], template, readOpts);
        results.push(outcome);
        canvases[outcome.sheetId] = outcome.reviewCanvas;
        set((s) => ({ reading: { ...s.reading, done: i + 1 } }));
      }
      set({
        results,
        reviewCanvases: canvases,
        reading: { active: false, done: sheets.length, total: sheets.length, current: '', error: null },
        selectedSheetId: results[0]?.sheetId ?? null,
        step: 'review',
      });
    } catch (e) {
      set((s) => ({
        results,
        reviewCanvases: canvases,
        reading: { ...s.reading, active: false, error: e instanceof Error ? e.message : String(e) },
      }));
      if (results.length) set({ step: 'review' });
    }
  },

  editCell: (sheetId, field, patch) =>
    set((state) => ({
      results: state.results.map((r) => {
        if (r.sheetId !== sheetId || !r.fields[field]) return r;
        const v = r.fields[field];
        const next = { ...v, ...patch, edited: true };
        // recompute simple flags for this sheet
        const stillMultiple = Object.values(r.fields).some((x) => x.kind === 'omr' && x.status === 'multiple');
        const stillBlank = Object.values({ ...r.fields, [field]: next }).some(
          (x) => x.kind === 'omr' && x.status === 'blank'
        );
        const flags = r.flags.filter((f) => !(f === 'multiple' && !stillMultiple) && !(f === 'blank' && !stillBlank));
        return { ...r, fields: { ...r.fields, [field]: next }, flags };
      }),
    })),

  selectSheet: (id) => set({ selectedSheetId: id }),

  resetAll: () =>
    set({
      step: 'load',
      sheets: [],
      template: makeTemplate(),
      results: [],
      reviewCanvases: {},
      reading: { active: false, done: 0, total: 0, current: '', error: null },
      selectedSheetId: null,
    }),

  loadTemplateObject: (t) => set({ template: t, step: 'template' }),
}));

export function templateSummary(t: FormTemplate, lang: 'ar' | 'en'): string {
  const omr = totalOmrQuestions(t.areas);
  const ocr = t.areas.filter((a) => a.type === 'ocr').length;
  const bcr = t.areas.filter((a) => a.type === 'bcr').length;
  const parts: string[] = [];
  if (omr) parts.push(`${omr} ${lang === 'ar' ? 'سؤال OMR' : 'OMR questions'}`);
  if (ocr) parts.push(`${ocr} ${lang === 'ar' ? 'منطقة نص' : 'OCR regions'}`);
  if (bcr) parts.push(`${bcr} ${lang === 'ar' ? 'منطقة باركود' : 'barcode regions'}`);
  return parts.join(' • ') || (lang === 'ar' ? 'مناطق غير محددة' : 'no areas yet');
}
