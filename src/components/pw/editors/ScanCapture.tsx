'use client'

// Scan capture: turn phone camera frames or uploaded photos into a PDF.
// Captured pages are listed as reorderable thumbnails and combined with the
// shared images-to-PDF pipeline.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Camera,
  CameraOff,
  CircleStop,
  FileImage,
  Images,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { EditorProps } from '@/lib/pw/types'
import { runImagesToPdf } from '@/lib/pw/client/images'
import { canvasToBlob } from '@/lib/pw/blob'

interface CaptureItem {
  file: File
  url: string
}

export function ScanCapture({ onProgress, onDone, onError }: EditorProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const counterRef = useRef(0)

  const [items, setItems] = useState<CaptureItem[]>([])
  const [camOn, setCamOn] = useState(false)
  const [camError, setCamError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const itemsRef = useRef<CaptureItem[]>([])

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCamOn(false)
  }, [])

  // Release camera + object URLs when the editor unmounts.
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      for (const it of itemsRef.current) URL.revokeObjectURL(it.url)
    }
  }, [])

  const addItem = (blob: Blob, name: string, type: string) => {
    const file = blob instanceof File && blob.type === type ? blob : new File([blob], name, { type })
    const url = URL.createObjectURL(file)
    setItems((prev) => [...prev, { file, url }])
  }

  const startCamera = async () => {
    setCamError(null)
    try {
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        throw new Error('Camera capture needs a secure (HTTPS) connection. You can still upload photos below.')
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser does not expose a camera API. You can still upload photos below.')
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => undefined)
      }
      setCamOn(true)
    } catch (e) {
      const err = e as { name?: string; message?: string }
      if (err?.name === 'NotAllowedError' || /permission|denied/i.test(err?.message ?? '')) {
        setCamError('Camera access was denied. Allow the camera in your browser settings, or upload photos instead.')
      } else if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
        setCamError('No usable camera was found on this device. You can upload photos instead.')
      } else if (err?.name === 'NotReadableError') {
        setCamError('The camera is in use by another application. Close it and try again, or upload photos.')
      } else {
        setCamError(err?.message || 'Camera could not be started. You can upload photos instead.')
      }
    }
  }

  const capturePage = async () => {
    const video = videoRef.current
    if (!video || !camOn) return
    try {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth || 1280
      canvas.height = video.videoHeight || 720
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas is not supported in this browser')
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92)
      counterRef.current += 1
      const name = `scan_${String(counterRef.current).padStart(3, '0')}.jpg`
      addItem(blob, name, 'image/jpeg')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not capture the camera frame.')
    }
  }

  const onUpload = (list: FileList | null) => {
    if (!list) return
    for (const f of Array.from(list)) {
      if (!f.type.startsWith('image/')) continue
      counterRef.current += 1
      const ext = f.type === 'image/png' ? 'png' : 'jpg'
      const name = `scan_${String(counterRef.current).padStart(3, '0')}.${ext}`
      addItem(f, name, f.type)
    }
  }

  const removeItem = (idx: number) => {
    setItems((prev) => {
      URL.revokeObjectURL(prev[idx].url)
      return prev.filter((_, i) => i !== idx)
    })
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
      return
    }
    setItems((prev) => {
      const next = [...prev]
      const [moved] = next.splice(dragIdx, 1)
      next.splice(idx, 0, moved)
      return next
    })
    setDragIdx(null)
  }

  const createPdf = async () => {
    if (items.length === 0 || busy) return
    setBusy(true)
    try {
      onProgress('Creating PDF from captured pages…', 10)
      const outs = await runImagesToPdf(
        items.map((it) => it.file),
        { pageSize: 'fit' },
        { onProgress }
      )
      onProgress('Done', 100)
      onDone(outs, `${items.length} scanned page${items.length === 1 ? '' : 's'}`)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not build the PDF from the captured pages.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="relative mx-auto aspect-video w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-muted">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`size-full object-cover ${camOn ? 'block' : 'hidden'}`}
            aria-label="Camera preview"
          />
          {!camOn ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <Camera className="size-8" aria-hidden />
              <p className="text-sm">Camera preview appears here</p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {!camOn ? (
            <Button size="sm" onClick={() => void startCamera()} disabled={busy}>
              <Camera className="size-4" aria-hidden />
              Start camera
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={() => void capturePage()}>
                <Plus className="size-4" aria-hidden />
                Capture page
              </Button>
              <Button size="sm" variant="outline" onClick={stopCamera}>
                <CircleStop className="size-4" aria-hidden />
                Stop camera
              </Button>
            </>
          )}
          <div className="flex items-center gap-2">
            <Label htmlFor="pw-scan-upload" className="sr-only">
              Upload photos
            </Label>
            <Input
              id="pw-scan-upload"
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                onUpload(e.target.files)
                e.target.value = ''
              }}
              className="w-64"
              disabled={busy}
            />
          </div>
        </div>

        {camError ? (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <CameraOff className="mt-0.5 size-4 shrink-0" aria-hidden />
            {camError}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {items.length > 0
            ? `${items.length} captured page${items.length === 1 ? '' : 's'} — drag or use the arrows to reorder`
            : 'Capture or upload pages to build the PDF.'}
        </p>
        {items.length > 0 ? (
          <div
            className="pw-scroll flex gap-3 overflow-x-auto pb-2"
            onDragOver={(e) => e.preventDefault()}
            role="list"
            aria-label="Captured pages"
          >
            {items.map((it, idx) => (
              <div
                key={it.url}
                role="listitem"
                draggable
                onDragStart={(e) => {
                  setDragIdx(idx)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => setDragIdx(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  dropOn(idx)
                }}
                className="relative w-28 shrink-0 rounded-lg border border-border bg-card p-2"
              >
                { }
                <img
                  src={it.url}
                  alt={`Captured page ${idx + 1}: ${it.file.name}`}
                  className="h-32 w-full rounded object-cover"
                  draggable={false}
                />
                <p className="mt-1 truncate text-center text-xs text-muted-foreground">{it.file.name}</p>
                <div className="mt-1 flex items-center justify-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={`Move ${it.file.name} earlier`}
                    disabled={idx === 0 || busy}
                    onClick={() => moveItem(idx, -1)}
                  >
                    <ArrowUp className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={`Move ${it.file.name} later`}
                    disabled={idx === items.length - 1 || busy}
                    onClick={() => moveItem(idx, 1)}
                  >
                    <ArrowDown className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-destructive"
                    aria-label={`Remove ${it.file.name}`}
                    disabled={busy}
                    onClick={() => removeItem(idx)}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={createPdf} disabled={busy || items.length === 0}>
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Images className="size-4" aria-hidden />
          )}
          Create PDF
        </Button>
        {items.length === 0 ? (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <FileImage className="size-4" aria-hidden />
            No pages captured yet
          </span>
        ) : null}
      </div>
    </div>
  )
}

export default ScanCapture
