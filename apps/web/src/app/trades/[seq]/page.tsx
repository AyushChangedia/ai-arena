import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cacheLife, cacheTag } from 'next/cache';
import type { LedgerEntry } from '@arena/shared/ledger-hash';
import { tradeVerb, formatInr, formatDateTimeIst, formatInt } from '@arena/shared/format';
import { fees } from '@/lib/config';
import { loadTrade, loadArena } from '@/lib/data';
import { holidayDates } from '@/lib/holidays';
import { PageShell, PageFallback } from '@/components/page-shell';
import { Unreachable } from '@/components/banners';
import { Missing } from '@/components/num';
import { CheckTrade } from '@/components/check-trade';
import type { LedgerRow } from '@arena/db/read';

export const metadata = { title: 'Trade' };

export default function Page({ params }: { params: Promise<{ seq: string }> }) {
  return (
    <Suspense fallback={<PageFallback />}>
      <Resolved params={params} />
    </Suspense>
  );
}
async function Resolved({ params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params;
  return <TradePage seq={seq} />;
}

/** The exact ledger entry, in the shape the hash covers (strings for integers, ISO times). */
function toEntry(e: LedgerRow): LedgerEntry {
  return {
    seq: e.seq,
    id: e.id,
    season_id: e.seasonId,
    participant_id: e.participantId,
    round_id: e.roundId,
    action_id: e.actionId,
    entry_type: e.entryType as LedgerEntry['entry_type'],
    symbol: e.symbol,
    side: e.side,
    quantity: e.quantity,
    price_paise: e.pricePaise?.toString() ?? null,
    price_source: e.priceSource,
    snapshot_id: e.snapshotId,
    gross_paise: e.grossPaise.toString(),
    charges: e.charges,
    charges_total_paise: e.chargesTotalPaise.toString(),
    cash_delta_paise: e.cashDeltaPaise.toString(),
    cash_after_paise: e.cashAfterPaise.toString(),
    position_after: e.positionAfter,
    avg_cost_after_paise: e.avgCostAfterPaise?.toString() ?? null,
    realized_pnl_paise: e.realizedPnlPaise?.toString() ?? null,
    note: e.note,
    ref_seq: e.refSeq,
    occurred_at: e.occurredAt.toISOString(),
    reveal_at: e.revealAt.toISOString(),
    prev_hash: e.prevHash,
  };
}

const CHARGE_LABELS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(fees.charges).map(([k, v]) => [k, v.label])),
  gst: fees.gst.label,
  dp: fees.dpCharge?.label ?? 'DP charge',
};

async function TradePage({ seq }: { seq: string }) {
  'use cache';
  cacheTag('detail');
  cacheLife('arena');
  const holidays = holidayDates();
  const [r, a] = await Promise.all([loadTrade(seq), loadArena()]);
  if (!r.ok || !a.ok) {
    cacheLife('seconds'); // never keep an outage in the cache
    return <Unreachable />;
  }
  if (!r.data) notFound();
  const { entry: e, neighbours, participant, action, cashBeforePaise, snapshotAt, round } = r.data;
  const title =
    (e.entryType === 'BUY' || e.entryType === 'SELL') && e.quantity !== null
      ? `${tradeVerb(e.entryType, e.quantity, e.positionAfter)} ${e.quantity} ${e.symbol}`
      : e.entryType.replace(/_/g, ' ').toLowerCase();
  const squareOff = round?.kind === 'square_off';
  return (
    <PageShell
      mode={a.data.mode}
      status={a.data.status}
      holidays={holidays}
      seasonActive={a.data.season?.status === 'active'}
      lastUpdated={a.data.lastUpdated}
    >
      <div className="py-6">
        <p className="text-sm text-text-2">Trade #{e.seq}</p>
        <h1 className="condensed text-2xl font-bold">
          {participant ? `${participant.shortCode}: ` : ''}
          {title}
        </h1>
      </div>
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <section aria-labelledby="fill" className="rounded-[var(--radius-panel)] bg-surface p-4">
          <h2 id="fill" className="condensed mb-2 text-lg font-semibold">
            The fill
          </h2>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-text-2">Side</dt>
            <dd>{e.side ?? '—'}</dd>
            <dt className="text-text-2">Stock</dt>
            <dd>{e.symbol ?? '—'}</dd>
            <dt className="text-text-2">Quantity</dt>
            <dd className="num">{e.quantity === null ? '—' : formatInt(e.quantity)}</dd>
            <dt className="text-text-2">Fill price</dt>
            <dd className="num">
              {e.pricePaise === null ? (
                <Missing reason="Not a trade" />
              ) : (
                `${formatInr(e.pricePaise)} (${e.priceSource === 'ask' ? 'best ask' : e.priceSource === 'bid' ? 'best bid' : 'last price ± 5 bps'})`
              )}
            </dd>
            <dt className="text-text-2">Snapshot time</dt>
            <dd className="num">{snapshotAt ? formatDateTimeIst(snapshotAt) : '—'}</dd>
            <dt className="text-text-2">Trade value</dt>
            <dd className="num">{formatInr(e.grossPaise)}</dd>
            {Object.entries(e.charges).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-text-2">{CHARGE_LABELS[k] ?? k}</dt>
                <dd className="num">{formatInr(BigInt(v))}</dd>
              </div>
            ))}
            <dt className="text-text-2">Total charges</dt>
            <dd className="num">{formatInr(e.chargesTotalPaise)}</dd>
            <dt className="text-text-2">Cash before</dt>
            <dd className="num">{formatInr(cashBeforePaise)}</dd>
            <dt className="text-text-2">Cash after</dt>
            <dd className="num">{formatInr(e.cashAfterPaise)}</dd>
            <dt className="text-text-2">Position after</dt>
            <dd className="num">{e.positionAfter === null ? '—' : formatInt(e.positionAfter)}</dd>
            <dt className="text-text-2">Realised P&amp;L</dt>
            <dd className="num">
              {e.realizedPnlPaise === null ? (
                <Missing reason="Only a trade that closes a position realises P&L" />
              ) : (
                formatInr(e.realizedPnlPaise)
              )}
            </dd>
          </dl>
          {squareOff ? (
            <p className="mt-3 text-sm">
              Square-off: the engine closed this position (intraday rule, nothing is held
              overnight). The model did not choose this trade.
            </p>
          ) : (
            <>
              {action?.why ? (
                <p className="model-text mt-3 text-sm">The model&apos;s reason: {action.why}</p>
              ) : null}
              {action?.exitPlan ? (
                <p className="model-text mt-2 text-sm">
                  Its exit plan: {action.exitPlan}{' '}
                  <span className="text-text-2">(published, never acted on)</span>
                </p>
              ) : null}
            </>
          )}
          {e.note ? <p className="model-text mt-3 text-sm text-text-2">Note: {e.note}</p> : null}
          <p className="mt-3 text-sm">
            {round ? (
              <Link className="link inline-flex min-h-11 items-center" href={`/rounds/${round.id}`}>
                The round
              </Link>
            ) : null}
            {participant ? (
              <Link
                className="link ml-4 inline-flex min-h-11 items-center"
                href={`/rounds/${round?.id ?? ''}#${participant.slot}`}
              >
                The decision
              </Link>
            ) : null}
          </p>
        </section>
        <section aria-labelledby="ledger" className="rounded-[var(--radius-panel)] bg-surface p-4">
          <h2 id="ledger" className="condensed mb-2 text-lg font-semibold">
            In the ledger
          </h2>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-text-2">seq</dt>
              <dd className="num">{e.seq}</dd>
            </div>
            <div>
              <dt className="text-text-2">prev_hash</dt>
              <dd className="tabular-nums break-all">{e.prevHash}</dd>
            </div>
            <div>
              <dt className="text-text-2">hash</dt>
              <dd className="tabular-nums break-all">{e.hash}</dd>
            </div>
          </dl>
          <nav aria-label="Neighbouring entries" className="mt-3 flex gap-4 text-sm">
            {neighbours.prev ? (
              <Link
                className="link inline-flex min-h-11 items-center"
                href={`/trades/${neighbours.prev}`}
              >
                Previous entry #{neighbours.prev}
              </Link>
            ) : null}
            {neighbours.next ? (
              <Link
                className="link inline-flex min-h-11 items-center"
                href={`/trades/${neighbours.next}`}
              >
                Next entry #{neighbours.next}
              </Link>
            ) : null}
          </nav>
          <div className="mt-4">
            <CheckTrade entry={toEntry(e)} expectedHash={e.hash} />
          </div>
        </section>
      </div>
    </PageShell>
  );
}
