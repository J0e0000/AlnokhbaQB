'use client';

// ============================================================
// ALNOKHBA QB — App Shell (single-page)
// Create Exam → Design → Preview → Generate → Publish → Scan → Grade
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import ScanStudio from '@/components/qb/ScanStudio';
import PdfToolsPane from '@/components/qb/PdfToolsPane';
import FormsStudio from '@/components/forms/FormsStudio';
import OcrImport from '@/components/qb/OcrImport';
import OnlinePane from '@/components/qb/OnlinePane';
import ReviewQueue from '@/components/qb/ReviewQueue';
import AssignmentsPane from '@/components/qb/AssignmentsPane';
import Designer from '@/components/qb/designer/Designer';
import LandingView from '@/components/qb/LandingView';
import { EmptyState, PaneHeader, StatCard } from '@/components/qb/pane-kit';
import ExtractionStudio from '@/components/qb/ExtractionStudio';
import BankManager from '@/components/qb/BankManager';
import PdfWorkspace from '@/components/qb/PdfWorkspace';
import Whiteboard from '@/components/qb/Whiteboard';
import AdminPane from '@/components/qb/AdminPane';
import type { QBQuestion } from '@/lib/qb/types';
import { keyFingerprint } from '@/lib/qb/key-fingerprint';
import {
  Activity, Archive, BookOpen, ClipboardCheck, ClipboardList, Eraser, Eye, FileDown, FileInput, FileStack, Files, GraduationCap, KeyRound, LayoutDashboard,
  Languages, Loader2, LogOut, Menu, Moon, PenTool, PencilRuler, Plus, RefreshCcw, ScanLine, ScanSearch, ScanText, Settings2, ShieldCheck, Sparkles, Sun, Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface ExamRow {
  id: string;
  title: string;
  subject: string | null;
  status: string;
  questionCount: number;
  omrEnabled: boolean;
  currentVersion: number;
  updatedAt: string;
}

interface ExamDetail {
  exam: ExamRow & { documentJson: string; answerKeyJson: string };
  document: { questions: QBQuestion[]; branding: { examTitle: string; institution: string }; omr: { enabled: boolean; optionsPerQuestion: number; studentIdDigits: number } };
  answerKey: Record<string, string>;
  versions: { id: string; version: number; publishedAt: string; omrTemplate?: boolean; answerKeyCount?: number; answerKeyHash?: string }[];
}

type View = 'dashboard' | 'bank' | 'design' | 'preview' | 'omr' | 'scan' | 'review' | 'ocr' | 'extract' | 'pdf' | 'pdftools' | 'forms' | 'whiteboard' | 'online' | 'assignments' | 'students' | 'admin' | 'settings';

interface SessionUserInfo {
  id: string;
  name: string;
  email: string;
  role: string;
  organizationId: string | null;
  organizationName: string | null;
}

// ---------- resilient file download (shared by Preview / OMR studio) ----------
// PDFs are rendered by Chromium server-side: a server restart, a cold browser
// launch, or a gateway blip can make ONE request fail transiently. This helper
// surfaces the REAL error from the response body, keeps a busy state, and
// auto-retries once on transient failures (network drop / 502 / 503 / 504).

const TRANSIENT_STATUS = new Set([502, 503, 504]);

async function fetchFileWithRetry(url: string): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200)); // let a restarting server come back
    try {
      const res = await fetch(url);
      if (res.ok || !TRANSIENT_STATUS.has(res.status)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err; // network failure (server/gateway restarting, connection reset)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('network');
}

async function downloadFile(url: string, name: string, successMsg = 'تم التنزيل ✓'): Promise<void> {
  let res: Response;
  try {
    res = await fetchFileWithRetry(url);
  } catch {
    toast.error('تعذر الاتصال بالخادم — تأكد من تشغيله ثم أعد المحاولة');
    return;
  }
  if (!res.ok) {
    let msg = `فشل التوليد (HTTP ${res.status})`;
    try {
      const data = (await res.json()) as { error?: string; details?: string };
      if (data?.error) msg = data.details ? `${data.error} — ${data.details}` : data.error;
    } catch {
      /* non-JSON error body (e.g. gateway 502 HTML) → keep the default message */
    }
    toast.error(msg);
    return;
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  toast.success(successMsg);
}

const ROLE_SHORT: Record<string, string> = {
  super_admin: 'مدير النظام',
  org_admin: 'مدير المؤسسة',
  teacher: 'معلم',
  viewer: 'مشاهد',
};

// ---------- grouped navigation (sidebar + mobile drawer share it) ----------

interface NavItem {
  key: View;
  ar: string;
  en: string;
  icon: LucideIcon;
  needsExam?: boolean;
  adminOnly?: boolean;
}

const NAV_GROUPS: Array<{ ar: string; en: string; items: NavItem[] }> = [
  {
    ar: 'الرئيسية',
    en: 'Home',
    items: [{ key: 'dashboard', ar: 'لوحة التحكم', en: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    ar: 'بنك الأسئلة',
    en: 'Question Bank',
    items: [
      { key: 'bank', ar: 'بنك الأسئلة', en: 'Bank', icon: BookOpen },
      { key: 'extract', ar: 'استخراج ذكي', en: 'Smart Extract', icon: ScanText },
      { key: 'ocr', ar: 'استيراد OCR', en: 'OCR Import', icon: FileInput },
    ],
  },
  {
    ar: 'الامتحانات',
    en: 'Exams',
    items: [
      { key: 'design', ar: 'المصمم', en: 'Designer', icon: PencilRuler, needsExam: true },
      { key: 'preview', ar: 'معاينة و PDF', en: 'Preview & PDF', icon: Eye, needsExam: true },
      { key: 'omr', ar: 'أوراق OMR', en: 'OMR Sheets', icon: Files, needsExam: true },
      { key: 'online', ar: 'أونلاين', en: 'Online', icon: GraduationCap },
    ],
  },
  {
    ar: 'التصحيح والمتابعة',
    en: 'Grading',
    items: [
      { key: 'scan', ar: 'مسح وتصحيح', en: 'Scanning', icon: ScanLine },
      { key: 'review', ar: 'قائمة المراجعة', en: 'Review Queue', icon: ClipboardCheck },
      { key: 'assignments', ar: 'الواجبات', en: 'Assignments', icon: ClipboardList },
      { key: 'students', ar: 'الطلاب', en: 'Students', icon: Users },
    ],
  },
  {
    ar: 'الأدوات',
    en: 'Tools',
    items: [
      { key: 'pdf', ar: 'مساحة PDF', en: 'PDF Workspace', icon: FileStack },
      { key: 'pdftools', ar: 'أدوات PDF', en: 'PDF Tools', icon: ScanSearch },
      { key: 'forms', ar: 'قارئ النماذج', en: 'Forms Scanner', icon: ClipboardList },
      { key: 'whiteboard', ar: 'السبورة', en: 'Whiteboard', icon: PenTool },
    ],
  },
  {
    ar: 'النظام',
    en: 'System',
    items: [
      { key: 'admin', ar: 'الإدارة', en: 'Admin', icon: ShieldCheck, adminOnly: true },
      { key: 'settings', ar: 'الإعدادات', en: 'Settings', icon: Settings2 },
    ],
  },
];

export default function Home() {
  const [view, setView] = useState<View>('dashboard');
  const [exams, setExams] = useState<ExamRow[]>([]);
  const [selectedExamId, setSelectedExamId] = useState<string | null>(null);
  const [health, setHealth] = useState<{ omrEngine?: boolean; pdf?: { running?: boolean } } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [user, setUser] = useState<SessionUserInfo | null>(null);
  const [authState, setAuthState] = useState<'loading' | 'in' | 'out'>('loading');
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  const L = useCallback((ar: string, en: string) => (lang === 'ar' ? ar : en), [lang]);

  // theme toggle (bootstrap script in layout already applied the class pre-paint)
  useEffect(() => {
    const saved = window.localStorage.getItem('anqb-theme');
    const t = saved === 'light' ? 'light' : 'dark';
    setTheme(t);
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, []);
  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', next === 'dark');
      window.localStorage.setItem('anqb-theme', next);
      return next;
    });
  };

  const fetchMe = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json().catch(() => ({}));
      if (data.user) {
        setUser(data.user as SessionUserInfo);
        setAuthState('in');
      } else {
        setUser(null);
        setAuthState('out');
      }
    } catch {
      setAuthState('out');
    }
  }, []);

  useEffect(() => {
    void fetchMe();
    const saved = window.localStorage.getItem('anqb-lang');
    if (saved === 'en' || saved === 'ar') setLang(saved);
  }, [fetchMe]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    window.localStorage.setItem('anqb-lang', lang);
  }, [lang]);

  const refreshExams = useCallback(async () => {
    try {
      const res = await fetch('/api/exams');
      const data = await res.json();
      setExams(Array.isArray(data) ? data : data.exams ?? []);
    } catch {
      toast.error('تعذر تحميل الامتحانات');
    }
  }, []);

  useEffect(() => {
    if (authState !== 'in') return;
    let cancelled = false;
    void (async () => {
      await refreshExams();
      try {
        const r = await fetch('/api/health');
        const h = await r.json();
        if (!cancelled) setHealth(h);
      } catch {
        /* health optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshExams, reloadKey, authState]);

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* even if the call fails the cookie stays until expiry — still clear locally */
    }
    setUser(null);
    setAuthState('out');
    setView('dashboard');
    toast.success('تم تسجيل الخروج');
  };

  if (authState === 'loading') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <div className="logo-glow animate-pop-in flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-700 font-black text-white brand-serif">
          <span className="text-3xl leading-none">ن</span>
        </div>
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return <LandingView onLoggedIn={() => void fetchMe()} />;
  }

  const isAdmin = user.role === 'org_admin' || user.role === 'super_admin';

  const openExam = (id: string, v: View) => {
    setSelectedExamId(id);
    setView(v);
  };

  return (
    <div className="flex min-h-dvh">
      {/* ===== desktop sidebar (start side in RTL) ===== */}
      <aside className="glass sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-e lg:flex">
        <div className="flex items-center gap-2.5 border-b px-4 py-3.5">
          <div className="logo-glow flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-700 font-black text-white brand-serif">ن</div>
          <div className="min-w-0">
            <div className="brand-serif text-base font-extrabold leading-tight">النخبة <span className="text-gradient">QB</span></div>
            <div className="truncate text-[9px] text-muted-foreground">{L('منصة الامتحانات المتكاملة', 'All-in-one exam platform')}</div>
          </div>
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto px-2.5 py-3" aria-label={L('التنقل الرئيسي', 'Main navigation')}>
          {NAV_GROUPS.map((g) => {
            const items = g.items.filter((it) => (!it.adminOnly || isAdmin) && (!it.needsExam || selectedExamId));
            if (items.length === 0) return null;
            return (
              <div key={g.en}>
                <div className="mb-1 px-2 text-[9px] font-bold uppercase tracking-widest text-slate-400">{L(g.ar, g.en)}</div>
                <div className="space-y-0.5">
                  {items.map((it) => (
                    <SideLink key={it.key} active={view === it.key} onClick={() => setView(it.key)} icon={<it.icon className="h-4 w-4" />}>
                      {L(it.ar, it.en)}
                    </SideLink>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="space-y-2 border-t px-3 py-3">
          <div className="flex items-center justify-between rounded-lg bg-background/50 px-2.5 py-1.5" title={L('حالة المحركات', 'Engine health')}>
            <span className="text-[9px] text-muted-foreground">{L('المحركات', 'Engines')}</span>
            <span className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${health?.omrEngine ? 'bg-violet-500 shadow-[0_0_8px_oklch(0.72_0.15_300)]' : 'bg-red-400'}`} title="محرك OMR" />
              <span className={`h-2 w-2 rounded-full ${health?.pdf?.running ? 'bg-violet-500 shadow-[0_0_8px_oklch(0.72_0.15_300)]' : 'bg-amber-400'}`} title="محرك PDF" />
            </span>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-background/50 px-2.5 py-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/80 to-fuchsia-700/80 text-[11px] font-black text-white">
              {(user.name || 'أ').trim().charAt(0)}
            </div>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[11px] font-bold">{user.name}</div>
              <div className="truncate text-[9px] text-muted-foreground">{ROLE_SHORT[user.role] ?? user.role}{user.organizationName ? ` • ${user.organizationName}` : ''}</div>
            </div>
          </div>
        </div>
      </aside>

      {/* ===== main column ===== */}
      <div className="flex min-h-dvh w-full min-w-0 flex-1 flex-col">
        <header className="glass sticky top-0 z-40 border-b shadow-[0_10px_40px_-24px_oklch(0_0_0/0.55)]">
          <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2.5">
            {/* mobile drawer trigger */}
            <Sheet>
              <SheetTrigger asChild>
                <button
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border text-slate-500 transition hover:bg-accent hover:text-foreground lg:hidden"
                  aria-label={L('القائمة', 'Menu')}
                >
                  <Menu className="h-4 w-4" />
                </button>
              </SheetTrigger>
              <SheetContent side="right" className="w-72 overflow-y-auto p-0">
                <SheetHeader className="border-b px-4 py-3.5 text-start">
                  <SheetTitle className="flex items-center gap-2.5">
                    <div className="logo-glow flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-700 text-xs font-black text-white brand-serif">ن</div>
                    <span className="brand-serif text-base font-extrabold">النخبة <span className="text-gradient">QB</span></span>
                  </SheetTitle>
                </SheetHeader>
                <nav className="space-y-4 px-3 py-3" aria-label={L('التنقل الرئيسي', 'Main navigation')}>
                  {NAV_GROUPS.map((g) => {
                    const items = g.items.filter((it) => (!it.adminOnly || isAdmin) && (!it.needsExam || selectedExamId));
                    if (items.length === 0) return null;
                    return (
                      <div key={g.en}>
                        <div className="mb-1 px-2 text-[9px] font-bold uppercase tracking-widest text-slate-400">{L(g.ar, g.en)}</div>
                        <div className="space-y-0.5">
                          {items.map((it) => (
                            <SideLink
                              key={it.key}
                              active={view === it.key}
                              onClick={() => setView(it.key)}
                              icon={<it.icon className="h-4 w-4" />}
                            >
                              {L(it.ar, it.en)}
                            </SideLink>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </nav>
                <div className="border-t px-3 py-3">
                  <div className="flex items-center gap-2 rounded-xl bg-background/50 px-2.5 py-2">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/80 to-fuchsia-700/80 text-[11px] font-black text-white">
                      {(user.name || 'أ').trim().charAt(0)}
                    </div>
                    <div className="min-w-0 leading-tight">
                      <div className="truncate text-[11px] font-bold">{user.name}</div>
                      <div className="truncate text-[9px] text-muted-foreground">{ROLE_SHORT[user.role] ?? user.role}</div>
                    </div>
                  </div>
                </div>
              </SheetContent>
            </Sheet>

            {/* brand (mobile + tablet — desktop uses the sidebar) */}
            <div className="flex items-center gap-2 lg:hidden">
              <div className="logo-glow flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-700 text-xs font-black text-white brand-serif">ن</div>
              <div className="brand-serif text-base font-extrabold leading-none">النخبة <span className="text-gradient">QB</span></div>
            </div>

            <div className="ms-auto flex items-center gap-2">
              <div className="hidden items-center gap-1.5 rounded-full border border-border bg-background/40 px-2.5 py-1 md:flex" title={L('حالة المحركات', 'Engine health')}>
                <span className={`h-2 w-2 rounded-full ${health?.omrEngine ? 'bg-violet-500 shadow-[0_0_8px_oklch(0.72_0.15_300)]' : 'bg-red-400'}`} title="محرك OMR" />
                <span className={`h-2 w-2 rounded-full ${health?.pdf?.running ? 'bg-violet-500 shadow-[0_0_8px_oklch(0.72_0.15_300)]' : 'bg-amber-400'}`} title="محرك PDF" />
              </div>
              <button
                onClick={toggleTheme}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-slate-500 transition hover:bg-accent hover:text-foreground"
                title={theme === 'dark' ? L('الوضع النهاري', 'Light mode') : L('الوضع الليلي', 'Dark mode')}
                aria-label={theme === 'dark' ? L('الوضع النهاري', 'Light mode') : L('الوضع الليلي', 'Dark mode')}
              >
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
              <button
                onClick={() => setLang((v) => (v === 'ar' ? 'en' : 'ar'))}
                className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] font-bold text-slate-500 transition hover:bg-accent hover:text-foreground"
                title={L('تبديل اللغة', 'Toggle language')}
              >
                <Languages className="h-3.5 w-3.5" /> {lang === 'ar' ? 'EN' : 'ع'}
              </button>
              <div className="hidden items-center gap-2 md:flex">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/80 to-fuchsia-700/80 text-[11px] font-black text-white">
                  {(user.name || 'أ').trim().charAt(0)}
                </div>
                <div className="text-start leading-tight">
                  <div className="text-[11px] font-bold">{user.name}</div>
                  <div className="text-[9px] text-slate-500">{ROLE_SHORT[user.role] ?? user.role}</div>
                </div>
              </div>
              <button
                onClick={() => void logout()}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-red-500/10 hover:text-red-500"
                title={L('تسجيل الخروج', 'Log out')}
                aria-label={L('تسجيل الخروج', 'Log out')}
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 lg:px-6">
          {view === 'dashboard' && (
            <Dashboard
              exams={exams}
              selectedExamId={selectedExamId}
              health={{ omrEngine: health?.omrEngine, pdfRunning: health?.pdf?.running }}
              onOpen={openExam}
              onGo={setView}
              onChanged={() => { void refreshExams(); setReloadKey((k) => k + 1); }}
            />
          )}
          {view === 'bank' && <BankManager />}
          {view === 'extract' && <ExtractionStudio onGoToBank={() => setView('bank')} />}
          {view === 'design' && selectedExamId && <Designer key={selectedExamId} examId={selectedExamId} />}
          {view === 'preview' && selectedExamId && <PreviewPane examId={selectedExamId} />}
          {view === 'omr' && selectedExamId && <OmrStudio examId={selectedExamId} />}
          {view === 'scan' && <ScanStudio onScanned={() => setReloadKey((k) => k + 1)} />}
          {view === 'review' && <ReviewQueue />}
          {view === 'ocr' && <OcrImport onCreated={(examId) => { void refreshExams(); setSelectedExamId(examId); setView('design'); }} />}
          {view === 'pdf' && <PdfWorkspace onExtractPages={() => { setView('extract'); toast.info('انتقل إلى الاستخراج الذكي وارفع الملف لاستخراج الأسئلة'); }} />}
          {view === 'pdftools' && <PdfToolsPane lang={lang} />}
          {view === 'forms' && <FormsStudio lang={lang} />}
          {view === 'whiteboard' && <Whiteboard />}
          {view === 'online' && <OnlinePane />}
          {view === 'assignments' && <AssignmentsPane />}
          {view === 'students' && <StudentsPane />}
          {view === 'admin' && isAdmin && <AdminPane sessionRole={user.role} sessionOrgId={user.organizationId} />}
          {view === 'settings' && <SettingsPane />}
        </main>

        {/* Sticky footer */}
        <footer className="glass mt-auto border-t py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-1 px-4 text-[11px] text-slate-400">
            <span className="flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-primary" />
              النخبة QB — نظام بنك أسئلة متكامل بمخطط امتحاني واحد يغذي المصمم و PDF و OMR
            </span>
            <span>{user.organizationName ?? 'النخبة للتعليم'} • {ROLE_SHORT[user.role] ?? user.role} • محرك OMR: Python + OpenCV</span>
          </div>
        </footer>
      </div>
    </div>
  );
}

function SideLink({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start text-[13px] font-medium transition ${
        active
          ? 'btn-primary-grad text-white shadow-[0_8px_22px_-10px_oklch(0.55_0.18_300/0.75)]'
          : 'text-slate-500 hover:bg-accent hover:text-foreground'
      }`}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}

// ---------------- Dashboard ----------------

function Dashboard({ exams, selectedExamId, health, onOpen, onGo, onChanged }: { exams: ExamRow[]; selectedExamId: string | null; health: { omrEngine?: boolean; pdfRunning?: boolean }; onOpen: (id: string, v: View) => void; onGo: (v: View) => void; onChanged: () => void }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [direction, setDirection] = useState<'rtl' | 'ltr'>('rtl');

  const create = async () => {
    if (!title.trim()) {
      toast.error('اكتب عنوان الامتحان');
      return;
    }
    const res = await fetch('/api/exams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, subject, direction }),
    });
    if (res.ok) {
      const data = await res.json();
      toast.success('تم إنشاء الامتحان');
      setCreateOpen(false);
      setTitle('');
      onChanged();
      onOpen(data.exam?.id ?? data.id, 'design');
    } else {
      toast.error('فشل الإنشاء');
    }
  };

  const publish = async (id: string) => {
    const res = await fetch(`/api/exams/${id}/publish`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      toast.success(`تم نشر النسخة ${data.version} — لقطة ثابتة محفوظة`);
      onChanged();
    } else toast.error(data.error ?? 'فشل النشر');
  };

  const archive = async (id: string) => {
    const res = await fetch(`/api/exams/${id}`, { method: 'DELETE' });
    if (res.ok) {
      toast.success('تمت أرشفة الامتحان (السجلات محفوظة)');
      onChanged();
    }
  };

  const QUICK_ACTIONS: Array<{ key: View | 'create'; ar: string; icon: LucideIcon; needsExam?: boolean }> = [
    { key: 'create', ar: 'امتحان جديد', icon: Plus },
    { key: 'bank', ar: 'بنك الأسئلة', icon: BookOpen },
    { key: 'extract', ar: 'استخراج ذكي', icon: ScanText },
    { key: 'scan', ar: 'مسح وتصحيح', icon: ScanLine },
    { key: 'omr', ar: 'أوراق OMR', icon: Files, needsExam: true },
    { key: 'pdf', ar: 'مساحة PDF', icon: FileStack },
  ];

  return (
    <div className="animate-fade-up space-y-5" dir="rtl">
      {/* Workspace banner */}
      <PaneHeader
        icon={LayoutDashboard}
        title="مساحة العمل — الامتحانات"
        desc="أنشئ امتحانًا، صمّمه، ولّد أوراق OMR، وامسح الإجابات بنقرة واحدة"
        actions={
          <Button className="btn-primary-grad gap-1 border-0 text-white" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> امتحان جديد
          </Button>
        }
      >
        <div className="flex flex-wrap gap-2">
          <StatChip label="امتحانات" value={exams.length} />
          <StatChip label="منشورة" value={exams.filter((e) => e.status === 'PUBLISHED').length} tone="primary" />
          <StatChip label="مسودات" value={exams.filter((e) => e.status === 'DRAFT').length} tone="amber" />
          <StatChip
            label="محرك OMR"
            value={health.omrEngine ? 'يعمل' : 'متوقف'}
            tone={health.omrEngine ? 'primary' : 'red'}
          />
          <StatChip
            label="محرك PDF"
            value={health.pdfRunning ? 'يعمل' : 'بارد'}
            tone={health.pdfRunning ? 'primary' : 'amber'}
          />
        </div>
      </PaneHeader>

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {QUICK_ACTIONS.map((a) => {
          const disabled = !!a.needsExam && !selectedExamId;
          return (
            <button
              key={a.key}
              disabled={disabled}
              onClick={() => (a.key === 'create' ? setCreateOpen(true) : a.key === 'omr' && selectedExamId ? onOpen(selectedExamId, 'omr') : onGo(a.key as View))}
              className="card-hover glass flex flex-col items-start gap-2.5 rounded-2xl p-4 text-start disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="logo-glow flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-700 text-white">
                <a.icon className="h-4.5 w-4.5" />
              </span>
              <span className="text-xs font-bold">{a.ar}</span>
            </button>
          );
        })}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="text-right">إنشاء امتحان</DialogTitle>
            <DialogDescription className="text-right">أنشئ امتحانًا جديدًا بعنوان ومادة وصف دراسي، ثم افتح المصمم لإضافة الأسئلة.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>عنوان الامتحان</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="امتحان الرياضيات — أكتوبر" /></div>
            <div><Label>المادة</Label><Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="رياضيات" /></div>
            <div>
              <Label>اتجاه الورقة</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as 'rtl' | 'ltr')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="rtl">عربي (يمين ← يسار)</SelectItem>
                  <SelectItem value="ltr">English (left → right)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button className="btn-primary-grad w-full border-0 text-white" onClick={() => void create()}>إنشاء والانتقال للمصمم</Button>
          </div>
        </DialogContent>
      </Dialog>

      {exams.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="لا توجد امتحانات بعد"
          hint="ابدأ بإنشاء أول امتحان، أو استورد أسئلتك من صور وملفات قديمة عبر الاستخراج الذكي ثم أحِلها إلى امتحان"
        >
          <Button size="sm" className="btn-primary-grad gap-1 border-0 text-white" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> إنشاء أول امتحان
          </Button>
        </EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {exams.map((exam) => (
            <Card key={exam.id} className="card-hover">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold">{exam.title}</div>
                    <div className="mt-0.5 text-[11px] text-slate-500">{exam.subject ?? '—'} • {exam.questionCount} سؤال</div>
                  </div>
                  <Badge className={exam.status === 'PUBLISHED' ? 'bg-primary/15 text-primary' : exam.status === 'ARCHIVED' ? 'bg-slate-500/15 text-slate-500' : 'bg-amber-500/15 text-amber-600'}>
                    {exam.status === 'PUBLISHED' ? 'منشور' : exam.status === 'ARCHIVED' ? 'مؤرشف' : 'مسودة'}
                  </Badge>
                </div>
                <div className="mt-2 flex gap-1.5 text-[10px] text-slate-400">
                  <span>نسخة {exam.currentVersion}</span>
                  {exam.omrEnabled && <span className="rounded bg-primary/15 px-1.5 text-primary">OMR مفعّل</span>}
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={() => onOpen(exam.id, 'design')}><PencilRuler className="h-3 w-3" /> تصميم</Button>
                  <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={() => onOpen(exam.id, 'preview')}><Eye className="h-3 w-3" /> معاينة</Button>
                  <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={() => onOpen(exam.id, 'omr')}><Files className="h-3 w-3" /> OMR</Button>
                  {exam.status !== 'PUBLISHED' && (
                    <Button size="sm" className="btn-primary-grad h-7 gap-1 border-0 text-[11px] text-white" onClick={() => void publish(exam.id)}><GraduationCap className="h-3 w-3" /> نشر</Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-7 gap-1 text-[11px] text-slate-400" onClick={() => void archive(exam.id)}><Archive className="h-3 w-3" /> أرشفة</Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function StatChip({ label, value, tone = 'neutral' }: { label: string; value: string | number; tone?: 'neutral' | 'primary' | 'amber' | 'red' }) {
  const toneCls =
    tone === 'primary' ? 'text-primary' : tone === 'amber' ? 'text-amber-500' : tone === 'red' ? 'text-red-400' : 'text-foreground';
  return (
    <div className="rounded-xl border border-border bg-background/40 px-3 py-1.5 text-center">
      <div className={`text-sm font-extrabold leading-none ${toneCls}`}>{value}</div>
      <div className="mt-1 text-[9px] text-slate-500">{label}</div>
    </div>
  );
}

// ---------------- Preview ----------------

function PreviewPane({ examId }: { examId: string }) {
  const [html, setHtml] = useState<string>('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/exams/${examId}/preview`);
        const text = await r.text();
        if (!cancelled) {
          setHtml(text);
          setBusy(false);
        }
      } catch {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [examId]);

  const [pdfBusy, setPdfBusy] = useState(false);

  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      await downloadFile(`/api/exams/${examId}/pdf`, 'exam.pdf', 'تم تنزيل PDF (نص متجهي حقيقي)');
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div className="space-y-3" dir="rtl">
      <PaneHeader
        icon={Eye}
        title="معاينة الامتحان"
        desc="مطابقة ١:١ مع ملف PDF النهائي — ما تراه هنا هو ما يُطبع"
        actions={
          <Button size="sm" className="btn-primary-grad gap-1 border-0 text-white" disabled={pdfBusy} onClick={() => void downloadPdf()}>
            <FileDown className="h-4 w-4" /> {pdfBusy ? 'جارٍ التوليد…' : 'تنزيل PDF'}
          </Button>
        }
      />
      <Card className="overflow-hidden">
        {busy ? (
          <CardContent className="py-20 text-center text-sm text-slate-400">جارٍ الرسم…</CardContent>
        ) : (
          <iframe title="exam-preview" srcDoc={html} className="h-[calc(100vh-16rem)] w-full bg-slate-200" />
        )}
      </Card>
    </div>
  );
}

// ---------------- OMR Studio ----------------

function OmrStudio({ examId }: { examId: string }) {
  const [detail, setDetail] = useState<ExamDetail | null>(null);
  const [copies, setCopies] = useState(30);
  const [busy, setBusy] = useState<string>('');
  // ---- answer key (guide answer) draft ----
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch(`/api/exams/${examId}`);
    const data: ExamDetail = await res.json();
    setDetail(data);
    setKeyDraft(data.answerKey ?? {});
  }, [examId]);

  useEffect(() => {
    void load();
  }, [load]);

  const enableOmr = async (enabled: boolean) => {
    if (!detail) return;
    await fetch(`/api/exams/${examId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: { ...detail.document, omr: { ...detail.document.omr, enabled } } }),
    });
    toast.success(enabled ? 'تم تفعيل OMR — انشر الامتحان لتوليد القالب' : 'تم تعطيل OMR');
    void load();
  };

  const download = async (url: string, name: string, kind: string) => {
    setBusy(kind);
    try {
      await downloadFile(url, name, kind === 'pdf' ? `تم تنزيل ${name}` : 'تم التنزيل ✓');
    } finally {
      setBusy('');
    }
  };

  // ---- answer key actions ----
  const mcqQuestions = (detail?.document.questions ?? []).filter(
    (q) => q.type === 'mcq' && Array.isArray(q.options) && q.options.length >= 2
  );
  const setKeyCount = mcqQuestions.filter((q) => (keyDraft[q.id] ?? '') !== '').length;

  const toggleKey = (qid: string, letter: string) => {
    setKeyDraft((prev) => ({ ...prev, [qid]: prev[qid] === letter ? '' : letter }));
  };

  const saveKey = async () => {
    if (!detail) return;
    setBusy('key');
    try {
      const clean: Record<string, string> = {};
      for (const [qid, letter] of Object.entries(keyDraft)) {
        if (letter) clean[qid] = letter;
      }
      const res = await fetch(`/api/exams/${examId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answerKey: clean }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error ?? 'فشل حفظ مفتاح التصحيح');
        return;
      }
      toast.success(`تم حفظ مفتاح التصحيح (${Object.keys(clean).length} سؤالًا)`);
      void load();
    } finally {
      setBusy('');
    }
  };

  const republish = async () => {
    setBusy('publish');
    try {
      const res = await fetch(`/api/exams/${examId}/publish`, { method: 'POST' });
      const d = await res.json();
      if (res.ok) {
        toast.success(`تم إنشاء النسخة ${d.version} بمفتاح التصحيح والقالب المجمّدين`);
        void load();
      } else {
        toast.error(d.error ?? 'فشل إعادة النشر');
      }
    } finally {
      setBusy('');
    }
  };

  if (!detail) return <EmptyState icon={Files} title="جارٍ التحميل…" hint="يتم جلب تفاصيل الامتحان ومفتاح التصحيح من الخادم" />;
  const published = detail.exam.status === 'PUBLISHED' && detail.versions.length > 0;
  const latestVersion = detail.versions[0]; // versions are ordered desc (newest first)
  const frozenCount = latestVersion?.answerKeyCount ?? -1;
  const draftClean: Record<string, string> = {};
  for (const [qid, letter] of Object.entries(keyDraft)) if (letter) draftClean[qid] = letter;
  const draftHash = keyFingerprint(draftClean);
  const keyDiffers = published && !!latestVersion?.answerKeyHash && draftHash !== latestVersion.answerKeyHash;
  const missingKey = mcqQuestions.length - setKeyCount;

  return (
    <div className="space-y-4" dir="rtl">
      <PaneHeader
        icon={Files}
        title="استوديو أوراق OMR"
        desc="ورقة إجابة بفقاعات و QR — فعّل OMR، حدّد مفتاح التصحيح، انشر، ثم اطبع وامسح"
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">التصحيح الآلي (OMR)</div>
                <div className="text-[11px] text-slate-500">ورقة إجابة قابلة للقراءة الضوئية بفقاعات مواضعها مخزنة في القالب</div>
              </div>
              <Button size="sm" variant={detail.document.omr.enabled ? 'secondary' : 'outline'} onClick={() => void enableOmr(!detail.document.omr.enabled)}>
                {detail.document.omr.enabled ? 'مفعّل ✓' : 'معطّل'}
              </Button>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
              التدفق: فعّل OMR → حدّد مفتاح التصحيح (دليل الإجابة) → انشر الامتحان (يُجمّد المفتاح ويُنشأ قالب إحداثيات ثابت) → اطبع الأوراق → امسح → راجع الثقة → صحّح.
              كل ورقة تحمل QR يربطها بنسخة الامتحان — أوراق النسخ القديمة تُصحح بمفاتيحها القديمة.
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="text-sm font-semibold">توليد الأوراق {published ? `(النسخة ${latestVersion?.version})` : ''}</div>
            {!published ? (
              <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700">انشر الامتحان أولًا من الرئيسية (أو من بطاقة مفتاح التصحيح أدناه) لتوليد قالب OMR.</div>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <Label className="text-xs">عدد النسخ</Label>
                  <Slider value={[copies]} min={1} max={200} step={1} onValueChange={([v]) => setCopies(v)} className="flex-1" />
                  <span className="w-8 text-center text-sm font-bold">{copies}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" className="gap-1 bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy !== ''} onClick={() => void download(`/api/versions/${latestVersion?.id}/pdf?type=omr&copies=${copies}`, 'omr-sheets.pdf', 'pdf')}>
                    <FileDown className="h-4 w-4" /> {busy === 'pdf' ? 'جارٍ التوليد…' : `طباعة ${copies} ورقة (PDF)`}
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1" disabled={busy !== ''} onClick={() => void download(`/api/versions/${latestVersion?.id}/omr-png?sheet=0`, 'omr-sheet-300dpi.png', 'png')}>
                    <FileDown className="h-4 w-4" /> {busy === 'png' ? '…' : 'ورقة PNG 300dpi (اختبار)'}
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1" onClick={() => void download(`/api/versions/${latestVersion?.id}/pdf?type=exam`, 'exam.pdf', 'exam')}>
                    <BookOpen className="h-4 w-4" /> PDF الامتحان
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- Answer Key (guide answer) editor ---- */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              <div>
                <div className="text-sm font-semibold">مفتاح التصحيح — دليل الإجابة (Guide Answer)</div>
                <div className="text-[11px] text-slate-500">اختر الإجابة الصحيحة لكل سؤال؛ يُستخدم المفتاح في التصحيح الآلي عند مسح الأوراق</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={missingKey === 0 ? 'default' : 'destructive'} className={missingKey === 0 ? 'bg-primary' : ''}>
                {setKeyCount} / {mcqQuestions.length} سؤالًا
              </Badge>
              {mcqQuestions.length > 0 && (
                <>
                  <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" disabled={busy !== '' || setKeyCount === 0} onClick={() => setKeyDraft({})}>
                    <Eraser className="h-3.5 w-3.5" /> مسح الكل
                  </Button>
                  <Button size="sm" className="h-8 gap-1 bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy !== '' || mcqQuestions.length === 0} onClick={() => void saveKey()}>
                    {busy === 'key' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />} حفظ المفتاح
                  </Button>
                </>
              )}
            </div>
          </div>

          {mcqQuestions.length === 0 ? (
            <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700">
              لا توجد أسئلة اختيار من متعدد في المسودة. أضف أسئلة MCQ من المصمم (بنك الأسئلة) لتتمكن من تحديد دليل الإجابة.
            </div>
          ) : (
            <>
              {missingKey > 0 && (
                <div className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-700">
                  ⚠ {missingKey} سؤالًا بدون إجابة صحيحة — سيُحتسب فارغًا في التصحيح الآلي حتى تحدد إجابته.
                </div>
              )}
              <div className="max-h-96 space-y-1.5 overflow-y-auto pl-1 omr-key-scroll">
                {mcqQuestions.map((q) => {
                  const current = keyDraft[q.id] ?? '';
                  return (
                    <div key={q.id} className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
                      <span className="w-8 shrink-0 text-sm font-bold text-slate-700">{q.number}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-500" title={q.prompt}>{q.prompt || '—'}</span>
                      <div className="flex shrink-0 gap-1">
                        {q.options.map((o) => {
                          const active = current === o.id;
                          return (
                            <button
                              key={o.id}
                              type="button"
                              onClick={() => toggleKey(q.id, o.id)}
                              aria-pressed={active}
                              aria-label={`سؤال ${q.number}: ${o.id}`}
                              title={o.text || `الخيار ${o.id}`}
                              className={`h-7 w-7 rounded-full border text-xs font-bold transition ${
                                active
                                  ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                                  : 'border-slate-300 bg-white text-slate-600 hover:border-primary/60 hover:text-primary'
                              }`}
                            >
                              {o.id}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* publish-freeze notice */}
          {mcqQuestions.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3">
              <div className="text-[11px] leading-relaxed text-slate-600">
                {published ? (
                  <>
                    النسخة المنشورة (<b>النسخة {latestVersion?.version}</b>) مجمّدة على مفتاح بـ <b>{frozenCount}</b> سؤالًا
                    {frozenCount === 0 && <span className="text-red-600"> — لم يُحدَّد أي مفتاح وقت النشر!</span>}
                    {keyDiffers && <span className="text-amber-700"> — المفتاح الحالي مختلف؛ أعد النشر لتجميد المفتاح الجديد.</span>}
                  </>
                ) : (
                  <>المفتاح يُجمَّد عند النشر — انشر الامتحان لتوليد قالب OMR مع هذا المفتاح.</>
                )}
              </div>
              {mcqQuestions.length > 0 && setKeyCount < mcqQuestions.length && (
                <span className="text-[10px] text-amber-700">يُنصح بحفظ مفتاح كامل قبل النشر</span>
              )}
              {(!published || keyDiffers) && (
                <Button size="sm" className="h-8 gap-1 bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy !== ''} onClick={() => void republish()}>
                  {busy === 'publish' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
                  {published ? 'إعادة النشر بنسخة جديدة' : 'نشر الامتحان الآن'}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------- Students ----------------

function StudentsPane() {
  const [students, setStudents] = useState<{ id: string; code: string; name: string; classroom: string | null }[]>([]);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [classroom, setClassroom] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/students');
    setStudents(await res.json());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/students');
      const data = await res.json();
      if (!cancelled) setStudents(data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const add = async () => {
    if (!code.trim() || !name.trim()) {
      toast.error('أدخل الرقم والاسم');
      return;
    }
    const res = await fetch('/api/students', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, classroom }),
    });
    if (res.ok) {
      setCode(''); setName(''); setClassroom('');
      toast.success('تمت الإضافة');
      void load();
    } else {
      const d = await res.json();
      toast.error(d.error ?? 'فشل');
    }
  };

  return (
    <div className="space-y-4" dir="rtl">
      <PaneHeader
        icon={Users}
        title="الطلاب"
        desc="سجل الطلاب وأكوادهم وفصولهم — يُستخدم في الأونلاين والواجبات وورق OMR"
      />
      <Card><CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div><Label className="text-[10px]">الرقم</Label><Input className="h-9 w-32" value={code} onChange={(e) => setCode(e.target.value)} /></div>
        <div><Label className="text-[10px]">الاسم</Label><Input className="h-9 w-48" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><Label className="text-[10px]">الفصل</Label><Input className="h-9 w-28" value={classroom} onChange={(e) => setClassroom(e.target.value)} /></div>
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => void add()}><Plus className="h-4 w-4" /> إضافة</Button>
      </CardContent></Card>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead><tr className="border-b bg-slate-50 text-right text-xs text-slate-500">
            <th className="p-3">الرقم</th><th className="p-3">الاسم</th><th className="p-3">الفصل</th>
          </tr></thead>
          <tbody>
            {students.map((s) => (
              <tr key={s.id} className="border-b last:border-0">
                <td className="p-3 font-mono text-xs">{s.code}</td>
                <td className="p-3">{s.name}</td>
                <td className="p-3 text-slate-500">{s.classroom ?? '—'}</td>
              </tr>
            ))}
            {students.length === 0 && <tr><td colSpan={3} className="p-8 text-center text-slate-400">لا يوجد طلاب</td></tr>}
          </tbody>
        </table>
      </CardContent></Card>
    </div>
  );
}

// ---------------- Settings (calibration + OCR test) ----------------

function SettingsPane() {
  const [config, setConfig] = useState<{ filled: number; empty: number; ambiguousMargin: number; minAbsoluteFill: number; name?: string } | null>(null);
  const [ocrText, setOcrText] = useState('');
  const [ocrBusy, setOcrBusy] = useState(false);

  useEffect(() => {
    void fetch('/api/calibration').then(async (r) => {
      const d = await r.json();
      setConfig(d.config ?? d);
    });
  }, []);

  const save = async () => {
    if (!config) return;
    const res = await fetch('/api/calibration', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: config.name ?? 'مخصص', config }),
    });
    if (res.ok) toast.success('تم حفظ معايرة العتبات');
    else toast.error('فشل الحفظ');
  };

  const testOcr = async (file: File) => {
    setOcrBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const res = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: dataUrl, lang: 'ara' }),
      });
      const d = await res.json();
      setOcrText(d.text ?? d.error ?? '');
    } finally {
      setOcrBusy(false);
    }
  };

  if (!config) return <EmptyState icon={Activity} title="جارٍ التحميل…" hint="يتم تحميل إعدادات المعايرة من الخادم" />;

  return (
    <div className="space-y-4" dir="rtl">
      <PaneHeader
        icon={Settings2}
        title="الإعدادات"
        desc="معايرة قارئ OMR، اختبار OCR، وصحة الأنظمة"
      />
      <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold"><Activity className="h-4 w-4 text-primary" /> معايرة قارئ OMR</div>
          <p className="text-[11px] leading-relaxed text-slate-500">
            العتبات مأخوذة من معايرة فعلية (قلم رصاص/حبر/إضاءة منخفضة) عبر حزمة الاختبار.
            filled: نسبة التظليل لاعتبار الفقاعة معلّمة • empty: أقل من يُعتبر فارغة.
          </p>
          {([
            ['filled', 'حد التظليل (filled)', 0, 1],
            ['empty', 'حد الفارغ (empty)', 0, 1],
            ['ambiguousMargin', 'هامش الالتباس', 0, 0.5],
            ['minAbsoluteFill', 'أدنى تظليل مطلق', 0, 0.5],
          ] as const).map(([key, label, min, max]) => (
            <div key={key}>
              <div className="mb-1 flex justify-between text-xs"><Label>{label}</Label><span className="font-bold">{config[key].toFixed(2)}</span></div>
              <Slider value={[config[key]]} min={min} max={max} step={0.01} onValueChange={([v]) => setConfig({ ...config, [key]: v })} />
            </div>
          ))}
          <Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => void save()}>حفظ المعايرة</Button>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="text-sm font-semibold">اختبار OCR (منفصل عن OMR)</div>
          <p className="text-[11px] text-slate-500">العربية عبر نموذج رؤية لغوي، الإنجليزية عبر Tesseract. لا يُستخدم OCR في قراءة الفقاعات أبدًا.</p>
          <input
            type="file"
            accept="image/*"
            className="block w-full text-xs"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void testOcr(f);
            }}
          />
          {ocrBusy && <div className="text-xs text-primary">جارٍ الاستخراج…</div>}
          <Textarea className="h-40 text-xs" value={ocrText} onChange={(e) => setOcrText(e.target.value)} placeholder="النص المستخرج…" />
        </CardContent>
      </Card>
      <Card className="md:col-span-2">
        <CardContent className="p-4">
          <div className="text-sm font-semibold">صحة الأنظمة</div>
          <HealthTable />
        </CardContent>
      </Card>
      </div>
    </div>
  );
}

function HealthTable() {
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    void fetch('/api/health').then(async (r) => setHealth(await r.json()));
  }, []);
  if (!health) return <div className="py-4 text-center text-xs text-slate-400">…</div>;
  const aiHealth = health.ai as { mode?: string; model?: string; error?: string } | undefined;
  const aiMode = aiHealth?.mode ?? 'none';
  const aiOk = aiMode === 'env' || aiMode === 'zai';
  const aiLabel = aiMode === 'env' ? `مزود خارجي${aiHealth?.model ? ` (${aiHealth.model})` : ''}` : aiMode === 'zai' ? 'مدمج (بيئة التطوير)' : 'غير مهيأ';
  const rows: [string, boolean][] = [
    ['قاعدة البيانات', Boolean(health.db)],
    ['محرك PDF (Chromium)', Boolean((health.pdf as { ok?: boolean })?.ok ?? (health.pdf as { running?: boolean })?.running)],
    ['محرك OMR (Python + OpenCV)', Boolean(health.omrEngine)],
  ];
  return (
    <div className="mt-2 space-y-1.5 text-xs">
      {rows.map(([label, ok]) => (
        <div key={label} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
          <span>{label}</span>
          <Badge className={ok ? 'bg-primary/15 text-primary' : 'bg-red-100 text-red-600'}>{ok ? 'يعمل' : 'متوقف'}</Badge>
        </div>
      ))}
      <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
        <span>الذكاء الاصطناعي (الاستخراج الذكي + توليد الأسئلة)</span>
        <Badge className={aiOk ? 'bg-primary/15 text-primary' : 'bg-red-100 text-red-600'}>{aiLabel}</Badge>
      </div>
    </div>
  );
}
