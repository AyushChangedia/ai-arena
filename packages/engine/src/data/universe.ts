import type { Queryable } from '@arena/db';
import type { Universe } from '@arena/shared/schemas';
import type { InstrumentMaster, Instrument, IndexInstrument } from './provider';

export interface MappedUniverse {
  equities: Instrument[];
  indices: IndexInstrument[];
  unmapped: { symbol: string; reason: string }[];
  missingIndices: { name: string; reason: string }[];
}

export function resolveMapping(
  master: InstrumentMaster,
  symbols: string[],
  indexNames: string[],
): MappedUniverse {
  const out: MappedUniverse = { equities: [], indices: [], unmapped: [], missingIndices: [] };
  for (const s of symbols) {
    const m = master.equities.get(s);
    if (!m) out.unmapped.push({ symbol: s, reason: 'not looked up' });
    else if ('error' in m)
      out.unmapped.push({ symbol: s, reason: `${m.error} (${m.candidates} candidates)` });
    else out.equities.push(m);
  }
  for (const n of indexNames) {
    const m = master.indices.get(n);
    if (!m) out.missingIndices.push({ name: n, reason: 'not looked up' });
    else if ('error' in m)
      out.missingIndices.push({ name: n, reason: `${m.error} (${m.candidates} candidates)` });
    else out.indices.push(m);
  }
  return out;
}

/** Stores today's instrument mapping. The previous mapping stays for symbols not refreshed. */
export async function storeInstruments(
  db: Queryable,
  equities: Instrument[],
  indices: IndexInstrument[],
  date: string,
): Promise<void> {
  for (const e of equities) {
    await db.query(
      `INSERT INTO instruments (symbol, broker_token, exchange, name, tick_size_paise, refreshed_on) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (symbol) DO UPDATE SET broker_token = EXCLUDED.broker_token, exchange = EXCLUDED.exchange, name = EXCLUDED.name,
         tick_size_paise = EXCLUDED.tick_size_paise, refreshed_on = EXCLUDED.refreshed_on`,
      [e.symbol, e.brokerToken, e.exchange, e.name, e.tickSizePaise, date],
    );
  }
  for (const i of indices) {
    await db.query(
      `INSERT INTO instruments (symbol, broker_token, exchange, name, tick_size_paise, refreshed_on) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (symbol) DO UPDATE SET broker_token = EXCLUDED.broker_token, refreshed_on = EXCLUDED.refreshed_on`,
      [`INDEX:${i.name}`, i.brokerToken, i.exchange, i.name, 0, date],
    );
  }
}

/** The latest successful mapping, used when today's pre-market job hasn't run (SPEC §12.4). */
export async function storedMapping(
  db: Queryable,
  symbols: string[],
  indexNames: string[],
): Promise<MappedUniverse & { refreshedOn: string | null }> {
  const r = await db.query<{
    symbol: string;
    broker_token: string;
    exchange: string;
    name: string;
    tick_size_paise: number;
    refreshed_on: string;
  }>(
    "SELECT symbol, broker_token, exchange, name, tick_size_paise, to_char(refreshed_on,'YYYY-MM-DD') AS refreshed_on FROM instruments",
  );
  const by = new Map(r.rows.map((x) => [x.symbol, x]));
  const out: MappedUniverse & { refreshedOn: string | null } = {
    equities: [],
    indices: [],
    unmapped: [],
    missingIndices: [],
    refreshedOn: null,
  };
  for (const s of symbols) {
    const x = by.get(s);
    if (x) {
      out.equities.push({
        symbol: s,
        brokerToken: x.broker_token,
        exchange: x.exchange,
        name: x.name,
        tickSizePaise: x.tick_size_paise,
      });
      if (!out.refreshedOn || x.refreshed_on > out.refreshedOn) out.refreshedOn = x.refreshed_on;
    } else out.unmapped.push({ symbol: s, reason: 'no stored mapping' });
  }
  for (const n of indexNames) {
    const x = by.get(`INDEX:${n}`);
    if (x) out.indices.push({ name: n, brokerToken: x.broker_token, exchange: x.exchange });
    else out.missingIndices.push({ name: n, reason: 'no stored mapping' });
  }
  return out;
}

export async function recordUniverseVersion(db: Queryable, u: Universe): Promise<void> {
  const symbols = u.constituents.map((c) => c.symbol).sort();
  const last = await db.query<{ symbols: string[] }>(
    'SELECT symbols FROM universe_versions ORDER BY id DESC LIMIT 1',
  );
  const prev = last.rows[0]?.symbols ? [...last.rows[0].symbols].sort() : null;
  if (prev && prev.join(',') === symbols.join(',')) return;
  await db.query(
    'INSERT INTO universe_versions (effective_from, symbols, source_url) VALUES ($1,$2,$3)',
    [u.effectiveFrom, symbols, u.sourceUrl],
  );
}

/** True in the last two weeks of March and September, when NSE rebalances the index (SPEC §8.2). */
export function isRebalanceReminderWindow(isoDate: string): boolean {
  const [, m, d] = isoDate.split('-').map(Number);
  return (m === 3 || m === 9) && (d ?? 0) >= 17;
}
