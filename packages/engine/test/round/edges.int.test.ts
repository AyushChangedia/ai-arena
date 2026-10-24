import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from '../../../db/test/helpers';
import { makeWorld, buyOnce, answer, testModels, type World } from '../helpers/world';
import { startSeason } from '../../src/ops/admin';
import { runRound } from '../../src/round/runner';
import { runEndOfDay } from '../../src/round/eod';
import { currentSeason } from '../../src/round/store';
import { revalidateIfDue } from '../../src/ops/revalidate';
import { exportDay } from '../../src/round/export';
import { fakeFetch } from '../helpers/fixtures';
import { DataError } from '../../src/data/provider';

const DAY = '2026-10-19';
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:30+05:30`);
let db: TestDb;
let w: World;
const season = async () => (await currentSeason(w.db, 'shadow', DAY))!;

beforeAll(async () => {
  db = await createTestDb('edges');
  const models = testModels();
  models.participants[1]!.monthlyCapUsd = 0.0015; // anthropic: one call's cost (0.0011) leaves it under; two put it over
  w = makeWorld(db.engineUrl, at('09:30'), buyOnce, models);
  await startSeason(
    w.db,
    { id: 'S0', start: DAY, mode: 'shadow' },
    models,
    w.deps.calendar,
    10_000_000n,
    1,
    'test',
    'tester',
  );
});
afterAll(async () => {
  await w?.db.end();
  await db?.drop();
});

describe('runner edge cases', () => {
  it('flags a held stock that gapped at the open with no corporate action (gap guard)', async () => {
    await runRound(w.deps, await season(), DAY, '09:30', 'cron');
    // Next day's first round: AAA opens 30% above its previous close.
    w.clock.t = new Date('2026-10-20T09:30:30+05:30');
    const provider = w.deps.provider;
    w.deps.provider = () => {
      const p = provider();
      return {
        ...p,
        login: async () => {
          const s = await p.login();
          return {
            ...s,
            quotes: async (e, i) => {
              const b = await s.quotes(e, i);
              return {
                ...b,
                quotes: b.quotes.map((q) =>
                  q.symbol === 'AAA'
                    ? { ...q, openPaise: 130_000n, prevClosePaise: 100_000n, ltpPaise: 115_000n }
                    : q,
                ),
              };
            },
          };
        },
      };
    };
    await w.db.query(
      "UPDATE seasons SET ends_on = '2026-10-30', trading_days = 20 WHERE id = 'S0'",
    );
    const s = await runRound(
      w.deps,
      (await currentSeason(w.db, 'shadow', '2026-10-20'))!,
      '2026-10-20',
      '09:30',
      'cron',
    );
    w.deps.provider = provider;
    expect(s.incidents.some((i) => /AAA gapped/.test(i))).toBe(true);
    expect(
      (await w.db.query("SELECT flag FROM symbol_flags WHERE symbol = 'AAA'")).rows[0].flag,
    ).toBe('SUSPENDED_REVIEW');
    const ex = (
      await w.db.query(
        "SELECT reject_code FROM actions WHERE symbol = 'AAA' AND reject_code IS NOT NULL",
      )
    ).rows.map((r) => r.reject_code);
    expect(ex.every((c) => c === 'SYMBOL_SUSPENDED')).toBe(true);
    await w.db.query("UPDATE symbol_flags SET cleared_at = now() WHERE symbol = 'AAA'");
  });

  it('pauses a model at its monthly budget cap (SKIPPED_BUDGET)', async () => {
    w.clock.t = new Date('2026-10-20T10:00:30+05:30');
    const s = await runRound(
      w.deps,
      (await currentSeason(w.db, 'shadow', '2026-10-20'))!,
      '2026-10-20',
      '10:00',
      'cron',
    );
    expect(s.participants.find((p) => p.slot === 'anthropic')?.status).toBe('SKIPPED_BUDGET');
    expect(
      (await w.db.query("SELECT status FROM participants WHERE id = 'S0-anthropic'")).rows[0]
        .status,
    ).toBe('paused_budget');
  });

  it('marks decisions NOT_EXECUTED_DATA when the fill snapshot fails', async () => {
    w.clock.t = new Date('2026-10-20T10:30:30+05:30');
    const provider = w.deps.provider;
    let n = 0;
    w.deps.provider = () => {
      const p = provider();
      return {
        ...p,
        login: async () => {
          const s = await p.login();
          return {
            ...s,
            quotes: async (e, i) => {
              if (++n === 2) throw new DataError('DATA_REQUEST_FAILED', 'fill fetch failed');
              return s.quotes(e, i);
            },
          };
        },
      };
    };
    const s = await runRound(
      w.deps,
      (await currentSeason(w.db, 'shadow', '2026-10-20'))!,
      '2026-10-20',
      '10:30',
      'cron',
    );
    w.deps.provider = provider;
    expect([s.status, s.reason]).toEqual(['PARTIAL', 'fill snapshot failed']);
    const st = (
      await w.db.query('SELECT DISTINCT status FROM decisions WHERE round_id = $1', [s.roundId])
    ).rows.map((r) => r.status);
    expect(st).toContain('NOT_EXECUTED_DATA');
    expect(
      (await w.db.query('SELECT count(*)::int AS n FROM marks WHERE round_id = $1', [s.roundId]))
        .rows[0].n,
    ).toBe(0);
  });

  it('records EXECUTION_FAILED for a participant whose transaction fails, without touching the others', async () => {
    w.clock.t = new Date('2026-10-20T11:00:30+05:30');
    // Plant a broken position row only for google: the CHECK (quantity >= 0) makes its transaction fail.
    await w.db.query(
      "INSERT INTO positions (participant_id, symbol, quantity, avg_cost_paise) VALUES ('S0-google','CCC',1,1) ON CONFLICT DO NOTHING",
    );
    w.setLlm((m) =>
      answer(m, {
        reasoning: 'r',
        actions: [{ side: 'SELL', symbol: 'CCC', quantity: 1, why: 'x' }],
        note_to_self: '',
      }),
    );
    const owner = await import('pg').then(
      (m) => new m.default.Client({ connectionString: db.ownerUrl }),
    );
    await owner.connect();
    await owner.query(
      `CREATE OR REPLACE FUNCTION fail_google() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.participant_id = 'S0-google' THEN RAISE EXCEPTION 'planted failure'; END IF; RETURN NEW; END $$`,
    );
    await owner.query(
      'CREATE TRIGGER fail_google BEFORE INSERT ON ledger FOR EACH ROW EXECUTE FUNCTION fail_google()',
    );
    const s = await runRound(
      w.deps,
      (await currentSeason(w.db, 'shadow', '2026-10-20'))!,
      '2026-10-20',
      '11:00',
      'cron',
    );
    await owner.query('DROP TRIGGER fail_google ON ledger');
    await owner.query(
      "DELETE FROM positions WHERE participant_id = 'S0-google' AND symbol = 'CCC'",
    );
    await owner.end();
    expect(s.status).toBe('PARTIAL');
    expect(s.participants.find((p) => p.slot === 'google')?.status).toBe('EXECUTION_FAILED');
    expect(
      (
        await w.db.query(
          "SELECT status FROM decisions d WHERE round_id = $1 AND participant_id = 'S0-google'",
          [s.roundId],
        )
      ).rows[0].status,
    ).toBe('EXECUTION_FAILED');
    expect(
      (
        await w.db.query(
          "SELECT count(*)::int AS n FROM actions a JOIN decisions d ON d.id = a.decision_id WHERE d.round_id = $1 AND d.participant_id = 'S0-google'",
          [s.roundId],
        )
      ).rows[0].n,
    ).toBe(0);
    w.setLlm(buyOnce);
  });

  it('escalates to critical after three provider failures in a row', async () => {
    w.setLlm((m) =>
      m.startsWith('deepseek')
        ? { status: 500, body: { error: { code: 500, message: 'boom' } } }
        : answer(m, { reasoning: '', actions: [], note_to_self: '' }),
    );
    for (const slot of ['11:30', '12:00', '12:30']) {
      w.clock.t = new Date(`2026-10-20T${slot}:30+05:30`);
      await runRound(
        w.deps,
        (await currentSeason(w.db, 'shadow', '2026-10-20'))!,
        '2026-10-20',
        slot,
        'cron',
      );
    }
    expect(
      (
        await w.db.query(
          "SELECT severity FROM incidents WHERE key = 'llm:transient:deepseek' AND resolved_at IS NULL",
        )
      ).rows[0].severity,
    ).toBe('warn');
    expect(
      (
        await w.db.query(
          "SELECT severity FROM incidents WHERE key = 'llm:down:deepseek' AND resolved_at IS NULL",
        )
      ).rows[0].severity,
    ).toBe('critical');
    expect(
      w.sink.messages.some((m) => m.startsWith('CRITICAL: deepseek: missed 3 rounds in a row')),
    ).toBe(true);
    w.setLlm(buyOnce);
  });

  it('detects an unscheduled closure from stale exchange times', async () => {
    w.clock.t = new Date('2026-10-20T13:00:30+05:30');
    const provider = w.deps.provider;
    w.deps.provider = () => {
      const p = provider();
      return {
        ...p,
        login: async () => {
          const s = await p.login();
          return {
            ...s,
            quotes: async (e, i) => {
              const b = await s.quotes(e, i);
              const y = new Date('2026-10-19T10:00:00Z');
              return {
                ...b,
                quotes: b.quotes.map((q) => ({ ...q, exchangeTime: y })),
                indices: b.indices.map((x) => ({ ...x, exchangeTime: y })),
              };
            },
          };
        },
      };
    };
    const s = await runRound(
      w.deps,
      (await currentSeason(w.db, 'shadow', '2026-10-20'))!,
      '2026-10-20',
      '13:00',
      'cron',
    );
    w.deps.provider = provider;
    expect([s.status, s.reason]).toEqual(['SKIPPED_DATA', 'MARKET_CLOSED_UNSCHEDULED']);
  });

  it('end of day finishes the season on its last day', async () => {
    await w.db.query("UPDATE seasons SET ends_on = '2026-10-20' WHERE id = 'S0'");
    w.clock.t = new Date('2026-10-20T15:42:00+05:30');
    const r = await runEndOfDay(
      w.deps,
      (await currentSeason(w.db, 'shadow', '2026-10-20'))!,
      '2026-10-20',
    );
    expect(r.seasonFinished).toBe(true);
    expect((await w.db.query("SELECT status FROM seasons WHERE id = 'S0'")).rows[0].status).toBe(
      'finished',
    );
  });
});

describe('revalidation and export edge cases', () => {
  it('calls the endpoint when a reveal passed, records it, and handles rejection and errors', async () => {
    const f = fakeFetch(() => ({ body: { revalidated: true } }));
    const now = new Date();
    const base = {
      baseUrl: 'https://site.test',
      secret: 's'.repeat(32),
      log: (await import('pino')).default({ level: 'silent' }),
      now,
    };
    expect(await revalidateIfDue(w.db, { ...base, fetchImpl: f.impl })).toBe('ok');
    expect(f.calls[0]).toMatchObject({
      url: 'https://site.test/api/revalidate',
      method: 'POST',
      body: { tags: ['live'] },
    });
    expect(f.calls[0]!.headers.Authorization).toBe(`Bearer ${'s'.repeat(32)}`);
    expect(await revalidateIfDue(w.db, { ...base, fetchImpl: f.impl })).toBe('not-due');
    expect(
      await revalidateIfDue(w.db, {
        ...base,
        force: true,
        fetchImpl: fakeFetch(() => ({ status: 401, body: {} })).impl,
      }),
    ).toBe('failed');
    expect(
      await revalidateIfDue(w.db, {
        ...base,
        force: true,
        fetchImpl: fakeFetch(() => new Error('down')).impl,
      }),
    ).toBe('failed');
  });
  it('exports an empty day without an anchor', async () => {
    const r = await exportDay(w.db, '2026-10-21', w.deps.exportDir, false);
    expect(r.anchor.entries).toBe(0);
    expect(r.files.some((f) => f.includes('anchors'))).toBe(false);
  });
});
