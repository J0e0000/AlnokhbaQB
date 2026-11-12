// ============================================================
// ALNOKHBA QB — OCR engine abstraction (PHASE 8)
// DocumentProcessor registry: every OCR engine implements the
// same interface; the pipeline picks processors by language and
// runs them in order until one succeeds. Results always carry a
// confidence — null means the engine cannot self-assess, which
// forces `needsReview` (OCR output is NEVER auto-published; the
// teacher review step is mandatory by design).
//
// Adding a future engine (PaddleOCR / Surya / Docling …) = one
// new Processor below + register it. No route changes needed.
// ============================================================

export interface ProcessorInput {
  base64: string;
  mime: string;
  lang: 'ara' | 'eng';
}

export interface ProcessorResult {
  engine: string;
  text: string;
  /** 0..1 self-assessed confidence; null = engine can't assess → review */
  confidence: number | null;
}

export interface DocumentProcessor {
  name: string;
  langs: Array<'ara' | 'eng'>;
  process(input: ProcessorInput): Promise<ProcessorResult | null>; // null = failed/unsuitable
}

// ---------- processor 1: Tesseract (via the local OMR engine service) ----------
// Arabic support is REAL and OFFLINE: the engine bundles ara.traineddata
// (tesseract-ocr/tessdata_fast, Apache-2.0) and reports a mean word
// confidence from tesseract's TSV output. Weak Arabic results (< AR Escalate
// threshold) escalate to the VLM processor below instead of being trusted.

/** Below this self-assessed confidence the next processor gets a chance. */
const ESCALATE_BELOW = 0.6;

const tesseractProcessor: DocumentProcessor = {
  name: 'tesseract',
  langs: ['eng', 'ara'],
  async process({ base64, lang }) {
    const { ocrText } = await import('@/lib/omr/client');
    // Mixed pass: Arabic pages usually contain digits/latin fragments too.
    const res = await ocrText(base64, lang === 'ara' ? 'ara+eng' : lang);
    if (!res.ok || !res.text.trim()) return null;
    return { engine: 'tesseract', text: res.text, confidence: res.confidence ?? null };
  },
};

// ---------- processor 2: z-ai VLM (backend-only vision model) ----------

const VLM_OCR_PROMPT =
  'Extract ALL printed text from this image EXACTLY as written, preserving the original language, reading order and line breaks. Do not translate, summarize or add commentary. Output only the extracted text. / استخرج كل النص المطبوع في الصورة كما هو تمامًا وبالترتيب الأصلي دون ترجمة أو شرح، وأخرج النص فقط.';

export const vlmProcessor: DocumentProcessor = {
  name: 'vlm',
  langs: ['ara', 'eng'],
  async process({ base64, mime }) {
    try {
      // The SDK reads a .z-ai-config FILE — absent on Vercel unless we
      // materialize it from ZAI_CONFIG_JSON first (see src/lib/zai-config.ts).
      const { ensureZaiConfig } = await import('@/lib/zai-config');
      if (!ensureZaiConfig()) return null;
      const mod = (await import('z-ai-web-dev-sdk')) as unknown as {
        default: {
          create: () => Promise<{
            chat: {
              completions: {
                createVision: (params: unknown) => Promise<{
                  choices?: Array<{ message?: { content?: string } }>;
                }>;
              };
            };
          }>;
        };
      };
      const zai = await mod.default.create();
      const completion = await zai.chat.completions.createVision({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VLM_OCR_PROMPT },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
            ],
          },
        ],
        thinking: { type: 'disabled' },
      });
      const text = completion.choices?.[0]?.message?.content;
      if (!text || !text.trim()) return null;
      return { engine: 'vlm', text: text.trim(), confidence: null };
    } catch (err) {
      // surface the real reason in server logs — silent nulls made Vercel
      // OCR failures indistinguishable from genuinely-empty model output
      console.warn(`[ocr] vlm processor failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  },
};

// ---------- registry + pipeline ----------

/**
 * Ordered registry. The first processor that supports the language and
 * succeeds wins. Future engines slot in here without touching routes.
 * (PaddleOCR / Surya / Docling require heavy Python runtimes — deferred;
 * this interface is their integration point.)
 */
const PROCESSORS: DocumentProcessor[] = [tesseractProcessor, vlmProcessor];

export interface DocumentOcrResult {
  ok: boolean;
  engine?: string;
  text?: string;
  confidence: number | null;
  needsReview: boolean;
  stage?: string;
  error?: string;
}

/** Run the processor pipeline for a document image. */
export async function processDocument(input: ProcessorInput): Promise<DocumentOcrResult> {
  const candidates = PROCESSORS.filter((p) => p.langs.includes(input.lang));
  let lastStage = 'noProcessor';
  let lastError: string | undefined;
  // Weak-but-usable result: kept as fallback in case no stronger processor succeeds.
  let weak: ProcessorResult | null = null;

  for (const processor of candidates) {
    try {
      const result = await processor.process(input);
      if (result) {
        // Confident result wins. A self-assessed confidence below ESCALATE_BELOW
        // is never trusted blindly — the next processor (e.g. VLM for Arabic)
        // gets a chance; if none succeeds the weak result is returned flagged.
        if (result.confidence !== null && result.confidence < ESCALATE_BELOW) {
          if (!weak || (weak.confidence ?? 0) < result.confidence) weak = result;
          lastStage = 'lowConfidence';
          lastError = `المحرك ${processor.name} أعاد ثقة منخفضة (${result.confidence})`;
          continue;
        }
        // no self-assessed confidence → the teacher MUST review the text
        const needsReview = result.confidence === null || result.confidence < 0.85;
        return {
          ok: true,
          engine: result.engine,
          text: result.text,
          confidence: result.confidence,
          needsReview,
        };
      }
      lastStage = 'engineEmpty';
      lastError = `المحرك ${processor.name} أعاد نصًا فارغًا`;
    } catch (err) {
      lastStage = 'engineError';
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (weak) {
    return {
      ok: true,
      engine: weak.engine,
      text: weak.text,
      confidence: weak.confidence,
      needsReview: true,
    };
  }

  return { ok: false, confidence: null, needsReview: true, stage: lastStage, error: lastError };
}
