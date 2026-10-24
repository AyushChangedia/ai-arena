import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { cacheLife, cacheTag } from 'next/cache';
import { formatInr, formatUsd, formatInt } from '@arena/shared/format';
import { loadModel } from '@/lib/data';
import { holidayDates } from '@/lib/holidays';
import { chartSeries } from '@/lib/arena-view';
import { verdict, blunderText } from '@/lib/view';
import { arena } from '@/lib/config';
import { PageShell, PageFallback } from '@/components/page-shell';
import { Unreachable } from '@/components/banners';
import { Chip } from '@/components/chip';
import { Money, Pct, Pts, Ratio, Missing } from '@/components/num';
import { PortfolioChart } from '@/components/portfolio-chart';
import { AllocationBar } from '@/components/allocation-bar';
import { StatusStrip } from '@/components/status-strip';
import { Tabs } from '@/components/tabs';
import { participantStatus } from '@/lib/arena-view';

/** The seven participant slots are fixed, so their pages can be prerendered (and their metadata sits in <head>). */
export function generateStaticParams() {
  return ['openai', 'anthropic', 'google', 'meta', 'deepseek', 'monkey', 'nifty50'].map((slug) => ({
    slug,
  }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return cachedMeta(slug);
}
async function cachedMeta(slug: string): Promise<Metadata> {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const r = await loadModel(slug);
  if (!r.ok || !r.data) return { title: 'Model' };
  return { title: `${r.data.participant.displayName} (${r.data.participant.shortCode})` };
}

export default function Page({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <Suspense fallback={<PageFallback />}>
      <Resolved params={params} />
    </Suspense>
  );
}

async function Resolved({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ModelPage slug={slug} />;
}

async function ModelPage({ slug }: { slug: string }) {
  'use cache';
  cacheTag('live');
  cacheLife('arena');
  const holidays = holidayDates();
  const r = await loadModel(slug);
  if (!r.ok) {
    cacheLife('seconds'); // never keep an outage in the cache
    return <Unreachable />;
  }
  if (!r.data) notFound();
  const {
    participant: p,
    standing: s,
    arena: a,
    holdings,
    trades,
    decisions,
    blunders,
    strip,
    counts,
  } = r.data;
  const name = p.kind === 'monkey' ? 'Monkey (random)' : p.displayName;
  const index = a.participants.find((x) => x.kind === 'index');
  const latestMark = [...a.marks].reverse().find((m) => m.participantId === p.id);
  const holdingRows = holdings.map((h) => {
    const value = h.lastPricePaise === null ? null : BigInt(h.quantity) * h.lastPricePaise;
    return {
      ...h,
      value,
      pnl:
        h.lastPricePaise === null ? null : (h.lastPricePaise - h.avgCostPaise) * BigInt(h.quantity),
    };
  });
  const totalForWeights = latestMark?.totalPaise ?? null;

  const tradesTab = (
    <div
      className="relative overflow-x-auto"
      tabIndex={0}
      role="region"
      aria-label="Scrollable table"
    >
      {trades.length ? (
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <caption className="sr-only">Trades by {name}</caption>
          <thead>
            <tr className="border-b border-line text-text-2">
              <th scope="col" className="px-2 py-1 text-left font-normal">
                Trade
              </th>
              <th scope="col" className="px-2 py-1 text-left font-normal">
                When
              </th>
              <th scope="col" className="px-2 py-1 text-left font-normal">
                Action
              </th>
              <th scope="col" className="px-2 py-1 text-right font-normal">
                Price
              </th>
              <th scope="col" className="px-2 py-1 text-right font-normal">
                Charges
              </th>
              <th scope="col" className="px-2 py-1 text-right font-normal">
                Realised P&amp;L
              </th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.seq} className="border-b border-line">
                <td className="num px-2 py-1">
                  <Link
                    className="link inline-flex min-h-11 items-center"
                    href={`/trades/${t.seq}`}
                  >
                    #{t.seq}
                  </Link>
                </td>
                <td className="num px-2 py-1">
                  {t.occurredAt.toLocaleString('en-GB', {
                    timeZone: 'Asia/Kolkata',
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}{' '}
                  IST
                </td>
                <td className="px-2 py-1">
                  {t.side === 'BUY' ? 'Bought' : 'Sold'} {t.quantity} {t.symbol}
                </td>
                <td className="num px-2 py-1 text-right">
                  {t.pricePaise === null ? '—' : formatInr(t.pricePaise)}
                </td>
                <td className="num px-2 py-1 text-right">{formatInr(t.chargesTotalPaise)}</td>
                <td className="num px-2 py-1 text-right">
                  {t.realizedPnlPaise === null ? (
                    <Missing reason="Only sells realise P&L" />
                  ) : (
                    formatInr(t.realizedPnlPaise)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-text-2">No trades yet.</p>
      )}
    </div>
  );

  const thinkingTab = decisions.length ? (
    <ol className="space-y-4">
      {decisions.map((d) => (
        <li key={d.id} className="border-b border-line pb-3">
          <p className="text-sm text-text-2">
            <Link className="link num" href={`/rounds/${d.roundId}`}>
              {d.tradingDate} {d.slotTime} IST
            </Link>
            <span className="ml-2 text-text">{verdict(d.status, d.actions)}</span>
          </p>
          {d.reasoning ? (
            <p className="model-text prose-measure mt-1 text-sm">
              {d.reasoning.slice(0, arena.display.reasoningDisplayChars)}
            </p>
          ) : null}
          {d.actions.length ? (
            <ul className="mt-1 text-sm">
              {d.actions.map((x) => (
                <li key={x.id}>
                  {x.side ?? x.sideRaw} {x.quantity ?? String(x.quantityRaw)}{' '}
                  {x.symbol ?? x.symbolRaw}:{' '}
                  {x.status === 'executed'
                    ? 'executed'
                    : `rejected (${x.rejectDetail ?? x.rejectCode})`}
                  {x.why ? (
                    <span className="model-text text-text-2">
                      {' '}
                      “{x.why.slice(0, arena.display.whyDisplayChars)}”
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {d.noteToSelf ? (
            <p className="model-text mt-1 text-xs text-text-2">Note to self: {d.noteToSelf}</p>
          ) : null}
        </li>
      ))}
    </ol>
  ) : (
    <p className="text-sm text-text-2">No decisions revealed yet.</p>
  );

  const blundersTab = blunders.length ? (
    <ul className="divide-y divide-line text-sm">
      {blunders.map((b) => (
        <li key={b.id} className="py-2">
          {blunderText(b)}{' '}
          <Link className="link num text-xs text-text-2" href={`/rounds/${b.roundId}`}>
            {b.tradingDate} {b.slotTime} IST
          </Link>
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-text-2">No blunders yet.</p>
  );

  const reportTab = (
    <div className="space-y-4 text-sm">
      <StatusStrip
        label="Last 60 rounds"
        items={strip.map((x) => ({
          key: x.roundId,
          status: x.byParticipant[p.id] ?? null,
          title: `${x.tradingDate} ${x.slotTime}: ${x.byParticipant[p.id] ?? x.roundStatus}`,
        }))}
      />
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-text-2">Average latency</dt>
          <dd className="num">
            {counts?.avgLatencyMs === null || !counts ? (
              <Missing reason="No calls yet" />
            ) : (
              `${formatInt(counts.avgLatencyMs)} ms`
            )}
          </dd>
        </div>
        <div>
          <dt className="text-text-2">Input tokens</dt>
          <dd className="num">
            {counts ? formatInt(counts.inputTokens) : <Missing reason="No calls yet" />}
          </dd>
        </div>
        <div>
          <dt className="text-text-2">Output tokens</dt>
          <dd className="num">
            {counts ? formatInt(counts.outputTokens) : <Missing reason="No calls yet" />}
          </dd>
        </div>
        <div>
          <dt className="text-text-2">API spend</dt>
          <dd className="num">
            {counts ? formatUsd(counts.costUsd) : <Missing reason="No calls yet" />}
          </dd>
        </div>
      </dl>
    </div>
  );

  return (
    <PageShell
      mode={a.mode}
      status={a.status}
      holidays={holidays}
      seasonActive={a.season?.status === 'active'}
      lastUpdated={a.lastUpdated}
    >
      <div className="py-6">
        <div className="flex flex-wrap items-center gap-3">
          <Chip p={p} />
          <h1 className="condensed text-2xl font-bold">{name}</h1>
        </div>
        <p className="mt-1 text-sm text-text-2">
          {p.modelId ? (
            <span className="tabular-nums">{p.modelId}</span>
          ) : p.kind === 'index' ? (
            'Benchmark: ₹1,00,000 in the Nifty 50 at the season’s first fill, no costs.'
          ) : (
            'A seeded random trader. Same rules, same costs.'
          )}
        </p>
        <p className="text-sm text-text-2">
          Status: {participantStatus(p)}
          {p.retiredAt
            ? `, retired ${p.retiredAt.toISOString().slice(0, 10)}: ${p.retiredReason ?? ''}`
            : ''}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-4 rounded-[var(--radius-panel)] bg-surface p-4 sm:grid-cols-3 lg:grid-cols-5">
        <div>
          <dt className="text-sm text-text-2">Value</dt>
          <dd className="condensed text-xl font-semibold">
            <Money paise={s?.totalPaise} decimals={0} missing="No mark yet" />
          </dd>
        </div>
        <div>
          <dt className="text-sm text-text-2">Return</dt>
          <dd className="text-lg">
            <Pct frac={s?.returnFrac} missing="No mark yet" />
          </dd>
        </div>
        <div>
          <dt className="text-sm text-text-2">vs Nifty</dt>
          <dd className="text-lg">
            <Pts
              diff={s?.vsNiftyPts}
              missing={p.kind === 'index' ? 'This is the Nifty benchmark' : 'No Nifty mark yet'}
            />
          </dd>
        </div>
        <div>
          <dt className="text-sm text-text-2">Max drawdown</dt>
          <dd className="text-lg">
            <Pct frac={s?.maxDrawdown} arrow={false} missing="No marks yet" />
          </dd>
        </div>
        <div>
          <dt className="text-sm text-text-2">Trades</dt>
          <dd className="num text-lg">
            {s ? formatInt(s.trades) : <Missing reason="No trades yet" />}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-text-2">Clean answers</dt>
          <dd className="text-lg">
            <Ratio
              value={s?.cleanAnswers}
              missing={p.kind === 'model' ? 'No answers yet' : 'Not a model'}
            />
          </dd>
        </div>
        <div>
          <dt className="text-sm text-text-2">Accepted actions</dt>
          <dd className="text-lg">
            <Ratio value={s?.acceptedActions} missing="No actions yet" />
          </dd>
        </div>
        <div>
          <dt className="text-sm text-text-2">Uptime</dt>
          <dd className="text-lg">
            <Ratio
              value={s?.uptime}
              missing={p.kind === 'model' ? 'No rounds yet' : 'Not a model'}
            />
          </dd>
        </div>
        <div>
          <dt className="text-sm text-text-2">API spend</dt>
          <dd className="num text-lg">
            {p.kind === 'model' && s ? (
              formatUsd(s.costUsd)
            ) : (
              <Missing reason="Only models use the API" />
            )}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-text-2">Sharpe</dt>
          <dd className="num text-lg">
            {s?.sharpe === null || !s ? (
              <Missing reason="Needs 10 trading days" />
            ) : (
              `${s.sharpe.toFixed(2)} (daily, annualised)`
            )}
          </dd>
        </div>
      </dl>
      <section
        aria-labelledby="mchart"
        className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4"
      >
        <h2 id="mchart" className="condensed mb-2 text-lg font-semibold">
          Value against the Nifty 50
        </h2>
        <PortfolioChart
          series={chartSeries(a, [p.id, ...(index && index.id !== p.id ? [index.id] : [])])}
          startingCashPaise={(a.season?.startingCashPaise ?? 0n).toString()}
          summary={`${name}'s portfolio value over the season, with the Nifty 50 benchmark.`}
          tableId="trades"
        />
      </section>
      {p.kind !== 'index' ? (
        <section
          aria-labelledby="holdings-h"
          className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4"
        >
          <h2 id="holdings-h" className="condensed mb-2 text-lg font-semibold">
            Holdings
          </h2>
          {holdingRows.length ? (
            <>
              <div
                className="relative overflow-x-auto"
                tabIndex={0}
                role="region"
                aria-label="Scrollable table"
              >
                <table className="w-full min-w-[600px] border-collapse text-sm">
                  <caption className="sr-only">
                    Holdings of {name}, priced at the latest revealed mark (delayed)
                  </caption>
                  <thead>
                    <tr className="border-b border-line text-text-2">
                      <th scope="col" className="px-2 py-1 text-left font-normal">
                        Stock
                      </th>
                      <th scope="col" className="px-2 py-1 text-right font-normal">
                        Quantity
                      </th>
                      <th scope="col" className="px-2 py-1 text-right font-normal">
                        Average price
                      </th>
                      <th scope="col" className="px-2 py-1 text-right font-normal">
                        Last price (delayed)
                      </th>
                      <th scope="col" className="px-2 py-1 text-right font-normal">
                        Value
                      </th>
                      <th scope="col" className="px-2 py-1 text-left font-normal">
                        Weight
                      </th>
                      <th scope="col" className="px-2 py-1 text-right font-normal">
                        Unrealised P&amp;L
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdingRows.map((h) => {
                      const w =
                        h.value !== null && totalForWeights
                          ? Number(h.value) / Number(totalForWeights)
                          : null;
                      return (
                        <tr key={h.symbol} className="border-b border-line">
                          <th scope="row" className="px-2 py-1 text-left font-normal">
                            {h.symbol}{' '}
                            {h.underReview ? (
                              <span className="ml-1 rounded-[var(--radius-chip)] border border-accent px-1 text-xs text-accent">
                                Under review
                              </span>
                            ) : null}
                          </th>
                          <td className="num px-2 py-1 text-right">{formatInt(h.quantity)}</td>
                          <td className="num px-2 py-1 text-right">{formatInr(h.avgCostPaise)}</td>
                          <td className="num px-2 py-1 text-right">
                            <Money paise={h.lastPricePaise} missing="No price this round" />
                          </td>
                          <td className="num px-2 py-1 text-right">
                            <Money paise={h.value} decimals={0} missing="No price this round" />
                          </td>
                          <td className="px-2 py-1">
                            {w === null ? (
                              <Missing reason="No price this round" />
                            ) : (
                              <span className="flex items-center gap-2">
                                <span className="h-2 w-16 rounded bg-surface-2">
                                  <span
                                    className="block h-2 rounded"
                                    style={{
                                      width: `${Math.min(100, w * 100)}%`,
                                      background: p.color,
                                    }}
                                  />
                                </span>
                                <span className="num">{(w * 100).toFixed(1)}%</span>
                              </span>
                            )}
                          </td>
                          <td className="num px-2 py-1 text-right">
                            <Money paise={h.pnl} missing="No price this round" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {latestMark ? (
                <div className="mt-4">
                  <h3 className="mb-2 text-sm text-text-2">Allocation</h3>
                  <AllocationBar
                    color={p.color}
                    parts={[
                      ...holdingRows
                        .filter((h) => h.value !== null)
                        .map((h) => ({ label: h.symbol, valuePaise: h.value! })),
                      { label: 'Cash', valuePaise: latestMark.cashPaise },
                    ]}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-text-2">
              No holdings: all cash
              {latestMark ? (
                <>
                  {' '}
                  (<Money paise={latestMark.cashPaise} decimals={0} />)
                </>
              ) : null}
              .
            </p>
          )}
        </section>
      ) : null}
      <section
        aria-label="Details"
        className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4"
        id="trades"
      >
        <Tabs
          label={`${name}: details`}
          tabs={[
            { id: 'trades', label: 'Trades', content: tradesTab },
            ...(p.kind === 'index'
              ? []
              : [
                  { id: 'thinking', label: 'Thinking', content: thinkingTab },
                  { id: 'blunders', label: 'Blunders', content: blundersTab },
                ]),
            ...(p.kind === 'model'
              ? [{ id: 'report', label: 'Report card', content: reportTab }]
              : []),
          ]}
        />
      </section>
    </PageShell>
  );
}
