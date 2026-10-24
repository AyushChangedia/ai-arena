/**
 * The CLI commands, run in-process against a test database with a temporary config directory.
 * The config dir holds copies of the committed arena/fees/roster rules plus test-only universe,
 * calendar and models files.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from '../../../db/test/helpers';
import { testModels } from '../helpers/world';

const TEST_UNIVERSE_50 = {
  index: 'NIFTY 50',
  effectiveFrom: '2026-09-30',
  sourceUrl: 'https://example.test/list.csv',
  downloadedOn: '2026-10-01',
  constituents: Array.from({ length: 50 }, (_, i) => ({ symbol: `T${i}`, name: `Test ${i}` })),
};

const repoConfig = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'config');
const cfg = mkdtempSync(join(tmpdir(), 'arena-cfg-'));
mkdirSync(join(cfg, 'universe'));
mkdirSync(join(cfg, 'calendar'));
for (const f of ['arena.json', 'fees.json', 'roster-rules.json'])
  copyFileSync(join(repoConfig, f), join(cfg, f));
writeFileSync(join(cfg, 'universe', 'nifty50.json'), JSON.stringify(TEST_UNIVERSE_50));
for (const year of [2025, 2026, 2027])
  writeFileSync(
    join(cfg, 'calendar', `nse-${year}.json`),
    JSON.stringify({
      year,
      exchange: 'NSE',
      segment: 'equity',
      source: 'test',
      sourceUrl: 'https://example.test/',
      downloadedOn: '2026-01-01',
      holidays: [],
    }),
  );
writeFileSync(join(cfg, 'models.json'), JSON.stringify(testModels()));
process.env.ARENA_CONFIG_DIR = cfg;

let db: TestDb;
const out: string[] = [];
const savedEnv = { ...process.env };

beforeAll(async () => {
  db = await createTestDb('cmd');
  process.env.DATABASE_URL = db.engineUrl;
  process.env.ARENA_MODE = 'shadow';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  process.env = savedEnv;
  await db?.drop();
});

const text = () => out.join('');

describe('CLI commands', () => {
  it('admin start-season, pause, resume and bad usage', async () => {
    const { adminCommand } = await import('../../src/commands/ops');
    const { parseArgs } = await import('../../src/ops/args');
    expect(
      await adminCommand(
        parseArgs([
          'start-season',
          '--id',
          'S0',
          '--start',
          '2026-10-19',
          '--mode',
          'shadow',
          '--reason',
          'test',
        ]),
      ),
    ).toBe(0);
    expect(text()).toContain(
      'Season S0 (shadow) scheduled: 2026-10-19 to 2026-11-13, 20 trading days',
    );
    expect(await adminCommand(parseArgs(['pause', '--reason', 'test']))).toBe(0);
    expect(await adminCommand(parseArgs(['resume', '--reason', 'test']))).toBe(0);
    expect(
      await adminCommand(
        parseArgs([
          'corp-action',
          '--symbol',
          'AAA',
          '--type',
          'dividend',
          '--amount',
          '5.50',
          '--ex-date',
          '2026-10-30',
          '--source',
          'https://x.test',
          '--reason',
          'r',
        ]),
      ),
    ).toBe(0);
    expect(await adminCommand(parseArgs(['nope']))).toBe(2);
    await expect(
      adminCommand(
        parseArgs(['start-season', '--id', 'S1', '--start', '2026-10-19', '--mode', 'live']),
      ),
    ).rejects.toThrow(/not approved/);
  });

  it('tick --dry and tick report the schedule state without failing', async () => {
    const { tickCommand } = await import('../../src/commands/ops');
    const { parseArgs } = await import('../../src/ops/args');
    expect(await tickCommand(parseArgs(['--dry']))).toBe(0);
    expect(text()).toContain('Dry run');
    const code = await tickCommand(parseArgs([]));
    expect([0, 1]).toContain(code);
    expect(text()).toMatch(/## Tick \d{4}-\d{2}-\d{2} \d{2}:\d{2} IST/);
  });

  it('reconcile, verify-ledger (database and file), anchor-commit and replay of an unknown round', async () => {
    const { reconcileCommand, verifyLedgerCommand, anchorCommitCommand, replayCommand } =
      await import('../../src/commands/ops');
    const { parseArgs } = await import('../../src/ops/args');
    expect(await reconcileCommand(parseArgs([]))).toBe(0);
    expect(await verifyLedgerCommand(parseArgs([]))).toBe(0);
    const f = join(cfg, 'ledger.jsonl');
    writeFileSync(f, '');
    expect(await verifyLedgerCommand(parseArgs(['--file', f]))).toBe(0);
    writeFileSync(
      f,
      '{"seq":"1","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","hash":"bad","id":"x","season_id":"S","participant_id":"P","entry_type":"SEASON_START","gross_paise":"0","charges":{},"charges_total_paise":"0","cash_delta_paise":"1","cash_after_paise":"1","occurred_at":"2026-01-01T00:00:00.000Z","reveal_at":"2026-01-01T00:00:00.000Z"}\n',
    );
    expect(await verifyLedgerCommand(parseArgs(['--file', f]))).toBe(1);
    expect(text()).toContain('FAILED');
    expect(await anchorCommitCommand(parseArgs(['--date', '2026-10-19', '--sha', 'abcdef1']))).toBe(
      0,
    );
    await expect(
      anchorCommitCommand(parseArgs(['--date', '2026-10-19', '--sha', 'not-a-sha'])),
    ).rejects.toThrow(/commit hash/);
    await expect(
      replayCommand(parseArgs(['--round', '00000000-0000-4000-8000-000000000000'])),
    ).rejects.toThrow(/not found/);
    expect(await replayCommand(parseArgs(['--round', 'random']))).toBe(0);
  });

  it('import-universe and import-holidays write config files', async () => {
    const { importUniverse, importHolidays } = await import('../../src/commands/market');
    const { parseArgs } = await import('../../src/ops/args');
    const csv = join(cfg, 'n50.csv');
    writeFileSync(
      csv,
      [
        'Company Name,Industry,Symbol,Series,ISIN Code',
        ...Array.from(
          { length: 50 },
          (_, i) => `Co ${i},Ind,S${i},EQ,INE00000${String(i).padStart(4, '0')}`,
        ),
      ].join('\n'),
    );
    expect(await importUniverse(parseArgs(['--csv', csv, '--effective-from', '2026-09-30']))).toBe(
      0,
    );
    expect(
      JSON.parse(readFileSync(join(cfg, 'universe', 'nifty50.json'), 'utf8')).constituents,
    ).toHaveLength(50);
    writeFileSync(join(cfg, 'universe', 'nifty50.json'), JSON.stringify(TEST_UNIVERSE_50));
    const hol = join(cfg, 'h.json');
    writeFileSync(
      hol,
      JSON.stringify({ CM: [{ tradingDate: '25-Dec-2027', description: 'Christmas' }] }),
    );
    expect(await importHolidays(parseArgs(['--year', '2027', '--file', hol]))).toBe(0);
    expect(
      JSON.parse(readFileSync(join(cfg, 'calendar', 'nse-2027.json'), 'utf8')).holidays,
    ).toHaveLength(1);
  });

  it('snapshot and decide refuse to run without --dry', async () => {
    const { snapshotDry } = await import('../../src/commands/market');
    const { decideCommand } = await import('../../src/commands/llm');
    const { parseArgs } = await import('../../src/ops/args');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await snapshotDry(parseArgs([]))).toBe(2);
    expect(await decideCommand(parseArgs([]))).toBe(2);
    err.mockRestore();
  });

  it('doctor runs the database probe against the test database', async () => {
    const { commands } = await import('../../src/commands');
    expect(await commands.doctor!.run({ _: [], flags: {} })).toBe(1); // Angel One / OpenRouter are not configured
    expect(text()).toMatch(/database connection \+ migrations \| yes \| pass/);
  });
});
