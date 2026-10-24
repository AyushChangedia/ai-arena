import { describe, it, expect } from 'vitest';
import { computeIndicators, rsi, closeNDaysAgo, returnSince } from '../../src/data/indicators';
import { importNifty50Csv, importNseHolidays, splitCsvLine } from '../../src/data/importers';
import { TokenBucket } from '../../src/data/rate-limit';
import { totpNow, msUntilNextTotpWindow } from '../../src/data/totp';
import { httpJson, HttpError, redactUrl } from '../../src/data/http';
import { resolveMapping, isRebalanceReminderWindow } from '../../src/data/universe';
import { inMarketHours, summariseSnapshot, snapshotFor } from '../../src/data/market';
import { sanitize } from '../../src/ops/fixtures';
import type { Candle, MarketDataSession } from '../../src/data/provider';
import { must, loadArena } from '../../src/config/load';

const bar = (i: number, close: bigint, vol = 100n): Candle => ({
  date: `2026-01-${String(i + 1).padStart(2, '0')}`,
  openPaise: close,
  highPaise: close,
  lowPaise: close,
  closePaise: close,
  volume: vol,
});

describe('indicators (SPEC §8.5)', () => {
  it('omits values when history is too short', () => {
    expect(computeIndicators([bar(0, 100n)])).toEqual({
      sma20Paise: null,
      sma50Paise: null,
      rsi14: null,
      avgVol20d: null,
    });
  });
  it('computes SMA, average volume and RSI', () => {
    const bars = Array.from({ length: 25 }, (_, i) =>
      bar(i, BigInt(1000 + i * 10), BigInt(100 + i)),
    );
    const ind = computeIndicators(bars.slice().reverse());
    expect(ind.sma20Paise).toBe(1145n); // mean of 1050..1240
    expect(ind.sma50Paise).toBeNull();
    expect(ind.avgVol20d).toBe(115n);
    expect(ind.rsi14).toBe(100);
    expect(rsi(Array.from({ length: 16 }, () => 5n))).toBe(50);
    const zigzag = Array.from({ length: 30 }, (_, i) => BigInt(1000 + (i % 2 ? 20 : 0) + i));
    const r = rsi(zigzag)!;
    expect(r).toBeGreaterThan(50);
    expect(r).toBeLessThan(100);
  });
  it('finds closes N trading days ago and returns', () => {
    const bars = Array.from({ length: 6 }, (_, i) => bar(i, BigInt(100 + i)));
    expect(closeNDaysAgo(bars, 5)).toBe(101n);
    expect(closeNDaysAgo(bars, 20)).toBeNull();
    expect(returnSince(110n, 100n)).toBeCloseTo(0.1);
    expect(returnSince(110n, null)).toBeNull();
  });
});

describe('importers', () => {
  const header = 'Company Name,Industry,Symbol,Series,ISIN Code';
  const rows = Array.from(
    { length: 50 },
    (_, i) => `"Company ${i}, Ltd.",Industry ${i},SYM${i},EQ,INE00000${String(i).padStart(4, '0')}`,
  );
  it('imports the niftyindices CSV', () => {
    const u = importNifty50Csv([header, ...rows].join('\n'), {
      sourceUrl: 'https://x.test/a.csv',
      effectiveFrom: '2026-09-30',
      downloadedOn: '2026-10-24',
    });
    expect(u.constituents).toHaveLength(50);
    expect(u.constituents[0]).toEqual({
      symbol: 'SYM0',
      name: 'Company 0, Ltd.',
      industry: 'Industry 0',
      isin: 'INE000000000',
    });
  });
  it('rejects the wrong file or the wrong count', () => {
    expect(() =>
      importNifty50Csv('a,b\n1,2', {
        sourceUrl: 'https://x.test',
        effectiveFrom: '2026-09-30',
        downloadedOn: '2026-10-24',
      }),
    ).toThrow(/missing the "Company Name"/);
    expect(() =>
      importNifty50Csv([header, ...rows.slice(1)].join('\n'), {
        sourceUrl: 'https://x.test',
        effectiveFrom: '2026-09-30',
        downloadedOn: '2026-10-24',
      }),
    ).toThrow();
  });
  it('splits quoted CSV cells', () => {
    expect(splitCsvLine('"a ""b""",c, d ')).toEqual(['a "b"', 'c', 'd']);
  });
  it('imports NSE holiday JSON (CM segment) and CSV', () => {
    const json = JSON.stringify({
      CM: [
        { tradingDate: '26-Jan-2030', weekDay: 'Saturday', description: 'Test day', Sr_no: 1 },
        { tradingDate: '01-Jan-2031', description: 'Other year' },
      ],
      FO: [],
    });
    const c = importNseHolidays(json, {
      year: 2030,
      sourceUrl: 'https://x.test',
      downloadedOn: '2030-01-01',
    });
    expect(c.holidays).toEqual([{ date: '2030-01-26', description: 'Test day' }]);
    const csv = importNseHolidays(
      'Sr. No,Date,Day,Description\n1,2030-03-01,Fri,A\n2,15-Aug-2030,Thu,B',
      { year: 2030, sourceUrl: 'https://x.test', downloadedOn: '2030-01-01' },
    );
    expect(csv.holidays.map((h) => h.date)).toEqual(['2030-03-01', '2030-08-15']);
    expect(() =>
      importNseHolidays('{"FO": []}', {
        year: 2030,
        sourceUrl: 'https://x.test',
        downloadedOn: '2030-01-01',
      }),
    ).toThrow(/CM/);
    expect(() =>
      importNseHolidays('{"CM": [{"x": 1}]}', {
        year: 2030,
        sourceUrl: 'https://x.test',
        downloadedOn: '2030-01-01',
      }),
    ).toThrow(/missing/);
    expect(() =>
      importNseHolidays('a,b\n1,2', {
        year: 2030,
        sourceUrl: 'https://x.test',
        downloadedOn: '2030-01-01',
      }),
    ).toThrow(/Date column/);
    expect(() =>
      importNseHolidays('Date,Description\nsoon,x', {
        year: 2030,
        sourceUrl: 'https://x.test',
        downloadedOn: '2030-01-01',
      }),
    ).toThrow(/Unrecognised/);
  });
});

describe('plumbing', () => {
  it('token bucket throttles to the configured rate', async () => {
    let now = 0;
    const waits: number[] = [];
    const tb = new TokenBucket(
      2,
      1,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    await tb.acquire();
    await tb.acquire();
    await tb.acquire();
    expect(waits).toEqual([500, 500]);
  });
  it('TOTP matches the RFC 6238 SHA-1 test vector', () => {
    expect(totpNow('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082');
    expect(msUntilNextTotpWindow(59_000)).toBe(1000);
  });
  it('httpJson parses JSON, keeps text, and classifies failures', async () => {
    const ok = await httpJson({
      url: 'https://x.test/a',
      timeoutMs: 100,
      fetchImpl: async () => new Response('{"a":1}'),
    });
    expect(ok.json).toEqual({ a: 1 });
    const text = await httpJson({
      url: 'https://x.test/a',
      timeoutMs: 100,
      fetchImpl: async () => new Response('<html>'),
    });
    expect(text.json).toBeUndefined();
    expect(text.text).toBe('<html>');
    const slow = httpJson({
      url: 'https://x.test/a?key=SECRET',
      timeoutMs: 10,
      fetchImpl: (_u, init) =>
        new Promise((_r, rej) =>
          init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))),
        ),
    });
    await expect(slow).rejects.toMatchObject({ kind: 'timeout' });
    await expect(slow).rejects.not.toThrow(/SECRET/);
    await expect(
      httpJson({
        url: 'https://x.test',
        timeoutMs: 100,
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(redactUrl('https://api.telegram.org/bot123:abc/sendMessage?x=1')).toBe(
      'https://api.telegram.org/bot[redacted]/sendMessage',
    );
    expect(redactUrl('not a url')).toBe('[url]');
  });
  it('resolves mappings and flags failures', () => {
    const m = resolveMapping(
      {
        equities: new Map([
          ['A', { symbol: 'A', brokerToken: '1', exchange: 'NSE', name: 'A', tickSizePaise: 5 }],
          ['B', { error: 'AMBIGUOUS', candidates: 2 }],
        ]),
        indices: new Map([['Nifty 50', { error: 'NOT_FOUND', candidates: 0 }]]),
      },
      ['A', 'B', 'C'],
      ['Nifty 50', 'India VIX'],
    );
    expect(m.equities.map((e) => e.symbol)).toEqual(['A']);
    expect(m.unmapped.map((u) => u.symbol)).toEqual(['B', 'C']);
    expect(m.missingIndices.map((u) => u.name)).toEqual(['Nifty 50', 'India VIX']);
    expect(isRebalanceReminderWindow('2026-03-20')).toBe(true);
    expect(isRebalanceReminderWindow('2026-09-16')).toBe(false);
    expect(isRebalanceReminderWindow('2026-10-20')).toBe(false);
  });
  it('knows NSE market hours in IST', () => {
    expect(inMarketHours(new Date('2026-11-02T04:00:00Z'))).toBe(true); // 09:30 IST Mon
    expect(inMarketHours(new Date('2026-11-02T03:30:00Z'))).toBe(false); // 09:00
    expect(inMarketHours(new Date('2026-11-01T05:00:00Z'))).toBe(false); // Sunday
  });
  it('takes a snapshot from a session and summarises it', async () => {
    const t = new Date('2026-11-02T05:00:00Z');
    const session: MarketDataSession = {
      quotes: async () => ({
        quotes: [
          {
            symbol: 'A',
            ltpPaise: 100n,
            bidPaise: 99n,
            askPaise: 100n,
            openPaise: 100n,
            highPaise: 100n,
            lowPaise: 100n,
            prevClosePaise: 100n,
            volume: 1n,
            exchangeTime: t,
            parseError: null,
          },
        ],
        indices: [
          {
            name: 'Nifty 50',
            valueX100: 100n,
            prevCloseX100: 100n,
            exchangeTime: t,
            parseError: null,
          },
        ],
        raw: [{ x: 1 }],
      }),
      dailyCandles: async () => [],
    };
    const s = await snapshotFor({
      session,
      source: 'test',
      purpose: 'decision',
      arena: must(loadArena()),
      now: () => t,
      mapping: {
        equities: [{ symbol: 'A', brokerToken: '1', exchange: 'NSE', name: 'A', tickSizePaise: 5 }],
        indices: [{ name: 'Nifty 50', brokerToken: '2', exchange: 'NSE' }],
        unmapped: [{ symbol: 'B', reason: 'x' }],
        missingIndices: [],
      },
    });
    expect(s.quotes.map((q) => [q.symbol, q.valid])).toEqual([
      ['A', true],
      ['B', false],
    ]);
    expect(s.verdict.status).toBe('ok');
    expect(summariseSnapshot(s)).toMatch(/1\/2 valid quotes, 1 with depth/);
  });
  it('sanitises recorded fixtures', () => {
    expect(
      sanitize(
        {
          data: {
            jwtToken: 'x',
            symbolToken: '3045',
            clientcode: 'C1',
            nested: ['has SECRETVALUE in it'],
          },
        },
        ['SECRETVALUE'],
      ),
    ).toEqual({
      data: {
        jwtToken: '[removed]',
        symbolToken: '3045',
        clientcode: '[removed]',
        nested: ['has [redacted] in it'],
      },
    });
  });
});
