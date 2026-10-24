import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { createPool } from '@arena/db';
import { createTestDb, type TestDb } from '../../../db/test/helpers';
import { persistSnapshot, loadSnapshot, type Snapshot } from '../../src/data/snapshot';
import { storeInstruments, storedMapping, recordUniverseVersion } from '../../src/data/universe';
import { storeBars, loadBars, refreshIndicators } from '../../src/data/market';
import {
  openIncident,
  resolveIncident,
  openIncidentCount,
  resolveIncidentsByPrefix,
} from '../../src/ops/incidents';

let db: TestDb;
let pool: pg.Pool;
beforeAll(async () => {
  db = await createTestDb('store');
  pool = createPool(db.engineUrl);
});
afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('market data persistence (engine_rw)', () => {
  it('stores and reloads a snapshot exactly', async () => {
    const t = new Date('2026-11-02T05:00:00.000Z');
    const s: Snapshot = {
      id: '00000000-0000-4000-8000-00000000c0de',
      purpose: 'decision',
      source: 'test',
      startedAt: t,
      finishedAt: t,
      raw: [{ a: 1 }],
      verdict: { status: 'rejected', reason: 'DATA_DEGRADED', detail: '6 of 50 quotes invalid' },
      quotes: [
        {
          symbol: 'TCS',
          ltpPaise: 341250n,
          bidPaise: 341200n,
          askPaise: 341250n,
          openPaise: 1n,
          highPaise: 2n,
          lowPaise: 1n,
          prevClosePaise: 340000n,
          volume: 10n,
          exchangeTime: t,
          parseError: null,
          valid: true,
          invalidReason: null,
          depthAvailable: true,
        },
        {
          symbol: 'INFY',
          ltpPaise: null,
          bidPaise: null,
          askPaise: null,
          openPaise: null,
          highPaise: null,
          lowPaise: null,
          prevClosePaise: null,
          volume: null,
          exchangeTime: null,
          parseError: 'x',
          valid: false,
          invalidReason: 'schema: ltp',
          depthAvailable: false,
        },
      ],
      indices: [
        {
          name: 'Nifty 50',
          valueX100: 2432145n,
          prevCloseX100: 2420000n,
          exchangeTime: t,
          parseError: null,
          valid: true,
          invalidReason: null,
        },
      ],
    };
    await persistSnapshot(pool, s);
    const back = await loadSnapshot(pool, s.id);
    expect(back?.verdict).toEqual(s.verdict);
    expect(back?.quotes.find((q) => q.symbol === 'TCS')).toMatchObject({
      ltpPaise: 341250n,
      askPaise: 341250n,
      depthAvailable: true,
      valid: true,
    });
    expect(back?.quotes.find((q) => q.symbol === 'INFY')).toMatchObject({
      ltpPaise: null,
      valid: false,
      invalidReason: 'schema: ltp',
    });
    expect(back?.indices[0]?.valueX100).toBe(2432145n);
    expect(await loadSnapshot(pool, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('stores the instrument mapping and falls back to it', async () => {
    await storeInstruments(
      pool,
      [{ symbol: 'TCS', brokerToken: '11536', exchange: 'NSE', name: 'TCS', tickSizePaise: 10 }],
      [{ name: 'Nifty 50', brokerToken: '99926000', exchange: 'NSE' }],
      '2026-11-02',
    );
    const m = await storedMapping(pool, ['TCS', 'INFY'], ['Nifty 50', 'India VIX']);
    expect(m.equities).toEqual([
      { symbol: 'TCS', brokerToken: '11536', exchange: 'NSE', name: 'TCS', tickSizePaise: 10 },
    ]);
    expect(m.unmapped.map((u) => u.symbol)).toEqual(['INFY']);
    expect(m.indices[0]?.brokerToken).toBe('99926000');
    expect(m.missingIndices.map((x) => x.name)).toEqual(['India VIX']);
    expect(m.refreshedOn).toBe('2026-11-02');
  });

  it('records universe versions only when the list changes', async () => {
    const u = {
      index: 'NIFTY 50' as const,
      effectiveFrom: '2026-09-30',
      sourceUrl: 'https://x.test',
      downloadedOn: '2026-10-24',
      constituents: [
        { symbol: 'B', name: 'b' },
        { symbol: 'A', name: 'a' },
      ],
    };
    await recordUniverseVersion(pool, u);
    await recordUniverseVersion(pool, u);
    await recordUniverseVersion(pool, { ...u, constituents: [{ symbol: 'C', name: 'c' }] });
    expect((await pool.query('SELECT count(*)::int AS n FROM universe_versions')).rows[0].n).toBe(
      2,
    );
  });

  it('stores bars and computes indicators from bars before the date', async () => {
    const bars = Array.from({ length: 22 }, (_, i) => ({
      date: `2026-10-${String(i + 1).padStart(2, '0')}`,
      openPaise: 100n,
      highPaise: 100n,
      lowPaise: 100n,
      closePaise: BigInt(100 + i),
      volume: 5n,
    }));
    await storeBars(pool, 'TCS', bars);
    await storeBars(pool, 'TCS', bars.slice(0, 1)); // upsert is idempotent
    expect(await loadBars(pool, 'TCS', '2026-10-22')).toHaveLength(21);
    await refreshIndicators(pool, ['TCS'], '2026-10-23');
    const r = (
      await pool.query(
        "SELECT sma20_paise, sma50_paise, rsi14 FROM indicators WHERE symbol = 'TCS'",
      )
    ).rows[0];
    expect(r.sma20_paise).toBe('112'); // mean of 102..121 = 111.5 -> 112
    expect(r.sma50_paise).toBeNull();
    expect(Number(r.rsi14)).toBe(100);
  });

  it('deduplicates incidents by key and resolves them', async () => {
    const i = {
      key: 'data:login',
      severity: 'critical' as const,
      title: 't',
      detail: 'd',
      publicMessage: 'p',
      scope: 'arena',
    };
    expect((await openIncident(pool, i)).isNew).toBe(true);
    expect((await openIncident(pool, i)).isNew).toBe(false);
    expect(await openIncidentCount(pool, 'data:')).toBe(1);
    expect(await resolveIncident(pool, 'data:login')).toBe(1);
    expect((await openIncident(pool, i)).isNew).toBe(true);
    expect(await resolveIncidentsByPrefix(pool, 'data:')).toBe(1);
  });
});
