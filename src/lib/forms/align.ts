// Sheet alignment: fiducial-marker detection + perspective/affine warping,
// with a projection-profile deskew fallback. Pure canvas math, no OpenCV.

import type { GrayImage } from './image';

interface Blob {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  fill: number; // area / bbox area
  cx: number;
  cy: number;
}

// ---------------- connected components ----------------

function findDarkBlobs(g: GrayImage, maxPixels = 12_000_000, minArea = 0): Blob[] {
  const { w, h, data } = g;
  // Otsu threshold
  const hist = new Uint32Array(256);
  const step = Math.max(1, Math.floor((w * h) / 1_500_000));
  let n = 0;
  for (let i = 0; i < data.length; i += step) {
    hist[data[i] | 0]++;
    n++;
  }
  let sum = 0;
  for (let b = 0; b < 256; b++) sum += b * hist[b];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let b = 0; b < 256; b++) {
    wB += hist[b];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = b;
    }
  }
  const dark = thr - 10; // slightly below Otsu → keep anti-aliased marker edges inside

  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const blobs: Blob[] = [];
  const maxBlobs = 8000;

  for (let start = 0; start < w * h; start++) {
    if (visited[start] || data[start] > dark) continue;
    if (blobs.length >= maxBlobs) break;
    // BFS
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    let area = 0;
    while (head < tail) {
      const idx = queue[head++];
      const x = idx % w;
      const y = (idx - x) / w;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      // 4-neighbors
      if (x > 0 && !visited[idx - 1] && data[idx - 1] <= dark) {
        visited[idx - 1] = 1;
        queue[tail++] = idx - 1;
      }
      if (x < w - 1 && !visited[idx + 1] && data[idx + 1] <= dark) {
        visited[idx + 1] = 1;
        queue[tail++] = idx + 1;
      }
      if (y > 0 && !visited[idx - w] && data[idx - w] <= dark) {
        visited[idx - w] = 1;
        queue[tail++] = idx - w;
      }
      if (y < h - 1 && !visited[idx + w] && data[idx + w] <= dark) {
        visited[idx + w] = 1;
        queue[tail++] = idx + w;
      }
      if (tail > maxPixels) break;
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (area < minArea) continue; // skip speckle without wasting a slot
    blobs.push({
      x0,
      y0,
      x1,
      y1,
      area,
      fill: area / (bw * bh),
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
    });
  }
  return blobs;
}

export interface MarkerMatch {
  index: number;
  cx: number;
  cy: number;
  size: number;
  residual: number; // px distance between detected center and expected center
}

/**
 * Detect the template's fiducial markers on a sheet. Each expected marker is
 * matched by running connected components INSIDE a local search window around
 * its expected position (robust to speckle noise and fast), then picking the
 * most square, solid dark blob of plausible size nearest to the expectation.
 */
export function detectMarkers(
  g: GrayImage,
  expected: { x: number; y: number; w: number; h: number }[],
  tolerance = 0.09
): MarkerMatch[] {
  const { w, h, data } = g;
  const maxDim = Math.max(w, h);
  const tol = tolerance * maxDim;
  // local Otsu-ish threshold for the whole sheet once
  const hist = new Uint32Array(256);
  const step = Math.max(1, Math.floor((w * h) / 1_500_000));
  let n = 0;
  for (let i = 0; i < data.length; i += step) {
    hist[data[i] | 0]++;
    n++;
  }
  let sum = 0;
  for (let b = 0; b < 256; b++) sum += b * hist[b];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let b = 0; b < 256; b++) {
    wB += hist[b];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = b;
    }
  }
  const dark = thr - 10;

  const matches: MarkerMatch[] = [];

  expected.forEach((m, i) => {
    const ex = (m.x + m.w / 2) * w;
    const ey = (m.y + m.h / 2) * h;
    const expSize = ((m.w * w) + (m.h * h)) / 2;

    // local search window around the expected marker
    const wx0 = Math.max(0, Math.floor(ex - tol - expSize));
    const wy0 = Math.max(0, Math.floor(ey - tol - expSize));
    const wx1 = Math.min(w - 1, Math.ceil(ex + tol + expSize));
    const wy1 = Math.min(h - 1, Math.ceil(ey + tol + expSize));
    const ww = wx1 - wx0 + 1;
    const wh = wy1 - wy0 + 1;
    if (ww <= 2 || wh <= 2) return;

    // connected components within the window
    const visited = new Uint8Array(ww * wh);
    const queue = new Int32Array(ww * wh);
    let bestBlob: Blob | null = null;
    let bestScore = Infinity;

    for (let sy = 0; sy < wh; sy++) {
      for (let sx = 0; sx < ww; sx++) {
        const vIdx = sy * ww + sx;
        if (visited[vIdx]) continue;
        const gIdx = (wy0 + sy) * w + (wx0 + sx);
        if (data[gIdx] > dark) continue;
        let head = 0;
        let tail = 0;
        queue[tail++] = vIdx;
        visited[vIdx] = 1;
        let bx0 = ww;
        let by0 = wh;
        let bx1 = 0;
        let by1 = 0;
        let area = 0;
        while (head < tail) {
          const idx = queue[head++];
          const x = idx % ww;
          const y = (idx - x) / ww;
          area++;
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
          if (x > 0 && !visited[idx - 1] && data[(wy0 + y) * w + (wx0 + x - 1)] <= dark) {
            visited[idx - 1] = 1;
            queue[tail++] = idx - 1;
          }
          if (x < ww - 1 && !visited[idx + 1] && data[(wy0 + y) * w + (wx0 + x + 1)] <= dark) {
            visited[idx + 1] = 1;
            queue[tail++] = idx + 1;
          }
          if (y > 0 && !visited[idx - ww] && data[(wy0 + y - 1) * w + (wx0 + x)] <= dark) {
            visited[idx - ww] = 1;
            queue[tail++] = idx - ww;
          }
          if (y < wh - 1 && !visited[idx + ww] && data[(wy0 + y + 1) * w + (wx0 + x)] <= dark) {
            visited[idx + ww] = 1;
            queue[tail++] = idx + ww;
          }
        }
        const bw = bx1 - bx0 + 1;
        const bh = by1 - by0 + 1;
        const size = (bw + bh) / 2;
        if (size < expSize * 0.3 || size > expSize * 3.2) continue;
        const squareness = Math.min(bw, bh) / Math.max(bw, bh);
        if (squareness < 0.62) continue;
        const fill = area / (bw * bh);
        if (fill < 0.55) continue; // must be a solid square, not an outline
        const cx = wx0 + (bx0 + bx1) / 2;
        const cy = wy0 + (by0 + by1) / 2;
        const dist = Math.hypot(cx - ex, cy - ey);
        if (dist > tol) continue;
        const score = dist + Math.abs(size - expSize) * 0.25;
        if (score < bestScore) {
          bestScore = score;
          bestBlob = { x0: bx0, y0: by0, x1: bx1, y1: by1, area, fill, cx, cy };
        }
      }
    }
    if (bestBlob) {
      const b = bestBlob;
      const bw = b.x1 - b.x0 + 1;
      const bh = b.y1 - b.y0 + 1;
      matches.push({
        index: i,
        cx: b.cx,
        cy: b.cy,
        size: (bw + bh) / 2,
        residual: Math.hypot(b.cx - ex, b.cy - ey),
      });
    }
  });
  return matches;
}

/**
 * Guess fiducial positions from a sample sheet without a known template:
 * find solid square blobs in the four corner quadrants and return up to four
 * normalized rectangles (one per corner, largest first).
 */
export function guessMarkers(g: GrayImage): { x: number; y: number; w: number; h: number }[] {
  const blobs = findDarkBlobs(g);
  const { w, h } = g;
  const candidates: { norm: FormMarkerRect; corner: number; size: number }[] = [];
  for (const b of blobs) {
    const bw = b.x1 - b.x0 + 1;
    const bh = b.y1 - b.y0 + 1;
    const size = (bw + bh) / 2;
    if (size < w * 0.012 || size > w * 0.09) continue;
    const squareness = Math.min(bw, bh) / Math.max(bw, bh);
    if (squareness < 0.7 || b.fill < 0.6) continue;
    const nx = b.cx / w;
    const ny = b.cy / h;
    // corner quadrants only (outer 22% of each axis)
    const nearLeft = nx < 0.22;
    const nearRight = nx > 0.78;
    const nearTop = ny < 0.22;
    const nearBottom = ny > 0.78;
    let corner = -1;
    if (nearTop && nearLeft) corner = 0;
    else if (nearTop && nearRight) corner = 1;
    else if (nearBottom && nearLeft) corner = 2;
    else if (nearBottom && nearRight) corner = 3;
    if (corner < 0) continue;
    candidates.push(
      { norm: { x: b.x0 / w, y: b.y0 / h, w: bw / w, h: bh / h }, corner, size }
    );
  }
  // best (largest) per corner, ordered TL, TR, BL, BR
  const out: FormMarkerRect[] = [];
  for (let corner = 0; corner < 4; corner++) {
    const best = candidates
      .filter((c) => c.corner === corner)
      .sort((a, b) => b.size - a.size)[0];
    if (best) out.push(best.norm);
  }
  return out;
}

interface FormMarkerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------- transforms ----------------

export type Transform = { kind: 'affine'; m: Float64Array } | { kind: 'homography'; h: Float64Array };

/** Solve dst = M·src for an affine transform from 3 point pairs. */
export function solveAffine(src: { x: number; y: number }[], dst: { x: number; y: number }[]): Float64Array {
  // [x y 1] · [a c e; b d f] = [X Y]
  const [s0, s1, s2] = src;
  const [d0, d1, d2] = dst;
  const det = s0.x * (s1.y - s2.y) - s0.y * (s1.x - s2.x) + (s1.x * s2.y - s2.x * s1.y);
  if (Math.abs(det) < 1e-9) throw new Error('Degenerate marker geometry');
  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / det;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / det;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / det;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / det;
  const e =
    (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) /
    det;
  const f =
    (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) /
    det;
  return new Float64Array([a, b, c, d, e, f]);
}

/** DLT homography from 4 point pairs (forward: dst = H·src). */
export function solveHomography(src: { x: number; y: number }[], dst: { x: number; y: number }[]): Float64Array {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
  }
  // Gaussian elimination on the 8×9 augmented system (h8 = 1 fixed by scaling)
  const n = 8;
  const M = A.map((row) => [...row]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    [M[col], M[piv]] = [M[piv], M[col]];
    const pv = M[col][col];
    if (Math.abs(pv) < 1e-12) throw new Error('Degenerate marker geometry');
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / pv;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const hs: number[] = [];
  for (let r = 0; r < n; r++) hs.push(M[r][n] / M[r][r]);
  hs.push(1);
  return new Float64Array(hs);
}

function invertAffine(m: Float64Array): Float64Array {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error('Degenerate transform');
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  const ie = (c * f - d * e) / det;
  const if_ = (b * e - a * f) / det;
  return new Float64Array([ia, ib, ic, id, ie, if_]);
}

function invertHomography(h: Float64Array): Float64Array {
  const [a, b, c, d, e, f, g, hh, i] = h;
  const A =
    a * (e * i - f * hh) - b * (d * i - f * g) + c * (d * hh - e * g);
  if (Math.abs(A) < 1e-12) throw new Error('Degenerate homography');
  const inv = new Float64Array([
    (e * i - f * hh) / A,
    (c * hh - b * i) / A,
    (b * f - c * e) / A,
    (f * g - d * i) / A,
    (a * i - c * g) / A,
    (c * d - a * f) / A,
    (d * hh - e * g) / A,
    (b * g - a * hh) / A,
    (a * e - b * d) / A,
  ]);
  return inv;
}

/** Build a forward transform mapping detected marker centers → expected centers. */
export function markerTransform(
  matches: MarkerMatch[],
  expected: { x: number; y: number; w: number; h: number }[],
  refW: number,
  refH: number
): Transform {
  const src = matches.map((m) => ({ x: m.cx, y: m.cy }));
  const dst = matches.map((m) => {
    const e = expected[m.index];
    return { x: (e.x + e.w / 2) * refW, y: (e.y + e.h / 2) * refH };
  });
  if (matches.length >= 4 && !collinear(dst)) {
    return { kind: 'homography', h: solveHomography(src, dst) };
  }
  return { kind: 'affine', m: solveAffine(src.slice(0, 3), dst.slice(0, 3)) };
}

function collinear(pts: { x: number; y: number }[]): boolean {
  if (pts.length < 3) return true;
  const [a, b, c] = pts;
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const scale = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - a.x, c.y - a.y) || 1;
  return Math.abs(cross / scale) < 0.02;
}

/** Warp the sheet so the template geometry lands exactly at refW×refH pixels. */
export function warpCanvas(
  source: HTMLCanvasElement,
  t: Transform,
  outW: number,
  outH: number
): HTMLCanvasElement {
  const inv = t.kind === 'affine' ? invertAffine(t.m) : invertHomography(t.h);
  const sctx = source.getContext('2d', { willReadFrequently: true });
  if (!sctx) throw new Error('Canvas is not supported in this browser');
  const srcData = sctx.getImageData(0, 0, source.width, source.height);
  const sp = srcData.data;
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const octx = out.getContext('2d');
  if (!octx) throw new Error('Canvas is not supported in this browser');
  const dst = octx.createImageData(outW, outH);
  const dp = dst.data;
  const sw = source.width;
  const sh = source.height;

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let sx: number;
      let sy: number;
      if (t.kind === 'affine') {
        const [ia, ib, ic, id, ie, if_] = inv;
        sx = ia * x + ic * y + ie;
        sy = ib * x + id * y + if_;
      } else {
        const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = inv;
        const denom = h6 * x + h7 * y + h8 || 1e-9;
        sx = (h0 * x + h1 * y + h2) / denom;
        sy = (h3 * x + h4 * y + h5) / denom;
      }
      const o = (y * outW + x) * 4;
      if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) {
        dp[o] = 255;
        dp[o + 1] = 255;
        dp[o + 2] = 255;
        dp[o + 3] = 255;
        continue;
      }
      // bilinear
      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const p00 = (y0 * sw + x0) * 4;
      const p10 = p00 + 4;
      const p01 = p00 + sw * 4;
      const p11 = p01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sp[p00 + ch] * (1 - fx) + sp[p10 + ch] * fx;
        const bot = sp[p01 + ch] * (1 - fx) + sp[p11 + ch] * fx;
        dp[o + ch] = top * (1 - fy) + bot * fy;
      }
      dp[o + 3] = 255;
    }
  }
  octx.putImageData(dst, 0, 0);
  return out;
}

/**
 * Confidence from marker residuals normalized by the search tolerance:
 * 1 = markers exactly where expected, 0 = barely inside the window.
 * (Pre-warp residual is naturally large for rotated sheets — that is exactly
 * what alignment corrects — so it must NOT be compared to the marker size.)
 */
export function alignmentConfidence(matches: MarkerMatch[], tolerance = 0.09, maxDim = 1): number {
  if (!matches.length) return 0;
  const tol = Math.max(1, tolerance * maxDim);
  const meanRes = matches.reduce((s, m) => s + m.residual, 0) / matches.length;
  return Math.max(0, Math.min(1, 1 - meanRes / tol));
}

// ---------------- deskew fallback ----------------

/** Estimate skew from the sharpness of horizontal projection profiles. */
export function estimateDeskewAngle(g: GrayImage): number {
  // Downsample for speed.
  const step = Math.max(1, Math.floor(g.w / 900));
  const w = Math.floor(g.w / step);
  const h = Math.floor(g.h / step);
  const small = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      small[y * w + x] = g.data[y * step * g.w + x * step] < 140 ? 1 : 0;
    }
  }
  let bestAngle = 0;
  let bestScore = -1;
  for (let deg = -6; deg <= 6; deg += 0.25) {
    const rad = (deg * Math.PI) / 180;
    const tan = Math.tan(rad);
    const rows = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let count = 0;
      for (let x = 4; x < w - 4; x++) {
        const yy = Math.round(y + x * tan);
        if (yy >= 0 && yy < h && small[yy * w + x]) count++;
      }
      rows[y] = count;
    }
    // sharpness = sum of squared row sums (peaked profile = well aligned text lines)
    let score = 0;
    for (let y = 0; y < h; y++) score += rows[y] * rows[y];
    if (score > bestScore) {
      bestScore = score;
      bestAngle = deg;
    }
  }
  return bestAngle;
}

/** Rotate a canvas around its center, expanding bounds; white background. */
export function rotateCanvas(source: HTMLCanvasElement, deg: number): HTMLCanvasElement {
  const rad = (deg * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const w = source.width;
  const h = source.height;
  const outW = Math.round(w * cos + h * sin);
  const outH = Math.round(w * sin + h * cos);
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Canvas is not supported in this browser');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(rad);
  ctx.drawImage(source, -w / 2, -h / 2);
  return out;
}
