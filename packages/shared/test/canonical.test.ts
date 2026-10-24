import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../src/canonical';
import {
  computeEntryHash,
  canonicalEntry,
  verifyChain,
  GENESIS_HASH,
  type LedgerEntry,
} from '../src/ledger-hash';

describe('canonical JSON', () => {
  it('sorts keys, strips whitespace, stringifies integers', () => {
    expect(canonicalJson({ b: 1, a: { d: null, c: [2n, 'x', true, false] } })).toBe(
      '{"a":{"c":["2","x",true,false],"d":null},"b":"1"}',
    );
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson(new Date('2026-11-02T04:00:00Z'))).toBe('"2026-11-02T04:00:00.000Z"');
  });
  it('refuses floats and odd values', () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow(/non-integer/);
    expect(() => canonicalJson(new Date('nope'))).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
  });
});

describe('sha256 known vectors', () => {
  it('matches FIPS 180-2 vectors', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

export const VECTOR_ENTRY: LedgerEntry = {
  seq: 1n,
  id: '00000000-0000-4000-8000-000000000001',
  season_id: 'S0',
  participant_id: 'S0-openai',
  round_id: null,
  action_id: null,
  entry_type: 'SEASON_START',
  symbol: null,
  side: null,
  quantity: null,
  price_paise: null,
  price_source: null,
  snapshot_id: null,
  gross_paise: 0n,
  charges: {},
  charges_total_paise: 0n,
  cash_delta_paise: 10000000n,
  cash_after_paise: 10000000n,
  position_after: null,
  avg_cost_after_paise: null,
  realized_pnl_paise: null,
  note: 'Season start',
  ref_seq: null,
  occurred_at: '2026-11-02T04:00:00.000Z',
  reveal_at: new Date('2026-11-02T04:15:00.000Z'),
  prev_hash: GENESIS_HASH,
};

export const VECTOR_CANONICAL =
  '{"action_id":null,"avg_cost_after_paise":null,"cash_after_paise":"10000000","cash_delta_paise":"10000000","charges":{},"charges_total_paise":"0","entry_type":"SEASON_START","gross_paise":"0","id":"00000000-0000-4000-8000-000000000001","note":"Season start","occurred_at":"2026-11-02T04:00:00.000Z","participant_id":"S0-openai","position_after":null,"prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","price_paise":null,"price_source":null,"quantity":null,"realized_pnl_paise":null,"ref_seq":null,"reveal_at":"2026-11-02T04:15:00.000Z","round_id":null,"season_id":"S0","seq":"1","side":null,"snapshot_id":null,"symbol":null}';

describe('ledger entry hash vectors', () => {
  it('produces the documented canonical form', () => {
    expect(canonicalEntry(VECTOR_ENTRY)).toBe(VECTOR_CANONICAL);
  });
  it('hash equals an independent node:crypto hash of the canonical form', async () => {
    const expected = createHash('sha256').update(VECTOR_CANONICAL, 'utf8').digest('hex');
    expect(await computeEntryHash(VECTOR_ENTRY)).toBe(expected);
  });
  it('normalises equivalent representations to the same hash', async () => {
    const alt = {
      ...VECTOR_ENTRY,
      seq: '1',
      cash_after_paise: '10000000',
      occurred_at: new Date('2026-11-02T09:30:00+05:30'),
    };
    expect(await computeEntryHash(alt)).toBe(await computeEntryHash(VECTOR_ENTRY));
  });
  it('rejects non-integers and bad timestamps', () => {
    expect(() => canonicalEntry({ ...VECTOR_ENTRY, cash_after_paise: '1.5' })).toThrow();
    expect(() => canonicalEntry({ ...VECTOR_ENTRY, occurred_at: 'x' })).toThrow();
  });
});

describe('verifyChain', () => {
  async function chain(n: number): Promise<LedgerEntry[]> {
    const out: LedgerEntry[] = [];
    let prev = GENESIS_HASH;
    for (let i = 1; i <= n; i++) {
      const e: LedgerEntry = {
        ...VECTOR_ENTRY,
        seq: BigInt(i),
        id: `id-${i}`,
        prev_hash: prev,
        charges: { stt: BigInt(i) },
      };
      e.hash = await computeEntryHash(e);
      prev = e.hash;
      out.push(e);
    }
    return out;
  }
  it('accepts a valid chain', async () => {
    const c = await chain(4);
    const r = await verifyChain(c);
    expect(r.ok).toBe(true);
    expect(r.headHash).toBe(c[3]!.hash);
    expect((await verifyChain([])).headHash).toBeNull();
  });
  it('detects tampering, broken links and gaps', async () => {
    const c = await chain(4);
    c[1] = { ...c[1]!, cash_after_paise: 1n };
    const r = await verifyChain(c);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.kind)).toContain('hash_mismatch');
    const c2 = await chain(3);
    const r2 = await verifyChain([c2[0]!, c2[2]!]);
    expect(r2.problems.map((p) => p.kind)).toEqual(
      expect.arrayContaining(['seq_gap', 'prev_hash_mismatch']),
    );
  });
});
