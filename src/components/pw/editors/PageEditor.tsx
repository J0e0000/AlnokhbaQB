'use client'

// Page editor: place text, rectangles, images and freehand ink on page
// previews. Everything is stored as Annotation objects (points, top-left
// origin) and flattened with pdf-lib on apply.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Eraser,
  Image as ImageIcon,
  Loader2,
  MousePointer2,
  PaintBucket,
  Pencil,
  Square,
  Trash2,
  Type as TypeIcon,
  Undo2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import type { EditorProps } from '@/lib/pw/types'
import { openPdfFile, renderPage, friendlyPdfError } from '@/lib/pw/pdfjs'
import { flattenAnnotations, type Annotation } from '@/lib/pw/client/annotate'

type PdfDoc = Awaited<ReturnType<typeof openPdfFile>>

type Ann = Annotation & { id: number }

type Tool = 'select' | 'text' | 'rect-fill' | 'rect-outline' | 'image' | 'freehand'

interface PageDims {
  widthPt: number
  heightPt: number
  cw: number
  ch: number
}

interface Pt {
  x: number
  y: number
}

interface Stroke {
  pts: Pt[]
  color: string
  width: number
}

const TARGET_W = 700
const MIN_SHAPE = 4 // pt

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

function strokePath(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  if (pts.length === 0) return
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  if (pts.length === 1) ctx.lineTo(pts[0].x + 0.1, pts[0].y + 0.1)
  for (let i = 1; i < pts.length - 1; i++) {
    const midX = (pts[i].x + pts[i + 1].x) / 2
    const midY = (pts[i].y + pts[i + 1].y) / 2
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY)
  }
  const last = pts[pts.length - 1]
  ctx.lineTo(last.x, last.y)
  ctx.stroke()
}

export function PageEditor({ files, onProgress, onDone, onError }: EditorProps) {
  const pdfRef = useRef<PdfDoc | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const imgCacheRef = useRef(new Map<string, HTMLImageElement>())
  const pageDimsRef = useRef<Record<number, { widthPt: number; heightPt: number }>>({})
  const strokesRef = useRef<Record<number, Stroke[]>>({})
  const layerIdRef = useRef<Record<number, number>>({})
  const idRef = useRef(1)
  const dragRef = useRef<
    | {
        mode: 'move' | 'resize' | 'rect' | 'draw'
        startPt: Pt
        orig: { x: number; y: number; w: number; h: number }
      }
    | null
  >(null)
  const liveStrokeRef = useRef<Pt[] | null>(null)
  const draftRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const pendingTextRef = useRef<{ x: number; y: number; value: string } | null>(null)

  const [tool, setTool] = useState<Tool>('select')
  const [color, setColor] = useState('#111111')
  const [textSize, setTextSize] = useState(18)
  const [shapeOpacity, setShapeOpacity] = useState(60)
  const [strokeWidth, setStrokeWidth] = useState(2.5)
  const [anns, setAnns] = useState<Ann[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [pendingText, setPendingText] = useState<{ x: number; y: number; value: string } | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [pageNo, setPageNo] = useState(1)
  const [dims, setDims] = useState<PageDims | null>(null)
  const [rendering, setRendering] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const file = files[0]

  // ---- page rendering ---------------------------------------------------------
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
        const ov = overlayRef.current
        if (ov) {
          ov.width = r.canvas.width
          ov.height = r.canvas.height
        }
        pageDimsRef.current[n - 1] = { widthPt: r.widthPt, heightPt: r.heightPt }
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
    setSelectedId(null)
    void drawPage(clamped)
  }

  // ---- overlay painting ---------------------------------------------------------
  const forceImageLoad = (url: string, onLoad: () => void) => {
    const cache = imgCacheRef.current
    const existing = cache.get(url)
    if (existing) return existing
    const img = new Image()
    img.onload = onLoad
    img.src = url
    cache.set(url, img)
    return img
  }

  const drawOverlay = useCallback(() => {
    const ov = overlayRef.current
    if (!ov || !dims) return
    const ctx = ov.getContext('2d')
    if (!ctx) return
    const s = ov.width / dims.widthPt
    ctx.clearRect(0, 0, ov.width, ov.height)
    ctx.textBaseline = 'top'

    for (const a of anns) {
      if (a.page !== pageNo - 1) continue
      if (a.kind === 'text') {
        ctx.font = `${a.size * s}px sans-serif`
        ctx.fillStyle = a.color
        ctx.fillText(a.text, a.x * s, a.y * s)
      } else if (a.kind === 'rect') {
        ctx.save()
        ctx.globalAlpha = a.stroke ? 1 : a.opacity
        if (a.stroke) {
          ctx.strokeStyle = a.color
          ctx.lineWidth = Math.max(1, 2 * s)
          ctx.strokeRect(a.x * s, a.y * s, a.w * s, a.h * s)
        } else {
          ctx.fillStyle = a.color
          ctx.fillRect(a.x * s, a.y * s, a.w * s, a.h * s)
        }
        ctx.restore()
      } else {
        const img = imgCacheRef.current.get(a.dataUrl)
        if (img && img.complete) {
          ctx.drawImage(img, a.x * s, a.y * s, a.w * s, a.h * s)
        } else {
          forceImageLoad(a.dataUrl, () => drawOverlay())
        }
      }
    }

    // live freehand stroke
    if (liveStrokeRef.current) {
      ctx.save()
      ctx.strokeStyle = color
      ctx.lineWidth = strokeWidth
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      strokePath(ctx, liveStrokeRef.current)
      ctx.restore()
    }

    // draft rectangle
    if (draftRectRef.current) {
      const d = draftRectRef.current
      ctx.save()
      ctx.globalAlpha = shapeOpacity / 100
      if (tool === 'rect-outline') {
        ctx.strokeStyle = color
        ctx.lineWidth = Math.max(1, 2 * s)
        ctx.strokeRect(d.x * s, d.y * s, d.w * s, d.h * s)
      } else {
        ctx.fillStyle = color
        ctx.fillRect(d.x * s, d.y * s, d.w * s, d.h * s)
      }
      ctx.restore()
    }

    // selection outline
    const sel = anns.find((a) => a.id === selectedId)
    if (sel && sel.page === pageNo - 1) {
      ctx.save()
      ctx.strokeStyle = '#c2410c'
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1.5
      ctx.strokeRect(sel.x * s - 2, sel.y * s - 2, sel.w * s + 4, sel.h * s + 4)
      ctx.restore()
    }
  }, [anns, pageNo, dims, selectedId, color, strokeWidth, shapeOpacity, tool])

  useEffect(() => {
    drawOverlay()
  }, [drawOverlay, rendering])

  // ---- geometry helpers ---------------------------------------------------------
  const pagePoint = (clientX: number, clientY: number): Pt | null => {
    const canvas = canvasRef.current
    if (!canvas || !dims) return null
    const rect = canvas.getBoundingClientRect()
    return {
      x: clamp(((clientX - rect.left) * dims.widthPt) / rect.width, 0, dims.widthPt),
      y: clamp(((clientY - rect.top) * dims.heightPt) / rect.height, 0, dims.heightPt),
    }
  }

  const isLayerAnn = (a: Ann) =>
    a.kind === 'image' &&
    a.x === 0 &&
    a.y === 0 &&
    !!dims &&
    a.w >= dims.widthPt - 1 &&
    a.h >= dims.heightPt - 1

  const capture = (e: React.PointerEvent) => {
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      /* best effort */
    }
  }

  // ---- freehand layer rasterization -----------------------------------------------
  const rasterizeLayer = (page: number): string | null => {
    const d = pageDimsRef.current[page]
    const strokes = strokesRef.current[page] ?? []
    if (!d) return null
    const S = 2
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(d.widthPt * S))
    c.height = Math.max(1, Math.round(d.heightPt * S))
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.scale(S, S)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const st of strokes) {
      ctx.strokeStyle = st.color
      ctx.lineWidth = st.width
      strokePath(ctx, st.pts)
    }
    return c.toDataURL('image/png')
  }

  const upsertLayer = (page: number) => {
    const dataUrl = rasterizeLayer(page)
    if (!dataUrl) return
    const d = pageDimsRef.current[page]
    if (!d) return
    const existingId = layerIdRef.current[page]
    setAnns((prev) => {
      if (existingId) {
        return prev.map((a) =>
          a.id === existingId && a.kind === 'image' ? { ...a, dataUrl } : a
        )
      }
      const id = ++idRef.current
      layerIdRef.current[page] = id
      return [
        ...prev,
        { kind: 'image', id, page, x: 0, y: 0, w: d.widthPt, h: d.heightPt, dataUrl },
      ]
    })
  }

  // ---- pointer interaction ---------------------------------------------------------
  const onOverlayPointerDown = (e: React.PointerEvent) => {
    if (!dims || rendering) return
    const p = pagePoint(e.clientX, e.clientY)
    if (!p) return

    if (tool === 'freehand') {
      liveStrokeRef.current = [p]
      dragRef.current = { mode: 'draw', startPt: p, orig: { x: 0, y: 0, w: 0, h: 0 } }
      capture(e)
      return
    }

    if (tool === 'rect-fill' || tool === 'rect-outline') {
      draftRectRef.current = { x: p.x, y: p.y, w: 0, h: 0 }
      dragRef.current = { mode: 'rect', startPt: p, orig: { x: 0, y: 0, w: 0, h: 0 } }
      capture(e)
      return
    }

    if (tool === 'text') {
      if (pendingTextRef.current?.value) commitPendingText()
      pendingTextRef.current = { x: p.x, y: p.y, value: '' }
      setPendingText({ x: p.x, y: p.y, value: '' })
      return
    }

    // select tool — hit test topmost annotation on this page
    const hits = anns.filter((a) => a.page === pageNo - 1 && !isLayerAnn(a))
    for (let i = hits.length - 1; i >= 0; i--) {
      const a = hits[i]
      if (p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h) {
        setSelectedId(a.id)
        dragRef.current = { mode: 'move', startPt: p, orig: { x: a.x, y: a.y, w: a.w, h: a.h } }
        capture(e)
        return
      }
    }
    setSelectedId(null)
  }

  const onOverlayPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    const p = pagePoint(e.clientX, e.clientY)
    if (!p) return

    if (drag?.mode === 'draw') {
      liveStrokeRef.current?.push(p)
      drawOverlay()
      return
    }
    if (drag?.mode === 'rect') {
      const d = draftRectRef.current
      if (d) {
        d.x = Math.min(drag.startPt.x, p.x)
        d.y = Math.min(drag.startPt.y, p.y)
        d.w = Math.abs(p.x - drag.startPt.x)
        d.h = Math.abs(p.y - drag.startPt.y)
        drawOverlay()
      }
      return
    }
    if (!drag) return

    const dx = p.x - drag.startPt.x
    const dy = p.y - drag.startPt.y
    if (drag.mode === 'move') {
      setAnns((prev) =>
        prev.map((a) =>
          a.id === selectedId
            ? {
                ...a,
                x: clamp(drag.orig.x + dx, 0, Math.max(0, (dims?.widthPt ?? 0) - drag.orig.w)),
                y: clamp(drag.orig.y + dy, 0, Math.max(0, (dims?.heightPt ?? 0) - drag.orig.h)),
              }
            : a
        )
      )
    } else if (drag.mode === 'resize' && dims) {
      setAnns((prev) =>
        prev.map((a) =>
          a.id === selectedId
            ? {
                ...a,
                w: clamp(drag.orig.w + dx, MIN_SHAPE, dims.widthPt - a.x),
                h: clamp(drag.orig.h + dy, MIN_SHAPE, dims.heightPt - a.y),
              }
            : a
        )
      )
    }
  }

  const onOverlayPointerUp = () => {
    const drag = dragRef.current
    dragRef.current = null

    if (drag?.mode === 'draw') {
      const pts = liveStrokeRef.current
      liveStrokeRef.current = null
      if (pts && pts.length > 0 && dims) {
        const page = pageNo - 1
        const strokes = strokesRef.current[page] ?? []
        strokes.push({ pts, color, width: strokeWidth })
        strokesRef.current[page] = strokes
        upsertLayer(page)
      } else {
        drawOverlay()
      }
      return
    }

    if (drag?.mode === 'rect') {
      const d = draftRectRef.current
      draftRectRef.current = null
      if (d && dims && d.w >= MIN_SHAPE && d.h >= MIN_SHAPE) {
        setAnns((prev) => [
          ...prev,
          {
            kind: 'rect',
            id: ++idRef.current,
            page: pageNo - 1,
            x: d.x,
            y: d.y,
            w: d.w,
            h: d.h,
            color,
            opacity: shapeOpacity / 100,
            stroke: tool === 'rect-outline',
          },
        ])
      } else {
        drawOverlay()
      }
    }
  }

  // ---- text input ---------------------------------------------------------------
  const commitPendingText = () => {
    const pend = pendingTextRef.current
    pendingTextRef.current = null
    setPendingText(null)
    if (!pend || !pend.value.trim() || !dims) return
    const measure = document.createElement('canvas').getContext('2d')
    let w = 10
    if (measure) {
      measure.font = `${textSize}px sans-serif`
      w = Math.max(4, measure.measureText(pend.value).width)
    }
    setAnns((prev) => [
      ...prev,
      {
        kind: 'text',
        id: ++idRef.current,
        page: pageNo - 1,
        x: pend.x,
        y: pend.y,
        w,
        h: textSize,
        text: pend.value,
        size: textSize,
        color,
      },
    ])
  }

  // ---- image tool ---------------------------------------------------------------
  const onPickImage = (f: File | undefined) => {
    if (!f || !dims) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      const img = new Image()
      img.onload = () => {
        const w = dims.widthPt * 0.5
        const h = w * (img.naturalHeight / Math.max(1, img.naturalWidth))
        const id = ++idRef.current
        imgCacheRef.current.set(url, img)
        setAnns((prev) => [
          ...prev,
          {
            kind: 'image',
            id,
            page: pageNo - 1,
            x: (dims.widthPt - w) / 2,
            y: dims.heightPt * 0.18,
            w,
            h,
            dataUrl: url,
          },
        ])
        setSelectedId(id)
        setTool('select')
      }
      img.onerror = () => onError('Could not decode the selected image.')
      img.src = url
    }
    reader.onerror = () => onError('Could not read the selected image.')
    reader.readAsDataURL(f)
  }

  // ---- undo / clear / delete ------------------------------------------------------
  const undo = () => {
    const page = pageNo - 1
    const idx = [...anns].reverse().findIndex((a) => a.page === page)
    if (idx === -1) return
    const target = [...anns].reverse()[idx]
    if (target.id === layerIdRef.current[page]) {
      strokesRef.current[page]?.pop()
      if ((strokesRef.current[page]?.length ?? 0) === 0) {
        delete layerIdRef.current[page]
      } else {
        upsertLayer(page)
        return
      }
    }
    setAnns((prev) => prev.filter((a) => a.id !== target.id))
    if (selectedId === target.id) setSelectedId(null)
  }

  const clearPage = () => {
    const page = pageNo - 1
    strokesRef.current[page] = []
    delete layerIdRef.current[page]
    setAnns((prev) => prev.filter((a) => a.page !== page))
    setSelectedId(null)
  }

  const deleteSelected = () => {
    if (selectedId === null) return
    const target = anns.find((a) => a.id === selectedId)
    if (target && target.kind === 'image' && target.x === 0 && target.y === 0) {
      const page = target.page
      strokesRef.current[page] = []
      delete layerIdRef.current[page]
    }
    setAnns((prev) => prev.filter((a) => a.id !== selectedId))
    setSelectedId(null)
  }

  // ---- apply ------------------------------------------------------------------
  const applyChanges = async () => {
    if (!file || busy) return
    setBusy(true)
    try {
      onProgress('Flattening annotations…', 15)
      const outs = await flattenAnnotations(
        file,
        anns.map((a) => {
          const { id: _id, ...ann } = a
          return ann
        }),
        [],
        { onProgress }
      )
      const pages = new Set(anns.map((a) => a.page)).size
      onProgress('Done', 100)
      onDone(outs, `${anns.length} annotation${anns.length === 1 ? '' : 's'} on ${pages} page${pages === 1 ? '' : 's'}`)
    } catch (e) {
      onError(friendlyPdfError(e))
    } finally {
      setBusy(false)
    }
  }

  if (!file) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Add a PDF file to edit its pages.</p>
      </div>
    )
  }

  const toolBtn = (t: Tool, label: string, icon: React.ReactNode) => (
    <Button
      key={t}
      variant={tool === t ? 'default' : 'outline'}
      size="sm"
      aria-pressed={tool === t}
      aria-label={label}
      onClick={() => setTool(t)}
      disabled={busy}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  )

  const pageCount = new Set(anns.map((a) => a.page)).size
  const sel = anns.find((a) => a.id === selectedId && a.page === pageNo - 1)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {toolBtn('select', 'Select', <MousePointer2 className="size-4" aria-hidden />)}
        {toolBtn('text', 'Text', <TypeIcon className="size-4" aria-hidden />)}
        {toolBtn('rect-fill', 'Fill', <PaintBucket className="size-4" aria-hidden />)}
        {toolBtn('rect-outline', 'Outline', <Square className="size-4" aria-hidden />)}
        {toolBtn('image', 'Image', <ImageIcon className="size-4" aria-hidden />)}
        {toolBtn('freehand', 'Draw', <Pencil className="size-4" aria-hidden />)}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            onPickImage(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {tool === 'image' ? (
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            Upload image
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="pw-edit-color" className="text-sm">
            Color
          </Label>
          <input
            id="pw-edit-color"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="size-8 cursor-pointer rounded border border-border bg-background p-0.5"
            aria-label="Annotation color"
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="pw-edit-textsize" className="text-sm">
            Text size
          </Label>
          <Input
            id="pw-edit-textsize"
            type="number"
            min={12}
            max={72}
            value={textSize}
            onChange={(e) => setTextSize(clamp(Number(e.target.value) || 12, 12, 72))}
            className="w-20"
            disabled={busy}
          />
        </div>
        <div className="flex min-w-40 flex-1 items-center gap-2">
          <Label htmlFor="pw-edit-opacity" className="whitespace-nowrap text-sm">
            Fill opacity
          </Label>
          <Slider
            id="pw-edit-opacity"
            min={10}
            max={100}
            step={5}
            value={[shapeOpacity]}
            onValueChange={(v) => setShapeOpacity(v[0] ?? 60)}
            disabled={busy}
          />
          <span className="w-10 text-right text-sm text-muted-foreground">{shapeOpacity}%</span>
        </div>
        <div className="flex min-w-40 flex-1 items-center gap-2">
          <Label htmlFor="pw-edit-stroke" className="whitespace-nowrap text-sm">
            Ink width
          </Label>
          <Slider
            id="pw-edit-stroke"
            min={1}
            max={10}
            step={0.5}
            value={[strokeWidth]}
            onValueChange={(v) => setStrokeWidth(v[0] ?? 2.5)}
            disabled={busy}
          />
          <span className="w-8 text-right text-sm text-muted-foreground">{strokeWidth}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={undo} disabled={busy}>
            <Undo2 className="size-4" aria-hidden />
            Undo
          </Button>
          <Button variant="outline" size="sm" onClick={clearPage} disabled={busy}>
            <Eraser className="size-4" aria-hidden />
            Clear page
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={deleteSelected}
            disabled={busy || selectedId === null}
          >
            <Trash2 className="size-4" aria-hidden />
            Delete selected
          </Button>
        </div>
      </div>

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
          {anns.length} annotation{anns.length === 1 ? '' : 's'} on {pageCount} page
          {pageCount === 1 ? '' : 's'}
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
        <canvas
          ref={overlayRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
          aria-hidden
        />
        {rendering ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-md bg-background/60">
            <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : null}
        <div
          className="absolute inset-0 touch-none"
          style={{ cursor: tool === 'select' ? 'default' : 'crosshair' }}
          onPointerDown={onOverlayPointerDown}
          onPointerMove={onOverlayPointerMove}
          onPointerUp={onOverlayPointerUp}
          onPointerCancel={onOverlayPointerUp}
        >
          {sel ? (
            <div
              role="slider"
              aria-label="Resize selected annotation"
              aria-valuenow={Math.round(sel.w)}
              className="absolute -bottom-2 -right-2 size-4 cursor-nwse-resize rounded-sm border border-border bg-background shadow-sm"
              style={{
                left: `calc(${((sel.x + sel.w) / (dims?.widthPt ?? 1)) * 100}% - 8px)`,
                top: `calc(${((sel.y + sel.h) / (dims?.heightPt ?? 1)) * 100}% - 8px)`,
              }}
              onPointerDown={(e) => {
                e.stopPropagation()
                const p = pagePoint(e.clientX, e.clientY)
                if (!p) return
                dragRef.current = { mode: 'resize', startPt: p, orig: { x: sel.x, y: sel.y, w: sel.w, h: sel.h } }
                capture(e)
              }}
            />
          ) : null}
          {pendingText && dims ? (
            <Input
              autoFocus
              value={pendingText.value}
              onChange={(e) => {
                const next = { ...pendingText, value: e.target.value }
                pendingTextRef.current = next
                setPendingText(next)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitPendingText()
                if (e.key === 'Escape') {
                  pendingTextRef.current = null
                  setPendingText(null)
                }
                e.stopPropagation()
              }}
              onBlur={commitPendingText}
              placeholder="Type text, press Enter"
              className="absolute z-10 w-48 text-sm"
              style={{
                left: `${(pendingText.x / dims.widthPt) * 100}%`,
                top: `${(pendingText.y / dims.heightPt) * 100}%`,
              }}
              aria-label="New text annotation"
            />
          ) : null}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {tool === 'select'
          ? 'Click an item to select it, drag to move, use the corner handle to resize.'
          : tool === 'text'
            ? 'Click on the page to place text.'
            : tool === 'freehand'
              ? 'Draw directly on the page with your pointer.'
              : 'Drag on the page to create the shape.'}
      </p>

      <div>
        <Button size="sm" onClick={applyChanges} disabled={busy || anns.length === 0}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Apply changes
        </Button>
      </div>
    </div>
  )
}

export default PageEditor
