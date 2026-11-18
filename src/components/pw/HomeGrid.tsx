'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { TOOLS, GROUPS } from '@/lib/pw/registry';
import { GROUP_META, type ToolDef, type ToolGroup } from '@/lib/pw/types';
import { ToolIcon } from './icons';

const ENGINE_BADGE: Record<ToolDef['engine'], { label: string; className: string }> = {
  client: { label: 'In-browser', className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30' },
  server: { label: 'Server', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30' },
  ai: { label: 'AI', className: 'bg-primary/10 text-primary border-primary/30' },
};

function ToolCard({ tool, onOpen }: { tool: ToolDef; onOpen: (id: string) => void }) {
  const badge = ENGINE_BADGE[tool.engine];
  return (
    <button
      type="button"
      onClick={() => onOpen(tool.id)}
      className="group flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-4 text-start shadow-sm transition hover:border-primary hover:shadow-md focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={`Open tool: ${tool.name}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary text-primary transition group-hover:bg-primary group-hover:text-primary-foreground">
          <ToolIcon name={tool.icon} className="h-5 w-5" />
        </span>
        <span className="flex gap-1">
          {tool.badge ? (
            <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {tool.badge}
            </span>
          ) : null}
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${badge.className}`}>{badge.label}</span>
        </span>
      </div>
      <span className="pw-serif text-base font-bold">{tool.name}</span>
      <span className="text-sm leading-snug text-muted-foreground line-clamp-3">{tool.description}</span>
    </button>
  );
}

export function HomeGrid({ onOpen }: { onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<'all' | ToolGroup>('all');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TOOLS.filter((t) => {
      if (active !== 'all' && t.group !== active) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        GROUP_META[t.group].label.toLowerCase().includes(q) ||
        t.id.includes(q)
      );
    });
  }, [query, active]);

  const tabs: { key: 'all' | ToolGroup; label: string }[] = [
    { key: 'all', label: 'All tools' },
    ...GROUPS.map((g) => ({ key: g, label: GROUP_META[g].label })),
  ];

  const grouped =
    active === 'all'
      ? GROUPS.map((g) => ({ group: g, tools: filtered.filter((t) => t.group === g) })).filter((s) => s.tools.length > 0)
      : [{ group: active, tools: filtered }];

  return (
    <section aria-label="PDF tools" className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools…"
            className="ps-9"
            aria-label="Search tools"
          />
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Tool categories">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active === t.key}
              onClick={() => setActive(t.key)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-ring ${
                active === t.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card text-muted-foreground hover:border-primary hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {grouped.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
          No tools match “{query}”. Try another search term.
        </p>
      ) : (
        grouped.map((section) => (
          <div key={section.group} className="space-y-3">
            {active === 'all' ? (
              <div>
                <h2 className="pw-serif text-lg font-bold">{GROUP_META[section.group].label}</h2>
                <p className="text-xs text-muted-foreground">{GROUP_META[section.group].blurb}</p>
              </div>
            ) : null}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {section.tools.map((t) => (
                <ToolCard key={t.id} tool={t} onOpen={onOpen} />
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
