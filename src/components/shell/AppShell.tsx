'use client';

// ============================================================
// النخبة QB — app shell: RTL sidebar (desktop) + bottom bar (mobile)
// Groups per docs/design-plan.md; active state via aria-current.
// ============================================================

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BookOpen, ClipboardList, FileInput, Files, GraduationCap, NotebookPen,
  ScanLine, Settings2, ShieldAlert, Users,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Wordmark, RegistrationMark } from '@/components/shell/Wordmark';
import { SystemStatus } from '@/components/shell/SystemStatus';
import { t } from '@/lib/ui/strings';

interface Item {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: t('groupExams'),
    items: [
      { href: '/exams', label: t('navExams'), icon: ClipboardList },
      { href: '/bank', label: t('navBank'), icon: BookOpen },
      { href: '/import', label: t('navImport'), icon: FileInput },
    ],
  },
  {
    label: t('groupGrading'),
    items: [
      { href: '/scan', label: t('navScan'), icon: ScanLine },
      { href: '/pipeline', label: t('navPipeline'), icon: Files },
      { href: '/cheating', label: t('navCheating'), icon: ShieldAlert },
    ],
  },
  {
    label: t('groupStudents'),
    items: [
      { href: '/students', label: t('navStudents'), icon: Users },
      { href: '/assignments', label: t('navAssignments'), icon: NotebookPen },
      { href: '/online', label: t('navOnline'), icon: GraduationCap },
    ],
  },
  {
    label: t('groupSettings'),
    items: [
      { href: '/settings', label: t('navSettings'), icon: Settings2 },
    ],
  },
];

const MOBILE_MAIN: Item[] = [
  { href: '/exams', label: t('navExams'), icon: ClipboardList },
  { href: '/scan', label: t('navScan'), icon: ScanLine },
  { href: '/students', label: t('navStudents'), icon: Users },
];

function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  if (href === '/exams') return pathname.startsWith('/exams/');
  return pathname.startsWith(`${href}/`);
}

function NavItem({ item, active, onSelect }: { item: Item; active: boolean; onSelect?: () => void }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={`flex min-h-9 items-center gap-2.5 rounded-md px-3 py-2 text-[15px] transition-colors ${
        active
          ? 'bg-sidebar-primary font-medium text-sidebar-primary-foreground'
          : 'text-sidebar-foreground/90 hover:bg-sidebar-accent'
      }`}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {item.label}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  const moreItems = GROUPS.flatMap((g) => g.items).filter(
    (it) => !MOBILE_MAIN.some((m) => m.href === it.href),
  );

  return (
    <div className="min-h-screen">
      {/* Desktop sidebar — RTL start side */}
      <aside className="sidebar-nav fixed inset-y-0 start-0 z-40 hidden w-60 flex-col bg-sidebar text-sidebar-foreground lg:flex">
        <div className="border-b border-sidebar-border p-4">
          <Link href="/exams" className="block rounded-md" aria-label={t('appFullName')}>
            <Wordmark />
          </Link>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label={t('appFullName')}>
          {GROUPS.map((group) => (
            <div key={group.label} className="mb-3">
              <div className="px-3 pb-1 pt-2 text-[13px] text-sidebar-foreground/60">{group.label}</div>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavItem key={item.href} item={item} active={isActive(pathname, item.href)} />
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <SystemStatus />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b bg-card px-4 py-2 lg:hidden">
        <Link href="/exams" aria-label={t('appFullName')}>
          <Wordmark onDesk />
        </Link>
        <RegistrationMark className="h-6 w-6 text-primary" />
      </header>

      {/* Content */}
      <div className="flex min-h-screen flex-col lg:ps-60">
        <main className="flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0">
          {children}
        </main>
      </div>

      {/* Mobile bottom bar — the 4 most used destinations */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-card lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label={t('navMore')}
      >
        <div className="grid grid-cols-4">
          {MOBILE_MAIN.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 text-[13px] ${
                  active ? 'font-medium text-primary' : 'text-muted-foreground'
                }`}
              >
                <Icon className="h-5 w-5" />
                {item.label}
              </Link>
            );
          })}
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-[13px] text-muted-foreground"
                aria-haspopup="dialog"
              >
                <RegistrationMark className="h-5 w-5" />
                {t('navMore')}
              </button>
            </SheetTrigger>
            <SheetContent side="bottom" className="rounded-t-xl px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              <SheetHeader>
                <SheetTitle className="font-print text-lg">{t('appFullName')}</SheetTitle>
              </SheetHeader>
              <div className="sidebar-nav space-y-3">
                {GROUPS.map((group) => (
                  <div key={group.label}>
                    <div className="px-1 pb-1 text-[13px] text-muted-foreground">{group.label}</div>
                    <div className="space-y-0.5">
                      {group.items
                        .filter((it) => !MOBILE_MAIN.some((m) => m.href === it.href))
                        .map((item) => (
                          <NavItem
                            key={item.href}
                            item={item}
                            active={isActive(pathname, item.href)}
                            onSelect={() => setMoreOpen(false)}
                          />
                        ))}
                    </div>
                  </div>
                ))}
                <div className="rounded-lg bg-ink/5 p-3" dir="rtl">
                  <SystemStatus compact />
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </nav>
    </div>
  );
}
