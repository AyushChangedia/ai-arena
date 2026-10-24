'use client';
import { useEffect, useState } from 'react';
import { marketOpen, nextSlot, countdown, slotLabel, istParts, type ClockInput } from '@/lib/clock';

/** Header chip (Live, Closed, Paused), IST clock and countdown, computed in the browser from the schedule. */
export function MarketClock({
  clock,
  paused,
  latestRound,
  seasonActive,
}: {
  clock: ClockInput;
  paused: boolean;
  latestRound: { n: number; of: number } | null;
  seasonActive: boolean;
}) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const open = now ? marketOpen(now, clock.holidays) : false;
  const state = paused ? 'Paused' : open && seasonActive ? 'Live' : 'Closed';
  const next = now ? nextSlot(now, clock) : null;
  const p = now ? istParts(now) : null;
  return (
    <div className="flex min-h-12 flex-col items-end gap-0.5">
      <span
        className={`condensed inline-flex items-center gap-1.5 rounded-[var(--radius-chip)] px-2 py-0.5 text-sm font-semibold ${state === 'Live' ? 'bg-accent text-bg' : state === 'Paused' ? 'border border-accent text-accent' : 'border border-line text-text-2'}`}
        aria-live="off"
      >
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${state === 'Live' ? 'bg-bg' : state === 'Paused' ? 'bg-accent' : 'bg-text-2'}`}
        />
        {now ? state : ' '}
      </span>
      <span className="num text-xs text-text-2">
        {p
          ? `${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:${String(p.minutes % 60).padStart(2, '0')} IST`
          : ' '}
      </span>
      <span className="sr-only">
        {latestRound ? `Latest round ${latestRound.n} of ${latestRound.of}.` : ''}
      </span>
      {next && seasonActive && !paused ? (
        <span className="num text-xs text-text-2">
          Next round {slotLabel(next, now!)} ({countdown(next.at.getTime() - now!.getTime())})
        </span>
      ) : null}
    </div>
  );
}
