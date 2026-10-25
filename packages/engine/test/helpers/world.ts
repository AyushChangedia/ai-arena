/**
 * Test world for integration tests: a fake market-data provider and a fake OpenRouter, wired into Deps
 * against a throwaway *_test database. Everything here is test-only.
 */
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import type pg from 'pg';
import { createPool } from '@arena/db';
import type { ModelsConfig, Universe, ModelEntry } from '@arena/shared/schemas';
import { must, loadArena, loadFees, loadRosterRules } from '../../src/config/load';
import { TradingCalendar } from '../../src/data/calendar';
import { OpenRouterClient } from '../../src/llm/openrouter';
import { Alerter, type AlertSink } from '../../src/ops/alerts';
import {
  DataError,
  type MarketDataProvider,
  type MarketDataSession,
  type RawQuote,
  type RawIndexQuote,
  type Candle,
  type Instrument,
} from '../../src/data/provider';
import type { Deps } from '../../src/round/deps';
import { fixture } from './fixtures';

export const SYMBOLS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];
export const TEST_UNIVERSE = {
  index: 'NIFTY 50',
  effectiveFrom: '2026-09-30',
  sourceUrl: 'https://example.test/list.csv',
  downloadedOn: '2026-10-01',
  constituents: SYMBOLS.map((s) => ({ symbol: s, name: `${s} Ltd` })),
} as unknown as Universe;

export const CALENDAR = new TradingCalendar(
  [2025, 2026, 2027].map((year) => ({
    year,
    exchange: 'NSE' as const,
    segment: 'equity' as const,
    source: 'test',
    sourceUrl: 'https://example.test/',
    downloadedOn: '2026-01-01',
    holidays: [],
  })),
);

const rules = must(loadRosterRules());
export function testModels(approved = false): ModelsConfig {
  const slots = ['openai', 'anthropic', 'google', 'meta', 'deepseek'] as const;
  const participants: ModelEntry[] = slots.map((slot) => ({
    slot,
    openrouterId: `${slot}/test-model`,
    canonicalSlug: `${slot}/test-model-20260101`,
    displayName: `${slot} test model`,
    shortCode: rules.slots[slot]!.shortCode,
    color: rules.slots[slot]!.color,
    created: 1,
    contextLength: 100000,
    supportedParameters: ['max_tokens', 'temperature', 'response_format', 'structured_outputs'],
    pricing: { promptUsdPerToken: '0.000001', completionUsdPerToken: '0.000002' },
    monthlyEstimateUsd: 2,
    monthlyCapUsd: 3,
  }));
  return {
    tier: 'budget',
    approved,
    approvedBy: approved ? 'test' : null,
    approvedOn: approved ? '2026-10-01' : null,
    generatedAt: 'x',
    source: 'https://openrouter.ai/api/v1/models',
    estimateAssumptions: { inputTokensPerCall: 1, outputTokensPerCall: 1, roundsPerMonth: 1 },
    totalMonthlyEstimateUsd: 10,
    participants,
    alternatives: [],
    benchmarks: rules.benchmarks,
  };
}

export interface MarketState {
  prices: Map<string, bigint>;
  index: bigint;
  loginFails: boolean;
  invalid: Set<string>;
  quotesFail: boolean;
  calls: number;
}

export function marketState(): MarketState {
  return {
    prices: new Map(SYMBOLS.map((s, i) => [s, BigInt(100_000 + i * 25_000)])),
    index: 2_400_000n,
    loginFails: false,
    invalid: new Set(),
    quotesFail: false,
    calls: 0,
  };
}

export function fakeProvider(st: MarketState, now: () => Date): MarketDataProvider {
  const inst = (s: string): Instrument => ({
    symbol: s,
    brokerToken: `T${s}`,
    exchange: 'NSE',
    name: s,
    tickSizePaise: 5,
  });
  return {
    source: 'fake-market',
    instruments: async (universe, indexNames) => ({
      equities: new Map(universe.map((s) => [s, inst(s)])),
      indices: new Map(
        indexNames.map((n) => [n, { name: n, brokerToken: `I${n}`, exchange: 'NSE' }]),
      ),
    }),
    login: async (): Promise<MarketDataSession> => {
      if (st.loginFails)
        throw new DataError('DATA_LOGIN_FAILED', 'login failed: AB1000 Invalid Email Or Password');
      return {
        quotes: async (equities, indices) => {
          st.calls++;
          if (st.quotesFail)
            throw new DataError(
              'DATA_SHAPE_CHANGED',
              'quote response shape changed',
              'data.fetched',
            );
          const t = now();
          const quotes: RawQuote[] = equities.map((e) => {
            const p = st.prices.get(e.symbol) ?? 100_000n;
            return {
              symbol: e.symbol,
              ltpPaise: st.invalid.has(e.symbol) ? null : p,
              bidPaise: p - 50n,
              askPaise: p + 50n,
              openPaise: p,
              highPaise: p,
              lowPaise: p,
              prevClosePaise: p,
              volume: 1000n,
              exchangeTime: t,
              parseError: st.invalid.has(e.symbol) ? 'schema: ltp Required' : null,
            };
          });
          const idx: RawIndexQuote[] = indices.map((i) => ({
            name: i.name,
            valueX100: st.index,
            prevCloseX100: 2_400_000n,
            exchangeTime: t,
            parseError: null,
          }));
          return { quotes, indices: idx, raw: [{ fake: true }] };
        },
        dailyCandles: async (i, _from, to): Promise<Candle[]> => {
          const p = st.prices.get(i.symbol) ?? 100_000n;
          return Array.from({ length: 3 }, (_, k) => ({
            date: CALENDAR.previousTradingDay(k === 0 ? to : CALENDAR.previousTradingDay(to)),
            openPaise: p,
            highPaise: p,
            lowPaise: p,
            closePaise: p,
            volume: 100n,
          }));
        },
      };
    },
  };
}

export type ModelBehaviour = (
  model: string,
  n: number,
) => { status?: number; body: unknown } | Error;

const OK_BODY = fixture('openrouter/chat-success.docs-example.json').body as Record<
  string,
  unknown
>;
export function answer(model: string, content: object | string): { body: unknown } {
  return {
    body: {
      ...OK_BODY,
      model,
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: typeof content === 'string' ? content : JSON.stringify(content),
          },
        },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        cost: 0.0011,
        completion_tokens_details: { reasoning_tokens: 50 },
      },
    },
  };
}

export function fakeLlm(behaviour: ModelBehaviour) {
  const counts = new Map<string, number>();
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    bodies.push(body as Record<string, unknown>);
    const n = (counts.get(body.model) ?? 0) + 1;
    counts.set(body.model, n);
    const r = behaviour(body.model, n);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return {
    client: new OpenRouterClient({
      apiKey: 'sk-test',
      fetchImpl,
      wait: async () => {},
      random: () => 0,
    }),
    bodies,
  };
}

export class MemorySink implements AlertSink {
  messages: string[] = [];
  async send(text: string) {
    this.messages.push(text);
  }
}

export interface World {
  deps: Deps;
  db: pg.Pool;
  market: MarketState;
  clock: { t: Date };
  sink: MemorySink;
  llmBodies: Record<string, unknown>[];
  setLlm: (b: ModelBehaviour) => void;
}

/**
 * The committed arena config with a fixed 12-round, 30-minute schedule, so the round tests
 * don't depend on the schedule a season happens to use.
 */
export function testArena() {
  const a = must(loadArena());
  return { ...a, schedule: { ...a.schedule, everyMinutes: 30, lastSlot: '15:00' } };
}

export function makeWorld(
  engineUrl: string,
  start: Date,
  behaviour: ModelBehaviour,
  models = testModels(),
): World {
  const db = createPool(engineUrl);
  const clock = { t: start };
  const now = () => clock.t;
  const market = marketState();
  const sink = new MemorySink();
  const log = pino({ level: 'silent' });
  let llm = fakeLlm(behaviour);
  const world: World = {
    db,
    market,
    clock,
    sink,
    llmBodies: llm.bodies,
    setLlm: (b) => {
      llm = fakeLlm(b);
      world.llmBodies = llm.bodies;
    },
    deps: {
      arena: testArena(),
      fees: must(loadFees()),
      universe: TEST_UNIVERSE,
      calendar: CALENDAR,
      models,
      env: { ARENA_MODE: 'shadow' },
      db,
      provider: () => fakeProvider(market, now),
      llm: () => llm.client,
      log,
      alerts: new Alerter(db, sink, log, { runUrl: null, statusUrl: null }, now),
      now,
      tickId: 'test',
      exportDir: mkdtempSync(join(tmpdir(), 'arena-export-')),
    },
  };
  return world;
}

/** A model that buys 2 shares of the first symbol on its first call, then holds. */
export const buyOnce: ModelBehaviour = (model, n) =>
  answer(model, {
    reasoning: `${model} thinks.`,
    actions: n === 1 ? [{ side: 'BUY', symbol: 'AAA', quantity: 2, why: 'test' }] : [],
    note_to_self: `note ${n}`,
  });
