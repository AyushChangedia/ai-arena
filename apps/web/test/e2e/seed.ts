/**
 * Seeds a *_test database for the end-to-end suite by running the real engine round runner with the
 * test-only fake market and fake model providers. Refuses any database whose name doesn't end in _test
 * (SPEC §2.1.3). Usage: tsx test/e2e/seed.ts <populated|empty|paused> <dbname>
 */
import pg from 'pg';
import { migrate } from '@arena/db';
import {
  makeWorld,
  answer,
  testModels,
  type ModelBehaviour,
} from '../../../../packages/engine/test/helpers/world';
import { startSeason } from '../../../../packages/engine/src/ops/admin';
import { runRound, runSquareOff } from '../../../../packages/engine/src/round/runner';
import { runEndOfDay } from '../../../../packages/engine/src/round/eod';
import { exportDay } from '../../../../packages/engine/src/round/export';
import { currentSeason } from '../../../../packages/engine/src/round/store';
import { slotTimes } from '../../../../packages/engine/src/round/schedule';
import { must, loadArena } from '../../../../packages/engine/src/config/load';

const ADMIN = process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const PW = 'arena_local_test_only';
const [scenario, dbName] = process.argv.slice(2);

function urlFor(db: string, user?: string): string {
  const u = new URL(ADMIN);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user;
    u.password = PW;
  }
  return u.toString();
}

// Deterministic, varied behaviour per model and round: buys, sells, a short, a rejected sell, an
// unreadable answer, a timeout. Every answer states a strategy, and every action a reason and an exit plan.
const behaviour: ModelBehaviour = (model, n) => {
  const slot = model.split('/')[0]!;
  const syms = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];
  const pick = syms[(n + slot.length) % syms.length]!;
  const strategy = `${slot}: momentum. Buy stocks breaking out on volume, short the weakest; risk 1% per trade.`;
  if (slot === 'openai' && n === 2)
    return answer(model, {
      strategy,
      reasoning: `${slot}: ${pick} is the weakest stock today. Shorting a small position.`,
      actions: [
        {
          side: 'SELL',
          symbol: pick,
          quantity: 2,
          why: `${pick} fell below its opening range on heavy volume.`,
          exit_plan: 'Buy back 1% lower, or if it reclaims the open.',
        },
      ],
      note_to_self: `Short ${pick}.`,
    });
  if (slot === 'google' && n === 3)
    return answer(model, 'I think the market looks interesting today.');
  if (slot === 'meta' && n === 4)
    return { status: 503, body: { error: { code: 503, message: 'No available provider' } } };
  if (slot === 'deepseek' && n === 2)
    return answer(model, {
      strategy,
      reasoning: 'Trim a stock I do not hold.',
      actions: [
        {
          side: 'SELL',
          symbol: 'HDFCBANK',
          quantity: 40,
          why: 'Take profit.',
          exit_plan: 'None.',
        },
      ],
      note_to_self: 'Check holdings first.',
    });
  if (n % 3 === 0)
    return answer(model, {
      strategy,
      reasoning: `${slot}: holding steady after round ${n}.\nBanks flat, IT firm.`,
      actions: [],
      note_to_self: `Round ${n}: held.`,
    });
  if (n % 4 === 0)
    return answer(model, {
      strategy,
      reasoning: `${slot}: taking some profit.`,
      actions: [
        {
          side: 'SELL',
          symbol: syms[(n - 1 + slot.length) % syms.length],
          quantity: 1,
          why: 'Lock in gains.',
          exit_plan: 'Done: this closes part of the position.',
        },
      ],
      note_to_self: '',
    });
  return answer(model, {
    strategy,
    reasoning: `${slot}: ${pick} looks strong on relative volume. Adding a small position.\nKeeping cash for later rounds.`,
    actions: [
      {
        side: 'BUY',
        symbol: pick,
        quantity: 3,
        why: `${pick} relative strength.`,
        exit_plan: 'Sell 2% higher, or 1% below the entry.',
      },
    ],
    note_to_self: `Bought ${pick}.`,
  });
};

async function main() {
  if (!scenario || !dbName) throw new Error('usage: seed.ts <populated|empty|paused> <dbname>');
  if (!dbName.endsWith('_test'))
    throw new Error(`Refusing to seed "${dbName}": test databases must end in _test.`);
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  await migrate(urlFor(dbName));
  const owner = new pg.Client({ connectionString: urlFor(dbName) });
  await owner.connect();
  await owner.query(`ALTER ROLE engine_rw PASSWORD '${PW}'`);
  await owner.query(`ALTER ROLE web_ro PASSWORD '${PW}'`);

  const models = testModels();
  if (scenario === 'empty') {
    const w = makeWorld(urlFor(dbName, 'engine_rw'), new Date(), behaviour, models, 'intraday');
    const future = new Date(Date.now() + 9 * 86_400_000);
    let start = future.toISOString().slice(0, 10);
    while (!w.deps.calendar.isTradingDay(start)) start = w.deps.calendar.nextTradingDay(start);
    await startSeason(
      w.db,
      { id: 'S0', start, mode: 'shadow' },
      models,
      w.deps.calendar,
      10_000_000n,
      20,
      'e2e seed',
      'seed',
    );
    await w.db.end();
    await owner.end();
    return;
  }

  const days = ['2026-10-19', '2026-10-20'];
  // The committed rules: intraday long-short, brokerage 0.03% or ₹20, square-off from 15:00.
  const w = makeWorld(
    urlFor(dbName, 'engine_rw'),
    new Date(`${days[0]}T09:30:30+05:30`),
    behaviour,
    models,
    'intraday',
  );
  await startSeason(
    w.db,
    { id: 'S0', start: days[0]!, mode: 'shadow' },
    models,
    w.deps.calendar,
    10_000_000n,
    20,
    'e2e seed',
    'seed',
  );
  // The site numbers rounds from the committed schedule, so seed exactly those slots.
  w.deps.arena = must(loadArena());
  const slots = slotTimes(w.deps.arena);
  for (const [di, day] of days.entries()) {
    for (const [si, slot] of slots.entries()) {
      if (di === 1 && si >= Math.ceil(slots.length / 2)) break; // the second day is half done
      w.clock.t = new Date(`${day}T${slot}:30+05:30`);
      // Prices drift deterministically so values move.
      for (const [i, s] of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'].entries()) {
        const base = 100_000n + BigInt(i) * 25_000n;
        const drift = BigInt(((di * 12 + si) * (i % 3 === 0 ? 37 : i % 3 === 1 ? -23 : 11)) % 4000);
        w.market.prices.set(s, base + drift * 10n);
      }
      w.market.index = 2_400_000n + BigInt((di * 12 + si) * 1500);
      const season = (await currentSeason(w.db, 'shadow', day))!;
      await runRound(w.deps, season, day, slot, 'cron');
    }
    if (di === 0) {
      w.clock.t = new Date(`${day}T15:02:00+05:30`);
      await runSquareOff(w.deps, (await currentSeason(w.db, 'shadow', day))!, day, 'cron');
      w.clock.t = new Date(`${day}T15:42:00+05:30`);
      await runEndOfDay(w.deps, (await currentSeason(w.db, 'shadow', day))!, day);
      await exportDay(w.db, day, w.deps.exportDir, true);
      await w.db.query("UPDATE anchors SET commit_sha = 'abc1234' WHERE date = $1", [day]);
    }
  }
  await w.db.query(
    "INSERT INTO incidents (id, key, severity, title, detail, public_message, scope, started_at, resolved_at) VALUES (gen_random_uuid(), 'schedule:missed:x', 'warn', 'Round missed', 'internal detail', 'Round missed: scheduler didn''t run.', 'round', now() - interval '1 day', now())",
  );
  if (scenario === 'paused') {
    await w.db.query("UPDATE arena_state SET paused = true, paused_reason = 'credits_exhausted'");
    await w.db.query(
      "INSERT INTO incidents (id, key, severity, title, detail, public_message, scope, started_at) VALUES (gen_random_uuid(), 'llm:credits', 'critical', 'Out of credit', 'HTTP 402', 'Rounds are paused: the arena is out of API credit.', 'arena', now())",
    );
    // Planted failure for "Check this trade": tamper with the first revealed trade, #7 (test database only).
    await owner.query('ALTER TABLE ledger DISABLE TRIGGER ledger_no_update');
    await owner.query(
      "UPDATE ledger SET price_paise = price_paise + 100 WHERE seq = (SELECT min(seq) FROM ledger WHERE entry_type IN ('BUY','SELL'))",
    );
    await owner.query('ALTER TABLE ledger ENABLE TRIGGER ledger_no_update');
  }
  await w.db.end();
  await owner.end();
}

main().then(
  () => process.stdout.write(`seeded ${scenario} into ${dbName}\n`),
  (e: unknown) => {
    process.stderr.write(`seed failed: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
