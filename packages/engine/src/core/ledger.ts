/**
 * Ledger entry construction and chaining (SPEC §11.7). Appending to the database happens in
 * round/ledger-store.ts under an advisory lock; this module is pure.
 */
import {
  computeEntryHash,
  GENESIS_HASH,
  type LedgerEntry,
  type LedgerEntryType,
} from '@arena/shared/ledger-hash';
import { chargesToJson, type Charges } from './fees';
import type { PortfolioState } from './portfolio';

export type LedgerDraft = Omit<LedgerEntry, 'seq' | 'prev_hash' | 'hash'>;

export interface ChainHead {
  seq: bigint; // last assigned seq (0 if empty)
  hash: string; // last hash (GENESIS_HASH if empty)
}

export const EMPTY_HEAD: ChainHead = { seq: 0n, hash: GENESIS_HASH };

/** Assigns seq and prev_hash in order and computes each hash. */
export async function chainDrafts(
  head: ChainHead,
  drafts: LedgerDraft[],
): Promise<{ entries: LedgerEntry[]; head: ChainHead }> {
  const entries: LedgerEntry[] = [];
  let seq = head.seq;
  let prev = head.hash;
  for (const d of drafts) {
    seq += 1n;
    const e: LedgerEntry = { ...d, seq, prev_hash: prev };
    e.hash = await computeEntryHash(e);
    prev = e.hash;
    entries.push(e);
  }
  return { entries, head: { seq, hash: prev } };
}

export function chargesJson(c: Charges | null): Record<string, string> {
  return c ? chargesToJson(c) : {};
}

const ZERO_CHARGES = {};

export interface DraftBase {
  id: string;
  seasonId: string;
  participantId: string;
  roundId: string | null;
  occurredAt: Date;
  revealAt: Date;
}

function base(
  b: DraftBase,
  type: LedgerEntryType,
): Pick<
  LedgerDraft,
  'id' | 'season_id' | 'participant_id' | 'round_id' | 'entry_type' | 'occurred_at' | 'reveal_at'
> {
  return {
    id: b.id,
    season_id: b.seasonId,
    participant_id: b.participantId,
    round_id: b.roundId,
    entry_type: type,
    occurred_at: b.occurredAt,
    reveal_at: b.revealAt,
  };
}

const EMPTY = {
  action_id: null,
  symbol: null,
  side: null,
  quantity: null,
  price_paise: null,
  price_source: null,
  snapshot_id: null,
  position_after: null,
  avg_cost_after_paise: null,
  realized_pnl_paise: null,
  note: null,
  ref_seq: null,
} as const;

export function seasonStartDraft(b: DraftBase, startingCash: bigint): LedgerDraft {
  return {
    ...base(b, 'SEASON_START'),
    ...EMPTY,
    gross_paise: 0n,
    charges: ZERO_CHARGES,
    charges_total_paise: 0n,
    cash_delta_paise: startingCash,
    cash_after_paise: startingCash,
    note: 'Season start',
  };
}

export interface TradeDraftInput {
  actionId: string;
  side: 'BUY' | 'SELL';
  symbol: string;
  quantity: number;
  pricePaise: bigint;
  priceSource: string;
  snapshotId: string;
  grossPaise: bigint;
  charges: Charges;
  chargesTotalPaise: bigint;
  cashDeltaPaise: bigint;
  cashAfterPaise: bigint;
  positionAfter: number;
  avgCostAfterPaise: bigint | null;
  realizedPnlPaise: bigint | null;
}

export function tradeDraft(b: DraftBase, t: TradeDraftInput): LedgerDraft {
  return {
    ...base(b, t.side),
    ...EMPTY,
    action_id: t.actionId,
    symbol: t.symbol,
    side: t.side,
    quantity: t.quantity,
    price_paise: t.pricePaise,
    price_source: t.priceSource,
    snapshot_id: t.snapshotId,
    gross_paise: t.grossPaise,
    charges: chargesJson(t.charges),
    charges_total_paise: t.chargesTotalPaise,
    cash_delta_paise: t.cashDeltaPaise,
    cash_after_paise: t.cashAfterPaise,
    position_after: t.positionAfter,
    avg_cost_after_paise: t.avgCostAfterPaise,
    realized_pnl_paise: t.realizedPnlPaise,
  };
}

export interface AdjustDraftInput {
  type: 'DIVIDEND' | 'SPLIT_ADJUST' | 'BONUS_ADJUST' | 'RETIRE' | 'CORRECTION';
  symbol: string | null;
  quantityDelta: number | null;
  grossPaise: bigint;
  cashDeltaPaise: bigint;
  cashAfterPaise: bigint;
  positionAfter: number | null;
  avgCostAfterPaise: bigint | null;
  note: string;
  refSeq?: bigint | null;
}

export function adjustDraft(b: DraftBase, a: AdjustDraftInput): LedgerDraft {
  return {
    ...base(b, a.type),
    ...EMPTY,
    symbol: a.symbol,
    quantity: a.quantityDelta,
    gross_paise: a.grossPaise,
    charges: ZERO_CHARGES,
    charges_total_paise: 0n,
    cash_delta_paise: a.cashDeltaPaise,
    cash_after_paise: a.cashAfterPaise,
    position_after: a.positionAfter,
    avg_cost_after_paise: a.avgCostAfterPaise,
    note: a.note,
    ref_seq: a.refSeq ?? null,
  };
}

/**
 * Rebuilds each participant's cash and positions from ledger entries alone (SPEC §11.6, §12.7).
 * Throws on any internal inconsistency (cash_after not matching the running cash).
 */
export function rebuildFromLedger(entries: LedgerEntry[]): Map<string, PortfolioState> {
  const out = new Map<string, PortfolioState>();
  const sorted = [...entries].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
  for (const e of sorted) {
    const p = out.get(e.participant_id) ?? { cashPaise: 0n, positions: new Map() };
    out.set(e.participant_id, p);
    p.cashPaise += BigInt(e.cash_delta_paise);
    if (p.cashPaise !== BigInt(e.cash_after_paise)) {
      throw new Error(
        `ledger seq ${String(e.seq)}: cash_after ${String(e.cash_after_paise)} but rebuilt cash is ${p.cashPaise}`,
      );
    }
    if (e.symbol && e.position_after !== null && e.position_after !== undefined) {
      const qty = Number(e.position_after);
      const prev = p.positions.get(e.symbol)?.quantity ?? 0;
      const delta = Number(e.quantity ?? 0);
      const expected =
        e.entry_type === 'BUY' || e.entry_type === 'SPLIT_ADJUST' || e.entry_type === 'BONUS_ADJUST'
          ? prev + delta
          : e.entry_type === 'SELL'
            ? prev - delta
            : qty;
      if (expected !== qty)
        throw new Error(
          `ledger seq ${String(e.seq)}: position_after ${qty} but rebuilt position is ${expected}`,
        );
      if (qty === 0) p.positions.delete(e.symbol);
      else
        p.positions.set(e.symbol, {
          quantity: qty,
          avgCostPaise: BigInt(e.avg_cost_after_paise ?? 0n),
        });
    }
  }
  return out;
}
