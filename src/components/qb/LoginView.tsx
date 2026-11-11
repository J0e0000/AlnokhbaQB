'use client';

// ============================================================
// ALNOKHBA QB — Login / Register view ("Midnight Luxe" identity)
// Split hero: brand showcase + glass auth card. Arabic-first.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  BookOpen, Files, Info, Loader2, LogIn, PenTool, ScanLine, ShieldCheck, Sparkles, UserPlus,
} from 'lucide-react';

interface Props {
  onLoggedIn: () => void;
}

const FEATURES = [
  { icon: <ScanLine className="h-4 w-4" />, title: 'مسح وتصحيح آلي فوري', desc: 'أوراق OMR تُقرأ وتُصحّح في ثوانٍ بمحرك OpenCV' },
  { icon: <PenTool className="h-4 w-4" />, title: 'مصمم امتحانات بصري', desc: 'اسحب وافرح لبناء ورقة امتحان احترافية' },
  { icon: <Files className="h-4 w-4" />, title: 'تصدير PDF و OMR', desc: 'نماذج جاهزة للطباعة برمز QR لكل نسخة' },
  { icon: <BookOpen className="h-4 w-4" />, title: 'بنك أسئلة ذكي', desc: 'استخراج الأسئلة من أي ملف وتنظيمها بالتصنيفات' },
];

export default function LoginView({ onLoggedIn }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'تعذر تسجيل الدخول');
        return;
      }
      toast.success(`مرحبًا ${data.user?.name ?? ''} 👋`);
      onLoggedIn();
    } catch {
      setError('تعذر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password, organizationName: orgName.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'تعذر إنشاء الحساب');
        return;
      }
      toast.success('تم إنشاء المؤسسة وحسابك — مرحبًا بك');
      onLoggedIn();
    } catch {
      setError('تعذر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center px-4 py-8" dir="rtl">
      <div className="mx-auto grid w-full max-w-5xl items-center gap-8 lg:grid-cols-[1.15fr_1fr] lg:gap-12">
        {/* ---------- Brand panel ---------- */}
        <section className="animate-fade-up hidden flex-col gap-7 lg:flex">
          <div className="flex items-center gap-4">
            <div className="logo-glow flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 font-black text-white" style={{ fontFamily: 'Amiri, serif' }}>
              <span className="text-3xl leading-none">ن</span>
            </div>
            <div>
              <h1 className="text-3xl font-extrabold leading-tight" style={{ fontFamily: 'Amiri, serif' }}>
                منصة <span className="text-gradient">النخبة QB</span>
              </h1>
              <p className="mt-0.5 text-sm text-slate-500">بنك أسئلة • امتحانات PDF و OMR • تصحيح آلي</p>
            </div>
          </div>

          <p className="max-w-md text-[15px] leading-8 text-slate-500">
            نظام متكامل واحد يغذي كل شيء: صمّم الامتحان، ولّد أوراق OMR بنسخ متعددة، امسح أوراق الطلاب بالكاميرا،
            واحصل على الدرجات فورًا — بمنحنى ثقة يضع علامة على كل إجابة ملتبسة للمراجعة.
          </p>

          <ul className="grid max-w-md gap-3">
            {FEATURES.map((f) => (
              <li key={f.title} className="glass card-hover flex items-start gap-3 rounded-xl p-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-600/15 text-emerald-600">{f.icon}</span>
                <span>
                  <span className="block text-sm font-bold text-slate-700">{f.title}</span>
                  <span className="block text-xs text-slate-500">{f.desc}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="flex max-w-md items-center gap-2 text-[11px] text-slate-400">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            جلسات مشفّرة (JWT) • عزل بيانات كل مؤسسة • سجل تدقيق كامل
          </div>
        </section>

        {/* ---------- Auth card ---------- */}
        <section className="animate-fade-up mx-auto w-full max-w-md">
          {/* compact brand for mobile */}
          <div className="mb-5 flex flex-col items-center gap-2 text-center lg:hidden">
            <div className="logo-glow flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 font-black text-white" style={{ fontFamily: 'Amiri, serif' }}>
              <span className="text-2xl leading-none">ن</span>
            </div>
            <h1 className="text-lg font-extrabold" style={{ fontFamily: 'Amiri, serif' }}>
              منصة <span className="text-gradient">النخبة QB</span>
            </h1>
            <p className="text-xs text-slate-500">بنك أسئلة • امتحانات PDF و OMR • تصحيح آلي</p>
          </div>

          <div className="glass animate-pop-in rounded-2xl p-5 shadow-2xl shadow-black/10 sm:p-6">
            <div className="mb-4 flex items-center gap-2 text-emerald-600">
              <Sparkles className="h-4 w-4" />
              <span className="text-xs font-bold">حلقة الوصول إلى مساحة العمل</span>
            </div>
            <Tabs defaultValue="login">
              <TabsList className="mb-4 grid w-full grid-cols-2">
                <TabsTrigger value="login" className="gap-1.5"><LogIn className="h-4 w-4" /> تسجيل الدخول</TabsTrigger>
                <TabsTrigger value="register" className="gap-1.5"><UserPlus className="h-4 w-4" /> حساب جديد</TabsTrigger>
              </TabsList>

              {error && (
                <Alert variant="destructive" className="mb-3">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <TabsContent value="login" className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="login-email">البريد الإلكتروني</Label>
                  <Input id="login-email" type="email" dir="ltr" className="text-left" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teacher@school.com" autoComplete="email" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="login-password">كلمة المرور</Label>
                  <Input id="login-password" type="password" dir="ltr" className="text-left" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && void login()} autoComplete="current-password" />
                </div>
                <Button className="btn-primary-grad w-full border-0 text-white" disabled={busy || !email.trim() || !password} onClick={() => void login()}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} دخول
                </Button>

                <Alert className="border-emerald-600/25 bg-emerald-600/10">
                  <Info className="h-4 w-4 text-emerald-600" />
                  <AlertDescription className="text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-800">
                    <div className="font-bold">حسابات تجريبية جاهزة:</div>
                    مدير النظام: <span dir="ltr" className="font-mono">admin@alnokhba.qb / Admin@2025</span><br />
                    معلم: <span dir="ltr" className="font-mono">teacher@alnokhba.qb / Teacher@2025</span>
                  </AlertDescription>
                </Alert>
              </TabsContent>

              <TabsContent value="register" className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="reg-name">الاسم الكامل</Label>
                  <Input id="reg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="أستاذ محمد أحمد" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-org">اسم المؤسسة / المدرسة</Label>
                  <Input id="reg-org" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="مدرسة النور النموذجية" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-email">البريد الإلكتروني</Label>
                  <Input id="reg-email" type="email" dir="ltr" className="text-left" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-password">كلمة المرور (٨ أحرف على الأقل)</Label>
                  <Input id="reg-password" type="password" dir="ltr" className="text-left" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && void register()} autoComplete="new-password" />
                </div>
                <Button className="btn-primary-grad w-full border-0 text-white" disabled={busy || !name.trim() || !orgName.trim() || !email.trim() || password.length < 8} onClick={() => void register()}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} إنشاء مؤسسة وحساب مدير
                </Button>
                <p className="text-center text-[11px] text-slate-400">سيصبح حسابك مدير المؤسسة (org_admin) ويكون بنك الأسئلة معزولًا تمامًا لمؤسستك.</p>
              </TabsContent>
            </Tabs>
          </div>

          <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-[11px] text-slate-400 lg:hidden">
            <ShieldCheck className="h-3.5 w-3.5" /> جلسات مشفّرة (JWT) • عزل بيانات كل مؤسسة • سجل تدقيق كامل
          </p>
        </section>
      </div>
    </div>
  );
}
