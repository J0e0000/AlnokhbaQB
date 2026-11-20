'use client';

import { useEffect, useState } from 'react';
import { Languages, Moon, ShieldCheck, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function Header() {
  const [dark, setDark] = useState(false);
  const [rtl, setRtl] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Defer sync-with-DOM state out of the effect body (no cascading render).
    const t = setTimeout(() => {
      setDark(document.documentElement.classList.contains('dark'));
      setRtl(document.documentElement.dir === 'rtl');
      setMounted(true);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('pw-theme', next ? 'dark' : 'light');
    } catch {
      /* private mode */
    }
  };

  const toggleDir = () => {
    const next = !rtl;
    setRtl(next);
    document.documentElement.dir = next ? 'rtl' : 'ltr';
    try {
      localStorage.setItem('pw-dir', next ? 'rtl' : 'ltr');
    } catch {
      /* private mode */
    }
  };

  return (
    <header className="border-b border-border bg-card/70 backdrop-blur sticky top-0 z-40">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => {
            window.location.hash = '';
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          }}
          className="flex items-baseline gap-1 text-xl focus-visible:outline-2 focus-visible:outline-ring rounded"
          aria-label="Pagewise home"
        >
          <span className="pw-serif font-bold tracking-tight">
            Page<span className="text-primary">wise</span>
          </span>
          <span className="sr-only">— PDF toolkit</span>
        </button>

        <div className="flex items-center gap-2">
          <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Privacy-first
          </span>
          <Button variant="ghost" size="icon" onClick={toggleDir} aria-label={rtl ? 'Switch to left-to-right layout' : 'Switch to right-to-left layout'} title="Toggle layout direction">
            <Languages className="h-4.5 w-4.5" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} title="Toggle theme" disabled={!mounted}>
            {dark ? <Sun className="h-4.5 w-4.5" aria-hidden="true" /> : <Moon className="h-4.5 w-4.5" aria-hidden="true" />}
          </Button>
        </div>
      </div>
    </header>
  );
}
