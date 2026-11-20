// ============================================================
// ALNOKHBA QB — Designer Store (zustand)
// The canonical QBDocument is the SINGLE source of truth.
// Fabric is only a view/manipulation layer that reads/writes
// element geometry through this store.
// ============================================================

'use client';

import { create } from 'zustand';
import type {
  QBBranding,
  QBDocument,
  QBElement,
  QBQuestion,
  QBTextStyle,
} from './types';
import { QB_SCHEMA_VERSION } from './types';
import { starterDocument } from './schema';

export interface DesignerState {
  examId: string | null;
  title: string;
  document: QBDocument;
  answerKey: Record<string, string>;
  selectedElementId: string | null;
  activePage: number;
  zoom: number;
  gridSnap: boolean;
  /** bumps on structural changes → canvas full resync */
  structureVersion: number;
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  past: QBDocument[];
  future: QBDocument[];
}

export interface DesignerActions {
  loadExam: (examId: string, title: string, document: QBDocument, answerKey: Record<string, string>) => void;
  addElement: (element: QBElement) => void;
  updateElement: (id: string, patch: { style?: Record<string, unknown>; content?: Record<string, unknown>; rotation?: number; page?: number; visible?: boolean; locked?: boolean; x?: number; y?: number; widthMm?: number; heightMm?: number }) => void;
  deleteElement: (id: string) => void;
  duplicateElement: (id: string) => void;
  reorder: (id: string, dir: 'front' | 'back') => void;
  commitGeometry: (id: string, geom: { x: number; y: number; widthMm: number; heightMm: number; rotation: number }) => void;
  selectElement: (id: string | null) => void;
  setActivePage: (i: number) => void;
  setZoom: (z: number) => void;
  setGridSnap: (v: boolean) => void;
  addQuestion: () => QBQuestion;
  updateQuestion: (id: string, patch: Partial<QBQuestion>) => void;
  deleteQuestion: (id: string) => void;
  setAnswerKey: (questionId: string, optionId: string) => void;
  setPageCount: (n: number) => void;
  updateBranding: (patch: Partial<QBBranding>) => void;
  updateOmr: (patch: Partial<QBDocument['omr']>) => void;
  setGrading: (patch: NonNullable<QBDocument['grading']>) => void;
  setDirection: (d: 'rtl' | 'ltr') => void;
  setTitle: (t: string) => void;
  undo: () => void;
  redo: () => void;
  save: () => Promise<boolean>;
  markClean: () => void;
}

let idCounter = 0;
function genId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36)}`;
}

const HISTORY_CAP = 80;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export const emptyDocument = (): QBDocument => starterDocument('امتحان جديد', 'مدرسة النخبة');

export const useDesignerStore = create<DesignerState & DesignerActions>((set, get) => ({
  examId: null,
  title: '',
  document: emptyDocument(),
  answerKey: {},
  selectedElementId: null,
  activePage: 0,
  zoom: 0.75,
  gridSnap: true,
  structureVersion: 0,
  dirty: false,
  saving: false,
  lastSavedAt: null,
  past: [],
  future: [],

  loadExam: (examId, title, document, answerKey) =>
    set({
      examId,
      title,
      document: clone(document),
      answerKey: clone(answerKey || {}),
      selectedElementId: null,
      activePage: 0,
      zoom: 0.75,
      dirty: false,
      lastSavedAt: null,
      past: [],
      future: [],
      structureVersion: get().structureVersion + 1,
    }),

  addElement: (element) => {
    const { document, past } = get();
    set({
      past: [...past.slice(-HISTORY_CAP), clone(document)],
      future: [],
      document: { ...document, elements: [...document.elements, element] },
      selectedElementId: element.id,
      dirty: true,
      structureVersion: get().structureVersion + 1,
    });
  },

  updateElement: (id, patch) => {
    const { document } = get();
    const elements = document.elements.map((el) => {
      if (el.id !== id) return el;
      const next = { ...el } as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'style') next.style = { ...((el as unknown as { style: Record<string, unknown> }).style), ...(v as Record<string, unknown>) };
        else if (k === 'content') next.content = { ...((el as unknown as { content: Record<string, unknown> }).content), ...(v as Record<string, unknown>) };
        else next[k] = v;
      }
      return next as unknown as QBElement;
    });
    set({ document: { ...document, elements }, dirty: true });
  },

  deleteElement: (id) => {
    const { document, past } = get();
    set({
      past: [...past.slice(-HISTORY_CAP), clone(document)],
      future: [],
      document: { ...document, elements: document.elements.filter((el) => el.id !== id) },
      selectedElementId: get().selectedElementId === id ? null : get().selectedElementId,
      dirty: true,
      structureVersion: get().structureVersion + 1,
    });
  },

  duplicateElement: (id) => {
    const { document, past } = get();
    const src = document.elements.find((el) => el.id === id);
    if (!src) return;
    const copy = { ...clone(src), id: genId('el'), x: src.x + 5, y: src.y + 5 };
    set({
      past: [...past.slice(-HISTORY_CAP), clone(document)],
      future: [],
      document: { ...document, elements: [...document.elements, copy] },
      selectedElementId: copy.id,
      dirty: true,
      structureVersion: get().structureVersion + 1,
    });
  },

  reorder: (id, dir) => {
    const { document, past } = get();
    const els = [...document.elements];
    const idx = els.findIndex((el) => el.id === id);
    if (idx < 0) return;
    const [el] = els.splice(idx, 1);
    if (dir === 'front') els.push(el);
    else els.unshift(el);
    set({
      past: [...past.slice(-HISTORY_CAP), clone(document)],
      future: [],
      document: { ...document, elements: els },
      dirty: true,
      structureVersion: get().structureVersion + 1,
    });
  },

  commitGeometry: (id, geom) => {
    const { document, past } = get();
    set({
      past: [...past.slice(-HISTORY_CAP), clone(document)],
      future: [],
      document: {
        ...document,
        elements: document.elements.map((el) => (el.id === id ? { ...el, ...geom } : el)),
      },
      dirty: true,
    });
  },

  selectElement: (id) => set({ selectedElementId: id }),
  setActivePage: (i) => set({ activePage: Math.max(0, i), selectedElementId: null }),
  setZoom: (z) => set({ zoom: Math.min(3, Math.max(0.25, z)) }),
  setGridSnap: (v) => set({ gridSnap: v }),

  addQuestion: () => {
    const { document, past, activePage } = get();
    const num = document.questions.length + 1;
    const question: QBQuestion = {
      id: genId('q'),
      number: num,
      type: 'mcq',
      prompt: 'نص السؤال الجديد',
      options: [
        { id: 'A', text: '' },
        { id: 'B', text: '' },
        { id: 'C', text: '' },
        { id: 'D', text: '' },
      ],
      marks: 1,
    };
    // place a question element below the lowest element on the active page
    const pageEls = document.elements.filter((el) => el.page === activePage);
    const maxY = pageEls.reduce((m, el) => Math.max(m, el.y + el.heightMm), 36);
    const element: QBElement = {
      id: genId('el'),
      type: 'question',
      page: activePage,
      x: document.margins.leftMm,
      y: Math.min(maxY + 4, document.pageSize.heightMm - 40),
      widthMm: document.pageSize.widthMm - document.margins.leftMm - document.margins.rightMm,
      heightMm: 22,
      rotation: 0,
      style: {
        fontFamily: 'Tajawal',
        fontSize: 12,
        bold: false,
        italic: false,
        underline: false,
        align: document.direction === 'rtl' ? 'right' : 'left',
        color: '#111827',
        lineHeight: 1.5,
      },
      content: {
        questionId: question.id,
        showNumber: true,
        optionLayout: 'inline',
        showOptionLetter: true,
        showMarks: false,
      },
    } as QBElement;
    set({
      past: [...past.slice(-HISTORY_CAP), clone(document)],
      future: [],
      document: { ...document, questions: [...document.questions, question], elements: [...document.elements, element] },
      selectedElementId: element.id,
      dirty: true,
      structureVersion: get().structureVersion + 1,
    });
    return question;
  },

  updateQuestion: (id, patch) => {
    const { document } = get();
    set({
      document: {
        ...document,
        questions: document.questions.map((q) => (q.id === id ? { ...q, ...patch } : q)),
      },
      dirty: true,
      structureVersion: get().structureVersion + 1,
    });
  },

  deleteQuestion: (id) => {
    const { document, past, answerKey } = get();
    const nextKey = { ...answerKey };
    delete nextKey[id];
    set({
      past: [...past.slice(-HISTORY_CAP), clone(document)],
      future: [],
      document: {
        ...document,
        questions: document.questions.filter((q) => q.id !== id).map((q, i) => ({ ...q, number: i + 1 })),
        elements: document.elements.filter((el) => !(el.type === 'question' && (el.content as { questionId?: string }).questionId === id)),
      },
      answerKey: nextKey,
      dirty: true,
      structureVersion: get().structureVersion + 1,
    });
  },

  setAnswerKey: (questionId, optionId) => {
    set({ answerKey: { ...get().answerKey, [questionId]: optionId }, dirty: true });
  },

  setPageCount: (n) => {
    const { document, past } = get();
    const count = Math.min(10, Math.max(1, n));
    set({
      past: [...past.slice(-HISTORY_CAP), clone(document)],
      future: [],
      document: { ...document, pageCount: count },
      activePage: Math.min(get().activePage, count - 1),
      dirty: true,
      structureVersion: get().structureVersion + 1,
    });
  },

  updateBranding: (patch) => {
    const { document, past } = get();
    set({
      past: [...past.slice(-HISTORY_CAP), clone(document)],
      future: [],
      document: { ...document, branding: { ...document.branding, ...patch } },
      dirty: true,
    });
  },

  updateOmr: (patch) => {
    const { document } = get();
    set({
      document: { ...document, omr: { ...document.omr, ...patch } },
      dirty: true,
    });
  },

  setGrading: (patch) => {
    const { document } = get();
    set({
      document: { ...document, grading: { ...document.grading, ...patch } },
      dirty: true,
    });
  },

  setDirection: (d) => {
    const { document, past } = get();
    set({
      past: [...past.slice(-HISTORY_CAP), clone(document)],
      future: [],
      document: { ...document, direction: d },
      dirty: true,
      structureVersion: get().structureVersion + 1,
    });
  },

  setTitle: (t) => set({ title: t, dirty: true }),

  undo: () => {
    const { past, future, document } = get();
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    set({
      document: prev,
      past: past.slice(0, -1),
      future: [clone(document), ...future.slice(0, HISTORY_CAP)],
      selectedElementId: null,
      dirty: true,
      structureVersion: get().structureVersion + 1,
    });
  },

  redo: () => {
    const { past, future, document } = get();
    if (future.length === 0) return;
    const next = future[0];
    set({
      document: next,
      past: [...past.slice(-HISTORY_CAP), clone(document)],
      future: future.slice(1),
      selectedElementId: null,
      dirty: true,
      structureVersion: get().structureVersion + 1,
    });
  },

  save: async () => {
    const { examId, title, document, answerKey } = get();
    if (!examId) return false;
    set({ saving: true });
    try {
      const res = await fetch(`/api/exams/${examId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, document: { ...document, schemaVersion: QB_SCHEMA_VERSION }, answerKey }),
      });
      if (!res.ok) {
        const info = await res.json().catch(() => null);
        console.error('[designer] save failed', res.status, info?.error ?? '');
        set({ saving: false });
        return false;
      }
      set({ saving: false, dirty: false, lastSavedAt: Date.now() });
      return true;
    } catch {
      set({ saving: false });
      return false;
    }
  },

  markClean: () => set({ dirty: false, lastSavedAt: Date.now() }),
}));
