import Link from 'next/link';
import type { DecisionRow, Participant, RoundRow } from '@arena/db/read';
import { formatInr } from '@arena/shared/format';
import { arena } from '@/lib/config';
import { verdict, firstLine } from '@/lib/view';
import { roundNumber } from '@/lib/schedule';
import { Chip } from './chip';

/** "Round 7 at 11:30 IST": one row per participant with a verdict and the first line of its reasoning (SPEC §16.3). */
export function RoundPanel({
  round,
  decisions,
  participants,
  animate,
}: {
  round: RoundRow;
  decisions: DecisionRow[];
  participants: Participant[];
  animate: boolean;
}) {
  const order = participants.filter((p) => p.kind !== 'index');
  return (
    <section
      aria-labelledby="latest-round"
      className="rounded-[var(--radius-panel)] bg-surface p-4"
    >
      <h2 id="latest-round" className="condensed text-lg font-semibold">
        <Link href={`/rounds/${round.id}`} className="link">
          Round {roundNumber(round.slotTime)} at {round.slotTime} IST
        </Link>
        <span className="ml-2 text-sm font-normal text-text-2">{round.tradingDate}</span>
      </h2>
      {round.status !== 'COMPLETED' ? (
        <p className="text-sm text-text-2">
          Status: {round.status.toLowerCase().replace(/_/g, ' ')}
          {round.statusReason ? ` (${round.statusReason})` : ''}
        </p>
      ) : null}
      <ul className="mt-3 divide-y divide-line">
        {order.map((p, i) => {
          const d = decisions.find((x) => x.participantId === p.id);
          return (
            <li
              key={p.id}
              className={`py-2 ${animate ? 'reveal-row' : ''}`}
              style={animate ? { animationDelay: `${i * 120}ms` } : undefined}
            >
              <details>
                <summary className="flex min-h-11 cursor-pointer list-none items-start gap-3">
                  <Chip p={p} size="sm" />
                  <span className="flex-1">
                    <span className="block font-medium">
                      {d ? verdict(d.status, d.actions) : 'No decision recorded'}
                    </span>
                    {d?.reasoning ? (
                      <span className="model-text block text-sm text-text-2">
                        {firstLine(d.reasoning)}
                      </span>
                    ) : null}
                  </span>
                </summary>
                {d ? (
                  <div className="mt-2 space-y-2 pl-1 text-sm">
                    {d.reasoning ? (
                      <p className="model-text prose-measure">
                        {d.reasoning.slice(0, arena.display.reasoningDisplayChars)}
                      </p>
                    ) : null}
                    {d.actions.length ? (
                      <ul className="space-y-1">
                        {d.actions.map((a) => (
                          <li key={a.id} className="num">
                            {a.status === 'executed' ? (
                              <>
                                {a.side === 'BUY' ? 'Bought' : 'Sold'} {a.quantity} {a.symbol} at{' '}
                                {a.pricePaise === null ? '—' : formatInr(a.pricePaise)} (
                                {a.priceSource === 'ask'
                                  ? 'best ask'
                                  : a.priceSource === 'bid'
                                    ? 'best bid'
                                    : 'last price ± 5 bps'}
                                ), charges{' '}
                                {a.chargesTotalPaise === null
                                  ? '—'
                                  : formatInr(a.chargesTotalPaise)}
                                {a.ledgerSeq ? (
                                  <>
                                    {' '}
                                    <Link className="link" href={`/trades/${a.ledgerSeq}`}>
                                      trade #{a.ledgerSeq}
                                    </Link>
                                  </>
                                ) : null}
                              </>
                            ) : (
                              <>Rejected: {a.rejectDetail ?? a.rejectCode}</>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <Link
                      className="link inline-flex min-h-11 items-center"
                      href={`/rounds/${round.id}#${p.slot}`}
                    >
                      Show full answer
                    </Link>
                  </div>
                ) : null}
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
