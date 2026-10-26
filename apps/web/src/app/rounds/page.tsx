import { Suspense } from 'react';
import Link from 'next/link';
import { cacheLife, cacheTag } from 'next/cache';
import { formatTradingDate } from '@arena/shared/format';
import { loadRounds, loadArena } from '@/lib/data';
import { holidayDates } from '@/lib/holidays';
import { roundNumber } from '@/lib/schedule';
import { PageShell, PageFallback } from '@/components/page-shell';
import { Unreachable } from '@/components/banners';

export const metadata = { title: 'Rounds' };

const STATUS: Record<string, string> = {
  COMPLETED: 'Completed',
  PARTIAL: 'Partly completed',
  SKIPPED_DATA: 'Skipped: market data unavailable',
  SKIPPED_PAUSED: 'Skipped: arena paused',
  MISSED_SCHEDULE: "Missed: scheduler didn't run",
  ABORTED: 'Aborted',
  RUNNING: 'Running',
};

export default function Page() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Rounds />
    </Suspense>
  );
}

async function Rounds() {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const holidays = holidayDates();
  const [r, a] = await Promise.all([loadRounds(), loadArena()]);
  if (!r.ok || !a.ok) {
    cacheLife('seconds'); // never keep an outage in the cache
    return <Unreachable />;
  }
  const days = [...new Set(r.data.rounds.map((x) => x.tradingDate))];
  return (
    <PageShell
      mode={r.data.mode}
      status={a.data.status}
      holidays={holidays}
      seasonActive={r.data.season?.status === 'active'}
      lastUpdated={a.data.lastUpdated}
    >
      <h1 className="condensed py-6 text-2xl font-bold">
        Rounds{r.data.season ? `, ${r.data.season.name}` : ''}
      </h1>
      {days.length === 0 ? <p className="text-text-2">No rounds have been revealed yet.</p> : null}
      <div className="space-y-6">
        {days.map((d) => (
          <section
            key={d}
            aria-labelledby={`d-${d}`}
            className="rounded-[var(--radius-panel)] bg-surface p-4"
          >
            <h2 id={`d-${d}`} className="condensed mb-2 text-lg font-semibold">
              {formatTradingDate(d)}
            </h2>
            <ul className="divide-y divide-line">
              {r.data.rounds
                .filter((x) => x.tradingDate === d)
                .sort((x, y) => x.slotTime.localeCompare(y.slotTime))
                .map((x) => (
                  <li key={x.id}>
                    <Link
                      href={`/rounds/${x.id}`}
                      className="flex min-h-11 items-center justify-between gap-3 py-1"
                    >
                      <span className="num">
                        {x.kind === 'square_off'
                          ? `Square-off at ${x.slotTime} IST`
                          : `Round ${roundNumber(x.slotTime)} at ${x.slotTime} IST`}
                      </span>
                      <span
                        className={`text-sm ${x.status === 'COMPLETED' ? 'text-text-2' : 'text-accent'}`}
                      >
                        {STATUS[x.status] ?? x.status}
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </PageShell>
  );
}
