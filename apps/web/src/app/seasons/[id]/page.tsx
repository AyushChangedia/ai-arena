import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { cacheLife, cacheTag } from 'next/cache';
import { formatTradingDate } from '@arena/shared/format';
import { loadSeason, loadArena } from '@/lib/data';
import { holidayDates } from '@/lib/holidays';
import { standingRows, chartSeries } from '@/lib/arena-view';
import { PageShell, PageFallback } from '@/components/page-shell';
import { Unreachable } from '@/components/banners';
import { StandingsTable } from '@/components/standings-table';
import { PortfolioChart } from '@/components/portfolio-chart';
import { ChartTable } from '@/components/chart-table';

export const metadata = { title: 'Season' };

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<PageFallback />}>
      <Resolved params={params} />
    </Suspense>
  );
}
async function Resolved({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SeasonPage id={id} />;
}

async function SeasonPage({ id }: { id: string }) {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const holidays = holidayDates();
  const [r, a] = await Promise.all([loadSeason(id), loadArena()]);
  if (!r.ok || !a.ok) {
    cacheLife('seconds'); // never keep an outage in the cache
    return <Unreachable />;
  }
  if (!r.data) notFound();
  const s = r.data;
  return (
    <PageShell
      mode={a.data.mode}
      status={a.data.status}
      holidays={holidays}
      seasonActive={false}
      lastUpdated={a.data.lastUpdated}
    >
      <h1 className="condensed py-6 text-2xl font-bold">{s.season.name}</h1>
      <p className="text-sm text-text-2">
        {formatTradingDate(s.season.startsOn)} to{' '}
        {s.season.endsOn ? formatTradingDate(s.season.endsOn) : '—'},{' '}
        {s.season.status === 'finished' ? 'final standings' : 'in progress'}
      </p>
      <section className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4" aria-label="Chart">
        <PortfolioChart
          series={chartSeries(s)}
          startingCashPaise={s.season.startingCashPaise.toString()}
          summary={`Portfolio values over ${s.season.name}.`}
          tableId="season-table"
        />
        <ChartTable id="season-table" marks={s.marks} participants={s.participants} />
      </section>
      <section className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4" aria-labelledby="st">
        <h2 id="st" className="condensed mb-2 text-lg font-semibold">
          Standings
        </h2>
        <StandingsTable rows={standingRows(s)} caption={`Standings, ${s.season.name}`} />
      </section>
    </PageShell>
  );
}
