'use client'

// Signature editor. Step 1 creates a transparent PNG signature (draw, type
// or upload). Step 2 places it on a live page preview and flattens it into
// the document (optionally on additional pages).

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Eraser,
  Loader2,
  Undo2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { EditorProps } from '@/lib/pw/types'
import { openPdfFile, renderPage, friendlyPdfError } from '@/lib/pw/pdfjs'
import { flattenAnnotations, type Annotation } from '@/lib/pw/client/annotate'
import { parsePageRanges } from '@/lib/pw/range'

type PdfDoc = Awaited<ReturnType<typeof openPdfFile>>

interface PageDims {
  widthPt: number
  heightPt: number
  cw: number
  ch: number
}

const TARGET_W = 640
const SIG_W = 600
const SIG_H = 180
const INK = '#111111'
const CursiveFont = "'Segoe Script', 'Brush Script MT', cursive"

const INK_COLORS = ['#111111', '#c2410c', '#0f766e']

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode the signature image'))
    img.src = src
  })
}

export function SignEditor({ files, onProgress, onDone, onError }: EditorProps) {
  // ---- step 1 state ---------------------------------------------------------
  const [step, setStep] = useState<'sign' | 'place'>('sign')
  const [tab, setTab] = useState<'draw' | 'type' | 'upload'>('draw')
  const sigCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const strokesRef = useRef<{ x: number; y: number }[][]>([])
  const drawingRef = useRef(false)
  const [hasDrawInk, setHasDrawInk] = useState(false)
  const [textVal, setTextVal] = useState('')
  const [inkColor, setInkColor] = useState(INK)
  const [uploadUrl, setUploadUrl] = useState<string | null>(null)
  const [sig, setSig] = useState<{ url: string; w: number; h: number } | null>(null)

  // ---- step 2 state ---------------------------------------------------------
  const pdfRef = useRef<PdfDoc | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [pageNo, setPageNo] = useState(1)
  const [dims, setDims] = useState<PageDims | null>(null)
  const [rendering, setRendering] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [dispW, setDispW] = useState(160)
  const [opacity, setOpacity] = useState(100)
  const [extraPages, setExtraPages] = useState('')
  const [rangeError, setRangeError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dragSigRef = useRef<{ startClient: { x: number; y: number }; startPos: { x: number; y: number } } | null>(null)

  const file = files[0]

  const hasInk =
    tab === 'draw' ? hasDrawInk : tab === 'type' ? textVal.trim().length > 0 : !!uploadUrl

  // ---- signature canvas rendering ------------------------------------------
  const strokePath = (ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]) => {
    if (pts.length === 0) return
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    if (pts.length === 1) {
      ctx.lineTo(pts[0].x + 0.1, pts[0].y + 0.1)
    }
    for (let i = 1; i < pts.length - 1; i++) {
      const midX = (pts[i].x + pts[i + 1].x) / 2
      const midY = (pts[i].y + pts[i + 1].y) / 2
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY)
    }
    const last = pts[pts.length - 1]
    ctx.lineTo(last.x, last.y)
    ctx.stroke()
  }

  const redrawSig = useCallback(() => {
    const canvas = sigCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(2, 0, 0, 2, 0, 0)
    ctx.clearRect(0, 0, SIG_W, SIG_H)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (tab === 'draw') {
      ctx.lineWidth = 2.5
      ctx.strokeStyle = INK
      for (const s of strokesRef.current) strokePath(ctx, s)
    } else if (tab === 'type') {
      const t = textVal.trim()
      if (!t) return
      let fontSize = 34
      ctx.font = `${fontSize}px ${CursiveFont}`
      const measured = ctx.measureText(t).width
      if (measured > SIG_W - 24) {
        fontSize = Math.max(14, Math.floor(fontSize * ((SIG_W - 24) / measured)))
        ctx.font = `${fontSize}px ${CursiveFont}`
      }
      ctx.fillStyle = inkColor
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(t, SIG_W / 2, SIG_H / 2)
    } else if (tab === 'upload' && uploadUrl) {
      void loadImage(uploadUrl).then((img) => {
        const c = sigCanvasRef.current
        const cctx = c?.getContext('2d')
        if (!c || !cctx) return
        cctx.setTransform(2, 0, 0, 2, 0, 0)
        cctx.clearRect(0, 0, SIG_W, SIG_H)
        const scale = Math.min((SIG_W - 12) / img.naturalWidth, (SIG_H - 12) / img.naturalHeight)
        const w = img.naturalWidth * scale
        const h = img.naturalHeight * scale
        cctx.drawImage(img, (SIG_W - w) / 2, (SIG_H - h) / 2, w, h)
      })
    }
  }, [tab, textVal, inkColor, uploadUrl])

  useEffect(() => {
    redrawSig()
  }, [redrawSig])

  const sigPoint = (e: React.PointerEvent): { x: number; y: number } => {
    const canvas = sigCanvasRef.current
    const rect = canvas!.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) * SIG_W) / rect.width,
      y: ((e.clientY - rect.top) * SIG_H) / rect.height,
    }
  }

  const onSigPointerDown = (e: React.PointerEvent) => {
    if (tab !== 'draw') return
    drawingRef.current = true
    strokesRef.current.push([sigPoint(e)])
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      /* best effort */
    }
  }

  const onSigPointerMove = (e: React.PointerEvent) => {
    if (!drawingRef.current || tab !== 'draw') return
    strokesRef.current[strokesRef.current.length - 1]?.push(sigPoint(e))
    redrawSig()
  }

  const onSigPointerUp = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    if ((strokesRef.current[strokesRef.current.length - 1]?.length ?? 0) > 0) setHasDrawInk(true)
  }

  const undoStroke = () => {
    strokesRef.current.pop()
    redrawSig()
    setHasDrawInk(strokesRef.current.length > 0)
  }

  const clearStrokes = () => {
    strokesRef.current = []
    redrawSig()
    setHasDrawInk(false)
  }

  const onUploadFile = (f: File | undefined) => {
    if (!f) return
    if (!/image\/(png|jpeg)/.test(f.type)) {
      onError('Please choose a PNG or JPEG image for the signature.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setUploadUrl(String(reader.result))
    reader.onerror = () => onError('Could not read the selected image.')
    reader.readAsDataURL(f)
  }

  const continueToPlace = async () => {
    const canvas = sigCanvasRef.current
    if (!canvas || !hasInk) return
    try {
      const url = canvas.toDataURL('image/png')
      const img = await loadImage(url)
      setSig({ url, w: img.naturalWidth, h: img.naturalHeight })
      setPos(null)
      setStep('place')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not prepare the signature.')
    }
  }

  // ---- page preview (step 2) ------------------------------------------------
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
    if (step !== 'place' || !file || pdfRef.current) return
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
  }, [step, file, drawPage])

  const gotoPage = (n: number) => {
    const pdf = pdfRef.current
    if (!pdf || busy) return
    const clamped = clamp(n, 1, pdf.numPages)
    setPageNo(clamped)
    void drawPage(clamped)
  }

  // Derived signature geometry in page points (top-left origin).
  const ptPerCssPx = dims ? dims.widthPt / TARGET_W : 1
  const wPt = sig ? dispW * ptPerCssPx : 0
  const hPt = sig ? wPt * (sig.h / sig.w) : 0

  useEffect(() => {
    if (sig && dims && !pos) {
      setPos({
        x: Math.max(0, dims.widthPt / 2 - (dispW * (dims.widthPt / TARGET_W)) / 2),
        y: dims.heightPt * 0.18,
      })
    }
  }, [sig, dims, pos, dispW])

  const onSigDragStart = (e: React.PointerEvent) => {
    if (!pos || busy) return
    dragSigRef.current = { startClient: { x: e.clientX, y: e.clientY }, startPos: pos }
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      /* best effort */
    }
  }

  const onSigDragMove = (e: React.PointerEvent) => {
    const drag = dragSigRef.current
    const canvas = canvasRef.current
    if (!drag || !canvas || !dims) return
    const rect = canvas.getBoundingClientRect()
    const k = dims.widthPt / rect.width
    setPos({
      x: clamp(drag.startPos.x + (e.clientX - drag.startClient.x) * k, 0, Math.max(0, dims.widthPt - wPt)),
      y: clamp(drag.startPos.y + (e.clientY - drag.startClient.y) * k, 0, Math.max(0, dims.heightPt - hPt)),
    })
  }

  // ---- apply ------------------------------------------------------------------
  const applySignature = async () => {
    if (!file || !sig || !pos || busy || !dims) return
    setBusy(true)
    try {
      let targets: number[] = [pageNo - 1]
      const extra = extraPages.trim()
      if (extra) {
        const parsed = parsePageRanges(extra, numPages)
        targets = [pageNo - 1, ...parsed.filter((p) => p !== pageNo - 1)]
      }
      setRangeError(null)

      // Bake the chosen opacity into the PNG so it survives flattening.
      let url = sig.url
      if (opacity < 100) {
        const img = await loadImage(sig.url)
        const c = document.createElement('canvas')
        c.width = sig.w
        c.height = sig.h
        const ctx = c.getContext('2d')
        if (!ctx) throw new Error('Canvas is not supported in this browser')
        ctx.globalAlpha = opacity / 100
        ctx.drawImage(img, 0, 0)
        url = c.toDataURL('image/png')
      }

      const anns: Annotation[] = targets.map((page) => ({
        kind: 'image',
        page,
        x: pos.x,
        y: pos.y,
        w: wPt,
        h: hPt,
        dataUrl: url,
      }))
      onProgress('Flattening signature…', 20)
      const outs = await flattenAnnotations(file, anns, [], { onProgress })
      onProgress('Done', 100)
      onDone(outs, `Signature applied to ${targets.length} page${targets.length === 1 ? '' : 's'}`)
    } catch (e) {
      if (e instanceof Error && /page range|Bad page/i.test(e.message)) {
        setRangeError(e.message)
      } else {
        onError(friendlyPdfError(e))
      }
    } finally {
      setBusy(false)
    }
  }

  if (!file) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Add a PDF file to sign it.</p>
      </div>
    )
  }

  const pct = (v: number, total: number) => `${(v / total) * 100}%`

  return (
    <div className="space-y-4">
      {step === 'sign' ? (
        <>
          <Tabs value={tab} onValueChange={(v) => setTab(v === 'type' || v === 'upload' ? v : 'draw')}>
            <TabsList>
              <TabsTrigger value="draw">Draw</TabsTrigger>
              <TabsTrigger value="type">Type</TabsTrigger>
              <TabsTrigger value="upload">Upload</TabsTrigger>
            </TabsList>

            <TabsContent value="draw" className="space-y-3">
              <div className="max-w-full overflow-x-auto pw-scroll">
                <canvas
                  ref={sigCanvasRef}
                  width={SIG_W * 2}
                  height={SIG_H * 2}
                  style={{ width: SIG_W, height: SIG_H }}
                  className="block max-w-full touch-none rounded-md border border-border bg-[repeating-linear-gradient(45deg,transparent,transparent_8px,rgba(0,0,0,0.03)_8px,rgba(0,0,0,0.03)_16px)]"
                  onPointerDown={onSigPointerDown}
                  onPointerMove={onSigPointerMove}
                  onPointerUp={onSigPointerUp}
                  onPointerCancel={onSigPointerUp}
                  aria-label="Signature drawing area"
                />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={undoStroke} disabled={!hasDrawInk}>
                  <Undo2 className="size-4" aria-hidden />
                  Undo
                </Button>
                <Button variant="outline" size="sm" onClick={clearStrokes} disabled={!hasDrawInk}>
                  <Eraser className="size-4" aria-hidden />
                  Clear
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="type" className="space-y-3">
              <div className="max-w-full overflow-x-auto pw-scroll">
                <canvas
                  ref={sigCanvasRef}
                  width={SIG_W * 2}
                  height={SIG_H * 2}
                  style={{ width: SIG_W, height: SIG_H }}
                  className="block max-w-full rounded-md border border-border bg-background"
                  aria-label="Signature preview"
                />
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pw-sig-text">Signature text</Label>
                  <Input
                    id="pw-sig-text"
                    value={textVal}
                    onChange={(e) => setTextVal(e.target.value)}
                    placeholder="Your name"
                    className="w-56"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Ink color</Label>
                  <div className="flex gap-2" role="radiogroup" aria-label="Ink color">
                    {INK_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={inkColor === c}
                        aria-label={`Ink color ${c}`}
                        onClick={() => setInkColor(c)}
                        className={`size-7 rounded-full border-2 ${
                          inkColor === c ? 'border-foreground' : 'border-border'
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="upload" className="space-y-3">
              <div className="max-w-full overflow-x-auto pw-scroll">
                <canvas
                  ref={sigCanvasRef}
                  width={SIG_W * 2}
                  height={SIG_H * 2}
                  style={{ width: SIG_W, height: SIG_H }}
                  className="block max-w-full rounded-md border border-border bg-[linear-gradient(45deg,rgba(0,0,0,0.04)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.04)_75%),linear-gradient(45deg,rgba(0,0,0,0.04)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.04)_75%)] bg-[length:16px_16px] bg-[position:0_0,8px_8px]"
                  aria-label="Signature preview"
                />
              </div>
              <div>
                <Label htmlFor="pw-sig-file" className="mb-1.5 block">
                  Signature image (PNG or JPEG)
                </Label>
                <Input
                  id="pw-sig-file"
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(e) => onUploadFile(e.target.files?.[0])}
                  className="max-w-sm"
                />
              </div>
            </TabsContent>
          </Tabs>

          <div className="flex gap-2">
            <Button size="sm" onClick={continueToPlace} disabled={!hasInk}>
              Continue to placement
            </Button>
          </div>
        </>
      ) : null}

      {step === 'place' && sig ? (
        <>
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
            <Button variant="ghost" size="sm" onClick={() => setStep('sign')} disabled={busy}>
              Back to signature
            </Button>
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
            {pos && dims ? (
              <div
                role="button"
                tabIndex={0}
                aria-label="Signature placement — drag to move"
                className="absolute cursor-move touch-none select-none"
                style={{
                  left: pct(pos.x, dims.widthPt),
                  top: pct(pos.y, dims.heightPt),
                  width: pct(dispW, TARGET_W),
                  opacity: opacity / 100,
                }}
                onPointerDown={onSigDragStart}
                onPointerMove={onSigDragMove}
                onPointerUp={() => {
                  dragSigRef.current = null
                }}
                onPointerCancel={() => {
                  dragSigRef.current = null
                }}
              >
                { }
                <img
                  src={sig.url}
                  alt="Your signature"
                  className="pointer-events-none block w-full drop-shadow-sm"
                  draggable={false}
                />
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pw-sig-width">Signature width ({dispW} px)</Label>
              <Slider
                id="pw-sig-width"
                min={60}
                max={320}
                step={2}
                value={[dispW]}
                onValueChange={(v) => setDispW(v[0] ?? 160)}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-sig-opacity">Opacity ({opacity}%)</Label>
              <Slider
                id="pw-sig-opacity"
                min={20}
                max={100}
                step={5}
                value={[opacity]}
                onValueChange={(v) => setOpacity(v[0] ?? 100)}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pw-sig-pages">Also apply to pages (optional, e.g. 1-3,5)</Label>
              <Input
                id="pw-sig-pages"
                value={extraPages}
                onChange={(e) => {
                  setExtraPages(e.target.value)
                  setRangeError(null)
                }}
                placeholder="Leave empty for the current page only"
                disabled={busy}
                inputMode="numeric"
              />
              {rangeError ? <p className="text-sm text-destructive">{rangeError}</p> : null}
            </div>
          </div>

          <div>
            <Button size="sm" onClick={applySignature} disabled={busy || rendering || !pos}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Apply signature
            </Button>
            <span className="ml-3 text-sm text-muted-foreground">
              Drag the signature on the page to position it.
            </span>
          </div>
        </>
      ) : null}
    </div>
  )
}

export default SignEditor
