'use client';

import { useState } from 'react';
import { Copy, Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { baseName } from '@/lib/pw/blob';
import { extractDocumentText, friendlyPdfError } from '@/lib/pw/pdfjs';
import type { OptionValues, OutFile, ToolDef } from '@/lib/pw/types';

interface AiRunnerProps {
  tool: ToolDef;
  files: File[];
  opts: OptionValues;
  onProgress: (message: string, percent?: number) => void;
  onDone: (results: OutFile[], info?: string) => void;
  onError: (message: string) => void;
}

interface SseEvent {
  event: string;
  data: string;
}

/** Client runner for AI tools: extract text locally, stream the answer via SSE. */
export function AiRunner({ tool, files, opts, onProgress, onDone, onError }: AiRunnerProps) {
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const ready = files.length >= (tool.minFiles ?? 1) && !busy;

  const run = async () => {
    const file = files[0];
    if (!file) return;
    setBusy(true);
    setOutput('');
    setCopied(false);
    try {
      onProgress('Reading the document in your browser…', 5);
      const { text } = await extractDocumentText(file, (done, total) =>
        onProgress(`Extracting text — page ${done} of ${total}…`, 5 + Math.round((done / Math.max(1, total)) * 25))
      );
      if (!text.trim()) {
        onError('No extractable text found — this looks like a scan. Run the OCR tool first, then try again.');
        return;
      }
      onProgress('Asking the AI…', 35);

      const res = await fetch('/api/pw/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: tool.aiTool,
          text,
          length: opts.length,
          target: opts.target,
        }),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        onError(data.error || 'The AI service could not be reached.');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';
      const events: SseEvent[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7).trim();
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (!data) continue;
          events.push({ event, data });
          try {
            const payload = JSON.parse(data) as { message?: string; text?: string };
            if (event === 'delta' && payload.text) {
              full += payload.text;
              setOutput(full);
              onProgress('Writing…', 70);
            } else if (event === 'error' && payload.message) {
              onError(payload.message);
              return;
            }
          } catch {
            /* ignore malformed frames */
          }
        }
      }
      void events;

      if (!full.trim()) {
        onError('The model returned an empty response — please retry.');
        return;
      }
      const ext = tool.aiTool === 'markdown' ? 'md' : tool.aiTool === 'summarize' ? (opts.style === 'plain' ? 'txt' : 'md') : 'txt';
      const blob = new Blob([full], { type: ext === 'md' ? 'text/markdown' : 'text/plain' });
      onDone([{ name: `${baseName(file.name)}_${tool.aiTool}.${ext}`, blob }], `${full.length.toLocaleString()} characters generated`);
    } catch (e) {
      onError(e instanceof Error ? friendlyPdfError(e) : 'The AI request failed.');
    } finally {
      setBusy(false);
      onProgress('', undefined);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" onClick={run} disabled={!ready}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
          {busy ? 'Working…' : tool.name}
        </Button>
        <span className="text-xs text-muted-foreground">
          {files.length === 0 ? 'Add a PDF first — the file stays on your device, only its text is analysed.' : 'Text is extracted locally, then streamed from the AI service.'}
        </span>
      </div>

      {output ? (
        <div className="relative rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">AI output</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(output);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <pre className="pw-scroll max-h-96 overflow-y-auto whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed" aria-live="polite">
            {output}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
