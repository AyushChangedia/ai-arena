import { canonicalJson, sha256Hex } from './canonical';

export const GENESIS_HASH = '0'.repeat(64);

export const LEDGER_ENTRY_TYPES = [
  'SEASON_START',
  'BUY',
  'SELL',
  'DIVIDEND',
  'SPLIT_ADJUST',
  'BONUS_ADJUST',
  'RETIRE',
  'CORRECTION',
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/**
 * A ledger entry exactly as hashed and exported. Keys match the database columns.
 * Integers are bigint or number; timestamps are Date or ISO strings (normalised before hashing).
 */
export interface LedgerEntry {
  seq: bigint | number | string;
  id: string;
  season_id: string;
  participant_id: string;
  round_id: string | null;
  action_id: string | null;
  entry_type: LedgerEntryType;
  symbol: string | null;
  side: 'BUY' | 'SELL' | null;
  quantity: number | bigint | string | null;
  price_paise: bigint | string | null;
  price_source: string | null;
  snapshot_id: string | null;
  gross_paise: bigint | string;
  charges: Record<string, bigint | string>;
  charges_total_paise: bigint | string;
  cash_delta_paise: bigint | string;
  cash_after_paise: bigint | string;
  position_after: number | bigint | string | null;
  avg_cost_after_paise: bigint | string | null;
  realized_pnl_paise: bigint | string | null;
  note: string | null;
  ref_seq: bigint | number | string | null;
  occurred_at: Date | string;
  reveal_at: Date | string;
  prev_hash: string;
  hash?: string;
}

const INT_FIELDS = [
  'seq',
  'quantity',
  'price_paise',
  'gross_paise',
  'charges_total_paise',
  'cash_delta_paise',
  'cash_after_paise',
  'position_after',
  'avg_cost_after_paise',
  'realized_pnl_paise',
  'ref_seq',
] as const;

const INT_RE = /^-?\d+$/;

function normInt(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'bigint' ? v.toString() : typeof v === 'number' ? String(v) : String(v);
  if (!INT_RE.test(s)) throw new TypeError(`${field} is not an integer: ${s}`);
  return BigInt(s).toString();
}

function normTime(v: Date | string, field: string): string {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`${field} is not a timestamp`);
  return d.toISOString();
}

/** The object that is hashed: every field except `hash`, normalised to canonical types. */
export function hashableEntry(e: LedgerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: e.id,
    season_id: e.season_id,
    participant_id: e.participant_id,
    round_id: e.round_id ?? null,
    action_id: e.action_id ?? null,
    entry_type: e.entry_type,
    symbol: e.symbol ?? null,
    side: e.side ?? null,
    price_source: e.price_source ?? null,
    snapshot_id: e.snapshot_id ?? null,
    note: e.note ?? null,
    occurred_at: normTime(e.occurred_at, 'occurred_at'),
    reveal_at: normTime(e.reveal_at, 'reveal_at'),
    prev_hash: e.prev_hash,
    charges: Object.fromEntries(
      Object.entries(e.charges ?? {}).map(([k, v]) => [k, normInt(v, `charges.${k}`)]),
    ),
  };
  for (const f of INT_FIELDS) out[f] = normInt(e[f], f);
  return out;
}

export function canonicalEntry(e: LedgerEntry): string {
  return canonicalJson(hashableEntry(e));
}

export async function computeEntryHash(e: LedgerEntry): Promise<string> {
  return sha256Hex(canonicalEntry(e));
}

export type ChainProblem =
  | { seq: string; kind: 'hash_mismatch'; expected: string; actual: string | undefined }
  | { seq: string; kind: 'prev_hash_mismatch'; expected: string; actual: string }
  | { seq: string; kind: 'seq_gap'; expected: string; actual: string };

export interface ChainResult {
  ok: boolean;
  entries: number;
  headHash: string | null;
  problems: ChainProblem[];
}

/**
 * Verifies a contiguous run of entries. `startPrevHash` is the hash before the first entry
 * (GENESIS_HASH for seq 1, or the previous day's anchor head).
 */
export async function verifyChain(
  entries: LedgerEntry[],
  startPrevHash: string = GENESIS_HASH,
): Promise<ChainResult> {
  const problems: ChainProblem[] = [];
  let prev = startPrevHash;
  let expectedSeq: bigint | null = null;
  for (const e of entries) {
    const seq = BigInt(normInt(e.seq, 'seq') ?? '0');
    if (expectedSeq !== null && seq !== expectedSeq) {
      problems.push({
        seq: seq.toString(),
        kind: 'seq_gap',
        expected: expectedSeq.toString(),
        actual: seq.toString(),
      });
    }
    if (e.prev_hash !== prev) {
      problems.push({
        seq: seq.toString(),
        kind: 'prev_hash_mismatch',
        expected: prev,
        actual: e.prev_hash,
      });
    }
    const h = await computeEntryHash(e);
    if (h !== e.hash) {
      problems.push({ seq: seq.toString(), kind: 'hash_mismatch', expected: h, actual: e.hash });
    }
    prev = e.hash ?? h;
    expectedSeq = seq + 1n;
  }
  return {
    ok: problems.length === 0,
    entries: entries.length,
    headHash: entries.length ? (entries[entries.length - 1]?.hash ?? null) : null,
    problems,
  };
}
