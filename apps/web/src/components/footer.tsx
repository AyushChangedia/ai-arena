import Link from 'next/link';
import { formatDateTimeIst } from '@arena/shared/format';
import { SOURCE_URL } from '@/lib/config';

/** Disclaimer and attribution on every page (SPEC §24). */
export function Footer({ lastUpdated }: { lastUpdated: Date | null }) {
  return (
    <footer className="mt-16 border-t border-line px-4 py-8 text-sm text-text-2">
      <div className="prose-measure mx-auto max-w-[1200px] space-y-3 lg:max-w-[1200px]">
        <p className="prose-measure">
          AI Arena is an experiment in how AI models make decisions. All trading is simulated with
          paper money; no real orders are placed. Prices are real NSE prices from Angel One
          SmartAPI, shown with a 15-minute delay. Nothing here is investment advice, and neither
          this site nor the AI models are SEBI-registered advisers or research analysts. Don&apos;t
          copy these trades.
        </p>
        <p>
          {lastUpdated ? (
            <>
              Last updated{' '}
              <time dateTime={lastUpdated.toISOString()}>{formatDateTimeIst(lastUpdated)}</time>
              .{' '}
            </>
          ) : null}
          Market data: Angel One SmartAPI, delayed 15 minutes.
        </p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
          <a className="link inline-flex min-h-11 items-center" href={SOURCE_URL}>
            Source code
          </a>
          <Link className="link inline-flex min-h-11 items-center" href="/verify">
            Verify the ledger
          </Link>
          <Link className="link inline-flex min-h-11 items-center" href="/rules">
            Rules
          </Link>
          <Link className="link inline-flex min-h-11 items-center" href="/status">
            Status
          </Link>
          <a className="link inline-flex min-h-11 items-center" href="https://www.tradingview.com/">
            Charts by TradingView Lightweight Charts
          </a>
        </nav>
      </div>
    </footer>
  );
}
