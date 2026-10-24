/**
 * Appends ledger entries (SPEC §11.7): serialised with pg_advisory_xact_lock, gap-free seq assigned
 * inside the lock, hash-chained to the previous entry. Must run inside a transaction.
 */
import type pg from 'pg';
import type { LedgerEntry } from '@arena/shared/ledger-hash';
import { chainDrafts, type LedgerDraft, type ChainHead } from '../core/ledger';
import { GENESIS_HASH } from '@arena/shared/ledger-hash';

export const LEDGER_LOCK_KEY = 7_311_002;

export async function ledgerHead(db: Pick<pg.PoolClient, 'query'>): Promise<ChainHead> {
  const r = await db.query<{ seq: string; hash: string }>(
    'SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1',
  );
  return r.rows[0]
    ? { seq: BigInt(r.rows[0].seq), hash: r.rows[0].hash }
    : { seq: 0n, hash: GENESIS_HASH };
}

export async function appendLedger(
  tx: pg.PoolClient,
  drafts: LedgerDraft[],
): Promise<LedgerEntry[]> {
  if (!drafts.length) return [];
  await tx.query('SELECT pg_advisory_xact_lock($1)', [LEDGER_LOCK_KEY]);
  const head = await ledgerHead(tx);
  const { entries } = await chainDrafts(head, drafts);
  for (const e of entries) {
    await tx.query(
      `INSERT INTO ledger (seq, id, season_id, participant_id, round_id, action_id, entry_type, symbol, side, quantity, price_paise,
         price_source, snapshot_id, gross_paise, charges, charges_total_paise, cash_delta_paise, cash_after_paise, position_after,
         avg_cost_after_paise, realized_pnl_paise, note, ref_seq, occurred_at, reveal_at, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
      [
        e.seq,
        e.id,
        e.season_id,
        e.participant_id,
        e.round_id,
        e.action_id,
        e.entry_type,
        e.symbol,
        e.side,
        e.quantity,
        e.price_paise,
        e.price_source,
        e.snapshot_id,
        e.gross_paise,
        JSON.stringify(e.charges),
        e.charges_total_paise,
        e.cash_delta_paise,
        e.cash_after_paise,
        e.position_after,
        e.avg_cost_after_paise,
        e.realized_pnl_paise,
        e.note,
        e.ref_seq,
        e.occurred_at,
        e.reveal_at,
        e.prev_hash,
        e.hash,
      ],
    );
  }
  return entries;
}

/** Brings the positions table in line with the entries just written (rebuildable from the ledger). */
export async function applyPositions(tx: pg.PoolClient, entries: LedgerEntry[]): Promise<void> {
  for (const e of entries) {
    if (!e.symbol || e.position_after === null || e.position_after === undefined) continue;
    const qty = Number(e.position_after);
    if (qty === 0)
      await tx.query('DELETE FROM positions WHERE participant_id = $1 AND symbol = $2', [
        e.participant_id,
        e.symbol,
      ]);
    else
      await tx.query(
        `INSERT INTO positions (participant_id, symbol, quantity, avg_cost_paise) VALUES ($1,$2,$3,$4)
         ON CONFLICT (participant_id, symbol) DO UPDATE SET quantity = EXCLUDED.quantity, avg_cost_paise = EXCLUDED.avg_cost_paise`,
        [e.participant_id, e.symbol, qty, e.avg_cost_after_paise],
      );
  }
}

const big = (v: unknown) => (v === null || v === undefined ? null : BigInt(v as string));

/** Reads ledger rows back as LedgerEntry objects (for reconcile, replay, export and verify). */
export function rowToEntry(r: Record<string, unknown>): LedgerEntry {
  return {
    seq: BigInt(r.seq as string),
    id: r.id as string,
    season_id: r.season_id as string,
    participant_id: r.participant_id as string,
    round_id: (r.round_id as string | null) ?? null,
    action_id: (r.action_id as string | null) ?? null,
    entry_type: r.entry_type as LedgerEntry['entry_type'],
    symbol: (r.symbol as string | null) ?? null,
    side: (r.side as 'BUY' | 'SELL' | null) ?? null,
    quantity: (r.quantity as number | null) ?? null,
    price_paise: big(r.price_paise),
    price_source: (r.price_source as string | null) ?? null,
    snapshot_id: (r.snapshot_id as string | null) ?? null,
    gross_paise: BigInt(r.gross_paise as string),
    charges: r.charges as Record<string, string>,
    charges_total_paise: BigInt(r.charges_total_paise as string),
    cash_delta_paise: BigInt(r.cash_delta_paise as string),
    cash_after_paise: BigInt(r.cash_after_paise as string),
    position_after: (r.position_after as number | null) ?? null,
    avg_cost_after_paise: big(r.avg_cost_after_paise),
    realized_pnl_paise: big(r.realized_pnl_paise),
    note: (r.note as string | null) ?? null,
    ref_seq: big(r.ref_seq),
    occurred_at: r.occurred_at as Date,
    reveal_at: r.reveal_at as Date,
    prev_hash: r.prev_hash as string,
    hash: r.hash as string,
  };
}

export async function loadLedger(
  db: Pick<pg.Pool, 'query'>,
  where = 'TRUE',
  params: unknown[] = [],
): Promise<LedgerEntry[]> {
  const r = await db.query(`SELECT * FROM ledger WHERE ${where} ORDER BY seq`, params);
  return r.rows.map(rowToEntry);
}
