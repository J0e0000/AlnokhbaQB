'use client'

// Compare view: word-level diff between exactly two PDFs, shown side by
// side with a downloadable plain-text report.

import { useState } from 'react'
import { FileDiff, Loader2, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import type { EditorProps } from '@/lib/pw/types'
import { diffPdfs, diffReport, type DiffChunk, type PageDiff } from '@/lib/pw/client/compare'
import { friendlyPdfError } from '@/lib/pw/pdfjs'
import { baseName, downloadBlob } from '@/lib/pw/blob'

const ADD_CLASSES = 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
const DEL_CLASSES = 'bg-destructive/10 text-destructive line-through decoration-destructive/40'

function DiffPane({ chunks, side }: { chunks: DiffChunk[]; side: 'left' | 'right' }) {
  const visible = chunks.filter((c) => (side === 'left' ? c.op !== 'add' : c.op !== 'del'))
  if (visible.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing to show on this side.</p>
  }
  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
      {visible.map((c, i) =>
        c.op === 'same' ? (
          <span key={i}>{c.text} </span>
        ) : (
          <span key={i} className={`rounded px-0.5 ${c.op === 'add' ? ADD_CLASSES : DEL_CLASSES}`}>
            {c.text}{' '}
          </span>
        )
      )}
    </div>
  )
}

export function CompareView({ files, onProgress, onDone, onError }: EditorProps) {
  const [result, setResult] = useState<{ pages: PageDiff[]; totalAdd: number; totalDel: number } | null>(null)
  const [summary, setSummary] = useState('')
  const [curPage, setCurPage] = useState(1)
  const [running, setRunning] = useState(false)
  const [ready, setReady] = useState(false)

  const ok = files.length === 2

  const runCompare = async () => {
    if (!ok || running) return
    setRunning(true)
    setResult(null)
    setReady(false)
    try {
      onProgress('Comparing documents…', 5)
      const r = await diffPdfs(files[0], files[1], { onProgress })
      setResult(r)
      const identical = r.totalAdd + r.totalDel === 0
      setSummary(
        identical
          ? 'Documents are identical'
          : `${r.pages.length} pages · +${r.totalAdd} / -${r.totalDel} words changed`
      )
      setCurPage(1)
      setReady(true)
      onProgress('Done', 100)
    } catch (e) {
      onError(friendlyPdfError(e))
    } finally {
      setRunning(false)
    }
  }

  const downloadReport = () => {
    if (!result || !ok) return
    const name = `${baseName(files[0].name)}_${baseName(files[1].name)}_comparison.txt`
    const text = diffReport(files[0].name, files[1].name, result.pages, result.totalAdd, result.totalDel)
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    downloadBlob(blob, name)
    onDone([{ name, blob, info: summary }], summary)
  }

  const current: PageDiff | null = result?.pages[curPage - 1] ?? null

  return (
    <div className="space-y-4">
      {!ok ? (
        <p className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
          This tool compares exactly two PDFs. Please select two files first
          ({files.length} selected).
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void runCompare()} disabled={!ok || running}>
          {running ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <FileDiff className="size-4" aria-hidden />
          )}
          Compare
        </Button>
        {result && ready ? (
          <Button size="sm" variant="outline" onClick={downloadReport}>
            <ScrollText className="size-4" aria-hidden />
            Download report (.txt)
          </Button>
        ) : null}
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {ok ? (
            <>
              A: <span className="font-medium text-foreground">{files[0].name}</span>
              {' · B: '}
              <span className="font-medium text-foreground">{files[1].name}</span>
            </>
          ) : (
            'Waiting for two files'
          )}
        </span>
      </div>

      {result && ready ? (
        <>
          <p className="text-sm font-medium" aria-live="polite">
            {summary}
          </p>
          <Separator />

          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Pages — the dot marks changed pages</p>
            <div className="pw-scroll flex gap-2 overflow-x-auto pb-2">
              {result.pages.map((p) => (
                <Button
                  key={p.page}
                  size="sm"
                  variant={p.page === curPage ? 'default' : 'outline'}
                  className="relative shrink-0"
                  aria-label={`Show page ${p.page}${p.identical ? '' : ` (+${p.additions} / -${p.deletions} words)`}`}
                  aria-pressed={p.page === curPage}
                  onClick={() => setCurPage(p.page)}
                >
                  {p.page}
                  {!p.identical ? (
                    <span
                      className="absolute right-1 top-1 size-1.5 rounded-full bg-destructive"
                      aria-hidden
                    />
                  ) : null}
                </Button>
              ))}
            </div>
          </div>

          {current ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={current.identical ? 'secondary' : 'destructive'}>
                  {current.identical ? 'Page identical' : `+${current.additions} / -${current.deletions} words`}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  Left: {files[0].name} — Right: {files[1].name}
                </span>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-border bg-card p-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Original (A)
                  </p>
                  <ScrollArea className="pw-scroll max-h-96 overflow-y-auto pr-2">
                    <DiffPane chunks={current.left} side="left" />
                  </ScrollArea>
                </div>
                <div className="rounded-lg border border-border bg-card p-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Changed (B)
                  </p>
                  <ScrollArea className="pw-scroll max-h-96 overflow-y-auto pr-2">
                    <DiffPane chunks={current.right} side="right" />
                  </ScrollArea>
                </div>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

export default CompareView
