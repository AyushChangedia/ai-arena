/**
 * The live-service commands (roster, snapshot --dry, decide --dry, record-fixtures) run in-process with
 * global fetch stubbed to answer from the docs-example fixtures. Proves the wiring, not the live services.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { createTestDb, type TestDb } from '../../../db/test/helpers';
import { testModels, answer } from '../helpers/world';
import { fixture } from '../helpers/fixtures';

const repoConfig = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'config');
const cfg = mkdtempSync(join(tmpdir(), 'arena-live-'));
mkdirSync(join(cfg, 'universe'));
mkdirSync(join(cfg, 'calendar'));
for (const f of ['arena.json', 'fees.json', 'roster-rules.json'])
  copyFileSync(join(repoConfig, f), join(cfg, f));
const SYMS = Array.from({ length: 50 }, (_, i) => `T${i}`);
writeFileSync(
  join(cfg, 'universe', 'nifty50.json'),
  JSON.stringify({
    index: 'NIFTY 50',
    effectiveFrom: '2026-09-30',
    sourceUrl: 'https://example.test/l.csv',
    downloadedOn: '2026-10-01',
    constituents: SYMS.map((s) => ({ symbol: s, name: s })),
  }),
);
for (const year of [2025, 2026, 2027])
  writeFileSync(
    join(cfg, 'calendar', `nse-${year}.json`),
    JSON.stringify({
      year,
      exchange: 'NSE',
      segment: 'equity',
      source: 't',
      sourceUrl: 'https://example.test/',
      downloadedOn: '2026-01-01',
      holidays: [],
    }),
  );
writeFileSync(join(cfg, 'models.json'), JSON.stringify(testModels()));

const quoteItem = (
  fixture('angelone/quote-full.docs-example.json').body as {
    data: { fetched: Record<string, unknown>[] };
  }
).data.fetched[0]!;
const master = [
  ...SYMS.map((s, i) => ({
    token: String(1000 + i),
    symbol: `${s}-EQ`,
    name: s,
    expiry: '',
    strike: '-1',
    lotsize: '1',
    instrumenttype: '',
    exch_seg: 'NSE',
    tick_size: '5.000000',
  })),
  {
    token: '99926000',
    symbol: 'Nifty 50',
    name: 'NIFTY',
    instrumenttype: 'AMXIDX',
    exch_seg: 'NSE',
    tick_size: '0',
  },
  {
    token: '99926017',
    symbol: 'India VIX',
    name: 'INDIA VIX',
    instrumenttype: 'AMXIDX',
    exch_seg: 'NSE',
    tick_size: '0',
  },
];

function fakeGlobalFetch() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.endsWith('/api/v1/models'))
      return json(fixture('openrouter/models-list.docs-example.json').body);
    if (url.endsWith('/chat/completions'))
      return json(
        answer(body.model, {
          reasoning: 'Test.',
          actions: [{ side: 'BUY', symbol: 'T1', quantity: 1, why: 'x' }],
          note_to_self: '',
        }).body,
      );
    if (url.includes('OpenAPIScripMaster')) return json(master);
    if (url.endsWith('loginByPassword'))
      return json(fixture('angelone/login-success.docs-example.json').body);
    if (url.endsWith('/market/v1/quote')) {
      const t = DateTime.now().setZone('Asia/Kolkata').toFormat('dd-LLL-yyyy HH:mm:ss');
      const toks: string[] = body.exchangeTokens.NSE;
      return json({
        status: true,
        message: 'SUCCESS',
        errorcode: '',
        data: {
          fetched: toks.map((tok) => ({ ...quoteItem, symbolToken: tok, exchFeedTime: t })),
          unfetched: [],
        },
      });
    }
    if (url.endsWith('getCandleData'))
      return json(fixture('angelone/candles-one-day.docs-example.json').body);
    return json({ message: 'no route' }, 404);
  });
}

let db: TestDb;
const out: string[] = [];
const saved = { ...process.env };

beforeAll(async () => {
  db = await createTestDb('live');
  Object.assign(process.env, {
    ARENA_CONFIG_DIR: cfg,
    DATABASE_URL: db.engineUrl,
    ARENA_MODE: 'shadow',
    OPENROUTER_API_KEY: 'sk-test-only',
    ANGEL_API_KEY: 'test-api-key',
    ANGEL_CLIENT_CODE: 'TEST1',
    ANGEL_MPIN: '1234',
    ANGEL_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
  });
  vi.stubGlobal('fetch', fakeGlobalFetch());
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => (out.push(String(s)), true));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = saved;
  await db?.drop();
});

describe('live-service commands against docs-example responses', () => {
  it('roster proposes and writes models.json with approved=false', async () => {
    const { rosterCommand } = await import('../../src/commands/llm');
    const target = join(cfg, 'proposed.json');
    expect(await rosterCommand({ _: [], flags: { tier: 'budget', out: target } })).toBe(0);
    const m = JSON.parse(readFileSync(target, 'utf8'));
    expect(m.approved).toBe(false);
    expect(m.participants).toHaveLength(5);
    expect(out.join('')).toContain('Estimated total');
    expect(await rosterCommand({ _: [], flags: { tier: 'flagship' } })).toBe(1); // the fixture has no Opus/Gemini Pro
    await expect(rosterCommand({ _: [], flags: { tier: 'huge' } })).rejects.toThrow(/--tier/);
  });

  it('snapshot --dry logs in, maps 50 symbols and validates quotes', async () => {
    const { snapshotDry } = await import('../../src/commands/market');
    expect(await snapshotDry({ _: [], flags: { dry: true } })).toBe(0);
    expect(out.join('')).toMatch(
      /Mapping: 50 symbols mapped; unmapped: none; indices missing: none/,
    );
  });

  it('decide --dry calls every model with the real prompt and validates the answers', async () => {
    const { decideCommand } = await import('../../src/commands/llm');
    expect(await decideCommand({ _: [], flags: { dry: true, participant: 'all' } })).toBe(0);
    const text = out.join('');
    expect(text).toContain('## decide --dry (all)');
    expect(text).toMatch(/openai \| openai\/test-model \| OK/);
    await expect(
      decideCommand({ _: [], flags: { dry: true, participant: 'nobody' } }),
    ).rejects.toThrow(/--participant/);
  });

  it('record-fixtures writes sanitised recordings', async () => {
    const { recordAngelFixtures } = await import('../../src/commands/market');
    const dir = mkdtempSync(join(tmpdir(), 'fx-out-'));
    expect(await recordAngelFixtures({ _: [], flags: { out: dir } })).toBe(0);
    const files = readdirSync(join(dir, 'angelone'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    const all = files.map((f) => readFileSync(join(dir, 'angelone', f), 'utf8')).join('\n');
    expect(all).not.toContain('docs-example-placeholder-jwt');
    expect(all).not.toContain('test-api-key');
  });
});
