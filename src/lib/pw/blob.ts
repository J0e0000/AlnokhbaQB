// Small browser-side helpers shared by tools and editors.

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'file';
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Strip characters that are awkward in downloaded filenames. */
export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[/\\?%*:|"<>]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'file'
  );
}

export async function zipOutFiles(files: { name: string; blob: Blob }[], zipName: string): Promise<Blob> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const used = new Map<string, number>();
  for (const f of files) {
    let name = sanitizeFileName(f.name);
    const n = used.get(name) ?? 0;
    used.set(name, n + 1);
    if (n > 0) {
      const dot = name.lastIndexOf('.');
      name = dot > 0 ? `${name.slice(0, dot)}_${n}${name.slice(dot)}` : `${name}_${n}`;
    }
    zip.file(name, f.blob);
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/** Read a File as a fresh ArrayBuffer (safe to hand to multiple parsers). */
export async function readFileBuffer(file: File | Blob): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))),
      type,
      quality
    );
  });
}

export function bytesToDataUrl(buf: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
