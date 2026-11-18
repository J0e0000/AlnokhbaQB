'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Download,
  FileDown,
  Loader2,
  Package,
  RotateCcw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  defaultsOf,
  type OptionValues,
  type OutFile,
  type ToolDef,
  type ToolOption,
} from '@/lib/pw/types';
import { formatBytes, sanitizeFileName } from '@/lib/pw/blob';
import { friendlyPdfError } from '@/lib/pw/pdfjs';
import { CUSTOM_EDITORS } from './editors';
import { AiRunner } from './AiRunner';

interface ResultRow {
  name: string;
  size: number;
  info?: string;
  blob?: Blob;
  serverFile?: string;
}

const PRIVACY_TEXT: Record<ToolDef['privacy'], string> = {
  local: 'Runs entirely in your browser — files never leave your device.',
  server: 'Processed on our server — files are deleted right after the job (max 1 hour).',
  'text-only': 'Only the extracted text is sent to the AI service — the file itself never leaves your device.',
};

function acceptMatches(accept: string, file: File): boolean {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (accept.includes('pdf')) return ext === '.pdf' || file.type === 'application/pdf';
  if (accept.includes('image/')) return file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(ext);
  if (accept.includes('.docx') || accept.includes('office')) {
    return /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv)$/i.test(ext);
  }
  if (accept.includes('.html')) return /\.(html?|htm)$/i.test(ext) || file.type === 'text/html';
  return true;
}

export function Workspace({ tool, onBack }: { tool: ToolDef; onBack: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [opts, setOpts] = useState<OptionValues>(() => defaultsOf(tool));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ message: string; pct: number | null }>({ message: '', pct: null });
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [resultsInfo, setResultsInfo] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragIndex = useRef<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const minFiles = tool.minFiles ?? 1;
  const isEditor = Boolean(tool.custom);
  const Editor = tool.custom ? CUSTOM_EDITORS[tool.custom] : null;

  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  // Reset the whole flow when the user switches tools.
  useEffect(() => {
    setFiles([]);
    setOpts(defaultsOf(tool));
    setRunning(false);
    setError(null);
    setResults([]);
    setResultsInfo(null);
    setJobId(null);
    setProgress({ message: '', pct: null });
    if (pollRef.current) clearTimeout(pollRef.current);
  }, [tool.id]);

  const resetForFiles = useCallback(() => {
    setError(null);
    setResults([]);
    setResultsInfo(null);
    setJobId(null);
    setProgress({ message: '', pct: null });
  }, []);

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const accepted: File[] = [];
      const rejected: string[] = [];
      for (const f of Array.from(incoming)) {
        if (acceptMatches(tool.accept, f)) accepted.push(f);
        else rejected.push(f.name);
      }
      if (rejected.length > 0) {
        setError(`Skipped unsupported file${rejected.length > 1 ? 's' : ''}: ${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? '…' : ''}`);
      } else {
        setError(null);
      }
      setFiles((prev) => {
        const base = tool.multi ? prev : [];
        const cap = tool.maxFiles ?? (tool.multi ? 200 : 1);
        const next = [...base, ...accepted].slice(0, cap);
        return next;
      });
      resetForFiles();
    },
    [tool.accept, tool.multi, tool.maxFiles, resetForFiles]
  );

  const removeFile = (i: number) => {
    setFiles((prev) => prev.filter((_, idx) => idx !== i));
    resetForFiles();
  };

  const moveFile = (from: number, to: number) => {
    setFiles((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    resetForFiles();
  };

  const onProgress = useCallback((message: string, percent?: number) => {
    setProgress({ message, pct: percent == null ? null : Math.max(0, Math.min(100, Math.round(percent))) });
  }, []);

  const onDone = useCallback((out: OutFile[], info?: string) => {
    setRunning(false);
    setProgress({ message: '', pct: null });
    setResultsInfo(info ?? null);
    setResults(
      out.map((o) => ({
        name: o.name,
        size: o.blob.size,
        info: o.info,
        blob: o.blob,
      }))
    );
  }, []);

  const onError = useCallback((message: string) => {
    setRunning(false);
    setProgress({ message: '', pct: null });
    setError(message);
  }, []);

  // ------------------------------------------------------------ runners --

  const runClient = async () => {
    if (!tool.run) return;
    setRunning(true);
    setError(null);
    setResults([]);
    setResultsInfo(null);
    try {
      const out = await tool.run(files, opts, { onProgress });
      onDone(out);
    } catch (e) {
      onError(e instanceof Error ? friendlyPdfError(e) : 'Something went wrong');
    }
  };

  const pollJob = useCallback(
    (id: string, startedAt: number) => {
      pollRef.current = setTimeout(async () => {
        try {
          const res = await fetch(`/api/pw/jobs/${id}`);
          if (res.status === 404) {
            onError('The job expired on the server. Please run it again.');
            return;
          }
          const data = (await res.json()) as {
            status: string;
            progress: number;
            message: string;
            error?: string;
            results?: { name: string; size: number; info?: string }[];
          };
          if (data.status === 'done') {
            onProgress('Done', 100);
            setJobId(id);
            setResultsInfo(null);
            setResults(
              (data.results ?? []).map((r) => ({ name: r.name, size: r.size, info: r.info, serverFile: r.name }))
            );
            setRunning(false);
            setProgress({ message: '', pct: null });
            return;
          }
          if (data.status === 'error') {
            onError(data.error || 'The job failed on the server');
            return;
          }
          if (Date.now() - startedAt > 5 * 60 * 1000) {
            onError('The job is taking unusually long and was stopped waiting. Try a smaller file.');
            return;
          }
          onProgress(data.message || 'Working…', data.progress);
          pollJob(id, startedAt);
        } catch {
          onError('Lost connection to the server while waiting for the job.');
        }
      }, 900);
    },
    [onError, onProgress]
  );

  const runServer = async () => {
    setRunning(true);
    setError(null);
    setResults([]);
    setResultsInfo(null);
    setJobId(null);
    setProgress({ message: 'Uploading…', pct: null });
    try {
      const form = new FormData();
      form.append('tool', tool.serverTool ?? tool.id);
      form.append('options', JSON.stringify(opts));
      for (const f of files) form.append('files', f, f.name);
      const res = await fetch('/api/pw/jobs', { method: 'POST', body: form });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        onError(data.error || 'The server rejected the job');
        return;
      }
      onProgress('Queued…', 2);
      pollJob(data.id, Date.now());
    } catch {
      onError('Could not reach the server. Check your connection and retry.');
    }
  };

  const downloadAll = async () => {
    if (results.length < 2) return;
    if (results.every((r) => r.blob)) {
      const { zipOutFiles, downloadBlob } = await import('@/lib/pw/blob');
      const zip = await zipOutFiles(
        results.map((r) => ({ name: r.name, blob: r.blob as Blob })),
        'pagewise_results.zip'
      );
      downloadBlob(zip, 'pagewise_results.zip');
    } else if (jobId) {
      const { zipOutFiles, downloadBlob } = await import('@/lib/pw/blob');
      const blobs: { name: string; blob: Blob }[] = [];
      for (const r of results) {
        const res = await fetch(`/api/pw/jobs/${jobId}/result?file=${encodeURIComponent(r.name)}`);
        if (!res.ok) {
          setError('A result file is no longer available on the server.');
          return;
        }
        blobs.push({ name: r.name, blob: await res.blob() });
      }
      downloadBlob(await zipOutFiles(blobs, 'pagewise_results.zip'), 'pagewise_results.zip');
    }
  };

  const canRun = files.length >= minFiles && !running && !isEditor && tool.engine !== 'ai';

  const visibleOptions = useMemo(
    () => tool.options.filter((o) => !o.showIf || o.showIf(opts)),
    [tool.options, opts]
  );

  // ------------------------------------------------------------- render --

  return (
    <section aria-label={`${tool.name} tool`} className="space-y-5">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack} className="-ms-2 text-primary">
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
          All tools
        </Button>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="pw-serif text-2xl font-bold">{tool.name}</h1>
          <span
            className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
              tool.engine === 'client'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : tool.engine === 'ai'
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
            }`}
          >
            {tool.engine === 'client' ? 'In-browser' : tool.engine === 'ai' ? 'AI' : 'Server'}
          </span>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{tool.description}</p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          {tool.privacy === 'local' ? (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
              {PRIVACY_TEXT.local}
            </>
          ) : tool.privacy === 'text-only' ? (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
              {PRIVACY_TEXT['text-only']}
            </>
          ) : (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
              {PRIVACY_TEXT.server}
            </>
          )}
        </p>
        {tool.note ? <p className="mt-1 text-xs italic text-muted-foreground">{tool.note}</p> : null}
      </div>

      <Alert className="border-border bg-card">
        <AlertTriangle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <AlertTitle className="text-sm font-semibold">Get started</AlertTitle>
        <AlertDescription className="text-sm text-muted-foreground">
          {tool.custom === 'scan'
            ? 'Capture pages with your camera or add photos below, then build the PDF.'
            : tool.custom === 'compare'
              ? 'Add exactly two PDFs — the original and the changed version.'
              : `Drop ${tool.multi ? 'files' : 'a file'} here or click to choose. ${tool.multi ? 'You can reorder them before running.' : ''}`}
        </AlertDescription>
      </Alert>

      {tool.custom !== 'scan' ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            addFiles(e.dataTransfer.files);
          }}
          className="cursor-pointer rounded-xl border-2 border-dashed border-border bg-card px-6 py-8 text-center text-sm text-muted-foreground transition hover:border-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={`Choose ${tool.multi ? 'files' : 'file'} for ${tool.name}`}
        >
          <FileDown className="mx-auto mb-2 h-6 w-6 text-primary" aria-hidden="true" />
          Drop {tool.multi ? 'files' : 'a file'} here, or click to browse
          <span className="mt-1 block text-xs">
            {tool.accept.includes('pdf') ? 'PDF documents' : tool.accept.includes('image/') ? 'JPG, PNG, WebP, GIF, BMP' : 'See accepted formats'} · up to{' '}
            {tool.maxFiles ?? (tool.multi ? 20 : 1)} file{(tool.maxFiles ?? (tool.multi ? 20 : 1)) > 1 ? 's' : ''}
          </span>
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept={tool.accept}
        multiple={tool.multi}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = '';
        }}
        aria-hidden="true"
        tabIndex={-1}
      />

      {files.length > 0 ? (
        <ul className="space-y-2" aria-label="Selected files">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              draggable
              onDragStart={() => (dragIndex.current = i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex.current !== null && dragIndex.current !== i) moveFile(dragIndex.current, i);
                dragIndex.current = null;
              }}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-secondary text-xs font-semibold text-secondary-foreground" aria-hidden="true">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm" title={f.name}>
                {f.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.size)}</span>
              {tool.multi ? (
                <span className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveFile(i, i - 1)} disabled={i === 0} aria-label={`Move ${f.name} up`}>
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveFile(i, i + 1)} disabled={i === files.length - 1} aria-label={`Move ${f.name} down`}>
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </span>
              ) : null}
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeFile(i)} aria-label={`Remove ${f.name}`}>
                <X className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {visibleOptions.length > 0 && !isEditor ? (
        <div className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleOptions.map((o) => (
            <OptionField key={o.key} option={o} value={opts[o.key]} onChange={(v) => setOpts((prev) => ({ ...prev, [o.key]: v }))} />
          ))}
        </div>
      ) : null}

      {Editor ? (
        <Editor
          files={files}
          opts={opts}
          onProgress={onProgress}
          onDone={onDone}
          onError={onError}
        />
      ) : null}

      {tool.engine === 'ai' ? (
        <AiRunner tool={tool} files={files} opts={opts} onProgress={onProgress} onDone={onDone} onError={onError} />
      ) : null}

      {!isEditor && tool.engine !== 'ai' ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" onClick={tool.engine === 'client' ? runClient : runServer} disabled={!canRun}>
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Working…
              </>
            ) : (
              tool.name
            )}
          </Button>
          <span className="text-xs text-muted-foreground">
            {files.length < minFiles ? `Add at least ${minFiles} file${minFiles > 1 ? 's' : ''} to start` : `${files.length} file${files.length > 1 ? 's' : ''} ready`}
          </span>
        </div>
      ) : null}

      {running && progress.message ? (
        <div className="space-y-1.5" aria-live="polite">
          <p className="text-sm text-muted-foreground">{progress.message}</p>
          {progress.pct != null ? <Progress value={progress.pct} aria-label={`Progress: ${progress.pct}%`} /> : null}
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle className="text-sm">Something went wrong</AlertTitle>
          <AlertDescription className="text-sm">{error}</AlertDescription>
        </Alert>
      ) : null}

      {results.length > 0 ? (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4" aria-live="polite">
          <div className="flex items-center justify-between gap-2">
            <h2 className="pw-serif text-lg font-bold">Result{results.length > 1 ? 's' : ''}</h2>
            {results.length > 1 ? (
              <Button variant="outline" size="sm" onClick={downloadAll}>
                <Package className="h-4 w-4" aria-hidden="true" />
                Download all (.zip)
              </Button>
            ) : null}
          </div>
          {resultsInfo ? <p className="text-sm text-muted-foreground">{resultsInfo}</p> : null}
          <ul className="space-y-2">
            {results.map((r) => (
              <li key={r.name} className="flex items-center gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={r.name}>
                  {sanitizeFileName(r.name)}
                </span>
                {r.info ? <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{r.info}</span> : null}
                <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(r.size)}</span>
                {r.blob ? (
                  <Button size="sm" onClick={() => void import('@/lib/pw/blob').then(({ downloadBlob }) => downloadBlob(r.blob as Blob, r.name))}>
                    <Download className="h-4 w-4" aria-hidden="true" />
                    Download
                  </Button>
                ) : jobId ? (
                  <Button size="sm" asChild>
                    <a href={`/api/pw/jobs/${jobId}/result?file=${encodeURIComponent(r.name)}`} download={r.name}>
                      <Download className="h-4 w-4" aria-hidden="true" />
                      Download
                    </a>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setResults([]);
              setResultsInfo(null);
              setError(null);
            }}
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Clear results
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function OptionField({
  option,
  value,
  onChange,
}: {
  option: ToolOption;
  value: OptionValues[string] | undefined;
  onChange: (v: string | number | boolean) => void;
}) {
  const id = `opt-${option.key}`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {option.label}
      </Label>
      {'type' in option && option.type === 'select' ? (
        <Select value={String(value ?? option.default)} onValueChange={(v) => onChange(v)}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {option.choices.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {'type' in option && (option.type === 'number' || option.type === 'pages') ? (
        <Input
          id={id}
          type={option.type === 'number' ? 'number' : 'text'}
          inputMode={option.type === 'number' ? 'numeric' : undefined}
          min={'min' in option ? option.min : undefined}
          max={'max' in option ? option.max : undefined}
          value={String(value ?? '')}
          onChange={(e) => onChange(option.type === 'number' ? Number(e.target.value) : e.target.value)}
          placeholder={'placeholder' in option ? option.placeholder : undefined}
        />
      ) : null}
      {'type' in option && option.type === 'text' ? (
        option.multiline ? (
          <Textarea id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={'placeholder' in option ? option.placeholder : undefined} rows={3} />
        ) : (
          <Input id={id} type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={'placeholder' in option ? option.placeholder : undefined} />
        )
      ) : null}
      {'type' in option && option.type === 'slider' ? (
        <div className="flex items-center gap-3 pt-1.5">
          <Slider
            id={id}
            min={option.min}
            max={option.max}
            step={option.step ?? 1}
            value={[Number(value ?? option.default)]}
            onValueChange={(v) => onChange(v[0])}
          />
          <span className="w-12 shrink-0 text-end text-xs tabular-nums text-muted-foreground">{Number(value ?? option.default)}</span>
        </div>
      ) : null}
      {'type' in option && option.type === 'checkbox' ? (
        <div className="pt-1.5">
          <Switch id={id} checked={Boolean(value)} onCheckedChange={(v) => onChange(v)} />
        </div>
      ) : null}
      {'type' in option && option.type === 'color' ? (
        <input
          id={id}
          type="color"
          value={String(value ?? option.default)}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-14 cursor-pointer rounded-md border border-input bg-background p-1"
          aria-label={option.label}
        />
      ) : null}
      {option.help ? <p className="text-[11px] text-muted-foreground">{option.help}</p> : null}
    </div>
  );
}
