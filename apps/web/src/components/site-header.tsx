import Link from 'next/link';
import { MarketClock } from './market-clock';
import { ShadowBanner } from './banners';
import { slotTimes } from '@/lib/schedule';

export interface HeaderProps {
  mode: 'shadow' | 'live';
  paused: boolean;
  holidays: string[];
  seasonActive: boolean;
  subline?: string | null;
}

export function SiteHeader({ mode, paused, holidays, seasonActive, subline }: HeaderProps) {
  return (
    <>
      {mode === 'shadow' ? <ShadowBanner /> : null}
      <header className="mx-auto flex max-w-[1200px] items-start justify-between gap-4 px-4 py-3">
        <div>
          <Link href="/" className="condensed text-xl font-bold tracking-tight">
            AI Arena
          </Link>
          {subline ? <p className="text-sm text-text-2">{subline}</p> : null}
          <nav aria-label="Main" className="mt-1 flex flex-wrap gap-x-4 text-sm text-text-2">
            <Link className="inline-flex min-h-11 items-center hover:text-text" href="/rounds">
              Rounds
            </Link>
            <Link className="inline-flex min-h-11 items-center hover:text-text" href="/verify">
              Verify
            </Link>
            <Link className="inline-flex min-h-11 items-center hover:text-text" href="/status">
              Status
            </Link>
            <Link className="inline-flex min-h-11 items-center hover:text-text" href="/rules">
              Rules
            </Link>
          </nav>
        </div>
        <MarketClock
          clock={{ slots: slotTimes(), holidays }}
          paused={paused}
          latestRound={null}
          seasonActive={seasonActive}
        />
      </header>
    </>
  );
}
