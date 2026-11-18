'use client';

// ============================================================
// ALNOKHBA QB — Public landing page ("Amethyst Royale")
// Navbar → hero → stats → AI highlight → features → tools →
// how-it-works → roles → FAQ → CTA → footer
// Pure CSS visuals (no raster assets) + shared aurora/grid backdrop.
// All accents use semantic tokens (primary/gold) so the whole page
// follows the site theme automatically.
// "ابدأ الآن" switches to the embedded LoginView.
// ============================================================

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import LoginView from './LoginView';
import {
  ArrowLeft, BookOpen, Camera, CheckCircle2, ClipboardList, FileStack, Files, GraduationCap,
  Landmark, Layers, PenTool, ScanLine, ScanSearch, ScanText, School, ShieldCheck, Sparkles,
  Users, Wand2, BrainCircuit, FileCheck2, BadgeCheck, ChevronDown,
} from 'lucide-react';

const FEATURES = [
  {
    icon: ScanText,
    title: 'استخراج ذكي من أي مصدر',
    desc: 'ارفع صورة أو PDF لامتحان قديم — نموذج رؤية لغوي يقرأ الأسئلة، يصنّفها، ويضيفها للمراجعة بثقة عالية.',
    tags: ['OCR + VLM', 'عربي وإنجليزي'],
  },
  {
    icon: BookOpen,
    title: 'بنك أسئلة منظم',
    desc: 'مادة → وحدة → درس. وسم، صعوبة، علامات، كشف تكرار ذكي يدعم صيغ العربية، واستيراد جماعي.',
    tags: ['تصنيف هرمي', 'كشف التكرار'],
  },
  {
    icon: PenTool,
    title: 'مصمم امتحانات مرن',
    desc: 'اسحب الأسئلة من البنك ووفّق الأوراق: إصدارات متعددة بترتيب مختلف، رؤوس مخصصة، ومعادلات ورموز.',
    tags: ['إصدارات A/B', 'ورقة 1:1'],
  },
  {
    icon: ScanLine,
    title: 'تصحيح OMR فوري',
    desc: 'أوراق إجابة بفقاعات و QR — امسح بالكاميرا أو الماسح، يقرأ المحرك الفقاعات ويصحح مئات الأوراق في دقائق.',
    tags: ['Python + OpenCV', 'QR للنسخ'],
  },
  {
    icon: GraduationCap,
    title: 'اختبارات أونلاين',
    desc: 'انشر الامتحان رقميًا مع ساعة خادم ضد التلاعب، مراقبة حية للتقدم، ونتائج تصل لحظة التسليم.',
    tags: ['مراقبة حية', 'ساعة خادم'],
  },
  {
    icon: ClipboardList,
    title: 'واجبات ومتابعة',
    desc: 'ارفع الواجبات من الهاتف، راجعها وصححها، وتابع حالة التسليم لكل فصل — كل شيء في مكان واحد.',
    tags: ['رفع من الجوال', 'حالات التسليم'],
  },
];

const TOOLS = [
  { icon: FileStack, label: 'مساحة PDF' },
  { icon: Layers, label: 'أدوات PDF (دمج • تقسيم • ضغط)' },
  { icon: ScanSearch, label: 'قارئ النماذج' },
  { icon: Wand2, label: 'سبورة ذكية' },
  { icon: ScanText, label: 'استيراد OCR' },
  { icon: CheckCircle2, label: 'قائمة مراجعة القراءات' },
];

const STEPS = [
  {
    n: '١',
    title: 'جهّز أسئلتك',
    desc: 'أنشئ الامتحان، أو استورد الأسئلة من صور وملفات PDF قديمة بالاستخراج الذكي، أو ولّدها بالذكاء الاصطناعي.',
  },
  {
    n: '٢',
    title: 'صمّم وانشر',
    desc: 'رتب الورقة في المصمم، فعّل OMR وحدد مفتاح التصحيح، ثم انشر — PDF متجهي وأوراق إجابة بضغطة.',
  },
  {
    n: '٣',
    title: 'امسح وصحّح',
    desc: 'امسح الأوراق بالكاميرا، راجع القراءات غير المؤكدة، وصدّر النتائج — دقائق بدل ساعات.',
  },
];

const ROLES = [
  {
    icon: School,
    title: 'للمعلم',
    points: ['بنك أسئلة يعاد استخدامه كل عام', 'ورق وطباعة متطابقة ١:١', 'تصحيح آلي فوري'],
  },
  {
    icon: Landmark,
    title: 'للإدارة',
    points: ['صلاحيات وأدوار لكل مستخدم', 'سجل تدقيق كامل للعمليات', 'مؤسسات وفصول متعددة'],
  },
  {
    icon: Users,
    title: 'للطالب',
    points: ['امتحان أونلاين بسيط من المتصفح', 'رفع الواجبات من الجوال', 'نتائج وتغذية راجعة سريعة'],
  },
];

const FAQS = [
  {
    q: 'هل تدعم المنصة اللغة العربية بالكامل؟',
    a: 'نعم — الواجهة، الامتحانات، أوراق OMR، والاستخراج الذكي كلها مصممة للعربية أولًا مع دعم كامل لاتجاه RTL، والمحتوى الإنجليزي مدعوم في الأسئلة والأوراق عند الحاجة.',
  },
  {
    q: 'كيف يعمل التصحيح الآلي للأوراق الورقية؟',
    a: 'تُطبع أوراق إجابة بفقاعات ورمز QR يحدد النسخة، ثم تمسح الأوراق بالكاميرا أو الماسح الضوئي. يقرأ المحرك الفقاعات ويقارنها بمفتاح التصحيح، والقراءات غير المؤكدة تذهب لقائمة مراجعة قبل اعتماد النتيجة.',
  },
  {
    q: 'هل الأسئلة المولّدة بالذكاء الاصطناعي تُنشر مباشرة؟',
    a: 'لا — كل سؤال يولّده الذكاء الاصطناعي يصل بحالة «بانتظار المراجعة» ولا يدخل البنك النهائي إلا بعد موافقة المعلم، مع بيان السؤال والخيارات والإجابة النموذجية والتفسير.',
  },
  {
    q: 'هل يمكن الاستخدام من الهاتف؟',
    a: 'نعم، المسح بالكاميرا الحية، رفع الواجبات، الامتحانات الأونلاين، ومراقبة النتائج — كلها تعمل من متصفح الجوال دون تثبيت أي تطبيق.',
  },
  {
    q: 'هل بيانات مدرستي آمنة؟',
    a: 'كل مؤسسة بياناتها معزولة، والدخول محمي بأدوار وصلاحيات (مشرف مؤسسة / معلم / طالب)، وكل عملية حساسة تُسجَّل في سجل تدقيق كامل يمكن مراجعته في أي وقت.',
  },
];

export default function LandingView({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [mode, setMode] = useState<'landing' | 'login'>('landing');

  if (mode === 'login') {
    return <LoginView onLoggedIn={onLoggedIn} onBack={() => setMode('landing')} />;
  }

  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });

  return (
    <div dir="rtl" className="flex min-h-dvh flex-col">
      {/* ---------- glass navbar ---------- */}
      <header className="glass sticky top-0 z-40 border-b">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
          <div className="logo-glow flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-700 font-black text-white brand-serif">ن</div>
          <div className="brand-serif text-lg font-extrabold leading-none">
            النخبة <span className="text-gradient">QB</span>
          </div>
          <nav className="mx-4 hidden items-center gap-1 text-xs font-medium text-muted-foreground md:flex">
            <button className="rounded-lg px-3 py-1.5 transition hover:bg-accent hover:text-foreground" onClick={() => go('features')}>الميزات</button>
            <button className="rounded-lg px-3 py-1.5 transition hover:bg-accent hover:text-foreground" onClick={() => go('ai')}>الذكاء الاصطناعي</button>
            <button className="rounded-lg px-3 py-1.5 transition hover:bg-accent hover:text-foreground" onClick={() => go('steps')}>كيف تعمل</button>
            <button className="rounded-lg px-3 py-1.5 transition hover:bg-accent hover:text-foreground" onClick={() => go('roles')}>لمن؟</button>
            <button className="rounded-lg px-3 py-1.5 transition hover:bg-accent hover:text-foreground" onClick={() => go('faq')}>الأسئلة الشائعة</button>
          </nav>
          <div className="ms-auto flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setMode('login')}>دخول المعلمين</Button>
            <Button size="sm" className="btn-primary-grad h-8 gap-1 border-0 text-xs text-white" onClick={() => setMode('login')}>
              ابدأ الآن <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </header>

      {/* ---------- hero ---------- */}
      <section className="hero-halo relative mx-auto w-full max-w-6xl px-4 pb-16 pt-14 sm:pt-20">
        <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="animate-fade-up">
            <Badge className="gap-1.5 border border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300" variant="outline">
              <Sparkles className="h-3.5 w-3.5" />
              مدعوم بالذكاء الاصطناعي — استخراج وتوليد أسئلة
            </Badge>
            <h1 className="brand-serif mt-4 text-4xl font-black leading-[1.25] sm:text-5xl sm:leading-[1.25]">
              بنك أسئلة، مصمم امتحانات، وتصحيح آلي
              <span className="text-gradient"> ورقيًا ورقميًا </span>
              في منصة واحدة
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              من الصورة الممسوحة إلى ورقة الامتحان ثم درجة الطالب — النخبة QB يستخرج الأسئلة بالذكاء الاصطناعي،
              يصمم الأوراق، ويصحح مئات أوراق OMR بالكاميرا في دقائق. مصمم للمدرسة العربية أولًا.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button size="lg" className="btn-primary-grad gap-2 border-0 text-white" onClick={() => setMode('login')}>
                ابدأ الآن — مجانًا <ArrowLeft className="h-4 w-4" />
              </Button>
              <Button size="lg" variant="outline" className="gap-2" onClick={() => go('steps')}>
                شاهد كيف تعمل <ChevronDown className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-violet-500" /> دخول محمي بصلاحيات وأدوار</span>
              <span className="flex items-center gap-1.5"><Camera className="h-3.5 w-3.5 text-violet-500" /> يعمل من متصفح الجوال مباشرة</span>
              <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-violet-500" /> دعم كامل للعربية و RTL</span>
            </div>
          </div>

          {/* hero mock — pure CSS app window */}
          <div className="relative animate-fade-up" style={{ animationDelay: '120ms' }}>
            <div className="hero-mock relative rounded-3xl p-4 sm:p-5">
              <div className="mb-3 flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-violet-400/70" />
                <span className="ms-2 text-[10px] text-muted-foreground">alnokhba-qb • مساحة العمل</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { t: 'امتحانات', v: '١٤', tone: 'text-violet-500' },
                  { t: 'منشورة', v: '٩', tone: 'text-foreground' },
                  { t: 'مصححة', v: '٤٧٢', tone: 'text-amber-500' },
                ].map((s) => (
                  <div key={s.t} className="rounded-xl border border-border bg-background/60 p-3 text-center">
                    <div className={`text-xl font-extrabold stat-number ${s.tone}`}>{s.v}</div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">{s.t}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 rounded-xl border border-border bg-background/60 p-3.5">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold">امتحان الرياضيات — منتصف الفصل</div>
                  <Badge className="bg-violet-600/15 text-violet-600 dark:text-violet-300">منشور</Badge>
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span>٢٥ سؤالًا</span><span>•</span><span>OMR مفعّل</span><span>•</span><span>نسخة B</span>
                </div>
                <div className="mt-2.5 space-y-1.5">
                  {['٧٢٪', '٨٩٪', '٩٦٪'].map((w, i) => (
                    <div key={i} className="h-1.5 rounded-full bg-muted">
                      <div className="h-full rounded-full bg-gradient-to-l from-violet-500 to-fuchsia-400" style={{ width: w }} />
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between rounded-xl border border-border bg-background/60 p-3">
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <BrainCircuit className="h-3.5 w-3.5 text-violet-500" />
                  استخراج ذكي — ٣ أسئلة في ٨ ثوانٍ
                </div>
                <div className="text-xs font-extrabold text-amber-500">٩٨٪ ثقة</div>
              </div>
            </div>
            {/* floating badges */}
            <div className="animate-float absolute -top-4 end-4 hidden rounded-2xl border border-border bg-card/90 px-3 py-2 text-center shadow-xl backdrop-blur sm:block">
              <div className="text-[9px] text-muted-foreground">وقت التصحيح</div>
              <div className="text-sm font-extrabold text-violet-500">-٩٥٪</div>
            </div>
            <div className="animate-float-slow absolute -bottom-5 start-6 hidden rounded-2xl border border-border bg-card/90 px-3 py-2 text-center shadow-xl backdrop-blur sm:block">
              <div className="text-[9px] text-muted-foreground">أسئلة مستخرجة بالذكاء الاصطناعي</div>
              <div className="text-sm font-extrabold text-amber-500">١٢٤٠ سؤالًا</div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- stats band ---------- */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <div className="glass grid grid-cols-2 gap-px overflow-hidden rounded-2xl md:grid-cols-4">
          {[
            { v: '+١٨', t: 'أداة متكاملة في مكان واحد' },
            { v: '٣', t: 'محركات: VLM • OMR • PDF' },
            { v: '١٠٠٪', t: 'دعم للعربية واتجاه RTL' },
            { v: 'دقائق', t: 'تصحيح دفعة كاملة بالكاميرا' },
          ].map((s) => (
            <div key={s.t} className="flex flex-col items-center gap-1 px-4 py-6 text-center">
              <div className="brand-serif text-2xl font-black text-gradient sm:text-3xl stat-number">{s.v}</div>
              <div className="text-[11px] text-muted-foreground">{s.t}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- AI highlight ---------- */}
      <section id="ai" className="anchor-scroll mx-auto max-w-6xl px-4 pb-16">
        <div className="rounded-3xl bg-gradient-to-br from-violet-500/50 via-fuchsia-500/20 to-amber-400/50 p-[1.5px] shadow-[0_20px_60px_-30px_oklch(0.55_0.18_300/0.5)]">
        <div className="glass relative overflow-hidden rounded-[calc(1.5rem-1.5px)] p-6 sm:p-8">
          <div className="pointer-events-none absolute -top-24 end-0 h-56 w-56 rounded-full bg-violet-500/15 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 start-1/4 h-56 w-56 rounded-full bg-amber-400/10 blur-3xl" />
          <div className="relative grid items-center gap-8 lg:grid-cols-[1fr_1fr]">
            <div>
              <Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300">
                <Sparkles className="me-1.5 h-3.5 w-3.5" /> الذكاء الاصطناعي
              </Badge>
              <h2 className="brand-serif mt-3 text-3xl font-black">
                فكّك أي امتحان قديم — أو دع الذكاء الاصطناعي <span className="text-gradient">يكتب أسئلتك</span>
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                نموذج رؤية لغوي يقرأ أوراقك الممسوحة ويستخرج الأسئلة بإجاباتها وتفسيراتها، ومولّد أسئلة يكتب أسئلة جديدة
                حسب المادة والصف والصعوبة — والقرار النهائي دائمًا للمعلم.
              </p>
              <ul className="mt-4 space-y-2.5">
                {[
                  { icon: ScanText, t: 'استخراج من صور و PDF — عربي وإنجليزي، خيارات ومقالي وصح وخطأ' },
                  { icon: BrainCircuit, t: 'توليد أسئلة جديدة ببيانات المادة والوحدة ومستوى الصعوبة' },
                  { icon: FileCheck2, t: 'كل سؤال يمر بمراجعة المعلم قبل دخوله البنك — لا نشر تلقائي' },
                ].map((li) => (
                  <li key={li.t} className="flex items-start gap-2.5 text-xs text-muted-foreground">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-violet-500/12 text-violet-500">
                      <li.icon className="h-3.5 w-3.5" />
                    </span>
                    {li.t}
                  </li>
                ))}
              </ul>
            </div>

            {/* extraction review mock */}
            <div className="rounded-2xl border border-border bg-background/70 p-4 backdrop-blur">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-bold">
                  <ScanText className="h-4 w-4 text-violet-500" />
                  مراجعة الاستخراج — اختبار العلوم.png
                </div>
                <Badge variant="outline" className="text-[10px] border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">٣ أسئلة</Badge>
              </div>
              <div className="mt-3 space-y-2.5">
                {[
                  { q: 'أي العضيات مسؤول عن إنتاج الطاقة في الخلية؟', c: '٩٨٪', w: '٩٨٪', key: 'الميتوكوندريا' },
                  { q: 'اكتب تعريف التمثيل الضوئي', c: '٩٥٪', w: '٩٥٪', key: 'مقالي — إجابة نموذجية' },
                  { q: 'The powerhouse of the cell is …', c: '٩٦٪', w: '٩٦٪', key: 'mitochondria' },
                ].map((r, i) => (
                  <div key={i} className="rounded-xl border border-border bg-card/70 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-[11px] font-bold">{r.q}</div>
                      <div className="flex items-center gap-1 text-[10px] font-extrabold text-violet-500 stat-number">{r.c}</div>
                    </div>
                    <div className="mt-1.5 h-1 rounded-full bg-muted">
                      <div className="h-full rounded-full bg-gradient-to-l from-violet-500 to-amber-400" style={{ width: r.w }} />
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <BadgeCheck className="h-3 w-3 text-emerald-500" />
                      الإجابة: {r.key}
                    </div>
                  </div>
                ))}
              </div>
              <Button size="sm" className="btn-primary-grad mt-3 w-full border-0 text-white" onClick={() => setMode('login')}>
                جرّب الاستخراج الذكي بنفسك <ArrowLeft className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
        </div>
      </section>

      {/* ---------- features ---------- */}
      <section id="features" className="anchor-scroll mx-auto max-w-6xl px-4 pb-16">
        <div className="mb-8 text-center">
          <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">الميزات</Badge>
          <h2 className="brand-serif mt-3 text-3xl font-black">كل ما تحتاجه الامتحان الورقي والرقمي</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
            من بنك الأسئلة إلى التصحيح — دورة حياة الامتحان كاملة في نظام واحد يعمل من المتصفح.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <div key={f.title} className="shine card-hover glass group rounded-2xl p-5 animate-fade-up" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="logo-glow flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-700 text-white">
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-3 text-sm font-extrabold">{f.title}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{f.desc}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {f.tags.map((t) => (
                  <Badge key={t} variant="outline" className="border-violet-500/25 bg-violet-500/8 text-[10px] text-violet-600 dark:text-violet-300">{t}</Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- tools strip ---------- */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <div className="rounded-2xl border border-border bg-card/50 p-5">
          <div className="mb-4 flex items-center gap-2 text-xs font-bold text-muted-foreground">
            <Layers className="h-4 w-4 text-amber-500" />
            وأيضًا داخل المنصة — مجموعة أدوات كاملة بدون برامج خارجية
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            {TOOLS.map((t) => (
              <div key={t.label} className="card-hover flex flex-col items-center gap-2 rounded-xl border border-border bg-background/50 px-3 py-4 text-center">
                <t.icon className="h-5 w-5 text-violet-500" />
                <span className="text-[11px] font-medium leading-tight">{t.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section id="steps" className="anchor-scroll mx-auto max-w-6xl px-4 pb-16">
        <div className="mb-8 text-center">
          <Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300">كيف تعمل</Badge>
          <h2 className="brand-serif mt-3 text-3xl font-black">ثلاث خطوات من الورقة الممسوحة إلى النتيجة</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.n} className="card-hover glass relative rounded-2xl p-5 pt-6 animate-fade-up" style={{ animationDelay: `${i * 80}ms` }}>
              <div className="timeline-dot absolute -top-3 end-4 flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-700 text-sm font-black text-white logo-glow">
                {s.n}
              </div>
              <h3 className="brand-serif text-lg font-extrabold">{s.title}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- roles ---------- */}
      <section id="roles" className="anchor-scroll mx-auto max-w-6xl px-4 pb-16">
        <div className="mb-8 text-center">
          <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">لمن؟</Badge>
          <h2 className="brand-serif mt-3 text-3xl font-black">مصمم حول يوم المدرسة الحقيقي</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {ROLES.map((r, i) => (
            <div key={r.title} className="card-hover glass rounded-2xl p-5 animate-fade-up" style={{ animationDelay: `${i * 80}ms` }}>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/15 to-amber-400/10 text-violet-600 dark:text-violet-300">
                  <r.icon className="h-5 w-5" />
                </div>
                <h3 className="brand-serif text-lg font-extrabold">{r.title}</h3>
              </div>
              <ul className="mt-3 space-y-2">
                {r.points.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" /> {p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- FAQ ---------- */}
      <section id="faq" className="anchor-scroll mx-auto max-w-3xl px-4 pb-16">
        <div className="mb-8 text-center">
          <Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300">الأسئلة الشائعة</Badge>
          <h2 className="brand-serif mt-3 text-3xl font-black">أسئلة يسألها كل معلم قبل البدء</h2>
        </div>
        <div className="glass rounded-2xl px-5">
          <Accordion type="single" collapsible className="w-full">
            {FAQS.map((f, i) => (
              <AccordionItem key={i} value={`faq-${i}`}>
                <AccordionTrigger className="text-sm font-bold hover:no-underline">
                  {f.q}
                </AccordionTrigger>
                <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                  {f.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* ---------- final CTA ---------- */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <div className="glass relative overflow-hidden rounded-3xl p-8 text-center sm:p-12">
          <div className="pointer-events-none absolute -top-24 start-1/3 h-64 w-64 rounded-full bg-violet-500/20 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-24 end-1/4 h-64 w-64 rounded-full bg-amber-400/15 blur-3xl" />
          <div className="relative">
            <h2 className="brand-serif text-3xl font-black sm:text-4xl">
              جاهز توفّر <span className="text-gradient">ساعات من التصحيح</span> كل أسبوع؟
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-sm text-muted-foreground">
              أنشئ حساب مؤسستك في دقيقة، وادعُ المعلمين — كل الأدوات تعمل من المتصفح بدون تثبيت.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button size="lg" className="btn-primary-grad gap-2 border-0 text-white" onClick={() => setMode('login')}>
                ابدأ الآن — مجانًا <ArrowLeft className="h-4 w-4" />
              </Button>
              <Button size="lg" variant="outline" onClick={() => go('features')}>استعرض الميزات</Button>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- footer ---------- */}
      <footer className="mt-auto border-t py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <div className="logo-glow flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-700 text-[11px] font-black text-white brand-serif">ن</div>
            <span className="brand-serif text-sm font-extrabold">النخبة <span className="text-gradient">QB</span></span>
          </div>
          <span>بنك الأسئلة • الاستخراج الذكي • مصمم الامتحانات • تصحيح OMR • أونلاين</span>
          <span>© {new Date().getFullYear()} النخبة للتعليم — صُنع بشغف للمعلمين</span>
        </div>
      </footer>
    </div>
  );
}
