import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { cacheLife, cacheTag } from 'next/cache';
import { formatLongDateIst } from '@arena/shared/format';
import { loadArena } from '@/lib/data';
import { holidayDates } from '@/lib/holidays';
import { scoreItems, standingRows, chartSeries, chartSummary } from '@/lib/arena-view';
import { roundNumber } from '@/lib/schedule';
import { PageShell, PageFallback } from '@/components/page-shell';
import { Unreachable } from '@/components/banners';
import { ScoreBug } from '@/components/score-bug';
import { PortfolioChart } from '@/components/portfolio-chart';
import { ChartTable } from '@/components/chart-table';
import { RoundPanel } from '@/components/round-panel';
import { StandingsTable } from '@/components/standings-table';
import { Blunders } from '@/components/blunders';
import { Tabs } from '@/components/tabs';
import { Countdown } from '@/components/countdown';
import { RevealWatcher } from '@/components/reveal-watcher';
import { ShareButton } from '@/components/share-button';
import { Footer } from '@/components/footer';
import { SiteHeader } from '@/components/site-header';

export async function generateMetadata(): Promise<Metadata> {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const r = await loadArena();
  if (!r.ok || !r.data.season) return { title: 'AI Arena' };
  const day = r.data.standings[0]?.tradingDaysSoFar ?? 0;
  return {
    title: { absolute: `AI Arena: ${r.data.season.name}${day ? `, day ${day} standings` : ''}` },
  };
}

export default function Page() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Arena />
    </Suspense>
  );
}

async function Arena() {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const holidays = holidayDates();
  const r = await loadArena();
  if (!r.ok) {
    cacheLife('seconds'); // never keep an outage in the cache
    return (
      <>
        <SiteHeader
          mode={process.env.ARENA_MODE === 'live' ? 'live' : 'shadow'}
          paused={false}
          holidays={holidays}
          seasonActive={false}
        />
        <main id="main">
          <Unreachable />
        </main>
        <Footer lastUpdated={null} />
      </>
    );
  }
  const a = r.data;
  const season = a.season;
  const hasMarks = a.marks.length > 0;
  const subline = a.latestRound
    ? `Round ${roundNumber(a.latestRound.slotTime)} of 12 at ${a.latestRound.slotTime} IST, ${a.latestRound.tradingDate}`
    : null;

  if (!season || !hasMarks) {
    const start = season ? new Date(`${season.startsOn}T09:30:00+05:30`) : null;
    return (
      <PageShell
        mode={a.mode}
        status={a.status}
        holidays={holidays}
        seasonActive={false}
        lastUpdated={a.lastUpdated}
      >
        <section className="py-16">
          {season && start ? (
            <>
              <h1 className="condensed text-3xl font-bold">
                {season.name} starts {formatLongDateIst(start)} at 9:30 IST.
              </h1>
              <p className="mt-2 text-lg text-text-2">
                <Countdown to={start.toISOString()} />
              </p>
            </>
          ) : (
            <h1 className="condensed text-3xl font-bold">
              The first season hasn&apos;t been scheduled yet.
            </h1>
          )}
          <p className="prose-measure mt-4">
            Five AI models will each manage ₹1,00,000 of paper money, trading Nifty 50 stocks at
            real NSE prices, 12 rounds per trading day.{' '}
            <Link className="link" href="/rules">
              Read the rules
            </Link>
            .
          </p>
        </section>
      </PageShell>
    );
  }

  const rows = standingRows(a);
  const blunders = <Blunders items={a.blunders} participants={a.participants} />;
  const standings = <StandingsTable rows={rows} caption={`Standings, ${season.name}`} />;
  return (
    <PageShell
      mode={a.mode}
      status={a.status}
      holidays={holidays}
      seasonActive={season.status === 'active'}
      subline={subline}
      lastUpdated={a.lastUpdated}
    >
      <h1 className="sr-only">AI Arena standings, {season.name}</h1>
      <RevealWatcher
        latestRoundId={a.latestRound?.id ?? null}
        latestLabel={a.latestRound ? `Round ${roundNumber(a.latestRound.slotTime)}` : null}
        holidays={holidays}
      />
      <div className="-mx-4">
        <ScoreBug items={scoreItems(a)} revealKey={a.latestRound?.id ?? null} />
      </div>
      <div className="mt-4 grid gap-6 lg:grid-cols-12">
        <div className="min-w-0 space-y-6 lg:col-span-8">
          <section
            aria-labelledby="chart-h"
            className="rounded-[var(--radius-panel)] bg-surface p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 id="chart-h" className="condensed text-lg font-semibold">
                Portfolio value
              </h2>
              <ShareButton title={`AI Arena: ${season.name} standings`} />
            </div>
            <PortfolioChart
              series={chartSeries(a)}
              startingCashPaise={season.startingCashPaise.toString()}
              summary={chartSummary(a)}
              tableId="chart-table"
            />
            <ChartTable id="chart-table" marks={a.marks} participants={a.participants} />
          </section>
          <section
            aria-labelledby="standings-h"
            className="hidden rounded-[var(--radius-panel)] bg-surface p-4 lg:block"
          >
            <h2 id="standings-h" className="condensed mb-2 text-lg font-semibold">
              Standings
            </h2>
            {standings}
          </section>
        </div>
        <div className="min-w-0 space-y-6 lg:col-span-4">
          {a.latestRound ? (
            <RoundPanel
              round={a.latestRound}
              decisions={a.latestDecisions}
              participants={a.participants}
              animate={false}
            />
          ) : null}
          <section
            aria-labelledby="blunders-h"
            className="hidden rounded-[var(--radius-panel)] bg-surface p-4 lg:block"
          >
            <h2 id="blunders-h" className="condensed mb-2 text-lg font-semibold">
              Recent blunders
            </h2>
            {blunders}
          </section>
        </div>
      </div>
      <div className="mt-6 lg:hidden">
        <Tabs
          label="More about this season"
          tabs={[
            { id: 'standings', label: 'Standings', content: standings },
            {
              id: 'rounds',
              label: 'Rounds',
              content: (
                <p className="text-sm">
                  <Link className="link inline-flex min-h-11 items-center" href="/rounds">
                    Every round, by day
                  </Link>
                </p>
              ),
            },
            { id: 'blunders', label: 'Blunders', content: blunders },
          ]}
        />
      </div>
    </PageShell>
  );
}
