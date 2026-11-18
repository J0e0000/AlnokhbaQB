'use client'

// Crop editor: draw a crop box over a live page preview, choose scope and
// mode, then apply it with pdf-lib. Boxes are stored in preview (canvas)
// pixels and converted to PDF points via widthPt / canvasWidth.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { EditorProps } from '@/lib/pw/types'
import { openPdfFile, renderPage, friendlyPdfError } from '@/lib/pw/pdfjs'
import { applyCrop } from '@/lib/pw/client/crop'
import { parsePageRanges } from '@/lib/pw/range'

type PdfDoc = Awaited<ReturnType<typeof openPdfFile>>

interface BoxPx {
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
const MIN_BOX = 6 // px — anything smaller counts as a stray click

export function CropEditor({ files, onProgress, onDone, onError }: EditorProps) {
  const pdfRef = useRef<PdfDoc | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<{
    mode: 'draw' | 'move' | 'resize'
    startClient: { x: number; y: number }
    startPt: { x: number; y: number }
    orig: BoxPx
  } | null>(null)

  const [numPages, setNumPages] = useState(0)
  const [pageNo, setPageNo] = useState(1)
  const [dims, setDims] = useState<PageDims | null>(null)
  const [box, setBox] = useState<BoxPx | null>(null)
  const [rendering, setRendering] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<'crop' | 'media'>('crop')
  const [scope, setScope] = useState<'all' | 'current' | 'custom'>('all')
  const [rangeInput, setRangeInput] = useState('')
  const [rangeError, setRangeError] = useState<string | null>(null)
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
        const ctx = vis.getContext('2d')
        ctx?.drawImage(r.canvas, 0, 0)
        setDims({ widthPt: r.widthPt, heightPt: r.heightPt, cw: r.canvas.width, ch: r.canvas.height })
        setBox(null) // selection is per-page — start clean after page switch
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
    const clamped = Math.min(Math.max(1, n), pdf.numPages)
    setPageNo(clamped)
    void drawPage(clamped)
  }

  // ---- pointer geometry helpers -------------------------------------------
  const canvasPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const k = canvas.width / rect.width
    return {
      x: Math.min(Math.max(0, (clientX - rect.left) * k), canvas.width),
      y: Math.min(Math.max(0, (clientY - rect.top) * k), canvas.height),
    }
  }

  const beginDrag = (
    e: React.PointerEvent,
    dragMode: 'draw' | 'move' | 'resize',
    orig: BoxPx
  ) => {
    const p = canvasPoint(e.clientX, e.clientY)
    if (!p) return
    dragRef.current = {
      mode: dragMode,
      startClient: { x: e.clientX, y: e.clientY },
      startPt: p,
      orig,
    }
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      /* pointer capture is best-effort */
    }
  }

  const onOverlayPointerDown = (e: React.PointerEvent) => {
    if (busy || !dims) return
    const p = canvasPoint(e.clientX, e.clientY)
    if (!p) return
    const fresh: BoxPx = { x: p.x, y: p.y, w: 0, h: 0 }
    setBox(fresh)
    beginDrag(e, 'draw', fresh)
  }

  const onOverlayPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || !dims) return
    const p = canvasPoint(e.clientX, e.clientY)
    if (!p) return
    if (drag.mode === 'draw') {
      setBox({
        x: Math.min(drag.startPt.x, p.x),
        y: Math.min(drag.startPt.y, p.y),
        w: Math.abs(p.x - drag.startPt.x),
        h: Math.abs(p.y - drag.startPt.y),
      })
    } else if (drag.mode === 'move') {
      const dx = p.x - drag.startPt.x
      const dy = p.y - drag.startPt.y
      setBox({
        ...drag.orig,
        x: Math.min(Math.max(0, drag.orig.x + dx), dims.cw - drag.orig.w),
        y: Math.min(Math.max(0, drag.orig.y + dy), dims.ch - drag.orig.h),
      })
    } else {
      const dx = p.x - drag.startPt.x
      const dy = p.y - drag.startPt.y
      setBox({
        ...drag.orig,
        w: Math.min(Math.max(MIN_BOX, drag.orig.w + dx), dims.cw - drag.orig.x),
        h: Math.min(Math.max(MIN_BOX, drag.orig.h + dy), dims.ch - drag.orig.y),
      })
    }
  }

  const onOverlayPointerUp = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.mode === 'draw') {
      setBox((b) => (b && (b.w < MIN_BOX || b.h < MIN_BOX) ? null : b))
    }
  }

  // ---- derived values -------------------------------------------------------
  const ptPerPx = dims ? dims.widthPt / dims.cw : 1
  const boxPt = box
    ? { x: box.x * ptPerPx, y: box.y * ptPerPx, w: box.w * ptPerPx, h: box.h * ptPerPx }
    : null

  const validateRange = (): number[] | null => {
    const pdf = pdfRef.current
    if (!pdf) return null
    if (scope === 'all') return Array.from({ length: pdf.numPages }, (_, i) => i)
    if (scope === 'current') return [pageNo - 1]
    try {
      const idx = parsePageRanges(rangeInput, pdf.numPages)
      setRangeError(null)
      return idx
    } catch (err) {
      setRangeError(err instanceof Error ? err.message : 'Invalid page range')
      return null
    }
  }

  const apply = async () => {
    if (!file || !boxPt || busy) return
    const indices = validateRange()
    if (!indices) return
    setBusy(true)
    try {
      onProgress('Applying crop…', 30)
      const out = await applyCrop(file, boxPt, indices, mode)
      onProgress('Done', 100)
      onDone([out])
    } catch (e) {
      onError(friendlyPdfError(e))
    } finally {
      setBusy(false)
    }
  }

  if (!file) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Add a PDF file to crop its pages.</p>
      </div>
    )
  }

  const pct = (v: number, total: number) => `${(v / total) * 100}%`

  return (
    <div className="space-y-4">
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
        <span className="text-sm text-muted-foreground">
          Drag on the page to draw the crop box. Switch pages to preview — the box applies to the
          chosen scope.
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
          aria-hidden={false}
        >
          {box && dims ? (
            <div
              className="absolute border-2 border-primary bg-primary/10"
              style={{
                left: pct(box.x, dims.cw),
                top: pct(box.y, dims.ch),
                width: pct(box.w, dims.cw),
                height: pct(box.h, dims.ch),
              }}
              onPointerDown={(e) => {
                e.stopPropagation()
                beginDrag(e, 'move', box)
              }}
              role="img"
              aria-label="Crop selection"
            >
              <button
                type="button"
                aria-label="Clear selection"
                className="absolute -right-3 -top-3 flex size-6 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm hover:bg-accent"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setBox(null)}
              >
                <X className="size-3.5" aria-hidden />
              </button>
              <div
                className="absolute -bottom-2 -right-2 size-4 cursor-nwse-resize rounded-sm border border-border bg-background shadow-sm"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  beginDrag(e, 'resize', box)
                }}
                aria-label="Resize crop selection"
                role="slider"
                aria-valuenow={Math.round(boxPt?.w ?? 0)}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">
          Selection:{' '}
          {boxPt ? (
            <span className="font-medium text-foreground">
              {Math.round(boxPt.w)} × {Math.round(boxPt.h)} pt at ({Math.round(boxPt.x)},{' '}
              {Math.round(boxPt.y)})
            </span>
          ) : (
            'none'
          )}
        </span>
        {box ? (
          <Button variant="outline" size="sm" onClick={() => setBox(null)} disabled={busy}>
            Clear selection
          </Button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pw-crop-mode">Mode</Label>
          <Select
            value={mode}
            onValueChange={(v) => setMode(v === 'media' ? 'media' : 'crop')}
            disabled={busy}
          >
            <SelectTrigger id="pw-crop-mode" className="w-full">
              <SelectValue placeholder="Crop mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="crop">Crop (visual crop)</SelectItem>
              <SelectItem value="media">Crop + resize media box</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pw-crop-scope">Apply to</Label>
          <Select
            value={scope}
            onValueChange={(v) => {
              const next = v === 'all' || v === 'current' || v === 'custom' ? v : 'all'
              setScope(next)
              if (next !== 'custom') setRangeError(null)
            }}
            disabled={busy}
          >
            <SelectTrigger id="pw-crop-scope" className="w-full">
              <SelectValue placeholder="Scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All pages</SelectItem>
              <SelectItem value="current">Current page only</SelectItem>
              <SelectItem value="custom">Custom range</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {scope === 'custom' ? (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="pw-crop-range">Pages (e.g. 1-3,5)</Label>
            <Input
              id="pw-crop-range"
              value={rangeInput}
              onChange={(e) => {
                setRangeInput(e.target.value)
                setRangeError(null)
              }}
              placeholder="1-3,5"
              disabled={busy}
              inputMode="numeric"
            />
            {rangeError ? <p className="text-sm text-destructive">{rangeError}</p> : null}
          </div>
        ) : null}
      </div>

      <div>
        <Button size="sm" onClick={apply} disabled={busy || !box || rendering}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Apply crop
        </Button>
        {!box ? (
          <span className="ml-3 text-sm text-muted-foreground">Draw a selection box first.</span>
        ) : null}
      </div>
    </div>
  )
}

export default CropEditor
