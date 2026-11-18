'use client'

// Organize editor: visual page grid with drag-and-drop reordering,
// per-page rotation, duplication and removal. Fully client-side via pdf-lib.

import { useCallback, useEffect, useRef, useState } from 'react'
import { PDFDocument, degrees } from 'pdf-lib'
import {
  Copy,
  RotateCcw,
  RotateCw,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Loader2,
  TriangleAlert,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import type { EditorProps, OutFile } from '@/lib/pw/types'
import { makeThumbnails, friendlyPdfError, type Thumb } from '@/lib/pw/pdfjs'
import { loadDoc, saveDoc } from '@/lib/pw/client/organize'
import { baseName } from '@/lib/pw/blob'

interface OrgItem {
  id: string
  srcIndex: number
  rotate: number // user rotation on top of the original, degrees 0/90/180/270
}

const CARD_W = 96
const CARD_H = 144

export function OrganizeGrid({ files, onProgress, onDone, onError }: EditorProps) {
  const [thumbs, setThumbs] = useState<Thumb[] | null>(null)
  const [items, setItems] = useState<OrgItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const idRef = useRef(0)

  const file = files[0]

  // Load thumbnails + build the initial ordered list on mount.
  useEffect(() => {
    if (!file) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    makeThumbnails(file, { pixelWidth: 160 })
      .then(({ thumbs: t, pdf }) => {
        if (cancelled) return
        setThumbs(t)
        idRef.current = t.length
        setItems(t.map((_, i) => ({ id: `p${i + 1}`, srcIndex: i, rotate: 0 })))
        void pdf.cleanup().catch(() => undefined)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setLoadError(friendlyPdfError(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [file])

  const normalize = (deg: number) => ((deg % 360) + 360) % 360

  const rotateItem = (idx: number, delta: number) => {
    setItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, rotate: normalize(it.rotate + delta) } : it))
    )
  }

  const duplicateItem = (idx: number) => {
    setItems((prev) => {
      const copy = { ...prev[idx], id: `p${++idRef.current}` }
      const next = [...prev]
      next.splice(idx + 1, 0, copy)
      return next
    })
  }

  const removeItem = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx))
  }

  const moveItem = (idx: number, dir: -1 | 1) => {
    setItems((prev) => {
      const to = idx + dir
      if (to < 0 || to >= prev.length) return prev
      const next = [...prev]
      const [it] = next.splice(idx, 1)
      next.splice(to, 0, it)
      return next
    })
  }

  const dropOn = (idx: number) => {
    if (dragIdx === null || dragIdx === idx) {
      setDragIdx(null)
      setHoverIdx(null)
      return
    }
    setItems((prev) => {
      const next = [...prev]
      const [moved] = next.splice(dragIdx, 1)
      next.splice(idx, 0, moved)
      return next
    })
    setDragIdx(null)
    setHoverIdx(null)
  }

  const resetOrder = useCallback(() => {
    if (!thumbs) return
    idRef.current = thumbs.length
    setItems(thumbs.map((_, i) => ({ id: `p${i + 1}`, srcIndex: i, rotate: 0 })))
  }, [thumbs])

  const apply = async () => {
    if (!file || items.length === 0 || busy) return
    setBusy(true)
    try {
      onProgress('Opening document…', 5)
      const src = await loadDoc(file)
      const out = await PDFDocument.create()
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        onProgress(`Copying page ${i + 1} of ${items.length}…`, 5 + Math.round((i / items.length) * 85))
        const [copied] = await out.copyPages(src, [item.srcIndex])
        const orig = thumbs?.[item.srcIndex]?.rotation ?? 0
        copied.setRotation(degrees(normalize(orig + item.rotate)))
        out.addPage(copied)
      }
      onProgress('Writing organized document…', 95)
      const result: OutFile = await saveDoc(
        out,
        `${baseName(file.name)}_organized.pdf`,
        `${items.length} pages in new order`
      )
      onProgress('Done', 100)
      onDone([result])
    } catch (e) {
      onError(friendlyPdfError(e))
    } finally {
      setBusy(false)
    }
  }

  if (!file) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Add a PDF file to organize its pages.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={apply} disabled={busy || loading || items.length === 0}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Apply new order
        </Button>
        <Button size="sm" variant="outline" onClick={resetOrder} disabled={busy || !thumbs}>
          Reset
        </Button>
        {thumbs ? (
          <span className="text-sm text-muted-foreground">
            {items.length} page{items.length === 1 ? '' : 's'} — drag cards to reorder, rotate or duplicate below
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-48 w-full rounded-lg" />
          ))}
        </div>
      ) : null}

      {loadError ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{loadError}</span>
        </div>
      ) : null}

      {!loading && !loadError && thumbs ? (
        <div
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
          onDragOver={(e) => e.preventDefault()}
        >
          {items.map((item, idx) => {
            const t = thumbs[item.srcIndex]
            const rot = item.rotate
            const fitScale =
              rot % 180 === 0
                ? Math.min(CARD_W / t.widthPt, CARD_H / t.heightPt)
                : Math.min(CARD_W / t.heightPt, CARD_H / t.widthPt)
            return (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => {
                  setDragIdx(idx)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => {
                  setDragIdx(null)
                  setHoverIdx(null)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  setHoverIdx(idx)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  dropOn(idx)
                }}
                className={`rounded-lg border bg-card p-2 transition-shadow focus-within:ring-2 focus-within:ring-ring ${
                  dragIdx === idx ? 'opacity-50' : ''
                } ${hoverIdx === idx && dragIdx !== null && dragIdx !== idx ? 'ring-2 ring-ring' : ''}`}
              >
                <div
                  className="relative flex items-center justify-center overflow-hidden rounded bg-muted"
                  style={{ width: CARD_W, height: CARD_H }}
                >
                  { }
                  <img
                    src={t.url}
                    alt={`Page ${item.srcIndex + 1} preview`}
                    className="pointer-events-none block shadow-sm"
                    style={{
                      width: t.widthPt * fitScale,
                      height: t.heightPt * fitScale,
                      transform: `rotate(${rot}deg)`,
                    }}
                    draggable={false}
                  />
                  <Badge variant="secondary" className="absolute left-1 top-1 px-1.5">
                    p.{item.srcIndex + 1}
                  </Badge>
                  {rot !== 0 ? (
                    <Badge variant="outline" className="absolute right-1 top-1 px-1.5">
                      {rot}°
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Rotate page ${item.srcIndex + 1} left`}
                    title="Rotate left"
                    disabled={busy}
                    onClick={() => rotateItem(idx, -90)}
                  >
                    <RotateCcw className="size-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Rotate page ${item.srcIndex + 1} right`}
                    title="Rotate right"
                    disabled={busy}
                    onClick={() => rotateItem(idx, 90)}
                  >
                    <RotateCw className="size-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Duplicate page ${item.srcIndex + 1}`}
                    title="Duplicate"
                    disabled={busy}
                    onClick={() => duplicateItem(idx)}
                  >
                    <Copy className="size-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-destructive"
                    aria-label={`Delete page ${item.srcIndex + 1} from output`}
                    title="Delete"
                    disabled={busy}
                    onClick={() => removeItem(idx)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Move page ${item.srcIndex + 1} earlier`}
                    title="Move earlier"
                    disabled={busy || idx === 0}
                    onClick={() => moveItem(idx, -1)}
                  >
                    <ChevronLeft className="size-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Move page ${item.srcIndex + 1} later`}
                    title="Move later"
                    disabled={busy || idx === items.length - 1}
                    onClick={() => moveItem(idx, 1)}
                  >
                    <ChevronRight className="size-4" aria-hidden />
                  </Button>
                </div>
                <p className="sr-only" aria-live="polite">
                  Page {item.srcIndex + 1}, position {idx + 1}
                </p>
              </div>
            )
          })}
        </div>
      ) : null}

      {busy ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Building the organized document…
        </p>
      ) : null}
    </div>
  )
}

export default OrganizeGrid
