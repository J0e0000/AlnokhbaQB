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

const tesseractProcessor: DocumentProcessor = {
  name: 'tesseract',
  langs: ['ara', 'eng'],
  async process({ base64, lang }) {
    const { ocrText } = await import('@/lib/omr/client');
    const res = await ocrText(base64, lang);
    if (!res.ok) {
      // transport or engine error — surface the reason so the API details
      // show WHY tesseract failed (binary missing / pack missing / down)
      if ('error' in res && res.error) throw new Error(res.error);
      return null;
    }
    if (!res.text.trim()) return null;
    return { engine: 'tesseract', text: res.text, confidence: null };
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
    } catch {
      return null;
    }
  },
};

// ---------- processor 3: OpenAI-compatible vision API (Vercel: AI_* env) ----------
// The z-ai SDK above only authenticates inside its own sandbox. On Vercel the
// app ships AI_API_KEY + AI_BASE_URL + AI_VISION_MODEL (Groq or any OpenAI-
// compatible vision endpoint) — this processor uses them directly so Arabic
// OCR works in production where tesseract is unavailable.

export const vlmApiProcessor: DocumentProcessor = {
  name: 'vlm-api',
  langs: ['ara', 'eng'],
  async process({ base64, mime }) {
    const apiKey = process.env.AI_API_KEY?.trim();
    const baseUrl = (process.env.AI_BASE_URL?.trim() || 'https://api.groq.com/openai/v1').replace(
      /\/+$/,
      '',
    );
    const model = process.env.AI_VISION_MODEL?.trim();
    if (!apiKey || !model) return null; // not configured → skip silently
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 55_000);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 4096,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: VLM_OCR_PROMPT },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
              ],
            },
          ],
        }),
        signal: ctrl.signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`vlm-api HTTP ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content;
      if (!text || !text.trim()) return null;
      return { engine: 'vlm-api', text: text.trim(), confidence: null };
    } finally {
      clearTimeout(timer);
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
const PROCESSORS: DocumentProcessor[] = [tesseractProcessor, vlmProcessor, vlmApiProcessor];

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

  for (const processor of candidates) {
    try {
      const result = await processor.process(input);
      if (result) {
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
      // surface WHY each engine failed (missing binary / pack / auth …) in
      // the API response details instead of swallowing the reason
      console.error(`[ocr] processor ${processor.name} failed:`, lastError);
    }
  }

  return { ok: false, confidence: null, needsReview: true, stage: lastStage, error: lastError };
}
