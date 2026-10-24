import { DateTime } from 'luxon';
import type { Queryable } from '@arena/db';
import type { ArenaConfig, Universe } from '@arena/shared/schemas';
import type { MarketDataProvider, MarketDataSession, Candle, Instrument } from './provider';
import { resolveMapping, storedMapping, type MappedUniverse } from './universe';
import { takeSnapshot, type Snapshot, type SnapshotPurpose } from './snapshot';
import { istDate } from './validate';
import { computeIndicators } from './indicators';

export function indexNames(arena: ArenaConfig): string[] {
  return [arena.marketData.indexName, arena.marketData.vixName];
}

/** Is `t` within NSE's continuous session (09:15–15:30 IST)? Used for the freshness rule. */
export function inMarketHours(t: Date): boolean {
  const d = DateTime.fromJSDate(t, { zone: 'Asia/Kolkata' });
  const m = d.hour * 60 + d.minute;
  return d.weekday <= 5 && m >= 9 * 60 + 15 && m <= 15 * 60 + 30;
}

export async function freshMapping(
  provider: MarketDataProvider,
  universe: Universe,
  arena: ArenaConfig,
): Promise<MappedUniverse> {
  const symbols = universe.constituents.map((c) => c.symbol);
  const master = await provider.instruments(symbols, indexNames(arena));
  return resolveMapping(master, symbols, indexNames(arena));
}

export async function mappingFromDb(
  db: Queryable,
  universe: Universe,
  arena: ArenaConfig,
  extraSymbols: string[] = [],
) {
  const symbols = [...new Set([...universe.constituents.map((c) => c.symbol), ...extraSymbols])];
  return storedMapping(db, symbols, indexNames(arena));
}

export interface SnapshotRequest {
  session: MarketDataSession;
  source: string;
  purpose: SnapshotPurpose;
  mapping: MappedUniverse;
  arena: ArenaConfig;
  exDateToday?: Set<string>;
  now?: () => Date;
  /** Override for tests and dry runs outside market hours. */
  checkFreshness?: boolean;
}

export function snapshotFor(r: SnapshotRequest): Promise<Snapshot> {
  const now = r.now ?? (() => new Date());
  const t = now();
  return takeSnapshot({
    session: r.session,
    source: r.source,
    purpose: r.purpose,
    equities: r.mapping.equities,
    indices: r.mapping.indices,
    unmapped: r.mapping.unmapped.map((u) => u.symbol),
    rules: r.arena.limits,
    context: {
      checkFreshness: r.checkFreshness ?? inMarketHours(t),
      exDateToday: r.exDateToday ?? new Set(),
      requiredIndex: r.arena.marketData.indexName,
      tradingDate: istDate(t),
    },
    now,
  });
}

export async function storeBars(db: Queryable, symbol: string, bars: Candle[]): Promise<number> {
  let n = 0;
  for (const b of bars) {
    const r = await db.query(
      `INSERT INTO daily_bars (symbol, date, open_paise, high_paise, low_paise, close_paise, volume) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (symbol, date) DO UPDATE SET open_paise = EXCLUDED.open_paise, high_paise = EXCLUDED.high_paise,
         low_paise = EXCLUDED.low_paise, close_paise = EXCLUDED.close_paise, volume = EXCLUDED.volume`,
      [symbol, b.date, b.openPaise, b.highPaise, b.lowPaise, b.closePaise, b.volume],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

export async function loadBars(
  db: Queryable,
  symbol: string,
  beforeDate: string,
  limit = 80,
): Promise<Candle[]> {
  const r = await db.query(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, open_paise, high_paise, low_paise, close_paise, volume FROM daily_bars
     WHERE symbol = $1 AND date < $2 ORDER BY date DESC LIMIT $3`,
    [symbol, beforeDate, limit],
  );
  return r.rows
    .map((x) => ({
      date: x.date,
      openPaise: BigInt(x.open_paise),
      highPaise: BigInt(x.high_paise),
      lowPaise: BigInt(x.low_paise),
      closePaise: BigInt(x.close_paise),
      volume: BigInt(x.volume),
    }))
    .reverse();
}

/** Fetches daily candles for each instrument between two dates and stores them; returns per-symbol counts. */
export async function backfillBars(
  db: Queryable,
  session: MarketDataSession,
  instruments: Instrument[],
  fromDate: string,
  toDate: string,
): Promise<{ symbol: string; bars: number; error?: string }[]> {
  const out: { symbol: string; bars: number; error?: string }[] = [];
  for (const inst of instruments) {
    try {
      const bars = (await session.dailyCandles(inst, fromDate, toDate)).filter(
        (b) => b.date <= toDate,
      );
      await storeBars(db, inst.symbol, bars);
      out.push({ symbol: inst.symbol, bars: bars.length });
    } catch (e) {
      out.push({ symbol: inst.symbol, bars: 0, error: (e as Error).message });
    }
  }
  return out;
}

/** Recomputes indicators as of `asOfDate` from bars strictly before it. */
export async function refreshIndicators(
  db: Queryable,
  symbols: string[],
  asOfDate: string,
): Promise<number> {
  let n = 0;
  for (const s of symbols) {
    const bars = await loadBars(db, s, asOfDate, 80);
    const ind = computeIndicators(bars);
    await db.query(
      `INSERT INTO indicators (symbol, date, sma20_paise, sma50_paise, rsi14, avg_vol_20d) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (symbol, date) DO UPDATE SET sma20_paise = EXCLUDED.sma20_paise, sma50_paise = EXCLUDED.sma50_paise,
         rsi14 = EXCLUDED.rsi14, avg_vol_20d = EXCLUDED.avg_vol_20d`,
      [s, asOfDate, ind.sma20Paise, ind.sma50Paise, ind.rsi14, ind.avgVol20d],
    );
    n++;
  }
  return n;
}

export function summariseSnapshot(s: Snapshot): string {
  const valid = s.quotes.filter((q) => q.valid);
  const depth = valid.filter((q) => q.depthAvailable).length;
  const idx = s.indices
    .map((i) => `${i.name}: ${i.valid ? 'valid' : `invalid (${i.invalidReason})`}`)
    .join('; ');
  const verdict =
    s.verdict.status === 'ok' ? 'accepted' : `rejected ${s.verdict.reason}: ${s.verdict.detail}`;
  return `${valid.length}/${s.quotes.length} valid quotes, ${depth} with depth. ${idx}. Snapshot ${verdict}.`;
}
