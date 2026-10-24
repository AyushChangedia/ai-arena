/**
 * Angel One SmartAPI market-data client (SPEC §8). Read-only: login, instrument master, quotes, candles.
 * Endpoints and headers follow the official SDKs (angel-one/smartapi-python, smartapi-javascript) and
 * SmartAPI docs. This module never calls any order endpoint.
 */
import { z } from 'zod';
import { DateTime } from 'luxon';
import { rupeesToPaise, decimalToScaled } from '@arena/shared/money';
import { httpJson, sleep, HttpError, type FetchLike } from './http';
import { TokenBucket } from './rate-limit';
import { totpNow, msUntilNextTotpWindow } from './totp';
import {
  DataError,
  type MarketDataProvider,
  type MarketDataSession,
  type InstrumentMaster,
  type Instrument,
  type IndexInstrument,
  type QuoteBatch,
  type RawQuote,
  type RawIndexQuote,
  type Candle,
} from './provider';

export const ANGEL_PATHS = {
  login: '/rest/auth/angelbroking/user/v1/loginByPassword',
  quote: '/rest/secure/angelbroking/market/v1/quote',
  candles: '/rest/secure/angelbroking/historical/v1/getCandleData',
} as const;

export interface AngelCredentials {
  apiKey: string;
  clientCode: string;
  mpin: string;
  totpSecret: string;
}

export interface AngelOptions {
  apiRoot: string;
  instrumentMasterUrl: string;
  timeoutMs: number;
  quoteBatchSize: number;
  quoteRequestsPerSecond: number;
  candleRequestsPerSecond: number;
  fetchImpl?: FetchLike;
  /** Records non-login responses verbatim (smoke.yml record-fixtures). Never called for login. */
  recorder?: (path: string, request: unknown, status: number, response: unknown) => void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

// ---- Response schemas (validated; fields are never defaulted) ----

const envelope = z.object({
  status: z.boolean(),
  message: z.string(),
  errorcode: z.string(),
  data: z.unknown(),
});

const loginData = z.object({
  jwtToken: z.string().min(10),
  refreshToken: z.string(),
  feedToken: z.string(),
});

const depthLevel = z.object({ price: z.number(), quantity: z.number(), orders: z.number() });
export const angelQuoteItem = z.object({
  exchange: z.string(),
  tradingSymbol: z.string(),
  symbolToken: z.string(),
  ltp: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  exchFeedTime: z.string(),
  tradeVolume: z.number(),
  depth: z.object({ buy: z.array(depthLevel), sell: z.array(depthLevel) }).optional(),
});
const quoteData = z.object({
  fetched: z.array(z.unknown()),
  unfetched: z.array(
    z
      .object({
        exchange: z.string().optional(),
        symbolToken: z.string().optional(),
        message: z.string().optional(),
        errorCode: z.string().optional(),
      })
      .passthrough(),
  ),
});

const candleRow = z.tuple([z.string(), z.number(), z.number(), z.number(), z.number(), z.number()]);

export const scripMasterRow = z
  .object({
    token: z.string(),
    symbol: z.string(),
    name: z.string(),
    exch_seg: z.string(),
    instrumenttype: z.string(),
    tick_size: z.string(),
  })
  .passthrough();

// ---- Helpers ----

/** Angel One exchange times look like "21-Jun-2023 10:46:10" in IST. */
export function parseAngelTime(s: string): Date | null {
  const dt = DateTime.fromFormat(s.trim(), 'dd-LLL-yyyy HH:mm:ss', {
    zone: 'Asia/Kolkata',
    locale: 'en',
  });
  return dt.isValid ? dt.toJSDate() : null;
}

const SESSION_ERRORS = new Set(['AG8001', 'AG8002', 'AG8003']);
// AB1050 is documented for an invalid TOTP; the message check covers wording changes.
export function isInvalidTotp(errorcode: string, message: string): boolean {
  return errorcode === 'AB1050' || /totp/i.test(message);
}

function headers(apiKey: string, jwt?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': apiKey,
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  };
}

function bestPrice(levels: { price: number }[] | undefined): bigint | null {
  const p = levels?.[0]?.price;
  if (p === undefined || !(p > 0)) return null;
  return rupeesToPaise(p);
}

export function toRawQuote(symbol: string, item: unknown): RawQuote {
  const parsed = angelQuoteItem.safeParse(item);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      symbol,
      ltpPaise: null,
      bidPaise: null,
      askPaise: null,
      openPaise: null,
      highPaise: null,
      lowPaise: null,
      prevClosePaise: null,
      volume: null,
      exchangeTime: null,
      parseError: `schema: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'invalid'}`,
    };
  }
  const q = parsed.data;
  const time = parseAngelTime(q.exchFeedTime);
  return {
    symbol,
    ltpPaise: rupeesToPaise(q.ltp),
    bidPaise: bestPrice(q.depth?.buy),
    askPaise: bestPrice(q.depth?.sell),
    openPaise: rupeesToPaise(q.open),
    highPaise: rupeesToPaise(q.high),
    lowPaise: rupeesToPaise(q.low),
    prevClosePaise: rupeesToPaise(q.close),
    volume: BigInt(Math.trunc(q.tradeVolume)),
    exchangeTime: time,
    parseError: time ? null : `schema: exchFeedTime unparseable (${q.exchFeedTime})`,
  };
}

export function toRawIndexQuote(name: string, item: unknown): RawIndexQuote {
  const parsed = angelQuoteItem
    .omit({ depth: true, tradeVolume: true })
    .passthrough()
    .safeParse(item);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      name,
      valueX100: null,
      prevCloseX100: null,
      exchangeTime: null,
      parseError: `schema: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'invalid'}`,
    };
  }
  const time = parseAngelTime(parsed.data.exchFeedTime);
  return {
    name,
    valueX100: decimalToScaled(parsed.data.ltp, 2),
    prevCloseX100: decimalToScaled(parsed.data.close, 2),
    exchangeTime: time,
    parseError: time ? null : 'schema: exchFeedTime unparseable',
  };
}

/** Maps universe symbols and index names to instruments. Zero or multiple matches are errors, never guesses. */
export function mapInstruments(
  rows: unknown[],
  universe: string[],
  indexNames: string[],
): InstrumentMaster {
  const bySymbol = new Map<string, z.infer<typeof scripMasterRow>[]>();
  const indexRows: z.infer<typeof scripMasterRow>[] = [];
  for (const r of rows) {
    const p = scripMasterRow.safeParse(r);
    if (!p.success) continue; // Rows from other segments may carry other shapes; only valid rows can match.
    const row = p.data;
    if (row.exch_seg !== 'NSE') continue;
    if (row.instrumenttype === 'AMXIDX') indexRows.push(row);
    else if (row.symbol.endsWith('-EQ')) {
      const list = bySymbol.get(row.symbol) ?? [];
      list.push(row);
      bySymbol.set(row.symbol, list);
    }
  }
  const equities: InstrumentMaster['equities'] = new Map();
  for (const sym of universe) {
    const matches = bySymbol.get(`${sym}-EQ`) ?? [];
    if (matches.length !== 1) {
      equities.set(sym, {
        error: matches.length ? 'AMBIGUOUS' : 'NOT_FOUND',
        candidates: matches.length,
      });
      continue;
    }
    const m = matches[0]!;
    const tick = Number(m.tick_size);
    equities.set(sym, {
      symbol: sym,
      brokerToken: m.token,
      exchange: 'NSE',
      name: m.name,
      tickSizePaise: Number.isFinite(tick) ? Math.round(tick) : 5,
    });
  }
  const indices: InstrumentMaster['indices'] = new Map();
  for (const name of indexNames) {
    const matches = indexRows.filter(
      (r) =>
        r.name.toLowerCase() === name.toLowerCase() ||
        r.symbol.toLowerCase() === name.toLowerCase(),
    );
    const unique = [...new Map(matches.map((m) => [m.token, m])).values()];
    if (unique.length !== 1) {
      indices.set(name, {
        error: unique.length ? 'AMBIGUOUS' : 'NOT_FOUND',
        candidates: unique.length,
      });
      continue;
    }
    indices.set(name, { name, brokerToken: unique[0]!.token, exchange: 'NSE' });
  }
  return { equities, indices };
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export class AngelOneProvider implements MarketDataProvider {
  readonly source = 'angelone-smartapi';
  private readonly quoteLimiter: TokenBucket;
  private readonly candleLimiter: TokenBucket;

  constructor(
    private readonly creds: AngelCredentials,
    private readonly opts: AngelOptions,
  ) {
    this.quoteLimiter = new TokenBucket(opts.quoteRequestsPerSecond, 1, opts.now, opts.wait);
    this.candleLimiter = new TokenBucket(opts.candleRequestsPerSecond, 1, opts.now, opts.wait);
  }

  private async post(path: string, body: unknown, jwt?: string) {
    try {
      const res = await httpJson({
        url: `${this.opts.apiRoot}${path}`,
        method: 'POST',
        headers: headers(this.creds.apiKey, jwt),
        body,
        timeoutMs: this.opts.timeoutMs,
        fetchImpl: this.opts.fetchImpl,
      });
      if (path !== ANGEL_PATHS.login)
        this.opts.recorder?.(path, body, res.status, res.json ?? res.text);
      return res;
    } catch (e) {
      if (e instanceof HttpError)
        throw new DataError('DATA_REQUEST_FAILED', e.message, undefined, { cause: e });
      throw e;
    }
  }

  /** Logs in with client code + MPIN + TOTP (SPEC §8.1). The response is never stored or logged. */
  async loginJwt(): Promise<string> {
    const attempt = async () => {
      const res = await this.post(ANGEL_PATHS.login, {
        clientcode: this.creds.clientCode,
        password: this.creds.mpin,
        totp: totpNow(this.creds.totpSecret, (this.opts.now ?? Date.now)()),
      });
      const env = envelope.safeParse(res.json);
      if (!env.success)
        throw new DataError(
          'DATA_LOGIN_FAILED',
          `login response not understood (HTTP ${res.status})`,
          'envelope',
        );
      if (!env.data.status)
        return { ok: false as const, errorcode: env.data.errorcode, message: env.data.message };
      const data = loginData.safeParse(env.data.data);
      if (!data.success)
        throw new DataError(
          'DATA_LOGIN_FAILED',
          'login succeeded but the token field is missing',
          'data.jwtToken',
        );
      return { ok: true as const, jwt: data.data.jwtToken };
    };
    let r = await attempt();
    if (!r.ok && isInvalidTotp(r.errorcode, r.message)) {
      await (this.opts.wait ?? sleep)(msUntilNextTotpWindow((this.opts.now ?? Date.now)()) + 1000);
      r = await attempt();
    }
    if (!r.ok)
      throw new DataError(
        'DATA_LOGIN_FAILED',
        `login failed: ${r.errorcode || 'no code'} ${r.message}`.trim(),
      );
    return r.jwt;
  }

  async login(): Promise<MarketDataSession> {
    let jwt = await this.loginJwt();
    const relogin = async () => {
      jwt = await this.loginJwt();
    };
    // A secure call that re-logs in once if the session expired mid-round (SPEC §13 #3).
    const secure = async (path: string, body: unknown): Promise<unknown> => {
      for (let i = 0; i < 2; i++) {
        const res = await this.post(path, body, jwt);
        const env = envelope.safeParse(res.json);
        const expired =
          res.status === 401 ||
          res.status === 403 ||
          (env.success && SESSION_ERRORS.has(env.data.errorcode));
        if (expired && i === 0) {
          await relogin();
          continue;
        }
        if (expired)
          throw new DataError('DATA_SESSION_EXPIRED', 'session expired and re-login did not help');
        if (!env.success)
          throw new DataError(
            'DATA_SHAPE_CHANGED',
            `unexpected response from ${path} (HTTP ${res.status})`,
            'envelope',
          );
        if (!env.data.status)
          throw new DataError(
            'DATA_REQUEST_FAILED',
            `${path} failed: ${env.data.errorcode} ${env.data.message}`,
          );
        return env.data.data;
      }
      throw new DataError('DATA_SESSION_EXPIRED', 'session expired');
    };

    return {
      quotes: async (equities: Instrument[], indices: IndexInstrument[]): Promise<QuoteBatch> => {
        const byToken = new Map<
          string,
          { kind: 'eq'; inst: Instrument } | { kind: 'idx'; inst: IndexInstrument }
        >();
        for (const e of equities) byToken.set(e.brokerToken, { kind: 'eq', inst: e });
        for (const i of indices) byToken.set(i.brokerToken, { kind: 'idx', inst: i });
        const raw: unknown[] = [];
        const seen = new Map<string, unknown>();
        for (const batch of chunk([...byToken.keys()], this.opts.quoteBatchSize)) {
          await this.quoteLimiter.acquire();
          const data = await secure(ANGEL_PATHS.quote, {
            mode: 'FULL',
            exchangeTokens: { NSE: batch },
          });
          const parsed = quoteData.safeParse(data);
          if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new DataError(
              'DATA_SHAPE_CHANGED',
              'quote response shape changed',
              issue ? `data.${issue.path.join('.')}` : 'data',
            );
          }
          raw.push(parsed.data);
          for (const item of parsed.data.fetched) {
            const tok = (item as { symbolToken?: unknown }).symbolToken;
            if (typeof tok === 'string') seen.set(tok, item);
          }
        }
        const quotes: RawQuote[] = [];
        const idx: RawIndexQuote[] = [];
        for (const [tok, entry] of byToken) {
          const item = seen.get(tok);
          if (entry.kind === 'eq') {
            quotes.push(
              item === undefined
                ? { ...toRawQuote(entry.inst.symbol, {}), parseError: 'not returned by provider' }
                : toRawQuote(entry.inst.symbol, item),
            );
          } else {
            idx.push(
              item === undefined
                ? {
                    ...toRawIndexQuote(entry.inst.name, {}),
                    parseError: 'not returned by provider',
                  }
                : toRawIndexQuote(entry.inst.name, item),
            );
          }
        }
        return { quotes, indices: idx, raw };
      },
      dailyCandles: async (
        inst: Instrument,
        fromDate: string,
        toDate: string,
      ): Promise<Candle[]> => {
        await this.candleLimiter.acquire();
        const data = await secure(ANGEL_PATHS.candles, {
          exchange: 'NSE',
          symboltoken: inst.brokerToken,
          interval: 'ONE_DAY',
          fromdate: `${fromDate} 09:15`,
          todate: `${toDate} 15:30`,
        });
        if (data === null) return [];
        const rows = z.array(candleRow).safeParse(data);
        if (!rows.success)
          throw new DataError(
            'DATA_SHAPE_CHANGED',
            'candle response shape changed',
            `data.${rows.error.issues[0]?.path.join('.') ?? ''}`,
          );
        return rows.data.map(([t, o, h, l, c, v]) => {
          const d = DateTime.fromISO(t, { setZone: true }).setZone('Asia/Kolkata');
          if (!d.isValid)
            throw new DataError(
              'DATA_SHAPE_CHANGED',
              `candle timestamp unparseable: ${t}`,
              'data[].0',
            );
          return {
            date: d.toISODate()!,
            openPaise: rupeesToPaise(o),
            highPaise: rupeesToPaise(h),
            lowPaise: rupeesToPaise(l),
            closePaise: rupeesToPaise(c),
            volume: BigInt(Math.trunc(v)),
          };
        });
      },
    };
  }

  async instruments(universe: string[], indexNames: string[]): Promise<InstrumentMaster> {
    let res;
    try {
      res = await httpJson({
        url: this.opts.instrumentMasterUrl,
        timeoutMs: Math.max(this.opts.timeoutMs, 60_000),
        fetchImpl: this.opts.fetchImpl,
      });
    } catch (e) {
      throw new DataError(
        'DATA_REQUEST_FAILED',
        `instrument master download failed: ${(e as Error).message}`,
        undefined,
        { cause: e },
      );
    }
    if (!res.ok || !Array.isArray(res.json))
      throw new DataError(
        'DATA_SHAPE_CHANGED',
        `instrument master is not a JSON array (HTTP ${res.status})`,
        '(root)',
      );
    return mapInstruments(res.json, universe, indexNames);
  }
}
