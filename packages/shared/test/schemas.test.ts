import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  arenaConfigSchema,
  feesConfigSchema,
  modelsConfigSchema,
  universeSchema,
  calendarSchema,
  rosterRulesSchema,
  envSchema,
  cleanEnv,
  type ModelEntry,
} from '../src/schemas/index';
import { NotImplementedError, ConfigError, ClassifiedError, errorMessage } from '../src/errors';
import { REJECTION_CODES, STATUS_PUBLIC_TEXT, DECISION_STATUSES } from '../src/codes';

const read = (p: string) =>
  JSON.parse(readFileSync(new URL(`../../../config/${p}`, import.meta.url), 'utf8'));

describe('config schemas', () => {
  it('accepts the committed arena, fees and roster rules', () => {
    expect(arenaConfigSchema.parse(read('arena.json')).limits.maxActionsPerRound).toBe(5);
    expect(feesConfigSchema.parse(read('fees.json')).charges.stt.rate).toEqual({
      num: 1,
      den: 1000,
    });
    // The five paid-tier labs first, then the labs that take part only with free models.
    expect(Object.keys(rosterRulesSchema.parse(read('roster-rules.json')).slots)).toEqual([
      'openai',
      'anthropic',
      'google',
      'meta',
      'deepseek',
      'nvidia',
      'thinkingmachines',
      'xingchen',
      'recursive',
    ]);
  });
  it('rejects unknown keys and bad values in arena.json', () => {
    const a = read('arena.json');
    expect(arenaConfigSchema.safeParse({ ...a, extra: 1 }).success).toBe(false);
    expect(
      arenaConfigSchema.safeParse({ ...a, schedule: { ...a.schedule, firstSlot: '9:30' } }).success,
    ).toBe(false);
  });

  const entry = (slot: ModelEntry['slot'], code: string): ModelEntry => ({
    slot,
    openrouterId: `${slot}/m`,
    canonicalSlug: null,
    displayName: slot,
    shortCode: code,
    color: '#5AB8F0',
    created: 1,
    contextLength: 1000,
    supportedParameters: ['temperature'],
    pricing: { promptUsdPerToken: '0.0000001', completionUsdPerToken: '1e-7' },
    monthlyEstimateUsd: 1,
    monthlyCapUsd: 1.5,
  });
  const models = {
    tier: 'budget',
    approved: false,
    approvedBy: null,
    approvedOn: null,
    generatedAt: 'x',
    source: 'https://openrouter.ai/api/v1/models',
    estimateAssumptions: { inputTokensPerCall: 1, outputTokensPerCall: 1, roundsPerMonth: 1 },
    totalMonthlyEstimateUsd: 5,
    participants: [
      entry('openai', 'GPT'),
      entry('anthropic', 'CLD'),
      entry('google', 'GEM'),
      entry('meta', 'MSP'),
      entry('deepseek', 'DSK'),
    ],
    alternatives: [],
    benchmarks: {
      index: { displayName: 'Nifty 50', shortCode: 'NIF', color: '#F2F5F9' },
      monkey: { displayName: 'Monkey', shortCode: 'MKY', color: '#93A4BA' },
    },
  };
  it('validates models.json, including unique slots and short codes', () => {
    expect(modelsConfigSchema.safeParse(models).success).toBe(true);
    const dupSlot = {
      ...models,
      participants: [...models.participants.slice(0, 4), entry('openai', 'XYZ')],
    };
    expect(modelsConfigSchema.safeParse(dupSlot).success).toBe(false);
    const dupCode = {
      ...models,
      participants: [...models.participants.slice(0, 4), entry('deepseek', 'GPT')],
    };
    expect(modelsConfigSchema.safeParse(dupCode).success).toBe(false);
  });

  const constituents = Array.from({ length: 50 }, (_, i) => ({
    symbol: `SYM${i}`,
    name: `Company ${i}`,
  }));
  const universe = {
    index: 'NIFTY 50',
    effectiveFrom: '2026-09-30',
    sourceUrl: 'https://www.niftyindices.com/x.csv',
    downloadedOn: '2026-10-24',
    constituents,
  };
  it('validates the universe', () => {
    expect(universeSchema.safeParse(universe).success).toBe(true);
    expect(
      universeSchema.safeParse({
        ...universe,
        constituents: [...constituents.slice(0, 49), constituents[0]],
      }).success,
    ).toBe(false);
    expect(
      universeSchema.safeParse({ ...universe, constituents: constituents.slice(0, 49) }).success,
    ).toBe(false);
  });
  it('validates the calendar', () => {
    const cal = {
      year: 2026,
      exchange: 'NSE',
      segment: 'equity',
      source: 'NSE circular',
      sourceUrl: 'https://www.nseindia.com/x',
      downloadedOn: '2026-10-24',
      holidays: [{ date: '2026-01-26', description: 'Republic Day' }],
    };
    expect(calendarSchema.safeParse(cal).success).toBe(true);
    expect(
      calendarSchema.safeParse({ ...cal, holidays: [{ date: '2025-01-26', description: 'x' }] })
        .success,
    ).toBe(false);
  });
  it('validates env and treats blank values as missing', () => {
    const cleaned = cleanEnv({ DATABASE_URL: '  ', ARENA_MODE: 'shadow', UNRELATED: 'x' });
    expect(cleaned.DATABASE_URL).toBeUndefined();
    expect(cleaned).not.toHaveProperty('UNRELATED');
    expect(envSchema.safeParse({ ARENA_MODE: 'prod' }).success).toBe(false);
    expect(envSchema.safeParse({ ANGEL_TOTP_SECRET: 'not base32!' }).success).toBe(false);
  });
});

describe('errors and codes', () => {
  it('error classes carry their data', () => {
    expect(new NotImplementedError('x').message).toBe('Not implemented: x');
    expect(new ConfigError('m', 'f').fix).toBe('f');
    const c = new ClassifiedError('K', 'm', 'p', { cause: 1 });
    expect([c.kind, c.publicMessage, c.cause]).toEqual(['K', 'p', 1]);
    expect(errorMessage(new Error('e'))).toBe('e');
    expect(errorMessage('s')).toBe('s');
  });
  it('every decision status has public text; fault flags match SPEC §11.3', () => {
    for (const s of DECISION_STATUSES) expect(STATUS_PUBLIC_TEXT[s]).toBeTruthy();
    expect(REJECTION_CODES.PRICE_UNAVAILABLE.modelFault).toBe(false);
    expect(REJECTION_CODES.SYMBOL_SUSPENDED.modelFault).toBe(false);
    expect(Object.values(REJECTION_CODES).filter((c) => c.modelFault)).toHaveLength(11);
  });
});
