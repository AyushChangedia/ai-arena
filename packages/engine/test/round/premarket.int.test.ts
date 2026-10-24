import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from '../../../db/test/helpers';
import { makeWorld, buyOnce, type World } from '../helpers/world';
import {
  startSeason,
  corpAction,
  pause,
  resume,
  retire,
  clearFlag,
  resolveIncidentById,
  correct,
} from '../../src/ops/admin';
import { runRound } from '../../src/round/runner';
import { runPreMarket } from '../../src/round/premarket';
import { currentSeason } from '../../src/round/store';
import { reconcile } from '../../src/round/reconcile';
import { replayRound } from '../../src/round/replay';
import { tick } from '../../src/round/tick';

const D1 = '2026-10-19';
const D2 = '2026-10-20';
let db: TestDb;
let w: World;

beforeAll(async () => {
  db = await createTestDb('pre');
  w = makeWorld(db.engineUrl, new Date(`${D1}T09:30:30+05:30`), buyOnce);
  await startSeason(
    w.db,
    { id: 'S0', start: D1, mode: 'shadow' },
    w.deps.models,
    w.deps.calendar,
    10_000_000n,
    20,
    'test',
    'tester',
  );
  await runRound(w.deps, (await currentSeason(w.db, 'shadow', D1))!, D1, '09:30', 'cron');
});
afterAll(async () => {
  await w?.db.end();
  await db?.drop();
});

describe('replay detects a changed computation', () => {
  it('reports mismatching hashes when the fee schedule differs from the one used', async () => {
    const id = (await w.db.query("SELECT id FROM rounds WHERE slot_time = '09:30'")).rows[0].id;
    const fees = structuredClone(w.deps.fees);
    fees.charges.stt.rate = { num: 2, den: 1000 };
    const r = await replayRound(
      w.db,
      id,
      w.deps.arena,
      fees,
      w.deps.universe.constituents.map((c) => c.symbol),
    );
    expect(r.ok).toBe(false);
    expect(r.mismatches.some((m) => /replay hash/.test(m))).toBe(true);
  });
});

describe('pre-market job and corporate actions (SPEC §12.4, §8.7)', () => {
  it('maps instruments, backfills bars, computes indicators and applies a split on its ex-date', async () => {
    await corpAction(
      w.db,
      {
        symbol: 'AAA',
        type: 'split',
        ratio: '2:1',
        exDate: D2,
        source: 'https://example.test/split',
      },
      'split',
      'tester',
    );
    w.clock.t = new Date(`${D2}T08:45:00+05:30`);
    const detail = await runPreMarket(w.deps, (await currentSeason(w.db, 'shadow', D2))!, D2);
    expect(detail.mapped).toBe(8);
    expect(detail.corporateActions).toEqual(['AAA split']);
    const pos = (
      await w.db.query(
        "SELECT quantity, avg_cost_paise FROM positions WHERE participant_id = 'S0-openai' AND symbol = 'AAA'",
      )
    ).rows[0];
    expect(pos).toEqual({ quantity: 4, avg_cost_paise: '50025' });
    const adj = (
      await w.db.query(
        "SELECT entry_type, quantity, position_after FROM ledger WHERE participant_id = 'S0-openai' AND entry_type = 'SPLIT_ADJUST'",
      )
    ).rows[0];
    expect(adj).toEqual({ entry_type: 'SPLIT_ADJUST', quantity: 2, position_after: 4 });
    expect(
      (await w.db.query('SELECT count(*)::int AS n FROM daily_bars')).rows[0].n,
    ).toBeGreaterThan(0);
    expect(
      (await w.db.query('SELECT count(*)::int AS n FROM indicators WHERE date = $1', [D2])).rows[0]
        .n,
    ).toBe(8);
    expect((await reconcile(w.db, 'S0', D2)).ok).toBe(true);
  });

  it('a tick in the pre-market window runs the job once', async () => {
    w.clock.t = new Date('2026-10-21T08:40:00+05:30');
    const r1 = await tick(w.deps, { dry: false, mode: 'shadow', trigger: 'cron' });
    expect(r1.ran).toContain('pre-market job');
    const r2 = await tick(w.deps, { dry: false, mode: 'shadow', trigger: 'cron' });
    expect(r2.ran).not.toContain('pre-market job');
    const dry = await tick(w.deps, { dry: true, mode: 'shadow', trigger: 'manual' });
    expect(dry.summary).toContain('Dry run');
  });
});

describe('admin commands write the public admin log', () => {
  it('pause, resume, retire, clear-flag, resolve-incident and correct', async () => {
    expect(await pause(w.db, 'maintenance', 'tester')).toBe('Arena paused.');
    expect(await resume(w.db, 'done', 'tester')).toBe('Arena resumed.');
    expect(await retire(w.db, 'meta', 'model removed from OpenRouter', 'tester')).toMatch(
      /Retired meta/,
    );
    await w.db.query(
      "INSERT INTO symbol_flags (symbol, flag, reason, set_at) VALUES ('BBB','SUSPENDED_REVIEW','gap',now())",
    );
    expect(await clearFlag(w.db, 'BBB', 'checked: no corporate action', 'tester')).toBe(
      'Cleared the flag on BBB.',
    );
    await expect(clearFlag(w.db, 'BBB', 'again', 'tester')).rejects.toThrow(/no active flag/);
    const inc = (
      await w.db.query(
        "INSERT INTO incidents (id, key, severity, title, detail, public_message, scope, started_at) VALUES (gen_random_uuid(),'x','warn','t','d','p','arena',now()) RETURNING id",
      )
    ).rows[0].id;
    expect(await resolveIncidentById(w.db, inc, 'fixed', 'tester')).toMatch(/Resolved/);
    const seq = (
      await w.db.query(
        "SELECT seq FROM ledger WHERE participant_id = 'S0-google' AND entry_type = 'BUY'",
      )
    ).rows[0].seq;
    expect(
      await correct(
        w.db,
        { refSeq: seq, cashDeltaPaise: 100n },
        'refund a charge entered twice',
        'tester',
      ),
    ).toMatch(/Wrote correction/);
    await expect(
      correct(w.db, { refSeq: '999999', cashDeltaPaise: 0n }, 'x', 'tester'),
    ).rejects.toThrow(/No ledger entry/);
    expect((await reconcile(w.db, 'S0', null)).ok).toBe(true);
    const log = (await w.db.query('SELECT command FROM admin_log ORDER BY at')).rows.map(
      (r) => r.command,
    );
    expect(log).toEqual(
      expect.arrayContaining([
        'start-season',
        'corp-action',
        'pause',
        'resume',
        'retire',
        'clear-flag',
        'resolve-incident',
        'correct',
      ]),
    );
    await expect(
      corpAction(
        w.db,
        { symbol: 'AAA', type: 'dividend', amount: '0', exDate: D2, source: 'https://x.test' },
        'x',
        't',
      ),
    ).rejects.toThrow(/positive/);
    await expect(
      corpAction(
        w.db,
        { symbol: 'AAA', type: 'split', ratio: '2-1', exDate: D2, source: 'https://x.test' },
        'x',
        't',
      ),
    ).rejects.toThrow(/ratio/);
  });

  it('a retired model has its holdings sold at the next round, then a RETIRE entry', async () => {
    w.clock.t = new Date('2026-10-21T10:00:30+05:30');
    const s = await runRound(
      w.deps,
      (await currentSeason(w.db, 'shadow', '2026-10-21'))!,
      '2026-10-21',
      '10:00',
      'cron',
    );
    expect(s.participants.find((p) => p.slot === 'meta')).toMatchObject({
      status: 'RETIRED',
      actions: 'SELL 4 AAA',
    });
    const e = (
      await w.db.query(
        "SELECT entry_type FROM ledger WHERE participant_id = 'S0-meta' ORDER BY seq DESC LIMIT 2",
      )
    ).rows.map((r) => r.entry_type);
    expect(e).toEqual(['RETIRE', 'SELL']);
    expect(
      (
        await w.db.query(
          "SELECT count(*)::int AS n FROM positions WHERE participant_id = 'S0-meta'",
        )
      ).rows[0].n,
    ).toBe(0);
    const r = await replayRound(
      w.db,
      s.roundId!,
      w.deps.arena,
      w.deps.fees,
      w.deps.universe.constituents.map((c) => c.symbol),
    );
    expect(r.mismatches).toEqual([]);
  });
});
