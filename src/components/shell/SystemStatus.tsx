'use client';

// حالة النظام — labeled engine health in the sidebar footer.
// Replaces the two unlabeled colored dots: each row names the component,
// states connected/disconnected in words, and gives a one-line fix.

import { useEffect, useState } from 'react';
import { CircleSlash, CircleCheck } from 'lucide-react';
import { t } from '@/lib/ui/strings';

interface Health {
  db?: boolean;
  pdf?: { ok?: boolean; running?: boolean };
  omrEngine?: { ok?: boolean };
}

interface Row {
  key: string;
  label: string;
  ok: boolean;
  fix: string;
}

export function SystemStatus({ compact = false }: { compact?: boolean }) {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadOnce = () => {
      fetch('/api/health')
        .then(async (res) => {
          const h = (await res.json()) as Health;
          if (!cancelled) setHealth(h);
        })
        .catch(() => {
          if (!cancelled) setHealth({});
        });
    };
    // Defer the first poll out of the effect body (no cascading render).
    const t0 = setTimeout(loadOnce, 0);
    const id = setInterval(loadOnce, 30000);
    return () => {
      cancelled = true;
      clearTimeout(t0);
      clearInterval(id);
    };
  }, []);

  const rows: Row[] = [
    {
      key: 'db',
      label: t('sysDb'),
      ok: Boolean(health?.db),
      fix: t('fixDb'),
    },
    {
      key: 'pdf',
      label: t('sysPdf'),
      ok: Boolean(health?.pdf?.ok ?? health?.pdf?.running),
      fix: t('fixPdf'),
    },
    {
      key: 'omr',
      label: t('sysOmr'),
      ok: Boolean(health?.omrEngine?.ok),
      fix: t('fixOmr'),
    },
  ];

  return (
    <div className="sidebar-nav space-y-1" aria-label={t('systemStatus')}>
      {!compact && (
        <div className="mb-1 text-[13px] font-medium text-sidebar-foreground/70">{t('systemStatus')}</div>
      )}
      {rows.map((row) => (
        <div key={row.key} className="group/row" title={row.ok ? undefined : row.fix}>
          <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-[13px]">
            <span className="truncate text-sidebar-foreground/90">{row.label}</span>
            <span
              className={`flex shrink-0 items-center gap-1 ${row.ok ? 'text-[#7fd6a4]' : 'text-[#e79b8f]'}`}
            >
              {row.ok ? (
                <CircleCheck className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <CircleSlash className="h-3.5 w-3.5" aria-hidden />
              )}
              {row.ok ? t('connected') : t('disconnected')}
            </span>
          </div>
          {!row.ok && (
            <p className="px-2 pb-1 text-[13px] leading-snug text-sidebar-foreground/70">{row.fix}</p>
          )}
        </div>
      ))}
    </div>
  );
}
