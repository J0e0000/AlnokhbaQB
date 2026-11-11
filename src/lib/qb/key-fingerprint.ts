// ============================================================
// ALNOKHBA QB — deterministic answer-key fingerprint
// Used to compare the exam DRAFT key against the key frozen in a
// published ExamVersion (both sides normalize identically → tiny
// 32-bit hex digest; empty entries are ignored).
// ============================================================

export function keyFingerprint(key: Record<string, string>): string {
  const entries = Object.entries(key ?? {})
    .filter(([, v]) => typeof v === 'string' && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const s = JSON.stringify(entries);
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
