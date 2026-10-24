import type { ReactNode } from 'react';
import { SiteHeader } from './site-header';
import { Footer } from './footer';
import { PausedBanner, pausedMessage } from './banners';
import type { StatusRow } from '@arena/db/read';

export function PageShell({
  mode,
  status,
  holidays,
  seasonActive,
  subline,
  children,
  lastUpdated,
}: {
  mode: 'shadow' | 'live';
  status: StatusRow | null;
  holidays: string[];
  seasonActive: boolean;
  subline?: string | null;
  children: ReactNode;
  lastUpdated: Date | null;
}) {
  return (
    <>
      <SiteHeader
        mode={mode}
        paused={Boolean(status?.paused)}
        holidays={holidays}
        seasonActive={seasonActive}
        subline={subline}
      />
      {status?.paused ? (
        <PausedBanner
          message={pausedMessage(status.pausedReason)}
          since={status.lastCompletedRoundAt}
        />
      ) : null}
      <main id="main" className="mx-auto max-w-[1200px] px-4 pb-8">
        {children}
      </main>
      <Footer lastUpdated={lastUpdated} />
    </>
  );
}

export function PageFallback() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-8" aria-busy="true">
      <p className="text-text-2">Loading the arena…</p>
    </div>
  );
}
