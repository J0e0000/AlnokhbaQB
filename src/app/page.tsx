'use client';

import { useEffect, useState } from 'react';
import { FileStack, ShieldCheck, Zap } from 'lucide-react';
import { Header } from '@/components/pw/Header';
import { HomeGrid } from '@/components/pw/HomeGrid';
import { Workspace } from '@/components/pw/Workspace';
import { getTool, TOOLS } from '@/lib/pw/registry';

function currentToolId(): string | null {
  const m = window.location.hash.match(/^#\/tool\/([\w-]+)$/);
  return m ? m[1] : null;
}

export default function Page() {
  const [toolId, setToolId] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => {
      setToolId(currentToolId());
      window.scrollTo({ top: 0 });
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const tool = toolId ? getTool(toolId) : null;
  const openTool = (id: string) => {
    window.location.hash = `#/tool/${id}`;
    setToolId(id);
    window.scrollTo({ top: 0 });
  };
  const back = () => {
    window.location.hash = '';
    setToolId(null);
    window.scrollTo({ top: 0 });
  };

  const inBrowser = TOOLS.filter((t) => t.engine === 'client').length;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-12 pt-6">
        {tool ? (
          <Workspace tool={tool} onBack={back} />
        ) : (
          <>
            <section className="pw-paper -mx-4 mb-8 rounded-b-3xl px-4 pb-8 pt-6 sm:pb-12 sm:pt-10">
              <h1 className="pw-serif max-w-2xl text-3xl font-bold leading-tight sm:text-4xl">
                Every PDF tool, <span className="text-primary">one page</span>.
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                Merge, split, compress, convert, sign, redact and understand PDFs — with original tooling built for privacy.
                Most tools run entirely in your browser; anything that needs a server is deleted right after the job.
              </p>
              <ul className="mt-4 flex flex-wrap gap-2 text-xs font-medium text-muted-foreground" aria-label="Highlights">
                <li className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5">
                  <FileStack className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  {TOOLS.length} tools in 7 categories
                </li>
                <li className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5">
                  <Zap className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  {inBrowser} tools work offline, in-browser
                </li>
                <li className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  No account required
                </li>
              </ul>
            </section>
            <HomeGrid onOpen={openTool} />
          </>
        )}
      </main>

      <footer className="mt-auto border-t border-border bg-card/60 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            <span className="pw-serif font-bold text-foreground">
              Page<span className="text-primary">wise</span>
            </span>{' '}
            — an original, privacy-first PDF toolkit.
          </p>
          <p>In-browser tools never upload a byte. Server jobs are deleted after download, and at most one hour later.</p>
        </div>
      </footer>
    </div>
  );
}
