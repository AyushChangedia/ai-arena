import { describe, it, expect } from 'vitest';
import {
  AngelOneProvider,
  ANGEL_PATHS,
  parseAngelTime,
  mapInstruments,
  toRawQuote,
  toRawIndexQuote,
  isInvalidTotp,
} from '../../src/data/angelone';
import { DataError } from '../../src/data/provider';
import { fixture, fakeFetch, type FakeCall } from '../helpers/fixtures';

const creds = {
  apiKey: 'api-key-x',
  clientCode: 'C123',
  mpin: '1234',
  totpSecret: 'JBSWY3DPEHPK3PXP',
};
const opts = (fetchImpl: (u: string, i?: RequestInit) => Promise<Response>, extra = {}) => ({
  apiRoot: 'https://apiconnect.angelone.in',
  instrumentMasterUrl: 'https://master.example/OpenAPIScripMaster.json',
  timeoutMs: 1000,
  quoteBatchSize: 2,
  quoteRequestsPerSecond: 1000,
  candleRequestsPerSecond: 1000,
  fetchImpl,
  wait: async () => {},
  ...extra,
});

const login = fixture('angelone/login-success.docs-example.json').body;
const quote = fixture('angelone/quote-full.docs-example.json').body as {
  data: { fetched: Record<string, unknown>[] };
};

function route(
  handlers: Partial<Record<string, (c: FakeCall, n: number) => { status?: number; body: unknown }>>,
) {
  return fakeFetch((c, n) => {
    for (const [path, h] of Object.entries(handlers)) if (c.url.endsWith(path) && h) return h(c, n);
    return { status: 404, body: { message: 'no route' } };
  });
}

describe('Angel One provider (docs-example fixtures)', () => {
  it('logs in with client code, MPIN and a fresh TOTP, and sends the documented headers', async () => {
    const f = route({ [ANGEL_PATHS.login]: () => ({ body: login }) });
    const jwt = await new AngelOneProvider(creds, opts(f.impl)).loginJwt();
    expect(jwt).toBe('docs-example-placeholder-jwt');
    const c = f.calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.body).toMatchObject({ clientcode: 'C123', password: '1234' });
    expect((c.body as { totp: string }).totp).toMatch(/^\d{6}$/);
    expect(c.headers['X-PrivateKey']).toBe('api-key-x');
    expect(c.headers['X-UserType']).toBe('USER');
    expect(c.headers.Authorization).toBeUndefined();
  });

  it('retries once in the next TOTP window on an invalid TOTP, then fails as DATA_LOGIN_FAILED', async () => {
    const bad = fixture('angelone/login-invalid-totp.docs-example.json').body;
    const waits: number[] = [];
    const f = route({ [ANGEL_PATHS.login]: () => ({ body: bad }) });
    const p = new AngelOneProvider(
      creds,
      opts(f.impl, { wait: async (ms: number) => void waits.push(ms) }),
    );
    await expect(p.loginJwt()).rejects.toMatchObject({ kind: 'DATA_LOGIN_FAILED' });
    expect(f.calls).toHaveLength(2);
    expect(waits[0]).toBeGreaterThan(1000);
    const f2 = route({ [ANGEL_PATHS.login]: (_c, n) => ({ body: n === 1 ? bad : login }) });
    expect(await new AngelOneProvider(creds, opts(f2.impl)).loginJwt()).toBe(
      'docs-example-placeholder-jwt',
    );
  });

  it('does not retry other login failures', async () => {
    const f = route({
      [ANGEL_PATHS.login]: () => ({
        body: fixture('angelone/login-bad-mpin.docs-example.json').body,
      }),
    });
    await expect(new AngelOneProvider(creds, opts(f.impl)).loginJwt()).rejects.toThrow(/AB1000/);
    expect(f.calls).toHaveLength(1);
    const g = route({ [ANGEL_PATHS.login]: () => ({ status: 500, body: '<html>' }) });
    await expect(new AngelOneProvider(creds, opts(g.impl)).loginJwt()).rejects.toThrow(
      /not understood/,
    );
    const h = route({
      [ANGEL_PATHS.login]: () => ({
        body: { status: true, message: 'SUCCESS', errorcode: '', data: {} },
      }),
    });
    await expect(new AngelOneProvider(creds, opts(h.impl)).loginJwt()).rejects.toThrow(
      /token field is missing/,
    );
    const n = fakeFetch(() => new Error('ECONNRESET'));
    await expect(new AngelOneProvider(creds, opts(n.impl)).loginJwt()).rejects.toMatchObject({
      kind: 'DATA_REQUEST_FAILED',
    });
  });

  it('fetches quotes in batches with the bearer token and parses depth', async () => {
    const recorded: string[] = [];
    const f = route({
      [ANGEL_PATHS.login]: () => ({ body: login }),
      [ANGEL_PATHS.quote]: (c) => {
        const toks = (c.body as { exchangeTokens: { NSE: string[] } }).exchangeTokens.NSE;
        const fetched = toks
          .filter((t) => t !== '777')
          .map((t) => ({ ...quote.data.fetched[0], symbolToken: t, tradingSymbol: `X${t}-EQ` }));
        return {
          body: {
            status: true,
            message: 'SUCCESS',
            errorcode: '',
            data: {
              fetched,
              unfetched: toks.includes('777')
                ? [
                    {
                      exchange: 'NSE',
                      symbolToken: '777',
                      message: 'Invalid token',
                      errorCode: 'AB4006',
                    },
                  ]
                : [],
            },
          },
        };
      },
    });
    const p = new AngelOneProvider(
      creds,
      opts(f.impl, { recorder: (path: string) => recorded.push(path) }),
    );
    const s = await p.login();
    const batch = await s.quotes(
      [
        { symbol: 'SBIN', brokerToken: '3045', exchange: 'NSE', name: 'SBIN', tickSizePaise: 5 },
        { symbol: 'TCS', brokerToken: '11536', exchange: 'NSE', name: 'TCS', tickSizePaise: 10 },
        { symbol: 'GONE', brokerToken: '777', exchange: 'NSE', name: 'x', tickSizePaise: 5 },
      ],
      [{ name: 'Nifty 50', brokerToken: '99926000', exchange: 'NSE' }],
    );
    const quoteCalls = f.calls.filter((c) => c.url.endsWith(ANGEL_PATHS.quote));
    expect(quoteCalls).toHaveLength(2); // batch size 2, four tokens
    expect(quoteCalls[0]!.headers.Authorization).toBe('Bearer docs-example-placeholder-jwt');
    const sbin = batch.quotes.find((q) => q.symbol === 'SBIN')!;
    expect(sbin.ltpPaise).toBe(57180n);
    expect(sbin.prevClosePaise).toBe(56650n);
    expect(sbin.bidPaise).toBe(57180n);
    expect(sbin.askPaise).toBeNull(); // sell depth is all zeros in the example
    expect(sbin.exchangeTime?.toISOString()).toBe('2023-03-21T12:45:09.000Z');
    expect(batch.quotes.find((q) => q.symbol === 'GONE')!.parseError).toBe(
      'not returned by provider',
    );
    expect(batch.indices[0]!.valueX100).toBe(57180n);
    expect(recorded).not.toContain(ANGEL_PATHS.login);
    expect(recorded).toContain(ANGEL_PATHS.quote);
  });

  it('re-logs in once when the session expires mid-round, then gives up', async () => {
    const expired = fixture('angelone/session-invalid-token.docs-example.json');
    let quoteCalls = 0;
    const f = route({
      [ANGEL_PATHS.login]: () => ({ body: login }),
      [ANGEL_PATHS.quote]: () =>
        ++quoteCalls === 1
          ? { status: expired.status, body: expired.body }
          : quote.data
            ? {
                body: {
                  status: true,
                  message: 'SUCCESS',
                  errorcode: '',
                  data: { fetched: [], unfetched: [] },
                },
              }
            : { body: null },
    });
    const s = await new AngelOneProvider(creds, opts(f.impl)).login();
    await s.quotes([], [{ name: 'Nifty 50', brokerToken: '99926000', exchange: 'NSE' }]);
    expect(f.calls.filter((c) => c.url.endsWith(ANGEL_PATHS.login))).toHaveLength(2);
    const g = route({
      [ANGEL_PATHS.login]: () => ({ body: login }),
      [ANGEL_PATHS.quote]: () => ({ status: 401, body: expired.body }),
    });
    const s2 = await new AngelOneProvider(creds, opts(g.impl)).login();
    await expect(
      s2.quotes([], [{ name: 'Nifty 50', brokerToken: '1', exchange: 'NSE' }]),
    ).rejects.toMatchObject({ kind: 'DATA_SESSION_EXPIRED' });
  });

  it('treats a changed response shape as DATA_SHAPE_CHANGED with the field path', async () => {
    const f = route({
      [ANGEL_PATHS.login]: () => ({ body: login }),
      [ANGEL_PATHS.quote]: () => ({
        body: { status: true, message: 'SUCCESS', errorcode: '', data: { fetchedQuotes: [] } },
      }),
    });
    const s = await new AngelOneProvider(creds, opts(f.impl)).login();
    const err = await s
      .quotes([], [{ name: 'Nifty 50', brokerToken: '1', exchange: 'NSE' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataError);
    expect((err as DataError).kind).toBe('DATA_SHAPE_CHANGED');
    expect((err as DataError).fieldPath).toMatch(/^data\./);
    const g = route({
      [ANGEL_PATHS.login]: () => ({ body: login }),
      [ANGEL_PATHS.quote]: () => ({ status: 502, body: 'Bad gateway' }),
    });
    const s2 = await new AngelOneProvider(creds, opts(g.impl)).login();
    await expect(
      s2.quotes([], [{ name: 'N', brokerToken: '1', exchange: 'NSE' }]),
    ).rejects.toMatchObject({ kind: 'DATA_SHAPE_CHANGED' });
    const h = route({
      [ANGEL_PATHS.login]: () => ({ body: login }),
      [ANGEL_PATHS.quote]: () => ({
        body: { status: false, message: 'Rate limit', errorcode: 'AB2001', data: null },
      }),
    });
    const s3 = await new AngelOneProvider(creds, opts(h.impl)).login();
    await expect(
      s3.quotes([], [{ name: 'N', brokerToken: '1', exchange: 'NSE' }]),
    ).rejects.toMatchObject({ kind: 'DATA_REQUEST_FAILED' });
  });

  it('parses daily candles into IST trading dates', async () => {
    const c = fixture('angelone/candles-one-day.docs-example.json');
    const f = route({
      [ANGEL_PATHS.login]: () => ({ body: login }),
      [ANGEL_PATHS.candles]: () => ({ body: c.body }),
    });
    const s = await new AngelOneProvider(creds, opts(f.impl)).login();
    const bars = await s.dailyCandles(
      { symbol: 'SBIN', brokerToken: '3045', exchange: 'NSE', name: 'SBIN', tickSizePaise: 5 },
      '2023-09-04',
      '2023-09-06',
    );
    expect(bars.map((b) => b.date)).toEqual(['2023-09-04', '2023-09-05', '2023-09-06']);
    expect(bars[2]!.closePaise).toBe(58630n);
    const sent = f.calls.find((x) => x.url.endsWith(ANGEL_PATHS.candles))!.body;
    expect(sent).toEqual({
      exchange: 'NSE',
      symboltoken: '3045',
      interval: 'ONE_DAY',
      fromdate: '2023-09-04 09:15',
      todate: '2023-09-06 15:30',
    });
    const empty = route({
      [ANGEL_PATHS.login]: () => ({ body: login }),
      [ANGEL_PATHS.candles]: () => ({
        body: { status: true, message: 'SUCCESS', errorcode: '', data: null },
      }),
    });
    expect(
      await (
        await new AngelOneProvider(creds, opts(empty.impl)).login()
      ).dailyCandles(
        { symbol: 'S', brokerToken: '1', exchange: 'NSE', name: 'S', tickSizePaise: 5 },
        'a',
        'b',
      ),
    ).toEqual([]);
    const bad = route({
      [ANGEL_PATHS.login]: () => ({ body: login }),
      [ANGEL_PATHS.candles]: () => ({
        body: { status: true, message: 'SUCCESS', errorcode: '', data: [['x', 1]] },
      }),
    });
    await expect(
      (await new AngelOneProvider(creds, opts(bad.impl)).login()).dailyCandles(
        { symbol: 'S', brokerToken: '1', exchange: 'NSE', name: 'S', tickSizePaise: 5 },
        'a',
        'b',
      ),
    ).rejects.toMatchObject({ kind: 'DATA_SHAPE_CHANGED' });
    const badTime = route({
      [ANGEL_PATHS.login]: () => ({ body: login }),
      [ANGEL_PATHS.candles]: () => ({
        body: { status: true, message: 'SUCCESS', errorcode: '', data: [['nope', 1, 1, 1, 1, 1]] },
      }),
    });
    await expect(
      (await new AngelOneProvider(creds, opts(badTime.impl)).login()).dailyCandles(
        { symbol: 'S', brokerToken: '1', exchange: 'NSE', name: 'S', tickSizePaise: 5 },
        'a',
        'b',
      ),
    ).rejects.toThrow(/unparseable/);
  });

  it('maps each universe symbol to exactly one NSE equity, and indices by name', async () => {
    const rows = fixture<{ body: unknown[] }>('angelone/scrip-master-rows.docs-example.json').body;
    const m = mapInstruments(
      [
        ...rows,
        {
          token: '9',
          symbol: 'DUP-EQ',
          name: 'DUP',
          instrumenttype: '',
          exch_seg: 'NSE',
          tick_size: '5',
        },
        {
          token: '10',
          symbol: 'DUP-EQ',
          name: 'DUP',
          instrumenttype: '',
          exch_seg: 'NSE',
          tick_size: '5',
        },
        'junk',
      ],
      ['SBIN', 'TCS', 'DUP', 'MISSING'],
      ['Nifty 50', 'India VIX', 'Nifty Bank'],
    );
    expect(m.equities.get('TCS')).toEqual({
      symbol: 'TCS',
      brokerToken: '11536',
      exchange: 'NSE',
      name: 'TCS',
      tickSizePaise: 10,
    });
    expect(m.equities.get('DUP')).toEqual({ error: 'AMBIGUOUS', candidates: 2 });
    expect(m.equities.get('MISSING')).toEqual({ error: 'NOT_FOUND', candidates: 0 });
    expect(m.indices.get('Nifty 50')).toEqual({
      name: 'Nifty 50',
      brokerToken: '99926000',
      exchange: 'NSE',
    });
    expect(m.indices.get('India VIX')).toMatchObject({ brokerToken: '99926017' });
    expect(m.indices.get('Nifty Bank')).toEqual({ error: 'NOT_FOUND', candidates: 0 });
    const f = fakeFetch(() => ({ body: rows }));
    const im = await new AngelOneProvider(creds, opts(f.impl)).instruments(['SBIN'], ['Nifty 50']);
    expect(im.equities.get('SBIN')).toMatchObject({ brokerToken: '3045' });
    const g = fakeFetch(() => ({ body: { not: 'array' } }));
    await expect(
      new AngelOneProvider(creds, opts(g.impl)).instruments([], []),
    ).rejects.toMatchObject({ kind: 'DATA_SHAPE_CHANGED' });
    const h = fakeFetch(() => new Error('down'));
    await expect(
      new AngelOneProvider(creds, opts(h.impl)).instruments([], []),
    ).rejects.toMatchObject({ kind: 'DATA_REQUEST_FAILED' });
  });

  it('marks quotes with missing fields as unparsed, never defaulting to zero', () => {
    const { ltp: _l, ...noLtp } = quote.data.fetched[0]!;
    const r = toRawQuote('SBIN', noLtp);
    expect(r.ltpPaise).toBeNull();
    expect(r.parseError).toMatch(/ltp/);
    expect(
      toRawQuote('SBIN', { ...quote.data.fetched[0], exchFeedTime: 'garbage' }).parseError,
    ).toMatch(/exchFeedTime/);
    expect(toRawIndexQuote('N', {}).parseError).toMatch(/schema/);
    expect(
      toRawIndexQuote('N', { ...quote.data.fetched[0], exchFeedTime: 'x' }).parseError,
    ).toMatch(/exchFeedTime/);
    expect(parseAngelTime('21-Mar-2023 18:15:09')?.toISOString()).toBe('2023-03-21T12:45:09.000Z');
    expect(parseAngelTime('bad')).toBeNull();
    expect(isInvalidTotp('X', 'Invalid TOTP entered')).toBe(true);
    expect(isInvalidTotp('AB1000', 'Invalid password')).toBe(false);
  });
});
