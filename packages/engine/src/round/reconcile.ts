/**
 * Reconciliation (SPEC §12.7): rebuild cash and positions from the ledger alone, compare with stored
 * positions and the day's last marks, verify the hash chain and its link to the previous anchor.
 * Any mismatch pauses the arena. Data is never silently fixed.
 */
import { verifyChain, GENESIS_HASH } from '@arena/shared/ledger-hash';
import type { Queryable } from '@arena/db';
import { rebuildFromLedger } from '../core/ledger';
import { loadLedger } from './ledger-store';
import { openIncident } from '../ops/incidents';
import { setPaused } from './store';
import type { Deps } from './deps';

export interface ReconcileResult {
  ok: boolean;
  problems: string[];
  entries: number;
  headHash: string | null;
}

export async function reconcile(
  db: Queryable,
  seasonId: string | null,
  date: string | null,
): Promise<ReconcileResult> {
  const problems: string[] = [];
  const all = await loadLedger(db as never);
  // Chain over the whole ledger (cheap at this scale), plus the link to the previous day's anchor.
  const chain = await verifyChain(all, GENESIS_HASH);
  for (const p of chain.problems) problems.push(`chain seq ${p.seq}: ${p.kind}`);
  if (date) {
    const prev = await db.query<{ head_hash: string; last_seq: string }>(
      'SELECT head_hash, last_seq FROM anchors WHERE date < $1 ORDER BY date DESC LIMIT 1',
      [date],
    );
    const a = prev.rows[0];
    if (a) {
      const at = all.find((e) => BigInt(e.seq) === BigInt(a.last_seq));
      if (!at || at.hash !== a.head_hash)
        problems.push(
          `anchor mismatch: previous anchor head ${a.head_hash.slice(0, 12)}… (seq ${a.last_seq}) not found in the ledger`,
        );
    }
  }
  const entries = seasonId ? all.filter((e) => e.season_id === seasonId) : all;
  let rebuilt;
  try {
    rebuilt = rebuildFromLedger(entries);
  } catch (e) {
    problems.push(`rebuild failed: ${(e as Error).message}`);
    return { ok: false, problems, entries: entries.length, headHash: chain.headHash };
  }
  const pos = await db.query<{
    participant_id: string;
    symbol: string;
    quantity: number;
    avg_cost_paise: string;
    season_id: string;
  }>(
    'SELECT p.participant_id, p.symbol, p.quantity, p.avg_cost_paise, pa.season_id FROM positions p JOIN participants pa ON pa.id = p.participant_id',
  );
  const stored = new Map<string, Map<string, { q: number; a: bigint }>>();
  for (const r of pos.rows) {
    if (seasonId && r.season_id !== seasonId) continue;
    if (!stored.has(r.participant_id)) stored.set(r.participant_id, new Map());
    stored.get(r.participant_id)!.set(r.symbol, { q: r.quantity, a: BigInt(r.avg_cost_paise) });
  }
  const ids = new Set([...rebuilt.keys(), ...stored.keys()]);
  for (const id of ids) {
    const want = rebuilt.get(id)?.positions ?? new Map();
    const have = stored.get(id) ?? new Map();
    for (const sym of new Set([...want.keys(), ...have.keys()])) {
      const w = want.get(sym);
      const h = have.get(sym);
      if ((w?.quantity ?? 0) !== (h?.q ?? 0) || (w && h && w.avgCostPaise !== h.a)) {
        problems.push(
          `${id} ${sym}: ledger says ${w?.quantity ?? 0} @ ${w?.avgCostPaise ?? '-'}, positions table says ${h?.q ?? 0} @ ${h?.a ?? '-'}`,
        );
      }
    }
  }
  // The latest mark's cash must equal the ledger cash at that moment.
  const marks = await db.query<{ participant_id: string; cash_paise: string; marked_at: Date }>(
    `SELECT DISTINCT ON (m.participant_id) m.participant_id, m.cash_paise, m.marked_at FROM marks m JOIN participants p ON p.id = m.participant_id
     WHERE p.kind <> 'index' ${seasonId ? 'AND p.season_id = $1' : ''} ORDER BY m.participant_id, m.marked_at DESC`,
    seasonId ? [seasonId] : [],
  );
  for (const m of marks.rows) {
    const before = entries.filter(
      (e) => e.participant_id === m.participant_id && new Date(e.occurred_at) <= m.marked_at,
    );
    const cash = before.length ? BigInt(before[before.length - 1]!.cash_after_paise) : null;
    if (cash !== null && cash !== BigInt(m.cash_paise))
      problems.push(`${m.participant_id}: last mark cash ${m.cash_paise} but ledger cash ${cash}`);
  }
  return { ok: problems.length === 0, problems, entries: entries.length, headHash: chain.headHash };
}

/** Runs reconciliation; on mismatch opens a critical incident and pauses the arena. */
export async function reconcileAndAct(
  d: Deps,
  seasonId: string | null,
  date: string,
): Promise<ReconcileResult> {
  const r = await reconcile(d.db, seasonId, date);
  if (!r.ok) {
    const at = d.now();
    await setPaused(d.db, true, 'reconciliation_mismatch');
    const time = at.toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
    });
    await openIncident(
      d.db,
      {
        key: 'reconcile:mismatch',
        severity: 'critical',
        title: 'Reconciliation mismatch',
        detail: r.problems.slice(0, 20).join('\n'),
        publicMessage: `Numbers under review since ${time} IST. Rounds are paused until this is resolved.`,
        scope: 'arena',
      },
      at,
    );
    await d.alerts.raise({
      key: 'reconcile:mismatch',
      severity: 'critical',
      text: `Reconciliation mismatch; arena paused. ${r.problems.slice(0, 3).join('; ')}`,
    });
  }
  return r;
}
