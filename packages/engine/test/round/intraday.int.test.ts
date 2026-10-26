/**
 * Intraday long-short end to end (SPEC §3, §12.3a; the owner's choice, 2026-10-26): a short opened in
 * a round, the square-off between 15:00 and 15:15, the end-of-day fallback, replay and the export.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { createTestDb, type TestDb } from '../../../db/test/helpers';
import { verifyChain } from '@arena/shared/ledger-hash';
import { makeWorld, answer, testModels, type World, type ModelBehaviour } from '../helpers/world';
import { startSeason, endSeason } from '../../src/ops/admin';
import { tick } from '../../src/round/tick';
import { currentSeason } from '../../src/round/store';
import { reconcile } from '../../src/round/reconcile';
import { replayRound } from '../../src/round/replay';
import { loadLedger } from '../../src/round/ledger-store';
import { historyFor } from '../../src/round/context';
import { computeCharges } from '../../src/core/fees';

const DAY = '2026-10-19'; // a Monday in the past
const DAY2 = '2026-10-20';
const DAY3 = '2026-10-21';
const at = (day: string, hhmm: string, plusSec = 30) =>
  new Date(new Date(`${day}T${hhmm}:00+05:30`).getTime() + plusSec * 1000);

/** openai shorts 10 AAA on its first call; the other models buy 5 BBB; later calls hold. */
const shortAndBuy: ModelBehaviour = (model, n) =>
  answer(model, {
    strategy: `${model}: fade weak opens, ride strong ones; stop at 1%.`,
    reasoning: `${model} round ${n}.`,
    actions:
      n !== 1
        ? []
        : model.startsWith('openai')
          ? [
              {
                side: 'SELL',
                symbol: 'AAA',
                quantity: 10,
                why: 'AAA opened weak on heavy volume; expect it to slide toward 950.',
                exit_plan: 'Cover below 960, or above 1010 as a stop.',
              },
            ]
          : [
              {
                side: 'BUY',
                symbol: 'BBB',
                quantity: 5,
                why: 'BBB broke above yesterday’s high.',
                exit_plan: 'Sell at 1300.',
              },
            ],
    note_to_self: '',
  });

let db: TestDb;
let w: World;
const tickNow = () => tick(w.deps, { dry: false, mode: 'shadow', trigger: 'cron' });

beforeAll(async () => {
  db = await createTestDb('intraday');
  w = makeWorld(db.engineUrl, at(DAY, '09:30'), shortAndBuy, testModels(), 'intraday');
  await startSeason(
    w.db,
    { id: 'P1', start: DAY, mode: 'shadow' },
    w.deps.models,
    w.deps.calendar,
    BigInt(w.deps.arena.startingCashPaise),
    20,
    'test',
    'tester',
  );
});
afterAll(async () => {
  await w?.db.end();
  await db?.drop();
});

describe('intraday day 1: a short, the square-off, end of day', () => {
  let roundId: string;

  it('a SELL with nothing held opens a short, and the strategy and exit plans are stored', async () => {
    const r = await tickNow();
    expect(r.ran).toContain('round 09:30');
    roundId = r.rounds[0]!.roundId!;
    const pos = (
      await w.db.query(
        "SELECT symbol, quantity, avg_cost_paise FROM positions WHERE participant_id = 'P1-openai'",
      )
    ).rows;
    expect(pos).toEqual([{ symbol: 'AAA', quantity: -10, avg_cost_paise: '99950' }]);
    const d = (
      await w.db.query(
        "SELECT strategy, reasoning FROM decisions WHERE round_id = $1 AND participant_id = 'P1-openai'",
        [roundId],
      )
    ).rows[0];
    expect(d.strategy).toContain('fade weak opens');
    const a = (
      await w.db.query(
        "SELECT a.why, a.exit_plan, a.status FROM actions a JOIN decisions d ON d.id = a.decision_id WHERE d.round_id = $1 AND d.participant_id = 'P1-openai'",
        [roundId],
      )
    ).rows[0];
    expect(a).toEqual({
      why: 'AAA opened weak on heavy volume; expect it to slide toward 950.',
      exit_plan: 'Cover below 960, or above 1010 as a stop.',
      status: 'executed',
    });
    // The model was told the square-off time and shown signed positions.
    expect(
      w.llmBodies.some((b) => JSON.stringify(b).includes('Square-off: 15:00 IST today.')),
    ).toBe(true);
    // The Monkey states its (lack of) strategy too.
    const m = (
      await w.db.query(
        "SELECT strategy FROM decisions WHERE round_id = $1 AND participant_id = 'P1-monkey'",
        [roundId],
      )
    ).rows[0];
    expect(m.strategy).toMatch(/^No strategy: coin flips/);
  });

  it('the 15:02 tick closes every position: shorts bought back at the ask, longs sold at the bid', async () => {
    w.market.prices.set('AAA', 95_000n); // AAA fell: the short made money
    w.clock.t = at(DAY, '15:02');
    const r = await tickNow();
    const so = r.rounds.find((x) => x.slot.startsWith('square-off'))!;
    expect(so.slot).toBe('square-off 15:02');
    expect(so.status).toBe('COMPLETED');
    expect(r.ran).toContain('square-off 15:02');
    expect((await w.db.query('SELECT count(*)::int AS n FROM positions')).rows[0].n).toBe(0);
    const round = (
      await w.db.query(
        "SELECT kind, status, to_char(slot_time,'HH24:MI') AS t FROM rounds WHERE id = $1",
        [so.roundId],
      )
    ).rows[0];
    expect(round).toEqual({ kind: 'square_off', status: 'COMPLETED', t: '15:02' });
    const cover = (
      await w.db.query(
        "SELECT side, quantity, price_paise, price_source, position_after, realized_pnl_paise, charges_total_paise FROM ledger WHERE round_id = $1 AND participant_id = 'P1-openai'",
        [so.roundId],
      )
    ).rows[0];
    const gross = 95_050n * 10n;
    const charges = computeCharges(w.deps.fees, 'BUY', gross, { dpApplies: false }).total;
    expect(cover).toEqual({
      side: 'BUY',
      quantity: 10,
      price_paise: '95050',
      price_source: 'ask',
      position_after: 0,
      realized_pnl_paise: ((99_950n - 95_050n) * 10n - charges).toString(),
      charges_total_paise: charges.toString(),
    });
    const sells = (
      await w.db.query(
        "SELECT count(*)::int AS n FROM ledger WHERE round_id = $1 AND side = 'SELL' AND symbol = 'BBB' AND price_source = 'bid'",
        [so.roundId],
      )
    ).rows[0].n;
    expect(sells).toBeGreaterThanOrEqual(4);
    const ds = (
      await w.db.query('SELECT DISTINCT status FROM decisions WHERE round_id = $1', [so.roundId])
    ).rows.map((x) => x.status);
    expect(ds).toEqual(['SQUARE_OFF']);
    // Replay reproduces both the short and the square-off.
    for (const id of [roundId, so.roundId!]) {
      const rep = await replayRound(
        w.db,
        id,
        w.deps.arena,
        w.deps.fees,
        w.deps.universe.constituents.map((c) => c.symbol),
      );
      expect(rep.mismatches).toEqual([]);
      expect(rep.compared).toBeGreaterThan(0);
    }
    // The next round's history shows the square-off fills.
    const season = (await currentSeason(w.db, 'shadow', DAY))!;
    const h = await historyFor(w.db, season.id, 'P1-openai', null);
    expect(h[0]).toBe(`${DAY} 15:02 square-off: BUY 10 AAA filled at 950.50`);
  });

  it('nothing is left to square off at 15:12, and end of day marks everyone in cash', async () => {
    w.clock.t = at(DAY, '15:12');
    const r = await tickNow();
    expect(r.ran.some((x) => x.startsWith('square-off'))).toBe(false);
    w.clock.t = at(DAY, '15:45');
    const r2 = await tickNow();
    expect(r2.ran.some((x) => x.startsWith('end of day (reconciliation ok)'))).toBe(true);
    expect(r2.ran.some((x) => x.includes('(end of day)'))).toBe(false);
    const eod = (
      await w.db.query(
        "SELECT m.holdings_value_paise, p.kind FROM marks m JOIN participants p ON p.id = m.participant_id WHERE m.kind = 'eod' AND p.kind <> 'index'",
      )
    ).rows;
    expect(eod.length).toBe(6);
    expect(eod.every((m) => m.holdings_value_paise === '0')).toBe(true);
    w.clock.t = at(DAY, '16:05');
    const r3 = await tickNow();
    expect(r3.exported).toEqual([DAY]);
    const dir = join(w.deps.exportDir, 'public-data', '2026', '10', '19');
    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect((await verifyChain(ledger)).ok).toBe(true);
    expect(ledger.some((e) => e.position_after === '-10')).toBe(true);
    const decisions = readFileSync(join(dir, 'decisions.jsonl'), 'utf8');
    expect(decisions).toContain('"strategy":"openai/test-model: fade weak opens');
    expect(decisions).toContain('"exit_plan":"Cover below 960, or above 1010 as a stop."');
    expect(readFileSync(join(dir, 'rounds.jsonl'), 'utf8')).toContain('"kind":"square_off"');
  });

  it('the public views show the strategy, the exit plans and the square-off round', async () => {
    const web = new pg.Client({ connectionString: db.webUrl });
    await web.connect();
    try {
      expect(
        (await web.query("SELECT count(*)::int AS n FROM v_rounds WHERE kind = 'square_off'"))
          .rows[0].n,
      ).toBe(1);
      expect(
        (await web.query('SELECT count(*)::int AS n FROM v_decisions WHERE strategy IS NOT NULL'))
          .rows[0].n,
      ).toBeGreaterThan(0);
      expect(
        (await web.query("SELECT exit_plan FROM v_actions WHERE symbol = 'AAA' AND side = 'SELL'"))
          .rows[0].exit_plan,
      ).toBe('Cover below 960, or above 1010 as a stop.');
      // Open shorts appear in v_holdings while open; after the square-off there are none.
      expect((await web.query('SELECT count(*)::int AS n FROM v_holdings')).rows[0].n).toBe(0);
    } finally {
      await web.end();
    }
  });
});

describe('intraday day 2: a stock with no price at the square-off', () => {
  it('stays open and is retried, then end of day closes it at the day-end price', async () => {
    w.setLlm(shortAndBuy);
    w.market.prices.set('AAA', 100_000n);
    w.clock.t = at(DAY2, '09:30');
    await tickNow();
    expect(
      (
        await w.db.query(
          "SELECT quantity FROM positions WHERE participant_id = 'P1-openai' AND symbol = 'AAA'",
        )
      ).rows[0].quantity,
    ).toBe(-10);
    w.market.invalid.add('AAA');
    w.clock.t = at(DAY2, '15:02');
    const r = await tickNow();
    const so = r.rounds.find((x) => x.slot === 'square-off 15:02')!;
    expect(so.status).toBe('PARTIAL');
    expect(so.reason).toContain('AAA');
    expect(
      (await w.db.query('SELECT severity FROM incidents WHERE key = $1', [`squareoff:${DAY2}`]))
        .rows[0].severity,
    ).toBe('warn');
    // After the deadline the retry is critical.
    w.clock.t = at(DAY2, '15:22');
    const r2 = await tickNow();
    expect(r2.rounds.find((x) => x.slot === 'square-off 15:22')!.status).toBe('PARTIAL');
    expect(
      (
        await w.db.query('SELECT severity FROM incidents WHERE key = $1 AND resolved_at IS NULL', [
          `squareoff:${DAY2}`,
        ])
      ).rows[0].severity,
    ).toBe('warn'); // an open incident keeps its first severity; the alert was raised once
    w.market.invalid.delete('AAA');
    w.clock.t = at(DAY2, '15:45');
    const r3 = await tickNow();
    expect(r3.ran.some((x) => x.endsWith('(end of day)'))).toBe(true);
    expect(r3.ran.some((x) => x.startsWith('end of day (reconciliation ok)'))).toBe(true);
    expect((await w.db.query('SELECT count(*)::int AS n FROM positions')).rows[0].n).toBe(0);
    const last = (
      await w.db.query(
        "SELECT r.kind, d.reasoning FROM ledger l JOIN rounds r ON r.id = l.round_id JOIN decisions d ON d.round_id = r.id AND d.participant_id = l.participant_id WHERE l.participant_id = 'P1-openai' ORDER BY l.seq DESC LIMIT 1",
      )
    ).rows[0];
    expect(last.kind).toBe('square_off');
    expect(last.reasoning).toMatch(/^End-of-day square-off/);
    expect(
      (await w.db.query('SELECT resolved_at FROM incidents WHERE key = $1', [`squareoff:${DAY2}`]))
        .rows[0].resolved_at,
    ).not.toBeNull();
    expect((await reconcile(w.db, 'P1', null)).ok).toBe(true);
    expect((await verifyChain(await loadLedger(w.db))).ok).toBe(true);
  });
});

describe('intraday day 3: a paused arena still squares off', () => {
  it('closes positions at 15:02 while paused for credit, but not during a reconciliation review', async () => {
    w.setLlm(shortAndBuy);
    w.clock.t = at(DAY3, '09:30');
    await tickNow();
    expect(
      (await w.db.query('SELECT count(*)::int AS n FROM positions')).rows[0].n,
    ).toBeGreaterThan(0);
    await w.db.query(
      "UPDATE arena_state SET paused = true, paused_reason = 'reconciliation_mismatch'",
    );
    w.clock.t = at(DAY3, '15:02');
    const r = await tickNow();
    expect(r.ran.some((x) => x.startsWith('square-off'))).toBe(false);
    await w.db.query("UPDATE arena_state SET paused_reason = 'credits_exhausted'");
    w.clock.t = at(DAY3, '15:12');
    const r2 = await tickNow();
    expect(r2.ran).toContain('square-off 15:12');
    expect((await w.db.query('SELECT count(*)::int AS n FROM positions')).rows[0].n).toBe(0);
    // Finishing after 15:15 would raise a late incident; 15:12 is on time.
    expect(
      (
        await w.db.query('SELECT count(*)::int AS n FROM incidents WHERE key = $1', [
          `squareoff-late:${DAY3}`,
        ])
      ).rows[0].n,
    ).toBe(0);
    await w.db.query('UPDATE arena_state SET paused = false, paused_reason = NULL');
  });
});

describe('ending a season early for a fresh practice season (owner decision, 2026-10-26)', () => {
  it('freezes the old season, then a new one can start', async () => {
    await expect(endSeason(w.db, 'P1', ' ', 'tester')).rejects.toThrow(/needs --reason/);
    await expect(endSeason(w.db, 'NOPE', 'x', 'tester')).rejects.toThrow(/No season NOPE/);
    const ledgerBefore = (await w.db.query('SELECT count(*)::int AS n FROM ledger')).rows[0].n;
    const msg = await endSeason(w.db, 'P1', 'Rules changed to intraday long-short.', 'tester');
    expect(msg).toBe(
      `Season P1 finished early after 3 trading day(s), on ${DAY3}. Its standings are frozen at that day's marks.`,
    );
    const s = (
      await w.db.query(
        "SELECT status, to_char(ends_on,'YYYY-MM-DD') AS ends, trading_days FROM seasons WHERE id = 'P1'",
      )
    ).rows[0];
    expect(s).toEqual({ status: 'finished', ends: DAY3, trading_days: 3 });
    expect((await w.db.query('SELECT count(*)::int AS n FROM ledger')).rows[0].n).toBe(
      ledgerBefore,
    );
    const log = (
      await w.db.query("SELECT args, reason FROM admin_log WHERE command = 'end-season'")
    ).rows[0];
    expect(log.reason).toBe('Rules changed to intraday long-short.');
    expect(log.args.plannedTradingDays).toBe(20);
    await expect(endSeason(w.db, 'P1', 'again', 'tester')).rejects.toThrow(/already finished/);
    expect(await currentSeason(w.db, 'shadow', '2026-10-22')).toBeNull();
    await startSeason(
      w.db,
      { id: 'P2', start: '2026-10-22', mode: 'shadow' },
      w.deps.models,
      w.deps.calendar,
      BigInt(w.deps.arena.startingCashPaise),
      20,
      'fresh practice season',
      'tester',
    );
    expect((await currentSeason(w.db, 'shadow', '2026-10-22'))?.id).toBe('P2');
  });
});
