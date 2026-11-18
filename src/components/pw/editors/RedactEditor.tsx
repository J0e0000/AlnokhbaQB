'use client'

// Redaction editor: draw opaque boxes over sensitive content. Applying
// rasterizes the affected pages and burns the boxes in, so the covered text
// is genuinely removed from the document.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  ShieldX,
  TriangleAlert,
  X,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type { EditorProps } from '@/lib/pw/types'
import { openPdfFile, renderPage, friendlyPdfError } from '@/lib/pw/pdfjs'
import { flattenRedaction } from '@/lib/pw/client/annotate'

type PdfDoc = Awaited<ReturnType<typeof openPdfFile>>

interface BoxPt {
  x: number
  y: number
  w: number
  h: number
}

interface PageDims {
  widthPt: number
  heightPt: number
  cw: number
  ch: number
}

const TARGET_W = 640
const MIN_BOX = 4 // pt

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

export function RedactEditor({ files, onProgress, onDone, onError }: EditorProps) {
  const pdfRef = useRef<PdfDoc | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<{ startPt: { x: number; y: number } } | null>(null)

  const [numPages, setNumPages] = useState(0)
  const [pageNo, setPageNo] = useState(1)
  const [dims, setDims] = useState<PageDims | null>(null)
  const [boxes, setBoxes] = useState<Record<number, BoxPt[]>>({})
  const [draft, setDraft] = useState<BoxPt | null>(null)
  const [boxColor, setBoxColor] = useState('#000000')
  const [rendering, setRendering] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const file = files[0]

  const drawPage = useCallback(
    async (n: number) => {
      const pdf = pdfRef.current
      const vis = canvasRef.current
      if (!pdf || !vis) return
      setRendering(true)
      try {
        const base = (await pdf.getPage(n)).getViewport({ scale: 1 })
        const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2)
        const r = await renderPage(pdf, n, (TARGET_W / base.width) * dpr)
        vis.width = r.canvas.width
        vis.height = r.canvas.height
        vis.getContext('2d')?.drawImage(r.canvas, 0, 0)
        setDims({ widthPt: r.widthPt, heightPt: r.heightPt, cw: r.canvas.width, ch: r.canvas.height })
      } catch (e) {
        onError(friendlyPdfError(e))
      } finally {
        setRendering(false)
      }
    },
    [onError]
  )

  useEffect(() => {
    if (!file) return
    let cancelled = false
    openPdfFile(file)
      .then((pdf) => {
        if (cancelled) {
          void pdf.cleanup().catch(() => undefined)
          return
        }
        pdfRef.current = pdf
        setNumPages(pdf.numPages)
        void drawPage(1)
      })
      .catch((e: unknown) => setLoadError(friendlyPdfError(e)))
    return () => {
      cancelled = true
      if (pdfRef.current) {
        void pdfRef.current.cleanup().catch(() => undefined)
        pdfRef.current = null
      }
    }
  }, [file, drawPage])

  const gotoPage = (n: number) => {
    const pdf = pdfRef.current
    if (!pdf || busy) return
    const clamped = clamp(n, 1, pdf.numPages)
    setPageNo(clamped)
    void drawPage(clamped)
  }

  const pagePoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    if (!canvas || !dims) return null
    const rect = canvas.getBoundingClientRect()
    return {
      x: clamp(((clientX - rect.left) * dims.widthPt) / rect.width, 0, dims.widthPt),
      y: clamp(((clientY - rect.top) * dims.heightPt) / rect.height, 0, dims.heightPt),
    }
  }

  const onOverlayPointerDown = (e: React.PointerEvent) => {
    if (!dims || busy) return
    const p = pagePoint(e.clientX, e.clientY)
    if (!p) return
    dragRef.current = { startPt: p }
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 })
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      /* best effort */
    }
  }

  const onOverlayPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    const p = pagePoint(e.clientX, e.clientY)
    const start = dragRef.current.startPt
    if (!p) return
    setDraft({
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    })
  }

  const onOverlayPointerUp = () => {
    dragRef.current = null
    if (draft && draft.w >= MIN_BOX && draft.h >= MIN_BOX) {
      const page = pageNo - 1
      setBoxes((prev) => ({ ...prev, [page]: [...(prev[page] ?? []), draft] }))
    }
    setDraft(null)
  }

  const removeBox = (page: number, idx: number) => {
    setBoxes((prev) => ({ ...prev, [page]: (prev[page] ?? []).filter((_, i) => i !== idx) }))
  }

  const totalBoxes = Object.values(boxes).reduce((n, list) => n + list.length, 0)
  const touchedPages = Object.values(boxes).filter((l) => l.length > 0).length

  const applyRedaction = async () => {
    if (!file || busy || totalBoxes === 0) return
    setBusy(true)
    try {
      const outs = await flattenRedaction(file, boxes, { color: boxColor }, { onProgress })
      onProgress('Done', 100)
      onDone(outs)
    } catch (e) {
      onError(friendlyPdfError(e))
    } finally {
      setBusy(false)
    }
  }

  if (!file) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Add a PDF file to redact its content.</p>
      </div>
    )
  }

  const pct = (v: number, total: number) => `${(v / total) * 100}%`
  const currentBoxes = boxes[pageNo - 1] ?? []

  return (
    <div className="space-y-4">
      <Alert variant="destructive">
        <TriangleAlert className="size-4" aria-hidden />
        <AlertTitle>Redaction is permanent</AlertTitle>
        <AlertDescription>
          Redacted pages are flattened to images — the text under boxes is permanently removed.
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous page"
          disabled={!numPages || pageNo <= 1 || rendering || busy}
          onClick={() => gotoPage(pageNo - 1)}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <span className="min-w-24 text-center text-sm text-muted-foreground">
          Page {pageNo}
          {numPages ? ` of ${numPages}` : ''}
        </span>
        <Button
          variant="outline"
          size="icon"
          aria-label="Next page"
          disabled={!numPages || pageNo >= numPages || rendering || busy}
          onClick={() => gotoPage(pageNo + 1)}
        >
          <ChevronRight className="size-4" aria-hidden />
        </Button>
        <div className="flex items-center gap-2">
          <Label htmlFor="pw-redact-color" className="text-sm">
            Box color
          </Label>
          <input
            id="pw-redact-color"
            type="color"
            value={boxColor}
            onChange={(e) => setBoxColor(e.target.value)}
            className="size-8 cursor-pointer rounded border border-border bg-background p-0.5"
            aria-label="Redaction box color"
          />
        </div>
        <span className="text-sm text-muted-foreground">
          {totalBoxes} box{totalBoxes === 1 ? '' : 'es'} on {touchedPages} page
          {touchedPages === 1 ? '' : 's'} — drag on the page to redact
        </span>
      </div>

      {loadError ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {loadError}
        </p>
      ) : null}

      <div className="relative mx-auto w-fit max-w-full" style={{ width: TARGET_W, maxWidth: '100%' }}>
        <canvas
          ref={canvasRef}
          className="block h-auto w-full rounded-md border border-border bg-background"
          aria-label="PDF page preview"
        />
        {rendering ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-md bg-background/60">
            <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : null}
        <div
          className="absolute inset-0 cursor-crosshair touch-none"
          onPointerDown={onOverlayPointerDown}
          onPointerMove={onOverlayPointerMove}
          onPointerUp={onOverlayPointerUp}
          onPointerCancel={onOverlayPointerUp}
        >
          {dims
            ? currentBoxes.map((b, i) => (
                <div
                  key={i}
                  className="absolute"
                  style={{
                    left: pct(b.x, dims.widthPt),
                    top: pct(b.y, dims.heightPt),
                    width: pct(b.w, dims.widthPt),
                    height: pct(b.h, dims.heightPt),
                    backgroundColor: boxColor,
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    aria-label={`Remove redaction box ${i + 1} on page ${pageNo}`}
                    title="Remove box"
                    className="absolute -right-2.5 -top-2.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm hover:bg-accent"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => removeBox(pageNo - 1, i)}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </div>
              ))
            : null}
          {dims && draft ? (
            <div
              className="pointer-events-none absolute bg-destructive/40 outline outline-1 outline-destructive"
              style={{
                left: pct(draft.x, dims.widthPt),
                top: pct(draft.y, dims.heightPt),
                width: pct(draft.w, dims.widthPt),
                height: pct(draft.h, dims.heightPt),
              }}
            />
          ) : null}
        </div>
      </div>

      <div>
        <Button size="sm" onClick={applyRedaction} disabled={busy || totalBoxes === 0}>
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <ShieldX className="size-4" aria-hidden />
          )}
          Apply redaction
        </Button>
        {totalBoxes === 0 ? (
          <span className="ml-3 text-sm text-muted-foreground">
            Draw at least one box to enable redaction.
          </span>
        ) : null}
      </div>
    </div>
  )
}

export default RedactEditor
