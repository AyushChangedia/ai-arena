'use client';
import { useLayoutEffect, useRef } from 'react';
import Link from 'next/link';
import { formatInr, formatPct, direction } from '@arena/shared/format';

export interface ScoreItem {
  id: string;
  slot: string;
  rank: number;
  shortCode: string;
  color: string;
  kind: 'model' | 'index' | 'monkey';
  name: string;
  totalPaise: bigint | null;
  returnFrac: number | null;
}

/**
 * The score bug (SPEC §16.1): ranked by total value, sticky, horizontal scroll with snap.
 * When a new round is revealed it re-sorts with a FLIP animation; reduced motion makes it instant.
 */
export function ScoreBug({ items, revealKey }: { items: ScoreItem[]; revealKey: string | null }) {
  const refs = useRef(new Map<string, HTMLElement>());
  const last = useRef(new Map<string, DOMRect>());
  const lastKey = useRef(revealKey);
  useLayoutEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const changed = lastKey.current !== revealKey;
    lastKey.current = revealKey;
    if (changed && !reduce) {
      for (const [id, el] of refs.current) {
        const before = last.current.get(id);
        if (!before) continue;
        const after = el.getBoundingClientRect();
        const dx = before.left - after.left;
        if (dx)
          el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], {
            duration: 600,
            easing: 'cubic-bezier(.2,.8,.2,1)',
          });
      }
    }
    for (const [id, el] of refs.current) last.current.set(id, el.getBoundingClientRect());
  });
  return (
    <nav
      aria-label="Score bug: standings by total value"
      className="sticky top-0 z-20 border-y border-line bg-bg"
    >
      <ol className="scorebug relative mx-auto flex max-w-[1200px] gap-2 overflow-x-auto px-4 py-2">
        {items.map((it) => {
          const dir = it.returnFrac === null ? 'flat' : direction(it.returnFrac);
          return (
            <li
              key={it.id}
              ref={(el) => {
                if (el) refs.current.set(it.id, el);
                else refs.current.delete(it.id);
              }}
              className="shrink-0"
            >
              <Link
                href={`/models/${it.slot}`}
                className={`condensed relative flex min-h-11 items-center gap-2 rounded-[var(--radius-chip)] px-2 ${it.kind === 'model' ? 'bg-surface' : 'border border-line'}`}
              >
                <span className="num text-sm text-text-2">{it.rank}</span>
                <span className="text-sm font-bold" style={{ color: it.color }}>
                  {it.shortCode}
                </span>
                <span className="sr-only">{it.name}</span>
                <span className="num text-base font-semibold">
                  {it.totalPaise === null ? '—' : formatInr(it.totalPaise, { decimals: 0 })}
                </span>
                <span
                  className={`num text-sm ${dir === 'gain' ? 'text-gain' : dir === 'loss' ? 'text-loss' : 'text-text-2'}`}
                >
                  {it.returnFrac === null ? '—' : formatPct(it.returnFrac)}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
