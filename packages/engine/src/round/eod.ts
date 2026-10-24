/** End of day (SPEC §12.5): valuation snapshot, day-end marks, reconciliation, digest. */
import { formatInr } from '@arena/shared/format';
import { snapshotFor, mappingFromDb } from '../data/market';
import { persistSnapshot } from '../data/snapshot';
import { pricesWithFallback } from './context';
import { writeMarks } from './runner';
import { reconcileAndAct, type ReconcileResult } from './reconcile';
import { participants as loadParticipants, heldSymbols, type SeasonRow } from './store';
import type { Deps } from './deps';

export interface EodResult {
  snapshot: string;
  reconcile: ReconcileResult;
  seasonFinished: boolean;
}

export async function runEndOfDay(d: Deps, season: SeasonRow, date: string): Promise<EodResult> {
  const provider = d.provider();
  const held = await heldSymbols(d.db, season.id);
  const mapping = await mappingFromDb(d.db, d.universe, d.arena, held);
  const session = await provider.login();
  // The day-end mark uses last traded prices; NSE's official close is a different calculation.
  const snap = await snapshotFor({
    session,
    source: provider.source,
    purpose: 'valuation',
    mapping,
    arena: d.arena,
    now: d.now,
    checkFreshness: false,
  });
  await persistSnapshot(d.db, snap);
  const parts = await loadParticipants(d.db, season.id);
  const symbols = [...new Set([...d.universe.constituents.map((c) => c.symbol), ...held])];
  const valuation = await pricesWithFallback(d.db, snap, symbols);
  const revealAt = new Date(snap.finishedAt.getTime() + d.arena.season.publicDelayMinutes * 60_000);
  await writeMarks(d, season, parts, snap, valuation, 'eod', null, revealAt);
  const rec = await reconcileAndAct(d, season.id, date);
  const standings = await d.db.query<{ display_name: string; total_paise: string }>(
    `SELECT p.display_name, m.total_paise FROM marks m JOIN participants p ON p.id = m.participant_id WHERE m.snapshot_id = $1 ORDER BY m.total_paise DESC`,
    [snap.id],
  );
  const spend = await d.db.query<{ s: string | null }>(
    'SELECT sum(cost_usd)::text AS s FROM decisions d JOIN rounds r ON r.id = d.round_id WHERE r.season_id = $1 AND r.trading_date = $2',
    [season.id, date],
  );
  const open = await d.db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM incidents WHERE resolved_at IS NULL',
  );
  await d.alerts.digest(
    [
      `AI Arena ${season.id}, ${date}: day-end`,
      ...standings.rows.map(
        (r, i) =>
          `${i + 1}. ${r.display_name} ${formatInr(BigInt(r.total_paise), { decimals: 0 })}`,
      ),
      `API spend today: $${Number(spend.rows[0]?.s ?? 0).toFixed(4)}`,
      `Open incidents: ${open.rows[0]?.n ?? 0}`,
      `Reconciliation: ${rec.ok ? 'ok' : `MISMATCH (${rec.problems.length} problems); arena paused`}`,
    ].join('\n'),
  );
  let seasonFinished = false;
  if (season.ends_on && date >= season.ends_on) {
    await d.db.query("UPDATE seasons SET status = 'finished' WHERE id = $1", [season.id]);
    seasonFinished = true;
  }
  return { snapshot: snap.id, reconcile: rec, seasonFinished };
}
