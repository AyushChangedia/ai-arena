import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { createTestDb, type TestDb } from '../../../db/test/helpers';
import { verifyChain } from '@arena/shared/ledger-hash';
import { makeWorld, buyOnce, answer, testModels, type World } from '../helpers/world';
import { startSeason } from '../../src/ops/admin';
import { runRound } from '../../src/round/runner';
import { tick } from '../../src/round/tick';
import { currentSeason } from '../../src/round/store';
import { reconcile } from '../../src/round/reconcile';
import { replayRound } from '../../src/round/replay';
import { loadLedger } from '../../src/round/ledger-store';
import { abortStaleRounds } from '../../src/round/recovery';
import { monthSpendUsd } from '../../src/llm/budget';

const DAY = '2026-10-19'; // a Monday in the past
const at = (hhmm: string, plusSec = 30) =>
  new Date(new Date(`${DAY}T${hhmm}:00+05:30`).getTime() + plusSec * 1000);

let db: TestDb;
let w: World;

async function freshSeason(world: World, id = 'S0') {
  await startSeason(
    world.db,
    { id, start: DAY, mode: 'shadow' },
    world.deps.models,
    world.deps.calendar,
    BigInt(world.deps.arena.startingCashPaise),
    20,
    'test',
    'tester',
  );
  return (await currentSeason(world.db, 'shadow', DAY))!;
}

beforeAll(async () => {
  db = await createTestDb('round');
  w = makeWorld(db.engineUrl, at('09:30'), buyOnce);
});
afterAll(async () => {
  await w?.db.end();
  await db?.drop();
});

describe('a full round end to end (SPEC §19.3)', () => {
  it('records decisions, actions, ledger, positions and marks', async () => {
    const season = await freshSeason(w);
    const s = await runRound(w.deps, season, DAY, '09:30', 'cron');
    expect(s.status).toBe('COMPLETED');
    expect(s.participants.map((p) => [p.slot, p.status]).sort()).toEqual([
      ['anthropic', 'OK'],
      ['deepseek', 'OK'],
      ['google', 'OK'],
      ['meta', 'OK'],
      ['monkey', 'OK'],
      ['openai', 'OK'],
    ]);
    const round = (await w.db.query('SELECT * FROM rounds WHERE id = $1', [s.roundId])).rows[0];
    expect(round.status).toBe('COMPLETED');
    expect(round.market_block).toContain('MARKET at 09:30 IST');
    expect(new Date(round.reveal_at).getTime()).toBe(new Date(round.reveal_at).getTime());
    const season2 = (
      await w.db.query(
        "SELECT status, system_prompt, index_at_start_x100, to_char(ends_on,'YYYY-MM-DD') AS ends FROM seasons WHERE id = 'S0'",
      )
    ).rows[0];
    expect(season2.status).toBe('active');
    expect(season2.system_prompt).toContain(`The season runs from ${DAY}`);
    expect(season2.index_at_start_x100).toBe('2400000');
    // Five models bought 2 AAA each at the ask (1000.50).
    const buys = (
      await w.db.query(
        "SELECT participant_id, quantity, price_paise, price_source FROM ledger WHERE entry_type = 'BUY' AND participant_id NOT LIKE '%monkey'",
      )
    ).rows;
    expect(buys).toHaveLength(5);
    for (const b of buys)
      expect([b.quantity, b.price_paise, b.price_source]).toEqual([2, '100050', 'ask']);
    const starts = (
      await w.db.query("SELECT count(*)::int AS n FROM ledger WHERE entry_type = 'SEASON_START'")
    ).rows[0].n;
    expect(starts).toBe(6); // five models + Monkey; the Nifty benchmark has no ledger
    const marks = (
      await w.db.query(
        'SELECT p.kind, m.total_paise FROM marks m JOIN participants p ON p.id = m.participant_id WHERE m.round_id = $1',
        [s.roundId],
      )
    ).rows;
    expect(marks).toHaveLength(7);
    expect(marks.find((m) => m.kind === 'index').total_paise).toBe('10000000');
    const pos = (
      await w.db.query(
        "SELECT count(*)::int AS n FROM positions WHERE symbol = 'AAA' AND participant_id NOT LIKE '%monkey'",
      )
    ).rows[0].n;
    expect(pos).toBe(5);
    // Every row of the round shares one reveal time.
    const reveals = (
      await w.db.query(
        "SELECT DISTINCT reveal_at FROM (SELECT reveal_at FROM decisions WHERE round_id = $1 UNION ALL SELECT reveal_at FROM ledger WHERE round_id = $1 AND entry_type <> 'SEASON_START' UNION ALL SELECT reveal_at FROM marks WHERE round_id = $1 UNION ALL SELECT reveal_at FROM rounds WHERE id = $1) x",
        [s.roundId],
      )
    ).rows;
    expect(reveals).toHaveLength(1);
    expect((await verifyChain(await loadLedger(w.db))).ok).toBe(true);
    expect(
      w.llmBodies.every(
        (b) =>
          !('models' in b) && (b.provider as { require_parameters: boolean }).require_parameters,
      ),
    ).toBe(true);
  });

  it('the next round sees its history, note to self and holdings, and replay reproduces the hashes', async () => {
    w.clock.t = at('10:00');
    const season = (await currentSeason(w.db, 'shadow', DAY))!;
    const s = await runRound(w.deps, season, DAY, '10:00', 'cron');
    expect(s.status).toBe('COMPLETED');
    const priv = (
      await w.db.query(
        "SELECT private_block FROM decisions d JOIN participants p ON p.id = d.participant_id WHERE d.round_id = $1 AND p.slot = 'openai'",
        [s.roundId],
      )
    ).rows[0].private_block as string;
    expect(priv).toContain(
      'ROUND 2 of 12 today, Monday 2026-10-19, 10:00 IST. Season day 1 of 20. Next round: 10:30 IST.',
    );
    expect(priv).toContain('AAA, 2, 1000.50, 1000.00');
    expect(priv).toContain(`${DAY} 09:30: BUY 2 AAA filled at 1000.50`);
    expect(priv).toContain('YOUR NOTE TO SELF FROM LAST ROUND\nnote 1');
    const rounds = (await w.db.query('SELECT id FROM rounds')).rows.map((r) => r.id as string);
    for (const id of rounds) {
      const r = await replayRound(
        w.db,
        id,
        w.deps.arena,
        w.deps.fees,
        w.deps.universe.constituents.map((c) => c.symbol),
      );
      expect(r.mismatches).toEqual([]);
      expect(r.ok).toBe(true);
    }
  });

  it('two concurrent runs for the same slot produce exactly one round', async () => {
    w.clock.t = at('10:30');
    const season = (await currentSeason(w.db, 'shadow', DAY))!;
    const [a, b] = await Promise.all([
      runRound(w.deps, season, DAY, '10:30', 'cron'),
      runRound(w.deps, season, DAY, '10:30', 'cron'),
    ]);
    expect([a.status, b.status].sort()).toEqual(['COMPLETED', 'OWNED_ELSEWHERE']);
    expect(
      (await w.db.query("SELECT count(*)::int AS n FROM rounds WHERE slot_time = '10:30'")).rows[0]
        .n,
    ).toBe(1);
  });

  it('reconciliation passes, then detects a planted mismatch and pauses the arena', async () => {
    const ok = await reconcile(w.db, 'S0', DAY);
    expect(ok.problems).toEqual([]);
    await w.db.query(
      "UPDATE positions SET quantity = quantity + 1 WHERE symbol = 'AAA' AND participant_id = 'S0-openai'",
    );
    const { reconcileAndAct } = await import('../../src/round/reconcile');
    const bad = await reconcileAndAct(w.deps, 'S0', DAY);
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]).toMatch(/S0-openai AAA: ledger says 2/);
    const st = (await w.db.query('SELECT paused, paused_reason FROM arena_state')).rows[0];
    expect(st).toEqual({ paused: true, paused_reason: 'reconciliation_mismatch' });
    const inc = (
      await w.db.query("SELECT public_message FROM incidents WHERE key = 'reconcile:mismatch'")
    ).rows[0];
    expect(inc.public_message).toMatch(
      /^Numbers under review since \d\d:\d\d IST\. Rounds are paused until this is resolved\.$/,
    );
    expect(w.sink.messages.some((m) => m.startsWith('CRITICAL: Reconciliation mismatch'))).toBe(
      true,
    );
    // Undo the plant (positions are a cache) and resume, as an admin would after fixing.
    await w.db.query(
      "UPDATE positions SET quantity = quantity - 1 WHERE symbol = 'AAA' AND participant_id = 'S0-openai'",
    );
    await w.db.query('UPDATE arena_state SET paused = false, paused_reason = NULL');
    await w.db.query("UPDATE incidents SET resolved_at = now() WHERE key = 'reconcile:mismatch'");
  });

  it('records spend for the budget check', async () => {
    expect(await monthSpendUsd(w.db, 'S0-openai', at('11:00'))).toBeCloseTo(0.0033, 6);
  });
});

describe('failure modes produce the statuses in SPEC §13', () => {
  it('a data outage skips the round with DATA_LOGIN_FAILED and a critical incident', async () => {
    w.clock.t = at('11:00');
    w.market.loginFails = true;
    const season = (await currentSeason(w.db, 'shadow', DAY))!;
    const s = await runRound(w.deps, season, DAY, '11:00', 'cron');
    w.market.loginFails = false;
    expect([s.status, s.reason]).toEqual(['SKIPPED_DATA', 'DATA_LOGIN_FAILED']);
    const inc = (
      await w.db.query("SELECT severity, public_message FROM incidents WHERE key = 'data:login'")
    ).rows[0];
    expect(inc).toEqual({
      severity: 'critical',
      public_message: "Rounds are paused: market data isn't coming through.",
    });
    expect(
      (
        await w.db.query('SELECT count(*)::int AS n FROM decisions WHERE round_id = $1', [
          s.roundId,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it('too many invalid quotes skip the round (DATA_DEGRADED); a few become NO_PRICE', async () => {
    w.clock.t = at('11:30');
    w.market.invalid = new Set(['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF']);
    const season = (await currentSeason(w.db, 'shadow', DAY))!;
    const s = await runRound(w.deps, season, DAY, '11:30', 'cron');
    expect([s.status, s.reason]).toEqual(['SKIPPED_DATA', 'DATA_DEGRADED']);
    // The run summary says why, by count and cause.
    expect(s.detail).toBe('6 of 8 quotes invalid (schema: ltp Required 6)');
    w.market.invalid = new Set(['HHH']);
    w.clock.t = at('12:00');
    const s2 = await runRound(w.deps, season, DAY, '12:00', 'cron');
    expect(s2.status).toBe('COMPLETED');
    const mb = (await w.db.query('SELECT market_block FROM rounds WHERE id = $1', [s2.roundId]))
      .rows[0].market_block as string;
    expect(mb).toContain('NO_PRICE this round: HHH (schema: ltp Required)');
    w.market.invalid = new Set();
  });

  it('a changed provider shape is a critical data error with the field path', async () => {
    w.clock.t = at('12:30');
    w.market.quotesFail = true;
    const season = (await currentSeason(w.db, 'shadow', DAY))!;
    const s = await runRound(w.deps, season, DAY, '12:30', 'cron');
    w.market.quotesFail = false;
    expect([s.status, s.reason]).toEqual(['SKIPPED_DATA', 'DATA_SHAPE_CHANGED']);
    const inc = (
      await w.db.query(
        "SELECT severity, detail FROM incidents WHERE key = 'data:DATA_SHAPE_CHANGED'",
      )
    ).rows[0];
    expect(inc.severity).toBe('critical');
    expect(inc.detail).toContain('field data.fetched');
  });

  it('unreadable answers, wrong serving model and provider timeouts are isolated per model', async () => {
    w.clock.t = at('13:00');
    w.setLlm((model) => {
      if (model.startsWith('openai')) return answer(model, 'I like TCS.');
      if (model.startsWith('google'))
        return answer('google/some-other-model', { reasoning: 'x', actions: [], note_to_self: '' });
      if (model.startsWith('meta'))
        return { status: 503, body: { error: { code: 503, message: 'No available provider' } } };
      return answer(model, {
        reasoning: 'hold',
        actions: [{ side: 'SELL', symbol: 'ZZZ', quantity: 40, why: 'x' }],
        note_to_self: '',
      });
    });
    const season = (await currentSeason(w.db, 'shadow', DAY))!;
    const s = await runRound(w.deps, season, DAY, '13:00', 'cron');
    expect(s.status).toBe('COMPLETED');
    const by = Object.fromEntries(s.participants.map((p) => [p.slot, p.status]));
    expect(by).toMatchObject({
      openai: 'INVALID_RESPONSE',
      google: 'MODEL_MISMATCH',
      meta: 'MISSED_PROVIDER',
      anthropic: 'OK',
      deepseek: 'OK',
    });
    const rej = (
      await w.db.query(
        "SELECT reject_code, reject_detail, model_fault FROM actions a JOIN decisions d ON d.id = a.decision_id JOIN participants p ON p.id = d.participant_id WHERE d.round_id = $1 AND p.slot = 'anthropic'",
        [s.roundId],
      )
    ).rows[0];
    expect(rej).toEqual({
      reject_code: 'UNKNOWN_SYMBOL',
      reject_detail: 'Tried to sell 40 ZZZ, held 0',
      model_fault: true,
    });
    const mm = (
      await w.db.query("SELECT severity FROM incidents WHERE key = 'llm:mismatch:google'")
    ).rows[0];
    expect(mm.severity).toBe('critical');
  });

  it('a broken key for every model pauses the arena (MISSED_CONFIG)', async () => {
    w.clock.t = at('13:30');
    w.setLlm(() => ({
      status: 401,
      body: { error: { code: 401, message: 'No auth credentials found' } },
    }));
    const season = (await currentSeason(w.db, 'shadow', DAY))!;
    const s = await runRound(w.deps, season, DAY, '13:30', 'cron');
    expect(
      s.participants.filter((p) => p.slot !== 'monkey').every((p) => p.status === 'MISSED_CONFIG'),
    ).toBe(true);
    expect(s.participants.find((p) => p.slot === 'monkey')?.status).toBe('OK');
    expect((await w.db.query('SELECT paused, paused_reason FROM arena_state')).rows[0]).toEqual({
      paused: true,
      paused_reason: 'llm_auth',
    });
    // A paused arena records due slots as SKIPPED_PAUSED.
    w.clock.t = at('14:00', 60);
    const r = await tick(w.deps, { dry: false, mode: 'shadow', trigger: 'cron' });
    expect(r.ran).toContain('slot 14:00 recorded as paused');
    expect(
      (await w.db.query("SELECT status FROM rounds WHERE slot_time = '14:00'")).rows[0].status,
    ).toBe('SKIPPED_PAUSED');
    await w.db.query('UPDATE arena_state SET paused = false, paused_reason = NULL');
    w.setLlm(buyOnce);
  });

  it('402 pauses the arena with the out-of-credit message', async () => {
    w.clock.t = at('14:30');
    w.setLlm((m) =>
      m.startsWith('openai')
        ? { status: 402, body: { error: { code: 402, message: 'Insufficient credits' } } }
        : answer(m, { reasoning: '', actions: [], note_to_self: '' }),
    );
    const season = (await currentSeason(w.db, 'shadow', DAY))!;
    await runRound(w.deps, season, DAY, '14:30', 'cron');
    expect((await w.db.query('SELECT paused_reason FROM arena_state')).rows[0].paused_reason).toBe(
      'credits_exhausted',
    );
    expect(
      (await w.db.query("SELECT public_message FROM incidents WHERE key = 'llm:credits'")).rows[0]
        .public_message,
    ).toBe('Rounds are paused: the arena is out of API credit.');
    await w.db.query('UPDATE arena_state SET paused = false, paused_reason = NULL');
    w.setLlm(buyOnce);
  });

  it('a crash mid-round leaves a RUNNING round that the next tick marks ABORTED', async () => {
    const season = (await currentSeason(w.db, 'shadow', DAY))!;
    w.clock.t = at('15:00');
    // Simulate a crash: the round row exists and one decision was stored, then the process died.
    const id = '00000000-0000-4000-8000-00000000dead';
    await w.db.query(
      "INSERT INTO rounds (id, season_id, trading_date, slot_time, scheduled_at, started_at, status, trigger) VALUES ($1,'S0',$2,'15:00',$3,$3,'RUNNING','cron')",
      [id, DAY, at('15:00', 0)],
    );
    await w.db.query(
      "INSERT INTO decisions (id, round_id, participant_id, status) VALUES (gen_random_uuid(), $1, 'S0-openai', 'OK')",
      [id],
    );
    w.clock.t = at('15:20');
    const aborted = await abortStaleRounds(w.deps);
    expect(aborted).toEqual([id]);
    expect((await w.db.query('SELECT status FROM rounds WHERE id = $1', [id])).rows[0].status).toBe(
      'ABORTED',
    );
    const ds = (
      await w.db.query('SELECT status FROM decisions WHERE round_id = $1', [id])
    ).rows.map((r) => r.status);
    expect(ds).toHaveLength(6);
    expect(new Set(ds)).toEqual(new Set(['MISSED_ABORTED']));
    void season;
  });
});

describe('end of day, export, anchors and the public views', () => {
  it('tick runs end of day with a clean reconciliation, then exports a verifiable day', async () => {
    w.clock.t = at('15:45');
    const r = await tick(w.deps, { dry: false, mode: 'shadow', trigger: 'cron' });
    expect(r.ran.some((x) => x.startsWith('end of day (reconciliation ok)'))).toBe(true);
    expect(w.sink.messages.some((m) => m.includes('day-end'))).toBe(true);
    w.clock.t = at('16:05');
    // Export waits for day-end marks to be public in the database clock, which is now (they revealed long ago for this past date).
    const r2 = await tick(w.deps, { dry: false, mode: 'shadow', trigger: 'cron' });
    expect(r2.exported).toEqual([DAY]);
    const dir = join(w.deps.exportDir, 'public-data', '2026', '10', '19');
    const ledgerLines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect((await verifyChain(ledgerLines)).ok).toBe(true);
    const anchor = JSON.parse(
      readFileSync(join(w.deps.exportDir, 'public-data', 'anchors', `${DAY}.json`), 'utf8'),
    );
    expect(anchor.head_hash).toBe(ledgerLines.at(-1).hash);
    expect(readFileSync(join(dir, 'decisions.jsonl'), 'utf8')).toContain('"rng_seed"');
    const r3 = await tick(w.deps, { dry: false, mode: 'shadow', trigger: 'cron' });
    expect(r3.exported).toEqual([]);
  });

  it('web_ro sees revealed rows through views only', async () => {
    const web = new pg.Client({ connectionString: db.webUrl });
    await web.connect();
    try {
      const rounds = (await web.query('SELECT status FROM v_rounds')).rows.map((r) => r.status);
      expect(rounds).toContain('COMPLETED');
      expect(
        (await web.query('SELECT count(*)::int AS n FROM v_ledger')).rows[0].n,
      ).toBeGreaterThan(10);
      expect(
        (await web.query("SELECT count(*)::int AS n FROM v_holdings WHERE symbol = 'AAA'")).rows[0]
          .n,
      ).toBeGreaterThanOrEqual(5);
      await expect(web.query('SELECT * FROM decisions')).rejects.toThrow(/permission denied/);
    } finally {
      await web.end();
    }
  });

  it('missed slots in the past are recorded as MISSED_SCHEDULE on the next tick', async () => {
    const w2 = makeWorld(db.engineUrl, at('09:30'), buyOnce);
    try {
      await w2.db.query("UPDATE seasons SET status = 'finished' WHERE id = 'S0'");
      await startSeason(
        w2.db,
        { id: 'S9', start: '2026-10-20', mode: 'shadow' },
        testModels(),
        w2.deps.calendar,
        10_000_000n,
        20,
        'test',
        'tester',
      );
      w2.clock.t = new Date('2026-10-20T10:31:00+05:30');
      const r = await tick(w2.deps, { dry: false, mode: 'shadow', trigger: 'cron' });
      expect(r.ran.find((x) => x.startsWith('recorded missed slot(s) 09:30, 10:00'))).toBeTruthy();
      expect(r.ran).toContain('round 10:30');
    } finally {
      await w2.db.end();
    }
  });

  it('a live season refuses to run until the roster is approved', async () => {
    const w3 = makeWorld(
      db.engineUrl,
      new Date('2026-10-21T09:31:00+05:30'),
      buyOnce,
      testModels(false),
    );
    try {
      await expect(
        startSeason(
          w3.db,
          { id: 'S1', start: '2026-10-21', mode: 'live' },
          testModels(false),
          w3.deps.calendar,
          10_000_000n,
          20,
          't',
          't',
        ),
      ).rejects.toThrow(/not approved/);
      await startSeason(
        w3.db,
        { id: 'S1', start: '2026-10-21', mode: 'live' },
        testModels(true),
        w3.deps.calendar,
        10_000_000n,
        20,
        't',
        't',
      );
      const r = await tick(w3.deps, { dry: false, mode: 'live', trigger: 'cron' });
      expect(r.ok).toBe(false);
      expect(r.summary).toContain('not approved');
    } finally {
      await w3.db.end();
    }
  });
});
