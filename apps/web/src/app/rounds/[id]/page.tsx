import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cacheLife, cacheTag } from 'next/cache';
import {
  formatInr,
  formatTimeIst,
  formatTradingDate,
  formatUsd,
  tradeVerb,
} from '@arena/shared/format';
import { loadRound, loadArena } from '@/lib/data';
import { holidayDates } from '@/lib/holidays';
import { roundNumber } from '@/lib/schedule';
import { verdict } from '@/lib/view';
import { arena } from '@/lib/config';
import { PageShell, PageFallback } from '@/components/page-shell';
import { Unreachable } from '@/components/banners';
import { Chip } from '@/components/chip';

export const metadata = { title: 'Round' };

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<PageFallback />}>
      <Resolved params={params} />
    </Suspense>
  );
}
async function Resolved({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RoundPage id={id} />;
}

const t = (d: Date | null) => (d ? formatTimeIst(d) : '—');

async function RoundPage({ id }: { id: string }) {
  'use cache';
  cacheTag('detail', 'live');
  cacheLife('arena');
  const holidays = holidayDates();
  const [r, a] = await Promise.all([loadRound(id), loadArena()]);
  if (!r.ok || !a.ok) {
    cacheLife('seconds'); // never keep an outage in the cache
    return <Unreachable />;
  }
  if (!r.data) notFound();
  const { round, season, participants, decisions, marketTable, fills } = r.data;
  return (
    <PageShell
      mode={a.data.mode}
      status={a.data.status}
      holidays={holidays}
      seasonActive={season?.status === 'active'}
      lastUpdated={a.data.lastUpdated}
    >
      <div className="py-6">
        <h1 className="condensed text-2xl font-bold">
          {round.kind === 'square_off'
            ? `Square-off at ${round.slotTime} IST, `
            : `Round ${roundNumber(round.slotTime)} at ${round.slotTime} IST, `}
          {formatTradingDate(round.tradingDate)}
        </h1>
        {round.kind === 'square_off' ? (
          <p className="prose-measure mt-2 text-sm text-text-2">
            Intraday rule: the engine closed every open position (longs sold at the best bid, shorts
            bought back at the best ask, normal costs). The models did not choose these trades.
          </p>
        ) : null}
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-text-2">Scheduled</dt>
            <dd className="num">{t(round.scheduledAt)}</dd>
          </div>
          <div>
            <dt className="text-text-2">Actual start</dt>
            <dd className="num">{t(round.startedAt)}</dd>
          </div>
          <div>
            <dt className="text-text-2">Decision snapshot</dt>
            <dd className="num">{t(round.decisionSnapshotAt)}</dd>
          </div>
          <div>
            <dt className="text-text-2">Fill snapshot</dt>
            <dd className="num">{t(round.fillSnapshotAt)}</dd>
          </div>
          <div>
            <dt className="text-text-2">Status</dt>
            <dd>
              {round.status.toLowerCase().replace(/_/g, ' ')}
              {round.statusReason ? ` (${round.statusReason})` : ''}
            </dd>
          </div>
        </dl>
      </div>
      <section aria-labelledby="moves" className="rounded-[var(--radius-panel)] bg-surface p-4">
        <h2 id="moves" className="condensed mb-3 text-lg font-semibold">
          Every move
        </h2>
        <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
          {participants
            .filter((p) => p.kind !== 'index')
            .map((p) => {
              const d = decisions.find((x) => x.participantId === p.id);
              return (
                <article
                  key={p.id}
                  id={p.slot}
                  className="rounded-[var(--radius-panel)] border border-line p-3"
                >
                  <header className="flex items-center gap-2">
                    <Chip p={p} size="sm" />
                    <h3 className="font-semibold">
                      {d ? verdict(d.status, d.actions) : 'No decision recorded'}
                    </h3>
                  </header>
                  {d ? (
                    <div className="mt-2 space-y-2 text-sm">
                      {d.strategy ? (
                        <p className="model-text">
                          <span className="font-semibold not-italic text-text">Strategy: </span>
                          {d.strategy}
                        </p>
                      ) : null}
                      {d.reasoning ? (
                        <details>
                          <summary className="min-h-11 cursor-pointer text-text-2">
                            Reasoning
                          </summary>
                          <p className="model-text">{d.reasoning}</p>
                        </details>
                      ) : null}
                      {d.actions.length ? (
                        <ul className="space-y-1">
                          {d.actions.map((x) => (
                            <li key={x.id}>
                              <span className="num">
                                {x.status === 'executed' && x.side && x.quantity !== null
                                  ? tradeVerb(
                                      x.side === 'BUY' ? 'BUY' : 'SELL',
                                      x.quantity,
                                      x.positionAfter,
                                    )
                                  : (x.side ?? x.sideRaw ?? '?')}{' '}
                                {x.quantity ?? String(x.quantityRaw ?? '?')}{' '}
                                {x.symbol ?? x.symbolRaw ?? '?'}
                              </span>
                              {': '}
                              {x.status === 'executed' ? (
                                <>
                                  filled at{' '}
                                  <span className="num">
                                    {x.pricePaise === null ? '—' : formatInr(x.pricePaise)}
                                  </span>{' '}
                                  (
                                  {x.priceSource === 'ask'
                                    ? 'best ask'
                                    : x.priceSource === 'bid'
                                      ? 'best bid'
                                      : 'last price ± 5 bps'}
                                  )
                                  {x.ledgerSeq ? (
                                    <>
                                      {' '}
                                      <Link className="link" href={`/trades/${x.ledgerSeq}`}>
                                        trade #{x.ledgerSeq}
                                      </Link>
                                    </>
                                  ) : null}
                                </>
                              ) : (
                                <>rejected: {x.rejectDetail ?? x.rejectCode}</>
                              )}
                              {x.why ? (
                                <span className="model-text block text-text-2">
                                  Why: {x.why.slice(0, arena.display.whyDisplayChars)}
                                </span>
                              ) : null}
                              {x.exitPlan ? (
                                <span className="model-text block text-text-2">
                                  Exit plan:{' '}
                                  {x.exitPlan.slice(0, arena.display.exitPlanDisplayChars)}{' '}
                                  <span className="not-italic">(published, never acted on)</span>
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {d.noteToSelf ? (
                        <p className="model-text text-text-2">Note to self: {d.noteToSelf}</p>
                      ) : null}
                      <p className="text-xs text-text-2 tabular-nums">
                        {d.servingModel ? `Served by ${d.servingModel}. ` : ''}
                        {d.latencyMs !== null ? `${d.latencyMs} ms. ` : ''}
                        {d.inputTokens !== null
                          ? `${d.inputTokens} in / ${d.outputTokens} out tokens. `
                          : ''}
                        {d.costUsd !== null
                          ? `${formatUsd(d.costUsd)}${d.costEstimated ? ' (estimated)' : ''}.`
                          : ''}
                        {d.rngSeed ? ` Seed ${d.rngSeed}.` : ''}
                      </p>
                      {d.answerText ? (
                        <details>
                          <summary className="min-h-11 cursor-pointer">Show full answer</summary>
                          <pre
                            tabIndex={0}
                            className="model-text max-h-96 overflow-auto rounded bg-bg p-2 text-xs"
                          >
                            {d.answerText}
                          </pre>
                        </details>
                      ) : null}
                      {d.privateBlock ? (
                        <details>
                          <summary className="min-h-11 cursor-pointer">
                            Private block (portfolio and history it saw)
                          </summary>
                          <pre
                            tabIndex={0}
                            className="model-text max-h-96 overflow-auto rounded bg-bg p-2 text-xs"
                          >
                            {d.privateBlock}
                          </pre>
                        </details>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
        </div>
      </section>
      {fills.length ? (
        <section
          aria-labelledby="fills"
          className="mt-6 rounded-[var(--radius-panel)] bg-surface p-4"
        >
          <h2 id="fills" className="condensed mb-2 text-lg font-semibold">
            Fills
          </h2>
          <div
            className="relative overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Scrollable table"
          >
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <caption className="sr-only">Fills in this round with price source</caption>
              <thead>
                <tr className="border-b border-line text-text-2">
                  <th scope="col" className="px-2 py-1 text-left font-normal">
                    Trade
                  </th>
                  <th scope="col" className="px-2 py-1 text-left font-normal">
                    Participant
                  </th>
                  <th scope="col" className="px-2 py-1 text-left font-normal">
                    Fill
                  </th>
                  <th scope="col" className="px-2 py-1 text-right font-normal">
                    Price
                  </th>
                  <th scope="col" className="px-2 py-1 text-left font-normal">
                    Source
                  </th>
                </tr>
              </thead>
              <tbody>
                {fills.map((f) => (
                  <tr key={f.seq} className="border-b border-line">
                    <td className="num px-2 py-1">
                      <Link
                        className="link inline-flex min-h-11 items-center"
                        href={`/trades/${f.seq}`}
                      >
                        #{f.seq}
                      </Link>
                    </td>
                    <td className="px-2 py-1">
                      {participants.find((p) => p.id === f.participantId)?.shortCode}
                    </td>
                    <td className="px-2 py-1">
                      {f.entryType === 'RETIRE'
                        ? 'Retired'
                        : `${f.side === 'BUY' ? 'Bought' : 'Sold'} ${f.quantity} ${f.symbol}`}
                    </td>
                    <td className="num px-2 py-1 text-right">
                      {f.pricePaise === null ? '—' : formatInr(f.pricePaise)}
                    </td>
                    <td className="px-2 py-1">{f.priceSource ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <section
        aria-labelledby="prompt"
        className="mt-6 space-y-3 rounded-[var(--radius-panel)] bg-surface p-4"
      >
        <h2 id="prompt" className="condensed text-lg font-semibold">
          What every model saw
        </h2>
        {season?.systemPrompt ? (
          <details>
            <summary className="min-h-11 cursor-pointer">The shared system prompt</summary>
            <pre
              tabIndex={0}
              className="model-text max-h-[32rem] overflow-auto rounded bg-bg p-2 text-xs"
            >
              {season.systemPrompt}
            </pre>
          </details>
        ) : null}
        {marketTable ? (
          <details>
            <summary className="min-h-11 cursor-pointer">The shared market table</summary>
            <pre tabIndex={0} className="max-h-[32rem] overflow-auto rounded bg-bg p-2 text-xs">
              {marketTable}
            </pre>
          </details>
        ) : (
          <p className="text-sm text-text-2">
            The full market table is published after that day&apos;s market close.
          </p>
        )}
      </section>
    </PageShell>
  );
}
