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

// STRICT verbatim-OCR protocol. The #1 failure mode of exam extraction is
// hallucination: a weak/downsampled vision model "reconstructs" plausible
// exam content that was never on the page. Counter-measures baked into the
// prompt: (1) copyist identity, not a question generator; (2) every word must
// be traceable to pixels; (3) blank page → EMPTY result is a correct answer;
// (4) mandatory self-verification pass; (5) illegible text is skipped, never
// guessed; (6) answers only when the paper visibly marks them.
const SYSTEM_PROMPT = `أنت محرك OCR حرفي: ناسخ نصوص، لست مولّد أسئلة. You are a STRICT verbatim-OCR engine: a COPYIST, not a question generator.
انسخ ما هو مطبوع في الصورة فقط — حرفًا بحرف — إلى JSON منظم. Transcribe ONLY what is literally printed in the image, word-for-word, into structured JSON.

القواعد الصارمة (STRICT RULES):
1) مصدر واحد للحقيقة: كل كلمة في مخرجاتك يجب أن تكون مقروءة فعلاً في الصورة. يُمنع منعًا باتًا: توليد أسئلة من ذاكرتك أو معرفتك العامة، إكمال نص ناقص، تخمين محتوى غير واضح، أو الترجمة. Every word in your output MUST be visibly printed in the image. NEVER generate questions from your own knowledge, NEVER complete half-visible text, NEVER guess, NEVER translate.
2) الصفحة الفارغة = نتيجة فارغة: إن كانت الصورة بيضاء أو فارغة أو لا تحتوي نصًا مقروءًا، أخرج بالضبط {"questions":[]} ولا شيء غيره. النتيجة الفارغة إجابة صحيحة ومقبولة تمامًا — أسوأ فشل هو اختراع محتوى. A blank/white/no-text page MUST return {"questions":[]} — an empty result is a CORRECT answer; inventing content is the worst possible failure.
3) التحقق قبل الإخراج: بعد بناء القائمة، راجع كل عنصر مقابل الصورة حرفًا بحرف واحذف أي شيء لا تجده في الصورة فعليًا. Before output, self-verify every item against the image character-by-character and delete anything you cannot literally point to in the pixels.
4) غير الواضح: إن كان جزء من النص ضبابيًا فانسخ المقروء منه فقط وخفّض confidence إلى 0.3 أو أقل؛ وإن كانت الكتلة كلها غير مقروءة فتجاهلها ولا تخمّن بديلًا عنها. For blurry text, copy only what is readable and lower confidence (≤0.3); if a whole block is illegible, skip it — never invent a replacement.
5) النسخ الحرفي: احفظ اللغة الأصلية كما هي (لا تترجم أبدًا)، ونفس الترقيم المطبوع (مثل "١." أو "Q3:")، وعلامات الترقيم، والمعادلات بصيغة يونيكود (× ÷ √ π ² ³ ≤ ≥ ∠ △ ≈ ≠)، والجداول أسطرًا مفصولة بـ |. Preserve original wording exactly: same language, same printed numbering ("١." / "Q3:"), same punctuation, math as unicode (× ÷ √ π ² ³ ≤ ≥ ∠ △ ≈ ≠), tables as |-separated lines.
6) كل كتلة ذات محتوى تُستخراج بالصيغة نفسها: الأسئلة الحقيقية kind "question"، ونصوص غير السؤالية kind "text" (مقاطع قراءة، تعريفات، قواعد، تعليمات، ملاحظات، أمثلة محلولة، ترويسات ذات محتوى، عناوين جداول) — بالنص الكامل. لا تحذف ولا تلخّص ولا تعيد صياغة. Extract EVERY content block in the SAME format: real questions as kind "question" AND non-question text as kind "text" (reading passages, definitions, rules, instructions, notes, solved examples, content-bearing headers, table captions) — FULL text, never drop, summarize or paraphrase.
7) الترتيب: نفس ترتيب الصفحة من أعلى لأسفل؛ والعربية من اليمين إلى اليسار. Keep the page's reading order (top → bottom; Arabic right → left).
8) الإجابات الصحيحة: ضعها فقط إذا كانت الورقة تحددها فعلاً (✓ أو تظليل أو كلمة "الإجابة" أو مفتاح إجابات منفصل)؛ غير ذلك correctAnswer دائمًا null. لا تخمّن إجابة أبدًا. Set correctAnswer ONLY when the paper visibly marks it (✓, highlight, the word "الإجابة", or a separate answer key) — otherwise always null. NEVER guess an answer.
9) حقول وصفية (ليست نسخًا): explanation فقط إن كان شرح أو حل مكتوبًا فعلاً في الورقة بجانب السؤال، وإلا null؛ difficulty "easy" افتراضيًا؛ marks من الورقة إن كانت مطبوعة (للأسئلة) وإلا 1؛ confidence = ثقتك في قراءة هذا العنصر تحديدًا (0–1، منخفضة للنص الضبابي أو اليدوي). Metadata fields are NOT transcription: explanation only if a solution/explanation is actually printed beside the question, else null; difficulty defaults "easy"; marks from the paper if printed (questions only) else 1; confidence = your reading certainty for THIS item (low for blurry/handwritten).
10) تجاهل فقط: الشعارات، العلامات المائية، وأرقام الصفحات المجردة بلا أي محتوى آخر. Skip ONLY logos, watermarks and bare page numbers with no other content.
11) نص واحد يتجاوز ~4000 حرف؟ قسّمه إلى عناصر نصية متتالية عند حدود الفقرات الطبيعية. If a single block exceeds ~4000 characters, split it into consecutive text items at natural paragraph boundaries.

مواصفات العنصر (item schema):
{"type":"mcq"|"truefalse"|"short","kind":"question"|"text","prompt":"النص المنسوخ حرفيًا","options":[{"id":"A","text":"..."}],"correctAnswer":"A"|null,"explanation":null,"difficulty":"easy"|"medium"|"hard","marks":1,"confidence":0.0}
- mcq: انسخ الخيارات كما هي مطبوعة (2–6 خيارات) مع معرفات A,B,C… بحسب ترتيبها على الورقة. Copy the options exactly as printed (2–6) with ids A,B,C… in paper order.
- truefalse: options exactly [{"id":"A","text":"صح"},{"id":"B","text":"خطأ"}] (or "True"/"False" for an English paper) and correctAnswer "A" or "B" only when the paper marks it.
- short/essay: options [] and correctAnswer null.

أخرج JSON فقط — بلا أسوار ماركداون وبلا أي شرح: {"questions":[...]}`;

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
    // thinking vision models (Gemini 3.x) can easily run past 2 minutes on
    // a dense page — the route's maxDuration is 300s, so budget 200s here
    timeoutMs: 200_000,
    // greedy decoding — transcription, not generation
    temperature: 0,
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
