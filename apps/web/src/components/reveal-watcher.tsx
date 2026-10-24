'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { marketOpen } from '@/lib/clock';

/**
 * Refreshes the cached page every 5 minutes while the tab is visible during market hours (SPEC §16.5),
 * and announces a new round politely. No database polling: router.refresh() re-reads the cached page.
 */
export function RevealWatcher({
  latestRoundId,
  latestLabel,
  holidays,
}: {
  latestRoundId: string | null;
  latestLabel: string | null;
  holidays: string[];
}) {
  const router = useRouter();
  const first = useRef(latestRoundId);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    if (latestRoundId && first.current && latestRoundId !== first.current && latestLabel) {
      setAnnounce(`${latestLabel} results are in.`);
      first.current = latestRoundId;
    }
  }, [latestRoundId, latestLabel]);
  useEffect(() => {
    const t = setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        marketOpen(new Date(Date.now() - 30 * 60_000), holidays)
      )
        router.refresh();
    }, 5 * 60_000);
    return () => clearInterval(t);
  }, [router, holidays]);
  return (
    <div aria-live="polite" className="sr-only">
      {announce}
    </div>
  );
}
