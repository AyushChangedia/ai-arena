import Link from 'next/link';
import type { DecisionRow, HoldingRow, MarkRow, Participant, RoundRow } from '@arena/db/read';
import { formatInr, formatInt } from '@arena/shared/format';
import type { Standing } from '@/lib/view';
import { verdict, firstLine } from '@/lib/view';
import { Chip } from './chip';
import { Money, Pct, Pnl, Missing } from './num';
import { arena } from '@/lib/config';

/**
 * One panel per AI model (the owner's request, 2026-10-25): name, the ₹1,00,000 it started with,
 * what it's worth now, profit or loss in green or red, what it did in the latest round, and its
 * current portfolio. Every figure comes from the same delayed public views as the rest of the site.
 */
export function ModelCards({
  participants,
  standings,
  marks,
  holdings,
  latestRound,
  latestDecisions,
  startingCashPaise,
}: {
  participants: Participant[];
  standings: Standing[];
  marks: MarkRow[];
  holdings: HoldingRow[];
  latestRound: RoundRow | null;
  latestDecisions: DecisionRow[];
  startingCashPaise: bigint;
}) {
  const models = participants
    .filter((p) => p.kind === 'model')
    .map((p) => ({ p, s: standings.find((x) => x.participant.id === p.id) ?? null }))
    .sort((a, b) => (a.s?.rank ?? 99) - (b.s?.rank ?? 99));
  if (!models.length) return null;
  return (
    <section aria-labelledby="models-h" className="mt-6">
      <h2 id="models-h" className="condensed mb-3 text-lg font-semibold">
        The models
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {models.map(({ p, s }) => (
          <li key={p.id} className="min-w-0">
            <ModelCard
              p={p}
              s={s}
              cashPaise={latestCash(marks, p.id)}
              holdings={holdings.filter((h) => h.participantId === p.id)}
              round={latestRound}
              decision={latestDecisions.find((d) => d.participantId === p.id) ?? null}
              startingCashPaise={startingCashPaise}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function latestCash(marks: MarkRow[], participantId: string): bigint | null {
  let best: MarkRow | null = null;
  for (const m of marks)
    if (m.participantId === participantId && (!best || m.markedAt > best.markedAt)) best = m;
  return best ? best.cashPaise : null;
}

function ModelCard({
  p,
  s,
  cashPaise,
  holdings,
  round,
  decision,
  startingCashPaise,
}: {
  p: Participant;
  s: Standing | null;
  cashPaise: bigint | null;
  holdings: HoldingRow[];
  round: RoundRow | null;
  decision: DecisionRow | null;
  startingCashPaise: bigint;
}) {
  const total = s?.totalPaise ?? null;
  const change = total === null ? null : total - startingCashPaise;
  const headingId = `model-${p.slot}`;
  const firstReason = decision?.actions.find((a) => a.status === 'executed' && a.why)?.why ?? null;
  const intraday = arena.product === 'intraday_long_short' ? arena.intraday : undefined;
  return (
    <article
      aria-labelledby={headingId}
      className="flex h-full flex-col rounded-[var(--radius-panel)] bg-surface p-4"
    >
      <header className="flex items-start justify-between gap-2">
        <h3 id={headingId} className="flex min-w-0 items-center gap-2 font-semibold">
          <Chip p={p} />
          <span className="truncate" title={p.displayName}>
            {p.displayName}
          </span>
        </h3>
        {s ? <span className="num text-sm text-text-2">#{s.rank}</span> : null}
      </header>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt className="text-text-2">Started with</dt>
        <dd className="text-right">
          <Money paise={startingCashPaise} decimals={0} />
        </dd>
        <dt className="text-text-2">Worth now</dt>
        <dd className="condensed text-right text-lg font-semibold">
          <Money paise={total} decimals={0} missing="No round marked yet" />
        </dd>
        <dt className="text-text-2">Profit or loss</dt>
        <dd className="text-right">
          <Pnl paise={change} decimals={0} missing="No round marked yet" />
          {s?.returnFrac !== null && s?.returnFrac !== undefined ? (
            <span className="ml-1 text-xs">
              (<Pct frac={s.returnFrac} />)
            </span>
          ) : null}
        </dd>
      </dl>

      <div className="mt-3 border-t border-line pt-3 text-sm">
        <p className="text-text-2">{round ? `Last round, ${round.slotTime} IST` : 'Last round'}</p>
        {decision ? (
          <>
            <p className="font-medium">{verdict(decision.status, decision.actions)}</p>
            {firstReason ? (
              <p className="model-text mt-0.5 line-clamp-3 text-text-2">
                <span className="not-italic">Why: </span>“{firstReason}”
              </p>
            ) : decision.reasoning ? (
              <p className="model-text mt-0.5 line-clamp-2 text-text-2">
                {firstLine(decision.reasoning)}
              </p>
            ) : null}
          </>
        ) : (
          <p className="font-medium">No trades yet</p>
        )}
      </div>

      {decision?.strategy ? (
        <div className="mt-3 border-t border-line pt-3 text-sm">
          <p className="text-text-2">Strategy</p>
          <p className="model-text mt-0.5 line-clamp-4">
            {decision.strategy.slice(0, arena.display.strategyDisplayChars)}
          </p>
        </div>
      ) : null}

      <div className="mt-3 border-t border-line pt-3 text-sm">
        <p className="text-text-2">Portfolio</p>
        {cashPaise === null && !holdings.length ? (
          <p className="mt-1">
            All cash: <span className="num">{formatInr(startingCashPaise, { decimals: 0 })}</span>
          </p>
        ) : (
          <table className="mt-1 w-full">
            <caption className="sr-only">Positions of {p.displayName}</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Stock</th>
                <th scope="col">Shares</th>
                <th scope="col">Value</th>
                <th scope="col">Profit or loss</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h) => {
                const value =
                  h.lastPricePaise === null ? null : h.lastPricePaise * BigInt(h.quantity);
                const pnl =
                  h.lastPricePaise === null
                    ? null
                    : (h.lastPricePaise - h.avgCostPaise) * BigInt(h.quantity);
                return (
                  <tr key={h.symbol}>
                    <th scope="row" className="py-0.5 text-left font-medium">
                      {h.symbol}
                    </th>
                    <td className="num py-0.5 text-right text-text-2">
                      {formatInt(h.quantity)}
                      {h.quantity < 0 ? ' short' : ''}
                    </td>
                    <td className="py-0.5 text-right">
                      <Money paise={value} decimals={0} missing="No price yet" />
                    </td>
                    <td className="py-0.5 text-right text-xs">
                      <Pnl paise={pnl} decimals={0} missing="No price yet" />
                    </td>
                  </tr>
                );
              })}
              <tr>
                <th scope="row" className="py-0.5 text-left font-medium">
                  Cash
                </th>
                <td />
                <td className="py-0.5 text-right">
                  {cashPaise === null ? (
                    <Missing reason="No round marked yet" />
                  ) : (
                    <Money paise={cashPaise} decimals={0} />
                  )}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
        {intraday ? (
          <p className="mt-1 text-xs text-text-2">
            Intraday: every position is closed by {intraday.squareOffDeadline} IST.
          </p>
        ) : null}
      </div>

      <Link
        href={`/models/${p.slot}`}
        className="link mt-auto inline-flex min-h-11 items-center pt-2 text-sm"
      >
        All trades and reasoning for {p.shortCode}
      </Link>
    </article>
  );
}
