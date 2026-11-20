'use client';

// ============================================================
// ALNOKHBA QB — Pane design-language kit ("Amethyst Royale")
// Every feature pane opens with the same PaneHeader rhythm:
// glass banner + glowing icon tile + Amiri title + gold caption.
// EmptyState replaces ad-hoc "no data" cards. StatCard for KPIs.
// ============================================================

import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

type Tone = 'emerald' | 'gold' | 'red' | 'neutral';

const toneText: Record<Tone, string> = {
  emerald: 'text-success dark:text-success',
  gold: 'text-warning dark:text-warning',
  red: 'text-destructive dark:text-destructive',
  neutral: 'text-foreground',
};

/** Standard pane banner. `actions` renders buttons on the far side. */
export function PaneHeader({
  icon: Icon,
  title,
  desc,
  actions,
  children,
}: {
  icon: LucideIcon;
  title: string;
  desc?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="glass relative overflow-hidden rounded-2xl p-5">
      <div className="pointer-events-none absolute -top-20 start-1/4 h-48 w-48 rounded-full bg-success/100/15 blur-3xl" />
      
      <div className="relative flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-ink text-white">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="brand-serif truncate text-xl font-extrabold leading-tight">{title}</h1>
            {desc && <p className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">{desc}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="relative mt-3">{children}</div>}
    </div>
  );
}

/** Premium empty state — icon medallion + title + hint + optional CTA. */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-success/10 text-success">
          <Icon className="h-7 w-7" />
        </div>
        <div className="text-sm font-bold">{title}</div>
        {hint && <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">{hint}</p>}
        {children && <div className="mt-1">{children}</div>}
      </CardContent>
    </Card>
  );
}

/** Dashboard / hero KPI card. */
export function StatCard({
  icon: Icon,
  label,
  value,
  tone = 'neutral',
  sub,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  tone?: Tone;
  sub?: string;
}) {
  return (
    <Card className="card-hover">
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${toneText[tone]} bg-success/10`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className={`text-lg font-extrabold leading-none stat-number ${toneText[tone]}`}>{value}</div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            {label}
            {sub && <span className="text-muted-foreground"> • {sub}</span>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
