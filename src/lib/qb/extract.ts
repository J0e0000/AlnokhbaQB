// ============================================================
// ALNOKHBA QB — Smart extraction core (server-only)
// Page image → VLM → structured candidate questions (zod-validated,
// confidence-scored, NEVER auto-published — human review is mandatory).
// ============================================================

import { z } from 'zod';
import { aiVisionText } from '@/lib/ai/client';

// ---------- zod schemas ----------

export const extractedItemSchema = z.object({
  type: z.enum(['mcq', 'truefalse', 'short']).catch('short'),
  /** question = real exam question; text = any other content block (passage,
   *  definition, instructions, notes…). Non-question text is extracted too,
   *  in the SAME format — the teacher filters it during review. */
  kind: z.enum(['question', 'text']).default('question').catch('question'),
  prompt: z.string().min(1).max(5000),
  options: z
    .array(z.object({ id: z.string().min(1).max(4), text: z.string().max(2000) }))
    .max(6)
    .default([]),
  correctAnswer: z.string().max(4).nullable().catch(null),
  explanation: z.string().max(5000).nullable().catch(null),
  difficulty: z.enum(['easy', 'medium', 'hard']).catch('medium'),
  marks: z.coerce.number().int().min(1).max(100).catch(1),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
});

export type ExtractedItem = z.infer<typeof extractedItemSchema>;

export const EXTRACT_LANGUAGES = ['ara', 'eng', 'auto'] as const;
export type ExtractLanguage = (typeof EXTRACT_LANGUAGES)[number];

// ---------- VLM prompt ----------

const SYSTEM_PROMPT = `أنت نظام خبير في قراءة المستندات التعليمية الممسوحة ضوئيًا واستخراج محتواها بالكامل. Exam-content extraction.
Extract EVERY text block visible in the image, in reading order, into structured JSON — real exam questions AND non-question text alike. NOTHING that carries content may be dropped.
Rules:
- Output ONLY valid JSON. No markdown fences, no commentary: {"questions":[...]}
- Every item: {"type":"mcq"|"truefalse"|"short","kind":"question"|"text","prompt":"...","options":[{"id":"A","text":"..."}],"correctAnswer":"A"|null,"explanation":null,"difficulty":"easy"|"medium"|"hard","marks":1,"confidence":0.0}
- Real exam questions: kind "question".
  - mcq: 2–6 options with ids A,B,C…
  - truefalse: options exactly [{"id":"A","text":"صح"},{"id":"B","text":"خطأ"}] (or "True"/"False" if the paper is English) and correctAnswer "A" or "B" when the paper marks it.
  - short/essay: options [] and correctAnswer null.
- Text that is NOT a question — reading passages, definitions, rules, notes, explanations, solved examples, instructions, exam headers with real content, table captions, essay prompts without options: kind "text", type "short", options [], correctAnswer null — copy the FULL original text into "prompt". Never drop, summarize or paraphrase it.
- Keep items in the SAME ORDER as on the page (top → bottom; for Arabic right → left).
- Preserve the ORIGINAL language of the text exactly — Arabic stays Arabic, English stays English. Never translate.
- Copy mathematical equations in plain text using unicode (× ÷ √ π ² ³ ≤ ≥ ∠ △ ≈ ≠). Copy tables as lines with | separators.
- If the paper marks the correct answer (✓, underline, "الإجابة", key list), set correctAnswer accordingly; otherwise null.
- marks: read from the paper when printed (questions only), otherwise 1.
- confidence: your reading certainty for THIS item (0–1). Use low values for blurry/small/handwritten text.
- Skip ONLY pure page furniture: logos, watermarks and bare page numbers with no other content.
- NEVER invent, complete or "restore" content: only output text you can literally read in the image. If a block is unreadable, skip it (or output it with a very low confidence). Do not add items from memory or guess plausible exam content.
- If a single text block exceeds ~4000 characters, split it into consecutive text items at natural paragraph boundaries.
- If the page is completely blank, output {"questions":[]}`;

// ---------- VLM call ----------

interface VlmPageResult {
  items: ExtractedItem[];
  rawChars: number;
}

export async function extractQuestionsFromPage(
  dataUrl: string,
  language: ExtractLanguage
): Promise<VlmPageResult> {
  const langHint =
    language === 'ara'
      ? 'المستند باللغة العربية بالأساس.'
      : language === 'eng'
        ? 'The document is mainly in English.'
        : 'المستند قد يكون عربيًا أو إنجليزيًا أو مزيجًا — حافظ على لغة كل نص كما هي.';

  const raw = await aiVisionText({
    prompt: `${SYSTEM_PROMPT}\n${langHint}`,
    dataUrl,
    // full-content extraction (questions + passages) needs more headroom
    // than the old questions-only pass — 8192 covers dense A4 pages
    maxTokens: 8192,
  });
  return { items: parseExtractionJson(raw), rawChars: raw.length };
}

// ---------- defensive JSON parsing ----------

export function parseExtractionJson(raw: string): ExtractedItem[] {
  let text = raw.trim();
  // strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // slice from first { to last }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];
  text = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const questions = (parsed as { questions?: unknown })?.questions;
  if (!Array.isArray(questions)) return [];

  const items: ExtractedItem[] = [];
  for (const q of questions) {
    const res = extractedItemSchema.safeParse(q);
    if (res.success && res.data.prompt.trim().length > 0) items.push(res.data);
  }
  return items;
}

// ---------- Arabic-aware duplicate detection ----------

const TASHKEEL = /[\u0617-\u061A\u064B-\u0652\u0670\u0640]/g; // harakat + tatweel
const DIACRITICS = /[\u0622\u0623\u0625]/g; // أ إ آ → ا

/** Normalizes question text for duplicate comparison (Arabic-aware). */
export function normalizeForDuplicate(s: string): string {
  return s
    .replace(TASHKEEL, '')
    .replace(DIACRITICS, 'ا')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function trueFalseOptionsFor(lang: 'ara' | 'eng'): Array<{ id: string; text: string }> {
  return lang === 'ara'
    ? [
        { id: 'A', text: 'صح' },
        { id: 'B', text: 'خطأ' },
      ]
    : [
        { id: 'A', text: 'True' },
        { id: 'B', text: 'False' },
      ];
}
