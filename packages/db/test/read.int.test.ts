/**
 * Every web read function runs as web_ro (views only) against a database filled by the real round runner,
 * and returns correctly ordered, typed data. Includes a regression test for numeric ledger ordering.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import * as read from '../src/read';
import { createTestDb, type TestDb } from './helpers';
import { makeWorld, buyOnce } from '../../engine/test/helpers/world';
import { startSeason } from '../../engine/src/ops/admin';
import { runRound } from '../../engine/src/round/runner';
import { runEndOfDay } from '../../engine/src/round/eod';
import { exportDay } from '../../engine/src/round/export';
import { currentSeason } from '../../engine/src/round/store';
import { verifyChain, type LedgerEntry } from '@arena/shared/ledger-hash';

let db: TestDb;
let web: pg.Client;
const sql: read.Sql = { query: async (t, p) => (await web.query(t, p as unknown[])).rows };
const DAY = '2026-10-19';

beforeAll(async () => {
  db = await createTestDb('read');
  const w = makeWorld(db.engineUrl, new Date(`${DAY}T09:30:30+05:30`), buyOnce);
  await startSeason(
    w.db,
    { id: 'S0', start: DAY, mode: 'shadow' },
    w.deps.models,
    w.deps.calendar,
    10_000_000n,
    20,
    't',
    't',
  );
  for (const slot of ['09:30', '10:00', '10:30', '11:00']) {
    w.clock.t = new Date(`${DAY}T${slot}:30+05:30`);
    w.setLlm((m, n) => buyOnce(m, n === 1 ? 1 : 1)); // every model buys each round so there are >10 ledger entries
    await runRound(w.deps, (await currentSeason(w.db, 'shadow', DAY))!, DAY, slot, 'cron');
  }
  w.clock.t = new Date(`${DAY}T15:42:00+05:30`);
  await runEndOfDay(w.deps, (await currentSeason(w.db, 'shadow', DAY))!, DAY);
  await exportDay(w.db, DAY, w.deps.exportDir, true);
  await w.db.end();
  web = new pg.Client({ connectionString: db.webUrl });
  await web.connect();
});
afterAll(async () => {
  await web?.end();
  await db?.drop();
});

describe('web read layer (views only, as web_ro)', () => {
  it('returns the season, participants, marks, status and standings inputs', async () => {
    const s = (await read.getSiteSeason(sql, 'shadow'))!;
    expect(s).toMatchObject({
      id: 'S0',
      mode: 'shadow',
      status: 'active',
      startingCashPaise: 10_000_000n,
    });
    expect(await read.getSeasonById(sql, 'S0')).toMatchObject({ id: 'S0' });
    expect((await read.listSeasons(sql, 'shadow')).map((x) => x.id)).toEqual(['S0']);
    expect(await read.getSiteSeason(sql, 'live')).toBeNull();
    const parts = await read.getParticipants(sql, 'S0');
    expect(parts.map((p) => p.kind)).toEqual([
      'model',
      'model',
      'model',
      'model',
      'model',
      'monkey',
      'index',
    ]);
    const marks = await read.getMarks(sql, 'S0');
    expect(marks.length).toBe(4 * 7 + 7);
    expect(typeof marks[0]!.totalPaise).toBe('bigint');
    expect((await read.getStatus(sql))!.paused).toBe(false);
    const counts = await read.getParticipantCounts(sql, 'S0');
    expect(counts.find((c) => c.participantId === 'S0-openai')).toMatchObject({
      ok: 4,
      roundsHeld: 4,
    });
  });

  it('returns rounds, decisions with actions, blunders and recent statuses', async () => {
    const rounds = await read.getRounds(sql, 'S0');
    expect(rounds.map((r) => r.slotTime)).toEqual(['11:00', '10:30', '10:00', '09:30']);
    expect(await read.getRound(sql, 'not-a-uuid')).toBeNull();
    const latest = (await read.getLatestDecisionRound(sql, 'S0'))!;
    expect(latest.slotTime).toBe('11:00');
    const ds = await read.getRoundDecisions(sql, rounds[3]!.id);
    expect(ds).toHaveLength(6);
    expect(ds.find((d) => d.participantId === 'S0-openai')!.actions[0]).toMatchObject({
      side: 'BUY',
      symbol: 'AAA',
      status: 'executed',
    });
    expect(await read.getParticipantDecisions(sql, 'S0-openai', 2)).toHaveLength(2);
    expect(await read.getBlunders(sql, 'S0', 10)).toEqual(expect.any(Array));
    expect(await read.getUnreadable(sql, 'S0')).toEqual([]);
    const strip = await read.getRecentStatuses(sql, 'S0', 3);
    expect(strip.map((x) => x.slotTime)).toEqual(['10:00', '10:30', '11:00']);
    expect(strip[0]!.byParticipant['S0-openai']).toBe('OK');
    expect(await read.getMarketTable(sql, rounds[0]!.id)).toContain('MARKET at');
  });

  it('orders ledger entries numerically (regression: text-cast seq sorted "10" before "2")', async () => {
    const day = await read.getLedgerForDate(sql, DAY);
    expect(day.length).toBeGreaterThan(10);
    const seqs = day.map((e) => Number(e.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const head = (await read.getLedgerHead(sql))!;
    expect(head.seq).toBe(String(Math.max(...seqs)));
    const asEntries: LedgerEntry[] = day.map((e) => ({
      seq: e.seq,
      id: e.id,
      season_id: e.seasonId,
      participant_id: e.participantId,
      round_id: e.roundId,
      action_id: e.actionId,
      entry_type: e.entryType as LedgerEntry['entry_type'],
      symbol: e.symbol,
      side: e.side,
      quantity: e.quantity,
      price_paise: e.pricePaise,
      price_source: e.priceSource,
      snapshot_id: e.snapshotId,
      gross_paise: e.grossPaise,
      charges: e.charges,
      charges_total_paise: e.chargesTotalPaise,
      cash_delta_paise: e.cashDeltaPaise,
      cash_after_paise: e.cashAfterPaise,
      position_after: e.positionAfter,
      avg_cost_after_paise: e.avgCostAfterPaise,
      realized_pnl_paise: e.realizedPnlPaise,
      note: e.note,
      ref_seq: e.refSeq,
      occurred_at: e.occurredAt,
      reveal_at: e.revealAt,
      prev_hash: e.prevHash,
      hash: e.hash,
    }));
    expect((await verifyChain(asEntries)).ok).toBe(true);
    const part = await read.getParticipantLedger(sql, 'S0-openai');
    expect(part.map((e) => Number(e.seq))).toEqual(
      [...part.map((e) => Number(e.seq))].sort((a, b) => a - b),
    );
    expect(await read.getLedgerForDate(sql, 'nope')).toEqual([]);
    const one = (await read.getLedgerEntry(sql, '10'))!;
    expect(one.seq).toBe('10');
    expect(await read.getLedgerEntry(sql, 'x')).toBeNull();
    expect(await read.getNeighbourSeqs(sql, '10')).toEqual({ prev: '9', next: '11' });
    expect(
      (await read.getTradesForSeason(sql, 'S0')).every(
        (t) => t.entryType === 'BUY' || t.entryType === 'SELL',
      ),
    ).toBe(true);
  });

  it('returns holdings, anchors, incidents, admin log and flags', async () => {
    const h = await read.getHoldings(sql, ['S0-openai']);
    expect(h[0]).toMatchObject({ symbol: 'AAA', quantity: 8, underReview: false });
    expect(h[0]!.lastPricePaise).toBe(100_000n);
    expect((await read.getAnchors(sql))[0]).toMatchObject({ date: DAY });
    expect(await read.getIncidents(sql)).toEqual(expect.any(Array));
    expect((await read.getAdminLog(sql)).map((a) => a.command)).toContain('start-season');
    expect(await read.getFlags(sql)).toEqual([]);
  });
});
