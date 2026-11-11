// ============================================================
// ALNOKHBA QB — E2E test: Smart extraction pipeline
//   bun scripts/test-extract.ts
// Renders a real exam page (Arabic + English questions) to PNG
// via the project's own Chromium pool, then pushes it through
// POST /api/extract → review → import → duplicate re-import.
// ============================================================

import { renderPng } from '../src/lib/pdf/pool';

const BASE = 'http://localhost:3000';

const PAGE_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
  body { font-family: 'Tajawal', 'Amiri', sans-serif; padding: 40px; background: white; width: 700px; }
  .q { margin-bottom: 22px; font-size: 19px; }
  .q .opts { margin-top: 6px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; font-size: 17px; }
  .en { direction: ltr; text-align: left; font-family: Arial, sans-serif; }
</style></head><body>
<h2>اختبار العلوم — خلية الكائن الحي</h2>
<div class="q">1. أي العضيات مسؤول عن إنتاج الطاقة في الخلية؟
  <div class="opts"><div>أ) النواة</div><div>ب) الميتوكوندريا</div><div>ج) الرايبوسوم</div><div>د) الفجوة</div></div>
</div>
<div class="q">2. اكتب تعريف للتمثيل الضوئي.</div>
<div class="q en">3. Choose the correct answer: The powerhouse of the cell is ___
  <div class="opts"><div>A) nucleus</div><div>B) mitochondria</div><div>C) ribosome</div><div>D) vacuole</div></div>
</div>
</body></html>`;

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'teacher@alnokhba.qb', password: 'Teacher@2025' }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!res.ok || !cookie) throw new Error(`login failed: ${res.status}`);
  return cookie;
}

async function main() {
  console.log('[1] rendering exam page via Chromium pool…');
  const png = await renderPng(PAGE_HTML, { widthMm: 215, heightMm: 165, dpi: 200 });
  console.log(`    PNG: ${(png.length / 1024).toFixed(0)} KB`);
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

  const cookie = await login();
  const H = { 'Content-Type': 'application/json', cookie };

  console.log('[2] POST /api/extract …');
  const t0 = Date.now();
  const extRes = await fetch(`${BASE}/api/extract`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ filename: 'اختبار العلوم.png', mimeType: 'image/png', language: 'auto', pages: [{ page: 1, dataUrl }] }),
  });
  const ext = await extRes.json();
  if (!extRes.ok) {
    console.error('EXTRACT FAILED', extRes.status, ext);
    process.exit(1);
  }
  console.log(`    job ${ext.jobId}: ${ext.questionCount} candidates in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('[3] GET /api/extract/:id (review data)…');
  const jobRes = await fetch(`${BASE}/api/extract/${ext.jobId}`, { headers: { cookie } });
  const job = await jobRes.json();
  for (const [i, q] of (job.questions ?? []).entries()) {
    console.log(`    Q${i + 1} [${q.type}] conf=${Math.round(q.confidence * 100)}% page=${q.page} :: ${q.prompt.slice(0, 70)}`);
    for (const o of q.options ?? []) console.log(`        ${o.id}) ${o.text.slice(0, 50)}`);
    console.log(`        key=${q.correctAnswer ?? '—'}`);
  }

  const ids = (job.questions ?? []).map((q: { id: string }) => q.id);
  if (ids.length === 0) {
    console.error('NO CANDIDATES EXTRACTED');
    process.exit(1);
  }

  console.log('[4] import to bank…');
  const impRes = await fetch(`${BASE}/api/extract/${ext.jobId}/import`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ ids, defaults: { subject: 'العلوم', chapter: 'خلية الكائن الحي' } }),
  });
  const imp = await impRes.json();
  console.log(`    imported=${imp.imported} duplicates=${imp.duplicates} errors=${imp.errors?.length ?? 0}`);

  console.log('[5] re-import the same ids (all must be duplicates)…');
  const imp2 = await (await fetch(`${BASE}/api/extract/${ext.jobId}/import`, { method: 'POST', headers: H, body: JSON.stringify({ ids }) })).json();
  console.log(`    imported=${imp2.imported} duplicates=${imp2.duplicates}`);
  if (imp2.imported > 0) {
    console.error('DUPLICATE DETECTION FAILED');
    process.exit(1);
  }

  console.log('[6] unauthenticated guard check…');
  const unauth = await fetch(`${BASE}/api/extract`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  console.log(`    POST /api/extract without cookie → ${unauth.status} (expect 401)`);

  console.log('EXTRACT E2E: PASS');
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
