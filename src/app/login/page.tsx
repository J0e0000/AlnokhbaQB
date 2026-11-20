'use client';

// ============================================================
// النخبة QB — /login (shared-password gate, Arabic RTL)
// Desk surface, wordmark, one field, one button — the
// registration-mark motif is the only decoration.
// ============================================================

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RegistrationMark, Wordmark } from '@/components/shell/Wordmark';

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        const msg = data?.error ?? 'كلمة المرور غير صحيحة — أعد المحاولة';
        setError(msg);
        toast.error(msg);
        return;
      }
      toast.success('تم تسجيل الدخول — أهلًا بك');
      // ?next=<path> set by the proxy redirect; fall back to the exams list.
      const params = new URLSearchParams(window.location.search);
      const next = params.get('next');
      router.replace(next && next.startsWith('/') ? next : '/exams');
      router.refresh();
    } catch {
      const msg = 'تعذر الاتصال بالخادم — أعد المحاولة';
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4" dir="rtl">
      <div className="w-full max-w-sm">
        <div className="paper-sheet rounded-xl p-8">
          <div className="mb-8 flex flex-col items-center gap-3 text-center">
            <Wordmark onDesk />
            <p className="text-[13px] text-muted-foreground">بنك الأسئلة والتصحيح الآلي</p>
            <RegistrationMark className="h-9 w-9 text-border" aria-hidden />
          </div>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="password">كلمة المرور</Label>
              <Input
                id="password"
                type="password"
                dir="ltr"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="text-end"
                aria-invalid={!!error}
                aria-describedby={error ? 'login-error' : undefined}
              />
            </div>
            {error && (
              <p id="login-error" role="alert" className="text-[13px] font-medium text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              className="h-11 w-full bg-primary text-[15px] font-medium text-primary-foreground hover:bg-primary/90"
              disabled={busy || !password}
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  جارٍ التحقق…
                </>
              ) : (
                'دخول'
              )}
            </Button>
          </form>
        </div>
        <p className="mt-4 text-center text-[13px] text-muted-foreground">
          الجلسة صالحة ٧ أيام على هذا الجهاز
        </p>
      </div>
    </main>
  );
}
