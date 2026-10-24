import { randomUUID } from 'node:crypto';
import type { Queryable } from '@arena/db';
import type { MarketDataSession, Instrument, IndexInstrument } from './provider';
import {
  validateQuote,
  validateIndexQuote,
  snapshotVerdict,
  type ValidatedQuote,
  type ValidatedIndexQuote,
  type ValidationRules,
  type ValidationContext,
  type SnapshotVerdict,
} from './validate';

export type SnapshotPurpose = 'decision' | 'fill' | 'valuation';

export interface Snapshot {
  id: string;
  purpose: SnapshotPurpose;
  source: string;
  startedAt: Date;
  finishedAt: Date;
  quotes: ValidatedQuote[];
  indices: ValidatedIndexQuote[];
  verdict: SnapshotVerdict;
  raw: unknown[];
}

export interface TakeSnapshotArgs {
  session: MarketDataSession;
  source: string;
  purpose: SnapshotPurpose;
  equities: Instrument[];
  indices: IndexInstrument[];
  /** Universe symbols that couldn't be mapped today: recorded as NO_PRICE. */
  unmapped: string[];
  rules: ValidationRules;
  context: Omit<ValidationContext, 'snapshotTime'>;
  now?: () => Date;
}

export async function takeSnapshot(a: TakeSnapshotArgs): Promise<Snapshot> {
  const now = a.now ?? (() => new Date());
  const startedAt = now();
  const batch = await a.session.quotes(a.equities, a.indices);
  const finishedAt = now();
  const ctx: ValidationContext = { ...a.context, snapshotTime: finishedAt };
  const quotes = batch.quotes.map((q) => validateQuote(q, a.rules, ctx));
  for (const s of a.unmapped) {
    quotes.push({
      symbol: s,
      ltpPaise: null,
      bidPaise: null,
      askPaise: null,
      openPaise: null,
      highPaise: null,
      lowPaise: null,
      prevClosePaise: null,
      volume: null,
      exchangeTime: null,
      parseError: null,
      valid: false,
      invalidReason: 'no unique instrument mapping today',
      depthAvailable: false,
    });
  }
  quotes.sort((x, y) => x.symbol.localeCompare(y.symbol));
  const indices = batch.indices.map((i) => validateIndexQuote(i, a.rules, ctx));
  return {
    id: randomUUID(),
    purpose: a.purpose,
    source: a.source,
    startedAt,
    finishedAt,
    quotes,
    indices,
    verdict: snapshotVerdict(quotes, indices, a.rules, ctx),
    raw: batch.raw,
  };
}

export async function persistSnapshot(db: Queryable, s: Snapshot): Promise<void> {
  const valid = s.quotes.filter((q) => q.valid).length;
  await db.query(
    `INSERT INTO snapshots (id, purpose, fetch_started_at, fetch_finished_at, source, raw, valid_count, invalid_count, status, reject_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      s.id,
      s.purpose,
      s.startedAt,
      s.finishedAt,
      s.source,
      JSON.stringify(s.raw),
      valid,
      s.quotes.length - valid,
      s.verdict.status,
      s.verdict.status === 'rejected' ? `${s.verdict.reason}: ${s.verdict.detail}` : null,
    ],
  );
  for (const q of s.quotes) {
    await db.query(
      `INSERT INTO quotes (snapshot_id, symbol, ltp_paise, bid_paise, ask_paise, open_paise, high_paise, low_paise, prev_close_paise,
         volume, exchange_time, valid, invalid_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        s.id,
        q.symbol,
        q.ltpPaise,
        q.bidPaise,
        q.askPaise,
        q.openPaise,
        q.highPaise,
        q.lowPaise,
        q.prevClosePaise,
        q.volume,
        q.exchangeTime,
        q.valid,
        q.invalidReason,
      ],
    );
  }
  for (const i of s.indices) {
    await db.query(
      `INSERT INTO index_quotes (snapshot_id, name, value_x100, prev_close_x100, exchange_time, valid) VALUES ($1,$2,$3,$4,$5,$6)`,
      [s.id, i.name, i.valueX100, i.prevCloseX100, i.exchangeTime, i.valid],
    );
  }
}

const big = (v: string | null): bigint | null => (v === null ? null : BigInt(v));

/** Loads a stored snapshot (for replay, marks and the decide command). */
export async function loadSnapshot(db: Queryable, id: string): Promise<Snapshot | null> {
  const s = await db.query('SELECT * FROM snapshots WHERE id = $1', [id]);
  const row = s.rows[0];
  if (!row) return null;
  const q = await db.query('SELECT * FROM quotes WHERE snapshot_id = $1 ORDER BY symbol', [id]);
  const ix = await db.query('SELECT * FROM index_quotes WHERE snapshot_id = $1 ORDER BY name', [
    id,
  ]);
  const [reason, ...rest] = String(row.reject_reason ?? '').split(': ');
  return {
    id: row.id,
    purpose: row.purpose,
    source: row.source,
    startedAt: row.fetch_started_at,
    finishedAt: row.fetch_finished_at,
    raw: row.raw,
    verdict:
      row.status === 'ok'
        ? { status: 'ok' }
        : { status: 'rejected', reason: reason as 'DATA_DEGRADED', detail: rest.join(': ') },
    quotes: q.rows.map((r) => ({
      symbol: r.symbol,
      ltpPaise: big(r.ltp_paise),
      bidPaise: big(r.bid_paise),
      askPaise: big(r.ask_paise),
      openPaise: big(r.open_paise),
      highPaise: big(r.high_paise),
      lowPaise: big(r.low_paise),
      prevClosePaise: big(r.prev_close_paise),
      volume: big(r.volume),
      exchangeTime: r.exchange_time,
      parseError: null,
      valid: r.valid,
      invalidReason: r.invalid_reason,
      depthAvailable: r.bid_paise !== null && r.ask_paise !== null,
    })),
    indices: ix.rows.map((r) => ({
      name: r.name,
      valueX100: big(r.value_x100),
      prevCloseX100: big(r.prev_close_x100),
      exchangeTime: r.exchange_time,
      parseError: null,
      valid: r.valid,
      invalidReason: r.valid ? null : 'invalid',
    })),
  };
}
