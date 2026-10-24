'use client';
import { useState } from 'react';
import Link from 'next/link';
import { formatInr, formatPct, formatPts, direction, formatInt } from '@arena/shared/format';

export interface StandingRow {
  id: string;
  slot: string;
  rank: number;
  movement: number | null;
  name: string;
  shortCode: string;
  color: string;
  kind: string;
  totalPaise: string | null;
  returnFrac: number | null;
  todayFrac: number | null;
  vsNifty: number | null;
  maxDrawdown: number | null;
  trades: number;
  status: string;
}

type Key = 'rank' | 'total' | 'return' | 'today' | 'vs' | 'dd' | 'trades';

const cls = (v: number | null) =>
  v === null
    ? 'text-text-2'
    : direction(v) === 'gain'
      ? 'text-gain'
      : direction(v) === 'loss'
        ? 'text-loss'
        : 'text-text-2';
const dash = (reason: string) => (
  <span title={reason} aria-label={`Not available: ${reason}`} className="text-text-2">
    —
  </span>
);

/** Sortable standings (SPEC §16.3). */
export function StandingsTable({ rows, caption }: { rows: StandingRow[]; caption: string }) {
  const [key, setKey] = useState<Key>('rank');
  const [asc, setAsc] = useState(true);
  const val = (r: StandingRow): number => {
    switch (key) {
      case 'rank':
        return r.rank;
      case 'total':
        return r.totalPaise === null ? -Infinity : Number(r.totalPaise);
      case 'return':
        return r.returnFrac ?? -Infinity;
      case 'today':
        return r.todayFrac ?? -Infinity;
      case 'vs':
        return r.vsNifty ?? -Infinity;
      case 'dd':
        return r.maxDrawdown ?? -Infinity;
      case 'trades':
        return r.trades;
    }
  };
  const sorted = [...rows].sort((a, b) => (asc ? val(a) - val(b) : val(b) - val(a)));
  const th = (k: Key, label: string, align = 'text-right') => (
    <th
      scope="col"
      aria-sort={key === k ? (asc ? 'ascending' : 'descending') : 'none'}
      className={`px-2 py-1 font-normal text-text-2 ${align}`}
    >
      <button
        type="button"
        className="min-h-11 w-full text-inherit"
        style={{ textAlign: align === 'text-right' ? 'right' : 'left' }}
        onClick={() => {
          if (key === k) setAsc(!asc);
          else {
            setKey(k);
            setAsc(k === 'rank');
          }
        }}
      >
        {label}
        {key === k ? <span aria-hidden> {asc ? '↑' : '↓'}</span> : null}
      </button>
    </th>
  );
  return (
    <div
      className="relative overflow-x-auto"
      tabIndex={0}
      role="region"
      aria-label="Scrollable table"
    >
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line">
            {th('rank', 'Rank', 'text-left')}
            <th scope="col" className="px-2 py-1 text-left font-normal text-text-2">
              Participant
            </th>
            {th('total', 'Value')}
            {th('return', 'Return')}
            {th('today', 'Today')}
            {th('vs', 'vs Nifty')}
            {th('dd', 'Max drawdown')}
            {th('trades', 'Trades')}
            <th scope="col" className="px-2 py-1 text-left font-normal text-text-2">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={r.id}
              className={`border-b border-line ${r.kind === 'model' ? '' : 'text-text-2'}`}
            >
              <td className="num px-2 py-2">
                {r.rank}
                {r.movement ? (
                  <span
                    className={`ml-1 text-xs ${r.movement > 0 ? 'text-gain' : 'text-loss'}`}
                    aria-label={
                      r.movement > 0
                        ? `up ${r.movement} since yesterday`
                        : `down ${-r.movement} since yesterday`
                    }
                  >
                    {r.movement > 0 ? `▲${r.movement}` : `▼${-r.movement}`}
                  </span>
                ) : null}
              </td>
              <td className="px-2 py-2">
                <Link
                  href={`/models/${r.slot}`}
                  className="inline-flex min-h-11 items-center gap-2"
                >
                  <span className="condensed font-bold" style={{ color: r.color }}>
                    {r.shortCode}
                  </span>
                  <span className="link">{r.name}</span>
                </Link>
              </td>
              <td className="num px-2 py-2 text-right">
                {r.totalPaise === null
                  ? dash('No mark yet')
                  : formatInr(BigInt(r.totalPaise), { decimals: 0 })}
              </td>
              <td className={`num px-2 py-2 text-right ${cls(r.returnFrac)}`}>
                {r.returnFrac === null ? dash('No mark yet') : formatPct(r.returnFrac)}
              </td>
              <td className={`num px-2 py-2 text-right ${cls(r.todayFrac)}`}>
                {r.todayFrac === null
                  ? dash('Needs a previous day-end mark')
                  : formatPct(r.todayFrac)}
              </td>
              <td className={`num px-2 py-2 text-right ${cls(r.vsNifty)}`}>
                {r.vsNifty === null
                  ? dash(r.kind === 'index' ? 'This is the Nifty benchmark' : 'No Nifty mark yet')
                  : formatPts(r.vsNifty)}
              </td>
              <td className="num px-2 py-2 text-right">
                {r.maxDrawdown === null
                  ? dash('No marks yet')
                  : formatPct(r.maxDrawdown, { arrow: false })}
              </td>
              <td className="num px-2 py-2 text-right">
                {r.kind === 'index' ? dash('The benchmark does not trade') : formatInt(r.trades)}
              </td>
              <td className="px-2 py-2">{r.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
